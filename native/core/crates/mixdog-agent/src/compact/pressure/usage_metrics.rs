//! The usage figures a session header keeps, written per model call and at the turn's end
//! (`session/manager/usage-metrics.mjs`: `persistIterationMetrics`, `accumulateSessionUsage`,
//! `recordLastContextTokens`, `applyAskTerminalUsageTotals`, `bumpUsageMetricsTurnId`,
//! `bumpUsageMetricsEpoch`; `shared/usage-readout-totals.mjs`: `foldUsageReadout`;
//! `shared/llm/reasoning-usage.mjs`).
//!
//! Like the pressure state beside it, every operation is a pure function from the session header
//! to a [`HeaderPatch`]. A model call arrives as Node's `usageDeltaEvent` record; whether the
//! provider's `input_tokens` leaves the cache out (`providerInputExcludesCache`) is the caller's.

use mixdog_js::math::round;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::Header;
use super::HeaderPatch;
use super::num;
use super::number;
use super::number_or_zero;
use super::truthy;

/// `tokenCount(value)` of `reasoning-usage.mjs`: a safe non-negative integer.
fn token_count(value: Option<&Value>) -> Option<u64> {
    let n = value?.as_f64()?;
    (n >= 0.0 && n.fract() == 0.0 && n <= 9_007_199_254_740_991.0).then_some(n as u64)
}

/// `reasoningUsage(usage)` of a record that states `reasoningTokens` (a usage delta, or the
/// header's own `reasoningUsage`). A record without the key is searched in Node under the names a
/// provider's raw usage object uses, which neither a delta nor a header carries: nothing found.
fn reasoning_of(usage: Option<&Value>) -> (Option<u64>, bool) {
    match usage.and_then(Value::as_object).filter(|record| record.contains_key("reasoningTokens")) {
        Some(record) => {
            let tokens = token_count(record.get("reasoningTokens"));
            (tokens, tokens.is_some() && record.get("reasoningTokensComplete") != Some(&Value::Bool(false)))
        }
        None => (None, false),
    }
}

fn reasoning_value(tokens: Option<u64>, complete: bool) -> Value {
    json!({ "reasoningTokens": tokens, "reasoningTokensComplete": complete })
}

/// `combineReasoningUsage(left, right)`.
fn combine_reasoning(left: Option<&Value>, right: Option<&Value>) -> Value {
    let ((a, a_complete), (b, b_complete)) = (reasoning_of(left), reasoning_of(right));
    let tokens = match (a, b) {
        (None, None) => None,
        _ => Some(a.unwrap_or(0) + b.unwrap_or(0)),
    };
    reasoning_value(tokens, a_complete && b_complete)
}

/// `uncachedInputTokensForProvider(provider, input, cachedRead, cacheWrite)`: providers that report
/// `input_tokens` without the cache reads count the cache writes beside it.
pub fn uncached_input_tokens(input_excludes_cache: bool, input: f64, cached_read: f64, cache_write: f64) -> f64 {
    if input <= 0.0 {
        return 0.0;
    }
    if input_excludes_cache { input + cache_write } else { (input - cached_read - cache_write).max(0.0) }
}

/// `num(value)` of `usage-readout-totals.mjs`: a finite positive number, else 0.
fn positive(value: Option<&Value>) -> f64 {
    let n = number(value);
    if n.is_finite() && n > 0.0 { n } else { 0.0 }
}

/// `foldUsageReadout(totals, delta, requestMs)`: the session-cumulative cache hit and speed, one fold
/// per model call; a new record, `totals` untouched.
pub fn fold_usage_readout(totals: Option<&Value>, delta: &Value, request_ms: Option<&Value>) -> Value {
    let base: Map<String, Value> = match totals.and_then(Value::as_object) {
        Some(record) => record.clone(),
        None => {
            let mut empty = Map::new();
            for key in ["input", "cacheRead", "cacheWrite", "output", "requestOutputTokens", "requestMs"] {
                empty.insert(key.to_owned(), json!(0));
            }
            empty
        }
    };
    let mut next = base.clone();
    if delta.get("promptKnown") != Some(&Value::Bool(false)) {
        let cache_read = positive(delta.get("deltaCachedRead"));
        let cache_write = positive(delta.get("deltaCacheWrite"));
        let explicit = positive(delta.get("deltaPrompt"));
        let prompt = if explicit != 0.0 { explicit } else { positive(delta.get("deltaInput")) + cache_read + cache_write };
        next.insert("input".into(), num(positive(base.get("input")) + (prompt - cache_read - cache_write).max(0.0)));
        next.insert("cacheRead".into(), num(positive(base.get("cacheRead")) + cache_read));
        next.insert("cacheWrite".into(), num(positive(base.get("cacheWrite")) + cache_write));
    }
    let output = positive(delta.get("deltaOutput"));
    // A record saved before the output sum existed has none to extend: it stays without.
    if let Some(sum) = base.get("output").and_then(Value::as_f64).filter(|sum| sum.is_finite()) {
        next.insert("output".into(), num(sum + output));
    }
    let ms = positive(request_ms);
    if ms > 0.0 && output > 0.0 {
        next.insert("requestOutputTokens".into(), num(positive(base.get("requestOutputTokens")) + output));
        next.insert("requestMs".into(), num(positive(base.get("requestMs")) + ms));
    }
    Value::Object(next)
}

/// `accumulateSessionUsage(session, delta)`.
fn accumulate(session: &Header, patch: &mut HeaderPatch, delta: &Value, input_excludes_cache: bool) {
    let field = |key: &str| number_or_zero(delta.get(key));
    let (input, output, cached_read, cache_write) = (field("deltaInput"), field("deltaOutput"), field("deltaCachedRead"), field("deltaCacheWrite"));
    // Old sessions have spend but no reasoning counters: their past usage stays unknown, even after
    // the first newly measured response arrives.
    let had_usage = truthy(session.get("reasoningUsage")) || number_or_zero(session.get("totalInputTokens")) > 0.0 || number_or_zero(session.get("totalOutputTokens")) > 0.0;
    let reasoning = if had_usage {
        combine_reasoning(session.get("reasoningUsage"), Some(delta))
    } else {
        let (tokens, complete) = reasoning_of(Some(delta));
        reasoning_value(tokens, complete)
    };
    let uncached = match delta.get("deltaUncachedInput") {
        Some(explicit) if !explicit.is_null() => number_or_zero(Some(explicit)),
        _ => uncached_input_tokens(input_excludes_cache, input, cached_read, cache_write),
    };
    let total = |key: &str| number_or_zero(session.get(key));
    patch.put("reasoningUsage", reasoning);
    patch.put("totalInputTokens", num(total("totalInputTokens") + input));
    patch.put("totalOutputTokens", num(total("totalOutputTokens") + output));
    patch.put("totalToolCalls", num(total("totalToolCalls") + field("deltaToolCalls")));
    patch.put("tokensCumulative", num(total("tokensCumulative") + input + output));
    patch.put("totalCachedReadTokens", num(total("totalCachedReadTokens") + cached_read));
    patch.put("totalCacheWriteTokens", num(total("totalCacheWriteTokens") + cache_write));
    patch.put("totalUncachedInputTokens", num(total("totalUncachedInputTokens") + uncached));
}

/// `clearLastContextTokens(session, ts)`: no usable prompt split for the last call, so the window
/// snapshot is unknown until the next measured send.
fn clear_last(patch: &mut HeaderPatch, ts: f64) {
    for key in ["lastInputTokens", "lastOutputTokens", "lastCachedReadTokens", "lastCacheWriteTokens", "lastUncachedInputTokens", "lastContextTokens"] {
        patch.put(key, Value::Null);
    }
    patch.put("lastContextTokensUpdatedAt", num(ts));
    patch.put("lastContextTokensStaleAfterCompact", Value::Bool(true));
}

/// `applyMeasuredContextOccupancy(session, contextTokens, outputTokens, ts)`: a provider that reports
/// whole-context occupancy (a checkpoint's used tokens) still gives a measured gauge reading; the
/// prompt and cache split stays unknown, never zero.
fn apply_occupancy(patch: &mut HeaderPatch, context_tokens: Option<&Value>, output_tokens: Option<&Value>, ts: f64) -> bool {
    let occupancy = number(context_tokens);
    if !occupancy.is_finite() || occupancy <= 0.0 {
        return false;
    }
    patch.put("lastInputTokens", Value::Null);
    patch.put("lastOutputTokens", num(number_or_zero(output_tokens)));
    patch.put("lastCachedReadTokens", Value::Null);
    patch.put("lastCacheWriteTokens", Value::Null);
    patch.put("lastUncachedInputTokens", Value::Null);
    patch.put("lastContextTokens", num(round(occupancy)));
    patch.put("lastContextTokensUpdatedAt", num(ts));
    patch.put("lastContextTokensStaleAfterCompact", Value::Bool(false));
    true
}

/// `setLastContextTokens(session, ..)`: the last call's prompt split plus its normalized context
/// footprint, comparable across providers (Anthropic's `input_tokens` leaves the cache out, so it is
/// added back). `output_in_window`: the generated output is in the window too.
fn set_last(patch: &mut HeaderPatch, reading: &Reading, input_excludes_cache: bool, ts: f64) {
    let Reading { input, output, cached_read, cache_write, output_in_window } = *reading;
    patch.put("lastInputTokens", num(input));
    patch.put("lastOutputTokens", num(output));
    patch.put("lastCachedReadTokens", num(cached_read));
    patch.put("lastCacheWriteTokens", num(cache_write));
    patch.put("lastUncachedInputTokens", num(uncached_input_tokens(input_excludes_cache, input, cached_read, cache_write)));
    let prompt = if input_excludes_cache { input + cached_read + cache_write } else { input };
    patch.put("lastContextTokens", num(prompt + if output_in_window { output } else { 0.0 }));
    patch.put("lastContextTokensUpdatedAt", num(ts));
    patch.put("lastContextTokensStaleAfterCompact", Value::Bool(false));
}

/// The last call's measured prompt split.
#[derive(Clone, Copy)]
struct Reading {
    input: f64,
    output: f64,
    cached_read: f64,
    cache_write: f64,
    output_in_window: bool,
}

/// `persistIterationMetrics(delta)`: one model call of the session, from Node's `usageDeltaEvent`.
/// `now` is `Date.now()`, for a delta that carries no `ts`.
///
/// Node keeps an idempotency set per session so that a retried report of the same call counts once;
/// a call here is reported once, so every report counts.
pub fn iteration_metrics(session: &Header, delta: &Value, input_excludes_cache: bool, now: f64) -> HeaderPatch {
    let mut patch = HeaderPatch::default();
    let stated_ts = number_or_zero(delta.get("ts"));
    let ts = if stated_ts == 0.0 { now } else { stated_ts };
    // `resolveUsageMetricsEpoch`: the loop's epoch, or one more when the iteration counter went back
    // without the loop saying so.
    let stored_epoch = number_or_zero(session.get("usageMetricsEpoch"));
    let mut epoch = stored_epoch;
    let stated = delta.get("usageMetricsEpoch").filter(|value| !value.is_null()).map(|value| number(Some(value))).filter(|n| n.is_finite());
    if let Some(stated) = stated {
        epoch = epoch.max(stated);
    }
    let index = number(delta.get("iterationIndex"));
    let previous = session.get("lastIterationIndex").and_then(Value::as_f64);
    if stated.is_none() && index.is_finite() && previous.is_some_and(|previous| index < previous) {
        epoch += 1.0;
    }
    if epoch != stored_epoch {
        patch.put("usageMetricsEpoch", num(epoch));
    }
    accumulate(session, &mut patch, delta, input_excludes_cache);
    patch.put("usageReadout", fold_usage_readout(session.get("usageReadout"), delta, delta.get("requestMs")));
    // `recordLastContextTokens(session, iterationContext(delta))`: each context field defaults to the
    // delta's own token count when the delta does not state it.
    let context = |key: &str, fallback: &str| delta.get(key).or_else(|| delta.get(fallback));
    let (input, output) = (context("contextInputTokens", "deltaInput"), context("contextOutputTokens", "deltaOutput"));
    let (cached_read, cache_write) = (context("contextCachedReadTokens", "deltaCachedRead"), context("contextCacheWriteTokens", "deltaCacheWrite"));
    let measured = if input_excludes_cache { number_or_zero(cached_read) + number_or_zero(cache_write) } else { 0.0 };
    let prompt = number_or_zero(input) + measured;
    if prompt <= 0.0 {
        if !apply_occupancy(&mut patch, delta.get("contextMeasuredTokens"), output, ts) {
            clear_last(&mut patch, ts);
        }
    } else {
        let in_window = delta.get("contextOutputInWindow") == Some(&Value::Bool(true));
        let reading = Reading {
            input: number_or_zero(input),
            output: number_or_zero(output),
            cached_read: number_or_zero(cached_read),
            cache_write: number_or_zero(cache_write),
            output_in_window: in_window,
        };
        set_last(&mut patch, &reading, input_excludes_cache, ts);
    }
    patch.put("lastIterationIndex", delta.get("iterationIndex").cloned().unwrap_or(Value::Null));
    patch.put("updatedAt", num(ts));
    patch
}

/// What `applyAskTerminalUsageTotals(session, result, { skipTotalsIfIncremental })` reads of a finished
/// ask. `usage` and `last_turn` are Node's normalized usage records (`inputTokens`, `outputTokens`,
/// `cachedTokens`, `cacheWriteTokens`, `reasoningTokens`, `reasoningTokensComplete`).
pub struct TerminalUsage<'a> {
    /// `result.usage`, the ask's aggregate; `None` for an ask that made no measured call.
    pub usage: Option<&'a Value>,
    /// `result.lastTurnUsage || result.usage || {}`.
    pub last_turn: &'a Value,
    /// `result.toolCallsTotal`.
    pub tool_calls_total: f64,
    /// `runtime.usageMetricsTurnIncremental === true`: every call already counted its own usage.
    pub incremental: bool,
    pub input_excludes_cache: bool,
    /// `Date.now()`.
    pub now: f64,
}

/// `applyAskTerminalUsageTotals(session, result, options)`.
pub fn terminal_usage(session: &Header, ask: &TerminalUsage<'_>) -> HeaderPatch {
    let mut patch = HeaderPatch::default();
    let Some(usage) = ask.usage else {
        let (tokens, _) = reasoning_of(session.get("reasoningUsage"));
        patch.put("reasoningUsage", reasoning_value(tokens, false));
        return patch;
    };
    if !ask.incremental {
        let (reasoning_tokens, reasoning_complete) = reasoning_of(Some(usage));
        let delta = json!({
            "deltaInput": number_or_zero(usage.get("inputTokens")),
            "deltaOutput": number_or_zero(usage.get("outputTokens")),
            "deltaToolCalls": ask.tool_calls_total,
            "reasoningTokens": reasoning_tokens,
            "reasoningTokensComplete": reasoning_complete,
            "deltaCachedRead": number_or_zero(usage.get("cachedTokens")),
            "deltaCacheWrite": number_or_zero(usage.get("cacheWriteTokens")),
        });
        accumulate(session, &mut patch, &delta, ask.input_excludes_cache);
    }
    let last = ask.last_turn;
    let stated = |key: &str| last.get(key).filter(|value| !value.is_null());
    let context_input = stated("contextInputTokens").or_else(|| stated("inputTokens"));
    let measured_input = number_or_zero(context_input);
    let measured_cache = if ask.input_excludes_cache { number_or_zero(last.get("cachedTokens")) + number_or_zero(last.get("cacheWriteTokens")) } else { 0.0 };
    if measured_input + measured_cache <= 0.0 {
        if !apply_occupancy(&mut patch, last.get("contextTokens"), last.get("outputTokens"), ask.now) {
            clear_last(&mut patch, ask.now);
        }
        return patch;
    }
    let cached_read = stated("contextCachedTokens").or_else(|| stated("cachedTokens"));
    let reading = Reading {
        input: measured_input,
        output: number_or_zero(stated("outputTokens")),
        cached_read: number_or_zero(cached_read),
        cache_write: number_or_zero(stated("cacheWriteTokens")),
        output_in_window: stated("contextInputTokens").is_some(),
    };
    set_last(&mut patch, &reading, ask.input_excludes_cache, ask.now);
    patch
}

/// `bumpUsageMetricsTurnId(session)`: the monotonic per-ask id usage idempotency is scoped by.
pub fn bump_turn_id(session: &Header) -> HeaderPatch {
    let mut patch = HeaderPatch::default();
    patch.put("usageMetricsTurnId", num(number_or_zero(session.get("usageMetricsTurnId")) + 1.0));
    patch
}

/// `bumpUsageMetricsEpoch(session)`: the loop restarted its iteration counter (a compaction).
pub fn bump_epoch(session: &Header) -> HeaderPatch {
    let mut patch = HeaderPatch::default();
    patch.put("usageMetricsEpoch", num(number_or_zero(session.get("usageMetricsEpoch")) + 1.0));
    patch
}

/// `measuredContextTokens(usage)` (`loop/usage.mjs`): the provider-measured whole-context occupancy (Cursor's
/// checkpoint `usedTokens`, kept on `Usage.raw.context_tokens` by `cursor-wire-stream-sink.mjs`), when it is a
/// positive number; it feeds the context gauge when the provider reports no prompt count.
pub fn measured_context_tokens(usage: &mixdog_core_api::domain::provider::Usage) -> Option<u64> {
    let value = usage.raw.as_ref()?.get("context_tokens")?.as_f64()?;
    (value.is_finite() && value > 0.0).then(|| round(value) as u64)
}

#[cfg(test)]
mod measured_tests {
    use super::measured_context_tokens;
    use mixdog_core_api::domain::provider::Usage;
    use serde_json::json;

    /// `measuredContextTokens(usage)`: a positive provider-measured figure, rounded as `Math.round` does.
    #[test]
    fn a_positive_measured_occupancy_is_kept_rounded_and_anything_else_is_not() {
        let with = |raw| Usage { raw: Some(raw), ..Default::default() };
        assert_eq!(measured_context_tokens(&with(json!({ "context_tokens": 7000.6 }))), Some(7001));
        assert_eq!(measured_context_tokens(&with(json!({ "context_tokens": 0 }))), None);
        assert_eq!(measured_context_tokens(&with(json!({ "other": 5 }))), None);
        assert_eq!(measured_context_tokens(&Usage::default()), None);
    }
}
