//! `ProcessWarmDeps` against `session/cache-warm.mjs`: every `defaultPrices` answer and every
//! `defaultRecordUsage` ledger row of `fixtures/cache-warm-deps/golden.json`
//! (`record-cache-warm-deps.mjs`), priced over the models.dev table the recording used; and the
//! setting read from `fixtures/cache-warm/golden.json`.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_core_api::domain::provider::{DeliveryState, ErrorKind, ProviderError, WireRequest};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::chain::{WarmDeps, WarmRequest, WarmTarget, WarmTimers};
use super::plan::CacheStrategy;
use super::process::{ProcessWarmDeps, TokioTimers, WarmConfig, WarmProviders, WarmSessions};
use super::stream::{WarmFailure, WarmUsage};
use crate::catalog::{CatalogPricing, CatalogSnapshot, CatalogService, ModelsDev, ModelsDevSource};
use crate::oauth::CredentialIo;
use crate::registry::accounting::{UsageRow, UsageSink};
use crate::transport::http::{HttpResponse, HttpSend};

const DEPS_GOLDEN: &str = include_str!("../../../../fixtures/cache-warm-deps/golden.json");
const WARM_GOLDEN: &str = include_str!("../../../../fixtures/cache-warm/golden.json");

struct Req {
    provider: String,
    model: String,
    session: String,
    owner: Option<String>,
}

impl WarmRequest for Req {
    fn provider_name(&self) -> &str {
        &self.provider
    }
    fn model(&self) -> &str {
        &self.model
    }
    fn session_id(&self) -> &str {
        &self.session
    }
    fn sent_at(&self) -> f64 {
        0.0
    }
    fn request_kind(&self) -> Option<&str> {
        None
    }
    fn cache_strategy(&self) -> Option<CacheStrategy> {
        None
    }
    fn thinking_budget_tokens(&self) -> f64 {
        0.0
    }
    fn has_effort(&self) -> bool {
        false
    }
    fn effort_levels_empty(&self) -> bool {
        false
    }
    fn has_warm_mode(&self) -> bool {
        true
    }
    fn owner_session_id(&self) -> Option<&str> {
        self.owner.as_deref()
    }
}

/// Nothing is fetched: the table is set resident.
struct Offline;

#[async_trait]
impl HttpSend for Offline {
    async fn send(&self, _: WireRequest, _: crate::transport::Exchange) -> Result<HttpResponse, ProviderError> {
        Err(ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent))
    }
}

/// The catalog warmed with the recording's models.dev table and an empty LiteLLM one.
async fn pricing(golden: &Value) -> Arc<CatalogPricing> {
    let tokens = mixdog_rt::testing::tokens();
    let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let metadata = ModelsDevSource::new(Arc::new(Offline), PathBuf::from("unused"), io);
    metadata.set_layer(ModelsDev::from_models_dev(golden["modelsdev"].clone()).expect("the recorded table"));
    let litellm = ModelsDevSource::litellm(Arc::new(Offline), PathBuf::from("unused"), io);
    litellm.set_layer(ModelsDev::from_litellm(json!({})));
    let service = CatalogService::cold_start(CatalogSnapshot::default(), Vec::new(), metadata).await.with_litellm(litellm).await;
    Arc::new(CatalogPricing(Arc::new(service)))
}

struct Config(Value);

impl WarmConfig for Config {
    fn load(&self) -> Value {
        self.0.clone()
    }
}

struct Sessions;

#[async_trait]
impl WarmSessions for Sessions {
    fn turn_in_flight(&self, _: &str) -> bool {
        false
    }
    async fn last_sent_request(&self, _: &str) -> Result<Option<Arc<dyn WarmRequest>>, String> {
        Ok(None)
    }
}

/// `fast` is what the recording found for the request (`fast && supportsAnthropicFastMode(model)
/// && fastModeAvailable()`).
struct Providers {
    fast: bool,
}

#[async_trait]
impl WarmProviders for Providers {
    async fn ready(&self) {}
    async fn current(&self, _: &dyn WarmRequest) -> bool {
        true
    }
    fn fast_priced(&self, _: &dyn WarmRequest) -> bool {
        self.fast
    }
    async fn send(
        &self,
        _: &dyn WarmRequest,
        _: &WarmTarget,
        _: &CancellationToken,
        _: &mut (dyn for<'u> FnMut(&'u WarmUsage) + Send),
    ) -> Result<WarmUsage, WarmFailure> {
        unreachable!("these tests send nothing")
    }
}

struct Collect(Mutex<Vec<UsageRow>>);

#[async_trait]
impl UsageSink for Collect {
    async fn record_queued(&self, row: UsageRow) -> Result<(), String> {
        self.0.lock().unwrap().push(row);
        Ok(())
    }
}

fn deps(pricing: Arc<CatalogPricing>, config: Value, fast: bool, now: f64, sink: Option<Arc<Collect>>) -> ProcessWarmDeps {
    ProcessWarmDeps {
        now: Arc::new(move || now),
        timers: TokioTimers,
        config: Arc::new(Config(config)),
        sessions: Arc::new(Sessions),
        providers: Arc::new(Providers { fast }),
        pricing,
        ledger: Arc::new(move || sink.clone().map(|sink| sink as Arc<dyn UsageSink>)),
        log: Arc::new(|_| {}),
    }
}

fn request(case: &Value) -> Req {
    Req {
        provider: case["provider"].as_str().unwrap().to_owned(),
        model: case["model"].as_str().unwrap().to_owned(),
        session: case["session"]["id"].as_str().unwrap_or_default().to_owned(),
        owner: ["ownerSessionId", "parentSessionId"].iter().find_map(|key| case["session"][key].as_str()).map(str::to_owned),
    }
}

fn number(value: &Value) -> Option<f64> {
    value.as_f64()
}

#[tokio::test]
async fn the_prices_are_nodes_default_prices() {
    let golden: Value = serde_json::from_str(DEPS_GOLDEN).unwrap();
    let pricing = pricing(&golden).await;
    let cases = golden["prices"].as_array().unwrap();
    assert!(cases.len() >= 30);
    let mut priced = 0;
    for case in cases {
        let deps = deps(Arc::clone(&pricing), json!({}), case["fastPriced"] == true, 0.0, None);
        let got = deps.prices(&request(case), case["ttlMs"].as_f64().unwrap(), case["promptTokens"].as_f64().unwrap()).await.unwrap();
        let want = &case["prices"];
        assert_eq!((got.read, got.write, got.output), (number(&want["read"]), number(&want["write"]), number(&want["output"])), "{case}");
        priced += usize::from(got.read.is_some());
    }
    assert!(priced > 10 && priced < cases.len(), "the golden reaches priced and unpriced models");
}

#[tokio::test]
async fn the_ledger_row_of_a_warm_is_nodes() {
    let golden: Value = serde_json::from_str(DEPS_GOLDEN).unwrap();
    let pricing = pricing(&golden).await;
    let cases = golden["rows"].as_array().unwrap();
    assert!(cases.len() >= 8);
    for case in cases {
        let sink = Arc::new(Collect(Mutex::default()));
        let deps = deps(Arc::clone(&pricing), json!({}), false, case["recordedAt"].as_f64().unwrap(), Some(Arc::clone(&sink)));
        let usage = &case["usage"];
        let count = |key: &str| usage[key].as_f64().unwrap_or(0.0);
        let warm = WarmUsage {
            input: count("inputTokens"),
            output: count("outputTokens"),
            cached: count("cachedTokens"),
            cache_write: count("cacheWriteTokens"),
            cache_write_1h: usage.get("cacheWrite1hTokens").and_then(Value::as_f64),
            prompt_tokens: None,
            cost_usd: None,
        };
        deps.record_usage(&request(case), &warm, case["startedAt"].as_f64().unwrap(), case["account"].as_str().unwrap()).await.unwrap();
        let rows = sink.0.lock().unwrap();
        assert_eq!(rows.len(), 1, "{}", case["name"]);
        let mut got = serde_json::to_value(&rows[0]).unwrap();
        // The random id of a live record is `<req>` in the recording.
        let id = got["id"].as_str().unwrap().to_owned();
        got["id"] = json!(format!("<req>{}", &id[36..]));
        assert_eq!(got, case["row"], "{}", case["name"]);
    }
}

#[tokio::test]
async fn no_open_ledger_records_nothing() {
    let golden: Value = serde_json::from_str(DEPS_GOLDEN).unwrap();
    let deps = deps(pricing(&golden).await, json!({}), false, 0.0, None);
    let usage = WarmUsage { input: 1.0, output: 1.0, cached: 0.0, cache_write: 0.0, cache_write_1h: None, prompt_tokens: None, cost_usd: None };
    deps.record_usage(&request(&golden["rows"][0]), &usage, 0.0, "").await.unwrap();
}

#[tokio::test]
async fn the_setting_is_read_from_the_config_as_node_reads_it() {
    let golden: Value = serde_json::from_str(WARM_GOLDEN).unwrap();
    let deps_golden: Value = serde_json::from_str(DEPS_GOLDEN).unwrap();
    let pricing = pricing(&deps_golden).await;
    for row in golden["pure"]["enabled"].as_array().unwrap() {
        let config = row.get("config").cloned().unwrap_or(Value::Null);
        let deps = deps(Arc::clone(&pricing), config, false, 0.0, None);
        assert_eq!(deps.read_config_enabled(), row["enabled"].as_bool().unwrap(), "{row}");
        assert_eq!(deps.enabled().await, row["enabled"].as_bool().unwrap(), "{row}");
    }
}

#[tokio::test]
async fn a_timer_runs_after_its_delay_and_a_cancelled_one_never_does() {
    let fired = Arc::new(Mutex::new(Vec::<&'static str>::new()));
    for (name, delay, cancel) in [("late", 150.0, false), ("cancelled", 150.0, true), ("negative", -5.0, false)] {
        let fired = Arc::clone(&fired);
        let handle = TokioTimers.schedule(delay, Box::pin(async move { fired.lock().unwrap().push(name) }));
        if cancel {
            handle.cancel();
        }
    }
    tokio::time::sleep(std::time::Duration::from_millis(60)).await;
    assert_eq!(*fired.lock().unwrap(), vec!["negative"]);
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    assert_eq!(*fired.lock().unwrap(), vec!["negative", "late"]);
}
