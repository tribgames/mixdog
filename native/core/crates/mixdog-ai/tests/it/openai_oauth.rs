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
    /// The head window each request was handed and the words its expiry reads as.
    windows: Mutex<Vec<(Option<std::time::Duration>, Option<String>)>>,
    /// How long the endpoint takes to answer: the window in which a second refresher could spend the same token.
    delay: std::time::Duration,
}

#[async_trait]
impl HttpSend for TokenEndpoint {
    async fn send(
        &self,
        request: WireRequest,
        exchange: mixdog_ai::transport::Exchange,
    ) -> Result<HttpResponse, ProviderError> {
        let window = exchange.liveness.head_deadline();
        self.windows.lock().unwrap().push((window, window.and_then(|wait| exchange.surface.timeout_text(wait))));
        self.seen.lock().unwrap().push(request);
        tokio::time::sleep(self.delay).await;
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
async fn a_refresh_hands_its_transport_thirty_seconds_read_as_an_aborted_fetch() {
    let f = fixture(
        stored("a1", now_ms() + 1_000),
        vec![(200, json!({"access_token": "a2", "refresh_token": "r2", "expires_in": 3600}))],
    )
    .await;
    f.oauth.current().await.unwrap();
    assert_eq!(
        *f.endpoint.windows.lock().unwrap(),
        [(Some(std::time::Duration::from_secs(30)), Some(mixdog_ai::transport::ABORTED.to_owned()))]
    );
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
    // The token is expired, so nothing is left to coast on (`reusableCurrentTokens`).
    let dead = fixture(
        stored("a1", now_ms().saturating_sub(1_000)),
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

/// Two handles over one file, each a process of its own to the lease: both expiring, both refreshing at once. The first
/// spends the single-use token; the endpoint refuses a second spend as the real one does (`refresh_token_reused`). The
/// second waits for the lease, reads the pair the first stored and adopts it: one request, one new token for both,
/// no sign-in asked.
#[tokio::test]
async fn two_processes_refreshing_at_once_spend_the_token_once() {
    use mixdog_ai::oauth::lease::LockProcess;
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let file = CredentialFile::new(dir.path().join("openai-oauth.json"), CredentialIo { read: tokens.interactive_io, write: tokens.durability_io });
    file.save(&stored("a1", now_ms() + 1_000)).await.unwrap();
    let endpoint = Arc::new(TokenEndpoint {
        replies: Mutex::new(
            vec![
                (200, json!({"access_token": "a2", "refresh_token": "r2", "expires_in": 3600})),
                (401, json!({"error": {"code": "refresh_token_reused"}})),
            ]
            .into(),
        ),
        delay: std::time::Duration::from_millis(50),
        ..Default::default()
    });
    let handle = |file: &CredentialFile| {
        OpenAiOAuth::in_process(file.clone(), endpoint.clone(), Arc::new(LockProcess::new(mixdog_statefile::LockOwner::another_in_process())))
    };
    let (first, second) = (handle(&file), handle(&file));
    let (a, b) = tokio::join!(first.current(), second.current());
    assert_eq!((a.unwrap().bearer.as_str(), b.unwrap().bearer.as_str()), ("a2", "a2"));
    assert_eq!(endpoint.seen.lock().unwrap().len(), 1, "the old token was spent once");
    let mixdog_ai::oauth::Probe::Present(doc) = file.load_document().await else { panic!("stored") };
    assert_eq!(doc["refresh_token"], "r2");
}

/// Node's rule for a permanent refusal (openai-oauth-tokens.mjs:252): any 401, or a typed refresh-token code in the
/// body, is a dead grant; a bare 400 or 5xx is not. Whether the user is asked to sign in then depends on whether a
/// usable token remains (`reusableCurrentTokens`, `:344`): an unexpired one keeps serving, an expired one asks.
#[tokio::test]
async fn a_dead_grant_asks_for_sign_in_only_when_no_usable_token_remains() {
    let refusals = [
        (401, json!("gateway page")),
        (400, json!({"detail": "Refresh token was revoked"})),
        (500, json!({"error": "refresh_token_reused"})),
    ];
    for (status, body) in refusals {
        let expired = fixture(stored("a1", now_ms().saturating_sub(1_000)), vec![(status, body.clone())]).await;
        let error = expired.oauth.current().await.unwrap_err();
        assert!(error.reauth_required, "expired: {status} {body}");

        let live = fixture(stored("a1", now_ms() + 1_000), vec![(status, body.clone())]).await;
        assert_eq!(live.oauth.current().await.unwrap().bearer, "a1", "unexpired: {status} {body}");
    }
    // Not a dead grant at all: no sign-in is asked even with nothing left to use.
    let f = fixture(stored("a1", now_ms().saturating_sub(1_000)), vec![(400, json!({"error": "invalid_request"}))]).await;
    assert!(!f.oauth.current().await.unwrap_err().reauth_required);
}

/// A token endpoint that answers after a gate opens, so the test can drop every waiter while the exchange is in flight.
struct GatedEndpoint {
    started: tokio::sync::Notify,
    gate: tokio::sync::Notify,
    seen: Mutex<usize>,
}

#[async_trait]
impl HttpSend for GatedEndpoint {
    async fn send(&self, _request: WireRequest, _exchange: mixdog_ai::transport::Exchange) -> Result<HttpResponse, ProviderError> {
        *self.seen.lock().unwrap() += 1;
        self.started.notify_one();
        self.gate.notified().await;
        let body = serde_json::to_vec(&json!({"access_token": "a2", "refresh_token": "r2", "expires_in": 3600})).unwrap();
        Ok(HttpResponse { status: 200, headers: vec![], body: Box::new(OneChunk(Some(Bytes::from(body)))) })
    }
}

/// Every caller gives up mid-exchange. The refresh has the lease and runs to its end on its own: the new pair is stored
/// and the lease released, so another process then proceeds without waiting on a live owner that will never finish.
#[tokio::test]
async fn a_refresh_whose_every_waiter_is_cancelled_still_persists_and_releases_the_lease() {
    use mixdog_ai::oauth::lease::LockProcess;
    use mixdog_ai::oauth::lease::REFRESH_LEASE;
    use mixdog_ai::oauth::lease::refresh_lock_path;
    use mixdog_ai::oauth::SystemPace;
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let file = CredentialFile::new(dir.path().join("openai-oauth.json"), CredentialIo { read: tokens.interactive_io, write: tokens.durability_io });
    file.save(&stored("a1", now_ms() + 1_000)).await.unwrap();
    let endpoint = Arc::new(GatedEndpoint { started: tokio::sync::Notify::new(), gate: tokio::sync::Notify::new(), seen: Mutex::new(0) });
    let oauth = OpenAiOAuth::in_process(file.clone(), endpoint.clone(), Arc::new(LockProcess::new(mixdog_statefile::LockOwner::another_in_process())));

    // The only waiter is dropped while the exchange is in flight.
    let waiter = tokio::spawn({
        let oauth = Arc::new(oauth);
        async move { oauth.current().await }
    });
    endpoint.started.notified().await;
    waiter.abort();
    let _ = waiter.await;
    endpoint.gate.notify_one();

    // Another process takes the same lease: it is granted once the orphaned refresh released it, and it finds the new pair.
    let other = Arc::new(LockProcess::new(mixdog_statefile::LockOwner::another_in_process()));
    let found = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        file.lease(&refresh_lock_path(file.path()), &other, &SystemPace, REFRESH_LEASE, async { file.load_document().await }),
    )
    .await
    .expect("the lease was released")
    .unwrap();
    let mixdog_ai::oauth::Probe::Present(doc) = found else { panic!("stored") };
    assert_eq!(doc["refresh_token"], "r2", "the refresh persisted although nobody waited for it");
    assert_eq!(*endpoint.seen.lock().unwrap(), 1);
}

/// `json.expires_at ?? json.expiresAt` is read before `expires_in`, in seconds or milliseconds
/// (`normalizeExpiresAtMs`, openai-oauth-tokens.mjs:262).
#[tokio::test]
async fn a_stated_expiry_in_the_refresh_answer_is_stored() {
    let at_s = now_ms() / 1000 + 7200;
    let f = fixture(
        stored("a1", now_ms() + 1_000),
        vec![(200, json!({"access_token": "a2", "refresh_token": "r2", "expiresAt": at_s, "expires_in": 60}))],
    )
    .await;
    assert_eq!(f.oauth.current().await.unwrap().bearer, "a2");
    let mixdog_ai::oauth::Probe::Present(doc) = f.file.load_document().await else { panic!("stored") };
    assert_eq!(doc["expires_at"], json!(at_s * 1000));
}

/// A token endpoint that answers every request with one status and the bytes as they are.
struct RawEndpoint(u16, Vec<u8>);

#[async_trait]
impl HttpSend for RawEndpoint {
    async fn send(&self, _request: WireRequest, _exchange: mixdog_ai::transport::Exchange) -> Result<HttpResponse, ProviderError> {
        Ok(HttpResponse { status: self.0, headers: vec![], body: Box::new(OneChunk((!self.1.is_empty()).then(|| Bytes::from(self.1.clone())))) })
    }
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

fn lock_of(file: &CredentialFile) -> std::path::PathBuf {
    mixdog_ai::oauth::lease::refresh_lock_path(file.path())
}

fn tokens_reply(access: &str, refresh: &str) -> (u16, Value) {
    (200, json!({"access_token": access, "refresh_token": refresh, "expires_in": 3600}))
}

/// An endpoint that runs a hook in each send (a panic, another writer, a hang) before it answers from its script.
struct HookedEndpoint {
    replies: Mutex<VecDeque<(u16, Value)>>,
    seen: Mutex<usize>,
    hook: Mutex<Option<Box<dyn FnOnce() -> futures::future::BoxFuture<'static, ()> + Send>>>,
}

impl HookedEndpoint {
    fn new(replies: Vec<(u16, Value)>) -> Arc<Self> {
        Arc::new(Self { replies: Mutex::new(replies.into()), seen: Mutex::new(0), hook: Mutex::new(None) })
    }
    fn on_next_send(&self, hook: impl FnOnce() -> futures::future::BoxFuture<'static, ()> + Send + 'static) {
        *self.hook.lock().unwrap() = Some(Box::new(hook));
    }
    fn sent(&self) -> usize {
        *self.seen.lock().unwrap()
    }
}

#[async_trait]
impl HttpSend for HookedEndpoint {
    async fn send(&self, _request: WireRequest, _exchange: mixdog_ai::transport::Exchange) -> Result<HttpResponse, ProviderError> {
        *self.seen.lock().unwrap() += 1;
        let hook = self.hook.lock().unwrap().take();
        if let Some(hook) = hook {
            hook().await;
        }
        let (status, body) = self.replies.lock().unwrap().pop_front().expect("scripted reply");
        Ok(HttpResponse { status, headers: vec![], body: Box::new(OneChunk(Some(Bytes::from(serde_json::to_vec(&body).unwrap())))) })
    }
}

async fn hooked(stored_doc: Value, replies: Vec<(u16, Value)>) -> (tempfile::TempDir, CredentialFile, Arc<HookedEndpoint>, OpenAiOAuth) {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let file = CredentialFile::new(dir.path().join("openai-oauth.json"), CredentialIo { read: tokens.interactive_io, write: tokens.durability_io });
    file.save(&stored_doc).await.unwrap();
    let endpoint = HookedEndpoint::new(replies);
    let oauth = OpenAiOAuth::in_process(file.clone(), endpoint.clone(), Arc::new(mixdog_ai::oauth::lease::LockProcess::new(mixdog_statefile::LockOwner::another_in_process())));
    (dir, file, endpoint, oauth)
}

/// The refresh task panics holding the lease: its waiters, holding no token still in date, get a failure, the lease is
/// gone (the guard's drop released it while unwinding) and the flight is cleared, so the same credential object runs a
/// later refresh that succeeds.
#[tokio::test]
async fn a_refresh_task_that_panics_frees_its_lease_and_its_flight() {
    let (_dir, file, endpoint, oauth) = hooked(stored("a1", now_ms().saturating_sub(1_000)), vec![tokens_reply("a2", "r2")]).await;
    let oauth = Arc::new(oauth);
    let (entered, gate) = (Arc::new(tokio::sync::Notify::new()), Arc::new(tokio::sync::Notify::new()));
    endpoint.on_next_send({
        let (entered, gate) = (entered.clone(), gate.clone());
        move || {
            Box::pin(async move {
                entered.notify_one();
                gate.notified().await;
                panic!("the refresh task dies holding the lease");
            })
        }
    });
    // The first caller starts the flight, which stops at the gate holding the lease. The second is polled while it is
    // there: the lanes of a test run inline, so its token read finishes in that one poll and it joins the flight at once.
    // Only then is the gate opened, so both callers are on the flight when it dies.
    let first = tokio::spawn({
        let oauth = oauth.clone();
        async move { oauth.current().await }
    });
    entered.notified().await;
    let mut second = Box::pin(oauth.current());
    assert!(futures::poll!(second.as_mut()).is_pending(), "the second caller waits on the flight");
    gate.notify_one();
    let (a, b) = (first.await.unwrap(), second.await);
    assert!(a.is_err() && b.is_err(), "every waiter of the dead flight gets a failure");
    assert!(!lock_of(&file).exists(), "the lease went with the task");
    assert_eq!(oauth.current().await.unwrap().bearer, "a2", "a later refresh on the same object succeeds");
}

/// The runtime is shut down mid-refresh while the credential object lives on outside it: the dropped task's guards release
/// the lease (nothing is queued to do it later) and clear the flight, so a new runtime refreshes with the same object.
#[test]
fn a_runtime_shut_down_mid_refresh_releases_the_lease_with_nothing_queued() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let file = CredentialFile::new(dir.path().join("openai-oauth.json"), CredentialIo { read: tokens.interactive_io, write: tokens.durability_io });
    std::fs::write(file.path(), serde_json::to_vec(&stored("a1", now_ms() + 1_000)).unwrap()).unwrap();
    let endpoint = HookedEndpoint::new(vec![tokens_reply("a2", "r2")]);
    let oauth = Arc::new(OpenAiOAuth::in_process(file.clone(), endpoint.clone(), Arc::new(mixdog_ai::oauth::lease::LockProcess::new(mixdog_statefile::LockOwner::another_in_process()))));

    let (reached_tx, reached_rx) = std::sync::mpsc::channel::<()>();
    endpoint.on_next_send(move || {
        Box::pin(async move {
            reached_tx.send(()).unwrap();
            std::future::pending::<()>().await;
        })
    });
    let first = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
    first.spawn({
        let oauth = oauth.clone();
        async move {
            let _ = oauth.current().await;
        }
    });
    reached_rx.recv_timeout(std::time::Duration::from_secs(30)).expect("the refresh reached the token endpoint");
    assert!(lock_of(&file).exists(), "the refresh holds the lease");
    drop(first);
    assert!(!lock_of(&file).exists(), "dropping the runtime released the lease synchronously");

    let second = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
    let bearer = second.block_on(oauth.current()).unwrap().bearer;
    assert_eq!(bearer, "a2", "the same object refreshes on a new runtime");
}

/// A lease whose caller vanished after the lane took the lock is released: the guard travels out of the acquiring job as
/// its result, and a result nobody receives is dropped with the lock.
#[tokio::test]
async fn a_lease_whose_caller_is_dropped_after_the_lane_took_the_lock_is_released() {
    use mixdog_ai::oauth::SystemPace;
    use mixdog_ai::oauth::lease::LockProcess;
    use mixdog_ai::oauth::lease::REFRESH_LEASE;
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let file = CredentialFile::new(dir.path().join("openai-oauth.json"), CredentialIo { read: tokens.interactive_io, write: tokens.durability_io });
    let lock = lock_of(&file);
    let process = LockProcess::new(mixdog_statefile::LockOwner::another_in_process());
    let mut lease = Box::pin(file.lease(&lock, &process, &SystemPace, REFRESH_LEASE, std::future::pending::<()>()));
    let started = std::time::Instant::now();
    while !lock.exists() {
        let _ = futures::poll!(lease.as_mut());
        tokio::task::yield_now().await;
        assert!(started.elapsed() < std::time::Duration::from_secs(30), "the lane never took the lock");
    }
    drop(lease);
    let started = std::time::Instant::now();
    while lock.exists() {
        tokio::task::yield_now().await;
        assert!(started.elapsed() < std::time::Duration::from_secs(30), "the lock outlived its caller");
    }
}

/// A lease over a dead holder's lock is granted (the dead-owner reclaim), and the next one is not blocked by it.
#[tokio::test]
async fn a_second_process_reclaims_a_dead_holders_refresh_lease() {
    use mixdog_ai::oauth::SystemPace;
    use mixdog_ai::oauth::lease::LockProcess;
    use mixdog_ai::oauth::lease::REFRESH_LEASE;
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let file = CredentialFile::new(dir.path().join("openai-oauth.json"), CredentialIo { read: tokens.interactive_io, write: tokens.durability_io });
    let lock = lock_of(&file);
    std::fs::write(&lock, format!("{} 1 tok\n", mixdog_testkit::dead_pid())).unwrap();
    let process = LockProcess::new(mixdog_statefile::LockOwner::another_in_process());
    let got = file.lease(&lock, &process, &SystemPace, REFRESH_LEASE, async { 7 }).await.unwrap();
    assert_eq!(got, 7);
    assert!(!lock.exists());
}

/// A dead grant, then many calls: one exchange in total, the still-usable access token keeps serving, a rewrite of the
/// stored metadata (same refresh token) does not lift the refusal, and once the token is past its expiry sign-in is asked
/// with no further exchange.
#[tokio::test]
async fn a_dead_grant_is_exchanged_once_and_then_only_serves_until_expiry() {
    let (_dir, file, endpoint, oauth) = hooked(stored("a1", now_ms() + 60_000), vec![(400, json!({"error": "invalid_grant"}))]).await;
    for _ in 0..6 {
        let credential = oauth.current().await.expect("a usable token keeps serving");
        assert_eq!(credential.bearer, "a1");
    }
    assert_eq!(endpoint.sent(), 1, "the refused refresh token was presented once");
    // Metadata and an expiry rewrite under the same refresh token do not lift it.
    file.save(&stored("a1", now_ms().saturating_sub(1_000))).await.unwrap();
    let error = oauth.current().await.unwrap_err();
    assert!(error.reauth_required, "past its expiry nothing is left: sign-in is asked");
    assert_eq!(endpoint.sent(), 1, "and still no exchange");
}

/// Another process replaces the refresh token after a refusal: a usable pair is adopted without an exchange, and one
/// that needs a refresh gets exactly one new attempt (the refusal named the old token only).
#[tokio::test]
async fn a_refresh_token_replaced_by_another_process_lifts_the_refusal() {
    let (_dir, file, endpoint, oauth) = hooked(stored("a1", now_ms() + 60_000), vec![(400, json!({"error": "invalid_grant"})), tokens_reply("a4", "r4")]).await;
    assert_eq!(oauth.current().await.unwrap().bearer, "a1");
    assert_eq!(endpoint.sent(), 1);

    file.save(&json!({"access_token": "a3", "refresh_token": "r3", "expires_at": now_ms() + 3_600_000})).await.unwrap();
    assert_eq!(oauth.current().await.unwrap().bearer, "a3", "adopted: usable, no exchange");
    assert_eq!(endpoint.sent(), 1);

    file.save(&json!({"access_token": "a3", "refresh_token": "r3", "expires_at": now_ms() + 60_000})).await.unwrap();
    assert_eq!(oauth.current().await.unwrap().bearer, "a4", "one new attempt with the new token");
    assert_eq!(endpoint.sent(), 2);
}

/// A refusal for the old token that arrives after another process stored a new pair: the new pair is adopted and is not
/// marked, so it is refreshed later like any other.
#[tokio::test]
async fn a_late_refusal_of_the_old_token_does_not_poison_the_new_one() {
    let (_dir, file, endpoint, oauth) = hooked(stored("a1", now_ms() + 1_000), vec![(401, json!({"error": {"code": "refresh_token_reused"}})), tokens_reply("a4", "r4")]).await;
    let rewrite = file.clone();
    endpoint.on_next_send(move || {
        Box::pin(async move {
            rewrite.save(&json!({"access_token": "a3", "refresh_token": "r3", "expires_at": now_ms() + 3_600_000})).await.unwrap();
        })
    });
    assert_eq!(oauth.current().await.unwrap().bearer, "a3", "the pair stored meanwhile is adopted");
    // The new token is not remembered as refused: when it needs refreshing it is exchanged.
    file.save(&json!({"access_token": "a3", "refresh_token": "r3", "expires_at": now_ms() + 1_000})).await.unwrap();
    assert_eq!(oauth.current().await.unwrap().bearer, "a4");
    assert_eq!(endpoint.sent(), 2);
}

/// A transient failure holds the next preemptive refresh off while the token is still in date (`_refreshFallbackUntil`); a
/// token past its real expiry exchanges despite the holdoff.
#[tokio::test]
async fn a_transient_failure_holds_the_next_send_off_until_the_token_expires() {
    let (_dir, file, endpoint, oauth) = hooked(stored("a1", now_ms() + 60_000), vec![(503, json!({})), tokens_reply("a2", "r2")]).await;
    assert_eq!(oauth.current().await.unwrap().bearer, "a1", "coasts on the usable token");
    // Node holds the next preemptive attempt off until the expiry skew (`_refreshFallbackUntil`).
    assert_eq!(oauth.current().await.unwrap().bearer, "a1", "the outage is not retried on every turn");
    assert_eq!(endpoint.sent(), 1);
    file.save(&stored("a1", now_ms().saturating_sub(1_000))).await.unwrap();
    assert_eq!(oauth.current().await.unwrap().bearer, "a2", "an expired token exchanges despite the holdoff");
    assert_eq!(endpoint.sent(), 2);
}

/// No refresh token: a token that is not past its real expiry keeps serving, one that is asks for sign-in.
#[tokio::test]
async fn without_a_refresh_token_a_usable_access_token_keeps_serving() {
    let doc = |expires_at: u64| json!({"access_token": "a1", "expires_at": expires_at, "account_id": "acct-1"});
    let (_d, _f, endpoint, oauth) = hooked(doc(now_ms() + 60_000), vec![]).await;
    assert_eq!(oauth.current().await.unwrap().bearer, "a1");
    assert_eq!(endpoint.sent(), 0);
    let (_d, _f, _e, expired) = hooked(doc(now_ms().saturating_sub(1_000)), vec![]).await;
    assert!(expired.current().await.unwrap_err().reauth_required);
}


/// After a 401 the refresh is answered 2xx with no usable token: the caller is told the refresh failed, with the cause
/// the answer gives, and the stored login is not touched.
#[tokio::test]
async fn a_refresh_answer_that_is_no_token_is_a_failed_refresh_naming_its_cause() {
    let cases: [(&[u8], &str); 4] = [
        (b"{}", "refresh returned null"),
        (br#"{"access_token":""}"#, "refresh returned null"),
        (br#"{"refresh_token":"r2"}"#, "refresh returned null"),
        (b"null", "Cannot read properties of null (reading 'access_token')"),
    ];
    for (body, cause) in cases {
        let dir = tempfile::tempdir().unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let file = CredentialFile::new(dir.path().join("openai-oauth.json"), CredentialIo { read: tokens.interactive_io, write: tokens.durability_io });
        file.save(&stored("a1", now_ms() + 3_600_000)).await.unwrap();
        let oauth = OpenAiOAuth::new(file.clone(), Arc::new(RawEndpoint(200, body.to_vec())));
        let rejected = oauth.current().await.unwrap();
        let error = oauth.after_rejection(&rejected).await.expect_err("no token came back");
        assert_eq!(error.message, format!("OpenAI OAuth token refresh failed ({cause}). Re-authenticate via provider login."), "{}", String::from_utf8_lossy(body));
        let mixdog_ai::oauth::Probe::Present(doc) = file.load_document().await else { panic!("stored") };
        assert_eq!(doc["access_token"], "a1", "the stored login is kept");
    }
}

/// After a 401 the refresh is answered 2xx with no usable token: the text the caller gets is the one the real Node
/// refresh threw for the same answer (`connect-errors/record.mjs --only refreshAnswers`), whole.
#[cfg(node_twin)]
#[tokio::test]
async fn a_refresh_answer_that_is_no_token_reads_as_nodes_whole() {
    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/agent/connect-errors/golden/connect_errors.json")).unwrap();
    let answers = golden["refreshAnswers"].as_array().unwrap();
    assert!(answers.len() >= 17);
    for answer in answers {
        let name = answer["name"].as_str().unwrap();
        let body = answer["body"].as_str().unwrap_or_default().as_bytes().to_vec();
        let dir = tempfile::tempdir().unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let file = CredentialFile::new(dir.path().join("openai-oauth.json"), CredentialIo { read: tokens.interactive_io, write: tokens.durability_io });
        file.save(&stored("a1", now_ms() + 3_600_000)).await.unwrap();
        let oauth = OpenAiOAuth::new(file, Arc::new(RawEndpoint(answer["status"].as_u64().unwrap() as u16, body)));
        let rejected = oauth.current().await.unwrap();
        let error = oauth.after_rejection(&rejected).await.expect_err(name);
        assert_eq!(error.message, answer["thrown"]["message"].as_str().unwrap(), "{name}");
    }
}

/// A token endpoint whose answer head arrives and whose body then fails to read.
struct BrokenBody(u16);

struct Failing;

#[async_trait]
impl BodyStream for Failing {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        Some(Err(TransportFault::Connect { os_code: None }))
    }
}

#[async_trait]
impl HttpSend for BrokenBody {
    async fn send(&self, _: WireRequest, _: mixdog_ai::transport::Exchange) -> Result<HttpResponse, ProviderError> {
        Ok(HttpResponse { status: self.0, headers: vec![], body: Box::new(Failing) })
    }
}

/// `refreshUnderLock` catches a body that cannot be read like any failed exchange (`openai-oauth-tokens.mjs:242`, `:329-332`):
/// the token still in date keeps serving, the turn does not fail.
#[tokio::test]
async fn a_refresh_whose_body_cannot_be_read_keeps_the_valid_token() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let file = CredentialFile::new(dir.path().join("openai-oauth.json"), CredentialIo { read: tokens.interactive_io, write: tokens.durability_io });
    file.save(&stored("a1", now_ms() + 1_000)).await.unwrap();
    let oauth = OpenAiOAuth::new(file, Arc::new(BrokenBody(200)));
    assert_eq!(oauth.current().await.unwrap().bearer, "a1");
}

/// The head's status survives a body that cannot be read: a 401 is still the refresh token's refusal.
#[tokio::test]
async fn a_broken_401_body_is_still_a_refresh_token_refusal() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let file = CredentialFile::new(dir.path().join("openai-oauth.json"), CredentialIo { read: tokens.interactive_io, write: tokens.durability_io });
    file.save(&stored("a1", now_ms() + 3_600_000)).await.unwrap();
    let oauth = OpenAiOAuth::new(file, Arc::new(BrokenBody(401)));
    let rejected = oauth.current().await.unwrap();
    assert!(oauth.after_rejection(&rejected).await.unwrap_err().reauth_required);
}

/// A forced refresh that ran its own exchange is final even when the server hands back the same bearer: it does not
/// spend the just-rotated refresh token again, and a successful renewal arms no failure holdoff.
#[tokio::test]
async fn the_owner_of_a_successful_exchange_does_not_exchange_again_for_the_same_bearer() {
    let (_dir, _file, endpoint, oauth) = hooked(stored("a1", now_ms() + 3_600_000), vec![tokens_reply("a1", "r2")]).await;
    let rejected = oauth.current().await.unwrap();
    assert_eq!(oauth.after_rejection(&rejected).await.unwrap().map(|next| next.bearer), Some("a1".to_owned()));
    assert_eq!(endpoint.sent(), 1, "the forced caller's own exchange is final: no second exchange spends the rotated token");
    let (_dir, _file, endpoint, oauth) = hooked(stored("a1", now_ms() + 1_000), vec![(200, json!({"access_token": "a1", "refresh_token": "r2", "expires_in": 1})), (200, json!({"access_token": "a1", "refresh_token": "r3", "expires_in": 1}))]).await;
    assert_eq!(oauth.current().await.unwrap().bearer, "a1");
    assert_eq!(oauth.current().await.unwrap().bearer, "a1");
    assert_eq!(endpoint.sent(), 2, "a successful renewal that returned the same bearer is not a failure to coast on");
}

/// A 401's forced refresh that joins a preemptive refresh which only coasted on the rejected token runs its own
/// exchange instead of being handed the rejected bearer again (`openai-oauth-tokens.mjs:369-386`).
#[tokio::test]
async fn a_forced_refresh_that_joins_a_coasting_one_runs_its_own_exchange() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let file = CredentialFile::new(dir.path().join("openai-oauth.json"), CredentialIo { read: tokens.interactive_io, write: tokens.durability_io });
    file.save(&stored("a1", now_ms() + 1_000)).await.unwrap();
    let endpoint = Arc::new(TokenEndpoint {
        replies: Mutex::new(vec![(500, json!({})), (200, json!({"access_token": "a2", "refresh_token": "r2", "expires_in": 3600}))].into()),
        delay: std::time::Duration::from_millis(200),
        ..Default::default()
    });
    let oauth = OpenAiOAuth::new(file, endpoint.clone());
    let rejected = mixdog_ai::providers::openai::adapter::Credential { bearer: "a1".into(), account_id: Some("acct-1".into()) };
    let (preemptive, forced) = tokio::join!(oauth.current(), async {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        oauth.after_rejection(&rejected).await
    });
    assert_eq!(preemptive.unwrap().bearer, "a1");
    assert_eq!(forced.unwrap().expect("a new credential").bearer, "a2");
    assert_eq!(endpoint.seen.lock().unwrap().len(), 2);
}
