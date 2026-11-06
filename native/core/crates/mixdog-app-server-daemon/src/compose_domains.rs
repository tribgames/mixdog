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
use mixdog_core_agents::setup::SetupRequests;
use mixdog_core_agents::setup::SetupRequestsService;
use mixdog_core_agents::setup::SetupUiSurface;
use mixdog_app_protocol::limits::Limits;
use mixdog_core_domains::domains::diagnostics::DiagnosticsService;
use mixdog_core_domains::domains::diagnostics::DoctorConfig;
use mixdog_core_domains::domains::host::NotificationClicks;
use mixdog_core_domains::domains::instructions::InstructionsChanged;
use mixdog_core_ports::ports::domain_sessions::SessionAttachments;
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
pub use local::LocalSeams;

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
    /// The package root: shipped `orchestration/`, `output-styles/`, `agents/`.
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
    /// Drops the prompt-rules and context-status caches and publishes the profile change: WP-SESSION.
    pub instructions_changed: Arc<dyn InstructionsChanged>,
    /// SessionAttachmentLinks over the session directory: WP-SESSION.
    pub session_attachments: Arc<dyn SessionAttachments>,
    /// The one OS proxy decision of the process: WP-AI-SVC.
    pub system_proxy: Arc<SystemProxy>,
    /// The doctor's statuses no domain answers: WP-SESSION (provider, notice), WP-CHANNELS
    /// (worker, setup), WP-MCP (hooks), WP-MIGRATE (session log), WP-INSTALL (JS runtime).
    pub doctor: Arc<dyn DoctorHost>,
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
    pub paths: DomainPaths,
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
    /// The one local provider (`ProcessInputs.local_provider`).
    pub local_provider: Arc<mixdog_services::local_provider::LocalProvider>,
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

pub async fn compose_domains(inputs: DomainInputs) -> Result<ComposedDomains, ComposeDomainsError> {
    let mut services: Vec<Arc<dyn DomainService>> = Vec::new();
    let (state, config) = (inputs.state.clone(), inputs.config.clone());
    let watcher = ConfigWatcher::start(config.clone()).map_err(ComposeDomainsError::Watch)?;
    let local = local::build(&inputs, &config).await?;
    let tool_modules = ToolModules::new(config.clone(), local.tool_modules_host.clone(), state.publisher.clone(), inputs.cancel.clone());
    let settings = Settings::new(config.clone(), inputs.seams.settings_effects.clone(), inputs.env.clone());
    let output_styles = OutputStyles::new(config.clone(), inputs.paths.package_root.join("output-styles"), &inputs.paths.data_dir);
    services.push(Arc::new(ConfigService::new(config.clone(), tool_modules.clone(), settings, output_styles)));
    services.extend(local.services);
    let setup_requests = Arc::new(SetupRequests::new(inputs.seams.setup_ui.clone()));
    services.push(Arc::new(SetupRequestsService::new(setup_requests.clone())));
    services.push(Arc::new(NetworkProxyService::new(
        Arc::new(config.clone()),
        inputs.seams.network_proxy.clone(),
        inputs.seams.routed_clients.clone(),
    )));
    let rows = rows::build(&inputs, &config, state.publisher.clone(), tool_modules.clone()).await?;
    services.extend(rows.services);
    let mut transfer_sources = local.transfer_sources;
    transfer_sources.extend(rows.transfer_sources);
    transfer_sources.push(ExportSource::new(HostExportRenderer::new(inputs.host.clone(), inputs.seams.session_cwds.clone()), &inputs.tokens));
    services.push(Arc::new(CompactionSettingsService::new(Arc::new(config.clone()), inputs.seams.compaction_host.clone())));
    services.push(WorkflowConfig::new(
        config.clone(),
        WorkflowPaths { root: inputs.paths.package_root.clone(), data: inputs.paths.data_dir.clone() },
        inputs.seams.workflow_host.clone(),
        inputs.scopes.scopes("workflow")?,
        &inputs.tokens,
    ));
    services.push(Arc::new(BrowserService::new(inputs.host.clone())));
    services.push(Arc::new(VisualizeService::new(inputs.host.clone())));
    let extensions = Arc::new(ConfigExtensions::new(config.clone()));
    services.push(Arc::new(PluginsService::new(
        Arc::new(PluginAdmin::new(inputs.paths.data_dir.clone(), inputs.seams.plugins.git.clone(), inputs.seams.plugins.announce.clone())),
        Arc::new(DeclarationCache::new()),
        extensions.clone(),
        inputs.seams.plugins.host.clone(),
        inputs.tokens.maintenance_io,
    )));
    let late = Arc::new(LateDomains::default());
    services.push(DiagnosticsService::new(
        Arc::new(ServiceDoctor::new(late.clone(), inputs.seams.doctor.clone())),
        DoctorConfig {
            data_dir: inputs.paths.data_dir.clone(),
            package_version: Some(rows.package_version.clone()),
            check_timeout: DoctorConfig::CHECK_TIMEOUT,
        },
        inputs.scopes.scopes("diagnostics")?,
        &inputs.tokens,
    ));
    Ok(ComposedDomains { services, transfer_sources, state, config, local_provider: local.provider, tool_modules, watcher, late, system: rows.system, extensions, setup_requests })
}
