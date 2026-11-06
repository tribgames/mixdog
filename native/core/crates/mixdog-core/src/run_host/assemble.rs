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
use mixdog_protocol::message_class::user_text::Blobs;
use mixdog_services::effort_judge::judge::{EffortJudge, EffortJudgeModel};
use mixdog_agent::step_effort::StepEffortJudge;
use mixdog_store::schema::record::Header;
use mixdog_tools::policy::{ConnectorPermissions, SessionGrants, ToolPolicy, ToolResolver};
use serde_json::{json, Value};

use super::artifact::ToolResultArtifacts;
use super::factory::{Assembled, AssembleInput, GateBuilder, GateContext, RunParts, SkillContext, SkillsBuilder};
use super::hooks::{PostToolDispatch, SessionToolHooks};
use super::reactions::{LoopReactions, ReactionScope, ReactionTargets};
use super::result_reuse::ToolResultReuse;
use super::route_fallback::{HopHost, RouteHop};
use crate::ports::gate::{GateEnv, LiveHeader, SessionGate};

/// The tools of a session's surface.
pub struct SessionTools {
    pub tools: Vec<Arc<dyn Tool>>,
    /// The builtin names typo aliases and suggestions draw from (`ToolSet::with_builtins`).
    pub builtins: Vec<String>,
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
    pub rows: Arc<crate::session::StoredRows>,
    /// Where a dropped execution is archived (`FreshParts.archive`).
    pub archive: Arc<dyn mixdog_agent::offload::ArtifactStore>,
    pub blobs: Arc<dyn Blobs + Send + Sync>,
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
    /// The todo list, goal and background work as the turn guards read them. Owner:
    /// WP-SESSION-PORTS (`TodoStore`, `GoalPort`) over `run_host::guards::HostTodoView`.
    fn todo_view(&self, thread: &ThreadId, header: &Header) -> Arc<dyn TodoView>;
    /// PostToolUse / PostToolUseFailure / PostToolBatch dispatch. Owner: WP-MCP (hook bus).
    fn post_tool_dispatch(&self) -> Arc<dyn PostToolDispatch>;
    /// The compaction pipeline for this session's route (`run_host::compactors::SessionCompactors`
    /// over `FreshCompactor::for_session`). `input` is the run's: the settings it compacts by and
    /// the stored rows, archive and blobs its transcript is read through.
    fn compactor(&self, thread: &ThreadId, header: &Header, input: CompactorInput) -> Option<Arc<dyn Compactor>>;
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
    pub blobs: Arc<dyn Blobs + Send + Sync>,
    /// The process-wide react targets: the same value the react tool (`ports::reactions::SessionReactions`)
    /// records into.
    pub reaction_targets: Arc<ReactionTargets>,
    /// The session directory: each session's live header, grants and thread window. Boot builds it with
    /// `Arc::new_cyclic` since the directory owns the run factory that owns these services.
    pub directory: std::sync::Weak<crate::session::SessionDirectory>,
    /// The shared effort-judge model, present when the install has the ONNX Runtime library; each run's judge is
    /// built over it with the run's ladder.
    pub effort_judge: Option<Arc<EffortJudgeModel>>,
    pub seams: Arc<dyn SessionSeams>,
    /// The sources of the settings the config does not hold.
    pub settings: super::settings::SettingsSources,
    /// Runs the git and shell-tools probes of a composition (one per daemon process).
    pub probes: Arc<super::prewarm::StartupProbes>,
    /// The process-wide probe cache (`prompt::probes`).
    pub observed: Arc<crate::prompt::probes::StartupObservations>,
}

pub struct HostRunParts {
    services: HostServices,
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

#[async_trait]
impl RunParts for HostRunParts {
    async fn assemble(&self, input: AssembleInput<'_>) -> Result<Assembled, TurnError> {
        let s = &self.services;
        let seams = &s.seams;
        let (thread, header) = (input.thread, input.header);
        let (provider_id, model) = (text(header, "provider"), text(header, "model"));
        let provider = s
            .registry
            .get(provider_id)
            .await
            .ok_or_else(|| refuse(format!("provider {provider_id:?} is not available")))?;
        let cwd = cwd_of(header)?;
        let SessionTools { tools, builtins } = seams.tools(thread, header, &input.surface).await.map_err(refuse)?;
        let tool_set = ToolSet::with_builtins(tools, builtins);
        let settings = super::settings::merge_settings(
            seams.run_settings(thread, header),
            &s.settings,
            &super::settings::TurnFacts {
                thread,
                header,
                provider: &provider,
                prior: input.prior,
                request: input.request,
                injected: input.injected,
                tools: &tool_set.definitions(),
                now_ms: s.clock.now_ms(),
            },
        );
        let agent = header.get("agent").and_then(Value::as_str).filter(|a| !a.is_empty());
        let hidden = seams.hidden_agent(agent) || settings.hidden_agent;
        let tool_env = ToolEnv {
            thread_id: thread.clone(),
            turn_id: input.turn.clone(),
            cwd: AbsPath::new(cwd.clone()).ok_or_else(|| refuse("the working directory is not absolute"))?,
            surface: if text(header, "owner") == "agent" { SurfaceKind::Agent } else { SurfaceKind::Lead },
            io: s.io.clone(),
            approvals: Arc::new(input.port.clone()),
            files: s.files.clone(),
            processes: s.processes.clone(),
            progress: input.progress.clone(),
            deadline_of: None,
            notify: input.notify.clone(),
        };
        let directory = s.directory.upgrade().ok_or_else(|| refuse("the session directory is closed"))?;
        let guards: Arc<dyn TurnGuards> = Arc::new(TodoGuards::new(seams.todo_view(thread, header), hidden));

        let mut config = RunConfig::new(thread.clone(), input.turn.clone(), model);
        let options = &mut config.options;
        options.session_id = Some(thread.as_str().to_owned());
        options.effort = Some(text(header, "effort").to_owned()).filter(|e| !e.is_empty());
        options.fast = header.get("fast").and_then(Value::as_bool) == Some(true);
        options.prompt_cache_key = Some(text(header, "promptCacheKey").to_owned()).filter(|k| !k.is_empty());
        options.model_parameters = header.get("modelParameters").filter(|v| v.is_object()).cloned();
        options.model_max_output_tokens = settings.model_max_output_tokens;
        options.thread = Some(RequestThread { id: thread.clone(), window: directory.thread_window(thread), turn: Some(input.turn.clone()) });
        options.provider_state = input.port.provider_state().await;
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
            Box::new(move |context: GateContext| {
                Arc::new(mixdog_agent::env::PolicyGate::new(mixdog_agent::env::PolicyGateParts {
                    policy,
                    connectors,
                    session,
                    tools: resolver,
                    grants,
                    approvals: context.approvals,
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
        let rows = Arc::new(crate::session::StoredRows::new());
        let artifacts: Arc<dyn mixdog_agent::offload::ArtifactStore> = Arc::new(ToolResultArtifacts::new(s.io, &seams.data_dir(), session_id));
        // No settings, no compaction policy: Node has no compactor for the session.
        let compactor = compact_settings.and_then(|settings| {
            seams.compactor(thread, header, CompactorInput { settings, rows: rows.clone(), archive: artifacts.clone(), blobs: s.blobs.clone() })
        });
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
            reuse: Some(Arc::new(ToolResultReuse::new(s.io, session_id, &cwd, read_body, s.clock.clone()))),
            reactions: Some(Arc::new(LoopReactions::new(session_id, s.reaction_targets.clone(), rows, mixdog_protocol::text_class::is_internal_transcript_display_text))),
            reaction_scope: Some(ReactionScope::new(s.reaction_targets.clone(), session_id)),
            tail: Some(Arc::new(mixdog_agent::tail_rules::RuleTailReminder { context: seams.tail_context(header) })),
            step_judge,
            artifacts: Some(artifacts),
            images: seams.image_compactor(),
            blobs: s.blobs.clone(),
            carry: RunCarry::default(),
        })
    }
}
