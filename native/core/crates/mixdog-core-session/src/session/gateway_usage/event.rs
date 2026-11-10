//! The gateway usage event of one provider request, as the statusline's `route-meta.mjs` builds it:
//! `summarizeGatewayUsage` (the summary of a request), then `recordGatewayUsageEvent` (the stored
//! shape, with `compactTelemetry` and `compactTransportTiming`). Both work on JSON values with the
//! JavaScript coercions of the original, so the same inputs give the same bytes.

use mixdog_ai::catalog::UsageArgs;
use mixdog_ai::registry::accounting::UsagePricing;
use mixdog_js::js_trim;
use mixdog_js::json_number;
use mixdog_js::math;
use mixdog_js::slice_utf16;
use mixdog_js::to_number;
use mixdog_js::to_number_of;
use mixdog_js::value_to_string;
use serde_json::Map;
use serde_json::Value;

/// The route section of the process (`routeSectionKey`, `routeSectionStartedAt`): when the route
/// identity last changed.
#[derive(Default)]
pub struct RouteSection {
    key: Option<String>,
    started_at: i64,
}

/// JavaScript truthiness of a present value.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

fn get<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key)
}

/// `value || null`.
fn or_null(value: Option<&Value>) -> Value {
    if truthy(value) { value.cloned().unwrap_or(Value::Null) } else { Value::Null }
}

fn finite(n: f64) -> Option<f64> {
    n.is_finite().then_some(n)
}

/// `num(value, fallback)`.
fn num(value: Option<&Value>, fallback: f64) -> f64 {
    match value {
        None | Some(Value::Null) => fallback,
        Some(Value::String(text)) if text.is_empty() => fallback,
        Some(value) => finite(to_number(value)).unwrap_or(fallback),
    }
}

/// `num(value, null)`.
fn num_or_null(value: Option<&Value>) -> Value {
    match value {
        None | Some(Value::Null) => Value::Null,
        Some(Value::String(text)) if text.is_empty() => Value::Null,
        Some(value) => finite(to_number(value)).map_or(Value::Null, json_number),
    }
}

/// `round(value, digits)`: `None` is Node's `null`.
fn round(value: f64, digits: i32) -> Option<f64> {
    finite(value).map(|n| {
        let scale = 10f64.powi(digits);
        math::round(n * scale) / scale
    })
}

/// `cleanString(value)`.
fn clean_string(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) => Some(js_trim(text).to_owned()).filter(|text| !text.is_empty()),
        _ => None,
    }
}

fn text_or_null(text: Option<String>) -> Value {
    text.map_or(Value::Null, Value::String)
}

/// `providerKind(provider)`.
fn provider_kind(provider: Option<&Value>) -> &'static str {
    let name = if truthy(provider) { mixdog_js::js_to_lowercase(&value_to_string(provider.unwrap_or(&Value::Null))) } else { String::new() };
    if name.is_empty() {
        "unknown"
    } else if name.contains("oauth") {
        "oauth"
    } else if name == "mixdog-local" {
        "local"
    } else {
        "api"
    }
}

/// `x?.providerKind || providerKind(x?.provider)`.
fn kind_of(holder: &Value) -> Value {
    if truthy(get(holder, "providerKind")) { holder["providerKind"].clone() } else { Value::from(provider_kind(get(holder, "provider"))) }
}

/// `isInclusiveProvider(provider)`.
fn is_inclusive(provider: Option<&Value>) -> bool {
    if !truthy(provider) {
        return false;
    }
    let name = mixdog_js::js_to_lowercase(&value_to_string(provider.unwrap_or(&Value::Null)));
    name != "anthropic" && name != "anthropic-oauth"
}

/// `routeIdentityKey(routeInfo)`.
fn route_identity_key(route: &Value) -> String {
    let part = |key: &str| if truthy(get(route, key)) { value_to_string(&route[key]) } else { String::new() };
    let fast = if get(route, "fast") == Some(&Value::Bool(true)) { "fast" } else { "" };
    [part("provider"), part("model"), part("effort"), fast.to_owned()].join("\u{1}")
}

/// `ensureRouteSection(routeInfo)`: the identity key and when its section began. A key made only of
/// separators is `trim`med to nothing in Node too, but `\u{1}` is not white space, so it never is.
fn ensure_route_section(section: &mut RouteSection, route: &Value, now: i64) -> i64 {
    let key = route_identity_key(route);
    if section.key.as_deref() != Some(&key) {
        section.key = Some(key);
        section.started_at = now;
    }
    section.started_at
}

/// `compactBoundaryDenominator(routeInfo, compact)`.
fn compact_boundary_denominator(route: &Value, compact: &Value) -> f64 {
    fn first<'a>(a: Option<&'a Value>, b: Option<&'a Value>, c: Option<&'a Value>) -> Option<&'a Value> {
        [a, b, c].into_iter().find(|v| !matches!(v, None | Some(Value::Null))).flatten()
    }
    let from_route = num(first(get(route, "compactBoundaryTokens"), get(route, "compact_boundary_tokens"), get(route, "boundaryTokens")), 0.0);
    let from_compact = num(first(get(compact, "boundaryTokens"), get(compact, "compactBoundaryTokens"), get(compact, "compact_boundary_tokens")), 0.0);
    let boundary = if from_route > 0.0 { from_route } else { from_compact };
    let window = |key: &str| first(get(route, key), get(compact, key), None);
    let context_window = num(window("contextWindow"), 0.0);
    let budget_window = num(get(compact, "budgetWindow"), 0.0);
    let raw_context_window = num(window("rawContextWindow"), 0.0);
    if boundary > 0.0 {
        boundary
    } else if context_window > 0.0 {
        context_window
    } else if budget_window > 0.0 {
        budget_window
    } else if raw_context_window > 0.0 {
        raw_context_window
    } else {
        0.0
    }
}

fn nullish<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    if matches!(a, None | Some(Value::Null)) { b } else { a }
}

/// `promptFootprintTokens(provider, usage)`.
fn prompt_footprint(provider: Option<&Value>, usage: &Value) -> f64 {
    let input = num(get(usage, "inputTokens"), 0.0);
    let cache_read = num(nullish(get(usage, "cachedTokens"), get(usage, "cacheReadTokens")), 0.0);
    let cache_write = num(get(usage, "cacheWriteTokens"), 0.0);
    let prompt = num(get(usage, "promptTokens"), 0.0);
    if prompt > 0.0 {
        prompt
    } else if is_inclusive(provider) {
        input
    } else {
        input + cache_read + cache_write
    }
}

/// `usageCostUsd(routeInfo, providerOut)`.
fn usage_cost_usd(route: &Value, provider_out: &Value, usage: &Value, pricing: &dyn UsagePricing) -> f64 {
    let provider_cost = to_number_of(get(usage, "costUsd"));
    if provider_cost.is_finite() {
        return round(provider_cost, 6).unwrap_or(0.0);
    }
    let tokens = |value: Option<&Value>| num(value, 0.0);
    let tier = clean_string(get(provider_out, "serviceTier")).or_else(|| clean_string(get(usage, "raw").and_then(|raw| raw.get("service_tier"))));
    let kind = value_to_string(&kind_of(route));
    let text = |key: &str| get(route, key).filter(|v| truthy(Some(v))).map(value_to_string).unwrap_or_default();
    let args = UsageArgs {
        provider: text("provider"),
        model: text("model"),
        pricing_model: get(provider_out, "pricingModel").filter(|v| truthy(Some(v))).map(value_to_string),
        kind: Some(kind),
        request_service_tier: get(provider_out, "requestServiceTier").filter(|v| truthy(Some(v))).map(value_to_string),
        service_tier: tier,
        input_tokens: tokens(get(usage, "inputTokens")),
        output_tokens: tokens(get(usage, "outputTokens")),
        cache_read_tokens: tokens(nullish(get(usage, "cachedTokens"), get(usage, "cacheReadTokens"))),
        cache_write_tokens: tokens(get(usage, "cacheWriteTokens")),
        cache_write_1h_tokens: tokens(get(usage, "cacheWrite1hTokens")),
        ..UsageArgs::default()
    };
    pricing.price_usage(&args).cost_usd.unwrap_or(0.0)
}

/// `Object.keys(raw).sort()` of an object `raw`.
fn raw_usage_keys(raw: Option<&Value>) -> Vec<Value> {
    let mut keys: Vec<String> = match raw {
        Some(Value::Object(map)) => mixdog_js::js_object_keys(map).into_iter().cloned().collect(),
        Some(Value::Array(items)) => (0..items.len()).map(|i| i.to_string()).collect(),
        _ => Vec::new(),
    };
    keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    keys.into_iter().map(Value::String).collect()
}

/// `summarizeGatewayUsage(routeInfo, providerOut, compact, durationMs)` at `now`.
pub fn summarize(section: &mut RouteSection, pricing: &dyn UsagePricing, route: &Value, provider_out: &Value, compact: &Value, duration_ms: Option<f64>, now: i64) -> Map<String, Value> {
    let empty = Value::Object(Map::new());
    let usage = get(provider_out, "usage").filter(|u| truthy(Some(u))).unwrap_or(&empty);
    let started_at = ensure_route_section(section, route, now);
    let provider = get(route, "provider");
    let prompt_tokens = prompt_footprint(provider, usage);
    let boundary = compact_boundary_denominator(route, compact);
    let after = num(get(compact, "afterTokens"), 0.0);
    let estimate = if after != 0.0 { after } else { num(get(compact, "beforeTokens"), 0.0) };
    let context_used_pct = if boundary > 0.0 {
        if estimate > 0.0 { round(estimate * 100.0 / boundary, 2) } else { round(prompt_tokens * 100.0 / boundary, 2).map(|pct| pct.min(100.0)) }
    } else {
        None
    };
    let cost = usage_cost_usd(route, provider_out, usage, pricing);
    let provider_cost = to_number_of(get(usage, "costUsd")).is_finite();
    let mut out = Map::new();
    let mut put = |key: &str, value: Value| {
        out.insert(key.into(), value);
    };
    put("at", json_number(now as f64));
    put("provider", get(route, "provider").cloned().unwrap_or(Value::Null));
    put("model", get(route, "model").cloned().unwrap_or(Value::Null));
    put("providerKind", kind_of(route));
    put("routeKey", Value::from(route_identity_key(route)));
    put("routeSectionStartedAt", json_number(started_at as f64));
    put("responseModel", clean_string(get(provider_out, "model")).map(Value::String).unwrap_or_else(|| or_null(get(route, "model"))));
    put("serviceTier", text_or_null(clean_string(get(provider_out, "serviceTier")).or_else(|| clean_string(get(usage, "raw").and_then(|raw| raw.get("service_tier"))))));
    put("inputTokens", json_number(num(get(usage, "inputTokens"), 0.0)));
    put("outputTokens", json_number(num(get(usage, "outputTokens"), 0.0)));
    put("cacheReadTokens", json_number(num(nullish(get(usage, "cachedTokens"), get(usage, "cacheReadTokens")), 0.0)));
    put("cacheWriteTokens", json_number(num(get(usage, "cacheWriteTokens"), 0.0)));
    put("promptTokens", json_number(prompt_tokens));
    put("costUsd", json_number(cost));
    put("costSource", Value::from(if provider_cost { "provider" } else if cost > 0.0 { "catalog" } else { "none" }));
    put("contextUsedPct", context_used_pct.map_or(Value::Null, json_number));
    put("compact", compact_copy(compact));
    put("durationMs", duration_ms.and_then(finite).map_or(Value::Null, |ms| json_number(math::max(0.0, math::round(ms)))));
    put("rawUsageKeys", Value::Array(raw_usage_keys(get(usage, "raw"))));
    out
}

/// `compact && typeof compact === 'object' ? { ...compact } : compact`.
fn compact_copy(compact: &Value) -> Value {
    compact.clone()
}

/// `compactTelemetry(compact)`.
fn compact_telemetry(compact: Option<&Value>) -> Option<Value> {
    let compact = compact.filter(|c| matches!(c, Value::Object(_) | Value::Array(_)))?;
    let mut out = Map::new();
    for key in ["contextWindow", "compactLimitTokens", "budgetWindow", "beforeTokens", "afterTokens", "reserveTokens"] {
        out.insert(key.into(), num_or_null(get(compact, key)));
    }
    out.insert("method".into(), text_or_null(clean_string(get(compact, "method"))));
    out.insert("compacted".into(), Value::Bool(get(compact, "compacted") == Some(&Value::Bool(true))));
    for key in ["error", "compactError"] {
        if truthy(get(compact, key)) {
            out.insert(key.into(), Value::String(slice_utf16(&value_to_string(&compact[key]), 240)));
        }
    }
    Some(Value::Object(out))
}

/// `compactTransportTiming(timing)`.
fn compact_transport_timing(timing: Option<&Value>) -> Option<Value> {
    let timing = timing.filter(|t| matches!(t, Value::Object(_) | Value::Array(_)))?;
    let count = |key: &str| finite(to_number_of(get(timing, key))).map_or(Value::Null, |n| json_number(math::max(0.0, math::round(n))));
    let text = |key: &str| text_or_null(clean_string(get(timing, key)));
    let mut out = Map::new();
    out.insert("transport".into(), text("transport"));
    out.insert("outcome".into(), text("outcome"));
    for key in ["admissionQueueWaitMs", "providerConcurrentRequests", "providerQueuedRequests", "poolOwnerWaitMs", "socketAcquireMs", "poolAcquireMs", "requestBuildSerializationMs", "preResponseCreatedMs", "providerFirstEventMs", "retryBackoffMs", "handshakeRetries", "acquireAttempts"] {
        out.insert(key.into(), count(key));
    }
    out.insert("acquireMode".into(), text("acquireMode"));
    Some(Value::Object(out))
}

/// `Number.isFinite(Number(x)) ? Math.max(0, Math.round(x)) : null`.
fn count_or_null(value: Option<&Value>) -> Value {
    finite(to_number_of(value)).map_or(Value::Null, |n| json_number(math::max(0.0, math::round(n))))
}

/// `recordGatewayUsageEvent(summary)`'s event, at `now`.
pub fn event_of(summary: &Value, now: i64) -> Value {
    let text = |key: &str| text_or_null(clean_string(get(summary, key)));
    let tokens = |key: &str| json_number(num(get(summary, key), 0.0));
    let cache_strategy = match get(summary, "cacheStrategy") {
        Some(strategy @ (Value::Object(_) | Value::Array(_))) => {
            let entries: Vec<(String, Value)> = match strategy {
                Value::Object(map) => map.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
                Value::Array(items) => items.iter().enumerate().map(|(i, v)| (i.to_string(), v.clone())).collect(),
                _ => Vec::new(),
            };
            let mut kept = Map::new();
            for (key, value) in entries {
                if let (Some(key), Some(value)) = (clean_string(Some(&Value::String(key))), clean_string(Some(&value))) {
                    kept.insert(key, Value::String(value));
                }
                if kept.len() == 8 {
                    break;
                }
            }
            Value::Object(kept)
        }
        _ => Value::Null,
    };
    let raw_keys: Vec<Value> = match get(summary, "rawUsageKeys") {
        Some(Value::Array(keys)) => keys.iter().filter_map(|k| clean_string(Some(k))).take(40).map(Value::String).collect(),
        _ => Vec::new(),
    };
    let started_at = num(get(summary, "routeSectionStartedAt"), 0.0);
    let cost = round(if truthy(get(summary, "costUsd")) { to_number_of(get(summary, "costUsd")) } else { 0.0 }, 6).filter(|c| *c != 0.0).unwrap_or(0.0);
    let pct = to_number_of(get(summary, "contextUsedPct"));
    let mut event = Map::new();
    let mut put = |key: &str, value: Value| {
        event.insert(key.into(), value);
    };
    put("ts", if truthy(get(summary, "at")) { summary["at"].clone() } else { json_number(now as f64) });
    put("provider", or_null(get(summary, "provider")));
    put("model", or_null(get(summary, "model")));
    put("providerKind", kind_of(summary));
    put("routeKey", or_null(get(summary, "routeKey")));
    put("routeSectionStartedAt", if started_at != 0.0 { json_number(started_at) } else { Value::Null });
    put("responseModel", text("responseModel"));
    put("serviceTier", text("serviceTier"));
    put("inputTokens", tokens("inputTokens"));
    put("outputTokens", tokens("outputTokens"));
    put("cacheReadTokens", tokens("cacheReadTokens"));
    put("cacheWriteTokens", tokens("cacheWriteTokens"));
    put("promptTokens", tokens("promptTokens"));
    put("costUsd", json_number(cost));
    put("costSource", text("costSource"));
    put("contextUsedPct", if pct.is_finite() { round(to_number_of(get(summary, "contextUsedPct")), 2).map_or(Value::Null, json_number) } else { Value::Null });
    put("durationMs", count_or_null(get(summary, "durationMs")));
    put("requestKind", text("requestKind"));
    put("effort", text("effort"));
    put("sessionId", text("sessionId"));
    put("sourceType", text("sourceType"));
    put("sourceName", text("sourceName"));
    put("toolCount", count_or_null(get(summary, "toolCount")));
    put("systemCount", count_or_null(get(summary, "systemCount")));
    put("messageCount", count_or_null(get(summary, "messageCount")));
    put("chatMessageCount", count_or_null(get(summary, "chatMessageCount")));
    put("cacheStrategy", cache_strategy);
    put("rawUsageKeys", Value::Array(raw_keys));
    if let Some(compact) = compact_telemetry(get(summary, "compact")) {
        event.insert("compact".into(), compact);
    }
    if let Some(timing) = compact_transport_timing(get(summary, "transportTiming")) {
        event.insert("transportTiming".into(), timing);
    }
    Value::Object(event)
}
