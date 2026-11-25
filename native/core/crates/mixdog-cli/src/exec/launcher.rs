//! The exec's own core: composed in this process on the pristine root and reached over the in-process
//! connector, as `createHeadlessSessionRuntime` creates the session runtime inside the exec's own Node process.

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_acp::preset::AgentPreset;
use mixdog_app_server_client::api::CallOptions;
use mixdog_app_server_client::api::ClientError;
use mixdog_app_server_client::api::ClientEvent;
use mixdog_app_server_client::api::ClientInfo;
use mixdog_app_server_client::api::ConnectOptions;
use mixdog_app_server_client::api::ConnectionStatus;
use mixdog_app_server_client::api::ErrorData;
use mixdog_app_server_client::api::ProtocolClient;
use mixdog_app_server_client::api::ResumeWindow;
use mixdog_app_server_client::api::Target;
use mixdog_app_server_client::api::ThreadId;
use mixdog_app_server_client::api::ThreadReducer;
use mixdog_app_server_daemon::compose::ComposeConfig;
use mixdog_app_server_daemon::compose::ComposedCore;
use mixdog_app_server_daemon::compose::JsRuntime;
use mixdog_app_server_daemon::server::Shutdown;
use mixdog_core_api::domain::ownership::FenceReason;
use mixdog_core_api::domain::ownership::Ownership;
use mixdog_rt::Backend;
use mixdog_rt::LaneTokens;
use mixdog_rt::TaskClass;
use mixdog_rt::exec::Executors;
use mixdog_services::effort_judge::model::OrtRuntime;
use serde_json::Value;

use super::boundary::Boundary;
use super::boundary::HostCredentials;
use super::seams::CoreLauncher;
use super::seams::CoreSession;

/// The pristine root is the run's own temp folder: no other core shares it, so there is no lock to lose.
struct PrivateRoot(String);

impl Ownership for PrivateRoot {
    fn instance_id(&self) -> &str {
        &self.0
    }
    fn revalidate(&self) -> Result<(), FenceReason> {
        Ok(())
    }
}

/// The host's credentials for the run's providers (the Lead's and every route profile's), read before the run's
/// environment is scrubbed.
pub struct ResolvedCredentials {
    by_provider: HashMap<String, (Option<String>, Option<PathBuf>)>,
}

impl ResolvedCredentials {
    /// `getAgentApiKey(provider)` (its environment names, then its keychain entry) and the credential file of the account
    /// the host's pool has selected (`providerAccountPath(provider, currentProviderAccountId(provider))`), for each provider.
    pub async fn read(tokens: &LaneTokens, providers: &[String], host_data_dir: &Path) -> Self {
        let vault = Arc::new(mixdog_core::run_host::vault::KeychainVault::open(tokens.durability_io, host_data_dir));
        let keys = mixdog_ai::registry::keys::ApiKeyStore::new(vault, Arc::new(mixdog_ai::registry::keys::ProcessEnv), false);
        let accounts = mixdog_ai::accounts::AccountStore::new(
            host_data_dir.to_path_buf(),
            mixdog_ai::oauth::CredentialIo { read: tokens.interactive_io, write: tokens.durability_io },
        );
        let mut by_provider = HashMap::new();
        for provider in providers {
            let api_key = keys.get(provider).await.ok().flatten();
            let pool_credential = match accounts.current_provider_account_id(provider).await {
                Ok(id) => accounts.account_path(provider, &id).ok().flatten(),
                Err(_) => None,
            };
            by_provider.insert(provider.clone(), (api_key, pool_credential));
        }
        Self { by_provider }
    }
}

impl HostCredentials for ResolvedCredentials {
    fn api_key(&self, provider: &str) -> Option<String> {
        self.by_provider.get(provider).and_then(|(key, _)| key.clone())
    }
    fn pool_credential(&self, provider: &str, _host_data_dir: &Path) -> Option<PathBuf> {
        self.by_provider.get(provider).and_then(|(_, path)| path.clone())
    }
}

/// Composes the exec's core on the executors this process booted, over the install's JS runtime and ONNX Runtime.
pub struct InProcessLauncher {
    executors: Arc<Executors>,
    tokens: LaneTokens,
    install: std::sync::Mutex<Option<(JsRuntime, OrtRuntime)>>,
    agent_presets: Vec<AgentPreset>,
    /// The host's own folder of the ACP agents: the builds the app installed and the sign-ins it keeps.
    acp_data_dir: PathBuf,
}

impl InProcessLauncher {
    /// `agent_presets` without their upkeep: a one-shot run neither installs nor updates an agent, which stays the app's to
    /// keep current. Its check still finds a CLI where the installer puts it, and a registry agent's build and sign-in in
    /// the host's data folder `host_data_dir`.
    pub fn new(
        executors: Arc<Executors>,
        tokens: LaneTokens,
        js_runtime: JsRuntime,
        ort_library: OrtRuntime,
        agent_presets: Vec<AgentPreset>,
        host_data_dir: &Path,
    ) -> Self {
        let agent_presets =
            agent_presets.into_iter().map(|preset| AgentPreset { distribution: preset.distribution.without_mutations(), ..preset }).collect();
        Self {
            executors,
            tokens,
            install: std::sync::Mutex::new(Some((js_runtime, ort_library))),
            agent_presets,
            acp_data_dir: mixdog_app_server_daemon::acp_tools::acp_data_dir(host_data_dir),
        }
    }
}

/// The run's environment, as `applyPristineEnvironment` sets `process.env`: the core reads it from the process.
fn apply_env(env: &BTreeMap<String, Option<String>>) {
    for (name, value) in env {
        // SAFETY: the exec's own thread runs on a current-thread runtime and the executors' threads are idle until the core
        // is composed below: no thread reads the environment while it changes.
        unsafe {
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
    }
}

/// What the run establishes for the core it composes in this process, which a daemon never does: the judge folder of the
/// run's `MIXDOG_EFFORT_JUDGE_DIR`, and the Lead's delegation when the route profile gives agent roles routes.
pub(super) fn bind_exec_core(boundary: &Boundary) {
    if let Some(Some(dir)) = boundary.env.get("MIXDOG_EFFORT_JUDGE_DIR").filter(|dir| dir.as_deref().is_some_and(|dir| !dir.is_empty())) {
        mixdog_services::effort_judge::model::bind_exec_judge_dir(PathBuf::from(dir));
    }
    if super::run::delegates(boundary) {
        mixdog_core_session::session::session_options::grant_exec_headless_delegation();
    }
}

#[async_trait]
impl CoreLauncher for InProcessLauncher {
    fn agent_presets(&self) -> &[AgentPreset] {
        &self.agent_presets
    }

    async fn launch(&self, boundary: &Boundary, feed: Arc<dyn ThreadReducer>) -> Result<Arc<dyn CoreSession>, String> {
        apply_env(&boundary.env);
        bind_exec_core(boundary);
        // The run's providers' credentials are bound in process and never named in the environment tools see
        // (`replaceProviderAuthBindings`, and the API keys the runtime config carries in memory).
        let keys: HashMap<String, String> = boundary.runtime_config["providers"]
            .as_object()
            .into_iter()
            .flatten()
            .filter_map(|(provider, entry)| entry["apiKey"].as_str().map(|key| (provider.clone(), key.to_owned())))
            .collect();
        if !keys.is_empty() {
            // The run is the process: the binding is never restored.
            let _ = mixdog_ai::registry::keys::replace_provider_api_key_bindings(keys);
        }
        let bindings: HashMap<String, String> = boundary
            .credential
            .iter()
            .chain(&boundary.role_credentials)
            .map(|binding| (binding.provider.clone(), binding.path.to_string_lossy().into_owned()))
            .collect();
        if !bindings.is_empty() {
            let _ = mixdog_ai::accounts::replace_provider_auth_bindings(bindings);
        }
        let (js_runtime, ort_library) =
            self.install.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take().ok_or("the exec's core was already launched")?;
        let data_dir = boundary.data_dir.clone();
        let stop = mixdog_rt::CancellationToken::new();
        // The exec's stderr is program output: the core's log lines (connection open/close among them) go to its own log file, as the
        // daemon's do from ready on, never to the terminal.
        let log = mixdog_app_server_daemon::daemon_log::DaemonLog::new(data_dir.join("daemon.log"), self.tokens.maintenance_io, stop.clone());
        log.enable_file_logging();
        let outgoing = mixdog_app_server::Outgoing::new();
        let config = ComposeConfig {
            rebuild: Default::default(),
            user_data_dir: data_dir.join("userdata"),
            // The exec's private runtime root (boundary.rs): no remote intent of the user's own core is read or written.
            runtime_root: boundary.runtime_root.clone(),
            log,
            data_dir,
            js_runtime,
            ort_library,
            outgoing: outgoing.clone(),
            ownership: Arc::new(PrivateRoot(format!("exec-{}", uuid::Uuid::new_v4().simple()))),
            stop,
            catalog_http: mixdog_app_server_daemon::catalog::production_http().map_err(|error| error.to_string())?,
            agent_presets: self.agent_presets.clone(),
            acp_data_dir: Some(self.acp_data_dir.clone()),
        };
        // Composed inside the executors, as the daemon composes its core: every ambient handle lands on them.
        let tokens = self.tokens.clone();
        let core = self
            .executors
            .handle(TaskClass::Work)
            .spawn(async move { mixdog_app_server_daemon::compose::compose(&tokens, config).await.map_err(|error| error.to_string()) })
            .await
            .map_err(|error| error.to_string())??;
        // Before the first request: the lifecycle counts the exec's calls as the daemon's counts its own.
        core.late_lifecycle().bind_in_process().map_err(|cell| format!("the {cell} was already bound"))?;
        let core = Arc::new(core);
        let (connector, shutdown) = mixdog_app_server_daemon::server::serve_in_process(core.clone(), outgoing).map_err(|error| format!("{error:?}"))?;
        let info: ClientInfo = serde_json::from_value(serde_json::json!({ "name": "mixdog-exec", "version": env!("CARGO_PKG_VERSION"), "kind": "cli" }))
            .map_err(|error| error.to_string())?;
        let options = ConnectOptions { thread_reducer: Some(feed), ..ConnectOptions::new(Target { id: "in-process".into() }, connector, info) };
        let client = mixdog_app_server_client::connect(options).await.map_err(|error| error.to_string())?;
        Ok(Arc::new(InProcessSession { client, core, shutdown, tokens: self.tokens.clone() }))
    }
}

/// A refused request as the exec reports it: a domain error is the Node error the runtime threw, so its own message is the
/// line (`mixdog: ${error.message}` in `executeHeadlessPrompt`), e.g. `[provider] Failed to init "x": unknown enabled
/// provider: x` for a provider the pristine config cannot build; anything else keeps the protocol's rendering.
fn rendered(error: &ClientError) -> String {
    match error.error_data() {
        Some(ErrorData::DomainError { message: Some(message), .. }) if !message.is_empty() => message,
        _ => error.to_string(),
    }
}

struct InProcessSession {
    client: mixdog_app_server_client::engine::Client,
    core: Arc<ComposedCore>,
    shutdown: Shutdown,
    tokens: LaneTokens,
}

#[async_trait]
impl CoreSession for InProcessSession {
    /// A started thread's feed is attached before the call returns: the client folds a thread's notifications only after its
    /// snapshot, and the exec's observations (`ExecLifecycle`'s callbacks in Node) all ride that feed. Header-only: the run
    /// needs the live events, not past turns.
    async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let result = self.client.call_raw(method, params, CallOptions::default()).await.map_err(|error| rendered(&error))?;
        if method == "thread/start" {
            let thread_id = result["thread"]["id"].as_str().ok_or("thread/start answered without a thread id")?;
            self.client.resume_thread(&ThreadId::from(thread_id), ResumeWindow::None { none: true }).await.map_err(|error| rendered(&error))?;
        }
        Ok(result)
    }

    async fn lost(&self) -> String {
        let mut events = self.client.events();
        loop {
            if let ConnectionStatus::Closed { reason } = self.client.status() {
                return reason.to_string();
            }
            match events.recv().await {
                Ok(ClientEvent::Status(ConnectionStatus::Closed { reason })) => return reason.to_string(),
                Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return "the connection to the core closed".to_owned(),
            }
        }
    }

    /// The connection, then the core's stop (the extension host and every registered stop step, whose last one drains the agent
    /// trace and the usage rows: `headlessCleanup`'s `drainAgentTrace` and `sessionStoreDrain`), then the exit flush the release
    /// procedure runs on every path, so a stop step over its budget still leaves the trace on disk.
    async fn close(&self) -> Result<(), String> {
        self.client.close().await;
        self.shutdown.run().await;
        self.core.flush_log().await;
        // The run removes the root while this process lives on, so the core's SQLite files close here, not at the process exit.
        let core = self.core.clone();
        mixdog_rt::LaneToken::submit(self.tokens.maintenance_io, &mixdog_rt::CancellationToken::new(), move |_lane| core.close_data_files())
            .map_err(|error| format!("{error:?}"))?
            .await
            .map_err(|error| format!("{error:?}"))
    }

    /// The extension host and the core's services stopped with the core (`close`).
    async fn stop_services(&self) -> Result<(), String> {
        Ok(())
    }
}
