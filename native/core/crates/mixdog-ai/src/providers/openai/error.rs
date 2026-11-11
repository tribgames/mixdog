//! Classification of a failed OpenAI response, run once at the adapter
//! boundary from typed fields only: HTTP status, headers, the parsed error
//! object (`code`, `type`, `resets_at`, `resets_in_seconds`) and WS close
//! codes. Message text is carried for logs and never inspected.

use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ErrorResponse;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::TransportFault;
use serde_json::Value;

const MESSAGE_LIMIT: usize = 200;

/// Precedence when a code and a type disagree: the most specific wins.
const KIND_RANK: [ErrorKind; 13] = [
    ErrorKind::Policy,
    ErrorKind::Billing,
    ErrorKind::Entitlement,
    ErrorKind::QuotaExhausted,
    ErrorKind::ContextOverflow,
    ErrorKind::RequestTooLarge,
    ErrorKind::Auth,
    ErrorKind::Permission,
    ErrorKind::ServiceTierUnavailable,
    ErrorKind::Overloaded,
    ErrorKind::RateLimited,
    ErrorKind::Transient,
    ErrorKind::InvalidRequest,
];

fn rank(kind: ErrorKind) -> usize {
    KIND_RANK
        .iter()
        .position(|k| *k == kind)
        .unwrap_or(KIND_RANK.len())
}

/// The kind a wire code names (`CODE_KINDS`, the OpenAI-relevant rows).
pub(super) fn kind_from_code(code: &str) -> Option<ErrorKind> {
    Some(match code {
        "cyber_policy" | "bio_policy" | "content_filter" | "safety" | "recitation"
        | "invalid_prompt" => ErrorKind::Policy,
        c if c.ends_with("_policy_violation") => ErrorKind::Policy,
        "insufficient_quota"
        | "credit_balance_exhausted"
        | "organization_spend_limit_exceeded"
        | "project_spend_limit_exceeded"
        | "organization_usage_limit_exceeded"
        | "billing_not_active"
        | "billing_hard_limit_reached"
        | "payment_required" => ErrorKind::Billing,
        "usage_not_included" => ErrorKind::Entitlement,
        "quota_exceeded" | "quota_exhausted" | "usage_limit_reached" => ErrorKind::QuotaExhausted,
        "context_length_exceeded" | "context_window_exceeded" | "model_context_window_exceeded" => {
            ErrorKind::ContextOverflow
        }
        "request_too_large" | "payload_too_large" | "request_entity_too_large" => {
            ErrorKind::RequestTooLarge
        }
        "invalid_api_key" | "authentication_error" | "unauthenticated" | "unauthorized"
        | "invalid_authentication" | "api_key_invalid" | "api_key_expired"
        | "access_token_expired" | "auth_context_expired" | "auth_expired" => ErrorKind::Auth,
        "permission_error" | "permission_denied" | "forbidden" | "service_disabled"
        | "api_key_service_blocked" => ErrorKind::Permission,
        "server_is_overloaded" | "overloaded_error" | "overloaded" | "server_overloaded"
        | "model_capacity_exhausted" | "model_capacity_exceeded" => ErrorKind::Overloaded,
        "flex_unavailable" => ErrorKind::ServiceTierUnavailable,
        "rate_limit_exceeded" | "rate_limit_error" | "rate_limited" | "slow_down"
        | "too_many_requests" => ErrorKind::RateLimited,
        "server_error" | "api_error" | "internal" | "internal_error" | "unavailable"
        | "service_unavailable" | "deadline_exceeded" | "timeout"
        | "previous_response_not_found" | "websocket_connection_limit_reached"
        | "stream_disconnected" | "network_error" | "malformed_stream" => ErrorKind::Transient,
        "invalid_request" | "invalid_request_error" | "invalid_argument"
        | "failed_precondition" | "bad_request" | "not_found" | "not_found_error"
        | "model_not_found" | "model_not_supported" | "unsupported_parameter" => {
            ErrorKind::InvalidRequest
        }
        _ => return None,
    })
}

fn kind_from_status(status: u16) -> Option<ErrorKind> {
    Some(match status {
        401 => ErrorKind::Auth,
        402 => ErrorKind::Billing,
        403 => ErrorKind::Permission,
        413 => ErrorKind::RequestTooLarge,
        429 => ErrorKind::RateLimited,
        529 => ErrorKind::Overloaded,
        408 | 409 | 425 => ErrorKind::Transient,
        // Edge-proxy statuses carry no verdict.
        525 | 526 => return None,
        400..=499 => ErrorKind::InvalidRequest,
        500..=599 => ErrorKind::Transient,
        _ => return None,
    })
}

fn lowered(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?.trim();
    (!text.is_empty()).then(|| text.to_ascii_lowercase())
}

/// Header lookup, case-insensitive.
pub(super) fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.trim())
}

fn retry_after(headers: &[(String, String)], now_ms: u64) -> Option<Duration> {
    let positive = |ms: f64| (ms.is_finite() && ms > 0.0).then(|| Duration::from_millis(ms.ceil() as u64));
    if let Some(ms) = header(headers, "retry-after-ms").and_then(|v| v.parse::<f64>().ok())
        && let Some(wait) = positive(ms)
    {
        return Some(wait);
    }
    let value = header(headers, "retry-after")?;
    if let Ok(seconds) = value.parse::<f64>() {
        return positive(seconds * 1000.0);
    }
    positive(mixdog_js::time::date_parse(value) - now_ms as f64)
}

/// Quota window reset: an absolute epoch (seconds or ms) or a delay.
fn reset_at(sources: &[&Value], now_ms: u64) -> Option<SystemTime> {
    for source in sources {
        let absolute = ["resets_at", "reset_at", "resetsAt"]
            .iter()
            .find_map(|key| source.get(*key))
            .and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())))
            .filter(|n| *n > 0.0);
        if let Some(n) = absolute {
            let ms = if n < 1e12 { n * 1000.0 } else { n };
            return Some(UNIX_EPOCH + Duration::from_millis(ms.round() as u64));
        }
        let relative = ["resets_in_seconds", "reset_in_seconds"]
            .iter()
            .find_map(|key| source.get(*key))
            .and_then(Value::as_f64)
            .filter(|n| *n > 0.0);
        if let Some(seconds) = relative {
            return Some(
                UNIX_EPOCH + Duration::from_millis(now_ms) + Duration::from_millis((seconds * 1000.0).round() as u64),
            );
        }
    }
    None
}

fn truncated(text: &str) -> String {
    text.chars().take(MESSAGE_LIMIT).collect()
}

/// The first typed HTTP status a wire error carries.
fn typed_status(sources: &[&Value]) -> Option<u16> {
    for source in sources {
        for key in ["httpStatus", "http_status", "status", "statusCode", "status_code", "code"] {
            let n = mixdog_js::to_number_of(source.get(key));
            if (100.0..=599.0).contains(&n)
            {
                return Some(n.floor() as u16);
            }
        }
    }
    None
}

/// Everything a failed response or wire error event carries.
pub(super) struct Failure<'a> {
    pub status: Option<u16>,
    pub headers: &'a [(String, String)],
    /// The error object (`error` of the body or event).
    pub error: Option<&'a Value>,
    /// The enclosing body or event.
    pub envelope: Option<&'a Value>,
    /// A wire error event without a code is transient; an HTTP body without
    /// one has no verdict beyond its status.
    pub wire_event: bool,
    pub message_fallback: &'a str,
    pub delivery: DeliveryState,
    pub now_ms: u64,
}

pub(super) fn classify(failure: &Failure<'_>) -> ProviderError {
    let code = lowered(failure.error.and_then(|e| e.get("code")))
        .or_else(|| lowered(failure.error.and_then(|e| e.get("type"))))
        .or_else(|| lowered(failure.envelope.and_then(|e| e.get("error"))));
    let kind_type = lowered(failure.error.and_then(|e| e.get("type")));
    let by_code = [code.as_deref(), kind_type.as_deref()]
        .into_iter()
        .flatten()
        .filter_map(kind_from_code)
        .min_by_key(|kind| rank(*kind));
    let status = failure.status.or_else(|| {
        let sources: Vec<&Value> = failure.error.into_iter().chain(failure.envelope).collect();
        typed_status(&sources)
    });
    let kind = by_code
        .or_else(|| status.and_then(kind_from_status))
        .unwrap_or(if failure.wire_event && status.is_none() {
            ErrorKind::Transient
        } else {
            ErrorKind::Unknown
        });
    let mut err = ProviderError::new(kind, failure.delivery);
    err.code = code;
    err.status = status;
    err.retry_after = retry_after(failure.headers, failure.now_ms);
    err.should_retry = header(failure.headers, "x-should-retry").and_then(|v| match v {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    });
    let sources: Vec<&Value> = failure.error.into_iter().chain(failure.envelope).collect();
    err.reset_at = reset_at(&sources, failure.now_ms);
    err.message = failure
        .error
        .and_then(|e| e.get("message"))
        .and_then(Value::as_str)
        .filter(|m| !m.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| truncated(failure.message_fallback));
    err
}

/// A non-success HTTP response (or a WebSocket upgrade rejection).
pub(super) fn classify_http(response: &ErrorResponse, now_ms: u64) -> ProviderError {
    let text = String::from_utf8_lossy(&response.body);
    let json: Option<Value> = serde_json::from_str(&text).ok();
    let envelope = json.as_ref().filter(|v| v.is_object());
    let error = envelope.map(|v| match v.get("error") {
        Some(e) if e.is_object() => e,
        _ => v,
    });
    classify(&Failure {
        status: response.status,
        headers: &response.headers,
        error,
        envelope,
        wire_event: false,
        message_fallback: &text,
        delivery: DeliveryState::Accepted,
        now_ms,
    })
}

/// `httpResponseError` (`openai-error-contract.mjs:261`): the message of a refused response (an HTTP/SSE request or a
/// WebSocket upgrade) under `label`, with the typed wire error's user copy in place of the server's own text
/// (`applyErrorContract`). `classified` is the response's classification (its code and reset time).
pub(super) fn http_response_message(label: &str, response: &ErrorResponse, classified: &ProviderError, now_ms: u64) -> String {
    let text = String::from_utf8_lossy(&response.body);
    let json: Option<Value> = serde_json::from_str(&text).ok();
    let error = json.as_ref().and_then(|j| match j.get("error") {
        Some(e) if e.is_object() => Some(e),
        _ => j.is_object().then_some(j),
    });
    let own = error.and_then(|e| e.get("message")).and_then(Value::as_str).unwrap_or_default();
    let diagnostic = mixdog_js::slice_utf16(if own.is_empty() { &text } else { own }, MESSAGE_LIMIT);
    let status = response.status.unwrap_or(0);
    let message = if diagnostic.is_empty() { format!("{label} {status}") } else { format!("{label} {status}: {diagnostic}") };
    let kind_type = error.and_then(|e| e.get("type")).and_then(Value::as_str).map(|t| t.trim().to_lowercase()).unwrap_or_default();
    let reset_ms = classified.reset_at.and_then(|at| at.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as f64);
    let mapped = typed_wire_message(classified.code.as_deref().unwrap_or_default(), &kind_type, error, &response.headers, reset_ms, now_ms);
    if mapped.is_empty() {
        return message;
    }
    // `applyTypedWireMessage`: the server's text at the end of the message is swapped for the copy.
    for needle in [own.to_owned(), mixdog_js::slice_utf16(own, MESSAGE_LIMIT)] {
        if !needle.is_empty() && message.ends_with(&needle) {
            return format!("{}{mapped}", &message[..message.len() - needle.len()]);
        }
    }
    if own.is_empty() && !message.is_empty() { format!("{message}: {mapped}") } else { message }
}

const QUOTA_EXCEEDED_CODES: [&str; 5] = [
    "insufficient_quota",
    "credit_balance_exhausted",
    "organization_spend_limit_exceeded",
    "project_spend_limit_exceeded",
    "organization_usage_limit_exceeded",
];

/// `typedWireErrorMessage`: the user copy of a typed wire error, empty when none applies.
fn typed_wire_message(code: &str, kind_type: &str, error: Option<&Value>, headers: &[(String, String)], reset_ms: Option<f64>, now_ms: u64) -> String {
    let named = |name: &str| header(headers, name).map(str::trim).unwrap_or_default().to_owned();
    if kind_type == "usage_limit_reached" || code == "usage_limit_reached" {
        let limit_id = named("x-codex-active-limit").to_lowercase().replace('_', "-");
        let limit_name = if limit_id.is_empty() { String::new() } else { named(&format!("x-{limit_id}-limit-name")) };
        let plan = error.and_then(|e| e.get("plan_type")).and_then(Value::as_str).unwrap_or_default();
        return usage_limit_message(plan, reset_ms, &named("x-codex-promo-message"), &named("x-codex-rate-limit-reached-type"), &limit_name, now_ms);
    }
    if kind_type == "usage_not_included" || code == "usage_not_included" {
        return "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.".into();
    }
    if QUOTA_EXCEEDED_CODES.contains(&code) || kind_type == "insufficient_quota" {
        return "Quota exceeded. Check your plan and billing details.".into();
    }
    if code == "server_is_overloaded" {
        return "Selected model is at capacity. Please try a different model.".into();
    }
    let fallback = match code {
        "websocket_connection_limit_reached" => {
            "Responses websocket connection limit reached (60 minutes). Create a new websocket connection to continue."
        }
        "previous_response_not_found" => "Previous response was not found. Retrying the full request.",
        _ => return String::new(),
    };
    let own = error.and_then(|e| e.get("message")).and_then(Value::as_str).unwrap_or_default();
    if own.trim().is_empty() { fallback.into() } else { String::new() }
}

/// `usageLimitMessage`: per-limit name first, then workspace credits / spend cap, then the promo, then the plan's copy.
fn usage_limit_message(plan: &str, reset_ms: Option<f64>, promo: &str, reached_type: &str, limit_name: &str, now_ms: u64) -> String {
    let at = reset_ms.filter(|ms| *ms != 0.0).map(|ms| retry_timestamp(ms, now_ms as f64)).unwrap_or_default();
    let suffix = if at.is_empty() { " Try again later.".to_owned() } else { format!(" Try again at {at}.") };
    let suffix_or = if at.is_empty() { " or try again later.".to_owned() } else { format!(" or try again at {at}.") };
    let name = limit_name.trim();
    if !name.is_empty() && !name.eq_ignore_ascii_case("codex") && !name.eq_ignore_ascii_case("gpt-reserve") {
        return format!("You’ve hit your usage limit for {name}. Switch to another model now,{suffix_or}");
    }
    let workspace = match reached_type.to_lowercase().as_str() {
        "workspace_owner_credits_depleted" => Some("Your workspace is out of credits. Add credits to continue."),
        "workspace_member_credits_depleted" => {
            Some("Your workspace is out of credits. Ask your workspace owner to refill in order to continue.")
        }
        "workspace_owner_usage_limit_reached" => {
            Some("You hit your spend cap set in your workspace. Increase your spend cap to continue.")
        }
        "workspace_member_usage_limit_reached" => Some(
            "You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.",
        ),
        _ => None,
    };
    if let Some(workspace) = workspace {
        return workspace.into();
    }
    if !promo.is_empty() {
        return format!("You’ve hit your usage limit. {promo},{suffix_or}");
    }
    match plan.to_lowercase().as_str() {
        "plus" => format!(
            "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits{suffix_or}"
        ),
        "team" | "self_serve_business_prolite" | "self_serve_business_usage_based" | "business" | "ent26"
        | "enterprise_cbp_automation" | "enterprise_cbp_usage_based" => {
            format!("You’ve hit your usage limit. To get more access now, send a request to your admin{suffix_or}")
        }
        "free" | "go" => format!(
            "You’ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus),{suffix_or}"
        ),
        "pro" | "prolite" | "promax" => {
            format!("You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits{suffix_or}")
        }
        _ => format!("You’ve hit your usage limit.{suffix}"),
    }
}

/// `formatRetryTimestamp`: "3:04 PM" on the local day of `now_ms`, else "Mar 5th, 2026 3:04 PM" (local time).
fn retry_timestamp(reset_ms: f64, now_ms: f64) -> String {
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let Some(reset) = mixdog_js::time::local_fields(reset_ms) else { return "Invalid Date".into() };
    let hour = match reset.hour % 12 {
        0 => 12,
        h => h,
    };
    let time = format!("{hour}:{:02} {}", reset.minute, if reset.hour < 12 { "AM" } else { "PM" });
    let today = mixdog_js::time::local_fields(now_ms).is_some_and(|now| (now.year, now.month, now.day) == (reset.year, reset.month, reset.day));
    if today {
        return time;
    }
    let ordinal = match reset.day {
        11..=13 => "th",
        d if d % 10 == 1 => "st",
        d if d % 10 == 2 => "nd",
        d if d % 10 == 3 => "rd",
        _ => "th",
    };
    format!("{} {}{ordinal}, {} {time}", MONTHS[reset.month as usize - 1], reset.day, reset.year)
}

/// `_httpStatusFromWsClose` (`openai-ws-events.mjs`): the status a close's code, or the words of its reason, stand for.
fn status_of_close(code: u16, reason: &str) -> Option<u16> {
    static WORDS: std::sync::LazyLock<[regex::Regex; 3]> = std::sync::LazyLock::new(|| {
        // JavaScript's `\b` is ASCII; `(?-u:\b)` is the same here.
        [
            r"(?-u:\b)(?:unauthorized|unauthorised|authentication|auth(?:enticated?)?|not authenticated|token expired|access token)(?-u:\b)",
            r"(?-u:\b)(?:forbidden|policy|permission denied)(?-u:\b)",
            r"(?-u:\b)(?:rate limit|quota)(?-u:\b)",
        ]
        .map(|pattern| regex::Regex::new(pattern).expect("a valid pattern"))
    });
    let reason = reason.to_lowercase();
    [(4401, 401), (4403, 403), (4429, 429)]
        .into_iter()
        .zip(WORDS.iter())
        .find(|((close, _), words)| code == *close || words.is_match(&reason))
        .map(|((_, status), _)| status)
}

/// `wsClosedError` (`openai-ws-terminal.mjs`): the socket closed before a terminal frame, with `ws`'s code (1005 for
/// a close without one) and reason.
pub fn ws_closed(code: u16, reason: &str, delivery: DeliveryState) -> ProviderError {
    let mut err = ProviderError::transport(TransportFault::WsClose { code: Some(code) }, delivery);
    if let Some(status) = status_of_close(code, reason) {
        err.kind = kind_from_status(status).unwrap_or(ErrorKind::Transient);
        err.status = Some(status);
    }
    let reason_part = if reason.is_empty() { String::new() } else { format!(", reason={reason}") };
    err.message = format!("OpenAI OAuth WS closed before response.completed (code={code}{reason_part})");
    err
}

#[cfg(test)]
mod tests {
    use super::*;

    // WS4: a close that ends a response is the error `wsClosedError` makes of it, for every close Node's recording
    // holds (`ws-close-error-capture.mjs`): the message, the close code and the status of the code or the reason's words.
    #[test]
    fn a_close_is_the_error_node_makes_of_it() {
        const RECORDING: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../benchmarks/terminal-bench-2.1/analysis/parity/fixtures/ws-close-errors.json"));
        const CAPTURE: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../benchmarks/terminal-bench-2.1/analysis/parity/ws-close-error-capture.mjs"));
        let node: Value = serde_json::from_str(RECORDING).unwrap();
        assert_eq!(node["manifest"]["exact"], true);
        assert_eq!(node["manifest"]["nodeCommit"], "b6f10295a");
        let sha: String = ring::digest::digest(&ring::digest::SHA256, CAPTURE).as_ref().iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(node["manifest"]["harness"]["ws-close-error-capture.mjs"], sha.as_str(), "ws-close-error-capture.mjs changed since the recording");
        let rust: Vec<Value> = node["cases"]
            .as_array()
            .unwrap()
            .iter()
            .map(|case| {
                let (code, reason) = (case["code"].as_u64().unwrap() as u16, case["reason"].as_str().unwrap());
                let err = ws_closed(code, reason, DeliveryState::Accepted);
                let close = match err.transport {
                    Some(TransportFault::WsClose { code }) => code,
                    _ => None,
                };
                serde_json::json!({ "code": code, "reason": reason, "message": err.message, "wsCloseCode": close, "httpStatus": err.status })
            })
            .collect();
        assert_eq!(Value::Array(rust), node["cases"]);
    }
}
