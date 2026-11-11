//! The warm's SSE stream (`providers/anthropic-cache-warm.mjs` `readCacheWarmStream`): read until
//! the usage is known and the first content block starts (the prefix was read and the cache
//! refreshed before any content), or until the message ends. Usage reaches `on_usage` as it
//! arrives, so a warm that fails after the provider accepted it is still accounted.

use mixdog_core_api::domain::provider::{ProviderError, TransportFault};
use serde_json::Value;

use crate::providers::anthropic::errors::classify_stream_error;
use crate::transport::link::BodyStream;

pub use mixdog_core_api::domain::cache_warm::{WarmFailure, WarmUsage};

fn reported_cost(value: &Value) -> Option<f64> {
    if value.is_null() || value.as_str().is_some_and(|s| mixdog_js::js_trim(s).is_empty()) {
        return None;
    }
    let n = mixdog_js::to_number(value);
    (n.is_finite() && n >= 0.0).then_some(n)
}

/// `updateTurnUsage(usage, raw)`: an omitted field keeps the earlier report, an explicit zero
/// replaces it.
fn update_usage(usage: &mut WarmUsage, raw: &Value) {
    let present = |value: Option<&Value>| value.filter(|v| !v.is_null()).map(mixdog_js::to_number);
    if let Some(v) = present(raw.get("input_tokens")) {
        usage.input = v;
    }
    if let Some(v) = present(raw.get("output_tokens")) {
        usage.output = v;
    }
    if let Some(v) = present(raw.get("cache_read_input_tokens")) {
        usage.cached = v;
    }
    if let Some(v) = present(raw.get("cache_creation_input_tokens")) {
        usage.cache_write = v;
    }
    if let Some(v) = present(raw.get("cache_creation").and_then(|c| c.get("ephemeral_1h_input_tokens"))) {
        usage.cache_write_1h = Some(v);
    }
    if let Some(cost) = raw.get("cost").and_then(reported_cost) {
        usage.cost_usd = Some(cost);
    }
    usage.prompt_tokens = Some(usage.input + usage.cached + usage.cache_write);
}

/// `TextDecoder` in stream mode: a character split across chunks is held until it completes.
#[derive(Default)]
struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(text) => {
                    out.push_str(text);
                    self.pending.clear();
                    return out;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    out.push_str(&String::from_utf8_lossy(&self.pending[..valid]));
                    match error.error_len() {
                        Some(bad) => {
                            out.push('\u{fffd}');
                            self.pending.drain(..valid + bad);
                        }
                        None => {
                            self.pending.drain(..valid);
                            return out;
                        }
                    }
                }
            }
        }
    }
}

/// JavaScript truthiness of a parsed value.
fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        _ => true,
    }
}

/// `_anthropicSseError(event, { display: 'Anthropic cache warm' })`'s text.
fn sse_error_text(event: &Value) -> String {
    let payload = event.get("error").filter(|e| e.is_object() || e.is_array()).unwrap_or(event);
    let truthy = |value: Option<&'_ Value>| -> Option<Value> { value.filter(|v| js_truthy(v)).cloned() };
    let kind = truthy(payload.get("type")).or_else(|| truthy(event.get("type"))).map_or_else(|| "error".to_owned(), |v| mixdog_js::value_to_string(&v));
    let message = truthy(payload.get("message")).map_or_else(|| "Anthropic SSE error".to_owned(), |v| mixdog_js::value_to_string(&v));
    format!("Anthropic cache warm SSE error {kind}: {message}")
}

/// How a read ended badly: the text and the classified error of an SSE error event.
type Ended = (String, Option<ProviderError>);

/// _anthropicSseError: the event's wire status and type, worded for the warm.
fn sse_error(event: &Value) -> Ended {
    let message = sse_error_text(event);
    let mut error = classify_stream_error(event);
    error.message.clone_from(&message);
    (message, Some(error))
}

/// Reads a warm's response body. `on_chunk` hears every chunk that did not end the read (the idle
/// watchdog); a failure carries `usage` as reported before it (`None` when none was).
pub async fn read_cache_warm_stream(
    body: &mut dyn BodyStream,
    on_usage: &mut (dyn FnMut(&WarmUsage) + Send),
    on_chunk: &mut (dyn FnMut(bool) + Send),
) -> Result<WarmUsage, WarmFailure> {
    let mut usage = WarmUsage::default();
    let mut reported = false;
    match read_frames(body, &mut usage, &mut reported, on_usage, on_chunk).await {
        Ok(()) => Ok(usage),
        Err((message, error)) => Err(WarmFailure { message, error, usage: reported.then_some(usage) }),
    }
}

async fn read_frames(
    body: &mut dyn BodyStream,
    usage: &mut WarmUsage,
    reported: &mut bool,
    on_usage: &mut (dyn FnMut(&WarmUsage) + Send),
    on_chunk: &mut (dyn FnMut(bool) + Send),
) -> Result<(), Ended> {
    let mut decoder = Utf8Stream::default();
    let mut buffer = String::new();
    let mut report = |raw: Option<&Value>, usage: &mut WarmUsage, reported: &mut bool| {
        let Some(raw) = raw.filter(|r| r.is_object() || r.is_array()) else { return };
        update_usage(usage, raw);
        *reported = true;
        on_usage(usage);
    };
    loop {
        let chunk = match body.next().await {
            None => return Ok(()),
            Some(Ok(bytes)) => bytes,
            Some(Err(fault)) => return Err((fault_text(&fault), None)),
        };
        buffer.push_str(&decoder.push(&chunk));
        while let Some(cut) = buffer.find("\n\n") {
            let frame: String = buffer.drain(..cut + 2).collect();
            let data = frame[..cut]
                .split('\n')
                .filter_map(|line| line.strip_prefix("data:").map(mixdog_js::js_trim_start))
                .collect::<Vec<_>>()
                .join("\n");
            if data.is_empty() {
                continue;
            }
            let Ok(event) = serde_json::from_str::<Value>(&data) else { continue };
            if event.is_null() {
                return Err(("Cannot read properties of null (reading 'type')".to_owned(), None));
            }
            let errored = event.get("type").and_then(Value::as_str) == Some("error")
                || event.get("error").is_some_and(js_truthy);
            if errored {
                return Err(sse_error(&event));
            }
            match event.get("type").and_then(Value::as_str) {
                Some("message_start") => report(event.get("message").and_then(|m| m.get("usage")), usage, reported),
                Some("message_delta") => report(event.get("usage"), usage, reported),
                // The prefix was read (and the cache refreshed) before any content.
                Some("content_block_start") if *reported => return Ok(()),
                Some("message_stop") => return Ok(()),
                _ => {}
            }
        }
        on_chunk(*reported);
    }
}

fn fault_text(fault: &TransportFault) -> String {
    format!("stream failed: {fault:?}")
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use async_trait::async_trait;
    use bytes::Bytes;
    use serde_json::{Map, json};

    use super::*;

    struct Chunks(VecDeque<Bytes>);

    #[async_trait]
    impl BodyStream for Chunks {
        async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
            self.0.pop_front().map(Ok)
        }
    }

    /// The fields Node's snapshot carries, by its names.
    fn usage_json(usage: &WarmUsage) -> Value {
        let mut map = Map::new();
        let mut put = |key: &str, value: f64| {
            map.insert(key.to_owned(), if value.fract() == 0.0 { json!(value as i64) } else { json!(value) });
        };
        put("inputTokens", usage.input);
        put("outputTokens", usage.output);
        put("cachedTokens", usage.cached);
        put("cacheWriteTokens", usage.cache_write);
        if let Some(v) = usage.cache_write_1h {
            put("cacheWrite1hTokens", v);
        }
        if let Some(v) = usage.cost_usd {
            put("costUsd", v);
        }
        if let Some(v) = usage.prompt_tokens {
            put("promptTokens", v);
        }
        Value::Object(map)
    }

    #[tokio::test]
    async fn every_recorded_stream_reads_as_nodes_does() {
        let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/cache-warm/golden.json")).unwrap();
        let rows = golden["stream"].as_array().unwrap();
        assert_eq!(rows.len(), 10);
        for row in rows {
            let mut body = Chunks(row["chunks"].as_array().unwrap().iter().map(|c| Bytes::from(c.as_str().unwrap().to_owned())).collect());
            let mut reports = Vec::new();
            let got = read_cache_warm_stream(&mut body, &mut |u| reports.push(usage_json(u)), &mut |_| {}).await;
            let name = &row["name"];
            let want_reports: Vec<Value> = row["reports"].as_array().unwrap().to_vec();
            assert_eq!(reports, want_reports, "{name}: reports");
            match (got, row.get("error")) {
                (Ok(usage), None) => assert_eq!(usage_json(&usage), row["usage"], "{name}"),
                (Err(failure), Some(error)) => {
                    assert_eq!(failure.message, error["message"].as_str().unwrap(), "{name}");
                    assert_eq!(failure.usage.as_ref().map_or(Value::Null, usage_json), error["usage"], "{name}: usage before the error");
                }
                (got, _) => panic!("{name}: {got:?}"),
            }
        }
    }
}
