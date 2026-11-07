//! The process's `WarmDeps` (`session/cache-warm.mjs` `DEFAULT_DEPS`): the setting, the prices of a
//! warm, the usage-ledger row and the timers are decided here; what only the session runtime, the
//! side-question store and the provider registry know is asked through [`WarmSessions`] and
//! [`WarmProviders`].
//!
//! Build one `Arc<Warmer>` over one `ProcessWarmDeps`; the settings effects and the purge hook
//! share it.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use futures::future::BoxFuture;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::chain::{TimerHandle, WarmDeps, WarmRequest, WarmTarget, WarmTimers};
use super::plan::{Prices, TTL_1H_MS, warming_enabled};
use super::stores::{Log, Now};
use super::stream::{WarmFailure, WarmUsage};
use crate::catalog::UsageArgs;
use crate::registry::accounting::{Facts, RecordArgs, UsagePricing, UsageSink, make_usage_record, random_uuid};

/// `CACHE_WARM_SOURCE`.
pub const CACHE_WARM_SOURCE: &str = "cache-warm";
const MILLION: f64 = 1_000_000.0;

/// `loadConfig({ secrets: false })`.
pub trait WarmConfig: Send + Sync {
    fn load(&self) -> Value;
}

/// What the session runtime knows.
#[async_trait]
pub trait WarmSessions: Send + Sync {
    /// `isTurnInFlight(runtimeState.get(sessionId))`.
    fn turn_in_flight(&self, session_id: &str) -> bool;
    /// `lastSentMainRequest(sessionId)`.
    async fn last_sent_request(&self, session_id: &str) -> Result<Option<Arc<dyn WarmRequest>>, String>;
}

/// What the provider registry knows.
#[async_trait]
pub trait WarmProviders: Send + Sync {
    /// `providersInitialized()`: waits for the owning runtime's initialization, never starts it.
    async fn ready(&self);
    /// `registeredProvider(name) === request.provider`.
    async fn current(&self, request: &dyn WarmRequest) -> bool;
    /// `request.opts.fast === true && supportsAnthropicFastMode(model) && fastModeAvailable()`:
    /// the real send went out in fast mode, so the warm is priced as it.
    fn fast_priced(&self, request: &dyn WarmRequest) -> bool;
    /// `provider.sendCacheWarm` on the request's registered provider.
    async fn send(
        &self,
        request: &dyn WarmRequest,
        target: &WarmTarget,
        cancel: &CancellationToken,
        on_usage: &mut (dyn for<'u> FnMut(&'u WarmUsage) + Send),
    ) -> Result<WarmUsage, WarmFailure>;
}

/// `setTimeout` on tokio.
pub struct TokioTimers;

struct Armed(CancellationToken);

impl TimerHandle for Armed {
    fn cancel(&self) {
        self.0.cancel();
    }
}

impl WarmTimers for TokioTimers {
    fn schedule(&self, delay_ms: f64, task: BoxFuture<'static, ()>) -> Box<dyn TimerHandle> {
        let token = CancellationToken::new();
        let stop = token.clone();
        // `setTimeout` clamps a negative or non-finite delay to 0.
        let delay = Duration::from_millis(if delay_ms.is_finite() && delay_ms > 0.0 { delay_ms as u64 } else { 0 });
        mixdog_rt::spawn("cache-warm-timer", mixdog_rt::TaskClass::Work, async move {
            tokio::select! {
                () = stop.cancelled() => {}
                () = tokio::time::sleep(delay) => task.await,
            }
        });
        Box::new(Armed(token))
    }
}

pub struct ProcessWarmDeps {
    pub now: Now,
    pub timers: TokioTimers,
    pub config: Arc<dyn WarmConfig>,
    pub sessions: Arc<dyn WarmSessions>,
    pub providers: Arc<dyn WarmProviders>,
    pub pricing: Arc<dyn UsagePricing>,
    /// `getUsageLedger()`: none while the ledger is not open.
    pub ledger: Arc<dyn Fn() -> Option<Arc<dyn UsageSink>> + Send + Sync>,
    pub log: Log,
}

impl ProcessWarmDeps {
    /// Per-million rates of a request using exactly the given tokens, or none when a used slot is
    /// unpriced.
    fn rates_of(&self, request: &dyn WarmRequest, fast: bool, tokens: UsageArgs) -> Option<serde_json::Map<String, Value>> {
        let priced = self.pricing.price_usage(&UsageArgs {
            provider: request.provider_name().to_owned(),
            model: request.model().to_owned(),
            input_tokens_inclusive: Some(false),
            request_service_tier: fast.then(|| "fast".to_owned()),
            ..tokens
        });
        priced.cost_usd.map(|_| priced.rates)
    }
}

fn per_token(rates: Option<&serde_json::Map<String, Value>>, key: &str) -> Option<f64> {
    rates.and_then(|rates| rates.get(key)).and_then(Value::as_f64).map(|rate| rate / MILLION)
}

#[async_trait]
impl WarmDeps for ProcessWarmDeps {
    fn now(&self) -> f64 {
        (self.now)()
    }

    fn timers(&self) -> &dyn WarmTimers {
        &self.timers
    }

    async fn enabled(&self) -> bool {
        self.read_config_enabled()
    }

    fn read_config_enabled(&self) -> bool {
        warming_enabled(Some(&self.config.load()))
    }

    fn turn_in_flight(&self, session_id: &str) -> bool {
        self.sessions.turn_in_flight(session_id)
    }

    async fn last_sent_request(&self, session_id: &str) -> Result<Option<Arc<dyn WarmRequest>>, String> {
        self.sessions.last_sent_request(session_id).await
    }

    async fn providers_ready(&self) {
        self.providers.ready().await;
    }

    async fn provider_current(&self, request: &dyn WarmRequest) -> bool {
        self.providers.current(request).await
    }

    /// `defaultPrices`: the rates at a prompt of `prompt_tokens` (a model priced by prompt length
    /// charges cache reads, writes and the warm's one output token at the tier that length falls
    /// in), at the request's own service tier.
    async fn prices(&self, request: &dyn WarmRequest, ttl_ms: f64, prompt_tokens: f64) -> Result<Prices, String> {
        let fast = self.providers.fast_priced(request);
        let one_hour = ttl_ms >= TTL_1H_MS;
        let read = self.rates_of(request, fast, UsageArgs { cache_read_tokens: prompt_tokens, output_tokens: 1.0, ..UsageArgs::default() });
        let write = self.rates_of(
            request,
            fast,
            UsageArgs { cache_write_tokens: prompt_tokens, cache_write_1h_tokens: if one_hour { prompt_tokens } else { 0.0 }, ..UsageArgs::default() },
        );
        Ok(Prices {
            read: per_token(read.as_ref(), "cacheReadCostPerM"),
            write: per_token(write.as_ref(), if one_hour { "cacheWrite1hCostPerM" } else { "cacheWriteCostPerM" }),
            output: per_token(read.as_ref(), "outputCostPerM"),
        })
    }

    async fn send(
        &self,
        request: &dyn WarmRequest,
        target: &WarmTarget,
        cancel: &CancellationToken,
        on_usage: &mut (dyn for<'u> FnMut(&'u WarmUsage) + Send),
    ) -> Result<WarmUsage, WarmFailure> {
        self.providers.send(request, target, cancel, on_usage).await
    }

    /// `defaultRecordUsage`: the row the provider boundary writes, under the `cache-warm` source.
    async fn record_usage(&self, request: &dyn WarmRequest, usage: &WarmUsage, started_at: f64, account_id: &str) -> Result<(), String> {
        let Some(ledger) = (self.ledger)() else { return Ok(()) };
        let now = (self.now)();
        let args = RecordArgs {
            ts: now as i64,
            provider: request.provider_name().to_owned(),
            model: request.model().to_owned(),
            requested_model: request.model().to_owned(),
            requested_provider: String::new(),
            status: String::new(),
            attempts: 0.0,
            ttft_ms: None,
            elapsed_ms: 0.0,
            pricing_model: None,
            session_id: Some(request.session_id().to_owned()),
            owner_session_id: request.owner_session_id().map(str::to_owned),
            source_type: CACHE_WARM_SOURCE.to_owned(),
            facts: Facts {
                input_tokens: Some(usage.input),
                input_tokens_known: None,
                output_tokens: usage.output,
                cached_tokens: usage.cached,
                cache_write_tokens: usage.cache_write,
                cache_write_1h_tokens: usage.cache_write_1h.unwrap_or(0.0),
                cost_usd: None,
                raw_service_tier: None,
            },
            input_tokens_inclusive: false,
            service_tier: None,
            request_service_tier: None,
            response_id: String::new(),
            account: account_id.to_owned(),
            duration_ms: now - started_at,
            origin: None,
            id: None,
        };
        let row = make_usage_record(&args, self.pricing.as_ref(), &random_uuid)?;
        ledger.record_queued(row).await
    }

    fn log(&self, line: &str) {
        (self.log)(&format!("[cache-warm] {line}\n"));
    }
}
