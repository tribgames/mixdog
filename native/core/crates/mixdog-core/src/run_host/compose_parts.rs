//! The composition of the turn path as plain functions of their inputs, so the daemon's
//! `compose.rs` only supplies the parts it builds (`compose-seams.md`, "TurnPath inputs").
//!
//! - [`early_rows`]: what the tool pool is built from (todos, running work, goals, cycles).
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
use mixdog_agent::env::Clock;
use mixdog_ai::registry::providers::ProviderRegistry;
use mixdog_core_api::domain::ext::ExtPool;
use mixdog_core_api::domain::fs::FileService;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_goal::goal::GoalConfig;
use mixdog_core_goal::goal::GoalEnv;
use mixdog_core_goal::goal::GoalRuntime;
use mixdog_core_ports::ports::run_stamps::RunStamps;
use mixdog_core_ports::ports::threads::HeaderUpdate;
use mixdog_core_ports::ports::threads::HeaderUpdates;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_core_run::ports::running_work::ProcessWork;
use mixdog_core_run::run_host::guards::UserCycles;
use mixdog_core_run::run_host::hop_host::HopFactory;
use mixdog_core_run::run_host::hop_host::HopDeps;
use mixdog_core_run::run_host::hop_host::HopSessions;
use mixdog_core_config::config::Config;
use mixdog_core_domains::domains::ai_account::collaborators::AuthRefresh;
use mixdog_core_domains::domains::ai_admin::chain::CatalogFacts;
use mixdog_core_ports::ports::memory_source::ThreadMessages;
use mixdog_core_ports::ports::route::LiveRoute;
use mixdog_core_ports::ports::threads::Section;
use mixdog_ai::service::admin_route::resolve_route;
use mixdog_core_domains::domains::ai_admin::chain::RouteFacts;
use mixdog_core_ports::ports::route::Route;
use mixdog_core_session::session::route_cell::SessionRoutes;
use mixdog_core_session::session::delivered::DeliveredCompletions;
use mixdog_core_session::session::pending_read::PendingQueue;
use mixdog_core_session::session::route_session::ContextStatusCache;
use mixdog_core_session::session::secret_input::SecretInputService;
use mixdog_core_session::session::secret_input::SecretSlots;
use mixdog_core_session::session::secret_input::SECRET_INPUT_TIMEOUT;
use mixdog_core_session::session::thread_state::SessionThreads;
use mixdog_tools::orch::util::PortError;
use serde_json::Map;
use mixdog_core_session::session::run_stamps::run_stamp_of;
use mixdog_core_session::session::run_stamps::Records;
use mixdog_core_session::session::RunFactory;
use mixdog_core_session::session::SessionDeps;
use mixdog_core_session::session::SessionDirectory;
use mixdog_core_agents::agents::AgentDefinitions;
use mixdog_mcp::hook_bus::session::CommonOf;
use mixdog_mcp::hook_bus::HookBus;
use mixdog_mcp::hook_bus::HookCommon;
use mixdog_mcp::McpHub;
use mixdog_agent::compact::blob_reads::BlobReads;
use mixdog_rt::DurabilityIo;
use mixdog_rt::LaneTokens;
use mixdog_services::effort_judge::judge::EffortJudgeModel;
use mixdog_store::paths::Paths;
use mixdog_store::schema::record::Header;
use mixdog_tools::exec::ExecRuntime;
use mixdog_tools::policy::ConnectorPermissions;
use mixdog_tools::policy::ToolPolicy;
use serde_json::json;
use serde_json::Value;

use super::config_hosts::ConfigHosts;
use super::config_hosts::Env;
use super::config_hosts::ThreadHeaders;
use super::hop_bindings::HopBindings;
use super::late::Bound;
use super::host_seams::ConfigSeams;
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
use super::turn_path::TurnPathParts;

/// TurnPathParts.hops: built once the directory and the registry exist.
pub type HopsBuilder = Box<dyn FnOnce(&Arc<SessionDirectory>, &Arc<ProviderRegistry>) -> HopFactory>;

/// HopSessions of a directory.
pub type HopSessionsBuilder = Box<dyn FnOnce(&Arc<SessionDirectory>) -> Arc<dyn HopSessions>>;

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
    pub cycles: Arc<UserCycles>,
}

/// `ProcessWork::new` points the exec runtime at `cycles`, so build the rows once per process.
pub fn early_rows(input: EarlyIn) -> EarlyRows {
    let cycles = Arc::<UserCycles>::default();
    EarlyRows {
        todos: Arc::new(ThreadTodos::new(input.threads, input.clock)),
        work: Arc::new(ProcessWork::new(input.board, input.exec, cycles.clone())),
        goals: Arc::new(GoalRuntime::new(GoalConfig::new(input.data_dir.to_string_lossy().into_owned()), GoalEnv::system(input.durability))),
        cycles,
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
    /// `wiring` and `errors` of the route hop's `HopDeps`; `settings.wiring` is the same `wiring`.
    pub hop: HopBindings,
    pub settings: SettingsSources,
    pub bots: Arc<BotRouteStore>,
    pub resolver: Arc<McpAwareResolver>,
    pub skills_listed: Arc<CatalogSkillsListed>,
    pub allow_all: Arc<ConfigAllowAll>,
}

/// The process's one provider registry: `DefaultProviderBuilder` over the builder inputs of `process`, accounted
/// by pricing, the ledger, the send scope and the account lookup. Built right after `ProcessServices`, so
/// `ProviderReadiness::new(registry, catalog)` and the settings and feature effects share it with the turn path.
pub fn provider_registry(
    process: &ProcessServices,
    env: mixdog_ai::registry::builder::BuilderEnv,
    images: Arc<dyn mixdog_core_api::domain::ext::ProfiledImageResizer>,
) -> (Arc<ProviderRegistry>, Arc<mixdog_ai::registry::builder::DefaultProviderBuilder>) {
    // `images`: the extension host's `sharp`, which every Messages engine fits its images with.
    let builder = Arc::new(mixdog_ai::registry::builder::DefaultProviderBuilder::new(env).with_images(images));
    // The concrete builder is handed back with the registry: `ProviderAdmin::production` takes the same `Arc` (wp-ai-svc-21).
    let registry = Arc::new(ProviderRegistry::new(builder.clone()).with_accounting(super::accounting_scope::accounting_deps(process)));
    (registry, builder)
}

/// Builds every row whose inputs exist. `process` is the one `ProcessServices` of the daemon.
pub fn ready_rows(process: &ProcessServices, input: ReadyIn) -> ReadyRows {
    let hop = HopBindings::new(process);
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
        auto_effort: Arc::new(super::auto_effort::ConfigAutoEffort::new(process.config.clone(), input.env)),
    };
    ReadyRows {
        ladder: Arc::new(super::ladder_sources::ProcessLadder::new(process)),
        hop,
        settings,
        bots: Arc::new(BotRouteStore::new(input.data_dir, process.lanes.interactive_io)),
        resolver: Arc::new(McpAwareResolver::new(input.tool_pool, input.hub)),
        skills_listed: Arc::new(CatalogSkillsListed(input.skills)),
        allow_all: Arc::new(ConfigAllowAll(process.config.clone())),
    }
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
        HopFactory::new(deps, sessions(directory))
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
    pub deps: Box<dyn FnOnce(Arc<dyn RunFactory>) -> SessionDeps>,
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
pub fn turn_path_parts(process: &ProcessServices, registry: Arc<ProviderRegistry>, early: EarlyRows, ready: ReadyRows, owed: Owed) -> TurnPathParts {
    let hops = hops(process, &ready.hop, ready.bots.clone(), owed.hop_sessions);
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
        skill_names: owed.skills,
        ext_pool: owed.ext_pool,
        hook_bus: owed.hook_bus,
        hook_common: hook_common(owed.directory),
        goals: early.goals,
        todos: early.todos,
        work: early.work,
        cycles: early.cycles,
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

    async fn publish(&self, thread: &ThreadId, section: Section) -> Result<(), PortError> {
        self.threads()?.publish(thread, section).await
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
        self.directory
            .directory()
            .is_some_and(|directory| mixdog_core_session::session::approval_surfaces::attached_in(&directory, &*self.presence, thread))
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
    Arc::new(SessionRoutes::new(move |request: &Route| {
        resolve_route(&config.agent(), request, &|provider, full| facts.is_known(provider, full))
    }))
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
        let skills = mixdog_mcp::skill_catalog::SkillCatalog::new(
            dir.path().to_path_buf(),
            tokens.maintenance_io,
            roots,
            Arc::new(NoSettings),
            &SkillsWatch::new(),
        );
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

    /// Registry, readiness and the effects are built from the process services before the turn path,
    /// and all of them hold the one registry the turn path takes.
    #[tokio::test]
    async fn the_registry_is_built_once_and_shared_with_readiness() {
        let world = world(&[], json!({}), Vec::new()).await;
        let images = Arc::new(mixdog_exthost::ExtImageCodec::new(Arc::new(mixdog_core_api::domain::mock::MockExtPool::new(1))));
        let (registry, builder) = provider_registry(&world.services, crate::run_host::builder_env::builder_env(&world.services), images);
        assert!(Arc::strong_count(&builder) >= 2, "the registry holds the builder it hands back");
        let readiness = mixdog_ai::catalog::ProviderReadiness::new(registry.clone(), world.services.catalog.clone());
        assert!(Arc::strong_count(&registry) >= 2, "readiness holds the registry the turn path is given");
        drop(readiness);
    }

    /// Every view of the late directory reports itself unbound until the directory is, and the
    /// composition's check names the first one left over.
    #[test]
    fn every_view_of_the_late_directory_is_unbound_until_the_directory_is_bound() {
        use super::super::late::{Unbound, require};
        let late = Arc::new(LateDirectory::default());
        let cells: [&dyn Bound; 6] =
            [&*late, &DirectoryHeaders(late.clone()), &LateRunStamps(late.clone()), &LateThreads(late.clone()), &LateHeaders(late.clone()), &HookCommonCell(late.clone())];
        for cell in cells {
            assert!(!cell.is_bound(), "{}", cell.cell());
        }
        assert_eq!(require(&cells), Err(Unbound { cell: "session directory" }));
        assert_eq!(require(&cells[1..]), Err(Unbound { cell: "directory headers" }));
    }}
