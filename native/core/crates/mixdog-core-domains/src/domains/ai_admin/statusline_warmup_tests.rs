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
    /// Every `bootProfile` mark, as `event detail`, in order.
    marks: Mutex<Vec<String>>,
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
    fn profile(&self, event: &str, detail: &str) {
        self.marks.lock().unwrap().push(format!("{event} {detail}"));
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
    built_from(recording["scenarios"][0].clone(), &recording["seeds"], env).await
}

/// The warm-up bound to the pipeline of the recorded profile `node`.
async fn built_from(node: Value, seeds: &Value, env: &'static [(&'static str, &'static str)]) -> Built {
    let rig = rig(&node, seeds, false).await;
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
// Node's reads before its warm-up has run (recorded with the warm-up delayed past them, statusline-oauth-route-before-warm):
// the route's provider, with no credential, is not listed and no row can search. Reads made before the warm-up do not
// change what is read after it: the registration moves the catalog revision, which drops the caches they filled.
#[tokio::test]
async fn reads_before_the_warm_up_answer_as_nodes_and_the_reads_after_it_still_do() {
    let mut built = built(NO_DELAY).await;
    let recording = statusline_recording();
    let before = recording["scenarios"].as_array().unwrap().iter().find(|s| s["name"] == "statusline-oauth-route-before-warm").unwrap();
    let calls = before["calls"].as_array().unwrap();
    assert_eq!(calls.iter().map(|c| c["action"].as_str().unwrap()).collect::<Vec<_>>(), ["listProviderModels", "listWebSearchModels"]);
    assert_rows("full, before the warm-up", &built.rig.service.rows(false, false).await.unwrap(), &calls[0]["value"]);
    let found = web_search(&built.rig).list(None, false).await.unwrap();
    assert_rows("web search, before the warm-up", found.as_array().unwrap(), &calls[1]["value"]);
    built.warm.start();
    built.warm.settle().await;
    built.seen.recv().await.unwrap();
    assert_node_reads(&built).await;
}

/// `wait`, or a failure naming `what` once a minute has passed without it.
async fn within<T>(what: &str, wait: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(60), wait).await.unwrap_or_else(|_| panic!("{what}: not within 60 s"))
}

// Node's model-list reads with the statusline-usage warm-up between the full and the web-search read (`model-lists`, the
// `*-after-statusline-warm-up-moved-catalog-revision` scenarios). The recorder held the warm-up, released it after the
// full read and held the endpoint's next request: the catalog refresh the readiness starts (provider-readiness.mjs:149)
// once the registry applied the config with the route's OAuth provider enabled and moved the catalog revision
// (registry.mjs:312). The web-search read lands after that move and before the refresh answered, so it drops the caches
// the full read filled (model-meta.mjs:18, web-search-catalog.mjs:112). Driven here in the same order: the endpoint held,
// the warm-up run to its end, the read made then. The core starts no catalog refresh after the warm-up's provider
// preparation (nothing reaches the held endpoint, or the warm-up could not end), so its read lands where Node's did:
// after the move, before any refresh answered. (The `*-before-statusline-warm-up` scenarios, the warm-up held through
// every read, are read with no warm-up in model_list_node_tests.)
#[tokio::test]
async fn a_web_search_read_after_the_warm_up_moved_the_catalog_revision_answers_as_nodes() {
    let recording = super::model_list_node_tests::recording();
    let mut driven = 0;
    for node in recording["scenarios"].as_array().unwrap() {
        let calls = node["calls"].as_array().unwrap();
        let actions: Vec<&str> = calls.iter().map(|c| c["action"].as_str().unwrap()).collect();
        if actions != ["listProviderModels", "listProviderModels", "statuslineUsageWarmup", "listWebSearchModels"] {
            continue;
        }
        let name = node["name"].as_str().unwrap();
        let built = built_from(node.clone(), &recording["seeds"], NO_DELAY).await;
        let rig = &built.rig;
        assert_rows(&format!("{name}: quick"), &rig.service.rows(false, true).await.unwrap(), &calls[0]["value"]);
        rig.host.settle_warm().await;
        assert_rows(&format!("{name}: full"), &rig.service.rows(false, false).await.unwrap(), &calls[1]["value"]);
        // From here on the endpoint holds what reaches it.
        let hits = rig.hits.load(std::sync::atomic::Ordering::SeqCst);
        rig.gate.send_replace(false);
        built.warm.start();
        within(&format!("{name}: the warm-up's provider preparation"), built.warm.settle()).await;
        assert!(built.gates.marks.lock().unwrap().iter().any(|mark| mark.starts_with("statusline-usage:warm-ready")), "{name}: the warm-up ran");
        let found = within(&format!("{name}: the web-search read"), web_search(rig).list(None, false)).await.unwrap();
        assert_rows(&format!("{name}: web search"), found.as_array().unwrap(), &calls[3]["value"]);
        assert_eq!(rig.hits.load(std::sync::atomic::Ordering::SeqCst), hits, "{name}: nothing reached the endpoint since the full read");
        rig.gate.send_replace(true);
        driven += 1;
    }
    assert!(driven > 0, "the recording holds a read after the warm-up moved the catalog revision");
}

// The third ordering (`*-after-catalog-refresh-completed-and-rewarmed`): after the warm-up moved the revision, the recorder
// answered the held catalog-refresh request and waited for what Node does on its completion (provider-readiness.mjs:160-171):
// the model caches dropped with the providers kept (`invalidateProviderCaches({ preserveProviderInit: true })`) and the
// authoritative re-warm (`warmProviderModelCache({ loadSecrets: true })`) landed (`provider-models:warm-ready` after
// `provider-catalogs:refresh-ready`). Driven here in the same order with the core's own steps for that completion: the
// catalog refresh and the invalidation that follows it (`ProviderReadiness::refresh_catalogs`), then the secrets-carrying
// warm run to its end, then the read. The core does not start that refresh by itself after the warm-up's preparation
// (`ProviderReadiness::ensure_providers_ready` reports `catalogs_due` and the warm-up drops it), so the test makes the steps.
#[tokio::test]
async fn a_web_search_read_after_the_refresh_completed_and_the_re_warm_landed_answers_as_nodes() {
    let recording = super::model_list_node_tests::recording();
    let mut driven = 0;
    for node in recording["scenarios"].as_array().unwrap() {
        let calls = node["calls"].as_array().unwrap();
        let actions: Vec<&str> = calls.iter().map(|c| c["action"].as_str().unwrap()).collect();
        if actions != ["listProviderModels", "listProviderModels", "statuslineUsageWarmup", "catalogRefreshCompleted", "listWebSearchModels"] {
            continue;
        }
        let name = node["name"].as_str().unwrap();
        let built = built_from(node.clone(), &recording["seeds"], NO_DELAY).await;
        let rig = &built.rig;
        let service = rig.service.clone();
        assert!(rig.readiness.bind_invalidation(Arc::new(move || service.invalidate())).is_ok(), "{name}: the invalidation is bound once");
        assert_rows(&format!("{name}: quick"), &rig.service.rows(false, true).await.unwrap(), &calls[0]["value"]);
        rig.host.settle_warm().await;
        assert_rows(&format!("{name}: full"), &rig.service.rows(false, false).await.unwrap(), &calls[1]["value"]);
        built.warm.start();
        within(&format!("{name}: the warm-up's provider preparation"), built.warm.settle()).await;
        assert!(built.gates.marks.lock().unwrap().iter().any(|mark| mark.starts_with("statusline-usage:warm-ready")), "{name}: the warm-up ran");
        within(&format!("{name}: the catalog refresh and its invalidation"), rig.readiness.refresh_catalogs()).await;
        assert!(!rig.service.cache_loaded(), "{name}: the refresh's completion dropped the cache");
        rig.service.warm_cache(true);
        within(&format!("{name}: the re-warm"), rig.service.settle_warm()).await;
        assert!(rig.service.cache_loaded(), "{name}: the re-warm landed");
        let found = within(&format!("{name}: the web-search read"), web_search(rig).list(None, false)).await.unwrap();
        assert_rows(&format!("{name}: web search"), found.as_array().unwrap(), &calls[4]["value"]);
        driven += 1;
    }
    assert_eq!(driven, 2, "the recording holds both families' reads after the refresh completed and the re-warm landed");
}

// The fourth ordering (`*-after-catalog-refresh-completed-while-rewarm-loads`): as the third, but the re-warm's load was held
// at its start (`loadProviderModelsFresh`) and the web-search read made while it was in flight, the caches dropped, then the
// load released. Driven here in the same order: the refresh and its invalidation, the secrets-carrying warm started and
// held at its first step (its keychain read, the vault gate closed), the read, then the release and the load's end.
#[tokio::test]
async fn a_web_search_read_while_the_re_warm_loads_answers_as_nodes() {
    let recording = super::model_list_node_tests::recording();
    let mut driven = 0;
    for node in recording["scenarios"].as_array().unwrap() {
        let calls = node["calls"].as_array().unwrap();
        let actions: Vec<&str> = calls.iter().map(|c| c["action"].as_str().unwrap()).collect();
        if actions != ["listProviderModels", "listProviderModels", "statuslineUsageWarmup", "catalogRefreshCompletedRewarmHeld", "listWebSearchModels", "rewarmReleased"] {
            continue;
        }
        let name = node["name"].as_str().unwrap();
        let built = built_from(node.clone(), &recording["seeds"], NO_DELAY).await;
        let rig = &built.rig;
        let service = rig.service.clone();
        assert!(rig.readiness.bind_invalidation(Arc::new(move || service.invalidate())).is_ok(), "{name}: the invalidation is bound once");
        assert_rows(&format!("{name}: quick"), &rig.service.rows(false, true).await.unwrap(), &calls[0]["value"]);
        rig.host.settle_warm().await;
        assert_rows(&format!("{name}: full"), &rig.service.rows(false, false).await.unwrap(), &calls[1]["value"]);
        built.warm.start();
        within(&format!("{name}: the warm-up's provider preparation"), built.warm.settle()).await;
        within(&format!("{name}: the catalog refresh and its invalidation"), rig.readiness.refresh_catalogs()).await;
        rig.vault_gate.send_replace(false);
        rig.service.warm_cache(true);
        within(&format!("{name}: the re-warm reaching its keychain read"), rig.vault_arrived.acquire()).await.unwrap().forget();
        assert!(rig.host.load_in_flight() && !rig.service.cache_loaded(), "{name}: the re-warm is in flight over dropped caches");
        let found = within(&format!("{name}: the web-search read while the re-warm loads"), web_search(rig).list(None, false)).await.unwrap();
        assert_rows(&format!("{name}: web search"), found.as_array().unwrap(), &calls[4]["value"]);
        rig.vault_gate.send_replace(true);
        within(&format!("{name}: the released re-warm"), rig.service.settle_warm()).await;
        assert!(rig.service.cache_loaded(), "{name}: the re-warm landed");
        driven += 1;
    }
    assert_eq!(driven, 2, "the recording holds both families' reads while the re-warm loads");
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
    // Node's statusline-usage:warm-ready, marked once the preparation is done and the refresh dispatched.
    assert_eq!(*built.gates.marks.lock().unwrap(), ["statusline-usage:warm-ready provider=anthropic-oauth"]);
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

// Teardown clears the pending warm-up timer: the runtime closing ends the delay at once, and no provider is registered.
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
    assert!(built.gates.marks.lock().unwrap().is_empty(), "Node marks the scheduled warm only, not the refresh after a turn");
}

#[tokio::test]
async fn a_route_that_is_not_oauth_is_left_alone() {
    let recording = super::model_list_node_tests::recording();
    let scenario = recording["scenarios"].as_array().unwrap().iter().find(|s| s["name"] == "custom-manual").unwrap();
    let rig = rig(scenario, &recording["seeds"], false).await;
    let warm = StatuslineWarmup::new(&|_| Some("0".to_owned()));
    let gates = Arc::new(Gates::default());
    let (tx, mut seen) = tokio::sync::mpsc::unbounded_channel();
    let sink = Arc::new(Sink { routes: Mutex::default(), seen: tx });
    warm.bind(rig.host.route.clone(), rig.loaded.clone(), rig.readiness.clone(), sink, gates.clone()).unwrap();
    warm.start();
    warm.turn_settled();
    warm.settle().await;
    assert!(seen.try_recv().is_err());
    assert!(gates.marks.lock().unwrap().is_empty(), "nothing was warmed, so nothing is marked");
    assert!(rig.registry.names().iter().all(|name| name != "anthropic-oauth"));
}
