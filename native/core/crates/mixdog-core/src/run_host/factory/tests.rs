mod cache_expiry;
mod effort;
mod forwarding;
#[cfg(feature = "live-bytes-probe")]
mod live_bytes;
mod outside_tests;
mod pinned_account;
mod restart;
mod snapshot;
mod task_waits;
mod text_sharing;
mod turn_cut;
mod turn_path;
mod turn_run;
mod units;
mod warm_store;

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicI64};
use std::time::Duration;

use mixdog_agent::env::{AllowAll, CompactError, CompactOutput, CompactRequest, NoGuards};
use mixdog_core_api::call::CallContext;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::mock::{MockApprovalGate, MockCodec, MockFileService, MockProcessManager, MockRetryDecider};
use mixdog_core_api::domain::provider::{DeliveryState, ModelRequest, ModelStream, ProviderError, StopReason, StreamEvent, ToolCall, WireCodec};
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_core_api::domain::tool::{SurfaceKind, Tool, ToolAnnotations, ToolContext, ToolIo, ToolOutcome, ToolOutput, ToolPart, ToolSpec};
use mixdog_core_api::ids::{ConnectionId, Method, OpId};
use mixdog_core_api::{CoreRequest, Reply, ThreadDirectory, ThreadHandle};
use mixdog_core_session::session::SessionDirectory;
use mixdog_core_session::session::testing::{Rig, eventually_on_awaiting};
use mixdog_protocol::{JsonValue, ProviderId};
use mixdog_store::schema::blob::Slot;
use mixdog_store::schema::record::Record;

use super::*;

struct Steps(VecDeque<StreamEvent>);

#[async_trait]
impl ModelStream for Steps {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
        self.0.pop_front().map(Ok)
    }
    fn delivery(&self) -> DeliveryState {
        DeliveryState::Accepted
    }
    fn on_wire_left(&mut self, _left: std::sync::Arc<dyn Fn() + Send + Sync>) {}
}

struct NoJobs;

impl mixdog_core_run::run_host::progress::WaitedJobs for NoJobs {
    fn silence(&self, _: &[String], _: i64) -> Option<mixdog_agent::agent_tool::progress::ToolSilence> {
        None
    }
}

/// A scripted stream that holds its stop until the observer has recorded the first call's early result, so that result
/// precedes the batch.
struct HeldStop(Steps, Arc<tokio::sync::Notify>);

#[async_trait]
impl ModelStream for HeldStop {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
        if matches!(self.0.0.front(), Some(StreamEvent::Completed { .. })) {
            self.1.notified().await;
        }
        self.0.next().await
    }
    fn delivery(&self) -> DeliveryState {
        DeliveryState::Accepted
    }
    fn on_wire_left(&mut self, _left: std::sync::Arc<dyn Fn() + Send + Sync>) {}
}

/// `Scripted`, whose response number `.2` (from 0) has its stop wait for the notice.
struct HeldScripted(Scripted, Arc<tokio::sync::Notify>, usize);

#[async_trait]
impl ProviderAdapter for HeldScripted {
    fn release_send(&self, group: &str) {
        self.0.release_send(group);
    }
    fn id(&self) -> &ProviderId {
        self.0.id()
    }
    fn codec(&self) -> &dyn WireCodec {
        self.0.codec()
    }
    fn retry_policy(&self) -> &RetryPolicy {
        self.0.retry_policy()
    }
    fn keepalive(&self) -> &KeepaliveSchedule {
        self.0.keepalive()
    }
    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        let held = lock(&self.0.requests).len() == self.2;
        let stream = self.0.attempt(request).await?;
        if !held {
            return Ok(stream);
        }
        // The held attempt's events are held again behind the notice.
        let mut steps = VecDeque::new();
        let mut stream = stream;
        while let Some(event) = stream.next().await {
            steps.push_back(event?);
        }
        Ok(Box::new(HeldStop(Steps(steps), self.1.clone())))
    }
}

struct Scripted {
    id: ProviderId,
    policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
    codec: MockCodec,
    script: Mutex<VecDeque<Vec<StreamEvent>>>,
    requests: Mutex<Vec<Arc<ModelRequest>>>,
    /// The next attempt is refused (a failed turn); it clears as it fires.
    fail_first: std::sync::atomic::AtomicBool,
}

#[async_trait]
impl ProviderAdapter for Scripted {
    fn release_send(&self, _group: &str) {}
    fn id(&self) -> &ProviderId {
        &self.id
    }
    fn codec(&self) -> &dyn WireCodec {
        &self.codec
    }
    fn retry_policy(&self) -> &RetryPolicy {
        &self.policy
    }
    fn keepalive(&self) -> &KeepaliveSchedule {
        &self.keepalive
    }
    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        if self.fail_first.swap(false, std::sync::atomic::Ordering::SeqCst) {
            return Err(ProviderError::new(mixdog_core_api::domain::provider::ErrorKind::InvalidRequest, DeliveryState::NotSent));
        }
        lock(&self.requests).push(request);
        let steps = lock(&self.script).pop_front().expect("provider script exhausted");
        Ok(Box::new(Steps(steps.into())))
    }
}

struct Echo(ToolSpec);

#[async_trait]
impl Tool for Echo {
    fn spec(&self) -> &ToolSpec {
        &self.0
    }
    async fn call(&self, _ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        Ok(ToolOutput { parts: vec![ToolPart::Text(format!("echo:{args}"))], ..ToolOutput::default() })
    }
}

struct Fixed;

impl Clock for Fixed {
    fn now_ms(&self) -> i64 {
        1_700_000_000_000
    }
}

struct NoBlobs;

#[async_trait]
impl mixdog_agent::compact::blob_reads::BlobReads for NoBlobs {
    async fn read_with(&self, work: mixdog_agent::compact::blob_reads::StoreWork) -> Result<(), mixdog_agent::compact::blob_reads::StoreUnavailable> {
        work(self);
        Ok(())
    }
}

struct Parts {
    provider: Arc<dyn ProviderAdapter>,
    workspace: std::path::PathBuf,
    /// Tools beside `echo`.
    more: Vec<Arc<dyn Tool>>,
    /// A key the settings reconcile adds to the header, and the headers the turns were assembled from.
    settle: Option<Arc<Settle>>,
    /// The route's effort wiring a turn is assembled with (the effort replay).
    effort: Option<Arc<EffortParts>>,
}

/// What the host's route wiring puts on a turn whose route takes effort updates (`assemble.rs`): the header's effort
/// on the requests, the projection inputs, the step's auto-effort anchor and its judge.
struct EffortParts {
    effort: Option<String>,
    route: mixdog_agent::effort::EffortRoute,
    step_auto: Option<mixdog_agent::step_effort::StepAutoEffort>,
    judge: Option<Arc<dyn mixdog_agent::step_effort::StepEffortJudge>>,
}

/// The scripted provider as the effort-taking adapter (`attempt_with` is its `attempt`).
struct EffortScripted(Arc<dyn ProviderAdapter>);

#[async_trait]
impl mixdog_agent::effort::EffortAdapter for EffortScripted {
    async fn attempt_with(&self, request: Arc<ModelRequest>, _: Option<mixdog_agent::effort::EffortProjection>) -> Result<Box<dyn ModelStream>, ProviderError> {
        self.0.attempt(request).await
    }
}

struct Settle {
    add: (&'static str, Value),
    seen: Mutex<Vec<mixdog_store::schema::record::Header>>,
}

fn request(method: &'static str, params: Value, op: &str) -> CoreRequest {
    CoreRequest {
        method: Method(method),
        params,
        op: Some(OpId::from(op)),
        ctx: CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, mixdog_rt::CancellationToken::new()),
    }
}

/// The scripted provider, arming `arm` as its first request goes out (the turn's start is on disk by then).
struct ArmedOnSend {
    inner: Arc<Scripted>,
    arm: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

#[async_trait]
impl ProviderAdapter for ArmedOnSend {
    fn release_send(&self, group: &str) {
        self.inner.release_send(group);
    }
    fn id(&self) -> &ProviderId {
        self.inner.id()
    }
    fn codec(&self) -> &dyn WireCodec {
        self.inner.codec()
    }
    fn retry_policy(&self) -> &RetryPolicy {
        self.inner.retry_policy()
    }
    fn keepalive(&self) -> &KeepaliveSchedule {
        self.inner.keepalive()
    }
    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        let arm = lock(&self.arm).take();
        if let Some(arm) = arm {
            arm();
        }
        self.inner.attempt(request).await
    }
}

/// A tool that starts, tells it did, and finishes only when released.
struct Blocker(ToolSpec, Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>);

#[async_trait]
impl Tool for Blocker {
    fn spec(&self) -> &ToolSpec {
        &self.0
    }
    async fn call(&self, _ctx: &ToolContext, _args: JsonValue) -> ToolOutcome {
        self.1.notify_one();
        self.2.notified().await;
        Ok(ToolOutput { parts: vec![ToolPart::Text("blocked, then released".into())], ..ToolOutput::default() })
    }
}

/// A tool that tells when it runs.
struct Probe(ToolSpec, Arc<std::sync::atomic::AtomicBool>, Arc<tokio::sync::Notify>);

#[async_trait]
impl Tool for Probe {
    fn spec(&self) -> &ToolSpec {
        &self.0
    }
    async fn call(&self, _ctx: &ToolContext, _args: JsonValue) -> ToolOutcome {
        self.1.store(true, std::sync::atomic::Ordering::SeqCst);
        self.2.notify_one();
        Ok(ToolOutput { parts: vec![ToolPart::Text("probed".into())], ..ToolOutput::default() })
    }
}

/// A `UserPromptSubmit` hook that never answers: the turn stands in its setup, before the model is asked.
struct HeldPrompt {
    reached: tokio::sync::Notify,
}

#[async_trait]
impl mixdog_core_session::session::lifecycle_hooks::LifecycleHooks for HeldPrompt {
    async fn prompt_submit(
        &self,
        _: &ThreadId,
        _: &mixdog_store::schema::record::Header,
        _: &Value,
    ) -> mixdog_core_session::session::lifecycle_hooks::PromptVerdict {
        self.reached.notify_one();
        std::future::pending().await
    }
}

/// The hooks a turn fired, in order, and what its `UserPromptSubmit` answers.
#[derive(Default)]
struct TurnHooks {
    calls: Mutex<Vec<String>>,
    verdict: Mutex<mixdog_core_session::session::lifecycle_hooks::PromptVerdict>,
}

#[async_trait]
impl mixdog_core_session::session::lifecycle_hooks::LifecycleHooks for TurnHooks {
    async fn prompt_submit(
        &self,
        _: &ThreadId,
        header: &mixdog_store::schema::record::Header,
        prompt: &Value,
    ) -> mixdog_core_session::session::lifecycle_hooks::PromptVerdict {
        lock(&self.calls).push(format!("UserPromptSubmit:{}:{prompt}", header["cwd"].as_str().unwrap_or_default()));
        lock(&self.verdict).clone()
    }
    async fn stop_failure(&self, _: &ThreadId, _: &mixdog_store::schema::record::Header, error_type: &str) {
        lock(&self.calls).push(format!("StopFailure:{error_type}"));
    }
}

/// Compacts the first time it is asked, keeping what the session's compactor keeps first (`split_protected_context`: the
/// system messages), then a summary and the latest message.
#[derive(Default)]
struct CompactsOnce {
    asked: AtomicBool,
}

#[async_trait]
impl Compactor for CompactsOnce {
    fn estimate_tokens(&self, _: &[AgentMessage]) -> u64 {
        1_000_000
    }

    async fn reduces(&self, _: &CompactRequest<'_>) -> bool {
        !self.asked.swap(true, Ordering::SeqCst)
    }

    async fn compact(&self, request: CompactRequest<'_>) -> Result<CompactOutput, CompactError> {
        let mut messages: Vec<AgentMessage> = request.messages.iter().take_while(|m| m.role() == Role::System).cloned().collect();
        messages.push(AgentMessage::user("[summary]"));
        messages.extend(request.messages.last().cloned());
        Ok(CompactOutput {
            messages,
            usage: None,
            input_excludes_cache: false,
            dropped_count: 0,
            dropped: None,
            skipped: false,
            pipeline_ms: 0.0,
            summary_ms: None,
            summary_route: None,
        })
    }
}

/// [`Parts`] with a compactor and explicit compaction settings.
struct Compacting {
    inner: Parts,
    compactor: Arc<dyn Compactor>,
    settings: mixdog_agent::boundary::CompactSettings,
}

/// [`Parts`] for a capped turn (a heartbeat's): its calls are not started as they stream (`Run::try_eager`), only by the
/// batch, once the assistant row that carries them is handed over.
struct Capped(Parts);

/// A provider that refuses every attempt with `error`.
struct Refusing {
    id: ProviderId,
    policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
    codec: MockCodec,
    error: ProviderError,
}

#[async_trait]
impl ProviderAdapter for Refusing {
    fn release_send(&self, _group: &str) {}
    fn id(&self) -> &ProviderId {
        &self.id
    }
    fn codec(&self) -> &dyn WireCodec {
        &self.codec
    }
    fn retry_policy(&self) -> &RetryPolicy {
        &self.policy
    }
    fn keepalive(&self) -> &KeepaliveSchedule {
        &self.keepalive
    }
    async fn attempt(&self, _: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        Err(self.error.clone())
    }
}

/// [`Parts`] that records every shell reap it is asked for.
struct Reaping {
    inner: Parts,
    reaps: Arc<Mutex<Vec<(ThreadId, i64)>>>,
    woke: Arc<tokio::sync::Notify>,
}

/// A tool that reports its output through `ctx.progress`, then waits to be released.
struct Reporter {
    spec: ToolSpec,
    reported: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
}

#[async_trait]
impl Tool for Reporter {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }
    async fn call(&self, ctx: &ToolContext, _args: JsonValue) -> ToolOutcome {
        ctx.progress.progress(mixdog_core_api::domain::tool::ToolProgress::Output(b"compiling".to_vec()));
        self.reported.notify_one();
        self.release.notified().await;
        Ok(ToolOutput { parts: vec![ToolPart::Text("built".into())], ..ToolOutput::default() })
    }
}

// ---- the real assembly -------------------------------------------------------------------------

struct OneProvider(Arc<dyn ProviderAdapter>);

struct Config;

struct NoMcp;

impl super::super::session_tools::SessionMcp for NoMcp {
    fn tools(&self, _: Option<&str>, _: &std::path::Path) -> Vec<Arc<dyn Tool>> {
        Vec::new()
    }
}

struct NoSkills;

#[async_trait]
impl super::super::session_tools::SkillsListed for NoSkills {
    async fn any_for(&self, _: &std::path::Path) -> Result<bool, String> {
        Ok(false)
    }
}

/// The session catalog `call_tool` resolves its target in, bound once the directory exists (the composition's
/// `LateCatalog`).
#[derive(Default)]
struct LateCatalog(std::sync::OnceLock<Arc<dyn mixdog_tools::orch::bridge::CatalogView>>);

impl LateCatalog {
    fn bound(&self) -> &dyn mixdog_tools::orch::bridge::CatalogView {
        self.0.get().expect("the catalog is bound before a turn runs").as_ref()
    }
}

#[async_trait]
impl mixdog_tools::orch::bridge::CatalogView for LateCatalog {
    fn available(&self, thread: &ThreadId) -> Vec<mixdog_tools::orch::bridge::ToolDoc> {
        self.bound().available(thread)
    }
    fn is_eager(&self, thread: &ThreadId, name: &str) -> bool {
        self.bound().is_eager(thread, name)
    }
    fn block_reason(&self, thread: &ThreadId, name: &str) -> Option<String> {
        self.bound().block_reason(thread, name)
    }
    fn alias_members(&self, key: &str) -> Vec<String> {
        self.bound().alias_members(key)
    }
    fn mcp_server_members(&self, thread: &ThreadId, requested: &str) -> Vec<String> {
        self.bound().mcp_server_members(thread, requested)
    }
    fn instructions_for(&self, thread: &ThreadId, names: &[String]) -> String {
        self.bound().instructions_for(thread, names)
    }
    async fn announce(&self, thread: &ThreadId, names: &[String]) {
        self.bound().announce(thread, names).await;
    }
    fn resolve_call(&self, thread: &ThreadId, name: &str) -> mixdog_tools::orch::bridge::CallResolution {
        self.bound().resolve_call(thread, name)
    }
    fn callable(&self, thread: &ThreadId) -> Vec<String> {
        self.bound().callable(thread)
    }
    async fn refresh(&self, thread: &ThreadId) {
        self.bound().refresh(thread).await;
    }
    async fn load_native(&self, thread: &ThreadId, args: &Value) -> Option<Result<String, String>> {
        self.bound().load_native(thread, args).await
    }
    fn lacks(&self, thread: &ThreadId, names: &[String]) -> bool {
        self.bound().lacks(thread, names)
    }
    async fn await_connect(&self, thread: &ThreadId) {
        self.bound().await_connect(thread).await;
    }
}

/// `call_tool`'s own pipeline, never reached: the loop projects a wire call onto its target before dispatch.
struct Unprojected;

#[async_trait]
impl mixdog_tools::orch::bridge::ToolDispatcher for Unprojected {
    async fn dispatch(&self, _: &ToolContext, name: &str, _: Value) -> ToolOutcome {
        panic!("call_tool dispatched {name} without the loop's projection")
    }
}

struct PoolResolver(Vec<Arc<dyn Tool>>);

impl mixdog_tools::policy::ToolResolver for PoolResolver {
    fn resolve(&self, _scope: Option<&str>, name: &str) -> Option<Arc<dyn Tool>> {
        self.0.iter().find(|t| t.spec().name == name).cloned()
    }
}

struct NoStamps;

#[async_trait::async_trait]
impl mixdog_core_ports::ports::run_stamps::RunStamps for NoStamps {
    async fn stamp_of(&self, _: &ThreadId) -> Option<Value> {
        None
    }
}

struct AllowNone;

impl super::super::mcp_seams::AllowAllActions for AllowNone {
    fn allow_all_actions(&self) -> bool {
        false
    }
}

struct NoEvidence;

#[async_trait]
impl mixdog_core_agents::agents::AgentEvidence for NoEvidence {
    async fn home_greeted(&self, _: &str) -> bool {
        false
    }
    async fn home_chatted(&self, _: &str) -> bool {
        false
    }
    async fn mixy_owns_routines(&self) -> Result<bool, String> {
        Ok(false)
    }
}

struct NoLadder;

#[async_trait]
impl super::super::step_judge::LadderSources for NoLadder {
    fn cached_row(&self, _: &str, _: &str) -> Option<serde_json::Map<String, Value>> {
        None
    }
    async fn rejected(&self, _: &str, _: &str) -> Option<mixdog_ai::effort::RejectionEntry> {
        None
    }
    fn custom_config(&self, _: &str) -> Option<(mixdog_ai::providers::custom::Protocol, String)> {
        None
    }
    fn anthropic_levels(&self, _: &str) -> Vec<String> {
        Vec::new()
    }
}

struct Pricing;

struct NoSkillNames;

/// Every thread is open for a hop; a hop never runs here (the scripted provider never fails), so the session's writes refuse.
struct OpenHopSessions;

impl mixdog_core_run::run_host::hop_host::HopSessions for OpenHopSessions {
    fn open(&self, _: &ThreadId) -> Option<Arc<dyn mixdog_core_run::run_host::hop_host::HopSession>> {
        Some(Arc::new(NoHopWrites))
    }
}

struct NoHopWrites;

/// The route facts of a routed world's hops: no catalog row and no cache policy.
struct NoRouteFacts;

#[async_trait]
impl super::super::route_change::RouteFacts for NoRouteFacts {
    fn context_meta(&self, _: &str, _: &str, _: &Value) -> Option<mixdog_core_run::run_host::session_context_meta::ContextMeta> {
        None
    }
    fn cache_opts(&self, _: &str, _: &str, _: Option<&str>, _: &mixdog_store::schema::record::Header) -> Option<Value> {
        None
    }
}

/// The agent config a routed world's route adapter reads, with no statusline or context gauge to tell.
struct HopRouteConfig(serde_json::Map<String, Value>);

impl mixdog_core_session::session::route_session::RouteConfig for HopRouteConfig {
    fn agent_config(&self) -> mixdog_core_ports::ports::domain_sessions::Obj {
        self.0.clone()
    }
    fn bots(&self) -> &(dyn mixdog_core_run::run_host::route_chain::BotRoutes + Send + Sync) {
        &NoBots
    }
}

impl mixdog_core_session::session::route_session::RouteStatusline for HopRouteConfig {
    fn write(&self, _: &str, _: &mixdog_core_ports::ports::route::Route, _: Option<u64>) {}
}

impl mixdog_core_session::session::route_session::ContextStatusCache for HopRouteConfig {
    fn invalidate(&self, _: &ThreadId) {}
}

/// A scripted adapter that answers its next attempt with an armed refusal, once, and retries nothing: a failure that
/// reaches the route chain at once.
struct ArmedRefusal {
    inner: Arc<Scripted>,
    policy: RetryPolicy,
    refusal: Mutex<Option<ProviderError>>,
}

impl ArmedRefusal {
    fn new(inner: Arc<Scripted>) -> Arc<Self> {
        let mut policy = RetryPolicy::codex_default();
        for row in [&mut policy.request, &mut policy.midstream, &mut policy.transport, &mut policy.connection] {
            row.schedule.max_retries = 0;
        }
        policy.recovery = None;
        Arc::new(Self { inner, policy, refusal: Mutex::new(None) })
    }
}

#[async_trait]
impl ProviderAdapter for ArmedRefusal {
    fn release_send(&self, group: &str) {
        self.inner.release_send(group);
    }
    fn id(&self) -> &ProviderId {
        self.inner.id()
    }
    fn codec(&self) -> &dyn WireCodec {
        self.inner.codec()
    }
    fn retry_policy(&self) -> &RetryPolicy {
        &self.policy
    }
    fn keepalive(&self) -> &KeepaliveSchedule {
        self.inner.keepalive()
    }
    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        let refused = lock(&self.refusal).take();
        match refused {
            Some(refusal) => Err(refusal),
            None => self.inner.attempt(request).await,
        }
    }
}

/// Builds the one scripted adapter of each provider it serves, each not available while its switch is off; any other
/// name is a provider no family serves (a removed custom provider), whose build fails as the product's does.
struct GatedProviders(Vec<(&'static str, Arc<dyn ProviderAdapter>, std::sync::atomic::AtomicBool)>);

impl GatedProviders {
    fn new(adapters: Vec<(&'static str, Arc<dyn ProviderAdapter>)>) -> Arc<Self> {
        Arc::new(Self(adapters.into_iter().map(|(name, adapter)| (name, adapter, std::sync::atomic::AtomicBool::new(true))).collect()))
    }
    fn set(&self, name: &str, on: bool) {
        let (_, _, switch) = self.0.iter().find(|(served, ..)| *served == name).expect("a served provider");
        switch.store(on, std::sync::atomic::Ordering::SeqCst);
    }
}

#[async_trait]
impl mixdog_ai::registry::providers::ProviderBuilder for GatedProviders {
    async fn build(&self, name: &str, _config: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
        self.0.iter().find(|(served, ..)| *served == name).map(|(_, adapter, _)| adapter.clone()).ok_or_else(|| format!("unknown enabled provider: {name}"))
    }
    async fn custom_key_ids(&self, _name: &str) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
    fn available(&self, name: &str) -> bool {
        self.0.iter().find(|(served, ..)| *served == name).is_none_or(|(_, _, on)| on.load(std::sync::atomic::Ordering::SeqCst))
    }
    async fn oauth_credentials_usable(&self, _name: &str) -> Result<bool, String> {
        Ok(true)
    }
}

struct NoWiring;

struct NoBots;

#[async_trait::async_trait]
impl mixdog_core_run::run_host::route_chain::BotRoutes for NoBots {
    async fn bot_route(&self, _: &str) -> Result<Option<Option<Value>>, mixdog_core_run::run_host::route_chain::RouteReadUnavailable> {
        Ok(None)
    }
    async fn stored_bot_route(&self, _: &str) -> Result<Option<Value>, mixdog_core_run::run_host::route_chain::RouteReadUnavailable> {
        Ok(None)
    }
}

struct Offline;

#[async_trait]
impl mixdog_ai::transport::http::HttpSend for Offline {
    async fn send(
        &self,
        _: mixdog_core_api::domain::provider::WireRequest,
        _exchange: mixdog_ai::transport::Exchange,
    ) -> Result<mixdog_ai::transport::http::HttpResponse, ProviderError> {
        Err(ProviderError::new(mixdog_core_api::domain::provider::ErrorKind::Transient, DeliveryState::NotSent))
    }
}

struct NoMarks;

struct NoCeilings;

struct AutoOff;

struct NoAttachmentText;

fn named(name: &str) -> Arc<dyn Tool> {
    let spec = ToolSpec {
        name: name.into(),
        title: None,
        trigger: None,
        public: true,
        aliases: Vec::new(),
        description: name.into(),
        input_schema: json!({ "type": "object" }),
        annotations: ToolAnnotations { read_only_hint: Some(true), idempotent_hint: Some(true), ..ToolAnnotations::default() },
        parallel_safe: true,
        exclusive_with: Vec::new(),
    };
    Arc::new(Echo(spec))
}

/// Notes every thread the assembly asks where its approvals go.
#[derive(Default)]
struct AskedFor(Mutex<Vec<String>>);

impl crate::run_host::run_approvals::RunApprovals for AskedFor {
    fn gate_for(
        &self,
        thread: &ThreadId,
        own: Arc<dyn mixdog_core_api::domain::approval::ApprovalGate>,
    ) -> Arc<dyn mixdog_core_api::domain::approval::ApprovalGate> {
        lock(&self.0).push(thread.as_str().to_owned());
        own
    }
}

/// The test settings host: a turn start brings the header to `.1`, the settings as they stand now.
struct LiveSettings(Arc<SessionDirectory>, Arc<Mutex<serde_json::Map<String, Value>>>);

impl LiveSettings {
    fn threads(&self) -> mixdog_core_session::session::thread_state::SessionThreads {
        mixdog_core_session::session::thread_state::SessionThreads::new(self.0.clone())
    }
}

#[async_trait]
impl super::super::turn_settings::TurnSettings for LiveSettings {
    async fn reconcile(&self, thread: &ThreadId, _: bool) -> Result<mixdog_store::schema::record::Header, String> {
        use mixdog_core_ports::ports::threads::ThreadState;
        let set = lock(&self.1).clone();
        if !set.is_empty() {
            self.threads().patch_header(thread, set, Vec::new()).await.map_err(|error| format!("{error:?}"))?;
        }
        self.threads().header(thread).await.map_err(|error| format!("{error:?}"))
    }
}

/// A transcript of text only: a media part is a failure of the replay.
struct ManualMeters;

impl mixdog_agent::compact::estimate::MediaMeter for ManualMeters {
    fn part(&self, part: &mixdog_core_api::domain::provider::ContentPart) -> mixdog_agent::compact::estimate::PartMeter {
        panic!("media part in a text-only replay: {part:?}")
    }
}

impl mixdog_agent::compact::pressure::ImageIdentities for ManualMeters {
    fn images(&self, _: &mixdog_agent::message::AgentMessage) -> Vec<mixdog_agent::compact::pressure::ImageDescriptor> {
        Vec::new()
    }
}

/// The thread's own header and route over a window the recording had; no media.
struct ManualWorld {
    threads: Arc<dyn mixdog_core_ports::ports::threads::ThreadState>,
    window: u64,
}

#[async_trait]
impl mixdog_core_session::session::thread_context::ContextWorld for ManualWorld {
    async fn snapshot(
        &self,
        thread: Option<&ThreadId>,
    ) -> Result<Option<mixdog_core_session::session::thread_context::ContextSnapshot>, mixdog_core_api::CoreError> {
        let header = self.threads.header(thread.expect("a thread")).await.expect("the thread's header");
        let text = |key: &str| header.get(key).and_then(Value::as_str).expect("a route").to_owned();
        let (provider, model) = (text("provider"), text("model"));
        Ok(Some(mixdog_core_session::session::thread_context::ContextSnapshot {
            header,
            replay_owner: ProviderId::from(provider.as_str()),
            provider,
            model,
            context_window: json!(self.window),
            cwd: Value::Null,
            mode: Value::Null,
            messages: Vec::new(),
            active: true,
            request_native: Vec::new(),
            request_defined: Vec::new(),
            session_defined: Vec::new(),
            agent_mode: false,
            annotations: std::collections::HashMap::new(),
            media: Arc::new(ManualMeters),
            images: Arc::new(ManualMeters),
            rows: Arc::new(super::super::context_world::StoredBodies),
        }))
    }
    fn lowering(
        &self,
        _: &ThreadId,
        _: &str,
    ) -> (Arc<dyn mixdog_agent::compact::estimate::MediaMeter>, Arc<dyn mixdog_agent::compact::pressure::ImageIdentities>) {
        (Arc::new(ManualMeters), Arc::new(ManualMeters))
    }
}

struct ManualNoHooks;

#[async_trait]
impl super::super::compact_hooks::CompactHooks for ManualNoHooks {
    async fn pre(&self, _: &ThreadId, _: &str) {}
    async fn post(&self, _: &ThreadId, _: &str) {}
}

struct ManualGauge;

impl mixdog_core_session::session::route_session::ContextStatusCache for ManualGauge {
    fn invalidate(&self, _: &ThreadId) {}
}

/// The test function the scripted MCP servers run as (`mixdog_testkit::mcp_server`): nothing unless started as one.
#[test]
fn scripted_server() {
    mixdog_testkit::mcp_server::serve_if_asked();
}

/// A provider that hands each request it is asked to send to `sent` and answers with a text. Its codec is Grok's, so
/// the body of a request is what a Grok turn puts on the wire.
struct Handing {
    id: ProviderId,
    policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
    codec: Arc<dyn WireCodec>,
    sent: tokio::sync::mpsc::UnboundedSender<Arc<ModelRequest>>,
}

#[async_trait]
impl ProviderAdapter for Handing {
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
        self.sent.send(request).expect("the test is listening");
        Ok(Box::new(Steps(VecDeque::from([
            StreamEvent::TextDelta("ok".into()),
            StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None },
        ]))))
    }
}

/// The surface host of the daemon reduced to what a `tools/toolsStatus` call touches: the mode, and the reconcile,
/// which brings an empty thread to the current settings by writing its header.
struct Reconciling(Arc<SessionDirectory>);

fn handing() -> (Arc<Handing>, tokio::sync::mpsc::UnboundedReceiver<Arc<ModelRequest>>) {
    let (sent, heard) = tokio::sync::mpsc::unbounded_channel();
    let provider = Arc::new(Handing {
        id: ProviderId::from("scripted"),
        policy: RetryPolicy::codex_default(),
        keepalive: KeepaliveSchedule::SPEC,
        codec: mixdog_ai::providers::grok::codec("1.0.70"),
        sent,
    });
    (provider, heard)
}

fn named_spec(name: &str) -> ToolSpec {
    ToolSpec {
        name: name.into(),
        title: None,
        trigger: None,
        public: true,
        aliases: Vec::new(),
        description: name.into(),
        input_schema: json!({ "type": "object" }),
        annotations: ToolAnnotations::default(),
        parallel_safe: true,
        exclusive_with: Vec::new(),
    }
}

impl mixdog_core_run::run_host::hop_host::HopWiring for NoWiring {
    fn wiring(&self, _: &Value, _: &Arc<dyn ProviderAdapter>) -> (Option<mixdog_agent::effort::EffortWiring>, Option<mixdog_agent::text_only::TextOnlyInput>) {
        (None, None)
    }
}

async fn snapshot_call(service: &mixdog_tools::orch::status::ToolsService, thread: &ThreadId, message: &str) -> Value {
    use mixdog_core_api::DomainService;
    let call = CoreRequest {
        method: Method("tools/toolsStatus"),
        params: json!({ "threadId": thread, "snapshot": true, "snapshotUserMessage": message }),
        op: None,
        ctx: CallContext::internal("test"),
    };
    let Ok(Reply::Value(status)) = service.call(call).await else { panic!("tools/toolsStatus answers a value") };
    status
}

fn jobs_free(jobs: &Jobs) -> bool {
    jobs.observed.try_lock().is_ok()
}

#[async_trait]
impl mixdog_ai::registry::providers::ProviderBuilder for OneProvider {
    async fn build(&self, _name: &str, _config: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
        Ok(self.0.clone())
    }
    async fn custom_key_ids(&self, _name: &str) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
    fn available(&self, _name: &str) -> bool {
        true
    }
    async fn oauth_credentials_usable(&self, _name: &str) -> Result<bool, String> {
        Ok(true)
    }
}

#[async_trait]
impl mixdog_mcp::skill_select::SkillNames for NoSkillNames {
    async fn names(&self, _: &std::path::Path) -> Result<std::collections::HashSet<String>, String> {
        Ok(Default::default())
    }
}

impl super::super::settings::HeartbeatMarks for NoMarks {
    fn is_heartbeat(&self, _: &str) -> bool {
        false
    }
}

impl super::super::settings::OutputCeilingSource for NoCeilings {
    fn ceilings(&self, _: &str, _: &str, _: &mixdog_store::schema::record::Header) -> super::super::settings::OutputCeilings {
        Default::default()
    }
}

impl super::super::settings::AutoEffortSource for AutoOff {
    fn mode_on(&self) -> bool {
        false
    }
    fn base_setting(&self) -> Option<Value> {
        None
    }
    fn steps_enabled(&self) -> bool {
        true
    }
}

#[async_trait]
impl mixdog_agent::attachments::AttachmentText for NoAttachmentText {
    async fn text_of(&self, _: &mixdog_core_api::domain::provider::ContentPart) -> Result<Option<String>, Box<ProviderError>> {
        Ok(None)
    }
}

impl mixdog_ai::registry::accounting::UsagePricing for Pricing {
    fn price_usage(&self, args: &mixdog_ai::catalog::UsageArgs) -> mixdog_ai::catalog::PricedUsage {
        mixdog_ai::catalog::PricedUsage { input: args.input_tokens, cost_usd: None, rates: serde_json::Map::new() }
    }
}

#[async_trait]
impl RunParts for Parts {
    async fn reconcile_turn(
        &self,
        _: &ThreadId,
        mut header: mixdog_store::schema::record::Header,
        _: bool,
    ) -> Result<mixdog_store::schema::record::Header, TurnError> {
        if let Some(settle) = &self.settle {
            header.insert(settle.add.0.to_owned(), settle.add.1.clone());
        }
        Ok(header)
    }

    async fn assemble(&self, input: AssembleInput<'_>) -> Result<Assembled, TurnError> {
        if let Some(settle) = &self.settle {
            lock(&settle.seen).push(input.header.clone());
        }
        let spec = ToolSpec {
            name: "echo".into(),
            title: None,
            trigger: None,
            public: true,
            aliases: Vec::new(),
            description: "echo".into(),
            input_schema: json!({ "type": "object" }),
            annotations: ToolAnnotations { read_only_hint: Some(true), idempotent_hint: Some(true), ..ToolAnnotations::default() },
            parallel_safe: true,
            exclusive_with: Vec::new(),
        };
        let tokens = mixdog_rt::testing::tokens();
        let mut config = RunConfig::new(input.thread.clone(), input.turn.clone(), "m");
        if let Some(effort) = &self.effort {
            config.options.effort = effort.effort.clone();
            config.effort = Some(mixdog_agent::effort::EffortWiring { route: effort.route.clone(), adapter: Arc::new(EffortScripted(self.provider.clone())) });
            config.step_auto_effort = effort.step_auto.clone();
        }
        Ok(Assembled {
            header: input.header.clone(),
            provider: self.provider.clone(),
            tools: ToolSet::new(std::iter::once(Arc::new(Echo(spec)) as Arc<dyn Tool>).chain(self.more.iter().cloned()).collect()),
            tool_env: ToolEnv {
                thread_id: input.thread.clone(),
                turn_id: input.turn.clone(),
                cwd: mixdog_core_api::domain::common::AbsPath::new(self.workspace.clone()).unwrap(),
                surface: SurfaceKind::Lead,
                io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
                approvals: Arc::new(MockApprovalGate::default()),
                files: Arc::new(MockFileService::default()),
                processes: Arc::new(MockProcessManager::default()),
                progress: input.progress.clone(),
                deadline_of: None,
                notify: input.notify.clone(),
                review: None,
            },
            gate: Box::new(|_| Arc::new(AllowAll)),
            worktree: self.workspace.to_string_lossy().into_owned(),
            config,
            clock: Arc::new(Fixed),
            decider: Arc::new(MockRetryDecider),
            guards: Arc::new(NoGuards),
            compactor: None,
            route: None,
            skills: None,
            hooks: None,
            reuse: None,
            reactions: None,
            reaction_scope: None,
            rows: Arc::default(),
            tail: None,
            side: None,
            step_judge: self.effort.as_ref().and_then(|e| e.judge.clone()),
            artifacts: None,
            images: None,
            failures: None,
            blobs: Arc::new(NoBlobs),
            carry: RunCarry::default(),
        })
    }
}

#[async_trait]
impl RunParts for Compacting {
    async fn reconcile_turn(
        &self,
        thread: &ThreadId,
        header: mixdog_store::schema::record::Header,
        conversation: bool,
    ) -> Result<mixdog_store::schema::record::Header, TurnError> {
        self.inner.reconcile_turn(thread, header, conversation).await
    }

    async fn assemble(&self, input: AssembleInput<'_>) -> Result<Assembled, TurnError> {
        let mut assembled = self.inner.assemble(input).await?;
        assembled.compactor = Some(self.compactor.clone());
        assembled.config.compact = Some(self.settings.clone());
        Ok(assembled)
    }
}

#[async_trait]
impl RunParts for Capped {
    async fn reconcile_turn(
        &self,
        thread: &ThreadId,
        header: mixdog_store::schema::record::Header,
        conversation: bool,
    ) -> Result<mixdog_store::schema::record::Header, TurnError> {
        self.0.reconcile_turn(thread, header, conversation).await
    }

    async fn assemble(&self, input: AssembleInput<'_>) -> Result<Assembled, TurnError> {
        let mut assembled = self.0.assemble(input).await?;
        assembled.config.limits = Some(mixdog_agent::limits::TurnLimits { max_tool_calls: Some(8), ..Default::default() });
        Ok(assembled)
    }
}

#[async_trait]
impl RunParts for Reaping {
    async fn reconcile_turn(
        &self,
        thread: &ThreadId,
        header: mixdog_store::schema::record::Header,
        conversation: bool,
    ) -> Result<mixdog_store::schema::record::Header, TurnError> {
        self.inner.reconcile_turn(thread, header, conversation).await
    }

    async fn assemble(&self, input: AssembleInput<'_>) -> Result<Assembled, TurnError> {
        self.inner.assemble(input).await
    }

    fn reap_turn_shells(&self, thread: &ThreadId, since_ms: i64) {
        lock(&self.reaps).push((thread.clone(), since_ms));
        self.woke.notify_one();
    }
}

#[async_trait]
impl super::super::host_seams::ConfigSeams for Config {
    fn hidden_agent(&self, _: Option<&str>) -> bool {
        false
    }
    fn synced_compaction(&self, _: &mixdog_store::schema::record::Header, _: bool) -> Option<Value> {
        None
    }
    fn route_config(&self, _: &mixdog_store::schema::record::Header) -> mixdog_app_protocol::v2::thread::ThreadRoute {
        Default::default()
    }
    fn settings_changes(&self, _: &mixdog_core_api::ids::ThreadId) -> Option<mixdog_core_session::session::turn_ops::SettingsFeed> {
        None
    }
    fn run_settings(&self, _: &ThreadId, _: &mixdog_store::schema::record::Header) -> super::super::assemble::RunSettings {
        super::super::assemble::RunSettings {
            hidden_agent: false,
            agent_mode: false,
            limits: None,
            compact: None,
            escalated_max_output_tokens: None,
            read_body_required: false,
            vision: None,
            effort: None,
            step_auto_effort: None,
            text_only: None,
            attachments: None,
            file_text: None,
            model_max_output_tokens: None,
            auto_clear: None,
        }
    }
    fn stored_instruction_files(&self) -> Option<Value> {
        None
    }
    fn response_language(&self) -> Option<(String, String)> {
        None
    }
}

impl mixdog_protocol::message_class::user_text::Blobs for NoBlobs {
    fn text_within(&self, _: &str, _: u64) -> Result<Option<String>, mixdog_protocol::message_class::user_text::ReadError> {
        Ok(None)
    }
}

#[derive(Default)]
struct Ledger(Mutex<Vec<mixdog_ai::registry::accounting::UsageRow>>, tokio::sync::Notify);

#[async_trait]
impl mixdog_ai::registry::accounting::UsageSink for Ledger {
    async fn record_queued(&self, row: mixdog_ai::registry::accounting::UsageRow) -> Result<(), String> {
        lock(&self.0).push(row);
        self.1.notify_waiters();
        Ok(())
    }
}

#[async_trait]
impl mixdog_core_run::run_host::hop_host::HopSession for NoHopWrites {
    fn header(&self) -> Option<Arc<mixdog_store::schema::record::Header>> {
        None
    }
    async fn write_hop(
        &self,
        _: mixdog_core_ports::ports::domain_sessions::Obj,
        _: &mixdog_core_run::run_host::route_fallback::HopWrite,
    ) -> Result<Option<mixdog_store::schema::record::Header>, mixdog_tools::orch::util::PortError> {
        unreachable!("no hop in this test")
    }
    async fn write_wire_pin(&self, _: Value) -> Result<(), mixdog_tools::orch::util::PortError> {
        unreachable!("no hop in this test")
    }
    async fn rebuild_tool_surface(&self, _: &str) -> Result<(), mixdog_tools::orch::util::PortError> {
        unreachable!("no hop in this test")
    }
}

/// A turn whose response streams `looking` and calls `probe`, then answers `all done`; every report's media preparation is
/// held (`TestCompaction::prepare_held`) from its first request on. The turn is capped ([`Capped`]): an uncapped one starts
/// `probe` as it streams, gated by the review baseline and not by its row, so the row's hold would not hold it.
struct HeldTurn {
    rig: Rig,
    _directory: SessionDirectory,
    _workspace: tempfile::TempDir,
    id: ThreadId,
    handle: Arc<mixdog_core_session::session::SessionHandle>,
    ran: Arc<std::sync::atomic::AtomicBool>,
    ran_now: Arc<tokio::sync::Notify>,
    /// How many preparations had started when the hold began.
    held_from: Arc<std::sync::atomic::AtomicUsize>,
}

/// A directory over `rig`'s store whose turns run on `provider` and whose thread header carries the system prompt `rules`.
fn restartable(rig: &Rig, provider: &Arc<dyn ProviderAdapter>, workspace: &std::path::Path) -> SessionDirectory {
    restartable_with(rig, provider, workspace, Vec::new())
}

fn restartable_with(rig: &Rig, provider: &Arc<dyn ProviderAdapter>, workspace: &std::path::Path, more: Vec<Arc<dyn Tool>>) -> SessionDirectory {
    let mut deps = rig.deps_parts(rig.store.clone());
    let parts = Parts { provider: provider.clone(), workspace: workspace.to_path_buf(), more, settle: None, effort: None };
    deps.runs = Arc::new(RunHostFactory::new(
        mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(),
        mixdog_tools::web::NativeSearchUsageSinks::new(),
        Arc::new(parts),
    ));
    SessionDirectory::new(Arc::new(deps))
}

/// [`Parts`] whose first assembly, when asked to, fails: the turn ends after the settings reconcile and before its rows are written.
struct FailsAssembly {
    inner: Parts,
    fail: std::sync::atomic::AtomicBool,
}

#[async_trait]
impl RunParts for FailsAssembly {
    async fn reconcile_turn(
        &self,
        thread: &ThreadId,
        header: mixdog_store::schema::record::Header,
        conversation: bool,
    ) -> Result<mixdog_store::schema::record::Header, TurnError> {
        self.inner.reconcile_turn(thread, header, conversation).await
    }

    async fn assemble(&self, input: AssembleInput<'_>) -> Result<Assembled, TurnError> {
        if self.fail.swap(false, Ordering::SeqCst) {
            return Err(TurnError { message: "assembly failed".into(), data: json!({}), provider_error: None });
        }
        self.inner.assemble(input).await
    }
}

fn restartable_failing(rig: &Rig, provider: &Arc<dyn ProviderAdapter>, workspace: &std::path::Path, fail: bool) -> SessionDirectory {
    let mut deps = rig.deps_parts(rig.store.clone());
    let parts = FailsAssembly {
        inner: Parts { provider: provider.clone(), workspace: workspace.to_path_buf(), more: Vec::new(), settle: None, effort: None },
        fail: std::sync::atomic::AtomicBool::new(fail),
    };
    deps.runs = Arc::new(RunHostFactory::new(
        mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(),
        mixdog_tools::web::NativeSearchUsageSinks::new(),
        Arc::new(parts),
    ));
    SessionDirectory::new(Arc::new(deps))
}

fn scripted(answers: &[&str]) -> Arc<Scripted> {
    let done = |text: &str| {
        vec![StreamEvent::TextDelta(text.into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }]
    };
    Arc::new(Scripted {
        id: ProviderId::from("scripted"),
        policy: RetryPolicy::codex_default(),
        keepalive: KeepaliveSchedule::SPEC,
        codec: MockCodec,
        script: Mutex::new(answers.iter().map(|answer| done(answer)).collect()),
        requests: Mutex::new(Vec::new()),
        fail_first: std::sync::atomic::AtomicBool::new(false),
    })
}

fn ended_runs(rig: &Rig, id: &ThreadId) -> usize {
    rig.store.records(id).into_iter().filter(|(_, record)| matches!(record, Record::Run(run) if matches!(run.phase, mixdog_store::schema::record::RunPhase::Completed | mixdog_store::schema::record::RunPhase::Failed))).count()
}

/// A provider that, on its first request, runs `on_first` (the test makes the store start failing there) and then answers as `inner`.
struct OnFirstSend {
    inner: Arc<Scripted>,
    on_first: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

#[async_trait]
impl ProviderAdapter for OnFirstSend {
    fn release_send(&self, group: &str) {
        self.inner.release_send(group);
    }
    fn id(&self) -> &ProviderId {
        self.inner.id()
    }
    fn codec(&self) -> &dyn WireCodec {
        self.inner.codec()
    }
    fn retry_policy(&self) -> &RetryPolicy {
        self.inner.retry_policy()
    }
    fn keepalive(&self) -> &KeepaliveSchedule {
        self.inner.keepalive()
    }
    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        if let Some(first) = lock(&self.on_first).take() {
            first();
        }
        self.inner.attempt(request).await
    }
}

fn tool_call(id: &str, name: &str) -> StreamEvent {
    StreamEvent::ToolCallDone(ToolCall { id: id.into(), name: name.into(), arguments: json!({ "a": id }), native_type: None })
}

fn tool_use() -> StreamEvent {
    StreamEvent::Completed { stop: Some(StopReason::ToolUse), pricing_model: None, request_ms: None }
}

fn scripted_rounds(rounds: Vec<Vec<StreamEvent>>) -> Arc<Scripted> {
    Arc::new(Scripted {
        id: ProviderId::from("scripted"),
        policy: RetryPolicy::codex_default(),
        keepalive: KeepaliveSchedule::SPEC,
        codec: MockCodec,
        script: Mutex::new(rounds.into()),
        requests: Mutex::new(Vec::new()),
        fail_first: std::sync::atomic::AtomicBool::new(false),
    })
}

fn item_rows(rig: &Rig, id: &ThreadId) -> usize {
    rig.store.records(id).iter().filter(|(_, record)| matches!(record, Record::Item(_))).count()
}

fn answer_events(text: &str) -> Vec<StreamEvent> {
    vec![StreamEvent::TextDelta(text.into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }]
}

/// An eager call of send 1 that its response's final calls left out is held through the start of send 2, which issues a
/// `task wait` with the same call id. The held call settles through `batch.rs`'s eager path, `early_result_of` and the
/// observer, either before the wait opens (`opens_first == false`) or after; the wait stays open until its own result,
/// which clears the spinner and the agent's wait.
async fn a_held_calls_late_settlement_leaves_a_later_sends_wait_alone(opens_first: bool) {
    let id = if opens_first { "held-after-open" } else { "held-before-open" };
    let settled = Arc::new(tokio::sync::Notify::new());
    SETTLED_HOOKS.lock().unwrap().push((id.into(), settled.clone()));
    let (go, held_started, held_release, wait_started, wait_release) = (
        Arc::new(tokio::sync::Notify::new()),
        Arc::new(tokio::sync::Notify::new()),
        Arc::new(tokio::sync::Notify::new()),
        Arc::new(tokio::sync::Notify::new()),
        Arc::new(tokio::sync::Notify::new()),
    );
    let call = |id: &str, name: &str, arguments: Value| ToolCall { id: id.into(), name: name.into(), arguments, native_type: None };
    let stop = |stop| StreamEvent::Completed { stop: Some(stop), pricing_model: None, request_ms: None };
    let scripted = Arc::new(HeldScripted(
        Scripted {
            id: ProviderId::from("scripted"),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new(VecDeque::from([
                // Send 1: the stream runs `holder`, and the final calls name `quick` alone.
                vec![
                    StreamEvent::ToolCallDone(call(id, "holder", json!({}))),
                    StreamEvent::ReturnedCalls(vec![call("quick-1", "quick", json!({}))]),
                    stop(StopReason::ToolUse),
                ],
                // Send 2: a wait with the first call's id, its stop held until the test lets it go.
                vec![StreamEvent::ToolCallDone(call(id, "task", json!({ "action": "wait" }))), stop(StopReason::ToolUse)],
                vec![StreamEvent::TextDelta("all done".into()), stop(StopReason::EndTurn)],
            ])),
            requests: Mutex::new(Vec::new()),
            fail_first: std::sync::atomic::AtomicBool::new(false),
        },
        go.clone(),
        1,
    ));
    let spec = |name: &str| ToolSpec {
        name: name.into(),
        title: None,
        trigger: None,
        public: true,
        aliases: Vec::new(),
        description: name.into(),
        input_schema: json!({ "type": "object" }),
        annotations: ToolAnnotations { read_only_hint: Some(true), idempotent_hint: Some(true), ..ToolAnnotations::default() },
        parallel_safe: true,
        exclusive_with: Vec::new(),
    };
    let (ran, ran_now) = (Arc::new(std::sync::atomic::AtomicBool::new(false)), Arc::new(tokio::sync::Notify::new()));
    let rig = Rig::new();
    let workspace = tempfile::tempdir().unwrap();
    let mut deps = rig.deps_parts(rig.store.clone());
    let more: Vec<Arc<dyn Tool>> = vec![
        Arc::new(Blocker(spec("holder"), held_started.clone(), held_release.clone())),
        Arc::new(Probe(spec("quick"), ran, ran_now)),
        Arc::new(Blocker(spec("task"), wait_started.clone(), wait_release.clone())),
    ];
    deps.runs = Arc::new(RunHostFactory::new(
        mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(),
        mixdog_tools::web::NativeSearchUsageSinks::new(),
        Arc::new(Parts { provider: scripted, workspace: workspace.path().to_path_buf(), more, settle: None, effort: None }),
    ));
    let directory = SessionDirectory::new(Arc::new(deps));
    let reply = directory
        .request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start"))
        .await
        .expect("thread/start");
    let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
    let thread = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
    let handle = directory.handle(&thread).expect("loaded");
    let within = |what: &'static str, signal: Arc<tokio::sync::Notify>| async move {
        tokio::time::timeout(std::time::Duration::from_secs(30), signal.notified()).await.unwrap_or_else(|_| panic!("{what} within 30 s"));
    };
    let frames = || rig.feeds.frames(thread.as_str());
    let mode = || {
        frames().iter().rev().find_map(|(_, method, params)| {
            (method == "thread/runtime/updated").then(|| params["value"]["spinner"]["mode"].as_str().map(str::to_owned)).flatten()
        })
    };
    let waiting = || directory.worker_live(&thread, 0, &NoJobs).task_waiting;
    let shown_open = || mode().as_deref() == Some("task-wait") && waiting();
    handle.request(request("turn/start", json!({ "threadId": thread, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");

    within("send 1's call started", held_started).await;
    // Send 2 has begun and issued its wait: the held call spans the start of the send.
    within("send 2's wait started", wait_started).await;
    if opens_first {
        go.notify_one();
        eventually_on_awaiting(|| format!("the wait shown as open: {:?}", mode()), &[handle.stepped()], || shown_open().then_some(())).await;
        held_release.notify_one();
        within("the held call's settlement handled", settled.clone()).await;
    } else {
        held_release.notify_one();
        within("the held call's settlement handled", settled.clone()).await;
        go.notify_one();
        eventually_on_awaiting(|| format!("the wait shown as open: {:?}", mode()), &[handle.stepped()], || shown_open().then_some(())).await;
    }
    assert!(shown_open(), "the held call's late settlement left the wait open");
    wait_release.notify_one();
    eventually_on_awaiting(
        || format!("the wait's own result clears the working state: {:?}", mode()),
        &[handle.stepped()],
        || (mode().as_deref() != Some("task-wait") && !waiting()).then_some(()),
    )
    .await;
    eventually_on_awaiting(|| "the turn settled".to_owned(), &[handle.stepped()], || (!handle.turn_busy()).then_some(())).await;
}

impl HeldTurn {
    async fn start() -> Self {
        let scripted = Arc::new(Scripted {
            id: ProviderId::from("scripted"),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new(VecDeque::from([
                vec![
                    StreamEvent::TextDelta("looking".into()),
                    StreamEvent::ToolCallDone(ToolCall { id: "c1".into(), name: "probe".into(), arguments: json!({}), native_type: None }),
                    StreamEvent::Completed { stop: Some(StopReason::ToolUse), pricing_model: None, request_ms: None },
                ],
                vec![
                    StreamEvent::TextDelta("all done".into()),
                    StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None },
                ],
            ])),
            requests: Mutex::new(Vec::new()),
            fail_first: std::sync::atomic::AtomicBool::new(false),
        });
        let rig = Rig::new();
        let held_from = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (compaction, from) = (rig.compaction.clone(), held_from.clone());
        let arm: Box<dyn FnOnce() + Send> = Box::new(move || {
            from.store(*compaction.prepare_started.borrow(), std::sync::atomic::Ordering::SeqCst);
            compaction.prepare_held.send_replace(true);
        });
        let provider = Arc::new(ArmedOnSend { inner: scripted, arm: Mutex::new(Some(arm)) });
        let (ran, ran_now) = (Arc::new(std::sync::atomic::AtomicBool::new(false)), Arc::new(tokio::sync::Notify::new()));
        let spec = ToolSpec {
            name: "probe".into(),
            title: None,
            trigger: None,
            public: true,
            aliases: Vec::new(),
            description: "probe".into(),
            input_schema: json!({ "type": "object" }),
            annotations: ToolAnnotations { read_only_hint: Some(true), idempotent_hint: Some(true), ..ToolAnnotations::default() },
            parallel_safe: true,
            exclusive_with: Vec::new(),
        };
        let workspace = tempfile::tempdir().unwrap();
        let mut deps = rig.deps_parts(rig.store.clone());
        let more: Vec<Arc<dyn Tool>> = vec![Arc::new(Probe(spec, ran.clone(), ran_now.clone()))];
        deps.runs = Arc::new(RunHostFactory::new(
            mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(),
            mixdog_tools::web::NativeSearchUsageSinks::new(),
            Arc::new(Capped(Parts { provider, workspace: workspace.path().to_path_buf(), more, settle: None, effort: None })),
        ));
        let directory = SessionDirectory::new(Arc::new(deps));
        let reply = directory
            .request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start"))
            .await
            .expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        let handle = directory.handle(&id).expect("loaded");
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");
        Self { rig, _directory: directory, _workspace: workspace, id, handle, ran, ran_now, held_from }
    }

    /// A report's preparation started after the hold began, and waits.
    async fn a_preparation_is_held(&self) {
        let mut started = self.rig.compaction.prepare_started.subscribe();
        let wait =
            started.wait_for(|started| *self.rig.compaction.prepare_held.borrow() && *started > self.held_from.load(std::sync::atomic::Ordering::SeqCst));
        tokio::time::timeout(std::time::Duration::from_secs(30), wait).await.expect("a preparation held within 30 s").expect("the counter");
    }

    /// What the feed showed of the turn, each once, in the order it first showed it.
    fn shown(&self) -> Vec<&'static str> {
        let mut out = Vec::new();
        for (_, method, params) in self.rig.feeds.frames(self.id.as_str()) {
            let call = params["item"]["run"]["callId"] == "c1";
            let name = match method.as_str() {
                "item/agentMessage/delta" if params["delta"] == "looking" => "text",
                "item/completed" if call && params["item"]["run"]["completedAt"].is_null() => "card",
                "item/completed" if call => "result",
                "thread/toolBatch/updated" if params["phase"] == "started" => "tool started",
                "item/agentMessage/delta" if params["delta"] == "all done" => "answer",
                _ => continue,
            };
            if !out.contains(&name) {
                out.push(name);
            }
        }
        out
    }

    /// The stored item rows' bodies.
    fn stored(&self) -> Vec<Value> {
        self.rig
            .store
            .records(&self.id)
            .into_iter()
            .filter_map(|(_, record)| match record {
                Record::Item(item) => match item.body {
                    Slot::Inline(body) => Some(body),
                    _ => None,
                },
                _ => None,
            })
            .collect()
    }
}

/// A clock the test moves.
struct Moving(AtomicI64);

impl Clock for Moving {
    fn now_ms(&self) -> i64 {
        self.0.load(std::sync::atomic::Ordering::SeqCst)
    }
}

/// [`Config`] whose sessions know a context window and compact automatically only when `auto`; the target is small
/// enough that an earlier turn's tool output is discardable.
struct Windowed {
    auto: bool,
}

#[async_trait]
impl super::super::host_seams::ConfigSeams for Windowed {
    fn hidden_agent(&self, agent: Option<&str>) -> bool {
        super::super::host_seams::ConfigSeams::hidden_agent(&Config, agent)
    }
    fn synced_compaction(&self, header: &mixdog_store::schema::record::Header, install: bool) -> Option<Value> {
        super::super::host_seams::ConfigSeams::synced_compaction(&Config, header, install)
    }
    fn route_config(&self, header: &mixdog_store::schema::record::Header) -> mixdog_app_protocol::v2::thread::ThreadRoute {
        super::super::host_seams::ConfigSeams::route_config(&Config, header)
    }
    fn settings_changes(&self, _: &ThreadId) -> Option<mixdog_core_session::session::turn_ops::SettingsFeed> {
        None
    }
    fn run_settings(&self, thread: &ThreadId, header: &mixdog_store::schema::record::Header) -> super::super::assemble::RunSettings {
        let mut settings = super::super::host_seams::ConfigSeams::run_settings(&Config, thread, header);
        settings.compact = Some(mixdog_agent::boundary::CompactSettings {
            auto: self.auto,
            context_window: Some(100_000),
            target_tokens: Some(2_500),
            token_calibration: 1.0,
            ..Default::default()
        });
        settings
    }
    fn stored_instruction_files(&self) -> Option<Value> {
        None
    }
    fn response_language(&self) -> Option<(String, String)> {
        None
    }
}

/// A local Anthropic endpoint behind the real adapter: it keeps every model request's JSON body and answers by what the
/// last message carries, reporting tiered usage only the message marker can explain (a five-minute write after the
/// cached read of the previous request's extent; a shrunken transcript reads nothing).
#[derive(Default)]
struct CacheEndpoint {
    bodies: Mutex<Vec<Value>>,
    extent: Mutex<(usize, u64)>,
}

impl CacheEndpoint {
    /// A model request of the session's turns: it carries the session's tools (a summary request carries none).
    fn main(body: &Value) -> bool {
        body["tools"].as_array().is_some_and(|tools| !tools.is_empty()) && body["max_tokens"] != 1
    }
    fn sse(&self, body: &Value) -> String {
        let messages = body["messages"].as_array().cloned().unwrap_or_default();
        let text = body.to_string();
        if !Self::main(body) {
            let usage = json!({ "input_tokens": 10, "output_tokens": 1 });
            return [
                ("message_start", json!({ "type": "message_start", "message": { "id": "msg_s", "type": "message", "role": "assistant", "model": "claude-test", "content": [], "stop_reason": null, "usage": usage } })),
                ("content_block_start", json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "text", "text": "" } })),
                ("content_block_delta", json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "HANDOFF-SUMMARY: the log was read." } })),
                ("content_block_stop", json!({ "type": "content_block_stop", "index": 0 })),
                ("message_delta", json!({ "type": "message_delta", "delta": { "stop_reason": "end_turn" }, "usage": { "output_tokens": 2 } })),
                ("message_stop", json!({ "type": "message_stop" })),
            ]
            .iter()
            .map(|(name, data)| format!("event: {name}\ndata: {data}\n\n"))
            .collect();
        }
        let (count, extent) = *lock(&self.extent);
        let read = if messages.len() >= count { extent } else { 0 };
        let created = 100 * (lock(&self.bodies).iter().filter(|b| Self::main(b)).count() as u64 + 1);
        *lock(&self.extent) = (messages.len(), read + created);
        let has = |id: &str| text.contains(&format!("\"tool_use_id\":\"{id}\""));
        let call = |id: &str, name: &str| Some((id.to_owned(), name.to_owned()));
        let last_text = messages.last().map(|m| m.to_string()).unwrap_or_default();
        let tool = if has("toolu_c3") {
            None
        } else if has("toolu_c2") {
            call("toolu_c3", "glob")
        } else if last_text.contains("now wait") {
            call("toolu_c2", "list")
        } else if has("toolu_c1") {
            None
        } else {
            call("toolu_c1", "grep")
        };
        let usage = json!({ "input_tokens": 10, "output_tokens": 1, "cache_read_input_tokens": read, "cache_creation_input_tokens": created, "cache_creation": { "ephemeral_5m_input_tokens": created, "ephemeral_1h_input_tokens": 0 } });
        let start = json!({ "type": "message_start", "message": { "id": "msg_1", "type": "message", "role": "assistant", "model": "claude-test", "content": [], "stop_reason": null, "usage": usage } });
        let (block, delta, stop) = match tool {
            Some((id, name)) => {
                (json!({ "type": "tool_use", "id": id, "name": name, "input": {} }), json!({ "type": "input_json_delta", "partial_json": "{}" }), "tool_use")
            }
            None => (json!({ "type": "text", "text": "" }), json!({ "type": "text_delta", "text": "done" }), "end_turn"),
        };
        [
            ("message_start", start),
            ("content_block_start", json!({ "type": "content_block_start", "index": 0, "content_block": block })),
            ("content_block_delta", json!({ "type": "content_block_delta", "index": 0, "delta": delta })),
            ("content_block_stop", json!({ "type": "content_block_stop", "index": 0 })),
            ("message_delta", json!({ "type": "message_delta", "delta": { "stop_reason": stop }, "usage": { "output_tokens": 2 } })),
            ("message_stop", json!({ "type": "message_stop" })),
        ]
        .iter()
        .map(|(name, data)| format!("event: {name}\ndata: {data}\n\n"))
        .collect()
    }
}

struct OneBody(Option<bytes::Bytes>);

#[async_trait]
impl mixdog_ai::transport::BodyStream for OneBody {
    async fn next(&mut self) -> Option<Result<bytes::Bytes, mixdog_core_api::domain::provider::TransportFault>> {
        self.0.take().map(Ok)
    }
}

#[async_trait]
impl mixdog_ai::transport::http::HttpSend for CacheEndpoint {
    async fn send(
        &self,
        request: mixdog_core_api::domain::provider::WireRequest,
        _: mixdog_ai::transport::Exchange,
    ) -> Result<mixdog_ai::transport::http::HttpResponse, ProviderError> {
        let body: Value = serde_json::from_slice(&request.body).unwrap_or(Value::Null);
        let reply = self.sse(&body);
        lock(&self.bodies).push(body);
        Ok(mixdog_ai::transport::http::HttpResponse {
            status: 200,
            headers: vec![("content-type".into(), "text/event-stream".into())],
            body: Box::new(OneBody(Some(reply.into()))),
        })
    }
}

struct TestKey;

#[async_trait]
impl mixdog_ai::providers::anthropic::ApiKeySource for TestKey {
    async fn key(&self) -> Result<String, ProviderError> {
        Ok("not-a-credential".into())
    }
    async fn reload(&self) -> Result<String, ProviderError> {
        Ok("not-a-credential".into())
    }
}

/// A tool whose result is fixed text.
struct Says(ToolSpec, String);

#[async_trait]
impl Tool for Says {
    fn spec(&self) -> &ToolSpec {
        &self.0
    }
    async fn call(&self, _: &ToolContext, _: JsonValue) -> ToolOutcome {
        Ok(ToolOutput { parts: vec![ToolPart::Text(self.1.clone())], ..ToolOutput::default() })
    }
}

/// A tool that answers only when the test lets it, after telling the test it is waiting.
struct Held(ToolSpec, Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>);

#[async_trait]
impl Tool for Held {
    fn spec(&self) -> &ToolSpec {
        &self.0
    }
    async fn call(&self, _: &ToolContext, _: JsonValue) -> ToolOutcome {
        self.1.notify_one();
        self.2.notified().await;
        Ok(ToolOutput { parts: vec![ToolPart::Text("RECENT-RESULT".into())], ..ToolOutput::default() })
    }
}

const OLD_PAYLOAD: &str = "OLD-PAYLOAD-7f3a ";

/// Two turns of a session through the real turn path, real Anthropic adapter and the run host's compactor, with the
/// clock moved by `wait_ms` while the second turn's tool runs. Returns the endpoint's model request bodies and the thread.
async fn tool_wait_turns(wait_ms: i64) -> (Vec<Value>, Value) {
    let endpoint = Arc::new(CacheEndpoint::default());
    let mut config = mixdog_ai::providers::anthropic::AnthropicConfig::new(Arc::new(|_: &str| {
        Some(mixdog_ai::providers::anthropic::ModelCaps { max_output_tokens: Some(4096), ..Default::default() })
    }));
    // Not the official URL: the body goes out plain.
    config.base_url = "http://anthropic.test".into();
    let adapter =
        mixdog_ai::providers::anthropic::AnthropicAdapter::api_key(config, endpoint.clone(), Arc::new(TestKey), mixdog_rt::testing::tokens().cpu_bulk);
    let clock = Arc::new(Moving(AtomicI64::new(1_700_000_000_000)));
    let (waiting, release) = (Arc::new(tokio::sync::Notify::new()), Arc::new(tokio::sync::Notify::new()));
    let spec = |name: &str| named_spec(name);
    let pool: Vec<Arc<dyn Tool>> = vec![
        // Builtin names, so the session's tool set offers them.
        Arc::new(Says(spec("grep"), OLD_PAYLOAD.repeat(1_000))),
        Arc::new(Held(spec("list"), waiting.clone(), release.clone())),
        Arc::new(Says(spec("glob"), "MORE".into())),
        named("Skill"),
    ];
    let world = turn_world_at(
        Arc::new(adapter),
        Arc::new(NoMcp),
        Vec::new(),
        false,
        None,
        Some(pool),
        Arc::new(MockFileService::default()),
        true,
        clock.clone(),
        Arc::new(Windowed { auto: false }),
        true,
        None,
    )
    .await;
    let tools = json!([{ "name": "grep" }, { "name": "list" }, { "name": "glob" }]);
    let (id, handle) = started_thread(&world, json!({ "provider": "anthropic", "model": "claude-test", "tools": tools })).await;
    let completed = || world.rig.feeds.frames(id.as_str()).into_iter().filter(|(_, m, _)| m == "turn/completed").count();
    handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "read the log" } }), "op-1")).await.expect("turn/start");
    eventually_on_awaiting(|| "the first turn's end".to_owned(), &[handle.stepped()], || (completed() >= 1).then_some(())).await;
    clock.0.fetch_add(10_000, std::sync::atomic::Ordering::SeqCst);
    handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-2", "input": { "prompt": "now wait" } }), "op-2")).await.expect("turn/start");
    if mixdog_rt::time::timeout(Duration::from_secs(30), waiting.notified()).await.is_err() {
        let frames: Vec<(String, Value)> = world.rig.feeds.frames(id.as_str()).into_iter().map(|(_, m, p)| (m, p)).collect();
        panic!("the held tool never ran; sent {:#?}; frames {frames:#?}", lock(&endpoint.bodies).iter().map(|b| b["messages"].to_string()).collect::<Vec<_>>());
    }
    clock.0.fetch_add(wait_ms, std::sync::atomic::Ordering::SeqCst);
    release.notify_one();
    eventually_on_awaiting(|| "the second turn's end".to_owned(), &[handle.stepped()], || (completed() >= 2).then_some(())).await;
    let all = lock(&endpoint.bodies).clone();
    let summaries = all.iter().filter(|b| !CacheEndpoint::main(b) && b["max_tokens"] != 1).count();
    let mut bodies: Vec<Value> = all.into_iter().filter(CacheEndpoint::main).collect();
    // The summary requests' count rides last.
    bodies.push(json!(summaries));
    (bodies, Value::Object((*handle.header_snapshot()).clone()))
}

fn cache_adapter(endpoint: &Arc<CacheEndpoint>) -> Arc<dyn ProviderAdapter> {
    let mut config = mixdog_ai::providers::anthropic::AnthropicConfig::new(Arc::new(|_: &str| {
        Some(mixdog_ai::providers::anthropic::ModelCaps { max_output_tokens: Some(4096), ..Default::default() })
    }));
    config.base_url = "http://anthropic.test".into();
    Arc::new(mixdog_ai::providers::anthropic::AnthropicAdapter::api_key(config, endpoint.clone(), Arc::new(TestKey), mixdog_rt::testing::tokens().cpu_bulk))
}

/// The tools of [`tool_wait_turns`], the held one answering at once.
fn answering_pool() -> Vec<Arc<dyn Tool>> {
    let release = Arc::new(tokio::sync::Notify::new());
    release.notify_one();
    vec![
        Arc::new(Says(named_spec("grep"), OLD_PAYLOAD.repeat(1_000))),
        Arc::new(Held(named_spec("list"), Arc::new(tokio::sync::Notify::new()), release)),
        Arc::new(Says(named_spec("glob"), "MORE".into())),
        named("Skill"),
    ]
}

/// What the fresh host does after a restart `gap_ms` past the first turn.
enum AfterRestart {
    Turn,
    SideQuestion,
}

/// The first turn on one host, the process ending (its books gone), then a fresh host over the same store and clock,
/// `gap_ms` later, doing `after`. Returns the model request bodies the fresh host sent and its answer to a side question.
async fn first_turn_then_restart(gap_ms: i64, after: AfterRestart) -> (Vec<Value>, Option<Value>) {
    let clock = Arc::new(Moving(AtomicI64::new(1_700_000_000_000)));
    let first = Arc::new(CacheEndpoint::default());
    let world = turn_world_at(
        cache_adapter(&first),
        Arc::new(NoMcp),
        Vec::new(),
        false,
        None,
        Some(answering_pool()),
        Arc::new(MockFileService::default()),
        true,
        clock.clone(),
        Arc::new(Windowed { auto: false }),
        true,
        None,
    )
    .await;
    let tools = json!([{ "name": "grep" }, { "name": "list" }, { "name": "glob" }]);
    // The session records its model's window ([`Windowed`]'s), as a session created over a listed model does: the manual
    // pass reads it there.
    let (id, handle) = started_thread(&world, json!({ "provider": "anthropic", "model": "claude-test", "tools": tools, "contextWindow": 100_000 })).await;
    let completed = |world: &World| world.rig.feeds.frames(id.as_str()).into_iter().filter(|(_, m, _)| m == "turn/completed").count();
    handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "read the log" } }), "op-1")).await.expect("turn/start");
    eventually_on_awaiting(|| "the first turn's end".to_owned(), &[handle.stepped()], || (completed(&world) >= 1).then_some(())).await;
    assert!(handle.header_snapshot().get("cacheTailBook").is_some(), "the checkpoint holds the book");
    // The process ends here: the next host has the stored session and books of its own, none of them open.
    clock.0.fetch_add(gap_ms, std::sync::atomic::Ordering::SeqCst);
    let second = Arc::new(CacheEndpoint::default());
    let store: Arc<dyn mixdog_core_session::session::ThreadStore> = world.rig.store.clone();
    let resumed = turn_world_at(
        cache_adapter(&second),
        Arc::new(NoMcp),
        Vec::new(),
        false,
        Some(store),
        Some(answering_pool()),
        Arc::new(MockFileService::default()),
        true,
        clock.clone(),
        Arc::new(Windowed { auto: false }),
        true,
        None,
    )
    .await;
    let handle = resumed.directory.open_handle(&id, &CallContext::internal("test")).await.expect("the thread reopens from its files");
    let answer = match after {
        AfterRestart::Turn => {
            handle
                .request(request("turn/start", json!({ "threadId": id, "opId": "op-2", "input": { "prompt": "now wait" } }), "op-2"))
                .await
                .expect("turn/start");
            eventually_on_awaiting(|| "the resumed turn's end".to_owned(), &[handle.stepped()], || (completed(&resumed) >= 1).then_some(())).await;
            None
        }
        AfterRestart::SideQuestion => {
            let asked = handle.request(request("thread/askSide", json!({ "opId": "op-side", "question": "what did the log say?" }), "op-side")).await;
            Some(match asked {
                Ok(Reply::Value(value)) => value,
                Ok(_) => panic!("thread/askSide answers a value"),
                Err(error) => json!({ "error": error.to_string() }),
            })
        }
    };
    let bodies = lock(&second.bodies).iter().filter(|b| CacheEndpoint::main(b)).cloned().collect();
    (bodies, answer)
}

async fn turn_world(provider: Arc<dyn ProviderAdapter>) -> World {
    turn_world_full(provider, Arc::new(NoMcp), Vec::new(), false, None, None, Arc::new(MockFileService::default()), false).await
}

#[allow(clippy::too_many_arguments)]
async fn turn_world_full(
    provider: Arc<dyn ProviderAdapter>,
    mcp: Arc<dyn super::super::session_tools::SessionMcp>,
    connected: Vec<Arc<dyn Tool>>,
    lead: bool,
    threads: Option<Arc<dyn mixdog_core_session::session::ThreadStore>>,
    pool: Option<Vec<Arc<dyn Tool>>>,
    files: Arc<dyn mixdog_core_api::domain::fs::FileService>,
    header_surfaces: bool,
) -> World {
    turn_world_at(provider, mcp, connected, lead, threads, pool, files, header_surfaces, Arc::new(Fixed), Arc::new(Config), false, None).await
}

/// [`turn_world_full`] whose services read `clock` and whose run settings are `config`'s; with
/// `summaries_on_turn_registry` a compaction's summary goes to the turn's own provider and reads its saved requests.
#[allow(clippy::too_many_arguments)]
async fn turn_world_at(
    provider: Arc<dyn ProviderAdapter>,
    mcp: Arc<dyn super::super::session_tools::SessionMcp>,
    connected: Vec<Arc<dyn Tool>>,
    lead: bool,
    threads: Option<Arc<dyn mixdog_core_session::session::ThreadStore>>,
    pool: Option<Vec<Arc<dyn Tool>>>,
    files: Arc<dyn mixdog_core_api::domain::fs::FileService>,
    header_surfaces: bool,
    clock: Arc<dyn Clock>,
    config: Arc<dyn super::super::host_seams::ConfigSeams>,
    summaries_on_turn_registry: bool,
    first_auto_effort: Option<Arc<super::super::auto_effort::TurnAutoEffort>>,
) -> World {
    turn_world_routed(provider, mcp, connected, lead, threads, pool, files, header_surfaces, clock, config, summaries_on_turn_registry, first_auto_effort, None)
        .await
}

/// The providers a [`turn_world_routed`] registry builds and the agent config its route hops read; its hops write the
/// session through the production route adapter. The hops read `config` as it stands at each read, so a test may edit
/// it between turns.
struct Routed {
    builder: Arc<dyn mixdog_ai::registry::providers::ProviderBuilder>,
    config: Arc<Mutex<serde_json::Map<String, Value>>>,
    /// What a route change of its hops reads: nothing ([`NoRouteFacts`]) unless a test gives its own.
    facts: Arc<dyn super::super::route_change::RouteFacts>,
}

fn routed(builder: Arc<dyn mixdog_ai::registry::providers::ProviderBuilder>, config: Value) -> Routed {
    Routed { builder, config: Arc::new(Mutex::new(config.as_object().expect("an agent config").clone())), facts: Arc::new(NoRouteFacts) }
}

/// [`turn_world_at`]; with `routed`, a registry over `routed`'s providers and route hops that write the session.
#[allow(clippy::too_many_arguments)]
async fn turn_world_routed(
    provider: Arc<dyn ProviderAdapter>,
    mcp: Arc<dyn super::super::session_tools::SessionMcp>,
    connected: Vec<Arc<dyn Tool>>,
    lead: bool,
    threads: Option<Arc<dyn mixdog_core_session::session::ThreadStore>>,
    pool: Option<Vec<Arc<dyn Tool>>>,
    files: Arc<dyn mixdog_core_api::domain::fs::FileService>,
    header_surfaces: bool,
    clock: Arc<dyn Clock>,
    config: Arc<dyn super::super::host_seams::ConfigSeams>,
    summaries_on_turn_registry: bool,
    first_auto_effort: Option<Arc<super::super::auto_effort::TurnAutoEffort>>,
    routed: Option<Routed>,
) -> World {
    let workspace = tempfile::tempdir().unwrap();
    let rig = Rig::new();
    let tokens = mixdog_rt::testing::tokens();
    let ledger = Arc::new(Ledger::default());
    let sink: Arc<dyn mixdog_ai::registry::accounting::UsageSink> = ledger.clone();
    let accounting = mixdog_ai::registry::accounted::AccountingDeps::new(Arc::new(Pricing), Arc::new(move || Some(sink.clone())));
    let mut pool: Vec<Arc<dyn Tool>> = pool.unwrap_or_else(|| vec![named("list"), named("Skill")]);
    // A Lead world's bridge sessions reach their deferred tools through the product's `call_tool`.
    let late_catalog = Arc::new(LateCatalog::default());
    if lead {
        pool.push(Arc::new(mixdog_tools::orch::bridge::CallTool::new(late_catalog.clone(), Arc::new(Unprojected))));
    }
    let processes: Arc<dyn mixdog_core_api::domain::process::ProcessManager> = Arc::new(MockProcessManager::default());
    let connectors: Arc<dyn mixdog_tools::policy::ConnectorPermissions> = mixdog_mcp::permissions::ConnectorPolicy::new(
        workspace.path().to_path_buf(),
        mixdog_mcp::permissions::PolicyIo { maintenance: tokens.maintenance_io, interactive: tokens.interactive_io, durability: tokens.durability_io },
    );
    let data = workspace.path().join("data");
    let judge = mixdog_services::effort_judge::judge::EffortJudgeModel::with_options(
        mixdog_services::effort_judge::model::ModelConfig::in_data_dir(
            &data,
            mixdog_services::effort_judge::model::OrtRuntime::Library(workspace.path().join("no-ort.dll")),
        ),
        mixdog_services::effort_judge::JudgeLanes::of(&tokens),
        mixdog_services::effort_judge::judge::JudgeOptions::default(),
    )
    .unwrap();
    let store = Arc::new(super::super::side_question_store::SideQuestionStore::new());
    let (builder, hop_config) = match routed {
        Some(Routed { builder, config, facts }) => (builder, Some((config, facts))),
        None => (Arc::new(OneProvider(provider.clone())) as Arc<dyn mixdog_ai::registry::providers::ProviderBuilder>, None),
    };
    let hop_clocks: (Arc<dyn Clock>, Arc<dyn mixdog_core_session::session::Clock>) = (clock.clone(), rig.clock.clone());
    let registry = Arc::new(mixdog_ai::registry::providers::ProviderRegistry::new(builder).with_accounting(accounting));
    let world_registry = registry.clone();
    let compaction = if summaries_on_turn_registry {
        super::super::compaction_world::tests::services_over(
            workspace.path(),
            json!({}),
            Arc::default(),
            store.clone(),
            registry.clone(),
            serde_json::Map::new(),
        )
        .await
    } else {
        super::super::compaction_world::tests::services(workspace.path(), json!({}), Arc::default()).await
    };
    let hook_bus = mixdog_mcp::hook_bus::HookBus::new(data.clone(), tokens.maintenance_io, processes.clone(), None, None, None);
    let next = super::super::next_request_source::NextRequestSource::new();
    let (kept, side_store, side_next) = (store.clone(), store.clone(), next.clone());
    let liveness =
        outside_tests::LIVENESS.with(|slot| slot.borrow_mut().take()).unwrap_or_else(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new);
    let asked = Arc::new(AskedFor::default());
    let exclusions: Arc<mixdog_core_session::session::SessionToolExclusions> = Arc::default();
    let surfaces_from = exclusions.clone();
    let (compaction_docs, compaction_reader, compaction_facts, compaction_config) =
        (compaction.docs.clone(), compaction.reader.clone(), compaction.attachment_facts.clone(), compaction.config.clone());
    let compactors = Arc::new(super::super::compactors::SessionCompactors::new(
        Arc::new(super::super::compaction_world::ProcessCompactionWorld::new(compaction)),
        clock.clone(),
    ));
    // A world wired as the composition wires compaction (summaries on the turn's registry) also compacts a session on
    // `thread/compact/start` with the host's own manual pass, over the same compactor the turns use.
    let late = Arc::new(super::super::compose_parts::LateDirectory::default());
    let manual: Option<Arc<dyn mixdog_core_session::session::turn_ops::ManualCompaction>> = summaries_on_turn_registry.then(|| {
        let threads: Arc<dyn mixdog_core_ports::ports::threads::ThreadState> = Arc::new(super::super::compose_parts::LateThreads(late.clone()));
        Arc::new(super::super::manual_compaction::HostManualCompaction::new(super::super::manual_compaction::ManualParts {
            world: Arc::new(ManualWorld { threads: threads.clone(), window: 100_000 }),
            threads,
            config: config.clone(),
            compactors: compactors.clone(),
            directory: late.clone(),
            hooks: Arc::new(ManualNoHooks),
            gauge: Arc::new(ManualGauge),
            clock: clock.clone(),
            recover: Arc::new(|_| {}),
            io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
            data_dir: data.clone(),
            blobs: Arc::new(NoBlobs),
            reuses: Arc::default(),
        })) as Arc<dyn mixdog_core_session::session::turn_ops::ManualCompaction>
    });
    // A world over a real store hosts a stored session: its surface is the production one, the header's tools.
    let production_surface = threads.is_some();
    let thread_store = threads.unwrap_or_else(|| -> Arc<dyn mixdog_core_session::session::ThreadStore> { rig.store.clone() });
    let rig_deps = rig.deps_parts(thread_store);
    let gateway = rig_deps.gateway_usage.clone();
    let route_facts = super::super::compaction_world::tests::facts_in(workspace.path(), registry.clone()).await;
    let parts = super::super::turn_path::TurnPathParts {
        tokens: tokens.clone(),
        clock: clock.clone(),
        paths: mixdog_store::paths::Paths { plugin_root: workspace.path().join("plugin"), data_dir: data },
        facts: route_facts,
        effort_judge: judge,
        side: super::super::side_requests::SideRequests {
            store: kept,
            caching: Arc::new(|_, _| false),
            docs: compaction_docs,
            reader: compaction_reader,
            facts: compaction_facts,
            clock: clock.clone(),
        },
        next: next.clone(),
        files,
        processes,
        policy: Arc::new(mixdog_tools::policy::ToolPolicy::new(Arc::new(mixdog_tools::policy::MemoryGrantStore::default()), connectors.clone())),
        connectors,
        resolver: Arc::new(PoolResolver(pool.iter().chain(&connected).cloned().collect())),
        unattended: crate::run_host::unattended::UnattendedRunRegistry::new(Arc::new(NoStamps)),
        approvals: asked.clone(),
        exclusions,
        agents: Arc::new(mixdog_core_agents::agents::AgentDefinitions::new(
            workspace.path().join("shipped"),
            workspace.path().join("agents"),
            tokens.interactive_io,
            mixdog_core_config::config::AgentRoutes::new(compaction_config, workspace.path()),
            Arc::new(NoEvidence),
            Arc::new(|| json!({})),
            workspace.path(),
        )),
        allow_all: Arc::new(AllowNone),
        hub: (mixdog_mcp::McpHub::new(
            mixdog_mcp::McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io, cpu: tokens.cpu_bulk },
            workspace.path().to_path_buf(),
            Default::default(),
        )),
        blobs: Arc::new(NoBlobs),
        tool_pool: pool,
        mcp: mcp.clone(),
        skills_listed: Arc::new(NoSkills),
        skill_names: Arc::new(NoSkillNames),
        skill_deliveries: None,
        ext_pool: Arc::new(mixdog_core_api::domain::mock::MockExtPool::new(4)),
        hook_bus,
        hook_common: Arc::new(|_| mixdog_mcp::hook_bus::HookCommon::default()),
        goals: Arc::new(rig.goals.clone()),
        todos: rig.todos.clone(),
        work: rig.work.clone(),
        config,
        settings: super::super::settings::SettingsSources {
            wiring: Arc::new(NoWiring),
            attachments: Arc::new(NoAttachmentText),
            media: None,
            heartbeats: Arc::new(NoMarks),
            ceilings: Arc::new(NoCeilings),
            auto_effort: Arc::new(AutoOff),
            first_auto_effort,
            vision: None,
        },
        ladder: Arc::new(NoLadder),
        shells: None,
        liveness,
        search_usage: mixdog_tools::web::NativeSearchUsageSinks::new(),
        reuses: Arc::default(),
        outside: outside_tests::OUTSIDE.with(|slot| slot.borrow_mut().take()),
        deps: Box::new({
            move |runs| {
                let mut deps = rig_deps;
                deps.runs = runs;
                if let Some(manual) = manual {
                    deps.compaction = manual;
                }
                if production_surface {
                    deps.surfaces = Arc::new(mixdog_core_session::session::HeaderToolSurfaces::new(Arc::new(mixdog_core_session::session::NoRouteExclusions)));
                }
                deps.side = Arc::new(super::super::side_question_store::SideQuestionService::new(side_store, side_next));
                // A Lead world's sessions are judged by the surface the composition derives from the header (`compose_flip`).
                if lead {
                    deps.surfaces = Arc::new(mixdog_core_session::session::HeaderToolSurfaces::new(surfaces_from));
                } else if header_surfaces {
                    deps.surfaces = Arc::new(mixdog_core_session::session::HeaderToolSurfaces::new(Arc::new(mixdog_core_session::session::NoRouteExclusions)));
                }
                deps
            }
        }),
        compactors,
        hops: Box::new({
            let registry_dir = workspace.path().join("catalog");
            let provider_id = provider.id().as_str().to_owned();
            move |directory, route_facts| {
                let io = mixdog_ai::oauth::CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
                let metadata = mixdog_ai::catalog::ModelsDevSource::new(Arc::new(Offline), registry_dir, io);
                let catalog = futures::executor::block_on(mixdog_ai::catalog::CatalogService::cold_start(
                    mixdog_ai::catalog::CatalogSnapshot::default(),
                    Vec::new(),
                    metadata,
                ));
                // A routed world's hops write the session as the composition's do (`compose_flip`): the route adapter over
                // the directory, with the route change the run host computes.
                let (config, sessions): (mixdog_core_run::run_host::hop_host::ConfigSnapshot, Arc<dyn mixdog_core_run::run_host::hop_host::HopSessions>) =
                    match hop_config {
                        Some((config, facts)) => {
                            let (run_clock, session_clock) = hop_clocks;
                            let change = Arc::new(super::super::route_change::RunHostRouteChange::new(facts, run_clock));
                            let threads = Arc::new(mixdog_core_session::session::thread_state::SessionThreads::new(directory.clone()));
                            let routes = Arc::new(HopRouteConfig(lock(&config).clone()));
                            let adapter = Arc::new(mixdog_core_session::session::route_session::SessionRouteAdapter::new(
                                directory.clone(),
                                threads,
                                change,
                                routes.clone(),
                                routes.clone(),
                                routes,
                                session_clock,
                            ));
                            (
                                Arc::new(move || lock(&config).clone()) as mixdog_core_run::run_host::hop_host::ConfigSnapshot,
                                Arc::new(mixdog_core_session::session::route_session::SessionHops::new(adapter))
                                    as Arc<dyn mixdog_core_run::run_host::hop_host::HopSessions>,
                            )
                        }
                        None => (
                            Arc::new(move || {
                                let mut providers = serde_json::Map::new();
                                providers.insert(provider_id.clone(), json!({ "enabled": true, "apiKey": "sk-test" }));
                                let mut cfg = serde_json::Map::new();
                                cfg.insert("providers".into(), Value::Object(providers));
                                cfg
                            }) as mixdog_core_run::run_host::hop_host::ConfigSnapshot,
                            Arc::new(OpenHopSessions) as Arc<dyn mixdog_core_run::run_host::hop_host::HopSessions>,
                        ),
                    };
                mixdog_core_run::run_host::hop_host::HopFactory::new(
                    mixdog_core_run::run_host::hop_host::HopDeps {
                        facts: route_facts.clone(),
                        catalog: Arc::new(catalog),
                        config,
                        bots: Arc::new(NoBots),
                        errors: Arc::new(|e| e.message.clone()),
                        wiring: Arc::new(NoWiring),
                    },
                    sessions,
                )
            }
        }),
    };
    let path = super::super::turn_path::TurnPath::new(parts).expect("turn path");
    // No provider is registered ahead: as after a restart, the turn's first request readies the thread's provider.
    assert!(registry.get("scripted").await.is_none());
    let directory = path.directory.clone();
    late.bind(&directory);
    // The settings host the composition binds: here one whose live settings are one key, `responseLanguage`, that a
    // turn start writes into the header when it moved (`settings`, empty: nothing moved).
    let settings = Arc::new(Mutex::new(serde_json::Map::new()));
    assert!(!lead, "a Lead surface host needs the recorded tool pool, which only the local comparison build has");
    assert!(path.turn_settings.bind(Arc::new(LiveSettings(directory.clone(), settings.clone()))).is_ok());
    World { workspace, rig, ledger, asked, store, next, directory, registry: world_registry, live_settings: settings, gateway }
}

/// The two providers of a switched-off test: `primary` and the Codex fallback `openai-oauth`, each answering `answers`
/// requests, behind a registry that builds either.
fn switched_off_pair(answers: usize) -> (Arc<Scripted>, Arc<Scripted>, Arc<GatedProviders>) {
    let scripted = |id: &str| {
        let reply = || {
            vec![
                StreamEvent::TextDelta(format!("from {id}")),
                StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None },
            ]
        };
        Arc::new(Scripted {
            id: ProviderId::from(id),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new((0..answers).map(|_| reply()).collect()),
            requests: Mutex::new(Vec::new()),
            fail_first: std::sync::atomic::AtomicBool::new(false),
        })
    };
    let (primary, fallback) = (scripted("primary"), scripted("openai-oauth"));
    let providers =
        GatedProviders::new(vec![("primary", primary.clone() as Arc<dyn ProviderAdapter>), ("openai-oauth", fallback.clone() as Arc<dyn ProviderAdapter>)]);
    (primary, fallback, providers)
}

/// One turn of `id` (`op`), the `count`th, settled.
async fn settled_turn(world: &World, id: &ThreadId, handle: &Arc<mixdog_core_session::session::SessionHandle>, op: &str, count: usize) {
    let covered = handle.header_snapshot().get("turnCoverage").cloned();
    let started = handle.request(request("turn/start", json!({ "threadId": id, "opId": op, "input": { "prompt": op } }), op)).await.expect("turn/start");
    assert!(matches!(started, Reply::Value(_)), "turn/start answers a value");
    settled_turns(world, id, handle, count, covered).await;
}

#[async_trait]
impl mixdog_core_ports::ports::tools_status::SurfaceHost for Reconciling {
    fn mode(&self, _: Option<&mixdog_store::schema::record::Header>) -> String {
        "lead".into()
    }
    async fn preview(&self) -> Result<mixdog_tools::orch::status::StatusSurface, mixdog_core_api::CoreError> {
        Ok(mixdog_tools::orch::status::StatusSurface::default())
    }
    async fn reconcile_empty(&self, thread: &ThreadId) -> Result<(), mixdog_core_api::CoreError> {
        use mixdog_core_ports::ports::threads::ThreadState;
        let set = json!({ "settingsReconciledAt": 1 }).as_object().unwrap().clone();
        mixdog_core_session::session::thread_state::SessionThreads::new(self.0.clone())
            .patch_header(thread, set, Vec::new())
            .await
            .map_err(|_| mixdog_core_api::CoreError::ThreadNotFound { thread_id: thread.clone() })
    }
}

/// The production `tools/toolsStatus` service over the world's threads and its request source.
fn tools_status(world: &World) -> mixdog_tools::orch::status::ToolsService {
    let threads = Arc::new(mixdog_core_session::session::thread_state::SessionThreads::new(world.directory.clone()));
    let surface = mixdog_core_ports::ports::tools_status::SessionToolStatus::new(threads, Arc::new(Reconciling(world.directory.clone())))
        .with_snapshots(world.next.clone());
    mixdog_tools::orch::status::ToolsService::new(Arc::new(surface))
}

/// The snapshot taken now, and the request the thread's next turn (`op`, prompt `go`) then hands the provider,
/// encoded the same way.
async fn snapshot_then_turn(
    world: &World,
    provider: &Arc<Handing>,
    heard: &mut tokio::sync::mpsc::UnboundedReceiver<Arc<ModelRequest>>,
    id: &ThreadId,
    handle: &Arc<mixdog_core_session::session::SessionHandle>,
    op: &str,
) -> (Value, Value) {
    let status = snapshot_call(&tools_status(world), id, "go").await;
    let started = handle.request(request("turn/start", json!({ "threadId": id, "opId": op, "input": { "prompt": "go" } }), op)).await.expect("turn/start");
    let Reply::Value(started) = started else { panic!("turn/start answers a value") };
    assert_eq!(started["kind"], "started", "{op}");
    let sent = mixdog_rt::time::timeout(Duration::from_secs(30), heard.recv())
        .await
        .unwrap_or_else(|_| panic!("timed out after 30000 ms awaiting the request turn {op} hands the provider"))
        .expect("the provider is alive");
    let handed = super::super::request_snapshot::snapshot(&handle.live_header().header(), &**provider, &sent).expect("the sent request encodes");
    (status["requestSnapshot"].clone(), handed)
}

/// The composition of a turn: TurnPath::new over test implementations of the missing owner traits and the scripted
/// provider behind the accounted registry.
struct World {
    workspace: tempfile::TempDir,
    rig: Rig,
    ledger: Arc<Ledger>,
    asked: Arc<AskedFor>,
    store: Arc<super::super::side_question_store::SideQuestionStore>,
    next: Arc<super::super::next_request_source::NextRequestSource>,
    directory: Arc<SessionDirectory>,
    /// The turns' provider registry, which the cache warmer's ports read too.
    registry: Arc<mixdog_ai::registry::providers::ProviderRegistry>,
    /// The live settings a turn start brings the header to ([`LiveSettings`]); empty moves nothing.
    live_settings: Arc<Mutex<serde_json::Map<String, Value>>>,
    /// Where the sessions record each settled ask, the statusline footer's route spend.
    gateway: mixdog_core_session::session::gateway_usage::GatewayUsage,
}

async fn started_thread(world: &World, header: Value) -> (ThreadId, Arc<mixdog_core_session::session::SessionHandle>) {
    let reply = world
        .directory
        .request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": world.workspace.path() }), "op-start"))
        .await
        .expect("thread/start");
    let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
    let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
    let handle = world.directory.handle(&id).expect("loaded");
    handle
        .request(CoreRequest {
            method: Method("thread/header/patch"),
            params: json!({ "threadId": id, "set": header }),
            op: None,
            ctx: CallContext::internal("test"),
        })
        .await
        .expect("route");
    (id, handle)
}

/// Waits until `count` runs of the thread have completed in the store and the last turn's settlement is over: the
/// coverage stamp is written before the Goal settlement comes back (`JobDone::GoalSettled`), and a turn started
/// while the actor is still busy settling is queued. `covered_before` is the stamp before the turn started.
async fn settled_turns(world: &World, id: &ThreadId, handle: &Arc<mixdog_core_session::session::SessionHandle>, count: usize, covered_before: Option<Value>) {
    let done = || {
        world
            .rig
            .store
            .records(id)
            .into_iter()
            .filter(|(_, record)| matches!(record, Record::Run(run) if run.phase == mixdog_store::schema::record::RunPhase::Completed))
            .count()
    };
    let covered = || handle.header_snapshot().get("turnCoverage").cloned();
    eventually_on_awaiting(
        || format!("{count} completed runs of {}, the changed turnCoverage stamp and an idle actor", id.as_str()),
        &[&world.rig.store.committed, handle.stepped()],
        || (done() >= count && covered() != covered_before && !handle.turn_busy()).then_some(()),
    )
    .await;
}

/// The whole of what is stored for a thread and its session directory, as Debug text: every record of the store (header,
/// transcript items, ends), the live header, the accounting rows, and every file under the workspace with its bytes.
fn stored_state(world: &World, id: &ThreadId, handle: &Arc<mixdog_core_session::session::SessionHandle>) -> String {
    fn files(dir: &std::path::Path, out: &mut Vec<String>) {
        let mut entries: Vec<_> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().path()).collect();
        entries.sort();
        for path in entries {
            if path.is_dir() {
                files(&path, out);
            } else {
                out.push(format!("{}={:?}", path.display(), std::fs::read(&path).unwrap()));
            }
        }
    }
    let mut on_disk = Vec::new();
    files(world.workspace.path(), &mut on_disk);
    format!("{:#?}\n{:#?}\n{:#?}\n{:#?}", world.rig.store.records(id), handle.live_header().header(), lock(&world.ledger.0), on_disk)
}
