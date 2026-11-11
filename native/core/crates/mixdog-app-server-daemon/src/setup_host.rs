//! The daemon's switches around the cached provider setup (`SetupHost` of wp-ai-svc-23), and the one cache drop the auth-refresh flow shares
//! with it.
//!
//! Node: `scheduleProviderSetupWarmup(delayMs = providerSetupWarmupDelayMs)` arms one timer (`createWarmupTimers.arm`,
//! `session-runtime/warmup/timer-arm.mjs`: nothing when it is already pending or the runtime is closing) that runs `cachedProviderSetup()` when it
//! fires (`warmup/provider-warmups.mjs:64-70`). The delay is `envDelayMs('MIXDOG_PROVIDER_SETUP_WARMUP_DELAY_MS', 300, { min: 0, max: 60_000 })`
//! (`runtime-tunables.mjs:14`), read once. The cache itself asks for `scheduleProviderSetupWarmup(0)`; the boot asks for the default delay.
//!
//! The warm-up runs the setup it warms, and that setup holds the host: a true cycle, so the setup is bound once, after it is built
//! (Node threads it the same way, `rt.scheduleProviderSetupWarmupRef`, `boot/providers.mjs:222-227`). `Bound` makes `verify_bound` check it.

use std::sync::Arc;
use std::sync::OnceLock;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;

use futures::future::BoxFuture;
use mixdog_core::run_host::late::Bound;
use mixdog_core_config::config::Config;
use mixdog_core_domains::domains::ai_account::auth_refresh::ProviderEffects;
use mixdog_core_domains::domains::ai_account::auth_refresh::RefreshEffects;
use mixdog_core_domains::domains::ai_account::setup_cache::CachedProviderSetup;
use mixdog_core_domains::domains::ai_admin::model_warmup::ModelWarmup;
use mixdog_core_domains::domains::ai_admin::model_warmup::WarmupMarks;
use mixdog_core_domains::domains::ai_account::setup_cache::SetupHost;
use mixdog_core_domains::domains::ai_account::collaborators::ProviderSetup;
use mixdog_rt::TaskClass;

/// The usage dashboards' view of the setup (`SetupSource`): `cachedProviderSetup({ force, quick })` and `displayConfig()` (the live config, as the gatherer reads it).
pub struct SetupSourceOf {
    pub setup: Arc<CachedProviderSetup>,
    pub config: Config,
    /// The providers of the loaded config (`loadConfig().providers`).
    pub effective: Arc<mixdog_ai::registry::effective::EffectiveProviders>,
}

#[async_trait::async_trait]
impl mixdog_core_domains::domains::ai_account::SetupSource for SetupSourceOf {
    async fn setup(&self, force: bool, quick: bool) -> Result<serde_json::Value, String> {
        self.setup.cached(force, quick).await.map_err(|failure| failure.message().to_owned())
    }

    async fn display_config(&self) -> Result<serde_json::Value, String> {
        let mut config = self.config.loaded_agent().await.map_err(|error| error.to_string())?;
        let providers = self.effective.load(&config, true).await?;
        config.insert("providers".into(), serde_json::Value::Object(providers));
        Ok(serde_json::Value::Object(config))
    }
}
/// `MIXDOG_PROVIDER_SETUP_WARMUP_DELAY_MS` and its default (`runtime-tunables.mjs:14`).
pub const WARMUP_DELAY_ENV: &str = "MIXDOG_PROVIDER_SETUP_WARMUP_DELAY_MS";
const WARMUP_DELAY_DEFAULT_MS: u64 = 300;
const WARMUP_DELAY_MAX_MS: u64 = 60_000;

/// `envDelayMs(name, 300, { min: 0, max: 60_000 })`: unset, empty or not a finite number is the default; otherwise `Number(raw)` floored
/// and clamped.
pub fn warmup_delay_ms(env: &dyn Fn(&str) -> Option<String>) -> u64 {
    let Some(raw) = env(WARMUP_DELAY_ENV).filter(|raw| !raw.is_empty()) else { return WARMUP_DELAY_DEFAULT_MS };
    let n = mixdog_js::string_to_number(&raw);
    if !n.is_finite() {
        return WARMUP_DELAY_DEFAULT_MS;
    }
    n.floor().clamp(0.0, WARMUP_DELAY_MAX_MS as f64) as u64
}

/// `timers.providerSetupWarmupTimer`.
const SLOT: &str = "providerSetupWarmupTimer";

/// `bootProfile(event, meta)` as a debug trace: the daemon's marks of its warm-ups.
pub struct TracedMarks;

impl WarmupMarks for TracedMarks {
    fn profile(&self, event: &str, detail: Option<serde_json::Value>) {
        tracing::debug!(event, ?detail, "boot profile");
    }
}

/// The provider-setup warm-up timer slot (`timers.providerSetupWarmupTimer`).
pub struct SetupWarmup {
    delay_ms: u64,
    pending: AtomicBool,
    /// `isCloseRequested()`.
    closing: Arc<dyn Fn() -> bool + Send + Sync>,
    marks: Arc<dyn WarmupMarks>,
    setup: OnceLock<Arc<dyn ProviderSetup>>,
}

impl SetupWarmup {
    pub fn new(delay_ms: u64, closing: Arc<dyn Fn() -> bool + Send + Sync>, marks: Arc<dyn WarmupMarks>) -> Arc<Self> {
        Arc::new(Self { delay_ms, pending: AtomicBool::new(false), closing, marks, setup: OnceLock::new() })
    }

    /// Binds the setup the timer warms; a second bind is refused.
    pub fn bind(&self, setup: Arc<dyn ProviderSetup>) -> Result<(), Arc<dyn ProviderSetup>> {
        self.setup.set(setup)
    }

    /// `getProviderSetupWarmupTimer() !== null`.
    pub fn pending(&self) -> bool {
        self.pending.load(Ordering::SeqCst)
    }

    pub fn closing(&self) -> bool {
        (self.closing)()
    }

    /// The boot's `scheduleProviderSetupWarmup()` with the default delay.
    pub fn schedule_default(self: &Arc<Self>) {
        self.schedule(self.delay_ms);
    }

    /// `arm('providerSetupWarmupTimer', delayMs, run)`: nothing when already pending or closing; the slot clears when the timer fires, and the
    /// run happens only while the runtime is open. The result of the warm-up is only a boot-profile mark.
    pub fn schedule(self: &Arc<Self>, delay_ms: u64) {
        if self.pending() || self.closing() {
            return;
        }
        if self.pending.swap(true, Ordering::SeqCst) {
            return;
        }
        let delay = Duration::from_millis(delay_ms);
        self.marks.armed(SLOT, delay);
        // `setTimeout` counts from the call, not from when the task is first polled.
        let deadline = tokio::time::Instant::now() + delay;
        let this = self.clone();
        mixdog_rt::spawn("provider-setup-warmup", TaskClass::Work, async move {
            tokio::time::sleep_until(deadline).await;
            this.marks.running(SLOT, true);
            this.pending.store(false, Ordering::SeqCst);
            if !this.closing()
                && let Some(setup) = this.setup.get()
            {
                // `cachedProviderSetup()`
                match setup.get(false, false, false, false).await {
                    Ok(_) => this.marks.profile("provider-setup:warm-ready", None),
                    Err(failure) => this.marks.profile("provider-setup:warm-failed", Some(serde_json::json!({ "error": failure.message() }))),
                }
            }
            this.marks.running(SLOT, false);
        });
    }
}

/// The model warm's late cell: bound once the model list and the runtime's gates exist; `verify_bound` checks it.
pub struct ModelWarmupCell(pub Arc<ModelWarmup>);

/// The statusline usage warm-up's late cell: bound once the usage service exists; `verify_bound` checks it.
pub struct StatuslineWarmupCell(pub Arc<mixdog_core_domains::domains::ai_admin::statusline_warmup::StatuslineWarmup>);

impl Bound for StatuslineWarmupCell {
    fn cell(&self) -> &'static str {
        "statusline usage warm-up"
    }

    fn is_bound(&self) -> bool {
        self.0.is_bound()
    }
}

impl Bound for ModelWarmupCell {
    fn cell(&self) -> &'static str {
        "provider model warm-up"
    }

    fn is_bound(&self) -> bool {
        self.0.is_bound()
    }
}

impl Bound for SetupWarmup {
    fn cell(&self) -> &'static str {
        "provider setup warm-up"
    }

    fn is_bound(&self) -> bool {
        self.setup.get().is_some()
    }
}

/// `SetupHost` over the daemon: the env, the live config and the warm-up slot.
pub struct DaemonSetupHost {
    pub env: Arc<dyn Fn(&str) -> Option<String> + Send + Sync>,
    pub config: Config,
    pub warmup: Arc<SetupWarmup>,
}

impl SetupHost for DaemonSetupHost {
    fn model_proxy_client(&self) -> bool {
        mixdog_ai::service::admin_models::model_proxy_client_mode(&|name| (self.env)(name))
    }

    /// `reloadFullConfig()`: the same `Config::reload` the auth-refresh effects run.
    fn reload_full_config(&self) {
        let config = self.config.clone();
        mixdog_rt::spawn("provider-setup-reload", TaskClass::Work, async move {
            let _ = config.reload().await;
        });
    }

    fn warmup_pending(&self) -> bool {
        self.warmup.pending()
    }

    /// `scheduleProviderSetupWarmup(0)`.
    fn schedule_warmup(&self) {
        // The slot lives behind an `Arc` the caller holds; `schedule` needs it by `Arc`.
        self.warmup.clone().schedule(0);
    }

    fn closing(&self) -> bool {
        self.warmup.closing()
    }
}

/// The auth-refresh effects with the provider-setup cache dropped where Node's one `invalidateProviderCaches()` drops it
/// (`provider-readiness.mjs:71-78` resets the model caches, the usage caches the setup lives in, and the shared catalog): `ProviderEffects`
/// drops the catalog revision and the dashboard, this adds the setup. Every other step is the live effects'.
pub struct CachesWithSetup {
    pub inner: Arc<ProviderEffects>,
    pub setup: Arc<CachedProviderSetup>,
}

impl RefreshEffects for CachesWithSetup {
    fn apply_config_change(&self) {
        self.inner.apply_config_change();
    }

    fn reload_config(&self) {
        self.inner.reload_config();
    }

    fn invalidate_provider_caches(&self) {
        self.inner.invalidate_provider_caches();
        self.setup.invalidate();
    }

    fn warm_provider_model_cache(&self) {
        self.inner.warm_provider_model_cache();
    }

    fn reset_admission_cooldowns(&self) {
        self.inner.reset_admission_cooldowns();
    }

    fn refresh_provider_catalogs(&self) -> Option<BoxFuture<'static, Result<(), ()>>> {
        self.inner.refresh_provider_catalogs()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicBool;

    use super::*;

    fn env(value: Option<&'static str>) -> impl Fn(&str) -> Option<String> {
        move |name| (name == WARMUP_DELAY_ENV).then(|| value.map(str::to_owned)).flatten()
    }

    /// Node's `envDelayMs`: default 300; empty, non-numeric and infinite are the default; else floored and clamped to 0..60000.
    #[test]
    fn the_warmup_delay_is_nodes_env_delay() {
        for (raw, want) in [
            (None, 300),
            (Some(""), 300),
            (Some("abc"), 300),
            (Some("Infinity"), 300),
            (Some("0"), 0),
            (Some("50.9"), 50),
            (Some("-5"), 0),
            (Some("999999"), 60_000),
            (Some(" 120 "), 120),
        ] {
            assert_eq!(warmup_delay_ms(&env(raw)), want, "{raw:?}");
        }
    }

    /// One timer slot: armed once, cleared when it fires, never armed while closing.
    #[tokio::test(start_paused = true)]
    async fn the_slot_is_armed_once_and_cleared_when_it_fires() {
        mixdog_rt::testing::tokens();
        let closing = Arc::new(AtomicBool::new(false));
        let warmup = SetupWarmup::new(
            300,
            {
                let closing = closing.clone();
                Arc::new(move || closing.load(Ordering::SeqCst))
            },
            Arc::new(TracedMarks),
        );
        warmup.schedule_default();
        warmup.schedule_default();
        assert!(warmup.pending());
        tokio::time::advance(Duration::from_millis(299)).await;
        tokio::task::yield_now().await;
        assert!(warmup.pending(), "not before the delay");
        tokio::time::advance(Duration::from_millis(2)).await;
        tokio::task::yield_now().await;
        assert!(!warmup.pending(), "the slot clears when the timer fires");
        closing.store(true, Ordering::SeqCst);
        warmup.schedule(0);
        assert!(!warmup.pending(), "a closing runtime arms nothing");
    }
}