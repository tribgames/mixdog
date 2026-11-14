//! The session's usage totals: Node's `stats` (`state.stats` of the session store), folded from the same `onUsageDelta`
//! event `thread/tokenUsage/updated` carries, so the figures are computed once. Three Node folds meet here:
//! `applyUsageDelta` (`ui/session-stats.mjs`: the running totals and the latest call), `foldUsageReadout`
//! (`runtime/shared/usage-readout-totals.mjs`: the cache and speed totals behind the composer readout) and
//! `contextMeasurementStats` (`runtime/shared/context-measurement.mjs`: the last measured prompt).

use serde_json::Map;
use serde_json::Value;
use serde_json::json;

/// `num(v)` of `ui/session-stats.mjs`: `Number(v)` when finite, else 0. A numeric string, a fraction and a
/// negative delta count as they do there.
fn num(usage: &Value, key: &str) -> f64 {
    let n = mixdog_js::to_number_of(usage.get(key));
    if n.is_finite() { n } else { 0.0 }
}

/// `num(v)` of `runtime/shared/usage-readout-totals.mjs`: the same, positive values only.
fn positive(usage: &Value, key: &str) -> f64 {
    num(usage, key).max(0.0)
}

/// A count as the JSON number `JSON.stringify` makes of it.
fn number(value: f64) -> Value {
    mixdog_js::json_number(value)
}

/// `foldUsageReadout`'s totals record.
#[derive(Clone, Debug, Default, PartialEq)]
struct Readout {
    input: f64,
    cache_read: f64,
    cache_write: f64,
    output: f64,
    request_output_tokens: f64,
    request_ms: f64,
}

/// What the last model call measured of the prompt (`sessionContextMeasurement`).
#[derive(Clone, Debug, Default, PartialEq)]
enum Measurement {
    /// No measurement yet, or one that no longer stands.
    #[default]
    Pending,
    /// The call reported no usage.
    Unavailable(i64),
    /// The prompt tokens of the last API request and when they were read.
    Known(f64, i64),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct SessionStats {
    input: f64,
    output: f64,
    cached: f64,
    cache_write: f64,
    prompt: f64,
    latest_input: f64,
    latest_output: f64,
    latest_cached: f64,
    latest_cache_write: f64,
    latest_prompt: f64,
    cost_usd: f64,
    measurement: Measurement,
    readout: Option<Readout>,
}

impl SessionStats {
    /// One model call's usage event (`usage_delta`).
    pub(crate) fn fold(&mut self, usage: &Value) {
        let (input, output) = (num(usage, "deltaInput"), num(usage, "deltaOutput"));
        let (cached, cache_write, prompt) = (num(usage, "deltaCachedRead"), num(usage, "deltaCacheWrite"), num(usage, "deltaPrompt"));
        self.input += input;
        self.output += output;
        self.cached += cached;
        self.cache_write += cache_write;
        self.prompt += prompt;
        self.latest_input = input;
        self.latest_output = output;
        self.latest_cached = cached;
        self.latest_cache_write = cache_write;
        self.latest_prompt = prompt;
        self.cost_usd += num(usage, "costUsd");
        let known = usage.get("promptKnown") != Some(&Value::Bool(false));
        let at = usage.get("ts").and_then(Value::as_i64).unwrap_or(0);
        let measured = positive(usage, "contextPromptTokens");
        self.measurement = if !known {
            Measurement::Unavailable(at)
        } else if measured > 0.0 {
            Measurement::Known(measured, at)
        } else {
            Measurement::Pending
        };
        let mut readout = self.readout.take().unwrap_or_default();
        if known {
            let (cached, cache_write) = (positive(usage, "deltaCachedRead"), positive(usage, "deltaCacheWrite"));
            let prompt = positive(usage, "deltaPrompt");
            let whole = if prompt > 0.0 { prompt } else { positive(usage, "deltaInput") + cached + cache_write };
            readout.input += (whole - cached - cache_write).max(0.0);
            readout.cache_read += cached;
            readout.cache_write += cache_write;
        }
        let output = positive(usage, "deltaOutput");
        readout.output += output;
        let request_ms = positive(usage, "requestMs");
        if request_ms > 0.0 && output > 0.0 {
            readout.request_output_tokens += output;
            readout.request_ms += request_ms;
        }
        self.readout = Some(readout);
    }

    /// The running input and output token totals (`stats.inputTokens`, `stats.outputTokens`).
    /// The spinner counts whole non-negative tokens, so a fraction or a net negative total reads as its floor or 0.
    pub(crate) fn tokens(&self) -> (u64, u64) {
        (self.input.max(0.0) as u64, self.output.max(0.0) as u64)
    }

    /// `state.stats` as the session publishes it, with the closed turns counted by the session (`stats.turns`).
    pub(crate) fn json(&self, turns: usize) -> Value {
        let mut stats = Map::new();
        for (key, value) in [
            ("inputTokens", self.input),
            ("outputTokens", self.output),
            ("cachedTokens", self.cached),
            ("cacheWriteTokens", self.cache_write),
            ("promptTokens", self.prompt),
            ("latestInputTokens", self.latest_input),
            ("latestOutputTokens", self.latest_output),
            ("latestCachedTokens", self.latest_cached),
            ("latestCacheWriteTokens", self.latest_cache_write),
            ("latestPromptTokens", self.latest_prompt),
        ] {
            stats.insert(key.into(), number(value));
        }
        stats.insert("costUsd".into(), number(self.cost_usd));
        stats.insert("turns".into(), json!(turns));
        let (tokens, source, at) = match self.measurement {
            Measurement::Known(tokens, at) => (number(tokens), "last_api_request", json!(at)),
            Measurement::Unavailable(at) => (Value::Null, "unavailable", json!(at)),
            Measurement::Pending => (Value::Null, "pending", Value::Null),
        };
        stats.insert("currentContextTokens".into(), tokens);
        stats.insert("currentEstimatedContextTokens".into(), json!(0));
        stats.insert("currentContextSource".into(), json!(source));
        stats.insert("currentContextUpdatedAt".into(), at);
        stats.insert(
            "usageReadout".into(),
            self.readout.as_ref().map_or(Value::Null, |readout| {
                json!({
                    "input": number(readout.input),
                    "cacheRead": number(readout.cache_read),
                    "cacheWrite": number(readout.cache_write),
                    "output": number(readout.output),
                    "requestOutputTokens": number(readout.request_output_tokens),
                    "requestMs": number(readout.request_ms),
                })
            }),
        );
        Value::Object(stats)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The totals of two calls equal what Node's recorded `read` scenario held after its two model calls
    /// (`real-turn-harness` `session-state.node.json`: stats).
    #[test]
    fn two_calls_fold_as_nodes_recorded_stats() {
        let call = json!({
            "deltaInput": 1200, "deltaOutput": 24, "deltaCachedRead": 0, "deltaCacheWrite": 0, "deltaPrompt": 1200,
            "promptKnown": true, "contextPromptTokens": 1200, "requestMs": 27, "ts": 5000,
        });
        let mut stats = SessionStats::default();
        stats.fold(&call);
        stats.fold(&call);
        assert_eq!(
            stats.json(1),
            json!({
                "inputTokens": 2400, "outputTokens": 48, "cachedTokens": 0, "cacheWriteTokens": 0, "promptTokens": 2400,
                "latestInputTokens": 1200, "latestOutputTokens": 24, "latestCachedTokens": 0, "latestCacheWriteTokens": 0,
                "latestPromptTokens": 1200, "costUsd": 0, "turns": 1,
                "currentContextTokens": 1200, "currentEstimatedContextTokens": 0, "currentContextSource": "last_api_request",
                "currentContextUpdatedAt": 5000,
                "usageReadout": { "input": 2400, "cacheRead": 0, "cacheWrite": 0, "output": 48, "requestOutputTokens": 48, "requestMs": 54 },
            })
        );
    }

    #[test]
    fn a_session_before_any_call_reads_pending_and_zero() {
        let stats = SessionStats::default().json(0);
        assert_eq!(stats["currentContextSource"], "pending");
        assert_eq!(stats["currentContextTokens"], Value::Null);
        assert_eq!(stats["usageReadout"], Value::Null);
        assert_eq!(stats["inputTokens"], 0);
    }

    /// `num()` is `Number(v)` with a finite check: a numeric string, a fraction and a negative delta are
    /// added; a non-numeric value, `NaN` and a non-finite cost count 0.
    #[test]
    fn deltas_count_as_nodes_num_does() {
        let mut stats = SessionStats::default();
        stats.fold(&json!({ "deltaInput": "12", "deltaOutput": 2.5, "deltaCachedRead": -3, "deltaPrompt": "x", "costUsd": "0.25" }));
        stats.fold(&json!({ "deltaInput": 8, "costUsd": "oops" }));
        let json = stats.json(2);
        assert_eq!((json["inputTokens"].clone(), json["outputTokens"].clone()), (json!(20), json!(2.5)));
        assert_eq!((json["cachedTokens"].clone(), json["promptTokens"].clone(), json["costUsd"].clone()), (json!(-3), json!(0), json!(0.25)));
        assert_eq!((json["latestInputTokens"].clone(), json["latestOutputTokens"].clone()), (json!(8), json!(0)));
    }
}
