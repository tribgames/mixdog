//! The daemon's warm-up schedulers (`WarmupSchedulers`, the object the boot, the turn settle and the wakes call) over the five
//! warm-ups, on the paused clock and a scripted world: the runtime's gates and marks, and every dependency a warm-up calls. An async
//! dependency resolves at the next `quiet`, a gated one once its gate is opened; time moves only by `tick`.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_ai::service::admin_route::Obj;
use mixdog_core_domains::domains::ai_account::collaborators::ProviderSetup;
use mixdog_core_domains::domains::ai_account::failure::Failure;
use mixdog_core_domains::domains::ai_admin::model_warmup::ModelCacheWarm;
use mixdog_core_domains::domains::ai_admin::model_warmup::ModelWarmup;
use mixdog_core_domains::domains::ai_admin::model_warmup::WarmupConfig;
use mixdog_core_domains::domains::ai_admin::model_warmup::WarmupGates;
use mixdog_core_domains::domains::ai_admin::model_warmup::WarmupMarks;
use mixdog_core_domains::domains::ai_admin::provider_warmup::ProviderInit;
use mixdog_core_domains::domains::ai_admin::provider_warmup::ProviderWarmup;
use mixdog_core_domains::domains::ai_admin::provider_warmup::ProviderWarmupConfig;
use mixdog_core_domains::domains::ai_admin::statusline_warmup::StatuslineSink;
use mixdog_core_domains::domains::ai_admin::statusline_warmup::StatuslineWarmup;
use mixdog_core_domains::domains::ai_admin::statusline_warmup::UsagePrep;
use serde_json::Value;
use serde_json::json;
use tokio::sync::Notify;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::catalog::CatalogRefresh;
use crate::catalog::CatalogWarmup;
use crate::prewarm_world::WarmupSchedulers;
use crate::setup_host::SetupWarmup;

/// The bound on every wait for the warm-ups to reach the state a step ends in.
const DEADLINE: Duration = Duration::from_secs(10);

/// A dependency call in flight: it resolves when the test releases it.
struct Dep {
    id: u64,
    /// The gate it waits on; none: an async dependency that resolves at the next yield.
    gate: Option<String>,
    release: Option<oneshot::Sender<Result<(), String>>>,
}

#[derive(Default)]
struct Inner {
    closed: bool,
    route: Obj,
    active: u32,
    catalog_pending: bool,
    /// `world.outcome`: the catalog warm's answer (`Err`: it throws).
    outcome: Option<Result<Value, String>>,
    first_turn_done: bool,
    keychain_gate: bool,
    provider_gate: bool,
    calls: Vec<Value>,
    events: Vec<Value>,
    warms: Vec<Value>,
    catalog_runs: Vec<Value>,
    /// `timers`: each slot ever armed, in the order first armed; `true` while armed.
    timers: Vec<(&'static str, bool)>,
    /// The timers armed and not yet fired, with their deadline.
    due: Vec<(&'static str, tokio::time::Instant)>,
    armed_now: Vec<Value>,
    /// Jobs started and not ended.
    running: i64,
    deps: Vec<Dep>,
    next_dep: u64,
    /// The gates opened: resolved (`Ok`) or rejected with the message.
    opened: HashMap<String, Result<(), String>>,
}

/// The scripted world: the runtime's gates and marks, and every scripted dependency.
#[derive(Default)]
struct World {
    inner: Mutex<Inner>,
    changed: Notify,
    close: CancellationToken,
}

impl World {
    fn with<T>(&self, f: impl FnOnce(&mut Inner) -> T) -> T {
        let out = f(&mut self.inner.lock().unwrap());
        self.changed.notify_waiters();
        out
    }

    /// A dependency call: registered at once, it resolves when released.
    async fn dep(self: &Arc<Self>, gate: Option<&str>) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        let id = self.with(|inner| {
            inner.next_dep += 1;
            inner.deps.push(Dep { id: inner.next_dep, gate: gate.map(str::to_owned), release: Some(tx) });
            inner.next_dep
        });
        struct Done(Arc<World>, u64);
        impl Drop for Done {
            fn drop(&mut self) {
                let id = self.1;
                self.0.with(|inner| inner.deps.retain(|dep| dep.id != id));
            }
        }
        let _done = Done(self.clone(), id);
        rx.await.expect("a dependency in flight is released or the test ends")
    }

    /// Waits until `ready` holds, re-checked on every change, under one real-time deadline for the whole wait. The
    /// deadline is a blocking task: while it runs the paused clock does not advance by itself (Tokio inhibits
    /// auto-advance while a blocking task runs), so only a `tick` moves time.
    #[allow(
        clippy::disallowed_methods,
        reason = "Test-only blocking watchdog/exit wait; its owned completion signal is released by the fixture, not product work."
    )]
    async fn until(&self, what: &str, mut ready: impl FnMut(&mut Inner) -> bool) {
        let (done, ended) = std::sync::mpsc::channel::<()>();
        let mut deadline = tokio::task::spawn_blocking(move || matches!(ended.recv_timeout(DEADLINE), Err(std::sync::mpsc::RecvTimeoutError::Timeout)));
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if ready(&mut self.inner.lock().unwrap()) {
                // Returned without yielding, so no timer due at this instant fires before the step's state is read; the
                // deadline task ends as `done` is dropped.
                drop(done);
                return;
            }
            tokio::select! {
                () = &mut changed => {}
                expired = &mut deadline => {
                    assert!(!expired.expect("the deadline task"), "timed out after {DEADLINE:?} waiting for {what}");
                    unreachable!("the deadline task ends only when the wait ends or its deadline passes");
                }
            }
        }
    }

    /// The end of a step that resolves nothing: after a tick every timer due has fired, and every job started is
    /// waiting on a dependency or has ended. Only a tick fires a timer (the mock clock), so a step that is not one waits
    /// on nothing when no job runs.
    async fn settle(&self, label: &str, ticked: bool) {
        self.until(label, |inner| {
            let now = tokio::time::Instant::now();
            !(ticked && inner.due.iter().any(|(_, at)| *at <= now)) && inner.running == inner.deps.len() as i64
        })
        .await;
    }

    /// A `yield`: every dependency not held by a closed gate resolves, and so does every one its continuation calls,
    /// until each job left waits on a held gate.
    async fn quiet(&self, label: &str) {
        self.until(label, |inner| {
            let opened = inner.opened.clone();
            for dep in &mut inner.deps {
                let answer = match &dep.gate {
                    None => Some(Ok(())),
                    Some(gate) => opened.get(gate).cloned(),
                };
                if let Some(answer) = answer
                    && let Some(release) = dep.release.take()
                {
                    let _ = release.send(answer);
                }
            }
            inner.running == inner.deps.len() as i64 && inner.deps.iter().all(|dep| dep.release.is_some())
        })
        .await;
    }
}

impl WarmupMarks for World {
    fn profile(&self, event: &str, detail: Option<Value>) {
        // The elapsed time of the provider init is not kept.
        let event = match detail {
            Some(Value::Object(mut meta)) => {
                if meta.contains_key("ms") {
                    meta.insert("ms".into(), json!("<elapsed ms>"));
                }
                json!([event, meta])
            }
            Some(detail) => json!([event, detail]),
            None => json!(event),
        };
        self.with(|inner| inner.events.push(event));
    }

    fn armed(&self, slot: &'static str, delay: Duration) {
        self.with(|inner| {
            match inner.timers.iter_mut().find(|(seen, _)| *seen == slot) {
                Some(entry) => entry.1 = true,
                None => inner.timers.push((slot, true)),
            }
            inner.due.push((slot, tokio::time::Instant::now() + delay));
            inner.armed_now.push(json!(delay.as_millis() as u64));
        });
    }

    fn running(&self, slot: &'static str, running: bool) {
        self.with(|inner| {
            if running {
                // A timer fired: its slot is cleared (`timers[key] = null`).
                if let Some(at) = inner.due.iter().position(|(seen, _)| *seen == slot) {
                    inner.due.remove(at);
                    if let Some(entry) = inner.timers.iter_mut().find(|(seen, _)| *seen == slot) {
                        entry.1 = false;
                    }
                }
                inner.running += 1;
            } else {
                inner.running -= 1;
            }
        });
    }
}

impl WarmupGates for World {
    /// `busyReason()`: a turn running (no session create in this world).
    fn busy(&self) -> Option<&'static str> {
        (self.inner.lock().unwrap().active > 0).then_some("turn-active")
    }
    fn closing(&self) -> bool {
        self.inner.lock().unwrap().closed
    }
    fn closed(&self) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
        let close = self.close.clone();
        Box::pin(async move { close.cancelled().await })
    }
}

/// The world as each warm-up's dependency port.
struct Port(Arc<World>);

#[async_trait]
impl ProviderInit for Port {
    async fn keychain_prewarm(&self) -> Result<(), String> {
        let gated = self.0.inner.lock().unwrap().keychain_gate;
        self.0.dep(gated.then_some("keychain")).await
    }
    async fn reload_full_config(&self) -> Result<(), String> {
        self.0.with(|inner| inner.calls.push(json!("reload")));
        Ok(())
    }
    async fn ensure_providers_ready(&self) -> Result<(), String> {
        let gated = self.0.inner.lock().unwrap().provider_gate;
        if !gated {
            self.0.with(|inner| inner.calls.push(json!("providers")));
        }
        self.0.dep(gated.then_some("provider")).await
    }
}

#[async_trait]
impl UsagePrep for Port {
    async fn keychain_prewarm(&self) {
        // The scripted keychain of the statusline cases only resolves.
        ProviderInit::keychain_prewarm(self).await.expect("the keychain gate of a statusline case resolves");
    }
    fn ensure_config_for_route_provider(&self) {
        self.0.with(|inner| inner.calls.push(json!("config")));
    }
    async fn ensure_provider_ready(&self, _provider: &str) -> Result<(), String> {
        ProviderInit::ensure_providers_ready(self).await
    }
}

impl StatuslineSink for Port {
    fn refresh_route(&self, route: &Obj) {
        self.0.with(|inner| inner.calls.push(json!(["usage", route])));
    }
}

impl ModelCacheWarm for Port {
    /// `getProviderModelsCache()` is `{}` and no load is in flight.
    fn warm_needed(&self) -> bool {
        true
    }
    fn refresh_pending(&self) -> bool {
        self.0.inner.lock().unwrap().catalog_pending
    }
    fn warm(&self, load_secrets: bool) {
        self.0.with(|inner| inner.warms.push(json!({ "loadSecrets": load_secrets })));
    }
    fn settle(&self) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        Box::pin(async {})
    }
}

#[async_trait]
impl CatalogRefresh for Port {
    async fn warm(&self) -> Result<(), String> {
        let outcome = self.0.inner.lock().unwrap().outcome.clone();
        let run = match &outcome {
            Some(Err(_)) => json!("throws"),
            Some(Ok(value)) => value.clone(),
            None => json!("resolves undefined"),
        };
        self.0.with(|inner| inner.catalog_runs.push(run));
        self.0.dep(None).await?;
        match outcome {
            Some(Err(error)) => Err(error),
            _ => Ok(()),
        }
    }
}

struct Setup(Arc<World>, tokio::sync::watch::Sender<u64>);

#[async_trait]
impl ProviderSetup for Setup {
    async fn get(&self, _: bool, _: bool, _: bool, _: bool) -> Result<Value, Failure> {
        self.0.dep(None).await.expect("the scripted setup resolves");
        Ok(json!({}))
    }
    fn filled(&self) -> tokio::sync::watch::Receiver<u64> {
        self.1.subscribe()
    }
}

struct Warmups {
    world: Arc<World>,
    schedulers: WarmupSchedulers,
    catalog_env: Vec<(&'static str, &'static str)>,
}

/// What the world is before a case starts.
struct Spec {
    active: u32,
    keychain_gate: bool,
    provider_gate: bool,
    provider_enabled: bool,
    catalog_enabled: bool,
    outcome: Option<Result<Value, String>>,
}

impl Default for Spec {
    fn default() -> Self {
        Self { active: 0, keychain_gate: false, provider_gate: false, provider_enabled: true, catalog_enabled: true, outcome: None }
    }
}

/// The five warm-ups over the case's world, each with a configured delay of 0.
fn warmups(spec: Spec) -> Warmups {
    mixdog_rt::testing::tokens();
    let w = Arc::new(World::default());
    w.with(|inner| {
        inner.route = json!({ "provider": "openai-oauth", "model": "first" }).as_object().cloned().unwrap();
        inner.active = spec.active;
        inner.outcome = spec.outcome.clone();
        inner.first_turn_done = true;
        inner.keychain_gate = spec.keychain_gate;
        inner.provider_gate = spec.provider_gate;
    });
    let gates: Arc<dyn WarmupGates> = w.clone();
    let providers = ProviderWarmup::new(ProviderWarmupConfig { enabled: spec.provider_enabled, delay: Duration::ZERO, before_first_turn: false });
    let models = ModelWarmup::new(WarmupConfig { enabled: true, delay: Duration::ZERO, before_first_turn: false });
    // The process's first turn settled before the warm-ups were bound, so it armed nothing.
    providers.first_turn_settled();
    models.first_turn_settled();
    providers.bind(Arc::new(Port(w.clone())), gates.clone()).unwrap();
    models.bind_cache(Arc::new(Port(w.clone())), gates.clone()).unwrap();
    let closing = {
        let w = w.clone();
        Arc::new(move || w.closing())
    };
    let setup = SetupWarmup::new(0, closing, w.clone());
    setup.bind(Arc::new(Setup(w.clone(), tokio::sync::watch::channel(0).0))).map_err(drop).unwrap();
    let catalog = CatalogWarmup::new(Arc::new(Port(w.clone())));
    catalog.bind_gates(gates.clone());
    let statusline = StatuslineWarmup::new(&|name| (name == "MIXDOG_STATUSLINE_USAGE_WARMUP_DELAY_MS").then(|| "0".to_owned()));
    let route = {
        let w = w.clone();
        Arc::new(move || w.inner.lock().unwrap().route.clone())
    };
    statusline.bind(route, Arc::new(Port(w.clone())), Arc::new(Port(w.clone())), gates).unwrap();
    let catalog_env =
        if spec.catalog_enabled { vec![("MIXDOG_MODEL_CATALOG_WARMUP_DELAY_MS", "0")] } else { vec![("MIXDOG_DISABLE_MODEL_CATALOG_WARMUP", "1")] };
    let schedulers = WarmupSchedulers { providers, models, setup, catalog, statusline };
    Warmups { world: w, schedulers, catalog_env }
}

impl Warmups {
    fn schedule_catalog(&self) {
        let env = self.catalog_env.clone();
        self.schedulers.schedule_model_catalog_warmup(&move |name| env.iter().find(|(key, _)| *key == name).map(|(_, value)| (*value).to_owned()));
    }

    /// Moves the clock, then waits until every timer due has fired and every job started waits on a dependency or has ended.
    async fn tick(&self, ms: u64) {
        tokio::time::advance(Duration::from_millis(ms)).await;
        self.world.settle("the warm-ups to settle after a tick", true).await;
    }

    /// Resolves every dependency not held by a closed gate, until each job left waits on a held gate.
    async fn quiet(&self) {
        self.world.quiet("the warm-ups to go quiet").await;
    }

    fn calls(&self) -> Vec<Value> {
        self.world.inner.lock().unwrap().calls.clone()
    }

    fn armed(&self) -> Vec<&'static str> {
        self.world.inner.lock().unwrap().timers.iter().filter(|(_, armed)| *armed).map(|(slot, _)| *slot).collect()
    }

    fn catalog_runs(&self) -> usize {
        self.world.inner.lock().unwrap().catalog_runs.len()
    }

    fn open_gate(&self, gate: &str) {
        self.world.with(|inner| drop(inner.opened.insert(gate.to_owned(), Ok(()))));
    }

    fn close_runtime(&self) {
        self.world.with(|inner| inner.closed = true);
        self.world.close.cancel();
    }
}

#[tokio::test(start_paused = true)]
async fn a_provider_warmup_cannot_start_provider_work_after_the_runtime_closes_during_keychain_readiness() {
    let warmups = warmups(Spec { keychain_gate: true, ..Spec::default() });
    warmups.schedulers.schedule_provider_warmup();
    warmups.tick(0).await;
    warmups.close_runtime();
    warmups.open_gate("keychain");
    warmups.quiet().await;
    assert_eq!(warmups.calls(), Vec::<Value>::new(), "no configuration reload and no provider initialization after the close");
}

#[tokio::test(start_paused = true)]
async fn a_statusline_warmup_cannot_start_provider_work_after_the_runtime_closes_during_keychain_readiness() {
    let warmups = warmups(Spec { keychain_gate: true, ..Spec::default() });
    warmups.schedulers.schedule_statusline_usage_warmup();
    warmups.tick(0).await;
    warmups.close_runtime();
    warmups.open_gate("keychain");
    warmups.quiet().await;
    assert_eq!(warmups.calls(), Vec::<Value>::new());
}

#[tokio::test(start_paused = true)]
async fn a_normal_provider_warmup_reloads_the_configuration_before_it_initializes_the_providers() {
    let warmups = warmups(Spec::default());
    warmups.schedulers.schedule_provider_warmup();
    warmups.tick(0).await;
    warmups.quiet().await;
    assert_eq!(warmups.calls(), vec![json!("reload"), json!("providers")]);
}

#[tokio::test(start_paused = true)]
async fn a_busy_runtime_parks_the_provider_warmup_with_no_timer_until_it_reports_idle() {
    let warmups = warmups(Spec { active: 1, ..Spec::default() });
    warmups.schedulers.schedule_provider_warmup();
    warmups.tick(0).await;
    warmups.tick(3_600_000).await;
    assert_eq!(warmups.calls(), Vec::<Value>::new(), "nothing runs while a turn is active, however long it takes");
    assert!(warmups.armed().is_empty(), "and no timer is armed to retry");

    warmups.world.with(|inner| inner.active = 0);
    warmups.schedulers.wake_deferred_warmups();
    warmups.tick(0).await;
    warmups.quiet().await;
    assert_eq!(warmups.calls(), vec![json!("reload"), json!("providers")], "the wake runs the parked warm-up");
}

#[tokio::test(start_paused = true)]
async fn a_statusline_warmup_refreshes_the_route_it_prepared_not_one_selected_while_it_waited_for_its_provider() {
    let warmups = warmups(Spec { provider_gate: true, ..Spec::default() });
    warmups.schedulers.schedule_statusline_usage_warmup();
    warmups.tick(0).await;
    warmups.quiet().await;
    warmups.world.with(|inner| inner.route = json!({ "provider": "anthropic", "model": "second" }).as_object().cloned().unwrap());
    warmups.open_gate("provider");
    warmups.quiet().await;
    let calls = warmups.calls();
    // The reading is of the route whose provider was prepared (`statusline_warmup.rs` `refresh_idle`), whatever was selected meanwhile.
    assert_eq!(calls.last(), Some(&json!(["usage", { "provider": "openai-oauth", "model": "first" }])), "{calls:?}");
    assert!(warmups.armed().is_empty(), "no idle loop is armed");
}

#[tokio::test(start_paused = true)]
async fn the_model_catalog_warmup_runs_every_six_hours_and_a_failure_waits_for_the_next_regular_cycle() {
    let warmups = warmups(Spec { outcome: Some(Err("catalog down".to_owned())), ..Spec::default() });
    warmups.schedule_catalog();
    warmups.tick(0).await;
    warmups.quiet().await;
    assert_eq!(warmups.catalog_runs(), 1);
    let six_hours = 6 * 3_600_000;
    warmups.tick(six_hours - 1).await;
    warmups.quiet().await;
    assert_eq!(warmups.catalog_runs(), 1, "a failure is not retried early");
    warmups.tick(1).await;
    warmups.quiet().await;
    assert_eq!(warmups.catalog_runs(), 2, "the next regular cycle runs it again");
}

#[tokio::test(start_paused = true)]
async fn a_disabled_warmup_arms_no_timer() {
    let warmups = warmups(Spec { provider_enabled: false, catalog_enabled: false, ..Spec::default() });
    warmups.schedulers.schedule_provider_warmup();
    warmups.schedule_catalog();
    warmups.tick(0).await;
    warmups.quiet().await;
    assert!(warmups.armed().is_empty(), "{:?}", warmups.armed());
    assert_eq!(warmups.calls(), Vec::<Value>::new());
    assert_eq!(warmups.catalog_runs(), 0);
}
