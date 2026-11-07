//! Adapters between the services this composition builds and the traits they take.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;

use async_trait::async_trait;
use mixdog_ai::catalog::CatalogService;
use mixdog_core_api::CallContext;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::Method;
use mixdog_core_base::support::failed;
use mixdog_core_config::config::Config;
use mixdog_core_config::config::LocalCatalogRefresh;
use mixdog_mcp::extension_service::ExtensionConfig;
use serde_json::Map;
use mixdog_app_protocol::v2::host::PowerEvent;
use mixdog_core_domains::domains::Domains;
use mixdog_core_domains::domains::client::AppInputSink;
use mixdog_core_domains::domains::host::PowerSink;
use mixdog_core_domains::domains::host::RemoteBridge;
use mixdog_core_domains::domains::host::RemoteTarget;
use mixdog_remote::access::RemoteRuntime;
use mixdog_remote::bridge::Dialer;
use mixdog_remote::bridge::ws::WsDialer;
use mixdog_rt::TaskClass;
use mixdog_services::bots::beat::UserActivity;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_domains::domains::diagnostics::DoctorSources;
use mixdog_core_domains::domains::diagnostics::Probe;
use mixdog_core_domains::domains::diagnostics::ProbeFailed;
use serde_json::Value;
use serde_json::json;
use mixdog_core_agents::setup::DomainCalls;
use mixdog_core_agents::setup::ProviderAccounts;
use mixdog_core_domains::domains::ai_admin::provider_status::ProviderRoster;
use mixdog_core_agents::setup::WorkflowFacts;
use mixdog_core_config::workflow::WorkflowConfig;
use mixdog_core_agents::setup::UpdateSettings;
use mixdog_core_config::config::Settings;
use mixdog_core_domains::domains::update::UpdateService;
use mixdog_tools::orch::util::PortError;

/// `getProviderAccounts(provider)` of the setup tool: the provider admin's roster read.
pub(super) struct RosterAccounts(pub(super) Arc<dyn ProviderRoster>);

#[async_trait]
impl ProviderAccounts for RosterAccounts {
    async fn accounts(&self, provider: &str) -> Result<Value, String> {
        self.0.accounts(provider).await
    }
}

/// `refreshLocalProviderCatalog`: the installed local models are listed by the model catalog.
pub(super) struct CatalogRefresh(Arc<CatalogService>);

impl CatalogRefresh {
    pub(super) fn new(catalog: Arc<CatalogService>) -> Self {
        Self(catalog)
    }
}

#[async_trait]
impl LocalCatalogRefresh for CatalogRefresh {
    async fn refresh(&self) {
        let _ = self.0.refresh().await;
    }
}

/// `noteUserInput`: the desktop's input time, kept by the heartbeat.
pub(super) struct ActivityInput(Arc<UserActivity>);

impl ActivityInput {
    pub(super) fn new(activity: Arc<UserActivity>) -> Self {
        Self(activity)
    }
}

impl AppInputSink for ActivityInput {
    fn note_user_input(&self, at_ms: i64) {
        self.0.note_user_input(at_ms);
    }
}

/// The remote runtime behind host/power and host/remoteTarget/set.
pub(super) struct RemotePower {
    remote: Arc<RemoteRuntime>,
    local: Arc<dyn Dialer>,
}

impl RemotePower {
    pub(super) fn new(remote: Arc<RemoteRuntime>, local: Arc<dyn Dialer>) -> Self {
        Self { remote, local }
    }
}

impl PowerSink for RemotePower {
    /// `remoteAccessSuspend` / `remoteAccessResume`: suspend closes the leg without error noise,
    /// resume reconnects once.
    fn power(&self, event: PowerEvent) {
        match event {
            PowerEvent::Suspend => self.remote.suspend(),
            PowerEvent::Resume => {
                let remote = self.remote.clone();
                mixdog_rt::spawn("remote-resume", TaskClass::Work, async move {
                    if let Err(error) = remote.resume().await {
                        tracing::warn!(%error, "remote access did not resume");
                    }
                });
            }
        }
    }
}

impl RemoteBridge for RemotePower {
    /// An SSH server core's tunnel, or this core again.
    fn set_target(&self, target: Option<RemoteTarget>) {
        match target {
            None => self.remote.set_target(self.local.clone()),
            Some(target) => self.remote.set_target(Arc::new(WsDialer { url: target.endpoint, token: target.token.unwrap_or_default() })),
        }
    }
}

/// The method table of the registered services, bound once the registration is done: the
/// doctor reads each status through the service that owns it.
#[derive(Default)]
pub struct LateDomains(OnceLock<Arc<Domains>>);

impl LateDomains {
    /// Binds the built table; a second bind is refused.
    pub fn bind(&self, domains: Arc<Domains>) -> Result<(), Arc<Domains>> {
        self.0.set(domains)
    }

    /// Whether a registered service answers `method`.
    pub fn serves(&self, method: &str) -> bool {
        self.0.get().is_some_and(|domains| domains.get(method).is_some())
    }

    /// One method of the table as an internal call: its value, or its failure.
    pub async fn call(&self, method: &'static str, params: Value) -> Result<Value, CoreError> {
        let domains = self.0.get().ok_or_else(|| failed("domains", format!("{method} was called before the services were registered")))?;
        let service = domains.get(method).ok_or_else(|| failed("domains", format!("{method} has no service")))?;
        let reply = service
            .call(CoreRequest { method: Method(method), params, op: None, ctx: CallContext::internal("domains") })
            .await?;
        match reply {
            Reply::Value(value) => Ok(value),
            Reply::Subscribe(_) => Err(failed("domains", format!("{method} answered a subscription"))),
        }
    }
}

#[async_trait]
impl DomainCalls for LateDomains {
    async fn call(&self, method: &'static str, params: Value) -> Result<Value, CoreError> {
        LateDomains::call(self, method, params).await
    }
}

/// `rt.setAutoUpdate(enabled)` of the setup tool: the config actor stores the switch, the update
/// service answers `getUpdateSettings()`. The update service is built after the owners are
/// handed out (the MCP stage needs them first), so it is bound into the cell later.
#[derive(Default)]
pub struct UpdateCell(OnceLock<Arc<UpdateService>>);

impl UpdateCell {
    pub(super) fn bind(&self, update: Arc<UpdateService>) {
        // Composition binds the one update service once.
        self.0.set(update).unwrap_or_else(|_| panic!("the update service is bound once"));
    }
}

pub(super) struct UpdateSetup {
    settings: Settings,
    update: Arc<UpdateCell>,
}

impl UpdateSetup {
    pub(super) fn new(settings: Settings, update: Arc<UpdateCell>) -> Arc<Self> {
        Arc::new(Self { settings, update })
    }
}

#[async_trait]
impl UpdateSettings for UpdateSetup {
    async fn set_auto_update(&self, enabled: bool) -> Result<Value, PortError> {
        self.settings
            .set_auto_update(&Value::Bool(enabled))
            .await
            .map_err(|error| PortError::Failed { capability: "setup".into(), message: error.to_string() })?;
        let update = self.update.0.get().ok_or_else(|| PortError::Unavailable {
            capability: "update".into(),
            message: "the update service is not composed yet".into(),
        })?;
        Ok(update.settings())
    }
}
/// The workflow owner's getters, for the `websearch` and `onboarding` status domains.
pub(super) struct WorkflowGetters(pub(super) Arc<WorkflowConfig>);

#[async_trait]
impl WorkflowFacts for WorkflowGetters {
    fn web_search_route(&self) -> Result<Value, PortError> {
        self.0.web_search_route().map_err(|error| PortError::Failed { capability: "setup".into(), message: format!("{error:?}") })
    }
    fn onboarding(&self) -> Result<Value, PortError> {
        self.0.onboarding_status().map_err(|error| PortError::Failed { capability: "setup".into(), message: format!("{error:?}") })
    }
    async fn workflows(&self) -> Result<Value, PortError> {
        self.0.list_workflows().await.map_err(|error| PortError::Failed { capability: "setup".into(), message: format!("{error:?}") })
    }
}

/// The statuses of the doctor that no domain answers: the session layer, the channel worker, the
/// hook bus and the JS runtime own them.
#[async_trait]
pub trait DoctorHost: Send + Sync {
    /// The JS runtime: `{version, engines}`.
    async fn node_runtime(&self) -> Probe;
    /// `getProviderSetup()` (cached).
    async fn provider_setup(&self) -> Probe;
    /// The route provider of the session state.
    fn active_provider(&self) -> Option<String>;
    async fn channel_worker_status(&self) -> Probe;
    async fn channel_setup(&self) -> Probe;
    async fn hooks_status(&self) -> Probe;
    async fn session_log_migration(&self) -> Probe;
    /// `builtinFeatureActive(undefined, id)` for `browser` and `computer`.
    fn bridge_active(&self, id: &str) -> bool;
    /// The text report as a notice of `thread`.
    async fn notice(&self, thread: Option<&ThreadId>, text: &str);
}

/// `DoctorSources`: the statuses the domains answer are read through them, the rest from
/// [`DoctorHost`].
pub(super) struct ServiceDoctor {
    late: Arc<LateDomains>,
    host: Arc<dyn DoctorHost>,
}

impl ServiceDoctor {
    pub(super) fn new(late: Arc<LateDomains>, host: Arc<dyn DoctorHost>) -> Self {
        Self { late, host }
    }

    /// `Ok(None)`: no service answers the status (the optional runtime call of Node is absent).
    async fn status(&self, method: &'static str, params: Value) -> Probe {
        if !self.late.serves(method) {
            return Ok(None);
        }
        self.late.call(method, params).await.map(Some).map_err(|_| ProbeFailed)
    }
}

#[async_trait]
impl DoctorSources for ServiceDoctor {
    async fn update(&self) -> Probe {
        self.status("update/checkForUpdate", json!({})).await
    }

    async fn node_runtime(&self) -> Probe {
        self.host.node_runtime().await
    }

    async fn provider_setup(&self) -> Probe {
        self.host.provider_setup().await
    }

    fn active_provider(&self) -> Option<String> {
        self.host.active_provider()
    }

    async fn mcp_status(&self) -> Probe {
        self.status("mcp/mcpStatus", json!({})).await
    }

    async fn tool_module_settings(&self) -> Probe {
        self.status("config/getToolModuleSettings", json!({})).await
    }

    async fn recap_settings(&self) -> Probe {
        self.status("config/getRecapSettings", json!({})).await
    }

    async fn voice_status(&self) -> Probe {
        self.status("voice/getVoiceStatus", json!({})).await
    }

    async fn channel_settings(&self) -> Probe {
        self.status("channel/getChannelSettings", json!({ "includeStatus": true })).await
    }

    async fn channel_worker_status(&self) -> Probe {
        self.host.channel_worker_status().await
    }

    async fn channel_setup(&self) -> Probe {
        self.host.channel_setup().await
    }

    async fn skills_status(&self) -> Probe {
        self.status("skills/skillsStatus", json!({})).await
    }

    async fn plugins_status(&self) -> Probe {
        self.status("plugins/pluginsStatus", json!({})).await
    }

    async fn hooks_status(&self) -> Probe {
        self.host.hooks_status().await
    }

    async fn session_log_migration(&self) -> Probe {
        self.host.session_log_migration().await
    }

    fn bridge_active(&self, id: &str) -> bool {
        self.host.bridge_active(id)
    }

    async fn notice(&self, thread: Option<&ThreadId>, text: &str) {
        self.host.notice(thread, text).await;
    }
}
/// How long a skills toggle waits for a further one before it is written (`CONFIG_SAVE_DEBOUNCE_MS`).
const SKILLS_SAVE_DEBOUNCE: std::time::Duration = std::time::Duration::from_millis(150);

#[derive(Default)]
struct PendingSkills {
    names: Option<Vec<String>>,
    generation: u64,
}

/// `ExtensionConfig` over the config actor: the agent section, `saveConfigAndAdopt` as the changed
/// fields only, and the debounced `skills` channel (`setDisabledSkills`): the list is the
/// section's own at once and reaches the file after a quiet 150 ms or [`flush_skills_save`].
///
/// [`flush_skills_save`]: ConfigExtensions::flush_skills_save
pub struct ConfigExtensions {
    config: Config,
    pending: Arc<Mutex<PendingSkills>>,
}

impl ConfigExtensions {
    pub fn new(config: Config) -> Self {
        Self { config, pending: Arc::default() }
    }

    fn pending(&self) -> std::sync::MutexGuard<'_, PendingSkills> {
        self.pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// `flushSkillsSave`: writes the pending list now (`ExtensionHost::flush_skills_save` calls it).
    pub async fn flush_skills_save(&self) {
        flush(&self.config, &self.pending).await;
    }
}

async fn flush(config: &Config, pending: &Mutex<PendingSkills>) {
    let names = pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner).names.take();
    let Some(names) = names else { return };
    let saved = config
        .update_agent(move |agent| {
            agent.insert("skills".into(), json!({ "disabled": names }));
            Ok(())
        })
        .await;
    if let Err(error) = saved {
        tracing::warn!(%error, "the disabled skills were not saved");
    }
}

#[async_trait]
impl ExtensionConfig for ConfigExtensions {
    fn agent(&self) -> Map<String, Value> {
        let mut agent = self.config.agent();
        if let Some(names) = &self.pending().names {
            agent.insert("skills".into(), json!({ "disabled": names }));
        }
        agent
    }

    async fn save_agent(&self, before: &Map<String, Value>, after: &Map<String, Value>) -> Result<(), String> {
        self.config.save_agent_config(before, after, false).await.map(drop).map_err(|error| error.to_string())
    }

    fn set_disabled_skills(&self, names: &[String]) {
        let generation = {
            let mut pending = self.pending();
            pending.names = Some(names.to_vec());
            pending.generation += 1;
            pending.generation
        };
        let (config, pending) = (self.config.clone(), self.pending.clone());
        mixdog_rt::spawn("skills-save", TaskClass::Work, async move {
            tokio::time::sleep(SKILLS_SAVE_DEBOUNCE).await;
            let current = pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner).generation;
            if current == generation {
                flush(&config, &pending).await;
            }
        });
    }
}