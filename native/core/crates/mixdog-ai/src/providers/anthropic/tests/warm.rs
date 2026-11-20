//! `AnthropicAdapter::send_cache_warm` and the account gate against Node: every scenario of
//! `fixtures/cache-warm-send/golden.json` (recorded by `record-cache-warm-send.mjs` driving
//! `sendAnthropicCacheWarm` and `cacheWarmAccountBlock` over a real roster and the real admission
//! scheduler) must end with the same error text, usage reports, POST count and lane state. The
//! request the warm POSTs is the one `attempt` builds.

use std::collections::VecDeque;
use std::sync::Mutex;

use mixdog_core_api::domain::cache_warm::CacheWarmSend;
use mixdog_core_api::domain::provider::{ModelRequest, ProviderAdapter, WireRequest};
use tokio_util::sync::CancellationToken;

use super::*;
use crate::accounts::rotation::{AccountRotation, UsageProbe};
use crate::accounts::{AccountStore};
use crate::accounts::QuotaWindowInput;
use crate::admission::{Admission, LaneKey, LaneSettings};
use crate::oauth::pace::SystemPace;
use crate::warmer::gate::{AccountGate, GateTarget, ProviderSwitch, QuotaResumes, UsageSnapshots, WarmGate};
use crate::warmer::send::{Deadlines, WarmContext};

// ---- the scripted POST -------------------------------------------------------------------------

enum Reply {
    Sse(Vec<Vec<u8>>),
    Status { status: u16, headers: Vec<(String, String)>, body: String },
    Throw(String),
    /// A POST that never answers.
    Hang,
    /// A 200 whose body stalls after its chunks.
    SseThenHang(Vec<Vec<u8>>),
}



#[derive(Default)]
struct WarmHttp {
    script: Mutex<VecDeque<Reply>>,
    sent: Mutex<Vec<WireRequest>>,
}

#[async_trait]
impl HttpSend for WarmHttp {
    async fn send(
        &self,
        request: WireRequest,
        _exchange: crate::transport::Exchange,
    ) -> Result<HttpResponse, ProviderError> {
        self.sent.lock().unwrap().push(request);
        let reply = self.script.lock().unwrap().pop_front().expect("scripted reply");
        Ok(match reply {
            Reply::Throw(message) => {
                let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent);
                error.message = message;
                return Err(error);
            }
            Reply::Hang => std::future::pending().await,
            Reply::Sse(chunks) => HttpResponse { status: 200, headers: Vec::new(), body: Box::new(ChunkBody { chunks: chunks.into(), then_hang: false }) },
            Reply::SseThenHang(chunks) => HttpResponse { status: 200, headers: Vec::new(), body: Box::new(ChunkBody { chunks: chunks.into(), then_hang: true }) },
            Reply::Status { status, headers, body } => HttpResponse { status, headers, body: Box::new(ChunkBody { chunks: VecDeque::from([body.into_bytes()]), then_hang: false }) },
        })
    }
}

struct ChunkBody {
    chunks: VecDeque<Vec<u8>>,
    then_hang: bool,
}

#[async_trait]
impl BodyStream for ChunkBody {
    async fn next(&mut self) -> Option<Result<bytes::Bytes, TransportFault>> {
        match self.chunks.pop_front() {
            Some(chunk) => Some(Ok(chunk.into())),
            None if self.then_hang => std::future::pending().await,
            None => None,
        }
    }
}

// ---- the process seams -------------------------------------------------------------------------

struct NoProbe;

#[async_trait]
impl UsageProbe for NoProbe {
    async fn measure(&self, _: &str, _: &str, _: bool) {}
}

struct On;

impl ProviderSwitch for On {
    fn available(&self, _: &str) -> bool {
        true
    }
}

struct NotPaused;

impl QuotaResumes for NotPaused {
    fn paused(&self, _: &str) -> bool {
        false
    }
}

struct NoSnapshot;

#[async_trait]
impl UsageSnapshots for NoSnapshot {
    async fn cached(&self, _: &str) -> Option<(Vec<crate::accounts::Window>, i64)> {
        None
    }
}

fn now_ms() -> i64 {
    i64::try_from(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()).unwrap()
}

fn gate() -> (AccountGate, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let store = AccountStore::new(dir.path().to_path_buf(), CredentialIo { read: tokens.interactive_io, write: tokens.durability_io });
    let rotation = Arc::new(AccountRotation::new(store.clone(), Arc::new(NoProbe), Arc::new(SystemPace)));
    let gate = AccountGate {
        admission: Arc::new(Admission::new()),
        lane_settings: Arc::new(|_: &LaneKey| LaneSettings { adaptive: true, ..LaneSettings::default() }),
        store,
        rotation,
        switch: Arc::new(On),
        resumes: Arc::new(NotPaused),
        snapshots: Arc::new(NoSnapshot),
        scope: Arc::new(crate::warmer::gate::OwnServices),
        now_ms: Arc::new(now_ms),
    };
    (gate, dir)
}



fn target(provider: &str, account: &str) -> GateTarget {
    GateTarget { provider: provider.to_owned(), account_id: account.to_owned(), model: "claude-opus-4-7".into(), session_id: String::new() }
}



fn warm_request() -> ModelRequest {
    let mut request = request(base_messages(), RequestOptions::default());
    request.options.max_output_tokens_override = Some(1);
    request
}

/// The adapter of `provider` and the credential store it reads (kept alive with it).
fn adapter_of(provider: &str, http: &Arc<WarmHttp>) -> (AnthropicAdapter, Arc<MemoryStore>) {
    let store = MemoryStore::signed_in();
    if provider == "anthropic" {
        return (AnthropicAdapter::api_key(config("https://api.anthropic.com"), http.clone(), Arc::new(FixedKey), cpu_bulk()), store);
    }
    let adapter = AnthropicAdapter::oauth(
        config("https://api.anthropic.com"),
        http.clone(),
        Arc::new(OAuthSession::new(store.file.clone(), http.clone())),
        false,
        cpu_bulk(),
    );
    (adapter, store)
}
/// The warm POSTs the body `attempt` builds (one request path), plain, with the credential.
#[tokio::test]
async fn a_warm_posts_the_request_attempt_builds_once_and_plain() {
    let http = Arc::new(WarmHttp::default());
    http.script.lock().unwrap().push_back(Reply::Sse(vec![
        b"data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":1,\"cache_read_input_tokens\":9}}}\n\n".to_vec(),
        b"data: {\"type\":\"content_block_start\"}\n\n".to_vec(),
    ]));
    let store = MemoryStore::signed_in();
    let adapter = AnthropicAdapter::oauth(
        config("https://api.anthropic.com"),
        http.clone(),
        Arc::new(OAuthSession::new(store.file.clone(), http.clone())),
        false,
        cpu_bulk(),
    );
    let (gate, _dir) = gate();
    let request = warm_request();
    let usage = adapter
        .send_cache_warm(&request, &WarmContext { gate: &gate, target: &target("anthropic", ""), deadlines: Deadlines::DEFAULT, report: &|_| {} }, &CancellationToken::new(), &mut |_| {})
        .await
        .unwrap();
    assert_eq!(usage.cached, 9.0);
    let sent = http.sent.lock().unwrap();
    assert_eq!(sent.len(), 1);
    let built = adapter.codec().encode(&request).unwrap();
    assert_eq!(sent[0].body, built.body, "the body attempt builds");
    assert!(!sent[0].headers.iter().any(|h| h.0.eq_ignore_ascii_case("content-encoding")), "plain body");
    assert_eq!(serde_json::from_slice::<Value>(&sent[0].body).unwrap()["max_tokens"], 1);
}

struct NoPrice;

/// The warmer reaches the warm through the registered (accounting-wrapped) adapter, and the
/// request it sends is capped at one token whatever the caller built.
#[tokio::test]
async fn a_wrapped_provider_warms_with_the_output_capped_at_one_token() {
    let http = Arc::new(WarmHttp::default());
    http.script.lock().unwrap().push_back(Reply::Sse(vec![
        b"data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":1,\"cache_read_input_tokens\":9}}}\n\n".to_vec(),
        b"data: {\"type\":\"content_block_start\"}\n\n".to_vec(),
    ]));
    let store = MemoryStore::signed_in();
    let adapter = AnthropicAdapter::oauth(
        config("https://api.anthropic.com"),
        http.clone(),
        Arc::new(OAuthSession::new(store.file.clone(), http.clone())),
        false,
        cpu_bulk(),
    );
    let deps = Arc::new(crate::registry::accounted::AccountingDeps::new(Arc::new(NoPrice), Arc::new(|| None)));
    let registered = crate::registry::accounted::AccountedAdapter::wrap(Arc::new(adapter), "anthropic-oauth", deps);
    let (gate, _dir) = gate();
    let real = request(base_messages(), RequestOptions::default());
    assert_eq!(real.options.max_output_tokens_override, None);
    let warm = registered.cache_warm().expect("the wrapper forwards the cache-warm mode");
    let ctx = WarmContext { gate: &gate, target: &target("anthropic", ""), deadlines: Deadlines::DEFAULT, report: &|_| {} };
    warm.send_cache_warm(&real, &ctx, &CancellationToken::new(), &mut |_| {}).await.unwrap();
    let sent = http.sent.lock().unwrap();
    assert_eq!(serde_json::from_slice::<Value>(&sent[0].body).unwrap()["max_tokens"], 1);
}

/// The first-byte deadline aborts a warm whose POST never answers; the failure says so.
#[tokio::test(start_paused = true)]
async fn a_post_that_never_answers_ends_at_the_first_byte_deadline() {
    struct Hang;
    #[async_trait]
    impl HttpSend for Hang {
        async fn send(
            &self,
            _: WireRequest,
            _exchange: crate::transport::Exchange,
        ) -> Result<HttpResponse, ProviderError> {
            std::future::pending().await
        }
    }
    let http = Arc::new(Hang);
    let store = MemoryStore::signed_in();
    let adapter = AnthropicAdapter::oauth(
        config("https://api.anthropic.com"),
        http.clone(),
        Arc::new(OAuthSession::new(store.file.clone(), http)),
        false,
        cpu_bulk(),
    );
    let (gate, _dir) = gate();
    let failure = adapter
        .send_cache_warm(&warm_request(), &WarmContext { gate: &gate, target: &target("anthropic", ""), deadlines: Deadlines::DEFAULT, report: &|_| {} }, &CancellationToken::new(), &mut |_| {})
        .await
        .unwrap_err();
    assert_eq!(failure.message, "cache warm first byte timed out after 60000ms");
}

/// What the gate was told about each refusal.
#[derive(Default)]
struct Refusals {
    seen: Mutex<Vec<(ProviderError, bool)>>,
}

#[async_trait]
impl WarmGate for Refusals {
    async fn block(&self, _: &GateTarget) -> Option<String> {
        None
    }

    async fn record_refusal(&self, _: &GateTarget, error: &ProviderError, aborted: bool) -> Result<(), String> {
        self.seen.lock().unwrap().push((error.clone(), aborted));
        Ok(())
    }
}

/// An SSE `rate_limit_error` after usage reaches the gate as the 429 it is, with the provider's
/// type, and the failure still carries the usage: the lane and roster judge it like a send's.
#[tokio::test]
async fn an_sse_rate_limit_error_reaches_the_gate_as_a_429_with_its_type() {
    let http = Arc::new(WarmHttp::default());
    http.script.lock().unwrap().push_back(Reply::Sse(vec![
        b"data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":1,\"cache_read_input_tokens\":9}}}\n\n".to_vec(),
        b"data: {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"slow down\"}}\n\n".to_vec(),
    ]));
    let (adapter, _store) = adapter_of("anthropic-oauth", &http);
    let refusals = Refusals::default();
    let ctx = WarmContext { gate: &refusals, target: &target("anthropic-oauth", ""), deadlines: Deadlines::DEFAULT, report: &|_| {} };
    let failure = adapter.send_cache_warm(&warm_request(), &ctx, &CancellationToken::new(), &mut |_| {}).await.unwrap_err();
    assert_eq!(failure.message, "Anthropic cache warm SSE error rate_limit_error: slow down");
    assert_eq!(failure.usage.as_ref().map(|u| u.cached), Some(9.0));
    let seen = refusals.seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    let (error, aborted) = &seen[0];
    assert!(!aborted);
    assert_eq!(error.status, Some(429));
    assert_eq!(error.code.as_deref(), Some("rate_limit_error"));
    assert_eq!(error.message, failure.message);
}

impl crate::registry::accounting::UsagePricing for NoPrice {
    fn price_usage(&self, _: &crate::catalog::UsageArgs) -> crate::catalog::PricedUsage {
        unreachable!("a warm is not priced by the wrapper")
    }
}



// ---- the account gate and the warm's own outcomes ----------------------------------------------

fn frame(event: Value) -> Vec<u8> {
    format!("data: {event}\n\n").into_bytes()
}

fn start_with_usage() -> Vec<u8> {
    frame(serde_json::json!({ "type": "message_start", "message": { "usage": { "input_tokens": 1, "cache_read_input_tokens": 9, "cache_creation_input_tokens": 5 } } }))
}

fn first_block() -> Vec<u8> {
    frame(serde_json::json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "text", "text": "" } }))
}

struct Off;

impl ProviderSwitch for Off {
    fn available(&self, _: &str) -> bool {
        false
    }
}

struct Paused;

impl QuotaResumes for Paused {
    fn paused(&self, session: &str) -> bool {
        session == "paused-session"
    }
}

fn refusal(status: u16) -> ProviderError {
    let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::Accepted);
    error.status = Some(status);
    error
}

#[tokio::test]
async fn the_gate_names_the_first_reason_that_stops_a_warm() {
    let (mut gate, _dir) = gate();
    let now = now_ms();
    // A provider without a roster and without a stored quota reading has no evidence of room.
    assert_eq!(gate.block_at(&target("anthropic-oauth", ""), now).await.as_deref(), Some("no fresh quota reading"));
    assert_eq!(gate.block_at(&target("anthropic", ""), now).await, None, "a provider outside the roster providers is gated by the lane alone");
    // The session's quota-resume pause.
    gate.resumes = Arc::new(Paused);
    let mut paused = target("anthropic", "");
    paused.session_id = "paused-session".into();
    assert_eq!(gate.block_at(&paused, now).await.as_deref(), Some("session paused until its quota resets"));
    paused.session_id = "other-session".into();
    assert_eq!(gate.block_at(&paused, now).await, None);
    // The Developer switch is read before everything else.
    gate.switch = Arc::new(Off);
    assert_eq!(gate.block_at(&paused, now).await.as_deref(), Some("provider disabled"));
    gate.switch = Arc::new(On);
    // With a roster, the account that holds the cache has to be named, connected and read.
    let account = "00000000-0000-4000-8000-000000000001";
    gate.store.register("anthropic-oauth", account, "", false).await.unwrap();
    assert_eq!(gate.block_at(&target("anthropic-oauth", ""), now).await.as_deref(), Some("account holding the cache unknown"));
    assert_eq!(gate.block_at(&target("anthropic-oauth", "00000000-0000-4000-8000-0000000000ff"), now).await.as_deref(), Some("account not connected"));
    assert_eq!(gate.block_at(&target("anthropic-oauth", account), now).await.as_deref(), Some("no fresh quota reading"));
}

/// A warm's refusal reaches the lane as a send's would: only a 429 on an adaptive (Anthropic) lane, only when its
/// advised wait (Retry-After) is at most 60 s, and only on that account's lane. A 429 that advises no wait halves
/// the lane's limit but parks it for no time, so it blocks nothing.
#[tokio::test]
async fn a_refused_warm_parks_the_lane_only_for_a_429_with_a_short_advised_wait() {
    let (gate, _dir) = gate();
    let now = now_ms();
    let refused = |status: u16, wait_secs: Option<u64>| {
        let mut error = refusal(status);
        error.retry_after = wait_secs.map(std::time::Duration::from_secs);
        error
    };
    let blocked = |account: &'static str| {
        let gate = &gate;
        async move { gate.block_at(&target("anthropic", account), now).await }
    };
    gate.record_refusal(&target("anthropic", "a1"), &refused(500, Some(20)), false).await.unwrap();
    assert_eq!(blocked("a1").await, None, "the lane keeps 429s only");
    gate.record_refusal(&target("anthropic", "a2"), &refused(429, Some(20)), true).await.unwrap();
    assert_eq!(blocked("a2").await, None, "an aborted warm is not a refusal");
    gate.record_refusal(&target("anthropic", "a3"), &refused(429, None), false).await.unwrap();
    assert_eq!(blocked("a3").await, None, "no advised wait parks the lane for no time");
    gate.record_refusal(&target("anthropic", "a4"), &refused(429, Some(61)), false).await.unwrap();
    assert_eq!(blocked("a4").await, None, "a wait past 60 s describes a model's pool, not the account's lane");
    gate.record_refusal(&target("anthropic", "a5"), &refused(429, Some(20)), false).await.unwrap();
    assert_eq!(blocked("a5").await.as_deref(), Some("rate-limit cooldown"));
    assert_eq!(blocked("a6").await, None, "another account's lane is its own");
}
#[tokio::test]
async fn a_warm_the_gate_skips_sends_nothing_and_says_why() {
    let http = Arc::new(WarmHttp::default());
    let (adapter, _store) = adapter_of("anthropic-oauth", &http);
    let (mut gate, _dir) = gate();
    gate.switch = Arc::new(Off);
    let ctx = WarmContext { gate: &gate, target: &target("anthropic", ""), deadlines: Deadlines::DEFAULT, report: &|_| {} };
    let failure = adapter.send_cache_warm(&warm_request(), &ctx, &CancellationToken::new(), &mut |_| {}).await.unwrap_err();
    assert_eq!(failure.message, "cache warm skipped: provider disabled");
    assert!(http.sent.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_warm_ends_at_the_first_content_block_once_the_usage_is_known_and_never_reads_on() {
    let http = Arc::new(WarmHttp::default());
    http.script.lock().unwrap().push_back(Reply::Sse(vec![
        start_with_usage(),
        first_block(),
        frame(serde_json::json!({ "type": "error", "error": { "type": "api_error", "message": "never read" } })),
    ]));
    let (adapter, _store) = adapter_of("anthropic-oauth", &http);
    let (gate, _dir) = gate();
    let mut reports = Vec::new();
    let ctx = WarmContext { gate: &gate, target: &target("anthropic", ""), deadlines: Deadlines::DEFAULT, report: &|_| {} };
    let usage = adapter.send_cache_warm(&warm_request(), &ctx, &CancellationToken::new(), &mut |u: &crate::warmer::stream::WarmUsage| reports.push(u.cached)).await.unwrap();
    assert_eq!((usage.input, usage.cached, usage.cache_write), (1.0, 9.0, 5.0));
    assert_eq!(usage.prompt_tokens, Some(15.0), "the whole prompt: input plus the cache read and written");
    assert_eq!(reports, [9.0], "the usage was reported as it arrived");
}

#[tokio::test]
async fn a_content_block_before_any_usage_does_not_end_the_warm_and_later_reports_keep_what_they_omit() {
    let http = Arc::new(WarmHttp::default());
    http.script.lock().unwrap().push_back(Reply::Sse(vec![
        first_block(),
        start_with_usage(),
        frame(serde_json::json!({ "type": "message_delta", "delta": {}, "usage": { "output_tokens": 7 } })),
        frame(serde_json::json!({ "type": "message_stop" })),
    ]));
    let (adapter, _store) = adapter_of("anthropic-oauth", &http);
    let (gate, _dir) = gate();
    let mut reports = Vec::new();
    let ctx = WarmContext { gate: &gate, target: &target("anthropic", ""), deadlines: Deadlines::DEFAULT, report: &|_| {} };
    let usage = adapter.send_cache_warm(&warm_request(), &ctx, &CancellationToken::new(), &mut |u: &crate::warmer::stream::WarmUsage| reports.push((u.cached, u.output))).await.unwrap();
    assert_eq!((usage.cached, usage.output), (9.0, 7.0));
    assert_eq!(reports, [(9.0, 0.0), (9.0, 7.0)]);
}

#[tokio::test]
async fn a_refused_warm_reaches_the_gate_with_the_providers_status_and_the_transports_own_text() {
    let refused = Reply::Status { status: 500, headers: Vec::new(), body: r#"{"type":"error","error":{"type":"api_error","message":"boom"}}"#.into() };
    for (reply, status, text) in [(refused, Some(500), None), (Reply::Throw("socket closed".into()), None, Some("socket closed"))] {
        let http = Arc::new(WarmHttp::default());
        http.script.lock().unwrap().push_back(reply);
        let (adapter, _store) = adapter_of("anthropic-oauth", &http);
        let refusals = Refusals::default();
        let ctx = WarmContext { gate: &refusals, target: &target("anthropic", ""), deadlines: Deadlines::DEFAULT, report: &|_| {} };
        let failure = adapter.send_cache_warm(&warm_request(), &ctx, &CancellationToken::new(), &mut |_| {}).await.unwrap_err();
        assert!(failure.usage.is_none());
        if let Some(text) = text {
            assert_eq!(failure.message, text);
        }
        let seen = refusals.seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!((seen[0].0.status, seen[0].1), (status, false));
    }
}

#[tokio::test]
async fn an_sse_error_before_any_usage_fails_with_no_usage_and_its_wire_status() {
    let http = Arc::new(WarmHttp::default());
    http.script.lock().unwrap().push_back(Reply::Sse(vec![frame(serde_json::json!({ "type": "error", "error": { "type": "overloaded_error", "message": "busy" } }))]));
    let (adapter, _store) = adapter_of("anthropic-oauth", &http);
    let refusals = Refusals::default();
    let ctx = WarmContext { gate: &refusals, target: &target("anthropic", ""), deadlines: Deadlines::DEFAULT, report: &|_| {} };
    let failure = adapter.send_cache_warm(&warm_request(), &ctx, &CancellationToken::new(), &mut |_| {}).await.unwrap_err();
    assert_eq!(failure.message, "Anthropic cache warm SSE error overloaded_error: busy");
    assert!(failure.usage.is_none());
    assert_eq!(refusals.seen.lock().unwrap()[0].0.status, Some(529));
}

/// The two deadlines on the virtual clock: the first byte from the start until the usage arrives, then the idle
/// window between chunks.
#[tokio::test(start_paused = true)]
async fn a_stream_that_stalls_ends_at_the_first_byte_window_before_usage_and_at_the_idle_window_after_it() {
    let deadlines = Deadlines { first_byte: std::time::Duration::from_secs(5), sse_idle: std::time::Duration::from_secs(2) };
    let (gate, _dir) = gate();
    let warm = |reply: Reply| {
        let http = Arc::new(WarmHttp::default());
        http.script.lock().unwrap().push_back(reply);
        adapter_of("anthropic-oauth", &http)
    };
    let (silent, _s1) = warm(Reply::SseThenHang(vec![b": waiting\n\n".to_vec()]));
    let ctx = WarmContext { gate: &gate, target: &target("anthropic", ""), deadlines, report: &|_| {} };
    let failure = silent.send_cache_warm(&warm_request(), &ctx, &CancellationToken::new(), &mut |_| {}).await.unwrap_err();
    assert_eq!(failure.message, "cache warm first byte timed out after 5000ms");
    assert!(failure.usage.is_none());
    let (stalled, _s2) = warm(Reply::SseThenHang(vec![start_with_usage()]));
    let failure = stalled.send_cache_warm(&warm_request(), &ctx, &CancellationToken::new(), &mut |_| {}).await.unwrap_err();
    assert_eq!(failure.message, "cache warm stream timed out after 2000ms");
    assert_eq!(failure.usage.as_ref().map(|u| u.cached), Some(9.0), "the usage the provider accepted is still accounted");
}

#[tokio::test(start_paused = true)]
async fn a_caller_abort_ends_the_warm_with_the_abort_text_carries_the_usage_and_is_not_a_refusal() {
    let http = Arc::new(WarmHttp::default());
    http.script.lock().unwrap().push_back(Reply::SseThenHang(vec![start_with_usage()]));
    let (adapter, _store) = adapter_of("anthropic-oauth", &http);
    let refusals = Refusals::default();
    let cancel = CancellationToken::new();
    let later = cancel.clone();
    tokio::spawn(async move {
        mixdog_rt::time::sleep(std::time::Duration::from_secs(1)).await;
        later.cancel();
    });
    let ctx = WarmContext { gate: &refusals, target: &target("anthropic", ""), deadlines: Deadlines::DEFAULT, report: &|_| {} };
    let failure = adapter.send_cache_warm(&warm_request(), &ctx, &cancel, &mut |_| {}).await.unwrap_err();
    assert_eq!(failure.message, "This operation was aborted");
    assert_eq!(failure.usage.as_ref().map(|u| u.cached), Some(9.0));
    assert!(refusals.seen.lock().unwrap()[0].1, "the gate is told it was an abort");
    // Aborted before the POST answers: the same text.
    let hung = Arc::new(WarmHttp::default());
    hung.script.lock().unwrap().push_back(Reply::Hang);
    let (adapter, _store) = adapter_of("anthropic-oauth", &hung);
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    let failure = adapter.send_cache_warm(&warm_request(), &ctx, &cancelled, &mut |_| {}).await.unwrap_err();
    assert_eq!(failure.message, "This operation was aborted");
}

// ---- the lane's clock: the advised wait, its extension and the recovery ------------------------
//
// The lane reads `tokio::time::Instant`, the clock the runtime's virtual clock drives, so these tests move time
// with `tokio::time::advance`. 1.4.5 (`admission-scheduler.mjs` `_recordFailure`): a 429 on an adaptive lane
// (`isAnthropicLane`) halves the limit and sets `cooldownUntil = max(cooldownUntil, now + retryAfter)`, unless the
// wait exceeds `PROVIDER_COOLDOWN_FAIL_FAST_MS` (60 s); `_recordSuccess` gives one slot back per `limit` successes up
// to the limit seen before the 429, which restores the configured one.

fn limited_for(secs: u64) -> ProviderError {
    let mut error = refusal(429);
    error.retry_after = Some(std::time::Duration::from_secs(secs));
    error
}

async fn parked(gate: &AccountGate, account: &str) -> Option<String> {
    gate.block_at(&target("anthropic", account), now_ms()).await
}

#[tokio::test(start_paused = true)]
async fn a_parked_lane_blocks_until_the_advised_wait_has_passed_and_not_after() {
    let (gate, _dir) = gate();
    gate.record_refusal(&target("anthropic", "a1"), &limited_for(20), false).await.unwrap();
    assert_eq!(parked(&gate, "a1").await.as_deref(), Some("rate-limit cooldown"));
    tokio::time::advance(std::time::Duration::from_millis(19_999)).await;
    assert_eq!(parked(&gate, "a1").await.as_deref(), Some("rate-limit cooldown"), "one millisecond short of the advised wait");
    tokio::time::advance(std::time::Duration::from_millis(1)).await;
    assert_eq!(parked(&gate, "a1").await, None, "at the advised wait the lane is free again");
}

#[tokio::test(start_paused = true)]
async fn a_second_429_during_the_wait_extends_it_to_the_later_end_and_never_shortens_it() {
    let (gate, _dir) = gate();
    // 20 s at t=0, then 15 s more advised at t=10: the later end (t=25) holds.
    gate.record_refusal(&target("anthropic", "longer"), &limited_for(20), false).await.unwrap();
    // 20 s at t=0, then only 5 s advised at t=10: the first end (t=20) holds.
    gate.record_refusal(&target("anthropic", "shorter"), &limited_for(20), false).await.unwrap();
    tokio::time::advance(std::time::Duration::from_secs(10)).await;
    gate.record_refusal(&target("anthropic", "longer"), &limited_for(15), false).await.unwrap();
    gate.record_refusal(&target("anthropic", "shorter"), &limited_for(5), false).await.unwrap();
    tokio::time::advance(std::time::Duration::from_millis(9_999)).await;
    assert!(parked(&gate, "longer").await.is_some());
    assert!(parked(&gate, "shorter").await.is_some(), "t=19.999 s");
    tokio::time::advance(std::time::Duration::from_millis(1)).await;
    assert_eq!(parked(&gate, "shorter").await, None, "t=20 s: the shorter advice did not move the end earlier");
    assert!(parked(&gate, "longer").await.is_some(), "t=20 s: the extension is still running");
    tokio::time::advance(std::time::Duration::from_millis(4_999)).await;
    assert!(parked(&gate, "longer").await.is_some(), "t=24.999 s");
    tokio::time::advance(std::time::Duration::from_millis(1)).await;
    assert_eq!(parked(&gate, "longer").await, None, "t=25 s");
}

#[tokio::test(start_paused = true)]
async fn the_halved_limit_gives_one_slot_back_per_limit_of_successes_until_the_configured_one_returns() {
    use crate::admission::{AdmissionRequest, Outcome, Priority};
    let (mut gate, _dir) = gate();
    gate.lane_settings = Arc::new(|_: &LaneKey| LaneSettings { concurrency: Some(8), adaptive: true, ..LaneSettings::default() });
    gate.record_refusal(&target("anthropic", "a1"), &limited_for(1), false).await.unwrap();
    let limit = |gate: &AccountGate| gate.admission.snapshot()[0].limit;
    assert_eq!(limit(&gate), Some(4), "the limit of 8 is halved");
    tokio::time::advance(std::time::Duration::from_secs(1)).await;
    let lane = gate.admission.lane(&LaneKey::new(ProviderId::from("anthropic"), "a1"), (gate.lane_settings)(&LaneKey::new(ProviderId::from("anthropic"), "a1")));
    let cancel = CancellationToken::new();
    let mut succeeded = 0;
    // At limit L, L successes add a slot: 4 -> 5 -> 6 -> 7, then 7 more restore the configured 8.
    for (after, want) in [(3, Some(4)), (4, Some(5)), (8, Some(5)), (9, Some(6)), (14, Some(6)), (15, Some(7)), (21, Some(7)), (22, Some(8))] {
        while succeeded < after {
            let request = AdmissionRequest { owner: Arc::from("warm-test"), priority: Priority::default(), on_cooldown_wait: None, liveness: None };
            gate.admission.acquire(&lane, request, &cancel).await.unwrap().finish(Outcome::Success);
            succeeded += 1;
        }
        assert_eq!(limit(&gate), want, "after {after} successes");
    }
}

struct Redirected;

#[async_trait]
impl crate::warmer::gate::PlanScope for Redirected {
    async fn plan_meters_apply(&self, _: &str) -> bool {
        false
    }
}

/// A warm judges the plan meters against the destination as a send does: a full meter stops a warm to the plan's own
/// service, and an unproven destination borrows none.
#[tokio::test]
async fn a_full_plan_meter_stops_a_warm_only_where_it_describes_the_destination() {
    const ID: &str = "11111111-1111-4111-8111-111111111111";
    let (mut gate, _dir) = gate();
    gate.store.register("anthropic-oauth", ID, "A", false).await.unwrap();
    let full = QuotaWindowInput { label: "5H".into(), used_pct: Some(100.0), reset_at: Some(now_ms() + 3_600_000), ..QuotaWindowInput::default() };
    gate.store.record_usage("anthropic-oauth", ID, vec![full]).await.unwrap();
    assert_eq!(gate.block_at(&target("anthropic-oauth", ID), now_ms()).await.as_deref(), Some("account blocked or quota exhausted"));
    gate.scope = Arc::new(Redirected);
    assert_eq!(gate.block_at(&target("anthropic-oauth", ID), now_ms()).await, None);
}

#[tokio::test]
async fn a_429_on_a_lane_that_is_not_adaptive_parks_nothing_and_the_lanes_check_alone_answers() {
    let (mut gate, _dir) = gate();
    // The lane rule of a send: only Anthropic's lanes are adaptive. `openai` is outside the roster providers, so the
    // gate's lane check is the only thing that could ever answer for it.
    gate.lane_settings = crate::admission::provider_lane_settings(None);
    gate.record_refusal(&target("openai", "a1"), &limited_for(20), false).await.unwrap();
    assert_eq!(gate.block_at(&target("openai", "a1"), now_ms()).await, None);
    assert_eq!(gate.admission.snapshot()[0].limit, None, "the lane was not throttled either");
    gate.record_refusal(&target("anthropic", "a1"), &limited_for(20), false).await.unwrap();
    assert_eq!(gate.block_at(&target("anthropic", "a1"), now_ms()).await.as_deref(), Some("rate-limit cooldown"));
}
