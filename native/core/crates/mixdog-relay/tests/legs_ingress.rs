//! Uplink admission and refusal of oversize frames, run against this crate's WebSocket server with raw byte clients: refusal while a frame is still arriving, the ceiling, bursts, coalesced reads, fragmentation, and the shared pool.

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use bytes::Bytes;
use mixdog_relay::legs::ingress::{Admit, AdmitQuery, HOOK_FRAME_LIMIT_BYTES, IngressLeg, IngressLimits, IngressPool, LegKind, Sweep, admit_ingress};
use mixdog_relay::legs::policy::{INGRESS_FREE_WINDOW_BYTES, INGRESS_RESERVATION_BYTES, MAX_INGRESS_BYTES, MAX_WS_PAYLOAD_BYTES, Oversize, check_oversize};
use mixdog_relay::ws::{HandshakeRequest, ServerOptions, WebSocket, WebSocketServer, WsEvent};
use mixdog_rt::time::{Instant, sleep};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::tcp::OwnedReadHalf;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

mod support;
use support::eventually;

const KEY: &str = "dGhlIHNhbXBsZSBub25jZQ==";
const MASK: [u8; 4] = [0x0a, 0x0b, 0x0c, 0x0d];
const CLIENT_ID: &str = "12345678-abcd-4321-abcd-1234567890ab";

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

// ---- wire helpers ----

fn upgrade() -> Vec<u8> {
    format!("GET /ws HTTP/1.1\r\nHost: relay\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {KEY}\r\nSec-WebSocket-Version: 13\r\n\r\n")
        .into_bytes()
}

fn masked(payload: &[u8]) -> impl Iterator<Item = u8> + '_ {
    payload.iter().enumerate().map(|(index, byte)| byte ^ MASK[index % 4])
}

/// One masked client frame; `first` is the FIN, RSV and opcode byte.
fn frame(first: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = vec![first];
    if payload.len() < 126 {
        out.push(0x80 | payload.len() as u8);
    } else if payload.len() <= 0xffff {
        out.push(0x80 | 126);
        out.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    } else {
        out.push(0x80 | 127);
        out.extend_from_slice(&(payload.len() as u64).to_be_bytes());
    }
    out.extend_from_slice(&MASK);
    out.extend(masked(payload));
    out
}

/// A frame whose header declares `declared` bytes and carries `payload`.
fn frame_declaring(first: u8, declared: u64, payload: &[u8]) -> Vec<u8> {
    let mut out = vec![first, 0x80 | 127];
    out.extend_from_slice(&declared.to_be_bytes());
    out.extend_from_slice(&MASK);
    out.extend(masked(payload));
    out
}

fn text(message: &str) -> Vec<u8> {
    frame(0x81, message.as_bytes())
}

fn envelope(data: &str) -> String {
    format!("{{\"type\":\"frame\",\"clientId\":\"{CLIENT_ID}\",\"data\":\"{data}\"}}")
}

// ---- a leg, as the sockets code runs it ----

type Frames = Arc<Mutex<Vec<(u8, Vec<u8>)>>>;

struct Delivered {
    data: Vec<u8>,
    announced: bool,
    fits: bool,
}

struct Harness {
    server: Arc<WebSocketServer>,
    pool: IngressPool,
}

struct Peer {
    out: mpsc::UnboundedSender<Option<Vec<u8>>>,
    reader: JoinHandle<()>,
    frames: Frames,
    delivered: Arc<Mutex<Vec<Delivered>>>,
    closed: Arc<Mutex<Option<u16>>>,
    ws: WebSocket,
    leg: IngressLeg,
}

async fn read_client(mut read: OwnedReadHalf, frames: Frames) {
    let mut buffer: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; 64 * 1024];
    let mut head_done = false;
    loop {
        let Ok(count) = read.read(&mut chunk).await else { return };
        if count == 0 {
            return;
        }
        buffer.extend_from_slice(&chunk[..count]);
        if !head_done {
            let Some(end) = buffer.windows(4).position(|window| window == b"\r\n\r\n") else { continue };
            buffer.drain(..end + 4);
            head_done = true;
        }
        loop {
            if buffer.len() < 2 {
                break;
            }
            let (header, length) = match buffer[1] & 0x7f {
                126 if buffer.len() >= 4 => (4, usize::from(u16::from_be_bytes([buffer[2], buffer[3]]))),
                126 => break,
                127 if buffer.len() >= 10 => {
                    let mut wide = [0u8; 8];
                    wide.copy_from_slice(&buffer[2..10]);
                    (10, usize::try_from(u64::from_be_bytes(wide)).unwrap_or(usize::MAX))
                }
                127 => break,
                short => (2, usize::from(short)),
            };
            if buffer.len() < header + length {
                break;
            }
            let opcode = buffer[0] & 0x0f;
            let payload = buffer[header..header + length].to_vec();
            buffer.drain(..header + length);
            if opcode != 0x0a {
                locked(&frames).push((opcode, payload));
            }
        }
    }
}

impl Harness {
    fn new(max_payload: u64) -> Self {
        Self { server: Arc::new(WebSocketServer::new(ServerOptions::new(max_payload))), pool: IngressPool::new() }
    }

    async fn phone(&self, limits: IngressLimits) -> Peer {
        let limit = limits.limit;
        self.connect(LegKind::Phone { limit_for: Arc::new(move |_| limit) }, limits).await
    }

    async fn desktop(&self, limits: IngressLimits) -> Peer {
        self.connect(LegKind::Desktop, limits).await
    }

    async fn connect(&self, kind: LegKind, limits: IngressLimits) -> Peer {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("address").port();
        let mut client = TcpStream::connect(("127.0.0.1", port)).await.expect("connect");
        let (mut stream, _) = listener.accept().await.expect("accept");
        client.write_all(&upgrade()).await.expect("write the head");
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 4096];
        let (request, end) = loop {
            let count = stream.read(&mut chunk).await.expect("read the head");
            assert!(count > 0, "the head was cut");
            buffer.extend_from_slice(&chunk[..count]);
            let mut headers = [httparse::EMPTY_HEADER; 32];
            let mut parsed = httparse::Request::new(&mut headers);
            if let httparse::Status::Complete(end) = parsed.parse(&buffer).expect("a request head") {
                let request = HandshakeRequest {
                    method: parsed.method.expect("a method").to_string(),
                    headers: parsed.headers.iter().map(|header| (header.name.to_string(), String::from_utf8_lossy(header.value).into_owned())).collect(),
                };
                break (request, end);
            }
        };
        let leftover = Bytes::copy_from_slice(&buffer[end..]);
        let (ws, mut events) = match self.server.handle_upgrade(&request, stream, leftover).await {
            Ok(pair) => pair,
            Err(_) => panic!("the upgrade was refused"),
        };
        let limit = limits.limit;
        let leg = IngressLeg::install(&self.pool, &ws, kind, limits);

        let delivered: Arc<Mutex<Vec<Delivered>>> = Arc::default();
        let closed: Arc<Mutex<Option<u16>>> = Arc::default();
        let (seen, seen_closed, own) = (Arc::clone(&delivered), Arc::clone(&closed), leg.clone());
        tokio::spawn(async move {
            while let Some(event) = events.next().await {
                match event {
                    WsEvent::Message { data, is_binary } => {
                        let announced = own.note_delivery();
                        let verdict = check_oversize(data.len(), limit, announced);
                        if verdict == (Oversize::Refused { announce: true }) {
                            own.signal_oversize(data.len(), limit, &data, is_binary);
                        }
                        locked(&seen).push(Delivered { data: data.to_vec(), announced, fits: verdict == Oversize::Fits });
                    }
                    WsEvent::Close { code, .. } => {
                        own.release();
                        *locked(&seen_closed) = Some(code);
                    }
                    _ => {}
                }
            }
        });

        let (read, mut write) = client.into_split();
        let frames: Frames = Arc::default();
        let reader = tokio::spawn(read_client(read, Arc::clone(&frames)));
        let (out, mut queue) = mpsc::unbounded_channel::<Option<Vec<u8>>>();
        tokio::spawn(async move {
            while let Some(Some(bytes)) = queue.recv().await {
                if write.write_all(&bytes).await.is_err() {
                    break;
                }
            }
        });
        Peer { out, reader, frames, delivered, closed, ws, leg }
    }
}

impl Peer {
    /// Queue bytes for the wire; they are written in order by a task, so a peer the server stopped reading never blocks a test.
    fn send(&self, bytes: Vec<u8>) {
        let _ = self.out.send(Some(bytes));
    }

    /// Drop the client's connection.
    fn kill(&self) {
        let _ = self.out.send(None);
        self.reader.abort();
    }

    fn notices(&self) -> Vec<Value> {
        locked(&self.frames)
            .iter()
            .filter(|(opcode, _)| *opcode == 1)
            .filter_map(|(_, payload)| serde_json::from_slice::<Value>(payload).ok())
            .filter(|value| value["error"] == "frame-too-large" || value["type"] == "frame-too-large")
            .collect()
    }

    fn close_code(&self) -> Option<u16> {
        locked(&self.frames).iter().find(|(opcode, _)| *opcode == 8).map(|(_, payload)| u16::from_be_bytes([payload[0], payload[1]]))
    }

    fn close_frame(&self) -> Option<(u16, String)> {
        locked(&self.frames)
            .iter()
            .find(|(opcode, _)| *opcode == 8)
            .map(|(_, payload)| (u16::from_be_bytes([payload[0], payload[1]]), String::from_utf8_lossy(&payload[2..]).into_owned()))
    }

    fn delivered_count(&self) -> usize {
        locked(&self.delivered).len()
    }

    fn delivered_flags(&self) -> Vec<(usize, bool, bool)> {
        locked(&self.delivered).iter().map(|item| (item.data.len(), item.announced, item.fits)).collect()
    }
}

fn number(value: &Value, key: &str) -> u64 {
    value[key].as_u64().unwrap_or_else(|| panic!("{key} is not a number in {value}"))
}

// ---- the cases ----

#[tokio::test]
async fn a_refusal_is_announced_while_the_frame_is_still_arriving_and_only_once() {
    let harness = Harness::new(256 * 1024);
    let limits = IngressLimits { limit: 64 * 1024, transport: 256 * 1024, window: 8 * 1024, ..IngressLimits::default() };
    let peer = harness.phone(limits).await;
    // Half a frame proves the timing: the header DECLARES 4 MiB, a message the transport can never carry, so it is answered
    // while most of it is still on the wire. That is the only moment anything can be said about it.
    let oversize = 4 * 1024 * 1024;
    peer.send(frame_declaring(0x81, oversize, &vec![b'x'; 64 * 1024]));
    eventually("the refusal", || !peer.notices().is_empty()).await;
    let notices = peer.notices();
    assert_eq!(notices.len(), 1);
    // Like for like: the size declared for this message against the application limit.
    assert_eq!(number(&notices[0], "bytes"), oversize);
    assert_eq!(number(&notices[0], "limit"), 64 * 1024);
    assert_eq!(notices[0]["resync"], 1);
    assert_eq!(peer.delivered_count(), 0);
    // The refusal precedes the transport's own answer, and is not repeated.
    eventually("the transport's close", || peer.close_code().is_some()).await;
    assert_eq!(peer.close_code(), Some(1009));
    assert_eq!(peer.notices().len(), 1);
}

#[tokio::test]
async fn exactly_at_the_ceiling_is_forwarded_unwarned_and_one_byte_over_is_refused_once() {
    let harness = Harness::new(MAX_WS_PAYLOAD_BYTES as u64);
    let limit = 64 * 1024;
    let peer = harness.phone(IngressLimits::with_limit(limit)).await;
    // Exactly at the ceiling is SUPPORTED traffic: header and mask bytes are never counted against it.
    peer.send(text(&"e".repeat(limit)));
    eventually("the frame at the ceiling", || peer.delivered_count() == 1).await;
    assert_eq!(peer.delivered_flags(), vec![(limit, false, true)]);
    assert!(peer.notices().is_empty());
    // One byte over is refused, once, with numbers the sender can compare against the size it recorded.
    peer.send(text(&"e".repeat(limit + 1)));
    eventually("the refusal", || !peer.notices().is_empty()).await;
    sleep(Duration::from_millis(200)).await;
    let notices = peer.notices();
    assert_eq!(notices.len(), 1);
    assert_eq!(number(&notices[0], "bytes"), limit as u64 + 1);
    assert_eq!(number(&notices[0], "limit"), limit as u64);
    assert_eq!(peer.delivered_flags(), vec![(limit, false, true), (limit + 1, false, false)]);
    assert!(peer.ws.is_open());
}

#[tokio::test]
async fn a_burst_of_control_frames_pins_no_reservation() {
    let harness = Harness::new(MAX_WS_PAYLOAD_BYTES as u64);
    // A tiny window: if control frames counted as message bytes at all, this many of them would reserve, and never give it back.
    let limits = IngressLimits { window: 4 * 1024, reservation: 1024 * 1024, ceiling: 2 * 1024 * 1024, ..IngressLimits::default() };
    let peer = harness.phone(limits).await;
    harness.pool.reset_stats();
    let mut burst = Vec::with_capacity(50_000 * 6 + 32);
    for _ in 0..50_000 {
        burst.extend_from_slice(&frame(0x89, b""));
    }
    burst.extend_from_slice(&text("after-the-burst"));
    peer.send(burst);
    // The stream is ordered, so this message landing means every ping ahead of it has been metered.
    eventually("the message after the burst", || peer.delivered_count() == 1).await;
    let stats = harness.pool.stats();
    assert_eq!((stats.peak, stats.reserved, stats.waiting, stats.deferrals), (0, 0, 0, 0));
    assert!(peer.ws.is_open());
}

#[tokio::test]
async fn messages_coalesced_into_one_read_are_refused_at_most_once_each() {
    let harness = Harness::new(MAX_WS_PAYLOAD_BYTES as u64);
    // The transport size is small here so the first message is refused by the meter while it arrives; the second one is
    // ordinary. Refusal state kept on the LEG would be overwritten by the second header before the first is delivered.
    let limits = IngressLimits { limit: 4096, transport: 4096, ..IngressLimits::default() };
    let peer = harness.desktop(limits).await;
    let early = envelope(&"y".repeat(5000));
    let ordinary = envelope("ok");
    let mut wire = text(&early);
    wire.extend(text(&ordinary));
    peer.send(wire);
    eventually("both messages", || peer.delivered_count() == 2).await;
    sleep(Duration::from_millis(200)).await;
    let notices = peer.notices();
    assert_eq!(notices.len(), 1, "refused once");
    assert_eq!(number(&notices[0], "bytes"), early.len() as u64);
    assert_eq!(number(&notices[0], "limit"), 4096);
    // The delivered refusal is the one the meter already announced, so the delivery path stayed silent.
    assert_eq!(peer.delivered_flags(), vec![(early.len(), true, false), (ordinary.len(), false, true)]);

    // The same two messages with a transport that carries them: the delivery path refuses the first, once.
    let late = harness.desktop(IngressLimits { limit: 4096, ..IngressLimits::default() }).await;
    let mut wire = text(&early);
    wire.extend(text(&ordinary));
    late.send(wire);
    eventually("both messages", || late.delivered_count() == 2).await;
    sleep(Duration::from_millis(200)).await;
    let notices = late.notices();
    assert_eq!(notices.len(), 1);
    assert_eq!(number(&notices[0], "bytes"), early.len() as u64);
    assert_eq!(notices[0]["clientId"], CLIENT_ID);
    assert_eq!(late.delivered_flags(), vec![(early.len(), false, false), (ordinary.len(), false, true)]);
}

#[tokio::test]
async fn a_fragmented_message_past_the_transport_is_refused_before_the_close() {
    let harness = Harness::new(256 * 1024);
    let limits = IngressLimits { limit: 64 * 1024, transport: 256 * 1024, ..IngressLimits::default() };
    let peer = harness.desktop(limits).await;
    // A message split across frames only overruns the transport on a LATER fragment.
    let fragment = 200 * 1024;
    let head = envelope("");
    let head = &head[..head.len() - 2];
    let first = frame(0x01, format!("{head}{}", "y".repeat(fragment - head.len())).as_bytes());
    let second = frame(0x80, "z".repeat(fragment).as_bytes());
    peer.send(first);
    sleep(Duration::from_millis(150)).await;
    // The first fragment is within the transport: nothing to say yet.
    assert!(peer.notices().is_empty());
    peer.send(second);
    eventually("the refusal", || !peer.notices().is_empty()).await;
    let notices = peer.notices();
    assert_eq!(notices.len(), 1);
    // Everything the sender declared for this message, against the application ceiling it broke.
    assert_eq!(number(&notices[0], "bytes"), 2 * fragment as u64);
    assert_eq!(number(&notices[0], "limit"), 64 * 1024);
    // Decided from the head alone, which cannot prove that no later top-level clientId follows: the notice names nobody.
    assert!(notices[0].get("clientId").is_none());
    eventually("the transport's close", || peer.close_code().is_some()).await;
    assert_eq!(peer.close_code(), Some(1009));
    assert_eq!(peer.notices().len(), 1);
}

#[tokio::test]
async fn a_declared_but_never_completed_frame_is_not_described_as_a_message() {
    let harness = Harness::new(MAX_WS_PAYLOAD_BYTES as u64);
    let peer = harness.phone(IngressLimits::with_limit(4096)).await;
    // 5000 bytes promised, 512 handed over: a declaration is not a message, so while the transport can still carry it nothing
    // is refused.
    let declared = 5000;
    let wire = text(&"q".repeat(declared));
    let (header, body) = wire.split_at(wire.len() - declared);
    let mut partial = header.to_vec();
    partial.extend_from_slice(&body[..512]);
    peer.send(partial);
    sleep(Duration::from_millis(300)).await;
    assert!(peer.notices().is_empty());
    assert_eq!(peer.delivered_count(), 0);
    assert!(peer.ws.is_open());
    // Completing it makes the message real, and it is refused once, at the size that arrived.
    peer.send(body[512..].to_vec());
    eventually("the refusal", || !peer.notices().is_empty()).await;
    sleep(Duration::from_millis(150)).await;
    let notices = peer.notices();
    assert_eq!(notices.len(), 1);
    assert_eq!(number(&notices[0], "bytes"), declared as u64);
    assert_eq!(number(&notices[0], "limit"), 4096);
    assert_eq!(peer.delivered_flags(), vec![(declared, false, false)]);
    assert!(peer.ws.is_open());
}

#[tokio::test]
async fn ingress_admission_bounds_the_box_not_the_leg_count() {
    // The reservation covers a leg's WORST case, so reserved bytes bound the memory actually assembled.
    assert_eq!(INGRESS_RESERVATION_BYTES, MAX_WS_PAYLOAD_BYTES);
    assert_eq!(MAX_INGRESS_BYTES, 2 * MAX_WS_PAYLOAD_BYTES);
    assert_eq!(admit_ingress(&AdmitQuery { pending: 1024, ..AdmitQuery::default() }), Admit::Read);
    assert_eq!(admit_ingress(&AdmitQuery { pending: 512 * 1024, ..AdmitQuery::default() }), Admit::Reserve);
    assert_eq!(
        admit_ingress(&AdmitQuery { pending: 512 * 1024, reserved: MAX_INGRESS_BYTES - INGRESS_RESERVATION_BYTES, ..AdmitQuery::default() }),
        Admit::Reserve
    );
    assert_eq!(admit_ingress(&AdmitQuery { pending: 512 * 1024, reserved: MAX_INGRESS_BYTES, ..AdmitQuery::default() }), Admit::Wait);

    let harness = Harness::new(MAX_WS_PAYLOAD_BYTES as u64);
    let ceiling = 512 * 1024;
    let limits = IngressLimits { ceiling, reservation: 256 * 1024, window: 16 * 1024, ..IngressLimits::default() };
    let payload = "z".repeat(1024 * 1024);
    let mut peers = Vec::new();
    for _ in 0..8 {
        peers.push(harness.desktop(limits).await);
    }
    harness.pool.reset_stats();
    // Every leg pushes a supported frame at the same moment. Without a gate this is legCount x maxPayload of heap.
    for peer in &peers {
        peer.send(text(&payload));
    }
    eventually("every frame", || peers.iter().all(|peer| peer.delivered_count() == 1)).await;
    let stats = harness.pool.stats();
    // Byte-for-byte: bounding memory must not cost payload fidelity.
    for peer in &peers {
        assert_eq!(locked(&peer.delivered)[0].data, payload.as_bytes());
        assert!(peer.ws.is_open());
    }
    // The gate engaged (each frame is far past the window, so each had to be charged to the pool) and it never handed out more
    // than the box budget however many legs arrived together.
    assert!(stats.peak >= 256 * 1024);
    assert!(stats.peak <= ceiling);
    assert_eq!((stats.reserved, stats.waiting), (0, 0));
}

#[tokio::test]
async fn a_parked_leg_waits_instead_of_losing_its_frame() {
    let harness = Harness::new(MAX_WS_PAYLOAD_BYTES as u64);
    // One reservation IS the whole pool, so a second supported frame cannot be admitted until the first lands.
    let reservation = 256 * 1024;
    let limits = IngressLimits { ceiling: reservation, reservation, window: 16 * 1024, ..IngressLimits::default() };
    let stalled = harness.desktop(limits).await;
    let parked = harness.desktop(limits).await;
    harness.pool.reset_stats();
    let payload = "w".repeat(512 * 1024);
    let wire = text(&payload);
    // Half a frame, then silence.
    stalled.send(wire[..64 * 1024].to_vec());
    eventually("the reservation", || harness.pool.stats().reserved == reservation).await;
    // The pool is spoken for, so this leg is PARKED: its bytes stay on its own side of the wire. It is not cut, and its frame
    // is not dropped.
    parked.send(wire.clone());
    eventually("the parked leg", || harness.pool.stats().waiting == 1).await;
    sleep(Duration::from_millis(200)).await;
    assert_eq!(stalled.delivered_count() + parked.delivered_count(), 0);
    assert!(parked.ws.is_open() && parked.leg.is_waiting());
    // The stalled frame completes, the parked leg is admitted next, and both payloads arrive whole.
    stalled.send(wire[64 * 1024..].to_vec());
    eventually("both frames", || stalled.delivered_count() == 1 && parked.delivered_count() == 1).await;
    assert_eq!(locked(&stalled.delivered)[0].data, payload.as_bytes());
    assert_eq!(locked(&parked.delivered)[0].data, payload.as_bytes());
    eventually("the pool to empty", || harness.pool.stats().reserved == 0).await;
    let stats = harness.pool.stats();
    assert!(stats.deferrals >= 1);
    assert_eq!(stats.waiting, 0);
    assert!(stalled.ws.is_open() && parked.ws.is_open());
}

#[tokio::test]
async fn fragmented_and_whole_messages_measure_identically() {
    let harness = Harness::new(MAX_WS_PAYLOAD_BYTES as u64);
    let payload = "y".repeat(5000);
    let (low, high) = payload.as_bytes().split_at(2500);
    let forms: Vec<Vec<u8>> = vec![
        frame(0x81, payload.as_bytes()),
        [frame(0x01, low), frame(0x80, high)].concat(),
        frame(0x82, payload.as_bytes()),
        [frame(0x02, low), frame(0x80, high)].concat(),
    ];
    // Within the limit: every form is delivered at 5000 bytes, refused by nobody.
    let fits = harness.phone(IngressLimits::with_limit(5000)).await;
    for form in &forms {
        fits.send(form.clone());
    }
    eventually("four messages", || fits.delivered_count() == 4).await;
    assert_eq!(fits.delivered_flags(), vec![(5000, false, true); 4]);
    assert!(fits.notices().is_empty());
    // One byte under: every form is refused once, at the same size.
    let over = harness.phone(IngressLimits::with_limit(4999)).await;
    for form in &forms {
        over.send(form.clone());
    }
    eventually("four messages", || over.delivered_count() == 4).await;
    eventually("four refusals", || over.notices().len() >= 4).await;
    sleep(Duration::from_millis(150)).await;
    let notices = over.notices();
    assert_eq!(notices.len(), 4);
    assert!(notices.iter().all(|notice| number(notice, "bytes") == 5000 && number(notice, "limit") == 4999));
}

#[tokio::test]
async fn a_leg_that_dies_hands_the_pool_back_so_the_next_leg_has_its_full_capacity() {
    let harness = Harness::new(MAX_WS_PAYLOAD_BYTES as u64);
    let reservation = 256 * 1024;
    let limits = IngressLimits { ceiling: reservation, reservation, window: 16 * 1024, ..IngressLimits::default() };
    let first = harness.desktop(limits).await;
    let wire = text(&"a".repeat(300 * 1024));
    first.send(wire[..100 * 1024].to_vec());
    eventually("the reservation", || harness.pool.stats().reserved == reservation).await;
    // This connection ends for a reason of its own. Nothing of it is carried to the next leg: the reservation is simply back.
    first.kill();
    eventually("the pool to empty", || harness.pool.stats().reserved == 0).await;
    harness.pool.reset_stats();
    let second = harness.desktop(limits).await;
    second.send(wire.clone());
    eventually("the frame", || second.delivered_count() == 1).await;
    assert_eq!(harness.pool.stats().deferrals, 0, "the next leg was never made to wait");
    assert_eq!(second.delivered_flags(), vec![(300 * 1024, false, true)]);
}

#[tokio::test]
async fn the_sweep_cuts_a_stalled_holder_and_a_long_waiter_and_never_pings_a_parked_leg() {
    let harness = Harness::new(MAX_WS_PAYLOAD_BYTES as u64);
    let reservation = 256 * 1024;
    let limits = IngressLimits { ceiling: reservation, reservation, window: 16 * 1024, ..IngressLimits::default() };
    let holder = harness.desktop(limits).await;
    let waiter = harness.desktop(limits).await;
    let idle = harness.desktop(limits).await;
    let wire = text(&"h".repeat(512 * 1024));
    holder.send(wire[..64 * 1024].to_vec());
    eventually("the reservation", || holder.leg.is_holding()).await;
    // Only the start of its frame: parked at the header, and once admitted it holds and stalls like the first.
    waiter.send(wire[..100 * 1024].to_vec());
    eventually("the parked leg", || waiter.leg.is_waiting()).await;

    let now = Instant::now();
    assert_eq!(idle.leg.sweep(now + Duration::from_secs(120)), Sweep::Clear);
    // Inside both timeouts nothing is cut, and a parked leg is left out of the ping sweep.
    assert_eq!(holder.leg.sweep(now + Duration::from_secs(25)), Sweep::Clear);
    assert_eq!(waiter.leg.sweep(now + Duration::from_secs(25)), Sweep::Parked);
    assert_eq!(waiter.leg.sweep(now + Duration::from_secs(50)), Sweep::Parked);
    // Past 30 s without progress the holder is cut, 4008 "slow producer": its reservation goes to the waiter.
    assert_eq!(holder.leg.sweep(now + Duration::from_secs(35)), Sweep::Closed);
    eventually("the holder's close frame", || holder.close_frame().is_some()).await;
    assert_eq!(holder.close_frame(), Some((4008, "slow producer".to_string())));
    eventually("the waiter to be admitted", || waiter.leg.is_holding()).await;
    assert!(!waiter.leg.is_waiting());
    assert_eq!(harness.pool.stats().reserved, reservation);
    // A leg that waits past 60 s is cut, 4009 "relay busy".
    let late = harness.desktop(limits).await;
    late.send(wire[..100 * 1024].to_vec());
    eventually("the late leg to park", || late.leg.is_waiting()).await;
    let later = Instant::now() + Duration::from_secs(61);
    assert_eq!(late.leg.sweep(later), Sweep::Closed);
    eventually("the late leg's close frame", || late.close_frame().is_some()).await;
    assert_eq!(late.close_frame(), Some((4009, "relay busy".to_string())));
    assert_eq!(harness.pool.stats().waiting, 0);
}

#[tokio::test]
async fn a_hook_leg_is_metered_with_its_1_mib_limit_through_the_same_pool_and_nobody_is_told() {
    let harness = Harness::new(MAX_WS_PAYLOAD_BYTES as u64);
    let hook = harness.connect(LegKind::Hook, IngressLimits::hook()).await;
    harness.pool.reset_stats();
    // 300 KiB is past the free window, so it takes a reservation out of the box pool and gives it back on delivery.
    let big = vec![b'k'; INGRESS_FREE_WINDOW_BYTES + 44 * 1024];
    hook.send(frame(0x82, &big));
    eventually("the frame", || hook.delivered_count() == 1).await;
    assert_eq!(harness.pool.stats().peak, INGRESS_RESERVATION_BYTES);
    eventually("the pool to empty", || harness.pool.stats().reserved == 0).await;
    // Past its 1 MiB limit the message is delivered as over the limit, and nobody is told.
    hook.send(frame(0x82, &vec![b'k'; HOOK_FRAME_LIMIT_BYTES + 1]));
    eventually("the second frame", || hook.delivered_count() == 2).await;
    sleep(Duration::from_millis(100)).await;
    assert_eq!(hook.delivered_flags()[1], (HOOK_FRAME_LIMIT_BYTES + 1, false, false));
    assert!(hook.notices().is_empty());
    assert_eq!(*locked(&hook.closed), None);
}

#[tokio::test]
async fn releasing_a_leg_is_idempotent_and_lets_go_of_its_socket() {
    let harness = Harness::new(MAX_WS_PAYLOAD_BYTES as u64);
    let reservation = 256 * 1024;
    let limits = IngressLimits { ceiling: reservation, reservation, window: 16 * 1024, ..IngressLimits::default() };
    let peer = harness.desktop(limits).await;
    let wire = text(&"r".repeat(300 * 1024));
    peer.send(wire[..100 * 1024].to_vec());
    eventually("the reservation", || peer.leg.is_holding()).await;
    peer.leg.release();
    peer.leg.release();
    assert_eq!(harness.pool.stats().reserved, 0);
    assert!(!peer.leg.is_holding());
    // A released leg takes no new reservation, even if bytes still arrive on its socket.
    peer.send(wire[100 * 1024..].to_vec());
    eventually("the frame", || peer.delivered_count() == 1).await;
    assert_eq!(harness.pool.stats().reserved, 0);
}
