//! The statusline usage warm-up against Node's recording (`fixtures/model-lists-statusline`, recorded from the Node
//! commit b6f10295a): a profile with a custom provider enabled and a default route naming `anthropic-oauth`. Once Node's
//! statusline-usage warm-up has run, its provider-model reads list the route's provider.

use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use mixdog_ai::service::admin_route::Obj;
use serde_json::Value;

use super::model_list_node_tests::{Rig, assert_rows, rig, statusline_recording, web_search};
use super::model_warmup::WarmupGates;
use super::statusline_warmup::{StatuslineSink, StatuslineWarmup};
use crate::domains::ai_account::collaborators::WebSearchModels;

#[derive(Default)]
struct Gates {
    busy: Mutex<Option<&'static str>>,
    close: tokio_util::sync::CancellationToken,
}

impl WarmupGates for Gates {
    fn busy(&self) -> Option<&'static str> {
        *self.busy.lock().unwrap()
    }
    fn closing(&self) -> bool {
        self.close.is_cancelled()
    }
    fn closed(&self) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
        let close = self.close.clone();
        Box::pin(async move { close.cancelled().await })
    }
}

struct Sink {
    routes: Mutex<Vec<Obj>>,
    seen: tokio::sync::mpsc::UnboundedSender<()>,
}

impl StatuslineSink for Sink {
    fn refresh_route(&self, route: &Obj) {
        self.routes.lock().unwrap().push(route.clone());
        let _ = self.seen.send(());
    }
}

struct Built {
    rig: Rig,
    warm: Arc<StatuslineWarmup>,
    gates: Arc<Gates>,
    sink: Arc<Sink>,
    seen: tokio::sync::mpsc::UnboundedReceiver<()>,
    node: Value,
}

async fn built(env: &'static [(&'static str, &'static str)]) -> Built {
    let recording = statusline_recording();
    let node = recording["scenarios"][0].clone();
    let rig = rig(&node, &recording["seeds"], false).await;
    let warm = StatuslineWarmup::new(&move |name| env.iter().find(|(key, _)| *key == name).map(|(_, value)| (*value).to_owned()));
    let gates = Arc::new(Gates::default());
    let (tx, seen) = tokio::sync::mpsc::unbounded_channel();
    let sink = Arc::new(Sink { routes: Mutex::default(), seen: tx });
    warm.bind(rig.host.route.clone(), rig.loaded.clone(), rig.readiness.clone(), sink.clone(), gates.clone()).unwrap();
    Built { rig, warm, gates, sink, seen, node }
}

const NO_DELAY: &[(&str, &str)] = &[("MIXDOG_STATUSLINE_USAGE_WARMUP_DELAY_MS", "0")];

/// Node's reads after its warm-up, in the order the recorder made them: the full read that ended its wait (which loads
/// the provider-model cache), then the recorded web-search rows and the recorded full rows.
async fn assert_node_reads(built: &Built) {
    let calls = built.node["calls"].as_array().unwrap();
    assert_eq!(calls.iter().map(|c| c["action"].as_str().unwrap()).collect::<Vec<_>>(), ["listWebSearchModels", "listProviderModels"]);
    let waited = built.rig.service.rows(false, false).await.unwrap();
    assert_rows("the read that ended Node's wait", &waited, &built.node["waited"]["rows"]);
    let found = web_search(&built.rig).list(None, false).await.unwrap();
    assert_rows("web search", found.as_array().unwrap(), &calls[0]["value"]);
    assert_rows("full", &built.rig.service.rows(false, false).await.unwrap(), &calls[1]["value"]);
}
// Without the warm-up nothing prepares the route's provider: the reads list the custom provider only, as the Rust daemon
// answered before.
#[tokio::test]
async fn without_the_warm_up_the_default_routes_provider_is_not_listed() {
    let built = built(NO_DELAY).await;
    let rows = built.rig.service.rows(false, false).await.unwrap();
    assert!(rows.iter().all(|row| row["provider"] != "anthropic-oauth"), "{rows:?}");
}

#[tokio::test]
async fn the_boot_warm_up_makes_the_reads_node_recorded() {
    let mut built = built(NO_DELAY).await;
    built.warm.start();
    built.warm.settle().await;
    built.seen.recv().await.unwrap();
    assert_node_reads(&built).await;
    let routes = built.sink.routes.lock().unwrap();
    assert_eq!(routes.len(), 1, "the route's reading is refreshed once");
    assert_eq!(routes[0]["provider"], "anthropic-oauth");
}

#[tokio::test(start_paused = true)]
async fn the_boot_warm_up_waits_for_nodes_default_delay() {
    let mut built = built(&[]).await;
    let started = tokio::time::Instant::now();
    built.warm.start();
    built.warm.armed.acquire().await.unwrap().forget();
    tokio::time::advance(Duration::from_millis(799)).await;
    assert!(built.seen.try_recv().is_err(), "800 ms has not passed");
    tokio::time::advance(Duration::from_millis(1)).await;
    built.warm.settle().await;
    built.seen.recv().await.unwrap();
    // The paused clock moves only by advance and by the auto-advance to the next timer, which a longer delay would have
    // needed: the warm ran at exactly 800 ms.
    assert_eq!(tokio::time::Instant::now() - started, Duration::from_millis(800));
}

// 	eardown clears the pending warm-up timer: the runtime closing ends the delay at once, and no provider is registered.
#[tokio::test(start_paused = true)]
async fn the_runtime_closing_ends_the_pending_delay_and_registers_nothing() {
    let mut built = built(&[]).await;
    let started = tokio::time::Instant::now();
    built.warm.start();
    built.warm.armed.acquire().await.unwrap().forget();
    built.gates.close.cancel();
    built.warm.settle().await;
    assert_eq!(tokio::time::Instant::now() - started, Duration::ZERO, "the task ended without the delay passing");
    assert!(built.seen.try_recv().is_err());
    assert!(built.rig.registry.names().iter().all(|name| name != "anthropic-oauth"));
}

#[tokio::test]
async fn a_busy_runtime_parks_the_warm_up_until_a_wake() {
    let mut built = built(NO_DELAY).await;
    *built.gates.busy.lock().unwrap() = Some("turn");
    built.warm.start();
    built.warm.settle().await;
    assert!(built.seen.try_recv().is_err(), "parked while busy");
    assert!(built.rig.registry.names().iter().all(|name| name != "anthropic-oauth"));
    *built.gates.busy.lock().unwrap() = None;
    built.warm.wake();
    built.warm.settle().await;
    built.seen.recv().await.unwrap();
    assert_node_reads(&built).await;
}

#[tokio::test]
async fn a_settled_turn_prepares_and_refreshes_at_once_even_when_busy() {
    let mut built = built(NO_DELAY).await;
    *built.gates.busy.lock().unwrap() = Some("turn");
    built.warm.turn_settled();
    built.seen.recv().await.unwrap();
    assert_node_reads(&built).await;
}

#[tokio::test]
async fn a_route_that_is_not_oauth_is_left_alone() {
    let recording = super::model_list_node_tests::recording();
    let scenario = recording["scenarios"].as_array().unwrap().iter().find(|s| s["name"] == "custom-manual").unwrap();
    let rig = rig(scenario, &recording["seeds"], false).await;
    let warm = StatuslineWarmup::new(&|_| Some("0".to_owned()));
    let (tx, mut seen) = tokio::sync::mpsc::unbounded_channel();
    let sink = Arc::new(Sink { routes: Mutex::default(), seen: tx });
    warm.bind(rig.host.route.clone(), rig.loaded.clone(), rig.readiness.clone(), sink, Arc::new(Gates::default())).unwrap();
    warm.start();
    warm.turn_settled();
    warm.settle().await;
    assert!(seen.try_recv().is_err());
    assert!(rig.registry.names().iter().all(|name| name != "anthropic-oauth"));
}
