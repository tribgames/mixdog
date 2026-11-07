//! The usage ledger row of a media generation (`media-usage.mjs` `recordMediaUsage`). One row per
//! generation, from what the provider reported: nothing is estimated, and a ledger failure never
//! fails the generation (it is logged the way usage accounting logs it).

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::catalog::Media;
use mixdog_ai::registry::accounting::{Facts, RecordArgs, UsagePricing, UsageSink, make_usage_record};
use mixdog_js::to_number_of;
use serde_json::Value;

/// What one generation reports to the ledger.
pub struct MediaUsageCall<'a> {
    /// The lane id: the ledger's provider.
    pub lane: &'a str,
    pub model: &'a str,
    /// The model that ran, when it is not the one listed (the ChatGPT lane bills the
    /// orchestrator model that ran the hosted tool).
    pub pricing_model: Option<&'a str>,
    /// The adapter's normalized usage (`usage::*`), or none when the provider reported nothing.
    pub usage: Option<&'a Value>,
    pub session_id: &'a str,
    pub source_type: &'a str,
    /// The connected account id the lane ran as (`''` for a lane without accounts).
    pub account: &'a str,
}

fn field(usage: Option<&Value>, key: &str) -> Option<f64> {
    usage.and_then(|u| u.get(key)).map(|v| to_number_of(Some(v))).filter(|n| !n.is_nan())
}

/// `recordMediaUsage(args)`: builds the row and queues it; a failure is logged and swallowed.
pub async fn record_media_usage(sink: &dyn UsageSink, pricing: &dyn UsagePricing, new_id: &(dyn Fn() -> String + Sync), now_ms: i64, call: MediaUsageCall<'_>) {
    let usage = call.usage;
    let count = |key: &str| field(usage, key).unwrap_or(0.0);
    let args = RecordArgs {
        ts: now_ms,
        provider: call.lane.to_owned(),
        model: call.model.to_owned(),
        requested_model: call.model.to_owned(),
        requested_provider: String::new(),
        status: "completed".to_owned(),
        attempts: 1.0,
        ttft_ms: None,
        elapsed_ms: 0.0,
        pricing_model: call.pricing_model.map(str::to_owned),
        session_id: Some(call.session_id.to_owned()),
        owner_session_id: None,
        source_type: call.source_type.to_owned(),
        facts: Facts {
            input_tokens: Some(count("inputTokens")),
            input_tokens_known: None,
            output_tokens: count("outputTokens"),
            cached_tokens: count("cachedTokens"),
            cache_write_tokens: 0.0,
            cache_write_1h_tokens: 0.0,
            cost_usd: usage.and_then(|u| u.get("costUsd")).and_then(Value::as_f64),
            raw_service_tier: None,
        },
        // No media lane is Anthropic's, whose prompt totals exclude the cached part.
        input_tokens_inclusive: true,
        media: Some(Media {
            reported_cost_usd: usage.and_then(|u| u.get("costUsd")).and_then(Value::as_f64),
            output_image_tokens: count("outputImageTokens"),
            output_video_tokens: count("outputVideoTokens"),
            images: count("images"),
            seconds: count("seconds"),
            resolution: usage.and_then(|u| u.get("resolution")).and_then(Value::as_str).map(str::to_owned),
        }),
        service_tier: None,
        request_service_tier: None,
        response_id: String::new(),
        account: call.account.to_owned(),
        duration_ms: 0.0,
        origin: None,
        id: None,
    };
    let saved = match make_usage_record(&args, pricing, new_id) {
        Ok(row) => sink.record_queued(row).await,
        Err(error) => Err(error),
    };
    if let Err(error) = saved {
        tracing::error!("[usage-ledger] RECORD NOT SAVED: {error}");
    }
}

/// Where the jobs bill a generation. `call.account` is the account the job was pinned to (empty:
/// the lane's own, which the implementation resolves).
#[async_trait]
pub trait MediaUsageLedger: Send + Sync {
    async fn record(&self, call: MediaUsageCall<'_>);
}

/// The production ledger: the usage queue, the pricing catalog, a clock and the random ids.
pub struct QueuedLedger {
    pub sink: Arc<dyn UsageSink>,
    pub pricing: Arc<dyn UsagePricing>,
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
    pub new_id: Arc<dyn Fn() -> String + Send + Sync>,
    /// `lane, pinned account` -> the account id the row names: the pinned one, else the one the
    /// chat has selected for the lane's provider, `''` for a lane without accounts.
    pub account_of: Arc<dyn LedgerAccounts>,
}

/// `lane, pinned account` -> the account id a usage row names. Async: the chat's selection is
/// read from the roster on every call.
#[async_trait]
pub trait LedgerAccounts: Send + Sync {
    async fn account(&self, lane: &str, pinned: &str) -> String;
}

#[async_trait]
impl MediaUsageLedger for QueuedLedger {
    async fn record(&self, call: MediaUsageCall<'_>) {
        let account = self.account_of.account(call.lane, call.account).await;
        record_media_usage(self.sink.as_ref(), self.pricing.as_ref(), self.new_id.as_ref(), (self.now)(), MediaUsageCall { account: &account, ..call }).await;
    }
}