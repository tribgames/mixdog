//! The session's usage totals: Node's `stats` (`state.stats` of the session store), folded from the same `onUsageDelta`
//! event `thread/tokenUsage/updated` carries, so the figures are computed once. Three Node folds meet here:
//! `applyUsageDelta` (`ui/session-stats.mjs`: the running totals and the latest call), `foldUsageReadout`
//! (`runtime/shared/usage-readout-totals.mjs`: the cache and speed totals behind the composer readout) and
//! `contextMeasurementStats` (`runtime/shared/context-measurement.mjs`: the last measured prompt).

use serde_json::Map;
use serde_json::Value;
use serde_json::json;

/// A token count of the event: a non-negative integer, else 0.
fn count(usage: &Value, key: &str) -> u64 {
    usage.get(key).and_then(Value::as_u64).unwrap_or(0)
}

/// `foldUsageReadout`'s totals record.
#[derive(Clone, Debug, Default, PartialEq)]
struct Readout {
    input: u64,
    cache_read: u64,
    cache_write: u64,
    output: u64,
    request_output_tokens: u64,
    request_ms: u64,
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
    Known(u64, i64),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct SessionStats {
    input: u64,
    output: u64,
    cached: u64,
    cache_write: u64,
    prompt: u64,
    latest_input: u64,
    latest_output: u64,
    latest_cached: u64,
    latest_cache_write: u64,
    latest_prompt: u64,
    cost_usd: f64,
    measurement: Measurement,
    readout: Option<Readout>,
}

impl SessionStats {
    /// One model call's usage event (`usage_delta`).
    pub(crate) fn fold(&mut self, usage: &Value) {
        let (input, output) = (count(usage, "deltaInput"), count(usage, "deltaOutput"));
        let (cached, cache_write, prompt) = (count(usage, "deltaCachedRead"), count(usage, "deltaCacheWrite"), count(usage, "deltaPrompt"));
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
        self.cost_usd += usage.get("costUsd").and_then(Value::as_f64).filter(|cost| cost.is_finite()).unwrap_or(0.0);
        let known = usage.get("promptKnown") != Some(&Value::Bool(false));
        let at = usage.get("ts").and_then(Value::as_i64).unwrap_or(0);
        let measured = count(usage, "contextPromptTokens");
        self.measurement = if !known {
            Measurement::Unavailable(at)
        } else if measured > 0 {
            Measurement::Known(measured, at)
        } else {
            Measurement::Pending
        };
        let mut readout = self.readout.take().unwrap_or_default();
        if known {
            let whole = if prompt > 0 { prompt } else { input + cached + cache_write };
            readout.input += whole.saturating_sub(cached + cache_write);
            readout.cache_read += cached;
            readout.cache_write += cache_write;
        }
        readout.output += output;
        let request_ms = count(usage, "requestMs");
        if request_ms > 0 && output > 0 {
            readout.request_output_tokens += output;
            readout.request_ms += request_ms;
        }
        self.readout = Some(readout);
    }

    /// The running input and output token totals (`stats.inputTokens`, `stats.outputTokens`).
    pub(crate) fn tokens(&self) -> (u64, u64) {
        (self.input, self.output)
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
            stats.insert(key.into(), json!(value));
        }
        stats.insert("costUsd".into(), if self.cost_usd.fract() == 0.0 { json!(self.cost_usd as i64) } else { json!(self.cost_usd) });
        stats.insert("turns".into(), json!(turns));
        let (tokens, source, at) = match self.measurement {
            Measurement::Known(tokens, at) => (json!(tokens), "last_api_request", json!(at)),
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
                    "input": readout.input,
                    "cacheRead": readout.cache_read,
                    "cacheWrite": readout.cache_write,
                    "output": readout.output,
                    "requestOutputTokens": readout.request_output_tokens,
                    "requestMs": readout.request_ms,
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
}
