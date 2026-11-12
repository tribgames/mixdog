//! The record builders of Node's call sites (`agent-trace.mjs`, `agent-trace-format.mjs` and the
//! literals passed to `appendAgentTrace` in the providers and the session loop), one function per
//! record. Each takes the JavaScript call's named arguments as a JSON object (absent = `undefined`)
//! and returns the record `appendAgentTrace` receives, with Node's key order and `||` / `??` rules.
//!
//! What stays with the call site: values read off JavaScript error objects (`err.code`,
//! `err.httpStatus`, ...) and the `payload` objects the providers assemble from their own state
//! (cache-break, xAI cache, WebSocket watchdog and header payloads) arrive here already built.

use mixdog_js::json_number;
use mixdog_js::to_number;
use serde_json::Map;
use serde_json::Value;

use crate::record::truthy;

pub type Args = Map<String, Value>;

/// A record under construction: JavaScript object-literal semantics (insert keeps a key's place).
struct Row(Map<String, Value>);

impl Row {
    fn new() -> Self {
        Self(Map::new())
    }

    fn put(mut self, key: &str, value: Value) -> Self {
        self.0.insert(key.into(), value);
        self
    }

    /// `key: value` where an `undefined` value leaves the key out.
    fn put_some(self, key: &str, value: Option<&Value>) -> Self {
        match value {
            Some(v) => self.put(key, v.clone()),
            None => self,
        }
    }

    fn text(self, key: &str, value: &str) -> Self {
        self.put(key, Value::String(value.into()))
    }

    /// `key: a.key` (a key `a` lacks is `undefined`, so it is left out).
    fn copy(self, a: &Args, key: &str) -> Self {
        self.copy_as(a, key, key)
    }

    fn copy_as(mut self, a: &Args, from: &str, to: &str) -> Self {
        if let Some(v) = a.get(from) {
            self.0.insert(to.into(), v.clone());
        }
        self
    }

    /// `to: a.from || null`.
    fn or_null(self, a: &Args, from: &str, to: &str) -> Self {
        self.put(to, or_null(a.get(from)))
    }

    /// `to: a.from ?? null`.
    fn nullish(self, a: &Args, from: &str, to: &str) -> Self {
        self.put(to, nullish(a.get(from)))
    }

    /// `...object`.
    fn spread(mut self, object: Option<&Value>) -> Self {
        if let Some(Value::Object(map)) = object {
            for (k, v) in map {
                self.0.insert(k.clone(), v.clone());
            }
        }
        self
    }

    fn done(self) -> Map<String, Value> {
        self.0
    }
}

fn or_null(value: Option<&Value>) -> Value {
    match value {
        Some(v) if truthy(v) => v.clone(),
        _ => Value::Null,
    }
}

fn nullish(value: Option<&Value>) -> Value {
    value.cloned().unwrap_or(Value::Null)
}

fn number(value: Option<&Value>) -> f64 {
    value.map_or(f64::NAN, to_number)
}

/// `Math.round`.
fn round(x: f64) -> f64 {
    (x + 0.5).floor()
}

fn num_value(x: f64) -> Value {
    json_number(x)
}

/// `Number.isFinite(Number(v)) ? Number(v) : null`.
pub fn finite_number_or_null(value: Option<&Value>) -> Value {
    let n = number(value);
    if n.is_finite() { num_value(n) } else { Value::Null }
}

/// `Number(x || 0) || null`: the HTTP status of an error, 0 and NaN becoming null.
fn status_or_null(value: Option<&Value>) -> Value {
    let n = if value.is_some_and(truthy) { number(value) } else { 0.0 };
    if n == 0.0 || n.is_nan() { Value::Null } else { num_value(n) }
}

fn is_true(value: Option<&Value>) -> bool {
    value == Some(&Value::Bool(true))
}

fn object_of(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

// ---------------------------------------------------------------------------
// agent-trace.mjs
// ---------------------------------------------------------------------------

/// `traceAgentPreset`.
pub fn preset_assign_record(a: &Args) -> Args {
    Row::new()
        .copy(a, "sessionId")
        .text("kind", "preset_assign")
        .or_null(a, "agent", "agent")
        .or_null(a, "presetName", "preset_name")
        .or_null(a, "model", "model")
        .or_null(a, "provider", "provider")
        .or_null(a, "parentSessionId", "parent_session_id")
        .or_null(a, "parentSessionId", "parentSessionId")
        .done()
}

/// `traceAgentFetch`.
pub fn fetch_record(a: &Args) -> Args {
    let retries = number(a.get("handshakeRetries"));
    let mut payload = Row::new()
        .copy_as(a, "headersMs", "headers_ms")
        .text("phase", "http_response_headers")
        .copy_as(a, "httpStatus", "http_status")
        .or_null(a, "provider", "provider")
        .or_null(a, "model", "model")
        .or_null(a, "transport", "transport");
    if retries.is_finite() {
        payload = payload.put("handshake_retries", num_value(retries));
    }
    let classifiers = a.get("handshakeRetryClassifiers").filter(|v| v.as_array().is_some_and(|l| !l.is_empty()));
    if let Some(list) = classifiers {
        payload = payload.put("handshake_retry_classifiers", list.clone());
    }
    let payload = payload.done();
    Row::new()
        .copy(a, "sessionId")
        .text("kind", "fetch")
        .copy_as(a, "headersMs", "headers_ms")
        .copy_as(a, "httpStatus", "http_status")
        .or_null(a, "provider", "provider")
        .or_null(a, "model", "model")
        .or_null(a, "transport", "transport")
        .spread(Some(&Value::Object(
            ["handshake_retries", "handshake_retry_classifiers"]
                .iter()
                .filter_map(|k| payload.get(*k).map(|v| ((*k).to_string(), v.clone())))
                .collect(),
        )))
        .put("payload", Value::Object(payload))
        .done()
}

/// `traceAgentSse`.
pub fn sse_record(a: &Args) -> Args {
    let payload = Row::new()
        .copy_as(a, "sseParseMs", "sse_parse_ms")
        .copy_as(a, "sseParseMs", "stream_total_ms")
        .copy_as(a, "ttftMs", "ttft_ms")
        .copy_as(a, "ttftMs", "first_token_ms")
        .or_null(a, "provider", "provider")
        .or_null(a, "model", "model")
        .or_null(a, "transport", "transport")
        .done();
    Row::new()
        .copy(a, "sessionId")
        .text("kind", "sse")
        .copy_as(a, "sseParseMs", "sse_parse_ms")
        .copy_as(a, "sseParseMs", "stream_total_ms")
        .copy_as(a, "ttftMs", "ttft_ms")
        .copy_as(a, "ttftMs", "first_token_ms")
        .or_null(a, "provider", "provider")
        .or_null(a, "model", "model")
        .or_null(a, "transport", "transport")
        .put("payload", Value::Object(payload))
        .done()
}

/// `traceTurnTiming`.
pub fn turn_timing_record(a: &Args) -> Args {
    let ms = |key: &str| {
        let n = number(a.get(key));
        if n.is_finite() { num_value(round(n)) } else { Value::Null }
    };
    let status = match a.get("status") {
        Some(v) if truthy(v) => v.clone(),
        _ => Value::String("unknown".into()),
    };
    let payload = Row::new()
        .put("status", status)
        .or_null(a, "requestId", "request_id")
        .put("ttft_ms", ms("ttftMs"))
        .put("end_to_end_ttft_ms", ms("endToEndTtftMs"))
        .put("queue_ms", ms("queueMs"))
        .put("route_ms", ms("routeMs"))
        .put("preflight_ms", ms("preflightMs"))
        .put("mcp_ms", ms("mcpMs"))
        .put("provider_ms", ms("providerMs"))
        .done();
    Row::new()
        .copy(a, "sessionId")
        .text("kind", "turn_timing")
        .spread(Some(&Value::Object(payload.clone())))
        .put("payload", Value::Object(payload))
        .done()
}

/// `isInclusiveProvider` (`shared/llm/cost.mjs`).
pub fn is_inclusive_provider(provider: Option<&Value>) -> bool {
    match provider {
        Some(v) if truthy(v) => {
            let p = mixdog_js::js_to_lowercase(&mixdog_js::value_to_string(v));
            p != "anthropic" && p != "anthropic-oauth"
        }
        _ => false,
    }
}

/// `resolveTraceUsageInput`: `(uncachedInputTokens, promptTokens)`.
pub fn resolve_trace_usage_input(
    provider: Option<&Value>,
    input_tokens: Option<&Value>,
    cached_tokens: Option<&Value>,
    cache_write_tokens: Option<&Value>,
    inclusive: Option<&Value>,
) -> (f64, f64) {
    let inclusive = match inclusive {
        Some(Value::Bool(b)) => *b,
        _ => is_inclusive_provider(provider),
    };
    let or_zero = |v: Option<&Value>| if v.is_some_and(truthy) { number(v) } else { 0.0 };
    let (input, read, write) = (or_zero(input_tokens), or_zero(cached_tokens), or_zero(cache_write_tokens));
    if inclusive {
        ((input - read - write).max(0.0), input.max(read + write))
    } else {
        (input, input + read + write)
    }
}

fn token_count(value: Option<&Value>) -> Option<Value> {
    let n = value?.as_f64()?;
    (n.fract() == 0.0 && (0.0..=9_007_199_254_740_991.0).contains(&n)).then(|| num_value(n))
}

/// `reasoningUsage(usage).reasoningTokens` (`shared/llm/reasoning-usage.mjs`): the count or null.
pub fn reasoning_tokens(usage: Option<&Value>) -> Value {
    let Some(usage) = usage.filter(|u| truthy(u)) else {
        return Value::Null;
    };
    if let Some(object) = usage.as_object().filter(|o| o.contains_key("reasoningTokens")) {
        return token_count(object.get("reasoningTokens")).unwrap_or(Value::Null);
    }
    let raw = usage.get("raw").filter(|v| !v.is_null()).unwrap_or(usage);
    let paths: [&[&str]; 8] = [
        &["output_tokens_details", "reasoning_tokens"],
        &["output_tokens_details", "thinking_tokens"],
        &["completion_tokens_details", "reasoning_tokens"],
        &["completion_tokens_details", "thinking_tokens"],
        &["thinking_tokens"],
        &["thinkingTokens"],
        &["thoughtsTokenCount"],
        &["thoughts_token_count"],
    ];
    paths
        .iter()
        .find_map(|path| token_count(path.iter().try_fold(raw, |v, key| v.get(*key))))
        .unwrap_or(Value::Null)
}

/// `traceAgentUsage`. `identity` is the usage context of the send in progress
/// (`currentUsageContext()`: `provider`, `sessionId`, `inputTokensInclusive`, `requestedModel`,
/// `pricingModel`, `sourceType`).
pub fn usage_raw_record(a: &Args, identity: Option<&Args>) -> Args {
    let pick = |own: &str| -> Option<Value> {
        identity
            .and_then(|i| i.get(own))
            .filter(|v| truthy(v))
            .cloned()
            .or_else(|| a.get(own).cloned())
    };
    let provider = pick("provider");
    let session_id = pick("sessionId");
    let inclusive = identity.and_then(|i| i.get("inputTokensInclusive")).filter(|v| !v.is_null()).or(a.get("inputTokensInclusive"));
    let (uncached, prompt) = resolve_trace_usage_input(
        provider.as_ref(),
        a.get("inputTokens"),
        a.get("cachedTokens"),
        a.get("cacheWriteTokens"),
        inclusive,
    );
    let cache_write = if a.get("cacheWriteTokens").is_some_and(truthy) { a.get("cacheWriteTokens").cloned() } else { Some(Value::from(0)) };
    let prompt_total = match a.get("promptTokens") {
        Some(Value::Number(n)) => Value::Number(n.clone()),
        _ => num_value(prompt),
    };
    let raw_usage = a.get("rawUsage");
    let tier = [a.get("serviceTier"), raw_usage.and_then(|r| r.get("service_tier")), raw_usage.and_then(|r| r.get("serviceTier"))]
        .into_iter()
        .flatten()
        .find(|v| truthy(v))
        .cloned()
        .unwrap_or(Value::Null);
    let thinking = reasoning_tokens(raw_usage);
    let mut chain = Row::new();
    for (from, to) in [
        ("requestPrevResponseId", "request_prev_response_id"),
        ("chainContinuous", "chain_continuous"),
        ("continuationResetReason", "continuation_reset_reason"),
    ] {
        chain = chain.copy_as(a, from, to);
    }
    let chain = chain.done();
    let request_kind = match a.get("requestKind") {
        Some(Value::String(s)) if !s.is_empty() => Value::String(s.clone()),
        _ => Value::Null,
    };
    let id = |key: &str| identity.and_then(|i| i.get(key));
    let mut payload = Row::new()
        .put("provider", or_null(provider.as_ref()))
        .put("requested_model", or_null(id("requestedModel")))
        .put(
            "pricing_model",
            or_null(a.get("pricingModel").filter(|v| truthy(v)).or(id("pricingModel"))),
        )
        .put("source_type", or_null(id("sourceType")))
        .put("prompt_tokens", prompt_total.clone())
        .put("uncached_input_tokens", num_value(uncached))
        .put("thinking_tokens", thinking.clone())
        .or_null(a, "modelDisplay", "model_display")
        .or_null(a, "responseId", "response_id")
        .put("service_tier", tier.clone())
        .put("raw_usage", or_null(raw_usage))
        .spread(Some(&Value::Object(chain.clone())));
    if a.get("prefixBlocks").is_some_and(truthy) {
        payload = payload.copy_as(a, "prefixBlocks", "prefix_blocks");
    }
    let mut row = Row::new();
    if let Some(s) = session_id {
        row = row.put("sessionId", s);
    }
    row = row
        .copy(a, "iteration")
        .text("kind", "usage_raw")
        .copy_as(a, "inputTokens", "input_tokens")
        .copy_as(a, "outputTokens", "output_tokens")
        .put("thinking_tokens", thinking)
        .copy_as(a, "cachedTokens", "cached_tokens");
    if let Some(w) = cache_write {
        row = row.put("cache_write_tokens", w);
    }
    row.put("uncached_input_tokens", num_value(uncached))
        .put("prompt_tokens", prompt_total)
        .or_null(a, "model", "model")
        .or_null(a, "modelDisplay", "model_display")
        .or_null(a, "responseId", "response_id")
        .put("request_kind", request_kind)
        .put("service_tier", tier)
        .spread(Some(&Value::Object(chain)))
        .put("payload", Value::Object(payload.done()))
        .done()
}

/// `grokCacheChainTraceFields`.
pub fn grok_cache_chain_fields(
    provider_state: Option<&Value>,
    request_prev_response_id: Option<&Value>,
    continuation_reset_reason: Option<&str>,
) -> Args {
    let non_empty = |v: Option<&Value>| v.and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
    let last = non_empty(provider_state.and_then(|s| s.get("xaiResponses")).and_then(|x| x.get("previousResponseId")));
    let sent = non_empty(request_prev_response_id);
    let continuous = sent.is_some() && sent == last;
    Row::new()
        .put("requestPrevResponseId", sent.map_or(Value::Null, Value::String))
        .put("chainContinuous", Value::Bool(continuous))
        .put(
            "continuationResetReason",
            continuation_reset_reason.filter(|s| !s.is_empty()).map_or(Value::Null, |s| Value::String(s.into())),
        )
        .done()
}

// ---------------------------------------------------------------------------
// agent-trace-format.mjs
// ---------------------------------------------------------------------------

/// `traceAgentLoop`; the caller applies the `MIXDOG_AGENT_TRACE_VERBOSE` / `_TIMING` gate
/// (`TraceConfig::loop_rows`).
pub fn loop_record(a: &Args) -> Args {
    Row::new()
        .copy(a, "sessionId")
        .copy(a, "iteration")
        .text("kind", "loop")
        .or_null(a, "agent", "agent")
        .copy_as(a, "sendMs", "send_ms")
        .nullish(a, "preSendMs", "pre_send_ms")
        .nullish(a, "toolResumeMs", "tool_resume_ms")
        .copy_as(a, "messageCount", "message_count")
        .nullish(a, "bodyBytesEst", "body_bytes_est")
        .done()
}

/// `traceAgentCompress`.
pub fn compress_record(a: &Args) -> Args {
    let before = number(a.get("before"));
    let after = number(a.get("after"));
    let savings = if before > 0.0 { round((1.0 - after / before) * 100.0) } else { 0.0 };
    let payload = Row::new()
        .copy_as(a, "before", "bytes_before")
        .copy_as(a, "after", "bytes_after")
        .put("savings_pct", num_value(savings))
        .done();
    Row::new()
        .copy(a, "sessionId")
        .text("kind", "compress")
        .copy_as(a, "toolName", "tool_name")
        .put("payload", Value::Object(payload))
        .done()
}

/// `nonNegativeInt(value)`.
fn non_negative_int(value: Option<&Value>) -> f64 {
    let n = number(value).floor();
    if n.is_finite() && n >= 0.0 { n } else { 0.0 }
}

fn int_value(n: f64) -> Value {
    num_value(n)
}

/// `buildShellOutputTelemetryPayload`.
pub fn shell_output_payload(a: &Args) -> Option<Args> {
    let telemetry = a.get("telemetry");
    let t = |key: &str| telemetry.and_then(|t| t.get(key));
    let command_output = number(t("commandOutputBytes"));
    if !command_output.is_finite() || command_output < 0.0 {
        return None;
    }
    let visible = non_negative_int(a.get("modelVisibleBytes"));
    let cob = command_output.trunc();
    let exit_code = t("exitCode")
        .filter(|v| v.as_f64().is_some_and(|n| n.fract() == 0.0))
        .cloned()
        .unwrap_or(Value::Null);
    let lossless = match t("losslessCompaction") {
        Some(l) if truthy(l) => Value::Object(
            Row::new()
                .put("applied", Value::Bool(l.get("applied") == Some(&Value::Bool(true))))
                .nullish(l.as_object().unwrap_or(&Map::new()), "reason", "reason")
                .nullish(l.as_object().unwrap_or(&Map::new()), "kind", "kind")
                .done(),
        ),
        _ => Value::Null,
    };
    Some(
        Row::new()
            .or_null(a, "toolCallId", "tool_call_id")
            .or_null(a, "resultKind", "result_kind")
            .put("command_output_bytes", int_value(cob))
            .put("captured_preview_bytes", int_value(non_negative_int(t("capturedPreviewBytes"))))
            .put("shell_result_bytes", int_value(non_negative_int(t("shellResultBytes"))))
            .put("tool_result_bytes", int_value(non_negative_int(t("toolResultBytes"))))
            .put("pre_offload_bytes", int_value(non_negative_int(a.get("preOffloadBytes"))))
            .put("post_offload_bytes", int_value(non_negative_int(a.get("postOffloadBytes"))))
            .put("model_visible_bytes", int_value(visible))
            .put("byte_delta", int_value(cob - visible))
            .put(
                "reduction_pct",
                if command_output > 0.0 { num_value(round((1.0 - visible / command_output) * 100.0)) } else { Value::Null },
            )
            .put("exit_code", exit_code)
            .put("signal", or_null(t("signal")))
            .put("timed_out", Value::Bool(is_true(t("timedOut"))))
            .put("spilled", Value::Bool(is_true(t("spilled"))))
            .put("offloaded", Value::Bool(is_true(a.get("offloaded"))))
            .put("lossless_compaction", lossless)
            .done(),
    )
}

/// `traceAgentShellOutput`: `None` when Node returns without a row.
pub fn shell_output_record(a: &Args) -> Option<Args> {
    let payload = shell_output_payload(a)?;
    if !a.get("sessionId").is_some_and(truthy) {
        return None;
    }
    let tool_name = match a.get("toolName") {
        Some(v) if truthy(v) => v.clone(),
        _ => Value::String("shell".into()),
    };
    Some(
        Row::new()
            .copy(a, "sessionId")
            .text("kind", "shell_output")
            .put("tool_name", tool_name)
            .put("payload", Value::Object(payload))
            .done(),
    )
}

/// `buildToolOutputTelemetryPayload`.
pub fn tool_output_payload(a: &Args) -> Option<Args> {
    let before = number(a.get("preOffloadBytes"));
    let after = number(a.get("postOffloadBytes"));
    if !before.is_finite() || before < 0.0 || !after.is_finite() || after < 0.0 {
        return None;
    }
    let visible = non_negative_int(a.get("modelVisibleBytes"));
    let saved = (before.trunc() - visible).max(0.0);
    Some(
        Row::new()
            .or_null(a, "toolCallId", "tool_call_id")
            .or_null(a, "resultKind", "result_kind")
            .put("pre_offload_bytes", int_value(before.trunc()))
            .put("post_offload_bytes", int_value(after.trunc()))
            .put("model_visible_bytes", int_value(visible))
            .put("saved_bytes", int_value(saved))
            .put("reduction_pct", if before > 0.0 { num_value(round((1.0 - visible / before) * 100.0)) } else { Value::Null })
            .put("offloaded", Value::Bool(is_true(a.get("offloaded"))))
            .done(),
    )
}

/// `traceAgentToolOutput`: a row only for an offloaded result.
pub fn tool_output_record(a: &Args) -> Option<Args> {
    let payload = tool_output_payload(a)?;
    if !a.get("sessionId").is_some_and(truthy) || payload.get("offloaded") != Some(&Value::Bool(true)) {
        return None;
    }
    Some(
        Row::new()
            .copy(a, "sessionId")
            .text("kind", "tool_output")
            .or_null(a, "toolName", "tool_name")
            .put("payload", Value::Object(payload))
            .done(),
    )
}

/// `traceAgentBatch`.
pub fn batch_record(a: &Args) -> Args {
    let mut payload = Row::new().copy_as(a, "toolCallCount", "tool_call_count");
    if a.get("batchId").is_some_and(truthy) && a.get("batchCalls").is_some_and(Value::is_array) {
        payload = payload
            .put("batch_schema_version", Value::from(1))
            .copy_as(a, "batchId", "batch_id")
            .copy(a, "iteration")
            .copy_as(a, "batchCalls", "calls");
    }
    Row::new()
        .copy(a, "sessionId")
        .text("kind", "batch")
        .put("payload", Value::Object(payload.done()))
        .done()
}

// ---------------------------------------------------------------------------
// Literals at the call sites
// ---------------------------------------------------------------------------

/// `stall_abort` (`agent-progress-watchdog.mjs`): `elapsed_ms`, `message`, `stage`.
pub fn stall_abort_record(a: &Args) -> Args {
    let payload = Row::new()
        .copy_as(a, "elapsed_ms", "elapsed_ms")
        .copy(a, "message")
        .nullish(a, "stage", "stage")
        .done();
    Row::new()
        .copy(a, "sessionId")
        .nullish(a, "iteration", "iteration")
        .text("kind", "stall_abort")
        .or_null(a, "agent", "agent")
        .put("payload", Value::Object(payload))
        .done()
}

/// `transport_fallback` (`transport-fallback-trace.mjs`, `openai-compat.mjs`,
/// `openai-oauth-dispatch.mjs`): `sessionId`, `iteration` (as the site resolves it),
/// `provider`, `model`, `transport`, `from`, `to`, `reason` and the error's `error_code`,
/// `error_http_status`, `error_classifier`.
pub fn transport_fallback_record(a: &Args) -> Args {
    let payload = Row::new()
        .copy(a, "from")
        .copy(a, "to")
        .copy(a, "reason")
        .or_null(a, "error_code", "error_code")
        .put("error_http_status", status_or_null(a.get("error_http_status")))
        .or_null(a, "error_classifier", "error_classifier")
        .done();
    Row::new()
        .copy(a, "sessionId")
        .copy(a, "iteration")
        .text("kind", "transport_fallback")
        .copy(a, "provider")
        .copy(a, "model")
        .copy(a, "transport")
        .put("payload", Value::Object(payload))
        .done()
}

/// `transport_error` (`openai-oauth-dispatch.mjs`): `message` is cut to 500 UTF-16 units.
pub fn transport_error_record(a: &Args) -> Args {
    let message = a.get("message").map(mixdog_js::value_to_string).unwrap_or_default();
    let payload = Row::new()
        .copy(a, "stage")
        .or_null(a, "error_code", "error_code")
        .put("error_http_status", status_or_null(a.get("error_http_status")))
        .nullish(a, "error_ws_close_code", "error_ws_close_code")
        .or_null(a, "error_classifier", "error_classifier")
        .nullish(a, "ws_retries", "ws_retries")
        .put("live_text_emitted", Value::Bool(is_true(a.get("live_text_emitted"))))
        .text("message", &crate::text::slice_utf16(&message, 500))
        .done();
    Row::new()
        .copy(a, "sessionId")
        .copy(a, "iteration")
        .text("kind", "transport_error")
        .text("provider", "openai-oauth")
        .copy(a, "model")
        .copy(a, "transport")
        .put("payload", Value::Object(payload))
        .done()
}

/// `spawn_ws_prewarm` (`openai-startup-prewarm.mjs`).
pub fn spawn_ws_prewarm_record(a: &Args) -> Args {
    Row::new()
        .copy(a, "sessionId")
        .text("kind", "spawn_ws_prewarm")
        .text("provider", "openai-oauth")
        .text("transport", "websocket")
        .copy(a, "payload")
        .done()
}

/// `iteration` as `Number.isFinite(iteration) ? iteration : null` (no coercion).
fn finite_iteration(value: Option<&Value>) -> Value {
    match value {
        Some(Value::Number(n)) if n.as_f64().is_some_and(f64::is_finite) => Value::Number(n.clone()),
        _ => Value::Null,
    }
}

/// `ws_header_keys` (`turn-state-headers.mjs`): `sessionId`, `iteration`, `event_type`, `payload`.
pub fn ws_header_keys_record(a: &Args) -> Args {
    let payload = object_of(a.get("payload"));
    let pick = |key: &str| payload.and_then(|p| p.get(key)).cloned();
    let mut row = Row::new()
        .put("sessionId", or_null(a.get("sessionId")))
        .put("iteration", finite_iteration(a.get("iteration")))
        .text("kind", "ws_header_keys");
    if let Some(v) = pick("provider") {
        row = row.put("provider", v);
    }
    if let Some(v) = pick("model") {
        row = row.put("model", v);
    }
    row.text("transport", "websocket").copy_as(a, "event_type", "event_type").copy(a, "payload").done()
}

/// `ws_timeout` (`openai-ws-watchdogs.mjs`).
pub fn ws_timeout_record(a: &Args) -> Args {
    Row::new()
        .put("sessionId", or_null(a.get("sessionId")))
        .put("iteration", finite_iteration(a.get("iteration")))
        .text("kind", "ws_timeout")
        .spread(a.get("payload"))
        .copy(a, "payload")
        .done()
}

/// `cache_context` / `cache_anomaly` (`openai-compat-xai.mjs`): `{sessionId, iteration, kind, ...payload, payload}`.
pub fn spread_payload_record(kind: &str, a: &Args) -> Args {
    Row::new()
        .copy(a, "sessionId")
        .copy(a, "iteration")
        .text("kind", kind)
        .spread(a.get("payload"))
        .copy(a, "payload")
        .done()
}

/// `output_truncated` (`loop/diagnostics.mjs`): `stop_reason`, `content_len`, `agent`.
pub fn output_truncated_record(a: &Args) -> Args {
    let payload = Row::new()
        .copy(a, "stop_reason")
        .copy(a, "content_len")
        .or_null(a, "agent", "agent")
        .done();
    Row::new()
        .copy(a, "sessionId")
        .copy(a, "iteration")
        .text("kind", "output_truncated")
        .put("payload", Value::Object(payload))
        .done()
}

/// `context` (`ask-turn-prepare.mjs`).
pub fn context_record(a: &Args) -> Args {
    Row::new()
        .text("kind", "context")
        .copy(a, "sessionId")
        .copy(a, "model")
        .copy(a, "provider")
        .copy(a, "totalBytes")
        .copy(a, "breakdown")
        .done()
}

/// `steer` (`tool-batch/pre-dispatch.mjs`).
pub fn steer_record(a: &Args) -> Args {
    Row::new()
        .copy(a, "sessionId")
        .copy(a, "iteration")
        .text("kind", "steer")
        .copy(a, "payload")
        .or_null(a, "agent", "agent")
        .done()
}

/// `cache_break` of `traceCacheBreak` (`cache-break-trace.mjs`): `sessionId`, `iteration`, and the
/// already built `payload`.
pub fn cache_break_record(a: &Args) -> Args {
    let payload = object_of(a.get("payload"));
    let p = |key: &str| payload.and_then(|p| p.get(key));
    Row::new()
        .put("sessionId", or_null(a.get("sessionId")))
        .put("iteration", finite_number_or_null(a.get("iteration")))
        .text("kind", "cache_break")
        .put_some("classification", p("classification"))
        .put_some("reason", p("reason"))
        .put("source", or_null(p("source")))
        .put("provider", or_null(p("provider")))
        .put("model", or_null(p("model")))
        .put("transport", or_null(p("transport")))
        .copy(a, "payload")
        .done()
}

/// `cleanText(value, max)`: absent, null and `''` are null; otherwise `String(value)` with each run of CR, LF and TAB as
/// one space, cut to `max` UTF-16 units.
fn clean_text(value: Option<&Value>, max: usize) -> Option<String> {
    let value = value.filter(|v| !v.is_null() && v.as_str() != Some(""))?;
    let mut out = String::new();
    let mut in_run = false;
    for c in mixdog_js::value_to_string(value).chars() {
        let space = matches!(c, '\r' | '\n' | '\t');
        if !space {
            out.push(c);
        } else if !in_run {
            out.push(' ');
        }
        in_run = space;
    }
    Some(crate::text::slice_utf16(&out, max))
}

/// `cleanHash`: the cleaned text's first 16 units.
fn clean_hash(value: Option<&Value>) -> Option<String> {
    clean_text(value, 128).map(|text| crate::text::slice_utf16(&text, 16)).filter(|text| !text.is_empty())
}

/// `finiteNumber`.
fn finite_number(value: Option<&Value>) -> Option<Value> {
    let n = number(value);
    n.is_finite().then(|| num_value(n))
}

/// `buildCacheBreakPayload(record)` (`cache-break-trace.mjs`): the fields of a cache-break record, nulls left out.
pub fn cache_break_payload(record: &Args) -> Args {
    let text = |key: &str| clean_text(record.get(key), 120).map(Value::String);
    let hash = |key: &str| clean_hash(record.get(key)).map(Value::String);
    let num = |key: &str| finite_number(record.get(key));
    let flag = |key: &str| Some(Value::Bool(is_true(record.get(key))));
    let fields: Vec<(&str, Option<Value>)> = vec![
        ("classification", Some(text("classification").unwrap_or_else(|| "unknown".into()))),
        ("reason", Some(text("reason").unwrap_or_else(|| "unknown".into()))),
        ("source", text("source")),
        ("provider", text("provider")),
        ("model", text("model")),
        ("transport", text("transport")),
        ("intentional_transition", text("intentionalTransition")),
        ("index", num("index")),
        ("previous_count", num("previousCount")),
        ("next_count", num("nextCount")),
        ("previous_hash", hash("previousHash")),
        ("next_hash", hash("nextHash")),
        ("previous_request_prefix_hash", hash("previousRequestPrefixHash")),
        ("next_request_prefix_hash", hash("nextRequestPrefixHash")),
        ("request_prefix_changed", flag("requestPrefixChanged")),
        ("cached_tokens", num("cachedTokens")),
        ("prompt_tokens", num("promptTokens")),
        ("uncached_tokens", num("uncachedTokens")),
        ("cache_ratio", num("cacheRatio")),
        ("actual_cache_miss", flag("actualCacheMiss")),
        ("previous_cached_prefix_tokens", num("previousCachedPrefixTokens")),
        ("idle_ms", num("idleMs")),
        ("missing_prefix_guard_baseline", is_true(record.get("missingPrefixGuardBaseline")).then_some(Value::Bool(true))),
        ("input_prefix_mismatch_index", num("inputPrefixMismatchIndex")),
        ("input_prefix_mismatch_previous_count", num("inputPrefixMismatchPreviousCount")),
        ("input_prefix_mismatch_current_count", num("inputPrefixMismatchCurrentCount")),
        ("input_prefix_mismatch_expected_type", text("inputPrefixMismatchExpectedType")),
        ("input_prefix_mismatch_expected_hash", hash("inputPrefixMismatchExpectedHash")),
        ("input_prefix_mismatch_actual_type", text("inputPrefixMismatchActualType")),
        ("input_prefix_mismatch_actual_hash", hash("inputPrefixMismatchActualHash")),
        ("changed_blocks", text("changedBlocks")),
        ("system_markers_changed", record.get("markersChanged").filter(|v| v.is_boolean()).cloned()),
        ("lost_message_breakpoints", text("lostMessageBreakpoints")),
    ];
    fields.into_iter().filter_map(|(key, value)| Some((key.to_owned(), value?))).collect()
}

/// `traceCacheBreak(record)`'s trace row: `{sessionId, iteration, kind, classification, reason, source, provider, model,
/// transport, payload}` over [`cache_break_payload`].
pub fn cache_break_trace_record(record: &Args) -> Args {
    let mut args = Args::new();
    args.insert("sessionId".into(), or_null(record.get("sessionId")));
    // Raw: `cache_break_record` applies `finiteNumber` once; an absent iteration must stay absent (Number(null) is 0).
    if let Some(iteration) = record.get("iteration") {
        args.insert("iteration".into(), iteration.clone());
    }
    args.insert("payload".into(), Value::Object(cache_break_payload(record)));
    cache_break_record(&args)
}

/// `formatCacheBreakLine(record)`: the `[cache-break] key=value ...` stderr line (no newline).
pub fn cache_break_line(record: &Args) -> String {
    let payload = cache_break_payload(record);
    let p = |key: &str| payload.get(key).cloned();
    let fields = [
        ("classification", p("classification")),
        ("reason", p("reason")),
        ("source", p("source")),
        ("session", clean_text(record.get("sessionId"), 160).map(Value::String)),
        ("provider", p("provider")),
        ("model", p("model")),
        ("iteration", finite_number(record.get("iteration"))),
        ("index", p("index")),
        ("previousCount", p("previous_count")),
        ("nextCount", p("next_count")),
        ("previousHash", p("previous_hash")),
        ("nextHash", p("next_hash")),
        ("inputMismatchIndex", p("input_prefix_mismatch_index")),
        ("intent", p("intentional_transition")),
        ("cachedTokens", p("cached_tokens")),
        ("promptTokens", p("prompt_tokens")),
        ("previousCachedPrefixTokens", p("previous_cached_prefix_tokens")),
        ("idleMs", p("idle_ms")),
        ("noGuardBaseline", p("missing_prefix_guard_baseline")),
        ("changedBlocks", p("changed_blocks")),
        ("systemMarkersChanged", p("system_markers_changed")),
        ("lostMessageBreakpoints", p("lost_message_breakpoints")),
    ];
    let shown: Vec<String> = fields
        .into_iter()
        .filter_map(|(key, value)| {
            let value = value?;
            Some(match &value {
                Value::String(_) => format!("{key}={}", crate::text::stringify(&value)),
                Value::Number(n) => format!("{key}={}", mixdog_js::number_to_string(n.as_f64().unwrap_or(f64::NAN))),
                other => format!("{key}={other}"),
            })
        })
        .collect();
    format!("[cache-break] {}", shown.join(" "))
}

/// `cache_break` / `cache_miss` of the WebSocket send (`openai-ws-send-trace.mjs`): the fields are
/// `sessionId`, `iteration`, `classification`?, `source`?, `provider`, `model`, `transport`?, `payload`.
pub fn ws_send_cache_record(kind: &str, a: &Args) -> Args {
    Row::new()
        .copy(a, "sessionId")
        .copy(a, "iteration")
        .text("kind", kind)
        .copy(a, "classification")
        .copy(a, "source")
        .copy(a, "provider")
        .copy(a, "model")
        .copy(a, "transport")
        .copy(a, "payload")
        .done()
}

/// `transport` (`openai-ws-send-trace.mjs`): `{sessionId, iteration, kind, ...payload, payload}`.
pub fn ws_send_transport_record(a: &Args) -> Args {
    spread_payload_record("transport", a)
}

/// `traceLoop` (`send-with-recovery.mjs`): `{kind, sessionId: sessionId || null, iteration, ...fields}`.
pub fn trace_loop_record(a: &Args) -> Args {
    Row::new()
        .copy(a, "kind")
        .put("sessionId", or_null(a.get("sessionId")))
        .copy(a, "iteration")
        .spread(a.get("fields"))
        .done()
}

/// The no-tool-turn ladder's `trace` (`loop/no-tool-turn.mjs`).
pub fn no_tool_record(a: &Args) -> Args {
    Row::new()
        .copy(a, "sessionId")
        .copy(a, "iteration")
        .copy(a, "kind")
        .copy(a, "payload")
        .or_null(a, "agent", "agent")
        .done()
}

/// `traceGeminiCache` (`gemini-cache-policy.mjs`): sessionId already resolved.
pub fn gemini_cache_record(a: &Args) -> Args {
    Row::new().copy(a, "sessionId").copy(a, "iteration").copy(a, "kind").copy(a, "payload").done()
}

/// `cursor_unknown_field` (`cursor-wire-stream-messages.mjs`).
pub fn cursor_unknown_field_record(a: &Args) -> Args {
    Row::new()
        .copy(a, "sessionId")
        .text("kind", "cursor_unknown_field")
        .text("provider", "cursor")
        .copy(a, "payload")
        .done()
}

/// `browserTimingRow` (`browser-bridge/timing.mjs`); the caller applies the
/// `MIXDOG_AGENT_TRACE_TIMING` / `_VERBOSE` gate (`TraceConfig::loop_rows`). Arguments:
/// `context {sessionId, turnId, action}`, `bridgeMs`, `body`, `status`.
pub fn browser_timing_record(a: &Args) -> Args {
    const KEYS: [&str; 6] = ["commandMs", "waitMs", "snapshotMs", "targetMs", "actionabilityMs", "inputMs"];
    fn numeric(source: Option<&Value>, keys: &[&str]) -> Map<String, Value> {
        let mut out = Map::new();
        for key in keys {
            if let Some(v) = source.and_then(|s| s.get(*key)) {
                if v.as_f64().is_some_and(|n| n.is_finite() && n >= 0.0) {
                    out.insert((*key).to_string(), v.clone());
                }
            }
        }
        out
    }
    let body = a.get("body");
    let ok_false = body.and_then(|b| b.get("ok")) == Some(&Value::Bool(false));
    let timing = if ok_false {
        body.and_then(|b| b.get("timing"))
    } else {
        body.and_then(|b| b.get("value")).and_then(|v| v.get("timing"))
    };
    let mut keys = vec!["queueMs"];
    keys.extend(KEYS);
    keys.extend(["screenshotMs", "snapshots", "screenshots"]);
    let mut phases = numeric(timing, &keys);
    if let Some(steps) = timing.and_then(|t| t.get("steps")).and_then(Value::as_array) {
        let mut step_keys = vec!["index"];
        step_keys.extend(KEYS);
        let list: Vec<Value> = steps
            .iter()
            .take(6)
            .filter(|s| s.get("index").and_then(Value::as_f64).is_some_and(|i| i.fract() == 0.0 && (1.0..=6.0).contains(&i)))
            .map(|s| Value::Object(numeric(Some(s), &step_keys)))
            .collect();
        phases.insert("steps".into(), Value::Array(list));
    }
    if let Some(mouse) = timing.and_then(|t| t.get("mouseEvents")).filter(|m| truthy(m)) {
        let mut events = Map::new();
        for kind in ["mouseMoved", "mousePressed", "mouseReleased"] {
            let event = numeric(mouse.get(kind), &["count", "totalMs"]);
            if !event.is_empty() {
                events.insert(kind.to_string(), Value::Object(event));
            }
        }
        phases.insert("mouseEvents".into(), Value::Object(events));
    }
    let context = a.get("context");
    let c = |key: &str| context.and_then(|c| c.get(key)).cloned();
    let mut row = Row::new().text("kind", "browser_timing");
    for (from, to) in [("sessionId", "sessionId"), ("turnId", "turn_id"), ("action", "action")] {
        if let Some(v) = c(from) {
            row = row.put(to, v);
        }
    }
    row.copy_as(a, "bridgeMs", "bridge_ms")
        .copy_as(a, "status", "http_status")
        .put("ok", Value::Bool(body.and_then(|b| b.get("ok")) == Some(&Value::Bool(true))))
        .put("payload", Value::Object(phases))
        .done()
}
