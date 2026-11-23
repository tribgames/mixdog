//! The display-only `reconnecting` stage a provider raises before each retry wait (`emitProviderRetryStage`,
//! retry-executor.mjs:346): a fixed reason class and phrase derived from the error's typed fields, never its text.

use std::time::Duration;

use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::StreamTimeoutPhase;
use serde_json::Value;
use serde_json::json;

use crate::service::error_text::format_duration_ms;
use crate::service::error_text::timed_out_ms;

/// `SERVER_ERROR_CODES` (provider-error-kind.mjs:735).
const SERVER_ERROR_CODES: [&str; 6] = ["server_error", "api_error", "internal", "internal_error", "unavailable", "service_unavailable"];

/// `safeRetryErrorCode`: the error's code when it is a word of the provider code vocabulary (`CODE_KINDS`, or
/// `resource_exhausted`, or a Responses auth code), else none.
fn safe_code(error: &ProviderError) -> Option<&str> {
    let code = error.code.as_deref()?;
    let known = crate::retry::classify::kind_from_code(code).is_some() || matches!(code, "resource_exhausted" | "auth_context_expired" | "auth_expired");
    known.then_some(code)
}

/// `retryReasonClass`.
fn reason_class(error: &ProviderError) -> &'static str {
    let status = error.status.unwrap_or(0);
    let code = safe_code(error);
    if error.kind == ErrorKind::Policy || error.code.as_deref().is_some_and(|c| c.trim().eq_ignore_ascii_case("content_filter")) {
        return "policy";
    }
    if matches!(error.kind, ErrorKind::RateLimited | ErrorKind::QuotaExhausted) || status == 429 {
        return "rate_limited";
    }
    if error.kind == ErrorKind::Overloaded || status == 529 {
        return "overloaded";
    }
    if matches!(error.kind, ErrorKind::Auth | ErrorKind::Permission) || status == 401 || status == 403 {
        return "auth";
    }
    if (500..600).contains(&status) || code.is_some_and(|c| SERVER_ERROR_CODES.contains(&c)) {
        return "server_error";
    }
    match error.timeout_phase {
        Some(StreamTimeoutPhase::Idle) => "stalled",
        Some(StreamTimeoutPhase::Headers | StreamTimeoutPhase::FirstChunk) => "first_response_timeout",
        None if error.timed_out => "first_response_timeout",
        None => "other",
    }
}

/// The phrase of a reason class (`RETRY_REASON_TEXT`, and `retryTimeoutText` for the two timeout classes with no
/// provider label).
fn reason_text(error: &ProviderError, class: &str) -> String {
    let ms = timed_out_ms(&error.message);
    match class {
        "rate_limited" => "Rate limited by the provider".into(),
        "overloaded" => "Provider overloaded".into(),
        "server_error" => "Provider server error".into(),
        "auth" => "Provider rejected the sign-in".into(),
        "policy" => "Safety filter refused the reply".into(),
        "first_response_timeout" if error.timeout_phase.is_some_and(StreamTimeoutPhase::is_first_byte) => {
            format!("Model still thinking: no output in {}; the provider sent nothing yet", format_duration_ms(ms))
        }
        "first_response_timeout" if ms > 0.0 => format!("No first response {}", format_duration_ms(ms)),
        "first_response_timeout" => "No first response".into(),
        "stalled" if ms > 0.0 => format!("No progress {}", format_duration_ms(ms)),
        "stalled" => "No progress".into(),
        _ => "Connection interrupted".into(),
    }
}

/// The `reconnecting` payload before the retry wait `wait` that runs attempt `attempt` of `max` (`now_ms`: `Date.now()`).
pub fn reconnecting(error: &ProviderError, attempt: u32, max: u32, wait: Duration, now_ms: u64) -> Value {
    let class = reason_class(error);
    let reason = reason_text(error, class);
    let wait_ms = wait.as_millis() as u64;
    let count = attempt.max(1);
    let max = max.max(count);
    let unbounded = max == u32::MAX;
    let tail = if wait_ms > 0 { format!(" in {}", format_duration_ms(wait_ms as f64)) } else { String::new() };
    let counter = if unbounded { count.to_string() } else { format!("{count}/{max}") };
    json!({
        "reasonClass": class,
        "attempt": attempt,
        "max": if unbounded { Value::Null } else { json!(max) },
        "waitMs": wait_ms,
        "retryAt": now_ms + wait_ms,
        "reason": reason,
        "classifier": safe_code(error),
        "message": format!("{reason} · retry {counter}{tail}"),
    })
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::domain::provider::DeliveryState;

    use super::*;

    fn error(kind: ErrorKind) -> ProviderError {
        ProviderError::new(kind, DeliveryState::NotSent)
    }

    #[test]
    fn a_content_filter_refusal_reads_as_a_policy_retry() {
        let mut refused = error(ErrorKind::Transient);
        refused.code = Some("content_filter".into());
        let payload = reconnecting(&refused, 1, 3, Duration::from_secs(2), 0);
        assert_eq!(payload["reasonClass"], "policy");
        assert_eq!(payload["message"], "Safety filter refused the reply · retry 1/3 in 2s");
    }

    #[test]
    fn a_retry_with_no_end_shows_the_attempt_without_a_total() {
        let payload = reconnecting(&error(ErrorKind::Transient), 7, u32::MAX, Duration::from_secs(30), 0);
        assert_eq!(payload["message"], "Connection interrupted · retry 7 in 30s");
        assert!(payload["max"].is_null());
    }
}
