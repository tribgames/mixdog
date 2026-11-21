//! The statusline usage warm-up: when it prepares the route's OAuth provider and refreshes its reading, and when it holds
//! back or leaves the route alone.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use mixdog_ai::service::admin_route::Obj;
use serde_json::Value;

use super::model_list_rig::{Rig, custom_manual, defaults, rig, seeds};
use super::model_warmup::{WarmupGates, WarmupMarks};
use super::statusline_warmup::{AFTER_TURN, ReadinessPrep, StatuslineSink, StatuslineWarmup, UsagePrep};
use crate::domains::ai_account::provider_setup::KeychainStatus;
use crate::domains::ai_account::setup_cache::KeychainLive;

#[derive(Default)]
struct Gates {
    busy: Mutex<Option<&'static str>>,
    close: tokio_util::sync::CancellationToken,
    marks: Mutex<Vec<String>>,
    /// The slot of every warm-up job that started.
    started: Mutex<Vec<&'static str>>,
    /// How many warm-up jobs have ended.
    ended: tokio::sync::watch::Sender<usize>,
}

impl WarmupMarks for Gates {
    fn profile(&self, event: &str, detail: Option<Value>) {
        self.marks.lock().unwrap().push(format!("{event} {}", detail.map(|detail| detail.to_string()).unwrap_or_default()));
    }
    fn running(&self, slot: &'static str, running: bool) {
        if running {
            self.started.lock().unwrap().push(slot);
        } else {
            self.ended.send_modify(|ended| *ended += 1);
        }
    }
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

struct ReadyKeychain;

#[async_trait::async_trait]
impl KeychainLive for ReadyKeychain {
    fn status(&self) -> KeychainStatus {
        KeychainStatus::default()
    }
    fn prewarm_ready(&self) -> bool {
        true
    }
    async fn await_prewarm(&self) {}
    async fn retry(&self, _: bool) -> bool {
        false
    }
    async fn refresh(&self, _: bool) -> bool {
        false
    }
}

#[derive(Default)]
struct Sink {
    routes: Mutex<Vec<Obj>>,
}

impl StatuslineSink for Sink {
    fn refresh_route(&self, route: &Obj) {
        self.routes.lock().unwrap().push(route.clone());
    }
}

/// The daemon's preparation, keeping what kept it from readying a provider.
struct Recorded {
    inner: ReadinessPrep,
    failures: Mutex<Vec<String>>,
}

#[async_trait::async_trait]
impl UsagePrep for Recorded {
    async fn keychain_prewarm(&self) {
        self.inner.keychain_prewarm().await;
    }
    fn ensure_config_for_route_provider(&self) {
        self.inner.ensure_config_for_route_provider();
    }
    async fn ensure_provider_ready(&self, provider: &str) -> Result<bool, String> {
        let ready = self.inner.ensure_provider_ready(provider).await;
        if let Err(error) = &ready {
            self.failures.lock().unwrap().push(error.clone());
        }
        ready
    }
}

struct Built {
    rig: Rig,
    warm: Arc<StatuslineWarmup>,
    gates: Arc<Gates>,
    sink: Arc<Sink>,
    prep: Arc<Recorded>,
}

const NO_DELAY: &[(&str, &str)] = &[("MIXDOG_STATUSLINE_USAGE_WARMUP_DELAY_MS", "0")];

/// The warm-up bound to a profile whose default route is `scenario`'s.
async fn built(scenario: Value, env: &'static [(&'static str, &'static str)]) -> Built {
    let rig = rig(&scenario, &seeds(), false).await;
    let warm = StatuslineWarmup::new(&move |name| env.iter().find(|(key, _)| *key == name).map(|(_, value)| (*value).to_owned()));
    let gates = Arc::new(Gates::default());
    let sink = Arc::new(Sink::default());
    let inner = ReadinessPrep { keychain: Arc::new(ReadyKeychain), config: rig.config.clone(), loaded: rig.loaded.clone(), readiness: rig.readiness.clone() };
    let prep = Arc::new(Recorded { inner, failures: Mutex::default() });
    warm.bind(rig.host.route.clone(), prep.clone(), sink.clone(), gates.clone()).unwrap();
    Built { rig, warm, gates, sink, prep }
}

fn registered(built: &Built) -> bool {
    built.rig.registry.names().iter().any(|name| name == "anthropic-oauth")
}

/// The routes whose reading the ended warm-up refreshed; none fails with what kept the refresh from the sink.
fn refreshed(built: &Built) -> Vec<Obj> {
    let routes = built.sink.routes.lock().unwrap().clone();
    assert!(
        !routes.is_empty(),
        "no reading was refreshed; preparation failures {:?}, marks {:?}",
        built.prep.failures.lock().unwrap(),
        built.gates.marks.lock().unwrap()
    );
    routes
}

fn none_refreshed(built: &Built) -> bool {
    built.sink.routes.lock().unwrap().is_empty()
}

#[tokio::test]
async fn the_boot_warm_up_registers_the_routes_provider_and_refreshes_its_reading_once() {
    let built = built(defaults(), NO_DELAY).await;
    built.warm.start();
    built.warm.settle().await;
    let routes = refreshed(&built);
    assert_eq!(routes.len(), 1, "the route's reading is refreshed once");
    assert_eq!(routes[0]["provider"], "anthropic-oauth");
    assert_eq!(*built.gates.marks.lock().unwrap(), [r#"statusline-usage:warm-ready {"provider":"anthropic-oauth"}"#]);
    assert!(registered(&built), "the provider is registered for the reads that follow");
}

#[tokio::test]
async fn a_busy_runtime_parks_the_warm_up_until_a_wake() {
    let built = built(defaults(), NO_DELAY).await;
    *built.gates.busy.lock().unwrap() = Some("turn");
    built.warm.start();
    built.warm.settle().await;
    assert!(none_refreshed(&built), "parked while busy");
    assert!(!registered(&built));
    *built.gates.busy.lock().unwrap() = None;
    built.warm.wake();
    built.warm.settle().await;
    refreshed(&built);
    assert!(registered(&built));
}

#[tokio::test]
async fn a_settled_turn_prepares_and_refreshes_at_once_even_when_busy() {
    let built = built(defaults(), NO_DELAY).await;
    *built.gates.busy.lock().unwrap() = Some("turn");
    built.warm.turn_settled();
    built.gates.ended.subscribe().wait_for(|ended| *ended == 1).await.unwrap();
    refreshed(&built);
    assert!(registered(&built));
    assert!(built.gates.marks.lock().unwrap().is_empty(), "only the scheduled warm is marked, not the refresh after a turn");
}

#[tokio::test(start_paused = true)]
async fn the_boot_warm_up_waits_eight_hundred_milliseconds_by_default() {
    let built = built(defaults(), &[]).await;
    let started = tokio::time::Instant::now();
    built.warm.start();
    built.warm.armed.acquire().await.unwrap().forget();
    tokio::time::advance(Duration::from_millis(799)).await;
    assert!(none_refreshed(&built), "800 ms has not passed");
    tokio::time::advance(Duration::from_millis(1)).await;
    built.warm.settle().await;
    refreshed(&built);
    assert_eq!(tokio::time::Instant::now() - started, Duration::from_millis(800));
}

#[tokio::test(start_paused = true)]
async fn the_runtime_closing_ends_the_pending_delay_and_registers_nothing() {
    let built = built(defaults(), &[]).await;
    let started = tokio::time::Instant::now();
    built.warm.start();
    built.warm.armed.acquire().await.unwrap().forget();
    built.gates.close.cancel();
    built.warm.settle().await;
    assert_eq!(tokio::time::Instant::now() - started, Duration::ZERO, "the task ended without the delay passing");
    assert!(none_refreshed(&built));
    assert!(!registered(&built));
}

#[tokio::test]
async fn a_route_that_is_not_oauth_is_left_alone_and_only_the_skip_is_marked() {
    let built = built(custom_manual(), NO_DELAY).await;
    built.warm.start();
    built.warm.turn_settled();
    built.warm.settle().await;
    assert!(none_refreshed(&built));
    assert!(!built.gates.started.lock().unwrap().contains(&AFTER_TURN), "no refresh after the turn was started");
    assert_eq!(*built.gates.marks.lock().unwrap(), [r#"statusline-usage:warm-skipped {"provider":"custom-aaaa"}"#]);
    assert!(!registered(&built));
}

#[tokio::test]
async fn a_provider_the_user_switched_off_after_the_config_loaded_is_neither_readied_nor_read() {
    let built = built(defaults(), NO_DELAY).await;
    // Stored after the loaded config was built, with a probe's flag that does not discount the user's decision.
    built
        .rig
        .config
        .update_agent(|doc| {
            doc.insert("providers".into(), serde_json::json!({ "anthropic-oauth": { "enabled": false, "credentialProbeUnavailable": true } }));
            Ok(())
        })
        .await
        .unwrap();
    built.warm.start();
    built.warm.settle().await;
    assert!(none_refreshed(&built));
    assert!(!registered(&built));
    assert!(built.prep.failures.lock().unwrap().is_empty(), "the readiness was never asked");
    assert!(built.gates.marks.lock().unwrap().is_empty());
}
