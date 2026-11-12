//! The statusline usage warm-up: Node's `createStatuslineUsageWarmup` (`warmup/statusline-usage-warmup.mjs`).
//!
//! When the live Main route names an OAuth provider, the daemon prepares that provider (the route's provider switched
//! on in the config the readiness initializes: `ensureProviderEnabled`) and then refreshes the route's usage reading.
//! Preparing it registers the provider, which is what makes its catalog (for an account that is not signed in, the
//! provider's own fallback family rows) part of every provider-model read: Node's `listProviderModels` lists the default
//! route's provider only because this warm-up ran.
//!
//! Triggers, each Node's:
//! * boot: `scheduleStatuslineUsageWarmup()` ([`StatuslineWarmup::start`]), after `MIXDOG_STATUSLINE_USAGE_WARMUP_DELAY_MS`
//!   (default 800, 0 to 60 000); it does nothing when the route is not an OAuth one, parks while the runtime is busy and
//!   re-checks the route when it runs;
//! * a wake (a turn ended, a session create settled, a catalog refresh settled): a parked run re-checks on its own tick
//!   ([`StatuslineWarmup::wake`]);
//! * a turn settling: `refreshStatuslineUsageAfterTurn` prepares and refreshes at once, with no delay and no deferral
//!   ([`StatuslineWarmup::turn_settled`]).
//!
//! A preparation first awaits the keychain prewarm and loads the full config (`ensureConfigForRouteProvider`), then
//! readies the route's provider ([`UsagePrep`]).

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::PoisonError;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_ai::catalog::ProviderReadiness;
use mixdog_ai::service::admin_route::Obj;
use mixdog_ai::service::admin_route::clean;
use mixdog_ai::service::admin_route::ensure_provider_enabled;
use serde_json::Value;
use serde_json::json;

use super::model_warmup::WarmupGates;
use super::model_warmup::env_delay;
use super::provider_sync::LoadedConfig;
use crate::domains::ai_account::setup_cache::KeychainLive;

/// `refreshStatuslineUsageSnapshot(route)`: the usage service measures the route's account in the background.
pub trait StatuslineSink: Send + Sync {
    fn refresh_route(&self, route: &Obj);
}

/// What a usage refresh prepares before it reads: `awaitKeychainPrewarm`, `ensureConfigForRouteProvider` and
/// `ensureProvidersReady(ensureProviderEnabled(getConfig(), provider))`.
#[async_trait]
pub trait UsagePrep: Send + Sync {
    async fn keychain_prewarm(&self);
    fn ensure_config_for_route_provider(&self);
    async fn ensure_provider_ready(&self, provider: &str) -> Result<(), String>;
}

/// The daemon's preparation: its keychain, the loaded config and the provider readiness.
pub struct ReadinessPrep {
    pub keychain: Arc<dyn KeychainLive>,
    /// `getConfig()`: the loaded config.
    pub loaded: Arc<LoadedConfig>,
    pub readiness: Arc<ProviderReadiness>,
}

#[async_trait]
impl UsagePrep for ReadinessPrep {
    async fn keychain_prewarm(&self) {
        self.keychain.await_prewarm().await;
    }

    /// The loaded config is the one built with the secrets (the provider sync rebuilds it on every change): there is
    /// nothing further to load.
    fn ensure_config_for_route_provider(&self) {}

    async fn ensure_provider_ready(&self, provider: &str) -> Result<(), String> {
        let config = self.loaded.get();
        self.readiness.ensure_providers_ready(Some(ensure_provider_enabled(&config, provider))).await.map(drop).map_err(|error| error.message)
    }
}

/// `timers.statuslineUsageWarmupTimer`.
const SLOT: &str = "statuslineUsageWarmupTimer";
/// The refresh after a settled turn, a job with no timer.
const AFTER_TURN: &str = "statuslineUsageAfterTurn";

struct Bindings {
    /// `getRoute()`: the live Main route.
    route: Arc<dyn Fn() -> Obj + Send + Sync>,
    prep: Arc<dyn UsagePrep>,
    sink: Arc<dyn StatuslineSink>,
    gates: Arc<dyn WarmupGates>,
}

impl Bindings {
    /// `oauthProviderId()`.
    fn oauth_route(&self) -> Option<Obj> {
        let route = (self.route)();
        clean(route.get("provider")).contains("oauth").then_some(route)
    }
}

#[derive(Default)]
struct State {
    /// `timers.statuslineUsageWarmupTimer` is set.
    pending: bool,
    /// `park('statuslineUsageWarmupTimer', run)`.
    parked: bool,
    task: Option<tokio::task::JoinHandle<()>>,
}

pub struct StatuslineWarmup {
    /// Tests: one permit once the delay's timer is registered with the runtime.
    #[cfg(test)]
    pub(super) armed: tokio::sync::Semaphore,
    /// `statuslineUsageWarmupDelayMs`.
    delay: Duration,
    bound: OnceLock<Bindings>,
    state: Mutex<State>,
}

impl StatuslineWarmup {
    pub fn new(env: &dyn Fn(&str) -> Option<String>) -> Arc<Self> {
        let delay = env_delay(env("MIXDOG_STATUSLINE_USAGE_WARMUP_DELAY_MS"), 800, 60_000.0);
        Arc::new(Self {
            #[cfg(test)]
            armed: tokio::sync::Semaphore::new(0),
            delay,
            bound: OnceLock::new(), state: Mutex::new(State::default()) })
    }

    /// Binds the route, the preparation, the usage service and the gates it works over; once.
    pub fn bind(&self, route: Arc<dyn Fn() -> Obj + Send + Sync>, prep: Arc<dyn UsagePrep>, sink: Arc<dyn StatuslineSink>, gates: Arc<dyn WarmupGates>) -> Result<(), ()> {
        self.bound.set(Bindings { route, prep, sink, gates }).map_err(|_| ())
    }

    pub fn is_bound(&self) -> bool {
        self.bound.get().is_some()
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `timers.statuslineUsageWarmupTimer` is set.
    pub fn pending(&self) -> bool {
        self.state().pending
    }

    /// The boot's `scheduleStatuslineUsageWarmup()`: a route that is not an OAuth one is marked skipped.
    pub fn start(self: &Arc<Self>) {
        let Some(bound) = self.bound.get() else { return };
        if bound.oauth_route().is_some() {
            self.arm(self.delay);
        } else {
            let provider = clean((bound.route)().get("provider"));
            let provider = if provider.is_empty() { Value::Null } else { Value::String(provider) };
            bound.gates.profile("statusline-usage:warm-skipped", Some(json!({ "provider": provider })));
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
        // setTimeout counts from the call; teardown clears the timer, so the runtime closing ends the wait.
        let deadline = tokio::time::Instant::now() + delay;
        let closed = bound.gates.closed();
        let this = self.clone();
        state.task = Some(mixdog_rt::spawn("statusline-usage-warmup", mixdog_rt::TaskClass::Work, async move {
            if !delay.is_zero() {
                let sleep = mixdog_rt::time::sleep_until(deadline);
                tokio::pin!(sleep);
                #[cfg(test)]
                {
                    // The first poll registers the timer.
                    let _ = futures::poll!(sleep.as_mut());
                    this.armed.add_permits(1);
                }
                tokio::select! {
                    () = &mut sleep => {}
                    () = closed => {
                        this.state().pending = false;
                        return;
                    }
                }
            }
            let Some(bound) = this.bound.get() else { return };
            bound.gates.running(SLOT, true);
            this.run(bound).await;
            bound.gates.running(SLOT, false);
        }));
    }

    /// `warmStatuslineUsage`: a parked run may wake after the route left OAuth; a busy runtime parks it again.
    async fn run(&self, bound: &Bindings) {
        {
            let mut state = self.state();
            state.pending = false;
            if bound.gates.closing() || bound.oauth_route().is_none() {
                return;
            }
            if let Some(reason) = bound.gates.busy() {
                state.parked = true;
                drop(state);
                bound.gates.profile("statusline-usage:warm-deferred", Some(json!({ "reason": reason })));
                return;
            }
        }
        match Self::refresh_idle(bound).await {
            // Node's mark after the preparation and the dispatch of the refresh, only for the scheduled warm (not a settled turn).
            Ok(Some(provider)) => bound.gates.profile("statusline-usage:warm-ready", Some(json!({ "provider": provider }))),
            Ok(None) => {}
            Err(error) => bound.gates.profile("statusline-usage:warm-failed", Some(json!({ "error": error }))),
        }
    }

    /// `refreshIdleStatuslineUsage`: the keychain and the config loaded, the route's provider prepared, then the reading
    /// of the route that was prepared (not of one selected while the preparation was pending). The provider of the route
    /// whose reading was dispatched, or none when the runtime was closing.
    async fn refresh_idle(bound: &Bindings) -> Result<Option<String>, String> {
        bound.prep.keychain_prewarm().await;
        if bound.gates.closing() {
            return Ok(None);
        }
        bound.prep.ensure_config_for_route_provider();
        let route = (bound.route)();
        let provider = clean(route.get("provider"));
        bound.prep.ensure_provider_ready(&provider).await?;
        if bound.gates.closing() {
            return Ok(None);
        }
        bound.sink.refresh_route(&route);
        Ok(Some(provider))
    }

    /// `rt.wakeDeferredWarmups()`: a parked run re-checks once, on its own tick.
    pub fn wake(self: &Arc<Self>) {
        let parked = std::mem::take(&mut self.state().parked);
        if parked {
            self.arm(Duration::ZERO);
        }
    }

    /// `refreshStatuslineUsageAfterTurn`: the turn spent quota, so the reading follows it, not a timer. Failures are
    /// dropped: the usage display never affects the session runtime.
    pub fn turn_settled(self: &Arc<Self>) {
        let Some(bound) = self.bound.get() else { return };
        if bound.gates.closing() || bound.oauth_route().is_none() {
            return;
        }
        let this = self.clone();
        bound.gates.running(AFTER_TURN, true);
        drop(mixdog_rt::spawn("statusline-usage-turn", mixdog_rt::TaskClass::Work, async move {
            if let Some(bound) = this.bound.get() {
                let _ = Self::refresh_idle(bound).await;
                bound.gates.running(AFTER_TURN, false);
            }
        }));
    }

    /// Waits for the scheduled run; for the callers that must see the end of the warm.
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
    }
}
