//! The binary reaches it over TLS through the `test-support` pin of its HTTP client (`REPLAY_PROVIDER_PIN`,
//! `REPLAY_PROVIDER_PIN_CERT`: [`StandIn::pin`]).
#![allow(dead_code, reason = "each test uses the part of the stand-in it needs")]

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use serde_json::json;
use tokio::io::AsyncWriteExt;

/// What the stand-in answers a messages request with.
pub enum Reply {
    /// The next text of the script, as a streamed assistant message (the last one again when the script is used up).
    Texts(Vec<String>),
    /// A 400 with this body, to every request.
    Refuse(String),
    /// A 200 stream that starts a message and then fails with this error message.
    BreakStream(String),
}

/// The method and path of one request, its body read to its end.
async fn read_request<S: tokio::io::AsyncRead + Unpin>(io: &mut S) -> Option<(String, String)> {
    use tokio::io::AsyncReadExt;
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        if let Some(at) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break at;
        }
        let read = io.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
    };
    let head = String::from_utf8_lossy(&buffer[..head_end]).into_owned();
    let mut first = head.lines().next()?.split(' ');
    let (method, path) = (first.next()?.to_owned(), first.next()?.to_owned());
    let length = head
        .lines()
        .find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length:").and_then(|value| value.trim().parse::<usize>().ok()))
        .unwrap_or(0);
    let mut have = buffer.len() - head_end - 4;
    while have < length {
        let read = io.read(&mut chunk).await.ok()?;
        if read == 0 {
            break;
        }
        have += read;
    }
    Some((method, path))
}

/// The hosts the TLS certificate covers.
const NAMES: [&str; 3] = ["api.anthropic.com", "localhost", "127.0.0.1"];

/// A running stand-in; it stops when dropped.
pub struct StandIn {
    tls_addr: std::net::SocketAddr,
    cert_path: PathBuf,
    requests: Arc<AtomicUsize>,
    runtime: Option<tokio::runtime::Runtime>,
}

/// The SSE body of an assistant message that says `text`.
fn sse_body(text: &str, index: usize) -> String {
    let event = |name: &str, data: serde_json::Value| format!("event: {name}\ndata: {data}\n\n");
    [
        event("message_start", json!({ "type": "message_start", "message": { "id": format!("msg_{index}"), "type": "message", "role": "assistant", "model": "claude-sonnet-4-6", "content": [], "usage": { "input_tokens": 21, "output_tokens": 1 } } })),
        event("content_block_start", json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "text", "text": "" } })),
        event("content_block_delta", json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": text } })),
        event("content_block_stop", json!({ "type": "content_block_stop", "index": 0 })),
        event("message_delta", json!({ "type": "message_delta", "delta": { "stop_reason": "end_turn" }, "usage": { "output_tokens": 11 } })),
        event("message_stop", json!({ "type": "message_stop" })),
    ]
    .concat()
}

/// Answers the requests of one connection.
async fn answer<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(mut io: S, reply: Arc<Reply>, count: Arc<AtomicUsize>) {
    let Some((method, path)) = read_request(&mut io).await else { return };
    let path = path.split('?').next().unwrap_or_default().to_owned();
    if method != "POST" || !path.ends_with("/v1/messages") {
        let _ = io.write_all(b"HTTP/1.1 404 Not Found\r\ncontent-type: text/plain\r\ncontent-length: 0\r\nconnection: close\r\n\r\n").await;
        let _ = io.shutdown().await;
        return;
    }
    let index = count.fetch_add(1, Ordering::SeqCst);
    let (status, kind, body) = match &*reply {
        Reply::Texts(script) => ("200 OK", "text/event-stream", sse_body(script.get(index).or_else(|| script.last()).map_or("", String::as_str), index)),
        Reply::Refuse(body) => ("400 Bad Request", "application/json", body.clone()),
        Reply::BreakStream(message) => {
            let started = sse_body("", index);
            let started = &started[..started.find("event: content_block_start").unwrap_or(started.len())];
            (
                "200 OK",
                "text/event-stream",
                format!("{started}event: error\ndata: {}\n\n", json!({ "type": "error", "error": { "type": "invalid_request_error", "message": message } })),
            )
        }
    };
    let head = format!("HTTP/1.1 {status}\r\ncontent-type: {kind}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len());
    let _ = io.write_all(head.as_bytes()).await;
    let _ = io.write_all(body.as_bytes()).await;
    let _ = io.shutdown().await;
}

impl StandIn {
    /// Starts the stand-in with the certificate written under `dir`; `script` is the text of each answer in turn.
    pub fn start(dir: &Path, script: &[&str]) -> Self {
        Self::start_with(dir, Reply::Texts(script.iter().map(|text| (*text).to_owned()).collect()))
    }

    /// Starts the stand-in with the certificate written under `dir`, answering as `reply` says.
    pub fn start_with(dir: &Path, reply: Reply) -> Self {
        let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
        let reply = Arc::new(reply);
        let requests = Arc::new(AtomicUsize::new(0));

        let issued = rcgen::generate_simple_self_signed(NAMES.iter().map(|name| (*name).to_owned()).collect::<Vec<_>>()).unwrap();
        let cert_path = dir.join("stand-in.der");
        std::fs::write(&cert_path, issued.cert.der().to_vec()).unwrap();
        let key = rustls::pki_types::PrivateKeyDer::Pkcs8(rustls::pki_types::PrivatePkcs8KeyDer::from(issued.signing_key.serialize_der()));
        let mut config = rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(vec![issued.cert.der().clone()], key)
            .unwrap();
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));

        let tls = runtime.block_on(tokio::net::TcpListener::bind("127.0.0.1:0")).unwrap();
        let tls_addr = tls.local_addr().unwrap();
        let count = requests.clone();
        runtime.spawn(async move {
            while let Ok((tcp, _)) = tls.accept().await {
                let (acceptor, reply, count) = (acceptor.clone(), reply.clone(), count.clone());
                tokio::spawn(async move {
                    if let Ok(io) = acceptor.accept(tcp).await {
                        answer(io, reply, count).await;
                    }
                });
            }
        });
        Self { tls_addr, cert_path, requests, runtime: Some(runtime) }
    }

    /// The variables that pin the binary's provider requests to the stand-in.
    pub fn pin(&self) -> [(&'static str, String); 2] {
        [("REPLAY_PROVIDER_PIN", self.tls_addr.to_string()), ("REPLAY_PROVIDER_PIN_CERT", self.cert_path.to_string_lossy().into_owned())]
    }

    /// How many messages requests it has answered.
    pub fn requests(&self) -> usize {
        self.requests.load(Ordering::SeqCst)
    }
}

impl Drop for StandIn {
    fn drop(&mut self) {
        if let Some(runtime) = self.runtime.take() {
            runtime.shutdown_background();
        }
    }
}
