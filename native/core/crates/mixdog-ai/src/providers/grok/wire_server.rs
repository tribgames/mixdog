//! The loopback server of the Rust half of the Grok wire recording; `wire/server.mjs` is its Node twin. A TLS listener on
//! 127.0.0.1 that keeps, byte for byte, what the production client (`ReqwestLink`) writes, and answers as the scenario's
//! script says. Nothing is parsed by a library: the request line, the headers (name and value, in the order sent) and the
//! body come from the bytes read off the socket. The recording has the shape `server.mjs` documents:
//! `{ kind: "http", conn, line, headers: [[name, value]...], body: { bytes, sha256, text } | null }`, a connection numbered
//! by its first recorded event.

use std::collections::VecDeque;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use rustls::ServerConfig;
use rustls::pki_types::PrivateKeyDer;
use rustls::pki_types::PrivatePkcs8KeyDer;
use serde_json::Value;
use serde_json::json;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::net::TcpStream;
use tokio_rustls::TlsAcceptor;

use super::fixture_manifest::sha256;

#[derive(Default)]
struct Inner {
    sink: Mutex<Vec<Value>>,
    script: Mutex<VecDeque<Value>>,
    next: AtomicUsize,
    unanswered: AtomicBool,
}

pub struct Loopback {
    inner: Arc<Inner>,
    pub addr: SocketAddr,
    /// The throwaway certificate the client trusts instead of the system's roots.
    pub root: reqwest::Certificate,
}

impl Loopback {
    pub async fn start(hosts: &[&str]) -> Self {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let issued = rcgen::generate_simple_self_signed(hosts.iter().map(|host| (*host).to_owned()).collect::<Vec<_>>()).unwrap();
        let certificate = issued.cert.der().clone();
        let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(issued.signing_key.serialize_der()));
        let mut config = ServerConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(vec![certificate.clone()], key)
            .unwrap();
        // Node's undici speaks HTTP/1.1 only, and so does the recording.
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
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
        Self { inner, addr, root: reqwest::Certificate::from_der(&certificate).unwrap() }
    }

    /// Starts a scenario: a fresh recording, connection numbering and script.
    pub fn begin(&self, script: VecDeque<Value>) {
        self.inner.sink.lock().unwrap().clear();
        *self.inner.script.lock().unwrap() = script;
        self.inner.next.store(0, Ordering::SeqCst);
        self.inner.unanswered.store(false, Ordering::SeqCst);
    }

    pub fn events(&self) -> Vec<Value> {
        self.inner.sink.lock().unwrap().clone()
    }

    pub fn script_left(&self) -> usize {
        self.inner.script.lock().unwrap().len()
    }

    /// A request arrived that the script had no answer for.
    pub fn unanswered(&self) -> bool {
        self.inner.unanswered.load(Ordering::SeqCst)
    }
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
}

async fn serve(inner: Arc<Inner>, acceptor: TlsAcceptor, tcp: TcpStream) {
    let Ok(mut io) = acceptor.accept(tcp).await else { return };
    let mut conn = 0usize;
    let mut buffer: Vec<u8> = Vec::new();
    loop {
        let mut chunk = [0u8; 16384];
        match io.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(n) => buffer.extend_from_slice(&chunk[..n]),
        }
        while let Some(end) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
            let text: String = buffer[..end].iter().map(|b| *b as char).collect();
            let mut lines = text.split("\r\n");
            let line = lines.next().unwrap().to_owned();
            let headers: Vec<(String, String)> = lines
                .map(|field| {
                    let at = field.find(':').unwrap();
                    (field[..at].to_owned(), field[at + 1..].trim().to_owned())
                })
                .collect();
            assert!(header(&headers, "transfer-encoding").is_none(), "the recorder reads content-length bodies only");
            let length: usize = header(&headers, "content-length").map_or(0, |v| v.parse().unwrap());
            if buffer.len() < end + 4 + length {
                break;
            }
            let body: Vec<u8> = buffer[end + 4..end + 4 + length].to_vec();
            buffer.drain(..end + 4 + length);
            if conn == 0 {
                conn = inner.next.fetch_add(1, Ordering::SeqCst) + 1;
            }
            let shown: Vec<Value> = headers.iter().map(|(n, v)| json!([n, v])).collect();
            let body = if body.is_empty() { Value::Null } else { json!({ "bytes": body.len(), "sha256": sha256(&body), "text": String::from_utf8_lossy(&body) }) };
            inner.sink.lock().unwrap().push(json!({ "kind": "http", "line": line, "headers": shown, "body": body, "conn": conn }));
            // A HEAD request is a socket warm-up: recorded, answered empty.
            if line.starts_with("HEAD ") {
                io.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n").await.ok();
                io.shutdown().await.ok();
                return;
            }
            let reply = inner.script.lock().unwrap().pop_front();
            let Some(reply) = reply else {
                inner.unanswered.store(true, Ordering::SeqCst);
                return;
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
        }
    }
}