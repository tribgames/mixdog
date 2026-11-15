//! The recorder of a connection: what a relay sent on it, as events. An HTTP answer is the status line, the headers in
//! order with their values, the body de-chunked (chunk sizes follow the sender's stream internals and are not
//! compared), the trailers, and whether the relay closed the connection. A WebSocket peer yields messages with their
//! opcode and payload, ping, pong, close code and reason, and the TCP close. Bytes are written to the relay unchanged.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine as _;
use rustls::pki_types::ServerName;
use serde_json::{Value, json};

/// The masking key of every client frame, fixed so a scenario sends the same bytes to both relays.
pub const MASK: [u8; 4] = [0x37, 0xfa, 0x21, 0x3d];
/// The `Sec-WebSocket-Key` of every handshake.
pub const HANDSHAKE_KEY: &str = "dGhlIHNhbXBsZSBub25jZQ==";
const MAX_FRAME: u64 = 512 << 20;
const PULL_SLICE: Duration = Duration::from_millis(20);

/// The throwaway certificate of a TLS scenario: the pem files both relays serve and the client config trusting it.
pub struct Tls {
    pub client: Arc<rustls::ClientConfig>,
    pub cert_pem: String,
    pub key_pem: String,
}

pub fn tls() -> &'static Tls {
    static TLS: OnceLock<Tls> = OnceLock::new();
    TLS.get_or_init(|| {
        let issued = rcgen::generate_simple_self_signed(vec!["localhost".to_owned()]).expect("a throwaway certificate");
        let mut roots = rustls::RootCertStore::empty();
        roots.add(issued.cert.der().clone()).expect("the certificate is a trust anchor");
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let client = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .expect("protocol versions")
            .with_root_certificates(roots)
            .with_no_client_auth();
        Tls { client: Arc::new(client), cert_pem: issued.cert.pem(), key_pem: issued.signing_key.serialize_pem() }
    })
}

enum Chunk {
    Data(Vec<u8>),
    Closed,
}

/// A client connection: a pump thread owns the socket (and the TLS session when there is one) so reads and writes
/// never wait on each other. A reset and an orderly end are both `closed`.
pub struct Conn {
    writer: Sender<Vec<u8>>,
    reader: Receiver<Chunk>,
    pub buf: Vec<u8>,
    pub closed: bool,
}

fn pump<S: Read + Write>(mut stream: S, writes: Receiver<Vec<u8>>, events: Sender<Chunk>) {
    let mut chunk = vec![0u8; 16 * 1024];
    let mut write_failed = false;
    loop {
        loop {
            match writes.try_recv() {
                Ok(bytes) if !write_failed => {
                    // The peer may have closed already: what it sent before that is still read below.
                    write_failed = stream.write_all(&bytes).and_then(|()| stream.flush()).is_err();
                }
                Ok(_) => {}
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => return,
            }
        }
        match stream.read(&mut chunk) {
            Ok(0) => {
                let _ = events.send(Chunk::Closed);
                return;
            }
            Ok(n) => {
                if events.send(Chunk::Data(chunk[..n].to_vec())).is_err() {
                    return;
                }
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut | std::io::ErrorKind::Interrupted
                ) => {}
            Err(_) => {
                let _ = events.send(Chunk::Closed);
                return;
            }
        }
    }
}

impl Conn {
    pub fn open(port: u16, tls_on: bool) -> Result<Self, String> {
        let tcp = TcpStream::connect(("127.0.0.1", port)).map_err(|e| format!("connect to 127.0.0.1:{port}: {e}"))?;
        tcp.set_nodelay(true).map_err(|e| e.to_string())?;
        tcp.set_read_timeout(Some(PULL_SLICE)).map_err(|e| e.to_string())?;
        let (write_tx, write_rx) = mpsc::channel();
        let (event_tx, event_rx) = mpsc::channel();
        if tls_on {
            let name = ServerName::try_from("localhost").map_err(|e| e.to_string())?;
            let session = rustls::ClientConnection::new(tls().client.clone(), name).map_err(|e| e.to_string())?;
            let stream = rustls::StreamOwned::new(session, tcp);
            std::thread::spawn(move || pump(stream, write_rx, event_tx));
        } else {
            std::thread::spawn(move || pump(tcp, write_rx, event_tx));
        }
        Ok(Self { writer: write_tx, reader: event_rx, buf: Vec::new(), closed: false })
    }

    pub fn write(&self, bytes: Vec<u8>) {
        // A pump that has ended (the relay closed) takes no more: the close is what the transcript shows.
        let _ = self.writer.send(bytes);
    }

    /// Waits for the next chunk or the close until `deadline`; false when nothing came in time.
    pub fn pull(&mut self, deadline: Instant) -> bool {
        if self.closed {
            return false;
        }
        let wait = deadline.saturating_duration_since(Instant::now());
        match self.reader.recv_timeout(wait) {
            Ok(Chunk::Data(bytes)) => {
                self.buf.extend_from_slice(&bytes);
                true
            }
            Ok(Chunk::Closed) | Err(RecvTimeoutError::Disconnected) => {
                self.closed = true;
                true
            }
            Err(RecvTimeoutError::Timeout) => false,
        }
    }

    /// Whether the relay closes the connection within `wait`; bytes that arrive meanwhile are kept in `buf`.
    pub fn closes_within(&mut self, wait: Duration) -> bool {
        let deadline = Instant::now() + wait;
        while !self.closed {
            if !self.pull(deadline) {
                break;
            }
        }
        self.closed
    }
}

pub fn body_value(bytes: &[u8]) -> Value {
    match std::str::from_utf8(bytes) {
        Ok(text) => json!({ "text": text }),
        Err(_) => json!({ "base64": base64::engine::general_purpose::STANDARD.encode(bytes) }),
    }
}

// ---- HTTP ----

#[derive(Debug, Clone)]
pub struct Head {
    pub status: u16,
    pub status_line: String,
    pub headers: Vec<(String, String)>,
    pub len: usize,
}

impl Head {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

fn parse_head(buf: &[u8]) -> Result<Option<Head>, String> {
    let mut storage = [httparse::EMPTY_HEADER; 128];
    let mut response = httparse::Response::new(&mut storage);
    match response.parse(buf) {
        Ok(httparse::Status::Complete(len)) => {
            let status = response.code.unwrap_or(0);
            let status_line =
                format!("HTTP/1.{} {} {}", response.version.unwrap_or(1), status, response.reason.unwrap_or(""));
            let headers = response
                .headers
                .iter()
                .map(|h| (h.name.to_owned(), String::from_utf8_lossy(h.value).into_owned()))
                .collect();
            Ok(Some(Head { status, status_line, headers, len }))
        }
        Ok(httparse::Status::Partial) => Ok(None),
        Err(e) => {
            Err(format!("unparsable response head ({e}): {}", String::from_utf8_lossy(&buf[..buf.len().min(200)])))
        }
    }
}

/// A chunked body when `buf` holds all of it: the body, the trailers, the bytes used.
type Dechunked = (Vec<u8>, Vec<(String, String)>, usize);

pub fn dechunk(buf: &[u8]) -> Result<Option<Dechunked>, String> {
    let mut body = Vec::new();
    let mut at = 0;
    loop {
        let Some(end) = find(&buf[at..], b"\r\n") else { return Ok(None) };
        let size_line = std::str::from_utf8(&buf[at..at + end]).map_err(|_| "chunk size is not text".to_owned())?;
        let size_text = size_line.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size_text, 16).map_err(|_| format!("bad chunk size {size_text:?}"))?;
        at += end + 2;
        if size == 0 {
            let mut trailers = Vec::new();
            loop {
                let Some(end) = find(&buf[at..], b"\r\n") else { return Ok(None) };
                let line = &buf[at..at + end];
                at += end + 2;
                if line.is_empty() {
                    return Ok(Some((body, trailers, at)));
                }
                let text = String::from_utf8_lossy(line);
                let (name, value) = text.split_once(':').unwrap_or((text.as_ref(), ""));
                trailers.push((name.to_owned(), value.trim().to_owned()));
            }
        }
        if buf.len() < at + size + 2 {
            return Ok(None);
        }
        body.extend_from_slice(&buf[at..at + size]);
        at += size;
        if &buf[at..at + 2] != b"\r\n" {
            return Err("chunk is not followed by CRLF".to_owned());
        }
        at += 2;
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

#[derive(Debug)]
pub struct Response {
    pub head: Head,
    pub body: Vec<u8>,
    pub trailers: Vec<(String, String)>,
    /// The connection closed before the body was complete.
    pub truncated: bool,
}

pub enum Answer {
    /// The relay closed the connection without an answer (the bytes it sent, if any, are not a head).
    NoAnswer(Vec<u8>),
    Response(Response),
}

/// The head of an answer. `Ok(Err(bytes))`: the relay closed before a head was complete.
pub fn read_head(conn: &mut Conn, deadline: Instant) -> Result<Result<Head, Vec<u8>>, String> {
    loop {
        if let Some(head) = parse_head(&conn.buf)? {
            conn.buf.drain(..head.len);
            return Ok(Ok(head));
        }
        if conn.closed {
            return Ok(Err(std::mem::take(&mut conn.buf)));
        }
        if !conn.pull(deadline) {
            return Err(format!("no complete response head in time; got {} bytes", conn.buf.len()));
        }
    }
}

/// The body that follows `head`, framed by chunked coding, Content-Length, or the close of the connection.
pub fn read_body(conn: &mut Conn, head: Head, head_request: bool, deadline: Instant) -> Result<Response, String> {
    let bodiless = head_request || head.status == 204 || head.status == 304 || (100..200).contains(&head.status);
    if bodiless {
        return Ok(Response { head, body: Vec::new(), trailers: Vec::new(), truncated: false });
    }
    let chunked = head.header("transfer-encoding").is_some_and(|v| v.to_ascii_lowercase().contains("chunked"));
    if chunked {
        loop {
            if let Some((body, trailers, used)) = dechunk(&conn.buf)? {
                conn.buf.drain(..used);
                return Ok(Response { head, body, trailers, truncated: false });
            }
            if conn.closed {
                return Ok(Response {
                    head,
                    body: std::mem::take(&mut conn.buf),
                    trailers: Vec::new(),
                    truncated: true,
                });
            }
            if !conn.pull(deadline) {
                return Err(format!("chunked body incomplete in time; got {} bytes", conn.buf.len()));
            }
        }
    }
    if let Some(length) = head.header("content-length") {
        let length: usize = length.trim().parse().map_err(|_| format!("bad Content-Length {length:?}"))?;
        while conn.buf.len() < length {
            if conn.closed {
                let body = std::mem::take(&mut conn.buf);
                return Ok(Response { head, body, trailers: Vec::new(), truncated: true });
            }
            if !conn.pull(deadline) {
                return Err(format!("body incomplete in time; got {} of {length} bytes", conn.buf.len()));
            }
        }
        let body: Vec<u8> = conn.buf.drain(..length).collect();
        return Ok(Response { head, body, trailers: Vec::new(), truncated: false });
    }
    while !conn.closed {
        if !conn.pull(deadline) {
            return Err("a body ended by the close did not end in time".to_owned());
        }
    }
    let body = std::mem::take(&mut conn.buf);
    Ok(Response { head, body, trailers: Vec::new(), truncated: false })
}

pub fn read_answer(conn: &mut Conn, head_request: bool, deadline: Instant) -> Result<Answer, String> {
    match read_head(conn, deadline)? {
        Err(seen) => Ok(Answer::NoAnswer(seen)),
        Ok(head) => read_body(conn, head, head_request, deadline).map(Answer::Response),
    }
}

pub fn headers_value(headers: &[(String, String)]) -> Value {
    Value::Array(headers.iter().map(|(k, v)| json!([k, v])).collect())
}

// ---- WebSocket ----

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WsEvent {
    /// A complete text or binary message (fragments joined); `op` is 1 or 2.
    Message {
        op: u8,
        data: Vec<u8>,
    },
    Ping(Vec<u8>),
    Pong(Vec<u8>),
    Close {
        code: Option<u16>,
        reason: String,
    },
    TcpClosed,
}

impl WsEvent {
    pub fn to_value(&self) -> Value {
        match self {
            Self::Message { op, data } => {
                let mut value = body_value(data);
                value["op"] = json!(if *op == 1 { "text" } else { "binary" });
                value["ev"] = json!("ws_message");
                value
            }
            Self::Ping(data) => json!({ "ev": "ws_ping", "payload": body_value(data) }),
            Self::Pong(data) => json!({ "ev": "ws_pong", "payload": body_value(data) }),
            Self::Close { code, reason } => json!({ "ev": "ws_close", "code": code, "reason": reason }),
            Self::TcpClosed => json!({ "ev": "tcp_close" }),
        }
    }
}

/// A client frame, masked with [`MASK`]. `declared` replaces the length in the header (a frame that announces more
/// than it carries).
pub fn encode_frame(fin: bool, op: u8, payload: &[u8], declared: Option<u64>) -> Vec<u8> {
    let length = declared.unwrap_or(payload.len() as u64);
    let mut frame = vec![if fin { 0x80 } else { 0 } | op];
    if length < 126 {
        frame.push(0x80 | length as u8);
    } else if length <= u64::from(u16::MAX) {
        frame.push(0x80 | 126);
        frame.extend_from_slice(&(length as u16).to_be_bytes());
    } else {
        frame.push(0x80 | 127);
        frame.extend_from_slice(&length.to_be_bytes());
    }
    frame.extend_from_slice(&MASK);
    frame.extend(payload.iter().enumerate().map(|(i, byte)| byte ^ MASK[i % 4]));
    frame
}

pub fn close_payload(code: Option<u16>, reason: &str) -> Vec<u8> {
    let mut payload = Vec::new();
    if let Some(code) = code {
        payload.extend_from_slice(&code.to_be_bytes());
        payload.extend_from_slice(reason.as_bytes());
    }
    payload
}

/// One server frame at the start of `buf`: `(fin, op, payload, bytes used)`.
pub fn parse_frame(buf: &[u8]) -> Result<Option<(bool, u8, Vec<u8>, usize)>, String> {
    if buf.len() < 2 {
        return Ok(None);
    }
    let (fin, op) = (buf[0] & 0x80 != 0, buf[0] & 0x0f);
    let masked = buf[1] & 0x80 != 0;
    let (length, mut at) = match buf[1] & 0x7f {
        126 => {
            if buf.len() < 4 {
                return Ok(None);
            }
            (u64::from(u16::from_be_bytes([buf[2], buf[3]])), 4)
        }
        127 => {
            if buf.len() < 10 {
                return Ok(None);
            }
            let mut eight = [0u8; 8];
            eight.copy_from_slice(&buf[2..10]);
            (u64::from_be_bytes(eight), 10)
        }
        short => (u64::from(short), 2),
    };
    if length > MAX_FRAME {
        return Err(format!("a server frame declares {length} bytes"));
    }
    let mask = if masked {
        if buf.len() < at + 4 {
            return Ok(None);
        }
        let key = [buf[at], buf[at + 1], buf[at + 2], buf[at + 3]];
        at += 4;
        Some(key)
    } else {
        None
    };
    let length = length as usize;
    if buf.len() < at + length {
        return Ok(None);
    }
    let mut payload = buf[at..at + length].to_vec();
    if let Some(key) = mask {
        for (i, byte) in payload.iter_mut().enumerate() {
            *byte ^= key[i % 4];
        }
    }
    Ok(Some((fin, op, payload, at + length)))
}

/// The upgraded side of a connection. Pings are answered with a pong, the first close with the same code, as a
/// WebSocket client does, so the close handshake can finish.
pub struct WsPeer {
    conn: Conn,
    partial: Option<(u8, Vec<u8>)>,
    answered_close: bool,
    reported_close: bool,
}

impl WsPeer {
    pub fn new(conn: Conn) -> Self {
        Self { conn, partial: None, answered_close: false, reported_close: false }
    }

    pub fn write(&self, bytes: Vec<u8>) {
        self.conn.write(bytes);
    }

    /// Answers the pings that have arrived while no step reads this connection (a step blocked on an HTTP answer),
    /// as a WebSocket client that reads in the background does, so a relay that sweeps for silent legs does not cut it.
    /// The answered pings are not events of the transcript; every other byte stays for the step that reads it.
    pub fn keepalive(&mut self) {
        while self.conn.pull(Instant::now()) {}
        let mut kept = Vec::with_capacity(self.conn.buf.len());
        let mut at = 0;
        while let Ok(Some((_, op, payload, used))) = parse_frame(&self.conn.buf[at..]) {
            if op == 9 {
                self.conn.write(encode_frame(true, 10, &payload, None));
            } else {
                kept.extend_from_slice(&self.conn.buf[at..at + used]);
            }
            at += used;
        }
        kept.extend_from_slice(&self.conn.buf[at..]);
        self.conn.buf = kept;
    }

    /// The next event, or `None` when nothing came before `deadline`.
    pub fn next(&mut self, deadline: Instant) -> Result<Option<WsEvent>, String> {
        loop {
            if let Some((fin, op, payload, used)) = parse_frame(&self.conn.buf)? {
                self.conn.buf.drain(..used);
                if let Some(event) = self.frame_event(fin, op, payload)? {
                    return Ok(Some(event));
                }
                continue;
            }
            if self.conn.closed {
                if self.reported_close {
                    return Ok(None);
                }
                self.reported_close = true;
                return Ok(Some(WsEvent::TcpClosed));
            }
            if !self.conn.pull(deadline) {
                return Ok(None);
            }
        }
    }

    fn frame_event(&mut self, fin: bool, op: u8, payload: Vec<u8>) -> Result<Option<WsEvent>, String> {
        match op {
            0 => {
                let Some((first, mut data)) = self.partial.take() else {
                    return Err("a continuation frame with nothing to continue".to_owned());
                };
                data.extend_from_slice(&payload);
                if fin {
                    Ok(Some(WsEvent::Message { op: first, data }))
                } else {
                    self.partial = Some((first, data));
                    Ok(None)
                }
            }
            1 | 2 if fin => Ok(Some(WsEvent::Message { op, data: payload })),
            1 | 2 => {
                self.partial = Some((op, payload));
                Ok(None)
            }
            9 => {
                self.conn.write(encode_frame(true, 10, &payload, None));
                Ok(Some(WsEvent::Ping(payload)))
            }
            10 => Ok(Some(WsEvent::Pong(payload))),
            8 => {
                let code = (payload.len() >= 2).then(|| u16::from_be_bytes([payload[0], payload[1]]));
                let reason = String::from_utf8_lossy(payload.get(2..).unwrap_or(&[])).into_owned();
                if !self.answered_close {
                    self.answered_close = true;
                    self.conn.write(encode_frame(true, 8, &close_payload(code, &reason), None));
                }
                Ok(Some(WsEvent::Close { code, reason }))
            }
            other => Err(format!("a server frame with opcode {other}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_client_frame_is_masked_and_its_length_can_be_declared_larger() {
        let frame = encode_frame(true, 1, b"hi", None);
        assert_eq!(&frame[..2], &[0x81, 0x82]);
        assert_eq!(&frame[2..6], &MASK);
        assert_eq!(frame[6], b'h' ^ MASK[0]);
        let long = encode_frame(true, 2, b"ab", Some(70_000));
        assert_eq!(long[1], 0x80 | 127);
        assert_eq!(&long[2..10], &70_000u64.to_be_bytes());
        assert_eq!(long.len(), 10 + 4 + 2);
        let medium = encode_frame(false, 1, &[0u8; 200], None);
        assert_eq!(medium[0], 0x01);
        assert_eq!(&medium[1..4], &[0x80 | 126, 0, 200]);
    }

    #[test]
    fn server_frames_parse_in_pieces() {
        let mut bytes = vec![0x81, 0x03];
        bytes.extend_from_slice(b"abc");
        bytes.extend_from_slice(&[0x88, 0x04, 0x0f, 0xa5]);
        bytes.extend_from_slice(b"no");
        assert_eq!(parse_frame(&bytes[..1]).unwrap(), None);
        assert_eq!(parse_frame(&bytes[..4]).unwrap(), None);
        let (fin, op, payload, used) = parse_frame(&bytes).unwrap().unwrap();
        assert!(fin && op == 1 && payload == b"abc" && used == 5);
        let (_, op, payload, used) = parse_frame(&bytes[used..]).unwrap().unwrap();
        assert_eq!((op, payload, used), (8, vec![0x0f, 0xa5, b'n', b'o'], 6));
    }

    #[test]
    fn fragments_join_into_one_message() {
        let (tx, rx) = mpsc::channel();
        let (wtx, _wrx) = mpsc::channel();
        let mut peer = WsPeer::new(Conn { writer: wtx, reader: rx, buf: Vec::new(), closed: false });
        let mut bytes = vec![0x01, 0x02];
        bytes.extend_from_slice(b"ab");
        bytes.extend_from_slice(&[0x80, 0x01]);
        bytes.extend_from_slice(b"c");
        tx.send(Chunk::Data(bytes)).unwrap();
        let event = peer.next(Instant::now() + Duration::from_millis(200)).unwrap();
        assert_eq!(event, Some(WsEvent::Message { op: 1, data: b"abc".to_vec() }));
        assert_eq!(peer.next(Instant::now() + Duration::from_millis(30)).unwrap(), None);
        tx.send(Chunk::Closed).unwrap();
        assert_eq!(peer.next(Instant::now() + Duration::from_millis(200)).unwrap(), Some(WsEvent::TcpClosed));
        assert_eq!(peer.next(Instant::now() + Duration::from_millis(30)).unwrap(), None);
    }

    #[test]
    fn a_chunked_body_is_joined_whatever_its_chunk_sizes() {
        let a = dechunk(b"3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n").unwrap().unwrap();
        let b = dechunk(b"5\r\nabcde\r\n0\r\n\r\n").unwrap().unwrap();
        assert_eq!(a.0, b"abcde");
        assert_eq!(a.0, b.0);
        let with_trailer = dechunk(b"1\r\nx\r\n0\r\nX-Sum: 7\r\n\r\n").unwrap().unwrap();
        assert_eq!(with_trailer.1, vec![("X-Sum".to_owned(), "7".to_owned())]);
        assert!(dechunk(b"5\r\nabc").unwrap().is_none());
        assert!(dechunk(b"zz\r\n").is_err());
    }

    #[test]
    fn a_response_head_keeps_header_order_and_case() {
        let head = parse_head(b"HTTP/1.1 404 Not Found\r\nX-B: 1\r\nx-a: 2\r\nX-B: 3\r\n\r\nrest").unwrap().unwrap();
        assert_eq!(head.status_line, "HTTP/1.1 404 Not Found");
        assert_eq!(head.headers[0], ("X-B".to_owned(), "1".to_owned()));
        assert_eq!(head.headers[1].0, "x-a");
        assert_eq!(head.headers[2].1, "3");
        assert_eq!(head.len, b"HTTP/1.1 404 Not Found\r\nX-B: 1\r\nx-a: 2\r\nX-B: 3\r\n\r\n".len());
        assert!(parse_head(b"HTTP/1.1 200 OK\r\nA: b\r\n").unwrap().is_none());
    }
}
