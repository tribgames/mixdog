//! The webhook tunnel: the cases of `lib/relay-hook.test.mjs` and the socket-level part of the `webhook ingress caps bodies that
//! are still arriving` case of `security.test.mjs`, run over real sockets: callers speak HTTP to the http1 layer with this
//! crate's `HookHub` as the handler, and the agent speaks WebSocket to this crate's server over a raw byte client.
//!
//! The agent is a raw client: it sends masked frames and reads the relay's. The upgrade is done the way the server's upgrade code
//! does it (the device is authenticated there, not in the hub): the test hands the socket and its events to `run_leg`.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use bytes::Bytes;
use mixdog_relay::hook::{HookHub, HookOptions};
use mixdog_relay::http1::{Handler, HandlerFuture, Limits, Request, ResponseWriter, UpgradeRequest};
use mixdog_relay::legs::ingress::IngressPool;
use mixdog_relay::net::Server;
use mixdog_relay::ws::{HandshakeRequest, ServerOptions, WebSocketServer};
use mixdog_rt::time::{sleep, timeout};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::{TcpListener, TcpStream};

const KEY: &str = "dGhlIHNhbXBsZSBub25jZQ==";
const MASK: [u8; 4] = [0x0a, 0x0b, 0x0c, 0x0d];
const DEVICE: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

// ---- the rig ----

struct Route(Arc<HookHub>);

impl Handler for Route {
    fn request(&self, request: Request, response: ResponseWriter) -> HandlerFuture {
        let hub = Arc::clone(&self.0);
        Box::pin(async move { hub.handle_request(request, response).await })
    }

    fn upgrade(&self, _upgrade: UpgradeRequest) {}
}

struct Rig {
    hub: Arc<HookHub>,
    sockets: WebSocketServer,
    _server: Server,
    addr: SocketAddr,
}

async fn boot(options: HookOptions) -> Rig {
    let hub = HookHub::new(IngressPool::new(), options);
    let server = Server::start(0, None, Arc::new(Route(Arc::clone(&hub))), Limits::default()).await.expect("start the server");
    let addr = ([127, 0, 0, 1], server.port()).into();
    Rig { hub, sockets: WebSocketServer::new(ServerOptions::new(68 * 1024 * 1024)), _server: server, addr }
}

fn options(max_pending: usize, timeout: Duration) -> HookOptions {
    HookOptions { max_pending, timeout, ..HookOptions::default() }
}

// ---- the agent: a raw WebSocket client ----

struct Agent {
    read: OwnedReadHalf,
    write: OwnedWriteHalf,
    buffer: Vec<u8>,
}

fn upgrade_head() -> Vec<u8> {
    format!("GET /hookleg HTTP/1.1\r\nHost: relay\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {KEY}\r\nSec-WebSocket-Version: 13\r\n\r\n")
        .into_bytes()
}

/// A client frame, masked: `first` is the FIN, RSV and opcode byte.
fn client_frame(first: u8, payload: &[u8]) -> Vec<u8> {
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
    out.extend(payload.iter().enumerate().map(|(index, byte)| byte ^ MASK[index % 4]));
    out
}

impl Rig {
    /// A hook leg for `device`, upgraded as the server's upgrade code does it.
    async fn agent(&self, device: &str) -> Agent {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("address").port();
        let mut client = TcpStream::connect(("127.0.0.1", port)).await.expect("connect");
        let (mut stream, _) = listener.accept().await.expect("accept");
        client.write_all(&upgrade_head()).await.expect("write the head");
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
        let (socket, events) = match self.sockets.handle_upgrade(&request, stream, leftover).await {
            Ok(pair) => pair,
            Err(_) => panic!("the upgrade was refused"),
        };
        let hub = Arc::clone(&self.hub);
        let device = device.to_owned();
        tokio::spawn(async move { hub.run_leg(&device, socket, events).await });
        // The leg counts once its task has registered it.
        for _ in 0..200 {
            if !self.hub.legs().is_empty() {
                break;
            }
            sleep(Duration::from_millis(10)).await;
        }
        // The answer to the upgrade ends at its blank line.
        let mut answer = Vec::new();
        let (mut read, write) = client.into_split();
        let rest = loop {
            let count = read.read(&mut chunk).await.expect("read the answer");
            assert!(count > 0, "the answer was cut");
            answer.extend_from_slice(&chunk[..count]);
            if let Some(at) = answer.windows(4).position(|window| window == b"\r\n\r\n") {
                break answer[at + 4..].to_vec();
            }
        };
        Agent { read, write, buffer: rest }
    }
}

impl Agent {
    /// One frame of the relay (unmasked), or `None` when nothing arrives within `wait` or the connection ended.
    async fn frame(&mut self, wait: Duration) -> Option<(u8, Vec<u8>)> {
        loop {
            if let Some(frame) = self.parse() {
                return Some(frame);
            }
            let mut chunk = vec![0u8; 64 * 1024];
            match timeout(wait, self.read.read(&mut chunk)).await {
                Ok(Ok(count)) if count > 0 => self.buffer.extend_from_slice(&chunk[..count]),
                _ => return None,
            }
        }
    }

    fn parse(&mut self) -> Option<(u8, Vec<u8>)> {
        let buffer = &self.buffer;
        if buffer.len() < 2 {
            return None;
        }
        let (header, length) = match buffer[1] & 0x7f {
            126 if buffer.len() >= 4 => (4, usize::from(u16::from_be_bytes([buffer[2], buffer[3]]))),
            127 if buffer.len() >= 10 => {
                let mut wide = [0u8; 8];
                wide.copy_from_slice(&buffer[2..10]);
                (10, usize::try_from(u64::from_be_bytes(wide)).unwrap_or(usize::MAX))
            }
            126 | 127 => return None,
            short => (2, usize::from(short)),
        };
        if buffer.len() < header + length {
            return None;
        }
        let opcode = buffer[0] & 0x0f;
        let payload = buffer[header..header + length].to_vec();
        self.buffer.drain(..header + length);
        Some((opcode, payload))
    }

    /// The next text frame as JSON.
    async fn json(&mut self) -> Value {
        loop {
            let (opcode, payload) = self.frame(Duration::from_secs(5)).await.expect("a frame from the relay");
            if opcode == 1 {
                return serde_json::from_slice(&payload).expect("a JSON frame");
            }
        }
    }

    /// Whether a text frame arrives within `wait`.
    async fn hears_text_within(&mut self, wait: Duration) -> bool {
        while let Some((opcode, _)) = self.frame(wait).await {
            if opcode == 1 {
                return true;
            }
        }
        false
    }

    /// The code of the close frame the relay sends, if one arrives.
    async fn close_code(&mut self) -> Option<(u16, String)> {
        while let Some((opcode, payload)) = self.frame(Duration::from_secs(5)).await {
            if opcode == 8 && payload.len() >= 2 {
                return Some((u16::from_be_bytes([payload[0], payload[1]]), String::from_utf8_lossy(&payload[2..]).into_owned()));
            }
        }
        None
    }

    async fn send_text(&mut self, text: &str) {
        self.write.write_all(&client_frame(0x81, text.as_bytes())).await.expect("send a frame");
    }

    async fn answer(&mut self, id: &Value, status: Value, content_type: &str, body: &[u8]) {
        let frame = json!({ "type": "http-response", "id": id, "status": status, "headers": { "content-type": content_type }, "body": STANDARD.encode(body) });
        self.send_text(&frame.to_string()).await;
    }
}

// ---- the callers: raw HTTP ----

struct Reply {
    status: u16,
    head: String,
    body: String,
}

impl Reply {
    fn has(&self, header: &str) -> bool {
        self.head.lines().any(|line| line.eq_ignore_ascii_case(header))
    }
}

fn dechunk(raw: &str) -> String {
    let mut out = String::new();
    let mut rest = raw;
    while let Some((size, tail)) = rest.split_once("\r\n") {
        let Ok(size) = usize::from_str_radix(size.split(';').next().unwrap_or("").trim(), 16) else { break };
        if size == 0 || tail.len() < size {
            break;
        }
        out.push_str(&tail[..size]);
        rest = tail[size..].strip_prefix("\r\n").unwrap_or("");
    }
    out
}

/// Reads until the server closes the connection (every caller asks for `Connection: close`).
async fn read_reply(mut stream: TcpStream) -> Reply {
    let mut out = Vec::new();
    let mut chunk = [0u8; 8192];
    let _ = timeout(Duration::from_secs(10), async {
        loop {
            match stream.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(count) => out.extend_from_slice(&chunk[..count]),
            }
        }
    })
    .await;
    let text = String::from_utf8_lossy(&out).into_owned();
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((text.as_str(), ""));
    let status = head.split(' ').nth(1).and_then(|code| code.parse().ok()).unwrap_or_else(|| panic!("no status in {text:?}"));
    let chunked = head.lines().any(|line| line.eq_ignore_ascii_case("Transfer-Encoding: chunked"));
    Reply { status, head: head.to_owned(), body: if chunked { dechunk(body) } else { body.to_owned() } }
}

fn request_head(method: &str, path: &str, length: usize, headers: &[(&str, &str)]) -> String {
    let mut head = format!("{method} {path} HTTP/1.1\r\nHost: relay\r\nConnection: close\r\nContent-Length: {length}\r\n");
    for (name, value) in headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    head
}

async fn call(addr: SocketAddr, method: &str, path: &str, headers: &[(&str, &str)], body: &[u8]) -> Reply {
    let mut stream = TcpStream::connect(addr).await.expect("connect");
    stream.write_all(request_head(method, path, body.len(), headers).as_bytes()).await.expect("write the request");
    stream.write_all(body).await.expect("write the body");
    read_reply(stream).await
}

fn hook_path(rest: &str) -> String {
    format!("/hook/{DEVICE}{rest}")
}

/// A body that STARTS and never ends: the request holds a slot and a growing buffer and has not reached the agent at all.
async fn slow_upload(addr: SocketAddr) -> TcpStream {
    let mut stream = TcpStream::connect(addr).await.expect("connect");
    let head = format!(
        "POST {} HTTP/1.1\r\nHost: relay\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\nb\r\n{{\"partial\":\r\n",
        hook_path("/webhook/test")
    );
    stream.write_all(head.as_bytes()).await.expect("write the head and the first chunk");
    stream
}

// ---- the cases ----

#[tokio::test]
async fn webhook_relay_responses_enforce_strict_base64_and_byte_limits() {
    let rig = boot(HookOptions::default()).await;
    let mut agent = rig.agent(DEVICE).await;
    let too_long = "A".repeat(349_526 * 4 + 4);
    // The answers of the agent: a good body, bad text, text longer than any body may encode to, a body that decodes past the limit.
    let cases: [(Value, u16, &str); 4] = [
        (json!(STANDARD.encode(b"ok")), 200, "ok"),
        (json!("not base64!"), 502, "{\"error\":\"invalid agent response\"}"),
        (json!(too_long), 502, "{\"error\":\"invalid agent response\"}"),
        (json!("A".repeat(349_526 * 4)), 502, "{\"error\":\"invalid agent response\"}"),
    ];
    for (body, status, expected) in cases {
        let caller = tokio::spawn(call(rig.addr, "POST", &hook_path("/x"), &[], b"{}"));
        let frame = agent.json().await;
        let reply = json!({ "type": "http-response", "id": frame["id"], "status": 200, "headers": { "content-type": "text/plain" }, "body": body });
        agent.send_text(&reply.to_string()).await;
        let reply = caller.await.expect("the caller");
        assert_eq!(reply.status, status);
        assert_eq!(reply.body, expected);
    }
}

#[tokio::test]
async fn hook_http_answers_404_and_503_without_a_live_agent() {
    // The 400 of a target that is not a URL is the `route` unit test of src/hook/http.rs (the http1 layer refuses such a head first).
    let rig = boot(HookOptions::default()).await;
    let reply = call(rig.addr, "GET", "/hook/nope", &[], b"").await;
    assert_eq!(reply.status, 404);
    assert_eq!(reply.body, "{\"error\":\"not found\"}");
    assert!(reply.has("Content-Type: application/json"));

    let reply = call(rig.addr, "GET", &hook_path("/x"), &[], b"").await;
    assert_eq!(reply.status, 503);
    assert_eq!(reply.body, "{\"error\":\"agent offline\"}");
    assert!(reply.has("Content-Type: application/json"));
}

#[tokio::test]
async fn a_dropped_hook_leg_fails_every_pending_http_response() {
    let rig = boot(HookOptions::default()).await;
    let mut agent = rig.agent(DEVICE).await;
    let first = tokio::spawn(call(rig.addr, "POST", &hook_path("/a"), &[], b"1"));
    let second = tokio::spawn(call(rig.addr, "POST", &hook_path("/b"), &[], b"2"));
    // Both are on the leg and parked.
    agent.json().await;
    agent.json().await;
    drop(agent);
    for caller in [first, second] {
        let reply = caller.await.expect("the caller");
        assert_eq!(reply.status, 502);
        assert_eq!(reply.body, "{\"error\":\"agent disconnected\"}");
    }
    // The leg is gone, so the next caller finds no agent.
    let mut gone = false;
    for _ in 0..40 {
        if call(rig.addr, "GET", &hook_path("/c"), &[], b"").await.status == 503 {
            gone = true;
            break;
        }
        sleep(Duration::from_millis(25)).await;
    }
    assert!(gone, "the dropped leg is still listed");
}

#[tokio::test]
async fn hook_rate_limits_destroy_the_request_before_a_body_is_read() {
    let rig = boot(HookOptions::default()).await;
    // 120 calls per device id in a window are answered (here: no agent); the next one is not.
    for attempt in 0..120 {
        let reply = call(rig.addr, "GET", &hook_path("/x"), &[], b"").await;
        assert_eq!(reply.status, 503, "call {attempt}");
    }
    // The refused call declares a body and never sends it: it is answered and its connection destroyed without waiting for one.
    let mut stream = TcpStream::connect(rig.addr).await.expect("connect");
    stream.write_all(request_head("POST", &hook_path("/x"), 5000, &[]).as_bytes()).await.expect("write the head");
    let reply = read_reply(stream).await;
    assert_eq!(reply.status, 429);
    assert!(reply.has("Retry-After: 60"));
    assert!(reply.has("Content-Type: application/json"));
    assert_eq!(reply.body, "{\"error\":\"rate limited\"}");
}

#[tokio::test]
async fn a_request_is_replayed_over_the_leg_and_the_agents_answer_returns() {
    let rig = boot(HookOptions::default()).await;
    let mut agent = rig.agent(DEVICE).await;
    let headers = [("Content-Type", "application/json"), ("X-Hub-Signature-256", "sha256=abc"), ("Cookie", "a=1"), ("Upgrade-Insecure-Requests", "1")];
    let caller = tokio::spawn({
        let addr = rig.addr;
        async move { call(addr, "POST", &hook_path("/webhook/test?x=1&y=%20"), &headers, b"{\"a\":1}").await }
    });
    let frame = agent.json().await;
    assert_eq!(frame["type"], "http");
    assert_eq!(frame["method"], "POST");
    assert_eq!(frame["path"], "/webhook/test?x=1&y=%20");
    assert_eq!(frame["body"], STANDARD.encode(b"{\"a\":1}"));
    assert_eq!(frame["id"].as_str().map(str::len), Some(36));
    let forwarded = frame["headers"].as_object().expect("headers");
    assert_eq!(forwarded["x-hub-signature-256"], "sha256=abc");
    assert_eq!(forwarded["content-type"], "application/json");
    assert_eq!(forwarded["cookie"], "a=1");
    assert_eq!(forwarded["upgrade-insecure-requests"], "1");
    for dropped in ["host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade", "te"] {
        assert!(!forwarded.contains_key(dropped), "{dropped} stays on its hop");
    }
    // Frames of no interest to a pending request are ignored: not JSON, another type, an id that is not parked.
    agent.send_text("not json").await;
    agent.send_text("null").await;
    agent.send_text("{\"type\":\"ping\"}").await;
    agent.answer(&json!("someone-else"), json!(200), "text/plain", b"x").await;
    agent.answer(&frame["id"], json!(201), "text/plain; charset=utf-8", b"created").await;
    let reply = caller.await.expect("the caller");
    assert_eq!(reply.status, 201);
    assert_eq!(reply.body, "created");
    assert!(reply.has("Content-Type: text/plain; charset=utf-8"));
    assert!(reply.has("Content-Length: 7"));
    // Any method goes, and a request without a body or a path beyond the id is told as `/` with an empty body.
    let caller = tokio::spawn(call(rig.addr, "DELETE", &hook_path(""), &[], b""));
    let frame = agent.json().await;
    assert_eq!((frame["method"].as_str(), frame["path"].as_str(), frame["body"].as_str()), (Some("DELETE"), Some("/"), Some("")));
    // A status outside 100..=599 is the relay's 502, and a content type that is not printable ASCII is JSON.
    agent.answer(&frame["id"], json!(700), "text/é", b"{}").await;
    let reply = caller.await.expect("the caller");
    assert_eq!(reply.status, 502);
    assert!(reply.has("Content-Type: application/json"));
}

#[tokio::test]
async fn an_agent_that_does_not_answer_times_out_with_504() {
    let rig = boot(options(64, Duration::from_millis(300))).await;
    let mut agent = rig.agent(DEVICE).await;
    let caller = tokio::spawn(call(rig.addr, "POST", &hook_path("/slow"), &[], b"{}"));
    let frame = agent.json().await;
    let reply = caller.await.expect("the caller");
    assert_eq!(reply.status, 504);
    assert_eq!(reply.body, "{\"error\":\"agent timeout\"}");
    // A late answer finds nothing parked and is ignored; the leg stays usable.
    agent.answer(&frame["id"], json!(200), "text/plain", b"late").await;
    let caller = tokio::spawn(call(rig.addr, "POST", &hook_path("/next"), &[], b"{}"));
    let frame = agent.json().await;
    agent.answer(&frame["id"], json!(200), "text/plain", b"fine").await;
    assert_eq!(caller.await.expect("the caller").body, "fine");
}

#[tokio::test]
async fn a_new_leg_of_the_same_device_supersedes_the_old_one() {
    let rig = boot(HookOptions::default()).await;
    let mut old = rig.agent(DEVICE).await;
    let parked = tokio::spawn(call(rig.addr, "POST", &hook_path("/a"), &[], b"1"));
    old.json().await;
    let mut new = rig.agent(DEVICE).await;
    // The old leg is closed 4000 and what it held fails; new requests go to the new leg.
    assert_eq!(old.close_code().await, Some((4000, "superseded".to_owned())));
    let reply = parked.await.expect("the caller");
    assert_eq!((reply.status, reply.body.as_str()), (502, "{\"error\":\"agent disconnected\"}"));
    let caller = tokio::spawn(call(rig.addr, "POST", &hook_path("/b"), &[], b"2"));
    let frame = new.json().await;
    new.answer(&frame["id"], json!(200), "text/plain", b"new").await;
    assert_eq!(caller.await.expect("the caller").body, "new");
    // The closed leg's own end does not touch the new one.
    drop(old);
    sleep(Duration::from_millis(100)).await;
    let caller = tokio::spawn(call(rig.addr, "POST", &hook_path("/c"), &[], b"3"));
    let frame = new.json().await;
    new.answer(&frame["id"], json!(200), "text/plain", b"still").await;
    assert_eq!(caller.await.expect("the caller").body, "still");
}

#[tokio::test]
async fn webhook_ingress_caps_bodies_that_are_still_arriving_not_just_landed_ones() {
    let rig = boot(options(2, Duration::from_secs(30))).await;
    let mut agent = rig.agent(DEVICE).await;
    let uploads = [slow_upload(rig.addr).await, slow_upload(rig.addr).await];
    sleep(Duration::from_millis(200)).await;

    let probe = call(rig.addr, "POST", &hook_path("/webhook/test"), &[], b"{}").await;
    assert_eq!(probe.status, 503);
    assert_eq!(probe.body, "{\"error\":\"agent busy\"}");
    assert!(probe.has("Retry-After: 1"));
    // Neither slow body ever ended, so nothing was forwarded: the cap was enforced against requests still on the wire.
    assert!(!agent.hears_text_within(Duration::from_millis(200)).await);

    // ...and a caller that hangs up mid-body gives its reservation back.
    drop(uploads);
    sleep(Duration::from_millis(200)).await;
    let caller = tokio::spawn(call(rig.addr, "POST", &hook_path("/webhook/test"), &[], b"{}"));
    let frame = agent.json().await;
    assert_eq!(frame["type"], "http");
    agent.answer(&frame["id"], json!(200), "text/plain", b"ok").await;
    assert_eq!(caller.await.expect("the caller").status, 200);
}

#[tokio::test]
async fn closing_the_relay_fails_every_parked_request() {
    let rig = boot(HookOptions::default()).await;
    let mut agent = rig.agent(DEVICE).await;
    let caller = tokio::spawn(call(rig.addr, "POST", &hook_path("/a"), &[], b"1"));
    agent.json().await;
    rig.hub.fail_pending_and_clear();
    let reply = caller.await.expect("the caller");
    assert_eq!((reply.status, reply.body.as_str()), (502, "{\"error\":\"agent disconnected\"}"));
    assert!(rig.hub.legs().is_empty());
}
