//! The turn path, built once per process: every part of the host assembly constructed from its inputs
//! and bound to the session directory. Every field of [`TurnPathParts`] is required; the parts no
//! crate implements yet are owner traits there (see `compose-seams.md`, "TurnPath inputs"), so the
//! daemon can only build the path once each has its real implementation.

use std::sync::Arc;

use mixdog_agent::compact::image::ToolImageCompactor;
use mixdog_agent::env::Clock;
use mixdog_ai::registry::accounted::AccountingDeps;
use mixdog_ai::registry::providers::{ProviderBuilder, ProviderRegistry};
use mixdog_core_api::domain::ext::ExtPool;
use mixdog_core_api::domain::fs::FileService;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::tool::{Tool, ToolIo};
use mixdog_exthost::ExtImageCodec;
use mixdog_mcp::hook_bus::session::CommonOf;
use mixdog_mcp::hook_bus::HookBus;
use mixdog_mcp::skill_select::SkillNames;
use mixdog_protocol::message_class::user_text::Blobs;
use mixdog_rt::LaneTokens;
use mixdog_services::effort_judge::judge::EffortJudgeModel;
use mixdog_store::paths::Paths;
use mixdog_tools::policy::{ConnectorPermissions, ToolPolicy, ToolResolver};
use mixdog_tools::state::todo::TodoStore;

use super::assemble::SkillParts;
use super::boot::{build_directory, HostParts};
use super::compaction_world::{CompactionServices, ProcessCompactionWorld};
use super::compactors::SessionCompactors;
use super::mcp_seams::{AllowAllActions, HostGateEnv};
use mixdog_core_ports::ports::run_stamps::RunStamps;
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
    /// `DefaultProviderBuilder::new(BuilderEnv)` (WP-AI-SVC).
    pub provider_builder: Arc<dyn ProviderBuilder>,
    /// Pricing, the ledger sink, the send scope and the account lookup (WP-AI-SVC, WP-LEDGER, WP-SESSION).
    pub accounting: AccountingDeps,
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
    pub run_stamps: Arc<dyn RunStamps>,
    /// The agent definitions the contact-bot rule reads.
    pub agents: Arc<AgentDefinitions>,
    pub allow_all: Arc<dyn AllowAllActions>,
    /// The MCP hub, for the connector account of a call.
    pub hub: Arc<McpHub>,
    pub blobs: Arc<dyn Blobs + Send + Sync>,
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
    pub goals: GoalRuntime,
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
    /// The session side of compaction (summary routes, fork source, media meters, cache tail); SessionCompactors is built
    /// over it (WP-COMPACTION-WORLD).
    pub compaction: CompactionServices,
    /// The route hop, built over the directory and the path's registry.
    pub hops: Box<dyn FnOnce(&Arc<SessionDirectory>, &Arc<ProviderRegistry>) -> HopFactory>,
}

#[derive(Debug, thiserror::Error)]
pub enum TurnPathError {
    #[error("no `Skill` tool is registered")]
    NoSkillTool,
    #[error("starting the providers: {0}")]
    Providers(String),
}

pub struct TurnPath {
    /// The real `ThreadDirectory` for the core.
    pub directory: Arc<SessionDirectory>,
    /// The table `ports::reactions::SessionReactions` records into.
    pub reaction_targets: Arc<ReactionTargets>,
    pub registry: Arc<ProviderRegistry>,
    /// `markUnattendedRun`: schedule and webhook runs mark themselves here for the length of a run.
    pub unattended: Arc<UnattendedRunRegistry>,
    /// The contact-bot snapshot; call `refresh().await` at start and when the agents change.
    pub contacts: Arc<ContactIds>,
}

impl TurnPath {
    pub fn new(parts: TurnPathParts) -> Result<Self, TurnPathError> {
        let TurnPathParts {
            tokens, clock, paths, provider_builder, accounting, effort_judge, side, next, files, processes, policy, connectors, resolver, run_stamps, agents, allow_all, hub, blobs, tool_pool, mcp,
            skills_listed, skill_names, ext_pool, hook_bus, hook_common, goals, todos, work, cycles, config, settings, ladder, deps, compaction, hops,
        } = parts;
        let io = ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io };
        let registry = Arc::new(ProviderRegistry::new(provider_builder).with_accounting(accounting));
        let skill_tool = tool_pool.iter().find(|t| t.spec().name == "Skill").cloned().ok_or(TurnPathError::NoSkillTool)?;
        let reaction_targets: Arc<ReactionTargets> = Arc::default();
        let unattended = UnattendedRunRegistry::new(run_stamps);
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
            blobs,
            reaction_targets: reaction_targets.clone(),
            effort_judge: Some(effort_judge),
            side,
            next,
            settings,
            seams: SeamParts {
                tools: SessionToolBuilder::new(tool_pool, mcp, skills_listed),
                todos: TodoViews::new(todos, Arc::new(goals), work, cycles),
                post_tool: Arc::new(BusPostToolDispatch::new(hook_bus, hook_common)),
                skills: Some(SkillParts { names: skill_names, tool: skill_tool }),
                config,
                ladder,
                images: Some(Arc::new(ToolImageCompactor::new(Arc::new(ExtImageCodec::new(ext_pool))))),
                paths,
            },
            probes: Arc::new(StartupProbes::new(io, processes)),
            observed: Arc::new(StartupObservations::new(clock)),
        };
        let compactors = Arc::new(SessionCompactors::new(Arc::new(ProcessCompactionWorld::new(compaction)), host.clock.clone()));
        let directory = build_directory(host, deps, move |directory, registry| DirectoryParts { hops: Arc::new(hops(directory, registry)), compactors });
        Ok(Self { directory, reaction_targets, registry, unattended, contacts })
    }
}