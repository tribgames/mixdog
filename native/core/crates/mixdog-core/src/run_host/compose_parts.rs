//! The composition of the turn path as plain functions of their inputs, so the daemon's
//! `compose.rs` only supplies the parts it builds (`compose-seams.md`, "TurnPath inputs").
//!
//! - [`early_rows`]: what the tool pool is built from (todos, running work, goals).
//! - [`ready_rows`]: every other row that needs nothing the tree lacks once a `ProcessServices`
//!   and the tool pool exist.
//! - [`turn_path_parts`]: the whole `TurnPathParts`, every owner part a parameter of [`Owed`].
//!
//! The directory comes after the path's registry, so `run_stamps`, `SessionHeaders` and
//! `hook_common` read a [`LateDirectory`] the daemon binds once `TurnPath::new` returns.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::OnceLock;
use std::sync::Weak;

use async_trait::async_trait;
use mixdog_agent::agent_tool::board::JobBoard;
use mixdog_agent::compact::blob_reads::BlobReads;
use mixdog_agent::env::Clock;
use mixdog_ai::registry::providers::ProviderRegistry;
use mixdog_ai::service::admin_route::resolve_route;
use mixdog_core_agents::agents::AgentDefinitions;
use mixdog_core_api::domain::ext::ExtPool;
use mixdog_core_api::domain::fs::FileService;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_config::config::Config;
use mixdog_core_domains::domains::ai_account::collaborators::AuthRefresh;
use mixdog_core_domains::domains::ai_admin::chain::CatalogFacts;
use mixdog_core_domains::domains::ai_admin::chain::RouteFacts;
use mixdog_core_goal::goal::GoalConfig;
use mixdog_core_goal::goal::GoalEnv;
use mixdog_core_goal::goal::GoalError;
use mixdog_core_goal::goal::GoalResult;
use mixdog_core_goal::goal::GoalRuntime;
use mixdog_core_goal::goal::GoalTitles;
use mixdog_core_ports::ports::memory_source::ThreadMessages;
use mixdog_core_ports::ports::route::LiveRoute;
use mixdog_core_ports::ports::route::Route;
use mixdog_core_ports::ports::run_stamps::RunStamps;
use mixdog_core_ports::ports::threads::HeaderUpdate;
use mixdog_core_ports::ports::threads::HeaderUpdates;
use mixdog_core_ports::ports::threads::Section;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_core_run::ports::running_work::ProcessWork;
use mixdog_core_run::run_host::hop_host::HopDeps;
use mixdog_core_run::run_host::hop_host::HopFactory;
use mixdog_core_run::run_host::hop_host::HopSessions;
use mixdog_core_session::session::RunFactory;
use mixdog_core_session::session::SessionDeps;
use mixdog_core_session::session::SessionDirectory;
use mixdog_core_session::session::delivered::DeliveredCompletions;
use mixdog_core_session::session::pending_read::PendingQueue;
use mixdog_core_session::session::route_cell::SessionRoutes;
use mixdog_core_session::session::route_session::ContextStatusCache;
use mixdog_core_session::session::run_stamps::Records;
use mixdog_core_session::session::run_stamps::run_stamp_of;
use mixdog_core_session::session::secret_input::SECRET_INPUT_TIMEOUT;
use mixdog_core_session::session::secret_input::SecretInputService;
use mixdog_core_session::session::secret_input::SecretSlots;
use mixdog_core_session::session::session_title::{TitleError, TitleModel};
use mixdog_core_session::session::thread_state::SessionThreads;
use mixdog_mcp::McpHub;
use mixdog_mcp::hook_bus::HookBus;
use mixdog_mcp::hook_bus::HookCommon;
use mixdog_mcp::hook_bus::session::CommonOf;
use mixdog_rt::DurabilityIo;
use mixdog_rt::LaneTokens;
use mixdog_services::effort_judge::judge::EffortJudgeModel;
use mixdog_store::paths::Paths;
use mixdog_store::schema::record::Header;
use mixdog_tools::exec::ExecRuntime;
use mixdog_tools::orch::util::PortError;
use mixdog_tools::policy::ConnectorPermissions;
use mixdog_tools::policy::ToolPolicy;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::config_hosts::ConfigHosts;
use super::config_hosts::Env;
use super::config_hosts::ThreadHeaders;
use super::hop_bindings::HopBindings;
use super::host_seams::ConfigSeams;
use super::late::Bound;
use super::mcp_seams::CatalogSkillsListed;
use super::mcp_seams::ConfigAllowAll;
use super::mcp_seams::McpAwareResolver;
use super::next_request_source::NextRequestSource;
use super::process::ProcessServices;
use super::process::SessionHeaders;
use super::run_seams::EnvReader;
use super::session_tools::SessionMcp;
use super::settings::SettingsSources;
use super::side_requests::SideRequests;
use super::thread_todos::ThreadTodos;
use super::turn_inputs::BotRouteStore;
use super::turn_inputs::CatalogCeilings;
use super::turn_inputs::CatalogVision;
use super::turn_path::TurnPathParts;

/// TurnPathParts.hops: built once the directory and the registry exist.
pub type HopsBuilder = Box<dyn FnOnce(&Arc<SessionDirectory>, &Arc<ProviderRegistry>) -> HopFactory>;

/// HopSessions of a directory.
pub type HopSessionsBuilder = Box<dyn FnOnce(&Arc<SessionDirectory>) -> Arc<dyn HopSessions> + Send>;

// ---- the late directory ----------------------------------------------------------------------

/// The session directory, bound once after the turn path builds it.
#[derive(Default)]
pub struct LateDirectory(OnceLock<Weak<SessionDirectory>>);

impl LateDirectory {
    pub fn bind(&self, directory: &Arc<SessionDirectory>) {
        let _ = self.0.set(Arc::downgrade(directory));
    }

    /// The directory once bound; `None` before the bind or after it is dropped.
    pub fn directory(&self) -> Option<Arc<SessionDirectory>> {
        self.0.get()?.upgrade()
    }

    /// The latest acked header of a loaded session.
    pub fn live_header(&self, session_id: &str) -> Option<Arc<Header>> {
        Some(self.directory()?.handle(&ThreadId::from(session_id))?.live_header().header())
    }
}

/// `SessionHeaders` (the codex `User-Agent` and the effort lookups) over the late directory.
pub struct DirectoryHeaders(pub Arc<LateDirectory>);

impl SessionHeaders for DirectoryHeaders {
    fn header(&self, session_id: &str) -> Option<Arc<Header>> {
        self.0.live_header(session_id)
    }
}

#[async_trait]
impl Records for LateDirectory {
    async fn record(&self, session: &str) -> Option<Header> {
        self.directory()?.stored_header(&ThreadId::from(session)).await
    }

    async fn record_fields(&self, session: &str, fields: &'static [&'static str]) -> Option<Header> {
        self.directory()?.stored_fields(&ThreadId::from(session), fields).await
    }
}

/// `RunStamps` over the late directory: `DirectoryRunStamps`' backfill (`run_stamp_of`), reading a
/// record where `DirectoryRunStamps` does (a loaded thread's header, else the stored record).
pub struct LateRunStamps(pub Arc<LateDirectory>);

#[async_trait]
impl RunStamps for LateRunStamps {
    async fn stamp_of(&self, thread: &ThreadId) -> Option<Value> {
        run_stamp_of(thread.as_str(), self.0.as_ref()).await
    }
}

/// `hookCommonPayload`'s permission mode and effort for a session header: the mode is
/// `session.permissionMode || 'default'`, the effort `{ level }` of the trimmed, lower-cased
/// `effort`, left out when empty.
pub fn common_of_header(header: &Header) -> HookCommon {
    let text = |key: &str| header.get(key).and_then(|v| v.as_str()).map(mixdog_js::js_trim).unwrap_or_default();
    let mode = text("permissionMode");
    let effort = text("effort").to_lowercase();
    HookCommon {
        transcript_path: None,
        permission_mode: Some(if mode.is_empty() { "default".to_owned() } else { mode.to_owned() }),
        effort: (!effort.is_empty()).then(|| json!({ "level": effort })),
    }
}

/// `TurnPathParts.hook_common`: the session's common fields from its live header. A session that
/// is not loaded has none, so it answers Node's defaults.
///
/// `transcript_path` is not read here: the bus asks the session service for it just before a handler
/// runs (`HookBus::bind_transcripts` over the session's `TranscriptFiles` export, Node's
/// `hookTranscriptPath`), so every payload that names a session carries it.
pub fn hook_common(directory: Arc<LateDirectory>) -> CommonOf {
    Arc::new(move |session_id: &str| match directory.live_header(session_id) {
        Some(header) => common_of_header(&header),
        None => HookCommon { permission_mode: Some("default".to_owned()), ..HookCommon::default() },
    })
}

/// The MCP scope of a hook's session (`rt.mcpScopeId`): the `mcpScopeId` of its live header.
pub fn hook_scope(directory: Arc<LateDirectory>) -> mixdog_mcp::hook_bus::ScopeOf {
    Arc::new(move |session_id: &str| directory.live_header(session_id).and_then(|header| super::session_tools::header_scope(&header).map(str::to_owned)))
}

// ---- the rows the tool pool is built from ----------------------------------------------------

pub struct EarlyIn {
    pub data_dir: PathBuf,
    pub durability: DurabilityIo,
    /// The session directory's `ThreadState`.
    pub threads: Arc<dyn ThreadState>,
    pub clock: Arc<dyn mixdog_core_session::session::Clock>,
    pub board: JobBoard,
    pub exec: Arc<ExecRuntime>,
}

pub struct EarlyRows {
    pub todos: Arc<ThreadTodos>,
    pub work: Arc<ProcessWork>,
    pub goals: Arc<GoalRuntime>,
    /// The Goal runtime's title model; the composition binds it once the summary services exist.
    pub goal_titles: Arc<LateGoalTitles>,
}

/// The Goal title model (`generateTitle` of `wireGoalRuntime`, `boot/tools.mjs`): the goals are built before the
/// summary services that hold the providers, so the model is bound afterwards. Until then no title is drawn.
#[derive(Default)]
pub struct LateGoalTitles(OnceLock<Arc<dyn TitleModel>>);

impl LateGoalTitles {
    pub fn bind(&self, model: Arc<dyn TitleModel>) {
        let _ = self.0.set(model);
    }
}

#[async_trait]
impl GoalTitles for LateGoalTitles {
    async fn generate(&self, objective: &str, cancel: &mixdog_rt::CancellationToken) -> GoalResult<String> {
        let Some(model) = self.0.get() else { return Err(GoalError::new("the Goal title model is not bound yet")) };
        model.generate(objective, "", "", cancel).await.map_err(|error| match error {
            TitleError::RouteUnresolved => GoalError::new("MAINTENANCE_ROUTE_UNRESOLVED"),
            TitleError::Failed(message) => GoalError::new(message),
        })
    }
}

fn goal_runtime(data_dir: &std::path::Path, durability: DurabilityIo, titles: Arc<LateGoalTitles>) -> GoalRuntime {
    let env = GoalEnv { titles: Some(titles), ..GoalEnv::system(durability) };
    GoalRuntime::new(GoalConfig::new(data_dir.to_string_lossy().into_owned()), env)
}

pub fn early_rows(input: EarlyIn) -> EarlyRows {
    let goal_titles = Arc::new(LateGoalTitles::default());
    EarlyRows {
        todos: Arc::new(ThreadTodos::new(input.threads, input.clock)),
        work: Arc::new(ProcessWork::new(input.board, input.exec)),
        goals: Arc::new(goal_runtime(&input.data_dir, input.durability, goal_titles.clone())),
        goal_titles,
    }
}

// ---- the rows that need the tool pool --------------------------------------------------------

/// What the READY rows of `TurnPathParts` are built from, besides the process services.
pub struct ReadyIn {
    pub data_dir: PathBuf,
    /// `process.env[name]`, the reader the config seams use.
    pub env: EnvReader,
    /// The tool pool the session tool set and the policy's resolver both read.
    pub tool_pool: Vec<Arc<dyn Tool>>,
    pub hub: Arc<McpHub>,
    pub skills: Arc<mixdog_mcp::skill_catalog::SkillCatalog>,
    /// The heartbeat marks the routine host also writes (`RoutineHost::new`'s `marks`).
    pub heartbeats: Arc<mixdog_services::bots::HeartbeatSessions>,
    /// The server's stored attachments.
    pub blobs: mixdog_store::blobs::BlobStore,
}

pub struct ReadyRows {
    pub ladder: Arc<super::ladder_sources::ProcessLadder>,
    auto_effort: Arc<super::auto_effort::ConfigAutoEffort>,
    auto_effort_env: EnvReader,
    /// `wiring` and `errors` of the route hop's `HopDeps`; `settings.wiring` is the same `wiring`.
    pub hop: HopBindings,
    pub settings: SettingsSources,
    pub bots: Arc<BotRouteStore>,
    pub resolver: Arc<McpAwareResolver>,
    pub skills_listed: Arc<CatalogSkillsListed>,
    pub allow_all: Arc<ConfigAllowAll>,
}

/// `TurnPathParts.hops`: the route hop over the directory and the path's registry. `sessions` builds
/// the `HopSessions` of the directory (`SessionHops` over a `SessionRouteAdapter`).
pub fn hops(
    process: &ProcessServices,
    hop: &HopBindings,
    bots: Arc<BotRouteStore>,
    sessions: impl FnOnce(&Arc<SessionDirectory>) -> Arc<dyn HopSessions> + 'static,
) -> HopsBuilder {
    let (config, catalog) = (process.config.clone(), process.catalog.clone());
    let (errors, wiring) = (hop.errors.clone(), hop.wiring.clone());
    Box::new(move |directory, registry| {
        let deps = HopDeps {
            registry: registry.clone(),
            catalog,
            // `getConfigSnapshot()` is the agent config (`providers`, `default`, presets), the file's `agent` section.
            config: Arc::new(move || config.agent()),
            bots,
            errors,
            wiring,
        };
        HopFactory::new(deps, sessions(directory)).with_eligibility(Arc::new(mixdog_core_run::run_host::hop_host::RegistryEligibility(registry.clone())))
    })
}

// ---- views over the late directory ------------------------------------------------------------

fn unbound() -> PortError {
    PortError::Unavailable { capability: "session".into(), message: "the session directory is not up".into() }
}

/// `ThreadState` and `ThreadMessages` over the late directory (`SessionThreads` once it is bound).
/// What is built before the directory (the tool pool's callers, the todos and the running work)
/// reads threads through this; a read before the bind is `Unavailable`.
pub struct LateThreads(pub Arc<LateDirectory>);

impl LateThreads {
    fn threads(&self) -> Result<SessionThreads, PortError> {
        self.0.directory().map(SessionThreads::new).ok_or_else(unbound)
    }
}

#[async_trait]
impl ThreadState for LateThreads {
    async fn header(&self, thread: &ThreadId) -> Result<Header, PortError> {
        self.threads()?.header(thread).await
    }

    async fn header_fields(&self, thread: &ThreadId, fields: &'static [&'static str]) -> Result<Header, PortError> {
        self.threads()?.header_fields(thread, fields).await
    }

    async fn patch_header(&self, thread: &ThreadId, set: Map<String, Value>, unset: Vec<String>) -> Result<(), PortError> {
        self.threads()?.patch_header(thread, set, unset).await
    }

    async fn patch_header_if(
        &self,
        thread: &ThreadId,
        expect: Map<String, Value>,
        set: Map<String, Value>,
        unset: Vec<String>,
    ) -> Result<Option<Map<String, Value>>, PortError> {
        self.threads()?.patch_header_if(thread, expect, set, unset).await
    }

    async fn patch_header_at(
        &self,
        thread: &ThreadId,
        at: &mixdog_core_ports::ports::threads::RunFence,
        expect: Map<String, Value>,
        set: Map<String, Value>,
        unset: Vec<String>,
    ) -> Result<mixdog_core_ports::ports::threads::FencedPatch, PortError> {
        self.threads()?.patch_header_at(thread, at, expect, set, unset).await
    }

    async fn publish(&self, thread: &ThreadId, section: Section) -> Result<(), PortError> {
        self.threads()?.publish(thread, section).await
    }

    /// The directory's own answer; before the bind nothing is stored.
    async fn store_header(&self, thread: &ThreadId, write: mixdog_core_ports::ports::threads::HeaderWrite) -> mixdog_core_ports::ports::threads::HeaderStored {
        match self.threads() {
            Ok(threads) => threads.store_header(thread, write).await,
            Err(error) => mixdog_core_ports::ports::threads::HeaderStored::Refused(format!("{error:?}")),
        }
    }

    fn log_identity(&self, thread: &ThreadId) -> Option<String> {
        self.threads().ok()?.log_identity(thread)
    }

    async fn held_fields(&self, thread: &ThreadId, keys: &'static [&'static str]) -> Result<Map<String, Value>, PortError> {
        self.threads()?.held_fields(thread, keys).await
    }
}

#[async_trait]
impl HeaderUpdates for LateThreads {
    async fn update_header(&self, thread: &ThreadId, update: HeaderUpdate) -> Result<(), PortError> {
        self.threads()?.update_header(thread, update).await
    }
}

#[async_trait]
impl ThreadMessages for LateThreads {
    async fn messages(&self, thread: &ThreadId) -> Result<Vec<Value>, PortError> {
        self.threads()?.messages(thread).await
    }
    async fn messages_until(&self, thread: &ThreadId, wanted: &(dyn for<'v> Fn(&'v Value) -> bool + Sync)) -> Result<Vec<Value>, PortError> {
        self.threads()?.messages_until(thread, wanted).await
    }
}

/// `ThreadHeaders` over the late directory: the stored header, `None` for an unknown thread or
/// before the directory is up. `HeaderCwds` (`DomainSeams.session_cwds`) is built on this view.
pub struct LateHeaders(pub Arc<LateDirectory>);

#[async_trait]
impl ThreadHeaders for LateHeaders {
    async fn header(&self, thread: &ThreadId) -> Result<Option<Header>, mixdog_core_api::CoreError> {
        let Some(directory) = self.0.directory() else { return Ok(None) };
        directory.try_stored_header(thread).await
    }
}

/// `ApprovalSurfaces` over the late directory, for the held-request home, which is built before the
/// directory (the setup tool reads it first). A thread the directory does not hold has no client
/// attached; before the bind it holds none, and `verify_bound` keeps the listener closed until it does.
pub struct LateApprovalSurfaces {
    pub directory: Arc<LateDirectory>,
    pub presence: Arc<dyn mixdog_core_api::ApprovalPresence>,
}

impl mixdog_core_api::ApprovalSurfaces for LateApprovalSurfaces {
    fn attached(&self, thread: &ThreadId) -> bool {
        self.directory.directory().is_some_and(|directory| mixdog_core_session::session::approval_surfaces::attached_in(&directory, &*self.presence, thread))
    }
}

// ---- rows with one owner each ------------------------------------------------------------------

/// The secret slots and the service that fills them from the desktop: ONE `SecretSlots`, held by
/// `SecretFill` (the handoff env) and by `approval/provideSecret`.
pub struct SecretInput {
    pub slots: Arc<SecretSlots>,
    pub service: Arc<SecretInputService>,
}

pub fn secret_input() -> SecretInput {
    let slots = Arc::new(SecretSlots::new(SECRET_INPUT_TIMEOUT));
    SecretInput { service: Arc::new(SecretInputService::new(slots.clone())), slots }
}

/// The delivered-completions registry and the pending queue the report host reads.
pub struct PendingRows {
    pub delivered: Arc<DeliveredCompletions>,
    pub queue: Arc<PendingQueue>,
}

/// Built once the directory exists (`PendingQueue` opens stored sessions through it).
pub fn pending_rows(directory: &Arc<SessionDirectory>, clock: Arc<dyn mixdog_core_session::session::Clock>) -> PendingRows {
    let delivered = Arc::new(DeliveredCompletions::new(clock));
    PendingRows { queue: Arc::new(PendingQueue::new(directory.clone(), delivered.clone())), delivered }
}

/// The live route cell of every thread: a thread's first read, and a held route being adopted, resolve
/// through the saved config (`resolveRoute(getConfig(), request)`, `boot/shared.mjs:19`). The same
/// `Arc` is the `LiveRoute` of `ConfigHosts` and the `RouteCell` of `LiveRouteWriter`.
pub fn live_routes(config: Config, facts: Arc<CatalogFacts>) -> Arc<SessionRoutes> {
    Arc::new(SessionRoutes::new(move |request: &Route| resolve_route(&config.agent(), request, &|provider, full| facts.is_known(provider, full))))
}

// ---- the late cells' bound() checks -------------------------------------------------------------

impl Bound for LateDirectory {
    fn cell(&self) -> &'static str {
        "session directory"
    }

    fn is_bound(&self) -> bool {
        self.directory().is_some()
    }
}

/// The cell `hook_common` reads the live header through (a closure has no handle of its own).
pub struct HookCommonCell(pub Arc<LateDirectory>);

macro_rules! view_bound {
    ($view:ty, $name:literal) => {
        impl Bound for $view {
            fn cell(&self) -> &'static str {
                $name
            }

            fn is_bound(&self) -> bool {
                self.0.is_bound()
            }
        }
    };
}

view_bound!(DirectoryHeaders, "directory headers");
view_bound!(LateRunStamps, "late run stamps");
view_bound!(LateThreads, "late threads");
view_bound!(LateHeaders, "late headers");
view_bound!(HookCommonCell, "hook common");
#[cfg(test)]
mod tests {
    use mixdog_mcp::skill_catalog::SkillRoots;
    use mixdog_mcp::skill_catalog::SkillSettings;
    use mixdog_mcp::skill_catalog::SkillSettingsSource;
    use mixdog_mcp::skills_watch::SkillsWatch;
    use serde_json::Map;

    use super::super::mcp_seams::AllowAllActions;
    use super::super::process_tests::world;
    use super::super::session_tools::SkillsListed;
    use super::*;

    struct NoSettings;
    impl SkillSettingsSource for NoSettings {
        fn current(&self) -> SkillSettings {
            SkillSettings::default()
        }
    }

    fn header(fields: &[(&str, Value)]) -> Header {
        let mut map = Map::new();
        for (key, value) in fields {
            map.insert((*key).to_owned(), value.clone());
        }
        map
    }

    struct FixedTitle;
    #[async_trait]
    impl TitleModel for FixedTitle {
        async fn generate(&self, _: &str, _: &str, _: &str, _: &mixdog_rt::CancellationToken) -> Result<String, TitleError> {
            Ok("Ship The Release".to_owned())
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_goal_gets_a_model_generated_title_once_the_model_is_bound() {
        let dir = tempfile::tempdir().unwrap();
        let titles = Arc::new(LateGoalTitles::default());
        let goals = goal_runtime(dir.path(), mixdog_rt::testing::tokens().durability_io, titles.clone());
        titles.bind(Arc::new(FixedTitle));
        goals.control("s1", json!("ship the release")).await.unwrap();
        goals.settled().await;
        assert_eq!(goals.snapshot("s1").await.unwrap().unwrap()["title"], json!("Ship The Release"));
        goals.close().await;
    }

    #[test]
    fn a_header_gives_the_hooks_its_permission_mode_and_effort() {
        let common = common_of_header(&header(&[("permissionMode", json!("strict")), ("effort", json!(" High "))]));
        assert_eq!(common.permission_mode.as_deref(), Some("strict"));
        assert_eq!(common.effort, Some(json!({ "level": "high" })));
    }

    struct Everyone;
    impl mixdog_core_api::ApprovalPresence for Everyone {
        fn answerable(&self, _thread: &ThreadId, _surface: &ThreadId) -> bool {
            true
        }
    }

    #[test]
    fn no_client_is_attached_to_a_thread_before_the_directory_exists() {
        use mixdog_core_api::ApprovalSurfaces;
        let surfaces = LateApprovalSurfaces { directory: Arc::default(), presence: Arc::new(Everyone) };
        assert!(!surfaces.attached(&ThreadId::from("sess_top")));
    }

    #[test]
    fn a_header_without_them_gives_node_defaults() {
        let common = common_of_header(&header(&[("permissionMode", Value::Null), ("effort", json!(""))]));
        assert_eq!(common.permission_mode.as_deref(), Some("default"));
        assert_eq!(common.effort, None);
    }

    #[tokio::test]
    async fn the_views_over_an_unbound_directory_say_so() {
        let late = Arc::new(LateDirectory::default());
        let thread = ThreadId::from("S1");
        let threads = LateThreads(late.clone());
        assert!(matches!(threads.header(&thread).await, Err(PortError::Unavailable { .. })));
        assert!(matches!(threads.messages(&thread).await, Err(PortError::Unavailable { .. })));
        assert!(matches!(LateHeaders(late).header(&thread).await, Ok(None)));
    }

    /// The daemon's agent sessions stamp an owner's close through this view: a patch for an idle thread reaches the
    /// thread's actor as one, so nothing is written while a turn runs, and it lands once the thread is idle.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_patch_for_an_idle_thread_is_decided_by_the_threads_actor_through_the_late_view() {
        use mixdog_core_api::CoreRequest;
        use mixdog_core_api::Reply;
        use mixdog_core_api::ThreadDirectory;
        use mixdog_core_api::ThreadHandle;
        use mixdog_core_api::call::CallContext;
        use mixdog_core_api::ids::ConnectionId;
        use mixdog_core_api::ids::Method;
        use mixdog_core_api::ids::OpId;
        use mixdog_core_ports::ports::threads::FencedPatch;
        use mixdog_core_ports::ports::threads::RunFence;

        let rig = mixdog_core_session::session::testing::Rig::new();
        let gate = Arc::new(tokio::sync::Notify::new());
        let open = gate.clone();
        rig.set_script(Arc::new(move |run| {
            let open = open.clone();
            Box::pin(async move {
                run.port.input_durable().await.expect("input durable");
                open.notified().await;
                mixdog_core_session::session::RunOutcome::Completed(Default::default())
            })
        }));
        let directory = Arc::new(SessionDirectory::new(rig.deps()));
        let late = Arc::new(LateDirectory::default());
        late.bind(&directory);
        let threads = LateThreads(late);
        let request = |method: &'static str, params: Value, op: &str| CoreRequest {
            method: Method(method),
            params,
            op: Some(OpId::from(op)),
            ctx: CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, mixdog_rt::CancellationToken::new()),
        };
        let reply =
            directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start")).await.expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        let handle = directory.handle(&id).expect("loaded");
        let turn = json!({ "threadId": id.as_str(), "opId": "op-1", "input": { "prompt": "work" } });
        let started = handle.request(request("turn/start", turn, "op-1")).await.expect("turn/start");
        let Reply::Value(started) = started else { panic!("turn/start answers a value") };
        let running = mixdog_core_api::ids::TurnId::from(started["turnId"].as_str().expect("the started turn").to_owned());
        let busy = |want: bool| {
            let handle = handle.clone();
            async move {
                tokio::time::timeout(std::time::Duration::from_secs(10), async {
                    while handle.turn_busy() != want {
                        handle.stepped().notified().await;
                    }
                })
                .await
                .expect("the turn's state")
            }
        };
        busy(true).await;
        let probe = |value: i64| Map::from_iter([("probe".to_owned(), json!(value))]);
        let patch = |at: RunFence, value: i64| {
            let (threads, id) = (&threads, &id);
            async move { threads.patch_header_at(id, &at, Map::new(), probe(value), Vec::new()).await.expect("answered") }
        };

        assert_eq!(patch(RunFence::Idle, 1).await, FencedPatch::Moved, "a turn runs: nothing is written for an idle thread");
        assert_eq!(patch(RunFence::Turn(mixdog_core_api::ids::TurnId::from("another".to_owned())), 2).await, FencedPatch::Moved);
        assert_eq!(threads.header(&id).await.expect("header").get("probe"), None);
        assert_eq!(patch(RunFence::Turn(running.clone()), 3).await, FencedPatch::Written, "the turn that runs");
        assert_eq!(threads.header(&id).await.expect("header").get("probe"), Some(&json!(3)));

        gate.notify_one();
        busy(false).await;
        assert_eq!(patch(RunFence::Turn(running), 4).await, FencedPatch::Moved, "that turn ended");
        assert_eq!(patch(RunFence::Idle, 5).await, FencedPatch::Written);
        assert_eq!(threads.header(&id).await.expect("header").get("probe"), Some(&json!(5)));
    }

    #[test]
    fn the_secret_service_and_the_slots_are_one_instance() {
        let input = secret_input();
        assert_eq!(Arc::strong_count(&input.slots), 2);
    }
    #[tokio::test]
    async fn a_session_that_is_not_loaded_answers_the_defaults() {
        let late = Arc::new(LateDirectory::default());
        let common = hook_common(late.clone())("nobody");
        assert_eq!(common.permission_mode.as_deref(), Some("default"));
        assert!(DirectoryHeaders(late.clone()).header("nobody").is_none());
        assert!(LateRunStamps(late).stamp_of(&ThreadId::from("nobody")).await.is_none());
    }

    /// Every view of the late directory reports itself unbound until the directory is, and the
    /// composition's check names the first one left over.
    #[test]
    fn every_view_of_the_late_directory_is_unbound_until_the_directory_is_bound() {
        use super::super::late::{Unbound, require};
        let late = Arc::new(LateDirectory::default());
        let cells: [&dyn Bound; 6] = [
            &*late,
            &DirectoryHeaders(late.clone()),
            &LateRunStamps(late.clone()),
            &LateThreads(late.clone()),
            &LateHeaders(late.clone()),
            &HookCommonCell(late.clone()),
        ];
        for cell in cells {
            assert!(!cell.is_bound(), "{}", cell.cell());
        }
        assert_eq!(require(&cells), Err(Unbound { cell: "session directory" }));
        assert_eq!(require(&cells[1..]), Err(Unbound { cell: "directory headers" }));
    }

    /// Registry, readiness and the effects are built from the process services before the turn path,
    /// and all of them hold the one registry the turn path takes.
    #[tokio::test]
    async fn the_registry_is_built_once_and_shared_with_readiness() {
        let world = world(&[], json!({}), Vec::new()).await;
        let images = Arc::new(mixdog_exthost::ExtImageCodec::new(Arc::new(mixdog_core_api::domain::mock::MockExtPool::new(1))));
        let (registry, builder) = provider_registry(&world.services, crate::run_host::builder_env::builder_env(&world.services), images, None);
        assert!(Arc::strong_count(&builder) >= 2, "the registry holds the builder it hands back");
        let readiness = mixdog_ai::catalog::ProviderReadiness::new(registry.clone(), world.services.catalog.clone());
        assert!(Arc::strong_count(&registry) >= 2, "readiness holds the registry the turn path is given");
        drop(readiness);
    }
    #[tokio::test]
    async fn the_ready_rows_share_the_instances_the_turn_reads() {
        let world = world(&[], json!({}), Vec::new()).await;
        let process = &world.services;
        let dir = tempfile::tempdir().unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let hub = McpHub::new(
            mixdog_mcp::server::McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io, cpu: tokens.cpu_bulk },
            dir.path().join("tool-results"),
            mixdog_mcp::result::OutputPolicy::default(),
        );
        let roots: SkillRoots = Arc::new(|_lane| Vec::new());
        let skills =
            mixdog_mcp::skill_catalog::SkillCatalog::new(dir.path().to_path_buf(), tokens.maintenance_io, roots, Arc::new(NoSettings), &SkillsWatch::new());
        let heartbeats = mixdog_services::bots::HeartbeatSessions::new();
        let rows = ready_rows(
            process,
            ReadyIn {
                data_dir: dir.path().to_path_buf(),
                env: Arc::new(|_| None),
                tool_pool: Vec::new(),
                hub,
                skills,
                heartbeats: heartbeats.clone(),
                blobs: mixdog_store::blobs::BlobStore::new(dir.path()),
            },
        );
        heartbeats.mark("beat");
        assert!(rows.settings.heartbeats.is_heartbeat("beat"), "settings read the marks the routine host writes");
        assert!(!rows.settings.heartbeats.is_heartbeat("other"));
        assert!(!rows.allow_all.allow_all_actions(), "an unset developer option is off");
        assert_eq!(rows.skills_listed.any_for(dir.path()).await, Ok(false), "no skill root, no skill");
    }
}

/// What the one `ConfigHosts` reads. `gauge` and `refresh` have no production type yet
/// (compose-seams.md, "Blocked rows"): the caller supplies them.
pub struct ConfigHostsIn {
    pub config: Config,
    pub routes: Arc<dyn LiveRoute>,
    pub gauge: Arc<dyn ContextStatusCache>,
    pub agents: Arc<AgentDefinitions>,
    /// The catalog and readiness; answers both `RouteFacts` and `ProvidersReady`.
    pub facts: Arc<CatalogFacts>,
    pub refresh: Arc<dyn AuthRefresh>,
    pub env: Env,
    pub surface: mixdog_core_base::surface::SurfaceGeneration,
}
/// The one `ConfigHosts`: assign it to `DomainSeams.compaction_host` and `.workflow_host`.
pub fn config_hosts(input: ConfigHostsIn) -> Arc<ConfigHosts> {
    Arc::new(ConfigHosts {
        config: input.config,
        routes: input.routes,
        gauge: input.gauge,
        agents: input.agents,
        facts: input.facts.clone(),
        ready: input.facts,
        refresh: input.refresh,
        env: input.env,
        surface: input.surface,
    })
}
// ---- the whole TurnPathParts -----------------------------------------------------------------

/// Every part another owner builds. The daemon fills it as each lands; nothing here has a default.
pub struct Owed {
    /// `markUnattendedRun`'s registry over the late run stamps (`UnattendedRunRegistry::new(Arc::new(LateRunStamps(directory)))`): the setup tool's held
    /// requests read it before the path exists, so the composition builds it and the path takes it.
    pub unattended: Arc<super::unattended::UnattendedRunRegistry>,
    /// Where a run's approval asks go (see `TurnPathParts::approvals`).
    pub approvals: Arc<dyn super::run_approvals::RunApprovals>,
    /// The one set of tool exclusions (see `TurnPathParts::exclusions`).
    pub exclusions: Arc<mixdog_core_session::session::SessionToolExclusions>,
    pub tokens: LaneTokens,
    pub clock: Arc<dyn Clock>,
    pub paths: Paths,
    pub effort_judge: Arc<EffortJudgeModel>,
    pub side: SideRequests,
    pub next: Arc<NextRequestSource>,
    pub files: Arc<dyn FileService>,
    pub processes: Arc<dyn ProcessManager>,
    pub policy: Arc<ToolPolicy>,
    pub connectors: Arc<dyn ConnectorPermissions>,
    pub agents: Arc<AgentDefinitions>,
    pub hub: Arc<McpHub>,
    pub blobs: Arc<dyn BlobReads>,
    pub mcp: Arc<dyn SessionMcp>,
    pub skills: Arc<mixdog_mcp::skill_catalog::SkillCatalog>,
    pub ext_pool: Arc<dyn ExtPool>,
    pub hook_bus: Arc<HookBus>,
    pub config: Arc<dyn ConfigSeams>,
    pub deps: Box<dyn FnOnce(Arc<dyn RunFactory>) -> SessionDeps + Send>,
    /// `SessionCompactors::new(Arc::new(ProcessCompactionWorld::new(services)), clock)`, built by the composition with the world it keeps.
    pub compactors: Arc<super::compactors::SessionCompactors>,
    /// `HopSessions` over the directory.
    pub hop_sessions: HopSessionsBuilder,
    pub directory: Arc<LateDirectory>,
    /// The pool the `early` rows were built into; `Skill`, `todo` and `load_tool` included.
    pub tool_pool: Vec<Arc<dyn Tool>>,
    /// The shell control over the runtime `early.work` runs in (`TurnPathParts.shells`).
    pub shells: Option<Arc<mixdog_tools::exec::ShellControl>>,
    /// The runtime liveness map (TurnPathParts.liveness), made before the path because the prewarm inside the session deps reads it.
    pub liveness: Arc<mixdog_services::task_reports::runtime_state::RuntimeLiveness>,
    /// The hosted web search's usage registry (`TurnPathParts.search_usage`), made before the web tools are built.
    pub search_usage: Arc<mixdog_tools::web::NativeSearchUsageSinks>,
    /// The sessions' result caches (`TurnPathParts.reuses`), made before the manual compaction that resets them.
    pub reuses: Arc<super::result_reuse::LiveReuses>,
}
/// The whole `TurnPathParts`: the flip only adds the calls that produce `process`, `early`,
/// `ready` and `owed`.
pub fn turn_path_parts(process: &ProcessServices, registry: Arc<ProviderRegistry>, early: EarlyRows, mut ready: ReadyRows, owed: Owed) -> TurnPathParts {
    let hops = hops(process, &ready.hop, ready.bots.clone(), owed.hop_sessions);
    let env = ready.auto_effort_env;
    let clock = owed.clock.clone();
    ready.settings.first_auto_effort = Some(Arc::new(super::auto_effort::TurnAutoEffort::new(
        ready.auto_effort,
        Arc::new(super::turn_judge::ModelTurnJudge::new(owed.effort_judge.clone(), &env)),
        ready.ladder.clone(),
        Arc::new(super::auto_effort::RegistryConfiguration::new(
            registry.clone(),
            ready.hop.source.clone(),
            process.unsupported.clone(),
            ready.hop.codex_declared.clone(),
        )),
        Arc::new(super::auto_effort::EffortDecisionLog::new(env, owed.paths.data_dir.clone(), owed.tokens.durability_io, owed.tokens.maintenance_io)),
        Arc::new(move || {
            chrono::DateTime::from_timestamp_millis(clock.now_ms()).map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)).unwrap_or_default()
        }),
    )));
    TurnPathParts {
        tokens: owed.tokens,
        clock: owed.clock,
        paths: owed.paths,
        registry,
        effort_judge: owed.effort_judge,
        side: owed.side,
        next: owed.next,
        files: owed.files,
        processes: owed.processes,
        policy: owed.policy,
        connectors: owed.connectors,
        resolver: ready.resolver,
        unattended: owed.unattended.clone(),
        approvals: owed.approvals,
        exclusions: owed.exclusions.clone(),
        agents: owed.agents,
        allow_all: ready.allow_all,
        hub: owed.hub,
        blobs: owed.blobs,
        tool_pool: owed.tool_pool,
        mcp: owed.mcp,
        skills_listed: ready.skills_listed,
        skill_deliveries: Some(owed.skills.clone()),
        skill_names: owed.skills,
        ext_pool: owed.ext_pool,
        hook_bus: owed.hook_bus,
        hook_common: hook_common(owed.directory),
        goals: early.goals,
        todos: early.todos,
        work: early.work,
        config: owed.config,
        settings: ready.settings,
        ladder: ready.ladder,
        deps: owed.deps,
        compactors: owed.compactors.clone(),
        hops,
        shells: owed.shells,
        liveness: owed.liveness,
        search_usage: owed.search_usage,
        reuses: owed.reuses,
    }
}

/// The process's one provider registry: `DefaultProviderBuilder` over the builder inputs of `process`, accounted
/// by pricing, the ledger, the send scope and the account lookup. Built right after `ProcessServices`, so
/// `ProviderReadiness::new(registry, catalog)` and the settings and feature effects share it with the turn path.
///
/// In the model-proxy client mode (`client`) the registry's providers are the PC's: each is the stand-in that sends over
/// `client.transport`, and the set is the one the PC reports. The concrete builder is still the local one, for the views
/// that read local settings.
pub fn provider_registry(
    process: &ProcessServices,
    env: mixdog_ai::registry::builder::BuilderEnv,
    images: Arc<dyn mixdog_core_api::domain::ext::ProfiledImageResizer>,
    client: Option<ModelProxyClient>,
) -> (Arc<ProviderRegistry>, Arc<mixdog_ai::registry::builder::DefaultProviderBuilder>) {
    // `images`: the extension host's `sharp`, which every Messages engine fits its images with.
    let builder = Arc::new(mixdog_ai::registry::builder::DefaultProviderBuilder::new(env).with_images(images));
    // The concrete builder is handed back with the registry: `ProviderAdmin::production` takes the same `Arc` (wp-ai-svc-21).
    let registry = match client {
        None => ProviderRegistry::new(builder.clone()),
        Some(client) => {
            let proxied = mixdog_core_domains::domains::ai_admin::model_proxy_adapter::ProxiedBuilder::new(client.transport, client.attachments);
            ProviderRegistry::new(Arc::new(proxied)).with_remote(client.providers)
        }
    };
    (Arc::new(registry.with_accounting(super::accounting_scope::accounting_deps(process))), builder)
}

/// What the registry of the model-proxy client mode sends through and learns its providers from.
pub struct ModelProxyClient {
    /// `model/proxy/execute` to the PC that declared `capabilities.modelProxy`.
    pub transport: Arc<dyn mixdog_ai::broker::ModelProxyTransport>,
    /// This server's stored attachments, inlined into each call (the PC cannot read them).
    pub attachments: Arc<dyn mixdog_ai::service::model_proxy_inline::AttachmentReader>,
    /// The PC's provider config (`loadModelProxyProviderConfig`).
    pub providers: Arc<dyn mixdog_ai::registry::providers::RemoteProviders>,
}
/// Builds every row whose inputs exist. `process` is the one `ProcessServices` of the daemon.
pub fn ready_rows(process: &ProcessServices, input: ReadyIn) -> ReadyRows {
    let hop = HopBindings::new(process);
    let auto_effort = Arc::new(super::auto_effort::ConfigAutoEffort::new(process.config.clone(), input.env.clone()));
    let settings = SettingsSources {
        wiring: hop.wiring.clone(),
        attachments: Arc::new(mixdog_core_domains::domains::ai_admin::model_proxy::StoreAttachments {
            store: input.blobs,
            interactive: process.lanes.interactive_io,
        }),
        media: Some(Arc::new({
            let source = hop.source.clone();
            move |session: &serde_json::Value| source.media(session)
        })),
        heartbeats: input.heartbeats,
        ceilings: Arc::new(CatalogCeilings::new(process.catalog.clone())),
        auto_effort: auto_effort.clone(),
        first_auto_effort: None,
        vision: Some(Arc::new(CatalogVision::new(process.catalog.clone(), process.config.clone()))),
    };
    ReadyRows {
        ladder: Arc::new(super::ladder_sources::ProcessLadder::new(process)),
        auto_effort,
        auto_effort_env: input.env,
        hop,
        settings,
        bots: Arc::new(BotRouteStore::new(input.data_dir, process.lanes.interactive_io)),
        resolver: Arc::new(McpAwareResolver::new(input.tool_pool, input.hub)),
        skills_listed: Arc::new(CatalogSkillsListed(input.skills)),
        allow_all: Arc::new(ConfigAllowAll(process.config.clone())),
    }
}
