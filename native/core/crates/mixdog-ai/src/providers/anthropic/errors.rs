//! Typed classification of Anthropic failures: HTTP responses and in-stream
//! `error` events. Runs once at the adapter boundary; the result carries every
//! field the retry and account layers read.

use std::time::Duration;
use std::time::SystemTime;

use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ErrorResponse;
use mixdog_core_api::domain::provider::ProviderError;
use serde_json::Value;

const RESET_HEADER: &str = "anthropic-ratelimit-unified-reset";
/// A subscription-window refusal carries one of these. A 429 without them is a
/// capacity blip or a routing refusal: the account's quota is not exhausted.
const QUOTA_HEADERS: [&str; 2] = [
    "anthropic-ratelimit-unified-representative-claim",
    "anthropic-ratelimit-unified-overage-status",
];

/// Anthropic's documented error-type enumeration → kind.
fn kind_for_code(code: &str) -> Option<ErrorKind> {
    Some(match code {
        "invalid_request_error" | "not_found_error" => ErrorKind::InvalidRequest,
        "authentication_error" => ErrorKind::Auth,
        "permission_error" => ErrorKind::Permission,
        "request_too_large" => ErrorKind::RequestTooLarge,
        "rate_limit_error" => ErrorKind::RateLimited,
        "overloaded_error" => ErrorKind::Overloaded,
        "billing_error" => ErrorKind::Billing,
        "api_error" | "timeout_error" | "conflict_error" => ErrorKind::Transient,
        // Any other type is read in the shared code vocabulary (`CODE_KINDS`): an endpoint speaking the Messages
        // wire may name `insufficient_quota`, which Node's pool takes as a quota refusal.
        other => return crate::retry::classify::kind_from_code(other),
    })
}

/// The HTTP status an in-stream error type stands for.
fn status_for_code(code: &str) -> Option<u16> {
    Some(match code {
        "invalid_request_error" => 400,
        "authentication_error" => 401,
        "permission_error" => 403,
        "not_found_error" => 404,
        "conflict_error" => 409,
        "request_too_large" => 413,
        "rate_limit_error" => 429,
        "api_error" => 500,
        "timeout_error" => 504,
        "overloaded_error" => 529,
        _ => return None,
    })
}

fn kind_for_status(status: u16) -> ErrorKind {
    match status {
        401 => ErrorKind::Auth,
        402 => ErrorKind::Billing,
        403 => ErrorKind::Permission,
        413 => ErrorKind::RequestTooLarge,
        429 => ErrorKind::RateLimited,
        529 => ErrorKind::Overloaded,
        408 | 409 | 425 => ErrorKind::Transient,
        525 | 526 => ErrorKind::Unknown,
        400..=499 => ErrorKind::InvalidRequest,
        500..=599 => ErrorKind::Transient,
        _ => ErrorKind::Unknown,
    }
}

pub(crate) fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

fn lowered_type(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?.trim();
    (!text.is_empty() && text != "error").then(|| text.to_lowercase())
}

/// `retryAfterMsFromHeaders`: `retry-after-ms`, then `retry-after` seconds, in ms and uncapped. A
/// header that is empty, zero, negative or not a finite number is no advice, and the next one is
/// read (`finitePositive`); the HTTP-date form of `retry-after` is not read.
pub(super) fn retry_after_ms(headers: &[(String, String)]) -> Option<f64> {
    let positive = |name: &str| {
        header(headers, name)
            .filter(|value| !value.is_empty())
            .map(mixdog_js::string_to_number)
            .filter(|n| n.is_finite() && *n > 0.0)
    };
    positive("retry-after-ms").or_else(|| positive("retry-after").map(|secs| (secs * 1000.0).ceil()))
}

fn retry_after(headers: &[(String, String)]) -> Option<Duration> {
    retry_after_ms(headers).map(|ms| Duration::from_millis(ms.ceil() as u64))
}

/// `anthropicQuotaError`'s message (`anthropic-oauth-request/initial-status.mjs`): the text a
/// cache warm's refused POST fails with on the subscription wire.
pub(super) fn quota_error_text(response: &ErrorResponse) -> String {
    let retry = retry_after(&response.headers).map_or_else(String::new, |after| {
        let ms = after.as_millis();
        let shown = if ms >= 60_000 && ms % 60_000 == 0 {
            format!("{}m", ms / 60_000)
        } else if ms >= 1000 {
            format!("{}s", ms.div_ceil(1000))
        } else {
            format!("{ms}ms")
        };
        format!(" retryAfter={shown}")
    });
    // Node scrubs the body (`provider.scrubTokens`) before the quota error cuts it to 200 characters.
    let body = crate::oauth::scrub::scrub_oauth_secrets(&String::from_utf8_lossy(&response.body), &[]);
    let detail = if body.is_empty() { String::new() } else { format!(": {}", mixdog_js::slice_utf16(&body, 200)) };
    let quota = ["anthropic-ratelimit-unified-representative-claim", "anthropic-ratelimit-unified-overage-status"]
        .iter()
        .any(|name| header(&response.headers, name).is_some_and(|v| !v.is_empty()));
    let kind = if quota { "quota/rate limit" } else { "request rejected" };
    format!("Anthropic OAuth API {} {kind}{retry}{detail}", response.status.unwrap_or(0))
}
/// The unified rate-limit window reset (epoch seconds).
fn reset_at(headers: &[(String, String)]) -> Option<SystemTime> {
    let secs = mixdog_js::string_to_number(header(headers, RESET_HEADER)?);
    (secs.is_finite() && secs > 0.0)
        .then(|| SystemTime::UNIX_EPOCH + Duration::from_millis((secs * 1000.0).ceil() as u64))
}

fn truncate_chars(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// The message the Anthropic SDK's `APIError` carries for a refused request (`makeMessage`): the body's
/// `message` when it has one, else the parsed body as JSON, else its text, after the status.
pub(crate) fn sdk_message(response: &ErrorResponse) -> String {
    let text = String::from_utf8_lossy(&response.body);
    let msg = match serde_json::from_str::<Value>(&text) {
        Ok(body) => match body.get("message") {
            Some(Value::String(m)) if !m.is_empty() => m.clone(),
            Some(m) if !matches!(m, Value::Null | Value::Bool(false) | Value::String(_)) && m.as_f64() != Some(0.0) => m.to_string(),
            _ => body.to_string(),
        },
        Err(_) => text.into_owned(),
    };
    match response.status {
        Some(status) if !msg.is_empty() => format!("{status} {msg}"),
        Some(status) => format!("{status} status code (no body)"),
        None if !msg.is_empty() => msg,
        None => "(no status code or body)".to_owned(),
    }
}

/// Anthropic's documented error type for a status (`STATUS_ERROR_TYPE`), when the body names none.
fn status_type(status: u16) -> Option<&'static str> {
    Some(match status {
        400 => "invalid_request_error",
        401 => "authentication_error",
        403 => "permission_error",
        404 => "not_found_error",
        409 => "conflict_error",
        429 => "rate_limit_error",
        500 => "api_error",
        504 => "timeout_error",
        529 => "overloaded_error",
        _ => return None,
    })
}

/// The single classification point of a non-success HTTP response.
pub(crate) fn classify_response(response: &ErrorResponse) -> ProviderError {
    let body: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
    let wire_type = lowered_type(body.pointer("/error/type")).or_else(|| lowered_type(body.get("type")));
    let provider_message = body
        .pointer("/error/message")
        .and_then(Value::as_str)
        .map(str::to_owned);
    // A 413 is a byte-size refusal, never a prompt-token one.
    let code = if response.status == Some(413) {
        Some("request_too_large".to_owned())
    } else {
        wire_type
    };
    let mut kind = code
        .as_deref()
        .and_then(kind_for_code)
        .or_else(|| response.status.map(kind_for_status))
        .unwrap_or(ErrorKind::Transient);
    let quota_headers = QUOTA_HEADERS
        .iter()
        .any(|name| header(&response.headers, name).is_some_and(|v| !v.is_empty()));
    if response.status == Some(429) && quota_headers {
        kind = ErrorKind::QuotaExhausted;
    }
    let mut err = ProviderError::new(kind, DeliveryState::Accepted);
    err.status = response.status;
    // `applyAnthropicErrorContract`: a body that names no type gets the documented one for its status.
    err.code = code.or_else(|| response.status.and_then(status_type).map(str::to_owned));
    err.retry_after = retry_after(&response.headers);
    err.reset_at = reset_at(&response.headers);
    err.should_retry = match header(&response.headers, "x-should-retry").map(str::trim) {
        Some("true") => Some(true),
        Some("false") => Some(false),
        _ => None,
    };
    let detail = provider_message
        .unwrap_or_else(|| truncate_chars(&String::from_utf8_lossy(&response.body), 200));
    err.message = match response.status {
        Some(status) => format!("Anthropic API {status}: {detail}"),
        None => format!("Anthropic API: {detail}"),
    };
    err
}

/// A typed in-stream `error` event (or an event carrying an `error` object).
pub(crate) fn classify_stream_error(event: &Value) -> ProviderError {
    let payload = event.get("error").filter(|e| e.is_object()).unwrap_or(event);
    let wire_type = lowered_type(payload.get("type"))
        .or_else(|| lowered_type(payload.get("code")))
        .or_else(|| lowered_type(event.get("type")));
    let numeric = [payload.get("status"), event.get("status")]
        .into_iter()
        .flatten()
        .filter_map(Value::as_u64)
        .find(|s| (400..600).contains(s))
        .map(|s| s as u16);
    let status = numeric.or_else(|| wire_type.as_deref().and_then(status_for_code));
    let kind = wire_type
        .as_deref()
        .and_then(kind_for_code)
        .or_else(|| status.map(kind_for_status))
        // An error event with no usable type or status is transient.
        .unwrap_or(ErrorKind::Transient);
    let mut err = ProviderError::new(kind, DeliveryState::Accepted);
    err.status = status;
    err.code = if status == Some(413) { Some("request_too_large".into()) } else { wire_type };
    err.message = format!(
        "Anthropic SSE error {}: {}",
        err.code.as_deref().unwrap_or("error"),
        payload
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Anthropic SSE error")
    );
    err
}
