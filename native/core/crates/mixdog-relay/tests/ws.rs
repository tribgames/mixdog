//! The WebSocket layer of the relay against the `ws` package. The same byte streams are sent to this crate's server and to
//! `tests/fixtures/node-ws-echo.mjs` (a `ws` WebSocketServer with the options `server.mjs` gives its own), and what the
//! peer receives and what each side reports (messages, pings, errors, close code and reason, in order) must be equal.
//! The Rust-only tests check what `ws` has no test for here: read gating, the raw tap, buffered accounting and the flush
//! callback, the server's `close`.
//!
//! The Node half needs `node` on PATH and `ws` resolvable from the checkout.

use std::process::Stdio;
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
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
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

async fn node_target(max_payload: u64, close_timeout_ms: u64) -> Target {
    let fixture = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/node-ws-echo.mjs");
    let options = json!({"maxPayload": max_payload, "closeTimeout": close_timeout_ms}).to_string();
    let mut child = tokio::process::Command::new("node")
        .arg(fixture)
        .arg(options)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("node is on PATH");
    let stdout = child.stdout.take().expect("piped stdout");
    let mut lines = BufReader::new(stdout).lines();
    let first = timeout(Duration::from_secs(20), lines.next_line())
        .await
        .expect("node-ws-echo.mjs started")
        .expect("read the listening line")
        .expect("a listening line");
    let port =
        serde_json::from_str::<Value>(&first).expect("a JSON line")["listening"].as_u64().expect("a port") as u16;
    let log: Log = Arc::default();
    let collected = Arc::clone(&log);
    tokio::spawn(async move {
        while let Ok(Some(line)) = lines.next_line().await {
            if let Ok(event) = serde_json::from_str::<Value>(&line) {
                record(&collected, event);
            }
        }
    });
    Target { port, log, _node: Some(child) }
}

#[derive(Clone)]
enum Step {
    Send(Vec<u8>),
    Wait(u64),
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
            let mut stream = TcpStream::connect(("127.0.0.1", self.port)).await.expect("connect");
            for step in &scenario.steps {
                match step {
                    Step::Send(bytes) => {
                        if stream.write_all(bytes).await.is_err() {
                            break;
                        }
                    }
                    Step::Wait(ms) => sleep(Duration::from_millis(*ms)).await,
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

/// Run every scenario against both servers and require the same bytes and the same events.
async fn compare(max_payload: u64, scenarios: Vec<Scenario>) {
    let rust = rust_target(max_payload, 300).await;
    let node = node_target(max_payload, 300).await;
    for scenario in &scenarios {
        let (rust_wire, rust_events) = rust.run(scenario).await;
        let (node_wire, node_events) = node.run(scenario).await;
        assert_eq!(
            rust_wire,
            node_wire,
            "{}: the bytes the peer received differ\nrust {:?}\nnode {:?}",
            scenario.label,
            String::from_utf8_lossy(&rust_wire),
            String::from_utf8_lossy(&node_wire)
        );
        assert_eq!(rust_events, node_events, "{}: the events differ", scenario.label);
    }
}

fn send(bytes: Vec<u8>) -> Step {
    Step::Send(bytes)
}

fn joined(parts: &[Vec<u8>]) -> Vec<u8> {
    parts.concat()
}

// ---- twin tests ----

#[tokio::test]
async fn an_unmasked_client_frame_is_answered_with_1002_by_both() {
    compare(
        1024,
        vec![
            scenario("unmasked text", vec![send(upgrade()), send(frame(0x81, b"hi", false))]),
            scenario(
                "unmasked in the same write as the head",
                vec![send(joined(&[upgrade(), frame(0x81, b"hi", false)]))],
            ),
        ],
    )
    .await;
}

#[tokio::test]
async fn reserved_bits_and_opcodes_are_answered_with_1002_by_both() {
    compare(
        1024,
        vec![
            scenario("rsv1", vec![send(upgrade()), send(frame(0xc1, b"hi", true))]),
            scenario("rsv2", vec![send(upgrade()), send(frame(0xa1, b"hi", true))]),
            scenario("rsv3", vec![send(upgrade()), send(frame(0x91, b"hi", true))]),
            scenario("opcode 3", vec![send(upgrade()), send(frame(0x83, b"hi", true))]),
            scenario("opcode 11", vec![send(upgrade()), send(frame(0x8b, b"", true))]),
            scenario("continuation without a message", vec![send(upgrade()), send(frame(0x80, b"x", true))]),
            scenario(
                "a text frame inside a fragmented message",
                vec![send(upgrade()), send(frame(0x01, b"a", true)), send(frame(0x81, b"b", true))],
            ),
        ],
    )
    .await;
}

#[tokio::test]
async fn control_frame_rules_are_answered_the_same_by_both() {
    compare(
        1024,
        vec![
            scenario("a fragmented ping", vec![send(upgrade()), send(frame(0x09, b"a", true))]),
            scenario("a ping of 126 bytes", vec![send(upgrade()), send(frame(0x89, &[b'p'; 126], true))]),
            scenario("a close of one byte", vec![send(upgrade()), send(frame(0x88, &[0x03], true))]),
            scenario("close code 1005", vec![send(upgrade()), send(frame(0x88, &[0x03, 0xed], true))]),
            scenario("close code 999", vec![send(upgrade()), send(frame(0x88, &[0x03, 0xe7], true))]),
            scenario("close code 5000", vec![send(upgrade()), send(frame(0x88, &[0x13, 0x88], true))]),
            scenario(
                "close reason that is not UTF-8",
                vec![send(upgrade()), send(frame(0x88, &[0x03, 0xe8, 0xff], true))],
            ),
            scenario("a length past 2^53", vec![send(upgrade()), send(frame_declaring(0x82, 1 << 53, b""))]),
        ],
    )
    .await;
}

#[tokio::test]
async fn an_oversize_message_closes_with_1009_whole_or_fragmented() {
    let whole = frame(0x82, &[7u8; 2000], true);
    compare(
        1024,
        vec![
            scenario("oversize whole", vec![send(upgrade()), send(whole)]),
            scenario(
                "oversize in two fragments",
                vec![send(upgrade()), send(frame(0x02, &[1u8; 600], true)), send(frame(0x80, &[2u8; 600], true))],
            ),
            scenario(
                "oversize declared, payload never sent",
                vec![send(upgrade()), send(frame_declaring(0x82, 5000, b"abc"))],
            ),
            scenario(
                "exactly the ceiling",
                vec![send(upgrade()), send(frame(0x82, &[3u8; 1024], true)), send(close_frame(1000, ""))],
            ),
        ],
    )
    .await;
}

#[tokio::test]
async fn invalid_utf8_closes_with_1007_in_text_and_in_a_close_reason() {
    compare(
        1024,
        vec![
            scenario("invalid text", vec![send(upgrade()), send(frame(0x81, &[0xff, 0xfe], true))]),
            scenario(
                "a surrogate encoded in UTF-8",
                vec![send(upgrade()), send(frame(0x81, &[0xed, 0xa0, 0x80], true))],
            ),
            scenario("an overlong encoding", vec![send(upgrade()), send(frame(0x81, &[0xc0, 0x80], true))]),
            scenario(
                "a sequence cut by the end of the message",
                vec![send(upgrade()), send(frame(0x81, &[0xe2, 0x82], true))],
            ),
            scenario(
                "a code point split across fragments is whole",
                vec![
                    send(upgrade()),
                    send(frame(0x01, &[0xe2, 0x82], true)),
                    send(frame(0x80, &[0xac], true)),
                    send(close_frame(1000, "")),
                ],
            ),
        ],
    )
    .await;
}

#[tokio::test]
async fn the_close_handshake_is_echoed_the_same_by_both() {
    compare(
        1024,
        vec![
            scenario("close 1000 with a reason", vec![send(upgrade()), send(close_frame(1000, "bye"))]),
            scenario("close with no payload", vec![send(upgrade()), send(frame(0x88, b"", true))]),
            scenario("close 4005", vec![send(upgrade()), send(close_frame(4005, "pairing rescan required"))]),
            scenario(
                "frames after the close frame are not read",
                vec![send(joined(&[upgrade(), close_frame(1000, "x"), text("late")]))],
            ),
        ],
    )
    .await;
}

#[tokio::test]
async fn pings_are_answered_with_pongs_in_order_and_reported() {
    compare(
        1024,
        vec![scenario(
            "a ping burst around a message",
            vec![
                send(upgrade()),
                send(joined(&[
                    frame(0x89, b"one", true),
                    frame(0x89, b"", true),
                    text("between"),
                    frame(0x89, &[b'z'; 125], true),
                    frame(0x8a, b"unsolicited", true),
                    close_frame(1000, ""),
                ])),
            ],
        )],
    )
    .await;
}

#[tokio::test]
async fn messages_are_echoed_whole_across_fragments_and_length_forms() {
    let large = vec![9u8; 70_000];
    compare(
        DEFAULT_MAX_PAYLOAD,
        vec![
            scenario(
                "a fragmented text message with a ping inside it",
                vec![
                    send(upgrade()),
                    send(frame(0x01, b"he", true)),
                    send(frame(0x89, b"mid", true)),
                    send(frame(0x00, b"ll", true)),
                    send(frame(0x80, b"o", true)),
                    send(close_frame(1000, "")),
                ],
            ),
            scenario(
                "an empty text and an empty binary",
                vec![
                    send(upgrade()),
                    send(frame(0x81, b"", true)),
                    send(frame(0x82, b"", true)),
                    send(close_frame(1000, "")),
                ],
            ),
            scenario(
                "126 and 65535 bytes",
                vec![
                    send(upgrade()),
                    send(frame(0x82, &[5u8; 126], true)),
                    send(frame(0x82, &[6u8; 65535], true)),
                    send(close_frame(1000, "")),
                ],
            ),
            scenario(
                "70000 bytes (the 64-bit length form)",
                vec![send(upgrade()), send(frame(0x82, &large, true)), send(close_frame(1000, ""))],
            ),
            scenario(
                "a masked frame with the zero key",
                vec![send(upgrade()), send(frame_masked(0x81, b"plain", Some([0; 4]))), send(close_frame(1000, ""))],
            ),
            scenario("a frame split into single bytes", {
                let mut steps = vec![send(upgrade())];
                steps.extend(text("split").into_iter().map(|byte| send(vec![byte])));
                steps.push(send(close_frame(1000, "")));
                steps
            }),
        ],
    )
    .await;
}

#[tokio::test]
async fn the_server_closing_waits_for_the_peer_then_destroys_after_the_timeout() {
    compare(
        1024,
        vec![
            scenario(
                "close sent, the peer stays silent",
                vec![send(upgrade()), send(text("cmd:close:1000")), Step::Wait(900)],
            )
            .quiet(1500),
            scenario(
                "close sent, the peer answers",
                vec![send(upgrade()), send(text("cmd:close:4003")), Step::Wait(100), send(close_frame(4003, "bye"))],
            ),
            scenario(
                "close sent, the peer answers with another code",
                vec![send(upgrade()), send(text("cmd:close:1000")), Step::Wait(100), send(close_frame(1001, "going"))],
            ),
        ],
    )
    .await;
}

#[tokio::test]
async fn terminate_drops_the_connection_with_no_close_frame() {
    compare(
        1024,
        vec![
            scenario("terminate", vec![send(upgrade()), send(text("cmd:terminate"))]),
            scenario(
                "server ping, the peer closes",
                vec![send(upgrade()), send(text("cmd:ping")), Step::Wait(100), send(close_frame(1000, ""))],
            ),
        ],
    )
    .await;
}

#[tokio::test]
async fn refusals_and_the_101_head_are_the_same_bytes() {
    let mut post = upgrade();
    post[0..3].copy_from_slice(b"PUT");
    compare(
        1024,
        vec![
            scenario("PUT", vec![send(post)]).refused().quiet(500),
            scenario(
                "Upgrade: h2c",
                vec![send(head(&[
                    "GET /ws HTTP/1.1",
                    "Host: relay",
                    "Upgrade: h2c",
                    "Connection: Upgrade",
                    &format!("Sec-WebSocket-Key: {KEY}"),
                    "Sec-WebSocket-Version: 13",
                ]))],
            )
            .refused()
            .quiet(500),
            scenario(
                "a key of the wrong length",
                vec![send(head(&[
                    "GET /ws HTTP/1.1",
                    "Host: relay",
                    "Upgrade: websocket",
                    "Connection: Upgrade",
                    "Sec-WebSocket-Key: abc==",
                    "Sec-WebSocket-Version: 13",
                ]))],
            )
            .refused()
            .quiet(500),
            scenario(
                "two keys",
                vec![send(head(&[
                    "GET /ws HTTP/1.1",
                    "Host: relay",
                    "Upgrade: websocket",
                    "Connection: Upgrade",
                    &format!("Sec-WebSocket-Key: {KEY}"),
                    &format!("Sec-WebSocket-Key: {KEY}"),
                    "Sec-WebSocket-Version: 13",
                ]))],
            )
            .refused()
            .quiet(500),
            scenario(
                "version 12",
                vec![send(head(&[
                    "GET /ws HTTP/1.1",
                    "Host: relay",
                    "Upgrade: websocket",
                    "Connection: Upgrade",
                    &format!("Sec-WebSocket-Key: {KEY}"),
                    "Sec-WebSocket-Version: 12",
                ]))],
            )
            .refused()
            .quiet(500),
            scenario(
                "no version",
                vec![send(head(&[
                    "GET /ws HTTP/1.1",
                    "Host: relay",
                    "Upgrade: websocket",
                    "Connection: Upgrade",
                    &format!("Sec-WebSocket-Key: {KEY}"),
                ]))],
            )
            .refused()
            .quiet(500),
            scenario(
                "a subprotocol list with a space inside a name",
                vec![send(upgrade_with(&["Sec-WebSocket-Protocol: a b"]))],
            )
            .refused()
            .quiet(500),
            scenario("a repeated subprotocol", vec![send(upgrade_with(&["Sec-WebSocket-Protocol: chat, chat"]))])
                .refused()
                .quiet(500),
            scenario(
                "subprotocols: the first is answered",
                vec![send(upgrade_with(&["Sec-WebSocket-Protocol: chat, superchat"])), send(close_frame(1000, ""))],
            ),
            scenario(
                "extensions are ignored",
                vec![
                    send(upgrade_with(&["Sec-WebSocket-Extensions: permessage-deflate"])),
                    send(close_frame(1000, "")),
                ],
            ),
            scenario(
                "version 13.0",
                vec![
                    send(head(&[
                        "GET /ws HTTP/1.1",
                        "Host: relay",
                        "Upgrade: WebSocket",
                        "Connection: Upgrade",
                        &format!("Sec-WebSocket-Key: {KEY}"),
                        "Sec-WebSocket-Version: 13.0",
                    ])),
                    send(close_frame(1000, "")),
                ],
            ),
            scenario(
                "version 8",
                vec![
                    send(head(&[
                        "GET /ws HTTP/1.1",
                        "Host: relay",
                        "Upgrade: websocket",
                        "Connection: Upgrade",
                        &format!("Sec-WebSocket-Key: {KEY}"),
                        "Sec-WebSocket-Version: 8",
                    ])),
                    send(close_frame(1000, "")),
                ],
            ),
        ],
    )
    .await;
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

#[tokio::test]
async fn a_tungstenite_client_sees_the_same_messages_from_both() {
    let rust = rust_target(1024, 300).await;
    let node = node_target(1024, 300).await;
    let from_rust = tungstenite_run(rust.port).await;
    let from_node = tungstenite_run(node.port).await;
    assert_eq!(from_rust, from_node);
    assert_eq!(from_rust.len(), 4, "text echo, binary echo, pong, close echo: {from_rust:?}");
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
        write.write_all(&big).await.expect("write the frame");
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
    ws.send_text("late", Some(Box::new(move |result| drop(tx.send(result)))));
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
    // Repeated headers read as Node joins them.
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
