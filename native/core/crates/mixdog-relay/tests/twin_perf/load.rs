//! The load of the performance comparison: tokio clients written for the test (a desktop leg, phone legs, an HTTP client, a
//! hook leg), the paired fleet they run against, and the process figures of the relay under test. Nothing here uses the
//! relay's own code: both relays are driven through their sockets exactly as a desktop and a phone drive them.
//!
//! The wire is the one `apps/relay/lib/relay-legs.mjs` describes: the desktop dials `/desktop` with Basic credentials,
//! declares its receiver (`desktop-lanes`), is told about each phone by `client-open`, and answers a phone through a binary
//! routing envelope (`MXR\x01`, flags, id length, id, payload) or a JSON `frame` for text; a phone dials `/ws?token=` with the
//! origin of the relay and sends its frames bare.

use std::future::Future;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use futures::{SinkExt, StreamExt};
use mixdog_testkit as testkit;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use tokio::task::{JoinHandle, JoinSet};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;

type Ws = WebSocketStream<TcpStream>;

/// `MAX_WS_PAYLOAD_BYTES` of the relay: the receiver capacity the desktop declares, so no leg's ceiling is the floor of an
/// undeclared leg.
const DECLARED_CAPACITY: u64 = 68 * 1024 * 1024;
const ENVELOPE_MAGIC: [u8; 4] = [0x4d, 0x58, 0x52, 0x01];
const ENVELOPE_TEXT_FLAG: u8 = 2;
const CLIENT_WAIT: Duration = Duration::from_secs(30);

// ---- time stamps carried in the frames ------------------------------------------------------------------------------

fn epoch() -> Instant {
    static EPOCH: OnceLock<Instant> = OnceLock::new();
    *EPOCH.get_or_init(Instant::now)
}

fn now_micros() -> u64 {
    u64::try_from(epoch().elapsed().as_micros()).unwrap_or(u64::MAX)
}

/// A text payload of `size` characters: `P`, the send time in microseconds (16 digits), then padding.
fn text_body(size: usize) -> String {
    let mut body = format!("P{:016}", now_micros());
    if size > body.len() {
        body.push_str(&"x".repeat(size - body.len()));
    }
    body
}

fn text_sent_at(body: &[u8]) -> Option<u64> {
    let text = std::str::from_utf8(body.get(..17)?).ok()?;
    text.strip_prefix('P')?.parse().ok()
}

fn binary_sent_at(body: &[u8]) -> Option<u64> {
    Some(u64::from_be_bytes(body.get(..8)?.try_into().ok()?))
}

/// The binary routing envelope of a frame for the phone `client_id`, the time stamped as the last step.
fn envelope(client_id: &str, size: usize) -> Vec<u8> {
    let mut frame = Vec::with_capacity(6 + client_id.len() + size);
    frame.extend_from_slice(&ENVELOPE_MAGIC);
    frame.push(0);
    frame.push(u8::try_from(client_id.len()).unwrap_or(u8::MAX));
    frame.extend_from_slice(client_id.as_bytes());
    let at = frame.len();
    frame.resize(at + size.max(8), 0xA5);
    frame[at..at + 8].copy_from_slice(&now_micros().to_be_bytes());
    frame
}

fn binary_payload(size: usize) -> Vec<u8> {
    let mut payload = vec![0xA5; size.max(8)];
    payload[..8].copy_from_slice(&now_micros().to_be_bytes());
    payload
}

fn json_frame(client_id: &str, data: &str) -> Message {
    Message::text(json!({ "type": "frame", "clientId": client_id, "data": data }).to_string())
}

/// A routing envelope read off the desktop leg: the phone's id, whether the payload is text, and the payload.
fn read_envelope(frame: &[u8]) -> Option<(&str, bool, &[u8])> {
    if frame.get(..4)? != ENVELOPE_MAGIC {
        return None;
    }
    let id_end = 6 + usize::from(*frame.get(5)?);
    let id = std::str::from_utf8(frame.get(6..id_end)?).ok()?;
    Some((id, frame[4] & ENVELOPE_TEXT_FLAG != 0, frame.get(id_end..)?))
}

// ---- measurements ---------------------------------------------------------------------------------------------------

/// Latencies (microseconds) of the frames one side received.
#[derive(Default)]
pub struct Recorder {
    samples: Mutex<Vec<u64>>,
    count: AtomicUsize,
}

impl Recorder {
    fn record(&self, sent_at: u64) {
        let latency = now_micros().saturating_sub(sent_at);
        self.samples.lock().unwrap_or_else(PoisonError::into_inner).push(latency);
        self.count.fetch_add(1, Ordering::SeqCst);
    }

    /// Frames received since the start (never reset).
    pub fn count(&self) -> usize {
        self.count.load(Ordering::SeqCst)
    }

    /// The samples so far, emptied.
    pub fn take(&self) -> Vec<u64> {
        std::mem::take(&mut *self.samples.lock().unwrap_or_else(PoisonError::into_inner))
    }
}

/// Nearest-rank percentile of `sorted` (ascending).
pub fn percentile(sorted: &[u64], percent: f64) -> u64 {
    if sorted.is_empty() {
        return 0;
    }
    let rank = ((percent / 100.0) * sorted.len() as f64).ceil() as usize;
    sorted[rank.clamp(1, sorted.len()) - 1]
}

/// Waits (bounded) until `ready` holds.
pub async fn until(limit: Duration, what: &str, mut ready: impl FnMut() -> bool) -> Result<(), String> {
    let end = Instant::now() + limit;
    while !ready() {
        if Instant::now() > end {
            return Err(format!("timed out after {limit:?} waiting for {what}"));
        }
        mixdog_rt::time::sleep(Duration::from_millis(2)).await;
    }
    Ok(())
}

// ---- the paired fleet -----------------------------------------------------------------------------------------------

/// One desktop (or hook worker) the relay knows, and the browser credentials paired to it.
pub struct DeviceSpec {
    pub id: String,
    secret: String,
    tokens: Vec<String>,
}

pub struct Fleet {
    pub devices: Vec<DeviceSpec>,
}

fn sha256_hex(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

impl Fleet {
    /// One device per entry of `phones`, each paired with that many browsers.
    pub fn new(phones: &[usize]) -> Self {
        let devices = phones
            .iter()
            .enumerate()
            .map(|(d, count)| DeviceSpec {
                id: format!("{:08x}-1111-4111-8111-{:012x}", 0xd000_0000_u32 + d as u32, d),
                secret: format!("perf-desktop-secret-{d:05}"),
                tokens: (0..*count).map(|p| format!("perf-phone-token-{d:05}-{p:05}-0123456789abcdef")).collect(),
            })
            .collect();
        Self { devices }
    }

    /// `devices.json` of the data directory, in the form both relays load: every device and browser already paired, so the
    /// load needs no claim flow.
    pub fn write_store(&self, data_dir: &Path) {
        let mut store = Map::new();
        for (d, device) in self.devices.iter().enumerate() {
            let mut clients = Map::new();
            for (p, token) in device.tokens.iter().enumerate() {
                clients.insert(
                    format!("{:08x}-2222-4222-8222-{:012x}", d, p + 1),
                    json!({
                        "tokenHash": sha256_hex(token), "name": "Perf", "platform": "", "browser": "",
                        "createdAt": 1_700_000_000_000_u64, "lastSeenAt": 1_700_000_000_000_u64,
                    }),
                );
            }
            store.insert(
                device.id.clone(),
                json!({ "secretHash": sha256_hex(&device.secret), "clientTokenHash": "", "clients": clients }),
            );
        }
        testkit::create_dir_all(data_dir);
        testkit::write(data_dir.join("devices.json"), Value::Object(store).to_string());
    }
}

/// The renderer tree of the static scenario: an index with a brotli sibling, a 2 MiB hashed asset with its sibling, and a
/// 300 KiB JSON file with none (answered gzipped live). The siblings hold bytes only: nothing decodes them.
pub fn write_renderer(dir: &Path) {
    let filler = |seed: u64, len: usize| -> Vec<u8> {
        let mut state = seed;
        (0..len)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                (state >> 24) as u8
            })
            .collect()
    };
    let mut index = String::from("<!doctype html><title>perf</title><meta charset=\"utf-8\">\n");
    while index.len() < 6 * 1024 {
        index.push_str("<!-- padding of the document, compressible text -->\n");
    }
    let mut data = String::from("[");
    for n in 0..6000 {
        data.push_str(&format!("{{\"id\":{n},\"name\":\"item-{n}\",\"tags\":[\"a\",\"b\",\"c\"],\"value\":{}}},", n * 7));
    }
    data.push_str("{}]");
    testkit::create_dir_all(dir.join("assets"));
    testkit::write(dir.join("index.html"), &index);
    testkit::write(dir.join("index.html.br"), filler(1, 1800));
    testkit::write(dir.join("assets").join("app-0123456789ab.js"), filler(2, 2 * 1024 * 1024));
    testkit::write(dir.join("assets").join("app-0123456789ab.js.br"), filler(3, 700 * 1024));
    testkit::write(dir.join("data.json"), &data.as_bytes()[..300 * 1024]);
}

// ---- sockets --------------------------------------------------------------------------------------------------------

async fn dial(port: u16, path: &str, headers: &[(&'static str, String)]) -> Result<Ws, String> {
    let mut request = format!("ws://127.0.0.1:{port}{path}").into_client_request().map_err(|e| e.to_string())?;
    for (name, value) in headers {
        request.headers_mut().insert(*name, HeaderValue::from_str(value).map_err(|e| e.to_string())?);
    }
    let stream = TcpStream::connect(("127.0.0.1", port)).await.map_err(|e| format!("connect {path}: {e}"))?;
    stream.set_nodelay(true).map_err(|e| e.to_string())?;
    // A relay frame may be up to 64 MiB: the client must take what the relay may send.
    let config = WebSocketConfig::default().max_message_size(Some(256 << 20)).max_frame_size(Some(256 << 20));
    let (socket, _) = tokio_tungstenite::client_async_with_config(request, stream, Some(config))
        .await
        .map_err(|e| format!("upgrade {path}: {e}"))?;
    Ok(socket)
}

fn basic(device: &DeviceSpec) -> (&'static str, String) {
    ("authorization", format!("Basic {}", STANDARD.encode(format!("{}:{}", device.id, device.secret))))
}

/// A paced run of frames of one size: `frames` frames, one per `period`.
#[derive(Clone, Copy)]
pub struct StreamSpec {
    pub binary: bool,
    pub size: usize,
    pub frames: usize,
    pub period: Duration,
}

struct StreamRun {
    spec: StreamSpec,
    remaining: usize,
    next: Instant,
}

impl StreamRun {
    fn start(spec: StreamSpec) -> Self {
        Self { spec, remaining: spec.frames, next: Instant::now() }
    }

    /// One frame went out: the next is due one period after the previous was due. `None` once the run is over.
    fn advance(run: Option<Self>) -> Option<Self> {
        let mut run = run?;
        run.remaining -= 1;
        run.next += run.spec.period;
        (run.remaining > 0).then_some(run)
    }
}

async fn due(at: Option<Instant>) {
    match at {
        Some(at) => mixdog_rt::time::sleep(at.saturating_duration_since(Instant::now())).await,
        None => std::future::pending::<()>().await,
    }
}

// ---- the desktop leg ------------------------------------------------------------------------------------------------

#[derive(Default)]
pub struct DesktopState {
    /// Frames the phones sent up, as the desktop received them.
    pub up: Recorder,
    /// The ids of the phones the relay announced.
    pub clients: Mutex<Vec<String>>,
    capabilities: AtomicBool,
    pub lost: AtomicBool,
}

enum DesktopCmd {
    /// One frame of `size` to every announced phone.
    Each { binary: bool, size: usize },
    /// A paced run of frames to the first announced phone.
    Stream(StreamSpec),
}

pub struct Desktop {
    cmds: UnboundedSender<DesktopCmd>,
    pub state: Arc<DesktopState>,
}

impl Desktop {
    pub fn each(&self, binary: bool, size: usize) {
        let _ = self.cmds.send(DesktopCmd::Each { binary, size });
    }

    pub fn stream(&self, spec: StreamSpec) {
        let _ = self.cmds.send(DesktopCmd::Stream(spec));
    }

    pub fn clients(&self) -> usize {
        self.state.clients.lock().unwrap_or_else(PoisonError::into_inner).len()
    }
}

fn desktop_frame(client: &str, binary: bool, size: usize) -> Message {
    if binary { Message::binary(envelope(client, size)) } else { json_frame(client, &text_body(size)) }
}

/// What the desktop does with one frame of the relay. `false` ends the leg.
async fn desktop_incoming(ws: &mut Ws, state: &DesktopState, message: Message) -> bool {
    match message {
        Message::Text(text) => {
            let Ok(value) = serde_json::from_str::<Value>(text.as_str()) else { return true };
            match value.get("type").and_then(Value::as_str) {
                Some("relay-capabilities") => state.capabilities.store(true, Ordering::SeqCst),
                Some("client-open") => {
                    let Some(id) = value.get("clientId").and_then(Value::as_str) else { return true };
                    state.clients.lock().unwrap_or_else(PoisonError::into_inner).push(id.to_owned());
                    // The challenge turn a phone's handshake is owed.
                    return ws.send(json_frame(id, "challenge")).await.is_ok();
                }
                _ => {}
            }
            true
        }
        Message::Binary(bytes) => {
            let Some((id, text, payload)) = read_envelope(&bytes) else { return true };
            if text && payload == b"hello" {
                return ws.send(json_frame(id, "ready")).await.is_ok();
            }
            if let Some(sent) = if text { text_sent_at(payload) } else { binary_sent_at(payload) } {
                state.up.record(sent);
            }
            true
        }
        Message::Close(_) => false,
        _ => true,
    }
}

async fn desktop_task(mut ws: Ws, mut cmds: UnboundedReceiver<DesktopCmd>, state: Arc<DesktopState>) {
    let mut stream: Option<StreamRun> = None;
    loop {
        let pace = due(stream.as_ref().map(|run| run.next));
        tokio::select! {
            command = cmds.recv() => {
                let Some(command) = command else { return };
                match command {
                    DesktopCmd::Each { binary, size } => {
                        let clients = state.clients.lock().unwrap_or_else(PoisonError::into_inner).clone();
                        for client in clients {
                            if ws.send(desktop_frame(&client, binary, size)).await.is_err() {
                                state.lost.store(true, Ordering::SeqCst);
                                return;
                            }
                        }
                    }
                    DesktopCmd::Stream(spec) => stream = Some(StreamRun::start(spec)),
                }
            }
            incoming = ws.next() => {
                let Some(Ok(message)) = incoming else {
                    state.lost.store(true, Ordering::SeqCst);
                    return;
                };
                if !desktop_incoming(&mut ws, &state, message).await {
                    state.lost.store(true, Ordering::SeqCst);
                    return;
                }
            }
            () = pace => {
                let Some(run) = stream.as_ref() else { continue };
                let client = state.clients.lock().unwrap_or_else(PoisonError::into_inner).first().cloned().unwrap_or_default();
                if ws.send(desktop_frame(&client, run.spec.binary, run.spec.size)).await.is_err() {
                    state.lost.store(true, Ordering::SeqCst);
                    return;
                }
                stream = StreamRun::advance(stream.take());
            }
        }
    }
}

/// Dials `/desktop`, declares the receiver, and returns once the relay has attached the leg (its first capabilities frame).
pub async fn connect_desktop(port: u16, device: &DeviceSpec) -> Result<Desktop, String> {
    let mut ws = dial(port, "/desktop", &[basic(device)]).await?;
    let lanes = json!({ "type": "desktop-lanes", "media": true, "maxPayloadBytes": DECLARED_CAPACITY, "textFrames": 1 });
    ws.send(Message::text(lanes.to_string())).await.map_err(|e| e.to_string())?;
    let state = Arc::new(DesktopState::default());
    let (cmds, commands) = unbounded_channel();
    tokio::spawn(desktop_task(ws, commands, state.clone()));
    until(CLIENT_WAIT, "the relay to attach the desktop leg", || state.capabilities.load(Ordering::SeqCst)).await?;
    Ok(Desktop { cmds, state })
}

// ---- the phone legs -------------------------------------------------------------------------------------------------

/// What all the phones of a run share.
#[derive(Default)]
pub struct Shared {
    /// Frames the desktop sent down, as the phones received them.
    pub down: Recorder,
    /// Phones whose handshake the desktop completed.
    pub ready: AtomicUsize,
    /// Phone legs the relay or the socket ended.
    pub lost: AtomicUsize,
}

enum PhoneCmd {
    Perf { binary: bool, size: usize },
    Stream(StreamSpec),
}

pub struct Phone {
    cmds: UnboundedSender<PhoneCmd>,
}

impl Phone {
    pub fn send(&self, binary: bool, size: usize) {
        let _ = self.cmds.send(PhoneCmd::Perf { binary, size });
    }

    pub fn stream(&self, spec: StreamSpec) {
        let _ = self.cmds.send(PhoneCmd::Stream(spec));
    }
}

fn phone_frame(binary: bool, size: usize) -> Message {
    if binary { Message::binary(binary_payload(size)) } else { Message::text(text_body(size)) }
}

async fn phone_task(mut ws: Ws, mut cmds: UnboundedReceiver<PhoneCmd>, shared: Arc<Shared>) {
    let mut stream: Option<StreamRun> = None;
    loop {
        let pace = due(stream.as_ref().map(|run| run.next));
        tokio::select! {
            command = cmds.recv() => {
                match command {
                    None => return,
                    Some(PhoneCmd::Perf { binary, size }) => {
                        if ws.send(phone_frame(binary, size)).await.is_err() {
                            shared.lost.fetch_add(1, Ordering::SeqCst);
                            return;
                        }
                    }
                    Some(PhoneCmd::Stream(spec)) => stream = Some(StreamRun::start(spec)),
                }
            }
            incoming = ws.next() => {
                let Some(Ok(message)) = incoming else {
                    shared.lost.fetch_add(1, Ordering::SeqCst);
                    return;
                };
                match message {
                    Message::Text(text) => match text.as_str() {
                        "challenge" => {
                            if ws.send(Message::text("hello")).await.is_err() {
                                shared.lost.fetch_add(1, Ordering::SeqCst);
                                return;
                            }
                        }
                        "ready" => {
                            shared.ready.fetch_add(1, Ordering::SeqCst);
                        }
                        body => {
                            if let Some(sent) = text_sent_at(body.as_bytes()) {
                                shared.down.record(sent);
                            }
                        }
                    },
                    Message::Binary(bytes) => {
                        if let Some(sent) = binary_sent_at(&bytes) {
                            shared.down.record(sent);
                        }
                    }
                    Message::Close(_) => {
                        shared.lost.fetch_add(1, Ordering::SeqCst);
                        return;
                    }
                    _ => {}
                }
            }
            () = pace => {
                let Some(run) = stream.as_ref() else { continue };
                if ws.send(phone_frame(run.spec.binary, run.spec.size)).await.is_err() {
                    shared.lost.fetch_add(1, Ordering::SeqCst);
                    return;
                }
                stream = StreamRun::advance(stream.take());
            }
        }
    }
}

/// Dials `/ws` with a paired browser's token and the relay's own origin.
pub async fn connect_phone(port: u16, token: &str, shared: Arc<Shared>) -> Result<Phone, String> {
    let ws = dial(port, &format!("/ws?token={token}"), &[("origin", format!("http://127.0.0.1:{port}"))]).await?;
    let (cmds, commands) = unbounded_channel();
    tokio::spawn(phone_task(ws, commands, shared));
    Ok(Phone { cmds })
}

/// A desktop with its phones, connected and through their handshake.
pub struct Rig {
    pub desktops: Vec<Desktop>,
    pub phones: Vec<Phone>,
    pub shared: Arc<Shared>,
}

/// Connects every device of the fleet as a desktop and every paired browser as a phone (`concurrency` dials at a time) and
/// waits until each phone is announced to its desktop and has been through the handshake.
pub async fn connect_fleet(port: u16, fleet: &Fleet, concurrency: usize) -> Result<Rig, String> {
    let shared = Arc::new(Shared::default());
    let mut desktops = Vec::new();
    for device in &fleet.devices {
        desktops.push(connect_desktop(port, device).await?);
    }
    let mut phones = Vec::new();
    let mut pending = JoinSet::new();
    let mut tokens = fleet.devices.iter().flat_map(|device| device.tokens.iter().cloned());
    loop {
        while pending.len() < concurrency {
            let Some(token) = tokens.next() else { break };
            let shared = shared.clone();
            pending.spawn(async move { connect_phone(port, &token, shared).await });
        }
        let Some(joined) = pending.join_next().await else { break };
        phones.push(joined.map_err(|e| e.to_string())??);
    }
    let wanted = phones.len();
    until(CLIENT_WAIT, "every phone to be announced and through its handshake", || {
        shared.ready.load(Ordering::SeqCst) >= wanted
            && desktops.iter().zip(&fleet.devices).all(|(desktop, device)| desktop.clients() == device.tokens.len())
    })
    .await?;
    Ok(Rig { desktops, phones, shared })
}

/// A refused `/ws` upgrade: the handshake completes and the relay closes with its pairing code. Returns that code.
pub async fn refused_upgrade(port: u16) -> Result<u16, String> {
    let mut ws = dial(port, "/ws", &[("origin", format!("http://127.0.0.1:{port}"))]).await?;
    loop {
        match ws.next().await {
            Some(Ok(Message::Close(Some(frame)))) => return Ok(u16::from(frame.code)),
            Some(Ok(Message::Close(None))) => return Ok(1005),
            Some(Ok(_)) => {}
            Some(Err(error)) => return Err(error.to_string()),
            None => return Err("the relay closed the socket without a close frame".to_owned()),
        }
    }
}

// ---- the hook leg ---------------------------------------------------------------------------------------------------

/// The task of a hook worker, ended when this is dropped.
pub struct HookLeg(JoinHandle<()>);

impl Drop for HookLeg {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Dials `/hookleg` and answers every forwarded request with `200 ok`.
pub async fn connect_hook(port: u16, device: &DeviceSpec) -> Result<HookLeg, String> {
    let mut ws = dial(port, "/hookleg", &[basic(device)]).await?;
    Ok(HookLeg(tokio::spawn(async move {
        while let Some(Ok(message)) = ws.next().await {
            let Message::Text(text) = message else { continue };
            let Ok(request) = serde_json::from_str::<Value>(text.as_str()) else { continue };
            if request.get("type").and_then(Value::as_str) != Some("http") {
                continue;
            }
            let answer = json!({
                "type": "http-response", "id": request.get("id"), "status": 200,
                "headers": { "content-type": "text/plain" }, "body": STANDARD.encode("ok"),
            });
            if ws.send(Message::text(answer.to_string())).await.is_err() {
                return;
            }
        }
    })))
}

// ---- HTTP -----------------------------------------------------------------------------------------------------------

/// `GET path` with `Accept-Encoding: br, gzip` and `Connection: close`; the status and the bytes of the whole answer.
pub async fn http_get(port: u16, path: &str) -> Result<(u16, usize), String> {
    let exchange = async {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.map_err(|e| e.to_string())?;
        stream.set_nodelay(true).map_err(|e| e.to_string())?;
        let request =
            format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept-Encoding: br, gzip\r\nConnection: close\r\n\r\n");
        stream.write_all(request.as_bytes()).await.map_err(|e| e.to_string())?;
        let mut answer = Vec::new();
        stream.read_to_end(&mut answer).await.map_err(|e| e.to_string())?;
        let status = answer
            .get(9..12)
            .and_then(|code| std::str::from_utf8(code).ok())
            .and_then(|code| code.parse::<u16>().ok())
            .ok_or_else(|| format!("no status line in {} bytes", answer.len()))?;
        Ok::<_, String>((status, answer.len()))
    };
    match mixdog_rt::time::timeout(Duration::from_secs(60), exchange).await {
        Ok(result) => result,
        Err(_) => Err(format!("GET {path} did not finish in 60 s")),
    }
}

/// `total` jobs over `workers` tasks; the time the whole took and the time of each job in microseconds.
pub async fn pool<F, Fut>(total: usize, workers: usize, job: F) -> Result<(Duration, Vec<u64>), String>
where
    F: Fn(usize) -> Fut + Clone + Send + Sync + 'static,
    Fut: Future<Output = Result<(), String>> + Send + 'static,
{
    let next = Arc::new(AtomicUsize::new(0));
    let started = Instant::now();
    let mut tasks = JoinSet::new();
    for _ in 0..workers {
        let (next, job) = (next.clone(), job.clone());
        tasks.spawn(async move {
            let mut times = Vec::new();
            loop {
                let index = next.fetch_add(1, Ordering::SeqCst);
                if index >= total {
                    return Ok::<_, String>(times);
                }
                let begun = Instant::now();
                job(index).await?;
                times.push(u64::try_from(begun.elapsed().as_micros()).unwrap_or(u64::MAX));
            }
        });
    }
    let mut times = Vec::new();
    while let Some(done) = tasks.join_next().await {
        times.extend(done.map_err(|e| e.to_string())??);
    }
    Ok((started.elapsed(), times))
}

// ---- the relay process ----------------------------------------------------------------------------------------------

/// What the operating system says of the relay process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcessFigures {
    /// The largest resident set the process has had.
    pub peak_rss: u64,
    /// The resident set now.
    pub rss: u64,
    /// Processor time (user and kernel) since the process started.
    pub cpu_ms: u64,
}

/// The pid listening on `port` out of `netstat -ano` output.
pub fn netstat_listener(output: &str, port: u16) -> Option<u32> {
    let suffix = format!(":{port}");
    output.lines().find_map(|line| {
        let fields: Vec<&str> = line.split_whitespace().collect();
        match fields.as_slice() {
            [_, local, _, "LISTENING", pid] if local.ends_with(&suffix) => pid.parse().ok(),
            _ => None,
        }
    })
}

/// The pid of `ss -ltnpH` output.
pub fn ss_listener(output: &str) -> Option<u32> {
    let rest = output.split("pid=").nth(1)?;
    rest.split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()
}

/// The pid of the process listening on `port` (the relay is a direct child of the test, and the harness does not name its
/// pid).
pub fn listener_pid(port: u16) -> Result<u32, String> {
    use std::ffi::OsStr;
    let found = if cfg!(windows) {
        netstat_listener(&testkit::output("netstat", &[OsStr::new("-ano"), OsStr::new("-p"), OsStr::new("TCP")]), port)
    } else {
        let filter = format!("sport = :{port}");
        ss_listener(&testkit::output("ss", &[OsStr::new("-ltnpH"), OsStr::new(&filter)]))
    };
    found.ok_or_else(|| format!("no process listens on port {port}"))
}

/// `Name:  <n> kB` of a `/proc/<pid>/status`, in bytes.
pub fn status_kib(status: &str, name: &str) -> Option<u64> {
    let line = status.lines().find(|line| line.starts_with(name))?;
    Some(line.split_whitespace().nth(1)?.parse::<u64>().ok()? * 1024)
}

/// User plus kernel time of a `/proc/<pid>/stat`, in milliseconds (the clock tick is 100 Hz on every Linux the relay runs on).
pub fn stat_cpu_ms(stat: &str) -> Option<u64> {
    let fields: Vec<&str> = stat.rsplit_once(')')?.1.split_whitespace().collect();
    Some((fields.get(11)?.parse::<u64>().ok()? + fields.get(12)?.parse::<u64>().ok()?) * 10)
}

pub fn process_figures(pid: u32) -> Result<ProcessFigures, String> {
    use std::ffi::OsStr;
    if cfg!(windows) {
        let script = format!(
            "$p = Get-Process -Id {pid}; \"$($p.PeakWorkingSet64) $($p.WorkingSet64) $([int64]$p.TotalProcessorTime.TotalMilliseconds)\""
        );
        let answer = testkit::output("powershell", &[OsStr::new("-NoProfile"), OsStr::new("-Command"), OsStr::new(&script)]);
        let numbers: Vec<u64> = answer.split_whitespace().filter_map(|word| word.parse().ok()).collect();
        let &[peak_rss, rss, cpu_ms] = numbers.as_slice() else {
            return Err(format!("process {pid}: unreadable figures {answer:?}"));
        };
        Ok(ProcessFigures { peak_rss, rss, cpu_ms })
    } else {
        let status = testkit::read_string(format!("/proc/{pid}/status"));
        let stat = testkit::read_string(format!("/proc/{pid}/stat"));
        Ok(ProcessFigures {
            peak_rss: status_kib(&status, "VmHWM:").ok_or("VmHWM missing")?,
            rss: status_kib(&status, "VmRSS:").ok_or("VmRSS missing")?,
            cpu_ms: stat_cpu_ms(&stat).ok_or("unreadable stat")?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn netstat_names_the_listener_of_the_port() {
        let output = "  TCP    0.0.0.0:135     0.0.0.0:0     LISTENING       1000\n  TCP    [::]:43211   [::]:0     LISTENING       4321\n  TCP    127.0.0.1:43211   127.0.0.1:50000   ESTABLISHED   4321\n";
        assert_eq!(netstat_listener(output, 43211), Some(4321));
        assert_eq!(netstat_listener(output, 4321), None);
    }

    #[test]
    fn ss_and_proc_files_are_read() {
        assert_eq!(ss_listener("LISTEN 0 511 0.0.0.0:43211 0.0.0.0:* users:((\"node\",pid=1234,fd=20))"), Some(1234));
        assert_eq!(status_kib("Name:\tx\nVmHWM:\t  2048 kB\nVmRSS:\t 1024 kB\n", "VmHWM:"), Some(2048 * 1024));
        assert_eq!(stat_cpu_ms("12 (my (proc)) S 1 2 3 4 5 6 7 8 9 10 250 50 0"), Some(3000));
    }

    #[test]
    fn frames_carry_their_send_time() {
        let frame = envelope("0123456789abcdef", 64);
        let (id, text, payload) = read_envelope(&frame).expect("an envelope");
        assert_eq!((id, text, payload.len()), ("0123456789abcdef", false, 64));
        assert!(binary_sent_at(payload).is_some());
        let body = text_body(100);
        assert_eq!(body.len(), 100);
        assert!(text_sent_at(body.as_bytes()).is_some());
        assert_eq!(text_sent_at(b"challenge"), None);
    }

    #[test]
    fn percentiles_are_nearest_rank() {
        let sorted: Vec<u64> = (1..=100).collect();
        assert_eq!((percentile(&sorted, 50.0), percentile(&sorted, 99.0), percentile(&sorted, 100.0)), (50, 99, 100));
        assert_eq!(percentile(&[], 50.0), 0);
    }
}
