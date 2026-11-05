//! The `openai-oauth` sign-in against Node's own login module run over a fake
//! issuer (`fixtures/providers/oracles/openai-login-golden.json`): the authorize
//! URL, the token request and the credential it stores.

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_ai::oauth::AuthorizeRequest;
use mixdog_ai::oauth::CredentialFile;
use mixdog_ai::oauth::CredentialIo;
use mixdog_ai::oauth::Pkce;
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
    async fn send(&self, request: WireRequest) -> Result<HttpResponse, ProviderError> {
        self.seen.lock().unwrap().push(request);
        Ok(HttpResponse {
            status: self.status,
            headers: vec![],
            body: Box::new(OneChunk(Some(Bytes::from(serde_json::to_vec(&self.body).unwrap())))),
        })
    }
}

fn golden() -> Value {
    let path = format!("{}/../../fixtures/providers/oracles/openai-login-golden.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

fn file() -> (tempfile::TempDir, CredentialFile) {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let file = CredentialFile::new(
        dir.path().join("openai-oauth.json"),
        CredentialIo { read: tokens.interactive_io, write: tokens.durability_io },
    );
    (dir, file)
}

fn login(endpoint: Arc<Endpoint>, file: CredentialFile, now: u64) -> OpenAiLogin {
    OpenAiLogin::new(file, endpoint).with_clock(Arc::new(move || now))
}

fn silent() -> Arc<Endpoint> {
    Arc::new(Endpoint { status: 500, body: json!({}), seen: Mutex::new(Vec::new()) })
}

#[test]
fn the_authorize_url_is_the_one_node_builds() {
    let golden = golden();
    let scenario = &golden["scenarios"]["withExpiresIn"];
    let (_dir, file) = file();
    let login = login(silent(), file, 0);
    assert_eq!(login.redirect().uri(1455), REDIRECT);
    assert_eq!(login.verifier_bytes(), 64);
    let pkce = Pkce::generate(login.verifier_bytes());
    assert_eq!(pkce.verifier.len() as u64, scenario["verifierLength"].as_u64().unwrap());
    assert_eq!(pkce.challenge.len() as u64, scenario["challengeLength"].as_u64().unwrap());
    let state = "ab".repeat(scenario["stateShape"]["length"].as_u64().unwrap() as usize / 2);
    let url = url::Url::parse(&login.authorize_url(&AuthorizeRequest {
        redirect_uri: REDIRECT,
        code_challenge: &pkce.challenge,
        state: &state,
    }))
    .unwrap();
    assert_eq!(format!("{}{}", url.origin().ascii_serialization(), url.path()), scenario["authorizeUrlBase"].as_str().unwrap());
    let pairs: Vec<(String, String)> = url.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    let order: Vec<&str> = pairs.iter().map(|(k, _)| k.as_str()).collect();
    let expected_order: Vec<&str> =
        scenario["authorizeParamOrder"].as_array().unwrap().iter().map(|k| k.as_str().unwrap()).collect();
    assert_eq!(order, expected_order);
    for (key, value) in scenario["authorizeFixed"].as_object().unwrap() {
        let got = pairs.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str());
        assert_eq!(got, value.as_str(), "{key}");
    }
}

#[tokio::test]
async fn the_exchange_sends_node_s_form_and_stores_node_s_credential() {
    let golden = golden();
    for (name, scenario) in golden["scenarios"].as_object().unwrap() {
        let mut reply = json!({"access_token": scenario["tokens"]["access_token"], "refresh_token": "refresh-1"});
        if let Some(id) = scenario["tokens"]["id_token"].as_str() {
            reply["id_token"] = json!(id);
        }
        if let Some(seconds) = scenario["tokens"]["expires_in"].as_u64() {
            reply["expires_in"] = json!(seconds);
        }
        let endpoint = Arc::new(Endpoint { status: 200, body: reply, seen: Mutex::new(Vec::new()) });
        let (_dir, file) = file();
        let login = login(endpoint.clone(), file.clone(), scenario["nowMs"].as_u64().unwrap());
        let verifier = Pkce::generate(64).verifier;
        login.exchange(" code 123 ", &verifier, REDIRECT).await.unwrap();

        let request = endpoint.seen.lock().unwrap()[0].clone();
        let expected = &scenario["tokenRequest"];
        assert_eq!(request.method, expected["method"].as_str().unwrap(), "{name}");
        assert_eq!(request.url, "https://auth.openai.com/oauth/token", "{name}");
        assert!(
            request.headers.iter().any(|(k, v)| k.eq_ignore_ascii_case("content-type") && v == expected["contentType"].as_str().unwrap()),
            "{name}"
        );
        let form: Vec<(String, String)> =
            url::form_urlencoded::parse(&request.body).map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
        let order: Vec<&str> = form.iter().map(|(k, _)| k.as_str()).collect();
        let expected_order: Vec<&str> = expected["order"].as_array().unwrap().iter().map(|k| k.as_str().unwrap()).collect();
        assert_eq!(order, expected_order, "{name}");
        for (key, value) in expected["fixed"].as_object().unwrap() {
            assert_eq!(form.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str()), value.as_str(), "{name} {key}");
        }
        assert_eq!(form.iter().find(|(k, _)| k == "code_verifier").unwrap().1, verifier, "{name}");

        let Probe::Present(doc) = file.load_document().await else { panic!("{name}: stored") };
        assert_eq!(Value::Object(doc.clone()), scenario["saved"], "{name}");
        let keys: Vec<&str> = doc.keys().map(String::as_str).collect();
        let expected_keys: Vec<&str> = scenario["savedKeyOrder"].as_array().unwrap().iter().map(|k| k.as_str().unwrap()).collect();
        assert_eq!(keys, expected_keys, "{name}");
    }
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
