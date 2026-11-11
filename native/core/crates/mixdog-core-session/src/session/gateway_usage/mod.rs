//! The gateway usage events of `<data>/gateway-usage.local.jsonl`: one per completed ask, recorded by
//! `recordStandaloneStatusTelemetry` (`session/manager/status-telemetry.mjs`) after the ask's usage
//! reached the session, and read by the statusline footer for route spend and local budgets.

mod event;
mod store;

#[cfg(test)]
mod asks_tests;

pub use store::GatewayUsage;
pub use store::LEGACY_FILE;
pub use store::STORE_FILE;
pub use store::Scheduler;
pub use store::TokioScheduler;

use mixdog_core_api::domain::provider::Usage;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

/// What `recordStandaloneStatusTelemetry(session, result, durationMs)` reads of a completed ask.
pub struct Ask<'a> {
    /// The session header: `id`, `provider`, `model`, `effort`, `fast`, `contextWindow`,
    /// `rawContextWindow`, `sourceType`, `sourceName`, `agent`, `providerCacheOpts`.
    pub header: &'a Map<String, Value>,
    /// `result.usage`.
    pub usage: &'a Usage,
    /// `result.model`.
    pub response_model: &'a str,
    /// `result.toolCallsTotal`.
    pub tool_calls_total: u64,
    /// `session.messages.length`.
    pub message_count: usize,
    /// `estimateTranscriptContextUsage(session.messages, session.tools, { provider })`.
    pub estimated_tokens: f64,
    /// The latest user message's `meta.effortConfiguration.effort` (`turnEffort`).
    pub turn_effort: Option<String>,
    /// `Date.now() - askStartedAt`.
    pub duration_ms: f64,
    /// `result.transportTiming`.
    pub transport_timing: Option<Value>,
}

/// `turnEffort(session)`: the effort the latest user message ran at (`meta.effortConfiguration.effort`),
/// over the messages' rows.
pub fn turn_effort<'a>(mut rows: impl DoubleEndedIterator<Item = &'a Map<String, Value>>) -> Option<String> {
    let user = rows.rfind(|row| row.get("role").and_then(Value::as_str) == Some("user"))?;
    let effort = user.get("meta")?.get("effortConfiguration")?.get("effort")?;
    effort.as_str().map(str::to_owned)
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `a || b || null`.
fn first_truthy(values: &[Option<&Value>]) -> Value {
    values.iter().find(|v| truthy(**v)).and_then(|v| v.cloned()).unwrap_or(Value::Null)
}

/// `result.usage` in the shape of Node's normalized usage.
fn usage_value(usage: &Usage) -> Value {
    let mut out = json!({
        "inputTokens": usage.input_tokens,
        "outputTokens": usage.output_tokens,
        "cachedTokens": usage.cache_read_tokens,
        "cacheWriteTokens": usage.cache_write_tokens,
        "cacheWrite1hTokens": usage.cache_write_1h_tokens,
    });
    if let Some(cost) = usage.cost {
        out["costUsd"] = mixdog_js::json_number(cost.0 as f64 / mixdog_core_api::domain::provider::UsdTicks::PER_USD as f64);
    }
    if let Some(raw) = &usage.raw {
        out["raw"] = raw.clone();
    }
    out
}

impl GatewayUsage {
    /// `recordStandaloneStatusTelemetry`: nothing is recorded for a session without a provider and a model.
    pub fn record_ask(&self, ask: &Ask<'_>) {
        let header = ask.header;
        let get = |key: &str| header.get(key);
        if !truthy(get("provider")) || !truthy(get("model")) {
            return;
        }
        let route = json!({
            "provider": get("provider"),
            "model": get("model"),
            // `session.effort || ''`
            "effort": if truthy(get("effort")) { first_truthy(&[get("effort")]) } else { Value::from("") },
            "fast": get("fast") == Some(&Value::Bool(true)),
            "contextWindow": first_truthy(&[get("contextWindow")]),
            "rawContextWindow": first_truthy(&[get("rawContextWindow"), get("contextWindow")]),
        });
        let provider_out = json!({ "usage": usage_value(ask.usage), "model": ask.response_model });
        let compact = json!({ "afterTokens": mixdog_js::json_number(ask.estimated_tokens) });
        let mut extra = Map::new();
        extra.insert("requestKind".into(), Value::from("chat"));
        let effort = ask.turn_effort.clone().map(Value::String).filter(|v| truthy(Some(v)));
        extra.insert("effort".into(), effort.unwrap_or_else(|| first_truthy(&[get("effort")])));
        extra.insert("sessionId".into(), first_truthy(&[get("id")]));
        extra.insert("sourceType".into(), if truthy(get("sourceType")) { first_truthy(&[get("sourceType")]) } else { Value::from("lead") });
        extra.insert("sourceName".into(), first_truthy(&[get("sourceName"), get("agent")]));
        extra.insert("toolCount".into(), json!(ask.tool_calls_total));
        extra.insert("messageCount".into(), json!(ask.message_count));
        extra.insert("cacheStrategy".into(), first_truthy(&[get("providerCacheOpts").and_then(|opts| opts.get("cacheStrategy"))]));
        extra.insert("transportTiming".into(), ask.transport_timing.clone().unwrap_or(Value::Null));
        self.record(&route, &provider_out, &compact, Some(ask.duration_ms), extra);
    }
}
