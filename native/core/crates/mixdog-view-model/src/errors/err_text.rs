//! The one user-facing text of a failure and the labels built on it (`err-text.mjs`): `errText` (the message of anything
//! thrown), `presentErrorText` (the sentence every surface shows), the retry status line and the compact failure label of
//! a background task or agent card.

use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::js_trim;
use mixdog_js::json_stringify;
use mixdog_js::math::round;
use mixdog_js::slice_utf16;
use mixdog_js::utf16_len;
use serde_json::Value;

use super::error_presentation::describe_error;
use super::error_presentation::safe_error_details;
use super::js_value::Js;
use super::js_value::get;
use super::js_value::is_error_instance;
use super::js_value::is_object;
use super::js_value::js_string;
use super::js_value::num_text;
use super::js_value::number;
use super::js_value::number_or_zero;
use super::js_value::path;
use super::js_value::str_of;
use super::js_value::string_or_empty;
use super::js_value::truthy;
use super::provider_timeout_phase::IDLE;
use super::provider_timeout_phase::is_first_byte_timeout;
use super::transport_error_text::transport_error_text;

macro_rules! js_re {
    ($name:ident, $pattern:expr, $flags:expr) => {
        static $name: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static($pattern, $flags));
    };
}

js_re!(ERROR_PREFIX, r"^\s*(?:\[[^\]]*error[^\]]*\]|error)\s*[:-]\s*", "i");
js_re!(EMBEDDED_ERROR, r"^\s*(?:error|failure|failed)\s*[:=]\s*(.+?)\s*$", "i");
js_re!(WHITESPACE, r"\s+", "");
js_re!(MINUTES_TOKEN, r"^(\d+)m$", "");
js_re!(SECONDS_TOKEN, r"^(\d+)s$", "");
js_re!(MILLIS_TOKEN, r"^(\d+)ms$", "");
js_re!(WATCHDOG_FIRST_RESPONSE, r"first response stale\s*\((\d+)ms\)", "i");
js_re!(WATCHDOG_STALE, r"(?:agent )?(?:task|tool running) stale\s*\((\d+)ms", "i");
js_re!(NORMALIZED_TIMEOUT, r"no first response from (?:the )?[\w\s]*within (\d+m|\d+s|\d+ms)", "i");
js_re!(NORMALIZED_STALE, r"went stale after (\d+m|\d+s|\d+ms)", "i");
js_re!(ERROR_COLON, r"^error:\s*", "i");
js_re!(ERROR_COLON_LINE, r"^error\s*:", "i");
js_re!(ABORTED_BY_SESSION_CLOSE, r"aborted by session close", "i");
js_re!(RETRY_ABORTED, r"withRetry:\s*(?:sleep )?aborted", "i");
js_re!(SLEEP_ABORTED, r"^sleep aborted$", "i");
js_re!(TIMED_OUT, r"(?:timed out after|within) (\d+)ms", "i");
js_re!(LATEST_TURN, r"The latest message cannot fit this model \(LATEST_TURN_EXCEEDS_CONTEXT\)[\s\S]*$", "");
js_re!(TOOL_SURFACE, r"\(TOOL_SURFACE_EXCEEDS_CONTEXT\)", "");
js_re!(AT_CAPACITY, r"currently at capacity|at capacity due to high demand|provider overloaded|server overloaded", "i");
js_re!(AUTH_TEXT, r"\b(?:invalid|expired)\s+(?:api[ _-]?key|access token|credentials?)\b", "i");
js_re!(CONTEXT_TOO_LARGE, r"\bAGENT_CONTEXT_OVERFLOW\b|agent context overflow|latest turn cannot fit|context budget|context window", "i");
js_re!(COMPACT_FAILED, r"\bcompact(?:ion)?\b.*\b(?:failed|error|overflow)\b|\b(?:failed|error)\b.*\bcompact(?:ion)?\b", "i");
js_re!(QUOTA_RETRY, r"retryAfter=([^\s:]+)", "i");
js_re!(RATE_LIMIT_TEXT, r"\b429\b|rate[_ -]?limit|quota|too many requests|resource exhausted|insufficient_quota|quota_exceeded", "i");
js_re!(ANTHROPIC_OAUTH, r"Anthropic OAuth", "i");
js_re!(COOLDOWN, r"cooldown", "i");
js_re!(INACTIVITY, r"timed out after (\d+)ms of inactivity", "i");
js_re!(FIRST_BYTE, r"first byte timed out after (\d+)ms", "i");
js_re!(FIRST_TRANSPORT_STALE, r"first (?:transport|semantic response) stale\s*\((\d+)ms\)", "i");
js_re!(FIRST_RESPONSE_STALE, r"(?:agent\s+)?first response stale\s*\((\d+)ms\)", "i");
js_re!(AGENT_STALE, r"agent (?:task|tool running) stale\s*\((\d+)ms[^)]*\)", "i");
js_re!(TOOL_STALE, r"tool running stale\s*\((\d+)ms[^)]*\)", "i");
js_re!(TASK_STALE, r"task stale\s*\((\d+)ms[^)]*\)", "i");
js_re!(SESSION_ABORTED_DURING_CALL, r#"Session\s+"sess_[^"]+"\s+closed:\s*aborted during call"#, "i");
js_re!(SESSION_CLOSED_DURING_CALL, r#"Session\s+"sess_[^"]+"\s+closed:\s*closed during call"#, "i");
js_re!(SESSION_CLOSED, r"^Session closed:\s*(?:closeSession|closed|aborted)\b", "i");
js_re!(PARENT_ABORTED, r"parent signal aborted", "i");
js_re!(SESSION_PREFIX, r#"Session\s+"sess_[^"]+"\s+closed:\s*"#, "i");
js_re!(SESSION_ID, r"\bsess_[A-Za-z0-9_-]+\b", "");
js_re!(RUN_ID, r"\brun_[A-Za-z0-9_-]{16,}\b", "");
js_re!(TERMINAL_STATUS, r"^(failed|error|timeout|cancelled|canceled|killed)$", "i");
js_re!(CANCELLED_STATUS, r"^(cancelled|canceled)$", "i");
js_re!(TIMEOUT_STATUS, r"^timeout$", "i");
js_re!(FIRST_RESPONSE_STALE_RAW, r"first response stale", "i");
js_re!(NO_FIRST_RESPONSE, r"no first response from", "i");
js_re!(WATCHDOG_PRESENTED, r"^(?:Model still thinking|Agent watchdog stopped the run):", "");
js_re!(STALE_RAW, r"(?:agent )?(?:task|tool running) stale|went stale without", "i");
js_re!(WENT_STALE, r"went stale after", "i");
js_re!(CONTEXT_TOO_LARGE_PRESENTED, r"\bcontext too large\b", "i");
js_re!(TRAILING_PERIOD, r"\.$", "");

/// `presentErrorText`'s options.
#[derive(Clone, Copy, Debug, Default)]
pub struct PresentOptions<'a> {
    /// `options.surface || options.tool`: which surface shows the text (`turn`, `agent`, `web_search`, `compact`, a tool name).
    pub surface: &'a str,
    /// The longest text; Node's default is 240.
    pub max: Option<f64>,
    /// The caller's own provider name, for a first-byte timeout.
    pub provider_label: Option<&'a str>,
    /// `Date.now()` for a reset time the text names; the wall clock when `None`.
    pub now_ms: Option<f64>,
}

/// The HTTP status carried by a provider/transport error, or 0 when absent.
pub fn error_http_status(err: Js) -> f64 {
    let picked = [get(err, "httpStatus"), get(err, "status"), path(err, &["response", "status"])].into_iter().find(|value| truthy(*value));
    picked.map_or(0.0, number_or_zero)
}

/// The message of anything thrown: a string as is, an `Error` its message or name, a plain object or event the first of
/// its message, nested error/reason, event type or JSON.
pub fn err_text(e: Js) -> String {
    let Some(value) = e else { return "undefined".into() };
    match value {
        Value::Null => return "null".into(),
        Value::String(text) => return text.clone(),
        _ => {}
    }
    if is_error_instance(e) {
        let message = get(e, "message");
        if truthy(message) {
            return js_string(message);
        }
        // `name` is inherited from `Error.prototype` when the error carries none of its own.
        let name = get(e, "name");
        if name.is_none() || truthy(name) {
            return name.map_or_else(|| "Error".into(), |name| js_string(Some(name)));
        }
        // `String(error)` with an empty name is the message.
        return message.map_or_else(String::new, |message| js_string(Some(message)));
    }
    // ErrorEvent / event-like / plain object (NOT instanceof Error)
    if let Some(message) = str_of(get(e, "message")).filter(|message| !message.is_empty()) {
        return message.to_owned();
    }
    for key in ["error", "reason"] {
        if let Some(inner) = get(e, key).filter(|inner| !inner.is_null()) {
            return err_text(Some(inner));
        }
    }
    if let Some(kind) = str_of(get(e, "type")).filter(|kind| !kind.is_empty()) {
        return format!("{kind} event");
    }
    let json = json_stringify(value);
    if !json.is_empty() && json != "{}" && json != "null" {
        return json;
    }
    js_string(e)
}

fn strip_error_prefix(value: &str) -> String {
    let stripped = ERROR_PREFIX.find(value).filter(|found| found.start == 0).map_or(value, |found| &value[found.end..]);
    js_trim(stripped).to_owned()
}

fn extract_json_error(text: &str) -> Option<String> {
    let value = js_trim(text);
    if !value.starts_with('{') && !value.starts_with('[') {
        return None;
    }
    let parsed = mixdog_js::json_parse(value).ok()?;
    let Value::Object(_) = &parsed else { return None };
    let parsed = Some(&parsed);
    if let Some(error) = str_of(get(parsed, "error")).filter(|error| !js_trim(error).is_empty()) {
        return Some(error.to_owned());
    }
    if let Some(message) = str_of(get(parsed, "message")).filter(|message| !js_trim(message).is_empty()) {
        return Some(message.to_owned());
    }
    get(parsed, "error").filter(|error| !error.is_null()).map(|error| err_text(Some(error)))
}

fn extract_embedded_error(text: &str) -> Option<String> {
    // `split(/\r?\n/)`: a carriage return before a line feed belongs to the separator.
    let mut lines: Vec<&str> = text.split('\n').collect();
    let last = lines.len() - 1;
    for line in lines.iter_mut().take(last) {
        *line = line.strip_suffix('\r').unwrap_or(line);
    }
    lines.into_iter().find_map(|line| EMBEDDED_ERROR.captures(line).and_then(|found| found.get(1)).filter(|found| !found.is_empty()).map(str::to_owned))
}

fn digits(text: &str) -> f64 {
    text.parse().unwrap_or(f64::NAN)
}

/// `formatDurationMs`: `90000` is `90s`, `120000` is `2m`, `800` is `800ms`.
pub fn format_duration_ms(value: f64) -> String {
    let ms = if value.is_nan() { 0.0 } else { value.max(0.0) };
    if ms >= 60_000.0 && ms % 60_000.0 == 0.0 {
        return format!("{}m", num_text(round(ms / 60_000.0)));
    }
    if ms >= 1_000.0 {
        return format!("{}s", num_text(round(ms / 1_000.0)));
    }
    format!("{}ms", num_text(ms))
}

fn compact_duration_for_status(value: f64, prefer_minutes: bool) -> String {
    let ms = if value.is_nan() { 0.0 } else { value.max(0.0) };
    if ms >= 1_000.0 {
        if prefer_minutes && ms >= 60_000.0 && ms % 60_000.0 == 0.0 {
            return format!("{}m", num_text(round(ms / 60_000.0)));
        }
        if ms < 600_000.0 && ms % 1_000.0 == 0.0 {
            return format!("{}s", num_text(round(ms / 1_000.0)));
        }
        if ms >= 60_000.0 && ms % 60_000.0 == 0.0 {
            return format!("{}m", num_text(round(ms / 60_000.0)));
        }
        return format!("{}s", num_text(round(ms / 1_000.0)));
    }
    format!("{}ms", num_text(ms))
}

fn parse_duration_token_ms(token: &str) -> f64 {
    let token = mixdog_js::js_to_lowercase(js_trim(token));
    let captured = |re: &JsRegex| re.captures(&token).and_then(|found| found.get(1)).map(digits);
    if let Some(minutes) = captured(&MINUTES_TOKEN) {
        return minutes * 60_000.0;
    }
    if let Some(seconds) = captured(&SECONDS_TOKEN) {
        return seconds * 1_000.0;
    }
    captured(&MILLIS_TOKEN).unwrap_or(f64::NAN)
}

fn humanize_retry_after_token(token: &str) -> String {
    let ms = parse_duration_token_ms(token);
    if !ms.is_finite() || ms < 60_000.0 {
        return token.to_owned();
    }
    let total_seconds = (ms / 1_000.0).floor();
    let days = (total_seconds / 86_400.0).floor();
    let hours = ((total_seconds % 86_400.0) / 3_600.0).floor();
    let minutes = ((total_seconds % 3_600.0) / 60.0).floor();
    let seconds = total_seconds % 60.0;
    let mut parts = Vec::new();
    if days != 0.0 {
        parts.push(format!("{}d", num_text(days)));
    }
    if hours != 0.0 {
        parts.push(format!("{}h", num_text(hours)));
    }
    if minutes != 0.0 {
        parts.push(format!("{}m", num_text(minutes)));
    }
    if days == 0.0 && hours == 0.0 && seconds != 0.0 {
        parts.push(format!("{}s", num_text(seconds)));
    }
    if parts.is_empty() { token.to_owned() } else { parts.join(" ") }
}

#[derive(Clone, Copy, PartialEq)]
enum WatchdogKind {
    Timeout,
    Stale,
}

fn watchdog_ms_from_raw_error(raw: &str) -> Option<(WatchdogKind, f64)> {
    if let Some(found) = WATCHDOG_FIRST_RESPONSE.captures(raw) {
        return Some((WatchdogKind::Timeout, digits(found.get(1)?)));
    }
    WATCHDOG_STALE.captures(raw).and_then(|found| Some((WatchdogKind::Stale, digits(found.get(1)?))))
}

fn compact_reason_from_normalized_timeout(presented: &str) -> String {
    let Some(token) = NORMALIZED_TIMEOUT.captures(presented).and_then(|found| found.get(1)) else { return String::new() };
    let ms = parse_duration_token_ms(token);
    if ms.is_finite() { format!("No first response {}", compact_duration_for_status(ms, false)) } else { format!("No first response {token}") }
}

fn compact_reason_from_normalized_stale(presented: &str) -> String {
    let Some(token) = NORMALIZED_STALE.captures(presented).and_then(|found| found.get(1)) else { return String::new() };
    let ms = parse_duration_token_ms(token);
    if ms.is_finite() { format!("No progress {}", compact_duration_for_status(ms, true)) } else { format!("No progress {token}") }
}

/// True when a background task's body is nothing but its error line.
pub fn is_background_error_only_body(body: &str, error: &str, now_ms: Option<f64>) -> bool {
    let trimmed = js_trim(body);
    if trimmed.is_empty() {
        return false;
    }
    let err = js_trim(error);
    let lines: Vec<&str> = trimmed.split('\n').map(js_trim).filter(|line| !line.is_empty()).collect();
    if lines.len() != 1 {
        return false;
    }
    let line = lines[0];
    if ERROR_COLON.is_match(line) {
        return true;
    }
    if err.is_empty() {
        return false;
    }
    let stripped = strip_error_prefix(line);
    let presented = present_error_text(Some(&Value::String(err.to_owned())), &PresentOptions { max: Some(500.0), now_ms, ..PresentOptions::default() });
    line == err || line == format!("Error: {err}") || stripped == err || line == format!("Error: {presented}") || stripped == presented
}

fn subject_for_surface(surface: &str) -> &'static str {
    let value = mixdog_js::js_to_lowercase(surface);
    if value.contains("search") || value.contains("web") {
        return "web search agent";
    }
    if value == "turn" || value.contains("request") {
        return "request";
    }
    if value.contains("agent") || value.contains("task") {
        return "agent";
    }
    "tool"
}

fn capitalize(value: &str) -> String {
    let mut chars = value.chars();
    chars.next().map_or_else(String::new, |first| first.to_uppercase().chain(chars).collect())
}

fn cap_text(value: &str, max: f64) -> String {
    let text = js_trim(value);
    let limit = {
        let n = number_or_zero_f(max);
        let n = if n == 0.0 { 240.0 } else { n };
        n.max(32.0)
    };
    if (utf16_len(text) as f64) > limit {
        let keep = (limit - 3.0).max(1.0);
        return format!("{}...", slice_utf16(text, keep as usize));
    }
    text.to_owned()
}

fn number_or_zero_f(n: f64) -> f64 {
    if n.is_nan() { 0.0 } else { n }
}

/// True for a failure that is a cancellation: an abort, a closed session, a retry sleep cut short.
pub fn is_cancel_like_error(error: Js) -> bool {
    if !error.is_some_and(|error| !error.is_null()) {
        return false;
    }
    if is_object(error) {
        if get(error, "cancelled") == Some(&Value::Bool(true)) {
            return true;
        }
        if matches!(string_or_empty(get(error, "name")).as_str(), "SessionClosedError" | "AbortError" | "APIUserAbortError") {
            return true;
        }
    }
    let text = err_text(error);
    ABORTED_BY_SESSION_CLOSE.is_match(&text) || RETRY_ABORTED.is_match(&text) || SLEEP_ABORTED.is_match(&text)
}

// One-line reason per provider kind. Fixed sentences (optionally with a parenthesised value) are the renderer's
// translation keys.
fn kind_line(provider_kind: &str, retry_after_ms: Option<f64>) -> Option<String> {
    Some(match provider_kind {
        "overloaded" => "Provider is busy at capacity.".to_owned(),
        "rate_limited" => match retry_after_ms {
            Some(ms) if ms != 0.0 => format!("Provider is rate-limited (retry in {}).", format_duration_ms(ms)),
            _ => "Provider is rate-limited.".to_owned(),
        },
        "quota_exhausted" => "Provider usage limit reached.".to_owned(),
        "entitlement" => "Not included in your plan.".to_owned(),
        "billing" => "Out of credits or at spend limit.".to_owned(),
        "permission" => "Access denied by the provider.".to_owned(),
        "policy" => "Refused by the provider safety policy.".to_owned(),
        "auth" => "Provider authentication failed.".to_owned(),
        _ => return None,
    })
}

// Typed evidence: a persisted descriptor or structured status/code fields. A bare message carries none, so its wording keeps
// the text path.
fn has_typed_evidence(error: Js) -> bool {
    is_object(error)
        && (truthy(path(error, &["errorKind", "kind"])) || error_http_status(error) > 0.0 || truthy(get(error, "code")) || truthy(get(error, "retryAfterMs")))
}

// The window a provider timeout names (providerTimeoutError's message, or a first-byte watchdog's "within Nms"), or 0.
fn timed_out_ms(text: &str) -> f64 {
    number_or_zero_f(TIMED_OUT.captures(text).and_then(|found| found.get(1)).map_or(f64::NAN, digits))
}

// A provider timeout before the model produced anything (isFirstByteTimeout): the model is slow, not the connection. The
// provider name comes from the caller's own provider config, never from the error.
fn still_thinking_text(error: Js, text: &str, provider_label: Option<&str>) -> String {
    let waited = number_or_zero(get(error, "waitedMs").filter(|waited| truthy(Some(*waited))));
    let ms = if waited != 0.0 { waited } else { timed_out_ms(text) };
    let provider = provider_label.filter(|label| !label.is_empty()).unwrap_or("the provider");
    let attempts = number(get(error, "attempts"));
    let attempts = if attempts > 0.0 { format!("; attempts: {}", num_text(attempts.floor())) } else { String::new() };
    format!("Model still thinking: no output in {}; {provider} sent nothing yet{attempts}.", format_duration_ms(ms))
}

// Stamped provider timeout phases and stream cuts. `None` when the error names neither, so the text rules below decide.
fn typed_stream_failure_text(error: Js, text: &str, provider_label: Option<&str>) -> Option<String> {
    if !is_object(error) {
        return None;
    }
    if is_first_byte_timeout(error) {
        return Some(still_thinking_text(error, text, provider_label));
    }
    if str_of(get(error, "timeoutPhase")) == Some(IDLE) {
        let ms = timed_out_ms(text);
        return Some(if ms > 0.0 { format!("No progress {}.", format_duration_ms(ms)) } else { "No progress.".into() });
    }
    // A stream that ended before its finish marker lost its connection.
    if str_of(get(error, "code")) == Some("TRUNCATED_STREAM") && get(error, "streamCorruption") != Some(&Value::Bool(true)) {
        return Some("Connection to the provider was lost (TRUNCATED_STREAM).".into());
    }
    None
}

/// The one user-facing sentence of a failure: `presentErrorText(error, options)`.
pub fn present_error_text(error: Js, options: &PresentOptions) -> String {
    let presentation = describe_error(error, options.now_ms);
    if matches!(presentation.kind.as_str(), "image-size" | "payload-size" | "request" | "model-unavailable" | "tool-schema") {
        return presentation.summary;
    }
    if has_typed_evidence(error)
        && presentation.kind != "unknown"
        && let Some(line) = kind_line(presentation.provider_kind, presentation.retry_after_ms)
    {
        return line;
    }
    let surface = options.surface;
    let subject = subject_for_surface(surface);
    let max = options.max.unwrap_or(240.0);
    let mut text = err_text(error);
    let (name, code) =
        if is_object(error) { (string_or_empty(get(error, "name")), string_or_empty(get(error, "code"))) } else { (String::new(), String::new()) };
    let status = error_http_status(error);
    // The fixed request overhead error is actionable as written (sizes, contributors, remedy): keep its lines instead of a
    // generic "Context too large." that would suggest compacting.
    if code == "TOOL_SURFACE_EXCEEDS_CONTEXT" || TOOL_SURFACE.is_match(&text) {
        return strip_error_prefix(&text);
    }
    // Likewise a latest message that cannot fit names its size and what would help; a wrapper's prefix ("agent compact
    // failed (...): ") is dropped.
    if let Some(found) = LATEST_TURN.find(&text) {
        return text[found.start..].replacen(" (LATEST_TURN_EXCEEDS_CONTEXT)", "", 1);
    }
    if let Some(inner) = extract_json_error(&text).filter(|inner| !inner.is_empty()) {
        text = inner;
    }
    if let Some(embedded) = extract_embedded_error(&text) {
        text = embedded;
    }
    let text = js_trim(&WHITESPACE.replace_all_with(&strip_error_prefix(&text), |_| " ".into())).to_owned();
    if text.is_empty() {
        return "Unknown error".into();
    }
    if let Some(stream_failure) = typed_stream_failure_text(error, &text, options.provider_label) {
        return stream_failure;
    }

    if code == "PROVIDER_PREFIX_MUTATION" || name == "ProviderPrefixMutationError" {
        return "Session state changed unexpectedly.".into();
    }
    if AT_CAPACITY.is_match(&text) {
        return "Provider is busy at capacity.".into();
    }
    if status == 401.0 || status == 403.0 || AUTH_TEXT.is_match(&text) {
        return "Provider authentication failed.".into();
    }
    // Connection-level failures (errno / undici cause chain / bare fetch messages / gateway 5xx) collapse to one sentence
    // with the code kept.
    if let Some(transport) = transport_error_text(error) {
        return transport;
    }
    if CONTEXT_TOO_LARGE.is_match(&text) {
        return "Context too large.".into();
    }
    if COMPACT_FAILED.is_match(&text) {
        if mixdog_js::js_to_lowercase(surface).contains("compact") {
            return cap_text(&text, max);
        }
        return "Compact failed.".into();
    }

    let quota_retry = QUOTA_RETRY.captures(&text).and_then(|found| found.get(1)).map(str::to_owned);
    if RATE_LIMIT_TEXT.is_match(&text) {
        let provider = if ANTHROPIC_OAUTH.is_match(&text) { "Anthropic" } else { "Provider" };
        // Cooldown refusals are recoverable right now by switching accounts: surface that path instead of leaving only the
        // wait option.
        let hint = if COOLDOWN.is_match(&text) { " Re-login or switch the provider account to continue now." } else { "" };
        let retry =
            quota_retry.filter(|token| !token.is_empty()).map(|token| format!("; retry after {}", humanize_retry_after_token(&token))).unwrap_or_default();
        return format!("{provider} quota/rate limit hit{retry}.{hint}");
    }

    if is_cancel_like_error(error) || name == "SessionClosedError" {
        return if subject == "request" { "Cancelled".into() } else { format!("{} was cancelled.", capitalize(subject)) };
    }

    let inactivity = INACTIVITY.captures(&text).and_then(|found| found.get(1)).map(digits);
    if name == "StreamStalledError" || name == "StreamStalledAbortError" || code == "ESTREAMSTALL" || inactivity.is_some() {
        let ms = inactivity.unwrap_or(0.0);
        return if ms.is_finite() && ms > 0.0 { format!("No progress {}.", format_duration_ms(ms)) } else { "No progress.".into() };
    }

    let first_byte = FIRST_BYTE.captures(&text).and_then(|found| found.get(1)).map(digits);
    if name == "ProviderTimeoutError" || code == "EPROVIDERTIMEOUT" || first_byte.is_some() {
        let ms = first_byte.unwrap_or(0.0);
        return if ms.is_finite() && ms > 0.0 { format!("No first response {}.", format_duration_ms(ms)) } else { "No first response.".into() };
    }

    // The agent's own watchdog, worded apart from any provider timeout.
    if let Some(found) = FIRST_TRANSPORT_STALE.captures(&text) {
        return format!("Agent watchdog stopped the run: no model response in {}.", format_duration_ms(digits(found.get(1).unwrap_or(""))));
    }

    if let Some(found) = FIRST_RESPONSE_STALE.captures(&text) {
        return format!("No first response from the {subject} within {}.", format_duration_ms(digits(found.get(1).unwrap_or(""))));
    }

    let stale = AGENT_STALE.captures(&text).or_else(|| TOOL_STALE.captures(&text)).or_else(|| TASK_STALE.captures(&text));
    if let Some(found) = stale {
        return format!("The {subject} went stale after {} without new stream/tool progress.", format_duration_ms(digits(found.get(1).unwrap_or(""))));
    }

    if SESSION_ABORTED_DURING_CALL.is_match(&text) {
        return format!("{} stopped while waiting for a response.", capitalize(subject));
    }

    if SESSION_CLOSED_DURING_CALL.is_match(&text) {
        return format!("{} stopped before the response completed.", capitalize(subject));
    }

    if SESSION_CLOSED.is_match(&text) {
        return format!("{} stopped.", capitalize(subject));
    }

    if PARENT_ABORTED.is_match(&text) {
        return format!("{} was cancelled by its caller.", capitalize(subject));
    }

    let text = SESSION_PREFIX.replace_all_with(&text, |_| "Session closed: ".into());
    let text = SESSION_ID.replace_all_with(&text, |_| "session".into());
    let text = RUN_ID.replace_all_with(&text, |_| "run".into());
    let text = js_trim(&WHITESPACE.replace_all_with(&text, |_| " ".into())).to_owned();

    let safe = safe_error_details(&text);
    cap_text(if safe.is_empty() { "Unknown error" } else { &safe }, max)
}

/// Our own wording for a typed timeout retry (`first_response_timeout` / `stalled`), built only from the error's stamps and
/// the window in its message; `None` for any other class. No error text is ever echoed.
pub fn retry_timeout_text(error: Js, reason_class: &str, provider_label: Option<&str>) -> Option<String> {
    let text = message_text(error);
    let ms = timed_out_ms(&text);
    if reason_class == "first_response_timeout" {
        if is_first_byte_timeout(error) {
            let sentence = still_thinking_text(error, &text, provider_label);
            return Some(TRAILING_PERIOD.replace_all_with(&sentence, |_| String::new()));
        }
        return Some(if ms > 0.0 { format!("No first response {}", format_duration_ms(ms)) } else { "No first response".into() });
    }
    if reason_class == "stalled" {
        return Some(if ms > 0.0 { format!("No progress {}", format_duration_ms(ms)) } else { "No progress".into() });
    }
    None
}

// `String(error?.message ?? '')`.
fn message_text(error: Js) -> String {
    match get(error, "message") {
        Some(message) if !message.is_null() => js_string(Some(message)),
        _ => String::new(),
    }
}

/// The one retry status line every surface shows: `reason · retry n/max in 15s`. The counts are `Number(x)` of what the
/// caller holds (NaN when it holds nothing).
pub fn retry_status_line(reason: &str, attempt: f64, max_attempts: f64, delay_ms: f64) -> String {
    let count = number_or_zero_f(attempt);
    let count = (if count == 0.0 { 1.0 } else { count }).max(1.0);
    let max = {
        let n = number_or_zero_f(max_attempts);
        (if n == 0.0 { count } else { n }).max(count)
    };
    let wait = number_or_zero_f(delay_ms).max(0.0);
    let wait_text = if wait > 0.0 { format!(" in {}", format_duration_ms(wait)) } else { String::new() };
    format!("{reason} · retry {}/{}{wait_text}", num_text(count), num_text(max))
}

/// Compact `Failed · reason` label for background task/agent failure cards.
pub fn background_task_failure_status_label(status: Js, error: Js, surface: &str, now_ms: Option<f64>) -> String {
    let raw = match error {
        Some(value) if !value.is_null() => js_trim(&js_string(Some(value))).to_owned(),
        _ => String::new(),
    };
    let status_norm = mixdog_js::js_to_lowercase(js_trim(&string_or_empty(status)));
    let terminal = TERMINAL_STATUS.is_match(&status_norm);
    if raw.is_empty() && !terminal {
        return String::new();
    }

    let presented = present_error_text(error, &PresentOptions { surface, max: Some(160.0), now_ms, ..PresentOptions::default() });
    let watchdog = watchdog_ms_from_raw_error(&raw);
    let watchdog_kind = |wanted: WatchdogKind| watchdog.filter(|(kind, _)| *kind == wanted).map(|(_, ms)| ms);

    let mut head = "Failed";
    if CANCELLED_STATUS.is_match(&status_norm) {
        head = "Cancelled";
    } else if TIMEOUT_STATUS.is_match(&status_norm)
        || watchdog_kind(WatchdogKind::Timeout).is_some()
        || FIRST_RESPONSE_STALE_RAW.is_match(&raw)
        || NO_FIRST_RESPONSE.is_match(&presented)
        || WATCHDOG_PRESENTED.is_match(&presented)
    {
        head = "Timeout";
    } else if watchdog_kind(WatchdogKind::Stale).is_some() || STALE_RAW.is_match(&raw) || WENT_STALE.is_match(&presented) {
        head = "Stale";
    }

    let strip_period = |text: &str| TRAILING_PERIOD.replace_all_with(text, |_| String::new());
    let reason = if CONTEXT_TOO_LARGE_PRESENTED.is_match(&presented) {
        "Context too large".to_owned()
    } else if head == "Timeout" {
        if let Some(ms) = watchdog_kind(WatchdogKind::Timeout) {
            format!("No first response {}", compact_duration_for_status(ms, false))
        } else {
            Some(compact_reason_from_normalized_timeout(&presented)).filter(|reason| !reason.is_empty()).unwrap_or_else(|| strip_period(&presented))
        }
    } else if head == "Stale" {
        if let Some(ms) = watchdog_kind(WatchdogKind::Stale) {
            format!("No progress {}", compact_duration_for_status(ms, true))
        } else {
            Some(compact_reason_from_normalized_stale(&presented)).filter(|reason| !reason.is_empty()).unwrap_or_else(|| strip_period(&presented))
        }
    } else {
        strip_period(&presented)
    };
    if reason.is_empty() { head.to_owned() } else { format!("{head} · {reason}") }
}

/// `Error: <text>` unless the text already starts that way.
pub fn error_line(error: Js, options: &PresentOptions) -> String {
    let text = present_error_text(error, options);
    if ERROR_COLON_LINE.is_match(&text) { text } else { format!("Error: {text}") }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn present(value: Value) -> String {
        present_error_text(Some(&value), &PresentOptions { now_ms: Some(1_700_000_000_000.0), ..PresentOptions::default() })
    }

    #[test]
    fn err_text_reads_what_was_thrown() {
        assert_eq!(err_text(None), "undefined");
        assert_eq!(err_text(Some(&json!(null))), "null");
        assert_eq!(err_text(Some(&json!({ "$isError": true, "name": "TypeError", "message": "" }))), "TypeError");
        assert_eq!(err_text(Some(&json!({ "error": { "message": "inner" } }))), "inner");
        assert_eq!(err_text(Some(&json!({ "type": "close" }))), "close event");
        assert_eq!(err_text(Some(&json!({ "code": 1 }))), "{\"code\":1}");
        assert_eq!(err_text(Some(&json!({}))), "[object Object]");
        assert_eq!(err_text(Some(&json!(7))), "7");
    }

    #[test]
    fn present_error_text_collapses_known_failures() {
        assert_eq!(present(json!("Error: first byte timed out after 90000ms")), "No first response 90s.");
        assert_eq!(present(json!({ "status": 429, "retryAfterMs": 90_000 })), "Provider is rate-limited (retry in 90s).");
        assert_eq!(
            present(json!("429 rate limit retryAfter=5m: cooldown")),
            "Provider quota/rate limit hit; retry after 5m. Re-login or switch the provider account to continue now."
        );
        assert_eq!(present(json!({ "code": "ECONNRESET", "message": "read ECONNRESET" })), "Connection to the provider was lost (ECONNRESET).");
        assert_eq!(
            present(json!({ "timeoutPhase": "headers", "waitedMs": 30_000, "attempts": 2, "message": "x" })),
            "Model still thinking: no output in 30s; the provider sent nothing yet; attempts: 2."
        );
        assert_eq!(present(json!({ "name": "AbortError", "message": "The operation was aborted" })), "Tool was cancelled.");
        assert_eq!(present(json!("{\"error\":\"disk full\"}")), "disk full");
        assert_eq!(present(json!("")), "Unknown error");
    }

    #[test]
    fn retry_and_background_labels() {
        assert_eq!(retry_status_line("No progress 30s", 2.0, 5.0, 15_000.0), "No progress 30s · retry 2/5 in 15s");
        assert_eq!(retry_status_line("x", f64::NAN, 0.0, 0.0), "x · retry 1/1");
        let error = json!({ "timeoutPhase": "idle", "message": "timed out after 45000ms of inactivity" });
        assert_eq!(retry_timeout_text(Some(&error), "stalled", None).as_deref(), Some("No progress 45s"));
        assert_eq!(retry_timeout_text(Some(&error), "other", None), None);
        let label = |status: &str, error: &str| background_task_failure_status_label(Some(&json!(status)), Some(&json!(error)), "", None);
        assert_eq!(label("failed", "agent first response stale (120000ms)"), "Timeout · No first response 120s");
        assert_eq!(label("failed", "agent task stale (600000ms)"), "Stale · No progress 10m");
        assert_eq!(label("cancelled", ""), "Cancelled · Unknown error");
        assert_eq!(background_task_failure_status_label(Some(&json!("running")), None, "", None), "");
        assert!(is_background_error_only_body("Error: boom", "boom", None));
        assert!(!is_background_error_only_body("line one\nline two", "boom", None));
        assert_eq!(error_line(Some(&json!("boom")), &PresentOptions::default()), "Error: boom");
    }
}
