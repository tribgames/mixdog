//! The provider model cache's own warm: Node's `scheduleProviderModelWarmup` (`warmup/provider-warmups.mjs`) with the
//! timer discipline of `warmup/timer-arm.mjs`, and the direct `warmProviderModelCache` calls of the account flows.
//!
//! Triggers, each Node's:
//! * boot: `scheduleProviderModelWarmup()` once the runtime is up ([`ModelWarmup::start`]);
//! * the first turn settling: `turn-settle.mjs` reschedules it once per process ([`ModelWarmup::first_turn_settled`]);
//! * a wake (a turn ended, a session create settled, a catalog refresh settled): a parked run re-checks on its own tick
//!   ([`ModelWarmup::wake`]);
//! * an account change: `warmProviderModelCache()` straight away, no switch, no deferral, no secrets
//!   ([`ModelWarmup::warm_now`]).
//!
//! A scheduled run does nothing when the cache is loaded or a load is in flight, parks while the runtime is busy or a
//! catalog refresh is running, and otherwise starts the load the readers share (`ModelListService::warm_cache`). The
//! refresh state it waits on is the catalog's own counter, so a job that is scheduled after the refresh began, or after
//! it settled, reads the same answer.
//!
//! Switches (`runtime-tunables.mjs`): `MIXDOG_DISABLE_PROVIDER_WARMUP` and `MIXDOG_DISABLE_MODEL_PREFETCH` (either on
//! turns the scheduled warm off), `MIXDOG_PROVIDER_MODEL_WARMUP_DELAY_MS` (default 0: the Rust runtime is the daemon,
//! `MIXDOG_DAEMON_HOST`; 0 to 120 000).

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::PoisonError;
use std::time::Duration;

use super::model_list::ModelListService;

/// Why a background job must wait for an idle runtime, or none (`busyReason` of `timer-arm.mjs`).
pub trait WarmupGates: Send + Sync {
    fn busy(&self) -> Option<&'static str>;
    /// `isCloseRequested()`.
    fn closing(&self) -> bool;
    /// Resolves when the runtime starts closing (	eardown clears the warm-up timers): a pending delay ends at once.
    fn closed(&self) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>;
}

/// `envFlag(name)`: only the documented spellings flip the fallback.
fn env_flag(raw: Option<String>, fallback: bool) -> bool {
    match raw.map(|raw| raw.trim().to_lowercase()) {
        Some(value) if matches!(value.as_str(), "1" | "true" | "yes" | "on") => true,
        Some(value) if matches!(value.as_str(), "0" | "false" | "off" | "no") => false,
        _ => fallback,
    }
}

/// `envDelayMs(name, fallback, { min: 0, max })`.
pub(super) fn env_delay(raw: Option<String>, fallback: u64, max: f64) -> Duration {
    let parsed = raw.filter(|raw| !raw.is_empty()).map(|raw| mixdog_js::string_to_number(&raw)).filter(|n| n.is_finite());
    Duration::from_millis(parsed.map_or(fallback as f64, |n| n.floor().clamp(0.0, max)) as u64)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WarmupConfig {
    /// `modelPrefetchEnabled`.
    pub enabled: bool,
    /// `providerModelWarmupDelayMs`.
    pub delay: Duration,
}

impl WarmupConfig {
    pub fn from_env(env: &dyn Fn(&str) -> Option<String>) -> Self {
        Self {
            enabled: !env_flag(env("MIXDOG_DISABLE_PROVIDER_WARMUP"), false) && !env_flag(env("MIXDOG_DISABLE_MODEL_PREFETCH"), false),
            delay: env_delay(env("MIXDOG_PROVIDER_MODEL_WARMUP_DELAY_MS"), 0, 120_000.0),
        }
    }
}

struct Bindings {
    list: Arc<ModelListService>,
    gates: Arc<dyn WarmupGates>,
}

#[derive(Default)]
struct State {
    /// `timers.providerModelWarmupTimer` is set.
    pending: bool,
    /// `park('providerModelWarmupTimer', run)`.
    parked: bool,
    /// `rt.firstTurnCompleted`.
    first_turn_done: bool,
    task: Option<tokio::task::JoinHandle<()>>,
}

pub struct ModelWarmup {
    config: WarmupConfig,
    bound: OnceLock<Bindings>,
    state: Mutex<State>,
}

impl ModelWarmup {
    pub fn new(config: WarmupConfig) -> Arc<Self> {
        Arc::new(Self { config, bound: OnceLock::new(), state: Mutex::new(State::default()) })
    }

    /// Binds the list the warm loads and the runtime's gates; once.
    pub fn bind(&self, list: Arc<ModelListService>, gates: Arc<dyn WarmupGates>) -> Result<(), ()> {
        self.bound.set(Bindings { list, gates }).map_err(|_| ())
    }

    pub fn is_bound(&self) -> bool {
        self.bound.get().is_some()
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The boot's `scheduleProviderModelWarmup()`.
    pub fn start(self: &Arc<Self>) {
        self.schedule();
    }

    /// `scheduleProviderModelWarmup(delayMs = providerModelWarmupDelayMs)`: nothing when the switches are off.
    fn schedule(self: &Arc<Self>) {
        if self.config.enabled {
            self.arm(self.config.delay);
        }
    }

    /// `arm`: one pending timer, none once the runtime is closing.
    fn arm(self: &Arc<Self>, delay: Duration) {
        let Some(bound) = self.bound.get() else { return };
        let mut state = self.state();
        if state.pending || bound.gates.closing() {
            return;
        }
        state.pending = true;
        // `setTimeout` counts from the call, not from when the task is first polled.
        let deadline = tokio::time::Instant::now() + delay;
        let this = self.clone();
        state.task = Some(mixdog_rt::spawn("model-warmup", mixdog_rt::TaskClass::Work, async move {
            if !delay.is_zero() {
                tokio::time::sleep_until(deadline).await;
            }
            this.fire();
        }));
    }

    /// `warmProviderModels`.
    fn fire(self: &Arc<Self>) {
        let Some(bound) = self.bound.get() else { return };
        let mut state = self.state();
        state.pending = false;
        if bound.gates.closing() || !bound.list.warm_needed() {
            return;
        }
        // The runtime is busy, or the startup catalog refresh is still running (it invalidates every model-derived
        // cache when it lands): wait for the next wake instead of polling.
        if bound.gates.busy().is_some() || bound.list.catalog.refresh_in_flight() {
            state.parked = true;
            return;
        }
        drop(state);
        bound.list.warm_cache(true);
    }

    /// `rt.wakeDeferredWarmups()`: a parked run re-checks once, on its own tick.
    pub fn wake(self: &Arc<Self>) {
        let parked = std::mem::take(&mut self.state().parked);
        if parked {
            self.arm(Duration::ZERO);
        }
    }

    /// `settleTurn`: the first settled turn of the process reschedules the warm (`isFirstTurnCompleted`).
    pub fn first_turn_settled(self: &Arc<Self>) {
        if !std::mem::replace(&mut self.state().first_turn_done, true) {
            self.schedule();
        }
    }

    /// `warmProviderModelCache()` of the account flows: straight away, whatever the switches say. Node passes no
    /// `loadSecrets`, so the load runs but is not adopted as the cache.
    pub fn warm_now(&self) {
        if let Some(bound) = self.bound.get() {
            bound.list.warm_cache(false);
        }
    }

    /// Waits for the scheduled run and the load it started; for the callers that must see the end of the warm.
    pub async fn settle(&self) {
        loop {
            let task = self.state().task.take();
            match task {
                Some(task) => {
                    let _ = task.await;
                }
                None => break,
            }
        }
        if let Some(bound) = self.bound.get() {
            bound.list.settle_warm().await;
        }
    }
}
