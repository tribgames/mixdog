//! The `openai-oauth` sign-in against Node's own login module run over a fake
//! issuer (`fixtures/providers/oracles/openai-login-golden.json`): the authorize
//! URL, the token request and the credential it stores.

#![allow(clippy::disallowed_methods, reason = "test-only: reads a recorded fixture synchronously")]

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_ai::oauth::AuthorizeRequest;
use mixdog_ai::oauth::CredentialFile;
use mixdog_ai::oauth::CredentialIo;
use mixdog_ai::oauth::PkceProvider;
use mixdog_ai::oauth::Probe;
use mixdog_ai::providers::openai::login::OpenAiLogin;
use mixdog_ai::transport::BodyStream;
use mixdog_ai::transport::HttpResponse;
use mixdog_ai::transport::HttpSend;
use mixdog_core_api::domain::login::LoginFailure;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::WireRequest;
use serde_json::Value;
use serde_json::json;

const REDIRECT: &str = "http://localhost:1455/auth/callback";

struct OneChunk(Option<Bytes>);

#[async_trait]
impl BodyStream for OneChunk {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        self.0.take().map(Ok)
    }
}

struct Endpoint {
    status: u16,
    body: Value,
    seen: Mutex<Vec<WireRequest>>,
}

#[async_trait]
impl HttpSend for Endpoint {
    async fn send(&self, request: WireRequest, _exchange: mixdog_ai::transport::Exchange) -> Result<HttpResponse, ProviderError> {
        self.seen.lock().unwrap().push(request);
        Ok(HttpResponse { status: self.status, headers: vec![], body: Box::new(OneChunk(Some(Bytes::from(serde_json::to_vec(&self.body).unwrap())))) })
    }
}

fn file() -> (tempfile::TempDir, CredentialFile) {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let file = CredentialFile::new(dir.path().join("openai-oauth.json"), CredentialIo { read: tokens.interactive_io, write: tokens.durability_io });
    (dir, file)
}

fn login(endpoint: Arc<Endpoint>, file: CredentialFile, now: u64) -> OpenAiLogin {
    OpenAiLogin::new(file, endpoint).with_clock(Arc::new(move || now))
}

fn silent() -> Arc<Endpoint> {
    Arc::new(Endpoint { status: 500, body: json!({}), seen: Mutex::new(Vec::new()) })
}

#[tokio::test]
async fn a_refused_exchange_stores_nothing() {
    let (_dir, file) = file();
    let endpoint = Arc::new(Endpoint { status: 400, body: json!({"error": "invalid_grant"}), seen: Mutex::new(Vec::new()) });
    let outcome = login(endpoint, file.clone(), 0).exchange("c", "v", REDIRECT).await;
    assert!(matches!(outcome, Err(LoginFailure::Denied)), "{outcome:?}");
    assert!(matches!(file.load_document().await, Probe::Absent));

    let endpoint = Arc::new(Endpoint { status: 200, body: json!({"access_token": "a"}), seen: Mutex::new(Vec::new()) });
    let outcome = login(endpoint, file.clone(), 0).exchange("c", "v", REDIRECT).await;
    assert!(matches!(outcome, Err(LoginFailure::Failed { .. })));
    let outcome = login(silent(), file.clone(), 0).exchange("  ", "v", REDIRECT).await;
    assert!(matches!(outcome, Err(LoginFailure::Failed { .. })));
    assert!(matches!(file.load_document().await, Probe::Absent));
}

#[test]
fn the_authorize_url_names_the_codex_client_in_the_documented_parameter_order() {
    let (_dir, file) = file();
    let login = login(silent(), file, 0);
    assert_eq!(login.redirect().uri(1455), REDIRECT);
    assert_eq!(login.verifier_bytes(), 64);
    let url = url::Url::parse(&login.authorize_url(&AuthorizeRequest { redirect_uri: REDIRECT, code_challenge: "challenge-1", state: "state-1" })).unwrap();
    assert_eq!(format!("{}{}", url.origin().ascii_serialization(), url.path()), "https://auth.openai.com/oauth/authorize");
    let pairs: Vec<(String, String)> = url.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    let want = [
        ("response_type", "code"),
        ("client_id", "app_EMoamEEZ73f0CkXaXp7hrann"),
        ("redirect_uri", REDIRECT),
        ("scope", "openid profile email offline_access api.connectors.read api.connectors.invoke"),
        ("code_challenge", "challenge-1"),
        ("code_challenge_method", "S256"),
        ("id_token_add_organizations", "true"),
        ("codex_cli_simplified_flow", "true"),
        ("state", "state-1"),
        ("originator", "codex_cli_rs"),
    ];
    assert_eq!(pairs.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect::<Vec<_>>(), want);
}

#[tokio::test]
async fn the_exchange_posts_the_authorization_code_form_and_stores_the_pair_with_its_expiry() {
    let reply = json!({"access_token": "opaque-access", "refresh_token": "refresh-1", "expires_in": 3600});
    let endpoint = Arc::new(Endpoint { status: 200, body: reply, seen: Mutex::new(Vec::new()) });
    let (_dir, file) = file();
    login(endpoint.clone(), file.clone(), 1_000).exchange(" code 123 ", "verifier-1", REDIRECT).await.unwrap();

    let request = endpoint.seen.lock().unwrap()[0].clone();
    assert_eq!((request.method.as_str(), request.url.as_str()), ("POST", "https://auth.openai.com/oauth/token"));
    assert!(request.headers.iter().any(|(k, v)| k.eq_ignore_ascii_case("content-type") && v == "application/x-www-form-urlencoded"));
    let form: Vec<(String, String)> = url::form_urlencoded::parse(&request.body).map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    let form: Vec<(&str, &str)> = form.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    assert_eq!(
        form,
        [
            ("grant_type", "authorization_code"),
            ("code", "code 123"),
            ("redirect_uri", REDIRECT),
            ("client_id", "app_EMoamEEZ73f0CkXaXp7hrann"),
            ("code_verifier", "verifier-1"),
        ]
    );

    let Probe::Present(doc) = file.load_document().await else { panic!("stored") };
    assert_eq!(Value::Object(doc.clone()), json!({"access_token": "opaque-access", "refresh_token": "refresh-1", "expires_at": 3_601_000, "identity": null}));
    assert_eq!(doc.keys().map(String::as_str).collect::<Vec<_>>(), ["access_token", "refresh_token", "expires_at", "identity"]);
}
