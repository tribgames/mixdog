//! The exec's own core: composed in this process on the pristine root and reached over the in-process
//! connector, as `createHeadlessSessionRuntime` creates the session runtime inside the exec's own Node process.

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_app_server_client::api::CallOptions;
use mixdog_app_server_client::api::ClientEvent;
use mixdog_app_server_client::api::ClientInfo;
use mixdog_app_server_client::api::ConnectOptions;
use mixdog_app_server_client::api::ConnectionStatus;
use mixdog_app_server_client::api::ProtocolClient;
use mixdog_app_server_client::api::ResumeWindow;
use mixdog_app_server_client::api::Target;
use mixdog_app_server_client::api::ThreadId;
use mixdog_app_server_client::api::ThreadReducer;
use mixdog_app_server_daemon::compose::ComposeConfig;
use mixdog_app_server_daemon::compose::ComposedCore;
use mixdog_app_server_daemon::compose::JsRuntime;
use mixdog_services::effort_judge::model::OrtRuntime;
use mixdog_app_server_daemon::server::Shutdown;
use mixdog_core_api::domain::ownership::FenceReason;
use mixdog_core_api::domain::ownership::Ownership;
use mixdog_rt::Backend;
use mixdog_rt::LaneTokens;
use mixdog_rt::TaskClass;
use mixdog_rt::exec::Executors;
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

/// The host's credentials for the selected provider, read before the run's environment is scrubbed.
pub struct ResolvedCredentials {
    pub api_key: Option<String>,
    pub pool_credential: Option<PathBuf>,
}

impl ResolvedCredentials {
    /// `getAgentApiKey(provider)` (its environment names, then its keychain entry) and the credential file of the account
    /// the host's pool has selected (`providerAccountPath(provider, currentProviderAccountId(provider))`), for `provider`.
    pub async fn read(tokens: &LaneTokens, provider: &str, host_data_dir: &Path) -> Self {
        let vault = Arc::new(mixdog_core::run_host::vault::KeychainVault::open(tokens.durability_io, host_data_dir));
        let keys = mixdog_ai::registry::keys::ApiKeyStore::new(vault, Arc::new(mixdog_ai::registry::keys::ProcessEnv), false);
        let api_key = keys.get(provider).await.ok().flatten();
        let accounts = mixdog_ai::accounts::AccountStore::new(
            host_data_dir.to_path_buf(),
            mixdog_ai::oauth::CredentialIo { read: tokens.interactive_io, write: tokens.durability_io },
        );
        let pool_credential = match accounts.current_provider_account_id(provider).await {
            Ok(id) => accounts.account_path(provider, &id).ok().flatten(),
            Err(_) => None,
        };
        Self { api_key, pool_credential }
    }
}

impl HostCredentials for ResolvedCredentials {
    fn api_key(&self, _provider: &str) -> Option<String> {
        self.api_key.clone()
    }
    fn pool_credential(&self, _provider: &str, _host_data_dir: &Path) -> Option<PathBuf> {
        self.pool_credential.clone()
    }
}

/// Composes the exec's core on the executors this process booted, over the install's JS runtime and ONNX Runtime.
pub struct InProcessLauncher {
    executors: Arc<Executors>,
    tokens: LaneTokens,
    install: std::sync::Mutex<Option<(JsRuntime, OrtRuntime)>>,
}

impl InProcessLauncher {
    pub fn new(executors: Arc<Executors>, tokens: LaneTokens, js_runtime: JsRuntime, ort_library: OrtRuntime) -> Self {
        Self { executors, tokens, install: std::sync::Mutex::new(Some((js_runtime, ort_library))) }
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

#[async_trait]
impl CoreLauncher for InProcessLauncher {
    async fn launch(&self, boundary: &Boundary, feed: Arc<dyn ThreadReducer>) -> Result<Arc<dyn CoreSession>, String> {
        apply_env(&boundary.env);
        // The selected provider's credentials are bound in process and never named in the environment tools see
        // (`replaceProviderAuthBindings`, and the API key the runtime config carries in memory).
        let provider = boundary.runtime_config["providers"].as_object().and_then(|providers| providers.keys().next().cloned()).unwrap_or_default();
        if let Some(key) = boundary.runtime_config["providers"][&provider]["apiKey"].as_str() {
            // The run is the process: the binding is never restored.
            let _ = mixdog_ai::registry::keys::replace_provider_api_key_bindings(HashMap::from([(provider.clone(), key.to_owned())]));
        }
        if let Some(binding) = &boundary.credential {
            let _ = mixdog_ai::accounts::replace_provider_auth_bindings(HashMap::from([(binding.provider.clone(), binding.path.to_string_lossy().into_owned())]));
        }
        let (js_runtime, ort_library) = self.install.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take().ok_or("the exec's core was already launched")?;
        let data_dir = boundary.data_dir.clone();
        let stop = mixdog_rt::CancellationToken::new();
        let outgoing = mixdog_app_server::Outgoing::new();
        let config = ComposeConfig {
            user_data_dir: data_dir.join("userdata"),
            log: mixdog_app_server_daemon::daemon_log::DaemonLog::new(data_dir.join("daemon.log"), self.tokens.maintenance_io, stop.clone()),
            data_dir,
            js_runtime,
            ort_library,
            outgoing: outgoing.clone(),
            ownership: Arc::new(PrivateRoot(format!("exec-{}", uuid::Uuid::new_v4().simple()))),
            stop,
            catalog_http: mixdog_app_server_daemon::catalog::production_http().map_err(|error| error.to_string())?,
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
        let info: ClientInfo = serde_json::from_value(serde_json::json!({ "name": "mixdog-exec", "version": env!("CARGO_PKG_VERSION"), "kind": "cli" })).map_err(|error| error.to_string())?;
        let options = ConnectOptions { thread_reducer: Some(feed), ..ConnectOptions::new(Target { id: "in-process".into() }, connector, info) };
        let client = mixdog_app_server_client::connect(options).await.map_err(|error| error.to_string())?;
        Ok(Arc::new(InProcessSession { client, core, shutdown }))
    }
}

struct InProcessSession {
    client: mixdog_app_server_client::engine::Client,
    core: Arc<ComposedCore>,
    shutdown: Shutdown,
}

#[async_trait]
impl CoreSession for InProcessSession {
    /// A started thread's feed is attached before the call returns: the client folds a thread's notifications only after its
    /// snapshot, and the exec's observations (`ExecLifecycle`'s callbacks in Node) all ride that feed. Header-only: the run
    /// needs the live events, not past turns.
    async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let result = self.client.call_raw(method, params, CallOptions::default()).await.map_err(|error| error.to_string())?;
        if method == "thread/start" {
            let thread_id = result["thread"]["id"].as_str().ok_or("thread/start answered without a thread id")?;
            self.client
                .resume_thread(&ThreadId::from(thread_id), ResumeWindow::None { none: true })
                .await
                .map_err(|error| error.to_string())?;
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
        tokio::task::spawn_blocking(move || core.close_data_files()).await.map_err(|error| error.to_string())
    }

    /// The extension host and the core's services stopped with the core (`close`).
    async fn stop_services(&self) -> Result<(), String> {
        Ok(())
    }
}
