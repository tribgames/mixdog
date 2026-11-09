//! The turn path, built once per process: every part of the host assembly constructed from its inputs
//! and bound to the session directory. Every field of [`TurnPathParts`] is required; the parts no
//! crate implements yet are owner traits there (see `compose-seams.md`, "TurnPath inputs"), so the
//! daemon can only build the path once each has its real implementation.

use std::sync::Arc;

use mixdog_agent::compact::image::ToolImageCompactor;
use mixdog_agent::env::Clock;
use mixdog_ai::registry::providers::ProviderRegistry;
use mixdog_core_api::domain::ext::ExtPool;
use mixdog_core_api::domain::fs::FileService;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::tool::{Tool, ToolIo};
use mixdog_exthost::ExtImageCodec;
use mixdog_mcp::hook_bus::session::CommonOf;
use mixdog_mcp::hook_bus::HookBus;
use mixdog_mcp::skill_select::SkillNames;
use mixdog_agent::compact::blob_reads::BlobReads;
use mixdog_rt::LaneTokens;
use mixdog_services::effort_judge::judge::EffortJudgeModel;
use mixdog_store::paths::Paths;
use mixdog_tools::policy::{ConnectorPermissions, ToolPolicy, ToolResolver};
use mixdog_tools::state::todo::TodoStore;

use super::assemble::SkillParts;
use super::boot::{build_directory, HostParts};
use super::compactors::SessionCompactors;
use super::mcp_seams::{AllowAllActions, HostGateEnv};
use super::unattended::UnattendedRunRegistry;
use mixdog_core_agents::agents::AgentDefinitions;
use mixdog_core_agents::agents::ContactIds;
use mixdog_mcp::McpHub;
use mixdog_core_run::run_host::guards::RunningWork;
use mixdog_core_run::run_host::guards::UserCycles;
use super::host_seams::{ConfigSeams, DirectoryParts, SeamParts};
use mixdog_core_run::run_host::hop_host::HopFactory;
use super::mcp_seams::BusPostToolDispatch;
use super::prewarm::StartupProbes;
use super::reactions::ReactionTargets;
use super::settings::SettingsSources;
use super::session_tools::{SessionMcp, SessionToolBuilder, SkillsListed};
use super::step_judge::LadderSources;
use mixdog_core_goal::goal::GoalRuntime;
use mixdog_core_run::ports::todo_view::TodoViews;
use mixdog_core_prompt::prompt::probes::StartupObservations;
use mixdog_core_session::session::RunFactory;
use mixdog_core_session::session::SessionDeps;
use mixdog_core_session::session::SessionDirectory;

/// Everything the turn path is built from.
pub struct TurnPathParts {
    pub tokens: LaneTokens,
    pub clock: Arc<dyn Clock>,
    /// `Paths::from_process`, built once at boot.
    pub paths: Paths,
    // The model side.
    /// The process's one provider registry, built before the turn path (`compose_parts::provider_registry`):
    /// `ProviderReadiness` and the settings and feature effects hold the same `Arc`.
    pub registry: Arc<ProviderRegistry>,
    /// The shared effort-judge model (needs the ONNX Runtime library, WP-INTEGRATE).
    pub effort_judge: Arc<EffortJudgeModel>,
    /// The one side-question store: compaction.requests is built over the same instance.
    pub side: super::side_requests::SideRequests,
    /// The source of a thread's next request: the one SideQuestionService (in deps) is built over; bound here.
    pub next: Arc<super::next_request_source::NextRequestSource>,
    // The tool side.
    pub files: Arc<dyn FileService>,
    pub processes: Arc<dyn ProcessManager>,
    pub policy: Arc<ToolPolicy>,
    pub connectors: Arc<dyn ConnectorPermissions>,
    pub resolver: Arc<dyn ToolResolver>,
    /// The unattended runs' stamps (the session record's `run` object, WP-SESSION).
    pub unattended: Arc<UnattendedRunRegistry>,
    /// Where a run's approval asks go: the held-request layer of the composition.
    pub approvals: Arc<dyn super::run_approvals::RunApprovals>,
    /// The provider tool exclusions the turns record into: the SAME value the tool pool's `SessionCatalog` and the sessions' tool surfaces take (the pool is
    /// built before this path, so the path cannot make it).
    pub exclusions: Arc<mixdog_core_session::session::SessionToolExclusions>,
    /// The agent definitions the contact-bot rule reads.
    pub agents: Arc<AgentDefinitions>,
    pub allow_all: Arc<dyn AllowAllActions>,
    /// The MCP hub, for the connector account of a call.
    pub hub: Arc<McpHub>,
    pub blobs: Arc<dyn BlobReads>,
    /// Every registered tool, including `Skill`, `todo` and `load_tool`; the read/edit/patch tools carry the
    /// process's one `ReadState`.
    pub tool_pool: Vec<Arc<dyn Tool>>,
    pub mcp: Arc<dyn SessionMcp>,
    pub skills_listed: Arc<dyn SkillsListed>,
    /// The skill names available for a cwd (`SkillCatalog`).
    pub skill_names: Arc<dyn SkillNames>,
    pub ext_pool: Arc<dyn ExtPool>,
    pub hook_bus: Arc<HookBus>,
    pub hook_common: CommonOf,
    // The session side.
    pub goals: Arc<GoalRuntime>,
    pub todos: Arc<dyn TodoStore>,
    pub work: Arc<dyn RunningWork>,
    pub cycles: Arc<UserCycles>,
    pub config: Arc<dyn ConfigSeams>,
    /// The settings the config does not hold: the route wiring (`RouteWirer`), attachments, heartbeat marks, output
    /// ceilings and auto-effort settings.
    pub settings: SettingsSources,
    pub ladder: Arc<dyn LadderSources>,
    /// The session directory's own dependencies, given the real run factory (WP-SESSION).
    pub deps: Box<dyn FnOnce(Arc<dyn RunFactory>) -> SessionDeps>,
    /// The session compactors, built over the compaction world (WP-COMPACTION-WORLD) by the composition: the manual compaction and the inheritance fit
    /// read the same world, and neither can be built from inside this path (the `deps` closure is called in it with the run factory only).
    pub compactors: Arc<SessionCompactors>,
    /// The route hop, built over the directory and the path's registry.
    pub hops: Box<dyn FnOnce(&Arc<SessionDirectory>, &Arc<ProviderRegistry>) -> HopFactory>,
    /// The runtime's shell control: the progress watchdog's stop reaps a turn's shells through it.
    pub shells: Option<Arc<mixdog_tools::exec::ShellControl>>,
    /// The runtime liveness map the runs write, made by the composition: the code-graph prewarm's busy probe (inside deps) and the path's readers hold the same Arc.
    pub liveness: Arc<mixdog_services::task_reports::runtime_state::RuntimeLiveness>,
    /// The hosted web search's usage registry, made by the composition: `SenderDeps.sinks` reports into the same Arc the runs register their turn in.
    pub search_usage: Arc<mixdog_tools::web::NativeSearchUsageSinks>,
}

#[derive(Debug, thiserror::Error)]
pub enum TurnPathError {
    #[error("no `Skill` tool is registered")]
    NoSkillTool,
    #[error("starting the providers: {0}")]
    Providers(String),
    /// A `git` or `task` without the definition delegated agents are sent.
    #[error("{0}")]
    AgentVariant(#[from] super::agent_variants::VariantError),
}

pub struct TurnPath {
    /// The real `ThreadDirectory` for the core.
    pub directory: Arc<SessionDirectory>,
    /// The table `ports::reactions::SessionReactions` records into.
    pub reaction_targets: Arc<ReactionTargets>,
    /// Clear a session's live result caches on a workspace change (`HostRuntime::workspace_context`).
    pub reuses: Arc<super::result_reuse::LiveReuses>,
    pub registry: Arc<ProviderRegistry>,
    /// `markUnattendedRun`: schedule and webhook runs mark themselves here for the length of a run.
    pub unattended: Arc<UnattendedRunRegistry>,
    /// The contact-bot snapshot; call `refresh().await` at start and when the agents change.
    pub contacts: Arc<ContactIds>,
    /// The provider tool exclusions the turns record into: pass this same value to
    /// `SessionCatalog::new` as its `exclusions`.
    pub exclusions: Arc<mixdog_core_session::session::SessionToolExclusions>,
    /// Bind the settings host here once it exists (LeadSurfaceHost as TurnSettings); every turn start
    /// reconciles through it, and a turn before the bind fails.
    pub turn_settings: Arc<super::turn_settings::LateTurnSettings>,
    /// The runtime liveness map the runs write: the pool's `running`, the thread list's `working` and the report host read it.
    pub liveness: Arc<mixdog_services::task_reports::runtime_state::RuntimeLiveness>,
}

impl TurnPath {
    pub fn new(parts: TurnPathParts) -> Result<Self, TurnPathError> {
        let TurnPathParts {
            tokens, clock, paths, registry, effort_judge, side, next, files, processes, policy, connectors, resolver, unattended, approvals, exclusions, agents, allow_all, hub, blobs, tool_pool, mcp,
            skills_listed, skill_names, ext_pool, hook_bus, hook_common, goals, todos, work, cycles, config, settings, ladder, deps, compactors, hops, shells, liveness, search_usage,
        } = parts;
        let io = ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io };
        let skill_tool = tool_pool.iter().find(|t| t.spec().name == "Skill").cloned().ok_or(TurnPathError::NoSkillTool)?;
        let reaction_targets: Arc<ReactionTargets> = Arc::default();
        let reuses: Arc<super::result_reuse::LiveReuses> = Arc::default();
        let turn_settings: Arc<super::turn_settings::LateTurnSettings> = Arc::default();
        let contacts = Arc::new(ContactIds::new(agents));
        let gate_env = Arc::new(HostGateEnv::new(unattended.clone(), contacts.clone(), allow_all, hub));
        let host = HostParts {
            registry: registry.clone(),
            clock: clock.clone(),
            files,
            processes: processes.clone(),
            io,
            policy,
            connectors,
            resolver,
            gate_env,
            approvals,
            blobs,
            reaction_targets: reaction_targets.clone(),
            reuses: reuses.clone(),
            effort_judge: Some(effort_judge),
            side,
            next,
            settings,
            seams: SeamParts {
                tools: SessionToolBuilder::new(tool_pool, mcp, skills_listed)?,
                todos: TodoViews::new(todos, goals, work, cycles),
                post_tool: Arc::new(BusPostToolDispatch::new(hook_bus, hook_common)),
                skills: Some(SkillParts { names: skill_names, tool: skill_tool }),
                config,
                ladder,
                images: Some(Arc::new(ToolImageCompactor::new(Arc::new(ExtImageCodec::new(ext_pool))))),
                paths,
            },
            probes: Arc::new(StartupProbes::new(io, processes)),
            observed: Arc::new(StartupObservations::new(clock)),
            shells,
            exclusions: exclusions.clone(),
            turn_settings: turn_settings.clone(),
            liveness: liveness.clone(),
            search_usage,
        };
        let directory = build_directory(host, deps, move |directory, registry| DirectoryParts { hops: Arc::new(hops(directory, registry)), compactors });
        Ok(Self { directory, reaction_targets, reuses, registry, unattended, contacts, exclusions, turn_settings, liveness })
    }
}
