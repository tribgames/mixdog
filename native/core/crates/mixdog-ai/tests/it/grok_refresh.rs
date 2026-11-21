//! The Grok credential refresh: when a send's header refreshes the token, what the exchange looks like, what is kept of
//! it, how failures are retried and when a still-valid token stands in for a failed refresh.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_ai::oauth::CredentialFile;
use mixdog_ai::oauth::CredentialIo;
use mixdog_ai::oauth::Pace;
use mixdog_ai::providers::connect::rewrite::Credential;
use mixdog_ai::providers::grok::auth::GrokCredential;
use mixdog_ai::transport::BodyStream;
use mixdog_ai::transport::Exchange;
use mixdog_ai::transport::HttpResponse;
use mixdog_ai::transport::HttpSend;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::WireRequest;
use serde_json::Value;
use serde_json::json;

const ENDPOINT: &str = "https://auth.x.ai/oauth2/token";
const MINUTE: u64 = 60_000;

/// A clock that moves only when a refresh waits; every wait is kept.
struct Clock {
    now: AtomicU64,
    waits: Mutex<Vec<u64>>,
}

#[async_trait]
impl Pace for Clock {
    fn now_ms(&self) -> u64 {
        self.now.load(Ordering::SeqCst)
    }
    async fn wait(&self, duration: Duration) {
        self.waits.lock().unwrap().push(duration.as_millis() as u64);
        self.now.fetch_add(duration.as_millis() as u64, Ordering::SeqCst);
    }
    /// The middle of the jitter range, so a wait is its base plus half of it.
    fn draw(&self) -> f64 {
        0.5
    }
}

struct Once(Option<Bytes>);

#[async_trait]
impl BodyStream for Once {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        self.0.take().map(Ok)
    }
}

/// The token endpoint: every POST is kept and answered by the next scripted reply.
#[derive(Default)]
struct Endpoint {
    replies: Mutex<VecDeque<(u16, String)>>,
    posts: Mutex<Vec<(String, String)>>,
}

#[async_trait]
impl HttpSend for Endpoint {
    async fn send(&self, request: WireRequest, _: Exchange) -> Result<HttpResponse, ProviderError> {
        // The proxy origin is warmed before a turn; that is not a token request.
        if request.method == "HEAD" {
            return Ok(HttpResponse { status: 200, headers: Vec::new(), body: Box::new(Once(None)) });
        }
        self.posts.lock().unwrap().push((request.url.clone(), String::from_utf8(request.body).unwrap()));
        let (status, body) = self.replies.lock().unwrap().pop_front().expect("a token request the test did not script");
        Ok(HttpResponse { status, headers: Vec::new(), body: Box::new(Once(Some(Bytes::from(body)))) })
    }
}

struct Setup {
    credential: GrokCredential,
    endpoint: Arc<Endpoint>,
    clock: Arc<Clock>,
    path: PathBuf,
    _dir: tempfile::TempDir,
}

fn granted(access: &str, refresh: &str) -> (u16, String) {
    (200, json!({"access_token": access, "refresh_token": refresh, "expires_in": 3600}).to_string())
}

fn setup(stored: Value, replies: Vec<(u16, String)>) -> Setup {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("grok-oauth.json");
    std::fs::write(&path, stored.to_string()).unwrap();
    let rt = mixdog_rt::testing::tokens();
    let file = CredentialFile::new(path.clone(), CredentialIo { read: rt.interactive_io, write: rt.durability_io });
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
    let clock = Arc::new(Clock { now: AtomicU64::new(now), waits: Mutex::new(Vec::new()) });
    let endpoint = Arc::new(Endpoint { replies: Mutex::new(replies.into()), posts: Mutex::new(Vec::new()) });
    let credential = GrokCredential::new(endpoint.clone(), file).with_pace(clock.clone());
    Setup { credential, endpoint, clock, path, _dir: dir }
}

impl Setup {
    fn now(&self) -> u64 {
        self.clock.now_ms()
    }

    /// A stored credential expiring `in_ms` from now (negative: already expired).
    fn stored(&self, access: &str, refresh: &str, in_ms: i64) -> Value {
        json!({"access_token": access, "refresh_token": refresh, "expires_at": self.now() as i64 + in_ms, "token_endpoint": ENDPOINT})
    }

    fn posts(&self) -> Vec<(String, String)> {
        self.endpoint.posts.lock().unwrap().clone()
    }

    fn waits(&self) -> Vec<u64> {
        self.clock.waits.lock().unwrap().clone()
    }

    fn file(&self) -> Value {
        serde_json::from_str(&std::fs::read_to_string(&self.path).unwrap()).unwrap()
    }

    async fn bearer(&self, force: bool) -> Result<String, ProviderError> {
        let (name, value) = self.credential.header(force).await?.expect("a header");
        assert_eq!(name, "authorization");
        Ok(value)
    }
}

/// A setup whose file is rewritten with a token expiring `in_ms` from the clock's now.
fn with_token(in_ms: i64, replies: Vec<(u16, String)>) -> Setup {
    let s = setup(json!({}), replies);
    std::fs::write(&s.path, s.stored("a1", "r1", in_ms).to_string()).unwrap();
    s
}

#[tokio::test]
async fn a_token_with_time_left_is_used_without_any_request() {
    let s = with_token(MINUTE as i64 * 60, vec![]);
    assert_eq!(s.bearer(false).await.unwrap(), "Bearer a1");
    assert!(s.posts().is_empty());
}

#[tokio::test]
async fn a_token_inside_the_five_minute_margin_is_refreshed_and_the_rotated_tokens_are_stored() {
    let s = with_token(4 * MINUTE as i64, vec![granted("a2", "r2")]);
    assert_eq!(s.bearer(false).await.unwrap(), "Bearer a2");
    let posts = s.posts();
    assert_eq!(posts.len(), 1);
    assert_eq!(posts[0].0, ENDPOINT);
    let form: std::collections::HashMap<String, String> = url::form_urlencoded::parse(posts[0].1.as_bytes()).into_owned().collect();
    assert_eq!((form["grant_type"].as_str(), form["refresh_token"].as_str()), ("refresh_token", "r1"));
    let stored = s.file();
    assert_eq!((stored["access_token"].clone(), stored["refresh_token"].clone()), (json!("a2"), json!("r2")));
    assert_eq!(stored["expires_at"].as_u64(), Some(s.now() + 3600 * 1000), "the new expiry counts from the exchange");
    assert_eq!(stored["token_endpoint"], ENDPOINT);
}

#[tokio::test]
async fn the_old_refresh_token_is_kept_when_the_response_omits_a_new_one() {
    let s = with_token(MINUTE as i64, vec![(200, json!({"access_token": "a2", "expires_in": 60}).to_string())]);
    assert_eq!(s.bearer(false).await.unwrap(), "Bearer a2");
    assert_eq!(s.file()["refresh_token"], "r1");
}

#[tokio::test]
async fn a_token_a_margin_away_is_not_refreshed_but_a_forced_header_refreshes_any_token() {
    let s = with_token(MINUTE as i64 * 6, vec![granted("a2", "r2")]);
    assert_eq!(s.bearer(false).await.unwrap(), "Bearer a1");
    assert!(s.posts().is_empty());
    assert_eq!(s.bearer(true).await.unwrap(), "Bearer a2");
    assert_eq!(s.posts().len(), 1);
}

#[tokio::test]
async fn a_credential_file_another_process_rotated_is_what_the_next_send_uses() {
    let s = with_token(MINUTE as i64 * 60, vec![]);
    assert_eq!(s.bearer(false).await.unwrap(), "Bearer a1");
    std::fs::write(&s.path, s.stored("a9", "r9", MINUTE as i64 * 60).to_string()).unwrap();
    assert_eq!(s.bearer(false).await.unwrap(), "Bearer a9");
    assert!(s.posts().is_empty());
}

#[tokio::test]
async fn two_sends_needing_a_refresh_at_once_share_one_exchange() {
    let s = with_token(MINUTE as i64, vec![granted("a2", "r2")]);
    let (one, two) = tokio::join!(s.bearer(false), s.bearer(false));
    assert_eq!((one.unwrap(), two.unwrap()), ("Bearer a2".to_owned(), "Bearer a2".to_owned()));
    assert_eq!(s.posts().len(), 1);
}

#[tokio::test]
async fn a_transient_refusal_is_retried_twice_with_a_growing_pause_and_a_valid_token_stands_in() {
    let refused = || (500, "busy".to_owned());
    let s = with_token(4 * MINUTE as i64, vec![refused(), refused(), refused()]);
    assert_eq!(s.bearer(false).await.unwrap(), "Bearer a1", "the token is still valid, so the turn goes on with it");
    assert_eq!(s.posts().len(), 3);
    // 200 ms then 400 ms, each with up to as much again at random (half of it here).
    assert_eq!(s.waits(), [300, 600]);
    // The failed refresh is not tried again for the margin.
    assert_eq!(s.bearer(false).await.unwrap(), "Bearer a1");
    assert_eq!(s.posts().len(), 3);
}

#[tokio::test]
async fn a_failing_refresh_of_an_expired_token_fails_the_send_with_the_refusal() {
    let refused = || (500, "busy".to_owned());
    let s = with_token(-(MINUTE as i64), vec![refused(), refused(), refused()]);
    let error = s.bearer(false).await.unwrap_err();
    assert!(error.message.starts_with("[grok-oauth] token refresh 500: busy"), "{}", error.message);
    assert!(!error.reauth_required);
    assert_eq!(s.posts().len(), 3);
}

#[tokio::test]
async fn a_dead_grant_is_not_retried_and_asks_for_a_new_sign_in() {
    let s = with_token(MINUTE as i64 * 60, vec![(400, json!({"error": "invalid_grant"}).to_string())]);
    let error = s.bearer(true).await.unwrap_err();
    assert!(error.reauth_required);
    assert_eq!(error.code.as_deref(), Some("invalid_grant"));
    assert_eq!(s.posts().len(), 1);
    assert!(s.waits().is_empty());
}

#[tokio::test]
async fn a_token_endpoint_outside_x_ai_is_never_sent_the_refresh_token() {
    let s = setup(json!({}), vec![]);
    let hostile = json!({"access_token": "a1", "refresh_token": "r1", "expires_at": s.now() as i64 - 1000, "token_endpoint": "https://evil.example/token"});
    std::fs::write(&s.path, hostile.to_string()).unwrap();
    let error = s.bearer(false).await.unwrap_err();
    assert!(error.message.contains("untrusted token endpoint"), "{}", error.message);
    assert!(s.posts().is_empty());
}

/// A sign-out after a turn was served: the file is gone, or written back holding no sign-in. The token the credential
/// served before is not sent again, and the user it named is forgotten.
#[tokio::test]
async fn a_token_served_before_a_sign_out_is_not_sent_after_it() {
    for signed_out in [None, Some(json!({})), Some(json!({"access_token": "", "refresh_token": "", "expires_at": 0}))] {
        let s = with_token(MINUTE as i64 * 60, vec![]);
        let mut stored = s.stored("a1", "r1", MINUTE as i64 * 60);
        stored["user_id"] = json!("user-1");
        std::fs::write(&s.path, stored.to_string()).unwrap();
        assert_eq!(s.bearer(false).await.unwrap(), "Bearer a1");
        assert_eq!(s.credential.user_id().as_deref(), Some("user-1"));
        match &signed_out {
            Some(document) => std::fs::write(&s.path, document.to_string()).unwrap(),
            None => std::fs::remove_file(&s.path).unwrap(),
        }
        for force in [false, true] {
            let error = s.credential.header(force).await.expect_err("no header after the sign-out");
            assert!(error.reauth_required, "{signed_out:?}");
            assert!(error.message.starts_with("Grok OAuth is not connected"), "{}", error.message);
        }
        assert_eq!(s.credential.user_id(), None, "{signed_out:?}");
        assert!(s.posts().is_empty(), "nothing is exchanged for a login that is gone");
    }
}

/// A file that reads and holds both tokens but does not decode (here a `user_id` of `null`) is no sign-out: the token
/// served before stays in use, and with none served before the file is reported as unreadable.
#[tokio::test]
async fn a_sign_in_that_does_not_decode_keeps_the_token_served_before() {
    let s = with_token(MINUTE as i64 * 60, vec![]);
    let mut undecodable = s.stored("a9", "r9", MINUTE as i64 * 60);
    undecodable["user_id"] = Value::Null;
    assert_eq!(s.bearer(false).await.unwrap(), "Bearer a1");
    std::fs::write(&s.path, undecodable.to_string()).unwrap();
    assert_eq!(s.bearer(false).await.unwrap(), "Bearer a1");

    let fresh = setup(undecodable, vec![]);
    let error = fresh.bearer(false).await.unwrap_err();
    assert!(!error.reauth_required, "{}", error.message);
    assert!(error.message.contains("cannot be read"), "{}", error.message);
}

#[tokio::test]
async fn without_a_credential_file_the_provider_is_not_connected() {
    let s = setup(json!({}), vec![]);
    std::fs::remove_file(&s.path).unwrap();
    let error = s.bearer(false).await.unwrap_err();
    assert!(error.reauth_required);
    assert!(error.message.starts_with("Grok OAuth is not connected"), "{}", error.message);
    // A file whose refresh token is empty is as good as none.
    std::fs::write(&s.path, json!({"access_token": "a1", "refresh_token": ""}).to_string()).unwrap();
    assert!(s.bearer(false).await.unwrap_err().reauth_required);
}

#[tokio::test]
async fn a_refresh_leaves_nothing_but_the_credential_file_behind() {
    let s = with_token(MINUTE as i64, vec![granted("a2", "r2")]);
    assert_eq!(s.bearer(false).await.unwrap(), "Bearer a2");
    let left: Vec<String> = std::fs::read_dir(s.path.parent().unwrap()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(left, ["grok-oauth.json"], "the cross-process lease is released when the refresh is done");
}
