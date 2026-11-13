//! [`SessionSeams`] over the parts the composition root builds: each method delegates to the owner's
//! built part, and what no crate implements yet is one owner trait, [`ConfigSeams`], taken as a
//! parameter, so the root cannot be built without its real provider and nothing here stubs it.

use std::path::PathBuf;
use std::sync::Arc;

use mixdog_agent::env::Compactor;
use mixdog_agent::offload::ImageCompactor;
use mixdog_agent::step_effort::StepAutoEffort;
use mixdog_agent::tail_rules::TailContext;
use mixdog_agent::todo::TodoView;
use mixdog_core_api::ids::ThreadId;
use mixdog_store::paths::Paths;
use mixdog_store::schema::record::Header;
use mixdog_tools::policy::SessionSurface;
use serde_json::Value;

use super::assemble::{CompactorInput, RunSettings, SessionSeams, SessionTools, SkillParts};
use super::hooks::PostToolDispatch;
use mixdog_core_run::run_host::hop_host::HopFactory;
use mixdog_core_run::run_host::route_fallback::HopHost;
use super::session_tools::SessionToolBuilder;
use super::step_judge::{ladder_facts, LadderSources, StepLadderFacts};
use mixdog_core_run::ports::todo_view::TodoViews;

/// What the turn reads of the configuration and the agent store. Owner: WP-CONFIG; nothing in the
/// tree implements it yet.
#[async_trait::async_trait]
pub trait ConfigSeams: Send + Sync + 'static {
    /// `getHiddenAgent(agent)`: `agent` is a row of `src/defaults/agents.json`.
    fn hidden_agent(&self, agent: Option<&str>) -> bool;
    /// `getHiddenAgent(agent).stallCap.idleSeconds`.
    fn stall_cap_idle_seconds(&self, _agent: Option<&str>) -> Option<i64> {
        None
    }
    /// `readAgentFirstResponseTimeoutMs(agent)`.
    async fn first_response_timeout_ms(&self, _agent: &str) -> Option<i64> {
        None
    }
    /// The route's, settings' and agent's `RunConfig` fields; every field's Node origin is in
    /// `compose-seams.md` "RunSettings: origins".
    fn run_settings(&self, thread: &ThreadId, header: &Header) -> RunSettings;
    /// `syncSessionCompaction(session, config)` (`session-compaction-sync.mjs`): the thread's `compaction`
    /// record once it follows the saved configuration, when that differs from the header's; `None` for a
    /// configuration without the section or a record that already follows it. `install`: the session is being
    /// installed (created or resumed), the one point that leaves a headless caller's injected configuration
    /// alone (`usesInjectedConfig`); a configuration reload or settings save syncs regardless.
    fn synced_compaction(&self, header: &Header, install: bool) -> Option<Value>;
    /// The configured values the route section carries besides the session's own: `autoClear` (`getAutoClear`), `systemShell`
    /// (`normalizeSystemShellConfig(config.shell)`) and `webSearchRoute` (`webSearchRouteOrDefault(config.webSearchRoute)`), for
    /// the thread whose header is `header`.
    fn route_config(&self, header: &Header) -> mixdog_app_protocol::v2::thread::ThreadRoute;
    /// The saved configuration's change counter: it moves when a settings change is applied (`announceSettingsChange`).
    fn settings_changes(&self, thread: &ThreadId) -> Option<mixdog_core_session::session::turn_ops::SettingsFeed>;
    /// `readSection('agent').instructionFiles`, the stored setting.
    fn stored_instruction_files(&self) -> Option<Value>;
    /// The install's reply language `(code, name)` (`build_lead_language`), asked only for a header that
    /// recorded none. Runs in a lane job.
    fn response_language(&self) -> Option<(String, String)>;
}

/// The compaction pipeline of a session's route: [`super::compactors::SessionCompactors`] is the
/// implementation (`FreshCompactor::for_session` over the session's `FreshParts`, `TriggerSeams`,
/// fork source and `summary_routes`).
#[async_trait::async_trait]
pub trait CompactorSource: Send + Sync + 'static {
    async fn compactor(&self, thread: &ThreadId, header: &Header, prior: &[Value], input: CompactorInput) -> Option<Arc<dyn Compactor>>;
}

/// The parts that need the session directory, so they are built after it (the hop writes the session's
/// header; the compactor reads its rows).
pub struct DirectoryParts {
    pub hops: Arc<HopFactory>,
    pub compactors: Arc<dyn CompactorSource>,
}

/// The built parts the seams delegate to.
pub struct SeamParts {
    pub tools: SessionToolBuilder,
    pub todos: TodoViews,
    pub post_tool: Arc<dyn PostToolDispatch>,
    /// `None`: no `Skill` tool is registered.
    pub skills: Option<SkillParts>,
    pub config: Arc<dyn ConfigSeams>,
    pub ladder: Arc<dyn LadderSources>,
    pub images: Option<Arc<dyn ImageCompactor>>,
    pub paths: Paths,
}

pub struct HostSeams {
    parts: SeamParts,
    late: std::sync::OnceLock<DirectoryParts>,
}

impl HostSeams {
    pub fn new(parts: SeamParts) -> Self {
        Self { parts, late: std::sync::OnceLock::new() }
    }

    /// Binds the parts built over the directory; a second bind is refused.
    pub fn bind(&self, late: DirectoryParts) -> Result<(), DirectoryParts> {
        self.late.set(late)
    }
}

fn text<'a>(header: &'a Header, key: &str) -> &'a str {
    header.get(key).and_then(Value::as_str).map_or("", mixdog_js::js_trim)
}

#[async_trait::async_trait]
impl SessionSeams for HostSeams {
    async fn tools(&self, _thread: &ThreadId, header: &Header, surface: &SessionSurface) -> Result<SessionTools, String> {
        self.parts.tools.tools(header, surface).await
    }

    fn hidden_agent(&self, agent: Option<&str>) -> bool {
        self.parts.config.hidden_agent(agent)
    }

    fn stall_cap_idle_seconds(&self, agent: Option<&str>) -> Option<i64> {
        self.parts.config.stall_cap_idle_seconds(agent)
    }

    async fn first_response_timeout_ms(&self, agent: &str) -> Option<i64> {
        self.parts.config.first_response_timeout_ms(agent).await
    }

    fn todo_view(&self, thread: &ThreadId, header: &Header) -> Arc<dyn TodoView> {
        self.parts.todos.todo_view(thread, header)
    }

    fn post_tool_dispatch(&self) -> Arc<dyn PostToolDispatch> {
        self.parts.post_tool.clone()
    }

    async fn compactor(&self, thread: &ThreadId, header: &Header, prior: &[Value], input: CompactorInput) -> Option<Arc<dyn Compactor>> {
        self.late.get()?.compactors.compactor(thread, header, prior, input).await
    }

    fn hop_host(&self, thread: &ThreadId, header: &Header) -> Option<Arc<dyn HopHost>> {
        self.late.get()?.hops.hop_host(thread, header)
    }

    fn skill_parts(&self) -> Option<SkillParts> {
        self.parts.skills.as_ref().map(|s| SkillParts { names: s.names.clone(), tool: s.tool.clone(), deliveries: s.deliveries.clone() })
    }

    fn run_settings(&self, thread: &ThreadId, header: &Header) -> RunSettings {
        self.parts.config.run_settings(thread, header)
    }

    fn tail_context(&self, header: &Header) -> TailContext {
        super::tail::tail_context(header, || self.parts.config.response_language())
    }

    async fn step_ladder_facts(&self, _thread: &ThreadId, header: &Header, _auto: &StepAutoEffort) -> Option<StepLadderFacts> {
        Some(ladder_facts(&*self.parts.ladder, text(header, "provider"), text(header, "model")).await)
    }

    fn image_compactor(&self) -> Option<Arc<dyn ImageCompactor>> {
        self.parts.images.clone()
    }

    fn plugin_root(&self) -> PathBuf {
        self.parts.paths.plugin_root.clone()
    }

    fn stored_instruction_files(&self) -> Option<Value> {
        self.parts.config.stored_instruction_files()
    }

    fn data_dir(&self) -> PathBuf {
        self.parts.paths.data_dir.clone()
    }
}
