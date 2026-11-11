//! The startup catalog refresh a provider-readiness call starts, and what its completion does, against Node's recording
//! (`fixtures/catalog-refresh-start`, `benchmarks/rust-core/recorders/record-catalog-refresh-start.mjs`, Node 7f633e730):
//! every step of every scenario driven through the production pipeline of `model_list_node_tests` (readiness, registry,
//! the real provider builder over the fake endpoint, the catalog, the model list with the hooks the daemon binds), on a
//! paused clock that moves only by the recorded `advance` steps. Each step's observation is compared whole with Node's,
//! and so is the whole sequence of requests the endpoint received (method, URL, headers, body), in order.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use mixdog_ai::catalog::{CATALOG_REFRESH_INTERVAL, Point};
use mixdog_ai::service::admin_route::ensure_provider_enabled;
use serde_json::{Map, Value, json};

use super::model_list_node_tests::{Rig, rig_on};

fn recording() -> Value {
    serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/catalog-refresh-start/node-catalog-refresh-start.json")).unwrap()
}

/// `wait`, or a failure naming `what` once a minute of real time has passed without it (the clock is paused, so the
/// deadline is a std timer on its own thread).
async fn within<T>(what: &str, wait: impl std::future::Future<Output = T>) -> T {
    let (expired, deadline) = tokio::sync::oneshot::channel::<()>();
    let timer = std::thread::spawn(move || {
        std::thread::park_timeout(Duration::from_secs(60));
        expired.send(()).ok();
    });
    tokio::select! {
        biased;
        value = wait => {
            timer.thread().unpark();
            value
        }
        _ = deadline => panic!("{what}: not within 60 s"),
    }
}

struct Observer {
    wakes: Arc<AtomicUsize>,
}

impl Observer {
    fn state(&self, rig: &Rig, requests: Option<usize>, extra: Map<String, Value>) -> Value {
        let rewarms = rig.rewarms.load(Ordering::SeqCst);
        let mut observed = Map::new();
        if let Some(requests) = requests {
            observed.insert("requests".into(), json!(requests));
        }
        observed.insert("pending".into(), json!(rig.catalog.refresh_in_flight()));
        observed.insert("wakes".into(), json!(self.wakes.load(Ordering::SeqCst)));
        observed.insert("rewarms".into(), Value::Array(vec![json!({ "loadSecrets": true }); rewarms]));
        // Node's recorder reads the cache as it stands, without `syncCatalogRevision()`.
        observed.insert("cacheLoaded".into(), json!(rig.service.cache_held()));
        observed.insert("loadInFlight".into(), json!(rig.host.load_in_flight()));
        observed.extend(extra);
        Value::Object(observed)
    }
}

async fn settle(rig: &Rig, what: &str) {
    within(&format!("{what}: the catalog refreshes and their completion"), rig.readiness.settle_refreshes()).await;
    within(&format!("{what}: the provider-model load in flight"), rig.service.settle_warm()).await;
}

fn scenario<'a>(recording: &'a Value, name: &str) -> &'a Value {
    recording["scenarios"].as_array().unwrap().iter().find(|s| s["name"] == name).unwrap_or_else(|| panic!("{name}: not recorded"))
}

/// The scenario's rig, with the hooks the daemon binds and the wakes of the parked warm-ups counted.
async fn bound(recording: &Value, node: &Value) -> (Rig, Observer) {
    let start = tokio::time::Instant::now();
    let epoch = recording["now"].as_u64().unwrap();
    let rig = rig_on(node, &recording["seeds"], false, Some(Arc::new(move || epoch + start.elapsed().as_millis() as u64))).await;
    let service = rig.service.clone();
    assert!(rig.readiness.bind_invalidation(Arc::new(move || service.invalidate())).is_ok());
    rig.bind_rewarm();
    let observer = Observer { wakes: Arc::new(AtomicUsize::new(0)) };
    let wakes = observer.wakes.clone();
    rig.catalog.on_refresh_settled(Arc::new(move || {
        wakes.fetch_add(1, Ordering::SeqCst);
    }));
    (rig, observer)
}

/// Drives `wait` to its end on this thread, which the product's own thread is, stopped at a point: the runtime's other
/// tasks do not run meanwhile. Fails naming `what` after a minute.
fn block_within<T>(what: &str, wait: impl std::future::Future<Output = T>) -> T {
    struct Unpark(std::thread::Thread);
    impl std::task::Wake for Unpark {
        fn wake(self: Arc<Self>) {
            self.0.unpark();
        }
    }
    let waker = std::task::Waker::from(Arc::new(Unpark(std::thread::current())));
    let mut context = std::task::Context::from_waker(&waker);
    // Unconstrained: the stopped task's cooperative budget is not this future's.
    let mut wait = std::pin::pin!(tokio::task::unconstrained(within(what, wait)));
    loop {
        if let std::task::Poll::Ready(value) = wait.as_mut().poll(&mut context) {
            return value;
        }
        std::thread::park();
    }
}

/// Runs `steps` on the thread that next reaches `point`, before that thread goes on; the slot holds what they gave.
fn run_at<T: Send + 'static>(
    rig: &Rig,
    point: Point,
    what: String,
    steps: impl std::future::Future<Output = T> + Send + 'static,
) -> Arc<Mutex<Option<T>>> {
    let slot = Arc::new(Mutex::new(None));
    let filled = slot.clone();
    rig.readiness.at(point, move || {
        let value = block_within(&what, steps);
        *filled.lock().unwrap() = Some(value);
    });
    slot
}

fn taken<T>(slot: &Mutex<Option<T>>, what: &str) -> T {
    slot.lock().unwrap().take().unwrap_or_else(|| panic!("{what}: never reached its point"))
}

async fn replay(name: &str) {
    replay_overtaking(name, None).await;
}

/// The recorded scenario; with `overtaking`, that step (a readiness call) runs where a plain readiness call, asking for
/// the startup refresh, has not locked the refresh state yet.
async fn replay_overtaking(name: &str, overtaking: Option<usize>) {
    let recording = recording();
    let node = scenario(&recording, name);
    let (rig, observer) = bound(&recording, node).await;
    let mut log = rig.requests();
    let sent = |log: &tokio::sync::watch::Receiver<Vec<Value>>| log.borrow().len();
    let hold_of = |step: &Value| -> Vec<String> {
        step["hold"].as_array().map(|h| h.iter().map(|p| p.as_str().unwrap().to_owned()).collect()).unwrap_or_default()
    };
    for (index, step) in node["steps"].as_array().unwrap().iter().enumerate() {
        let what = format!("{name} step {index} ({})", step["do"].as_str().unwrap());
        // A held path is waited for among the requests this step makes.
        let from = sent(&log);
        let observed = match step["do"].as_str().unwrap() {
            "ready" => {
                let hold = hold_of(step);
                if !hold.is_empty() {
                    rig.gate.send_replace(false);
                }
                let providers = step["enable"].as_str().map(|enable| ensure_provider_enabled(&rig.loaded.get(), enable));
                let result = if overtaking == Some(index) {
                    let ready = rig.readiness.clone();
                    let inside = format!("{what}: inside the overtaken readiness call");
                    let slot = run_at(&rig, Point::StartupBeforeLock, inside, async move { ready.ensure_providers_ready(providers).await });
                    within(&format!("{what}: the overtaken readiness call"), rig.readiness.ensure_providers_ready(None)).await.expect("the overtaken readiness call");
                    taken(&slot, &what)
                } else {
                    rig.readiness.ensure_providers_ready(providers).await
                };
                let result = match result {
                    Ok(()) => Map::from_iter([("ok".to_owned(), json!(true))]),
                    Err(error) => Map::from_iter([("ok".to_owned(), json!(false)), ("error".to_owned(), json!(error.message))]),
                };
                held(&mut log, &what, &hold, from).await;
                let mut observed = result;
                observed.insert("observed".into(), observer.state(&rig, (!hold.is_empty()).then(|| sent(&log)), Map::new()));
                observed
            }
            "release" => {
                rig.gate.send_replace(true);
                Map::from_iter([("observed".to_owned(), observer.state(&rig, Some(sent(&log)), Map::new()))])
            }
            "settle" => {
                settle(&rig, &what).await;
                Map::from_iter([("observed".to_owned(), observer.state(&rig, Some(sent(&log)), Map::new()))])
            }
            "read" => {
                let force = step["force"].as_bool() == Some(true);
                let rows = within(&what, rig.service.rows_for(force, false, step["provider"].as_str())).await.unwrap();
                let extra = Map::from_iter([("rows".to_owned(), Value::Array(rows))]);
                Map::from_iter([("observed".to_owned(), observer.state(&rig, Some(sent(&log)), extra))])
            }
            "disable" => {
                let removed = rig.registry.disable(step["disable"].as_str().unwrap());
                Map::from_iter([
                    ("removed".to_owned(), json!(removed)),
                    ("observed".to_owned(), observer.state(&rig, Some(sent(&log)), Map::new())),
                ])
            }
            "init" => {
                let providers = ensure_provider_enabled(&rig.loaded.get(), step["enable"].as_str().unwrap());
                within(&what, rig.registry.init_providers(&providers)).await.expect("the registry initializes");
                Map::from_iter([("observed".to_owned(), observer.state(&rig, Some(sent(&log)), Map::new()))])
            }
            "refresh" => {
                within(&what, rig.readiness.refresh_catalogs()).await;
                Map::from_iter([("observed".to_owned(), observer.state(&rig, Some(sent(&log)), Map::new()))])
            }
            "serve" => {
                rig.serve(&step["stub"]);
                Map::from_iter([("observed".to_owned(), observer.state(&rig, Some(sent(&log)), Map::new()))])
            }
            "advance" => {
                let hold = hold_of(step);
                if !hold.is_empty() {
                    rig.gate.send_replace(false);
                }
                let before = rig.readiness.catalog_timer_fires();
                tokio::time::advance(Duration::from_millis(step["ms"].as_u64().unwrap())).await;
                // The timer that fell due runs its task (Node runs the callback inside the advance).
                tokio::task::yield_now().await;
                held(&mut log, &what, &hold, from).await;
                let fired = Map::from_iter([("timersFired".to_owned(), json!(rig.readiness.catalog_timer_fires() - before))]);
                Map::from_iter([("observed".to_owned(), observer.state(&rig, (!hold.is_empty()).then(|| sent(&log)), fired))])
            }
            "settleTimer" => {
                settle(&rig, &what).await;
                Map::from_iter([("observed".to_owned(), observer.state(&rig, Some(sent(&log)), Map::new()))])
            }
            other => panic!("{what}: unknown step {other}"),
        };
        let mut got = step.as_object().unwrap().clone();
        got.retain(|key, _| !matches!(key.as_str(), "ok" | "error" | "observed"));
        got.extend(observed);
        assert_eq!(Value::Object(got), *step, "{what}");
    }
    settle(&rig, &format!("{name} end")).await;
    assert_eq!(observer.state(&rig, Some(sent(&log)), Map::new()), node["final"], "{name}: the final state");
    let sent = Value::Array(log.borrow().clone());
    assert_eq!(header_names_folded(&sent), header_names_folded(&node["requests"]), "{name}: every request the endpoint received, in order");
}

/// Waits for a request to each of `paths` among those the endpoint received from the `from`th on.
async fn held(log: &mut tokio::sync::watch::Receiver<Vec<Value>>, what: &str, paths: &[String], from: usize) {
    for path in paths {
        let url = format!("__BASE_URL__{path}");
        let arrived = log.wait_for(|log| log.iter().skip(from).any(|r| r["url"] == url.as_str()));
        within(&format!("{what}: the held request to {path}"), arrived).await.unwrap();
    }
}

/// The requests with every header name lowercased: names are case-insensitive (RFC 9110 §5.1) and the core's HTTP
/// stack sends them lowercased whatever case the adapter wrote.
fn header_names_folded(requests: &Value) -> Value {
    let mut requests = requests.clone();
    for request in requests.as_array_mut().unwrap() {
        for header in request["headers"].as_array_mut().unwrap() {
            header[0] = json!(header[0].as_str().unwrap().to_ascii_lowercase());
        }
    }
    requests
}

/// The scenarios, in the recording's order; each runs as its own test.
const SCENARIOS: [&str; 14] = [
    "a-ready-call-starts-the-refresh-and-its-completion-rewarms",
    "a-second-ready-call-during-a-running-refresh-joins-it",
    "a-provider-set-change-during-a-running-refresh-starts-another",
    "a-refresh-that-fails",
    "a-failed-refresh-after-a-good-one",
    "providers-without-credentials",
    "the-catalog-timer-at-its-boundary",
    "a-ready-call-and-a-read-after-a-disable",
    "a-forced-refresh-after-a-disable",
    "a-forced-read-of-the-disabled-provider",
    "the-catalog-timer-after-a-disable",
    "a-disable-during-a-running-refresh",
    "the-catalog-timer-after-an-enable",
    "an-enable-during-a-running-refresh",
];

#[test]
fn every_recorded_scenario_is_replayed() {
    let recording = recording();
    let recorded: Vec<&str> = recording["scenarios"].as_array().unwrap().iter().map(|s| s["name"].as_str().unwrap()).collect();
    assert_eq!(recorded, SCENARIOS);
}

#[tokio::test(start_paused = true)]
async fn a_ready_call_starts_the_refresh_and_its_completion_rewarms() {
    replay(SCENARIOS[0]).await;
}

#[tokio::test(start_paused = true)]
async fn a_second_ready_call_during_a_running_refresh_joins_it() {
    replay(SCENARIOS[1]).await;
}

#[tokio::test(start_paused = true)]
async fn a_provider_set_change_during_a_running_refresh_starts_another() {
    replay(SCENARIOS[2]).await;
}

#[tokio::test(start_paused = true)]
async fn a_refresh_that_fails() {
    replay(SCENARIOS[3]).await;
}

#[tokio::test(start_paused = true)]
async fn a_failed_refresh_after_a_good_one() {
    replay(SCENARIOS[4]).await;
}

#[tokio::test(start_paused = true)]
async fn providers_without_credentials() {
    replay(SCENARIOS[5]).await;
}

#[tokio::test(start_paused = true)]
async fn the_catalog_timer_at_its_boundary() {
    replay(SCENARIOS[6]).await;
}

#[tokio::test(start_paused = true)]
async fn a_ready_call_and_a_read_after_a_disable() {
    replay(SCENARIOS[7]).await;
}

#[tokio::test(start_paused = true)]
async fn a_forced_refresh_after_a_disable() {
    replay(SCENARIOS[8]).await;
}

#[tokio::test(start_paused = true)]
async fn a_forced_read_of_the_disabled_provider() {
    replay(SCENARIOS[9]).await;
}

#[tokio::test(start_paused = true)]
async fn the_catalog_timer_after_a_disable() {
    replay(SCENARIOS[10]).await;
}

#[tokio::test(start_paused = true)]
async fn a_disable_during_a_running_refresh() {
    replay(SCENARIOS[11]).await;
}

#[tokio::test(start_paused = true)]
async fn the_catalog_timer_after_an_enable() {
    replay(SCENARIOS[12]).await;
}

#[tokio::test(start_paused = true)]
async fn an_enable_during_a_running_refresh() {
    replay(SCENARIOS[13]).await;
}

// The interleavings Node cannot have, because there a check and the change it decides run in one synchronous step: each
// forced at its point (the other side's steps run on the thread that reached it, before it goes on).

/// A readiness call whose epoch read is overtaken by a provider-set change and its readiness call (the recorded second
/// step) joins the newer refresh: one refresh per epoch, so the scenario replays as recorded, requests included.
#[tokio::test(start_paused = true)]
async fn a_readiness_call_overtaken_by_a_provider_set_change_joins_the_newer_refresh() {
    replay_overtaking(SCENARIOS[2], Some(1)).await;
}

/// A completion overtaken, before it settles, by a provider-set change and its readiness call (the recorded second step)
/// leaves the newer refresh's pending flag and wakes nothing: `settle` acts for the latest observed refresh only
/// (`isLatest()`, provider-readiness.mjs:152-157).
#[tokio::test(start_paused = true)]
async fn a_completion_overtaken_by_a_newer_refresh_leaves_its_pending_flag() {
    let recording = recording();
    let node = scenario(&recording, SCENARIOS[2]);
    let (rig, observer) = bound(&recording, node).await;
    let mut log = rig.requests();
    let held = |path: &'static str| move |log: &Vec<Value>| log.iter().any(|r| r["url"] == format!("__BASE_URL__{path}").as_str());
    rig.gate.send_replace(false);
    within("the first readiness call", rig.readiness.ensure_providers_ready(None)).await.unwrap();
    within("the first refresh's held listing", log.wait_for(held("/a/v1/models"))).await.unwrap();
    let providers = ensure_provider_enabled(&rig.loaded.get(), node["steps"][1]["enable"].as_str().unwrap());
    let (ready, gate) = (rig.readiness.clone(), rig.gate.clone());
    let slot = run_at(&rig, Point::CompletionBeforeSettle, "the readiness call inside the first completion".into(), async move {
        gate.send_replace(false);
        ready.ensure_providers_ready(Some(providers)).await
    });
    rig.gate.send_replace(true);
    // The newer refresh's tasks were spawned inside the first completion, so on this one thread its held listing is sent
    // only after that completion has run to its end.
    within("the newer refresh's held listing", log.wait_for(held("/b/v1/models"))).await.unwrap();
    taken(&slot, "the first completion").expect("the readiness call inside the first completion");
    assert!(rig.catalog.refresh_in_flight(), "the first completion cleared the pending flag of the newer refresh, which is running");
    assert_eq!(observer.wakes.load(Ordering::SeqCst), 0, "the first completion woke the parked warm-ups while the newer refresh runs");
    rig.gate.send_replace(true);
    settle(&rig, "the newer refresh").await;
    assert!(!rig.catalog.refresh_in_flight(), "the newer refresh settled its pending flag");
    assert_eq!(observer.wakes.load(Ordering::SeqCst), 1, "the newer refresh's settlement woke the parked warm-ups");
}

/// A 24 h timer past its sleep, overtaken before it locks by a provider-set change and its readiness call (the recorded
/// second step), whose startup refresh replaces the timer and opens a new window: the replaced timer sends nothing
/// (`clearTimeout`; `refreshCatalogs`' `Date.now() < _catalogRefreshNotBefore`, registry.mjs:740), and the new window's
/// timer fires at its own boundary.
#[tokio::test(start_paused = true)]
async fn a_replaced_timer_past_its_sleep_refreshes_nothing_inside_the_new_window() {
    let recording = recording();
    let node = scenario(&recording, SCENARIOS[2]);
    let (rig, _observer) = bound(&recording, node).await;
    within("the first readiness call", rig.readiness.ensure_providers_ready(None)).await.unwrap();
    settle(&rig, "the first refresh").await;
    let providers = ensure_provider_enabled(&rig.loaded.get(), node["steps"][1]["enable"].as_str().unwrap());
    let ready = rig.readiness.clone();
    let slot = run_at(&rig, Point::TimerBeforeLock, "the readiness call inside the first timer".into(), async move {
        ready.ensure_providers_ready(Some(providers)).await
    });
    tokio::time::advance(CATALOG_REFRESH_INTERVAL).await;
    // The timer that fell due runs its task.
    tokio::task::yield_now().await;
    taken(&slot, "the first timer").expect("the readiness call inside the first timer");
    assert_eq!(rig.readiness.catalog_timer_fires(), 0, "the replaced timer refreshed inside the new window");
    settle(&rig, "the new startup refresh").await;
    tokio::time::advance(CATALOG_REFRESH_INTERVAL - Duration::from_millis(1)).await;
    tokio::task::yield_now().await;
    assert_eq!(rig.readiness.catalog_timer_fires(), 0, "the new window's timer fired before its boundary");
    tokio::time::advance(Duration::from_millis(1)).await;
    tokio::task::yield_now().await;
    assert_eq!(rig.readiness.catalog_timer_fires(), 1, "the new window's timer fires at its boundary");
}
