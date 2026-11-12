//! The runtime's side of the code-graph prewarm timer (`PrewarmWorld`, flip-ce-12): the settings of
//! `runtime-tunables.mjs`, the busy reason of `timer-arm.mjs:29`, the current folder, and the graph
//! build of `CodeGraphTool::prewarm_if_project`.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core::run_host::code_graph_prewarm::PrewarmWorld;
use mixdog_core_session::session::prewarm_signals::CodeGraphPrewarmSignals;
use mixdog_core::run_host::compose_parts::LateDirectory;
use mixdog_services::task_reports::runtime_state::RuntimeLiveness;
use mixdog_tools::code_graph::CodeGraphTool;
use tokio_util::sync::CancellationToken;

use crate::compose_domains::EnvReader;

pub struct DaemonPrewarmWorld {
    pub tool: Arc<CodeGraphTool>,
    pub io: mixdog_rt::MaintenanceIo,
    /// `rt.closeRequested` (cancelled when the release begins: `ComposedCore::set_stop_reason`).
    pub close_requested: CancellationToken,
    /// Ends an in-flight build with the process.
    pub cancel: CancellationToken,
    pub liveness: Arc<RuntimeLiveness>,
    /// `getSessionCreatePromise()` through the verified late directory.
    pub directory: Arc<LateDirectory>,
    /// `rt.currentCwd`: the startup folder until a session moves it (`set_runtime_cwd`, flip-ce-5).
    pub cwd: Arc<Mutex<String>>,
    pub env: EnvReader,
}

/// `timer-arm.mjs` `busyReason()`: `getActiveTurnCount() > 0` -> `turn-active`; `getSessionCreatePromise()` -> `session-create`.
/// The one probe every background warm-up asks (the code-graph prewarm and the catalog warm-up).
pub fn busy_reason(liveness: &RuntimeLiveness, directory: &LateDirectory) -> Option<&'static str> {
    if !liveness.in_flight_session_activity().working.is_empty() {
        return Some("turn-active");
    }
    let directory = directory.directory().expect("session directory bound (compose::verify_bound)");
    directory.creating().then_some("session-create")
}

/// Node's `createWarmupSchedulers` (`warmup-schedulers.mjs:12`): the daemon's five warm-ups behind the calls the boot
/// (`boot/session.mjs:121-125`), the turn settle (`refreshStatuslineUsageAfterTurn`) and the wakes
/// (`wakeDeferredWarmups`) make.
pub struct WarmupSchedulers {
    pub providers: Arc<mixdog_core_domains::domains::ai_admin::provider_warmup::ProviderWarmup>,
    pub models: Arc<mixdog_core_domains::domains::ai_admin::model_warmup::ModelWarmup>,
    pub setup: Arc<crate::setup_host::SetupWarmup>,
    pub catalog: Arc<crate::catalog::CatalogWarmup>,
    pub statusline: Arc<mixdog_core_domains::domains::ai_admin::statusline_warmup::StatuslineWarmup>,
}

impl WarmupSchedulers {
    /// `scheduleProviderWarmup()`, at its configured delay.
    pub fn schedule_provider_warmup(&self) {
        self.providers.start();
    }

    /// `scheduleProviderModelWarmup()`, at its configured delay.
    pub fn schedule_provider_model_warmup(&self) {
        self.models.start();
    }

    /// `scheduleProviderSetupWarmup(delayMs)`; `None`: the configured delay.
    pub fn schedule_provider_setup_warmup(&self, delay_ms: Option<u64>) {
        match delay_ms {
            Some(delay_ms) => self.setup.schedule(delay_ms),
            None => self.setup.schedule_default(),
        }
    }

    /// `scheduleModelCatalogWarmup()`, its delay and switch read from `env`.
    pub fn schedule_model_catalog_warmup(&self, env: &dyn Fn(&str) -> Option<String>) {
        crate::catalog::arm_first_warm(&self.catalog, env);
    }

    /// `scheduleStatuslineUsageWarmup()`, at its configured delay.
    pub fn schedule_statusline_usage_warmup(&self) {
        self.statusline.start();
    }

    /// `refreshStatuslineUsageAfterTurn()`.
    pub fn refresh_statusline_usage_after_turn(&self) {
        self.statusline.turn_settled();
    }

    /// `wakeDeferredWarmups()`: the catalog, the models, the statusline, the providers.
    pub fn wake_deferred_warmups(&self) {
        self.catalog.wake();
        self.models.wake();
        self.statusline.wake();
        self.providers.wake();
    }
}

/// `SessionDeps.code_graph_prewarm`: a session's busy-state change (`rt.wakeDeferredWarmups`) reaches both background
/// warm-ups, the code-graph prewarm and the catalog warm-up; the rest of the signals are the prewarm's alone.
pub struct WarmupSignals {
    pub prewarm: mixdog_core::run_host::code_graph_prewarm::SessionPrewarm,
    pub schedulers: Arc<WarmupSchedulers>,
    pub channel_admin: Arc<mixdog_services::channels::ChannelAdmin>,
}

impl CodeGraphPrewarmSignals for WarmupSignals {
    fn schedule(&self, delay: Option<Duration>, reason: &'static str) {
        self.prewarm.schedule(delay, reason);
    }

    fn wake(&self) {
        self.prewarm.wake();
        self.schedulers.wake_deferred_warmups();
        self.channel_admin.wake_deferred_start();
    }

    /// `turn-settle.mjs`: the first settled turn reschedules the provider and model warms; every one refreshes the usage.
    fn turn_settled(&self) {
        self.schedulers.providers.first_turn_settled();
        self.schedulers.models.first_turn_settled();
        self.schedulers.refresh_statusline_usage_after_turn();
    }

    fn lazy(&self) -> bool {
        self.prewarm.lazy()
    }
}

/// The gates of the provider model warm (`busyReason` and `isCloseRequested`): the same probe the other background
/// warm-ups use.
pub struct DaemonWarmupGates {
    pub liveness: Arc<RuntimeLiveness>,
    pub directory: Arc<LateDirectory>,
    pub close_requested: CancellationToken,
}

impl mixdog_core_domains::domains::ai_admin::model_warmup::WarmupMarks for DaemonWarmupGates {
    /// `bootProfile(event, meta)`.
    fn profile(&self, event: &str, detail: Option<serde_json::Value>) {
        tracing::debug!(event, ?detail, "boot profile");
    }
}

impl mixdog_core_domains::domains::ai_admin::model_warmup::WarmupGates for DaemonWarmupGates {
    fn busy(&self) -> Option<&'static str> {
        busy_reason(&self.liveness, &self.directory)
    }

    fn closing(&self) -> bool {
        self.close_requested.is_cancelled()
    }

    fn closed(&self) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
        let closing = self.close_requested.clone();
        Box::pin(async move { closing.cancelled().await })
    }
}

/// What the provider warm runs in the daemon: its keychain, the config's full reload and the readiness of the loaded
/// config's providers (`getConfig().providers`).
pub struct DaemonProviderInit {
    pub keychain: Arc<dyn mixdog_core_domains::domains::ai_account::setup_cache::KeychainLive>,
    pub config: mixdog_core_config::config::Config,
    pub loaded: Arc<mixdog_core_domains::domains::ai_admin::provider_sync::LoadedConfig>,
    pub readiness: Arc<mixdog_ai::catalog::ProviderReadiness>,
}

#[async_trait]
impl mixdog_core_domains::domains::ai_admin::provider_warmup::ProviderInit for DaemonProviderInit {
    /// The keyring is asked per call (`HolderLive`): its prewarm cannot fail.
    async fn keychain_prewarm(&self) -> Result<(), String> {
        self.keychain.await_prewarm().await;
        Ok(())
    }

    async fn reload_full_config(&self) -> Result<(), String> {
        self.config.reload_full_config().await.map(drop).map_err(|error| error.to_string())
    }

    async fn ensure_providers_ready(&self) -> Result<(), String> {
        let providers = self.loaded.get().get("providers").and_then(serde_json::Value::as_object).cloned().unwrap_or_default();
        self.readiness.ensure_providers_ready(Some(providers)).await.map(drop).map_err(|error| error.message)
    }
}

impl DaemonPrewarmWorld {
    /// `envFlag(name)`: unset, empty or a typo is off.
    fn flag(&self, name: &str) -> bool {
        mixdog_services::memory::cycles::config::env_flag((self.env)(name).as_deref(), false)
    }

    /// `codeGraphPrewarmLazy` (`runtime-tunables.mjs`): `codeGraphPrewarmEnabled && !codeGraphPrewarmEager`. A cwd applied before the first turn does not warm.
    pub fn lazy(&self) -> bool {
        self.enabled() && !self.flag("MIXDOG_CODE_GRAPH_PREWARM_EAGER")
    }
}

#[async_trait]
impl PrewarmWorld for DaemonPrewarmWorld {
    /// `!envFlag('MIXDOG_DISABLE_CODE_GRAPH_PREWARM') && (envFlag('MIXDOG_ENABLE_CODE_GRAPH_PREWARM') || envFlag('MIXDOG_CODE_GRAPH_PREWARM_EAGER'))`.
    fn enabled(&self) -> bool {
        !self.flag("MIXDOG_DISABLE_CODE_GRAPH_PREWARM") && (self.flag("MIXDOG_ENABLE_CODE_GRAPH_PREWARM") || self.flag("MIXDOG_CODE_GRAPH_PREWARM_EAGER"))
    }

    /// `envDelayMs('MIXDOG_CODE_GRAPH_PREWARM_DELAY_MS', 250, { min: 0, max: 60_000 })`.
    fn delay(&self) -> Duration {
        let parsed = (self.env)("MIXDOG_CODE_GRAPH_PREWARM_DELAY_MS").filter(|raw| !raw.is_empty()).map(|raw| mixdog_js::string_to_number(&raw)).filter(|n| n.is_finite());
        Duration::from_millis(parsed.map_or(250.0, |n| n.floor().clamp(0.0, 60_000.0)) as u64)
    }

    fn close_requested(&self) -> bool {
        self.close_requested.is_cancelled()
    }

    /// `getActiveTurnCount() > 0` -> `turn-active`; `getSessionCreatePromise()` -> `session-create`.
    fn busy(&self) -> Option<&'static str> {
        busy_reason(&self.liveness, &self.directory)
    }

    fn current_cwd(&self) -> String {
        self.cwd.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    async fn prewarm(&self, cwd: &str) -> Result<bool, String> {
        Ok(self.tool.prewarm_if_project(std::path::Path::new(cwd), self.io, &self.cancel).await)
    }

    /// `bootProfile(event, detail)`.
    fn profile(&self, event: &str, detail: &str) {
        tracing::debug!(event, detail, "boot profile");
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use mixdog_services::task_reports::runtime_state::RuntimeEntry;

    /// The deferred channel start and every warm-up ask `busy_reason`; a turn the session runtime has
    /// dispatched, or one whose runtime entry is in flight, is `turn-active` (the directory is not asked).
    #[test]
    fn a_running_turn_is_turn_active_and_an_idle_runtime_is_not_asked_for_one() {
        let liveness = RuntimeLiveness::new();
        let directory = LateDirectory::default();
        let guard = liveness.dispatched("s1");
        assert_eq!(busy_reason(&liveness, &directory), Some("turn-active"));
        drop(guard);
        liveness.set_entry("s2", RuntimeEntry { stage: Some("streaming".into()), ..RuntimeEntry::default() });
        assert_eq!(busy_reason(&liveness, &directory), Some("turn-active"));
        liveness.set_entry("s2", RuntimeEntry { stage: Some("idle".into()), ..RuntimeEntry::default() });
        assert!(liveness.in_flight_session_activity().working.is_empty());
    }
}
