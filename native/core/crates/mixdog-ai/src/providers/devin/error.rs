//! Devin failures: Connect end-stream trailers, error response bodies and
//! protocol faults, each classified once into a [`ProviderError`].

use std::time::Duration;
use std::time::SystemTime;

use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ErrorResponse;
use mixdog_core_api::domain::provider::ProviderError;
use serde_json::Value;

use crate::providers::connect::ConnectFailure;
use crate::providers::connect::provider_error;
use crate::retry::advice;

/// Longest server text kept in an error message.
const MAX_DETAIL_CHARS: usize = 2000;

const REDACTED: &str = "[redacted]";

/// Server diagnostics may echo what the request carried: every known secret
/// is replaced before text is kept (longest first, so a secret that contains
/// another is replaced whole).
pub fn redact(text: &str, secrets: &[String]) -> String {
    let mut ordered: Vec<&String> = secrets.iter().filter(|s| !s.is_empty()).collect();
    ordered.sort_by_key(|s| std::cmp::Reverse(s.len()));
    let mut out = text.to_owned();
    for secret in ordered {
        out = out.replace(secret.as_str(), REDACTED);
    }
    out
}

/// One line, bounded; empty for markup or control characters (binary or
/// hostile output).
fn sanitize(text: &str) -> String {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let lower = normalized.to_ascii_lowercase();
    if lower.starts_with("<!doctype html") || lower.starts_with("<html") {
        return String::new();
    }
    if normalized.chars().any(|c| c.is_control()) {
        return String::new();
    }
    match normalized.char_indices().nth(MAX_DETAIL_CHARS) {
        Some((cut, _)) => format!("{}…", &normalized[..cut]),
        None => normalized,
    }
}

fn detail_text(details: Option<&Value>, secrets: &[String]) -> String {
    let Some(Value::Array(items)) = details else {
        return String::new();
    };
    let parts: Vec<String> = items
        .iter()
        .filter_map(|entry| {
            let kind = entry.get("type").and_then(Value::as_str).unwrap_or_default();
            let evidence = match entry.get("debug") {
                Some(Value::String(s)) => s.clone(),
                Some(other) => other.to_string(),
                None => entry
                    .get("value")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            };
            let part = [kind, evidence.as_str()]
                .iter()
                .filter(|s| !s.is_empty())
                .copied()
                .collect::<Vec<_>>()
                .join(": ");
            (!part.is_empty()).then_some(part)
        })
        .collect();
    sanitize(&redact(&parts.join("; "), secrets))
}

fn failure_message(operation: &str, code: &str, status: Option<u16>, detail: &str, details: &str) -> String {
    let mut head = format!("Devin {operation} {}", if code.is_empty() { "error" } else { code });
    if let Some(status) = status.filter(|s| *s != 0) {
        head.push_str(&format!(" (HTTP {status})"));
    }
    let mut text = if detail.is_empty() {
        head
    } else {
        format!("{head}: {detail}")
    };
    if !details.is_empty() {
        text.push_str(&format!(" [details: {details}]"));
    }
    text
}

fn retry_after_value(value: &Value) -> Option<Duration> {
    let first = match value {
        Value::Array(items) => items.first()?,
        other => other,
    };
    let text = match first {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => return None,
    };
    advice::from_headers(&[("retry-after".to_owned(), text)], SystemTime::now())
}

/// The error an end-stream trailer carries, or `None`: a trailer that is
/// not JSON, or has no error, means the stream simply ended.
pub fn trailer_error(payload: &[u8], operation: &str, secrets: &[String]) -> Option<ProviderError> {
    let parsed: Value = serde_json::from_slice(payload).ok()?;
    let error = parsed.get("error")?.as_object()?;
    let code = error.get("code").and_then(Value::as_str).unwrap_or_default();
    let message = error.get("message").and_then(Value::as_str).unwrap_or_default();
    if code.is_empty() && message.is_empty() {
        return None;
    }
    let code = if code.is_empty() { "unknown" } else { code };
    let detail = sanitize(&redact(message, secrets));
    let details = detail_text(error.get("details"), secrets);
    let retry_after = parsed
        .get("metadata")
        .and_then(|m| m.get("retry-after"))
        .and_then(retry_after_value);
    let lowered = code.to_ascii_lowercase();
    let mut out = provider_error(
        ConnectFailure {
            code: lowered.clone(),
            message: failure_message(operation, &lowered, None, &detail, &details),
            http_status: None,
            retry_after,
        },
        DeliveryState::Accepted,
    );
    mark_reauth(&mut out);
    Some(out)
}

/// A rejected sign-in names the re-auth step; the flag drives that, not text.
fn mark_reauth(error: &mut ProviderError) {
    if error.kind == ErrorKind::Auth && error.code.as_deref() == Some("unauthenticated") {
        error.reauth_required = true;
    }
}

/// A non-success HTTP response: a Connect JSON error body when present.
pub fn http_error(response: &ErrorResponse, operation: &str, secrets: &[String]) -> ProviderError {
    let status = response.status;
    let mut code = String::new();
    let mut message = String::new();
    let mut details: Option<Value> = None;
    if let Ok(parsed) = serde_json::from_slice::<Value>(&response.body) {
        code = parsed
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        message = [
            parsed.get("message"),
            parsed.get("error"),
            parsed.get("error").and_then(|e| e.get("message")),
        ]
        .into_iter()
        .flatten()
        .find_map(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default();
        details = parsed.get("details").cloned();
    } else if let Ok(text) = std::str::from_utf8(&response.body) {
        message = text.trim().to_owned();
    }
    let detail = sanitize(&redact(&message, secrets));
    let details = detail_text(details.as_ref(), secrets);
    let lowered = code.to_ascii_lowercase();
    let mut out = provider_error(
        ConnectFailure {
            code: lowered.clone(),
            message: failure_message(operation, &lowered, status, &detail, &details),
            http_status: status,
            retry_after: advice::from_headers(&response.headers, SystemTime::now()),
        },
        DeliveryState::Accepted,
    );
    if status == Some(413) {
        out.kind = ErrorKind::RequestTooLarge;
    }
    mark_reauth(&mut out);
    out
}

/// A fault in the framing or the payload of a response: not retried.
pub fn protocol_error(message: &str) -> ProviderError {
    let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::Accepted);
    error.code = Some("protocol".to_owned());
    error.message = format!("Devin protocol error: {message}");
    error
}

/// `transportError` (`devin-wire-transport.mjs:247-261`): what the raw `fetch` threw, as `Devin connection failed: …`
/// with every known secret redacted; an error that is not a transport fault passes unchanged.
pub fn connection_failed(mut error: ProviderError, secrets: &[String]) -> ProviderError {
    if error.transport.is_some() {
        error.message = format!("Devin connection failed: {}", redact(&error.message, secrets));
        error.code = Some("unavailable".to_owned());
    }
    error
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trailer_error_is_typed_by_code() {
        let e = trailer_error(
            br#"{"error":{"code":"resource_exhausted","message":"fixture quota"}}"#,
            "GetChatMessage",
            &[],
        )
        .unwrap();
        assert_eq!(e.kind, ErrorKind::RateLimited);
        assert_eq!(e.status, Some(429));
        assert_eq!(e.message, "Devin GetChatMessage resource_exhausted: fixture quota");
    }

    #[test]
    fn non_json_or_error_free_trailer_is_a_clean_end() {
        assert!(trailer_error(b"not json", "x", &[]).is_none());
        assert!(trailer_error(b"{}", "x", &[]).is_none());
    }

    #[test]
    fn secrets_never_survive_in_text() {
        let e = trailer_error(
            br#"{"error":{"code":"internal","message":"bad key devin-session-token$abc"}}"#,
            "op",
            &["devin-session-token$abc".to_owned(), "abc".to_owned()],
        )
        .unwrap();
        assert!(!e.message.contains("abc"));
    }
}
