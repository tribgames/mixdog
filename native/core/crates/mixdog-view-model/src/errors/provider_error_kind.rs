//! Provider error kind: one semantic verdict for a thrown provider error, shared by retry policy, account rotation and the
//! UI (`provider-error-kind.mjs`). A leaf module: it reads the typed fields provider boundaries stamp on errors (status,
//! code, headers, retryAfterMs, resetAt, quotaScope, reauthRequired) and falls back to the older fields (httpStatus,
//! responseFailed, providerError, SDK error bodies, RPC status strings). Message text is consulted only for untyped errors
//! and only for unambiguous wordings.
//!
//! Header sources are plain objects (a `Headers` object with a `get` method has no parsed form). The clock the wait
//! computations read (`Date.now()`) is a parameter, so a caller and a test decide what "now" is.

use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::js_object_keys;
use mixdog_js::js_to_lowercase;
use mixdog_js::js_trim;
use mixdog_js::json_number;
use mixdog_js::time::date_parse;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::js_value::Js;
use super::js_value::first_defined;
use super::js_value::first_truthy;
use super::js_value::get;
use super::js_value::is_object;
use super::js_value::js_string;
use super::js_value::number;
use super::js_value::path;
use super::js_value::str_of;
use super::js_value::string_or_empty;
use super::js_value::system_now_ms;
use super::js_value::truthy;
use super::provider_timeout_phase::AUTH;
use super::provider_timeout_phase::IDLE;
use super::provider_timeout_phase::is_first_byte_timeout;

/// The kinds `providerErrorKind` answers (`PROVIDER_ERROR_KINDS`).
pub const PROVIDER_ERROR_KINDS: &[&str] = &[
    "overloaded",
    "rate_limited",
    "quota_exhausted",
    "entitlement",
    "billing",
    "auth",
    "permission",
    "context_overflow",
    "request_too_large",
    "policy",
    "service_tier_unavailable",
    "invalid_request",
    "transient",
    "unknown",
];

/// Kinds whose refusal no wait or replay can change: quota, plan and billing.
pub const QUOTA_KINDS: &[&str] = &["quota_exhausted", "entitlement", "billing"];
/// Kinds that are deterministic refusals of this request (never replayed as-is).
pub const DETERMINISTIC_KINDS: &[&str] = &[
    "quota_exhausted",
    "entitlement",
    "billing",
    "policy",
    "auth",
    "permission",
    "context_overflow",
    "request_too_large",
    "service_tier_unavailable",
    "invalid_request",
];

/// The code a local fixed-overhead refusal carries.
pub const TOOL_SURFACE_EXCEEDS_CONTEXT: &str = "TOOL_SURFACE_EXCEEDS_CONTEXT";
const TOOL_SURFACE_MARKER: &str = "(TOOL_SURFACE_EXCEEDS_CONTEXT)";
const MAX_CAUSE_CHAIN_DEPTH: usize = 8;

macro_rules! js_re {
    ($name:ident, $pattern:expr, $flags:expr) => {
        static $name: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static($pattern, $flags));
    };
}

js_re!(
    MESSAGE_DELAY,
    r"(?:try again in|retry (?:again )?(?:in|after)|wait(?: for)?)\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?)\b",
    "i"
);
js_re!(RETRY_DELAY, r"^(\d+(?:\.\d+)?)s$", "");
js_re!(
    BARE_FETCH_TRANSPORT_MESSAGE,
    r"^(?:fetch failed|failed to fetch|couldn'?t fetch\.?|load failed|network error|terminated|other side closed|socket hang up)$",
    "i"
);
js_re!(TLS_RECORD_FAILURE, r"^ERR_SSL_[A-Z0-9_/]*BAD_RECORD_MAC$", "i");
js_re!(CAPACITY_MESSAGE, r"\bat capacity\b|\boverloaded\b|\bserver is busy\b", "i");
js_re!(LEGACY_BILLING_MESSAGE, r"\binsufficient_quota\b|exceeded your (?:current )?quota", "i");
js_re!(LEGACY_QUOTA_MESSAGE, r"\bquota_exceeded\b|\busage_limit_reached\b|hit your usage limit", "i");

const MESSAGE_DELAY_CODES: &[&str] = &["rate_limit_exceeded", "slow_down"];
const TRANSIENT_SDK_NAMES: &[&str] = &["APIConnectionError", "APIConnectionTimeoutError", "ConnectTimeoutError", "HeadersTimeoutError", "BodyTimeoutError"];
const STALL_NAMES: &[&str] = &["StreamStalledError", "StreamStalledAbortError", "AgentStallAbortError"];
const TRANSIENT_ERROR_CODES: &[&str] = &[
    "ECONNRESET",
    "ETIMEDOUT",
    "ESOCKETTIMEDOUT",
    "EAI_AGAIN",
    "ENOTFOUND",
    "EAI_NODATA",
    "ECONNREFUSED",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "EPIPE",
    "EPROVIDERTIMEOUT",
    "EGEMINITIMEOUT",
    "ESTREAMSTALL",
    "EWSACQUIRETIMEOUT",
    "UND_ERR_SOCKET",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_CONNECT",
    "EPROTO",
    "UND_ERR_DESTROYED",
    "UND_ERR_CLOSED",
    "ECONNABORTED",
    "ENETRESET",
    "ERR_STREAM_DESTROYED",
    "ERR_HTTP2_STREAM_ERROR",
    "ERR_HTTP2_SESSION_ERROR",
    "ERR_HTTP2_INVALID_SESSION",
    "ERR_SOCKET_CONNECTION_TIMEOUT",
    "ERR_SSL_WRONG_VERSION_NUMBER",
    "ERR_STREAM_PREMATURE_CLOSE",
];
const TRANSIENT_WS_CLOSE_CODES: &[f64] = &[1000.0, 1001.0, 1005.0, 1006.0, 1011.0, 1012.0];

/// Token-context refusals: the conversation is longer than the model's window.
const TOKEN_CONTEXT_OVERFLOW_PATTERNS: &[&str] = &[
    r"input (?:length|tokens?) exceeds? the context window",
    r"exceeds? the (?:maximum )?context (?:window|length)",
    r"maximum context length",
    r"context[_ ]length[_ ]exceeded",
    r"prompt is too long",
    r"reduce the length of (?:the )?(?:messages|input|prompt)",
    // Wordings other backends use for the same refusal, each tied to a context or input-length noun so a
    // tokens-per-minute rate limit never matches.
    r"prompt too long",
    r"prompt exceeds max length",
    r"input is too long for requested model",
    r"input token count.*exceeds the maximum",
    r"maximum prompt length is \d+",
    r"exceeds (?:the )?maximum allowed input length",
    r"is longer than the model'?s context length",
    r"exceeds the available context size",
    r"greater than the context length",
    r"context window exceeds limit",
    r"exceeded model token limit",
    r"too large for model with \d+ maximum context length",
    r"range of input length should be",
    r"model_context_window_exceeded",
];
/// Byte/media size refusals: the request body itself is too large.
const REQUEST_SIZE_PATTERNS: &[&str] = &[
    r"request payload size exceeds the limit",
    // A 413 re-wrapped by a proxy or aggregator without its status.
    r"request entity too large",
    r"request exceeds the maximum size",
];

static TOKEN_CONTEXT_OVERFLOW: LazyLock<Vec<JsRegex>> =
    LazyLock::new(|| TOKEN_CONTEXT_OVERFLOW_PATTERNS.iter().map(|pattern| JsRegex::new_static(pattern, "i")).collect());
static REQUEST_SIZE: LazyLock<Vec<JsRegex>> = LazyLock::new(|| REQUEST_SIZE_PATTERNS.iter().map(|pattern| JsRegex::new_static(pattern, "i")).collect());

/// A refusal wording that names a conversation longer than the model's window.
pub fn is_token_context_overflow_text(text: &str) -> bool {
    TOKEN_CONTEXT_OVERFLOW.iter().any(|re| re.is_match(text))
}

/// A refusal wording that names a request body over the size limit.
pub fn is_request_size_text(text: &str) -> bool {
    REQUEST_SIZE.iter().any(|re| re.is_match(text))
}

// When several typed codes are present (an envelope type plus a specific code), the most specific verdict wins.
const KIND_RANK: &[&str] = &[
    "policy",
    "billing",
    "entitlement",
    "quota_exhausted",
    "context_overflow",
    "request_too_large",
    "auth",
    "permission",
    "service_tier_unavailable",
    "overloaded",
    "rate_limited",
    "transient",
    "invalid_request",
];
const RESOURCE_EXHAUSTED: &str = "resource_exhausted";
// OpenRouter answers a 402 with this marker when concurrent in-flight spend is capped; it clears as requests finish
// (Retry-After), unlike a spent balance.
const IN_FLIGHT_BUDGET: &str = "openrouter_in_flight_budget";
const IN_FLIGHT_BUDGET_MAX_WAIT_MS: f64 = 60_000.0;

/// The kind a typed provider error code names (`CODE_KINDS`).
fn code_kind(code: &str) -> Option<&'static str> {
    Some(match code {
        "cyber_policy" | "bio_policy" | "cyber_policy_violation" | "bio_policy_violation" | "misalignment_policy_violation"
        | "content_policy_violation" | "content_filter" | "safety" | "recitation" | "invalid_prompt" => "policy",
        "insufficient_quota" | "credit_balance_exhausted" | "organization_spend_limit_exceeded" | "project_spend_limit_exceeded"
        | "organization_usage_limit_exceeded" | "billing_not_active" | "billing_hard_limit_reached" | "payment_required"
        | "insufficient_g1_credits_balance" => "billing",
        "usage_not_included" => "entitlement",
        "quota_exceeded" | "quota_exhausted" | "usage_limit_reached" | "provider_accounts_exhausted" => "quota_exhausted",
        "context_length_exceeded" | "context_window_exceeded" | "model_context_window_exceeded" => "context_overflow",
        "request_too_large" | "payload_too_large" | "request_entity_too_large" => "request_too_large",
        // Google names a rejected or expired key with an ErrorInfo reason on an INVALID_ARGUMENT 400; the reason outranks
        // the envelope status.
        "invalid_api_key" | "authentication_error" | "unauthenticated" | "unauthorized" | "invalid_authentication"
        | "api_key_invalid" | "api_key_expired" | "access_token_expired" => "auth",
        "permission_error" | "permission_denied" | "forbidden" | "service_disabled" | "api_key_service_blocked" => "permission",
        "server_is_overloaded" | "overloaded_error" | "overloaded" | "server_overloaded" | "model_capacity_exhausted"
        | "model_capacity_exceeded" => "overloaded",
        // The requested service tier has no capacity: the same request at the same tier is refused again, so it is final
        // rather than an overload.
        "flex_unavailable" => "service_tier_unavailable",
        "rate_limit_exceeded" | "rate_limit_error" | "rate_limited" | "slow_down" | "too_many_requests" => "rate_limited",
        "server_error" | "api_error" | "internal" | "internal_error" | "unavailable" | "service_unavailable"
        | "deadline_exceeded" | "timeout" | "previous_response_not_found" | "websocket_connection_limit_reached"
        | "stream_disconnected" | "network_error"
        // Replay safety is still the stream-outcome gate's call (classifyError).
        | "malformed_stream" => "transient",
        "invalid_request" | "invalid_request_error" | "invalid_argument" | "failed_precondition" | "bad_request" | "not_found"
        | "not_found_error" | "model_not_found" | "model_not_supported" | "unsupported_parameter" => "invalid_request",
        _ => return None,
    })
}

/// OpenRouter's canonical `error_type` vocabulary, stable across its Chat, Responses and Messages skins (the native code
/// beside it is lossy: on Responses an auth failure arrives as `server_error`, a context overflow as `invalid_prompt`),
/// mapped onto the typed codes classified here.
fn gateway_error_type_code(error_type: Js) -> Option<&'static str> {
    let key = js_to_lowercase(js_trim(str_of(error_type)?));
    Some(match key.as_str() {
        "authentication" => "authentication_error",
        "permission_denied" => "permission_denied",
        "payment_required" => "payment_required",
        "context_length_exceeded" => "context_length_exceeded",
        "payload_too_large" => "payload_too_large",
        "image_too_large" => "request_too_large",
        "rate_limit_exceeded" => "rate_limit_exceeded",
        "provider_overloaded" => "overloaded",
        "provider_unavailable" => "service_unavailable",
        "timeout" => "timeout",
        "server" => "server_error",
        "content_policy_violation" | "refusal" => "content_policy_violation",
        "invalid_request" | "invalid_prompt" | "unprocessable" => "invalid_request",
        "not_found" => "not_found",
        "precondition_failed" => "failed_precondition",
        _ => return None,
    })
}

/// Pre-classification normalizer for a wire error detail: when the envelope (or the detail itself) carries a gateway
/// `error_type`, its typed code replaces the lossy native code (kept as `native_code`). Any other detail is returned
/// unchanged.
pub fn normalize_gateway_error_detail(detail: Js, envelope: Js) -> Option<Value> {
    let error_type = first_defined(&[
        path(envelope, &["response", "error_type"]),
        get(envelope, "error_type"),
        get(detail, "error_type"),
        path(detail, &["metadata", "error_type"]),
    ]);
    let Some(code) = gateway_error_type_code(error_type) else { return detail.cloned() };
    let mut out: Map<String, Value> = match detail {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };
    let native = get(detail, "code").filter(|native| !native.is_null());
    out.insert("code".into(), json!(code));
    out.insert("error_type".into(), error_type.cloned().unwrap_or(Value::Null));
    if let Some(native) = native.filter(|native| native.as_str() != Some(code)) {
        out.insert("native_code".into(), native.clone());
    }
    Some(Value::Object(out))
}

/// The error followed down its `cause` chain, at most eight deep.
pub fn bounded_cause_chain(err: Js<'_>) -> Vec<&Value> {
    let mut chain = Vec::new();
    let mut cursor = err;
    while let Some(item) = cursor.filter(|item| truthy(Some(*item))) {
        if chain.len() >= MAX_CAUSE_CHAIN_DEPTH {
            break;
        }
        chain.push(item);
        cursor = get(Some(item), "cause");
    }
    chain
}

/// The local fixed-overhead refusal (`session/loop/context-overflow.mjs`), bare, wrapped as a cause, or persisted as its
/// text. Never a provider overflow: its diagnostic names tools, and a tool named like a provider error code must not turn
/// it into one.
pub fn is_tool_surface_exceeds_context_error(err: Js) -> bool {
    if !matches!(err, Some(Value::String(_) | Value::Object(_) | Value::Array(_))) || !truthy(err) {
        return false;
    }
    // Every node of the chain: an Error, or persisted failure text kept as a cause.
    bounded_cause_chain(err).into_iter().any(|item| match item {
        Value::String(text) => text.contains(TOOL_SURFACE_MARKER),
        item => {
            str_of(get(Some(item), "code")) == Some(TOOL_SURFACE_EXCEEDS_CONTEXT)
                || str_of(get(Some(item), "message")).is_some_and(|message| message.contains(TOOL_SURFACE_MARKER))
        }
    })
}

/// The value of header `name` in a header object (any case), the first of an array value.
pub fn header_value<'a>(headers: &'a Value, name: &str) -> Js<'a> {
    let Value::Object(map) = headers else { return None };
    let lower = js_to_lowercase(name);
    for key in js_object_keys(map) {
        if js_to_lowercase(key) == lower {
            return match map.get(key)? {
                Value::Array(items) => items.first(),
                value => Some(value),
            };
        }
    }
    None
}

fn wire_detail(err: Js) -> Js {
    let failed = get(err, "responseFailed");
    first_truthy(&[path(failed, &["response", "error"]), get(failed, "error"), get(err, "providerError"), failed])
}

// Every place a provider error may carry its response headers, outermost first: the error itself, the SDK response,
// preserved wire `error.headers`.
fn header_sources(err: Js<'_>) -> Vec<&Value> {
    let detail = wire_detail(err);
    [
        get(err, "headers"),
        path(err, &["response", "headers"]),
        path(err, &["data", "responseHeaders"]),
        path(err, &["error", "headers"]),
        get(detail, "headers"),
        path(err, &["providerError", "headers"]),
        path(err, &["payload", "error", "headers"]),
    ]
    .into_iter()
    .filter(|headers| truthy(*headers) && is_object(*headers))
    .flatten()
    .collect()
}

/// The first value of response header `name` across every preserved header source.
pub fn error_header_value<'a>(err: Js<'a>, name: &str) -> Js<'a> {
    header_sources(err).into_iter().filter_map(|headers| header_value(headers, name)).find(|value| !value.is_null() && value.as_str() != Some(""))
}

// The typed codes of one chain item: a gateway's canonical `error_type` codes, and the native ones.
fn code_fields(item: Js) -> (Vec<&'static str>, Vec<Js>) {
    let detail = wire_detail(item);
    let canonical = [
        gateway_error_type_code(first_defined(&[get(detail, "error_type"), path(detail, &["metadata", "error_type"])])),
        gateway_error_type_code(get(item, "error_type")),
        gateway_error_type_code(first_defined(&[path(item, &["error", "error_type"]), path(item, &["error", "metadata", "error_type"])])),
        gateway_error_type_code(path(item, &["error", "error", "error_type"])),
    ];
    let native = vec![
        get(detail, "code"),
        get(detail, "type"),
        get(detail, "status"),
        get(item, "providerErrorCode"),
        get(item, "code"),
        get(item, "type"),
        path(item, &["error", "code"]),
        path(item, &["error", "type"]),
        path(item, &["error", "status"]),
        path(item, &["error", "error", "code"]),
        path(item, &["error", "error", "type"]),
        path(item, &["payload", "code"]),
        path(item, &["payload", "type"]),
        path(item, &["payload", "error", "code"]),
        path(item, &["payload", "error", "type"]),
        get(item, "geminiStatus"),
        get(item, "status"),
    ];
    (canonical.into_iter().flatten().collect(), native)
}

/// The typed code of an error: the gateway's canonical one, else the first native code, trimmed and lower-cased.
pub fn typed_error_code(err: Js) -> String {
    let detail = wire_detail(err);
    if is_object(err)
        && let Some(canonical) = code_fields(err).0.first()
    {
        return (*canonical).to_owned();
    }
    for field in [get(detail, "code"), get(detail, "type"), get(err, "providerErrorCode"), get(err, "code"), path(err, &["error", "code"])] {
        if let Some(text) = str_of(field).map(js_trim).filter(|text| !text.is_empty()) {
            return js_to_lowercase(text);
        }
    }
    String::new()
}

// ── Retry-After ─────────────────────────────────────────────────────────────

// Zero or non-positive advice is no advice: the caller's local backoff applies and a later source may still advise.
fn finite_positive_number(n: f64) -> Option<f64> {
    (n.is_finite() && n > 0.0).then_some(n)
}

fn finite_positive(value: Js) -> Option<f64> {
    match value {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) if text.is_empty() => None,
        value => finite_positive_number(number(value)),
    }
}

fn retry_info_delay_ms(details: Js) -> Option<f64> {
    let Some(Value::Array(details)) = details else { return None };
    for detail in details {
        let delay = get(Some(detail), "retryDelay");
        let ms = match delay {
            Some(Value::String(text)) => {
                RETRY_DELAY.captures(js_trim(text)).and_then(|found| found.get(1)).map(|seconds| seconds.parse::<f64>().unwrap_or(f64::NAN) * 1000.0)
            }
            Some(object @ (Value::Object(_) | Value::Array(_))) => {
                let part = |key: &str| get(Some(object), key).filter(|value| truthy(Some(*value))).map_or(0.0, |value| number(Some(value)));
                Some(part("seconds") * 1000.0 + part("nanos") / 1_000_000.0)
            }
            _ => None,
        };
        if let Some(ms) = ms.and_then(finite_positive_number) {
            return Some(ms.ceil());
        }
    }
    None
}

fn message_delay_ms(err: Js) -> Option<f64> {
    let detail = first_truthy(&[wire_detail(err), get(err, "error")]);
    for message in [get(detail, "message"), path(err, &["error", "message"]), get(err, "message")] {
        let Some(message) = str_of(message).filter(|message| !message.is_empty()) else { continue };
        let Some(found) = MESSAGE_DELAY.captures(message) else { continue };
        let Some(value) = found.get(1).and_then(|digits| finite_positive_number(digits.parse().unwrap_or(f64::NAN))) else { continue };
        let unit = js_to_lowercase(found.get(2).unwrap_or(""));
        if unit == "ms" || unit.starts_with("millisecond") {
            return Some(value.ceil());
        }
        if unit == "m" || unit.starts_with("min") {
            return Some((value * 60_000.0).ceil());
        }
        return Some((value * 1000.0).ceil());
    }
    None
}

/// The server-advised wait before re-issuing, in ms; `None` when the server gave none. Precedence: the boundary-stamped
/// `retryAfterMs`, Retry-After headers (any preserved source), Google RetryInfo (`details` / SDK `errorDetails`), and
/// finally the delay a TYPED rate_limit_exceeded / slow_down message names. Window resets (`resetAt`,
/// anthropic-ratelimit-unified-reset) are never retry advice: they are reported separately for display and cooldown.
/// `now_ms` is `Date.now()`.
pub fn retry_after_ms_from_error(err: Js, now_ms: f64) -> Option<f64> {
    if !is_object(err) {
        return None;
    }
    // A deadline captured once at the boundary (`retryAfterAt`) survives a transport switch: report what is left of it.
    for item in bounded_cause_chain(err).into_iter().take(2) {
        let at = number(get(Some(item), "retryAfterAt"));
        if at.is_finite() && at > 0.0 {
            return Some((at - now_ms).max(0.0));
        }
    }
    for item in bounded_cause_chain(err).into_iter().take(2) {
        if let Some(stamped) = finite_positive(get(Some(item), "retryAfterMs")) {
            return Some(stamped);
        }
    }
    if let Some(ms) = finite_positive(error_header_value(err, "retry-after-ms")) {
        return Some(ms);
    }
    if let Some(retry_after) = error_header_value(err, "retry-after") {
        if let Some(seconds) = finite_positive(Some(retry_after)) {
            return Some((seconds * 1000.0).ceil());
        }
        if let Some(until_date) = finite_positive_number(date_parse(&js_string(Some(retry_after))) - now_ms) {
            return Some(until_date);
        }
    }
    let detail = wire_detail(err);
    for details in [
        get(err, "details"),
        path(err, &["error", "details"]),
        path(err, &["data", "error", "details"]),
        get(err, "errorDetails"),
        path(err, &["error", "errorDetails"]),
        get(detail, "details"),
    ] {
        if let Some(delay) = retry_info_delay_ms(details) {
            return Some(delay);
        }
    }
    if MESSAGE_DELAY_CODES.contains(&typed_error_code(err).as_str()) {
        return message_delay_ms(err);
    }
    None
}

// ── Transport evidence ──────────────────────────────────────────────────────

/// True for a socket/TLS errno that describes a transient transport fault.
pub fn is_transient_error_code(code: Js) -> bool {
    let value = string_or_empty(code);
    TRANSIENT_ERROR_CODES.contains(&value.as_str()) || TLS_RECORD_FAILURE.is_match(&value)
}

/// A bare runtime message that is the body-read form of a disconnect.
pub fn is_bare_fetch_transport_message(message: &str) -> bool {
    BARE_FETCH_TRANSPORT_MESSAGE.is_match(message)
}

/// An SDK error name that describes a transient connection fault.
pub fn is_transient_sdk_name(name: &str) -> bool {
    TRANSIENT_SDK_NAMES.contains(&name)
}

fn transport_evidence(err: &Value, chain: &[&Value], status: f64) -> bool {
    let err = Some(err);
    if get(err, "truncatedStream") == Some(&Value::Bool(true))
        || str_of(get(err, "code")) == Some("TRUNCATED_STREAM")
        || get(err, "streamStalled") == Some(&Value::Bool(true))
    {
        return true;
    }
    let close = first_defined(&[get(err, "wsCloseCode"), get(err, "streamCloseCode")]);
    if TRANSIENT_WS_CLOSE_CODES.contains(&if close.is_some() { number(close) } else { 0.0 }) {
        return true;
    }
    if chain.iter().copied().any(|item| is_transient_error_code(get(Some(item), "code"))) {
        return true;
    }
    if chain.iter().copied().any(|item| {
        let name = string_or_empty(get(Some(item), "name"));
        TRANSIENT_SDK_NAMES.contains(&name.as_str()) || STALL_NAMES.contains(&name.as_str())
    }) {
        return true;
    }
    status == 0.0 && chain.iter().copied().any(|item| BARE_FETCH_TRANSPORT_MESSAGE.is_match(js_trim(&string_or_empty(get(Some(item), "message")))))
}

// ── Typed evidence helpers ──────────────────────────────────────────────────

// A gateway's canonical `error_type` supersedes every native code in the chain.
fn typed_codes(chain: &[&Value]) -> Vec<String> {
    let mut canonical: Vec<String> = Vec::new();
    let mut native: Vec<String> = Vec::new();
    let add = |codes: &mut Vec<String>, field: Js| {
        let Some(text) = str_of(field) else { return };
        let code = js_to_lowercase(js_trim(text));
        if !code.is_empty() && !codes.contains(&code) {
            codes.push(code);
        }
    };
    for item in chain.iter().copied() {
        if !is_object(Some(item)) {
            continue;
        }
        let (canonical_fields, native_fields) = code_fields(Some(item));
        for field in canonical_fields {
            add(&mut canonical, Some(&Value::String(field.to_owned())));
        }
        for field in native_fields {
            add(&mut native, field);
        }
    }
    if canonical.is_empty() { native } else { canonical }
}

fn status_of(err: Js) -> f64 {
    for value in [get(err, "httpStatus"), get(err, "status"), get(err, "statusCode"), path(err, &["response", "status"])] {
        let n = number(value);
        if n.is_finite() && (100.0..=599.0).contains(&n) {
            return n.floor();
        }
    }
    0.0
}

// Retry-After advice for the budget exception: a valid `0` ("retry now") is advice here, although
// `retry_after_ms_from_error` treats zero as none.
fn in_flight_advice_ms(err: Js, now_ms: f64) -> Option<f64> {
    if let Some(advised) = retry_after_ms_from_error(err, now_ms) {
        return Some(advised);
    }
    for (name, unit_ms) in [("retry-after-ms", 1.0), ("retry-after", 1000.0)] {
        let value = error_header_value(err, name);
        let n = number(value);
        if value.is_some() && !js_trim(&js_string(value)).is_empty() && n.is_finite() && n >= 0.0 {
            return Some(n * unit_ms);
        }
    }
    None
}

// Only a 402 that names the marker AND carries Retry-After advice of 0..60s inclusive is a wait; without advice (or with a
// long one) it stays billing.
fn is_in_flight_budget_402(chain: &[&Value], status: f64, advice_ms: Option<f64>) -> bool {
    let Some(advice_ms) = advice_ms else { return false };
    if status != 402.0 || advice_ms > IN_FLIGHT_BUDGET_MAX_WAIT_MS {
        return false;
    }
    chain.iter().copied().any(|item| {
        let item = Some(item);
        if !is_object(item) {
            return false;
        }
        let detail = wire_detail(item);
        [
            get(detail, "code"),
            get(detail, "type"),
            path(detail, &["metadata", "code"]),
            path(detail, &["metadata", "type"]),
            path(detail, &["metadata", "reason"]),
            path(detail, &["metadata", "limit_source"]),
            get(item, "code"),
            get(item, "type"),
            path(item, &["error", "code"]),
            path(item, &["error", "type"]),
            path(item, &["error", "metadata", "code"]),
            path(item, &["error", "metadata", "type"]),
            path(item, &["error", "metadata", "reason"]),
            path(item, &["error", "metadata", "limit_source"]),
            path(item, &["error", "error", "code"]),
            path(item, &["error", "error", "type"]),
        ]
        .into_iter()
        .any(|value| str_of(value).is_some_and(|text| js_to_lowercase(js_trim(text)) == IN_FLIGHT_BUDGET))
    })
}

fn kind_from_status(status: f64) -> Option<&'static str> {
    if status == 401.0 {
        return Some("auth");
    }
    if status == 402.0 {
        return Some("billing");
    }
    if status == 403.0 {
        return Some("permission");
    }
    if status == 413.0 {
        return Some("request_too_large");
    }
    if status == 429.0 {
        return Some("rate_limited");
    }
    if status == 529.0 {
        return Some("overloaded");
    }
    if status == 408.0 || status == 409.0 || status == 425.0 {
        return Some("transient");
    }
    if status == 525.0 || status == 526.0 {
        return None;
    }
    if (400.0..500.0).contains(&status) {
        return Some("invalid_request");
    }
    if (500.0..600.0).contains(&status) {
        return Some("transient");
    }
    None
}

fn reset_at_of(err: Js, chain: &[&Value]) -> Option<f64> {
    for item in chain.iter().copied().filter(|item| is_object(Some(*item))) {
        let n = number(get(Some(item), "resetAt"));
        if n.is_finite() && n > 0.0 {
            return Some(n);
        }
    }
    let exhausted = number(path(err, &["quotaExhausted", "resetAt"]));
    (exhausted.is_finite() && exhausted > 0.0).then_some(exhausted)
}

fn quota_scope_of(chain: &[&Value]) -> Option<&'static str> {
    for item in chain.iter().copied().filter(|item| is_object(Some(*item))) {
        let scope = str_of(get(Some(item), "quotaScope")).map(|text| js_to_lowercase(js_trim(text))).unwrap_or_default();
        match scope.as_str() {
            "minute" => return Some("minute"),
            "day" => return Some("day"),
            "plan" => return Some("plan"),
            _ => {}
        }
    }
    None
}

fn kind_rank(kind: &str) -> usize {
    KIND_RANK.iter().position(|ranked| *ranked == kind).unwrap_or(usize::MAX)
}

// The most specific kind the typed codes name; no kind when none does.
fn kind_from_codes(codes: &[String], scope: Option<&str>) -> (Option<&'static str>, String) {
    let mut kind: Option<&'static str> = None;
    let mut code = String::new();
    for candidate in codes {
        let mut candidate_kind = code_kind(candidate);
        if candidate == RESOURCE_EXHAUSTED {
            // Google uses one code for per-minute throttles and spent quotas; the boundary names a spent quota with
            // quotaScope day/plan. Without that evidence it is a request-local rate limit.
            candidate_kind = Some(if matches!(scope, Some("day" | "plan")) { "quota_exhausted" } else { "rate_limited" });
        }
        if let Some(candidate_kind) = candidate_kind {
            let better = kind.is_none_or(|current| kind_rank(candidate_kind) < kind_rank(current));
            if better {
                kind = Some(candidate_kind);
                code = candidate.clone();
            }
        }
    }
    (kind, code)
}

/// The kind an error's typed codes alone name (no status, flag or wording); `None` when none does.
pub fn typed_code_kind(err: Js) -> Option<&'static str> {
    if !is_object(err) {
        return None;
    }
    let chain = bounded_cause_chain(err);
    kind_from_codes(&typed_codes(&chain), quota_scope_of(&chain)).0
}

fn message_of(err: Js, chain: &[&Value]) -> String {
    let detail = wire_detail(err);
    let mut messages: Vec<&str> = vec![];
    for message in [get(detail, "message"), path(err, &["error", "message"])] {
        messages.extend(str_of(message).filter(|message| !message.is_empty()));
    }
    messages.extend(chain.iter().copied().filter_map(|item| str_of(get(Some(item), "message"))).filter(|message| !message.is_empty()));
    messages.join("\n")
}

/// What `providerErrorKind` answered. `retry_after_ms` and `reset_at` are `null` in Node when absent.
#[derive(Clone, Debug, PartialEq)]
pub struct KindDescriptor {
    /// One of [`PROVIDER_ERROR_KINDS`].
    pub kind: &'static str,
    pub code: String,
    pub status: f64,
    pub retry_after_ms: Option<f64>,
    pub reset_at: Option<f64>,
}

impl KindDescriptor {
    /// The descriptor of a value that is no object.
    pub fn unknown() -> Self {
        Self { kind: "unknown", code: String::new(), status: 0.0, retry_after_ms: None, reset_at: None }
    }

    /// The object Node answers.
    pub fn to_value(&self) -> Value {
        let number = |value: Option<f64>| value.map_or(Value::Null, json_number);
        json!({
            "kind": self.kind,
            "code": self.code,
            "status": json_number(self.status),
            "retryAfterMs": number(self.retry_after_ms),
            "resetAt": number(self.reset_at),
        })
    }
}

/// `providerErrorKind`'s options.
#[derive(Clone, Copy, Debug)]
pub struct KindOptions {
    /// `false` skips the message-wording fallbacks, for retry policy that must decide from typed evidence alone.
    pub text: bool,
    /// `false` ignores the header-derived providerQuota / quotaExceeded flags.
    pub quota_flags: bool,
    /// A fully untyped error may read as a usage limit from unambiguous wording (presentation only).
    pub legacy_quota_wording: bool,
    /// `Date.now()`; the wall clock when `None`.
    pub now_ms: Option<f64>,
}

impl Default for KindOptions {
    fn default() -> Self {
        Self { text: true, quota_flags: true, legacy_quota_wording: false, now_ms: None }
    }
}

/// Classifies a provider error into one semantic kind.
pub fn provider_error_kind(err: Js, options: &KindOptions) -> KindDescriptor {
    let Some(err_value) = err.filter(|err| is_object(Some(*err))) else { return KindDescriptor::unknown() };
    let now_ms = options.now_ms.unwrap_or_else(system_now_ms);
    let chain = bounded_cause_chain(err);
    let status = status_of(err);
    let retry_after_ms = retry_after_ms_from_error(err, now_ms);
    let reset_at = reset_at_of(err, &chain);
    let scope = quota_scope_of(&chain);
    let codes = typed_codes(&chain);
    let describe = |kind: &'static str, code: &str| KindDescriptor {
        kind,
        code: if code.is_empty() { typed_error_code(err) } else { code.to_owned() },
        status,
        retry_after_ms,
        reset_at,
    };

    // A local fixed-overhead refusal is no provider kind, whatever its text names.
    if is_tool_surface_exceeds_context_error(err) {
        return describe("unknown", TOOL_SURFACE_EXCEEDS_CONTEXT);
    }
    // Validated account-pool evidence and boundary-stamped re-auth decide first.
    if truthy(get(err, "quotaExhausted")) && is_object(get(err, "quotaExhausted")) {
        return describe("quota_exhausted", "");
    }
    if chain.iter().copied().any(|item| get(Some(item), "reauthRequired") == Some(&Value::Bool(true))) {
        return describe("auth", "");
    }
    if is_in_flight_budget_402(&chain, status, in_flight_advice_ms(err, now_ms)) {
        return describe("transient", IN_FLIGHT_BUDGET);
    }
    // Every other 402 is a billing refusal, whatever generic retryable code (server_error, rate_limit_exceeded) its body
    // also carries.
    if status == 402.0 {
        return describe("billing", "");
    }

    let (mut kind, code) = kind_from_codes(&codes, scope);
    // Explicit quota flags (Anthropic unified-status rejected headers) outrank a generic rate-limit code or status; they
    // never turn an overload (or a more specific refusal) into quota.
    let quota_flagged = options.quota_flags
        && chain
            .iter()
            .copied()
            .any(|item| get(Some(item), "providerQuota") == Some(&Value::Bool(true)) || get(Some(item), "quotaExceeded") == Some(&Value::Bool(true)));
    if quota_flagged && matches!(kind, None | Some("rate_limited")) {
        kind = Some("quota_exhausted");
    }
    // Wordings, for untyped errors only (a typed code always decides).
    let text = if options.text && matches!(kind, None | Some("invalid_request")) { message_of(err, &chain) } else { String::new() };
    if kind.is_none() && codes.is_empty() && !text.is_empty() && status == 429.0 && CAPACITY_MESSAGE.is_match(&text) {
        kind = Some("overloaded");
    }
    // Presentation-only fallback (`legacyQuotaWording`): a fully UNTYPED error (no status, code, retry advice, quota flag or
    // scope, e.g. persisted failure text) may still read as a usage limit from unambiguous wording. Retry, rotation and
    // blocking never enable it.
    if options.legacy_quota_wording && kind.is_none() && codes.is_empty() && status == 0.0 && retry_after_ms.is_none() && scope.is_none() && !text.is_empty() {
        if LEGACY_BILLING_MESSAGE.is_match(&text) {
            kind = Some("billing");
        } else if LEGACY_QUOTA_MESSAGE.is_match(&text) {
            kind = Some("quota_exhausted");
        }
    }
    if kind.is_none() {
        kind = kind_from_status(status);
    }
    if matches!(kind, None | Some("invalid_request")) && !text.is_empty() {
        if is_token_context_overflow_text(&text) {
            kind = Some("context_overflow");
        } else if is_request_size_text(&text) {
            kind = Some("request_too_large");
        }
    }
    if kind.is_none() && transport_evidence(err_value, &chain, status) {
        kind = Some("transient");
    }
    // A provider wire error event without a deterministic code is a server-side fault.
    if kind.is_none() && (get(err, "responseFailed").is_some_and(|failed| !failed.is_null()) || get(err, "providerWireError") == Some(&Value::Bool(true))) {
        kind = Some("transient");
    }
    let mut kind = kind.unwrap_or("unknown");
    // The quota window the server names outranks the code's default reading.
    if scope == Some("minute") && kind == "quota_exhausted" {
        kind = "rate_limited";
    }
    // A day/plan window on a rate limit is a spent quota. A resetAt alone is not: rate-limit 429s carry window resets too
    // (kept for display/cooldown).
    if kind == "rate_limited" && matches!(scope, Some("day" | "plan")) {
        kind = "quota_exhausted";
    }
    describe(kind, &code)
}

const SERVER_ERROR_CODES: &[&str] = &["server_error", "api_error", "internal", "internal_error", "unavailable", "service_unavailable"];
// Responses failure codes the WS retry classifier acts on beyond the shared provider vocabulary.
const WS_RETRY_ERROR_CODES: &[&str] = &["auth_context_expired", "auth_expired"];
const STALL_ERROR_NAMES: &[&str] = &["StreamStalledError", "StreamStalledAbortError"];

/// True when `code` is one of the provider error codes this module classifies (rate/usage limits, quota, overload,
/// server/transient, context length, model not found, auth, policy, ...): a known vocabulary word, never free text.
fn is_known_provider_error_code(code: &str) -> bool {
    code_kind(code).is_some() || code == RESOURCE_EXHAUSTED
}

/// The typed error code when it is a known provider error code; `None` otherwise.
pub fn safe_retry_error_code(err: Js, now_ms: f64) -> Option<String> {
    let code = provider_error_kind(err, &KindOptions { now_ms: Some(now_ms), ..KindOptions::default() }).code;
    (is_known_provider_error_code(&code) || WS_RETRY_ERROR_CODES.contains(&code.as_str())).then_some(code)
}

/// One of rate_limited / overloaded / server_error / auth / first_response_timeout / stalled / other. The timeout classes
/// read our own typed timeout stamps (name, code, timeoutPhase), never message text.
pub fn retry_reason_class(err: Js, now_ms: f64) -> &'static str {
    let descriptor = provider_error_kind(err, &KindOptions { now_ms: Some(now_ms), ..KindOptions::default() });
    let (kind, status) = (descriptor.kind, descriptor.status);
    let code = safe_retry_error_code(err, now_ms);
    if kind == "rate_limited" || kind == "quota_exhausted" || status == 429.0 {
        return "rate_limited";
    }
    if kind == "overloaded" || status == 529.0 {
        return "overloaded";
    }
    if kind == "auth" || kind == "permission" || status == 401.0 || status == 403.0 {
        return "auth";
    }
    // A token-refresh timeout is a sign-in problem, not a slow model.
    let phase = str_of(get(err, "timeoutPhase"));
    if phase == Some(AUTH) {
        return "auth";
    }
    if (500.0..600.0).contains(&status) || code.as_deref().is_some_and(|code| SERVER_ERROR_CODES.contains(&code)) {
        return "server_error";
    }
    if phase == Some(IDLE) || str_of(get(err, "name")).is_some_and(|name| STALL_ERROR_NAMES.contains(&name)) || str_of(get(err, "code")) == Some("ESTREAMSTALL")
    {
        return "stalled";
    }
    // `firstByteTimeout` is the stamp the Anthropic first-message and OpenAI WS/HTTP first-event watchdogs put on their
    // errors.
    if is_first_byte_timeout(err)
        || get(err, "firstByteTimeout") == Some(&Value::Bool(true))
        || str_of(get(err, "name")) == Some("ProviderTimeoutError")
        || str_of(get(err, "code")) == Some("EPROVIDERTIMEOUT")
    {
        return "first_response_timeout";
    }
    "other"
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const NOW: f64 = 1_700_000_000_000.0;

    fn kind(err: Value) -> KindDescriptor {
        provider_error_kind(Some(&err), &KindOptions { now_ms: Some(NOW), ..KindOptions::default() })
    }

    #[test]
    fn typed_codes_and_statuses_decide() {
        assert_eq!(kind(json!({ "status": 429 })).kind, "rate_limited");
        assert_eq!(kind(json!({ "status": 529 })).kind, "overloaded");
        assert_eq!(kind(json!({ "status": 402, "code": "server_error" })).kind, "billing");
        assert_eq!(kind(json!({ "status": 400, "error": { "type": "invalid_request_error", "code": "context_length_exceeded" } })).kind, "context_overflow");
        assert_eq!(kind(json!({ "status": 429, "quotaScope": "day" })).kind, "quota_exhausted");
        assert_eq!(kind(json!({ "code": "resource_exhausted" })).kind, "rate_limited");
        assert_eq!(kind(json!({ "reauthRequired": true })).kind, "auth");
        assert_eq!(kind(json!("text")).kind, "unknown");
        assert_eq!(kind(json!({ "code": "ECONNRESET", "message": "x" })).kind, "transient");
    }

    #[test]
    fn untyped_wording_only_refines_request_refusals() {
        assert_eq!(kind(json!({ "status": 400, "message": "prompt is too long" })).kind, "context_overflow");
        assert_eq!(kind(json!({ "status": 429, "message": "model is at capacity" })).kind, "overloaded");
        assert_eq!(kind(json!({ "message": "prompt is too long" })).kind, "context_overflow");
        assert_eq!(kind(json!({ "status": 500, "message": "overloaded" })).kind, "transient");
        let untyped = |text| provider_error_kind(Some(&json!({ "message": text })), &KindOptions { legacy_quota_wording: true, ..KindOptions::default() }).kind;
        assert_eq!(untyped("You exceeded your current quota"), "billing");
        assert_eq!(untyped("hit your usage limit"), "quota_exhausted");
    }

    #[test]
    fn the_tool_surface_refusal_is_no_provider_kind() {
        let wrapped = json!({ "message": "wrapper", "cause": { "message": "x (TOOL_SURFACE_EXCEEDS_CONTEXT) context_length_exceeded", "code": "context_length_exceeded" } });
        let descriptor = kind(wrapped.clone());
        assert_eq!((descriptor.kind, descriptor.code.as_str()), ("unknown", TOOL_SURFACE_EXCEEDS_CONTEXT));
        assert!(is_tool_surface_exceeds_context_error(Some(&wrapped)));
        assert!(!is_tool_surface_exceeds_context_error(Some(&json!(5))));
    }

    #[test]
    fn retry_advice_follows_its_precedence() {
        let advice = |err: Value| retry_after_ms_from_error(Some(&err), NOW);
        assert_eq!(advice(json!({ "retryAfterMs": 1500, "headers": { "retry-after": "9" } })), Some(1500.0));
        assert_eq!(advice(json!({ "headers": { "Retry-After": "2" } })), Some(2000.0));
        assert_eq!(advice(json!({ "response": { "headers": { "retry-after-ms": ["250"] } } })), Some(250.0));
        assert_eq!(advice(json!({ "details": [{ "retryDelay": "3.5s" }] })), Some(3500.0));
        assert_eq!(advice(json!({ "retryAfterAt": NOW + 4000.0 })), Some(4000.0));
        assert_eq!(advice(json!({ "code": "rate_limit_exceeded", "message": "Please try again in 1.5 seconds" })), Some(1500.0));
        assert_eq!(advice(json!({ "message": "Please try again in 1.5 seconds" })), None);
        assert_eq!(advice(json!("x")), None);
    }

    #[test]
    fn retry_reasons_read_stamps_not_text() {
        let class = |err: Value| retry_reason_class(Some(&err), NOW);
        assert_eq!(class(json!({ "status": 429 })), "rate_limited");
        assert_eq!(class(json!({ "status": 503 })), "server_error");
        assert_eq!(class(json!({ "timeoutPhase": "auth" })), "auth");
        assert_eq!(class(json!({ "timeoutPhase": "idle" })), "stalled");
        assert_eq!(class(json!({ "timeoutPhase": "headers" })), "first_response_timeout");
        assert_eq!(class(json!({ "message": "first byte timed out" })), "other");
        assert_eq!(safe_retry_error_code(Some(&json!({ "code": "acct_123" })), NOW), None);
        assert_eq!(safe_retry_error_code(Some(&json!({ "code": "Rate_Limit_Exceeded" })), NOW).as_deref(), Some("rate_limit_exceeded"));
    }

    #[test]
    fn a_gateway_error_type_replaces_the_native_code() {
        let detail = json!({ "code": "server_error", "message": "m" });
        let envelope = json!({ "error_type": "authentication" });
        assert_eq!(
            normalize_gateway_error_detail(Some(&detail), Some(&envelope)),
            Some(json!({ "code": "authentication_error", "message": "m", "error_type": "authentication", "native_code": "server_error" }))
        );
        assert_eq!(normalize_gateway_error_detail(Some(&detail), None), Some(detail));
    }
}
