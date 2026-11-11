//! Node's recording `fixtures/session-warmup-schedulers/recording.json` (`record-session-warmup-schedulers.mjs`, test file
//! `src/session-runtime/warmup-schedulers.test.mjs`), read when the test runs and decoded with [`Exact`]: one test per
//! case. Node's `createWarmupSchedulers` is the daemon's [`WarmupSchedulers`] (`prewarm_world.rs`), the object the
//! boot (`compose_flip.rs`), the turn settle and the wakes (`WarmupSignals`) call: each recorded call is its method of
//! the same name over the daemon's five warm-ups. The recorded delay argument 0 is each warm-up's configured
//! delay (its env delay set to 0). The scripted dependencies are the recorder's: an async one resolves at the next
//! `yield` step (Node runs no microtask between steps), a gated one at the `yield` after its gate opened. Time is the
//! paused tokio clock, moved only by the recorded `tick` steps.

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
use mixdog_testkit::exact::Exact;
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

fn recording() -> Exact {
    let text = mixdog_testkit::fixture!("../../fixtures/session-warmup-schedulers/recording.json");
    Exact::decode(&serde_json::from_str(text).expect("the recording is JSON")).expect("the recording decodes")
}

/// A dependency call in flight: it resolves when the test releases it.
struct Dep {
    id: u64,
    /// The recorder's gate it waits on; none: an async dependency that resolves at the next yield.
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
    /// The gates the recorder opened: resolved (`Ok`) or rejected with the message.
    opened: HashMap<String, Result<(), String>>,
}

/// The recorder's world: the runtime's gates and marks, and every scripted dependency.
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

    /// A dependency call: registered at once, it resolves when released (`tracked` of the recorder).
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
    /// auto-advance while a blocking task runs), so only a recorded `tick` moves time.
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
        // The elapsed time of the provider init is not recorded (manifest: `<elapsed ms>`).
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

/// The five warm-ups over the case's world (`spec` of the recorder).
fn warmups(world: &Exact) -> Warmups {
    mixdog_rt::testing::tokens();
    let flag = |name: &str| world.try_get("flags").is_none_or(|flags| *flags.get(name) == Exact::Bool(true));
    let w = Arc::new(World::default());
    w.with(|inner| {
        inner.route = json!({ "provider": "openai-oauth", "model": "first" }).as_object().cloned().unwrap();
        inner.active = world.try_get("active").map_or(0, |active| active.as_f64() as u32);
        inner.catalog_pending = world.try_get("catalogPending").is_some_and(|pending| *pending == Exact::Bool(true));
        inner.outcome = world.try_get("catalogOutcome").map(|outcome| Ok(outcome.to_plain().expect("a plain outcome")));
        inner.first_turn_done = world.try_get("firstTurnCompleted").is_none_or(|done| *done == Exact::Bool(true));
        inner.keychain_gate = world.try_get("keychainGate").is_some_and(|gate| *gate == Exact::Bool(true));
        inner.provider_gate = world.try_get("providerGate").is_some_and(|gate| *gate == Exact::Bool(true));
    });
    let gates: Arc<dyn WarmupGates> = w.clone();
    let providers = ProviderWarmup::new(ProviderWarmupConfig { enabled: flag("providerWarmupEnabled"), delay: Duration::ZERO, before_first_turn: false });
    let models = ModelWarmup::new(WarmupConfig { enabled: flag("modelPrefetchEnabled"), delay: Duration::ZERO, before_first_turn: false });
    // `isFirstTurnCompleted()`: the process's first turn settled before the warm-ups were bound, so it armed nothing.
    if w.inner.lock().unwrap().first_turn_done {
        providers.first_turn_settled();
        models.first_turn_settled();
    }
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
    let catalog_env = if flag("modelCatalogWarmupEnabled") {
        vec![("MIXDOG_MODEL_CATALOG_WARMUP_DELAY_MS", "0")]
    } else {
        vec![("MIXDOG_DISABLE_MODEL_CATALOG_WARMUP", "1")]
    };
    // The daemon's scheduler object (`compose_flip.rs` builds the same over its warm-ups).
    let schedulers = WarmupSchedulers { providers, models, setup, catalog, statusline };
    Warmups { world: w, schedulers, catalog_env }
}

impl Warmups {
    fn call(&self, method: &str, args: &[Exact]) {
        if method.starts_with("schedule") {
            assert_eq!(args, [Exact::Number(0.0)], "{method}: the recorded delay is each warm-up's configured one, 0");
        }
        let schedulers = &self.schedulers;
        match method {
            "scheduleProviderWarmup" => schedulers.schedule_provider_warmup(),
            "scheduleProviderModelWarmup" => schedulers.schedule_provider_model_warmup(),
            "scheduleProviderSetupWarmup" => schedulers.schedule_provider_setup_warmup(Some(0)),
            "scheduleModelCatalogWarmup" => {
                let env = self.catalog_env.clone();
                schedulers.schedule_model_catalog_warmup(&move |name| env.iter().find(|(key, _)| *key == name).map(|(_, value)| (*value).to_owned()));
            }
            "scheduleStatuslineUsageWarmup" => schedulers.schedule_statusline_usage_warmup(),
            "refreshStatuslineUsageAfterTurn" => schedulers.refresh_statusline_usage_after_turn(),
            "wakeDeferredWarmups" => schedulers.wake_deferred_warmups(),
            other => panic!("unknown scheduler call {other}"),
        }
    }

    async fn step(&self, step: &Exact, at: usize) {
        let w = &self.world;
        let label = format!("the warm-ups to settle after step {at}");
        match step.get("op").as_str() {
            "call" => self.call(step.get("method").as_str(), step.get("args").as_array()),
            "tick" => tokio::time::advance(Duration::from_millis(step.get("ms").as_f64() as u64)).await,
            "yield" => {
                w.quiet(&label).await;
                return;
            }
            "closeRuntime" => {
                w.with(|inner| inner.closed = true);
                w.close.cancel();
            }
            "resolveGate" => w.with(|inner| drop(inner.opened.insert(step.get("gate").as_str().to_owned(), Ok(())))),
            "rejectGate" => w.with(|inner| drop(inner.opened.insert(step.get("gate").as_str().to_owned(), Err(step.get("message").as_str().to_owned())))),
            "setRoute" => w.with(|inner| inner.route = step.get("route").to_plain().expect("a plain route").as_object().cloned().unwrap()),
            "setActiveTurnCount" => w.with(|inner| inner.active = step.get("count").as_f64() as u32),
            "setCatalogRefreshPending" => w.with(|inner| inner.catalog_pending = *step.get("pending") == Exact::Bool(true)),
            "setCatalogOutcome" => w.with(|inner| {
                inner.outcome = Some(match step.try_get("error") {
                    Some(error) => Err(error.as_str().to_owned()),
                    None => Ok(step.get("value").to_plain().expect("a plain outcome")),
                });
            }),
            other => panic!("unknown step {other}"),
        }
        w.settle(&label, step.get("op").as_str() == "tick").await;
    }

    /// The recorder's `snapshot(step)`.
    fn row(&self, step: &Exact) -> Exact {
        let mut inner = self.world.inner.lock().unwrap();
        let timers: serde_json::Map<String, Value> = inner.timers.iter().map(|(slot, armed)| ((*slot).to_owned(), if *armed { json!("armed") } else { Value::Null })).collect();
        let armed = std::mem::take(&mut inner.armed_now);
        let mut row = vec![("step".to_owned(), step.clone())];
        for (key, value) in [
            ("calls", json!(inner.calls)),
            ("events", json!(inner.events)),
            ("warms", json!(inner.warms)),
            ("catalogRuns", json!(inner.catalog_runs)),
            ("timers", Value::Object(timers)),
            ("timersArmedThisStep", json!(armed)),
        ] {
            row.push((key.to_owned(), Exact::plain(&value)));
        }
        Exact::Object(row)
    }
}

/// Replays case `index` of the recording (several cases share a test line) and compares every row whole.
async fn replay(index: usize, line: f64) {
    let recording = recording();
    let case = &recording.get("cases").as_array()[index];
    assert_eq!(case.get("testLine").as_f64(), line, "case {index} is the recorded line {line}");
    let warmups = warmups(case.get("input").get("world"));
    let mut rows = Vec::new();
    for (at, step) in case.get("input").get("steps").as_array().iter().enumerate() {
        warmups.step(step, at).await;
        rows.push(warmups.row(step));
    }
    let name = case.get("name").as_str();
    let recorded = case.get("result").get("rows").as_array();
    for (at, (got, want)) in rows.iter().zip(recorded).enumerate() {
        assert_eq!(got, want, "{name}: row {at}");
    }
    assert_eq!(rows.len(), recorded.len(), "{name}: the rows");
}

#[tokio::test(start_paused = true)]
async fn line_85_provider_warmup_cannot_start_provider_work_after_closing_during_keychain_readiness() {
    replay(0, 85.0).await;
}

#[tokio::test(start_paused = true)]
async fn line_85_statusline_usage_warmup_cannot_start_provider_work_after_closing_during_keychain_readiness() {
    replay(1, 85.0).await;
}

#[tokio::test(start_paused = true)]
async fn line_85_usage_refresh_after_turn_cannot_start_provider_work_after_closing_during_keychain_readiness() {
    replay(2, 85.0).await;
}

#[tokio::test(start_paused = true)]
async fn line_97_provider_warmup_does_not_continue_after_a_keychain_failure_during_close() {
    replay(3, 97.0).await;
}

#[tokio::test(start_paused = true)]
async fn line_109_statusline_usage_warmup_stops_before_usage_refresh_if_provider_readiness_outlives_the_runtime() {
    replay(4, 109.0).await;
}

#[tokio::test(start_paused = true)]
async fn line_121_statusline_usage_warmup_refreshes_the_prepared_route_if_selection_changes_while_waiting() {
    replay(5, 121.0).await;
}

#[tokio::test(start_paused = true)]
async fn line_109_usage_refresh_after_turn_stops_before_usage_refresh_if_provider_readiness_outlives_the_runtime() {
    replay(6, 109.0).await;
}

#[tokio::test(start_paused = true)]
async fn line_121_usage_refresh_after_turn_refreshes_the_prepared_route_if_selection_changes_while_waiting() {
    replay(7, 121.0).await;
}

#[tokio::test(start_paused = true)]
async fn line_134_normal_provider_warmup_still_reloads_configuration_before_provider_initialization() {
    replay(8, 134.0).await;
}

#[tokio::test(start_paused = true)]
async fn line_148_busy_runtime_parks_provider_warmup_with_no_timer_until_the_runtime_reports_idle() {
    replay(9, 148.0).await;
}

#[tokio::test(start_paused = true)]
async fn line_166_provider_model_warmup_parks_behind_the_catalog_refresh_and_runs_when_it_settles() {
    replay(10, 166.0).await;
}

#[tokio::test(start_paused = true)]
async fn line_184_idle_session_before_its_first_turn_warms_the_model_cache_once_and_arms_nothing_after() {
    replay(11, 184.0).await;
}

#[tokio::test(start_paused = true)]
async fn line_199_model_catalog_warmup_runs_every_6h_a_failure_waits_for_the_next_regular_cycle() {
    replay(12, 199.0).await;
}

#[tokio::test(start_paused = true)]
async fn line_232_disabled_or_inapplicable_warmups_report_the_skip_instead_of_arming_a_timer() {
    replay(13, 232.0).await;
}

#[tokio::test(start_paused = true)]
async fn line_250_provider_setup_warmup_reports_readiness() {
    replay(14, 250.0).await;
}
