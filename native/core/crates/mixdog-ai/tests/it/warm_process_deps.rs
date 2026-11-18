//! The process's prompt-cache warm dependencies: the setting, the prices a warm is judged by, the ledger row a warm
//! writes, and the timers it arms.

use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_ai::catalog::PricedUsage;
use mixdog_ai::catalog::UsageArgs;
use mixdog_ai::registry::accounting::UsagePricing;
use mixdog_ai::registry::accounting::UsageRow;
use mixdog_ai::registry::accounting::UsageSink;
use mixdog_ai::warmer::chain::WarmDeps;
use mixdog_ai::warmer::chain::WarmRequest;
use mixdog_ai::warmer::chain::WarmTarget;
use mixdog_ai::warmer::chain::WarmTimers;
use mixdog_ai::warmer::plan::CacheStrategy;
use mixdog_ai::warmer::process::ProcessWarmDeps;
use mixdog_ai::warmer::process::TokioTimers;
use mixdog_ai::warmer::process::WarmConfig;
use mixdog_ai::warmer::process::WarmProviders;
use mixdog_ai::warmer::process::WarmSessions;
use mixdog_ai::warmer::stream::WarmFailure;
use mixdog_ai::warmer::stream::WarmUsage;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::RequestOptions;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

/// Per-million rates of one model: reads 0.3, five-minute writes 3.75, one-hour writes 6, output 15; twice that in
/// fast mode. Every other model has no price.
struct Rates;

impl UsagePricing for Rates {
    fn price_usage(&self, args: &UsageArgs) -> PricedUsage {
        let mut rates = serde_json::Map::new();
        if args.model != "priced-model" {
            return PricedUsage { input: args.input_tokens, cost_usd: None, rates };
        }
        let factor = if args.request_service_tier.as_deref() == Some("fast") { 2.0 } else { 1.0 };
        for (key, per_million) in [("cacheReadCostPerM", 0.3), ("cacheWriteCostPerM", 3.75), ("cacheWrite1hCostPerM", 6.0), ("outputCostPerM", 15.0)] {
            rates.insert(key.into(), json!(per_million * factor));
        }
        PricedUsage { input: args.input_tokens, cost_usd: Some(0.0), rates }
    }
}

struct Request {
    provider: &'static str,
    model: &'static str,
    owner: Option<&'static str>,
}

impl WarmRequest for Request {
    fn provider_name(&self) -> &str {
        self.provider
    }
    fn model(&self) -> &str {
        self.model
    }
    fn session_id(&self) -> &str {
        "session-1"
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
        self.owner
    }
    fn fast(&self) -> bool {
        false
    }
    fn warm_request(&self) -> Result<ModelRequest, String> {
        Ok(ModelRequest { model: self.model.to_owned(), messages: Vec::new(), tools: Vec::new(), options: RequestOptions::default() })
    }
    fn provider_generation(&self) -> Option<u64> {
        None
    }
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

/// `fast` says whether the real send went out in fast mode.
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

#[derive(Default)]
struct Ledger(Mutex<Vec<UsageRow>>);

#[async_trait]
impl UsageSink for Ledger {
    async fn record_queued(&self, row: UsageRow) -> Result<(), String> {
        self.0.lock().unwrap().push(row);
        Ok(())
    }
}

fn deps(config: Value, fast: bool, now: f64, ledger: Option<Arc<Ledger>>) -> ProcessWarmDeps {
    ProcessWarmDeps {
        now: Arc::new(move || now),
        timers: TokioTimers,
        config: Arc::new(Config(config)),
        sessions: Arc::new(Sessions),
        providers: Arc::new(Providers { fast }),
        pricing: Arc::new(Rates),
        ledger: Arc::new(move || ledger.clone().map(|ledger| ledger as Arc<dyn UsageSink>)),
        log: Arc::new(|_| {}),
    }
}

fn close(got: Option<f64>, want: f64) -> bool {
    got.is_some_and(|got| (got - want).abs() < 1e-12)
}

const FIVE_MINUTES: f64 = 5.0 * 60_000.0;
const ONE_HOUR: f64 = 60.0 * 60_000.0;
const PRICED: Request = Request { provider: "anthropic-oauth", model: "priced-model", owner: None };

#[test]
fn prompt_cache_warming_is_on_only_when_the_setting_is_exactly_true() {
    for (config, want) in [
        (json!({ "promptCacheWarming": true }), true),
        (json!({ "promptCacheWarming": false }), false),
        (json!({ "promptCacheWarming": "true" }), false),
        (json!({ "promptCacheWarming": 1 }), false),
        (json!({}), false),
        (Value::Null, false),
    ] {
        assert_eq!(deps(config.clone(), false, 0.0, None).read_config_enabled(), want, "{config}");
    }
}

#[tokio::test]
async fn the_prices_are_per_token_with_the_write_rate_of_the_entrys_lifetime() {
    let five = deps(json!({}), false, 0.0, None).prices(&PRICED, FIVE_MINUTES, 1000.0).await.unwrap();
    assert!(close(five.read, 0.3e-6) && close(five.write, 3.75e-6) && close(five.output, 15e-6), "{five:?}");
    let hour = deps(json!({}), false, 0.0, None).prices(&PRICED, ONE_HOUR, 1000.0).await.unwrap();
    assert!(close(hour.write, 6e-6), "an hour-long entry is written at the one-hour rate: {hour:?}");
    assert!(close(hour.read, 0.3e-6), "reading costs the same whatever the lifetime");
}

#[tokio::test]
async fn a_warm_of_a_fast_send_is_priced_at_the_fast_tier() {
    let fast = deps(json!({}), true, 0.0, None).prices(&PRICED, FIVE_MINUTES, 1000.0).await.unwrap();
    assert!(close(fast.read, 0.6e-6) && close(fast.output, 30e-6), "{fast:?}");
}

#[tokio::test]
async fn a_model_without_a_price_has_no_rates_at_all() {
    let unknown = Request { provider: "anthropic-oauth", model: "mystery", owner: None };
    let prices = deps(json!({}), false, 0.0, None).prices(&unknown, FIVE_MINUTES, 1000.0).await.unwrap();
    assert_eq!((prices.read, prices.write, prices.output), (None, None, None));
}

#[tokio::test]
async fn a_warm_writes_a_cache_warm_row_under_the_session_and_account_with_its_own_duration() {
    let ledger = Arc::new(Ledger::default());
    let request = Request { provider: "anthropic-oauth", model: "priced-model", owner: Some("owner-session") };
    let usage = WarmUsage { input: 10.0, output: 1.0, output_known: true, cached: 900.0, cache_write: 50.0, ..WarmUsage::default() };
    deps(json!({}), false, 1_700_000_005_000.0, Some(ledger.clone())).record_usage(&request, &usage, 1_700_000_001_000.0, "account-7").await.unwrap();
    let rows = ledger.0.lock().unwrap();
    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    assert_eq!(row.source_type, "cache-warm");
    assert_eq!((row.provider.as_str(), row.model.as_str(), row.account.as_str()), ("anthropic-oauth", "priced-model", "account-7"));
    assert_eq!((row.session_id.as_str(), row.owner_session_id.as_deref()), ("session-1", Some("owner-session")));
    assert_eq!((row.output, row.cache_read, row.cache_write), (1.0, 900.0, 50.0));
    assert_eq!((row.ts, row.duration_ms), (1_700_000_005_000, 4000.0), "the row's time is now, its duration the warm's");
}

#[tokio::test]
async fn with_no_open_ledger_a_warm_records_nothing_and_does_not_fail() {
    let usage = WarmUsage { input: 1.0, output: 1.0, output_known: true, ..WarmUsage::default() };
    deps(json!({}), false, 0.0, None).record_usage(&PRICED, &usage, 0.0, "").await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn a_timer_runs_after_its_delay_and_a_cancelled_one_never_does() {
    // The timers spawn through mixdog-rt, which needs its test backend installed.
    mixdog_rt::testing::tokens();
    let (fired, mut ran) = tokio::sync::mpsc::unbounded_channel::<&'static str>();
    for (name, delay, cancel) in [("late", 150.0, false), ("cancelled", 150.0, true), ("negative", -5.0, false)] {
        let fired = fired.clone();
        let handle = TokioTimers.schedule(delay, Box::pin(async move { let _ = fired.send(name); }));
        if cancel {
            handle.cancel();
        }
    }
    drop(fired);
    let (began, ms) = (tokio::time::Instant::now(), Duration::from_millis);
    assert_eq!((ran.recv().await, began.elapsed()), (Some("negative"), ms(0)), "a negative delay runs with no time passed");
    tokio::time::advance(ms(149)).await;
    assert!(ran.try_recv().is_err(), "nothing has run 149 ms in");
    tokio::time::advance(ms(1)).await;
    assert_eq!((ran.recv().await, began.elapsed()), (Some("late"), ms(150)), "the 150 ms timer runs at 150 ms");
    assert_eq!(ran.recv().await, None, "the cancelled timer never runs");
}
