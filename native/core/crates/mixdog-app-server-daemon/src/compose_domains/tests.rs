//! The composition over a temp data dir: every method of the domains this file builds is served by
//! a real service, and none by `MockDomain`.

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_app_protocol::CLIENT_METHODS;
use mixdog_app_protocol::CLIENT_NOTIFICATIONS;
use mixdog_core_api::CallContext;
use mixdog_core_api::CoreError;
use mixdog_core_api::HostChannel;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::mock::MockHostChannel;
use mixdog_core_api::ops::OpScope;
use mixdog_core_base::feed::CoreScopedFeeds;
use mixdog_core_base::feed::FeedLimits;
use mixdog_core_base::ops::OpGate;
use mixdog_core_base::ops::StateOpStore;
use mixdog_core_base::ops::ThreadOpGates;
use mixdog_core_config::config::SettingsEffects;
use mixdog_core_config::tool_modules::FeatureEffects;
use mixdog_core_domains::domains::DomainsBuilder;
use mixdog_core_domains::domains::host::NotificationClicks;
use mixdog_core_domains::domains::instructions::InstructionsChanged;
use mixdog_core_ports::ports::domain_sessions::NamedAttachment;
use mixdog_core_ports::ports::domain_sessions::SessionAttachments;
use mixdog_exthost::DEFAULT_PENDING_CAP;
use mixdog_exthost::ExtHostConfig;
use mixdog_exthost::ExtHostPool;
use mixdog_exthost::RenderBrowserConfig;
use mixdog_mcp::extension_service::ExtensionHost;
use mixdog_mcp::plugin_admin::GitRunner;
use mixdog_remote::access::runtime::LegLink;
use mixdog_remote::access::runtime::RemoteEvents;
use mixdog_remote::access::runtime::RemoteRuntime;
use mixdog_remote::access::runtime::RuntimeConfig;
use mixdog_remote::access::settings::AccessSettings;
use mixdog_remote::bridge::DialError;
use mixdog_remote::bridge::Dialer;
use mixdog_remote::bridge::Upstream;
use mixdog_remote::pair_code::PairCodeEffects;
use mixdog_remote::pair_code::PairCodeView;
use mixdog_remote::registry::DeviceRegistry;
use mixdog_remote::section::RemoteSection;
use mixdog_remote::section::RemoteSectionValue;
use mixdog_services::bots::beat::HeartbeatStore;
use mixdog_services::bots::beat::UserActivity;
use mixdog_services::effort_judge::model::OrtRuntime;
use mixdog_services::import::ImportSessions;
use mixdog_services::import::ImportedSession;
use mixdog_services::media::GeneratedMedia;
use mixdog_services::media::GenerationRequest;
use mixdog_services::media::MediaFailure;
use mixdog_services::media::MediaGenerator;
use mixdog_services::media::ResolvedMedia;
use mixdog_services::voice::Missing;
use mixdog_services::voice::VoiceInstaller;
use serde_json::Value;
use serde_json::json;

use super::*;
use crate::compose::ComposeConfig;
use crate::compose::Models;
use crate::compose::compose;
use adapters::DoctorHost;
use mixdog_core_domains::domains::diagnostics::Probe;

struct Quiet;

#[async_trait]
impl SettingsEffects for Quiet {
    fn set_configured_shell(&self, _: &str) {}
    fn note_cache_warming_enabled(&self, _: bool) {}
    async fn sync_developer_option(&self, _: &str) {}
}

#[async_trait]
impl FeatureEffects for Quiet {
    async fn prepare_office_fonts(&self) {}
    async fn sync_local_provider_registry(&self, _: bool) {}
    fn invalidate_context_status_cache(&self) {}
    fn invalidate_pre_session_tool_surface(&self) {}
}

#[async_trait]
impl ImportSessions for Quiet {
    async fn imported_sessions(&self) -> Vec<(String, String)> {
        Vec::new()
    }
    async fn session_exists(&self, _: &str) -> bool {
        false
    }
    async fn prepare_lead(&self) -> Result<(), String> {
        Ok(())
    }
    async fn create_imported_session(&self, _: ImportedSession) -> Result<String, String> {
        Err("none".into())
    }
}

#[async_trait]
impl MediaGenerator for Quiet {
    async fn resolve(&self, _: &str, _: &str, _: &str) -> Result<ResolvedMedia, MediaFailure> {
        Err(MediaFailure::new("none", "none"))
    }
    async fn generate(&self, _: GenerationRequest) -> Result<GeneratedMedia, MediaFailure> {
        Err(MediaFailure::new("none", "none"))
    }
    async fn lanes(&self) -> Value {
        json!([])
    }
}

#[async_trait]
impl VoiceInstaller for Quiet {
    async fn install(&self, _: Missing) -> Result<(), String> {
        Ok(())
    }
}

#[async_trait::async_trait]
impl SessionCwds for Quiet {
    async fn cwd(&self, _: &str) -> Option<String> {
        None
    }
}

impl NotificationClicks for Quiet {
    fn clicked(&self, _: &ThreadId) {}
}

#[async_trait]
impl InstructionsChanged for Quiet {
    async fn changed(&self) {}
}

#[async_trait]
impl SessionAttachments for Quiet {
    async fn named(&self, _: &str, _: &str) -> Option<NamedAttachment> {
        None
    }
}

#[async_trait]
impl DoctorHost for Quiet {
    async fn node_runtime(&self) -> Probe {
        Ok(None)
    }
    async fn provider_setup(&self) -> Probe {
        Ok(None)
    }
    fn active_provider(&self) -> Option<String> {
        None
    }
    async fn channel_worker_status(&self) -> Probe {
        Ok(None)
    }
    async fn channel_setup(&self) -> Probe {
        Ok(None)
    }
    async fn hooks_status(&self) -> Probe {
        Ok(None)
    }
    async fn session_log_migration(&self) -> Probe {
        Ok(None)
    }
    fn bridge_active(&self, _: &str) -> bool {
        false
    }
    async fn notice(&self, _: Option<&ThreadId>, _: &str) {}
}

impl GitRunner for Quiet {
    fn run(&self, _: &[String], _: std::time::Duration) -> Result<String, String> {
        Err("no git".into())
    }
}

#[async_trait]
impl ExtensionHost for Quiet {
    async fn reconcile_plugins_and_announce(&self) {}
    async fn announce(&self, _: &str) {}
    async fn announce_without_invalidating(&self, _: &str) {}
    async fn tool_names(&self) -> Vec<String> {
        Vec::new()
    }
    async fn reconnect_mcp_and_announce(&self, _: Option<&str>, _: bool, _: &[String]) -> Value {
        json!({})
    }
    async fn reconnect_all_mcp_and_announce(&self) -> Value {
        json!({})
    }
    async fn schedule_mcp_toggle(&self, _: &str, _: bool) -> Value {
        json!({})
    }
    async fn publish_mcp_changes(&self, _: &[(String, bool)]) {}
    async fn announce_mcp_changes(&self, _: &[(String, bool)]) {}
    async fn connect_configured_mcp(&self, _: &str, _: bool) -> Value {
        json!({})
    }
    fn invalidate_skills(&self) {}
    async fn flush_skills_save(&self) {}
    async fn current_cwd(&self, _: Option<&str>) -> std::path::PathBuf {
        std::path::PathBuf::new()
    }
    async fn skills_status(&self) -> Value {
        json!({})
    }
}

struct NoDial;

#[async_trait]
impl Dialer for NoDial {
    async fn dial(&self, _: &str) -> Result<Box<dyn Upstream>, DialError> {
        Err(DialError)
    }
}

impl RemoteEvents for Quiet {
    fn controller_key_delivered(&self, _: &str) {}
    fn owed_access_changed(&self) {}
    fn status(&self, _: Value) {}
}

impl PairCodeEffects for Quiet {
    fn send(&mut self, _: Value) -> bool {
        false
    }
    fn publish(&mut self, _: Option<&PairCodeView>) {}
    fn wake_at(&mut self, _: u64) {}
}

struct NoThreads;

#[async_trait]
impl ThreadOpGates for NoThreads {
    async fn gate(&self, thread: &ThreadId, _: &CallContext) -> Result<OpGate, CoreError> {
        Err(CoreError::ThreadNotFound { thread_id: thread.clone() })
    }
}

fn remote(dir: &Path) -> Arc<RemoteRuntime> {
    Arc::new(RemoteRuntime::new(
        RuntimeConfig {
            dir: dir.to_path_buf(),
            relay_url: None,
            app_version: None,
            durability: mixdog_rt::testing::tokens().durability_io,
            dialer: Arc::new(NoDial),
            registry: Arc::new(DeviceRegistry::default()),
            section: Arc::new(RemoteSection::new(
                Arc::new(mixdog_core_api::mock::MockStatePublisher::default()),
                RemoteSectionValue::default(),
            )),
            settings: Arc::new(AccessSettings::new(dir.to_path_buf(), Arc::new(|| "PC".to_owned()))),
            link: LegLink::default(),
            events: Arc::new(Quiet),
        },
        Box::new(|_| Box::new(Quiet)),
    ))
}

/// The namespaces this composition builds services for.
const OWNED: [&str; 17] = [
    "import", "localProvider", "media", "tidy", "voice", "config", "plugins", "system", "blob", "client",
    "diagnostics", "feedback", "host", "instructions", "update", "browser", "visualize",
];

/// Methods of an owned namespace whose service another work package is still building, with the owner.
const OTHER_OWNERS: &[(&str, &str)] = &[("host/claim", "wp-compaction-world: the server owns the connection registry")];

impl mixdog_agent::compact::settings_service::CompactionHost for Quiet {
    fn route_provider(&self, _: Option<&ThreadId>) -> Option<String> {
        None
    }
    fn adopt_session_compaction(&self, _: Option<&ThreadId>, _: &serde_json::Map<String, Value>) {}
    fn invalidate_context_status(&self, _: Option<&ThreadId>) {}
    fn refresh_lead_cache_opts(&self, _: Option<&ThreadId>, _: &serde_json::Map<String, Value>) {}
}

#[async_trait]
impl mixdog_core_config::workflow::WorkflowHost for Quiet {
    async fn thread_mode_facts(&self, _: &str) -> Result<Value, CoreError> {
        Ok(Value::Null)
    }
    fn main_route(&self) -> Value {
        Value::Null
    }
    async fn adopt_lead_route(&self, _: Value) {}
    async fn custom_agent_ids(&self) -> Vec<String> {
        Vec::new()
    }
    fn provider_available(&self, _: &str) -> bool {
        false
    }
    fn require_local_provider_management(&self) -> Result<(), String> {
        Ok(())
    }
    fn normalize_stored_custom_config(&self, entry: &Value) -> Result<Value, String> {
        Ok(entry.clone())
    }
    async fn after_credential_change(&self) {}
    async fn ensure_providers_ready(&self, _: serde_json::Map<String, Value>) -> Result<(), String> {
        Ok(())
    }
    async fn lookup_model_meta(&self, _: &str, _: &str) -> Option<Value> {
        None
    }
    fn web_search_capable(&self, _: &str, _: Option<&Value>) -> bool {
        false
    }
    fn fast_capable(&self, _: &str, _: Option<&Value>, _: Option<&str>, _: Option<&Value>) -> bool {
        false
    }
    fn web_search_route_saved(&self, _: &Value) {}
}

#[async_trait]
impl SetupUiSurface for Quiet {
    async fn notify(&self, _: &ThreadId, _: &str) -> bool {
        false
    }
}

#[tokio::test(flavor = "multi_thread")]
#[allow(clippy::disallowed_methods, reason = "test setup")]
async fn every_method_of_the_domains_built_here_has_a_real_service() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let host: Arc<dyn HostChannel> = Arc::new(MockHostChannel::default());
    let js = crate::js_runtime::fixture(dir.path());
    let policy = mixdog_ai::netproxy::NetworkProxy::new(
        Arc::new(mixdog_ai::netproxy::route::ProcessEnv),
        mixdog_ai::netproxy::system::SystemProxy::default(),
    );
    let clients = Arc::new(mixdog_ai::netproxy::clients::RoutedClients::new(policy.clone(), |_| {
        reqwest::Client::builder().build()
    }));
    // The shipped manifest the voice service reads from the package.
    let manifests = js.package_root.join("src").join("runtime").join("channels").join("data");
    std::fs::create_dir_all(&manifests).unwrap();
    std::fs::write(js.package_root.join("package.json"), r#"{"name":"mixdog","version":"1.4.5"}"#).unwrap();
    std::fs::write(
        manifests.join("voice-runtime-manifest.json"),
        include_str!("../../../../../../src/runtime/channels/data/voice-runtime-manifest.json"),
    )
    .unwrap();
    let core = compose(
        &tokens,
        ComposeConfig {
            data_dir: dir.path().to_path_buf(),
            user_data_dir: dir.path().join("userdata"),
            js_runtime: crate::js_runtime::fixture(dir.path()),
            ort_library: OrtRuntime::NoBinding,
            host: host.clone(),
        },
    )
    .await
    .unwrap();
    let ext_host = Arc::new(
        ExtHostPool::new(ExtHostConfig {
            program: js.program.clone(),
            args: vec![js.package_root.join("src").join("ext-host").join("worker.mjs").into_os_string()],
            electron: js.electron,
            workers: 1,
            pending_cap: DEFAULT_PENDING_CAP,
            spawn_io: tokens.spawn_io,
            render_browser: RenderBrowserConfig {
                command: None,
                profile_root: dir.path().join("render-browser"),
                no_sandbox: false,
            },
        })
        .unwrap(),
    );
    let (state, _) = mixdog_store::state::CoreState::open(
        tokens.sqlite_writer_thread,
        tokens.interactive_io,
        &dir.path().join("gates.sqlite"),
    )
    .unwrap();
    let mut gates = Vec::new();
    for scope in OP_SCOPES {
        let store = Arc::new(StateOpStore::new(state.clone(), scope.into()));
        gates.push((scope, OpGate::domain(OpScope::Domain(scope.into()), store).await.unwrap()));
    }
    let quiet = Arc::new(Quiet);
    let models = core.models();
    let app_feed = core.app_feed_core().clone();
    let state = Arc::new(mixdog_core_base::state::StateRuntime::new(app_feed.clone()));
    let (config, _) = mixdog_core_config::config::Config::open(
        dir.path().join("mixdog-config.json"),
        state.publisher.clone(),
        mixdog_core_config::config::ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io },
    )
    .await
    .unwrap();
    let inputs = DomainInputs {
        tokens,
        paths: DomainPaths {
            data_dir: dir.path().to_path_buf(),
            user_data_dir: dir.path().join("userdata"),
            package_root: js.package_root.clone(),
            node: js.program.clone(),
            electron: js.electron,
        },
        env: Arc::new(|_| None),
        app_feed,
        state,
        config,
        scoped_feeds: Arc::new(CoreScopedFeeds::new(
            FeedLimits { ring_bytes: 1 << 20, max_snapshot_bytes: 1 << 20 },
            tokens.cpu_interactive,
        )),
        host,
        ext_host,
        processes: core.tidy_processes().clone(),
        catalog: core.catalog().service().clone(),
        models: Models {
            tick: models.tick.clone(),
            embeddings: models.embeddings.clone(),
            effort_judge: models.effort_judge.clone(),
        },
        scopes: OpScopeSource::new(gates, Arc::new(NoThreads)),
        limits: Default::default(),
        cancel: CancellationToken::new(),
        seams: DomainSeams {
            settings_effects: quiet.clone(),
            feature_effects: quiet.clone(),
            local: LocalSeams {
                import_sessions: quiet.clone(),
                media_generator: quiet.clone(),
                voice_installer: quiet.clone(),
            },
            user_activity: UserActivity::new(
                HeartbeatStore::new(mixdog_services::bots::state_json::StateJson::new(
                    dir.path().join("heartbeat.json"),
                    tokens.durability_io,
                )),
                Arc::new(mixdog_services::scheduler::SystemClock),
            ),
            remote: remote(&dir.path().join("remote")),
            local_target: Arc::new(NoDial),
            notification_clicks: quiet.clone(),
            instructions_changed: quiet.clone(),
            session_attachments: quiet.clone(),
            system_proxy: Arc::new(mixdog_ai::netproxy::system::SystemProxy::default()),
            doctor: quiet.clone(),
            plugins: PluginSeams { host: quiet.clone(), git: quiet.clone(), announce: Arc::new(|| {}) },
            setup_ui: quiet.clone(),
            network_proxy: policy,
            routed_clients: clients,
            session_cwds: quiet.clone(),
            compaction_host: quiet.clone(),
            workflow_host: quiet.clone(),
        },
    };
    let composed = compose_domains(inputs).await.unwrap();
    // The one local provider is returned for the process inputs; the local-provider service holds the other handle.
    assert!(Arc::strong_count(&composed.local_provider) >= 2);
    // The methods of these services are other owners' (see `OTHER_OWNERS`); all else is here.
    let mut builder = DomainsBuilder::new();
    for service in &composed.services {
        builder.register(service.clone()).unwrap();
    }
    let unclaimed = builder.unclaimed();
    let table = CLIENT_METHODS.iter().map(|spec| spec.method).chain(CLIENT_NOTIFICATIONS.iter().map(|spec| spec.method));
    let missing: Vec<&str> = table
        .filter(|method| OWNED.contains(&method.split('/').next().unwrap()))
        .filter(|method| unclaimed.contains(method))
        .filter(|method| !OTHER_OWNERS.iter().any(|(name, _)| name == method))
        .collect();
    assert!(missing.is_empty(), "owned methods without a service: {missing:?}");
}