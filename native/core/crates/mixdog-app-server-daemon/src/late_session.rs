//! The seams of the composition that are a true cycle through the session directory, and the media layer's one late cell.
//!
//! The directory is built by `TurnPath::new`, from the tool pool; the pool holds the `setup` tool,
//! which holds the desktop request broker (`SetupRequests`, whose `SetupUiSurface` is
//! `SessionSetupUi` over the directory) and the setup callers (`CallerSessions` over the directory).
//! Neither can be built after the directory, so each is a cell bound once, right after it:
//! `LateSetupUi::bind(Arc::new(SessionSetupUi::new(directory, outgoing)))`, and `LateCallerSessions`
//! reads the same [`LateDirectory`] the other late views read.
//!
//! Nothing calls either before the bind: a setup request or a setup caller exists only inside a
//! turn, and a turn needs the directory. Unbound they answer as an unknown thread would.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core::run_host::compose_parts::LateDirectory;
use mixdog_core::run_host::late::Bound;
use mixdog_core_agents::setup::SetupUiSurface;
use mixdog_core_api::CoreError;
use mixdog_protocol::ThreadId;
use serde_json::{Map, Value};

use crate::compose_mcp::CallerSessions;

/// `SetupRequests`' surface, bound to `SessionSetupUi` once the directory exists.
#[derive(Default)]
pub struct LateSetupUi(OnceLock<Arc<dyn SetupUiSurface>>);

impl LateSetupUi {
    /// Binds the surface; a second bind is refused.
    pub fn bind(&self, surface: Arc<dyn SetupUiSurface>) -> Result<(), Arc<dyn SetupUiSurface>> {
        self.0.set(surface)
    }
}

#[async_trait]
impl SetupUiSurface for LateSetupUi {
    async fn notify(&self, thread: &ThreadId, request_id: &str, window: Duration) -> bool {
        match self.0.get() {
            Some(surface) => surface.notify(thread, request_id, window).await,
            None => false,
        }
    }

    /// Unbound, no request was ever shown, so there is nothing to settle.
    async fn settled(&self, thread: &ThreadId, request_id: &str) {
        if let Some(surface) = self.0.get() {
            surface.settled(thread, request_id).await;
        }
    }
}

impl Bound for LateSetupUi {
    fn cell(&self) -> &'static str {
        "setup ui surface"
    }

    fn is_bound(&self) -> bool {
        self.0.get().is_some()
    }
}

/// `SetupSeams.sessions` over the late directory.
pub struct LateCallerSessions(pub Arc<LateDirectory>);

#[async_trait]
impl CallerSessions for LateCallerSessions {
    async fn header(&self, thread: &ThreadId) -> Option<Map<String, Value>> {
        self.0.directory()?.stored_header(thread).await
    }

    async fn acting_agent(&self, thread: &ThreadId) -> Result<String, CoreError> {
        match self.0.directory() {
            Some(directory) => mixdog_core_session::session::SessionDirectory::acting_agent(&directory, thread).await,
            None => Err(CoreError::ThreadNotFound { thread_id: thread.clone() }),
        }
    }
}

impl Bound for LateCallerSessions {
    fn cell(&self) -> &'static str {
        "late caller sessions"
    }

    fn is_bound(&self) -> bool {
        self.0.is_bound()
    }
}

/// The `RouteSession` of the context world, bound to the directory's `SessionRouteAdapter` once the directory exists. The manual
/// compaction (a `TurnPath::new` input) reads it, and the adapter needs the directory: a true cycle. A call before the bind is a typed
/// `Unavailable` where the method can fail; the two synchronous reads have no error channel, so they `expect` the cell that `verify_bound`
/// proved bound before the first connection (the same rule as the live-directory read).
#[derive(Default)]
pub struct LateRouteSession(OnceLock<Arc<dyn mixdog_core_ports::ports::route::RouteSession>>);

impl LateRouteSession {
    pub fn bind(&self, session: Arc<dyn mixdog_core_ports::ports::route::RouteSession>) -> Result<(), &'static str> {
        self.0.set(session).map_err(|_| "route session")
    }

    fn bound(&self) -> Result<&Arc<dyn mixdog_core_ports::ports::route::RouteSession>, mixdog_tools::orch::util::PortError> {
        self.0.get().ok_or_else(|| mixdog_tools::orch::util::PortError::Unavailable {
            capability: "route session".to_owned(),
            message: "the route session was not bound before the server accepted connections".to_owned(),
        })
    }

    fn expect_bound(&self) -> &Arc<dyn mixdog_core_ports::ports::route::RouteSession> {
        self.0.get().expect("route session bound (compose::verify_bound)")
    }
}

#[async_trait]
impl mixdog_core_ports::ports::route::RouteSession for LateRouteSession {
    fn generation(&self, thread: &ThreadId) -> u64 {
        self.expect_bound().generation(thread)
    }

    async fn live_turn_messages(&self, thread: &ThreadId) -> Result<Vec<Value>, mixdog_tools::orch::util::PortError> {
        self.bound()?.live_turn_messages(thread).await
    }

    fn has_user_conversation(&self, messages: &[Value]) -> bool {
        self.expect_bound().has_user_conversation(messages)
    }

    async fn update_route(&self, thread: &ThreadId, fields: mixdog_core_ports::ports::route::Route, cross_provider: bool) -> Result<bool, mixdog_tools::orch::util::PortError> {
        self.bound()?.update_route(thread, fields, cross_provider).await
    }

    async fn record_boundary(&self, thread: &ThreadId, field: &str, boundary: Value) -> Result<bool, mixdog_tools::orch::util::PortError> {
        self.bound()?.record_boundary(thread, field, boundary).await
    }

    async fn rebuild_tool_surface(&self, thread: &ThreadId, provider: &str) -> Result<(), mixdog_tools::orch::util::PortError> {
        self.bound()?.rebuild_tool_surface(thread, provider).await
    }

    async fn owner_fallbacks(&self, thread: &ThreadId, header: &mixdog_store::schema::record::Header, provider: &str, model: &str) -> Result<Option<Vec<Value>>, mixdog_tools::orch::util::PortError> {
        self.bound()?.owner_fallbacks(thread, header, provider, model).await
    }

    fn write_statusline(&self, thread: &ThreadId, route: &mixdog_core_ports::ports::route::Route) {
        self.expect_bound().write_statusline(thread, route)
    }

    fn invalidate_context_status(&self, thread: &ThreadId) {
        self.expect_bound().invalidate_context_status(thread)
    }

    fn loaded(&self, thread: &ThreadId) -> bool {
        self.expect_bound().loaded(thread)
    }
}

impl Bound for LateRouteSession {
    fn cell(&self) -> &'static str {
        "route session"
    }

    fn is_bound(&self) -> bool {
        self.0.get().is_some()
    }
}
/// The `CycleBoot.llm` of the memory cycles, bound once the directory exists. The memory stack is an input of `TurnPath::new` (its search, ingest and
/// transcript offsets feed `SessionDeps` and the purge), and the `cycle1-agent` dispatch needs the built directory (`DispatchThreads`): a true cycle.
/// A cycle tick that runs before the bind gets a typed failure (the scheduler reports it as a failed cycle and tries again); `verify_bound`
/// proves the bind before the first connection, and the first tick is a timer after start-up.
#[derive(Default)]
pub struct LateCycleLlm(OnceLock<Arc<dyn mixdog_services::memory::cycles::Cycle1Llm>>);

impl LateCycleLlm {
    pub fn bind(&self, llm: Arc<dyn mixdog_services::memory::cycles::Cycle1Llm>) -> Result<(), &'static str> {
        self.0.set(llm).map_err(|_| "cycle llm")
    }
}

#[async_trait]
impl mixdog_services::memory::cycles::Cycle1Llm for LateCycleLlm {
    async fn call(&self, request: &mixdog_services::memory::cycles::Cycle1Request, cancel: &mixdog_rt::CancellationToken, prompt: &str) -> Result<String, String> {
        match self.0.get() {
            Some(llm) => llm.call(request, cancel, prompt).await,
            None => Err("the cycle dispatch was not bound before the server accepted connections".to_owned()),
        }
    }
}

impl Bound for LateCycleLlm {
    fn cell(&self) -> &'static str {
        "cycle llm"
    }

    fn is_bound(&self) -> bool {
        self.0.get().is_some()
    }
}
/// The room summaries' publish, bound once they exist. The rooms' daemon port republishes a room log's snapshot, `RoomSummaries` reads `ThreadListService`, which reads the
/// room rows, which read the room runner, which sits on the live rooms that hold the daemon port: a true cycle. A call before the bind cannot happen once `verify_bound`
/// has passed, so the reads `expect` the verified cell (the rule of the live-directory read).
#[derive(Default)]
pub struct LateRoomSummaries(OnceLock<Arc<mixdog_core_session::session::thread_list::RoomSummaries>>);

impl LateRoomSummaries {
    pub fn bind(&self, summaries: Arc<mixdog_core_session::session::thread_list::RoomSummaries>) -> Result<(), &'static str> {
        self.0.set(summaries).map_err(|_| "room summaries")
    }

    fn summaries(&self) -> &Arc<mixdog_core_session::session::thread_list::RoomSummaries> {
        self.0.get().expect("room summaries bound (compose::verify_bound)")
    }

    /// Every room's log row, published (`republish_catalog`).
    pub fn republish(&self) {
        self.summaries().republish();
    }

    /// One room log's row, published again (`republish(session)`), off the caller's thread.
    pub fn republish_session(&self, session_id: &str) {
        let (summaries, thread) = (self.summaries().clone(), ThreadId::from(session_id));
        drop(mixdog_rt::spawn("room-publish", mixdog_rt::TaskClass::Work, async move { summaries.publish_room(&thread, None).await }));
    }
}

impl Bound for LateRoomSummaries {
    fn cell(&self) -> &'static str {
        "room summaries"
    }

    fn is_bound(&self) -> bool {
        self.0.get().is_some()
    }
}
/// The takeover holds of the sessions this process hosts, for the secret fill's gates (`TakeoverGates`). The gates are built before the directory (the fill is a tool pool
/// input, the pool is a directory input): the reads `expect` the directory the verified cell holds.
pub struct LateHolds(pub Arc<LateDirectory>);

impl LateHolds {
    fn directory(&self) -> Arc<mixdog_core_session::session::SessionDirectory> {
        self.0.directory().expect("session directory bound (compose::verify_bound)")
    }
}

impl mixdog_core_session::session::secret_input::TakeoverHolds for LateHolds {
    fn hold(&self, thread: &mixdog_core_api::ids::ThreadId) -> mixdog_core_session::session::secret_input::TakeoverHold {
        self.directory().hold(thread)
    }

    fn any_screen(&self) -> bool {
        self.directory().any_screen()
    }
}

/// `abortSessionTurn(id, reason)` of the handoff env over the live directory.
pub struct LateAborts(pub Arc<LateDirectory>);

impl mixdog_core::run_host::handoff_env::TurnAborts for LateAborts {
    fn abort_session_turn(&self, thread: &mixdog_core_api::ids::ThreadId, reason: &str) -> bool {
        self.0.directory().expect("session directory bound (compose::verify_bound)").abort_session_turn(thread, reason)
    }
}

/// The computer helper pool as the secret fill and the handoff env read it. TRUE CYCLE: the pool wraps each session's backend with the fill's redaction, and the fill
/// types its Computer Use commands on the pool's helper: the pool is built second and bound here. `None` inside is "no helper binary on this machine" (the tool is then
/// not registered, and a fill finds "no desktop control is attached").
#[derive(Default)]
pub struct LateComputerHosts(OnceLock<Option<Arc<mixdog_core::run_host::native_tools::ComputerSessionPool>>>);

impl LateComputerHosts {
    pub fn bind(&self, pool: Option<Arc<mixdog_core::run_host::native_tools::ComputerSessionPool>>) -> Result<(), &'static str> {
        self.0.set(pool).map_err(|_| "computer hosts")
    }

    fn host(&self, thread: &mixdog_core_api::ids::ThreadId) -> Option<Arc<dyn mixdog_tools::state::secrets::ComputerSecretHost>> {
        use mixdog_core_session::session::secret_input::ComputerSecretHosts as _;
        self.0.get().expect("computer hosts bound (compose::verify_bound)").as_ref().and_then(|pool| pool.secret_host(thread))
    }
}

impl mixdog_core_session::session::secret_input::ComputerSecretHosts for LateComputerHosts {
    fn secret_host(&self, thread: &mixdog_core_api::ids::ThreadId) -> Option<Arc<dyn mixdog_tools::state::secrets::ComputerSecretHost>> {
        self.host(thread)
    }
}

impl mixdog_core::run_host::handoff_env::ComputerHosts for LateComputerHosts {
    fn secret_host(&self, thread: &mixdog_core_api::ids::ThreadId) -> Option<Arc<dyn mixdog_tools::state::secrets::ComputerSecretHost>> {
        self.host(thread)
    }
}

impl Bound for LateComputerHosts {
    fn cell(&self) -> &'static str {
        "computer hosts"
    }

    fn is_bound(&self) -> bool {
        self.0.get().is_some()
    }
}
/// The pool's three directory-side inputs, bound once the directory (and what it holds) exists. TRUE CYCLES, each listed in `flip-brief.md`: the `call_tool` dispatcher resolves
/// tools through the pool it sits in; the session catalog reads the surface host, which holds the pool; the `react` tool's reactions open threads on the directory the pool builds.
/// The sync reads `expect` the verified cell; the async ones answer a typed `Unavailable`.
#[derive(Default)]
pub struct LateDispatcher(OnceLock<Arc<dyn mixdog_tools::orch::bridge::ToolDispatcher>>);

impl LateDispatcher {
    pub fn bind(&self, dispatcher: Arc<dyn mixdog_tools::orch::bridge::ToolDispatcher>) -> Result<(), &'static str> {
        self.0.set(dispatcher).map_err(|_| "tool dispatcher")
    }
}

#[async_trait]
impl mixdog_tools::orch::bridge::ToolDispatcher for LateDispatcher {
    async fn dispatch(&self, ctx: &mixdog_core_api::domain::tool::ToolContext, name: &str, arguments: Value) -> mixdog_core_api::domain::tool::ToolOutcome {
        match self.0.get() {
            Some(dispatcher) => dispatcher.dispatch(ctx, name, arguments).await,
            None => Err(mixdog_core_api::domain::tool::ToolError::new(
                mixdog_core_api::domain::tool::ToolErrorCode::Unavailable { capability: "tools".to_owned(), reason: "starting".to_owned() },
                "Error: the tool dispatcher is not bound".to_owned(),
            )),
        }
    }
}

impl Bound for LateDispatcher {
    fn cell(&self) -> &'static str {
        "tool dispatcher"
    }

    fn is_bound(&self) -> bool {
        self.0.get().is_some()
    }
}

#[derive(Default)]
pub struct LateCatalog(OnceLock<Arc<dyn mixdog_tools::orch::bridge::CatalogView>>);

impl LateCatalog {
    pub fn bind(&self, catalog: Arc<dyn mixdog_tools::orch::bridge::CatalogView>) -> Result<(), &'static str> {
        self.0.set(catalog).map_err(|_| "session catalog")
    }

    fn catalog(&self) -> &Arc<dyn mixdog_tools::orch::bridge::CatalogView> {
        self.0.get().expect("session catalog bound (compose::verify_bound)")
    }
}

#[async_trait]
impl mixdog_tools::orch::bridge::CatalogView for LateCatalog {
    fn available(&self, thread: &ThreadId) -> Vec<mixdog_tools::orch::bridge::ToolDoc> {
        self.catalog().available(thread)
    }

    fn is_eager(&self, thread: &ThreadId, name: &str) -> bool {
        self.catalog().is_eager(thread, name)
    }

    fn block_reason(&self, thread: &ThreadId, name: &str) -> Option<String> {
        self.catalog().block_reason(thread, name)
    }

    fn alias_members(&self, key: &str) -> Vec<String> {
        self.catalog().alias_members(key)
    }

    fn mcp_server_members(&self, thread: &ThreadId, requested: &str) -> Vec<String> {
        self.catalog().mcp_server_members(thread, requested)
    }

    fn instructions_for(&self, thread: &ThreadId, names: &[String]) -> String {
        self.catalog().instructions_for(thread, names)
    }

    async fn announce(&self, thread: &ThreadId, names: &[String]) {
        self.catalog().announce(thread, names).await;
    }

    fn resolve_call(&self, thread: &ThreadId, name: &str) -> mixdog_tools::orch::bridge::CallResolution {
        self.catalog().resolve_call(thread, name)
    }
}

impl Bound for LateCatalog {
    fn cell(&self) -> &'static str {
        "session catalog"
    }

    fn is_bound(&self) -> bool {
        self.0.get().is_some()
    }
}

#[derive(Default)]
pub struct LateReactions(OnceLock<Arc<dyn mixdog_tools::state::react::Reactions>>);

impl LateReactions {
    pub fn bind(&self, reactions: Arc<dyn mixdog_tools::state::react::Reactions>) -> Result<(), &'static str> {
        self.0.set(reactions).map_err(|_| "reactions")
    }
}

#[async_trait]
impl mixdog_tools::state::react::Reactions for LateReactions {
    fn seat(&self, thread: &ThreadId) -> Option<mixdog_tools::state::react::ReactSeat> {
        self.0.get().expect("reactions bound (compose::verify_bound)").seat(thread)
    }

    async fn react(
        &self,
        thread: &ThreadId,
        call: &mixdog_protocol::ToolCallId,
        seat: &mixdog_tools::state::react::ReactSeat,
        emoji: Option<&str>,
        messages_back: u64,
    ) -> Result<mixdog_tools::state::react::ReactResult, mixdog_tools::orch::util::PortError> {
        match self.0.get() {
            Some(reactions) => reactions.react(thread, call, seat, emoji, messages_back).await,
            None => Err(mixdog_tools::orch::util::PortError::Unavailable { capability: "session".to_owned(), message: "reactions are not bound".to_owned() }),
        }
    }
}

impl Bound for LateReactions {
    fn cell(&self) -> &'static str {
        "reactions"
    }

    fn is_bound(&self) -> bool {
        self.0.get().is_some()
    }
}

/// The catalog the `session` tool's list reads: the thread list service, built after the pool the port sits in.
#[derive(Default)]
pub struct LateListCatalog(OnceLock<Arc<dyn mixdog_core::run_host::tool_pool::session_port::ThreadCatalog>>);

impl LateListCatalog {
    pub fn bind(&self, catalog: Arc<dyn mixdog_core::run_host::tool_pool::session_port::ThreadCatalog>) -> Result<(), &'static str> {
        self.0.set(catalog).map_err(|_| "session list catalog")
    }

    fn catalog(&self) -> Result<&Arc<dyn mixdog_core::run_host::tool_pool::session_port::ThreadCatalog>, mixdog_core_api::CoreError> {
        self.0.get().ok_or_else(|| mixdog_core_base::support::failed("session", "the session catalog is not bound"))
    }
}

#[async_trait]
impl mixdog_core::run_host::tool_pool::session_port::ThreadCatalog for LateListCatalog {
    async fn page(&self, cursor: Option<&str>, limit: usize) -> Result<mixdog_core::run_host::tool_pool::session_output::ListPage, mixdog_core_api::CoreError> {
        self.catalog()?.page(cursor, limit).await
    }

    async fn row(&self, id: &str) -> Result<Option<Value>, mixdog_core_api::CoreError> {
        self.catalog()?.row(id).await
    }

    fn live(&self) -> mixdog_core::run_host::tool_pool::session_port::LiveWork {
        self.0.get().map(|catalog| catalog.live()).unwrap_or_default()
    }

    fn work_of(&self, id: &str) -> mixdog_core::run_host::tool_pool::session_port::SessionWork {
        self.0.get().map(|catalog| catalog.work_of(id)).unwrap_or_default()
    }
}

/// What `session bots` reads besides the catalog, over the stores the daemon composes: the contact bots (off the roster when
/// the config disables them), the schedules and webhooks (`channelSetup`), the held requests of unattended runs
/// (`pendingHeldRequests`) and the report watches of task turns (`agentTaskWatches`, the home delivery, built after the pool
/// this sits in).
pub struct DaemonBotWorld {
    pub bots: Arc<dyn mixdog_core::run_host::tool_pool::session_port::BotIds>,
    pub config: mixdog_core_config::config::Config,
    pub admin: Arc<mixdog_services::channels::ChannelAdmin>,
    pub held: Arc<crate::held_requests::HeldRequests>,
    delivery: OnceLock<Arc<mixdog_services::bots::delivery::home::AgentHomeDelivery>>,
}

impl DaemonBotWorld {
    pub fn new(
        bots: Arc<dyn mixdog_core::run_host::tool_pool::session_port::BotIds>,
        config: mixdog_core_config::config::Config,
        admin: Arc<mixdog_services::channels::ChannelAdmin>,
        held: Arc<crate::held_requests::HeldRequests>,
    ) -> Self {
        Self { bots, config, admin, held, delivery: OnceLock::new() }
    }

    pub fn bind(&self, delivery: Arc<mixdog_services::bots::delivery::home::AgentHomeDelivery>) -> Result<(), &'static str> {
        self.delivery.set(delivery).map_err(|_| "bot world delivery")
    }
}

#[async_trait]
impl mixdog_core::run_host::tool_pool::session_port::BotWorld for DaemonBotWorld {
    async fn bots(&self) -> Result<Vec<mixdog_core::run_host::tool_pool::session_port::BotRow>, String> {
        let agent = self.config.agent();
        let mut rows = Vec::new();
        for id in self.bots.ids().await? {
            let name = self.bots.name(&id).await;
            let disabled = mixdog_core_config::config::agent_disabled(&agent, &id);
            rows.push(mixdog_core::run_host::tool_pool::session_port::BotRow { id, name, disabled });
        }
        Ok(rows)
    }

    async fn routines(&self) -> Result<Vec<Value>, String> {
        let setup = self.admin.get_channel_setup().await.map_err(|error| error.to_string())?;
        let mut rows = Vec::new();
        for (key, kind) in [("schedules", "schedule"), ("webhooks", "webhook")] {
            for row in setup.get(key).and_then(Value::as_array).into_iter().flatten() {
                let mut row = row.clone();
                if let Some(row) = row.as_object_mut() {
                    row.insert("kind".to_owned(), Value::String(kind.to_owned()));
                }
                rows.push(row);
            }
        }
        Ok(rows)
    }

    async fn held_requests(&self) -> Result<Vec<Value>, String> {
        self.held.pending().iter().map(|held| serde_json::to_value(held).map_err(|error| error.to_string())).collect()
    }

    async fn task_watches(&self) -> Result<Vec<Value>, String> {
        match self.delivery.get() {
            Some(delivery) => delivery.task_watches().await,
            None => Err("the report queue is not bound".to_owned()),
        }
    }
}

impl Bound for DaemonBotWorld {
    fn cell(&self) -> &'static str {
        "bot world delivery"
    }

    fn is_bound(&self) -> bool {
        self.delivery.get().is_some()
    }
}

impl Bound for LateListCatalog {
    fn cell(&self) -> &'static str {
        "session list catalog"
    }

    fn is_bound(&self) -> bool {
        self.0.get().is_some()
    }
}

/// `ThreadRequests` of the `session` tool's port over the live directory (the port is built with the pool, before the directory).
pub struct LateRequests(pub Arc<LateDirectory>);

#[async_trait]
impl mixdog_core::run_host::tool_pool::session_port::ThreadRequests for LateRequests {
    async fn request(&self, thread: &ThreadId, method: &'static str, params: Value) -> Result<Value, mixdog_core_api::CoreError> {
        match self.0.directory() {
            Some(directory) => mixdog_core::run_host::tool_pool::session_port::ThreadRequests::request(&*directory, thread, method, params).await,
            None => Err(mixdog_core_base::support::failed("session", "the session directory is not bound")),
        }
    }

    fn interrupt(&self, thread: &ThreadId) -> Result<bool, mixdog_core_api::CoreError> {
        mixdog_core::run_host::tool_pool::session_port::ThreadRequests::interrupt(&*self.0.directory().expect("session directory bound (compose::verify_bound)"), thread)
    }

    async fn transcript(&self, thread: &ThreadId) -> Result<Vec<mixdog_protocol::ThreadItem>, mixdog_core_api::CoreError> {
        match self.0.directory() {
            Some(directory) => mixdog_core::run_host::tool_pool::session_port::ThreadRequests::transcript(&*directory, thread).await,
            None => Err(mixdog_core_base::support::failed("session", "the session directory is not bound")),
        }
    }

    fn compact_after_turn(&self, thread: &ThreadId) -> Result<(), mixdog_core_api::CoreError> {
        mixdog_core::run_host::tool_pool::session_port::ThreadRequests::compact_after_turn(&*self.0.directory().expect("session directory bound (compose::verify_bound)"), thread)
    }

    async fn submit(&self, thread: &ThreadId, content: &Value, id: &str, hop: u32, bot_chain: &[String], from_agent: Option<&str>) -> Result<bool, mixdog_core_api::CoreError> {
        match self.0.directory() {
            Some(directory) => mixdog_core::run_host::tool_pool::session_port::ThreadRequests::submit(&*directory, thread, content, id, hop, bot_chain, from_agent).await,
            None => Err(mixdog_core_base::support::failed("session", "the session directory is not bound")),
        }
    }

    async fn start(&self, params: Value) -> Result<Value, mixdog_core_api::CoreError> {
        match self.0.directory() {
            Some(directory) => mixdog_core::run_host::tool_pool::session_port::ThreadRequests::start(&*directory, params).await,
            None => Err(mixdog_core_base::support::failed("session", "the session directory is not bound")),
        }
    }

    fn turn_state(&self, thread: &ThreadId) -> (u32, Vec<String>) {
        mixdog_core::run_host::tool_pool::session_port::ThreadRequests::turn_state(&*self.0.directory().expect("session directory bound (compose::verify_bound)"), thread)
    }
}
/// `context.cwd` of a recorded tool change: the live header's folder (`ThreadCwd`); a thread that is not loaded has none, and the review keeps the path as given.
pub struct LiveThreadCwd(pub Arc<LateDirectory>);

impl mixdog_core_review::turn_review::seams::ThreadCwd for LiveThreadCwd {
    fn cwd(&self, thread: &ThreadId) -> String {
        use mixdog_core::run_host::session_catalog::RunningHeaders;
        let directory = self.0.directory().expect("session directory bound (compose::verify_bound)");
        RunningHeaders::header(&*directory, thread).and_then(|header| header.get("cwd").and_then(Value::as_str).map(str::to_owned)).unwrap_or_default()
    }
}
/// The `Skill` tool's port, bound once the surface host exists. TRUE CYCLE: `HeaderSkillArm` judges a skill's tools through the surface host, which holds the pool the `Skill` tool sits in.
/// The async reads answer a typed `Unavailable` before the bind; `verify_bound` makes that unreachable.
#[derive(Default)]
pub struct LateSkills(OnceLock<Arc<dyn mixdog_tools::orch::skill::SkillPort>>);

impl LateSkills {
    pub fn bind(&self, port: Arc<dyn mixdog_tools::orch::skill::SkillPort>) -> Result<(), &'static str> {
        self.0.set(port).map_err(|_| "skill port")
    }

    fn port(&self) -> Result<&Arc<dyn mixdog_tools::orch::skill::SkillPort>, mixdog_tools::orch::util::PortError> {
        self.0.get().ok_or_else(|| mixdog_tools::orch::util::PortError::Unavailable { capability: "skills".to_owned(), message: "the skill port is not bound".to_owned() })
    }
}

#[async_trait]
impl mixdog_tools::orch::skill::SkillPort for LateSkills {
    async fn load(&self, thread: &ThreadId, name: &str, cwd: &mixdog_core_api::domain::common::AbsPath) -> Result<mixdog_tools::orch::skill::SkillLookup, mixdog_tools::orch::util::PortError> {
        self.port()?.load(thread, name, cwd).await
    }

    async fn body_present(&self, thread: &ThreadId, body: &str) -> Result<bool, mixdog_tools::orch::util::PortError> {
        match self.port() {
            Ok(port) => port.body_present(thread, body).await,
            Err(_) => Ok(false),
        }
    }
}

impl Bound for LateSkills {
    fn cell(&self) -> &'static str {
        "skill port"
    }

    fn is_bound(&self) -> bool {
        self.0.get().is_some()
    }
}
/// The cache-invalidation hook of `ProviderReadiness` (the cached provider setup and the usage
/// dashboard are dropped with the catalog), bound once at compose; startup verifies it is bound.
pub struct LateReadinessHook(pub Arc<mixdog_ai::catalog::ProviderReadiness>);

impl Bound for LateReadinessHook {
    fn cell(&self) -> &'static str {
        "provider cache invalidation"
    }

    fn is_bound(&self) -> bool {
        self.0.invalidation_bound()
    }
}

/// The media account probe of `mixdog_services::media::ProviderLayer`, bound once the probe that holds
/// the layer is built. A Codex image session reads it at `auth()`; startup verifies it is bound.
pub struct LateMediaProbe(pub Arc<mixdog_services::media::provider_layer::ProviderLayer>);

impl Bound for LateMediaProbe {
    fn cell(&self) -> &'static str {
        mixdog_services::media::provider_layer::PROBE_CELL
    }

    fn is_bound(&self) -> bool {
        self.0.probe_attached()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    /// Counts notices and settles.
    struct Counting(AtomicUsize, AtomicUsize);

    #[async_trait]
    impl SetupUiSurface for Counting {
        async fn notify(&self, _: &ThreadId, _: &str, _: Duration) -> bool {
            self.0.fetch_add(1, Ordering::SeqCst);
            true
        }

        async fn settled(&self, _: &ThreadId, _: &str) {
            self.1.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn the_setup_surface_answers_no_surface_until_bound_then_delegates() {
        let late = LateSetupUi::default();
        let thread = ThreadId::from("t");
        let window = Duration::from_secs(15);
        assert!(!late.notify(&thread, "r1", window).await);
        late.settled(&thread, "r1").await;
        let counting = Arc::new(Counting(AtomicUsize::new(0), AtomicUsize::new(0)));
        assert!(late.bind(counting.clone()).is_ok());
        assert!(late.notify(&thread, "r1", window).await);
        late.settled(&thread, "r1").await;
        assert_eq!(counting.0.load(Ordering::SeqCst), 1);
        assert_eq!(counting.1.load(Ordering::SeqCst), 1, "only the settle after the bind reaches the surface");
        assert!(late.bind(counting).is_err(), "a second bind is refused");
    }

    #[tokio::test]
    async fn the_callers_see_an_unknown_thread_until_the_directory_is_bound() {
        let callers = LateCallerSessions(Arc::new(LateDirectory::default()));
        let thread = ThreadId::from("t");
        assert!(callers.header(&thread).await.is_none());
        assert!(matches!(callers.acting_agent(&thread).await, Err(CoreError::ThreadNotFound { .. })));
    }
}

/// The `git` tool's `SessionWorktrees`, bound once the session workspaces exist. The tool pool is built before the directory and `SessionWorkspaces`
/// needs the directory (its `SessionWorkspaceHost`), a true cycle; this cell is bound right after the workspaces are built and listed in
/// `verify_bound`, so an unbound call is unreachable once the server accepts. If it ever happened, the tool answers a typed failure.
#[derive(Default)]
pub struct LateWorkspaces(OnceLock<Arc<dyn mixdog_tools::git::SessionWorktrees>>);

impl LateWorkspaces {
    pub fn bind(&self, workspaces: Arc<dyn mixdog_tools::git::SessionWorktrees>) -> Result<(), &'static str> {
        self.0.set(workspaces).map_err(|_| "session workspaces")
    }
}

#[async_trait]
impl mixdog_tools::git::SessionWorktrees for LateWorkspaces {
    async fn is_lead(&self, session_id: &str) -> bool {
        match self.0.get() {
            Some(workspaces) => workspaces.is_lead(session_id).await,
            None => false,
        }
    }

    async fn run(
        &self,
        op: mixdog_tools::git::SessionOp,
        caller_session_id: &str,
        cancel: &mixdog_rt::CancellationToken,
    ) -> Result<Value, mixdog_scm::error::ScmFailure> {
        match self.0.get() {
            Some(workspaces) => workspaces.run(op, caller_session_id, cancel).await,
            None => Err(mixdog_scm::error::ScmFailure::git("the session workspaces were not bound before the server accepted connections")),
        }
    }
}

impl Bound for LateWorkspaces {
    fn cell(&self) -> &'static str {
        "session workspaces"
    }

    fn is_bound(&self) -> bool {
        self.0.get().is_some()
    }
}

/// `SessionDeps.new_place`: the registered Projects and the draft's worktree step, which need the workspace service built after the
/// directory. Bound with it; `verify_bound` makes an unbound start unreachable.
#[derive(Default)]
pub struct LateNewPlace(OnceLock<Arc<dyn mixdog_core_session::session::NewThreadPlace>>);

impl LateNewPlace {
    pub fn bind(&self, place: Arc<dyn mixdog_core_session::session::NewThreadPlace>) -> Result<(), &'static str> {
        self.0.set(place).map_err(|_| "new thread place")
    }
}

#[async_trait]
impl mixdog_core_session::session::NewThreadPlace for LateNewPlace {
    async fn projects(&self) -> Result<Vec<String>, String> {
        self.0.get().expect("new thread place bound (compose::verify_bound)").projects().await
    }

    async fn enter_worktree(
        &self,
        thread: &ThreadId,
        worktree: &Value,
        input: Option<&Value>,
        cancel: &mixdog_rt::CancellationToken,
    ) -> Result<(), mixdog_core_api::CoreError> {
        self.0.get().expect("new thread place bound (compose::verify_bound)").enter_worktree(thread, worktree, input, cancel).await
    }
}

impl Bound for LateNewPlace {
    fn cell(&self) -> &'static str {
        "new thread place"
    }

    fn is_bound(&self) -> bool {
        self.0.get().is_some()
    }
}

/// `SessionDeps.draft_settings`: the new task's draft workflow and orchestration mode, applied through the `thread/setWorkflow` and
/// `thread/setOrchestrationMode` service registered after the directory. Bound with it; `verify_bound` makes an unbound start unreachable.
#[derive(Default)]
pub struct LateDraftSettings(OnceLock<Arc<dyn mixdog_core_api::DomainService>>);

impl LateDraftSettings {
    pub fn bind(&self, service: Arc<dyn mixdog_core_api::DomainService>) -> Result<(), &'static str> {
        self.0.set(service).map_err(|_| "draft settings")
    }

    /// The method as the host's `invokeSession` calls it: the one argument, no options. Without the `session` scope Node's runtime
    /// writes the configured value, which the empty session takes at its first turn (workflow-packs.mjs:53-71, style-and-mode.mjs:40-61),
    /// and its answer is not read (session-host-lifecycle.ts:766-776): the call names no thread, whose record the core writes only
    /// after the route (`begin_thread`), so the op is the domain's. Both are mutations, which the service refuses without an op
    /// id: each call is its own operation.
    async fn call(&self, method: &'static str, mut params: Value) -> Result<(), mixdog_core_api::CoreError> {
        let service = self.0.get().expect("draft settings bound (compose::verify_bound)");
        let op = uuid::Uuid::now_v7().to_string();
        params["opId"] = Value::String(op.clone());
        service
            .call(mixdog_core_api::call::CoreRequest {
                method: mixdog_core_api::ids::Method(method),
                params,
                op: Some(mixdog_core_api::ids::OpId::from(op)),
                ctx: mixdog_core_api::call::CallContext::internal("draft"),
            })
            .await
            .map(|_| ())
    }
}

#[async_trait]
impl mixdog_core_session::session::DraftSettings for LateDraftSettings {
    async fn set_workflow(&self, _thread: &ThreadId, workflow_id: &str) -> Result<(), mixdog_core_api::CoreError> {
        self.call("thread/setWorkflow", serde_json::json!({ "workflowId": workflow_id })).await
    }

    async fn set_orchestration_mode(&self, _thread: &ThreadId, mode: &str) -> Result<(), mixdog_core_api::CoreError> {
        self.call("thread/setOrchestrationMode", serde_json::json!({ "mode": mode })).await
    }
}

impl Bound for LateDraftSettings {
    fn cell(&self) -> &'static str {
        "draft settings"
    }

    fn is_bound(&self) -> bool {
        self.0.get().is_some()
    }
}

/// `SessionDeps.agent_status`: the agent tool's status rows (`AgentToolStatus`), which need the session directory the deps build. Bound once the directory, the agent registry and the
/// shell jobs exist; `verify_bound` makes an unbound read unreachable.
#[derive(Default)]
pub struct LateAgentStatus(OnceLock<Arc<dyn mixdog_core_session::session::agent_activity::AgentStatus>>);

impl LateAgentStatus {
    pub fn bind(&self, status: Arc<dyn mixdog_core_session::session::agent_activity::AgentStatus>) -> Result<(), &'static str> {
        self.0.set(status).map_err(|_| "agent status")
    }
}

#[async_trait]
impl mixdog_core_session::session::agent_activity::AgentStatus for LateAgentStatus {
    async fn status(&self, thread: &ThreadId) -> mixdog_app_protocol::v2::thread::ThreadAgents {
        self.0.get().expect("agent status bound (compose::verify_bound)").status(thread).await
    }
}

impl Bound for LateAgentStatus {
    fn cell(&self) -> &'static str {
        "agent status"
    }

    fn is_bound(&self) -> bool {
        self.0.get().is_some()
    }
}

/// `SessionDeps.live_workspace`: the session workspaces' live workspace, built after the directory the deps build. Bound with the workspaces.
#[derive(Default)]
pub struct LateLiveWorkspace(OnceLock<Arc<dyn mixdog_core_session::session::worktree::LiveWorkspace>>);

impl LateLiveWorkspace {
    pub fn bind(&self, live: Arc<dyn mixdog_core_session::session::worktree::LiveWorkspace>) -> Result<(), &'static str> {
        self.0.set(live).map_err(|_| "live workspace")
    }
}

#[async_trait]
impl mixdog_core_session::session::worktree::LiveWorkspace for LateLiveWorkspace {
    async fn live(&self, session: &str) -> Option<serde_json::Value> {
        self.0.get().expect("live workspace bound (compose::verify_bound)").live(session).await
    }
}

impl Bound for LateLiveWorkspace {
    fn cell(&self) -> &'static str {
        "live workspace"
    }

    fn is_bound(&self) -> bool {
        self.0.get().is_some()
    }
}

/// `SessionDeps.turn_admission`: the session workspaces' admission gate (`SessionWorkspaces`), built after the directory the deps build. Bound with the workspaces.
#[derive(Default)]
pub struct LateTurnAdmission(OnceLock<Arc<dyn mixdog_core_session::session::worktree::TurnAdmission>>);

impl LateTurnAdmission {
    pub fn bind(&self, admission: Arc<dyn mixdog_core_session::session::worktree::TurnAdmission>) -> Result<(), &'static str> {
        self.0.set(admission).map_err(|_| "turn admission")
    }
}

#[async_trait]
impl mixdog_core_session::session::worktree::TurnAdmission for LateTurnAdmission {
    async fn admit(&self, thread: &str, cwd: mixdog_core_session::session::worktree::Cwd, cancel: &mixdog_rt::CancellationToken) -> Result<Box<dyn Send>, mixdog_scm::error::ScmFailure> {
        self.0.get().expect("turn admission bound (compose::verify_bound)").admit(thread, cwd, cancel).await
    }
}

impl Bound for LateTurnAdmission {
    fn cell(&self) -> &'static str {
        "turn admission"
    }

    fn is_bound(&self) -> bool {
        self.0.get().is_some()
    }
}