//! The decision layer of Gemini explicit `cachedContents`
//! (`gemini-cache-policy.mjs`, `gemini-cache.mjs`, `gemini-request-body.mjs`):
//! tunables, prefix identity, whether a session's saved cache can be attached
//! or reused, and the two request bodies. Pure functions of their inputs.

use mixdog_js::js_trim;
use mixdog_js::json_stringify;
use mixdog_js::number_to_string;
use mixdog_js::string_to_number;
use mixdog_js::utf16_len;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::hash::stable_stringify;
use super::hash::trace_hash;
use mixdog_core_api::domain::provider::GeminiCacheState;

/// `geminiCacheTunables()`.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Tuning {
    /// The prefix is rebuilt every N iterations so recent turns enter it.
    pub refresh_every_n: f64,
    pub ttl_seconds: f64,
    /// `MIXDOG_GEMINI_EXPLICIT_CACHE` is `0`/`false`/`off`/`no`.
    pub disabled: bool,
    /// `PROVIDER_CACHE_CREATE_TOTAL_TIMEOUT_MS` (`stall-policy.mjs`): the
    /// whole `cachedContents.create`, in ms.
    pub create_total_ms: f64,
    /// `PROVIDER_CACHE_CREATE_TIMEOUT_MS`: one `cachedContents.create` attempt.
    pub create_attempt_ms: f64,
    /// `PROVIDER_RETRY_JITTER_RATIO`: `withRetry`'s symmetric backoff jitter.
    pub retry_jitter_ratio: f64,
}

/// `Number.parseInt(text, 10)` for the `STALL_TIMEOUT_S` reading: optional
/// sign, then the leading decimal digits; none is NaN.
fn parse_int(text: &str) -> f64 {
    let text = text.trim_start_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    let (negative, digits) = match text.as_bytes().first() {
        Some(b'-') => (true, &text[1..]),
        Some(b'+') => (false, &text[1..]),
        _ => (false, text),
    };
    let end = digits.bytes().take_while(u8::is_ascii_digit).count();
    if end == 0 {
        return f64::NAN;
    }
    let n: f64 = digits[..end].parse().unwrap_or(f64::INFINITY);
    if negative { -n } else { n }
}

/// `resolveTimeoutMs`: the first env name holding a positive number, clamped,
/// else the fallback, clamped.
fn resolve_timeout_ms(get: &impl Fn(&str) -> Option<String>, names: &[&str], fallback: f64, min: f64, max: f64) -> f64 {
    for name in names {
        if let Some(raw) = get(name).filter(|r| !r.is_empty()) {
            let n = string_to_number(&raw);
            if n.is_finite() && n > 0.0 {
                return n.max(min).min(max);
            }
        }
    }
    fallback.max(min).min(max)
}

/// `stall-policy.mjs`: the provider deadlines derive from the stall thresholds. The stall warning
/// window in ms and `PROVIDER_MAX_BEFORE_WARN_MS`.
fn stall_windows_ms(get: &impl Fn(&str) -> Option<String>) -> (f64, f64) {
    let abort_s = get("STALL_TIMEOUT_S").map_or(f64::NAN, |v| parse_int(&v));
    let abort_s = if abort_s.is_finite() && abort_s > 0.0 { abort_s } else { 600.0 };
    let warn_s = if abort_s > 300.0 { 300.0 } else { (abort_s / 2.0).floor() };
    (warn_s * 1000.0, (warn_s * 1000.0 - 15_000.0).max(1000.0))
}

/// `PROVIDER_FIRST_BYTE_TIMEOUT_MS` and `PROVIDER_SSE_IDLE_TIMEOUT_MS` in ms.
pub fn stall_deadlines_ms(get: impl Fn(&str) -> Option<String>) -> (f64, f64) {
    let (warn_ms, max_before_warn) = stall_windows_ms(&get);
    let first_byte = resolve_timeout_ms(&get, &["MIXDOG_PROVIDER_FIRST_BYTE_TIMEOUT_MS"], 60_000.0, 30_000.0, max_before_warn);
    let sse_idle = resolve_timeout_ms(&get, &["MIXDOG_PROVIDER_SSE_IDLE_TIMEOUT_MS"], 120_000.0, 10_000.0, warn_ms);
    (first_byte, sse_idle)
}

impl Tuning {
    /// From the process environment, read once by the caller.
    pub fn from_env(get: impl Fn(&str) -> Option<String>) -> Self {
        let (_, max_before_warn) = stall_windows_ms(&get);
        let first_byte =
            resolve_timeout_ms(&get, &["MIXDOG_PROVIDER_FIRST_BYTE_TIMEOUT_MS"], 60_000.0, 30_000.0, max_before_warn);
        let generate_total = resolve_timeout_ms(
            &get,
            &["MIXDOG_PROVIDER_GENERATE_TOTAL_TIMEOUT_MS"],
            max_before_warn,
            first_byte,
            max_before_warn,
        );
        let create_attempt_ms = resolve_timeout_ms(
            &get,
            &["MIXDOG_PROVIDER_CACHE_CREATE_TIMEOUT_MS"],
            generate_total.min(120_000.0),
            30_000.0,
            max_before_warn,
        );
        // `Number(raw)`: unset is NaN (default), an empty string is 0.
        let jitter = get("MIXDOG_PROVIDER_RETRY_JITTER_RATIO").map_or(f64::NAN, |v| string_to_number(&v));
        let retry_jitter_ratio = if jitter.is_finite() && jitter >= 0.0 { jitter.min(1.0) } else { 0.2 };
        let create_total_ms = resolve_timeout_ms(
            &get,
            &["MIXDOG_PROVIDER_CACHE_CREATE_TOTAL_TIMEOUT_MS"],
            generate_total.min(180_000.0),
            30_000.0,
            max_before_warn,
        );
        let positive = |name: &str, default: f64| {
            let n = get(name).map_or(f64::NAN, |v| string_to_number(&v));
            if n > 0.0 { n } else { default }
        };
        let mode = get("MIXDOG_GEMINI_EXPLICIT_CACHE").unwrap_or_default();
        let mode = js_trim(&mode).to_lowercase();
        Self {
            refresh_every_n: positive("MIXDOG_GEMINI_CACHE_REFRESH_EVERY", 4.0),
            ttl_seconds: positive("MIXDOG_GEMINI_CACHE_TTL_SECONDS", 300.0),
            disabled: ["0", "false", "off", "no"].contains(&mode.as_str()),
            create_total_ms,
            create_attempt_ms,
            retry_jitter_ratio,
        }
    }
}

impl Default for Tuning {
    fn default() -> Self {
        Self::from_env(|_| None)
    }
}

/// The request parts a cache prefix is made of (Node `{ systemInstruction,
/// geminiTools, toolConfig, contents }`). `system_instruction` is the text.
#[derive(Clone, Copy, Debug)]
pub struct CacheRequest<'a> {
    pub system_instruction: &'a str,
    pub tools: &'a [Value],
    pub tool_config: Option<&'a Value>,
    pub contents: &'a [Value],
}

/// `geminiBareModelId`: the model id without a `models/` prefix (any case).
pub fn bare_model_id(model: &str) -> &str {
    match model.get(..7) {
        Some(head) if head.eq_ignore_ascii_case("models/") => &model[7..],
        _ => model,
    }
}

/// Minimum prefix tokens for an explicit cache, or `None` when the docs exclude
/// the model (Gemini 4 and later). Gemini 2.5 Pro/Flash (not Lite) is 2048; every
/// other id keeps the conservative 4096 floor.
pub fn explicit_cache_min_tokens(model: &str) -> Option<u64> {
    let bare = bare_model_id(model).to_lowercase();
    if let Some(rest) = bare.strip_prefix("gemini-") {
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        if digits > 0 && rest[..digits].parse::<u64>().map_or(true, |major| major >= 4) {
            return None;
        }
    }
    if let Some(tail) = bare.strip_prefix("gemini-2.5-") {
        for family in ["pro", "flash"] {
            if let Some(after) = tail.strip_prefix(family) {
                // `(?!-lite)(?:-|$)`
                if after.is_empty() || (after.starts_with('-') && !after.starts_with("-lite")) {
                    return Some(2048);
                }
            }
        }
    }
    Some(4096)
}

/// `_geminiCachePrefixCount`: every content but the latest turn.
pub fn prefix_count(contents: &[Value]) -> usize {
    contents.len().saturating_sub(1)
}

/// `_geminiCachePrefixContents`: the first `count` contents, role collapsed to
/// `user`/`model` (cachedContents accepts only those), parts kept.
pub fn prefix_contents(contents: &[Value], count: usize) -> Vec<Value> {
    contents
        .iter()
        .take(count)
        .map(|c| {
            let role = match c.get("role").and_then(Value::as_str) {
                Some("model") => "model",
                _ => "user",
            };
            let parts = c.get("parts").filter(|p| p.is_array()).cloned().unwrap_or_else(|| json!([]));
            json!({"role": role, "parts": parts})
        })
        .collect()
}

fn truthy_text(text: &str) -> Value {
    if text.is_empty() { Value::Null } else { Value::String(text.to_owned()) }
}

/// `_geminiCachePrefixHash`.
pub fn prefix_hash(model: &str, request: &CacheRequest<'_>, count: usize) -> String {
    trace_hash(&stable_stringify(&json!({
        "model": truthy_text(model),
        "systemInstruction": request.system_instruction,
        "tools": request.tools,
        "toolConfig": request.tool_config,
        "contents": prefix_contents(request.contents, count),
    })))
}

/// `_geminiCredentialFingerprint`.
pub fn credential_fingerprint(api_key: &str) -> String {
    trace_hash(api_key)
}

/// `_geminiGlobalCacheKey`.
pub fn global_cache_key(credential_fingerprint: &str, model: &str, prefix_hash: &str, prefix_count: usize) -> String {
    trace_hash(&stable_stringify(&json!({
        "credentialFingerprint": truthy_text(credential_fingerprint),
        "model": truthy_text(model),
        "cachePrefixHash": prefix_hash,
        "cachePrefixContentCount": prefix_count,
    })))
}

/// `_estimateGeminiCacheTokens`: UTF-16 chars / 4 of the system text, tools and
/// every content but the last.
pub fn estimate_tokens(request: &CacheRequest<'_>) -> u64 {
    let mut chars = utf16_len(request.system_instruction);
    if !request.tools.is_empty() {
        chars += utf16_len(&json_stringify(&Value::Array(request.tools.to_vec())));
    }
    if request.contents.len() > 1 {
        for content in &request.contents[..request.contents.len() - 1] {
            let parts = content.get("parts").filter(|p| !p.is_null()).cloned().unwrap_or_else(|| json!(""));
            chars += utf16_len(&json_stringify(&parts));
        }
    }
    chars.div_ceil(4) as u64
}

/// `geminiPrefixBelowMinimum`: a model excluded from explicit caching, or a
/// prefix under the model's floor, never creates a cache.
pub fn prefix_below_minimum(model: &str, request: &CacheRequest<'_>) -> bool {
    match explicit_cache_min_tokens(model) {
        Some(min) => estimate_tokens(request) < min,
        None => true,
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Decision {
    pub can_attach: bool,
    pub can_reuse: bool,
}

/// `geminiCacheStateDecision`: whether the session's recorded cache can still
/// be attached (live TTL, same model, credential and prefix) and whether it is
/// fresh enough to reuse outright. Reuse needs TTL headroom (25% of the TTL,
/// clamped to 10 s..6 min) so a cache never expires mid-request.
pub fn decide(
    state: Option<&GeminiCacheState>,
    model: &str,
    credential_fingerprint: &str,
    request: &CacheRequest<'_>,
    current_iter: u32,
    now_ms: u64,
    tuning: &Tuning,
) -> Decision {
    let Some(state) = state.filter(|s| !s.cache_name.is_empty()) else {
        return Decision { can_attach: false, can_reuse: false };
    };
    let headroom_ms = (tuning.ttl_seconds * 250.0).max(10_000.0).min(360_000.0);
    let live_ms = state.cache_expires_at as f64 - now_ms as f64;
    let iters_since_create = f64::from(current_iter) - f64::from(state.cache_created_at_iter);
    let prefix_matches = state.cache_prefix_content_count <= request.contents.len()
        && !state.cache_prefix_hash.is_empty()
        && state.cache_prefix_hash == prefix_hash(model, request, state.cache_prefix_content_count);
    let can_attach = live_ms > 0.0
        && state.cache_model == model
        && state.cache_credential_fingerprint == credential_fingerprint
        && prefix_matches;
    Decision { can_attach, can_reuse: can_attach && live_ms > headroom_ms && iters_since_create < tuning.refresh_every_n }
}

/// `geminiCacheCreateBody`: system/tools/toolConfig plus the conversation prefix.
pub fn create_body(model: &str, tuning: &Tuning, request: &CacheRequest<'_>, count: usize) -> Value {
    let mut body = Map::new();
    body.insert("model".into(), json!(format!("models/{}", bare_model_id(model))));
    body.insert("ttl".into(), json!(format!("{}s", number_to_string(tuning.ttl_seconds))));
    if !request.system_instruction.is_empty() {
        body.insert("systemInstruction".into(), json!({"parts": [{"text": request.system_instruction}]}));
    }
    if !request.tools.is_empty() {
        body.insert("tools".into(), Value::Array(request.tools.to_vec()));
    }
    if let Some(config) = request.tool_config {
        body.insert("toolConfig".into(), config.clone());
    }
    let contents = prefix_contents(request.contents, count);
    if !contents.is_empty() {
        body.insert("contents".into(), Value::Array(contents));
    }
    Value::Object(body)
}

/// `geminiCachedRestBody`: the generateContent body for an attached cache. The
/// cache carries system/tools/toolConfig and the recorded prefix; every
/// uncached tail turn is sent, and the last turn when nothing is left.
pub fn cached_body(cache_name: &str, state: &GeminiCacheState, contents: &[Value], generation_config: Option<&Value>) -> Value {
    let from = state.cache_prefix_content_count.min(contents.len());
    let delta = &contents[from..];
    let sent: Vec<Value> = if delta.is_empty() { contents.last().cloned().into_iter().collect() } else { delta.to_vec() };
    let mut body = Map::new();
    body.insert("contents".into(), Value::Array(sent));
    body.insert("cachedContent".into(), json!(cache_name));
    if let Some(config) = generation_config {
        body.insert("generationConfig".into(), config.clone());
    }
    Value::Object(body)
}
