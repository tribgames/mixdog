//! The host assembly of a turn ([`RunParts`] over what exists today): the provider from the
//! registry, the tool environment from the file and process services, the policy gate, the
//! per-session tool-result reuse, artifacts, hooks, reactions and tail reminder, the retry decider,
//! and the turn's request options from the session header.
//!
//! What has no provider in the tree yet is a method of [`SessionSeams`], each naming its owner and
//! the exact signature the owner has to supply; nothing is stubbed. `compose-seams.md` carries one
//! row per method.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::env::{Clock, Compactor, RouteFallback, SkillSelector, TurnGuards};
use mixdog_agent::todo::{TodoGuards, TodoView};
use mixdog_agent::tools::{ToolEnv, ToolSet};
use mixdog_agent::{RunCarry, RunConfig};
use mixdog_ai::registry::providers::ProviderRegistry;
use mixdog_ai::retry::StandardRetryDecider;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::fs::FileService;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::provider::RequestThread;
use mixdog_core_api::domain::tool::{SurfaceKind, Tool, ToolIo};
use mixdog_core_api::ids::ThreadId;
use mixdog_protocol::TurnError;
use mixdog_agent::compact::blob_reads::BlobReads;
use mixdog_services::effort_judge::judge::{EffortJudge, EffortJudgeModel};
use mixdog_agent::step_effort::StepEffortJudge;
use mixdog_store::schema::record::Header;
use mixdog_tools::policy::{ConnectorPermissions, ToolPolicy, ToolResolver};
use serde_json::{json, Value};

use mixdog_core_run::run_host::artifact::ToolResultArtifacts;
use mixdog_core_run::run_host::failure_log::FailureWriter;
use mixdog_core_run::run_host::failure_log::RunFailureLog;
use super::factory::{Assembled, AssembleInput, GateBuilder, GateContext, RunParts, SkillContext, SkillsBuilder};
use super::hooks::{PostToolDispatch, SessionToolHooks};
use super::reactions::{LoopReactions, ReactionScope, ReactionTargets};
use super::result_reuse::ToolResultReuse;
use mixdog_core_run::run_host::route_fallback::HopHost;
use mixdog_core_run::run_host::route_fallback::RouteHop;
use mixdog_core_ports::ports::gate::GateEnv;
use mixdog_core_ports::ports::gate::SessionGate;

/// The tools of a session's surface.
pub struct SessionTools {
    pub tools: Vec<Arc<dyn Tool>>,
    /// The builtin names typo aliases and suggestions draw from (`ToolSet::with_builtins`).
    pub builtins: Vec<String>,
    /// The session is a delegated agent's: it is sent the agent text of `git` and `task`.
    pub agent: bool,
}

/// `RunConfig` fields that come from the route, the settings and the agent definition.
pub struct RunSettings {
    pub hidden_agent: bool,
    pub agent_mode: bool,
    pub limits: Option<mixdog_agent::limits::TurnLimits>,
    pub compact: Option<mixdog_agent::boundary::CompactSettings>,
    pub escalated_max_output_tokens: Option<u32>,
    pub read_body_required: bool,
    pub effort: Option<mixdog_agent::effort::EffortWiring>,
    pub step_auto_effort: Option<mixdog_agent::step_effort::StepAutoEffort>,
    pub text_only: Option<mixdog_agent::text_only::TextOnlyInput>,
    pub attachments: Option<Arc<dyn mixdog_agent::attachments::AttachmentText>>,
    pub model_max_output_tokens: Option<u32>,
}

/// What the explicit skill selector is made of, besides the run's own gate, environment and token.
#[derive(Clone)]
pub struct SkillParts {
    /// The skill names available for a cwd (`SkillCatalog`).
    pub names: Arc<dyn mixdog_mcp::skill_select::SkillNames>,
    /// The session's `Skill` tool.
    pub tool: Arc<dyn Tool>,
}

/// The run's own parts a compactor reads its transcript through: the same values the run commits
/// and archives with, so a pass sees exactly the rows the session stored.
pub struct CompactorInput {
    /// `RunSettings.compact` (`auto` is not read; see `FreshCompactor::for_session`).
    pub settings: mixdog_agent::boundary::CompactSettings,
    /// The run's stored bodies (`FreshParts.rows`).
    pub rows: Arc<mixdog_core_session::session::StoredRows>,
    /// Where a dropped execution is archived (`FreshParts.archive`).
    pub archive: Arc<dyn mixdog_agent::offload::ArtifactStore>,
    pub blobs: Arc<dyn BlobReads>,
}

/// What a turn needs and no crate supplies yet. Every method is a seam with its owner.
#[async_trait]
pub trait SessionSeams: Send + Sync + 'static {
    /// The surface's tools: the built-ins its tool spec names and the connected MCP servers' tools
    /// (`McpHub::tools`), filtered by the surface. Owner: WP-TOOLS-ORCH (built-in registry),
    /// WP-MCP (merge).
    /// Async: whether skills are listed comes from a current collection; its failure is the error.
    async fn tools(&self, thread: &ThreadId, header: &Header, surface: &mixdog_tools::policy::SessionSurface) -> Result<SessionTools, String>;
    /// `getHiddenAgent(agent)`. Owner: WP-CONFIG (agent store).
    fn hidden_agent(&self, agent: Option<&str>) -> bool;
    /// `getHiddenAgent(agent).stallCap.idleSeconds`: an internal agent's own idle budget.
    fn stall_cap_idle_seconds(&self, _agent: Option<&str>) -> Option<i64> {
        None
    }
    /// `readAgentFirstResponseTimeoutMs(agent)`: the agent definition's own first-response
    /// deadline (0 turns it off); `None` when it sets none.
    async fn first_response_timeout_ms(&self, _agent: &str) -> Option<i64> {
        None
    }
    /// The todo list, goal and background work as the turn guards read them. Owner:
    /// WP-SESSION-PORTS (`TodoStore`, `GoalPort`) over `run_host::guards::HostTodoView`.
    fn todo_view(&self, thread: &ThreadId, header: &Header) -> Arc<dyn TodoView>;
    /// PostToolUse / PostToolUseFailure / PostToolBatch dispatch. Owner: WP-MCP (hook bus).
    fn post_tool_dispatch(&self) -> Arc<dyn PostToolDispatch>;
    /// The compaction pipeline for this session's route (`run_host::compactors::SessionCompactors`
    /// over `FreshCompactor::for_session`). `input` is the run's: the settings it compacts by and
    /// the stored rows, archive and blobs its transcript is read through.
    async fn compactor(&self, thread: &ThreadId, header: &Header, prior: &[Value], input: CompactorInput) -> Option<Arc<dyn Compactor>>;
    /// What the route hop reads and writes (`HopHost`). Owner: WP-AI-SVC (registry, wires) with
    /// WP-SESSION (the header write).
    fn hop_host(&self, thread: &ThreadId, header: &Header) -> Option<Arc<dyn HopHost>>;
    /// Explicit skill selection for typed steering, over the turn's trusted selection text (`AgentTurn.skill_selection`,
    /// `prepareExplicitSkills` `selection`). Owner: WP-MCP (skills domain).
    fn skill_parts(&self) -> Option<SkillParts>;
    /// The route's, settings' and agent's `RunConfig` fields. Owner: WP-AGENT (limits, compaction
    /// settings, effort wiring, text-only), WP-CONFIG (settings).
    fn run_settings(&self, thread: &ThreadId, header: &Header) -> RunSettings;
    /// The tail reminder's language and role. Owner: WP-RUN-HOST (`rules_lead::build_lead_language`
    /// over the system locale) with WP-CONFIG for the role.
    fn tail_context(&self, header: &Header) -> mixdog_agent::tail_rules::TailContext;
    /// What the turn's route says about its efforts, for the step judge's ladder
    /// (`effortOptionsFor(provider, autoEffortModel(..))`, and a custom route's row, protocol and
    /// base URL). The host picks the ladder and builds the judge over its `EffortJudgeModel`.
    /// Owner: WP-AI-SVC (catalog rows, registry, custom config). `None`: the route has no facts.
    async fn step_ladder_facts(&self, thread: &ThreadId, header: &Header, auto: &mixdog_agent::step_effort::StepAutoEffort) -> Option<super::step_judge::StepLadderFacts>;
    /// Tool-result image compaction. Owner: WP-AGENT (ImageCompactor has no implementation).
    fn image_compactor(&self) -> Option<Arc<dyn mixdog_agent::offload::ImageCompactor>>;
    /// The install's plugin root (`rules/`, `output-styles/`): `mixdog_store::paths::Paths::plugin_root`.
    fn plugin_root(&self) -> PathBuf;
    /// `readSection('agent').instructionFiles`, the stored setting. Owner: WP-CONFIG.
    fn stored_instruction_files(&self) -> Option<Value>;
    /// The data directory of the install (artifacts and attachments live under it):
    /// `mixdog_store::paths::Paths::data_dir`.
    fn data_dir(&self) -> PathBuf;
}

/// The services the assembly composes.
pub struct HostServices {
    pub registry: Arc<ProviderRegistry>,
    pub clock: Arc<dyn Clock>,
    pub files: Arc<dyn FileService>,
    pub processes: Arc<dyn ProcessManager>,
    pub io: ToolIo,
    pub policy: Arc<ToolPolicy>,
    pub connectors: Arc<dyn ConnectorPermissions>,
    pub resolver: Arc<dyn ToolResolver>,
    pub gate_env: Arc<dyn GateEnv>,
    /// Where a run's approval asks go (held for its owner, or the session's own card).
    pub approvals: Arc<dyn super::run_approvals::RunApprovals>,
    pub blobs: Arc<dyn BlobReads>,
    /// The process-wide react targets: the same value the react tool (`ports::reactions::SessionReactions`)
    /// records into.
    pub reaction_targets: Arc<ReactionTargets>,
    /// The live runs' result caches, so a workspace change can clear a session's (`clearReadDedupSession`).
    pub reuses: Arc<super::result_reuse::LiveReuses>,
    /// The session directory: each session's live header, grants and thread window. Boot builds it with
    /// `Arc::new_cyclic` since the directory owns the run factory that owns these services.
    pub directory: std::sync::Weak<mixdog_core_session::session::SessionDirectory>,
    /// The shared effort-judge model, present when the install has the ONNX Runtime library; each run's judge is
    /// built over it with the run's ladder.
    pub effort_judge: Option<Arc<EffortJudgeModel>>,
    /// The side-question store the loop's sends record into (the one compaction.requests reads).
    pub side: super::side_requests::SideRequests,
    pub seams: Arc<dyn SessionSeams>,
    /// The sources of the settings the config does not hold.
    pub settings: super::settings::SettingsSources,
    /// Runs the git and shell-tools probes of a composition (one per daemon process).
    pub probes: Arc<super::prewarm::StartupProbes>,
    /// The process-wide probe cache (`prompt::probes`).
    pub observed: Arc<mixdog_core_prompt::prompt::probes::StartupObservations>,
    /// The runtime's shell control, which the progress watchdog's stop reaps a turn's shells
    /// through; `None` reaps nothing.
    pub shells: Option<Arc<mixdog_tools::exec::ShellControl>>,
    /// The tools the provider left out of a session's requests (`recordProviderToolExclusion`).
    pub exclusions: Arc<mixdog_core_session::session::SessionToolExclusions>,
    /// The settings reconcile every turn starts with; bound once the surface host exists.
    pub turn_settings: Arc<super::turn_settings::LateTurnSettings>,
}

mod session_view;

pub struct HostRunParts {
    services: HostServices,
}

/// The thread a Codex request names. Node's `codexWireSendOpts` fixes the wire window at `<wire id>:0` whatever the
/// compaction count, and `buildRequestSendOptions` sends the turn's start as the stamp its id was minted from.
pub(crate) fn wire_thread(id: ThreadId, turn: Option<mixdog_core_api::ids::TurnId>) -> RequestThread {
    let turn_started_at_ms = turn.as_ref().and_then(|t| mixdog_ai::providers::openai::client_meta::v7_stamp(t.as_str()));
    RequestThread { id, window: 0, turn, turn_started_at_ms }
}

/// `isUuidV7`: the canonical 8-4-4-4-12 form of a version 7, variant `[89ab]` id.
fn is_uuid_v7(value: &str) -> bool {
    let parts: Vec<&str> = value.split('-').collect();
    parts.len() == 5
        && parts.iter().zip([8, 4, 4, 4, 12]).all(|(part, len)| part.len() == len && part.bytes().all(|b| b.is_ascii_hexdigit()))
        && parts[2].starts_with(['7'])
        && parts[3].starts_with(['8', '9', 'a', 'b', 'A', 'B'])
}

/// The thread a request of the stored session `header` names: a Codex session sends its stored wire identity
/// (`codexWireSessionId`, `ensureCodexWireSessionId`), which is not the thread's id, as the id of every request of the
/// session, compaction summaries included; any other route names the thread itself. A Codex header with no valid stored
/// identity falls back to the thread id only for requests built outside a turn; `assemble` mints and stores one first.
pub(crate) fn request_identity(thread: &ThreadId, header: &Header, turn: Option<mixdog_core_api::ids::TurnId>) -> RequestThread {
    let stored = text(header, "codexWireSessionId").to_lowercase();
    let wire = (text(header, "provider") == "openai-oauth" && is_uuid_v7(&stored)).then(|| ThreadId::from(stored.as_str()));
    wire_thread(wire.unwrap_or_else(|| thread.clone()), turn)
}

/// The identity fields of a request's options, shared by the turn's assembly and the parity test: Node's
/// `codexSessionId`, thread and cache key are all the stored wire identity (`cache-strategy.mjs:312`).
pub(crate) fn apply_identity(options: &mut mixdog_core_api::domain::provider::RequestOptions, thread: &ThreadId, header: &Header, turn: Option<mixdog_core_api::ids::TurnId>) {
    let identity = request_identity(thread, header, turn);
    options.session_id = Some(identity.id.to_string());
    options.thread = Some(identity);
}

impl HostRunParts {
    pub fn new(services: HostServices) -> Self {
        Self { services }
    }
}

impl HostRunParts {
    /// Composes a session's prompt: the probes it asks for are settled first, then job runs in an
    /// io-interactive lane job over RealSources (see [super::prewarm::compose]).
    pub async fn compose_prompt<R: Send + 'static>(&self, job: super::prewarm::ComposeJob<R>) -> Result<R, TurnError> {
        let seams = &self.services.seams;
        let facts = Arc::new(super::prewarm::PromptFacts::from_process(seams.plugin_root(), seams.data_dir(), seams.stored_instruction_files()));
        super::prewarm::compose(&self.services.io, &self.services.probes, &self.services.observed, facts, job).await.map_err(refuse)
    }
}

fn text<'a>(header: &'a Header, key: &str) -> &'a str {
    header.get(key).and_then(Value::as_str).map_or("", mixdog_js::js_trim)
}

/// `snapshotProviderRequestTools` at a request boundary: `tools` as the provider is sent them, with the catalog tools the
/// transcript's native tool searches (`native`, [`super::factory::native_searches`]) reference. The turn's boundary and
/// the snapshot both take the request's tools here.
fn boundary_tools(header: &Header, tools: Vec<mixdog_core_api::domain::provider::ToolDefinition>, native: &[Value]) -> Vec<mixdog_core_api::domain::provider::ToolDefinition> {
    let provider = text(header, "provider").to_lowercase();
    let referenced = native.iter().flat_map(|record| super::context_world::native_references(Some(record), &provider)).collect();
    super::context_world::snapshot_tools(header, tools, referenced, &provider)
}

/// The session's `wireRoute` as the pin a gateway's send reads; `None` without one.
fn wire_pin_of(route: Option<&Value>) -> Option<mixdog_core_api::domain::provider::WirePin> {
    mixdog_core_api::domain::provider::WirePin::from_route(route?)
}

fn refuse(message: impl Into<String>) -> TurnError {
    TurnError { message: message.into(), data: json!({}), provider_error: None }
}

/// The turn's working directory: the header's `cwd`.
fn cwd_of(header: &Header) -> Result<PathBuf, TurnError> {
    let cwd = text(header, "cwd");
    if cwd.is_empty() {
        return Err(refuse("the session has no working directory"));
    }
    Ok(Path::new(cwd).to_path_buf())
}

/// The registry's connected-server tools (`isMcpTool`, `mcp__…`), which a non-bridge session's call reaches
/// by name though its request did not carry them; a built-in it did not offer stays unknown.
struct McpOnly(Arc<dyn ToolResolver>);

impl ToolResolver for McpOnly {
    fn resolve(&self, scope: Option<&str>, name: &str) -> Option<Arc<dyn Tool>> {
        if name.starts_with("mcp__") { self.0.resolve(scope, name) } else { None }
    }
}

/// What a request of a thread is made of, the same for the turn that sends it and for the rebuild a
/// side question forks: the route's provider, the surface's tools, the merged settings and the request
/// options the header gives.
struct RequestParts {
    provider: Arc<dyn mixdog_core_api::domain::provider::ProviderAdapter>,
    cwd: PathBuf,
    tool_set: ToolSet,
    settings: RunSettings,
    options: mixdog_core_api::domain::provider::RequestOptions,
}

/// The facts of the thread a request is built from.
struct RequestSource<'a> {
    thread: &'a ThreadId,
    header: &'a Header,
    surface: &'a mixdog_tools::policy::SessionSurface,
    prior: &'a [Value],
    request: &'a str,
    injected: bool,
    provider_state: Option<mixdog_core_api::domain::provider::ProviderState>,
    /// The turn the request is for, when there is one. (The thread's compaction count is not a request fact: the wire
    /// window is fixed at `<wire id>:0`, [`wire_thread`].)
    turn: Option<mixdog_core_api::ids::TurnId>,
}

impl HostRunParts {
    /// The tools a run calls: the surface's own and the registry behind them, the whole registry on a bridge
    /// session and its connected servers' tools on any other. A deferred tool is not in the request, but a call
    /// to it (through `call_tool`, or by its name) runs it, as Node's executor dispatches by registry
    /// (`tool-exec/dispatch.mjs`); `dispatchMcp` runs a tool a connected server of the session's scope holds
    /// whatever the session's exposure (`isRegisteredMcpTool`).
    fn surface_tools(&self, set: ToolSet, header: &Header, surface: &mixdog_tools::policy::SessionSurface) -> ToolSet {
        let scope = super::session_tools::header_scope(header).map(str::to_owned);
        if surface.bridge {
            return set.with_registry(self.services.resolver.clone(), scope);
        }
        set.with_registry(Arc::new(McpOnly(self.services.resolver.clone())), scope)
    }

    async fn request_parts(&self, source: RequestSource<'_>) -> Result<RequestParts, TurnError> {
        let s = &self.services;
        let seams = &s.seams;
        let (thread, header) = (source.thread, source.header);
        let provider_id = text(header, "provider");
        let provider = s
            .registry
            .get(provider_id)
            .await
            .ok_or_else(|| refuse(format!("provider {provider_id:?} is not available")))?;
        let cwd = cwd_of(header)?;
        let SessionTools { tools, builtins, agent } = seams.tools(thread, header, source.surface).await.map_err(refuse)?;
        let tool_set = ToolSet::with_builtins(tools, builtins).for_agent(agent);
        let tool_set = self.surface_tools(tool_set, header, source.surface);
        let settings = super::settings::merge_settings(
            seams.run_settings(thread, header),
            &s.settings,
            &super::settings::TurnFacts {
                thread,
                header,
                provider: &provider,
                prior: source.prior,
                request: source.request,
                injected: source.injected,
                tools: &tool_set.definitions(),
                now_ms: s.clock.now_ms(),
            },
        );
        let mut options = mixdog_core_api::domain::provider::RequestOptions::default();
        apply_identity(&mut options, thread, header, source.turn);
        options.effort = Some(text(header, "effort").to_owned()).filter(|e| !e.is_empty());
        options.fast = header.get("fast").and_then(Value::as_bool) == Some(true);
        options.prompt_cache_key = Some(text(header, "promptCacheKey").to_owned()).filter(|k| !k.is_empty());
        options.model_parameters = header.get("modelParameters").filter(|v| v.is_object()).cloned();
        options.model_max_output_tokens = settings.model_max_output_tokens;
        options.provider_state = source.provider_state;
        options.wire_pin = wire_pin_of(header.get("wireRoute"));
        Ok(RequestParts { provider, cwd, tool_set, settings, options })
    }

    /// `nextMainRequest`: the request the thread's next turn would send, assembled by the same parts
    /// and the same wire function as the turn's, without the turn's side effects. `None` for a thread
    /// that has no conversation yet, runs for an agent, or whose provider is not available.
    pub async fn next_request(
        &self,
        thread: &ThreadId,
        header: &Header,
        surface: &mixdog_tools::policy::SessionSurface,
        prior: Vec<(mixdog_core_api::ids::ItemId, Value)>,
    ) -> Option<(Arc<dyn mixdog_core_api::domain::provider::ProviderAdapter>, mixdog_core_api::domain::provider::ModelRequest)> {
        self.rebuild_request(thread, header, surface, prior, None).await.map(|(provider, request, _)| (provider, request))
    }

    /// [`Self::next_request`] as `nextMainRequest` returns it (`side-question.mjs:64-99`): the tools taken through
    /// `snapshotProviderRequestTools` (the request boundary's [`boundary_tools`]), and `user_message` appended to the
    /// transcript. `None` where `nextMainRequest` is null.
    pub async fn snapshot_request(
        &self,
        thread: &ThreadId,
        header: &Header,
        surface: &mixdog_tools::policy::SessionSurface,
        prior: Vec<(mixdog_core_api::ids::ItemId, Value)>,
        user_message: Option<&str>,
    ) -> Option<(Arc<dyn mixdog_core_api::domain::provider::ProviderAdapter>, mixdog_core_api::domain::provider::ModelRequest)> {
        let (provider, mut request, native) = self.rebuild_request(thread, header, surface, prior, user_message).await?;
        request.tools = boundary_tools(header, std::mem::take(&mut request.tools), &native);
        Some((provider, request))
    }

    async fn rebuild_request(
        &self,
        thread: &ThreadId,
        header: &Header,
        surface: &mixdog_tools::policy::SessionSurface,
        prior: Vec<(mixdog_core_api::ids::ItemId, Value)>,
        user_message: Option<&str>,
    ) -> Option<(Arc<dyn mixdog_core_api::domain::provider::ProviderAdapter>, mixdog_core_api::domain::provider::ModelRequest, Vec<Value>)> {
        if super::compaction_world::is_agent_owner(header) {
            return None;
        }
        let rows: Vec<Value> = prior.iter().map(|(_, body)| body.clone()).collect();
        if !mixdog_core_session::session::route_session::has_user_conversation(&rows) {
            return None;
        }
        let provider_state = header.get("providerState").and_then(|state| serde_json::from_value(state.clone()).ok());
        let source = RequestSource { thread, header, surface, prior: &rows, request: "", injected: false, provider_state, turn: None };
        let parts = self.request_parts(source).await.ok()?;
        let mut messages = rebuilt_messages(header, &rows)?;
        messages.extend(user_message.map(mixdog_agent::message::AgentMessage::user));
        let mut options = parts.options;
        options.iteration = 1;
        let (request, _) = mixdog_agent::assemble_request(
            text(header, "model"),
            options,
            mixdog_agent::project::project_for_wire(&messages),
            None,
            parts.tool_set.definitions(),
        );
        Some((parts.provider, request, super::factory::native_searches(&messages)))
    }

    /// The source of the tail reminder the session's sends carry (`withTailReminder`): what the
    /// turn's own assembly gives the loop, and what a cache warm adds to the request it replays.
    pub fn tail_reminder(&self, header: &Header) -> Arc<dyn mixdog_agent::env::TailReminder> {
        super::tail::session_tail_reminder(self.services.seams.tail_context(header))
    }
}

#[async_trait]
impl RunParts for HostRunParts {
    async fn reconcile_turn(&self, thread: &ThreadId, _: Header, conversation: bool) -> Result<Header, TurnError> {
        use super::turn_settings::TurnSettings;
        self.services.turn_settings.reconcile(thread, conversation).await.map_err(refuse)
    }

    async fn refresh_mcp(&self, thread: &ThreadId) -> Result<(), TurnError> {
        use super::turn_settings::TurnSettings;
        self.services.turn_settings.refresh_mcp(thread).await.map_err(refuse)
    }

    async fn current_agents(&self, thread: &ThreadId, header: &Header) -> Result<Option<Vec<super::turn_reminders::AgentEntry>>, TurnError> {
        use super::turn_settings::TurnSettings;
        self.services.turn_settings.current_agents(thread, header).await.map_err(refuse)
    }

    async fn orchestration_instructions(&self, mode: &str) -> Result<String, TurnError> {
        use super::turn_settings::TurnSettings;
        self.services.turn_settings.orchestration_instructions(mode).await.map_err(refuse)
    }

    async fn request_tools(&self, thread: &ThreadId, surface: &mixdog_tools::policy::SessionSurface) -> Result<Option<ToolSet>, TurnError> {
        let directory = self.services.directory.upgrade().ok_or_else(|| refuse("the session directory is closed"))?;
        let header = directory.live_header(thread).header();
        let SessionTools { tools, builtins, agent } = self.services.seams.tools(thread, &header, surface).await.map_err(refuse)?;
        let tool_set = ToolSet::with_builtins(tools, builtins).for_agent(agent);
        Ok(Some(self.surface_tools(tool_set, &header, surface)))
    }

    async fn migrate_exposure(&self, thread: &ThreadId, rows: Vec<Value>) -> Result<Option<Vec<mixdog_agent::message::AgentMessage>>, TurnError> {
        use super::turn_settings::TurnSettings;
        let migrated = self.services.turn_settings.migrate_exposure(thread, &rows).await.map_err(refuse)?;
        Ok(migrated.map(|header| super::factory::system_messages(&header)))
    }

    async fn request_snapshot(&self, thread: &ThreadId, tools: Vec<mixdog_core_api::domain::provider::ToolDefinition>, native: Vec<Value>) -> Result<Vec<mixdog_core_api::domain::provider::ToolDefinition>, TurnError> {
        let directory = self.services.directory.upgrade().ok_or_else(|| refuse("the session directory is closed"))?;
        let header = directory.live_header(thread).header();
        Ok(boundary_tools(&header, tools, &native))
    }

    fn stall_cap_idle_seconds(&self, agent: Option<&str>) -> Option<i64> {
        self.services.seams.stall_cap_idle_seconds(agent)
    }

    fn reap_turn_shells(&self, thread: &ThreadId, since_ms: i64) {
        if let Some(shells) = &self.services.shells {
            shells.reap_since(&mixdog_protocol::ThreadId::from(thread.as_str()), since_ms.max(0) as u64);
        }
    }

    fn reset_turn_shells(&self, thread: &ThreadId) {
        if let Some(shells) = &self.services.shells {
            shells.reset_reaped(&mixdog_protocol::ThreadId::from(thread.as_str()));
        }
    }

    async fn first_response_timeout_ms(&self, agent: &str) -> Option<i64> {
        self.services.seams.first_response_timeout_ms(agent).await
    }

    async fn record_applied_skills(&self, thread: &ThreadId, item: &mixdog_core_api::ids::ItemId, names: &[String]) -> Result<(), TurnError> {
        let directory = self.services.directory.upgrade().ok_or_else(|| refuse("the session directory is closed"))?;
        mixdog_core_session::session::thread_switches::record_applied_skills(&directory, thread, item, names).await.map_err(|error| refuse(error.to_string()))
    }

    async fn assemble(&self, input: AssembleInput<'_>) -> Result<Assembled, TurnError> {
        let s = &self.services;
        let seams = &s.seams;
        let (thread, header) = (input.thread, input.header);
        let provider_id = text(header, "provider");
        let directory = s.directory.upgrade().ok_or_else(|| refuse("the session directory is closed"))?;
        // `ensureCodexWireSessionId` (`ask-turn-open.mjs:85`): a Codex session with no valid stored wire identity (a fork
        // or a cold heir does not carry the source's, `cold-heir.mjs:70`) mints one and stores it before its first request.
        let ensured;
        let header = if provider_id == "openai-oauth" && !is_uuid_v7(&text(header, "codexWireSessionId").to_lowercase()) {
            directory
                .update_header(
                    thread,
                    Box::new(|stored| {
                        let mut set = serde_json::Map::new();
                        if !is_uuid_v7(&text(stored, "codexWireSessionId").to_lowercase()) {
                            set.insert("codexWireSessionId".into(), json!(uuid::Uuid::now_v7().to_string()));
                        }
                        mixdog_store::schema::record::HeaderChange { set, unset: Vec::new() }
                    }),
                )
                .await
                .map_err(|error| refuse(error.to_string()))?;
            ensured = directory.handle(thread).map(|handle| handle.live_header().header());
            ensured.as_deref().unwrap_or(header)
        } else {
            header
        };
        let RequestParts { provider, cwd, tool_set, settings, mut options } = self
            .request_parts(RequestSource {
                thread,
                header,
                surface: &input.surface,
                prior: input.prior,
                request: input.request,
                injected: input.injected,
                provider_state: input.port.provider_state().await,
                turn: Some(input.turn.clone()),
            })
            .await?;
        let agent = header.get("agent").and_then(Value::as_str).filter(|a| !a.is_empty());
        let hidden = seams.hidden_agent(agent) || settings.hidden_agent;
        // `pinSessionWireRoute` (`ask-turn-execute.mjs`): the session's wire is pinned before its first request;
        // a session that predates the table (`wireRoute` absent) and already answered keeps the wire it started on.
        {
            let model = text(header, "model");
            let current = header.get("wireRoute");
            let answered = input.prior.iter().any(|row| row.get("role").and_then(Value::as_str) == Some("assistant"));
            if let Some(pin) = mixdog_core_run::run_host::hop_host::resolve_pin(&*provider, current, provider_id, model, current.is_none() && answered).await {
                // The route moved while resolving: the newer route pins on its own turn.
                let live = directory.live_header(thread).header();
                if text(&live, "provider") == provider_id && text(&live, "model") == model {
                    // The turn's sends read the pin the session now holds (`sendWireRoute` reads `session.wireRoute`).
                    options.wire_pin = wire_pin_of(Some(&pin));
                    let mut set = serde_json::Map::new();
                    set.insert("wireRoute".into(), pin);
                    input.port.save_header(mixdog_store::schema::record::HeaderChange { set, unset: Vec::new() }).await.map_err(|_| refuse("the pinned wire route could not be saved"))?;
                }
            }
        }
        let tool_env = ToolEnv {
            thread_id: thread.clone(),
            turn_id: input.turn.clone(),
            cwd: AbsPath::new(cwd.clone()).ok_or_else(|| refuse("the working directory is not absolute"))?,
            surface: if super::compaction_world::is_agent_owner(header) { SurfaceKind::Agent } else { SurfaceKind::Lead },
            io: s.io.clone(),
            approvals: s.approvals.gate_for(thread, Arc::new(input.port.clone())),
            files: s.files.clone(),
            processes: s.processes.clone(),
            progress: input.progress.clone(),
            deadline_of: None,
            notify: input.notify.clone(),
            review: None,
        };
        // `beginTodoTurn(session, { genuine: !turnPromptSource?.source })` over the cycle state the record carries.
        let todo_guards = Arc::new(TodoGuards::new(seams.todo_view(thread, header), hidden).with_saved(header.get("todoCheck")));
        todo_guards.start_turn(!input.injected).await;
        let guards: Arc<dyn TurnGuards> = todo_guards;
        let observer: super::tool_exclusions::ObserverSlot = Arc::default();

        let mut config = RunConfig::new(thread.clone(), input.turn.clone(), text(header, "model"));
        // `send-phase.mjs:117`: the adapters report the tools they leave out of a request here.
        let mut options = options;
        options.on_tool_excluded = Some(super::tool_exclusions::sink(s.exclusions.clone(), thread.clone(), observer.clone(), s.directory.clone()));
        // Each provider attempt of the loop, whatever provider a route hop moved it to, begins a new set;
        // a side question's attempts do not (Node's `send-phase` is the loop's).
        config.request_begin = Some(super::tool_exclusions::request_begin(s.exclusions.clone(), thread.clone(), s.directory.clone()));
        config.options = options;
        config.hidden_agent = hidden;
        config.agent_mode = settings.agent_mode;
        config.limits = settings.limits;
        let compact_settings = settings.compact.clone();
        config.compact = settings.compact;
        config.escalated_max_output_tokens = settings.escalated_max_output_tokens;
        config.read_body_required = settings.read_body_required;
        config.effort = settings.effort;
        // The judge is built only when auto effort is on for the turn (`stepAutoEffort`), over the
        // shared model and the ladder of this run's route.
        // Step judging needs a calibration made for steps (`calibration.json` `steps === 1`).
        let step_auto_effort = match (settings.step_auto_effort, &s.effort_judge) {
            (Some(auto), Some(model)) if model.supports_steps().await => Some(auto),
            _ => None,
        };
        let step_judge = match &step_auto_effort {
            Some(auto) => match seams.step_ladder_facts(thread, header, auto).await {
                Some(facts) => super::step_judge::ladder_for(provider_id, auto, facts)
                    .zip(s.effort_judge.clone())
                    .map(|(ladder, model)| Arc::new(EffortJudge::new(model, ladder)) as Arc<dyn StepEffortJudge>),
                None => None,
            },
            None => None,
        };
        config.step_auto_effort = step_auto_effort;
        config.text_only = settings.text_only;
        config.attachments = settings.attachments;
        config.slot = input.slot;

        // The gate needs the observer and the token, which the factory makes after this: it is
        // built from them.
        let gate: GateBuilder = {
            let (policy, connectors, resolver) = (s.policy.clone(), s.connectors.clone(), s.resolver.clone());
            let grants = directory.grants(thread);
            let session = Arc::new(SessionGate::new(thread.clone(), directory.live_header(thread), input.surface_rx.clone(), s.gate_env.clone()));
            let (thread, cwd) = (thread.clone(), cwd.clone());
            let observer = observer.clone();
            let approvals = s.approvals.clone();
            Box::new(move |context: GateContext| {
                // The run's observer shows the exclusion notices; the factory builds the gate before the first request.
                let _ = observer.set(context.observer.clone());
                Arc::new(mixdog_agent::env::PolicyGate::new(mixdog_agent::env::PolicyGateParts {
                    policy,
                    connectors,
                    session,
                    tools: resolver,
                    grants,
                    approvals: approvals.gate_for(&thread, context.approvals),
                    observer: context.observer,
                    guards: context.guards,
                    thread_id: thread,
                    cwd,
                    cancel: context.cancel,
                }))
            })
        };
        let session_id = thread.as_str();
        let read_body = config.read_body_required;
        // The reaction facts are read off the stored bodies the run holds, as Node reads `meta`.
        let rows = Arc::new(mixdog_core_session::session::StoredRows::new());
        let artifacts: Arc<dyn mixdog_agent::offload::ArtifactStore> = Arc::new(ToolResultArtifacts::new(s.io, &seams.data_dir(), session_id));
        // No settings, no compaction policy: Node has no compactor for the session.
        let compactor = match compact_settings {
            Some(settings) => {
                seams.compactor(thread, header, input.prior, CompactorInput { settings, rows: rows.clone(), archive: artifacts.clone(), blobs: s.blobs.clone() }).await
            }
            None => None,
        };
        let side = s.side.tap(super::side_requests::RunSide { thread: thread.clone(), provider_name: provider_id.to_owned(), provider: provider.clone(), agent_owner: super::compaction_world::is_agent_owner(header) });
        Ok(Assembled {
            rows: rows.clone(),
            provider,
            tools: tool_set,
            tool_env,
            gate,
            worktree: cwd.to_string_lossy().into_owned(),
            config,
            clock: s.clock.clone(),
            decider: Arc::new(StandardRetryDecider),
            guards,
            compactor,
            route: seams.hop_host(thread, header).map(|host| Arc::new(RouteHop::new(host)) as Arc<dyn RouteFallback>),
            skills: seams.skill_parts().map(|parts| {
                let selection = input.skill_selection.clone();
                Box::new(move |run: SkillContext| {
                    Arc::new(super::mcp_seams::ExplicitSkillSelector::new(parts.names, parts.tool, run.gate, run.env, run.cancel).with_selection(selection)) as Arc<dyn SkillSelector>
                }) as SkillsBuilder
            }),
            hooks: Some(Arc::new(SessionToolHooks::new(session_id, &cwd, seams.post_tool_dispatch()))),
            reuse: Some({
                let reuse = Arc::new(ToolResultReuse::new(s.io, session_id, &cwd, read_body, s.clock.clone()));
                s.reuses.track(&reuse);
                reuse
            }),
            reactions: Some(Arc::new(LoopReactions::new(session_id, s.reaction_targets.clone(), rows, mixdog_protocol::text_class::is_internal_transcript_display_text))),
            reaction_scope: Some(ReactionScope::new(s.reaction_targets.clone(), session_id)),
            tail: Some(self.tail_reminder(header)),
            side: Some(side),
            step_judge,
            artifacts: Some(artifacts),
            images: seams.image_compactor(),
            failures: Some(Arc::new(RunFailureLog::new(
                FailureWriter::for_data_dir(&seams.data_dir(), s.io, s.clock.clone()),
                session_id,
                // `agent: batch.sessionRef?.agent || null` (finalize.mjs:236): the session's own agent, the Lead's "lead" included.
                agent,
                &cwd.to_string_lossy(),
            ))),
            blobs: s.blobs.clone(),
            carry: RunCarry::from_saved(header),
        })
    }
}

/// The messages of the next main request: the system prompt and the stored rows, with the pre-send
/// transcript repair of the loop's request boundary (a tool call the interrupted turn never answered
/// gets its stub, a stray result is dropped) applied to this local copy only; nothing is persisted.
fn rebuilt_messages(header: &Header, rows: &[Value]) -> Option<Vec<mixdog_agent::message::AgentMessage>> {
    let mut messages = super::factory::system_messages(header);
    for body in rows {
        messages.push(super::message_row::message_of(body).ok()?);
    }
    mixdog_agent::repair::repair_before_send(&mut messages);
    Some(messages)
}

#[cfg(test)]
mod rebuilt_tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_dangling_tool_call_is_answered_with_the_missing_stub_in_the_rebuilt_request() {
        let header = json!({}).as_object().unwrap().clone();
        let rows = vec![
            json!({ "role": "user", "content": "go" }),
            json!({ "role": "assistant", "content": "", "toolCalls": [{ "id": "c1", "name": "list", "arguments": {} }] }),
        ];
        let messages = rebuilt_messages(&header, &rows).unwrap();
        let tail = &messages[messages.len() - 1];
        assert_eq!(tail.tool_call_id(), Some("c1"));
        assert_eq!(tail.text(), "[Older tool result unavailable after context compaction]");
        assert_eq!(messages.len() - mixdog_core_prompt::prompt::blocks::request_system_messages(&header).len(), 3, "user, assistant, stub; no tail reminder");
        // A complete transcript is untouched.
        let whole = vec![rows[0].clone(), rows[1].clone(), json!({ "role": "tool", "toolCallId": "c1", "content": { "content": "ok" } })];
        assert_eq!(rebuilt_messages(&header, &whole).unwrap().last().unwrap().text(), "ok");
    }
}

/// The identity a request carries is read from the session's stored header, whichever way the session came to be
/// opened (`ensureCodexWireSessionId`, `ask-turn-open.mjs:85`): a resumed session sends the id it was stored with, a
/// sub-agent session the id of its own header and not its parent's, and a fork the id the fork minted for itself
/// (`mixdog-core-session`, `a_fork_has_a_codex_wire_identity_of_its_own`).
#[cfg(test)]
mod identity_tests {
    use serde_json::json;

    use super::*;

    fn stored(thread: &str, provider: &str, wire: serde_json::Value) -> (ThreadId, Header) {
        let header = json!({ "provider": provider, "codexWireSessionId": wire }).as_object().unwrap().clone();
        // Through the store's own text, as a resumed session's header comes back.
        let header: Header = serde_json::from_str(&serde_json::to_string(&header).unwrap()).unwrap();
        (ThreadId::from(thread), header)
    }

    fn request_of(thread: &ThreadId, header: &Header) -> mixdog_core_api::domain::provider::RequestOptions {
        let mut options = mixdog_core_api::domain::provider::RequestOptions::default();
        apply_identity(&mut options, thread, header, None);
        options
    }

    #[test]
    fn a_resumed_session_sends_its_stored_identity_in_every_request_field() {
        let (thread, header) = stored("thread_a", "openai-oauth", json!("0190F0A0-1C2D-7E3F-8A4B-5C6D7E8F9A0D"));
        let options = request_of(&thread, &header);
        let wire = "0190f0a0-1c2d-7e3f-8a4b-5c6d7e8f9a0d";
        assert_eq!(options.session_id.as_deref(), Some(wire));
        assert_eq!(options.thread.as_ref().unwrap().id.as_str(), wire);
        // Resumed again from the same stored header: the same identity.
        assert_eq!(request_of(&thread, &header).session_id, options.session_id);
    }

    #[test]
    fn a_sub_agent_session_sends_its_own_stored_identity_not_its_parents() {
        let (parent, parent_header) = stored("thread_parent", "openai-oauth", json!("0190f0a0-1c2d-7e3f-8a4b-5c6d7e8f9a0d"));
        let (child, child_header) = stored("thread_child", "openai-oauth", json!("0190f0a1-2222-7333-9444-555566667777"));
        assert_eq!(request_of(&parent, &parent_header).session_id.as_deref(), Some("0190f0a0-1c2d-7e3f-8a4b-5c6d7e8f9a0d"));
        assert_eq!(request_of(&child, &child_header).session_id.as_deref(), Some("0190f0a1-2222-7333-9444-555566667777"));
    }

    #[test]
    fn another_route_or_an_invalid_stored_identity_names_the_thread_itself() {
        let (thread, other) = stored("thread_b", "anthropic-oauth", json!("0190f0a0-1c2d-7e3f-8a4b-5c6d7e8f9a0d"));
        assert_eq!(request_of(&thread, &other).session_id.as_deref(), Some("thread_b"));
        let (thread, bad) = stored("thread_c", "openai-oauth", json!("not-a-uuid"));
        assert_eq!(request_of(&thread, &bad).session_id.as_deref(), Some("thread_c"));
    }
}