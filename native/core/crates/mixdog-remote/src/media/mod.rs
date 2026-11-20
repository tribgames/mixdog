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

use async_trait::async_trait;
use base64::Engine;
use serde_json::{Value, json};

use tokio_util::sync::CancellationToken;

use crate::clients::table::Revocation;
use crypto::{MEDIA_SCHEME, MEDIA_SEGMENT_BYTES, MediaWindowMeta, encrypt_media_meta, encrypt_media_segment};
use range::{DOWNLOAD_WINDOW_MAX_BYTES, MEDIA_WINDOW_MAX_BYTES, parse_range, window};

/// Socket backlog that pauses the read; a phone that stalls stops the pump within a few frames.
pub const MEDIA_SOCKET_BACKLOG_BYTES: u64 = 4 * 1024 * 1024;
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

/// Runs a delivery (its argument, which must not wait) only while the source still permits it, in one step with that test and
/// serialized against what ends the permission (a lease's removal, expiry or eviction); false when it refused.
pub type Commit = Arc<dyn Fn(&mut dyn FnMut()) -> bool + Send + Sync>;

/// What one request streams from: a gallery file or a download lease.
#[async_trait]
pub trait ByteSource: Send {
    fn size(&self) -> u64;
    fn mime(&self) -> String;
    fn version(&self) -> Option<String> {
        None
    }
    async fn read(&mut self, offset: u64, length: usize) -> std::io::Result<Vec<u8>>;
    /// The source's own permission to deliver, for a leased source: its lease, asked at the commit of every delivery without
    /// reading bytes or renewing anything, and the terminal event the lease's owner publishes when it ends (expiry, eviction,
    /// removal, unpair, invalidation). `None` for a source that has no lease of its own (a gallery file).
    fn lease_guard(&self) -> Option<LeaseGuard> {
        None
    }
}

/// A leased source's authority: the guarded commit (the enforcement) and the owner's terminal event (termination and release).
#[derive(Clone)]
pub struct LeaseGuard {
    pub commit: Commit,
    pub ended: CancellationToken,
}

/// What permits a delivery: the requesting credential's capability and, for a leased source, that exact lease. Reading or sealing
/// a segment reserves no permission to deliver it: every delivery (the head, the meta, each segment, however long it waited for
/// room) is committed through [`commit`](Self::commit), after its last wait.
///
/// Guarantee: no new delivery is committed after the revocation or the lease's end; bytes already committed to a transport may still
/// arrive.
#[derive(Clone)]
pub struct Permit {
    revocation: Revocation,
    lease: Option<LeaseGuard>,
}

impl Permit {
    pub fn new(revocation: Revocation, lease: Option<LeaseGuard>) -> Self {
        Self { revocation, lease }
    }

    /// Whether the credential's or the lease's end has been published.
    pub fn is_ended(&self) -> bool {
        self.revocation.is_revoked() || self.lease.as_ref().is_some_and(|lease| lease.ended.is_cancelled())
    }

    /// The combined terminal event: resolves when the credential or the lease ends, at once if either already had. Every wait made
    /// under this permit selects on it. The future owns its tokens, so it outlives the permit it came from.
    pub fn ended(&self) -> impl std::future::Future<Output = ()> + Send + 'static {
        let (credential, lease) = (self.revocation.ended(), self.lease.as_ref().map(|lease| lease.ended.clone()));
        async move {
            match lease {
                Some(lease) => tokio::select! {
                    () = credential.cancelled() => {}
                    () = lease.cancelled() => {}
                },
                None => credential.cancelled().await,
            }
        }
    }

    /// Runs `write` in one step with both tests; false (and nothing written) when either refuses.
    pub fn commit(&self, write: &mut dyn FnMut()) -> bool {
        let mut written = false;
        let allowed = self.revocation.commit(&mut || {
            written = match &self.lease {
                Some(lease) => (lease.commit)(&mut *write),
                None => {
                    write();
                    true
                }
            };
        });
        allowed && written
    }

    /// The permit as a transport write gate: the coordinator runs a gated message's records under it.
    pub fn commit_fn(&self) -> Commit {
        let permit = self.clone();
        Arc::new(move |write: &mut dyn FnMut()| permit.commit(write))
    }
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
    /// A project file a paired device previews, by the media lease its `projectFs/previewFile` call was given
    /// (`leasedMediaFile`, `media-leases.ts`): asked before the gallery, whatever the variant. The lease answers only the device
    /// it was minted for, only while it lasts, and only for the very file that was authorized.
    async fn project_file(&self, asset_id: &str, device: &str) -> Option<Box<dyn ByteSource>> {
        let _ = (asset_id, device);
        None
    }
}

/// Where one window's answer goes. Every step is awaited in order, so a lane that must wait for
/// room before it may queue a frame holds the pump there.
#[async_trait]
pub trait MediaOutput: Send {
    /// The requester went away: the pump stops at its next step, quietly.
    fn aborted(&self) -> bool;
    /// Resolves once the next segment may be produced; the file read waits here.
    async fn ready(&mut self);
    /// Sets what permits this request's deliveries; asked once, when its source is known. A 200 head, the meta and every segment
    /// are committed under it after the last wait for room, and one it refuses ends the stream with an error, never a hole.
    fn permit(&mut self, permit: Permit);
    async fn head(&mut self, status: u16);
    async fn chunk(&mut self, frame: Vec<u8>);
    async fn end(&mut self);
    async fn error(&mut self);
}

/// The requesting session, as its lane knows it.
pub struct MediaSession {
    pub media_key: Option<[u8; 32]>,
    pub device: Option<String>,
    /// Taken with the key and the device (`ClientTable::media_grant`), before anything spawned or waited.
    pub revocation: Revocation,
}

async fn fail(out: &mut dyn MediaOutput, status: u16) {
    out.head(status).await;
    out.end().await;
}

/// Answers one request on `out`: a status, or a 200 head, the authenticated meta frame and the
/// window's segment frames, then the end. Shared by every lane, so a window is the same bytes
/// whichever lane carries it.
pub async fn serve_media_window(sources: &dyn MediaSources, media: &MediaRequest, session: &MediaSession, out: &mut dyn MediaOutput) {
    // Only a client that explicitly speaks the encrypted scheme gets bytes.
    if media.enc != MEDIA_SCHEME {
        return fail(out, 404).await;
    }
    let Some(key) = session.media_key else { return fail(out, 403).await };
    // A credential revoked before the request is served has no authority: refused before any source is asked.
    if session.revocation.is_revoked() {
        return fail(out, 403).await;
    }
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
        let leased = match session.device.as_deref() {
            Some(device) => sources.project_file(&media.asset_id, device).await,
            None => None,
        };
        match leased {
            Some(source) => Ok(Some(source)),
            None => sources.gallery(&media.asset_id, &media.variant).await,
        }
    };
    let mut source = match source {
        Ok(Some(source)) => source,
        Ok(None) => return fail(out, 404).await,
        Err(failure) => return fail(out, if failure == SourceFailure::NotFound { 404 } else { 500 }).await,
    };
    out.permit(Permit::new(session.revocation.clone(), source.lease_guard()));
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
struct Pump {
    /// The relay gave up on the response, or the lane closed: the pump stops at its next step, and a wait it is in is left.
    cancel: CancellationToken,
    /// The relay's flow control for a phone that stopped draining; a change is an event the pump's wait takes.
    paused: tokio::sync::watch::Sender<bool>,
}

impl Pump {
    fn new() -> Self {
        Self { cancel: CancellationToken::new(), paused: tokio::sync::watch::Sender::new(false) }
    }
}

/// A wait that resolves when the outgoing queue has room (at or under its backlog limit), at once if it already has.
pub type RoomWait = std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>;

/// The outgoing socket queue's room as its owner publishes it: the owner's drain wakes the waiters, so a pump parked for room is an
/// event wait, never a poll. The limit is [`MEDIA_SOCKET_BACKLOG_BYTES`].
pub trait Room: Send + Sync {
    /// Resolves once the queue is at or under the limit. It must subscribe before it tests, so a drain between the two is not lost.
    fn room(&self) -> RoomWait;
}

pub struct RelayMediaLane {
    sources: Arc<dyn MediaSources>,
    send: Arc<dyn Fn(Value) -> bool + Send + Sync>,
    room: Arc<dyn Room>,
    pumps: Mutex<HashMap<String, Arc<Pump>>>,
}

struct LaneOutput {
    id: String,
    pump: Arc<Pump>,
    send: Arc<dyn Fn(Value) -> bool + Send + Sync>,
    room: Arc<dyn Room>,
    permit: Option<Permit>,
}

impl LaneOutput {
    /// A delivery of bytes: committed in one step with the permit (the send is synchronous, nothing is awaited under it), or, when
    /// the permit refuses, the stream ends: no more bytes are sent, and a `media-error` is offered to the queue without waiting.
    fn deliver(&mut self, frame: Value) {
        if self.pump.cancel.is_cancelled() {
            return;
        }
        let send = &self.send;
        let permitted = self.permit.as_ref().is_some_and(|permit| {
            permit.commit(&mut || {
                send(frame.clone());
            })
        });
        if !permitted {
            self.pump.cancel.cancel();
            (self.send)(json!({ "type": "media-error", "id": self.id }));
        }
    }
}

#[async_trait]
impl MediaOutput for LaneOutput {
    fn aborted(&self) -> bool {
        self.pump.cancel.is_cancelled() || self.permit.as_ref().is_some_and(Permit::is_ended)
    }

    /// Waits for the pause to clear and the queue to have room, on events only: the authority's end (credential or lease), the
    /// request's abort or the lane's closure, a pause-state change, and the queue's drain. Each subscription is armed before its
    /// predicate is tested. On the authority's end it returns at once, without room, and tells the phone only as far as the queue
    /// takes it without waiting.
    async fn ready(&mut self) {
        let authority = self.permit.as_ref().map(Permit::ended);
        let ended = async move {
            match authority {
                Some(authority) => authority.await,
                None => std::future::pending::<()>().await,
            }
        };
        tokio::pin!(ended);
        let mut paused = self.pump.paused.subscribe();
        loop {
            if self.pump.cancel.is_cancelled() {
                return;
            }
            if *paused.borrow_and_update() {
                tokio::select! {
                    biased;
                    () = self.pump.cancel.cancelled() => return,
                    () = &mut ended => break,
                    _ = paused.changed() => continue,
                }
            }
            tokio::select! {
                biased;
                () = self.pump.cancel.cancelled() => return,
                () = &mut ended => break,
                _ = paused.changed() => continue,
                () = self.room.room() => return,
            }
        }
        // The authority ended while waiting: the stream is over and no more bytes are committed. A terminal `media-error` is only
        // offered to the queue (`try_send`, no waiting for room), so it may be dropped; nothing waits in order to send it.
        self.pump.cancel.cancel();
        (self.send)(json!({ "type": "media-error", "id": self.id }));
    }

    fn permit(&mut self, permit: Permit) {
        self.permit = Some(permit);
    }

    async fn head(&mut self, status: u16) {
        let headers = if status == 200 { json!({ "Content-Type": "application/octet-stream", "Cache-Control": "no-store" }) } else { json!({}) };
        let head = json!({ "type": "media-head", "id": self.id, "status": status, "headers": headers });
        if status == 200 {
            self.deliver(head);
        } else {
            (self.send)(head);
        }
    }

    async fn chunk(&mut self, frame: Vec<u8>) {
        let data = base64::engine::general_purpose::STANDARD.encode(frame);
        self.deliver(json!({ "type": "media-chunk", "id": self.id, "data": data }));
    }

    async fn end(&mut self) {
        (self.send)(json!({ "type": "media-end", "id": self.id }));
    }

    async fn error(&mut self) {
        (self.send)(json!({ "type": "media-error", "id": self.id }));
    }
}

impl RelayMediaLane {
    pub fn new(sources: Arc<dyn MediaSources>, send: Arc<dyn Fn(Value) -> bool + Send + Sync>, room: Arc<dyn Room>) -> Self {
        Self { sources, send, room, pumps: Mutex::new(HashMap::new()) }
    }

    fn pumps(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<Pump>>> {
        self.pumps.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub async fn serve(&self, media: MediaRequest, session: MediaSession) {
        let pump = Arc::new(Pump::new());
        self.pumps().insert(media.id.clone(), pump.clone());
        let mut out = LaneOutput { id: media.id.clone(), pump: pump.clone(), send: self.send.clone(), room: self.room.clone(), permit: None };
        serve_media_window(self.sources.as_ref(), &media, &session, &mut out).await;
        let mut pumps = self.pumps();
        if pumps.get(&media.id).is_some_and(|current| Arc::ptr_eq(current, &pump)) {
            pumps.remove(&media.id);
        }
    }

    /// The relay gave up on one waiting response.
    pub fn abort(&self, id: &str) {
        if let Some(pump) = self.pumps().get(id) {
            pump.cancel.cancel();
        }
    }

    pub fn set_paused(&self, id: &str, paused: bool) {
        if let Some(pump) = self.pumps().get(id) {
            pump.paused.send_replace(paused);
        }
    }

    /// The relay dropped every waiting response with this leg: stop pumping.
    pub fn destroy_all(&self) {
        for (_, pump) in self.pumps().drain() {
            pump.cancel.cancel();
        }
    }

    pub fn active(&self) -> usize {
        self.pumps().len()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex as StdMutex;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::Duration;

    use super::crypto::MEDIA_SCHEME;
    use super::*;

    const HUNDRED_MB: u64 = 100 * 1024 * 1024;

    /// A leased 100 MB video that reads zeros and notes where each read began.
    struct Video(Arc<StdMutex<Vec<(u64, usize)>>>, Option<LeaseGuard>, Option<Arc<AtomicUsize>>);

    impl Drop for Video {
        /// A source dropped is counted, so a test sees that a stream that ended released it.
        fn drop(&mut self) {
            if let Some(dropped) = &self.2 {
                dropped.fetch_add(1, Ordering::SeqCst);
            }
        }
    }

    #[async_trait]
    impl ByteSource for Video {
        fn size(&self) -> u64 {
            HUNDRED_MB
        }
        fn mime(&self) -> String {
            "video/mp4".to_owned()
        }
        async fn read(&mut self, offset: u64, length: usize) -> std::io::Result<Vec<u8>> {
            self.0.lock().unwrap().push((offset, length));
            Ok(vec![0; length])
        }
        fn lease_guard(&self) -> Option<LeaseGuard> {
            self.1.clone()
        }
    }

    /// Only `phone-1` holds the lease `lease-1`; the gallery has nothing.
    struct Sources(Arc<StdMutex<Vec<(u64, usize)>>>);

    #[async_trait]
    impl MediaSources for Sources {
        async fn gallery(&self, _: &str, _: &str) -> Result<Option<Box<dyn ByteSource>>, SourceFailure> {
            Ok(None)
        }
        async fn download(&self, _: &str, _: &str) -> Option<Box<dyn ByteSource>> {
            None
        }
        async fn project_file(&self, asset_id: &str, device: &str) -> Option<Box<dyn ByteSource>> {
            (asset_id == "lease-1" && device == "phone-1").then(|| Box::new(Video(self.0.clone(), None, None)) as Box<dyn ByteSource>)
        }
    }

    #[derive(Default)]
    struct Out {
        heads: Vec<u16>,
        chunks: usize,
        ended: bool,
    }

    #[async_trait]
    impl MediaOutput for Out {
        fn aborted(&self) -> bool {
            false
        }
        async fn ready(&mut self) {}
        fn permit(&mut self, _: Permit) {}
        async fn head(&mut self, status: u16) {
            self.heads.push(status);
        }
        async fn chunk(&mut self, _: Vec<u8>) {
            self.chunks += 1;
        }
        async fn end(&mut self) {
            self.ended = true;
        }
        async fn error(&mut self) {}
    }

    async fn serve(sources: &Sources, variant: &str, range: &str, device: Option<&str>) -> Out {
        let media = MediaRequest {
            id: "r1".into(),
            asset_id: "lease-1".into(),
            variant: variant.into(),
            method: "GET".into(),
            range: range.into(),
            sid: String::new(),
            enc: MEDIA_SCHEME.into(),
        };
        let session = MediaSession { media_key: Some([7; 32]), device: device.map(str::to_owned), revocation: Revocation::default() };
        let mut out = Out::default();
        serve_media_window(sources, &media, &session, &mut out).await;
        out
    }

    /// One lease of the test: `valid` is its guarded commit's state (flipping it is an expiry, an eviction or a removal as the owner's
    /// table would see it) and `ended` the terminal event its owner publishes.
    #[derive(Clone)]
    struct TestLease {
        valid: Arc<AtomicBool>,
        ended: CancellationToken,
    }

    impl TestLease {
        fn new() -> Self {
            Self { valid: Arc::new(AtomicBool::new(true)), ended: CancellationToken::new() }
        }

        /// The owner ends the lease: the state is cleared and the event published.
        fn end(&self) {
            self.valid.store(false, Ordering::SeqCst);
            self.ended.cancel();
        }
    }

    /// Answers the leases `lease-1` and `lease-2` of `phone-1` (or, with `gallery`, the gallery for any asset), counting the sources
    /// dropped.
    struct Guarded {
        leases: HashMap<String, TestLease>,
        gallery: bool,
        dropped: Arc<AtomicUsize>,
    }

    impl Guarded {
        fn video(&self, lease: Option<&TestLease>) -> Box<dyn ByteSource> {
            let guard = lease.map(|lease| {
                let valid = lease.valid.clone();
                let commit: Commit = Arc::new(move |write: &mut dyn FnMut()| {
                    if valid.load(Ordering::SeqCst) {
                        write();
                        true
                    } else {
                        false
                    }
                });
                LeaseGuard { commit, ended: lease.ended.clone() }
            });
            Box::new(Video(Arc::new(StdMutex::new(Vec::new())), guard, Some(self.dropped.clone())))
        }
    }

    #[async_trait]
    impl MediaSources for Guarded {
        async fn gallery(&self, _: &str, _: &str) -> Result<Option<Box<dyn ByteSource>>, SourceFailure> {
            Ok(self.gallery.then(|| self.video(None)))
        }
        async fn download(&self, _: &str, _: &str) -> Option<Box<dyn ByteSource>> {
            None
        }
        async fn project_file(&self, asset_id: &str, device: &str) -> Option<Box<dyn ByteSource>> {
            if self.gallery || device != "phone-1" {
                return None;
            }
            self.leases.get(asset_id).map(|lease| self.video(Some(lease)))
        }
    }

    /// The outgoing queue's room as the test publishes it: stalled while `stalled()` says so, and the waiters are woken by `drained`,
    /// the owner's publication. `on_wait` runs when a wait begins, after the lane subscribed to its other events and before the
    /// predicate is tested (the window in which an end must not be lost).
    struct TestRoom {
        stalled: Arc<dyn Fn() -> bool + Send + Sync>,
        drained: Arc<tokio::sync::Notify>,
        on_wait: Option<Arc<dyn Fn() + Send + Sync>>,
        /// Waits that began stalled (a pump parked for room), and the event announcing each: the lane polls its other events before
        /// the room, so by the time a wait is counted here the pump's end, abort and pause subscriptions are armed.
        parked: Arc<AtomicUsize>,
        parked_changed: Arc<tokio::sync::Notify>,
    }

    impl Room for TestRoom {
        fn room(&self) -> RoomWait {
            let (stalled, drained, on_wait) = (self.stalled.clone(), self.drained.clone(), self.on_wait.clone());
            let (parked, parked_changed) = (self.parked.clone(), self.parked_changed.clone());
            Box::pin(async move {
                if let Some(on_wait) = &on_wait {
                    on_wait();
                }
                let mut counted = false;
                loop {
                    let drain = drained.notified();
                    tokio::pin!(drain);
                    drain.as_mut().enable();
                    if !stalled() {
                        return;
                    }
                    if !counted {
                        counted = true;
                        parked.fetch_add(1, Ordering::SeqCst);
                        parked_changed.notify_waiters();
                    }
                    drain.await;
                }
            })
        }
    }

    /// A lane over `Guarded` whose room the test controls: the queue is over its limit once `stall_after` chunk frames were sent, and
    /// stays so until `release` (which publishes the drain). No writable notification is ever sent otherwise.
    struct Rig {
        lane: Arc<RelayMediaLane>,
        sent: Arc<StdMutex<Vec<Value>>>,
        leases: HashMap<String, TestLease>,
        dropped: Arc<AtomicUsize>,
        released: Arc<AtomicBool>,
        drained: Arc<tokio::sync::Notify>,
        parked: Arc<AtomicUsize>,
        parked_changed: Arc<tokio::sync::Notify>,
    }

    /// The first segment is read before the pump waits for room, and nothing it read reserves its delivery: the lease ends (expiry,
    /// cap eviction, removal) while the pump is parked, room returns, and the cached segment is not committed; the stream ends with
    /// an error. The meta frame before it, committed while the lease was live, stays.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_lease_that_ends_while_the_first_segment_waits_commits_nothing_more() {
        let rig = Rig::new(false, 1);
        let running = rig.start(Revocation::default());
        rig.parked(1).await;
        assert_eq!((rig.frames("media-head"), rig.frames("media-chunk")), (1, 1), "head and meta committed, the cached segment waits");
        // The lease's state changes without its event being published yet (the commit is the enforcement).
        rig.leases["lease-1"].valid.store(false, Ordering::SeqCst);
        rig.resume(running).await;
        assert_eq!((rig.frames("media-chunk"), rig.frames("media-end"), rig.frames("media-error")), (1, 0, 1));
    }

    /// The same for a later segment: some are committed while the lease lives, the lease ends in a stall, and none after it is.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_lease_that_ends_while_a_later_segment_waits_commits_nothing_more() {
        let rig = Rig::new(false, 3);
        let running = rig.start(Revocation::default());
        rig.parked(1).await;
        assert_eq!(rig.frames("media-chunk"), 3, "the meta and two segments");
        // The lease's state changes without its event being published yet (the commit is the enforcement).
        rig.leases["lease-1"].valid.store(false, Ordering::SeqCst);
        rig.resume(running).await;
        assert_eq!((rig.frames("media-chunk"), rig.frames("media-end"), rig.frames("media-error")), (3, 0, 1));
    }

    /// An unpair while a gallery stream (which has no lease of its own) waits for room: the capability the request carried is
    /// revoked, so the cached segment is not committed once room returns. A stream under another capability is not affected.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_unpair_while_a_gallery_stream_waits_commits_nothing_more() {
        let rig = Rig::new(true, 1);
        let mine = Revocation::default();
        let running = rig.start(mine.clone());
        rig.parked(1).await;
        mine.revoke();
        rig.resume(running).await;
        assert_eq!((rig.frames("media-chunk"), rig.frames("media-end"), rig.frames("media-error")), (1, 0, 1));
        // A stream under a capability nobody revoked (here, another credential's) runs to its end.
        let rig = Rig::new(true, usize::MAX);
        rig.start(Revocation::default()).await.unwrap();
        assert_eq!(rig.frames("media-end"), 1);
    }

    /// A parked stream whose credential is unpaired, or whose lease ends (expiry, eviction and removal all publish the one event),
    /// ends with no room returned and no writable notification: the serving future returns, its registration is gone, its source
    /// (with the cached segment it read) is dropped, and nothing more than what was committed while permitted was sent. This holds
    /// for a stream parked before its first segment and for one parked behind later segments, on a gallery stream (credential only)
    /// and on a leased one.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_parked_stream_ends_with_its_source_dropped_when_its_credential_or_its_lease_ends_and_no_room_returns() {
        for (gallery, stall_after) in [(false, 1), (false, 3), (true, 1)] {
            for credential in [true, false] {
                if gallery && !credential {
                    continue;
                }
                let rig = Rig::new(gallery, stall_after);
                let capability = Revocation::default();
                let running = rig.start(capability.clone());
                rig.parked(1).await;
                assert_eq!(rig.frames("media-chunk"), stall_after, "gallery={gallery} stall={stall_after}: parked with what was committed");
                if credential {
                    capability.revoke();
                } else {
                    rig.leases["lease-1"].end();
                }
                rig.ended_without_room(running).await;
                let at = format!("gallery={gallery} stall={stall_after} credential={credential}");
                assert_eq!((rig.frames("media-chunk"), rig.frames("media-end")), (stall_after, 0), "{at}: nothing more is committed");
                assert_eq!((rig.lane.active(), rig.dropped.load(Ordering::SeqCst)), (0, 1), "{at}: the registration and the source are released");
            }
        }
    }

    /// The end published before the stream subscribes, and between its subscription and its predicate check, releases it as one that
    /// was waiting: the event is persistent.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_end_published_before_the_subscription_or_between_it_and_the_check_releases_the_stream() {
        // Before the request: the lease is already over when its source is obtained; nothing is sent and the source is released.
        let rig = Rig::new(false, 1);
        rig.leases["lease-1"].end();
        rig.ended_without_room(rig.start(Revocation::default())).await;
        assert_eq!((rig.frames("media-head"), rig.frames("media-chunk"), rig.dropped.load(Ordering::SeqCst), rig.lane.active()), (0, 0, 1, 0));
        // The credential's end before the request: refused before any source is asked.
        let rig = Rig::new(false, 1);
        let revoked = Revocation::default();
        revoked.revoke();
        rig.ended_without_room(rig.start(revoked)).await;
        assert_eq!((rig.frames("media-chunk"), rig.dropped.load(Ordering::SeqCst)), (0, 0));
        // Between the subscription and the check: the room's wait begins after the lane subscribed to the end, and the end lands
        // in that window; the wait is left by the end, with the room still stalled.
        let hook_rig: Arc<StdMutex<Option<TestLease>>> = Arc::new(StdMutex::new(None));
        let hook = {
            let hook_rig = hook_rig.clone();
            Arc::new(move || {
                if let Some(lease) = hook_rig.lock().unwrap().as_ref() {
                    lease.end();
                }
            }) as Arc<dyn Fn() + Send + Sync>
        };
        let rig = Rig::with_wait_hook(false, 1, Some(hook));
        *hook_rig.lock().unwrap() = Some(rig.leases["lease-1"].clone());
        rig.ended_without_room(rig.start(Revocation::default())).await;
        assert_eq!((rig.frames("media-chunk"), rig.frames("media-end"), rig.dropped.load(Ordering::SeqCst), rig.lane.active()), (1, 0, 1, 0));
    }

    /// Room that returns in the ordinary way completes a permitted stream, and ending one lease leaves another's stream parked and
    /// then working: a stream's end is its own authority's.
    #[tokio::test(flavor = "multi_thread")]
    async fn ordinary_capacity_return_completes_a_permitted_stream_and_ending_one_lease_leaves_the_others_working() {
        let rig = Rig::new(false, 4);
        let (first, second) = (rig.start_asset("lease-1", Revocation::default()), rig.start_asset("lease-2", Revocation::default()));
        rig.parked(2).await;
        assert_eq!(rig.lane.active(), 2, "both parked");
        rig.leases["lease-1"].end();
        rig.ended_without_room(first).await;
        assert_eq!(rig.lane.active(), 1, "the other lease's stream is still parked, not ended with it");
        assert_eq!(rig.frames("media-end"), 0);
        rig.resume(second).await;
        assert_eq!((rig.frames("media-end"), rig.frames("media-error")), (1, 1), "the ended lease's stream errored, the other ran to its end");
        assert_eq!(rig.dropped.load(Ordering::SeqCst), 2);
    }

    /// The admission was snapshotted and the task is delayed past the unpair (it stops before it registers its pump, or before its
    /// first read): the request holds the capability the unpair set, so it is refused and nothing is read or sent beyond the refusal.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_request_whose_admission_was_taken_before_an_unpair_is_refused() {
        let rig = Rig::new(true, usize::MAX);
        let snapshot = Revocation::default();
        // The unpair lands between the snapshot and the task's first step (the task is held until it has): what the task holds is
        // the capability the unpair set, the one thing it can still observe.
        snapshot.revoke();
        rig.start(snapshot).await.unwrap();
        let heads: Vec<u64> =
            rig.sent.lock().unwrap().iter().filter(|frame| frame["type"] == "media-head").map(|frame| frame["status"].as_u64().unwrap()).collect();
        assert_eq!(rig.frames("media-chunk"), 0, "no bytes");
        assert!(heads.is_empty() || heads == [403], "{heads:?}: refused, never a 200");
        assert_eq!(rig.lane.active(), 0);
    }

    /// A relay-origin preview of a 100 MB video seeks by range: the window starts where the phone asked, at any variant, and
    /// only the device that holds the lease is answered.
    #[tokio::test]
    async fn a_project_file_lease_is_served_by_range_to_its_device_alone() {
        let reads = Arc::new(StdMutex::new(Vec::new()));
        let sources = Sources(reads.clone());
        let seek = 60 * 1024 * 1024;
        let out = serve(&sources, "original", &format!("bytes={seek}-"), Some("phone-1")).await;
        assert_eq!((out.heads.as_slice(), out.ended), (&[200u16][..], true));
        assert!(out.chunks >= 2, "the meta frame and at least one segment");
        assert_eq!(reads.lock().unwrap()[0].0, seek, "the first read is at the seeked offset, not at the start");
        // The window is one request's share (a longer range continues in the next one), never the whole video.
        let read: usize = reads.lock().unwrap().iter().map(|(_, length)| length).sum();
        assert!(read as u64 <= MEDIA_WINDOW_MAX_BYTES, "{read}");
        reads.lock().unwrap().clear();
        // Whatever the variant, the lease answers; another device, or a session with none, is a 404 that reads nothing.
        assert_eq!(serve(&sources, "thumb", "bytes=0-9", Some("phone-1")).await.heads, vec![200]);
        assert_eq!(serve(&sources, "original", "bytes=0-9", Some("phone-2")).await.heads, vec![404]);
        assert_eq!(serve(&sources, "original", "bytes=0-9", None).await.heads, vec![404]);
        assert_eq!(reads.lock().unwrap().len(), 1, "only the first request read");
    }

    impl Rig {
        fn new(gallery: bool, stall_after: usize) -> Self {
            Self::with_wait_hook(gallery, stall_after, None)
        }

        fn with_wait_hook(gallery: bool, stall_after: usize, on_wait: Option<Arc<dyn Fn() + Send + Sync>>) -> Self {
            let sent = Arc::new(StdMutex::new(Vec::<Value>::new()));
            let (parked, parked_changed) = (Arc::new(AtomicUsize::new(0)), Arc::new(tokio::sync::Notify::new()));
            let (released, drained, dropped) = (Arc::new(AtomicBool::new(false)), Arc::new(tokio::sync::Notify::new()), Arc::new(AtomicUsize::new(0)));
            let leases: HashMap<String, TestLease> = ["lease-1", "lease-2"].iter().map(|asset| ((*asset).to_owned(), TestLease::new())).collect();
            let stalled: Arc<dyn Fn() -> bool + Send + Sync> = {
                let (sent, released) = (sent.clone(), released.clone());
                Arc::new(move || {
                    !released.load(Ordering::SeqCst) && sent.lock().unwrap().iter().filter(|frame| frame["type"] == "media-chunk").count() >= stall_after
                })
            };
            let lane = Arc::new(RelayMediaLane::new(
                Arc::new(Guarded { leases: leases.clone(), gallery, dropped: dropped.clone() }),
                {
                    let sent = sent.clone();
                    Arc::new(move |frame| {
                        sent.lock().unwrap().push(frame);
                        true
                    })
                },
                Arc::new(TestRoom { stalled, drained: drained.clone(), on_wait, parked: parked.clone(), parked_changed: parked_changed.clone() }),
            ));
            Self { lane, sent, leases, dropped, released, drained, parked, parked_changed }
        }

        fn frames(&self, kind: &str) -> usize {
            self.sent.lock().unwrap().iter().filter(|frame| frame["type"] == kind).count()
        }

        fn request(asset: &str) -> MediaRequest {
            MediaRequest {
                id: format!("r-{asset}"),
                asset_id: asset.into(),
                variant: "original".into(),
                method: "GET".into(),
                range: "bytes=0-".into(),
                sid: String::new(),
                enc: MEDIA_SCHEME.into(),
            }
        }

        fn start_asset(&self, asset: &str, revocation: Revocation) -> tokio::task::JoinHandle<()> {
            let (lane, request) = (self.lane.clone(), Self::request(asset));
            tokio::spawn(async move { lane.serve(request, MediaSession { media_key: Some([7; 32]), device: Some("phone-1".into()), revocation }).await })
        }

        fn start(&self, revocation: Revocation) -> tokio::task::JoinHandle<()> {
            self.start_asset("lease-1", revocation)
        }

        /// Waits until `pumps` pumps have parked behind the stalled room: the room announces each wait that begins stalled, and the lane
        /// has by then armed its other subscriptions (the end, the abort, the pause). The count is read after the subscription.
        async fn parked(&self, pumps: usize) {
            let wait = async {
                loop {
                    let begun = self.parked_changed.notified();
                    tokio::pin!(begun);
                    begun.as_mut().enable();
                    if self.parked.load(Ordering::SeqCst) >= pumps {
                        return;
                    }
                    begun.await;
                }
            };
            tokio::time::timeout(Duration::from_secs(10), wait).await.expect("the pumps parked for room");
        }

        /// Room returns: the owner publishes the drain.
        fn release(&self) {
            self.released.store(true, Ordering::SeqCst);
            self.drained.notify_waiters();
        }

        /// The pump has ended on its own, with no room returned: the serving future returned and its registration is gone.
        async fn ended_without_room(&self, running: tokio::task::JoinHandle<()>) {
            tokio::time::timeout(Duration::from_secs(5), running).await.expect("the pump ended with no room returned").unwrap();
        }

        async fn resume(&self, running: tokio::task::JoinHandle<()>) {
            self.release();
            self.ended_without_room(running).await;
        }
    }
}
