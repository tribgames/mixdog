//! The real [`ToolModulesHost`]: the runtime state behind the `toolModules` value, read from the
//! services that own it, and the preparations the setters run (`builtinFeatureAdapters` in
//! `session-runtime/boot/apis.mjs`).
//!
//! Two change signals feed `changes()`: the local provider's (`LocalProvider::subscribe`) and the
//! shared [`StateTick`] the embedder and the effort judge bump. A forwarding task merges them
//! into one counter. What the services do not own (the office fonts, the provider registry and
//! the session caches) sits behind [`FeatureEffects`].

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_rt::CancellationToken;
use mixdog_rt::InteractiveIo;
use mixdog_rt::LaneToken;
use mixdog_rt::TaskClass;
use mixdog_services::effort_judge::judge::EffortJudgeModel;
use mixdog_services::effort_judge::install::Manifest;
use mixdog_services::local_provider::assets::Fetcher;
use mixdog_services::local_provider::installations::wait;
use mixdog_services::local_provider::provider::LocalProvider;
use mixdog_services::memory::embed::config::DEFAULT_MODEL_ID;
use mixdog_services::memory::embed::provider::EmbeddingProvider;
use mixdog_services::tidy::InstallJob;
use mixdog_services::tidy::core_install::CoreInstall;
use mixdog_services::tidy::core_install::run_core_install;
use mixdog_services::tidy::process::{Processes, which};
use mixdog_services::tool_state::JudgeStatus;
use mixdog_services::tool_state::StateTick;
use mixdog_services::tool_state::onnx_runtime_supported;
use serde_json::Value;
use tokio::sync::watch;

use super::EffortJudgeState;
use super::External;
use super::ToolModulesHost;

/// What the setters trigger that no service owns.
#[async_trait]
pub trait FeatureEffects: Send + Sync + 'static {
    /// `prepareOfficeFonts()`: failures are ignored, as in Node.
    async fn prepare_office_fonts(&self);
    /// `syncLocalProviderRegistry(enabled)`: invalidates the provider caches, then disables the
    /// local provider in the registry or makes the providers ready again.
    async fn sync_local_provider_registry(&self, enabled: bool);
    fn invalidate_context_status_cache(&self);
    fn invalidate_pre_session_tool_surface(&self);
}

/// The services behind the value.
pub struct HostParts {
    pub local_provider: Arc<LocalProvider>,
    /// `LocalProviderService`'s last installation command error.
    pub installation_command_error: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    /// `None` where onnxruntime ships no binding (`OrtRuntime::NoBinding`): Node has no embedder there.
    pub embedder: Option<Arc<EmbeddingProvider>>,
    pub judge: Arc<EffortJudgeModel>,
    pub judge_manifest: Manifest,
    /// The tick the embedder and the judge were built with.
    pub tick: StateTick,
    /// Core Tidy engines install here (`dataDirOf(cfgMod)`).
    pub plugin_data: PathBuf,
    pub tidy_job: Arc<InstallJob>,
    /// The process manager and durability lane the core Tidy install probes and hashes its engines with.
    pub processes: Processes,
    pub fetcher: Arc<dyn Fetcher>,
    pub effects: Arc<dyn FeatureEffects>,
    /// Reads of metadata files run on this lane.
    pub read_lane: InteractiveIo,
}

pub struct ServicesToolModulesHost {
    parts: HostParts,
    merged: watch::Sender<u64>,
    cancel: CancellationToken,
}

impl ServicesToolModulesHost {
    /// Starts the task that merges the two change signals; it ends with `cancel`, which also
    /// cancels the downloads a setter started.
    pub fn new(parts: HostParts, cancel: CancellationToken) -> Arc<Self> {
        let merged = watch::channel(0).0;
        let host = Arc::new(Self { parts, merged, cancel: cancel.clone() });
        let mut provider = host.parts.local_provider.subscribe();
        let mut state = host.parts.tick.subscribe();
        let forward = host.clone();
        mixdog_rt::spawn("tool-modules-host-ticks", TaskClass::Work, async move {
            loop {
                tokio::select! {
                    () = cancel.cancelled() => return,
                    changed = provider.changed() => if changed.is_err() { return },
                    changed = state.changed() => if changed.is_err() { return },
                }
                forward.merged.send_modify(|tick| *tick += 1);
            }
        });
        host
    }

    async fn prepare_local_provider(&self) -> Result<(), String> {
        let (_, done) = self
            .parts
            .local_provider
            .start_installation("runtime", None)
            .map_err(|error| error.to_string())?;
        wait(done).await.map(drop)
    }

    async fn prepare_tidy(&self, engines: Option<&[String]>) {
        // Per-engine failures land in the install job, not in an error: the feature still
        // installs and the card reports what did not.
        run_core_install(
            &self.parts.tidy_job,
            CoreInstall {
                processes: self.parts.processes.clone(),
                plugin_data: &self.parts.plugin_data,
                manifest: None,
                env: None,
                fetcher: self.parts.fetcher.as_ref(),
                cancel: self.cancel.clone(),
                only: engines.map(<[String]>::to_vec),
            },
        )
        .await;
    }
}

#[async_trait]
impl ToolModulesHost for ServicesToolModulesHost {
    async fn external(&self) -> External {
        let parts = &self.parts;
        let judge = parts.judge.clone();
        let embedder = parts.embedder.clone();
        // The info readers stat and read files.
        let read = parts.read_lane.submit(&CancellationToken::new(), move |_| {
            (embedder.map_or_else(|| EmbeddingProvider::info_unbuilt(DEFAULT_MODEL_ID, None), |embedder| embedder.info()), judge.status(), which("git", None, None).is_some())
        });
        // A full or stopped lane reads as nothing installed; the next tick reads again.
        let nothing = || {
            (
                Value::Null,
                JudgeStatus {
                    available: false,
                    installing: false,
                    ready: false,
                    last_error: String::new(),
                    info: Value::Null,
                },
                false,
            )
        };
        let (embedding_info, status, git_available) = match read {
            Ok(job) => job.await.unwrap_or_else(|_| nothing()),
            Err(_) => nothing(),
        };
        External {
            embedding_info,
            onnx_supported: onnx_runtime_supported(),
            git_available,
            // A catalog that cannot be read yet reads as nothing; the next tick reads again.
            local_provider: parts.local_provider.status().await.unwrap_or(Value::Null),
            installation_command_error: (parts.installation_command_error)(),
            effort_judge: EffortJudgeState {
                available: status.available,
                installing: status.installing,
                ready: status.ready,
                last_error: Value::String(status.last_error),
                info: status.info,
            },
        }
    }

    fn changes(&self) -> watch::Receiver<u64> {
        self.merged.subscribe()
    }

    async fn prepare_builtin_feature(
        &self,
        name: &str,
        engines: Option<&[String]>,
    ) -> Result<(), String> {
        match name {
            "memory" => {
                let embedder = self.parts.embedder.as_ref().ok_or("the ONNX runtime is not supported on this platform")?;
                embedder.install(None, &self.cancel).await.map_err(|error| error.to_string())?;
                embedder.warmup().await.map(drop)
            }
            "office" => {
                self.parts.effects.prepare_office_fonts().await;
                Ok(())
            }
            "tidy" => {
                self.prepare_tidy(engines).await;
                Ok(())
            }
            "localProvider" => self.prepare_local_provider().await,
            // Downloads the judge model (verified per file) unless it is current.
            "autoEffort" => self
                .parts
                .judge
                .install(&self.parts.judge_manifest, None, &self.cancel)
                .await
                .map_err(|error| error.to_string()),
            _ => Ok(()),
        }
    }

    async fn stop_local_provider_server(&self) {
        self.parts.local_provider.stop().await;
    }

    async fn sync_local_provider_registry(&self, enabled: bool) {
        self.parts.effects.sync_local_provider_registry(enabled).await;
    }

    async fn shutdown_effort_judge(&self) {
        self.parts.judge.shutdown().await;
    }

    fn invalidate_context_status_cache(&self) {
        self.parts.effects.invalidate_context_status_cache();
    }

    fn invalidate_pre_session_tool_surface(&self) {
        self.parts.effects.invalidate_pre_session_tool_surface();
    }

    fn attach_tool_settings(&self, settings: std::sync::Weak<dyn mixdog_services::local_provider::provider::ToolSettings>) {
        self.parts.local_provider.attach_tool_settings(settings);
    }
}
