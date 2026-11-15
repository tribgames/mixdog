//! A stand-in provider for the entry's process tests: an Anthropic messages endpoint that answers every request with the next
//! scripted text (the last one again when the script is used up).
//!
//! It listens twice. The Rust binary reaches it over TLS through the `test-support` pin of its HTTP client
//! (`REPLAY_PROVIDER_PIN`, `REPLAY_PROVIDER_PIN_CERT`: [`StandIn::pin`]); the Node CLI reaches it over plain HTTP through the fetch tap
//! (`BENCH_PROVIDER_PORT`, tests/support/tap.mjs: [`StandIn::http_port`]). The root of the test declares `mod request;` (the exec
//! replays' request reader, `mixdog-cli/tests/support/request.rs`).
#![allow(dead_code, reason = "each test uses the part of the stand-in it needs")]

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use serde_json::json;
use tokio::io::AsyncWriteExt;

use crate::request;

/// The hosts the TLS certificate covers.
const NAMES: [&str; 3] = ["api.anthropic.com", "localhost", "127.0.0.1"];

/// A running stand-in; it stops when dropped.
pub struct StandIn {
    tls_addr: std::net::SocketAddr,
    http_addr: std::net::SocketAddr,
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
async fn answer<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(mut io: S, script: Arc<Vec<String>>, count: Arc<AtomicUsize>) {
    let Some(request) = request::read_request(&mut io).await else { return };
    let path = request.path.split('?').next().unwrap_or_default().to_owned();
    if request.method != "POST" || !path.ends_with("/v1/messages") {
        let _ = io.write_all(b"HTTP/1.1 404 Not Found\r\ncontent-type: text/plain\r\ncontent-length: 0\r\nconnection: close\r\n\r\n").await;
        let _ = io.shutdown().await;
        return;
    }
    let index = count.fetch_add(1, Ordering::SeqCst);
    let text = script.get(index).or_else(|| script.last()).map_or("", String::as_str);
    let body = sse_body(text, index);
    let head = format!("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len());
    let _ = io.write_all(head.as_bytes()).await;
    let _ = io.write_all(body.as_bytes()).await;
    let _ = io.shutdown().await;
}

impl StandIn {
    /// Starts the stand-in with the certificate written under `dir`; `script` is the text of each answer in turn.
    pub fn start(dir: &Path, script: &[&str]) -> Self {
        let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
        let script: Arc<Vec<String>> = Arc::new(script.iter().map(|text| (*text).to_owned()).collect());
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
        let http = runtime.block_on(tokio::net::TcpListener::bind("127.0.0.1:0")).unwrap();
        let (tls_addr, http_addr) = (tls.local_addr().unwrap(), http.local_addr().unwrap());
        let (tls_script, tls_count) = (script.clone(), requests.clone());
        runtime.spawn(async move {
            while let Ok((tcp, _)) = tls.accept().await {
                let (acceptor, script, count) = (acceptor.clone(), tls_script.clone(), tls_count.clone());
                tokio::spawn(async move {
                    if let Ok(io) = acceptor.accept(tcp).await {
                        answer(io, script, count).await;
                    }
                });
            }
        });
        let http_count = requests.clone();
        runtime.spawn(async move {
            while let Ok((tcp, _)) = http.accept().await {
                tokio::spawn(answer(tcp, script.clone(), http_count.clone()));
            }
        });
        Self { tls_addr, http_addr, cert_path, requests, runtime: Some(runtime) }
    }

    /// The variables that pin the Rust binary's provider requests to the stand-in.
    pub fn pin(&self) -> [(&'static str, String); 2] {
        [("REPLAY_PROVIDER_PIN", self.tls_addr.to_string()), ("REPLAY_PROVIDER_PIN_CERT", self.cert_path.to_string_lossy().into_owned())]
    }

    /// The port the Node CLI's fetch tap sends its provider requests to.
    pub fn http_port(&self) -> u16 {
        self.http_addr.port()
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
