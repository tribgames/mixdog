//! The `toolModules` app section: the Rust port of `getToolModuleSettings()` and its setters
//! (`settings-builtin-tools-api.mjs`), with the same value (DS §3, SPEC R14).
//!
//! The value is derived from the full config and the runtime state the host reports
//! ([`ToolModulesHost`]). It is pushed whenever either changes: every setter here refreshes
//! after its write, the service follows [`Config::changes`] (so another writer or an external
//! edit pushes too), and follows the host's [`ToolModulesHost::changes`] tick (local-provider
//! installation and server status, effort-judge download, embedding readiness). A refresh
//! publishes only when the value differs from the last one published.

mod edit;
mod host;
mod value;

pub use host::FeatureEffects;
pub use host::HostParts;
pub use host::ServicesToolModulesHost;

#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "test setup reads and writes fixture files")]
mod tests;

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::state::StatePublisher;
use mixdog_protocol::SectionName;
use mixdog_rt::CancellationToken;
use mixdog_rt::TaskClass;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio::sync::watch;

use crate::config::Config;
use crate::config::ConfigError;
use crate::state::change_of;

pub use value::builtin_feature_active;
pub use value::with_grandfathered_builtins;
pub use value::EffortJudgeState;
pub use value::External;
pub use value::INSTRUCTION_FILES_MODES;
pub use value::AUTO_EFFORT_BASES;

/// `EFFORT_JUDGE_UNSUPPORTED`.
pub const EFFORT_JUDGE_UNSUPPORTED: &str =
    "Auto effort is unsupported on darwin-x64 (no onnxruntime-node binding)";

const TOGGLEABLE_BUILTINS: [&str; 7] =
    ["git", "office", "tidy", "localProvider", "autoEffort", "visualize", "media"];
const INSTALLABLE_BUILTINS: [&str; 6] =
    ["git", "memory", "office", "tidy", "localProvider", "autoEffort"];

/// What the config cannot tell and the side effects the setters trigger. The owners of the
/// local provider, the effort judge, the embedder and the session surface implement it; reads
/// run on their own lanes, which is why they are async.
#[async_trait]
pub trait ToolModulesHost: Send + Sync + 'static {
    /// The runtime state behind the value.
    async fn external(&self) -> External;

    /// Ticks when any of that state changes (local-provider status, judge download, embedder
    /// readiness). The subscription replaces the desktop's status polls.
    fn changes(&self) -> watch::Receiver<u64>;

    /// `prepareBuiltinFeature(name, options)`: model pre-download, component verification.
    async fn prepare_builtin_feature(
        &self,
        name: &str,
        engines: Option<&[String]>,
    ) -> Result<(), String>;
    async fn stop_local_provider_server(&self);
    async fn sync_local_provider_registry(&self, enabled: bool);
    async fn shutdown_effort_judge(&self);
    fn invalidate_context_status_cache(&self);
    fn invalidate_pre_session_tool_surface(&self);
}

#[derive(Debug)]
pub enum ToolModulesError {
    /// A `TypeError` of the Node setter: the argument is not one of the allowed values.
    InvalidArgument(String),
    /// The preparation or another step failed.
    Failed(String),
    Config(ConfigError),
}

impl std::fmt::Display for ToolModulesError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ToolModulesError::InvalidArgument(message) | ToolModulesError::Failed(message) => {
                f.write_str(message)
            }
            ToolModulesError::Config(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for ToolModulesError {}

impl From<ConfigError> for ToolModulesError {
    fn from(error: ConfigError) -> Self {
        ToolModulesError::Config(error)
    }
}

/// `MIXDOG_FEATURE_*` lookups.
pub type FeatureEnv = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

pub struct ToolModules {
    config: Config,
    host: Arc<dyn ToolModulesHost>,
    publisher: Arc<dyn StatePublisher>,
    env: FeatureEnv,
    /// Asks the publishing task to recompute; it answers the value.
    refreshes: mpsc::UnboundedSender<oneshot::Sender<Value>>,
}

impl ToolModules {
    /// Starts the publishing task: it publishes the current value, then again whenever the
    /// config or the host's state changes, until `cancel`.
    pub fn new(
        config: Config,
        host: Arc<dyn ToolModulesHost>,
        publisher: Arc<dyn StatePublisher>,
        cancel: CancellationToken,
    ) -> Arc<Self> {
        Self::with_env(config, host, publisher, cancel, Arc::new(|name| std::env::var(name).ok()))
    }

    /// For headless runs and tests that supply their own environment.
    pub fn with_env(
        config: Config,
        host: Arc<dyn ToolModulesHost>,
        publisher: Arc<dyn StatePublisher>,
        cancel: CancellationToken,
        env: FeatureEnv,
    ) -> Arc<Self> {
        let (refreshes, requests) = mpsc::unbounded_channel();
        let service = Arc::new(Self {
            config,
            host,
            publisher,
            env,
            refreshes,
        });
        mixdog_rt::spawn("tool-modules", TaskClass::Work, service.clone().publish_loop(requests, cancel));
        service
    }

    /// The one task that computes and publishes, so frames follow the order of the changes
    /// and a value is never published twice in a row.
    async fn publish_loop(
        self: Arc<Self>,
        mut requests: mpsc::UnboundedReceiver<oneshot::Sender<Value>>,
        cancel: CancellationToken,
    ) {
        let mut config_changes = self.config.changes();
        let mut host_changes = self.host.changes();
        let mut last: Option<Value> = None;
        let mut reply: Option<oneshot::Sender<Value>> = None;
        loop {
            let current = self.settings().await;
            if last.as_ref() != Some(&current) {
                self.publisher.publish(SectionName::ToolModules, None, change_of(&current));
            }
            if let Some(reply) = reply.take() {
                let _ = reply.send(current.clone());
            }
            last = Some(current);
            tokio::select! {
                () = cancel.cancelled() => return,
                changed = config_changes.changed() => if changed.is_err() { return },
                changed = host_changes.changed() => if changed.is_err() { return },
                request = requests.recv() => match request {
                    Some(request) => reply = Some(request),
                    None => return,
                },
            }
        }
    }

    /// `getToolModuleSettings()`.
    pub async fn settings(&self) -> Value {
        let external = self.host.external().await;
        value::tool_module_settings(&self.config.agent(), &external, &*self.env)
    }

    /// Has the publishing task recompute and publish if the value changed; answers the
    /// current value. After the task has stopped it only answers.
    pub async fn refresh(&self) -> Value {
        let (reply, answer) = oneshot::channel();
        if self.refreshes.send(reply).is_ok()
            && let Ok(current) = answer.await
        {
            return current;
        }
        self.settings().await
    }

    async fn write(
        &self,
        change: impl FnOnce(&mut value::Doc) + Send + 'static,
    ) -> Result<(), ToolModulesError> {
        self.config
            .update_agent(move |doc| {
                change(doc);
                Ok(())
            })
            .await?;
        Ok(())
    }

    /// `setWebSearchEnabled`.
    pub async fn set_web_search_enabled(&self, enabled: bool) -> Result<Value, ToolModulesError> {
        self.write(move |doc| edit::set_module_enabled(doc, "webSearch", enabled)).await?;
        Ok(self.refresh().await)
    }

    /// `setInstructionFiles`.
    pub async fn set_instruction_files(&self, mode: &str) -> Result<Value, ToolModulesError> {
        if !INSTRUCTION_FILES_MODES.contains(&mode) {
            return Err(ToolModulesError::InvalidArgument(format!(
                "Instruction files must be one of {}.",
                INSTRUCTION_FILES_MODES.join(", ")
            )));
        }
        let mode = mode.to_owned();
        self.write(move |doc| {
            doc.insert("instructionFiles".into(), Value::String(mode));
        })
        .await?;
        Ok(self.refresh().await)
    }

    /// `setAutoEffortBase`.
    pub async fn set_auto_effort_base(&self, level: &str) -> Result<Value, ToolModulesError> {
        if !AUTO_EFFORT_BASES.contains(&level) {
            return Err(ToolModulesError::InvalidArgument(format!(
                "Auto reasoning base must be one of {}.",
                AUTO_EFFORT_BASES.join(", ")
            )));
        }
        let level = level.to_owned();
        self.write(move |doc| {
            doc.insert("autoEffortBase".into(), Value::String(level));
        })
        .await?;
        Ok(self.refresh().await)
    }

    /// `setRecapEnabled`: gates only the background memory cycles; not part of the value.
    pub async fn set_recap_enabled(&self, enabled: bool) -> Result<Value, ToolModulesError> {
        self.write(move |doc| edit::set_recap_enabled(doc, enabled)).await?;
        self.host.invalidate_pre_session_tool_surface();
        self.host.invalidate_context_status_cache();
        self.refresh().await;
        Ok(serde_json::json!({ "enabled": enabled }))
    }

    /// `setMemoryToolsEnabled`: the memory master toggle (tools, injection, recap together).
    pub async fn set_memory_tools_enabled(&self, enabled: bool) -> Result<Value, ToolModulesError> {
        self.write(move |doc| {
            edit::set_memory_tools_enabled(doc, enabled);
            edit::set_recap_enabled(doc, enabled);
            // Enabling is activation: it marks the feature installed.
            if enabled {
                edit::set_builtin_installed(doc, "memory");
            }
        })
        .await?;
        self.host.invalidate_context_status_cache();
        Ok(self.refresh().await)
    }

    /// `setBuiltinToolEnabled`.
    pub async fn set_builtin_tool_enabled(
        &self,
        name: &str,
        enabled: bool,
    ) -> Result<Value, ToolModulesError> {
        if !TOGGLEABLE_BUILTINS.contains(&name) {
            return Err(ToolModulesError::InvalidArgument(
                "Built-in tool must be git, office, tidy, localProvider, autoEffort, visualize, or media."
                    .into(),
            ));
        }
        let external = self.host.external().await;
        if name == "autoEffort" && enabled && !external.onnx_supported {
            return Err(ToolModulesError::Failed(EFFORT_JUDGE_UNSUPPORTED.into()));
        }
        let runtime_installed = external
            .local_provider
            .pointer("/runtime/installed")
            .is_some_and(|v| *v == Value::Bool(true));
        if (name == "localProvider" && enabled && !runtime_installed)
            || (name == "autoEffort" && enabled)
        {
            self.prepare(name, None).await?;
        }
        let owned = name.to_owned();
        self.write(move |doc| {
            edit::set_module_enabled(doc, &owned, enabled);
            if owned == "localProvider" {
                edit::set_local_provider_enabled(doc, enabled);
            }
            if enabled {
                edit::set_builtin_installed(doc, &owned);
            }
        })
        .await?;
        if name == "localProvider" {
            if !enabled {
                self.host.stop_local_provider_server().await;
            }
            self.host.sync_local_provider_registry(enabled).await;
        }
        // Turning Auto on loads nothing: the judge starts on its first turn.
        if name == "autoEffort" && !enabled {
            self.host.shutdown_effort_judge().await;
        }
        Ok(self.refresh().await)
    }

    /// `installBuiltinFeature`: prepare, then mark installed and enabled in one step. With
    /// `engines` for `tidy` it only fetches those engines and leaves the state as set.
    pub async fn install_builtin_feature(
        &self,
        name: &str,
        engines: Option<Vec<String>>,
    ) -> Result<Value, ToolModulesError> {
        if !INSTALLABLE_BUILTINS.contains(&name) {
            return Err(ToolModulesError::InvalidArgument(
                "Built-in feature must be git, memory, office, tidy, localProvider, or autoEffort."
                    .into(),
            ));
        }
        if name == "autoEffort" && !self.host.external().await.onnx_supported {
            return Err(ToolModulesError::Failed(EFFORT_JUDGE_UNSUPPORTED.into()));
        }
        if name == "tidy" && engines.is_some() {
            self.prepare(name, engines.as_deref()).await?;
            return Ok(self.refresh().await);
        }
        self.prepare(name, None).await?;
        let owned = name.to_owned();
        self.write(move |doc| {
            edit::set_builtin_installed(doc, &owned);
            if owned == "memory" {
                edit::set_memory_tools_enabled(doc, true);
                edit::set_recap_enabled(doc, true);
            } else {
                edit::set_module_enabled(doc, &owned, true);
            }
            if owned == "localProvider" {
                edit::set_local_provider_enabled(doc, true);
            }
        })
        .await?;
        if name == "localProvider" {
            self.host.sync_local_provider_registry(true).await;
        }
        if name == "memory" {
            self.host.invalidate_context_status_cache();
        }
        Ok(self.refresh().await)
    }

    async fn prepare(&self, name: &str, engines: Option<&[String]>) -> Result<(), ToolModulesError> {
        self.host
            .prepare_builtin_feature(name, engines)
            .await
            .map_err(ToolModulesError::Failed)
    }
}
