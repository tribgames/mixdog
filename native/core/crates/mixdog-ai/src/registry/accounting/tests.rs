//! The rows of every send outcome against the rows Node writes
//! (`fixtures/usage-accounting/record.mjs`): completed, cancelled and failed
//! sends, abandoned attempts included.

use std::sync::Mutex;

use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::UsdTicks;
use mixdog_js::time::Tz;
use serde_json::Map;

use super::*;

const GOLDEN: &str = include_str!("../../../fixtures/usage-accounting/golden.json");

/// Prices nothing, as an empty catalog does: the unpriced snapshot Node gives a
/// model it does not know.
struct Unpriced;

impl UsagePricing for Unpriced {
    fn price_usage(&self, args: &UsageArgs) -> PricedUsage {
        let cached = args.cache_read_tokens;
        let written = args.cache_write_tokens;
        let input = if args.input_tokens_known == Some(false) {
            0.0
        } else if args.input_tokens_inclusive == Some(true) {
            (args.input_tokens - cached - written).max(0.0)
        } else {
            args.input_tokens
        };
        let mut rates = Map::new();
        let written_1h = args.cache_write_1h_tokens.min(written);
        rates.insert("requestedModel".into(), args.requested_model.clone().map_or(Value::Null, Value::from));
        rates.insert("pricingModel".into(), json!(args.pricing_model.clone().unwrap_or_else(|| args.model.clone())));
        rates.insert("pricingProvider".into(), json!(args.provider));
        rates.insert("pricingSource".into(), Value::Null);
        if args.input_tokens_known == Some(false) {
            rates.insert("inputTokensKnown".into(), json!(false));
        }
        for (key, tier) in [("requestServiceTier", &args.request_service_tier), ("serviceTier", &args.service_tier)] {
            if let Some(tier) = tier.as_ref().filter(|tier| !tier.is_empty()) {
                rates.insert(key.into(), json!(tier));
            }
        }
        if written_1h != 0.0 {
            rates.insert("cacheWrite1hTokens".into(), crate::service::admin_route::jnum(written_1h));
        }
        let reason = if args.input_tokens_known == Some(false) { "unmeasured-input" } else { "model-not-found" };
        rates.insert("unpricedReason".into(), json!(reason));
        PricedUsage { input, cost_usd: None, rates }
    }
}

#[derive(Default)]
struct Collect(Mutex<Vec<UsageRow>>);

#[async_trait]
impl UsageSink for Collect {
    async fn record_queued(&self, row: UsageRow) -> Result<(), String> {
        self.0.lock().unwrap().push(row);
        Ok(())
    }
}

fn usage_of(spec: &Value) -> Usage {
    let n = |key: &str| spec.get(key).and_then(Value::as_u64).unwrap_or(0);
    Usage {
        input_tokens: n("inputTokens"),
        output_tokens: n("outputTokens"),
        cache_read_tokens: n("cachedTokens"),
        cache_write_tokens: n("cacheWriteTokens"),
        cache_write_1h_tokens: n("cacheWrite1hTokens"),
        cost: spec.get("costUsd").and_then(Value::as_f64).and_then(UsdTicks::from_usd),
        ..Usage::default()
    }
}

fn identity(case: &Value, started_at: i64) -> SendIdentity {
    let text = |key: &str| case.get(key).and_then(Value::as_str).map(str::to_owned);
    let provider = text("provider").unwrap();
    let model = text("model").unwrap();
    let provider_name = provider.clone();
    SendIdentity {
        provider: provider.clone(),
        model: model.clone(),
        requested_provider: provider,
        requested_model: model,
        route_hop: false,
        session_id: Some(text("sessionId").unwrap_or_else(|| "session-1".into())),
        owner_session_id: text("ownerSessionId"),
        source_type: "lead".into(),
        input_tokens_inclusive: case.get("inputExcludesCache") != Some(&json!(true)),
        request_service_tier: String::new(),
        // The account the send is bound to; Node's unbound default is `default`.
        account: if crate::accounts::ACCOUNT_PROVIDERS.contains(&provider_name.as_str()) { "default".into() } else { String::new() },
        request_id: "<req>".into(),
        started_at,
    }
}

async fn rows_of(case: &Value) -> Vec<Value> {
    let started_at = case["startedAt"].as_i64().unwrap();
    let end = &case["end"];
    let stream_ms = end.get("streamMs").and_then(Value::as_i64).unwrap_or(1500);
    let sink = Arc::new(Collect::default());
    let mut accounting = SendAccounting::new(identity(case, started_at), Arc::new(Unpriced), Some(sink.clone()))
        .with_sources(Arc::new(move || started_at + stream_ms), Arc::new(|| "<random>".into()));
    for attempt in case.get("abandoned").and_then(Value::as_array).into_iter().flatten() {
        let model = attempt.get("model").and_then(Value::as_str).map(str::to_owned);
        accounting.note_abandoned(&usage_of(&attempt["usage"]), model);
    }
    let usage = end.get("usage").map(usage_of);
    let recorded = match end["kind"].as_str().unwrap() {
        "completed" => {
            let completed = Completed {
                facts: usage.as_ref().map(Facts::from),
                model: end.get("model").and_then(Value::as_str).map(str::to_owned),
                response_id: end.get("responseId").and_then(Value::as_str).map(str::to_owned),
                fallback: end.get("fallback") == Some(&json!(true)),
                generation_ms: end.get("generationMs").and_then(Value::as_f64),
                stream_ended_at: started_at + stream_ms,
                ..Completed::default()
            };
            accounting.finish(Outcome::Completed(completed)).await
        }
        "cancelled" => accounting.finish(Outcome::Cancelled { reported: usage.as_ref().map(Facts::from) }).await,
        _ => {
            let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::Ambiguous);
            error.partial_usage = usage.map(Box::new);
            error.partial_model = end.get("model").and_then(Value::as_str).map(Box::from);
            accounting.finish(Outcome::Failed(&error)).await
        }
    };
    assert_eq!(recorded, Recorded::default());
    let rows = sink.0.lock().unwrap().iter().map(|row| serde_json::to_value(row).unwrap()).collect();
    rows
}

#[tokio::test]
async fn every_outcome_writes_the_rows_node_writes() {
    // The golden was recorded with TZ=UTC: the row's day is the local day.
    let _ = mixdog_js::time::set_process_zone(Tz::UTC);
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let cases = golden["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 17);
    for case in cases {
        let want = case["rows"].as_array().unwrap();
        let rows = rows_of(case).await;
        assert_eq!(&rows, want, "{}", case["name"]);
    }
}

#[test]
fn a_status_follows_failed_then_substituted_then_retried() {
    assert_eq!(usage_request_status(true, true, 3), "failed");
    assert_eq!(usage_request_status(false, true, 3), "substituted");
    assert_eq!(usage_request_status(false, false, 2), "retried");
    assert_eq!(usage_request_status(false, false, 1), "completed");
    assert!(!served_model_substituted("openai", "gpt-5", "openai/gpt-5-2026-01-01", false));
    assert!(served_model_substituted("openai", "gpt-5", "gpt-5-mini", false));
    assert!(!served_model_substituted("gemini-x", "a", "b", true));
}
