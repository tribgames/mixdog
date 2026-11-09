//! What the user's browser is shown by the loopback callback of every PKCE login, against Node's own callback servers
//! (`fixtures/oauth-callback-page/golden.json`, `record-oauth-callback-page.mjs`): each recorded case starts the
//! provider's real login over a scripted token endpoint (the answers Node was served), makes the recorded requests
//! to its callback server and compares each complete answer (status line, headers, body) or refusal to connect. The
//! login's end must agree with Node's too: it ended after the last request, and not before it.

#![allow(clippy::disallowed_methods, reason = "test-only: reads a recorded fixture synchronously")]

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_ai::oauth::AuthorizeRequest;
use mixdog_ai::oauth::CallbackPages;
use mixdog_ai::oauth::CredentialFile;
use mixdog_ai::oauth::CredentialIo;
use mixdog_ai::oauth::PkceLoginFlow;
use mixdog_ai::oauth::PkceProvider;
use mixdog_ai::oauth::Redirect;
use mixdog_ai::oauth::Refusal;
use mixdog_ai::providers::anthropic::oauth::AnthropicLogin;
use mixdog_ai::providers::devin::login::DevinLogin;
use mixdog_ai::providers::google::auth::antigravity::AntigravityLogin;
use mixdog_ai::providers::google::auth::antigravity::FileTokenStore;
use mixdog_ai::providers::google::auth::antigravity::Pause;
use mixdog_ai::providers::grok::auth::GrokLogin;
use mixdog_ai::providers::openai::login::OpenAiLogin;
use mixdog_ai::transport::BodyStream;
use mixdog_ai::transport::Exchange;
use mixdog_ai::transport::HttpResponse;
use mixdog_ai::transport::HttpSend;
use mixdog_core_api::domain::login::LoginFlow;
use mixdog_core_api::domain::login::LoginSession;
use mixdog_core_api::domain::login::LoginState;
use mixdog_core_api::domain::login::LoginTarget;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::WireRequest;
use serde_json::Value;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;

const GOLDEN: &str = include_str!("../../../../fixtures/oauth-callback-page/golden.json");
/// Recorded cases per provider; the golden lists the providers one after the other.
const PER_PROVIDER: usize = 23;

struct OneChunk(Option<Bytes>);

#[async_trait]
impl BodyStream for OneChunk {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        self.0.take().map(Ok)
    }
}

/// The token endpoint (and, for Antigravity, the account lookups) as Node was served: each recorded answer once, in order,
/// for the very method and URL Node requested.
struct Served(Mutex<VecDeque<Value>>);

#[async_trait]
impl HttpSend for Served {
    async fn send(&self, request: WireRequest, _exchange: Exchange) -> Result<HttpResponse, ProviderError> {
        let answer = self.0.lock().unwrap().pop_front().expect("the recording has no further request");
        assert_eq!((request.method.as_str(), request.url.as_str()), (answer["method"].as_str().unwrap(), answer["url"].as_str().unwrap()));
        if let Some(threw) = answer.get("threw") {
            // The transport's typed reading of what Node's `fetch` threw (`TimeoutError`; a reset connection; any other).
            let fault = match threw["cause"]["code"].as_str() {
                Some("ECONNRESET") => TransportFault::Reset,
                _ => TransportFault::Io { os_code: None },
            };
            let mut error = ProviderError::transport(fault, DeliveryState::Ambiguous);
            error.timed_out = threw["name"] == "TimeoutError";
            return Err(error);
        }
        Ok(HttpResponse {
            status: u16::try_from(answer["status"].as_u64().unwrap()).unwrap(),
            headers: Vec::new(),
            body: Box::new(OneChunk(Some(Bytes::from(answer["body"].as_str().unwrap().to_owned())))),
        })
    }
}

struct NoPause;

#[async_trait]
impl Pause for NoPause {
    async fn pause(&self, _: std::time::Duration) {}
}

/// The provider on a free port: the registered port is taken by whoever runs the real login on this machine.
struct FreePort(Arc<dyn PkceProvider>);

#[async_trait]
impl PkceProvider for FreePort {
    fn redirect(&self) -> Redirect {
        let own = self.0.redirect();
        Redirect { host: own.host, port: 0, path: own.path }
    }
    fn verifier_bytes(&self) -> usize {
        self.0.verifier_bytes()
    }
    fn authorize_url(&self, request: &AuthorizeRequest<'_>) -> String {
        self.0.authorize_url(request)
    }
    fn callback_pages(&self) -> CallbackPages {
        self.0.callback_pages()
    }
    async fn exchange_checked(&self, code: &str, verifier: &str, redirect_uri: &str) -> Result<Option<String>, Refusal> {
        self.0.exchange_checked(code, verifier, redirect_uri).await
    }
}

fn provider(name: &str, http: Arc<dyn HttpSend>, dir: &std::path::Path) -> Arc<dyn PkceProvider> {
    let tokens = mixdog_rt::testing::tokens();
    let file = CredentialFile::new(dir.join(format!("{name}.json")), CredentialIo { read: tokens.interactive_io, write: tokens.durability_io });
    let inner: Arc<dyn PkceProvider> = match name {
        "openai" => Arc::new(OpenAiLogin::new(file, http)),
        "anthropic" => Arc::new(AnthropicLogin::new(file, http)),
        "grok" => Arc::new(
            GrokLogin::new(http, file, "https://auth.x.ai/oauth2/authorize", "https://auth.x.ai/oauth2/token").expect("trusted endpoints"),
        ),
        "devin" => Arc::new(DevinLogin::new(file, http)),
        "antigravity" => Arc::new(AntigravityLogin {
            http,
            store: Arc::new(FileTokenStore(file)),
            client_version: "1.0.0".to_owned(),
            pause: Arc::new(NoPause),
            now_ms: Box::new(|| 0),
        }),
        other => panic!("unknown provider {other}"),
    };
    Arc::new(FreePort(inner))
}

/// One request as a raw client sends it, and the complete answer (or why there is none).
async fn exchange(port: u16, request: &str) -> Result<Vec<u8>, std::io::ErrorKind> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.map_err(|error| error.kind())?;
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut answer = Vec::new();
    stream.read_to_end(&mut answer).await.map_err(|error| error.kind())?;
    Ok(answer)
}

/// `[statusLine, headers, body]` of an answer as the recorder reads it: header names lowercase, `Date` left out,
/// and the framing (`Content-Length` here, `Transfer-Encoding: chunked` in Node's) replaced by the body itself.
fn read_answer(bytes: &[u8]) -> (String, Vec<(String, String)>, String) {
    let split = bytes.windows(4).position(|window| window == b"\r\n\r\n").expect("a complete head");
    let head = String::from_utf8(bytes[..split].to_vec()).unwrap();
    let body = &bytes[split + 4..];
    let mut lines = head.split("\r\n");
    let status = lines.next().unwrap().to_owned();
    let mut headers: Vec<(String, String)> = lines
        .map(|line| {
            let (name, value) = line.split_once(':').unwrap();
            (name.to_ascii_lowercase(), value.trim().to_owned())
        })
        .filter(|(name, _)| name != "date")
        .collect();
    if let Some(length) = headers.iter().find(|(name, _)| name == "content-length") {
        assert_eq!(length.1, body.len().to_string(), "the declared length is the body's");
    }
    headers.retain(|(name, _)| name != "content-length" && name != "transfer-encoding");
    headers.sort();
    (status, headers, String::from_utf8(body.to_vec()).unwrap())
}

fn assert_answer(got: &[u8], recorded: &Value, context: &str) {
    let (status, headers, body) = read_answer(got);
    assert_eq!(status, recorded["statusLine"].as_str().unwrap(), "{context}: status");
    let mut want: Vec<(String, String)> = recorded["headers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|pair| (pair[0].as_str().unwrap().to_owned(), pair[1].as_str().unwrap().to_owned()))
        .filter(|(name, _)| name != "transfer-encoding" && name != "content-length")
        .collect();
    want.sort();
    assert_eq!(headers, want, "{context}: headers");
    assert_eq!(body, recorded["body"].as_str().unwrap(), "{context}: body");
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

async fn replay(case: &Value) {
    let name = case["provider"].as_str().unwrap();
    let title = case["title"].as_str().unwrap();
    let http = Arc::new(Served(Mutex::new(case["served"].as_array().unwrap().iter().cloned().collect())));
    let dir = tempfile::tempdir().unwrap();
    let flow = PkceLoginFlow::new(LoginTarget::Provider(name.into()), provider(name, http.clone(), dir.path()));
    let session = flow.start().await.unwrap();
    let LoginState::Authorize { url, .. } = session.next().await.unwrap() else { panic!("{name} {title}: the authorize URL comes first") };
    let query: std::collections::HashMap<String, String> = url::Url::parse(&url).unwrap().query_pairs().into_owned().collect();
    let redirect = url::Url::parse(&query["redirect_uri"]).unwrap();
    let (host, port) = (redirect.host_str().unwrap().to_owned(), redirect.port().unwrap());
    for step in case["answers"].as_array().unwrap() {
        let target = step["target"].as_str().unwrap().replace("{path}", case["path"].as_str().unwrap()).replace("{state}", &query["state"]);
        let host_header = step["hostHeader"].as_str().map_or(format!("{host}:{port}"), str::to_owned);
        let request = format!("{} {target} HTTP/1.1\r\nHost: {host_header}\r\nConnection: close\r\n\r\n", step["method"].as_str().unwrap());
        let recorded = &step["answer"];
        if recorded.get("connection").is_some() {
            // Node's server was closed by the login's end; so is this one, once the login has reported it.
            terminal(session.as_ref()).await;
            assert_eq!(
                (exchange(port, &request).await, recorded["connection"].as_str().unwrap()),
                (Err(std::io::ErrorKind::ConnectionRefused), "ECONNREFUSED"),
                "{name} {title}: {target}"
            );
            continue;
        }
        let got = exchange(port, &request).await.unwrap_or_else(|kind| panic!("{name} {title}: {target}: {kind:?}"));
        assert_answer(&got, recorded, &format!("{name} {title}: {target}"));
    }
    let state = terminal(session.as_ref()).await;
    let settled = case["settled"].as_str().unwrap();
    match settled {
        "tokens" => assert!(matches!(state, LoginState::Done { .. }), "{name} {title}: Node's login resolved, got {state:?}"),
        "pending" => panic!("{name} {title}: a recorded case must end its login"),
        _ => assert!(matches!(state, LoginState::Failed(_)), "{name} {title}: Node's login ended without tokens ({settled}), got {state:?}"),
    }
    assert!(http.0.lock().unwrap().is_empty(), "{name} {title}: a request Node made to the token endpoint side was never made");
}

async fn provider_chunk(chunk: usize) {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let cases = golden["cases"].as_array().unwrap();
    for case in &cases[mixdog_rt::testing::chunk_range(cases.len(), chunk, PER_PROVIDER)] {
        replay(case).await;
    }
}

mixdog_rt::replay_chunks!(PROVIDER_TESTS, #[tokio::test] async provider_chunk; [
    the_callback_of_anthropic_answers_as_nodes = 0,
    the_callback_of_openai_answers_as_nodes = 1,
    the_callback_of_grok_answers_as_nodes = 2,
    the_callback_of_devin_answers_as_nodes = 3,
    the_callback_of_antigravity_answers_as_nodes = 4,
]);

#[test]
fn every_recorded_case_has_its_test() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let cases = golden["cases"].as_array().unwrap();
    mixdog_rt::testing::assert_chunks_registered(PROVIDER_TESTS, cases.len(), PER_PROVIDER);
    let providers = ["anthropic", "openai", "grok", "devin", "antigravity"];
    for (index, case) in cases.iter().enumerate() {
        assert_eq!(case["provider"], providers[index / PER_PROVIDER], "case {index} is in its provider's chunk");
    }
}

// --- MiMo and Command Code -------------------------------------------------------------------------------------------

const LOCAL: &str = include_str!("../../../../fixtures/oauth-callback-local/golden.json");

/// The platform's side of MiMo: `doc` sealed to the public key of the authorize URL.
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

    let url = url::Url::parse(authorize_url).unwrap();
    let pk = url.query_pairs().find(|(k, _)| k == "pk").unwrap().1.into_owned();
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

/// Starts `flow` and returns the session with its authorize URL and the port its callback is on.
async fn started(flow: &dyn LoginFlow, callback_param: &str) -> (Box<dyn LoginSession>, String, u16) {
    let session = flow.start().await.unwrap();
    let LoginState::Authorize { url, .. } = session.next().await.unwrap() else { panic!("the authorize URL comes first") };
    let query: std::collections::HashMap<String, String> = url::Url::parse(&url).unwrap().query_pairs().into_owned().collect();
    let port = url::Url::parse(&query[callback_param]).unwrap().port().unwrap();
    (session, url, port)
}

/// Makes the recorded request, or checks the server is gone; compares the answer.
async fn check_step(session: &dyn LoginSession, port: u16, request: &str, recorded: &Value, context: &str) {
    if recorded.get("connection").is_some() {
        terminal(session).await;
        assert_eq!(
            (exchange(port, request).await, recorded["connection"].as_str().unwrap()),
            (Err(std::io::ErrorKind::ConnectionRefused), "ECONNREFUSED"),
            "{context}"
        );
        return;
    }
    let got = exchange(port, request).await.unwrap_or_else(|kind| panic!("{context}: {kind:?}"));
    assert_answer(&got, recorded, context);
}

async fn check_end(session: &dyn LoginSession, case: &Value, served: &Served, context: &str) {
    let state = terminal(session).await;
    let settled = case["settled"].as_str().unwrap();
    match settled {
        "tokens" => assert!(matches!(state, LoginState::Done { .. }), "{context}: Node's login resolved, got {state:?}"),
        _ => assert!(matches!(state, LoginState::Failed(_)), "{context}: Node's login ended without tokens ({settled}), got {state:?}"),
    }
    assert!(served.0.lock().unwrap().is_empty(), "{context}: a recorded request was never made");
}

fn credential(dir: &std::path::Path, name: &str) -> CredentialFile {
    let tokens = mixdog_rt::testing::tokens();
    CredentialFile::new(dir.join(name), CredentialIo { read: tokens.interactive_io, write: tokens.durability_io })
}

#[tokio::test]
async fn the_mimo_callback_answers_as_nodes() {
    use mixdog_ai::providers::compat::login::mimo::MimoLogin;
    use mixdog_ai::providers::compat::login::mimo::key_name_path;

    let golden: Value = serde_json::from_str(LOCAL).unwrap();
    for case in golden["mimo"].as_array().unwrap() {
        let title = case["title"].as_str().unwrap();
        let served = Arc::new(Served(Mutex::new(case["served"].as_array().unwrap().iter().cloned().collect())));
        let dir = tempfile::tempdir().unwrap();
        let flow = MimoLogin::new(served.clone(), credential(dir.path(), "mimo-oauth.json"), credential(dir.path(), "mimo-oauth-key-name.json"));
        assert_eq!(key_name_path(dir.path()), dir.path().join("mimo-oauth-key-name.json"));
        let (session, url, port) = started(&flow, "redirect_uri").await;
        let sealed = seal(&url, &case["doc"]);
        for step in case["answers"].as_array().unwrap() {
            let target = step["target"].as_str().unwrap().replace("{sealed}", &sealed);
            let request = format!("{} {target} HTTP/1.1\r\nHost: localhost:{port}\r\nConnection: close\r\n\r\n", step["method"].as_str().unwrap());
            check_step(session.as_ref(), port, &request, &step["answer"], &format!("mimo {title}: {} {}", step["method"], step["target"])).await;
        }
        check_end(session.as_ref(), case, &served, &format!("mimo {title}")).await;
    }
}

#[tokio::test]
async fn the_command_code_callback_answers_as_nodes() {
    use mixdog_ai::accounts::AccountStore;
    use mixdog_ai::providers::compat::login::command_code::CommandCodeLogin;

    let golden: Value = serde_json::from_str(LOCAL).unwrap();
    for case in golden["commandCode"].as_array().unwrap() {
        let title = case["title"].as_str().unwrap();
        let served = Arc::new(Served(Mutex::new(case["served"].as_array().unwrap().iter().cloned().collect())));
        let dir = tempfile::tempdir().unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let accounts = AccountStore::new(dir.path().to_path_buf(), CredentialIo { read: tokens.interactive_io, write: tokens.durability_io });
        let flow = CommandCodeLogin::new(served.clone(), credential(dir.path(), "command-code-oauth.json"), credential(dir.path(), "cli-auth.json"), accounts);
        let (session, url, _) = started(&flow, "callback").await;
        let query: std::collections::HashMap<String, String> = url::Url::parse(&url).unwrap().query_pairs().into_owned().collect();
        let port = url::Url::parse(&query["callback"]).unwrap().port().unwrap();
        for step in case["answers"].as_array().unwrap() {
            let mut lines = vec![
                format!("{} {} HTTP/1.1", step["method"].as_str().unwrap(), step["target"].as_str().unwrap()),
                format!("Host: 127.0.0.1:{port}"),
                "Connection: close".to_owned(),
            ];
            for pair in step["headers"].as_array().unwrap() {
                lines.push(format!("{}: {}", pair[0].as_str().unwrap(), pair[1].as_str().unwrap()));
            }
            let body = step["body"].as_str().map(|text| text.replace("{state}", &query["state"]));
            if let Some(body) = &body {
                lines.push(format!("Content-Length: {}", body.len()));
            }
            let request = format!("{}\r\n\r\n{}", lines.join("\r\n"), body.unwrap_or_default());
            check_step(session.as_ref(), port, &request, &step["answer"], &format!("command code {title}: {} {}", step["method"], step["target"])).await;
        }
        check_end(session.as_ref(), case, &served, &format!("command code {title}")).await;
    }
}