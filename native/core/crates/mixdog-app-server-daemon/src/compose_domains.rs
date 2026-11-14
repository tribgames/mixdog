//! The daemon's domain services (compose-seams.md §A rows `import`, `localProvider`, `media`,
//! `tidy`, `voice`, `config`, `plugins`, `system`, `blob`, `client`, `diagnostics`, `feedback`,
//! `host`, `instructions`, `update`, `browser`, `visualize`, and the `StatePublisher`).
//!
//! [`compose_domains`] builds every one of them from [`DomainInputs`] and returns them for
//! registration in [`ComposedDomains`]; `compose.rs` registers `services`, passes
//! `transfer_sources` to `mixdog_workspace::service::Deps.sources`, and hands
//! `state.publisher` to everything else that publishes. What belongs to another owner's
//! service arrives through [`DomainSeams`], one named field per owed trait.

mod adapters;
mod export;
mod local;
mod local_setup;
mod rows;
#[cfg(test)]
mod tests;

use std::path::PathBuf;
use std::sync::Arc;

use mixdog_ai::catalog::CatalogService;
use mixdog_ai::netproxy::NetworkProxy;
use mixdog_ai::netproxy::clients::RoutedClients;
use mixdog_ai::netproxy::system::SystemProxy;
use mixdog_ai::service::network_proxy::NetworkProxyService;
use mixdog_core_agents::setup::DomainSettings;
use mixdog_core_agents::setup::FeatureActivity;
use mixdog_core_agents::setup::FeatureStatus;
use mixdog_core_agents::setup::QuotaAutoResume;
use mixdog_core_agents::setup::ConfigStatus;
use mixdog_core_agents::setup::SettingsSetup;
use mixdog_core_agents::setup::StatusReader;
use mixdog_core_agents::setup::ModelStatus;
use mixdog_core_agents::setup::SummaryStatus;
use mixdog_core_agents::setup::WorkflowStatus;
use mixdog_core_agents::setup::SetupRequests;
use mixdog_core_agents::setup::SetupRequestsService;
use mixdog_core_agents::setup::SetupUiSurface;
use mixdog_app_protocol::limits::Limits;
use mixdog_core_domains::domains::diagnostics::DiagnosticsService;
use mixdog_core_domains::domains::diagnostics::DoctorConfig;
use mixdog_core_domains::domains::host::NotificationClicks;
use mixdog_core_domains::domains::instructions::InstructionsChanged;
use mixdog_core_ports::ports::domain_sessions::SessionAttachments;
use mixdog_core_ports::ports::setup_actions::SetupActions;
use mixdog_remote::access::RemoteRuntime;
use mixdog_remote::bridge::Dialer;
use mixdog_services::bots::beat::UserActivity;
use mixdog_core_api::DomainService;
use mixdog_core_api::HostChannel;
use mixdog_core_api::feed::ScopedFeeds;
use mixdog_core_api::feed::Feed;
use mixdog_core_base::ops::OpGate;
use mixdog_core_base::ops::ThreadOpGates;
use mixdog_core_base::state::StateRuntime;
use mixdog_core_base::support::OpScopes;
use mixdog_core_config::config::Config;
use mixdog_core_config::config::ConfigService;
use mixdog_core_config::config::ConfigWatcher;
use mixdog_core_config::config::OutputStyles;
use mixdog_core_config::config::Settings;
use mixdog_core_config::config::SettingsEffects;
use mixdog_core_config::tool_modules::FeatureEffects;
use mixdog_core_config::tool_modules::ToolModules;
use mixdog_exthost::BrowserService;
use mixdog_exthost::ExtHostPool;
use mixdog_exthost::VisualizeService;
use mixdog_rt::LaneTokens;
use mixdog_services::tidy::process::Processes;
use mixdog_workspace::transfer::TransferSource;
use tokio_util::sync::CancellationToken;

use adapters::ServiceDoctor;
use adapters::UpdateCell;
use adapters::WorkflowGetters;
use adapters::RosterAccounts;
use adapters::UpdateSetup;
use mixdog_core_agents::setup::MediaDefaultSetup;
use mixdog_core_domains::domains::ai_admin::provider_status::ProviderRoster;
use local_setup::LocalSetup;
pub use export::{HeaderCwds, SessionCwds};
use export::HostExportRenderer;
use mixdog_agent::compact::settings_service::CompactionHost;
use mixdog_agent::compact::settings_service::CompactionSettingsService;
use mixdog_core_config::workflow::WorkflowConfig;
use mixdog_core_config::workflow::WorkflowHost;
use mixdog_core_config::workflow::WorkflowPaths;
use mixdog_core_domains::domains::visualize_export::ExportSource;
pub use adapters::ConfigExtensions;
use mixdog_mcp::declaration_cache::DeclarationCache;
use mixdog_mcp::extension_service::ExtensionHost;
use mixdog_mcp::extension_service::PluginsService;
use mixdog_mcp::plugin_admin::GitRunner;
use mixdog_mcp::plugin_admin::PluginAdmin;
pub use adapters::DoctorHost;
pub use adapters::LateDomains;
pub(crate) use adapters::internal_request;
pub use adapters::ServiceMcpStatus;
pub use local::LocalSeams;
pub use local::VoiceToggle;
pub use local::build_local_provider;
/// `package.json` `version` of the install: the build version the providers send as the client version.
pub(crate) use rows::package_version;

/// The op scopes this file's services take a gate for. `compose.rs` builds one gate per scope
/// and passes them in [`OpScopeSource`]; `OP_SCOPES` there must list every name here.
pub const OP_SCOPES: [&str; 6] = ["config", "update", "diagnostics", "feedback", "instructions", "workflow"];

/// How the process environment is read (`process.env[name]`).
pub type EnvReader = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

#[derive(Debug, thiserror::Error)]
pub enum ComposeDomainsError {
    #[error("watching mixdog-config.json: {0}")]
    Watch(mixdog_core_config::config::ConfigError),
    #[error("the op gate of `{0}` was not passed")]
    OpScope(&'static str),
    #[error("{0}")]
    Build(String),
}

/// The op gate of each scope in [`OP_SCOPES`] plus the thread directory's gates.
pub struct OpScopeSource {
    gates: Vec<(&'static str, OpGate)>,
    threads: Arc<dyn ThreadOpGates>,
}

impl OpScopeSource {
    pub fn new(gates: Vec<(&'static str, OpGate)>, threads: Arc<dyn ThreadOpGates>) -> Self {
        Self { gates, threads }
    }

    pub(crate) fn scopes(&self, scope: &'static str) -> Result<OpScopes, ComposeDomainsError> {
        let gate = self.gates.iter().find(|(name, _)| *name == scope).ok_or(ComposeDomainsError::OpScope(scope))?;
        Ok(OpScopes::new(gate.1.clone(), self.threads.clone()))
    }
}

/// Where the install and the data live.
pub struct DomainPaths {
    pub data_dir: PathBuf,
    /// The desktop profile folder.
    pub user_data_dir: PathBuf,
    /// The package root: the shipped `orchestration/`, `output-styles/`, `workflows/` and `agents/` are under its `src/` (`mixdogRoot()`).
    pub package_root: PathBuf,
    /// The JS interpreter of the install (`JsRuntime::program`) and whether it is the app binary
    /// in node mode: what runs the staged update's `npm`.
    pub node: PathBuf,
    pub electron: bool,
}

/// Traits the other owners' services implement; each field says whose.
pub struct DomainSeams {
    /// `SettingsEffects` (cache warming, system shell, developer options): provider registry
    /// (WP-AI-SVC) and session layer (WP-SESSION).
    pub settings_effects: Arc<dyn SettingsEffects>,
    /// `FeatureEffects` (office fonts, local provider registry, session caches): WP-AI-SVC, WP-SESSION.
    pub feature_effects: Arc<dyn FeatureEffects>,
    pub local: LocalSeams,
    /// The heartbeat's `UserActivity` (`noteUserInput`): WP-CHANNELS.
    pub user_activity: Arc<UserActivity>,
    /// The remote runtime (host/power suspend/resume, the bridge target): WP-REMOTE.
    pub remote: Arc<RemoteRuntime>,
    /// The bridge target that serves phones from this core (LocalDialer over the connection hub).
    pub local_target: Arc<dyn Dialer>,
    /// Routes a click on a desktop toast: WP-NOTIFY-ROOMS (`notify`).
    pub notification_clicks: Arc<dyn NotificationClicks>,
    /// Publishes the host's browser surface requests as `ui/openRequested` (`host/browser/surface`).
    pub browser_surfaces: Arc<dyn mixdog_core_domains::domains::host::BrowserSurfaces>,
    /// What the desktop reports about this PC's screen (`host/screen/displaysChanged`, `host/screen/indicator/stop`): the phone's screen sessions (`compose_screen`).
    pub screen_events: Arc<dyn mixdog_core_domains::domains::host::ScreenEvents>,
    /// The visualize tabs the desktop sets (`host/state/set`), folded for the phone's pane pages (`document/previewPages`).
    pub visualize_panes: Arc<mixdog_exthost::VisualizePanes>,
    /// Drops the prompt-rules and context-status caches and publishes the profile change: WP-SESSION.
    pub instructions_changed: Arc<dyn InstructionsChanged>,
    /// The one OS proxy decision of the process: WP-AI-SVC.
    pub system_proxy: Arc<SystemProxy>,
    pub plugins: PluginSeams,
    /// Tells the session whose setup request it is that a desktop surface should claim it
    /// (`notifySessionUi`): WP-SESSION.
    pub setup_ui: Arc<dyn SetupUiSurface>,
    /// The process's one network-proxy policy and the routed clients that follow it: WP-AI-SVC.
    pub network_proxy: Arc<NetworkProxy>,
    pub routed_clients: Arc<RoutedClients>,
    /// The live route and session side of the compaction and auto-clear settings: WP-SESSION.
    /// The project folder of a session, for the device export (`SessionDirectory`'s stored header `cwd`).
    pub session_cwds: Arc<dyn SessionCwds>,
    pub compaction_host: Arc<dyn CompactionHost>,
    /// The live route, provider registry and session facts of the workflow, orchestration-mode,
    /// web-search-route, model-preference and onboarding methods: WP-SESSION, WP-AI-SVC.
    pub workflow_host: Arc<dyn WorkflowHost>,
    /// The pending quota resumes (quota-resume.json): the setup action set_quota_auto_resume drops them when it turns the switch off.
    pub quota_resume: Arc<mixdog_core_base::quota_resume::QuotaResumeStore>,
    /// Whether the desktop's browser, computer and terminal bridges are up (the MIXDOG_FEATURE_* overrides first, then the bridge
    /// discovery files) for a tool the core registered: the same fact the skill gate reads. The `features` status prints it.
    pub feature_activity: Arc<dyn FeatureActivity>,
    /// The live Lead route (provider, model, effort, fast, model parameters, context limits): the session's fact, printed
    /// by the `summary` status.
    pub live_route: Arc<dyn mixdog_core_agents::setup::LiveRoute>,
    /// The OAuth account roster (`ProviderRoster`, implemented by `ProviderAdmin`): the setup action set_media_default checks an
    /// account id against it. WP-AI-ADMIN.
    pub provider_roster: Arc<dyn ProviderRoster>,
}

/// The seams of the post-directory stage: both read the session directory, which is built from the
/// tool pool, which needs the pre-pool stage's services. See [`compose_domains_post`].
pub struct PostSeams {
    /// DesktopAttachmentHost over the session directory and the blob store: WP-SESSION.
    pub session_attachments: Arc<dyn SessionAttachments>,
    /// The doctor's statuses no domain answers: WP-SESSION (provider, notice), WP-CHANNELS
    /// (worker, setup), WP-MCP (hooks), WP-MIGRATE (session log), WP-INSTALL (JS runtime).
    pub doctor: Arc<dyn DoctorHost>,
    /// `DirectoryImportSessions` over the session directory (WP-SESSION): the import service is built in this stage, after the
    /// directory, so it is plain build order (it reads nothing the pool needs, and the pool reads nothing of it).
    pub import_sessions: Arc<dyn mixdog_services::import::ImportSessions>,
}

/// What `PluginsService` runs on that no crate implements yet.
pub struct PluginSeams {
    /// Reconnects MCP servers and announces to the other runtimes (WP-MCP over the `McpHub`; its
    /// `flush_skills_save` calls `ComposedDomains::extensions.flush_skills_save()`).
    pub host: Arc<dyn ExtensionHost>,
    /// Runs `git` for a plugin clone or update (WP-MCP: the trait is synchronous, the spawn rules
    /// make the process manager's `ExecSpec` the only runner).
    pub git: Arc<dyn GitRunner>,
    /// `announceStoredStateChange('plugins')`: tells the other processes the registry changed.
    pub announce: Arc<dyn Fn() + Send + Sync>,
}

pub struct DomainInputs {
    pub tokens: LaneTokens,
    /// The stored-secret change marker the daemon's other parts share: the config watch follows it, so another process saving or
    /// forgetting a key reaches this one (`ensureConfigWatcher` watches the marker beside the file).
    pub secrets: Arc<mixdog_core_config::config::SecretChanges>,
    pub paths: DomainPaths,
    /// The raw `voice-runtime-manifest.json`, read once by the root: the voice service parses it here and the voice installer
    /// (`InstallerParts.manifest`, built before this stage as a `LocalSeams` input) takes the same value.
    pub voice_manifest: serde_json::Value,
    pub env: EnvReader,
    /// The app feed (`ComposedCore::app_feed_core`): the `state` runtime publishes to it.
    pub app_feed: Arc<dyn Feed>,
    /// Opened by compose before this call (`StateRuntime::new(app_feed)`): `settings_effects`,
    /// `feature_effects` and `ConfigHosts` need it first. Its publisher is `config`'s.
    pub state: Arc<StateRuntime>,
    /// `Config::open(<data_dir>/mixdog-config.json, state.publisher, ConfigLanes)` on `interactive_io` / `durability_io`, opened by compose.
    pub config: Config,
    pub scoped_feeds: Arc<dyn ScopedFeeds>,
    pub host: Arc<dyn HostChannel>,
    pub ext_host: Arc<ExtHostPool>,
    /// `ComposedCore::tidy_processes()`: the one process manager of Tidy and the local provider.
    pub processes: Processes,
    pub catalog: Arc<CatalogService>,
    pub models: crate::compose::Models,
    pub scopes: OpScopeSource,
    /// The core's wire limits (lob/* page sizes).
    pub limits: Limits,
    /// Stops what the config services started (downloads, ticks).
    pub cancel: CancellationToken,
    /// The process's one local provider, built before `ProcessServices` by [`build_local_provider`];
    /// the local-provider service and the tool-modules host hold it.
    pub local_provider: Arc<mixdog_services::local_provider::LocalProvider>,
    pub seams: DomainSeams,
}

pub struct ComposedDomains {
    /// Register each with `DomainsBuilder::register`.
    pub services: Vec<Arc<dyn DomainService>>,
    /// `mixdog_workspace::service::Deps.sources`.
    pub transfer_sources: Vec<Arc<dyn TransferSource>>,
    /// The one `StatePublisher` (`state.publisher`), the scoped-route table and the app sections.
    pub state: Arc<StateRuntime>,
    pub config: Config,
    pub tool_modules: Arc<ToolModules>,
    /// Hold for the daemon's lifetime: the config file's external-edit watch.
    pub watcher: ConfigWatcher,
    /// Bind the built `Domains` once registered: the doctor reads its statuses through it.
    pub late: Arc<LateDomains>,
    /// Call connection_closed(id) when a connection closes.
    pub system: Arc<mixdog_spawn::service::SystemService>,
    /// The agent config as the extension services read it; the `ExtensionHost` flushes it.
    pub extensions: Arc<ConfigExtensions>,
    /// The broker the setup tool's desktop requests go through (`SetupRuntime` shares it).
    pub setup_requests: Arc<SetupRequests>,
}

/// What the pool-side services need, built before the tool pool and the session directory:
/// `mcp_services` takes `tool_modules`, `extensions`, `plugins`, `workflow` and `setup_requests`.
pub struct PreDomains {
    pub services: Vec<Arc<dyn DomainService>>,
    pub transfer_sources: Vec<Arc<dyn TransferSource>>,
    pub state: Arc<StateRuntime>,
    pub config: Config,
    pub tool_modules: Arc<ToolModules>,
    pub watcher: ConfigWatcher,
    pub late: Arc<LateDomains>,
    pub extensions: Arc<ConfigExtensions>,
    pub setup_requests: Arc<SetupRequests>,
    /// The `PluginsService` also in `services`.
    pub plugins: Arc<dyn DomainService>,
    /// The `WorkflowConfig` also in `services` (`config/getWorkflowPack`).
    pub workflow: Arc<dyn DomainService>,
    /// The same `WorkflowConfig`, concrete: `thread/setWorkflow` and its siblings (`ThreadSettings`) read its packs and config.
    pub workflow_config: Arc<WorkflowConfig>,
    /// The output styles `ConfigService` serves (a clone shares its state): `thread/setOutputStyle` writes through them.
    pub output_styles: OutputStyles,
    /// The voice setup the voice service holds: the root passes `VoiceToggle(voice_setup)` as the setup tool's `SetupVoice`.
    pub voice_setup: Arc<mixdog_services::voice::VoiceSetup>,
    /// The media domain's job table and store, for the `media` tool's `StudioGraph` (one table, one store).
    pub media_jobs: Arc<mixdog_services::media::MediaJobs>,
    pub media_store: Arc<mixdog_services::media::MediaStore>,
    /// The setup actions this composition serves (local models, the domain-backed settings, the
    /// scalar settings): register each with SetupService::with_actions in the MCP stage.
    pub setup_actions: Vec<Arc<dyn SetupActions>>,
    /// The `status` readers this composition serves (the config-backed domains): register each with
    /// SetupService::with_status in the MCP stage.
    pub status_readers: Vec<Arc<dyn StatusReader>>,
    /// Bound to the update service by compose_domains_post; set_auto_update answers its settings.
    update_cell: Arc<UpdateCell>,
}

/// Stage one: every service that needs nothing of the session directory. Build order of the
/// composition is local provider, process services, registry, readiness, effects, this stage, the
/// MCP services, the tool pool, the turn path (which builds the directory), then [`compose_domains_post`].
pub async fn compose_domains_pre(inputs: &DomainInputs) -> Result<PreDomains, ComposeDomainsError> {
    let mut services: Vec<Arc<dyn DomainService>> = Vec::new();
    let (state, config) = (inputs.state.clone(), inputs.config.clone());
    // Node's `settings-changed` and `provider-models-changed` desktop events: app-feed notifications, in order with the
    // sections they follow.
    let app = state.app.clone();
    config.announce_to(Arc::new(move |method, params| app.notify(method, &params)));
    let watcher = ConfigWatcher::start_with_secrets(config.clone(), inputs.secrets.clone()).map_err(ComposeDomainsError::Watch)?;
    let local = local::build(inputs, &config).await?;
    let tool_modules = ToolModules::new(config.clone(), local.tool_modules_host.clone(), state.publisher.clone(), inputs.cancel.clone());
    let settings = Settings::new(config.clone(), inputs.seams.settings_effects.clone(), inputs.env.clone()).with_data_dir(inputs.paths.data_dir.clone());
    let output_styles = OutputStyles::new(config.clone(), inputs.paths.package_root.join("src").join("output-styles"), &inputs.paths.data_dir);
    services.push(Arc::new(ConfigService::new(config.clone(), tool_modules.clone(), settings.clone(), output_styles.clone())));
    services.extend(local.services);
    let setup_requests = Arc::new(SetupRequests::new(inputs.seams.setup_ui.clone()));
    services.push(Arc::new(SetupRequestsService::new(setup_requests.clone())));
    services.push(Arc::new(NetworkProxyService::new(
        Arc::new(config.clone()),
        inputs.seams.network_proxy.clone(),
        inputs.seams.routed_clients.clone(),
    )));
    let mut transfer_sources = local.transfer_sources;
    transfer_sources.push(ExportSource::new(HostExportRenderer::new(inputs.host.clone(), inputs.seams.session_cwds.clone()), &inputs.tokens));
    services.push(Arc::new(CompactionSettingsService::new(Arc::new(config.clone()), inputs.seams.compaction_host.clone())));
    let workflow_config = WorkflowConfig::new(
        config.clone(),
        WorkflowPaths { root: inputs.paths.package_root.join("src"), data: inputs.paths.data_dir.clone() },
        inputs.seams.workflow_host.clone(),
        inputs.scopes.scopes("workflow")?,
        &inputs.tokens,
    );
    let workflow_config_concrete = workflow_config.clone();
    // `presets`, `webSearch` and `workflows`: the pushed form of `listPresets`, `getWebSearchRoute` and `listWorkflows`.
    mixdog_core_config::workflow::sections::spawn_sections(workflow_config.clone(), state.publisher.clone(), inputs.cancel.clone())
        .map_err(|error| ComposeDomainsError::Watch(mixdog_core_config::config::ConfigError::Io(std::io::Error::other(error.to_string()))))?;
    let workflow: Arc<dyn DomainService> = workflow_config.clone();
    services.push(workflow.clone());
    services.push(Arc::new(BrowserService::new(inputs.host.clone())));
    services.push(Arc::new(VisualizeService::new(inputs.host.clone())));
    let extensions = Arc::new(ConfigExtensions::new(config.clone()));
    let plugins: Arc<dyn DomainService> = Arc::new(PluginsService::new(
        Arc::new(PluginAdmin::new(inputs.paths.data_dir.clone(), inputs.seams.plugins.git.clone(), inputs.seams.plugins.announce.clone())),
        Arc::new(DeclarationCache::new()),
        extensions.clone(),
        inputs.seams.plugins.host.clone(),
        inputs.tokens.maintenance_io,
    ));
    services.push(plugins.clone());
    let late = Arc::new(LateDomains::default());
    let update_cell = Arc::new(UpdateCell::default());
    let setup_actions: Vec<Arc<dyn SetupActions>> = vec![
        LocalSetup::new(local.service),
        Arc::new(DomainSettings::new(late.clone())),
        Arc::new(MediaDefaultSetup::new(late.clone(), Arc::new(RosterAccounts(inputs.seams.provider_roster.clone())))),
        Arc::new(SettingsSetup::new(
            settings.clone(),
            UpdateSetup::new(settings.clone(), update_cell.clone()),
            QuotaAutoResume::new(config.clone(), inputs.seams.quota_resume.clone()),
        )),
    ];
    let features = Arc::new(FeatureStatus::new(late.clone(), settings, inputs.seams.feature_activity.clone()));
    let status_readers: Vec<Arc<dyn StatusReader>> = vec![
        Arc::new(ConfigStatus::new(late.clone())),
        Arc::new(WorkflowStatus::new(Arc::new(WorkflowGetters(workflow_config.clone())), late.clone())),
        features.clone(),
        Arc::new(SummaryStatus::new(late.clone(), Arc::new(WorkflowGetters(workflow_config)), features, inputs.seams.live_route.clone())),
        Arc::new(ModelStatus::new(inputs.seams.live_route.clone())),
        local.media_status,
    ];
    Ok(PreDomains {
        services,
        transfer_sources,
        state,
        config,
        tool_modules,
        watcher,
        late,
        extensions,
        setup_requests,
        plugins,
        workflow,
        workflow_config: workflow_config_concrete,
        output_styles,
        voice_setup: local.voice_setup,
        media_jobs: local.media_jobs,
        media_store: local.media_store,
        setup_actions,
        status_readers,
        update_cell,
    })
}

/// Stage two, after `TurnPath::new` has built the directory: the services that read it
/// (`session_attachments`, the doctor's live surface) and the ones that need nothing from the pool
/// but were built after it in Node's order (client, host, instructions, feedback, blob, update,
/// system, diagnostics).
pub async fn compose_domains_post(inputs: &DomainInputs, post: PostSeams, pre: PreDomains) -> Result<ComposedDomains, ComposeDomainsError> {
    let PreDomains { mut services, mut transfer_sources, state, config, tool_modules, watcher, late, extensions, setup_requests, update_cell, .. } = pre;
    let rows = rows::build(inputs, &config, state.publisher.clone(), tool_modules.clone(), post.session_attachments).await?;
    update_cell.bind(rows.update.clone());
    // Node starts its self-update controller's boot check with the runtime (`wireSelfUpdate`).
    let _ = rows.update.start_boot_check();
    services.extend(rows.services);
    transfer_sources.extend(rows.transfer_sources);
    // `import/*`: built over the session layer's side of an import, which exists only now.
    let discovery = mixdog_services::import::Discovery::new(mixdog_services::import::Env::from_process(), inputs.tokens.maintenance_io);
    let jobs = mixdog_services::import::ImportJobs::new(discovery.clone(), post.import_sessions, mixdog_services::import::Limits::default());
    services.push(Arc::new(mixdog_services::import::ImportService::new(discovery, jobs, mixdog_services::import::Limits::default())));
    services.push(DiagnosticsService::new(
        Arc::new(ServiceDoctor::new(late.clone(), post.doctor)),
        DoctorConfig {
            data_dir: inputs.paths.data_dir.clone(),
            package_version: Some(rows.package_version.clone()),
            check_timeout: DoctorConfig::CHECK_TIMEOUT,
        },
        inputs.scopes.scopes("diagnostics")?,
        &inputs.tokens,
    ));
    Ok(ComposedDomains {
        services,
        transfer_sources,
        state,
        config,
        tool_modules,
        watcher,
        late,
        system: rows.system,
        extensions,
        setup_requests,
    })
}
