//! The provider initialization warm: Node's `scheduleProviderWarmup` (`warmup/provider-warmups.mjs`) with the timer
//! discipline of `warmup/timer-arm.mjs`.
//!
//! Triggers, each Node's:
//! * boot: `scheduleProviderWarmup()` once the runtime is up ([`ProviderWarmup::start`]);
//! * the first turn settling: `turn-settle.mjs` reschedules it once per process ([`ProviderWarmup::first_turn_settled`]);
//! * a wake (a turn ended, a session create settled, a catalog refresh settled): a parked run re-checks on its own tick
//!   ([`ProviderWarmup::wake`]).
//!
//! A run before the first turn is deferred (unless `MIXDOG_PROVIDER_WARMUP_BEFORE_FIRST_TURN`), a busy runtime parks it;
//! otherwise it awaits the keychain prewarm, reloads the full config and readies the configured providers.
//!
//! Switches (`runtime-tunables.mjs`): `providerWarmupEnabled` is opt-in (`MIXDOG_ENABLE_PROVIDER_WARMUP`,
//! `MIXDOG_PROVIDER_WARMUP_BEFORE_FIRST_TURN` or either warm-up delay set, and not `MIXDOG_DISABLE_PROVIDER_WARMUP`);
//! `MIXDOG_PROVIDER_WARMUP_DELAY_MS` (default 1 500, 0 to 60 000).

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::PoisonError;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::json;

use super::model_warmup::WarmupGates;
use super::model_warmup::env_delay;
use super::model_warmup::warmup_env_flag;

/// What the warm runs: `awaitKeychainPrewarm`, `reloadFullConfig` and `ensureProvidersReady(getConfig().providers)`.
#[async_trait]
pub trait ProviderInit: Send + Sync {
    async fn keychain_prewarm(&self) -> Result<(), String>;
    async fn reload_full_config(&self) -> Result<(), String>;
    async fn ensure_providers_ready(&self) -> Result<(), String>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProviderWarmupConfig {
    /// `providerWarmupEnabled`.
    pub enabled: bool,
    /// `providerWarmupDelayMs`.
    pub delay: Duration,
    /// `envFlag('MIXDOG_PROVIDER_WARMUP_BEFORE_FIRST_TURN')`.
    pub before_first_turn: bool,
}

impl ProviderWarmupConfig {
    pub fn from_env(env: &dyn Fn(&str) -> Option<String>) -> Self {
        let flag = |name: &str| warmup_env_flag(env(name));
        // `envPresent(name)`: set at all, whatever the value.
        let present = |name: &str| env(name).is_some();
        let before_first_turn = flag("MIXDOG_PROVIDER_WARMUP_BEFORE_FIRST_TURN");
        Self {
            enabled: !flag("MIXDOG_DISABLE_PROVIDER_WARMUP")
                && (flag("MIXDOG_ENABLE_PROVIDER_WARMUP") || before_first_turn || present("MIXDOG_PROVIDER_WARMUP_DELAY_MS") || present("MIXDOG_PROVIDER_MODEL_WARMUP_DELAY_MS")),
            delay: env_delay(env("MIXDOG_PROVIDER_WARMUP_DELAY_MS"), 1_500, 60_000.0),
            before_first_turn,
        }
    }
}

/// `timers.providerWarmupTimer`.
const SLOT: &str = "providerWarmupTimer";

struct Bindings {
    init: Arc<dyn ProviderInit>,
    gates: Arc<dyn WarmupGates>,
}

#[derive(Default)]
struct State {
    /// `timers.providerWarmupTimer` is set.
    pending: bool,
    /// `park('providerWarmupTimer', run)`.
    parked: bool,
    /// `rt.firstTurnCompleted`.
    first_turn_done: bool,
}

pub struct ProviderWarmup {
    config: ProviderWarmupConfig,
    bound: OnceLock<Bindings>,
    state: Mutex<State>,
}

impl ProviderWarmup {
    pub fn new(config: ProviderWarmupConfig) -> Arc<Self> {
        Arc::new(Self { config, bound: OnceLock::new(), state: Mutex::new(State::default()) })
    }

    /// Binds what the warm runs and the runtime's gates; once.
    pub fn bind(&self, init: Arc<dyn ProviderInit>, gates: Arc<dyn WarmupGates>) -> Result<(), ()> {
        self.bound.set(Bindings { init, gates }).map_err(|_| ())
    }

    pub fn is_bound(&self) -> bool {
        self.bound.get().is_some()
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `timers.providerWarmupTimer` is set.
    pub fn pending(&self) -> bool {
        self.state().pending
    }

    /// The boot's `scheduleProviderWarmup()`.
    pub fn start(self: &Arc<Self>) {
        self.schedule();
    }

    /// `scheduleProviderWarmup(delayMs = providerWarmupDelayMs)`: switched off, the skip is marked.
    fn schedule(self: &Arc<Self>) {
        let Some(bound) = self.bound.get() else { return };
        if self.config.enabled {
            self.arm(self.config.delay);
        } else {
            bound.gates.profile("providers:warm-skipped", None);
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
        drop(mixdog_rt::spawn("provider-warmup", mixdog_rt::TaskClass::Work, async move {
            tokio::time::sleep_until(deadline).await;
            let Some(bound) = this.bound.get() else { return };
            bound.gates.running(SLOT, true);
            this.state().pending = false;
            if !bound.gates.closing() {
                this.warm_providers(bound).await;
            }
            bound.gates.running(SLOT, false);
        }));
    }

    /// `warmProviders`.
    async fn warm_providers(&self, bound: &Bindings) {
        {
            let mut state = self.state();
            if !state.first_turn_done && !self.config.before_first_turn {
                drop(state);
                bound.gates.profile("providers:warm-deferred", Some(json!({ "reason": "first-turn-pending" })));
                return;
            }
            if let Some(reason) = bound.gates.busy() {
                state.parked = true;
                drop(state);
                bound.gates.profile("providers:warm-deferred", Some(json!({ "reason": reason })));
                return;
            }
        }
        let started = tokio::time::Instant::now();
        let loaded = match bound.init.keychain_prewarm().await {
            Ok(()) if bound.gates.closing() => return,
            Ok(()) => bound.init.reload_full_config().await,
            Err(error) => Err(error),
        };
        if let Err(error) = loaded {
            bound.gates.profile("config:full-failed", Some(json!({ "error": error })));
        }
        if bound.gates.closing() {
            return;
        }
        match bound.init.ensure_providers_ready().await {
            Ok(()) if bound.gates.closing() => {}
            Ok(()) => {
                let ms = started.elapsed().as_secs_f64() * 1000.0;
                bound.gates.profile("providers:init:ready", Some(json!({ "ms": format!("{ms:.1}") })));
            }
            Err(error) => bound.gates.profile("providers:warm-failed", Some(json!({ "error": error }))),
        }
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
}
