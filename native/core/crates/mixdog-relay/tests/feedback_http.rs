//! `POST /feedback`: the HTTP-level cases of `lib/feedback.test.mjs` (methods, content type, rate limits per address and global,
//! the body cap, the body timeout, the limit on bodies read at once, mail not configured, the error bodies and which refusals
//! close the connection), run over real sockets against the http1 layer with a scripted sender, and the real mailer against
//! a scripted SMTP server that speaks implicit TLS with a certificate made for the test.

use std::future::Future;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_fsio::Unlaned;
use mixdog_relay::feedback::http::BODY_TIMEOUT;
use mixdog_relay::feedback::{
    FeedbackEndpoint, FeedbackMail, FeedbackOptions, FeedbackSender, FeedbackService, Mailer, MAX_BODY_BYTES, SendFailure,
};
use mixdog_relay::http1::{Handler, HandlerFuture, Limits, Request, ResponseWriter, UpgradeRequest};
use mixdog_relay::logline::Line;
use mixdog_relay::mail::MailConfig;
use mixdog_relay::net::Server;
use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::TlsAcceptor;

// ---- the rig ----

struct Route(Arc<FeedbackEndpoint>);

impl Handler for Route {
    fn request(&self, request: Request, response: ResponseWriter) -> HandlerFuture {
        let endpoint = self.0.clone();
        Box::pin(async move { endpoint.handle(request, response).await })
    }

    fn upgrade(&self, _upgrade: UpgradeRequest) {}
}

#[derive(Default)]
struct Fake {
    sent: Mutex<Vec<FeedbackMail>>,
}

impl FeedbackSender for Fake {
    fn send<'a>(&'a self, mail: FeedbackMail) -> Pin<Box<dyn Future<Output = Result<(), SendFailure>> + Send + 'a>> {
        Box::pin(async move {
            self.sent.lock().unwrap().push(mail);
            Ok(())
        })
    }
}

#[derive(Clone, Default)]
struct Lines(Arc<Mutex<Vec<String>>>);

impl Lines {
    fn sink(&self) -> mixdog_relay::feedback::LogSink {
        let lines = self.0.clone();
        Arc::new(move |line: &Line| lines.lock().unwrap().push(line.text.clone()))
    }

    fn all(&self) -> Vec<String> {
        self.0.lock().unwrap().clone()
    }
}

struct Rig {
    dir: TempDir,
    addr: SocketAddr,
    server: Server,
    service: FeedbackService,
}

struct Setup {
    sender: Option<Arc<dyn FeedbackSender>>,
    options: FeedbackOptions,
    body_timeout: Duration,
}

impl Setup {
    fn with(sender: Arc<dyn FeedbackSender>) -> Self {
        Self { sender: Some(sender), options: FeedbackOptions { ip_limit: 1000, global_limit: 10_000, ..FeedbackOptions::default() }, body_timeout: BODY_TIMEOUT }
    }

    fn limits(mut self, ip_limit: usize, global_limit: usize) -> Self {
        self.options.ip_limit = ip_limit;
        self.options.global_limit = global_limit;
        self
    }

    fn body_timeout(mut self, timeout: Duration) -> Self {
        self.body_timeout = timeout;
        self
    }
}

async fn boot(setup: Setup) -> Rig {
    let dir = TempDir::new().unwrap();
    let lines = Lines::default();
    let options = FeedbackOptions { log: lines.sink(), ..setup.options };
    let io = mixdog_rt::testing::tokens().durability_io;
    let service = FeedbackService::start(dir.path(), io, setup.sender, options).await;
    let endpoint = Arc::new(FeedbackEndpoint::new(Some(service.clone())).with_body_timeout(setup.body_timeout));
    let server = Server::start(0, None, Arc::new(Route(endpoint)), Limits::default()).await.unwrap();
    let addr = ([127, 0, 0, 1], server.port()).into();
    Rig { dir, addr, server, service }
}

impl Rig {
    fn feedback_dir(&self) -> PathBuf {
        self.dir.path().join("feedback")
    }

    fn stored(&self) -> usize {
        mixdog_fsio::read_dir(&Unlaned, self.feedback_dir()).unwrap().count()
    }

    async fn finish(self) {
        self.service.close().await;
        self.server.terminate_connections();
    }
}

fn uid(n: u32) -> String {
    format!("{n:08x}-0000-4000-8000-000000000000")
}

fn valid(n: u32) -> Value {
    json!({ "id": uid(n), "kind": "bug", "message": "it broke" })
}

/// What the server answered.
#[derive(Debug)]
struct Reply {
    status: u16,
    head: String,
    body: String,
    /// The server closed the connection (rather than the wait ending).
    closed: bool,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or_else(|_| panic!("not json: {:?}", self.body))
    }

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

fn parse_reply(raw: &[u8], closed: bool) -> Reply {
    let text = String::from_utf8_lossy(raw).into_owned();
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((text.as_str(), ""));
    let status = head.split(' ').nth(1).and_then(|code| code.parse().ok()).unwrap_or_else(|| panic!("no status in {text:?}"));
    let chunked = head.lines().any(|line| line.eq_ignore_ascii_case("Transfer-Encoding: chunked"));
    let body = if chunked { dechunk(body) } else { body.to_owned() };
    Reply { status, head: head.to_owned(), body, closed }
}

/// Reads until the server closes the connection or has said nothing for 400 ms.
async fn read_reply(stream: &mut TcpStream) -> Reply {
    let mut out = Vec::new();
    let mut chunk = [0u8; 8192];
    let mut closed = false;
    loop {
        match mixdog_rt::time::timeout(Duration::from_millis(400), stream.read(&mut chunk)).await {
            Ok(Ok(0) | Err(_)) => {
                closed = true;
                break;
            }
            Ok(Ok(read)) => out.extend_from_slice(&chunk[..read]),
            Err(_) => break,
        }
    }
    parse_reply(&out, closed)
}

fn request_head(method: &str, headers: &[(&str, String)]) -> String {
    let mut head = format!("{method} /feedback HTTP/1.1\r\nHost: relay\r\n");
    for (name, value) in headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    head
}

/// One request with a complete body.
async fn call(addr: SocketAddr, method: &str, content_type: Option<&str>, body: &[u8]) -> Reply {
    let mut headers = vec![("Content-Length", body.len().to_string())];
    if let Some(content_type) = content_type {
        headers.push(("Content-Type", content_type.to_owned()));
    }
    let mut stream = TcpStream::connect(addr).await.unwrap();
    stream.write_all(request_head(method, &headers).as_bytes()).await.unwrap();
    stream.write_all(body).await.unwrap();
    read_reply(&mut stream).await
}

async fn post(addr: SocketAddr, body: &Value) -> Reply {
    call(addr, "POST", Some("application/json"), body.to_string().as_bytes()).await
}

async fn post_text(addr: SocketAddr, text: &str) -> Reply {
    call(addr, "POST", Some("application/json"), text.as_bytes()).await
}

/// A request that declares 1000 bytes and sends one: its body read stays open.
async fn stalled(addr: SocketAddr) -> TcpStream {
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let headers = [("Content-Type", "application/json".to_owned()), ("Content-Length", "1000".to_owned())];
    stream.write_all(request_head("POST", &headers).as_bytes()).await.unwrap();
    stream.write_all(b"x").await.unwrap();
    stream
}

fn is_no_store_json(reply: &Reply) -> bool {
    reply.has("Content-Type: application/json") && reply.has("Cache-Control: no-store")
}

// ---- accepted, refused, and what the answers look like ----

#[tokio::test]
async fn a_valid_post_is_accepted_after_the_record_is_on_disk_and_mailed_once() {
    let fake = Arc::new(Fake::default());
    let rig = boot(Setup::with(fake.clone())).await;
    let reply = post(rig.addr, &json!({ "id": uid(1), "kind": "bug", "message": "  it broke  ", "replyTo": "a@b.co" })).await;
    assert_eq!(reply.status, 202, "{reply:?}");
    assert_eq!(reply.json(), json!({ "id": uid(1), "status": "accepted" }));
    assert!(is_no_store_json(&reply), "{reply:?}");
    assert!(!reply.has("Connection: close"));
    assert_eq!(rig.stored(), 1);
    for _ in 0..100 {
        if !fake.sent.lock().unwrap().is_empty() {
            break;
        }
        mixdog_rt::time::sleep(Duration::from_millis(20)).await;
    }
    let sent = fake.sent.lock().unwrap().clone();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].subject, format!("[Mixdog feedback] bug {}", uid(1)));
    assert_eq!(sent[0].text, "it broke");
    assert_eq!(sent[0].reply_to.as_deref(), Some("a@b.co"));
    let again = post(rig.addr, &json!({ "id": uid(1), "kind": "bug", "message": "it broke", "replyTo": "a@b.co" })).await;
    assert_eq!(again.status, 202);
    rig.finish().await;
}

#[tokio::test]
async fn a_body_that_is_not_a_valid_feedback_is_400_invalid_feedback_and_stores_nothing() {
    let rig = boot(Setup::with(Arc::new(Fake::default()))).await;
    let long_reply = format!("{}@b.co", "a".repeat(250));
    let bad = [
        "not json".to_owned(),
        "[]".to_owned(),
        "".to_owned(),
        json!({ "id": "nope", "kind": "bug", "message": "m" }).to_string(),
        json!({ "id": uid(2), "kind": "x", "message": "m" }).to_string(),
        json!({ "id": uid(2), "kind": "bug", "message": "   " }).to_string(),
        json!({ "id": uid(2), "kind": "bug", "message": "a".repeat(8001) }).to_string(),
        json!({ "id": uid(2), "kind": "bug", "message": "m", "replyTo": "not-an-email" }).to_string(),
        json!({ "id": uid(2), "kind": "bug", "message": "m", "replyTo": long_reply }).to_string(),
        json!({ "id": uid(2), "kind": "bug", "message": "m", "replyTo": 5 }).to_string(),
        json!({ "id": uid(2), "kind": "bug", "message": "m", "replyTo": null }).to_string(),
    ];
    for text in &bad {
        let reply = post_text(rig.addr, text).await;
        assert_eq!(reply.status, 400, "{:?}", &text[..text.len().min(40)]);
        assert_eq!(reply.json(), json!({ "error": "invalid_feedback" }));
        assert!(is_no_store_json(&reply));
        assert!(!reply.has("Connection: close"));
    }
    assert_eq!(rig.stored(), 0);
    let longest = post(rig.addr, &json!({ "id": uid(3), "kind": "bug", "message": "a".repeat(8000), "replyTo": "  " })).await;
    assert_eq!(longest.status, 202, "{longest:?}");
    rig.finish().await;
}

#[tokio::test]
async fn a_conflicting_resubmission_is_409_conflict() {
    let rig = boot(Setup::with(Arc::new(Fake::default()))).await;
    assert_eq!(post(rig.addr, &valid(4)).await.status, 202);
    let other = post(rig.addr, &json!({ "id": uid(4), "kind": "bug", "message": "something else" })).await;
    assert_eq!(other.status, 409);
    assert_eq!(other.json(), json!({ "error": "conflict" }));
    rig.finish().await;
}

#[tokio::test]
async fn only_post_is_served_the_rest_get_405_with_allow_post() {
    let rig = boot(Setup::with(Arc::new(Fake::default()))).await;
    for method in ["GET", "PUT", "DELETE", "PATCH"] {
        let reply = call(rig.addr, method, Some("application/json"), b"{}").await;
        assert_eq!(reply.status, 405, "{method}");
        assert_eq!(reply.json(), json!({ "error": "method_not_allowed" }));
        assert!(reply.has("Allow: POST"));
        assert!(is_no_store_json(&reply));
        assert!(!reply.has("Connection: close"));
    }
    let head = call(rig.addr, "HEAD", None, b"").await;
    assert_eq!((head.status, head.body.as_str()), (405, ""));
    assert!(head.has("Allow: POST"));
    assert_eq!(rig.stored(), 0);
    rig.finish().await;
}

#[tokio::test]
async fn the_content_type_must_be_application_json_else_415_and_the_connection_closes() {
    let rig = boot(Setup::with(Arc::new(Fake::default()))).await;
    let text = valid(5).to_string();
    for kind in ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data", "application/jsonp"] {
        let reply = call(rig.addr, "POST", Some(kind), text.as_bytes()).await;
        assert_eq!(reply.status, 415, "{kind}");
        assert_eq!(reply.json(), json!({ "error": "unsupported_media_type" }));
        assert!(reply.has("Connection: close"), "{kind}: {reply:?}");
        assert!(reply.closed, "{kind}");
    }
    assert_eq!(call(rig.addr, "POST", None, text.as_bytes()).await.status, 415);
    assert_eq!(rig.stored(), 0);
    let reply = call(rig.addr, "POST", Some("Application/JSON; charset=utf-8"), text.as_bytes()).await;
    assert_eq!(reply.status, 202, "{reply:?}");
    rig.finish().await;
}

#[tokio::test]
async fn the_rate_limits_are_per_address_and_global_and_answer_429() {
    let rig = boot(Setup::with(Arc::new(Fake::default())).limits(1, 1000)).await;
    assert_eq!(post(rig.addr, &valid(6)).await.status, 202);
    let limited = post(rig.addr, &valid(7)).await;
    assert_eq!(limited.status, 429);
    assert_eq!(limited.json(), json!({ "error": "rate_limited" }));
    assert!(is_no_store_json(&limited));
    assert!(!limited.has("Connection: close"));
    rig.finish().await;

    let rig = boot(Setup::with(Arc::new(Fake::default())).limits(100, 2)).await;
    assert_eq!(post(rig.addr, &valid(8)).await.status, 202);
    assert_eq!(post(rig.addr, &valid(9)).await.status, 202);
    assert_eq!(post(rig.addr, &valid(10)).await.status, 429);
    rig.finish().await;
}

#[tokio::test]
async fn a_declared_body_over_the_cap_is_413_and_the_connection_closes() {
    let rig = boot(Setup::with(Arc::new(Fake::default()))).await;
    let mut stream = TcpStream::connect(rig.addr).await.unwrap();
    let headers = [("Content-Type", "application/json".to_owned()), ("Content-Length", (MAX_BODY_BYTES + 1).to_string())];
    stream.write_all(request_head("POST", &headers).as_bytes()).await.unwrap();
    stream.write_all(b"x").await.unwrap();
    let reply = read_reply(&mut stream).await;
    assert_eq!(reply.status, 413, "{reply:?}");
    assert_eq!(reply.json(), json!({ "error": "payload_too_large" }));
    assert!(reply.has("Connection: close") && reply.closed);
    assert_eq!(rig.stored(), 0);
    rig.finish().await;
}

#[tokio::test]
async fn a_body_that_grows_past_the_cap_is_413_and_one_at_the_cap_is_read() {
    let rig = boot(Setup::with(Arc::new(Fake::default()))).await;
    let mut stream = TcpStream::connect(rig.addr).await.unwrap();
    let headers = [("Content-Type", "application/json".to_owned()), ("Transfer-Encoding", "chunked".to_owned())];
    stream.write_all(request_head("POST", &headers).as_bytes()).await.unwrap();
    let piece = vec![b'x'; 64 * 1024];
    let mut sent = 0;
    while sent <= MAX_BODY_BYTES {
        let frame = [format!("{:x}\r\n", piece.len()).into_bytes(), piece.clone(), b"\r\n".to_vec()].concat();
        if stream.write_all(&frame).await.is_err() {
            break;
        }
        sent += piece.len();
    }
    let reply = read_reply(&mut stream).await;
    assert_eq!(reply.status, 413, "{reply:?}");
    assert_eq!(reply.json(), json!({ "error": "payload_too_large" }));
    assert!(reply.has("Connection: close"));
    assert!(reply.closed);
    // A body of exactly the cap is read whole and refused only as feedback.
    let at_cap = call(rig.addr, "POST", Some("application/json"), &vec![b' '; MAX_BODY_BYTES]).await;
    assert_eq!(at_cap.status, 400, "{at_cap:?}");
    rig.finish().await;
}

#[tokio::test]
async fn a_body_that_does_not_arrive_in_time_is_408_and_the_connection_closes() {
    let rig = boot(Setup::with(Arc::new(Fake::default())).body_timeout(Duration::from_millis(200))).await;
    let mut stream = stalled(rig.addr).await;
    let reply = read_reply(&mut stream).await;
    assert_eq!(reply.status, 408, "{reply:?}");
    assert_eq!(reply.json(), json!({ "error": "request_timeout" }));
    assert!(reply.has("Connection: close") && reply.closed);
    assert_eq!(rig.stored(), 0);
    rig.finish().await;
}

#[tokio::test]
async fn a_fourth_body_read_at_once_is_503_busy_without_being_read_and_places_are_freed() {
    let rig = boot(Setup::with(Arc::new(Fake::default()))).await;
    let held = vec![stalled(rig.addr).await, stalled(rig.addr).await, stalled(rig.addr).await];
    let mut busy = None;
    for _ in 0..100 {
        // 400 until the three places are taken.
        let reply = post_text(rig.addr, "bad").await;
        if reply.status == 503 {
            busy = Some(reply);
            break;
        }
        mixdog_rt::time::sleep(Duration::from_millis(20)).await;
    }
    let busy = busy.expect("the read cap is reached");
    assert_eq!(busy.json(), json!({ "error": "feedback_busy" }));
    assert!(busy.has("Connection: close") && busy.closed);
    drop(held);
    let mut accepted = false;
    for _ in 0..100 {
        if post(rig.addr, &valid(11)).await.status == 202 {
            accepted = true;
            break;
        }
        mixdog_rt::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(accepted, "the places are released");
    rig.finish().await;
}

#[tokio::test]
async fn without_mail_a_post_is_503_unavailable_before_its_body_is_read_and_stores_nothing() {
    let dir = TempDir::new().unwrap();
    let io = mixdog_rt::testing::tokens().durability_io;
    let service = FeedbackService::start(dir.path(), io, None, FeedbackOptions::default()).await;
    let endpoint = Arc::new(FeedbackEndpoint::new(Some(service.clone())));
    let server = Server::start(0, None, Arc::new(Route(endpoint)), Limits::default()).await.unwrap();
    let addr = ([127, 0, 0, 1], server.port()).into();
    let mut stream = stalled(addr).await;
    let reply = read_reply(&mut stream).await;
    assert_eq!(reply.status, 503, "{reply:?}");
    assert_eq!(reply.json(), json!({ "error": "feedback_unavailable" }));
    assert!(reply.has("Connection: close") && reply.closed);
    assert_eq!(mixdog_fsio::read_dir(&Unlaned, dir.path().join("feedback")).unwrap().count(), 0);
    service.close().await;

    // A service that failed to build is the same.
    let missing = Arc::new(FeedbackEndpoint::new(None));
    let other = Server::start(0, None, Arc::new(Route(missing)), Limits::default()).await.unwrap();
    let reply = post(([127, 0, 0, 1], other.port()).into(), &valid(12)).await;
    assert_eq!((reply.status, reply.json()), (503, json!({ "error": "feedback_unavailable" })));
    other.terminate_connections();
    server.terminate_connections();
}

#[tokio::test]
async fn a_storage_that_cannot_hold_the_record_answers_503_unavailable() {
    let rig = boot(Setup::with(Arc::new(Fake::default()))).await;
    rig.service.faults().rename.store(true, Ordering::SeqCst);
    let reply = post(rig.addr, &valid(13)).await;
    assert_eq!(reply.status, 503, "{reply:?}");
    assert_eq!(reply.json(), json!({ "error": "feedback_unavailable" }));
    assert!(!reply.has("Connection: close"));
    assert_eq!(rig.stored(), 0);
    rig.service.faults().rename.store(false, Ordering::SeqCst);
    assert_eq!(post(rig.addr, &valid(13)).await.status, 202);
    rig.finish().await;
}

// ---- the real mailer against a scripted SMTP server ----

#[derive(Default)]
struct Mailbox {
    messages: Mutex<Vec<String>>,
    commands: Mutex<Vec<String>>,
}

struct Smtp {
    port: u16,
    root: Vec<u8>,
    seen: Arc<Mailbox>,
}

/// An SMTP server over implicit TLS that accepts a message, or refuses the login with `auth_reply`.
async fn smtp(auth_reply: &'static str) -> Smtp {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let issued = rcgen::generate_simple_self_signed(vec!["localhost".to_owned()]).unwrap();
    let certificate = issued.cert.der().clone();
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(issued.signing_key.serialize_der()));
    let config = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![certificate.clone()], key)
        .unwrap();
    let acceptor = TlsAcceptor::from(Arc::new(config));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Mailbox::default());
    let shared = seen.clone();
    tokio::spawn(async move {
        while let Ok((tcp, _)) = listener.accept().await {
            let (acceptor, seen) = (acceptor.clone(), shared.clone());
            tokio::spawn(async move {
                let Ok(stream) = acceptor.accept(tcp).await else { return };
                smtp_session(BufReader::new(stream), auth_reply, seen).await;
            });
        }
    });
    Smtp { port, root: certificate.to_vec(), seen }
}

async fn smtp_session<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(mut io: BufReader<S>, auth_reply: &str, seen: Arc<Mailbox>) {
    async fn say<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(io: &mut BufReader<S>, text: &str) {
        let _ = io.get_mut().write_all(format!("{text}\r\n").as_bytes()).await;
        let _ = io.get_mut().flush().await;
    }
    say(&mut io, "220 mail.test ESMTP ready").await;
    loop {
        let mut line = String::new();
        if io.read_line(&mut line).await.unwrap_or(0) == 0 {
            return;
        }
        let line = line.trim_end().to_owned();
        seen.commands.lock().unwrap().push(line.clone());
        let verb = line.split(' ').next().unwrap_or("").to_ascii_uppercase();
        match verb.as_str() {
            "EHLO" => say(&mut io, "250-mail.test greets you\r\n250 AUTH PLAIN LOGIN").await,
            "AUTH" => say(&mut io, auth_reply).await,
            "MAIL" => say(&mut io, "250 2.1.0 Ok").await,
            "RCPT" => say(&mut io, "250 2.1.5 Ok").await,
            "DATA" => {
                say(&mut io, "354 End data with <CR><LF>.<CR><LF>").await;
                let mut message = String::new();
                loop {
                    let mut part = String::new();
                    if io.read_line(&mut part).await.unwrap_or(0) == 0 {
                        return;
                    }
                    if part == ".\r\n" {
                        break;
                    }
                    message.push_str(&part);
                }
                seen.messages.lock().unwrap().push(message);
                say(&mut io, "250 2.0.0 Ok: queued").await;
            }
            "QUIT" => {
                say(&mut io, "221 2.0.0 Bye").await;
                return;
            }
            _ => say(&mut io, "500 5.5.2 command not recognized").await,
        }
    }
}

fn mailer(server: &Smtp) -> Mailer {
    let mut config = MailConfig::new("localhost", server.port, "bot@example.com", "s3cret");
    config.secure = true;
    config.timeout = Duration::from_secs(10);
    Mailer::new(config, "support@mixdog.ai".to_owned()).trusting(vec![server.root.clone()])
}

async fn wait_until(what: &str, mut condition: impl FnMut() -> bool) {
    for _ in 0..250 {
        if condition() {
            return;
        }
        mixdog_rt::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("timed out waiting for {what}");
}

#[tokio::test]
async fn a_post_is_mailed_through_smtp_with_the_headers_and_attachments_of_the_record() {
    let server = smtp("235 2.7.0 Authentication successful").await;
    let mailer = mailer(&server);
    let options = mailer.options(FeedbackOptions { ip_limit: 1000, global_limit: 10_000, ..FeedbackOptions::default() });
    let dir = TempDir::new().unwrap();
    let io = mixdog_rt::testing::tokens().durability_io;
    let service = FeedbackService::start(dir.path(), io, Some(Arc::new(mailer) as Arc<dyn FeedbackSender>), options).await;
    let endpoint = Arc::new(FeedbackEndpoint::new(Some(service.clone())));
    let http = Server::start(0, None, Arc::new(Route(endpoint)), Limits::default()).await.unwrap();
    let addr = ([127, 0, 0, 1], http.port()).into();

    let mut png = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    png.extend_from_slice(&[7u8; 56]);
    let body = json!({
        "id": uid(20), "kind": "suggestion", "message": "please add it", "replyTo": "me@example.org",
        "attachments": [{ "name": "shot.png", "mimeType": "image/png", "data": STANDARD.encode(&png) }],
    });
    let reply = post(addr, &body).await;
    assert_eq!(reply.status, 202, "{reply:?}");
    wait_until("the message reaches the server", || !server.seen.messages.lock().unwrap().is_empty()).await;
    let message = server.seen.messages.lock().unwrap()[0].clone();
    assert!(message.contains(&format!("Subject: [Mixdog feedback] suggestion {}\r\n", uid(20))), "{message}");
    assert!(message.contains("\r\nFrom: bot@example.com\r\n") || message.starts_with("From: bot@example.com\r\n"), "{message}");
    assert!(message.contains("To: support@mixdog.ai\r\n"), "{message}");
    assert!(message.contains("Reply-To: me@example.org\r\n"), "{message}");
    assert!(message.contains(&format!("Message-ID: <{}@feedback.mixdog>\r\n", uid(20))), "{message}");
    assert!(message.contains("Content-Disposition: attachment; filename=shot.png"), "{message}");
    assert!(message.contains("Content-Type: image/png"), "{message}");
    assert!(message.contains(&STANDARD.encode(&png)[..40]), "{message}");
    let commands = server.seen.commands.lock().unwrap().clone();
    assert!(commands.contains(&"MAIL FROM:<bot@example.com>".to_owned()), "{commands:?}");
    assert!(commands.contains(&"RCPT TO:<support@mixdog.ai>".to_owned()), "{commands:?}");
    service.close().await;
    http.terminate_connections();
}

#[tokio::test]
async fn a_refused_login_is_logged_by_its_code_only_and_the_post_is_still_accepted() {
    let server = smtp("535 5.7.8 Authentication failed").await;
    let mailer = mailer(&server);
    let lines = Lines::default();
    let options = mailer.options(FeedbackOptions { log: lines.sink(), ..FeedbackOptions::default() });
    let dir = TempDir::new().unwrap();
    let io = mixdog_rt::testing::tokens().durability_io;
    let service = FeedbackService::start(dir.path(), io, Some(Arc::new(mailer) as Arc<dyn FeedbackSender>), options).await;
    let endpoint = Arc::new(FeedbackEndpoint::new(Some(service.clone())));
    let http = Server::start(0, None, Arc::new(Route(endpoint)), Limits::default()).await.unwrap();
    let addr = ([127, 0, 0, 1], http.port()).into();
    assert_eq!(post(addr, &valid(21)).await.status, 202);
    wait_until("the failure is logged", || !lines.all().is_empty()).await;
    assert_eq!(lines.all()[0], format!("[relay] feedback send failed id={} code=EAUTH", uid(21)));
    assert!(server.seen.messages.lock().unwrap().is_empty());
    assert_eq!(mixdog_fsio::read_dir(&Unlaned, dir.path().join("feedback")).unwrap().count(), 1);
    service.close().await;
    http.terminate_connections();
}
