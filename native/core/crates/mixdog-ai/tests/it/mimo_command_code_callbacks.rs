//! What the loopback callback of the MiMo and the Command Code sign-ins answers a browser, and which request ends the
//! login. Node 1.4.5: `mimo-oauth-login.mjs` (`onRequest`, `resultRedirect`) and `command-code-oauth-login.mjs`
//! (`handleRequest`, `reply`, `CORS_HEADERS`). The requests are made to the real loopback server of the real login flow
//! over a scripted token side; every expected status, header and body below is Node's literal answer.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_ai::accounts::AccountStore;
use mixdog_ai::oauth::CredentialFile;
use mixdog_ai::oauth::CredentialIo;
use mixdog_ai::providers::compat::login::command_code::CommandCodeLogin;
use mixdog_ai::providers::compat::login::mimo::MimoLogin;
use mixdog_ai::transport::BodyStream;
use mixdog_ai::transport::Exchange;
use mixdog_ai::transport::HttpResponse;
use mixdog_ai::transport::HttpSend;
use mixdog_core_api::domain::login::LoginFlow;
use mixdog_core_api::domain::login::LoginSession;
use mixdog_core_api::domain::login::LoginState;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::WireRequest;
use serde_json::Value;
use serde_json::json;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;

struct OneChunk(Option<Bytes>);

#[async_trait]
impl BodyStream for OneChunk {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        self.0.take().map(Ok)
    }
}

/// The token side: each scripted `(status, body)` once, in order, for whatever request is made.
struct Script(Mutex<VecDeque<(u16, &'static str)>>);

impl Script {
    fn new(answers: &[(u16, &'static str)]) -> Arc<Self> {
        Arc::new(Self(Mutex::new(answers.iter().copied().collect())))
    }
}

#[async_trait]
impl HttpSend for Script {
    async fn send(&self, _: WireRequest, _: Exchange) -> Result<HttpResponse, ProviderError> {
        let (status, body) = self.0.lock().unwrap().pop_front().expect("the login made a request the test did not script");
        Ok(HttpResponse { status, headers: Vec::new(), body: Box::new(OneChunk(Some(Bytes::from(body)))) })
    }
}

struct Answer {
    status: String,
    headers: Vec<(String, String)>,
    body: String,
}

impl Answer {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

async fn exchange(port: u16, request: &str) -> Answer {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes).await.unwrap();
    let text = String::from_utf8(bytes).unwrap();
    let (head, body) = text.split_once("\r\n\r\n").expect("a complete head");
    let mut lines = head.split("\r\n");
    let status = lines.next().unwrap().to_owned();
    let headers = lines.map(|l| l.split_once(':').unwrap()).map(|(k, v)| (k.trim().to_owned(), v.trim().to_owned())).collect();
    // Node frames an answer with a body in chunks; the body bytes are what a browser reads.
    let body = if head.to_ascii_lowercase().contains("transfer-encoding: chunked") { unchunked(body) } else { body.to_owned() };
    Answer { status, headers, body }
}

fn unchunked(mut rest: &str) -> String {
    let mut out = String::new();
    while let Some((size, tail)) = rest.split_once("\r\n") {
        let size = usize::from_str_radix(size.trim(), 16).unwrap();
        if size == 0 {
            break;
        }
        out.push_str(&tail[..size]);
        rest = &tail[size + 2..];
    }
    out
}

async fn terminal(session: &dyn LoginSession) -> LoginState {
    loop {
        match session.next().await {
            Some(state) if state.is_terminal() => return state,
            Some(_) => {}
            None => return session.state(),
        }
    }
}

async fn authorize(session: &dyn LoginSession) -> String {
    loop {
        if let Some(LoginState::Authorize { url, .. }) = session.next().await {
            return url;
        }
    }
}

fn query(url: &str) -> std::collections::HashMap<String, String> {
    url::Url::parse(url).unwrap().query_pairs().into_owned().collect()
}

fn credential(dir: &std::path::Path, name: &str) -> CredentialFile {
    let tokens = mixdog_rt::testing::tokens();
    CredentialFile::new(dir.join(name), CredentialIo { read: tokens.interactive_io, write: tokens.durability_io })
}

/// The platform's side of MiMo: `doc` sealed to the public key of the authorize URL (X25519, SHA-256 of the shared
/// secret as the AES-256-GCM key; payload = ephemeral public key, nonce, ciphertext; base64url).
fn seal(authorize_url: &str, doc: &Value) -> String {
    use aes_gcm::Aes256Gcm;
    use aes_gcm::Nonce;
    use aes_gcm::aead::Aead;
    use aes_gcm::aead::KeyInit;
    use base64::Engine as _;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use sha2::Digest;
    use sha2::Sha256;
    use x25519_dalek::PublicKey;
    use x25519_dalek::StaticSecret;

    let pk = query(authorize_url)["pk"].clone();
    let der = URL_SAFE_NO_PAD.decode(pk).unwrap();
    let public: [u8; 32] = der[12..].try_into().unwrap();
    let ephemeral = StaticSecret::from([9u8; 32]);
    let shared = ephemeral.diffie_hellman(&PublicKey::from(public));
    let cipher = Aes256Gcm::new_from_slice(&Sha256::digest(shared.as_bytes())).unwrap();
    let sealed = cipher.encrypt(Nonce::from_slice(&[4u8; 12]), doc.to_string().as_bytes()).unwrap();
    let mut payload = PublicKey::from(&ephemeral).as_bytes().to_vec();
    payload.extend_from_slice(&[4u8; 12]);
    payload.extend_from_slice(&sealed);
    URL_SAFE_NO_PAD.encode(payload)
}

async fn mimo_get(port: u16, target: &str) -> Answer {
    exchange(port, &format!("GET {target} HTTP/1.1\r\nHost: localhost:{port}\r\nConnection: close\r\n\r\n")).await
}

async fn mimo_started(http: Arc<Script>, dir: &std::path::Path) -> (Box<dyn LoginSession>, String, u16) {
    let flow = MimoLogin::new(http, credential(dir, "mimo-oauth.json"), credential(dir, "mimo-oauth-key-name.json"));
    let session = flow.start().await.unwrap();
    let url = authorize(session.as_ref()).await;
    let port = url::Url::parse(&query(&url)["redirect_uri"]).unwrap().port().unwrap();
    (session, url, port)
}

#[tokio::test]
async fn the_mimo_callback_answers_each_request_as_node_does_and_a_sealed_key_ends_the_login_on_the_platforms_success_page() {
    let dir = tempfile::tempdir().unwrap();
    let (session, url, port) = mimo_started(Script::new(&[]), dir.path()).await;

    // Not the callback path, or no payload at all: an empty 404, and the login waits on.
    for target in ["/other?u=abc", "/", "/?u="] {
        let answer = mimo_get(port, target).await;
        assert_eq!((answer.status.as_str(), answer.body.as_str()), ("HTTP/1.1 404 Not Found", ""), "{target}");
    }
    // A payload that is not sealed to this login's key.
    let refused = mimo_get(port, "/?u=AAAA").await;
    assert_eq!(refused.status, "HTTP/1.1 400 Bad Request");
    assert_eq!(refused.header("content-type"), Some("text/plain; charset=utf-8"));
    assert_eq!(refused.body, "Invalid authorization payload");

    let sealed = seal(&url, &json!({"sk": "sk-live", "uid": 7}));
    let done = mimo_get(port, &format!("/?u={sealed}")).await;
    assert_eq!(done.status, "HTTP/1.1 302 Found");
    assert_eq!(done.header("location"), Some("https://platform.xiaomimimo.com/authorize/callback?status=success"));
    assert_eq!(done.body, "");
    assert_eq!(terminal(session.as_ref()).await, LoginState::Done { account: Some("7".into()) });
    // The server went with the login.
    assert_eq!(TcpStream::connect(("127.0.0.1", port)).await.unwrap_err().kind(), std::io::ErrorKind::ConnectionRefused);
}

#[tokio::test]
async fn a_mimo_key_the_regions_reject_redirects_to_the_platforms_error_page_with_the_reason_and_ends_the_login() {
    let dir = tempfile::tempdir().unwrap();
    // A Token Plan key without a gateway is probed region by region; every region answers 401.
    let (session, url, port) = mimo_started(Script::new(&[(401, "bad"), (401, "bad"), (401, "bad")]), dir.path()).await;
    let sealed = seal(&url, &json!({"sk": "tp-abc"}));
    let answer = mimo_get(port, &format!("/?u={sealed}")).await;
    assert_eq!(answer.status, "HTTP/1.1 302 Found");
    let location = url::Url::parse(answer.header("location").unwrap()).unwrap();
    assert_eq!(format!("{}://{}{}", location.scheme(), location.host_str().unwrap(), location.path()), "https://platform.xiaomimimo.com/authorize/callback");
    let pairs: Vec<(String, String)> = location.query_pairs().into_owned().collect();
    assert_eq!(
        pairs,
        [
            ("status".to_owned(), "error".to_owned()),
            ("message".to_owned(), "[mimo-oauth] API key rejected (401) \u{2014} open /providers in mixdog to sign in again: bad".to_owned()),
        ]
    );
    assert!(matches!(terminal(session.as_ref()).await, LoginState::Failed(_)));
}

const STUDIO: &str = "https://commandcode.ai";
const WHOAMI: &str = r#"{"user":{"id":"U1","userName":"ann"}}"#;

struct Studio {
    session: Box<dyn LoginSession>,
    port: u16,
    state: String,
}

async fn studio_started(http: Arc<Script>, dir: &std::path::Path) -> Studio {
    let tokens = mixdog_rt::testing::tokens();
    let accounts = AccountStore::new(dir.to_path_buf(), CredentialIo { read: tokens.interactive_io, write: tokens.durability_io });
    let flow = CommandCodeLogin::new(http, credential(dir, "command-code-oauth.json"), credential(dir, "cli-auth.json"), accounts);
    let session = flow.start().await.unwrap();
    let url = authorize(session.as_ref()).await;
    let query = query(&url);
    let port = url::Url::parse(&query["callback"]).unwrap().port().unwrap();
    Studio { session, port, state: query["state"].clone() }
}

impl Studio {
    async fn send(&self, method: &str, target: &str, origin: Option<&str>, body: &str) -> Answer {
        let origin = origin.map(|o| format!("Origin: {o}\r\n")).unwrap_or_default();
        let request = format!(
            "{method} {target} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n{origin}Content-Length: {}\r\n\r\n{body}",
            self.port,
            body.len()
        );
        exchange(self.port, &request).await
    }

    fn callback(&self, key: &str) -> String {
        json!({"state": self.state, "apiKey": key, "userId": "x", "userName": "n", "keyName": "k"}).to_string()
    }
}

/// `CORS_HEADERS`: every reply of the Command Code callback carries these, whatever its status.
fn assert_cors(answer: &Answer, context: &str) {
    for (name, value) in [
        ("access-control-allow-origin", STUDIO),
        ("access-control-allow-methods", "POST, OPTIONS"),
        ("access-control-allow-headers", "Content-Type"),
        ("access-control-allow-private-network", "true"),
        ("vary", "Origin"),
    ] {
        assert_eq!(answer.header(name), Some(value), "{context}: {name}");
    }
}

fn assert_json(answer: &Answer, status: &str, body: &Value, context: &str) {
    assert_eq!(answer.status, status, "{context}");
    assert_eq!(answer.header("content-type"), Some("application/json"), "{context}");
    assert_eq!(serde_json::from_str::<Value>(&answer.body).unwrap(), *body, "{context}");
    // `JSON.stringify` writes the fields in this order, with no spaces.
    assert_eq!(answer.body, body.to_string(), "{context}: bytes");
    assert_cors(answer, context);
}

#[tokio::test]
async fn the_command_code_callback_refuses_each_wrong_request_in_nodes_words_and_keeps_waiting_until_the_key_is_accepted() {
    let dir = tempfile::tempdir().unwrap();
    let studio = studio_started(Script::new(&[(200, WHOAMI)]), dir.path()).await;

    // A preflight: no body, the CORS headers only.
    let preflight = studio.send("OPTIONS", "/callback", Some(STUDIO), "").await;
    assert_eq!((preflight.status.as_str(), preflight.body.as_str(), preflight.header("content-type")), ("HTTP/1.1 204 No Content", "", None));
    assert_cors(&preflight, "preflight");

    let forbidden = studio.send("POST", "/callback", Some("https://evil.example"), &studio.callback("key-1")).await;
    assert_json(&forbidden, "HTTP/1.1 403 Forbidden", &json!({"success": false, "error": "Forbidden origin"}), "foreign origin");
    // The origin is checked before the method: a foreign preflight is refused too.
    let foreign_preflight = studio.send("OPTIONS", "/callback", Some("https://evil.example"), "").await;
    assert_eq!(foreign_preflight.status, "HTTP/1.1 403 Forbidden");

    let elsewhere = studio.send("POST", "/other", Some(STUDIO), &studio.callback("key-1")).await;
    assert_json(&elsewhere, "HTTP/1.1 404 Not Found", &json!({"success": false, "error": "Not found"}), "other path");
    let get = studio.send("GET", "/callback", Some(STUDIO), "").await;
    assert_json(&get, "HTTP/1.1 405 Method Not Allowed", &json!({"success": false, "error": "Method not allowed"}), "GET");

    let not_json = studio.send("POST", "/callback", Some(STUDIO), "not json").await;
    assert_json(&not_json, "HTTP/1.1 400 Bad Request", &json!({"success": false, "error": "Invalid JSON body"}), "not JSON");
    let wrong = |error: &str| json!({"success": false, "error": error});
    let array = studio.send("POST", "/callback", Some(STUDIO), "[1]").await;
    assert_json(&array, "HTTP/1.1 400 Bad Request", &wrong("callback body must be an object"), "array");
    let other_state = studio.send("POST", "/callback", Some(STUDIO), &json!({"state": "other", "apiKey": "key-1"}).to_string()).await;
    assert_json(&other_state, "HTTP/1.1 400 Bad Request", &wrong("callback state mismatch"), "state");
    let missing = json!({"state": studio.state, "apiKey": "key-1", "userId": "x", "userName": "  ", "keyName": "k"}).to_string();
    assert_json(&studio.send("POST", "/callback", Some(STUDIO), &missing).await, "HTTP/1.1 400 Bad Request", &wrong("callback is missing userName"), "blank field");
    let malformed = studio.send("POST", "/callback", Some(STUDIO), &studio.callback("has space")).await;
    assert_json(&malformed, "HTTP/1.1 400 Bad Request", &wrong("callback carried a malformed API key"), "key");

    // None of that ended the login; a request without an Origin (a non-browser client) is let through.
    let accepted = studio.send("POST", "/callback", None, &studio.callback("key-1")).await;
    assert_json(&accepted, "HTTP/1.1 200 OK", &json!({"success": true}), "accepted");
    assert_eq!(terminal(studio.session.as_ref()).await, LoginState::Done { account: Some("U1".into()) });
    assert_eq!(TcpStream::connect(("127.0.0.1", studio.port)).await.unwrap_err().kind(), std::io::ErrorKind::ConnectionRefused);
}

#[tokio::test]
async fn a_key_the_identity_check_refuses_is_answered_400_and_ends_the_command_code_login_failed() {
    let dir = tempfile::tempdir().unwrap();
    let studio = studio_started(Script::new(&[(401, "")]), dir.path()).await;
    let refused = studio.send("POST", "/callback", Some(STUDIO), &studio.callback("key-1")).await;
    assert_json(&refused, "HTTP/1.1 400 Bad Request", &json!({"success": false, "error": "API key validation failed"}), "refused key");
    assert!(matches!(terminal(studio.session.as_ref()).await, LoginState::Failed(_)));
}
