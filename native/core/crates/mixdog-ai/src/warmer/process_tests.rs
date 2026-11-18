//! `ProcessWarmDeps` against `session/cache-warm.mjs`: every `defaultPrices` answer and every
//! `defaultRecordUsage` ledger row of `fixtures/cache-warm-deps/golden.json`
//! (`record-cache-warm-deps.mjs`), priced over the models.dev table the recording used; and the
//! setting read from `fixtures/cache-warm/golden.json`.

#[cfg(node_twin)]
use std::path::PathBuf;
#[cfg(node_twin)]
use std::sync::Arc;
#[cfg(node_twin)]
use std::sync::Mutex;

#[cfg(node_twin)]
use async_trait::async_trait;
#[cfg(node_twin)]
use mixdog_core_api::domain::provider::DeliveryState;
#[cfg(node_twin)]
use mixdog_core_api::domain::provider::ErrorKind;
#[cfg(node_twin)]
use mixdog_core_api::domain::provider::ProviderError;
#[cfg(node_twin)]
use mixdog_core_api::domain::provider::WireRequest;
#[cfg(node_twin)]
use serde_json::Value;
#[cfg(node_twin)]
use serde_json::json;
#[cfg(node_twin)]
use tokio_util::sync::CancellationToken;

#[cfg(node_twin)]
use super::chain::WarmRequest;
#[cfg(node_twin)]
use super::chain::WarmTarget;
#[cfg(node_twin)]
use super::chain::WarmDeps;
use super::chain::WarmTimers;
#[cfg(node_twin)]
use super::plan::CacheStrategy;
#[cfg(node_twin)]
use super::process::WarmConfig;
#[cfg(node_twin)]
use super::process::WarmProviders;
#[cfg(node_twin)]
use super::process::WarmSessions;
#[cfg(node_twin)]
use super::process::ProcessWarmDeps;
use super::process::TokioTimers;
#[cfg(node_twin)]
use super::stream::WarmFailure;
#[cfg(node_twin)]
use super::stream::WarmUsage;
#[cfg(node_twin)]
use crate::catalog::CatalogPricing;
#[cfg(node_twin)]
use crate::catalog::CatalogSnapshot;
#[cfg(node_twin)]
use crate::catalog::CatalogService;
#[cfg(node_twin)]
use crate::catalog::ModelsDev;
#[cfg(node_twin)]
use crate::catalog::ModelsDevSource;
#[cfg(node_twin)]
use crate::oauth::CredentialIo;
#[cfg(node_twin)]
use crate::accounts::ACCOUNT_PROVIDERS;
#[cfg(node_twin)]
use crate::registry::accounting::UsageRow;
#[cfg(node_twin)]
use crate::registry::accounting::UsageSink;
#[cfg(node_twin)]
use crate::transport::http::HttpResponse;
#[cfg(node_twin)]
use crate::transport::http::HttpSend;

#[cfg(node_twin)]
struct Req {
    provider: String,
    model: String,
    session: String,
    owner: Option<String>,
}

#[cfg(node_twin)]
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
    fn fast(&self) -> bool {
        false
    }
    fn warm_request(&self) -> Result<mixdog_core_api::domain::provider::ModelRequest, String> {
        Ok(mixdog_core_api::domain::provider::ModelRequest {
            model: self.model.clone(),
            messages: Vec::new(),
            tools: Vec::new(),
            options: mixdog_core_api::domain::provider::RequestOptions::default(),
        })
    }
    fn provider_generation(&self) -> Option<u64> {
        None
    }
}

#[cfg(node_twin)]
/// Nothing is fetched: the table is set resident.
struct Offline;

#[cfg(node_twin)]
#[async_trait]
impl HttpSend for Offline {
    async fn send(&self, _: WireRequest, _: crate::transport::Exchange) -> Result<HttpResponse, ProviderError> {
        Err(ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent))
    }
}

#[cfg(node_twin)]
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

#[cfg(node_twin)]
struct Config(Value);

#[cfg(node_twin)]
impl WarmConfig for Config {
    fn load(&self) -> Value {
        self.0.clone()
    }
}

#[cfg(node_twin)]
struct Sessions;

#[cfg(node_twin)]
#[async_trait]
impl WarmSessions for Sessions {
    fn turn_in_flight(&self, _: &str) -> bool {
        false
    }
    async fn last_sent_request(&self, _: &str) -> Result<Option<Arc<dyn WarmRequest>>, String> {
        Ok(None)
    }
}

#[cfg(node_twin)]
/// `fast` is what the recording found for the request (`fast && supportsAnthropicFastMode(model)
/// && fastModeAvailable()`).
struct Providers {
    fast: bool,
}

#[cfg(node_twin)]
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

#[cfg(node_twin)]
struct Collect(Mutex<Vec<UsageRow>>);

#[cfg(node_twin)]
#[async_trait]
impl UsageSink for Collect {
    async fn record_queued(&self, row: UsageRow) -> Result<(), String> {
        self.0.lock().unwrap().push(row);
        Ok(())
    }
}

#[cfg(node_twin)]
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

#[cfg(node_twin)]
fn request(case: &Value) -> Req {
    Req {
        provider: case["provider"].as_str().unwrap().to_owned(),
        model: case["model"].as_str().unwrap().to_owned(),
        session: case["session"]["id"].as_str().unwrap_or_default().to_owned(),
        owner: ["ownerSessionId", "parentSessionId"].iter().find_map(|key| case["session"][key].as_str()).map(str::to_owned),
    }
}

#[cfg(node_twin)]
fn number(value: &Value) -> Option<f64> {
    value.as_f64()
}

// The timers are tokio's, so the test moves the paused clock itself, to 1 ms before the 150 ms delay and then onto it.
#[tokio::test(start_paused = true)]
async fn a_timer_runs_after_its_delay_and_a_cancelled_one_never_does() {
    // TokioTimers spawns through mixdog-rt, which needs its (test) backend installed.
    mixdog_rt::testing::tokens();
    // Each timer that runs says so. The test keeps no sender, so a wait for one that will never run ends with `None`.
    let (fired, mut ran) = tokio::sync::mpsc::unbounded_channel::<&'static str>();
    for (name, delay, cancel) in [("late", 150.0, false), ("cancelled", 150.0, true), ("negative", -5.0, false)] {
        let fired = fired.clone();
        let handle = TokioTimers.schedule(delay, Box::pin(async move { let _ = fired.send(name); }));
        if cancel {
            handle.cancel();
        }
    }
    drop(fired);
    // A wait on the paused clock lets it run ahead to the next timer when nothing else can run, so each wait is followed by
    // the time on the clock: it is only where the test put it.
    let (began, ms) = (tokio::time::Instant::now(), std::time::Duration::from_millis);
    assert_eq!((ran.recv().await, began.elapsed()), (Some("negative"), ms(0)), "a negative delay runs with no time passed");
    tokio::time::advance(ms(149)).await;
    assert!(ran.try_recv().is_err(), "nothing has run 149 ms in");
    tokio::time::advance(ms(1)).await;
    assert_eq!((ran.recv().await, began.elapsed()), (Some("late"), ms(150)), "the 150 ms timer runs at 150 ms");
    assert_eq!(ran.recv().await, None, "the cancelled timer never runs");
}


#[cfg(node_twin)]
const DEPS_GOLDEN: &str = include_str!("../../../../fixtures/cache-warm-deps/golden.json");
#[cfg(node_twin)]
const WARM_GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/cache-warm/golden.json");
#[cfg(node_twin)]
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
#[cfg(node_twin)]
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
            output_known: usage.get("outputTokens").is_some_and(|v| v.is_number()),
            input: count("inputTokens"),
            output: count("outputTokens"),
            cached: count("cachedTokens"),
            cache_write: count("cacheWriteTokens"),
            cache_write_1h: usage.get("cacheWrite1hTokens").and_then(Value::as_f64),
            prompt_tokens: None,
            cost_usd: None,
        };
        // warmTarget: only a provider with a roster warms under an account; the recording drove the
        // chain, so the account its row names is the target's, not the hit's.
        let account = if ACCOUNT_PROVIDERS.contains(&case["provider"].as_str().unwrap()) { case["account"].as_str().unwrap() } else { "" };
        deps.record_usage(&request(case), &warm, case["startedAt"].as_f64().unwrap(), account).await.unwrap();
        let rows = sink.0.lock().unwrap();
        assert_eq!(rows.len(), 1, "{}", case["name"]);
        let mut got = serde_json::to_value(&rows[0]).unwrap();
        // The random id of a live record is `<req>` in the recording.
        let id = got["id"].as_str().unwrap().to_owned();
        got["id"] = json!(format!("<req>{}", &id[36..]));
        assert_eq!(got, case["row"], "{}", case["name"]);
    }
}
#[cfg(node_twin)]
#[tokio::test]
async fn no_open_ledger_records_nothing() {
    let golden: Value = serde_json::from_str(DEPS_GOLDEN).unwrap();
    let deps = deps(pricing(&golden).await, json!({}), false, 0.0, None);
    let usage = WarmUsage { input: 1.0, output: 1.0, output_known: true, cached: 0.0, cache_write: 0.0, cache_write_1h: None, prompt_tokens: None, cost_usd: None };
    deps.record_usage(&request(&golden["rows"][0]), &usage, 0.0, "").await.unwrap();
}
#[cfg(node_twin)]
#[tokio::test]
async fn the_setting_is_read_from_the_config_as_node_reads_it() {
    let golden: Value = serde_json::from_str(&WARM_GOLDEN).unwrap();
    let deps_golden: Value = serde_json::from_str(DEPS_GOLDEN).unwrap();
    let pricing = pricing(&deps_golden).await;
    for row in golden["pure"]["enabled"].as_array().unwrap() {
        let config = row.get("config").cloned().unwrap_or(Value::Null);
        let deps = deps(Arc::clone(&pricing), config, false, 0.0, None);
        assert_eq!(deps.read_config_enabled(), row["enabled"].as_bool().unwrap(), "{row}");
        assert_eq!(deps.enabled().await, row["enabled"].as_bool().unwrap(), "{row}");
    }
}
