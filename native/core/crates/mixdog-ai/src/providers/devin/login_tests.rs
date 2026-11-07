//! The Devin sign-in against Node's (`fixtures/devin-login/golden.json`, `record-devin-login.mjs`):
//! the authorize URL for the recorded state and challenge, and every code exchange: the request
//! sent, the token record stored (key order included) or the failure raised.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::login::LoginFailure;
use mixdog_core_api::domain::provider::{DeliveryState, ErrorKind, ProviderError, WireRequest};
use serde_json::Value;

use super::login::DevinLogin;
use crate::oauth::http::testing::Scripted;
use crate::oauth::{AuthorizeRequest, CredentialFile, CredentialIo, PkceProvider, Probe};
use crate::transport::{Exchange, HttpResponse, HttpSend};

const GOLDEN: &str = include_str!("../../../../../fixtures/devin-login/golden.json");

/// A request that gets no answer.
struct NoAnswer;

#[async_trait]
impl HttpSend for NoAnswer {
    async fn send(&self, _: WireRequest, _: Exchange) -> Result<HttpResponse, ProviderError> {
        Err(ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent))
    }
}

fn io() -> CredentialIo {
    let tokens = mixdog_rt::testing::tokens();
    CredentialIo { read: tokens.interactive_io, write: tokens.durability_io }
}

fn login(file: CredentialFile, http: Arc<dyn HttpSend>, now: u64) -> DevinLogin {
    DevinLogin::new(file, http).with_clock(Arc::new(move || now))
}

#[test]
fn the_authorize_url_is_nodes_for_its_state_and_challenge() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let authorize = &golden["authorize"];
    let dir = tempfile::tempdir().unwrap();
    let provider = login(CredentialFile::new(dir.path().join("devin-oauth.json"), io()), Arc::new(NoAnswer), 0);
    let redirect = provider.redirect();
    let redirect_uri = format!("http://{}:{}{}", redirect.host, redirect.port, redirect.path);
    let url = provider.authorize_url(&AuthorizeRequest {
        redirect_uri: &redirect_uri,
        code_challenge: authorize["challenge"].as_str().unwrap(),
        state: authorize["state"].as_str().unwrap(),
    });
    assert_eq!(url, authorize["url"].as_str().unwrap());
}

#[tokio::test]
async fn every_exchange_sends_and_stores_what_node_does() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let exchanges = golden["exchanges"].as_array().unwrap();
    assert_eq!(exchanges.len(), 13);
    // Node's scripted answers, by scenario.
    let answers: Vec<Option<(u16, &str)>> = vec![
        Some((200, "TOKEN:ann")),
        Some((200, "TOKEN:sub")),
        Some((200, "TOKEN:padded")),
        Some((200, "TOKEN:noexp")),
        Some((200, r#"{"token":"opaque-token"}"#)),
        Some((200, "TOKEN:array")),
        Some((200, r#"{"other":1}"#)),
        Some((200, r#"{"token":""}"#)),
        Some((200, r#"{"token":5}"#)),
        Some((200, "null")),
        Some((401, r#"{"error":"denied","token":"leaky"}"#)),
        Some((500, "{}")),
        None,
    ];
    for (exchange, answer) in exchanges.iter().zip(answers) {
        let name = exchange["name"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let file = CredentialFile::new(dir.path().join("devin-oauth.json"), io());
        let want_token = exchange["outcome"]["tokens"]["access_token"].as_str();
        let mut sent = None;
        let http: Arc<dyn HttpSend> = match answer {
            Some((status, body)) => {
                // `TOKEN:*` answers carry the token the recording received.
                let body = if body.starts_with("TOKEN:") {
                    serde_json::json!({ "token": want_token.unwrap() }).to_string()
                } else {
                    body.to_owned()
                };
                let scripted = Scripted::new(&[(status, &body)]);
                sent = Some(scripted.clone());
                scripted
            }
            None => Arc::new(NoAnswer),
        };
        let provider = login(file.clone(), http, exchange["now"].as_u64().unwrap());
        let result = provider.exchange("the-code", "the-verifier", "unused").await;
        if let Some(scripted) = &sent {
            let seen = scripted.seen.lock().unwrap();
            let want = &exchange["requests"][0];
            assert_eq!((seen[0].method.as_str(), seen[0].url.as_str()), (want["method"].as_str().unwrap(), want["url"].as_str().unwrap()), "{name}");
            let headers: Vec<(String, String)> = want["headers"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())).collect();
            assert_eq!(seen[0].headers, headers, "{name}: headers, in order");
            assert_eq!(String::from_utf8_lossy(&seen[0].body), want["body"].as_str().unwrap(), "{name}");
        }
        match (&exchange["outcome"]["tokens"], &exchange["outcome"]["message"]) {
            (Value::Object(_), _) => {
                assert!(result.is_ok(), "{name}: {result:?}");
                let Probe::Present(stored) = file.load_document().await else { panic!("{name}: nothing stored") };
                assert_eq!(
                    serde_json::to_string(&Value::Object(stored)).unwrap(),
                    serde_json::to_string(&exchange["outcome"]["tokens"]).unwrap(),
                    "{name}: stored record, key order included"
                );
            }
            (_, message) => {
                let Err(LoginFailure::Failed { code, message: got }) = result else { panic!("{name}: expected a failure") };
                assert_eq!(got, message.as_str().unwrap(), "{name}");
                assert_eq!(code, exchange["outcome"]["failureCode"].as_str().unwrap(), "{name}");
                assert!(matches!(file.load_document().await, Probe::Absent), "{name}: nothing stored on failure");
            }
        }
    }
}
