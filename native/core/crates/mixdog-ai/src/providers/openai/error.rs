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

/// The socket closed before a terminal frame. Only close codes the server
/// defines for authorization carry a status.
pub fn ws_closed(code: Option<u16>, delivery: DeliveryState) -> ProviderError {
    let status = match code {
        Some(4401) => Some(401),
        Some(4403) => Some(403),
        Some(4429) => Some(429),
        _ => None,
    };
    let mut err = ProviderError::transport(TransportFault::WsClose { code }, delivery);
    if let Some(status) = status {
        err.kind = kind_from_status(status).unwrap_or(ErrorKind::Transient);
        err.status = Some(status);
    }
    err.message = match code {
        Some(code) => format!("WebSocket closed before the response completed (code={code})"),
        None => "WebSocket closed before the response completed".to_owned(),
    };
    err
}
