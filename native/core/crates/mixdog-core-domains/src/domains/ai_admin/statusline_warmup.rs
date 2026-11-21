//! When the live Main route names an OAuth provider, the provider is prepared and the route's usage
//! reading refreshed: at boot after `MIXDOG_STATUSLINE_USAGE_WARMUP_DELAY_MS` (default 800, 0 to
//! 60 000), on a wake, and at once when a turn settles.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::PoisonError;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_ai::catalog::ProviderReadiness;
use mixdog_ai::service::admin_route::Obj;
use mixdog_ai::service::admin_route::clean;
use mixdog_core_config::config::Config;
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
    /// `false` when the user switched `provider` off: nothing is readied and the warm-up ends.
    async fn ensure_provider_ready(&self, provider: &str) -> Result<bool, String>;
}

/// The daemon's preparation: its keychain, the stored and the loaded config and the provider readiness.
pub struct ReadinessPrep {
    pub keychain: Arc<dyn KeychainLive>,
    /// The stored config: the user's own decisions.
    pub config: Config,
    /// `getConfig()`: the loaded config.
    pub loaded: Arc<LoadedConfig>,
    pub readiness: Arc<ProviderReadiness>,
}

#[async_trait]
impl UsagePrep for ReadinessPrep {
    async fn keychain_prewarm(&self) {
        self.keychain.await_prewarm().await;
    }

    fn ensure_config_for_route_provider(&self) {}

    async fn ensure_provider_ready(&self, provider: &str) -> Result<bool, String> {
        let stored = self.config.agent();
        if stored.get("providers").and_then(|providers| providers.get(provider)).and_then(|entry| entry.get("enabled")) == Some(&Value::Bool(false)) {
            return Ok(false);
        }
        let mut providers = self.loaded.providers();
        let mut entry = providers.get(provider).and_then(Value::as_object).cloned().unwrap_or_default();
        entry.insert("enabled".into(), Value::Bool(true));
        providers.insert(provider.to_owned(), Value::Object(entry));
        self.readiness.ensure_providers_ready(Some(providers)).await.map(|()| true).map_err(|error| error.message)
    }
}

/// `timers.statuslineUsageWarmupTimer`.
const SLOT: &str = "statuslineUsageWarmupTimer";
/// The refresh after a settled turn, a job with no timer.
pub(super) const AFTER_TURN: &str = "statuslineUsageAfterTurn";

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
            bound: OnceLock::new(),
            state: Mutex::new(State::default()),
        })
    }

    /// Binds the route, the preparation, the usage service and the gates it works over; once.
    #[allow(clippy::result_unit_err, reason = "existing one-time binding API: unit means already bound, with no public diagnostic payload")]
    pub fn bind(
        &self,
        route: Arc<dyn Fn() -> Obj + Send + Sync>,
        prep: Arc<dyn UsagePrep>,
        sink: Arc<dyn StatuslineSink>,
        gates: Arc<dyn WarmupGates>,
    ) -> Result<(), ()> {
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
        let route = {
            let mut state = self.state();
            state.pending = false;
            if bound.gates.closing() {
                return;
            }
            let Some(route) = bound.oauth_route() else { return };
            if let Some(reason) = bound.gates.busy() {
                state.parked = true;
                drop(state);
                bound.gates.profile("statusline-usage:warm-deferred", Some(json!({ "reason": reason })));
                return;
            }
            route
        };
        match Self::refresh_idle(bound, &route).await {
            // Node's mark after the preparation and the dispatch of the refresh, only for the scheduled warm (not a settled turn).
            Ok(Some(provider)) => bound.gates.profile("statusline-usage:warm-ready", Some(json!({ "provider": provider }))),
            Ok(None) => {}
            Err(error) => bound.gates.profile("statusline-usage:warm-failed", Some(json!({ "error": error }))),
        }
    }

    /// `refreshIdleStatuslineUsage` of `route`, the OAuth route the trigger checked: the keychain and the config loaded,
    /// its provider prepared, then its reading (never of a route selected meanwhile). The provider whose reading was
    /// dispatched, or none when the runtime was closing or the user switched the provider off.
    async fn refresh_idle(bound: &Bindings, route: &Obj) -> Result<Option<String>, String> {
        bound.prep.keychain_prewarm().await;
        if bound.gates.closing() {
            return Ok(None);
        }
        bound.prep.ensure_config_for_route_provider();
        let provider = clean(route.get("provider"));
        if !bound.prep.ensure_provider_ready(&provider).await? || bound.gates.closing() {
            return Ok(None);
        }
        bound.sink.refresh_route(route);
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
        if bound.gates.closing() {
            return;
        }
        let Some(route) = bound.oauth_route() else { return };
        let this = self.clone();
        bound.gates.running(AFTER_TURN, true);
        drop(mixdog_rt::spawn("statusline-usage-turn", mixdog_rt::TaskClass::Work, async move {
            if let Some(bound) = this.bound.get() {
                let _ = Self::refresh_idle(bound, &route).await;
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
