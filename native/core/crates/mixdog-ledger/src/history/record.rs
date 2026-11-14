//! A surviving original row as a usage record (`importTraceRow` and the part of `makeUsageRecord`
//! an import takes), and the repricing of restored whole days (`repriceRestoredDays`).
//!
//! Imports are priced at their day (`historical`), never at the exact request time, and a daily
//! sum is priced as a sum (`price_aggregate`): it cannot say which requests crossed a tier.

use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;

use crate::append::UsageRecord;
use crate::error::Result;
use crate::measure::num;
use crate::refresh::Pricer;
use crate::repair::PriceRequest;
use crate::repair::route_kind;
use crate::time::MAX_SAFE_INTEGER;
use crate::time::day_key;

/// JavaScript truthiness of a parsed value.
pub(super) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `a || b || c`: the first truthy operand, else the last one.
fn first<'a>(operands: &[Option<&'a Value>]) -> Option<&'a Value> {
    operands
        .iter()
        .copied()
        .find(|operand| matches!(operand, Some(value) if truthy(value)))
        .or_else(|| operands.last().copied())
        .flatten()
}

/// `a ?? b`: the first operand that is neither absent nor null.
fn nullish<'a>(operands: &[Option<&'a Value>]) -> Option<&'a Value> {
    operands.iter().copied().flatten().find(|value| !value.is_null())
}

/// Neither absent nor null (`value != null`).
fn present(value: Option<&Value>) -> bool {
    value.is_some_and(|value| !value.is_null())
}

/// `text(value)` of `usage-ledger.mjs`: a string cut to 300 UTF-16 units, anything else empty.
fn text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => mixdog_js::slice_utf16(text, 300),
        _ => String::new(),
    }
}

/// `n` of `priceUsage`: a finite number that is not negative, else 0.
fn non_negative(value: f64) -> f64 {
    if value.is_finite() && value >= 0.0 { value } else { 0.0 }
}

fn amount(value: Option<&Value>) -> f64 {
    non_negative(mixdog_js::to_number_of(value))
}

/// `isInclusiveProvider`: every provider but Anthropic's counts cached tokens inside its input.
fn inclusive(provider: &str) -> bool {
    !matches!(mixdog_js::js_to_lowercase(provider).as_str(), "anthropic" | "anthropic-oauth")
}

/// The request time of an original row: a number as it is, digits as a number, any other text as
/// `Date.parse` reads it. A time that is not a positive safe integer makes the row unrecordable.
fn timestamp(value: Option<&Value>) -> Option<i64> {
    let ms = match value? {
        Value::Number(number) => number.as_f64()?,
        Value::String(digits) if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) => {
            mixdog_js::string_to_number(digits)
        }
        other => mixdog_js::time::date_parse(&mixdog_js::value_to_string(other)),
    };
    (ms.is_finite() && ms.fract() == 0.0 && ms > 0.0 && ms <= MAX_SAFE_INTEGER as f64).then_some(ms as i64)
}

/// A provider-reported cost: present, not empty text, and a finite number that is not negative.
fn supplied_cost(value: Option<&Value>) -> Option<f64> {
    let value = value.filter(|v| !v.is_null())?;
    if matches!(value, Value::String(text) if text.is_empty()) {
        return None;
    }
    let cost = mixdog_js::to_number(value);
    (cost.is_finite() && cost >= 0.0).then_some(cost)
}

/// The rates of a row whose cost the provider reported or that ran locally: the catalog's price
/// is not what applied, so only the identity of the route is kept.
fn own_rates(priced: Option<&str>, provider: &str, kind: &str) -> String {
    let parsed: Option<Value> = priced.and_then(|rates| serde_json::from_str(rates).ok());
    let empty = Map::new();
    let rates = parsed.as_ref().and_then(Value::as_object).unwrap_or(&empty);
    let mut own = Map::new();
    for key in ["requestedModel", "pricingModel"] {
        if let Some(value) = rates.get(key) {
            own.insert(key.to_owned(), value.clone());
        }
    }
    for key in ["requestServiceTier", "serviceTier"] {
        if let Some(tier) = rates.get(key).filter(|tier| truthy(tier)) {
            own.insert(key.to_owned(), tier.clone());
        }
    }
    own.insert("pricingProvider".to_owned(), json!(provider));
    own.insert("pricingSource".to_owned(), json!(if kind == "local" { "local" } else { "provider" }));
    mixdog_js::json_stringify(&Value::Object(own))
}

/// `usageRecordId`: a digest of what identifies the request.
fn record_id(record: &UsageRecord, response_id: &str) -> String {
    let identity = if response_id.is_empty() {
        json!([
            "record",
            record.ts,
            record.provider,
            record.model,
            record.session_id,
            mixdog_js::json_number(record.input),
            mixdog_js::json_number(record.output),
            mixdog_js::json_number(record.cache_read),
            mixdog_js::json_number(record.cache_write),
        ])
    } else {
        json!(["response", record.provider, record.model, response_id])
    };
    Sha256::digest(mixdog_js::json_stringify(&identity).as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// `importTraceRow` then `makeUsageRecord(.., historical: true)`: `None` for a row that cannot
/// be recorded (no input or output figure, no provider or model, no usable time). A figure that
/// is empty is unknown, and importing it as zero would claim coverage.
pub(super) fn import_row(row: &Value, pricer: &dyn Pricer) -> Result<Option<UsageRecord>> {
    let payload = row.get("payload").filter(|payload| truthy(payload));
    let in_payload = |key: &str| payload.and_then(|payload| payload.get(key));
    let raw = row.get("kind").and_then(Value::as_str) == Some("usage_raw");
    let field = |snake: &str, camel: &str| row.get(if raw { snake } else { camel });
    let input = field("input_tokens", "inputTokens");
    let output = field("output_tokens", "outputTokens");
    if !present(input) || !present(output) {
        return Ok(None);
    }
    // A provider or model that is not text is a row nothing can be attributed to.
    let provider = text(first(&[row.get("provider"), in_payload("provider")]));
    let model = text(row.get("model"));
    if provider.is_empty() || model.is_empty() {
        return Ok(None);
    }
    let Some(ts) = timestamp(row.get("ts")) else {
        return Ok(None);
    };
    let kind = route_kind(&provider);
    let requested = text(first(&[row.get("requested_model"), in_payload("requested_model")]));
    let pricing_model = Some(text(first(&[row.get("pricing_model"), in_payload("pricing_model")]))).filter(|m| !m.is_empty());
    let cache_read = field("cached_tokens", "cacheReadTokens");
    let cache_write = field("cache_write_tokens", "cacheWriteTokens");
    let (cached, written) = (amount(cache_read), amount(cache_write));
    let uncached = if raw {
        nullish(&[row.get("uncached_input_tokens"), in_payload("uncached_input_tokens")])
    } else {
        None
    };
    let uncached_input = match uncached {
        Some(uncached) => amount(Some(uncached)),
        None if inclusive(&provider) => (amount(input) - cached - written).max(0.0),
        None => amount(input),
    };
    let written_1h = if raw {
        in_payload("raw_usage")
            .and_then(|usage| usage.get("cache_creation"))
            .and_then(|creation| creation.get("ephemeral_1h_input_tokens"))
    } else {
        None
    };
    let written_1h = amount(written_1h).min(written);
    let service_tier = Some(text(first(&[row.get("service_tier"), in_payload("service_tier")]))).filter(|t| !t.is_empty());
    let priced = pricer.price(&PriceRequest {
        provider: provider.clone(),
        model: model.clone(),
        pricing_model,
        requested_model: Some(requested.clone()).filter(|m| !m.is_empty()),
        input_tokens_known: None,
        uncached_input_tokens: uncached_input,
        output_tokens: amount(output),
        cache_read_tokens: cached,
        cache_write_tokens: written,
        cache_write_1h_tokens: (written_1h > 0.0).then_some(written_1h),
        request_service_tier: None,
        service_tier,
        kind: kind.to_owned(),
        ts,
        historical: true,
    })?;
    let supplied = if raw { None } else { supplied_cost(row.get("costUsd")) };
    let subscription = kind == "oauth";
    let reported = supplied.is_some() && !subscription && kind != "local";
    let cost_usd = if kind == "local" {
        Some(0.0)
    } else if reported {
        supplied
    } else {
        priced.cost_usd
    };
    let cost_source = if kind == "local" {
        "local"
    } else if cost_usd.is_none() {
        "unpriced"
    } else if subscription {
        "subscription"
    } else if reported {
        "provider"
    } else {
        "catalog"
    };
    let rates = if reported || kind == "local" {
        Some(own_rates(priced.rates.as_deref(), &provider, kind))
    } else {
        priced.rates
    };
    let session = first(&[row.get("session_id"), row.get("sessionId")]);
    let session_id = match session {
        Some(Value::String(id)) if id == "no-session" || id == "(none)" => String::new(),
        other => text(other),
    };
    let source_type = text(first(&[
        row.get("sourceType"),
        row.get("source_type"),
        in_payload("sourceType"),
        in_payload("source_type"),
    ]));
    let response_id = text(first(&[row.get("response_id"), in_payload("response_id")]));
    let duration = first(&[row.get("duration_ms"), row.get("durationMs"), row.get("duration")]);
    let mut record = UsageRecord {
        id: String::new(),
        ts,
        day: day_key(ts),
        requested_model: if requested == model { String::new() } else { requested },
        provider,
        model,
        kind: kind.to_owned(),
        session_id,
        owner_session_id: None,
        source_type,
        input: uncached_input,
        output: num(mixdog_js::to_number_of(output)),
        cache_read: num(mixdog_js::to_number_of(cache_read)),
        cache_write: num(mixdog_js::to_number_of(cache_write)),
        cost_usd,
        cost_source: cost_source.to_owned(),
        rates,
        origin: if raw { "trace" } else { "gateway" }.to_owned(),
        duration_ms: num(mixdog_js::to_number_of(duration)),
        account: String::new(),
        requested_provider: String::new(),
        status: "completed".to_owned(),
        attempts: 1,
        ttft_ms: None,
        elapsed_ms: 0.0,
    };
    record.id = record_id(&record, &response_id);
    Ok(Some(record))
}

const COST_KEYS: [&str; 4] = ["costUsd", "costBilled", "costEstimated", "costKnownTurns"];

/// `repriceRestoredDays`: a day restored from a backup carries costs of the time it was written;
/// they are cleared and every route is priced again from its sums at today's catalog, as an
/// estimate (nothing is billed). Days that were not restored are kept as they are.
pub(super) fn reprice_restored_days(original: &Value, pricer: &dyn Pricer) -> Result<Value> {
    let mut days = original.clone();
    match &mut days {
        Value::Object(map) => {
            for day in map.values_mut() {
                reprice_day(day, pricer)?;
            }
        }
        Value::Array(list) => {
            for day in list.iter_mut() {
                reprice_day(day, pricer)?;
            }
        }
        _ => {}
    }
    Ok(days)
}

fn conversation_of(owner: &mut Map<String, Value>) -> Option<&mut Map<String, Value>> {
    owner.get_mut("conversation").filter(|c| truthy(c)).and_then(Value::as_object_mut)
}

fn reprice_day(day: &mut Value, pricer: &dyn Pricer) -> Result<()> {
    let Some(day) = day.as_object_mut() else {
        return Ok(());
    };
    if !day.get("restored").is_some_and(truthy) {
        return Ok(());
    }
    for key in COST_KEYS {
        day.insert(key.to_owned(), Value::from(0));
        if let Some(conversation) = conversation_of(day) {
            conversation.insert(key.to_owned(), Value::from(0));
        }
    }
    let Some(mut models) = day.get_mut("models").map(std::mem::take) else {
        return Ok(());
    };
    let routes: Vec<&mut Value> = match &mut models {
        Value::Object(map) => map.values_mut().collect(),
        Value::Array(list) => list.iter_mut().collect(),
        _ => Vec::new(),
    };
    let mut outcome = Ok(());
    for route in routes {
        if let Err(error) = reprice_route(route, day, pricer) {
            outcome = Err(error);
            break;
        }
    }
    day.insert("models".to_owned(), models);
    outcome
}

fn reprice_route(route: &mut Value, day: &mut Map<String, Value>, pricer: &dyn Pricer) -> Result<()> {
    let Some(route) = route.as_object_mut() else {
        return Ok(());
    };
    let named = |value: Option<&Value>| value.and_then(Value::as_str).unwrap_or_default().to_owned();
    let provider = named(route.get("provider"));
    let model = named(route.get("model"));
    if !route.get("kind").is_some_and(truthy) {
        route.insert("kind".to_owned(), json!(route_kind(&provider)));
    }
    let kind = named(route.get("kind"));
    price_bucket(route, day, (provider.as_str(), model.as_str(), kind.as_str()), pricer)?;
    if let (Some(bucket), Some(target)) = (conversation_of(route), conversation_of(day)) {
        price_bucket(bucket, target, (provider.as_str(), model.as_str(), kind.as_str()), pricer)?;
    }
    Ok(())
}

/// One bucket of sums priced again, its cost added to the `target` it belongs to.
fn price_bucket(
    bucket: &mut Map<String, Value>,
    target: &mut Map<String, Value>,
    (provider, model, kind): (&str, &str, &str),
    pricer: &dyn Pricer,
) -> Result<()> {
    let cost = if kind == "local" {
        Some(0.0)
    } else {
        pricer
            .price_aggregate(&PriceRequest {
                provider: provider.to_owned(),
                model: model.to_owned(),
                pricing_model: None,
                requested_model: None,
                input_tokens_known: None,
                uncached_input_tokens: amount(bucket.get("input")),
                output_tokens: amount(bucket.get("output")),
                cache_read_tokens: amount(bucket.get("cacheRead")),
                cache_write_tokens: amount(bucket.get("cacheWrite")),
                cache_write_1h_tokens: None,
                request_service_tier: None,
                service_tier: None,
                kind: kind.to_owned(),
                ts: 0,
                historical: true,
            })?
            .cost_usd
    };
    let cost_usd = cost.unwrap_or(0.0);
    let turns = mixdog_js::to_number_of(bucket.get("turns"));
    let known = if cost.is_none() || turns.is_nan() { 0.0 } else { turns };
    for (key, value) in [("costUsd", cost_usd), ("costBilled", 0.0), ("costEstimated", cost_usd), ("costKnownTurns", known)] {
        bucket.insert(key.to_owned(), mixdog_js::json_number(value));
    }
    for (key, value) in [("costUsd", cost_usd), ("costEstimated", cost_usd), ("costKnownTurns", known)] {
        let sum = mixdog_js::to_number_of(target.get(key)) + value;
        target.insert(key.to_owned(), mixdog_js::json_number(sum));
    }
    Ok(())
}
