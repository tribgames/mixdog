//! The `openai-oauth` credential source over a real credential file and a
//! scripted token endpoint.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_ai::oauth::CredentialFile;
use mixdog_ai::oauth::CredentialIo;
use mixdog_ai::providers::openai::adapter::CredentialSource;
use mixdog_ai::providers::openai::oauth::OpenAiOAuth;
use mixdog_ai::transport::BodyStream;
use mixdog_ai::transport::HttpResponse;
use mixdog_ai::transport::HttpSend;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::WireRequest;
use serde_json::Value;
use serde_json::json;

struct OneChunk(Option<Bytes>);

#[async_trait]
impl BodyStream for OneChunk {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        self.0.take().map(Ok)
    }
}

#[derive(Default)]
struct TokenEndpoint {
    replies: Mutex<VecDeque<(u16, Value)>>,
    seen: Mutex<Vec<WireRequest>>,
}

#[async_trait]
impl HttpSend for TokenEndpoint {
    async fn send(&self, request: WireRequest) -> Result<HttpResponse, ProviderError> {
        self.seen.lock().unwrap().push(request);
        let (status, body) = self.replies.lock().unwrap().pop_front().expect("scripted reply");
        Ok(HttpResponse {
            status,
            headers: vec![],
            body: Box::new(OneChunk(Some(Bytes::from(serde_json::to_vec(&body).unwrap())))),
        })
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

struct Fixture {
    _dir: tempfile::TempDir,
    file: CredentialFile,
    endpoint: Arc<TokenEndpoint>,
    oauth: OpenAiOAuth,
}

async fn fixture(stored: Value, replies: Vec<(u16, Value)>) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let file = CredentialFile::new(
        dir.path().join("openai-oauth.json"),
        CredentialIo { read: tokens.interactive_io, write: tokens.durability_io },
    );
    file.save(&stored).await.unwrap();
    let endpoint = Arc::new(TokenEndpoint { replies: Mutex::new(replies.into()), ..Default::default() });
    let oauth = OpenAiOAuth::new(file.clone(), endpoint.clone());
    Fixture { _dir: dir, file, endpoint, oauth }
}

fn stored(access: &str, expires_at: u64) -> Value {
    json!({"access_token": access, "refresh_token": "r1", "expires_at": expires_at, "account_id": "acct-1", "identity": {"id": "keep-me"}})
}

#[tokio::test]
async fn a_fresh_token_is_used_without_a_refresh() {
    let f = fixture(stored("a1", now_ms() + 3_600_000), vec![]).await;
    let credential = f.oauth.current().await.unwrap();
    assert_eq!((credential.bearer.as_str(), credential.account_id.as_deref()), ("a1", Some("acct-1")));
    assert!(f.endpoint.seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn an_expiring_token_is_refreshed_and_the_rotated_pair_is_stored() {
    let f = fixture(
        stored("a1", now_ms() + 1_000),
        vec![(200, json!({"access_token": "a2", "refresh_token": "r2", "expires_in": 3600}))],
    )
    .await;
    assert_eq!(f.oauth.current().await.unwrap().bearer, "a2");
    let request = f.endpoint.seen.lock().unwrap()[0].clone();
    assert_eq!(request.url, "https://auth.openai.com/oauth/token");
    let form = String::from_utf8(request.body).unwrap();
    assert!(form.contains("grant_type=refresh_token") && form.contains("refresh_token=r1"));
    let doc = f.file.load_document().await;
    let mixdog_ai::oauth::Probe::Present(doc) = doc else { panic!("stored") };
    assert_eq!(doc["refresh_token"], "r2");
    assert_eq!(doc["identity"]["id"], "keep-me", "fields the refresh does not know survive");
}

#[tokio::test]
async fn a_rejected_token_is_replaced_and_an_unchanged_one_is_not_offered_again() {
    let f = fixture(
        stored("a1", now_ms() + 3_600_000),
        vec![(200, json!({"access_token": "a2", "refresh_token": "r2", "expires_in": 3600}))],
    )
    .await;
    let rejected = f.oauth.current().await.unwrap();
    let next = f.oauth.after_rejection(&rejected).await.unwrap().expect("a new token");
    assert_eq!(next.bearer, "a2");
    // The stored token is already the newer one: no second refresh happens.
    let stale = mixdog_ai::providers::openai::adapter::Credential { bearer: "a1".into(), account_id: None };
    let again = f.oauth.after_rejection(&stale).await.unwrap().expect("the stored token");
    assert_eq!(again.bearer, "a2");
    assert_eq!(f.endpoint.seen.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_dead_grant_asks_for_a_new_login_and_a_transient_failure_coasts() {
    let dead = fixture(
        stored("a1", now_ms() + 1_000),
        vec![(400, json!({"error": "invalid_grant"}))],
    )
    .await;
    let err = dead.oauth.current().await.unwrap_err();
    assert!(err.reauth_required && err.kind == ErrorKind::Auth);

    // A server error while the current token still has life keeps using it.
    let coast = fixture(stored("a1", now_ms() + 60_000), vec![(503, json!({}))]).await;
    assert_eq!(coast.oauth.current().await.unwrap().bearer, "a1");

    // The same failure with an expired token is an error, not a logout.
    let expired = fixture(stored("a1", now_ms().saturating_sub(1_000)), vec![(503, json!({}))]).await;
    let err = expired.oauth.current().await.unwrap_err();
    assert!(!err.reauth_required && err.kind == ErrorKind::Transient);
}

#[tokio::test]
async fn no_stored_login_needs_a_login() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let file = CredentialFile::new(
        dir.path().join("openai-oauth.json"),
        CredentialIo { read: tokens.interactive_io, write: tokens.durability_io },
    );
    let oauth = OpenAiOAuth::new(file, Arc::new(TokenEndpoint::default()));
    assert!(oauth.current().await.unwrap_err().reauth_required);
}
