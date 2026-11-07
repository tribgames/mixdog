//! What an upstream answer reports as usage (`media-usage.mjs`): a normalized object
//! `{ inputTokens, outputTokens, cachedTokens, outputImageTokens, outputVideoTokens, costUsd,
//! images, seconds, resolution }` holding only what the provider reported. Nothing here estimates:
//! a field the provider did not report stays absent, and `None` is "nothing billable reported".

use mixdog_js::{json_number, to_number_of, value_to_string};
use serde_json::{Map, Value};

const TICKS_PER_USD: f64 = 1e10;

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `count(value)`: a positive finite number, truncated; else 0.
fn count(value: Option<&Value>) -> f64 {
    let number = to_number_of(value);
    if number.is_finite() && number > 0.0 { number.trunc() } else { 0.0 }
}

/// `pick(source, ...keys)`: the first of the keys the source holds with a value.
fn pick<'a>(source: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|key| source.get(*key).filter(|v| !v.is_null()))
}

/// `tokenUsage(fields)`: the fields above zero, in the order given; none at all is `None`.
fn token_usage(fields: &[(&str, f64)]) -> Option<Map<String, Value>> {
    let usage: Map<String, Value> = fields.iter().filter(|(_, value)| *value > 0.0).map(|(key, value)| ((*key).to_owned(), json_number(*value))).collect();
    (!usage.is_empty()).then_some(usage)
}

fn is_object(value: &Value) -> bool {
    value.is_object() || value.is_array()
}

fn entries(value: Option<&Value>) -> &[Value] {
    value.and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

/// `String(entry?.modality || '')`.
fn modality(entry: &Value) -> String {
    let value = entry.get("modality");
    if truthy(value) { value.map(value_to_string).unwrap_or_default() } else { String::new() }
}

/// Gemini `generateContent` / Antigravity `usageMetadata` (camelCase or snake_case).
pub fn gemini_usage(meta: &Value) -> Option<Value> {
    if !truthy(Some(meta)) || !is_object(meta) {
        return None;
    }
    let details = pick(meta, &["candidatesTokensDetails", "candidates_tokens_details"]);
    let image_tokens: f64 = entries(details).iter().filter(|entry| modality(entry).to_uppercase() == "IMAGE").map(|entry| count(pick(entry, &["tokenCount", "token_count"]))).sum();
    token_usage(&[
        ("inputTokens", count(pick(meta, &["promptTokenCount", "prompt_token_count"]))),
        ("cachedTokens", count(pick(meta, &["cachedContentTokenCount", "cached_content_token_count"]))),
        ("outputTokens", count(pick(meta, &["candidatesTokenCount", "candidates_token_count"])) + count(pick(meta, &["thoughtsTokenCount", "thoughts_token_count"]))),
        ("outputImageTokens", image_tokens),
    ])
    .map(Value::Object)
}

/// Gemini Interactions API `usage` (omni video).
pub fn interactions_usage(usage: &Value) -> Option<Value> {
    if !truthy(Some(usage)) || !is_object(usage) {
        return None;
    }
    let video_tokens: f64 = entries(usage.get("output_tokens_by_modality")).iter().filter(|entry| modality(entry).to_lowercase() == "video").map(|entry| count(entry.get("tokens"))).sum();
    token_usage(&[
        ("inputTokens", count(usage.get("total_input_tokens"))),
        ("cachedTokens", count(usage.get("total_cached_tokens"))),
        ("outputTokens", count(usage.get("total_output_tokens")) + count(usage.get("total_thought_tokens"))),
        ("outputVideoTokens", video_tokens),
    ])
    .map(Value::Object)
}

/// OpenAI / Codex Responses `usage` from `response.completed`.
pub fn responses_usage(usage: &Value) -> Option<Value> {
    if !truthy(Some(usage)) || !is_object(usage) {
        return None;
    }
    token_usage(&[
        ("inputTokens", count(usage.get("input_tokens"))),
        ("cachedTokens", count(usage.get("input_tokens_details").and_then(|d| d.get("cached_tokens")))),
        ("outputTokens", count(usage.get("output_tokens"))),
    ])
    .map(Value::Object)
}

/// xAI image/video `usage.cost_in_usd_ticks` (1 USD = 1e10 ticks): the billed cost.
pub fn xai_usage(usage: &Value) -> Option<Value> {
    let ticks = usage.get("cost_in_usd_ticks").and_then(Value::as_f64).filter(|t| t.is_finite() && *t >= 0.0)?;
    let mut out = Map::new();
    out.insert("costUsd".to_owned(), json_number(ticks / TICKS_PER_USD));
    Some(Value::Object(out))
}

fn reported_cost(value: Option<&Value>) -> Option<&Value> {
    value.filter(|v| v.as_f64().is_some_and(|n| n.is_finite() && n >= 0.0))
}

/// Image API response usage (OpenRouter / NanoGPT `POST /images`). `usage.cost` is USD; NanoGPT's
/// top-level `cost` counts only when `paymentSource` says USD (it may be billed in XNO).
pub fn image_api_usage(body: &Value) -> Option<Value> {
    let none = Value::Null;
    let usage = body.get("usage").filter(|u| truthy(Some(u)) && is_object(u)).unwrap_or(&none);
    let tokens = token_usage(&[
        ("inputTokens", count(usage.get("prompt_tokens"))),
        ("outputTokens", count(usage.get("completion_tokens"))),
        ("outputImageTokens", count(usage.get("completion_tokens_details").and_then(|d| d.get("image_tokens")))),
    ]);
    let source = body.get("paymentSource");
    let paid_in_usd = if truthy(source) { source.map(value_to_string).unwrap_or_default().to_uppercase() == "USD" } else { false };
    let usd = if paid_in_usd { body.get("cost") } else { None };
    let cost = reported_cost(usage.get("cost")).or_else(|| reported_cost(usd));
    match cost {
        None => tokens.map(Value::Object),
        Some(cost) => {
            let mut out = tokens.unwrap_or_default();
            out.insert("costUsd".to_owned(), cost.clone());
            Some(Value::Object(out))
        }
    }
}

/// True when the provider reported something billable for the request. Seconds are only attached
/// once a video generation completed (billed per second).
pub fn has_reported_usage(usage: &Value) -> bool {
    if !truthy(Some(usage)) {
        return false;
    }
    usage.get("costUsd").is_some_and(Value::is_number) || ["inputTokens", "outputTokens", "cachedTokens", "seconds"].iter().any(|key| to_number_of(usage.get(*key)) > 0.0)
}

/// `withReportedUsage(error, usage)`: the usage worth attaching to a failure, so the ledger still
/// records what a failed request cost.
pub fn reported_usage(usage: Option<Value>) -> Option<Value> {
    usage.filter(has_reported_usage)
}
