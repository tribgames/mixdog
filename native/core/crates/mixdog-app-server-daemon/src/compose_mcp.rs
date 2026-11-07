//! The composition of the MCP, skills, connector and setup services (compose-seams.md rows
//! `mcp`, `skills`, `connector`, the setup tool and its agent-definition actions).
//!
//! [`mcp_services`] builds them from [`McpInputs`]. `compose.rs` registers
//! [`McpComposed::services`] with `DomainsBuilder::register`, hands [`McpComposed::setup`] to the
//! tool surface as the `setup` tool's service and passes [`McpComposed::agents`] where an
//! `AgentCatalog` is wanted. What belongs to another owner arrives through a named field.
//!
//! The `PluginsService` is composed by `compose_domains` before this runs, with
//! [`LateExtensionHost`] as its host; [`mcp_services`] binds that host to the real one, which
//! needs the config `compose_domains` opens.

use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::OnceLock;

use async_trait::async_trait;
use mixdog_core_agents::agents::AgentDefinitions;
use mixdog_core_agents::agents::AgentEffects;
use mixdog_core_agents::agents::AgentEvidence;
use mixdog_core_agents::setup::DefinitionSetup;
use mixdog_core_agents::setup::McpSetup;
use mixdog_core_agents::setup::SetupDesktop;
use mixdog_core_agents::setup::SetupService;
use mixdog_core_agents::setup::SetupVoice;
use mixdog_core_agents::setup::StatusReader;
use mixdog_core_api::CoreError;
use mixdog_core_api::DomainService;
use mixdog_core_base::rooms::ids::MIXY_AGENT_ID;
use mixdog_core_base::rooms::ids::agent_id_of_home_session;
use mixdog_core_base::rooms::ids::room_member_of_session;
use mixdog_core_config::config::AgentRoutes;
use mixdog_core_config::config::Config;
use mixdog_core_config::config::OutputStyles;
use mixdog_core_config::config::Settings;
use mixdog_core_config::config::SettingsEffects;
use mixdog_core_config::tool_modules::ToolModules;
use mixdog_core_config::tool_modules::builtin_feature_active;
use mixdog_core_config::tool_modules::value::feature_env_override;
use mixdog_core_config::tool_modules::value::module_enabled;
use mixdog_core_config::tool_modules::with_grandfathered_builtins;
use mixdog_core_ports::ports::setup_actions::CallerScope;
use mixdog_core_ports::ports::setup_actions::SetupActions;
use mixdog_core_ports::ports::setup_actions::SetupCallers;
use mixdog_mcp::config::Env;
use mixdog_mcp::connector_accounts::AccountHealth;
use mixdog_mcp::declaration_cache::DeclarationCache;
use mixdog_mcp::extension_service::ExtensionConfig;
use mixdog_mcp::extension_service::ExtensionHost;
use mixdog_mcp::hook_bus::HookObserver;
use mixdog_mcp::hub::McpHub;
use mixdog_mcp::mcp_glue::GlueHost;
use mixdog_mcp::mcp_glue::GlueInputs;
use mixdog_mcp::mcp_glue::GlueSecretOps;
use mixdog_mcp::mcp_glue::McpGlue;
use mixdog_mcp::mcp_glue::McpSurface;
use mixdog_mcp::mcp_secrets::GmailVerifier;
use mixdog_mcp::mcp_secrets::McpServerSecrets;
use mixdog_mcp::mcp_service::McpService;
use mixdog_mcp::oauth::OAuthEnv;
use mixdog_mcp::plugin_admin::GitRunner;
use mixdog_mcp::plugin_admin::PluginAdmin;
use mixdog_mcp::setup_runtime::ServiceSetupRuntime;
use mixdog_mcp::skill_catalog::SkillCatalog;
use mixdog_mcp::skill_catalog::SkillSettings;
use mixdog_mcp::skill_catalog::SkillSettingsSource;
use mixdog_mcp::skills::SkillGate;
use mixdog_mcp::skills_service::SkillsService;
use mixdog_mcp::skills_watch::SkillsWatch;
use mixdog_protocol::HeldRunKind;
use mixdog_protocol::ThreadId;
use mixdog_rt::LaneTokens;
use mixdog_secrets::SecretStore;
use mixdog_services::bots::heartbeat::HeartbeatSessions;
use mixdog_services::channels::setup::AutomationAdmin;
use serde_json::Map;
use serde_json::Value;

use crate::compose_domains::EnvReader;
use crate::domain_seams::automation_setup::AutomationActions;
use crate::held_requests::HeldHome;
use crate::domain_seams::doctor::HooksStatus;
use crate::hook_rule_setup::HookRuleSetup;
use crate::hook_rule_setup::hook_rules_path;
use crate::setup_status::ServiceStatus;

/// What a `requires: browser|computer|terminal|visualize` skill asks: whether the desktop's bridge
/// for the tool is up (Node reads the bridge discovery file, `builtin-features.mjs`).
pub trait BridgeFeatures: Send + Sync {
    fn present(&self, feature: &str) -> bool;
}

/// An [`ExtensionHost`] bound after the services that hold it are built: `compose_domains`
/// composes the `PluginsService` before it can return the config the real host reads.
#[derive(Default)]
pub struct LateExtensionHost {
    inner: OnceLock<Arc<dyn ExtensionHost>>,
}

impl mixdog_core::run_host::late::Bound for LateExtensionHost {
    fn cell(&self) -> &'static str {
        "extension host"
    }

    fn is_bound(&self) -> bool {
        self.inner.get().is_some()
    }
}

impl LateExtensionHost {
    pub fn new() -> Arc<Self> {
        Arc::default()
    }

    fn bind(&self, host: Arc<dyn ExtensionHost>) {
        assert!(self.inner.set(host).is_ok(), "the extension host is bound once");
    }

    fn get(&self) -> &Arc<dyn ExtensionHost> {
        self.inner.get().expect("the extension host is bound before the first request is served")
    }
}

#[async_trait]
impl ExtensionHost for LateExtensionHost {
    async fn reconcile_plugins_and_announce(&self) {
        self.get().reconcile_plugins_and_announce().await;
    }
    async fn announce(&self, kind: &str) {
        self.get().announce(kind).await;
    }
    async fn announce_without_invalidating(&self, kind: &str) {
        self.get().announce_without_invalidating(kind).await;
    }
    async fn tool_names(&self) -> Result<Vec<String>, String> {
        self.get().tool_names().await
    }
    async fn reconnect_mcp_and_announce(&self, only: Option<&str>, enabled: bool, drop: &[String]) -> Value {
        self.get().reconnect_mcp_and_announce(only, enabled, drop).await
    }
    async fn reconnect_all_mcp_and_announce(&self) -> Value {
        self.get().reconnect_all_mcp_and_announce().await
    }
    async fn schedule_mcp_toggle(&self, name: &str, enabled: bool) -> Value {
        self.get().schedule_mcp_toggle(name, enabled).await
    }
    async fn publish_mcp_changes(&self, changes: &[(String, bool)]) {
        self.get().publish_mcp_changes(changes).await;
    }
    async fn announce_mcp_changes(&self, changes: &[(String, bool)]) {
        self.get().announce_mcp_changes(changes).await;
    }
    async fn connect_configured_mcp(&self, only: &str, enabled: bool) -> Value {
        self.get().connect_configured_mcp(only, enabled).await
    }
    fn invalidate_skills(&self) {
        self.get().invalidate_skills();
    }
    async fn flush_skills_save(&self) {
        self.get().flush_skills_save().await;
    }
    async fn current_cwd(&self, thread_id: Option<&str>) -> Result<PathBuf, String> {
        self.get().current_cwd(thread_id).await
    }
    async fn skills_status(&self) -> Value {
        self.get().skills_status().await
    }
    async fn plugin_mcp_summary(&self, thread_id: Option<&str>) -> Result<Value, String> {
        self.get().plugin_mcp_summary(thread_id).await
    }
}

/// What gates a skill now (`getDisabledSkillNameSet`, `featureConfig`, `extensionScopesFromConfig`),
/// read from the config on every call.
pub struct ConfigSkillSettings {
    config: Arc<dyn ExtensionConfig>,
    env: EnvReader,
    bridges: Arc<dyn BridgeFeatures>,
}

impl ConfigSkillSettings {
    pub fn new(config: Arc<dyn ExtensionConfig>, env: EnvReader, bridges: Arc<dyn BridgeFeatures>) -> Self {
        Self { config, env, bridges }
    }
}

/// `DomainSeams.feature_activity` (wp-config-setup-7, `FeatureActivity::active(id)`) for browser, computer and terminal: the
/// env override, else the bridge fact, exactly the non-`visualize` arm of the skill gate above, over the same `BridgeFeatures`
/// value (`McpInputs.bridges`), so the two cannot disagree.
pub struct BridgeActivity {
    env: EnvReader,
    bridges: Arc<dyn BridgeFeatures>,
}

impl BridgeActivity {
    pub fn new(env: EnvReader, bridges: Arc<dyn BridgeFeatures>) -> Self {
        Self { env, bridges }
    }
}

impl mixdog_core_agents::setup::FeatureActivity for BridgeActivity {
    fn active(&self, id: &str) -> bool {
        let env = |name: &str| (self.env)(name);
        feature_env_override(&env, &format!("MIXDOG_FEATURE_{}", id.to_uppercase())).unwrap_or_else(|| self.bridges.present(id))
    }
}

/// `getLocalProviderStatus || localProviderStatus` for the provider setup (wp-ai-svc-23 `LocalStatus`): the local runtime's own status,
/// `None` when it throws. core-domains cannot import services, so the daemon wraps the one `LocalProvider`.
pub struct LocalStatusOf(pub Arc<mixdog_services::local_provider::provider::LocalProvider>);

#[async_trait::async_trait]
impl mixdog_core_domains::domains::ai_account::setup_world::LocalStatus for LocalStatusOf {
    async fn status(&self) -> Option<serde_json::Value> {
        self.0.status().await.ok()
    }
}
/// `readProviderAccountPool(provider).selectedId` (`SelectedAccounts`, wp-svc-misc-13): the roster is read on the credential lane
/// at every ask, so an edit made by anyone shows at once. An unreadable roster has no selection, as Node's empty pool.
pub struct AccountPoolSelected(pub mixdog_ai::accounts::AccountStore);

#[async_trait::async_trait]
impl mixdog_services::media::SelectedAccounts for AccountPoolSelected {
    async fn selected(&self, provider: &str) -> Option<String> {
        self.0.pool(provider).await.ok()?.selected_id
    }
}

/// The agent crate's `Clock` over the session crate's: both are "epoch milliseconds".
pub struct AgentClock(pub Arc<dyn mixdog_core_session::session::Clock>);

impl mixdog_agent::env::Clock for AgentClock {
    fn now_ms(&self) -> i64 {
        self.0.now_ms()
    }
}

/// One `ChangeSink` over several watch owners: every batch goes to each, and each keeps only the watch ids it registered.
pub struct FanOutSink(pub Vec<Arc<dyn mixdog_workspace::watcher::ChangeSink>>);

impl mixdog_workspace::watcher::ChangeSink for FanOutSink {
    fn changed(&self, watch_id: &str, paths: Vec<String>, kind: mixdog_workspace::watcher::ChangeKind) {
        for sink in &self.0 {
            sink.changed(watch_id, paths.clone(), kind);
        }
    }
}

/// The job board's notifier (`JobBoard::new(clock, notifier, on_change)`): a finished job is delivered to the session that started it, i.e. to the
/// session directory (`impl TaskNotifier for SessionDirectory`), which is built after the board: the board is read by the tool pool the directory is built
/// from. Reads the same late directory cell the other views read; a job exists only inside a turn, so the directory is bound by then.
pub struct LateBoardNotifier(pub Arc<mixdog_core::run_host::compose_parts::LateDirectory>);

#[async_trait::async_trait]
impl mixdog_tools::exec::TaskNotifier for LateBoardNotifier {
    async fn finished(&self, owner: &mixdog_protocol::ThreadId, surface: &str, task_id: &str, status: &str, notification: String) {
        if let Some(directory) = self.0.directory() {
            mixdog_tools::exec::TaskNotifier::finished(&*directory, owner, surface, task_id, status, notification).await;
        }
    }
}

/// The usage queue as a sink for callers that hold one sink for life (`QueuedLedger`): each row asks the source, as `ProcessInputs.ledger` does.
pub struct SourcedSink(pub Arc<dyn Fn() -> Option<Arc<dyn mixdog_ai::registry::accounting::UsageSink>> + Send + Sync>);

#[async_trait::async_trait]
impl mixdog_ai::registry::accounting::UsageSink for SourcedSink {
    async fn record_queued(&self, row: mixdog_ai::registry::accounting::UsageRow) -> Result<(), String> {
        match (self.0)() {
            Some(sink) => sink.record_queued(row).await,
            None => Err("no usage ledger".to_owned()),
        }
    }
}

/// `getQuotaAutoResume()` for the providers status reader (wp-ai-admin-4 `QuotaAutoResumeSetting`): the closure the sessions and the
/// resume timer read (`quota_lane::auto_resume_enabled` over the config), so the whole core has one switch.
pub struct QuotaSwitch(pub Arc<dyn Fn() -> bool + Send + Sync>);

impl mixdog_core_domains::domains::ai_admin::provider_status::QuotaAutoResumeSetting for QuotaSwitch {
    fn enabled(&self) -> bool {
        (self.0)()
    }
}

/// JavaScript truthiness of a value that came through JSON.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// The ids `requires` can name that `builtinFeatureActive` decides from the config.
const CONFIG_FEATURES: [&str; 8] = ["webSearch", "memory", "git", "office", "tidy", "localProvider", "autoEffort", "media"];

impl SkillSettingsSource for ConfigSkillSettings {
    fn current(&self) -> SkillSettings {
        let agent = self.config.agent();
        // Node reads `getConfigSnapshot`, which always carries `presets` (a user-mark key), so a
        // config without a `builtins` section is always grandfathered; the raw document may lack it.
        let mut profiled = agent.clone();
        profiled.entry("presets").or_insert_with(|| Value::Object(Map::new()));
        let doc = with_grandfathered_builtins(&profiled);
        let env = |name: &str| (self.env)(name);
        let onnx = mixdog_services::tool_state::onnx_runtime_supported();
        let mut active: HashSet<String> =
            CONFIG_FEATURES.iter().filter(|id| builtin_feature_active(&doc, id, &env, onnx)).map(|id| (*id).to_owned()).collect();
        for id in ["browser", "computer", "terminal", "visualize"] {
            let var = feature_env_override(&env, &format!("MIXDOG_FEATURE_{}", id.to_uppercase()));
            let on = match id {
                "visualize" => var.unwrap_or_else(|| module_enabled(&doc, id) && self.bridges.present(id)),
                _ => var.unwrap_or_else(|| self.bridges.present(id)),
            };
            if on {
                active.insert(id.to_owned());
            }
        }
        let disabled = agent
            .get("skills")
            .and_then(|skills| skills.get("disabled"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|name| mixdog_js::js_trim(&mixdog_js::value_to_string(name)).to_lowercase())
            .filter(|name| !name.is_empty())
            .collect();
        SkillSettings {
            gate: SkillGate { disabled, active_features: active },
            scopes: mixdog_mcp::scopes::ExtensionScopes::from_config(agent.get("extensionScopes").unwrap_or(&Value::Null)),
        }
    }
}

/// The session store as the setup callers read it.
#[async_trait]
pub trait CallerSessions: Send + Sync {
    /// The stored header of the session; `None` when it is unknown.
    async fn header(&self, thread: &ThreadId) -> Option<Map<String, Value>>;
    /// `String(caller.agent || '').trim()`; a session that cannot be opened is its error.
    async fn acting_agent(&self, thread: &ThreadId) -> Result<String, CoreError>;
}

#[async_trait]
impl CallerSessions for mixdog_core_session::session::SessionDirectory {
    async fn header(&self, thread: &ThreadId) -> Option<Map<String, Value>> {
        self.stored_header(thread).await
    }

    async fn acting_agent(&self, thread: &ThreadId) -> Result<String, CoreError> {
        mixdog_core_session::session::SessionDirectory::acting_agent(self, thread).await
    }
}

/// What only the live session layer knows about a setup caller.
#[async_trait]
pub trait SessionFacts: Send + Sync {
    /// `resolveSessionMode(..).mode === 'agent'`.
    async fn agent_mode(&self, thread: &ThreadId) -> bool;
    /// `mixyDisplayName()`.
    async fn mixy_name(&self) -> String;
    /// `settingsReachCurrentSession()`.
    async fn settings_reach_session(&self, thread: &ThreadId) -> bool;
}

#[async_trait]
impl SessionFacts for mixdog_core_session::session::setup_facts::SessionSetupFacts {
    async fn agent_mode(&self, thread: &ThreadId) -> bool {
        mixdog_core_session::session::setup_facts::SessionSetupFacts::agent_mode(self, thread).await
    }

    async fn mixy_name(&self) -> String {
        mixdog_core_session::session::setup_facts::SessionSetupFacts::mixy_name(self).await
    }

    async fn settings_reach_session(&self, thread: &ThreadId) -> bool {
        mixdog_core_session::session::setup_facts::SessionSetupFacts::settings_reach_session(self, thread).await
    }
}

/// `SetupCallers` over the session store, the heartbeat marks and the held layer's runs
/// (`scheduleCallerScope`, `schedule-access.mjs`).
pub struct SessionSetupCallers {
    sessions: Arc<dyn CallerSessions>,
    heartbeat: Arc<HeartbeatSessions>,
    runs: Arc<dyn HeldHome>,
    facts: Arc<dyn SessionFacts>,
}

impl SessionSetupCallers {
    pub fn new(sessions: Arc<dyn CallerSessions>, heartbeat: Arc<HeartbeatSessions>, runs: Arc<dyn HeldHome>, facts: Arc<dyn SessionFacts>) -> Self {
        Self { sessions, heartbeat, runs, facts }
    }

    /// `provenanceScope(session, id)`.
    fn provenance(&self, id: &str, header: Option<&Map<String, Value>>) -> CallerScope {
        if room_member_of_session(id).is_some() {
            return CallerScope::RoomMember;
        }
        if let Some(home) = agent_id_of_home_session(id) {
            return if home == MIXY_AGENT_ID { CallerScope::Human } else { CallerScope::Agent { agent_id: home, unattended: false } };
        }
        if self.heartbeat.is_marked(id) {
            return CallerScope::Agent { agent_id: MIXY_AGENT_ID.to_owned(), unattended: false };
        }
        let Some(header) = header.filter(|_| !id.is_empty()) else { return CallerScope::Headless };
        let text = |key: &str| header.get(key).filter(|v| truthy(v)).map(mixdog_js::value_to_string).unwrap_or_default();
        let source_type = text("sourceType").to_lowercase();
        let owner = text("ownerSessionId");
        let headless = text("owner").trim().to_lowercase() == "agent"
            || !text("parentSessionId").is_empty()
            || (!owner.is_empty() && owner != id)
            || !matches!(source_type.as_str(), "" | "lead" | "cli");
        if headless { CallerScope::Headless } else { CallerScope::Human }
    }
}

#[async_trait]
impl SetupCallers for SessionSetupCallers {
    async fn scope(&self, thread: &ThreadId) -> CallerScope {
        let id = thread.to_string();
        let header = self.sessions.header(thread).await;
        let scope = self.provenance(&id, header.as_ref());
        let Some(run) = self.runs.run_of(thread).await else { return scope };
        if matches!(scope, CallerScope::Headless | CallerScope::RoomMember) {
            return scope;
        }
        if run.kind == HeldRunKind::Room {
            return CallerScope::RoomMember;
        }
        match &scope {
            _ if run.agent_id.is_empty() => CallerScope::Headless,
            CallerScope::Agent { agent_id, .. } if *agent_id != run.agent_id => CallerScope::Headless,
            _ => CallerScope::Agent { agent_id: run.agent_id, unattended: true },
        }
    }

    async fn is_heartbeat(&self, thread: &ThreadId) -> bool {
        self.heartbeat.is_marked(&thread.to_string())
    }

    async fn acting_agent(&self, thread: &ThreadId) -> Result<String, CoreError> {
        self.sessions.acting_agent(thread).await
    }

    async fn agent_mode(&self, thread: &ThreadId) -> bool {
        self.facts.agent_mode(thread).await
    }

    async fn mixy_name(&self) -> String {
        self.facts.mixy_name().await
    }

    async fn settings_reach_session(&self, thread: &ThreadId) -> bool {
        self.facts.settings_reach_session(thread).await
    }
}

/// What the agent definitions need of the sessions and the clock.
pub struct AgentSeams {
    /// `home_greeted`, `home_chatted`, `mixy_owns_routines`: WP-SESSION and the automation store.
    pub evidence: Arc<dyn AgentEvidence>,
    /// `agents_changed`, `reload_routines`, `set_agent_route`: WP-SESSION, WP-CHANNELS, WP-AI-ADMIN.
    pub effects: Arc<dyn AgentEffects>,
    /// `resolveRoute(config, {})`: the live Main route.
    pub main_route: Arc<dyn Fn() -> Value + Send + Sync>,
    /// ISO timestamp for a saved definition.
    pub now: Arc<dyn Fn() -> String + Send + Sync>,
}

/// The agent definitions, built once. `ConfigHosts` (the compaction and workflow hosts of
/// `compose_domains`) and `mcp_services` both take this `Arc`, so it is built before either; it needs
/// nothing `compose_domains` produces. The shipped `agents/` is `<package_root>/src/agents` (`mixdogRoot()` is the `src` folder).
pub fn build_agents(tokens: &LaneTokens, config: &Config, package_root: &Path, data_dir: &Path, task_workspace: &Path, seams: AgentSeams) -> Arc<AgentDefinitions> {
    Arc::new(
        AgentDefinitions::new(
            package_root.join("src"),
            data_dir.to_path_buf(),
            tokens.interactive_io,
            AgentRoutes::new(config.clone(), data_dir.to_path_buf()),
            seams.evidence,
            seams.main_route,
            task_workspace.to_path_buf(),
        )
        .with_writes(tokens.durability_io, seams.effects, seams.now),
    )
}

/// What the setup tool needs of the session layer and the other owners.
pub struct SetupSeams {
    pub sessions: Arc<dyn CallerSessions>,
    pub heartbeat: Arc<HeartbeatSessions>,
    pub runs: Arc<dyn HeldHome>,
    pub facts: Arc<dyn SessionFacts>,
    pub desktop: Arc<dyn SetupDesktop>,
    pub voice: Arc<dyn SetupVoice>,
    /// The daemon's one `ChannelAdmin`: the five automation actions of the setup tool.
    pub automation: Arc<dyn AutomationAdmin>,
    /// The other owners' setup actions (`SetupService::with_actions` takes one owner at a time;
    /// every owner's goes into the one service).
    pub other_actions: Vec<Arc<dyn SetupActions>>,
    /// The other owners' `status` readers (`PreDomains::status_readers`, the `agents` reader):
    /// one `SetupService::with_status` each. A domain is served by one reader, so none repeats a
    /// domain `mcp_services` registers itself.
    pub other_status: Vec<Arc<dyn StatusReader>>,
}

pub struct McpInputs {
    pub tokens: LaneTokens,
    /// `resolvePluginData()`.
    pub data_dir: PathBuf,
    /// The package root: shipped `agents/`, `output-styles/`, `defaults/` (the bundled skills).
    pub package_root: PathBuf,
    /// The user's home folder (the connector folders, `~` in a server config).
    pub home: PathBuf,
    /// The process environment as one map (server configs expand `${VAR}` against it).
    pub process_env: Env,
    /// `process.env[name]` for the feature switches.
    pub env: EnvReader,
    pub hub: Arc<McpHub>,
    pub config: Config,
    pub tool_modules: Arc<ToolModules>,
    /// `ComposedDomains::extensions`.
    pub extensions: Arc<crate::compose_domains::ConfigExtensions>,
    /// The host `compose_domains` gave the `PluginsService` (`PluginSeams.host`).
    pub extension_host: Arc<LateExtensionHost>,
    /// The `PluginsService` `compose_domains` registered.
    pub plugins: Arc<dyn DomainService>,
    /// The config service (`config/getWorkflowPack`): `WorkflowConfig`.
    pub workflow: Arc<dyn DomainService>,
    pub secret_store: Arc<dyn SecretStore>,
    pub verifier: Arc<dyn GmailVerifier>,
    pub surface: Arc<dyn McpSurface>,
    pub bridges: Arc<dyn BridgeFeatures>,
    /// `rt.hooksStatus()`: the one `HookStatus` the doctor reads (`DoctorInputs.hooks`).
    pub hooks: Arc<dyn HooksStatus>,
    /// The hook bus's observer: the event log that `HookStatus` shows (`HookStatus::new`'s last argument).
    pub hook_observer: Arc<dyn HookObserver>,
    /// The watch the workspace watcher's sink feeds (`SkillsWatch::sink`).
    pub skills_watch: Arc<SkillsWatch>,
    pub git: Arc<dyn GitRunner>,
    pub announce: Arc<dyn Fn() + Send + Sync>,
    pub settings_effects: Arc<dyn SettingsEffects>,
    /// [`build_agents`]' result, also given to `ConfigHosts`.
    pub agents: Arc<AgentDefinitions>,
    pub setup: SetupSeams,
}

pub struct McpComposed {
    /// Register each with `DomainsBuilder::register`: `mcp/*` and `connector/*`, then `skills/*`.
    pub services: Vec<Arc<dyn DomainService>>,
    /// The `mcp/*` + `connector/*` service itself (also in `services`): the agent connector API (`McpConnectors::new(mcp, policy)`) calls it.
    pub mcp_domain: Arc<dyn DomainService>,
    /// The one `SetupCallers` (also inside the setup service): the host runtime's provenance reads (`scheduleCallerScope`) take the same value.
    pub callers: Arc<dyn SetupCallers>,
    /// The `setup` tool's service.
    pub setup: Arc<SetupService>,
    /// Also the `rooms::AgentCatalog`.
    pub agents: Arc<AgentDefinitions>,
    pub glue: Arc<McpGlue>,
    pub catalog: Arc<SkillCatalog>,
}

pub fn mcp_services(inputs: McpInputs) -> McpComposed {
    let McpInputs { tokens, data_dir, package_root, home, process_env, env, hub, config, tool_modules, extensions, extension_host, plugins, workflow, .. } = &inputs;
    let ext_config: Arc<dyn ExtensionConfig> = extensions.clone();
    let host: Arc<dyn ExtensionHost> = extension_host.clone();
    let admin = Arc::new(PluginAdmin::new(data_dir.clone(), inputs.git.clone(), inputs.announce.clone()));
    let settings: Arc<dyn SkillSettingsSource> = Arc::new(ConfigSkillSettings::new(ext_config.clone(), env.clone(), inputs.bridges.clone()));
    let catalog = SkillCatalog::new(
        data_dir.clone(),
        tokens.maintenance_io,
        McpGlue::skill_roots(admin.clone(), package_root.join("src").join("defaults")),
        settings.clone(),
        &inputs.skills_watch,
    );
    let glue = McpGlue::new(GlueInputs {
        hub: hub.clone(),
        config: ext_config.clone(),
        admin,
        declarations: Arc::new(DeclarationCache::new()),
        maintenance: tokens.maintenance_io,
        oauth_env: OAuthEnv { store: inputs.secret_store.clone(), plugin_data: data_dir.clone(), io: tokens.durability_io },
        env: process_env.clone(),
        surface: inputs.surface.clone(),
        health: Arc::new(AccountHealth::default()),
    });
    let glue_host = Arc::new(GlueHost::new(glue.clone(), catalog.clone()));
    let secret_ops = Arc::new(GlueSecretOps::new(inputs.secret_store.clone(), inputs.verifier.clone(), glue.clone()));
    let mcp: Arc<dyn DomainService> = Arc::new(McpService::new(
        ext_config.clone(),
        host.clone(),
        glue.clone(),
        Arc::new(McpServerSecrets::new(secret_ops, process_env.clone())),
        home.clone(),
    ));
    let skills = Arc::new(SkillsService::new(
        catalog.clone(),
        settings,
        ext_config,
        host,
        tokens.maintenance_io,
        tokens.durability_io,
        data_dir.clone(),
    ));
    glue_host.bind_skills(skills.clone());
    extension_host.bind(glue_host);
    let skills: Arc<dyn DomainService> = skills;

    let agents = inputs.agents.clone();
    let callers = Arc::new(SessionSetupCallers::new(
        inputs.setup.sessions.clone(),
        inputs.setup.heartbeat.clone(),
        inputs.setup.runs.clone(),
        inputs.setup.facts.clone(),
    ));
    let runtime = Arc::new(ServiceSetupRuntime::new(mcp.clone(), skills.clone(), plugins.clone()));
    let automation = Arc::new(AutomationActions::new(inputs.setup.automation.clone(), agents.clone(), callers.clone()));
    let mut setup = SetupService::new(config.clone(), tool_modules.clone(), callers.clone(), inputs.setup.desktop.clone(), inputs.setup.voice.clone())
        .with_settings(Settings::new(config.clone(), inputs.settings_effects.clone(), env.clone()))
        .with_output_styles(OutputStyles::new(config.clone(), package_root.join("src").join("output-styles"), data_dir))
        .with_actions(Arc::new(McpSetup::new(runtime)))
        .with_actions(Arc::new(HookRuleSetup::new(hook_rules_path(env, data_dir), tokens.maintenance_io, inputs.hooks.clone(), inputs.hook_observer.clone())))
        .with_actions(automation.clone())
        .with_status(automation)
        .with_actions(Arc::new(DefinitionSetup::new(agents.clone(), callers.clone(), workflow.clone(), skills.clone())))
        .with_status(Arc::new(ServiceStatus::new(mcp.clone(), skills.clone(), plugins.clone(), inputs.hooks.clone())));
    let callers_out: Arc<dyn SetupCallers> = callers;
    for owner in &inputs.setup.other_actions {
        setup = setup.with_actions(owner.clone());
    }
    for reader in &inputs.setup.other_status {
        setup = setup.with_status(reader.clone());
    }
    McpComposed { services: vec![mcp.clone(), skills], mcp_domain: mcp, callers: callers_out, setup: Arc::new(setup), agents, glue, catalog }
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "test fixtures are written straight to a temp dir")]
mod tests {
    use super::*;

    struct Doc(Map<String, Value>);

    #[async_trait]
    impl ExtensionConfig for Doc {
        fn agent(&self) -> Map<String, Value> {
            self.0.clone()
        }
        async fn save_agent(&self, _: &Map<String, Value>, _: &Map<String, Value>) -> Result<(), String> {
            Ok(())
        }
        fn set_disabled_skills(&self, _: &[String]) {}
    }

    struct Bridges(&'static [&'static str]);
    impl BridgeFeatures for Bridges {
        fn present(&self, feature: &str) -> bool {
            self.0.contains(&feature)
        }
    }

    fn settings(agent: Value, env: &'static [(&'static str, &'static str)], bridges: &'static [&'static str]) -> SkillSettings {
        let Value::Object(map) = agent else { unreachable!() };
        let reader: EnvReader = Arc::new(move |name| env.iter().find(|(k, _)| *k == name).map(|(_, v)| (*v).to_owned()));
        ConfigSkillSettings::new(Arc::new(Doc(map)), reader, Arc::new(Bridges(bridges))).current()
    }

    #[test]
    fn disabled_names_are_trimmed_and_lowercased() {
        let s = settings(serde_json::json!({"skills": {"disabled": [" Alpha ", "", "BETA"]}}), &[], &[]);
        assert_eq!(s.gate.disabled.len(), 2);
        assert!(s.gate.disabled.contains("alpha") && s.gate.disabled.contains("beta"));
    }

    #[test]
    fn bridge_features_follow_the_bridge_unless_the_environment_decides() {
        let on = settings(serde_json::json!({}), &[], &["browser"]);
        assert!(on.gate.active_features.contains("browser") && !on.gate.active_features.contains("terminal"));
        let forced = settings(serde_json::json!({}), &[("MIXDOG_FEATURE_TERMINAL", "1"), ("MIXDOG_FEATURE_BROWSER", "off")], &["browser"]);
        assert!(forced.gate.active_features.contains("terminal") && !forced.gate.active_features.contains("browser"));
    }

    struct Memory(std::sync::Mutex<std::collections::HashMap<String, String>>);

    #[async_trait]
    impl SecretStore for Memory {
        async fn get(&self, account: &str) -> Result<Option<String>, mixdog_secrets::SecretError> {
            Ok(self.0.lock().unwrap().get(account).cloned())
        }
        async fn set(&self, account: &str, value: &str) -> Result<(), mixdog_secrets::SecretError> {
            self.0.lock().unwrap().insert(account.to_owned(), value.to_owned());
            Ok(())
        }
        async fn delete(&self, account: &str) -> Result<(), mixdog_secrets::SecretError> {
            self.0.lock().unwrap().remove(account);
            Ok(())
        }
    }

    struct Quiet;

    #[async_trait]
    impl GmailVerifier for Quiet {
        async fn verify(&self, _: &str, _: &str) -> Result<(), String> {
            Ok(())
        }
    }
    #[async_trait]
    impl McpSurface for Quiet {
        async fn current_cwd(&self, _: Option<&str>) -> Result<PathBuf, String> {
            Ok(PathBuf::new())
        }
        async fn thread_scope(&self, _: &str) -> Result<Option<String>, String> {
            Ok(None)
        }
        async fn refresh_surface(&self) {}
        async fn tool_names(&self) -> Result<Vec<String>, String> {
            Ok(Vec::new())
        }
        fn open_browser(&self, _: &str) {}
        fn announce_plugins(&self) {}
        async fn flush_skills_save(&self) {}
    }
    impl BridgeFeatures for Quiet {
        fn present(&self, _: &str) -> bool {
            false
        }
    }
    #[async_trait]
    impl HooksStatus for Quiet {
        async fn status(&self) -> Value {
            serde_json::json!({ "rules": [] })
        }
    }
    impl HookObserver for Quiet {
        fn emit(&self, _: &str, _: Value) {}
    }
    impl GitRunner for Quiet {
        fn run(&self, _: &[String], _: std::time::Duration) -> Result<String, String> {
            Err("no git".into())
        }
    }
    #[async_trait]
    impl SettingsEffects for Quiet {
        fn set_configured_shell(&self, _: &str) {}
        fn note_cache_warming_enabled(&self, _: bool) {}
        async fn sync_developer_option(&self, _: &str) {}
    }
    #[async_trait]
    impl AgentEvidence for Quiet {
        async fn home_greeted(&self, _: &str) -> bool {
            false
        }
        async fn home_chatted(&self, _: &str) -> bool {
            false
        }
        async fn mixy_owns_routines(&self) -> Result<bool, String> {
            Ok(false)
        }
    }
    #[async_trait]
    impl AgentEffects for Quiet {
        async fn agents_changed(&self) {}
        async fn reload_routines(&self) -> Result<(), String> {
            Ok(())
        }
        async fn set_agent_route(&self, _: &str, _: &Value) -> Result<(), String> {
            Ok(())
        }
        async fn delete_owned_routines(&self, _: &str) -> Result<mixdog_core_agents::agents::OwnedRoutines, String> {
            Ok(Default::default())
        }
    }
    #[async_trait]
    impl CallerSessions for Quiet {
        async fn header(&self, _: &ThreadId) -> Option<Map<String, Value>> {
            None
        }
        async fn acting_agent(&self, _: &ThreadId) -> Result<String, CoreError> {
            Ok(String::new())
        }
    }
    #[async_trait]
    impl SessionFacts for Quiet {
        async fn agent_mode(&self, _: &ThreadId) -> bool {
            false
        }
        async fn mixy_name(&self) -> String {
            "Mixy".into()
        }
        async fn settings_reach_session(&self, _: &ThreadId) -> bool {
            false
        }
    }
    #[async_trait]
    impl HeldHome for Quiet {
        async fn run_of(&self, _: &ThreadId) -> Option<crate::held_requests::RunInfo> {
            None
        }
        fn ui_attached(&self, _: &ThreadId) -> bool {
            false
        }
        async fn deliver(&self, _: &str, _: &mixdog_protocol::HeldRequest) -> Result<(), String> {
            Ok(())
        }
        fn push(&self, _: &crate::held_requests::HeldPush) {}
        async fn agent_name(&self, id: &str) -> Result<String, String> {
            Ok(id.to_owned())
        }
        fn new_id(&self) -> String {
            "1".into()
        }
    }
    #[async_trait]
    impl SetupDesktop for Quiet {
        async fn request(&self, _: &ThreadId, _: &Value) -> Result<mixdog_core_agents::setup::DesktopAnswer, mixdog_tools::orch::util::PortError> {
            Ok(mixdog_core_agents::setup::DesktopAnswer::Done(Value::Null))
        }
    }
    #[async_trait]
    impl AutomationAdmin for Quiet {
        async fn get_channel_setup(&self) -> Result<Value, String> {
            Err("no channels".into())
        }
        async fn save_schedule(&self, _: &Value) -> Result<Value, String> {
            Err("no channels".into())
        }
        async fn save_webhook(&self, _: &Value) -> Result<Value, String> {
            Err("no channels".into())
        }
        async fn delete_schedule(&self, _: &str) -> Result<Value, String> {
            Err("no channels".into())
        }
        async fn delete_webhook(&self, _: &str) -> Result<Value, String> {
            Err("no channels".into())
        }
        async fn set_schedule_enabled(&self, _: &str, _: Option<&Value>) -> Result<Value, String> {
            Err("no channels".into())
        }
        async fn set_webhook_enabled(&self, _: &str, _: Option<&Value>) -> Result<Value, String> {
            Err("no channels".into())
        }
        async fn run_schedule_now(&self, _: &str) -> Result<Value, String> {
            Err("no channels".into())
        }
        async fn run_webhook_now(&self, _: &str) -> Result<Value, String> {
            Err("no channels".into())
        }
        async fn set_webhook_config(&self, _: Option<&Value>) -> Result<Value, String> {
            Err("no channels".into())
        }
    }
    #[async_trait]
    impl SetupVoice for Quiet {
        async fn set_enabled(&self, _: bool) -> Result<Value, mixdog_tools::orch::util::PortError> {
            Ok(Value::Null)
        }
    }

    struct Host(tokio::sync::watch::Sender<u64>);
    #[async_trait]
    impl mixdog_core_config::tool_modules::ToolModulesHost for Host {
        async fn external(&self) -> mixdog_core_config::tool_modules::External {
            mixdog_core_config::tool_modules::External {
                embedding_info: Value::Null,
                onnx_supported: false,
                git_available: false,
                local_provider: Value::Null,
                installation_command_error: None,
                effort_judge: mixdog_core_config::tool_modules::EffortJudgeState {
                    available: false,
                    installing: false,
                    ready: false,
                    last_error: Value::Null,
                    info: Value::Null,
                },
            }
        }
        fn changes(&self) -> tokio::sync::watch::Receiver<u64> {
            self.0.subscribe()
        }
        async fn prepare_builtin_feature(&self, _: &str, _: Option<&[String]>) -> Result<(), String> {
            Ok(())
        }
        async fn stop_local_provider_server(&self) {}
        async fn sync_local_provider_registry(&self, _: bool) {}
        async fn shutdown_effort_judge(&self) {}
        fn invalidate_context_status_cache(&self) {}
        fn invalidate_pre_session_tool_surface(&self) {}
    }

    async fn call(service: &Arc<dyn DomainService>, method: &'static str, params: Value) -> Value {
        let request = mixdog_core_api::CoreRequest {
            method: mixdog_core_api::ids::Method(method),
            params,
            op: None,
            ctx: mixdog_core_api::CallContext::internal("compose_mcp test"),
        };
        match service.call(request).await.unwrap() {
            mixdog_core_api::Reply::Value(value) => value,
            mixdog_core_api::Reply::Subscribe(_) => panic!("{method} subscribed"),
        }
    }

    /// The composition over a temp data dir, with `surface` as the session layer.
    struct Composed {
        composed: McpComposed,
        extensions: Arc<crate::compose_domains::ConfigExtensions>,
        dir: tempfile::TempDir,
        data: PathBuf,
    }

    async fn compose_over(surface: Arc<dyn McpSurface>) -> Composed {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        std::fs::create_dir_all(&data).unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let publisher = Arc::new(mixdog_core_api::mock::MockStatePublisher::default());
        let (config, _) = Config::open(
            data.join("mixdog-config.json"),
            publisher.clone(),
            mixdog_core_config::config::ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io },
        )
        .await
        .unwrap();
        let env: EnvReader = Arc::new(|_| None);
        let tool_modules = ToolModules::new(
            config.clone(),
            Arc::new(Host(tokio::sync::watch::channel(0).0)),
            publisher,
            mixdog_rt::CancellationToken::new(),
        );
        let hub = McpHub::new(
            mixdog_mcp::server::McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io },
            data.join("tool-results"),
            mixdog_mcp::result::OutputPolicy::default(),
        );
        let quiet = Arc::new(Quiet);
        let late = LateExtensionHost::new();
        let agents = build_agents(
            &tokens,
            &config,
            &dir.path().join("package"),
            &data,
            &dir.path().join("tasks"),
            AgentSeams {
                evidence: quiet.clone(),
                effects: quiet.clone(),
                main_route: Arc::new(|| Value::Null),
                now: Arc::new(|| "2026-01-01T00:00:00.000Z".into()),
            },
        );
        let extensions = Arc::new(crate::compose_domains::ConfigExtensions::new(config.clone()));
        let composed = mcp_services(McpInputs {
            tokens,
            data_dir: data.clone(),
            package_root: dir.path().join("package"),
            home: dir.path().join("home"),
            process_env: Env::default(),
            env,
            hub,
            config: config.clone(),
            tool_modules,
            extensions: extensions.clone(),
            extension_host: late,
            plugins: Arc::new(mixdog_core_api::mock::MockDomain::serving(&[])),
            workflow: Arc::new(mixdog_core_api::mock::MockDomain::serving(&[])),
            secret_store: Arc::new(Memory(Default::default())),
            verifier: quiet.clone(),
            surface,
            bridges: quiet.clone(),
            hooks: quiet.clone(),
            hook_observer: quiet.clone(),
            skills_watch: Arc::new(SkillsWatch::new()),
            git: quiet.clone(),
            announce: Arc::new(|| {}),
            settings_effects: quiet.clone(),
            agents,
            setup: SetupSeams {
                sessions: quiet.clone(),
                heartbeat: HeartbeatSessions::new(),
                runs: quiet.clone(),
                facts: quiet.clone(),
                desktop: quiet.clone(),
                voice: quiet.clone(),
                automation: quiet,
                other_actions: Vec::new(),
                other_status: Vec::new(),
            },
        });
        Composed { composed, extensions, dir, data }
    }

    /// The composition over a temp data dir: every `mcp/*`, `connector/*` and `skills/*` method
    /// resolves to a real service, each served by exactly one, and a call reaches the data dir.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_services_serve_their_methods_over_a_temp_data_dir() {
        let Composed { composed, dir, data, .. } = compose_over(Arc::new(Quiet)).await;
        let mut served: Vec<&str> = composed.services.iter().flat_map(|s| s.methods().iter().copied()).collect();
        let total = served.len();
        served.sort_unstable();
        served.dedup();
        assert_eq!(served.len(), total, "a method is served twice");
        for prefix in ["mcp/", "connector/", "skills/"] {
            assert!(served.iter().any(|m| m.starts_with(prefix)), "no {prefix} method is served");
        }
        let owner = |method: &str| composed.services.iter().find(|s| s.methods().contains(&method)).unwrap().clone();

        std::fs::create_dir_all(data.join("skills").join("alpha")).unwrap();
        std::fs::write(data.join("skills").join("alpha").join("SKILL.md"), "---\nname: alpha\ndescription: Use when testing.\n---\n\nbody\n").unwrap();
        let status = call(&owner("skills/skillsStatus"), "skills/skillsStatus", serde_json::json!({})).await;
        assert!(status.to_string().contains("alpha"), "{status}");
        let mcp = call(&owner("mcp/mcpStatus"), "mcp/mcpStatus", serde_json::json!({})).await;
        assert!(mcp.is_object(), "{mcp}");
        let tools = call(&owner("connector/listConnectorTools"), "connector/listConnectorTools", serde_json::json!({"connectorId": "nope"})).await;
        assert!(tools.is_array() || tools.is_object(), "{tools}");
    }

    /// A session layer that knows which scope each thread's stored header names.
    struct Headers(std::sync::Mutex<std::collections::HashMap<String, String>>);

    impl Headers {
        fn of(pairs: &[(&str, &str)]) -> Self {
            Self(std::sync::Mutex::new(pairs.iter().map(|(thread, scope)| ((*thread).to_owned(), (*scope).to_owned())).collect()))
        }
    }

    #[async_trait]
    impl McpSurface for Headers {
        async fn current_cwd(&self, thread: Option<&str>) -> Result<PathBuf, String> {
            Quiet.current_cwd(thread).await
        }
        async fn thread_scope(&self, thread: &str) -> Result<Option<String>, String> {
            Ok(self.0.lock().unwrap().get(thread).cloned())
        }
        async fn refresh_surface(&self) {}
        async fn tool_names(&self) -> Result<Vec<String>, String> {
            Ok(Vec::new())
        }
        fn open_browser(&self, _: &str) {}
        fn announce_plugins(&self) {}
        async fn flush_skills_save(&self) {}
    }

    /// A management call made on a child thread reads the scope the child inherited from the session
    /// that spawned it (`spawn-plan.mjs:108`; the child's header names its parent's scope), not only the
    /// scope its own session opened: the status of the parent's servers is the same through either thread,
    /// a thread whose header names no scope reads nothing live, a request with no thread reads the runtime's own scope, and
    /// once the parent's close releases the scope the child reads nothing either.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_management_call_on_a_child_thread_reads_the_scope_it_inherited() {
        use mixdog_mcp::mcp_glue::McpScopes;
        let surface = Arc::new(Headers::of(&[("lead", "s1"), ("child", "s1")]));
        let Composed { composed, extensions, dir, .. } = compose_over(surface).await;
        // A server whose command does not exist: it is registered under the scope it was connected for and fails there.
        let mut agent = extensions.agent();
        agent.insert("mcpServers".to_owned(), serde_json::json!({"ghost": {"command": "mixdog-no-such-server-binary"}}));
        extensions.save_agent(&extensions.agent(), &agent).await.unwrap();
        composed.glue.open("s1", "lead", dir.path()).await.unwrap();
        // The runtime scope connects at boot, whatever the sessions do.
        composed.glue.connect_runtime_scope().await.unwrap();

        let status_of = |thread: Option<&'static str>| {
            let service = composed.mcp_domain.clone();
            async move {
                let params = thread.map_or_else(|| serde_json::json!({}), |thread| serde_json::json!({"threadId": thread}));
                let status = call(&service, "mcp/mcpStatus", params).await;
                let rows = status["servers"].as_array().unwrap().clone();
                rows.iter().find(|row| row["name"] == "ghost").map(|row| row["status"].clone())
            }
        };
        assert_eq!(status_of(Some("lead")).await, Some(serde_json::json!("failed")), "the owner reads its scope");
        assert_eq!(status_of(Some("child")).await, Some(serde_json::json!("failed")), "the child reads its parent's scope");
        assert_eq!(status_of(Some("stranger")).await, Some(serde_json::json!("disconnected")), "a thread whose header names no scope reads nothing live");
        // A request naming no thread reads the runtime's own scope, connected at boot with the same configured servers.
        assert_eq!(status_of(None).await, Some(serde_json::json!("failed")), "a thread-less read uses the runtime's scope, never nothing");
        composed.glue.release("lead");
        assert_eq!(status_of(Some("child")).await, Some(serde_json::json!("disconnected")), "the parent's release leaves the child nothing");
    }
    /// The boot starts the runtime scope in the background and does not wait for it: a thread-less read that
    /// follows finds it connected (`scope_of_request(None)` waits for the first connect), and starting
    /// it again starts no second connection set.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_boot_starts_the_runtime_scope_and_a_read_finds_it_connected() {
        let Composed { composed, extensions, .. } = compose_over(Arc::new(Quiet)).await;
        let mut agent = extensions.agent();
        agent.insert("mcpServers".to_owned(), serde_json::json!({"ghost": {"command": "mixdog-no-such-server-binary"}}));
        extensions.save_agent(&extensions.agent(), &agent).await.unwrap();
        let hub = composed.glue.hub();
        let started = composed.glue.start_runtime_scope();
        started.await.unwrap();
        assert_eq!(hub.servers_in(hub.runtime_scope()).len(), 1, "the boot connected the configured server");
        composed.glue.start_runtime_scope().await.unwrap();
        assert_eq!(hub.servers_in(hub.runtime_scope()).len(), 1, "a second start opens no second connection set");
        let status = call(&composed.mcp_domain, "mcp/mcpStatus", serde_json::json!({})).await;
        assert_eq!(status["servers"][0]["status"], "failed", "a read with no session reads the runtime scope");
    }
    /// The control thread (`thread/start{kind:"control"}`) is seeded in the runtime scope, so a call
    /// naming it and a call naming no thread read the same servers of the same scope, and no second
    /// connection set exists besides the runtime scope and the sessions' own.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_control_thread_and_a_thread_less_read_share_the_runtime_scope() {
        use mixdog_mcp::mcp_glue::McpScopes;
        let surface = Arc::new(Headers::of(&[("lead", "s1")]));
        let Composed { composed, extensions, dir, .. } = compose_over(surface.clone()).await;
        let mut agent = extensions.agent();
        agent.insert("mcpServers".to_owned(), serde_json::json!({"ghost": {"command": "mixdog-no-such-server-binary"}}));
        extensions.save_agent(&extensions.agent(), &agent).await.unwrap();
        composed.glue.connect_runtime_scope().await.unwrap();
        let runtime_scope = composed.glue.hub().runtime_scope().to_owned();
        // The control thread's header names the runtime scope (`LeadSurfaceHost::seed_control`).
        surface.0.lock().unwrap().insert("control".to_owned(), runtime_scope.clone());
        composed.glue.open("s1", "lead", dir.path()).await.unwrap();

        let rows = |params: Value| {
            let service = composed.mcp_domain.clone();
            async move { call(&service, "mcp/mcpStatus", params).await["servers"].clone() }
        };
        let thread_less = rows(serde_json::json!({})).await;
        let control = rows(serde_json::json!({"threadId": "control"})).await;
        assert_eq!(control, thread_less, "the control thread reads what a thread-less call reads");
        assert_eq!(thread_less[0]["status"], "failed");
        // One connection set for both: the hub has exactly the runtime scope's server, plus the one session's.
        let hub = composed.glue.hub();
        assert_eq!(hub.servers_in(&runtime_scope).len(), 1);
        assert_eq!(hub.servers_in("s1").len(), 1);
        // Closing the control thread releases nothing.
        composed.glue.release("control");
        assert_eq!(rows(serde_json::json!({})).await[0]["status"], "failed");
        assert_eq!(hub.servers_in(&runtime_scope).len(), 1);
    }
    /// `tests/golden/skilllist.json` (recorded from Node by `skilllist.mjs`): the skill list of a
    /// sample setup, every row and what a session offers at three folders under two configs.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_skill_list_is_the_one_node_produces_for_the_sample_setup() {
        let golden: Value = serde_json::from_str(include_str!("../tests/golden/skilllist.json")).unwrap();
        let tokens = mixdog_rt::testing::tokens();
        for (index, config) in golden["configs"].as_array().unwrap().iter().enumerate() {
            let dir = tempfile::tempdir().unwrap();
            let base = dir.path().to_string_lossy().replace('\\', "/");
            let sub = |text: &str| text.replace("{base}", &base);
            for (rel, text) in golden["fixtures"].as_object().unwrap() {
                let path = dir.path().join(rel);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(path, sub(text.as_str().unwrap())).unwrap();
            }
            for folder in ["proj1/sub", "proj2", "elsewhere"] {
                std::fs::create_dir_all(dir.path().join(folder)).unwrap();
            }
            let Value::Object(agent) = serde_json::from_str::<Value>(&sub(&config["agent"].to_string())).unwrap() else { unreachable!() };
            let data = dir.path().join("data");
            let admin = Arc::new(PluginAdmin::new(data.clone(), Arc::new(Quiet), Arc::new(|| {})));
            let reader: EnvReader = Arc::new(|_| None);
            let settings: Arc<dyn SkillSettingsSource> = Arc::new(ConfigSkillSettings::new(Arc::new(Doc(agent)), reader, Arc::new(Bridges(&[]))));
            let catalog = SkillCatalog::new(
                data,
                tokens.maintenance_io,
                McpGlue::skill_roots(admin, dir.path().join("package").join("defaults")),
                settings,
                &SkillsWatch::new(),
            );
            let expected = &golden["results"][index];
            let rows: Vec<Value> = catalog
                .skills()
                .await
                .unwrap()
                .iter()
                .map(|s| {
                    serde_json::json!({
                        "name": s.name, "description": s.description, "whenToUse": s.when_to_use,
                        "path": s.file_path.to_string_lossy().replace('\\', "/").replace(&base, "{base}"),
                        "source": format!("{:?}", s.source).to_lowercase(),
                        "plugin": s.plugin, "requires": s.requires,
                    })
                })
                .collect();
            assert_eq!(Value::Array(rows), expected["all"], "config {}", config["name"]);
            for (key, folder) in [("inProj1", "proj1/sub"), ("inProj2", "proj2"), ("elsewhere", "elsewhere")] {
                let names: Vec<String> = catalog.visible(&dir.path().join(folder)).await.unwrap().into_iter().map(|s| s.name).collect();
                assert_eq!(serde_json::json!(names), expected["visible"][key], "config {} at {key}", config["name"]);
            }
        }
    }

    #[test]
    fn visualize_needs_its_module_on_as_well_as_the_bridge() {
        let off = settings(serde_json::json!({"modules": {"visualize": {"enabled": false}}}), &[], &["visualize"]);
        assert!(!off.gate.active_features.contains("visualize"));
        let on = settings(serde_json::json!({}), &[], &["visualize"]);
        assert!(on.gate.active_features.contains("visualize"));
    }
}

