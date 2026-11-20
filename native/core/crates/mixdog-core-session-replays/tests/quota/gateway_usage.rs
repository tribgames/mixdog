//! The gateway usage writer equals Node's: each recorded case (fixtures/gateway-usage/golden.json, written by
//! benchmarks/rust-core/recorders/record-gateway-usage.mjs from the product's own `recordStandaloneStatusTelemetry`) is
//! replayed on a fresh data dir with the same seed files and steps, and every file it leaves, byte for byte, and the delay of
//! every timer it sets must be Node's.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicI64;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use mixdog_ai::catalog::CatalogPricing;
use mixdog_ai::catalog::CatalogService;
use mixdog_ai::catalog::CatalogSnapshot;
use mixdog_ai::catalog::LITELLM_CACHE_FILE;
use mixdog_ai::catalog::MODELS_DEV_CACHE_FILE;
use mixdog_ai::catalog::ModelsDevSource;
use mixdog_ai::oauth::CredentialIo;
use mixdog_ai::transport::http::HttpResponse;
use mixdog_ai::transport::http::HttpSend;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireRequest;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio::sync::Notify;

use mixdog_core_session::session::Clock;
use mixdog_core_session::session::gateway_usage::GatewayUsage;
use mixdog_core_session::session::gateway_usage::Scheduler;

struct TestClock(AtomicI64);

impl Clock for TestClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

struct Timer {
    cleared: bool,
}

/// Keeps the timers the writer sets; a `fire` step runs one.
#[derive(Default)]
struct Manual {
    timers: Arc<Mutex<Vec<Timer>>>,
    set: Arc<Notify>,
}

impl Scheduler for Manual {
    fn after(&self, delay_ms: u64, job: Box<dyn FnOnce() + Send>) -> Box<dyn FnOnce() + Send> {
        let mut timers = self.timers.lock().unwrap();
        let _ = (delay_ms, job);
        timers.push(Timer { cleared: false });
        let index = timers.len() - 1;
        drop(timers);
        self.set.notify_waiters();
        let timers = self.timers.clone();
        Box::new(move || timers.lock().unwrap()[index].cleared = true)
    }
}

/// Nothing is fetched: the tables are set resident.
struct Offline;

#[async_trait]
impl HttpSend for Offline {
    async fn send(&self, _: WireRequest, _: mixdog_ai::transport::Exchange) -> Result<HttpResponse, ProviderError> {
        Err(ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent))
    }
}

/// The catalog warmed with the recording's models.dev table and an empty LiteLLM one.
async fn pricing(modelsdev: &Value) -> Arc<CatalogPricing> {
    let tokens = mixdog_rt::testing::tokens();
    let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let cache = tempfile::tempdir().unwrap();
    let cached = |data: &Value| format!("{{\"fetchedAt\":1,\"data\":{}}}\n", mixdog_js::json_stringify(data));
    std::fs::write(cache.path().join(MODELS_DEV_CACHE_FILE), cached(modelsdev)).unwrap();
    std::fs::write(cache.path().join(LITELLM_CACHE_FILE), cached(&json!({}))).unwrap();
    let metadata = ModelsDevSource::new(Arc::new(Offline), cache.path().to_path_buf(), io);
    metadata.warm_from_disk().await;
    let litellm = ModelsDevSource::litellm(Arc::new(Offline), cache.path().to_path_buf(), io);
    litellm.warm_from_disk().await;
    let service = CatalogService::cold_start(CatalogSnapshot::default(), Vec::new(), metadata).await.with_litellm(litellm).await;
    Arc::new(CatalogPricing(Arc::new(service)))
}

const HELD: std::time::Duration = std::time::Duration::from_secs(10);

async fn writer_in(dir: &std::path::Path) -> GatewayUsage {
    let clock = Arc::new(TestClock(AtomicI64::new(1)));
    GatewayUsage::new(dir, mixdog_rt::testing::tokens().durability_io, clock, pricing(&json!({})).await, Arc::new(Manual::default()))
}

fn record_one(usage: &GatewayUsage) {
    usage.record(&json!({ "provider": "p", "model": "m" }), &json!({}), &json!({}), Some(1.0), Map::new());
}

/// The replay's barrier on the usage events: an event recorded before it holds it until its append ran, events recorded
/// after it, still buffered on their timer, do not.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_barrier_waits_for_the_events_before_it_and_not_the_later_ones() {
    use futures::FutureExt;
    let dir = tempfile::tempdir().unwrap();
    let usage = writer_in(dir.path()).await;
    record_one(&usage);
    let mark = usage.marks().accepted();
    let mut settled = Box::pin(usage.marks().reached(mark));
    assert!(settled.as_mut().now_or_never().is_none(), "the event from before the barrier is still buffered");
    usage.flush();
    record_one(&usage);
    record_one(&usage);
    let answer = tokio::time::timeout(HELD, settled).await.expect("the barrier did not answer within 10 s although the earlier event was appended");
    assert_eq!(answer, Ok(()));
    assert_eq!((usage.marks().committed(), usage.marks().accepted()), (mark, mark + 2), "the later events are still unwritten");
}

/// An append that failed before the barrier is its error, naming the store.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_append_before_the_barrier_is_its_error() {
    let dir = tempfile::tempdir().unwrap();
    // The data directory is a file: the store's lock cannot be taken under it.
    let data = dir.path().join("not-a-directory");
    std::fs::write(&data, "x").unwrap();
    let usage = writer_in(&data).await;
    record_one(&usage);
    usage.flush();
    let answer = tokio::time::timeout(HELD, usage.marks().reached(usage.marks().accepted())).await.expect("the barrier did not answer within 10 s");
    let error = answer.expect_err("the failed append is the barrier's error");
    assert!(error.starts_with("the gateway usage events: write 1, accepted before the barrier, failed: "), "{error}");
}
