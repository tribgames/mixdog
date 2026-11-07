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
use crate::accounts::{AccountStore, BlockOptions, QuotaWindowInput};
use crate::admission::{Admission, Block, LaneKey, LaneSettings};
use crate::oauth::pace::SystemPace;
use crate::warmer::gate::{AccountGate, GateTarget, ProviderSwitch, QuotaResumes, UsageSnapshots, WarmGate};
use crate::warmer::send::{Deadlines, WarmContext};
use crate::warmer::stream::WarmUsage;

fn golden() -> Value {
    serde_json::from_str(include_str!("../../../../../../fixtures/cache-warm-send/golden.json")).unwrap()
}

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

fn chunks_of(spec: &Value) -> Vec<Vec<u8>> {
    spec["chunks"].as_array().unwrap().iter().map(|c| c.as_str().unwrap().as_bytes().to_vec()).collect()
}

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
    async fn send(&self, request: WireRequest) -> Result<HttpResponse, ProviderError> {
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
        now_ms: Arc::new(now_ms),
    };
    (gate, dir)
}

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

fn usage_fields(usage: &WarmUsage) -> Value {
    serde_json::json!({ "cachedTokens": usage.cached, "inputTokens": usage.input, "outputTokens": usage.output, "cacheWriteTokens": usage.cache_write })
}

fn recorded_fields(usage: &Value) -> Value {
    let n = |key: &str| usage.get(key).and_then(Value::as_f64).unwrap_or(0.0);
    serde_json::json!({ "cachedTokens": n("cachedTokens"), "inputTokens": n("inputTokens"), "outputTokens": n("outputTokens"), "cacheWriteTokens": n("cacheWriteTokens") })
}

fn warm_request() -> ModelRequest {
    let mut request = request(base_messages(), RequestOptions::default());
    request.options.max_output_tokens_override = Some(1);
    request
}

fn recorded_deadlines(golden: &Value) -> Deadlines {
    let ms = |key: &str| std::time::Duration::from_millis(golden["deadlines"][key].as_u64().unwrap());
    Deadlines { first_byte: ms("firstByteMs"), sse_idle: ms("sseIdleMs") }
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

/// Replays the recorded sends whose `timed` flag is `timed` and returns what differs from Node.
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
                    tokio::time::sleep(std::time::Duration::from_millis(after)).await;
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_recorded_warm_send_ends_as_nodes_does() {
    let rows = golden()["sends"].as_array().unwrap().iter().filter(|r| r["timed"] == false).count();
    assert_eq!(rows, 16);
    let failures = replay(false).await;
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// The recorded deadlines and caller aborts, on the paused clock.
#[tokio::test(start_paused = true)]
async fn every_recorded_deadline_and_abort_ends_as_nodes_does() {
    let rows = golden()["sends"].as_array().unwrap().iter().filter(|r| r["timed"] == true).count();
    assert_eq!(rows, 4);
    let failures = replay(true).await;
    assert!(failures.is_empty(), "{}", failures.join("\n"));
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

impl crate::registry::accounting::UsagePricing for NoPrice {
    fn price_usage(&self, _: &crate::catalog::UsageArgs) -> crate::catalog::PricedUsage {
        unreachable!("a warm is not priced by the wrapper")
    }
}

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
    let ctx = WarmContext { gate: &gate, target: &target("anthropic-oauth", ""), deadlines: Deadlines::DEFAULT, report: &|_| {} };
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
        async fn send(&self, _: WireRequest) -> Result<HttpResponse, ProviderError> {
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