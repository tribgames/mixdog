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
use mixdog_core_api::domain::provider::UsdTicks;
use mixdog_core_api::domain::provider::Usage;
use mixdog_core_api::domain::provider::WireRequest;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio::sync::Notify;

use mixdog_core_session::session::gateway_usage::Ask;
use mixdog_core_session::session::gateway_usage::GatewayUsage;
use mixdog_core_session::session::gateway_usage::Scheduler;
use mixdog_core_session::session::Clock;

const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/gateway-usage/golden.json");
const PER_CHUNK: usize = 3;

struct TestClock(AtomicI64);

impl Clock for TestClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

struct Timer {
    ms: u64,
    cleared: bool,
    fired: bool,
    job: Option<Box<dyn FnOnce() + Send>>,
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
        timers.push(Timer { ms: delay_ms, cleared: false, fired: false, job: Some(job) });
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

/// A seeded file: its recorded text, or the generated event lines (the recorder's `generate`).
fn seed_bytes(seed: &Value) -> String {
    if let Some(spec) = seed.get("gen") {
        let (lines, pad, base) = (spec["lines"].as_u64().unwrap(), spec["pad"].as_u64().unwrap() as usize, spec["base"].as_i64().unwrap());
        return (0..lines)
            .map(|i| format!("{}\n", mixdog_js::json_stringify(&json!({ "ts": base + i as i64 * 1000, "provider": "seed", "model": "m", "costUsd": 0, "n": i, "pad": "x".repeat(pad) }))))
            .collect();
    }
    seed["text"].as_str().unwrap().to_owned()
}

fn usage_of(usage: &Value) -> Usage {
    let count = |key: &str| usage[key].as_u64().unwrap_or(0);
    Usage {
        input_tokens: count("inputTokens"),
        output_tokens: count("outputTokens"),
        cache_read_tokens: count("cachedTokens"),
        cache_write_tokens: count("cacheWriteTokens"),
        cache_write_1h_tokens: count("cacheWrite1hTokens"),
        raw: usage.get("raw").cloned(),
        cost: usage["costUsd"].as_f64().map(|usd| UsdTicks((usd * UsdTicks::PER_USD as f64).round() as u64)),
        ..Usage::default()
    }
}

fn timer_states(timers: &Mutex<Vec<Timer>>) -> Vec<Value> {
    timers.lock().unwrap().iter().map(|t| json!({ "ms": t.ms, "cleared": t.cleared, "fired": t.fired })).collect()
}

async fn replay(case: &Value, modelsdev: &Value) {
    let name = case["name"].as_str().unwrap();
    let dir = tempfile::tempdir().unwrap();
    for (file, seed) in case["seed"].as_object().unwrap() {
        std::fs::write(dir.path().join(file), seed_bytes(seed)).unwrap();
    }
    let clock = Arc::new(TestClock(AtomicI64::new(0)));
    let scheduler = Arc::new(Manual::default());
    let timers = scheduler.timers.clone();
    let set = scheduler.set.clone();
    let usage = GatewayUsage::new(dir.path(), mixdog_rt::testing::tokens().durability_io, clock.clone(), pricing(modelsdev).await, scheduler);
    let mut at_exit = None;
    for step in case["steps"].as_array().unwrap() {
        match step["op"].as_str().unwrap() {
            "clock" => clock.0.store(step["now"].as_i64().unwrap(), Ordering::SeqCst),
            "ask" => {
                let (session, result) = (&step["session"], &step["result"]);
                // Node's `!result?.usage` guard sits at the call site here: a settled ask always carries its usage.
                if result.get("usage").is_none() {
                    continue;
                }
                let mut header: Map<String, Value> = session.as_object().unwrap().clone();
                let messages = header.remove("messages").unwrap();
                header.remove("tools");
                let rows: Vec<&Map<String, Value>> = messages.as_array().unwrap().iter().map(|m| m.as_object().unwrap()).collect();
                usage.record_ask(&Ask {
                    header: &header,
                    usage: &usage_of(&result["usage"]),
                    response_model: result["model"].as_str().unwrap_or_default(),
                    tool_calls_total: result["toolCallsTotal"].as_u64().unwrap(),
                    message_count: rows.len(),
                    estimated_tokens: step["estimatedTokens"].as_f64().unwrap(),
                    turn_effort: mixdog_core_session::session::gateway_usage::turn_effort(rows.iter().copied()),
                    duration_ms: step["durationMs"].as_f64().unwrap(),
                    transport_timing: result.get("transportTiming").cloned(),
                });
            }
            "fire" => {
                let ms = step["ms"].as_u64().unwrap();
                let job = {
                    let mut timers = timers.lock().unwrap();
                    let timer = timers.iter_mut().find(|t| !t.cleared && !t.fired && t.ms == ms).unwrap_or_else(|| panic!("{name}: no pending {ms} ms timer"));
                    timer.fired = true;
                    timer.job.take().unwrap()
                };
                job();
            }
            "await-timer" => {
                let ms = step["ms"].as_u64().unwrap();
                loop {
                    let arrived = set.notified();
                    tokio::pin!(arrived);
                    arrived.as_mut().enable();
                    if timers.lock().unwrap().iter().any(|t| !t.cleared && !t.fired && t.ms == ms) {
                        break;
                    }
                    arrived.await;
                }
            }
            "settle" => usage.settle().await,
            "exit" => {
                // The recorder reads the timers before `process.exit` runs the exit handler.
                at_exit = Some(timer_states(&timers));
                usage.flush_final().await
            }
            other => panic!("unknown step {other}"),
        }
    }
    let recorded: Vec<Value> = case["timers"].as_array().unwrap().clone();
    let set = at_exit.unwrap_or_else(|| timer_states(&timers));
    assert_eq!(set, recorded, "{name}: the timers set");
    let mut names: Vec<String> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    let want: Vec<&String> = case["files"].as_object().unwrap().keys().collect();
    assert_eq!(names.iter().collect::<Vec<_>>(), want, "{name}: the files left");
    for (file, golden) in case["files"].as_object().unwrap() {
        let bytes = std::fs::read(dir.path().join(file)).unwrap();
        match golden.get("text") {
            Some(text) => assert_eq!(String::from_utf8(bytes).unwrap(), text.as_str().unwrap(), "{name}: {file}"),
            None => {
                use sha2::Digest;
                let hex: String = sha2::Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
                let lines = String::from_utf8_lossy(&bytes).split('\n').filter(|l| !mixdog_js::js_trim(l).is_empty()).count();
                assert_eq!((bytes.len() as u64, lines as u64, hex.as_str()), (golden["bytes"].as_u64().unwrap(), golden["lines"].as_u64().unwrap(), golden["sha256"].as_str().unwrap()), "{name}: {file}");
            }
        }
    }
}

async fn cases_chunk(chunk: usize) {
    let golden: Value = serde_json::from_str(&GOLDEN).unwrap();
    let cases = golden["cases"].as_array().unwrap();
    let range = mixdog_rt::testing::chunk_range(cases.len(), chunk, PER_CHUNK);
    for case in &cases[range] {
        replay(case, &golden["modelsdev"]).await;
    }
}

#[test]
fn the_chunks_cover_the_recording() {
    let golden: Value = serde_json::from_str(&GOLDEN).unwrap();
    mixdog_rt::testing::assert_chunks_registered(CASES, golden["cases"].as_array().unwrap().len(), PER_CHUNK);
}

mixdog_rt::replay_chunks!(CASES, #[tokio::test] async cases_chunk; [
    the_writer_equals_node_chunk_00 = 0,
    the_writer_equals_node_chunk_01 = 1,
    the_writer_equals_node_chunk_02 = 2,
    the_writer_equals_node_chunk_03 = 3,
    the_writer_equals_node_chunk_04 = 4,
    the_writer_equals_node_chunk_05 = 5,
    the_writer_equals_node_chunk_06 = 6,
    the_writer_equals_node_chunk_07 = 7,
]);
