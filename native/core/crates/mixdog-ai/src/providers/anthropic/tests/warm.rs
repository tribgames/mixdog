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
#[cfg(node_twin)]
use crate::accounts::BlockOptions;
use crate::accounts::QuotaWindowInput;
use crate::admission::{Admission, LaneKey, LaneSettings};
#[cfg(node_twin)]
use crate::admission::Block;
use crate::oauth::pace::SystemPace;
use crate::warmer::gate::{AccountGate, GateTarget, ProviderSwitch, QuotaResumes, UsageSnapshots, WarmGate};
use crate::warmer::send::{Deadlines, WarmContext};
#[cfg(node_twin)]
use crate::warmer::stream::WarmUsage;

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

#[cfg(node_twin)]
fn chunks_of(spec: &Value) -> Vec<Vec<u8>> {
    spec["chunks"].as_array().unwrap().iter().map(|c| c.as_str().unwrap().as_bytes().to_vec()).collect()
}

#[cfg(node_twin)]
fn reply_of(spec: &Value) -> Reply {
    match spec["kind"].as_str().unwrap() {
        "sse" => Reply::Sse(chunks_of(spec)),
        "sse-hang" => Reply::SseThenHang(chunks_of(spec)),
        "hang" => Reply::Hang,
        "status" => Reply::Status {
            status: spec["status"].as_u64().unwrap() as u16,
            headers: spec["headers"].as_object().into_iter().flatten().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())).collect(),
            body: spec["body"].as_str().unwrap_or_default().to_owned(),
        },
        _ => Reply::Throw(spec["message"].as_str().unwrap().to_owned()),
    }
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

#[cfg(node_twin)]
/// Adds the recorded roster in its order.
async fn build_roster(gate: &AccountGate, roster: &Value) {
    for row in roster.as_array().unwrap() {
        let id = account_of(row["ref"].as_str().unwrap());
        gate.store.register("anthropic-oauth", &id, "", false).await.unwrap();
        if let Some(usage) = row.get("usage").filter(|u| !u.is_null()) {
            let windows = usage["quotaWindows"]
                .as_array()
                .unwrap()
                .iter()
                .map(|w| QuotaWindowInput {
                    label: w["label"].as_str().unwrap().to_owned(),
                    used_pct: w["usedPct"].as_f64(),
                    reset_at: w.get("resetAt").map(|_| now_ms() + 3_600_000),
                    ..QuotaWindowInput::default()
                })
                .collect();
            gate.store.record_usage("anthropic-oauth", &id, windows).await.unwrap();
        }
        if let Some(ms) = row["blockMs"].as_i64() {
            let options = BlockOptions { server_scheduled: true, ..BlockOptions::default() };
            gate.store.block("anthropic-oauth", &id, now_ms() + ms, "", options).await.unwrap();
        }
    }
}

#[cfg(node_twin)]
fn account_of(reference: &str) -> String {
    match reference {
        "" => String::new(),
        "nobody" => "nobody".to_owned(),
        // A v4-shaped id per recorded name.
        other => format!("00000000-0000-4000-8000-{:012x}", other.bytes().fold(7u64, |h, b| h.wrapping_mul(131).wrapping_add(u64::from(b))) & 0xffff_ffff_ffff),
    }
}

fn target(provider: &str, account: &str) -> GateTarget {
    GateTarget { provider: provider.to_owned(), account_id: account.to_owned(), model: "claude-opus-4-7".into(), session_id: String::new() }
}

#[cfg(node_twin)]
fn usage_fields(usage: &WarmUsage) -> Value {
    serde_json::json!({ "cachedTokens": usage.cached, "inputTokens": usage.input, "outputTokens": usage.output, "cacheWriteTokens": usage.cache_write })
}

#[cfg(node_twin)]
fn recorded_fields(usage: &Value) -> Value {
    let n = |key: &str| usage.get(key).and_then(Value::as_f64).unwrap_or(0.0);
    serde_json::json!({ "cachedTokens": n("cachedTokens"), "inputTokens": n("inputTokens"), "outputTokens": n("outputTokens"), "cacheWriteTokens": n("cacheWriteTokens") })
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


#[cfg(node_twin)]
fn golden() -> Value {
    serde_json::from_str(include_str!("../../../../../../fixtures/cache-warm-send/golden.json")).unwrap()
}
#[cfg(node_twin)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_account_gate_answers_as_nodes_does_for_every_recorded_case() {
    let golden = golden();
    let (gate, _dir) = gate();
    let rows = golden["gate"].as_array().unwrap();
    assert_eq!(rows.len(), 9);
    for (index, row) in rows.iter().enumerate() {
        if index == 2 {
            build_roster(&gate, &golden["roster"]).await;
        }
        let account = account_of(row["ref"].as_str().unwrap());
        let now = now_ms() + row["nowPlusMs"].as_i64().unwrap();
        let got = gate.block_at(&target(row["provider"].as_str().unwrap(), &account), now).await;
        assert_eq!(got.as_deref(), row["reason"].as_str(), "{}", row["name"]);
    }
}
#[cfg(node_twin)]
fn recorded_deadlines(golden: &Value) -> Deadlines {
    let ms = |key: &str| std::time::Duration::from_millis(golden["deadlines"][key].as_u64().unwrap());
    Deadlines { first_byte: ms("firstByteMs"), sse_idle: ms("sseIdleMs") }
}
/// Replays the recorded sends whose `timed` flag is `timed` and returns what differs from Node.
#[cfg(node_twin)]
async fn replay(timed: bool) -> Vec<String> {
    let golden = golden();
    let deadlines = recorded_deadlines(&golden);
    let (gate, _dir) = gate();
    build_roster(&gate, &golden["roster"]).await;
    let mut failures = Vec::new();
    for row in golden["sends"].as_array().unwrap().iter().filter(|r| r["timed"] == timed) {
        let name = row["name"].as_str().unwrap();
        let provider = row["provider"].as_str().unwrap();
        let account = account_of(row["ref"].as_str().unwrap());
        let http = Arc::new(WarmHttp::default());
        let (adapter, _store) = adapter_of(provider, &http);
        // A lane of its own per scenario: Node opened a fresh instance for each.
        let target = target(provider, &account);
        let scenario_gate = AccountGate {
            admission: Arc::new(Admission::new()),
            lane_settings: gate.lane_settings.clone(),
            store: gate.store.clone(),
            rotation: gate.rotation.clone(),
            switch: gate.switch.clone(),
            resumes: gate.resumes.clone(),
            snapshots: gate.snapshots.clone(),
            scope: gate.scope.clone(),
            now_ms: gate.now_ms.clone(),
        };
        for (i, run) in row["runs"].as_array().unwrap().iter().enumerate() {
            let responses = row["responses"].as_array().unwrap();
            http.script.lock().unwrap().push_back(reply_of(&responses[i.min(responses.len() - 1)]));
            let cancel = CancellationToken::new();
            if row["aborted"] == true {
                cancel.cancel();
            }
            if let Some(after) = row["abortAfterMs"].as_u64().filter(|ms| *ms > 0) {
                let later = cancel.clone();
                tokio::spawn(async move {
                    mixdog_rt::time::sleep(std::time::Duration::from_millis(after)).await;
                    later.cancel();
                });
            }
            let mut reports = Vec::new();
            let got = adapter
                .send_cache_warm(&warm_request(), &WarmContext { gate: &scenario_gate, target: &target, deadlines, report: &|_| {} }, &cancel, &mut |u| reports.push(usage_fields(u)))
                .await;
            let want_reports: Vec<Value> = run["reports"].as_array().unwrap().iter().map(recorded_fields).collect();
            if reports != want_reports {
                failures.push(format!("{name}[{i}]: reports {reports:?} want {want_reports:?}"));
            }
            match (&got, run.get("error")) {
                (Ok(usage), None) => {
                    if usage_fields(usage) != recorded_fields(&run["usage"]) {
                        failures.push(format!("{name}[{i}]: usage {usage:?}"));
                    }
                }
                (Err(failure), Some(error)) => {
                    if failure.message != error["message"].as_str().unwrap() {
                        failures.push(format!("{name}[{i}]: message\n got {}\nwant {}", failure.message, error["message"]));
                    }
                    let carried = failure.usage.as_ref().map_or(Value::Null, usage_fields);
                    let want = if error["usage"].is_null() { Value::Null } else { recorded_fields(&error["usage"]) };
                    if carried != want {
                        failures.push(format!("{name}[{i}]: usage carried {carried} want {want}"));
                    }
                    // What the lane and roster judge a refusal by.
                    let status = failure.error.as_ref().and_then(|e| e.status).map(u64::from);
                    if status != error["status"].as_u64() {
                        failures.push(format!("{name}[{i}]: status {status:?} want {}", error["status"]));
                    }
                    if let Some(kind) = error["providerErrorType"].as_str() {
                        let code = failure.error.as_ref().and_then(|e| e.code.as_deref());
                        if code != Some(kind) {
                            failures.push(format!("{name}[{i}]: error type {code:?} want {kind}"));
                        }
                    }
                }
                _ => failures.push(format!("{name}[{i}]: outcome {got:?} want {run}")),
            }
            let lane = scenario_gate.admission.lane(&LaneKey::new(ProviderId::from(provider), if account.is_empty() { "default" } else { account.as_str() }), (scenario_gate.lane_settings)(&LaneKey::new(ProviderId::from(provider), "x")));
            let block = match scenario_gate.admission.immediate_block(&lane) {
                Some(Block::Cooldown) => Some("rate-limit cooldown"),
                Some(Block::Throttled) => Some("account throttled"),
                None => None,
            };
            if block != run["laneBlock"].as_str() {
                failures.push(format!("{name}[{i}]: lane {block:?} want {}", run["laneBlock"]));
            }
        }
        let posts = http.sent.lock().unwrap().len();
        if posts as u64 != row["posts"].as_u64().unwrap() {
            failures.push(format!("{name}: {posts} POSTs, want {}", row["posts"]));
        }
    }
    failures
}
#[cfg(node_twin)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_recorded_warm_send_ends_as_nodes_does() {
    let rows = golden()["sends"].as_array().unwrap().iter().filter(|r| r["timed"] == false).count();
    assert_eq!(rows, 16);
    let failures = replay(false).await;
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
/// The recorded deadlines and caller aborts, on the paused clock.
#[cfg(node_twin)]
#[tokio::test(start_paused = true)]
async fn every_recorded_deadline_and_abort_ends_as_nodes_does() {
    let rows = golden()["sends"].as_array().unwrap().iter().filter(|r| r["timed"] == true).count();
    assert_eq!(rows, 4);
    let failures = replay(true).await;
    assert!(failures.is_empty(), "{}", failures.join("\n"));
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
