//! The composition of the turn path: the run factory over the host services, bound to the session
//! directory that owns it. The directory's own dependencies (`SessionDeps`: store, codec, feeds,
//! transcript, goals, review, ...) are WP-SESSION's rows and arrive as a closure over the run factory,
//! because the directory owns the factory that owns the services that read the directory.

use std::sync::{Arc, Weak};

use mixdog_agent::env::Clock;
use mixdog_ai::registry::providers::ProviderRegistry;
use mixdog_core_api::domain::fs::FileService;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::tool::ToolIo;
use mixdog_protocol::message_class::user_text::Blobs;
use mixdog_services::effort_judge::judge::EffortJudgeModel;
use mixdog_tools::policy::{ConnectorPermissions, ToolPolicy, ToolResolver};

use super::assemble::{HostRunParts, HostServices};
use super::factory::RunHostFactory;
use super::host_seams::{DirectoryParts, HostSeams, SeamParts};
use super::settings::SettingsSources;
use super::prewarm::StartupProbes;
use super::reactions::ReactionTargets;
use mixdog_core_ports::ports::gate::GateEnv;
use mixdog_core_prompt::prompt::probes::StartupObservations;
use mixdog_core_session::session::RunFactory;
use mixdog_core_session::session::SessionDeps;
use mixdog_core_session::session::SessionDirectory;

/// What the turn assembly is made of; `HostServices` less the directory it is bound to.
pub struct HostParts {
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
    /// The one table the react tool (`SessionReactions`) records into.
    pub reaction_targets: Arc<ReactionTargets>,
    pub effort_judge: Option<Arc<EffortJudgeModel>>,
    pub side: super::side_requests::SideRequests,
    /// The source of a thread's next request, bound to the directory and the assembly here.
    pub next: Arc<super::next_request_source::NextRequestSource>,
    pub seams: SeamParts,
    pub settings: SettingsSources,
    pub probes: Arc<StartupProbes>,
    pub observed: Arc<StartupObservations>,
    /// The runtime's shell control, which the progress watchdog's stop reaps the turn's shells through.
    pub shells: Option<Arc<mixdog_tools::exec::ShellControl>>,
}

/// The session directory over `deps`, whose `runs` is the real run factory.
pub fn build_directory(host: HostParts, deps: impl FnOnce(Arc<dyn RunFactory>) -> SessionDeps, late: impl FnOnce(&Arc<SessionDirectory>, &Arc<ProviderRegistry>) -> DirectoryParts) -> Arc<SessionDirectory> {
    let mut bound = None;
    let registry = host.registry.clone();
    let directory = Arc::new_cyclic(|directory: &Weak<SessionDirectory>| {
        let HostParts { registry, clock, files, processes, io, policy, connectors, resolver, gate_env, blobs, reaction_targets, effort_judge, side, next, seams, settings, probes, observed, shells } = host;
        let services = HostServices {
            registry,
            clock,
            files,
            processes,
            io,
            policy,
            connectors,
            resolver,
            gate_env,
            blobs,
            reaction_targets,
            directory: directory.clone(),
            effort_judge,
            side,
            seams: bound.insert(Arc::new(HostSeams::new(seams))).clone(),
            settings,
            probes,
            observed,
            shells,
        };
        let parts = Arc::new(HostRunParts::new(services));
        next.bind(directory.clone(), parts.clone());
        let runs: Arc<dyn RunFactory> = Arc::new(RunHostFactory::new(parts));
        SessionDirectory::new(Arc::new(deps(runs)))
    });
    if let Some(seams) = bound {
        // Bound exactly once, here.
        let _ = seams.bind(late(&directory, &registry));
    }
    directory
}
