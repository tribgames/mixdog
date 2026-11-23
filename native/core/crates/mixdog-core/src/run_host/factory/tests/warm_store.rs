//! The cache warmer over the product's own ports and the real thread store: sessions written by the product's writer, their
//! main-loop sends arming the chain through the side-question store, warms fired by the warmer's own timer and sent through
//! [`ProvidersWarm::send`], the request of a session that is not loaded rebuilt by [`NextRequestSource`]'s stored reads. Only
//! the clock, the timers and the provider's wire are the test's.

use std::sync::Mutex;

use futures::future::BoxFuture;
use mixdog_ai::accounts::AccountStore;
use mixdog_ai::accounts::rotation::{AccountRotation, UsageProbe};
use mixdog_ai::admission::{Admission, LaneKey, LaneSettings};
use mixdog_ai::providers::anthropic::{AnthropicCodec, AnthropicConfig, Flavor, ModelCaps};
use mixdog_ai::warmer::Warmer;
use mixdog_ai::warmer::chain::{TimerHandle, WarmDeps, WarmRequest, WarmTarget, WarmTimers};
use mixdog_ai::warmer::gate::{AccountGate, OwnServices, ProviderSwitch, QuotaResumes, UsageSnapshots};
use mixdog_ai::warmer::plan::{IDLE_RETURN_LOOKBACK_MS, IDLE_RETURN_WINDOW_MS, Prices, warm_delay_ms};
use mixdog_ai::warmer::process::{WarmProviders, WarmSessions};
use mixdog_ai::warmer::send::Deadlines;
use mixdog_ai::warmer::stores::{GapRules, GapStore, Log, Now, Touch, TouchStore};
use mixdog_ai::warmer::stream::{WarmFailure, WarmUsage};
use mixdog_core_api::domain::cache_warm::{CacheWarmSend, WarmContext};
use mixdog_core_api::domain::provider::{AccountRouting, ProviderAdapter, Usage};
use mixdog_core_ports::ports::route::RouteSession as _;
use mixdog_core_session::session::turn_ops::SideEnd;
use tokio_util::sync::CancellationToken;

use super::super::super::builder_env::CatalogCaps;
use super::super::super::warm_ports::{ProvidersWarm, SessionWarmth, SessionsWarm};
use super::*;

const MINUTE: f64 = 60_000.0;
const HOUR: f64 = 60.0 * MINUTE;
/// The world's fixed clock: every send of a session goes out at it.
const SENT: f64 = 1_700_000_000_000.0;
const STRATEGY: &str = r#"{ "tools": "none", "system": "1h", "tier3": "1h", "messages": "1h" }"#;
const ACCOUNT: &str = "00000000-0000-4000-8000-000000000001";
const OTHER_ACCOUNT: &str = "00000000-0000-4000-8000-000000000002";

fn caps(_: &str) -> Option<ModelCaps> {
    Some(ModelCaps {
        adaptive_thinking: true,
        manual_thinking: false,
        effort_levels: ["low", "medium", "high", "xhigh", "max"].iter().map(|s| (*s).to_owned()).collect(),
        ladder_stated: true,
        max_output_tokens: Some(65536),
        fast_mode: false,
        context_window: Some(500_000),
        thinking_display_updates: true,
    })
}

/// A Claude route on Anthropic's own codec: it hands each turn's request to `sent` and answers from `replies` (else a plain
/// answer), and its cache-warm mode keeps each warm's request and reads the whole cached prefix.
struct ClaudeEcho {
    id: ProviderId,
    policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
    codec: Arc<dyn WireCodec>,
    sent: tokio::sync::mpsc::UnboundedSender<Arc<ModelRequest>>,
    replies: Mutex<VecDeque<Vec<StreamEvent>>>,
    warms: Mutex<Vec<ModelRequest>>,
}

/// A send that wrote a 70k-token prefix at the hour's lifetime, served by `account`, with `thinking` before its answer.
fn answered(account: Option<&str>, thinking: bool) -> Vec<StreamEvent> {
    let mut events = Vec::new();
    if let Some(account) = account {
        events.push(StreamEvent::AccountRouting(AccountRouting { provider: "anthropic-oauth".into(), account_id: account.into(), session_account_id: None }));
    }
    if thinking {
        events.push(StreamEvent::ThinkingBlocks(json!([{ "type": "thinking", "thinking": "weighing the log", "signature": "sig-1" }])));
    }
    events.push(StreamEvent::Usage(Usage { input_tokens: 10, cache_write_tokens: 70_000, cache_write_1h_tokens: 70_000, ..Usage::default() }));
    events.push(StreamEvent::TextDelta("ok".into()));
    events.push(StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None });
    events
}

fn claude(id: &str, replies: Vec<Vec<StreamEvent>>) -> (Arc<ClaudeEcho>, tokio::sync::mpsc::UnboundedReceiver<Arc<ModelRequest>>) {
    let (sent, heard) = tokio::sync::mpsc::unbounded_channel();
    let provider = Arc::new(ClaudeEcho {
        id: ProviderId::from(id),
        policy: RetryPolicy::codex_default(),
        keepalive: KeepaliveSchedule::SPEC,
        codec: Arc::new(AnthropicCodec::new(Flavor::OAuth, AnthropicConfig::new(Arc::new(caps)))),
        sent,
        replies: Mutex::new(replies.into()),
        warms: Mutex::default(),
    });
    (provider, heard)
}

#[async_trait]
impl ProviderAdapter for ClaudeEcho {
    fn release_send(&self, _group: &str) {}
    fn id(&self) -> &ProviderId {
        &self.id
    }
    fn codec(&self) -> &dyn WireCodec {
        &*self.codec
    }
    fn retry_policy(&self) -> &RetryPolicy {
        &self.policy
    }
    fn keepalive(&self) -> &KeepaliveSchedule {
        &self.keepalive
    }
    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        let _ = self.sent.send(request);
        let steps = lock(&self.replies).pop_front().unwrap_or_else(|| answered(None, false));
        Ok(Box::new(Steps(VecDeque::from(steps))))
    }
    fn cache_warm(&self) -> Option<&dyn CacheWarmSend> {
        Some(self)
    }
}

#[async_trait]
impl CacheWarmSend for ClaudeEcho {
    async fn send_cache_warm(
        &self,
        request: &ModelRequest,
        _: &WarmContext<'_>,
        _: &CancellationToken,
        on_usage: &mut (dyn for<'u> FnMut(&'u WarmUsage) + Send),
    ) -> Result<WarmUsage, WarmFailure> {
        lock(&self.warms).push(request.clone());
        let usage = WarmUsage { input: 5.0, output: 1.0, output_known: true, cached: 70_000.0, ..WarmUsage::default() };
        on_usage(&usage);
        Ok(usage)
    }
}

/// The bytes of `request` on the route's wire, without the tail reminder (each send carries the one of its moment).
fn body(provider: &ClaudeEcho, request: &ModelRequest) -> Vec<u8> {
    provider.codec.encode(&mixdog_agent::without_tail_reminder(request)).expect("encodes").body.to_vec()
}

// the account gate the warm passes

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
    async fn cached(&self, _: &str) -> Option<(Vec<mixdog_ai::accounts::Window>, i64)> {
        None
    }
}

fn account_gate(dir: &std::path::Path) -> AccountGate {
    let tokens = mixdog_rt::testing::tokens();
    let store = AccountStore::new(dir.join("accounts"), mixdog_ai::oauth::CredentialIo { read: tokens.interactive_io, write: tokens.durability_io });
    let rotation = Arc::new(AccountRotation::new(store.clone(), Arc::new(NoProbe), Arc::new(mixdog_ai::oauth::SystemPace)));
    AccountGate {
        admission: Arc::new(Admission::new()),
        lane_settings: Arc::new(|_: &LaneKey| LaneSettings { adaptive: true, ..LaneSettings::default() }),
        store,
        rotation,
        switch: Arc::new(On),
        resumes: Arc::new(NotPaused),
        snapshots: Arc::new(NoSnapshot),
        scope: Arc::new(OwnServices),
        now_ms: Arc::new(|| 1_700_000_000_000),
    }
}

// the warmer's clock and timers

#[derive(Default)]
struct Mocked {
    now: Mutex<f64>,
    timers: Mutex<Vec<(f64, BoxFuture<'static, ()>)>>,
}

struct Noop;

impl TimerHandle for Noop {
    fn cancel(&self) {}
}

struct Timers(Arc<Mocked>);

impl WarmTimers for Timers {
    fn schedule(&self, delay_ms: f64, task: BoxFuture<'static, ()>) -> Box<dyn TimerHandle> {
        let at = *lock(&self.0.now) + delay_ms.max(0.0);
        lock(&self.0.timers).push((at, task));
        Box::new(Noop)
    }
}

/// The process's warm deps with the test's clock and timers: the sessions and the providers are the product's ports.
struct Deps {
    mocked: Arc<Mocked>,
    timers: Timers,
    sessions: Arc<SessionsWarm>,
    providers: Arc<ProvidersWarm>,
}

#[async_trait]
impl WarmDeps for Deps {
    fn now(&self) -> f64 {
        *lock(&self.mocked.now)
    }
    fn timers(&self) -> &dyn WarmTimers {
        &self.timers
    }
    async fn enabled(&self) -> bool {
        true
    }
    fn read_config_enabled(&self) -> bool {
        true
    }
    fn turn_in_flight(&self, session_id: &str) -> bool {
        self.sessions.turn_in_flight(session_id)
    }
    async fn last_sent_request(&self, session_id: &str) -> Result<Option<Arc<dyn WarmRequest>>, String> {
        self.sessions.last_sent_request(session_id).await
    }
    async fn providers_ready(&self) {}
    async fn provider_current(&self, request: &dyn WarmRequest) -> bool {
        self.providers.current(request).await
    }
    async fn prices(&self, _: &dyn WarmRequest, _: f64, _: f64) -> Result<Prices, String> {
        Ok(Prices { read: Some(0.5e-6), write: Some(6.25e-6), output: Some(25e-6) })
    }
    async fn send(
        &self,
        request: &dyn WarmRequest,
        target: &WarmTarget,
        cancel: &CancellationToken,
        on_usage: &mut (dyn for<'u> FnMut(&'u WarmUsage) + Send),
    ) -> Result<WarmUsage, WarmFailure> {
        self.providers.send(request, target, cancel, on_usage).await
    }
    async fn record_usage(&self, _: &dyn WarmRequest, _: &WarmUsage, _: f64, _: &str) -> Result<(), String> {
        Ok(())
    }
    fn log(&self, _: &str) {}
}

async fn real_store(data: &std::path::Path) -> Arc<dyn mixdog_core_session::session::ThreadStore> {
    use mixdog_core_api::domain::mock::MockOwnership;
    use mixdog_core_session::session::StoreThreads;
    use mixdog_store::sqlite::SqliteStore;

    let tokens = mixdog_rt::testing::tokens();
    let root = data.to_path_buf();
    let index = mixdog_rt::LaneToken::submit(tokens.maintenance_io, &mixdog_rt::CancellationToken::new(), move |lane| {
        SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &root)
    })
    .expect("lane")
    .await
    .expect("job ran")
    .expect("index");
    Arc::new(StoreThreads::over_data_dir(data, index, Arc::new(MockOwnership::default()), tokens.maintenance_io).await.expect("the thread store"))
}

/// One process: a turn world over the store, and the warmer over its ports and the warm files of `dir`, bound to the world's
/// side-question store as the composition binds it.
struct Process {
    world: World,
    mocked: Arc<Mocked>,
    warmer: Arc<Warmer>,
    touches: Arc<TouchStore>,
    gaps: Arc<GapStore>,
    sessions: Arc<SessionsWarm>,
    providers: Arc<ProvidersWarm>,
    accounts: AccountStore,
}

async fn process(provider: &Arc<ClaudeEcho>, store: &Arc<dyn mixdog_core_session::session::ThreadStore>, dir: &std::path::Path) -> Process {
    process_with(provider, store, dir, None).await
}

/// [`process`] whose sessions are offered the builtin tools of `pool` (their header's `tools` names them).
async fn process_with(
    provider: &Arc<ClaudeEcho>,
    store: &Arc<dyn mixdog_core_session::session::ThreadStore>,
    dir: &std::path::Path,
    pool: Option<Vec<Arc<dyn Tool>>>,
) -> Process {
    let surfaces = pool.is_some();
    let world =
        turn_world_full(provider.clone(), Arc::new(NoMcp), Vec::new(), false, Some(store.clone()), pool, Arc::new(MockFileService::default()), surfaces).await;
    let tokens = mixdog_rt::testing::tokens();
    let mocked = Arc::new(Mocked::default());
    *lock(&mocked.now) = SENT + 1000.0;
    let log: Log = Arc::new(|_| {});
    let clock = mocked.clone();
    let now: Now = Arc::new(move || *lock(&clock.now));
    let touches = Arc::new(TouchStore::open(dir.join("touches.json"), tokens.durability_io, log.clone(), now.clone()).await.unwrap());
    let rules = GapRules { lookback_ms: IDLE_RETURN_LOOKBACK_MS, window_ms: IDLE_RETURN_WINDOW_MS, min_ms: warm_delay_ms(5.0 * MINUTE) };
    let gaps = Arc::new(GapStore::open(dir.join("gaps.json"), tokens.durability_io, rules, log.clone(), now).await.unwrap());
    let io = mixdog_ai::oauth::CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let metadata = mixdog_ai::catalog::ModelsDevSource::new(Arc::new(Offline), dir.join("catalog"), io);
    let catalog = Arc::new(mixdog_ai::catalog::CatalogService::cold_start(mixdog_ai::catalog::CatalogSnapshot::default(), Vec::new(), metadata).await);
    let sessions = Arc::new(SessionsWarm::new(world.next.clone(), world.registry.clone(), CatalogCaps::with_flag(catalog.clone(), None), world.next.clone()));
    let gate = account_gate(dir);
    let accounts = gate.store.clone();
    let providers = Arc::new(ProvidersWarm::new(world.registry.clone(), catalog, Arc::new(gate), Deadlines::DEFAULT, log));
    let deps = Deps { mocked: mocked.clone(), timers: Timers(mocked.clone()), sessions: sessions.clone(), providers: providers.clone() };
    let warmer = Warmer::new(Arc::new(deps), touches.clone(), gaps.clone());
    world.store.bind_warm(Arc::new(SessionWarmth::new(warmer.clone(), sessions.clone())));
    Process { world, mocked, warmer, touches, gaps, sessions, providers, accounts }
}

impl Process {
    /// A session that came back after 2.5 hours idle, twenty times: a warm bridges its next wait.
    fn returns(&self, id: &ThreadId) {
        for i in 0..20 {
            let at = SENT - 6.0 * HOUR * f64::from(i + 1);
            self.gaps.open_gap(id.as_str(), at);
            self.gaps.close(id.as_str(), at + 2.5 * HOUR);
        }
    }

    /// One turn of `id`, settled; the request it sent.
    async fn turn(
        &self,
        heard: &mut tokio::sync::mpsc::UnboundedReceiver<Arc<ModelRequest>>,
        id: &ThreadId,
        handle: &Arc<mixdog_core_session::session::SessionHandle>,
        op: &str,
    ) -> Arc<ModelRequest> {
        let covered = handle.header_snapshot().get("turnCoverage").cloned();
        handle.request(request("turn/start", json!({ "threadId": id, "opId": op, "input": { "prompt": op } }), op)).await.expect("turn/start");
        let handed = mixdog_rt::time::timeout(Duration::from_secs(30), heard.recv()).await.expect("the turn's request within 30 s").expect("alive");
        eventually_on_awaiting(
            || format!("turn {op} settled"),
            &[handle.stepped()],
            || (handle.header_snapshot().get("turnCoverage").cloned() != covered && !handle.turn_busy()).then_some(()),
        )
        .await;
        handed
    }

    /// The session leaves memory at its idle decision, as the idle clock unloads it.
    async fn unload(&self, id: &ThreadId) {
        let handle = self.world.directory.handle(id).expect("loaded");
        loop {
            let mut stepped = Box::pin(handle.stepped().notified());
            stepped.as_mut().enable();
            self.world.directory.release(id).await;
            if self.world.directory.handle(id).is_none() {
                break;
            }
            mixdog_rt::time::timeout(Duration::from_secs(30), stepped).await.expect("the thread became idle within 30 s");
        }
    }

    /// Runs every timer due by `to`, in due order, with the clock at each.
    async fn advance(&self, to: f64) {
        loop {
            let due = {
                let mut timers = lock(&self.mocked.timers);
                let first = timers.iter().enumerate().filter(|(_, t)| t.0 <= to).min_by(|a, b| a.1.0.total_cmp(&b.1.0)).map(|(i, _)| i);
                first.map(|i| timers.remove(i))
            };
            let Some((at, task)) = due else { break };
            {
                let mut now = lock(&self.mocked.now);
                *now = now.max(at);
            }
            task.await;
        }
        let mut now = lock(&self.mocked.now);
        *now = now.max(to);
    }

    fn close(&self) -> mixdog_core_session::session::close::SessionClose {
        mixdog_core_session::session::close::SessionClose::new(
            self.world.directory.clone(),
            self.world.registry.clone(),
            Arc::new(mixdog_core_session::session::testing::NoShells),
            Arc::new(mixdog_tools::fs::ReadState::new(None)),
        )
    }
}

fn strategy() -> Value {
    serde_json::from_str(STRATEGY).unwrap()
}

/// A session of `header` (with the hour strategy) sent once and armed: the process, the session, the request it sent.
async fn armed(
    provider: &Arc<ClaudeEcho>,
    heard: &mut tokio::sync::mpsc::UnboundedReceiver<Arc<ModelRequest>>,
    store: &Arc<dyn mixdog_core_session::session::ThreadStore>,
    dir: &std::path::Path,
    mut header: Value,
) -> (Process, ThreadId, Arc<ModelRequest>) {
    header["providerCacheOpts"] = json!({ "cacheStrategy": strategy() });
    let p = process(provider, store, dir).await;
    let (id, handle) = started_thread(&p.world, header).await;
    p.returns(&id);
    let handed = p.turn(heard, &id, &handle, "op-1").await;
    let chain = p.warmer.chain_state(id.as_str()).expect("the settled send armed the chain");
    assert_eq!((chain.ttl_ms, chain.touch_at), (HOUR, SENT), "the hour the send wrote, from its send");
    (p, id, handed)
}

fn anthropic() -> Value {
    json!({ "provider": "anthropic", "model": "claude-opus-5-5" })
}

/// The request a session's stored rebuild warms is the request its next send would be, through the one assembly path the
/// turn takes: the header's deferred and MCP tools the request boundary adds, the thinking of the answered turn and the
/// session's own effort are all in the warm's body, which equals the body the session last sent.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stored_warm_sends_the_body_the_session_last_sent_with_its_deferred_tools_thinking_and_effort() {
    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let (provider, mut heard) = claude("anthropic", vec![answered(None, true), answered(None, false)]);
    // The request boundary adds the deferred catalog's tools beside the session's own, never to a request that has none.
    let p = process_with(&provider, &store, data.path(), Some(vec![Arc::new(Says(named_spec("grep"), "found".into()))])).await;
    let mcp = mixdog_core_api::domain::tool::StoredTool::mcp(
        json!({ "name": "mcp__alpha__list", "description": "Lists alpha.", "inputSchema": { "type": "object", "properties": {} } }),
        "alpha",
        Some("n"),
    )
    .encode();
    let native = json!({ "name": "office", "description": "Office files.", "inputSchema": { "type": "object", "properties": {} } });
    let header = json!({
        "provider": "anthropic", "model": "claude-opus-5-5", "effort": "high", "tools": [{ "name": "grep" }],
        "providerCacheOpts": { "cacheStrategy": strategy() },
        "deferredNativeTools": true, "deferredMcpToolNames": [], "deferredDiscoveredTools": ["mcp__alpha__list"],
        "deferredToolCatalog": [native, mcp],
    });
    let (id, handle) = started_thread(&p.world, header).await;
    let _first = p.turn(&mut heard, &id, &handle, "op-1").await;
    let handed = p.turn(&mut heard, &id, &handle, "op-2").await;
    let names: Vec<&str> = handed.tools.iter().map(|tool| tool.name.as_str()).collect();
    assert!(names.contains(&"grep") && names.contains(&"mcp__alpha__list") && names.contains(&"office"), "the turn sent the boundary's tools: {names:?}");
    assert_eq!(handed.options.effort.as_deref(), Some("high"));
    assert!(handed.messages.iter().any(|message| message.thinking_blocks.is_some()), "the second request carries the first answer's thinking");
    p.unload(&id).await;

    let warm = p.sessions.last_sent_request(id.as_str()).await.expect("readable").expect("a last send is stored");
    p.providers.send(&*warm, &WarmTarget { account_id: String::new() }, &CancellationToken::new(), &mut |_| {}).await.expect("the warm goes out");
    let warms = lock(&provider.warms);
    assert_eq!(warms.len(), 1);
    assert_eq!(body(&provider, &warms[0]), body(&provider, &handed), "the warm's body is the body the session last sent");
    assert!(p.world.directory.loaded_ids().is_empty(), "the warm did not load the session");
    assert!(!p.world.directory.deps().cache_tail.loaded(id.as_str()), "the book the warm's read opened is not left open");
}

/// The account that holds the cache is not the one the session's sends would go to now: the warm is not sent and the chain
/// ends.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_warm_whose_account_moved_is_not_sent_and_ends_the_chain() {
    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let (provider, mut heard) = claude("anthropic-oauth", vec![answered(Some(ACCOUNT), false)]);
    let header = json!({ "provider": "anthropic-oauth", "model": "claude-opus-5-5" });
    let (p, id, _) = armed(&provider, &mut heard, &store, data.path(), header).await;
    assert_eq!(p.warmer.chain_state(id.as_str()).map(|chain| chain.account_id), Some(ACCOUNT.to_owned()));
    p.accounts.register("anthropic-oauth", OTHER_ACCOUNT, "B", false).await.unwrap();
    p.advance(SENT + HOUR - MINUTE).await;
    assert!(lock(&provider.warms).is_empty(), "nothing was sent to the account that does not hold the cache");
    assert!(p.warmer.chain_state(id.as_str()).is_none(), "the chain ended");
}

/// A route change ends the chain and its touch: the cached prefix is the old route's.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_route_change_leaves_no_chain_and_no_touch() {
    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let (provider, mut heard) = claude("anthropic", Vec::new());
    let (p, id, _) = armed(&provider, &mut heard, &store, data.path(), anthropic()).await;
    let run_clock: Arc<dyn Clock> = Arc::new(Fixed);
    let change = Arc::new(super::super::super::route_change::RunHostRouteChange::new(Arc::new(NoRouteFacts), run_clock));
    let threads = Arc::new(mixdog_core_session::session::thread_state::SessionThreads::new(p.world.directory.clone()));
    let routes = Arc::new(HopRouteConfig(serde_json::Map::new()));
    let adapter = mixdog_core_session::session::route_session::SessionRouteAdapter::new(
        p.world.directory.clone(),
        threads,
        change,
        routes.clone(),
        routes.clone(),
        routes,
        p.world.rig.clock.clone(),
    );
    let route = json!({ "provider": "anthropic", "model": "claude-opus-5-4" }).as_object().unwrap().clone();
    assert!(adapter.update_route(&id, route.into_iter().collect(), false).await.expect("written"));
    assert!(p.warmer.chain_state(id.as_str()).is_none() && p.touches.get(id.as_str()).is_none());
    p.advance(SENT + HOUR).await;
    assert!(lock(&provider.warms).is_empty());
}

/// A session closed while it is not loaded: its chain ends with its touch, and nothing is warmed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_close_while_unloaded_leaves_no_chain_and_no_touch() {
    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let (provider, mut heard) = claude("anthropic", Vec::new());
    let (p, id, _) = armed(&provider, &mut heard, &store, data.path(), anthropic()).await;
    p.unload(&id).await;
    assert!(p.warmer.chain_state(id.as_str()).is_some(), "the unload keeps the chain");
    assert!(p.close().close(id.as_str(), "manual").await, "the tombstone landed");
    assert!(p.warmer.chain_state(id.as_str()).is_none() && p.touches.get(id.as_str()).is_none());
    p.advance(SENT + HOUR).await;
    assert!(lock(&provider.warms).is_empty());
}

/// An agent's session unloaded the way the agent registry unloads it keeps its chain, and its warm is the stored request.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_agent_sessions_unload_keeps_its_chain_and_warms_the_stored_request() {
    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let (provider, mut heard) = claude("anthropic", Vec::new());
    let header = json!({ "provider": "anthropic", "model": "claude-opus-5-5", "owner": "agent" });
    let (p, id, handed) = armed(&provider, &mut heard, &store, data.path(), header).await;
    // `unloadSessionRuntime`: the side request goes as an unload's, then the runtime is released.
    p.world.directory.deps().side.forget(&id, SideEnd::Unload);
    p.unload(&id).await;
    assert!(p.warmer.chain_state(id.as_str()).is_some(), "the agent unload keeps the chain");
    p.advance(SENT + HOUR - MINUTE).await;
    let warms = lock(&provider.warms);
    assert_eq!(warms.len(), 1, "the chain warms");
    assert_eq!(body(&provider, &warms[0]), body(&provider, &handed), "the stored request's body");
    assert!(p.world.directory.loaded_ids().is_empty(), "the warm did not load the session");
}

/// After a restart nothing is loaded: the warmer re-arms an open session from its touch file and warms the stored request;
/// a session closed meanwhile has nothing to repeat, so it gets no chain and its touch goes.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn after_a_restart_an_open_session_is_rearmed_and_a_closed_one_leaves_no_chain_and_no_touch() {
    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let (provider, mut heard) = claude("anthropic", Vec::new());
    let (p, open, handed) = armed(&provider, &mut heard, &store, data.path(), anthropic()).await;
    let mut header = anthropic();
    header["providerCacheOpts"] = json!({ "cacheStrategy": strategy() });
    let (closed, handle) = started_thread(&p.world, header).await;
    let _ = p.turn(&mut heard, &closed, &handle, "op-1").await;
    assert!(p.close().close(closed.as_str(), "manual").await);
    // A touch the close did not reach (a process that ended between the tombstone and the warmer).
    p.touches.record(closed.as_str(), Touch { touch_at: SENT, ttl_ms: HOUR, prompt_tokens: 70_000.0, account_id: None });
    p.touches.flush().await;
    p.gaps.flush().await;
    drop(p);

    let next = process(&provider, &store, data.path()).await;
    *lock(&next.mocked.now) = SENT + 10.0 * MINUTE;
    assert_eq!(next.warmer.rearm_after_restart().await, 1, "the open session alone is re-armed");
    assert!(next.warmer.chain_state(closed.as_str()).is_none() && next.touches.get(closed.as_str()).is_none(), "the closed one has neither");
    next.advance(SENT + HOUR - MINUTE).await;
    let warms = lock(&provider.warms);
    assert_eq!(warms.len(), 1, "the re-armed chain warms");
    assert_eq!(body(&provider, &warms[0]), body(&provider, &handed), "the stored request's body");
    assert!(next.world.directory.loaded_ids().is_empty(), "the restarted process loaded nothing for it");
    assert!(next.warmer.chain_state(open.as_str()).is_some());
}

/// A process shutdown detaches every loaded session (`close_on_exit`): the chain ends with the process, the touch stays, and
/// the next process re-arms the session that was open and warms the stored request.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_shutdown_keeps_the_touch_and_the_restart_rearms_the_session_that_was_open() {
    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let (provider, mut heard) = claude("anthropic", Vec::new());
    let (p, id, handed) = armed(&provider, &mut heard, &store, data.path(), anthropic()).await;
    p.world.directory.set_exit_close(Arc::new(p.close())).map_err(|_| "bound").expect("bound once");
    p.world.directory.shutdown_for("SIGTERM").await;
    assert!(p.warmer.chain_state(id.as_str()).is_none(), "the chain ends with the process's life of the session");
    assert!(p.touches.get(id.as_str()).is_some(), "the touch stays for the restart");
    p.touches.flush().await;
    p.gaps.flush().await;
    drop(p);

    let next = process(&provider, &store, data.path()).await;
    *lock(&next.mocked.now) = SENT + 10.0 * MINUTE;
    assert_eq!(next.warmer.rearm_after_restart().await, 1, "the session that was open is re-armed");
    next.advance(SENT + HOUR - MINUTE).await;
    let warms = lock(&provider.warms);
    assert_eq!(warms.len(), 1);
    assert_eq!(body(&provider, &warms[0]), body(&provider, &handed), "the stored request's body");
    assert!(next.world.directory.loaded_ids().is_empty());
}

/// Leaving a conversation for another context detaches it (`switchContext`): its chain ends and its touch stays, as at a
/// shutdown; a restart may re-arm it from the stored session.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_context_switch_ends_the_chain_and_keeps_the_touch() {
    use mixdog_core_config::workflow::thread_settings::ContextSwitch as _;

    struct NoTarget;
    impl mixdog_core_session::session::thread_switches::ContextTarget for NoTarget {
        fn invalidate(&self, _: &ThreadId) {}
    }

    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let (provider, mut heard) = claude("anthropic", Vec::new());
    let (p, id, _) = armed(&provider, &mut heard, &store, data.path(), anthropic()).await;
    let switch = mixdog_core_session::session::thread_switches::SessionContextSwitch::new(p.world.directory.clone(), Arc::new(p.close()), Arc::new(NoTarget));
    switch.switch_context(id.as_str(), Some("/work/b".into()), None, false).await.expect("switched");
    assert!(p.warmer.chain_state(id.as_str()).is_none(), "the chain ends");
    assert!(p.touches.get(id.as_str()).is_some(), "the touch stays");
    p.advance(SENT + HOUR).await;
    assert!(lock(&provider.warms).is_empty());
}
