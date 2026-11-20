//! The WebSocket layer of the relay: read gating, the raw tap, buffered accounting and the flush callback, the server's
//! `close`, the framing and handshake rules on the parser and over sockets, and a standard client against the server.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use mixdog_relay::ws::codec::{Receiver, ReceiverEvent, frame_header};
use mixdog_relay::ws::handshake::{self, HandshakeRequest};
use mixdog_relay::ws::{
    Gate, Holder, RawTap, ReadyState, Refused, ServerOptions, WebSocket, WebSocketServer, WsEvent, WsEvents,
};
use mixdog_rt::time::{Instant, sleep, timeout};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const KEY: &str = "dGhlIHNhbXBsZSBub25jZQ==";
const SAMPLE_ACCEPT: &str = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=";
const MASK: [u8; 4] = [1, 2, 3, 4];
const DEFAULT_MAX_PAYLOAD: u64 = 64 * 1024 * 1024 + 4 * 1024 * 1024;

// ---- wire helpers ----

fn head(lines: &[&str]) -> Vec<u8> {
    let mut text = lines.join("\r\n");
    text.push_str("\r\n\r\n");
    text.into_bytes()
}

fn upgrade() -> Vec<u8> {
    upgrade_with(&[])
}

fn upgrade_with(extra: &[&str]) -> Vec<u8> {
    let key = format!("Sec-WebSocket-Key: {KEY}");
    let mut lines = vec![
        "GET /ws HTTP/1.1",
        "Host: relay",
        "Upgrade: websocket",
        "Connection: Upgrade",
        key.as_str(),
        "Sec-WebSocket-Version: 13",
    ];
    lines.extend_from_slice(extra);
    head(&lines)
}

/// One client frame: `first` is the FIN, RSV and opcode byte; a masked payload uses the key 1, 2, 3, 4.
fn frame(first: u8, payload: &[u8], masked: bool) -> Vec<u8> {
    frame_masked(first, payload, masked.then_some(MASK))
}

fn frame_masked(first: u8, payload: &[u8], mask: Option<[u8; 4]>) -> Vec<u8> {
    let mut out = vec![first];
    let bit = if mask.is_some() { 0x80 } else { 0 };
    let length = payload.len();
    if length < 126 {
        out.push(bit | length as u8);
    } else if length < 65536 {
        out.push(bit | 126);
        out.extend_from_slice(&(length as u16).to_be_bytes());
    } else {
        out.push(bit | 127);
        out.extend_from_slice(&(length as u64).to_be_bytes());
    }
    match mask {
        Some(key) if key != [0; 4] => {
            out.extend_from_slice(&key);
            out.extend(payload.iter().enumerate().map(|(index, byte)| byte ^ key[index % 4]));
        }
        Some(key) => {
            out.extend_from_slice(&key);
            out.extend_from_slice(payload);
        }
        None => out.extend_from_slice(payload),
    }
    out
}

/// A frame whose header declares `declared` bytes (the 64-bit form) and carries `payload`, masked.
fn frame_declaring(first: u8, declared: u64, payload: &[u8]) -> Vec<u8> {
    let mut out = vec![first, 0x80 | 127];
    out.extend_from_slice(&declared.to_be_bytes());
    out.extend_from_slice(&MASK);
    out.extend(payload.iter().enumerate().map(|(index, byte)| byte ^ MASK[index % 4]));
    out
}

fn text(message: &str) -> Vec<u8> {
    frame(0x81, message.as_bytes(), true)
}

fn close_frame(code: u16, reason: &str) -> Vec<u8> {
    let mut payload = code.to_be_bytes().to_vec();
    payload.extend_from_slice(reason.as_bytes());
    frame(0x88, &payload, true)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

// ---- the two servers under comparison ----

type Log = Arc<Mutex<Vec<Value>>>;

fn record(log: &Log, event: Value) {
    log.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(event);
}

fn snapshot(log: &Log) -> Vec<Value> {
    log.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
}

struct Target {
    port: u16,
    log: Log,
    _node: Option<tokio::process::Child>,
}

/// What `ws` hands `HandshakeRequest`: the request head parsed with httparse.
async fn read_head(stream: &mut TcpStream) -> Option<(HandshakeRequest, Bytes)> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let count = stream.read(&mut chunk).await.ok()?;
        if count == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..count]);
        let mut headers = [httparse::EMPTY_HEADER; 64];
        let mut request = httparse::Request::new(&mut headers);
        if let httparse::Status::Complete(end) = request.parse(&buffer).ok()? {
            let parsed = HandshakeRequest {
                method: request.method?.to_string(),
                headers: request
                    .headers
                    .iter()
                    .map(|header| (header.name.to_string(), String::from_utf8_lossy(header.value).into_owned()))
                    .collect(),
            };
            return Some((parsed, Bytes::copy_from_slice(&buffer[end..])));
        }
    }
}

/// The echo behaviour of the fixture, over this crate's server.
async fn serve(server: Arc<WebSocketServer>, mut stream: TcpStream, log: Log) {
    let Some((request, leftover)) = read_head(&mut stream).await else { return };
    let Ok((ws, mut events)) = server.handle_upgrade(&request, stream, leftover).await else { return };
    while let Some(event) = events.next().await {
        match event {
            WsEvent::Message { data, is_binary } => {
                record(&log, json!({"ev": "message", "binary": is_binary, "hex": hex(&data)}));
                let command = if is_binary { String::new() } else { String::from_utf8_lossy(&data).into_owned() };
                if let Some(code) = command.strip_prefix("cmd:close:") {
                    let _ = ws.close(code.parse().unwrap_or(1000), "bye");
                } else if command == "cmd:terminate" {
                    ws.terminate();
                } else if command == "cmd:ping" {
                    let _ = ws.ping(Bytes::new(), None);
                } else if is_binary {
                    ws.send_binary(data, None);
                } else {
                    ws.send_text(data, None);
                }
            }
            WsEvent::Ping(data) => record(&log, json!({"ev": "ping", "hex": hex(&data)})),
            WsEvent::Pong(data) => record(&log, json!({"ev": "pong", "hex": hex(&data)})),
            WsEvent::Error(error) => record(&log, json!({"ev": "error", "code": error.code, "message": error.message})),
            WsEvent::Close { code, reason } => record(&log, json!({"ev": "close", "code": code, "hex": hex(&reason)})),
        }
    }
}

async fn rust_target(max_payload: u64, close_timeout_ms: u64) -> Target {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("address").port();
    let log: Log = Arc::default();
    let server = Arc::new(WebSocketServer::new(ServerOptions {
        max_payload,
        close_timeout: Duration::from_millis(close_timeout_ms),
    }));
    let served = Arc::clone(&log);
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(serve(Arc::clone(&server), stream, Arc::clone(&served)));
        }
    });
    Target { port, log, _node: None }
}

#[derive(Clone)]
enum Step {
    Send(Vec<u8>),
}

#[derive(Clone)]
struct Scenario {
    label: &'static str,
    steps: Vec<Step>,
    /// How long the peer waits for more bytes before it takes the answer as complete.
    quiet_ms: u64,
    /// Whether the socket is upgraded, so that a close event is expected.
    closes: bool,
}

fn scenario(label: &'static str, steps: Vec<Step>) -> Scenario {
    Scenario { label, steps, quiet_ms: 1500, closes: true }
}

impl Scenario {
    fn quiet(mut self, ms: u64) -> Self {
        self.quiet_ms = ms;
        self
    }

    fn refused(mut self) -> Self {
        self.closes = false;
        self
    }
}

impl Target {
    /// Run one scenario on a fresh connection: the bytes the peer received until the server ended the connection or fell
    /// quiet, and the events the server recorded meanwhile.
    async fn run(&self, scenario: &Scenario) -> (Vec<u8>, Vec<Value>) {
        let from = snapshot(&self.log).len();
        let mut wire = Vec::new();
        {
            let mut stream = TcpStream::connect(("127.0.0.1", self.port)).await.unwrap_or_else(|e| panic!("{}: connect: {e}", scenario.label));
            for step in &scenario.steps {
                match step {
                    Step::Send(bytes) => {
                        if stream.write_all(bytes).await.is_err() {
                            break;
                        }
                    }
                }
            }
            let mut buffer = [0u8; 8192];
            loop {
                match timeout(Duration::from_millis(scenario.quiet_ms), stream.read(&mut buffer)).await {
                    Ok(Ok(count)) if count > 0 => wire.extend_from_slice(&buffer[..count]),
                    _ => break,
                }
            }
        }
        let deadline = Instant::now() + Duration::from_secs(8);
        let events = loop {
            let events = snapshot(&self.log)[from..].to_vec();
            let finished = !scenario.closes || events.iter().any(|event| event["ev"] == "close");
            if finished || Instant::now() > deadline {
                break events;
            }
            sleep(Duration::from_millis(20)).await;
        };
        (wire, events)
    }
}

fn send(bytes: Vec<u8>) -> Step {
    Step::Send(bytes)
}

fn joined(parts: &[Vec<u8>]) -> Vec<u8> {
    parts.concat()
}

fn tungstenite_session(port: u16) -> Vec<String> {
    use tokio_tungstenite::tungstenite::protocol::CloseFrame;
    use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
    use tokio_tungstenite::tungstenite::{self, Message};

    let stream = std::net::TcpStream::connect(("127.0.0.1", port)).expect("connect");
    stream.set_read_timeout(Some(Duration::from_secs(5))).expect("read timeout");
    let (mut socket, _) = match tungstenite::client(format!("ws://127.0.0.1:{port}/ws"), stream) {
        Ok(pair) => pair,
        Err(_) => panic!("the WebSocket handshake failed"),
    };
    let mut seen = Vec::new();
    for message in [Message::text("hello"), Message::binary(vec![1u8, 2, 3]), Message::Ping(vec![7u8].into())] {
        socket.send(message).expect("send");
        let reply = socket.read().expect("read");
        seen.push(format!("{reply:?}"));
    }
    socket.close(Some(CloseFrame { code: CloseCode::Normal, reason: "done".into() })).expect("close");
    while let Ok(message) = socket.read() {
        seen.push(format!("{message:?}"));
    }
    seen
}

async fn tungstenite_run(port: u16) -> Vec<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let _ = tx.send(tungstenite_session(port));
    });
    rx.await.expect("the client thread finished")
}

// ---- Rust-only: gating, tap, accounting, server close ----

async fn tcp_pair() -> (TcpStream, TcpStream) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("address").port();
    let client = TcpStream::connect(("127.0.0.1", port)).await.expect("connect");
    let (server, _) = listener.accept().await.expect("accept");
    (client, server)
}

struct Session {
    client: TcpStream,
    ws: WebSocket,
    events: WsEvents,
    server: WebSocketServer,
    /// What the server wrote before the first frame: the 101 answer.
    answer: String,
}

async fn open_session(
    options: ServerOptions,
    handshake_and_frames: Vec<u8>,
    prepare: impl FnOnce(&WebSocket),
) -> Session {
    let (mut client, mut stream) = tcp_pair().await;
    client.write_all(&handshake_and_frames).await.expect("write the head");
    let (request, leftover) = read_head(&mut stream).await.expect("a request head");
    let server = WebSocketServer::new(options);
    let (ws, events) = match server.handle_upgrade(&request, stream, leftover).await {
        Ok(pair) => pair,
        Err(_) => panic!("the upgrade was refused"),
    };
    prepare(&ws);
    let mut answer = Vec::new();
    let mut byte = [0u8; 1];
    while !answer.ends_with(b"\r\n\r\n") {
        client.read_exact(&mut byte).await.expect("the 101 answer");
        answer.push(byte[0]);
    }
    Session { client, ws, events, server, answer: String::from_utf8(answer).expect("an ASCII head") }
}

async fn counted_messages(events: WsEvents) -> Arc<AtomicUsize> {
    let count = Arc::new(AtomicUsize::new(0));
    let seen = Arc::clone(&count);
    let mut events = events;
    tokio::spawn(async move {
        while let Some(event) = events.next().await {
            if matches!(event, WsEvent::Message { .. }) {
                seen.fetch_add(1, Ordering::SeqCst);
            }
        }
    });
    count
}

async fn wait_for_count(count: &AtomicUsize, wanted: usize) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while count.load(Ordering::SeqCst) < wanted {
        assert!(Instant::now() < deadline, "the message did not arrive");
        sleep(Duration::from_millis(20)).await;
    }
}

const BIG_FRAME_BYTES: usize = 48 * 1024 * 1024;

/// A peer that writes one huge frame stalls while the server does not read, and finishes once every holder let go.
async fn stalled_until_released(
    prepare: impl FnOnce(&WebSocket),
    partial: impl FnOnce(&WebSocket),
    release: impl FnOnce(&WebSocket),
) {
    let session = open_session(ServerOptions::new(128 * 1024 * 1024), upgrade(), prepare).await;
    let Session { client, ws, events, server: _server, .. } = session;
    let count = counted_messages(events).await;
    let (_read, mut write) = client.into_split();
    let big = frame_masked(0x82, &vec![7u8; BIG_FRAME_BYTES], Some([0; 4]));
    let writer = tokio::spawn(async move {
        // In pieces: Winsock takes one huge non-blocking write whole whatever the peer does with it, so only a stream of
        // modest writes feels the receive window that a server which does not read closes.
        for piece in big.chunks(64 * 1024) {
            write.write_all(piece).await.expect("write the frame");
        }
        write
    });
    sleep(Duration::from_millis(600)).await;
    assert!(!writer.is_finished(), "the peer's writes stall while the server does not read");
    assert_eq!(count.load(Ordering::SeqCst), 0);
    partial(&ws);
    sleep(Duration::from_millis(400)).await;
    assert!(!writer.is_finished(), "one holder letting go is not enough");
    release(&ws);
    let _write = timeout(Duration::from_secs(30), writer)
        .await
        .expect("the writes complete once reading resumes")
        .expect("writer");
    wait_for_count(&count, 1).await;
}

#[tokio::test]
async fn pause_stops_reading_and_resume_continues() {
    stalled_until_released(|ws| ws.pause(), |_| {}, |ws| ws.resume()).await;
}

#[tokio::test]
async fn reading_continues_only_when_both_holders_let_go() {
    stalled_until_released(
        |ws| {
            ws.gate().hold(Holder::Uplink);
            ws.gate().hold(Holder::Ingress);
        },
        |ws| {
            ws.gate().release(Holder::Uplink);
            assert!(ws.gate().is_held(Holder::Ingress));
            assert!(!ws.gate().is_held(Holder::Uplink));
        },
        |ws| ws.gate().release(Holder::Ingress),
    )
    .await;
}

#[tokio::test]
async fn pause_and_a_holder_are_independent() {
    stalled_until_released(
        |ws| {
            ws.pause();
            ws.gate().hold(Holder::Uplink);
        },
        |ws| ws.resume(),
        |ws| ws.gate().release(Holder::Uplink),
    )
    .await;
}

#[tokio::test]
async fn buffered_amount_counts_queued_bytes_and_the_callback_fires_once_each_after_the_write() {
    let session = open_session(ServerOptions::new(1024), upgrade(), |_| {}).await;
    let Session { mut client, ws, events, server: _server, .. } = session;
    let _count = counted_messages(events).await;
    let flushed = Arc::new(AtomicUsize::new(0));
    let one_mib = 1024 * 1024;
    let frames = 32;
    for _ in 0..frames {
        let done = Arc::clone(&flushed);
        ws.send_text(
            "x".repeat(one_mib),
            Some(Box::new(move |result| {
                assert!(result.is_ok());
                done.fetch_add(1, Ordering::SeqCst);
            })),
        );
    }
    // Nothing has run since the sends: every byte of every frame (header included) is still queued.
    assert_eq!(ws.buffered_amount(), frames * (one_mib + 10));
    assert_eq!(flushed.load(Ordering::SeqCst), 0);
    // The peer does not read: the transport cannot take 32 MiB, so something stays queued and not every callback fired.
    sleep(Duration::from_millis(500)).await;
    assert!(ws.buffered_amount() > 0, "a peer that does not read keeps bytes queued");
    assert!(flushed.load(Ordering::SeqCst) < frames);
    // The peer reads everything.
    let mut remaining = frames * (one_mib + 10);
    let mut buffer = vec![0u8; 256 * 1024];
    while remaining > 0 {
        let count =
            timeout(Duration::from_secs(20), client.read(&mut buffer)).await.expect("the peer reads").expect("read");
        assert!(count > 0, "the connection ended early");
        remaining -= count;
    }
    let deadline = Instant::now() + Duration::from_secs(20);
    while flushed.load(Ordering::SeqCst) < frames || ws.buffered_amount() > 0 {
        assert!(Instant::now() < deadline, "the queue did not drain");
        sleep(Duration::from_millis(20)).await;
    }
    sleep(Duration::from_millis(100)).await;
    assert_eq!(flushed.load(Ordering::SeqCst), frames, "each callback fires exactly once");
}

#[tokio::test]
async fn a_send_after_close_fails_its_callback_and_stays_counted_as_ws_does() {
    let session = open_session(ServerOptions::new(1024), upgrade(), |_| {}).await;
    let Session { ws, events, server: _server, .. } = session;
    let _count = counted_messages(events).await;
    ws.terminate();
    assert_eq!(ws.ready_state(), ReadyState::Closing);
    let (tx, rx) = tokio::sync::oneshot::channel();
    ws.send_text("late", Some(Box::new(move |result| {
        let _ = tx.send(result);
    })));
    let result = timeout(Duration::from_secs(5), rx).await.expect("the callback ran").expect("sent");
    assert_eq!(
        result.map_err(|error| error.to_string()),
        Err("WebSocket is not open: readyState 2 (CLOSING)".to_string())
    );
    assert_eq!(ws.buffered_amount(), 4);
}

struct Tap {
    chunks: Arc<Mutex<Vec<Vec<u8>>>>,
    hold_after_first: bool,
}

impl RawTap for Tap {
    fn chunk(&mut self, bytes: &[u8], gate: &Gate) {
        let mut chunks = self.chunks.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        chunks.push(bytes.to_vec());
        if self.hold_after_first && chunks.len() == 1 {
            gate.hold(Holder::Ingress);
        }
    }
}

#[tokio::test]
async fn the_raw_tap_sees_the_leftover_bytes_first_and_may_pause_before_the_parser_takes_the_chunk() {
    let first = text("first");
    let session = open_session(ServerOptions::new(1024), joined(&[upgrade(), first.clone()]), |_| {}).await;
    let Session { mut client, ws, mut events, server: _server, .. } = session;
    let chunks: Arc<Mutex<Vec<Vec<u8>>>> = Arc::default();
    ws.set_raw_tap(Box::new(Tap { chunks: Arc::clone(&chunks), hold_after_first: true }));
    // The chunk that held the gate is still parsed.
    let event = timeout(Duration::from_secs(5), events.next()).await.expect("an event").expect("not closed");
    assert_eq!(event, WsEvent::Message { data: Bytes::from_static(b"first"), is_binary: false });
    assert!(ws.gate().is_held(Holder::Ingress));
    // The next frame is not read while the tap's hold stands.
    let second = text("second");
    client.write_all(&second).await.expect("write");
    assert!(timeout(Duration::from_millis(400), events.next()).await.is_err(), "nothing is read while held");
    ws.gate().release(Holder::Ingress);
    let event = timeout(Duration::from_secs(5), events.next()).await.expect("an event").expect("not closed");
    assert_eq!(event, WsEvent::Message { data: Bytes::from_static(b"second"), is_binary: false });
    let seen = chunks.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
    assert_eq!(seen, vec![first, second], "the tap sees each chunk in order, the leftover first");
}

#[tokio::test]
async fn a_hold_standing_when_the_close_frame_is_parsed_does_not_stop_the_close() {
    let session = open_session(ServerOptions::new(1024), joined(&[upgrade(), close_frame(1000, "bye")]), |_| {}).await;
    let Session { mut client, ws, mut events, server: _server, .. } = session;
    let chunks: Arc<Mutex<Vec<Vec<u8>>>> = Arc::default();
    ws.set_raw_tap(Box::new(Tap { chunks, hold_after_first: true }));
    // The peer reads the echoed close frame and the end of the stream, then drops the connection.
    let peer = tokio::spawn(async move {
        let mut echoed = Vec::new();
        client.read_to_end(&mut echoed).await.expect("the echoed close and the end");
        echoed
    });
    // As ws resumes the socket after the close frame, the end of the stream is read with the hold still standing: the
    // close event comes now, not after the 30 s close timeout.
    let event = timeout(Duration::from_secs(5), events.next()).await.expect("the close event").expect("an event");
    assert_eq!(event, WsEvent::Close { code: 1000, reason: Bytes::from_static(b"bye") });
    assert!(ws.gate().is_held(Holder::Ingress), "the tap's own hold is left as it was");
    let echoed = timeout(Duration::from_secs(5), peer).await.expect("the peer finished").expect("peer");
    assert_eq!(echoed, vec![0x88, 5, 0x03, 0xe8, b'b', b'y', b'e']);
}

#[tokio::test]
async fn a_malformed_frame_on_a_closing_socket_ends_the_connection_and_frees_its_slot() {
    let session =
        open_session(ServerOptions { max_payload: 1024, close_timeout: Duration::from_millis(300) }, upgrade(), |_| {})
            .await;
    let Session { mut client, ws, mut events, server, answer } = session;
    assert!(answer.starts_with("HTTP/1.1 101 Switching Protocols\r\n"));
    assert!(answer.contains(&format!("Sec-WebSocket-Accept: {SAMPLE_ACCEPT}\r\n")));
    assert_eq!(server.clients().len(), 1);
    ws.close(4005, "pairing rescan required").expect("close");
    let mut sent = vec![0u8; 2 + 2 + "pairing rescan required".len()];
    client.read_exact(&mut sent).await.expect("the close frame");
    assert_eq!(&sent[..4], &[0x88, 25, 0x0f, 0xa5]);
    client.write_all(&frame(0x81, b"junk", false)).await.expect("write");
    let error = timeout(Duration::from_secs(5), events.next()).await.expect("an event").expect("not closed");
    let WsEvent::Error(error) = error else { panic!("an error event first, got {error:?}") };
    assert_eq!(error.code, "WS_ERR_EXPECTED_MASK");
    assert_eq!(error.status_code, 1002);
    drop(client);
    let closed = timeout(Duration::from_secs(5), events.next()).await.expect("an event").expect("not closed");
    assert_eq!(closed, WsEvent::Close { code: 1006, reason: Bytes::new() });
    assert!(events.next().await.is_none());
    assert_eq!(ws.ready_state(), ReadyState::Closed);
    let deadline = Instant::now() + Duration::from_secs(5);
    while !server.clients().is_empty() {
        assert!(Instant::now() < deadline, "the closed socket is still listed");
        sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn close_rejects_what_ws_rejects_and_sends_nothing() {
    let session = open_session(ServerOptions::new(1024), upgrade(), |_| {}).await;
    let Session { ws, events, server: _server, .. } = session;
    let _count = counted_messages(events).await;
    assert!(ws.close(1005, "").is_err());
    assert!(ws.close(1006, "").is_err());
    assert!(ws.close(999, "").is_err());
    assert!(ws.close(1000, "r".repeat(124)).is_err());
    assert!(ws.ping(vec![0u8; 126], None).is_err());
    assert!(ws.is_open(), "a refused close leaves the socket open");
    assert!(ws.close(1000, "r".repeat(123)).is_ok());
    assert_eq!(ws.ready_state(), ReadyState::Closing);
}

#[tokio::test]
async fn the_server_close_refuses_new_upgrades_with_503_and_waits_for_its_clients() {
    let session = open_session(ServerOptions::new(1024), upgrade(), |_| {}).await;
    let Session { ws, events, server, .. } = session;
    let server = Arc::new(server);
    let closing = {
        let server = Arc::clone(&server);
        tokio::spawn(async move { server.close().await })
    };
    sleep(Duration::from_millis(200)).await;
    assert!(!closing.is_finished(), "close waits for the open socket");
    let (mut client, stream) = tcp_pair().await;
    let request = HandshakeRequest::new(
        "GET",
        &[
            ("Upgrade", "websocket"),
            ("Connection", "Upgrade"),
            ("Sec-WebSocket-Key", KEY),
            ("Sec-WebSocket-Version", "13"),
        ],
    );
    match server.handle_upgrade(&request, stream, Bytes::new()).await {
        Err(Refused::Status(503)) => {}
        _ => panic!("a closing server answers 503"),
    }
    let mut answer = Vec::new();
    client.read_to_end(&mut answer).await.expect("the refusal ends the connection");
    assert_eq!(
        String::from_utf8(answer).expect("ASCII"),
        "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Type: text/html\r\nContent-Length: 19\r\n\r\nService Unavailable"
    );
    ws.terminate();
    let _count = counted_messages(events).await;
    timeout(Duration::from_secs(5), closing).await.expect("close finished once the socket closed").expect("task");
}

// ---- codec and handshake units ----

fn feed_all(receiver: &mut Receiver, chunks: &[&[u8]]) -> (Vec<ReceiverEvent>, Option<(String, u16)>) {
    let mut events = Vec::new();
    for chunk in chunks {
        if let Err(error) = receiver.feed(Bytes::copy_from_slice(chunk), &mut events) {
            return (events, Some((error.message, error.status_code)));
        }
    }
    (events, None)
}

#[test]
fn the_parser_assembles_a_frame_given_one_byte_at_a_time() {
    let wire = text("hello");
    let chunks: Vec<[u8; 1]> = wire.iter().map(|byte| [*byte]).collect();
    let refs: Vec<&[u8]> = chunks.iter().map(|chunk| chunk.as_slice()).collect();
    let (events, error) = feed_all(&mut Receiver::new(0), &refs);
    assert_eq!(error, None);
    assert_eq!(events, vec![ReceiverEvent::Message { data: Bytes::from_static(b"hello"), binary: false }]);
}

#[test]
fn the_parser_stops_after_a_close_frame() {
    let wire = joined(&[close_frame(1000, "bye"), text("late")]);
    let mut receiver = Receiver::new(0);
    let (events, error) = feed_all(&mut receiver, &[&wire]);
    assert_eq!(error, None);
    assert_eq!(events, vec![ReceiverEvent::Conclude { code: 1000, reason: Bytes::from_static(b"bye") }]);
    assert!(receiver.finished());
}

#[test]
fn chunks_held_unread_and_fragments_of_one_message_are_limited() {
    let mut receiver = Receiver::with_limits(0, 2, 16);
    let (_, error) = feed_all(&mut receiver, &[&[0x81], &[0x85], &[1], &[2], &[3]]);
    assert_eq!(error, Some(("Too many buffered chunks".to_string(), 1008)));
    let mut receiver = Receiver::with_limits(0, 100, 2);
    let wire = joined(&[frame(0x01, b"a", true), frame(0x00, b"b", true), frame(0x00, b"c", true)]);
    let (_, error) = feed_all(&mut receiver, &[&wire]);
    assert_eq!(error, Some(("Too many message fragments".to_string(), 1008)));
}

#[test]
fn frame_headers_use_the_shortest_length_form() {
    assert_eq!(frame_header(0x1, true, 125), ([0x81, 125, 0, 0, 0, 0, 0, 0, 0, 0], 2));
    assert_eq!(frame_header(0x2, true, 126), ([0x82, 126, 0, 126, 0, 0, 0, 0, 0, 0], 4));
    assert_eq!(frame_header(0x2, false, 65535), ([0x02, 126, 255, 255, 0, 0, 0, 0, 0, 0], 4));
    assert_eq!(frame_header(0x2, true, 65536), ([0x82, 127, 0, 0, 0, 0, 0, 1, 0, 0], 10));
}

#[test]
fn the_handshake_validates_as_handle_upgrade_does() {
    let ok = |headers: &[(&str, &str)]| handshake::validate(&HandshakeRequest::new("GET", headers));
    let good = [
        ("Upgrade", "WebSocket"),
        ("Connection", "Upgrade"),
        ("Sec-WebSocket-Key", KEY),
        ("Sec-WebSocket-Version", "13"),
    ];
    let accepted = ok(&good).expect("accepted");
    assert_eq!(accepted.protocol, None);
    let answer = String::from_utf8(handshake::accept_bytes(&accepted.key, None)).expect("ASCII");
    assert_eq!(
        answer,
        format!(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {SAMPLE_ACCEPT}\r\n\r\n"
        )
    );
    let with_version = |version: &'static str| {
        [("Upgrade", "websocket"), ("Sec-WebSocket-Key", KEY), ("Sec-WebSocket-Version", version)]
    };
    for version in ["13", "8", " 13 ", "13.0", "0x0d", "1.3e1"] {
        assert!(ok(&with_version(version)).is_ok(), "version {version:?}");
    }
    for version in ["", "12", "14", "abc", "13a"] {
        let refusal = ok(&with_version(version)).expect_err("refused");
        assert_eq!(
            (refusal.status, refusal.headers),
            (400, vec![("Sec-WebSocket-Version", "13, 8")]),
            "version {version:?}"
        );
    }
    let refusal = handshake::validate(&HandshakeRequest::new("POST", &good)).expect_err("refused");
    assert_eq!((refusal.status, refusal.message), (405, "Invalid HTTP method"));
    let refusal = ok(&[("Sec-WebSocket-Key", KEY), ("Sec-WebSocket-Version", "13")]).expect_err("refused");
    assert_eq!((refusal.status, refusal.message), (400, "Invalid Upgrade header"));
    // Repeated headers are joined.
    let twice = [
        ("Upgrade", "websocket"),
        ("Sec-WebSocket-Key", KEY),
        ("sec-websocket-key", KEY),
        ("Sec-WebSocket-Version", "13"),
    ];
    assert_eq!(ok(&twice).expect_err("refused").message, "Missing or invalid Sec-WebSocket-Key header");
}

#[test]
fn the_subprotocol_header_is_parsed_as_ws_parses_it() {
    let with = |protocol: &str| {
        handshake::validate(&HandshakeRequest::new(
            "GET",
            &[
                ("Upgrade", "websocket"),
                ("Sec-WebSocket-Key", KEY),
                ("Sec-WebSocket-Version", "13"),
                ("Sec-WebSocket-Protocol", protocol),
            ],
        ))
    };
    assert_eq!(with("chat, superchat").expect("accepted").protocol.as_deref(), Some("chat"));
    assert_eq!(with("chat,\tsuperchat").expect("accepted").protocol.as_deref(), Some("chat"));
    assert_eq!(with("v1.json").expect("accepted").protocol.as_deref(), Some("v1.json"));
    for bad in ["", "chat,", ",chat", "chat chat", " chat", "chat, chat", "a;b", "chat ,"] {
        assert_eq!(with(bad).expect_err("refused").message, "Invalid Sec-WebSocket-Protocol header", "{bad:?}");
    }
    let accepted = with("chat, superchat").expect("accepted");
    let answer =
        String::from_utf8(handshake::accept_bytes(&accepted.key, accepted.protocol.as_deref())).expect("ASCII");
    assert!(answer.ends_with("Sec-WebSocket-Protocol: chat\r\n\r\n"));
}

#[test]
fn the_refusal_is_what_abort_handshake_writes() {
    assert_eq!(
        String::from_utf8(handshake::refusal_bytes(400, Some("Invalid Upgrade header"), &[])).expect("ASCII"),
        "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Type: text/html\r\nContent-Length: 22\r\n\r\nInvalid Upgrade header"
    );
    assert_eq!(
        String::from_utf8(handshake::refusal_bytes(
            400,
            Some("Missing or invalid Sec-WebSocket-Version header"),
            &[("Sec-WebSocket-Version", "13, 8")]
        ))
        .expect("ASCII"),
        "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Type: text/html\r\nContent-Length: 47\r\nSec-WebSocket-Version: 13, 8\r\n\r\nMissing or invalid Sec-WebSocket-Version header"
    );
}



// ---- the protocol rules, on the parser ----

fn fed(max_payload: u64, wire: &[u8]) -> (Vec<ReceiverEvent>, Option<(String, u16)>) {
    feed_all(&mut Receiver::new(max_payload), &[wire])
}

fn refused_with(max_payload: u64, wire: &[u8]) -> u16 {
    fed(max_payload, wire).1.unwrap_or_else(|| panic!("{wire:02x?} was accepted")).1
}

#[test]
fn a_frame_that_breaks_the_framing_rules_ends_the_connection_with_1002() {
    let broken: [(&str, Vec<u8>); 14] = [
        ("unmasked", frame(0x81, b"hi", false)),
        ("rsv1", frame(0xc1, b"hi", true)),
        ("rsv2", frame(0xa1, b"hi", true)),
        ("rsv3", frame(0x91, b"hi", true)),
        ("reserved data opcode", frame(0x83, b"hi", true)),
        ("reserved control opcode", frame(0x8b, b"", true)),
        ("continuation without a message", frame(0x80, b"x", true)),
        ("text inside a fragmented message", joined(&[frame(0x01, b"a", true), frame(0x81, b"b", true)])),
        ("fragmented ping", frame(0x09, b"a", true)),
        ("ping over 125 bytes", frame(0x89, &[b'p'; 126], true)),
        ("close of one byte", frame(0x88, &[0x03], true)),
        ("close code 1005 on the wire", frame(0x88, &[0x03, 0xed], true)),
        ("close code below 1000", frame(0x88, &[0x03, 0xe7], true)),
        ("close code 5000", frame(0x88, &[0x13, 0x88], true)),
    ];
    for (label, wire) in broken {
        assert_eq!(refused_with(1024, &wire), 1002, "{label}");
    }
}

#[test]
fn a_message_over_the_ceiling_ends_the_connection_with_1009_whole_declared_or_fragmented() {
    assert_eq!(refused_with(1024, &frame(0x82, &[7u8; 2000], true)), 1009);
    assert_eq!(refused_with(1024, &joined(&[frame(0x02, &[1u8; 600], true), frame(0x80, &[2u8; 600], true)])), 1009);
    // Declared too long: refused before the payload arrives.
    assert_eq!(refused_with(1024, &frame_declaring(0x82, 5000, b"abc")), 1009);
    assert_eq!(refused_with(1024, &frame_declaring(0x82, 1 << 53, b"")), 1009);
    let (events, error) = fed(1024, &frame(0x82, &[3u8; 1024], true));
    assert_eq!(error, None, "a message of exactly the ceiling is read");
    assert_eq!(events, vec![ReceiverEvent::Message { data: Bytes::from(vec![3u8; 1024]), binary: true }]);
}

#[test]
fn text_that_is_not_utf8_ends_the_connection_with_1007_and_a_split_code_point_is_whole() {
    let invalid: [(&str, Vec<u8>); 5] = [
        ("bytes that are no encoding", frame(0x81, &[0xff, 0xfe], true)),
        ("an encoded surrogate", frame(0x81, &[0xed, 0xa0, 0x80], true)),
        ("an overlong form", frame(0x81, &[0xc0, 0x80], true)),
        ("a sequence cut by the end of the message", frame(0x81, &[0xe2, 0x82], true)),
        ("a close reason", frame(0x88, &[0x03, 0xe8, 0xff], true)),
    ];
    for (label, wire) in invalid {
        assert_eq!(refused_with(1024, &wire), 1007, "{label}");
    }
    let split = joined(&[frame(0x01, &[0xe2, 0x82], true), frame(0x80, &[0xac], true)]);
    let (events, error) = fed(1024, &split);
    assert_eq!(error, None);
    assert_eq!(events, vec![ReceiverEvent::Message { data: Bytes::from("\u{20ac}"), binary: false }]);
}

#[test]
fn a_close_frame_is_reported_with_its_code_and_reason_and_an_empty_one_as_1005() {
    let (events, _) = fed(1024, &close_frame(1000, "bye"));
    assert_eq!(events, vec![ReceiverEvent::Conclude { code: 1000, reason: Bytes::from_static(b"bye") }]);
    let (events, _) = fed(1024, &frame(0x88, b"", true));
    assert_eq!(events, vec![ReceiverEvent::Conclude { code: 1005, reason: Bytes::new() }]);
    let (events, _) = fed(1024, &close_frame(4005, "pairing rescan required"));
    assert_eq!(events, vec![ReceiverEvent::Conclude { code: 4005, reason: Bytes::from_static(b"pairing rescan required") }]);
}

#[test]
fn pings_and_pongs_are_reported_in_order_and_do_not_split_a_fragmented_message() {
    let wire = joined(&[
        frame(0x89, b"one", true),
        frame(0x89, b"", true),
        text("between"),
        frame(0x89, &[b'z'; 125], true),
        frame(0x8a, b"unsolicited", true),
    ]);
    let (events, error) = fed(1024, &wire);
    assert_eq!(error, None);
    assert_eq!(
        events,
        vec![
            ReceiverEvent::Ping(Bytes::from_static(b"one")),
            ReceiverEvent::Ping(Bytes::new()),
            ReceiverEvent::Message { data: Bytes::from_static(b"between"), binary: false },
            ReceiverEvent::Ping(Bytes::from(vec![b'z'; 125])),
            ReceiverEvent::Pong(Bytes::from_static(b"unsolicited")),
        ]
    );
    let fragmented = joined(&[
        frame(0x01, b"he", true),
        frame(0x89, b"mid", true),
        frame(0x00, b"ll", true),
        frame(0x80, b"o", true),
    ]);
    let (events, _) = fed(1024, &fragmented);
    assert_eq!(
        events,
        vec![
            ReceiverEvent::Ping(Bytes::from_static(b"mid")),
            ReceiverEvent::Message { data: Bytes::from_static(b"hello"), binary: false },
        ]
    );
}

#[test]
fn messages_arrive_whole_in_every_length_form_and_with_any_mask_key() {
    let large = vec![9u8; 70_000];
    let cases: [(&str, Vec<u8>, Vec<u8>, bool); 6] = [
        ("empty text", frame(0x81, b"", true), Vec::new(), false),
        ("empty binary", frame(0x82, b"", true), Vec::new(), true),
        ("126 bytes", frame(0x82, &[5u8; 126], true), vec![5u8; 126], true),
        ("65535 bytes", frame(0x82, &[6u8; 65535], true), vec![6u8; 65535], true),
        ("70000 bytes", frame(0x82, &large, true), large.clone(), true),
        ("the zero mask key", frame_masked(0x81, b"plain", Some([0; 4])), b"plain".to_vec(), false),
    ];
    for (label, wire, data, binary) in cases {
        let (events, error) = fed(DEFAULT_MAX_PAYLOAD, &wire);
        assert_eq!(error, None, "{label}");
        assert_eq!(events, vec![ReceiverEvent::Message { data: Bytes::from(data), binary }], "{label}");
    }
}

// ---- the protocol rules, over a socket ----

/// The frames a server wrote after its 101 answer: (opcode, payload); servers do not mask.
fn server_frames(wire: &[u8]) -> Vec<(u8, Vec<u8>)> {
    let start = wire.windows(4).position(|window| window == b"\r\n\r\n").expect("a response head") + 4;
    let mut rest = &wire[start..];
    let mut frames = Vec::new();
    while rest.len() >= 2 {
        let opcode = rest[0] & 0x0f;
        let (length, header) = match rest[1] & 0x7f {
            126 => (usize::from(u16::from_be_bytes([rest[2], rest[3]])), 4),
            127 => (u64::from_be_bytes(rest[2..10].try_into().expect("eight bytes")) as usize, 10),
            short => (usize::from(short), 2),
        };
        frames.push((opcode, rest[header..header + length].to_vec()));
        rest = &rest[header + length..];
    }
    frames
}

fn status_line(wire: &[u8]) -> String {
    String::from_utf8_lossy(wire).lines().next().unwrap_or_default().to_owned()
}

#[tokio::test]
async fn an_upgraded_socket_echoes_messages_answers_pings_and_echoes_the_close() {
    let target = rust_target(1024, 300).await;
    let steps = vec![
        send(upgrade()),
        send(text("hello")),
        send(frame(0x82, &[1, 2, 3], true)),
        send(frame(0x89, b"p", true)),
        send(close_frame(1000, "bye")),
    ];
    let (wire, events) = target.run(&scenario("echo", steps)).await;
    assert_eq!(status_line(&wire), "HTTP/1.1 101 Switching Protocols");
    assert!(String::from_utf8_lossy(&wire).contains("Sec-WebSocket-Accept: "));
    let mut close = vec![0x03, 0xe8];
    close.extend_from_slice(b"bye");
    assert_eq!(
        server_frames(&wire),
        vec![(1, b"hello".to_vec()), (2, vec![1, 2, 3]), (0xa, b"p".to_vec()), (8, close)]
    );
    assert_eq!(events.last().expect("events")["ev"], "close");
    assert_eq!(events.last().expect("events")["code"], 1000);
}

#[tokio::test]
async fn a_protocol_violation_on_an_open_socket_is_answered_with_a_close_frame_of_its_code() {
    let target = rust_target(1024, 300).await;
    for (label, wire, code) in [
        ("unmasked", frame(0x81, b"hi", false), 1002u16),
        ("oversize", frame(0x82, &[7u8; 2000], true), 1009),
        ("invalid text", frame(0x81, &[0xff, 0xfe], true), 1007),
    ] {
        let (answer, _) = target.run(&scenario(label, vec![send(upgrade()), send(wire)])).await;
        let frames = server_frames(&answer);
        let closing = frames.last().unwrap_or_else(|| panic!("{label}: no frame"));
        assert_eq!(closing.0, 8, "{label}");
        assert_eq!(u16::from_be_bytes([closing.1[0], closing.1[1]]), code, "{label}");
    }
}

#[tokio::test]
async fn a_close_the_server_starts_is_sent_and_the_connection_ends_when_the_peer_stays_silent() {
    let target = rust_target(1024, 300).await;
    let (wire, events) = target.run(&scenario("close", vec![send(upgrade()), send(text("cmd:close:4003"))]).quiet(1500)).await;
    let mut payload = vec![0x0f, 0xa3];
    payload.extend_from_slice(b"bye");
    assert_eq!(server_frames(&wire), vec![(8, payload)]);
    assert_eq!(events.last().expect("events")["ev"], "close");
}

#[tokio::test]
async fn terminating_drops_the_connection_without_a_close_frame() {
    let target = rust_target(1024, 300).await;
    let (wire, _) = target.run(&scenario("terminate", vec![send(upgrade()), send(text("cmd:terminate"))])).await;
    assert_eq!(status_line(&wire), "HTTP/1.1 101 Switching Protocols");
    assert_eq!(server_frames(&wire), vec![], "nothing follows the 101 answer");
}

#[tokio::test]
async fn an_upgrade_that_breaks_the_handshake_rules_is_refused_with_a_status_line() {
    let target = rust_target(1024, 300).await;
    let key = format!("Sec-WebSocket-Key: {KEY}");
    let refuse = |lines: Vec<&str>| scenario("refused", vec![send(head(&lines))]).refused().quiet(500);
    let mut put = upgrade();
    put[0..3].copy_from_slice(b"PUT");
    let (wire, _) = target.run(&scenario("put", vec![send(put)]).refused().quiet(500)).await;
    assert_eq!(status_line(&wire), "HTTP/1.1 405 Method Not Allowed");
    let base = ["GET /ws HTTP/1.1", "Host: relay", "Upgrade: websocket", "Connection: Upgrade"];
    fn with<'a>(base: &[&'a str], extra: &[&'a str]) -> Vec<&'a str> {
        [base, extra].concat()
    }
    for (label, lines) in [
        ("a key of the wrong length", with(&base, &["Sec-WebSocket-Key: abc==", "Sec-WebSocket-Version: 13"])),
        ("two keys", with(&base, &[key.as_str(), key.as_str(), "Sec-WebSocket-Version: 13"])),
        ("version 12", with(&base, &[key.as_str(), "Sec-WebSocket-Version: 12"])),
        ("no version", with(&base, &[key.as_str()])),
        ("a subprotocol with a space", with(&base, &[key.as_str(), "Sec-WebSocket-Version: 13", "Sec-WebSocket-Protocol: a b"])),
        ("a repeated subprotocol", with(&base, &[key.as_str(), "Sec-WebSocket-Version: 13", "Sec-WebSocket-Protocol: chat, chat"])),
    ] {
        let (wire, _) = target.run(&refuse(lines)).await;
        assert_eq!(status_line(&wire), "HTTP/1.1 400 Bad Request", "{label}");
    }
    let (wire, _) = target.run(&refuse(with(&base, &[key.as_str(), "Sec-WebSocket-Version: 12"]))).await;
    assert!(String::from_utf8_lossy(&wire).contains("Sec-WebSocket-Version: 13, 8\r\n"));
}

#[tokio::test]
async fn the_first_offered_subprotocol_is_answered_and_extensions_are_not() {
    let target = rust_target(1024, 300).await;
    let steps = vec![send(upgrade_with(&["Sec-WebSocket-Protocol: chat, superchat", "Sec-WebSocket-Extensions: permessage-deflate"])), send(close_frame(1000, ""))];
    let (wire, _) = target.run(&scenario("subprotocol", steps)).await;
    let answer = String::from_utf8_lossy(&wire);
    assert_eq!(status_line(&wire), "HTTP/1.1 101 Switching Protocols");
    assert!(answer.contains("Sec-WebSocket-Protocol: chat\r\n"), "{answer}");
    assert!(!answer.contains("Sec-WebSocket-Extensions"), "{answer}");
}

#[tokio::test]
async fn a_standard_websocket_client_exchanges_text_binary_ping_and_close_with_the_server() {
    let target = rust_target(1024, 300).await;
    let seen = tungstenite_run(target.port).await;
    assert_eq!(
        seen,
        vec![
            "Text(Utf8Bytes(b\"hello\"))".to_owned(),
            "Binary(b\"\\x01\\x02\\x03\")".to_owned(),
            "Pong(b\"\\x07\")".to_owned(),
            "Close(Some(CloseFrame { code: Normal, reason: Utf8Bytes(b\"done\") }))".to_owned(),
        ]
    );
}
