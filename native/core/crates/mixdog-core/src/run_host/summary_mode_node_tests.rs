//! `summary-mode.test.mjs` after :157: Node's recorded answers (`fixtures/summary-mode-routing/golden.json`,
//! `benchmarks/rust-core/recorders/record-summary-mode-routing.mjs`) against the core's own summary plan of a session:
//! the side-question store's saved request captured through the run's send tap (`SideRequests`), the session's
//! summary plan as the run host wires it (`SessionCompactors` over `PlannedHandoff::for_session`), its routes resolved
//! by `SummaryRoutes` over the process's summary host (Maintainer route, saved catalogs, window, calibration) and the
//! summary written by `PlannedHandoff::summarize`. The test's fake providers are scripted adapters answering by the
//! recorded JSON rule; their sends run through the one-shot request (no retry, as the fakes have none) and the
//! saved request's fork. Node's `initProvidersFn` is the host's provider readiness.

use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_agent::boundary::CompactSettings;
use mixdog_agent::compact::compactor::{HandoffSource, PlannedHandoff};
use mixdog_agent::compact::summary_run::{
    ForkSource, RouteStep, SummaryFailure, SummaryMode, SummaryResponse, SummaryRoute, SummarySender, plan_steps, route_failure,
};
use mixdog_agent::env::{Clock, CompactError};
use mixdog_agent::one_shot::OneShot;
use mixdog_agent::response::ModelResponse;
use mixdog_agent::tools::ToolEnv;
use mixdog_ai::catalog::{CatalogService, CatalogSnapshot, ModelsDevSource};
use mixdog_ai::oauth::CredentialIo;
use mixdog_ai::registry::providers::{ProviderBuilder, ProviderRegistry};
use mixdog_ai::service::routes::lighter_subscription_model;
use mixdog_ai::transport::http::{HttpResponse, HttpSend};
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::mock::{MockCodec, MockFileService, MockProcessManager, MockProgress};
use mixdog_core_api::domain::provider::{
    Content, DeliveryState, ErrorKind, ErrorResponse, Message, ModelListing, ModelRecord, ModelRequest, ModelStream, ProviderAdapter,
    ProviderError, RequestOptions, Role, StopReason, StreamEvent, WireCodec, WireRequest,
};
use mixdog_core_api::domain::retry::{Decision, JitterSamples, RetryDecider, RetryPolicy, RetryState, Verdict};
use mixdog_core_api::domain::tool::SurfaceKind;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_session::session::StoredRows;
use mixdog_protocol::{ProviderId, TurnId};
use mixdog_rt::CancellationToken;
use mixdog_store::schema::record::Header;
use serde_json::{Map, Value, json};

use super::compaction_node_harness::{NoStore, World, io, session_summary};
use super::message_row::message_of;
use super::retry::{RandomJitter, TimerWait};
use super::side_question_store::SideQuestionStore;
use super::side_requests::{RunSide, SideRequests};
use super::summary_host::{NoApprovals, SummaryDeps, SummaryServices};
use super::summary_routes::{ForkSender, MaintainerRoute, SessionFork, SessionRoute, SummaryHost};

const GOLDEN: &str = include_str!("../../../../fixtures/summary-mode-routing/golden.json");

/// Recorded cases the core does not reproduce; each is a reported difference, not replayed.
const DIFFERENCES: &[(&str, &str)] = &[];

struct At(AtomicI64);
impl Clock for At {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}
impl At {
    fn set(&self, at: &Value) {
        self.0.store(at.as_f64().unwrap() as i64, Ordering::SeqCst);
    }
}

/// Each send of a case in order: `{ provider, model, kind }`.
type Sends = Arc<Mutex<Vec<Value>>>;

/// One of the test's fake providers: its reply is `rule.byCall[n]`, else `rule.byModel[model]`, else `rule.reply`.
struct Fake {
    id: ProviderId,
    spec: Value,
    calls: AtomicU32,
    listed: AtomicU32,
    sends: Sends,
    forking: Arc<AtomicBool>,
    policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
}

impl Fake {
    fn new(spec: &Value, sends: &Sends, forking: &Arc<AtomicBool>) -> Arc<Self> {
        Arc::new(Self {
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            id: ProviderId::from(spec["name"].as_str().unwrap()),
            spec: spec.clone(),
            calls: AtomicU32::new(0),
            listed: AtomicU32::new(0),
            sends: sends.clone(),
            forking: forking.clone(),
        })
    }
    fn name(&self) -> &str {
        self.spec["name"].as_str().unwrap()
    }
}

struct Events(VecDeque<Result<StreamEvent, ProviderError>>);
#[async_trait]
impl ModelStream for Events {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
        self.0.pop_front()
    }
    fn delivery(&self) -> DeliveryState {
        DeliveryState::Accepted
    }
    fn on_wire_left(&mut self, _left: std::sync::Arc<dyn Fn() + Send + Sync>) {}
}

#[async_trait]
impl ModelListing for Fake {
    async fn list_models(&self) -> Result<Vec<ModelRecord>, ProviderError> {
        self.listed.fetch_add(1, Ordering::SeqCst);
        Ok(Vec::new())
    }
}

#[async_trait]
impl ProviderAdapter for Fake {
    fn id(&self) -> &ProviderId {
        &self.id
    }
    fn codec(&self) -> &dyn WireCodec {
        &MockCodec
    }
    fn retry_policy(&self) -> &RetryPolicy {
        &self.policy
    }
    fn keepalive(&self) -> &KeepaliveSchedule {
        &self.keepalive
    }
    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        let n = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        let kind = if self.forking.load(Ordering::SeqCst) { "fork" } else { "isolated" };
        self.sends.lock().unwrap().push(json!({ "provider": self.name(), "model": request.model, "kind": kind }));
        let rule = &self.spec["rule"];
        let reply = [&rule["byCall"][n.to_string()], &rule["byModel"][&request.model], &rule["reply"]].into_iter().find(|r| !r.is_null()).unwrap();
        if let Some(text) = reply["content"].as_str() {
            let done = StreamEvent::Completed { pricing_model: None, request_ms: None, stop: Some(StopReason::EndTurn) };
            return Ok(Box::new(Events(VecDeque::from([Ok(StreamEvent::TextDelta(text.to_owned())), Ok(done)]))));
        }
        let mut error = match reply["status"].as_u64() {
            Some(status) => MockCodec.classify(&ErrorResponse { status: Some(status as u16), headers: Vec::new(), body: Vec::new() }),
            None => ProviderError::new(ErrorKind::Unknown, DeliveryState::Accepted),
        };
        error.message = reply["message"].as_str().unwrap().to_owned();
        error.code = reply["code"].as_str().map(str::to_owned);
        Err(error)
    }
    fn models(&self) -> Option<&dyn ModelListing> {
        Some(self)
    }
}

/// The fakes answer each send once: no retry layer.
struct NoRetry;
impl RetryDecider for NoRetry {
    fn verdict(&self, error: &ProviderError, state: &RetryState, _: &RetryPolicy, _: JitterSamples) -> Decision {
        Decision { verdict: Verdict::Surface, next: state.after_failure(error.kind) }
    }
}

/// The saved request's fork, its sends marked as the fork's.
struct Forking {
    inner: Arc<dyn ForkSender>,
    flag: Arc<AtomicBool>,
}
#[async_trait]
impl ForkSender for Forking {
    async fn send(&self, route: &SummaryRoute) -> Result<SummaryResponse, SummaryFailure> {
        self.flag.store(true, Ordering::SeqCst);
        let sent = self.inner.send(route).await;
        self.flag.store(false, Ordering::SeqCst);
        sent
    }
}

struct NoBuilder;
#[async_trait]
impl ProviderBuilder for NoBuilder {
    async fn build(&self, name: &str, _: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
        Err(format!("no registry provider in this replay: {name}"))
    }
    async fn custom_key_ids(&self, _: &str) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
    fn available(&self, _: &str) -> bool {
        true
    }
    async fn oauth_credentials_usable(&self, _: &str) -> Result<bool, String> {
        Ok(false)
    }
}

struct Offline;
#[async_trait]
impl HttpSend for Offline {
    async fn send(&self, _: WireRequest, _: mixdog_ai::transport::Exchange) -> Result<HttpResponse, ProviderError> {
        Err(ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent))
    }
}

/// The process's summary host over `dir` (the saved catalogs) and the agent `config`, bound to the session `header`.
async fn process_host(dir: &Path, config: &Value, clock: Arc<At>, thread: &str, header: &Header) -> Arc<dyn SummaryHost> {
    let tokens = mixdog_rt::testing::tokens();
    let credentials = || CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let metadata = ModelsDevSource::new(Arc::new(Offline), dir.to_path_buf(), credentials());
    let agent: Map<String, Value> = mixdog_core_config::config::agent_routes::stored_file_of(config)["agent"].as_object().cloned().unwrap_or_default();
    SummaryServices::new(SummaryDeps {
        registry: Arc::new(ProviderRegistry::new(Arc::new(NoBuilder))),
        catalog: Arc::new(CatalogService::cold_start(CatalogSnapshot::default(), Vec::new(), metadata).await),
        config: Arc::new(move || agent.clone()),
        env: Arc::new(|_| None),
        clock,
        data_dir: AbsPath::new(dir).unwrap(),
        files: Arc::new(MockFileService::default()),
        processes: Arc::new(MockProcessManager::default()),
        progress: Arc::new(MockProgress::default()),
        io: io(),
    })
    .host(&ThreadId::from(thread), header)
}

/// The summary host of one case: the process's, with the test's fakes as the providers (Node's `getProviderFn`
/// answers the Maintainer's name with its fake and every other name with the conversation's) and its
/// `initProvidersFn` as their readiness.
struct Host {
    process: Arc<dyn SummaryHost>,
    main: Arc<Fake>,
    maintenance: Option<Arc<Fake>>,
    init: Value,
    clock: Arc<At>,
    dir: std::path::PathBuf,
}

impl Host {
    fn fake(&self, provider: &str) -> Arc<Fake> {
        self.maintenance.clone().filter(|m| m.name() == provider).unwrap_or_else(|| self.main.clone())
    }
}

#[async_trait]
impl SummaryHost for Host {
    fn session(&self) -> SessionRoute {
        self.process.session()
    }
    fn maintainer_route(&self) -> Option<MaintainerRoute> {
        self.process.maintainer_route()
    }
    async fn provider_ready(&self, _: &str, init: bool) -> Result<bool, SummaryFailure> {
        match &self.init {
            _ if !init => Ok(true),
            Value::Null => Ok(true),
            init if init["abort"] == json!(true) => Err(SummaryFailure::Aborted),
            init => {
                let failure = &init["failure"];
                let status = failure["status"].as_u64().map(|s| s as u16);
                Err(route_failure(failure["message"].as_str().unwrap().to_owned(), failure["code"].as_str(), status, false))
            }
        }
    }
    fn whole_window(&self, provider: &str, model: &str) -> u64 {
        self.process.whole_window(provider, model)
    }
    fn calibration(&self, provider: &str, model: &str) -> f64 {
        self.process.calibration(provider, model)
    }
    fn sender(&self, provider: &str) -> Arc<dyn SummarySender> {
        let clock: Arc<dyn Clock> = self.clock.clone();
        let tool_env = ToolEnv {
            thread_id: ThreadId::from("summary"),
            turn_id: TurnId::from("compact"),
            cwd: AbsPath::new(&self.dir).unwrap(),
            surface: SurfaceKind::Lead,
            io: io(),
            approvals: Arc::new(NoApprovals(clock.clone())),
            files: Arc::new(MockFileService::default()),
            processes: Arc::new(MockProcessManager::default()),
            progress: Arc::new(MockProgress::default()),
            deadline_of: None,
            notify: None,
            review: None,
        };
        Arc::new(OneShot::standalone(clock, Arc::new(RandomJitter), Arc::new(TimerWait), Arc::new(NoRetry), tool_env, self.fake(provider), CancellationToken::new()))
    }
    async fn saved_catalog(&self, provider: &str) -> Option<Vec<Value>> {
        self.process.saved_catalog(provider).await
    }
}

/// The saved catalog files as the query found them.
fn write_catalogs(dir: &Path, catalogs: &Value) {
    for (file, text) in catalogs.as_object().unwrap() {
        let path = dir.join(file);
        match text.as_str() {
            Some(text) => crate::run_host::fixture_fs::write(&path, text.as_bytes().to_vec()),
            None => {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
}

fn role(name: &str) -> Role {
    match name {
        "system" => Role::System,
        "assistant" => Role::Assistant,
        _ => Role::User,
    }
}

/// `captureMain`: the session's request sent through the run's send tap at its recorded time, then settled.
fn capture(store: &Arc<SideQuestionStore>, clock: &Arc<At>, thread: &str, capture: &Value, provider: Arc<Fake>, conversation: &[Value]) {
    let caching = capture["provider"]["info"]["supportsPromptCaching"] == json!(true);
    let side = SideRequests {
        store: store.clone(),
        caching: Arc::new(move |_, _| caching),
        docs: Arc::new(NoStore),
        reader: Arc::new(NoStore),
        facts: Arc::new(NoStore),
        clock: clock.clone(),
    };
    let request = ModelRequest {
        model: "main-model".into(),
        messages: conversation.iter().map(|m| Message::new(role(m["role"].as_str().unwrap()), Content::Text(m["content"].as_str().unwrap().to_owned()))).collect(),
        tools: Vec::new(),
        options: RequestOptions {
            session_id: Some(thread.to_owned()),
            model_parameters: Some(json!({ "cacheStrategy": capture["cacheStrategy"] })),
            ..RequestOptions::default()
        },
    };
    clock.set(&capture["sentAt"]);
    let run = RunSide { thread: ThreadId::from(thread), provider_name: capture["provider"]["name"].as_str().unwrap().to_owned(), provider, agent_owner: false };
    side.tap(run).begin(&request).settle(&ModelResponse { content: "ok".into(), ..ModelResponse::default() });
}

fn step_name(step: RouteStep) -> &'static str {
    match step {
        RouteStep::Session => "session",
        RouteStep::Maintainer => "maintenance",
        RouteStep::Lighter => "lighter",
    }
}

fn mode_name(mode: SummaryMode) -> &'static str {
    match mode {
        SummaryMode::Smart => "smart",
        SummaryMode::Maintainer => "maintainer",
        SummaryMode::Session => "self",
    }
}

/// One case's session: its fakes, its saved request and the summary plan of its compactor.
struct Case {
    summary: PlannedHandoff,
    main: Arc<Fake>,
    sends: Sends,
    rows: Arc<StoredRows>,
}

async fn case(dir: &Path, c: &Value, conversation: &[Value]) -> Case {
    let sends: Sends = Arc::default();
    let forking = Arc::new(AtomicBool::new(false));
    let clock = Arc::new(At(AtomicI64::new(0)));
    let thread = c["sessionId"].as_str().unwrap();
    let main = Fake::new(&c["provider"], &sends, &forking);
    let maintenance = (!c["maintenance"].is_null()).then(|| Fake::new(&c["maintenance"], &sends, &forking));
    let store = Arc::new(SideQuestionStore::new());
    if !c["capture"].is_null() {
        // The request was sent by the conversation's fake that captured it.
        let captured = if c["capture"]["provider"] == c["provider"] { main.clone() } else { Fake::new(&c["capture"]["provider"], &sends, &forking) };
        capture(&store, &clock, thread, &c["capture"], captured, conversation);
    }
    write_catalogs(dir, &c["catalogs"]);
    clock.set(&c["now"]);
    let Value::Object(header) = json!({
        "provider": c["provider"]["name"], "model": c["model"], "contextWindow": 200_000,
        "compaction": { "conversationThresholdTokens": 1 },
    }) else {
        unreachable!()
    };
    let process = process_host(dir, &c["config"], clock.clone(), thread, &header).await;
    let host = Arc::new(Host { process, main: main.clone(), maintenance, init: c["init"].clone(), clock: clock.clone(), dir: dir.to_path_buf() });
    let world = World {
        provider: c["provider"]["name"].as_str().unwrap().to_owned(),
        summary: host,
        compaction: c["config"].get("compaction").cloned(),
        saved_request: store.saved_request(&ThreadId::from(thread)),
        fork_sender: Arc::new(Forking { inner: store.fork_sender(&ThreadId::from(thread)), flag: forking }),
    };
    let rows = Arc::new(StoredRows::new());
    let settings = CompactSettings { context_window: Some(200_000), token_calibration: 1.0, ..CompactSettings::default() };
    let summary = session_summary(world, clock, thread, &header, settings, rows.clone(), dir).await;
    Case { summary, main, sends, rows }
}

#[tokio::test]
async fn the_cache_is_warm_as_in_node() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let conversation = golden["conversation"].as_array().unwrap();
    for query in golden["warm"].as_array().unwrap() {
        let clock = Arc::new(At(AtomicI64::new(0)));
        let store = Arc::new(SideQuestionStore::new());
        let thread = query["sessionId"].as_str().unwrap();
        if !query["capture"].is_null() {
            let fake = Fake::new(&query["capture"]["provider"], &Sends::default(), &Arc::default());
            capture(&store, &clock, thread, &query["capture"], fake, conversation);
        }
        clock.set(&query["now"]);
        let thread_id = ThreadId::from(thread);
        let fork = SessionFork::new(store.saved_request(&thread_id), clock, store.fork_sender(&thread_id));
        assert_eq!(json!(fork.warm()), query["warm"], "{thread}");
    }
    assert_eq!(golden["warm"].as_array().unwrap().len(), 12);
}

#[tokio::test]
async fn the_lighter_model_is_read_from_the_saved_catalog_as_in_node() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let dir = tempfile::tempdir().unwrap();
    for query in golden["lighter"].as_array().unwrap() {
        write_catalogs(dir.path(), &query["catalogs"]);
        let clock = Arc::new(At(AtomicI64::new(0)));
        clock.set(&query["now"]);
        let provider = query["provider"].as_str().unwrap();
        let host = process_host(dir.path(), &json!({}), clock, "lighter", &Header::new()).await;
        let catalog = host.saved_catalog(provider).await.unwrap_or_default();
        assert_eq!(json!(lighter_subscription_model(provider, &catalog)), query["model"], "{query}");
    }
    assert_eq!(golden["lighter"].as_array().unwrap().len(), 11);
}

#[tokio::test]
async fn the_summary_plans_equal_node() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let conversation = golden["conversation"].as_array().unwrap();
    let dir = tempfile::tempdir().unwrap();
    for plan in golden["plans"].as_array().unwrap() {
        let case = case(dir.path(), plan, conversation).await;
        let summary = &case.summary;
        let warm = summary.fork.warm();
        let steps = plan_steps(summary.config.mode, warm);
        let mut first = Value::Null;
        for step in &steps {
            if let Some(route) = summary.resolver.resolve(*step).await.expect("a route resolves") {
                first = json!({ "source": step_name(route.step), "provider": route.provider_name, "model": route.model });
                break;
            }
        }
        let got = json!({
            "mode": mode_name(summary.config.mode), "warm": warm, "steps": steps.len(), "first": first,
            "listed": case.main.listed.load(Ordering::SeqCst),
        });
        assert_eq!(got, plan["out"], "{} {}", plan["test"], plan["sessionId"]);
    }
    assert_eq!(golden["plans"].as_array().unwrap().len(), 15);
}

#[tokio::test]
async fn the_compactions_equal_node() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let conversation = golden["conversation"].as_array().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let mut replayed = 0;
    let mut differing: HashMap<&str, usize> = HashMap::new();
    for compact in golden["compacts"].as_array().unwrap() {
        let test = compact["test"].as_str().unwrap();
        let case = case(dir.path(), compact, conversation).await;
        let messages: Vec<_> = conversation
            .iter()
            .map(|row| {
                let message = message_of(row).unwrap();
                case.rows.record(&message, row.clone());
                message
            })
            .collect();
        assert!(case.summary.triggered(&messages).await, "the conversation reaches its threshold of 1 token");
        let warm = case.summary.fork.warm();
        let mut got = match case.summary.summarize(&messages, 50_000).await {
            Ok((step, generated)) => json!({ "ok": {
                "summaryModel": case.sends.lock().unwrap().last().map(|s| s["model"].clone()),
                "summaryRoute": step_name(step), "cacheWarm": warm, "mode": generated.mode,
                "sharedPrefixFallback": generated.shared_prefix_fallback,
            }}),
            Err(CompactError::Aborted) => json!({ "error": { "message": null, "aborted": true, "compactRoute": null } }),
            Err(CompactError::Failed(message) | CompactError::Overflow(message)) => {
                json!({ "error": { "message": message, "aborted": false, "compactRoute": null } })
            }
            Err(CompactError::RouteFailed(message, route)) => {
                json!({ "error": { "message": message, "aborted": false, "compactRoute": { "provider": route.provider, "model": route.model } } })
            }
        };
        got["calls"] = Value::Array(case.sends.lock().unwrap().clone());
        let mut want = compact["out"].clone();
        // The abort's reason is the test's own input: only that the compaction was cancelled is compared.
        if want["error"]["aborted"] == json!(true) {
            want["error"]["message"] = Value::Null;
        }
        if DIFFERENCES.iter().any(|(t, _)| *t == test) {
            *differing.entry(test).or_default() += 1;
            continue;
        }
        assert_eq!(got, want, "{test} {}", compact["sessionId"]);
        replayed += 1;
    }
    assert_eq!((replayed, differing.values().sum::<usize>()), (11, 0));
}
