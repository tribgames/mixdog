//! The media byte lane of the relay leg: the relay proxies a phone's HTTP request here and this
//! leg answers a head followed by raw chunks. Media never becomes an RPC payload, so a clip
//! cannot stall the UI socket and the phone keeps Range seeking. The relay is untrusted, so the
//! body is a sequence of AES-GCM frames sealed with the requesting session's media key
//! ([`crypto`]); the request names its session by `sid` (the session's public challenge).

pub mod crypto;
pub mod range;

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine;
use serde_json::{Value, json};

use crypto::{MEDIA_SCHEME, MEDIA_SEGMENT_BYTES, MediaWindowMeta, encrypt_media_meta, encrypt_media_segment};
use range::{DOWNLOAD_WINDOW_MAX_BYTES, MEDIA_WINDOW_MAX_BYTES, parse_range, window};

/// Socket backlog that pauses the read; a phone that stalls stops the pump within a few frames.
pub const MEDIA_SOCKET_BACKLOG_BYTES: u64 = 4 * 1024 * 1024;
const MEDIA_POLL: Duration = Duration::from_millis(50);
/// The `download` variant: file-download leases.
pub const FILE_DOWNLOAD_MEDIA_VARIANT: &str = "download";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MediaRequest {
    pub id: String,
    pub asset_id: String,
    pub variant: String,
    pub method: String,
    pub range: String,
    /// The requesting session's challenge; '' when the relay sent none.
    pub sid: String,
    /// Protocol opt-in; '' from an older client or relay.
    pub enc: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MediaCommand {
    Serve(MediaRequest),
    Abort(String),
    Pause { id: String, paused: bool },
    Ignored,
}

/// Routes a `media-*` envelope; one without an id is ignored.
pub fn route_media_envelope(envelope: &Value) -> MediaCommand {
    let text = |name: &str| envelope.get(name).and_then(Value::as_str).unwrap_or_default().to_owned();
    let id = text("id");
    if id.is_empty() {
        return MediaCommand::Ignored;
    }
    match envelope.get("type").and_then(Value::as_str).unwrap_or_default() {
        "media-request" => MediaCommand::Serve(MediaRequest {
            id,
            asset_id: text("assetId"),
            variant: if envelope.get("variant").is_some() { text("variant") } else { "original".to_owned() },
            method: if envelope.get("method").is_some() { text("method") } else { "GET".to_owned() },
            range: text("range"),
            sid: text("sid"),
            enc: text("enc"),
        }),
        "media-abort" => MediaCommand::Abort(id),
        "media-pause" => MediaCommand::Pause { id, paused: true },
        "media-resume" => MediaCommand::Pause { id, paused: false },
        _ => MediaCommand::Ignored,
    }
}

/// What one request streams from: a gallery file or a download lease.
#[async_trait]
pub trait ByteSource: Send {
    fn size(&self) -> u64;
    fn mime(&self) -> String;
    fn version(&self) -> Option<String> {
        None
    }
    async fn read(&mut self, offset: u64, length: usize) -> std::io::Result<Vec<u8>>;
}

/// Why a source failed before the head was sent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceFailure {
    NotFound,
    Changed,
    Other,
}

impl SourceFailure {
    fn status(self) -> u16 {
        match self {
            Self::Changed => 412,
            Self::NotFound => 404,
            Self::Other => 500,
        }
    }
}

/// Where gallery files and download leases come from.
#[async_trait]
pub trait MediaSources: Send + Sync {
    async fn gallery(&self, asset_id: &str, variant: &str) -> Result<Option<Box<dyn ByteSource>>, SourceFailure>;
    /// A lease answers only the device it was minted for.
    async fn download(&self, asset_id: &str, device: &str) -> Option<Box<dyn ByteSource>>;
}

/// Where one window's answer goes. Every step is awaited in order, so a lane that must wait for
/// room before it may queue a frame holds the pump there.
#[async_trait]
pub trait MediaOutput: Send {
    /// The requester went away: the pump stops at its next step, quietly.
    fn aborted(&self) -> bool;
    /// Resolves once the next segment may be produced; the file read waits here.
    async fn ready(&mut self);
    async fn head(&mut self, status: u16);
    async fn chunk(&mut self, frame: Vec<u8>);
    async fn end(&mut self);
    async fn error(&mut self);
}

/// The requesting session, as its lane knows it.
pub struct MediaSession {
    pub media_key: Option<[u8; 32]>,
    pub device: Option<String>,
}

async fn fail(out: &mut dyn MediaOutput, status: u16) {
    out.head(status).await;
    out.end().await;
}

/// Answers one request on `out`: a status, or a 200 head, the authenticated meta frame and the
/// window's segment frames, then the end. Shared by every lane, so a window is the same bytes
/// whichever lane carries it.
pub async fn serve_media_window(
    sources: &dyn MediaSources,
    media: &MediaRequest,
    session: &MediaSession,
    out: &mut dyn MediaOutput,
) {
    // Only a client that explicitly speaks the encrypted scheme gets bytes.
    if media.enc != MEDIA_SCHEME {
        return fail(out, 404).await;
    }
    let Some(key) = session.media_key else { return fail(out, 403).await };
    if media.method != "GET" {
        return fail(out, 405).await;
    }
    let download = media.variant == FILE_DOWNLOAD_MEDIA_VARIANT;
    let source = if download {
        match session.device.as_deref() {
            Some(device) => Ok(sources.download(&media.asset_id, device).await),
            None => Ok(None),
        }
    } else {
        sources.gallery(&media.asset_id, &media.variant).await
    };
    let mut source = match source {
        Ok(Some(source)) => source,
        Ok(None) => return fail(out, 404).await,
        Err(failure) => return fail(out, if failure == SourceFailure::NotFound { 404 } else { 500 }).await,
    };
    let size = source.size();
    let window_bytes = if download { DOWNLOAD_WINDOW_MAX_BYTES } else { MEDIA_WINDOW_MAX_BYTES };
    let Some((start, end)) = window(parse_range(&media.range, size), size, window_bytes) else {
        return fail(out, 416).await;
    };
    // Exactly `length` bytes, or the file changed under the stream: a short segment would not
    // match the size the frames are bound to.
    async fn read_segment(source: &mut dyn ByteSource, offset: u64, length: u64) -> Result<Vec<u8>, SourceFailure> {
        match source.read(offset, length as usize).await {
            Ok(bytes) if bytes.len() as u64 == length => Ok(bytes),
            Ok(_) => Err(SourceFailure::Changed),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Err(SourceFailure::NotFound),
            Err(_) => Err(SourceFailure::Other),
        }
    }
    let segment = MEDIA_SEGMENT_BYTES;
    // The first segment is read before the head: a lease that ended or a file that changed is a
    // status the phone can act on, not a body that breaks off.
    let mut first = None;
    if i128::from(start) <= end {
        let length = segment.min((end - i128::from(start) + 1) as u64);
        match read_segment(source.as_mut(), start, length).await {
            Ok(bytes) => first = Some(bytes),
            Err(failure) => {
                if !out.aborted() {
                    fail(out, failure.status()).await;
                }
                return;
            }
        }
    }
    if out.aborted() {
        return;
    }
    out.head(200).await;
    let meta = MediaWindowMeta { size, mime: source.mime(), start, end, version: source.version() };
    out.chunk(encrypt_media_meta(&key, &media.asset_id, &media.variant, &meta)).await;
    let mut offset = start;
    while i128::from(offset) <= end {
        out.ready().await;
        if out.aborted() {
            return;
        }
        let bytes = match first.take() {
            Some(bytes) => bytes,
            None => {
                let length = segment.min((end - i128::from(offset) + 1) as u64);
                match read_segment(source.as_mut(), offset, length).await {
                    Ok(bytes) => bytes,
                    Err(_) => {
                        if !out.aborted() {
                            out.error().await;
                        }
                        return;
                    }
                }
            }
        };
        if out.aborted() {
            return;
        }
        out.chunk(encrypt_media_segment(&key, &media.asset_id, &media.variant, offset, size, &bytes)).await;
        offset += segment;
    }
    out.end().await;
}

/// Two independent stalls can pause a pump — this socket's backlog, and the relay's flow control
/// for a phone that stopped draining — so the read only continues once BOTH are clear.
#[derive(Default)]
struct Pump {
    aborted: AtomicBool,
    relay_paused: AtomicBool,
}

pub struct RelayMediaLane {
    sources: Arc<dyn MediaSources>,
    send: Arc<dyn Fn(Value) -> bool + Send + Sync>,
    backlog: Arc<dyn Fn() -> u64 + Send + Sync>,
    pumps: Mutex<HashMap<String, Arc<Pump>>>,
}

struct LaneOutput {
    id: String,
    pump: Arc<Pump>,
    send: Arc<dyn Fn(Value) -> bool + Send + Sync>,
    backlog: Arc<dyn Fn() -> u64 + Send + Sync>,
}

#[async_trait]
impl MediaOutput for LaneOutput {
    fn aborted(&self) -> bool {
        self.pump.aborted.load(Ordering::Acquire)
    }

    async fn ready(&mut self) {
        while !self.aborted()
            && (self.pump.relay_paused.load(Ordering::Acquire) || (self.backlog)() > MEDIA_SOCKET_BACKLOG_BYTES)
        {
            mixdog_rt::time::sleep(MEDIA_POLL).await;
        }
    }

    async fn head(&mut self, status: u16) {
        let headers = if status == 200 {
            json!({ "Content-Type": "application/octet-stream", "Cache-Control": "no-store" })
        } else {
            json!({})
        };
        (self.send)(json!({ "type": "media-head", "id": self.id, "status": status, "headers": headers }));
    }

    async fn chunk(&mut self, frame: Vec<u8>) {
        let data = base64::engine::general_purpose::STANDARD.encode(frame);
        (self.send)(json!({ "type": "media-chunk", "id": self.id, "data": data }));
    }

    async fn end(&mut self) {
        (self.send)(json!({ "type": "media-end", "id": self.id }));
    }

    async fn error(&mut self) {
        (self.send)(json!({ "type": "media-error", "id": self.id }));
    }
}

impl RelayMediaLane {
    pub fn new(
        sources: Arc<dyn MediaSources>,
        send: Arc<dyn Fn(Value) -> bool + Send + Sync>,
        backlog: Arc<dyn Fn() -> u64 + Send + Sync>,
    ) -> Self {
        Self { sources, send, backlog, pumps: Mutex::new(HashMap::new()) }
    }

    fn pumps(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<Pump>>> {
        self.pumps.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub async fn serve(&self, media: MediaRequest, session: MediaSession) {
        let pump = Arc::new(Pump::default());
        self.pumps().insert(media.id.clone(), pump.clone());
        let mut out = LaneOutput {
            id: media.id.clone(),
            pump: pump.clone(),
            send: self.send.clone(),
            backlog: self.backlog.clone(),
        };
        serve_media_window(self.sources.as_ref(), &media, &session, &mut out).await;
        let mut pumps = self.pumps();
        if pumps.get(&media.id).is_some_and(|current| Arc::ptr_eq(current, &pump)) {
            pumps.remove(&media.id);
        }
    }

    /// The relay gave up on one waiting response.
    pub fn abort(&self, id: &str) {
        if let Some(pump) = self.pumps().get(id) {
            pump.aborted.store(true, Ordering::Release);
        }
    }

    pub fn set_paused(&self, id: &str, paused: bool) {
        if let Some(pump) = self.pumps().get(id) {
            pump.relay_paused.store(paused, Ordering::Release);
        }
    }

    /// The relay dropped every waiting response with this leg: stop pumping.
    pub fn destroy_all(&self) {
        for (_, pump) in self.pumps().drain() {
            pump.aborted.store(true, Ordering::Release);
        }
    }

    pub fn active(&self) -> usize {
        self.pumps().len()
    }
}
