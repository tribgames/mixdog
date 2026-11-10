//! The startup catalog refresh a provider-readiness call starts, and what its completion does, against Node's recording
//! (`fixtures/catalog-refresh-start`, `benchmarks/rust-core/recorders/record-catalog-refresh-start.mjs`, Node 7f633e730):
//! every step of every scenario driven through the production pipeline of `model_list_node_tests` (readiness, registry,
//! the real provider builder over the fake endpoint, the catalog, the model list with the hooks the daemon binds), on a
//! paused clock that moves only by the recorded `advance` steps. Each step's observation is compared whole with Node's,
//! and so is the whole sequence of requests the endpoint received (method, URL, headers, body), in order.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use mixdog_ai::service::admin_route::ensure_provider_enabled;
use serde_json::{Map, Value, json};

use super::model_list_node_tests::{Rig, rig_on};

fn recording() -> Value {
    serde_json::from_str(include_str!("../../../../../fixtures/catalog-refresh-start/node-catalog-refresh-start.json")).unwrap()
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

async fn replay(name: &str) {
    let recording = recording();
    let node = recording["scenarios"].as_array().unwrap().iter().find(|s| s["name"] == name).unwrap_or_else(|| panic!("{name}: not recorded"));
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
    let mut log = rig.requests();
    let sent = |log: &tokio::sync::watch::Receiver<Vec<Value>>| log.borrow().len();
    for (index, step) in node["steps"].as_array().unwrap().iter().enumerate() {
        let what = format!("{name} step {index} ({})", step["do"].as_str().unwrap());
        let observed = match step["do"].as_str().unwrap() {
            "ready" => {
                let hold: Vec<&str> = step["hold"].as_array().map(|h| h.iter().map(|p| p.as_str().unwrap()).collect()).unwrap_or_default();
                if !hold.is_empty() {
                    rig.gate.send_replace(false);
                }
                let providers = step["enable"].as_str().map(|enable| ensure_provider_enabled(&rig.loaded.get(), enable));
                let result = match rig.readiness.ensure_providers_ready(providers).await {
                    Ok(()) => Map::from_iter([("ok".to_owned(), json!(true))]),
                    Err(error) => Map::from_iter([("ok".to_owned(), json!(false)), ("error".to_owned(), json!(error.message))]),
                };
                for path in &hold {
                    let url = format!("__BASE_URL__{path}");
                    within(&format!("{what}: the held request to {path}"), log.wait_for(|log| log.iter().any(|r| r["url"] == url.as_str()))).await.unwrap();
                }
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
                let rows = within(&what, rig.service.rows(false, false)).await.unwrap();
                let extra = Map::from_iter([("rows".to_owned(), Value::Array(rows))]);
                Map::from_iter([("observed".to_owned(), observer.state(&rig, Some(sent(&log)), extra))])
            }
            "serve" => {
                rig.serve(&step["stub"]);
                Map::from_iter([("observed".to_owned(), observer.state(&rig, Some(sent(&log)), Map::new()))])
            }
            "advance" => {
                let before = rig.readiness.catalog_timer_fires();
                tokio::time::advance(Duration::from_millis(step["ms"].as_u64().unwrap())).await;
                // The timer that fell due runs its task (Node runs the callback inside the advance).
                tokio::task::yield_now().await;
                let fired = Map::from_iter([("timersFired".to_owned(), json!(rig.readiness.catalog_timer_fires() - before))]);
                Map::from_iter([("observed".to_owned(), observer.state(&rig, None, fired))])
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
const SCENARIOS: [&str; 7] = [
    "a-ready-call-starts-the-refresh-and-its-completion-rewarms",
    "a-second-ready-call-during-a-running-refresh-joins-it",
    "a-provider-set-change-during-a-running-refresh-starts-another",
    "a-refresh-that-fails",
    "a-failed-refresh-after-a-good-one",
    "providers-without-credentials",
    "the-catalog-timer-at-its-boundary",
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
