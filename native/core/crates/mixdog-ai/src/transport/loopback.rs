//! The loopback server of the Rust half of the wire parity checks, shared by every provider's check; `wire-server.mjs` is
//! its Node twin. A TLS listener on
//! 127.0.0.1 that records, byte for byte, what the production clients (`ReqwestLink`, `KeepaliveDialer`) write, and
//! answers as the scenario's script says. Nothing is parsed by a library: the request line, the headers (name, value, in
//! the order sent) and the body come from the bytes read off the socket, a WebSocket frame from its header and its
//! unmasked payload. The recording has the shape `wire-server.mjs` documents, and `Sec-WebSocket-Key` is replaced by
//! `<random>` exactly as there.

use std::collections::{HashMap, VecDeque};
use std::io::Read;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::{RootCertStore, ServerConfig};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio_rustls::TlsAcceptor;

pub const RANDOM: &str = "<random>";

/// What the server answers: a dial is accepted or refused, each data message sent is answered with the next entry of
/// `replies`, each http request with the next entry of `http`.
#[derive(Default)]
pub struct Script {
    pub dials: VecDeque<Value>,
    pub replies: VecDeque<Value>,
    pub http: VecDeque<Value>,
}

#[derive(Default)]
struct Inner {
    sink: Mutex<Vec<Value>>,
    script: Mutex<Script>,
    paused: AtomicBool,
    next: AtomicUsize,
    ended: Mutex<HashMap<usize, watch::Receiver<bool>>>,
    upgraded: Mutex<Vec<usize>>,
    unanswered: Mutex<Option<String>>,
    /// A reply that holds (`then: 'hold'`) has been written.
    held: tokio::sync::Notify,
}

pub struct Loopback {
    inner: Arc<Inner>,
    pub addr: SocketAddr,
    /// The client side of the throwaway certificate: trusted by nothing else.
    pub tls: Arc<rustls::ClientConfig>,
    pub root: reqwest::Certificate,
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

impl Loopback {
    pub async fn start(hosts: &[&str]) -> Self {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let issued = rcgen::generate_simple_self_signed(hosts.iter().map(|h| (*h).to_owned()).collect::<Vec<_>>()).unwrap();
        let certificate = issued.cert.der().clone();
        let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(issued.signing_key.serialize_der()));
        let mut config = ServerConfig::builder_with_provider(provider.clone())
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(vec![certificate.clone()], key)
            .unwrap();
        // Node's undici speaks HTTP/1.1 only, and so does the recording.
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        let mut roots = RootCertStore::empty();
        roots.add(certificate.clone()).unwrap();
        let tls = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(roots)
            .with_no_client_auth();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let inner = Arc::new(Inner::default());
        let acceptor = TlsAcceptor::from(Arc::new(config));
        let served = inner.clone();
        tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                tokio::spawn(serve(served.clone(), acceptor.clone(), tcp));
            }
        });
        Self { inner, addr, tls: Arc::new(tls), root: reqwest::Certificate::from_der(&certificate).unwrap() }
    }

    /// Starts a scenario: a fresh recording and script.
    pub fn begin(&self, script: Script) {
        self.inner.sink.lock().unwrap().clear();
        *self.inner.script.lock().unwrap() = script;
        *self.inner.unanswered.lock().unwrap() = None;
    }

    pub fn pause(&self, paused: bool) {
        self.inner.paused.store(paused, Ordering::SeqCst);
    }

    pub fn events(&self) -> Vec<Value> {
        self.inner.sink.lock().unwrap().clone()
    }

    /// Appends an event the client side produced (a backoff sleep).
    pub fn push(&self, event: Value) {
        if !self.inner.paused.load(Ordering::SeqCst) {
            self.inner.sink.lock().unwrap().push(event);
        }
    }

    pub fn unanswered(&self) -> Option<String> {
        self.inner.unanswered.lock().unwrap().clone()
    }

    pub fn script_left(&self) -> usize {
        let script = self.inner.script.lock().unwrap();
        script.dials.len() + script.replies.len() + script.http.len()
    }

    /// Resolves once a reply that holds has been written; the caller puts the deadline on it.
    pub async fn held(&self) {
        self.inner.held.notified().await;
    }

    /// The numbers of the connections that upgraded to a WebSocket.
    pub fn upgraded(&self) -> Vec<usize> {
        self.inner.upgraded.lock().unwrap().clone()
    }

    /// Resolves when connection `conn` has closed; with `recorded` the close is an event of the recording. The caller puts
    /// the deadline on it.
    pub async fn closed(&self, conn: usize, recorded: bool) {
        let mut ended = self.inner.ended.lock().unwrap().get(&conn).unwrap().clone();
        ended.wait_for(|gone| *gone).await.unwrap();
        if recorded && !self.inner.paused.load(Ordering::SeqCst) {
            self.inner.sink.lock().unwrap().push(json!({ "kind": "closed", "conn": conn }));
        }
    }
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
}

fn body_record(bytes: &[u8], headers: &[(String, String)]) -> Value {
    if bytes.is_empty() {
        return Value::Null;
    }
    let encoding = header(headers, "content-encoding");
    let decoded = match encoding {
        Some("gzip") => {
            let mut out = Vec::new();
            flate2::read::GzDecoder::new(bytes).read_to_end(&mut out).expect("a gzip body");
            out
        }
        Some("zstd") => zstd::decode_all(bytes).expect("a zstd body"),
        _ => bytes.to_vec(),
    };
    json!({ "encoding": encoding, "bytes": bytes.len(), "sha256": sha256(bytes), "text": String::from_utf8_lossy(&decoded) })
}

fn server_frame(opcode: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = vec![0x80 | opcode];
    match payload.len() {
        n if n < 126 => out.push(n as u8),
        n if n < 65536 => out.extend([126, (n >> 8) as u8, n as u8]),
        n => {
            out.push(127);
            out.extend((n as u64).to_be_bytes());
        }
    }
    out.extend(payload);
    out
}

enum Mode {
    Head,
    Body { line: String, headers: Vec<(String, String)>, length: usize },
    Frames,
}

async fn serve(inner: Arc<Inner>, acceptor: TlsAcceptor, tcp: TcpStream) {
    let Ok(mut io) = acceptor.accept(tcp).await else { return };
    let (gone, ended) = watch::channel(false);
    let mut conn = 0usize;
    let mut buffer: Vec<u8> = Vec::new();
    let mut mode = Mode::Head;
    // `then: 'mute'`: the client's close frames are recorded, never answered (a close that ends slowly).
    let mut muted = false;
    // A connection is numbered by its first recorded event, as in `wire-server.mjs`.
    let record = |conn: &mut usize, event: Value| {
        if *conn == 0 {
            *conn = inner.next.fetch_add(1, Ordering::SeqCst) + 1;
            inner.ended.lock().unwrap().insert(*conn, ended.clone());
        }
        if !inner.paused.load(Ordering::SeqCst) {
            let mut event = event;
            event["conn"] = json!(*conn);
            inner.sink.lock().unwrap().push(event);
        }
    };
    'serving: loop {
        let mut chunk = [0u8; 16384];
        match io.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => buffer.extend_from_slice(&chunk[..n]),
        }
        loop {
            match &mode {
                Mode::Head => {
                    let Some(end) = buffer.windows(4).position(|w| w == b"\r\n\r\n") else { break };
                    let head: Vec<u8> = buffer.drain(..end + 4).take(end).collect();
                    let text: String = head.iter().map(|b| *b as char).collect();
                    let mut lines = text.split("\r\n");
                    let line = lines.next().unwrap().to_owned();
                    let headers: Vec<(String, String)> = lines
                        .map(|field| {
                            let at = field.find(':').unwrap();
                            (field[..at].to_owned(), field[at + 1..].trim().to_owned())
                        })
                        .collect();
                    if header(&headers, "upgrade").is_some_and(|v| v.eq_ignore_ascii_case("websocket")) {
                        let key = header(&headers, "sec-websocket-key").unwrap().to_owned();
                        let shown: Vec<Value> = headers
                            .iter()
                            .map(|(n, v)| json!([n, if n.eq_ignore_ascii_case("sec-websocket-key") { RANDOM } else { v.as_str() }]))
                            .collect();
                        record(&mut conn, json!({ "kind": "ws-upgrade", "line": line, "headers": shown }));
                        inner.upgraded.lock().unwrap().push(conn);
                        let dial = inner.script.lock().unwrap().dials.pop_front().unwrap_or(json!({ "accept": true }));
                        let extra: String = dial["headers"].as_object().into_iter().flatten().map(|(n, v)| format!("{n}: {}\r\n", v.as_str().unwrap())).collect();
                        if dial["accept"] == true {
                            let accept = tokio_tungstenite::tungstenite::handshake::derive_accept_key(key.as_bytes());
                            let reply = format!("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n{extra}\r\n");
                            io.write_all(reply.as_bytes()).await.ok();
                        } else {
                            let body = dial["body"].as_str().unwrap_or("").as_bytes().to_vec();
                            let reply = format!("HTTP/1.1 {} Refused\r\n{extra}content-length: {}\r\nconnection: close\r\n\r\n", dial["status"], body.len());
                            io.write_all(reply.as_bytes()).await.ok();
                            io.write_all(&body).await.ok();
                        }
                        mode = Mode::Frames;
                    } else {
                        assert!(header(&headers, "transfer-encoding").is_none(), "the recorder reads content-length bodies only");
                        let length = header(&headers, "content-length").map_or(0, |v| v.parse().unwrap());
                        mode = Mode::Body { line, headers, length };
                    }
                }
                Mode::Body { length, .. } => {
                    if buffer.len() < *length {
                        break;
                    }
                    let Mode::Body { line, headers, length } = std::mem::replace(&mut mode, Mode::Head) else { unreachable!() };
                    let body: Vec<u8> = buffer.drain(..length).collect();
                    let shown: Vec<Value> = headers.iter().map(|(n, v)| json!([n, v])).collect();
                    record(&mut conn, json!({ "kind": "http", "line": line, "headers": shown, "body": body_record(&body, &headers) }));
                    // A HEAD request is a socket warm-up, recorded and answered empty.
                    if line.starts_with("HEAD ") {
                        io.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n").await.ok();
                        io.shutdown().await.ok();
                        break 'serving;
                    }
                    let reply = inner.script.lock().unwrap().http.pop_front();
                    let Some(reply) = reply else {
                        *inner.unanswered.lock().unwrap() = Some("http".into());
                        break 'serving;
                    };
                    let plan = if reply.is_array() { json!({ "events": reply }) } else { reply };
                    let text = match plan.get("events") {
                        Some(events) => events.as_array().unwrap().iter().map(|e| format!("event: {}\ndata: {e}\n\n", e["type"].as_str().unwrap())).collect::<String>(),
                        None => plan["body"].as_str().unwrap_or("").to_owned(),
                    };
                    let mut fields: Vec<(String, String)> = Vec::new();
                    if plan.get("events").is_some() {
                        fields.push(("content-type".into(), "text/event-stream".into()));
                    }
                    for (n, v) in plan["headers"].as_object().into_iter().flatten() {
                        fields.push((n.clone(), v.as_str().unwrap().to_owned()));
                    }
                    fields.push(("content-length".into(), text.len().to_string()));
                    let status = plan["status"].as_u64().unwrap_or(200);
                    let head: String = fields.iter().map(|(n, v)| format!("{n}: {v}\r\n")).collect();
                    io.write_all(format!("HTTP/1.1 {status} X\r\n{head}\r\n").as_bytes()).await.ok();
                    io.write_all(text.as_bytes()).await.ok();
                    if plan["then"] == "reset" {
                        break 'serving;
                    }
                    mode = Mode::Head;
                }
                Mode::Frames => {
                    if buffer.len() < 2 {
                        break;
                    }
                    let masked = buffer[1] & 128 != 0;
                    let mut length = (buffer[1] & 127) as usize;
                    let mut at = 2;
                    if length == 126 {
                        if buffer.len() < 4 {
                            break;
                        }
                        length = u16::from_be_bytes([buffer[2], buffer[3]]) as usize;
                        at = 4;
                    } else if length == 127 {
                        if buffer.len() < 10 {
                            break;
                        }
                        length = u64::from_be_bytes(buffer[2..10].try_into().unwrap()) as usize;
                        at = 10;
                    }
                    let mask: Option<[u8; 4]> = masked.then(|| buffer.get(at..at + 4).map(|m| m.try_into().unwrap())).flatten();
                    if masked {
                        if mask.is_none() {
                            break;
                        }
                        at += 4;
                    }
                    if buffer.len() < at + length {
                        break;
                    }
                    let mut payload = buffer[at..at + length].to_vec();
                    if let Some(mask) = mask {
                        for (i, b) in payload.iter_mut().enumerate() {
                            *b ^= mask[i % 4];
                        }
                    }
                    let first = buffer[0];
                    buffer.drain(..at + length);
                    let opcode = first & 15;
                    let mut event = json!({
                        "kind": "ws-frame", "opcode": opcode, "fin": first & 128 != 0,
                        "rsv": [first & 64 != 0, first & 32 != 0, first & 16 != 0], "masked": masked, "bytes": payload.len(),
                    });
                    if opcode == 1 {
                        event["text"] = json!(String::from_utf8_lossy(&payload));
                    } else {
                        event["hex"] = json!(hex(&payload));
                    }
                    record(&mut conn, event);
                    if opcode == 8 && !muted {
                        io.write_all(&server_frame(8, &payload)).await.ok();
                    }
                    if opcode == 9 {
                        io.write_all(&server_frame(10, &payload)).await.ok();
                    }
                    if opcode == 1 || opcode == 2 {
                        let reply = inner.script.lock().unwrap().replies.pop_front();
                        let Some(reply) = reply else {
                            *inner.unanswered.lock().unwrap() = Some("ws".into());
                            break 'serving;
                        };
                        let plan = if reply.is_array() { json!({ "events": reply }) } else { reply };
                        for event in plan["events"].as_array().into_iter().flatten() {
                            io.write_all(&server_frame(1, event.to_string().as_bytes())).await.ok();
                        }
                        if plan["then"] == "close" {
                            io.write_all(&server_frame(8, &[3, 232])).await.ok();
                            io.shutdown().await.ok();
                            break 'serving;
                        }
                        if plan["then"] == "reset" {
                            break 'serving;
                        }
                        if plan["then"] == "hold" {
                            io.flush().await.ok();
                            inner.held.notify_one();
                        }
                        if plan["then"] == "mute" {
                            muted = true;
                        }
                    }
                }
            }
        }
    }
    drop(io);
    // A muted connection's end is part of the recording: when the client gave up on the close it asked for.
    if muted {
        record(&mut conn, json!({ "kind": "closed" }));
    }
    gone.send(true).ok();
}
