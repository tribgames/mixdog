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

use serde_json::Value;
use serde_json::json;

use super::model_list::ModelListService;

/// What the runtime sees of its background warm-ups: Node's `bootProfile` marks and the caller-owned timer slots of
/// `timer-arm.mjs` (`timers[slot]`).
pub trait WarmupMarks: Send + Sync {
    /// `bootProfile(event, meta)`: the diagnostic mark; `None` is a mark without meta.
    fn profile(&self, event: &str, detail: Option<Value>);
    /// `timers[slot] = setTimeout(run, delay)`.
    fn armed(&self, _slot: &'static str, _delay: Duration) {}
    /// A job of `slot` started (its timer fired, or it runs at once) or ended.
    fn running(&self, _slot: &'static str, _running: bool) {}
}

/// Why a background job must wait for an idle runtime, or none (`busyReason` of `timer-arm.mjs`).
pub trait WarmupGates: WarmupMarks {
    fn busy(&self) -> Option<&'static str>;
    /// `isCloseRequested()`.
    fn closing(&self) -> bool;
    /// Resolves when the runtime starts closing (teardown clears the warm-up timers): a pending delay ends at once.
    fn closed(&self) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>;
}

/// The provider model cache as its warm sees it (`getProviderModelsCache`, `getProviderModelsPromise`,
/// `isCatalogRefreshPending`, `warmProviderModelCache`).
pub trait ModelCacheWarm: Send + Sync {
    /// Neither loaded nor loading.
    fn warm_needed(&self) -> bool;
    /// The startup catalog refresh is still running.
    fn refresh_pending(&self) -> bool;
    /// `warmProviderModelCache({ loadSecrets })`.
    fn warm(&self, load_secrets: bool);
    /// Waits for the load in flight, if any.
    fn settle(&self) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>>;
}

impl ModelCacheWarm for ModelListService {
    fn warm_needed(&self) -> bool {
        ModelListService::warm_needed(self)
    }
    fn refresh_pending(&self) -> bool {
        self.catalog.refresh_in_flight()
    }
    fn warm(&self, load_secrets: bool) {
        self.warm_cache(load_secrets);
    }
    fn settle(&self) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        Box::pin(self.settle_warm())
    }
}

/// `envFlag(name)` as the runtime's switches read it.
pub fn warmup_env_flag(raw: Option<String>) -> bool {
    env_flag(raw, false)
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
    /// `envFlag('MIXDOG_PROVIDER_WARMUP_BEFORE_FIRST_TURN')`: a warm before the first turn is not a deferred one.
    pub before_first_turn: bool,
}

impl WarmupConfig {
    pub fn from_env(env: &dyn Fn(&str) -> Option<String>) -> Self {
        Self {
            enabled: !env_flag(env("MIXDOG_DISABLE_PROVIDER_WARMUP"), false) && !env_flag(env("MIXDOG_DISABLE_MODEL_PREFETCH"), false),
            delay: env_delay(env("MIXDOG_PROVIDER_MODEL_WARMUP_DELAY_MS"), 0, 120_000.0),
            before_first_turn: env_flag(env("MIXDOG_PROVIDER_WARMUP_BEFORE_FIRST_TURN"), false),
        }
    }
}

/// `timers.providerModelWarmupTimer`.
const SLOT: &str = "providerModelWarmupTimer";

struct Bindings {
    cache: Arc<dyn ModelCacheWarm>,
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

    /// Binds the list the warm loads and the runtime's gates; once. The catalog's route-meta memo schedules this
    /// warm-up on a non-fetching miss (`scheduleProviderModelWarmup` handed to `createModelMetaIndex`): one mechanism,
    /// with the same switches, delay and parking as the boot's.
    pub fn bind(self: &Arc<Self>, list: Arc<ModelListService>, gates: Arc<dyn WarmupGates>) -> Result<(), ()> {
        let catalog = list.catalog.clone();
        self.bind_cache(list, gates)?;
        let this = Arc::downgrade(self);
        catalog.bind_warmup(move || {
            if let Some(warmup) = this.upgrade() {
                warmup.schedule();
            }
        });
        Ok(())
    }

    /// Binds the cache the warm loads and the runtime's gates; once.
    pub fn bind_cache(&self, cache: Arc<dyn ModelCacheWarm>, gates: Arc<dyn WarmupGates>) -> Result<(), ()> {
        self.bound.set(Bindings { cache, gates }).map_err(|_| ())
    }

    pub fn is_bound(&self) -> bool {
        self.bound.get().is_some()
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `timers.providerModelWarmupTimer` is set.
    pub fn pending(&self) -> bool {
        self.state().pending
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
        bound.gates.armed(SLOT, delay);
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

    /// The timer fired: `warmProviderModels` unless the runtime is closing.
    fn fire(self: &Arc<Self>) {
        let Some(bound) = self.bound.get() else { return };
        bound.gates.running(SLOT, true);
        self.warm_models(bound);
        bound.gates.running(SLOT, false);
    }

    /// `warmProviderModels`.
    fn warm_models(&self, bound: &Bindings) {
        let mut state = self.state();
        state.pending = false;
        if bound.gates.closing() || !bound.cache.warm_needed() {
            return;
        }
        // The runtime is busy, or the startup catalog refresh is still running (it invalidates every model-derived
        // cache when it lands): wait for the next wake instead of polling.
        let reason = bound.gates.busy().or_else(|| bound.cache.refresh_pending().then_some("catalog-refresh-pending"));
        if let Some(reason) = reason {
            state.parked = true;
            drop(state);
            bound.gates.profile("provider-models:warm-deferred", Some(json!({ "reason": reason })));
            return;
        }
        // Before the first turn the warm still runs, secrets-aware; the first turn's settle schedules it again.
        let deferred = !state.first_turn_done && !self.config.before_first_turn;
        drop(state);
        if deferred {
            bound.gates.profile("provider-models:warm-deferred", Some(json!({ "reason": "first-turn-pending" })));
        }
        bound.cache.warm(true);
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
            bound.cache.warm(false);
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
            bound.cache.settle().await;
        }
    }
}
