//! The statusline usage warm-up: when it prepares the route's OAuth provider and refreshes its reading, and when it holds
//! back or leaves the route alone.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use mixdog_ai::service::admin_route::Obj;
use serde_json::Value;

use super::model_list_rig::{Rig, custom_manual, defaults, rig, seeds};
use super::model_warmup::{WarmupGates, WarmupMarks};
use super::statusline_warmup::{ReadinessPrep, StatuslineSink, StatuslineWarmup};
use crate::domains::ai_account::provider_setup::KeychainStatus;
use crate::domains::ai_account::setup_cache::KeychainLive;

#[derive(Default)]
struct Gates {
    busy: Mutex<Option<&'static str>>,
    close: tokio_util::sync::CancellationToken,
    marks: Mutex<Vec<String>>,
}

impl WarmupMarks for Gates {
    fn profile(&self, event: &str, detail: Option<Value>) {
        self.marks.lock().unwrap().push(format!("{event} {}", detail.map(|detail| detail.to_string()).unwrap_or_default()));
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
}

const NO_DELAY: &[(&str, &str)] = &[("MIXDOG_STATUSLINE_USAGE_WARMUP_DELAY_MS", "0")];

/// The warm-up bound to a profile whose default route is `scenario`'s.
async fn built(scenario: Value, env: &'static [(&'static str, &'static str)]) -> Built {
    let rig = rig(&scenario, &seeds(), false).await;
    let warm = StatuslineWarmup::new(&move |name| env.iter().find(|(key, _)| *key == name).map(|(_, value)| (*value).to_owned()));
    let gates = Arc::new(Gates::default());
    let (tx, seen) = tokio::sync::mpsc::unbounded_channel();
    let sink = Arc::new(Sink { routes: Mutex::default(), seen: tx });
    let prep = Arc::new(ReadinessPrep { keychain: Arc::new(ReadyKeychain), loaded: rig.loaded.clone(), readiness: rig.readiness.clone() });
    warm.bind(rig.host.route.clone(), prep, sink.clone(), gates.clone()).unwrap();
    Built { rig, warm, gates, sink, seen }
}

fn registered(built: &Built) -> bool {
    built.rig.registry.names().iter().any(|name| name == "anthropic-oauth")
}

#[tokio::test]
async fn the_boot_warm_up_registers_the_routes_provider_and_refreshes_its_reading_once() {
    let mut built = built(defaults(), NO_DELAY).await;
    built.warm.start();
    built.warm.settle().await;
    built.seen.recv().await.unwrap();
    let routes = built.sink.routes.lock().unwrap();
    assert_eq!(routes.len(), 1, "the route's reading is refreshed once");
    assert_eq!(routes[0]["provider"], "anthropic-oauth");
    assert_eq!(*built.gates.marks.lock().unwrap(), [r#"statusline-usage:warm-ready {"provider":"anthropic-oauth"}"#]);
    assert!(registered(&built), "the provider is registered for the reads that follow");
}

#[tokio::test]
async fn a_busy_runtime_parks_the_warm_up_until_a_wake() {
    let mut built = built(defaults(), NO_DELAY).await;
    *built.gates.busy.lock().unwrap() = Some("turn");
    built.warm.start();
    built.warm.settle().await;
    assert!(built.seen.try_recv().is_err(), "parked while busy");
    assert!(!registered(&built));
    *built.gates.busy.lock().unwrap() = None;
    built.warm.wake();
    built.warm.settle().await;
    built.seen.recv().await.unwrap();
    assert!(registered(&built));
}

#[tokio::test]
async fn a_settled_turn_prepares_and_refreshes_at_once_even_when_busy() {
    let mut built = built(defaults(), NO_DELAY).await;
    *built.gates.busy.lock().unwrap() = Some("turn");
    built.warm.turn_settled();
    built.seen.recv().await.unwrap();
    assert!(registered(&built));
    assert!(built.gates.marks.lock().unwrap().is_empty(), "only the scheduled warm is marked, not the refresh after a turn");
}

#[tokio::test(start_paused = true)]
async fn the_boot_warm_up_waits_eight_hundred_milliseconds_by_default() {
    let mut built = built(defaults(), &[]).await;
    let started = tokio::time::Instant::now();
    built.warm.start();
    built.warm.armed.acquire().await.unwrap().forget();
    tokio::time::advance(Duration::from_millis(799)).await;
    assert!(built.seen.try_recv().is_err(), "800 ms has not passed");
    tokio::time::advance(Duration::from_millis(1)).await;
    built.warm.settle().await;
    built.seen.recv().await.unwrap();
    assert_eq!(tokio::time::Instant::now() - started, Duration::from_millis(800));
}

#[tokio::test(start_paused = true)]
async fn the_runtime_closing_ends_the_pending_delay_and_registers_nothing() {
    let mut built = built(defaults(), &[]).await;
    let started = tokio::time::Instant::now();
    built.warm.start();
    built.warm.armed.acquire().await.unwrap().forget();
    built.gates.close.cancel();
    built.warm.settle().await;
    assert_eq!(tokio::time::Instant::now() - started, Duration::ZERO, "the task ended without the delay passing");
    assert!(built.seen.try_recv().is_err());
    assert!(!registered(&built));
}

#[tokio::test]
async fn a_route_that_is_not_oauth_is_left_alone_and_only_the_skip_is_marked() {
    let mut built = built(custom_manual(), NO_DELAY).await;
    built.warm.start();
    built.warm.turn_settled();
    built.warm.settle().await;
    assert!(built.seen.try_recv().is_err());
    assert_eq!(*built.gates.marks.lock().unwrap(), [r#"statusline-usage:warm-skipped {"provider":"custom-aaaa"}"#]);
    assert!(!registered(&built));
}
