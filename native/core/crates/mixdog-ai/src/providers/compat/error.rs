//! The single classification point of a failed OpenAI-compatible response or
//! in-band error event (PW §3, `openai-compat-error-contract.mjs`). The wire
//! error's fields are gathered here and handed to the shared classifier
//! ([`crate::retry::classify`]) once; the message text is read only by that
//! classifier's wording fallbacks (an undecided 400 naming a context overflow).

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use mixdog_core_api::domain::provider::{DeliveryState, ErrorResponse, ProviderError};
use mixdog_protocol::JsonValue;

use crate::retry::advice;
use crate::retry::classify::{Facts, OPENROUTER_IN_FLIGHT_BUDGET, kind_from_code, kind_of};

use super::profile::{CompatProfile, CredentialKind, ReauthText};

/// A gateway's canonical `error_type` (OpenRouter), mapped onto the typed
/// codes of the shared vocabulary. It replaces the lossy native code beside it.
const GATEWAY_ERROR_TYPES: &[(&str, &str)] = &[
    ("authentication", "authentication_error"),
    ("permission_denied", "permission_denied"),
    ("payment_required", "payment_required"),
    ("context_length_exceeded", "context_length_exceeded"),
    ("payload_too_large", "payload_too_large"),
    ("image_too_large", "request_too_large"),
    ("rate_limit_exceeded", "rate_limit_exceeded"),
    ("provider_overloaded", "overloaded"),
    ("provider_unavailable", "service_unavailable"),
    ("timeout", "timeout"),
    ("server", "server_error"),
    ("content_policy_violation", "content_policy_violation"),
    ("refusal", "content_policy_violation"),
    ("invalid_request", "invalid_request"),
    ("invalid_prompt", "invalid_request"),
    ("unprocessable", "invalid_request"),
    ("not_found", "not_found"),
    ("precondition_failed", "failed_precondition"),
];

fn lowered(value: Option<&JsonValue>) -> Option<String> {
    let text = match value? {
        JsonValue::String(s) => mixdog_js::js_trim(s).to_lowercase(),
        JsonValue::Number(n) => n.to_string(),
        _ => return None,
    };
    (!text.is_empty()).then_some(text)
}

/// `resets_in_seconds` (relative), else `resets_at`/`reset_at` as epoch
/// seconds, epoch milliseconds or an ISO date.
fn reset_at(detail: &JsonValue, now: SystemTime) -> Option<SystemTime> {
    if let Some(relative) = advice::resets_in(detail) {
        return Some(now + relative);
    }
    let raw = detail
        .get("resets_at")
        .or_else(|| detail.get("reset_at"))
        .or_else(|| detail.get("metadata").and_then(|m| m.get("resets_at")))?;
    if let Some(n) = raw.as_f64().or_else(|| raw.as_str().and_then(|s| s.parse().ok())) {
        if n <= 0.0 {
            return None;
        }
        let ms = if n < 1e12 { n * 1000.0 } else { n };
        return Some(UNIX_EPOCH + Duration::from_millis(ms.round() as u64));
    }
    let when = mixdog_js::time::date_parse(raw.as_str()?);
    if !when.is_finite() {
        return None;
    }
    Some(UNIX_EPOCH + Duration::from_millis(u64::try_from(when as i64).ok()?))
}

/// The wire error object of a body: `{error:{…}}`, `{error:"text"}` or a bare
/// `{code,message,type}`.
fn detail_of(body: &JsonValue) -> Option<&JsonValue> {
    match body.get("error") {
        Some(inner) if inner.is_object() => Some(inner),
        Some(_) => Some(body),
        None => body
            .as_object()
            .filter(|o| o.contains_key("code") || o.contains_key("message") || o.contains_key("type"))
            .map(|_| body),
    }
}

/// A numeric status the payload itself states (`status` or a numeric `code`).
fn typed_status(detail: Option<&JsonValue>) -> Option<u16> {
    let detail = detail?;
    ["status", "code"].iter().find_map(|key| {
        let n = match detail.get(key)? {
            JsonValue::Number(n) => n.as_u64()?,
            JsonValue::String(s) => {
                let n = mixdog_js::string_to_number(s);
                if n.is_finite() && n >= 0.0 && n.fract() == 0.0 { n as u64 } else { return None }
            }
            _ => return None,
        };
        (100..600).contains(&n).then_some(n as u16)
    })
}

/// Classifies a failed response or in-band error payload. The delivery state
/// is `Accepted`: a status or an event arrived.
pub fn classify_parts(
    profile: &CompatProfile,
    status: Option<u16>,
    headers: &[(String, String)],
    body: &JsonValue,
    now: SystemTime,
) -> ProviderError {
    let detail = detail_of(body);
    let status = status.or_else(|| typed_status(detail));
    let code = lowered(detail.and_then(|d| d.get("code")));
    let kind_type = lowered(detail.and_then(|d| d.get("type")));
    // The specific `code` outranks the envelope `type` beside it.
    let typed = [code.as_deref(), kind_type.as_deref()]
        .into_iter()
        .flatten()
        .find(|c| kind_from_code(c).is_some());
    let gateway = detail
        .and_then(|d| d.get("error_type").or_else(|| d.get("metadata").and_then(|m| m.get("error_type"))))
        .or_else(|| body.get("error_type"))
        .and_then(|v| lowered(Some(v)))
        .and_then(|key| {
            GATEWAY_ERROR_TYPES
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, mapped)| *mapped)
        });
    let retry_after = advice::from_headers(headers, now);
    // The in-flight budget refusal is the one code outside the vocabulary
    // that the classifier reads.
    let facts_code = if code.as_deref() == Some(OPENROUTER_IN_FLIGHT_BUDGET) {
        code.as_deref()
    } else {
        typed
    };
    let message = detail
        .and_then(|d| d.get("message"))
        .and_then(JsonValue::as_str)
        .or_else(|| body.get("error").and_then(JsonValue::as_str))
        .unwrap_or_default();
    let kind = kind_of(&Facts {
        status,
        code: facts_code,
        text: Some(message),
        gateway_error_type: gateway,
        retry_after,
        wire_error_without_code: status.is_none() && typed.is_none(),
        ..Facts::default()
    });

    let mut err = ProviderError::new(kind, DeliveryState::Accepted);
    err.status = status;
    err.code = code.or(kind_type);
    err.retry_after = retry_after;
    err.reset_at = detail.and_then(|d| reset_at(d, now));
    let rejected_key = status == Some(401)
        && matches!(
            profile.credential,
            CredentialKind::StaticKey {
                reauth_on_401: true
            }
        );
    let signed_out = status == Some(401) && profile.chat.reauth == ReauthText::SignInExpired;
    err.reauth_required = rejected_key || signed_out;
    let mut text = friendly_message(profile, detail, message);
    // The OpenAI SDK words an HTTP refusal `<status> <message>`.
    if profile.chat.status_in_message
        && let Some(code) = status
    {
        text = format!("{code} {text}");
    }
    err.message = if err.reauth_required { reauth_message(profile, &text) } else { text };
    err
}

const SIGN_IN_HINT: &str = "open /providers in mixdog to sign in again";

/// A refusal that needs a new sign-in, worded as the provider words it.
fn reauth_message(profile: &CompatProfile, refusal: &str) -> String {
    let id = profile.id;
    let refusal = mixdog_js::js_trim(refusal);
    match profile.chat.reauth {
        ReauthText::Plain => refusal.to_owned(),
        ReauthText::KeyRejected if refusal.is_empty() => {
            format!("[{id}] API key rejected (401) — {SIGN_IN_HINT}")
        }
        ReauthText::KeyRejected => format!("[{id}] API key rejected (401) — {SIGN_IN_HINT}: {refusal}"),
        ReauthText::ModelKeyRejected => {
            let detail = mixdog_js::slice_utf16(refusal, 300);
            let detail = mixdog_js::js_trim(&detail);
            if detail.is_empty() {
                format!("[{id}] Model API key rejected — {SIGN_IN_HINT}")
            } else {
                format!("[{id}] Model API key rejected ({detail}) — {SIGN_IN_HINT}")
            }
        }
        ReauthText::SignInExpired => {
            format!("[{id}] invalid_grant: OpenCode sign-in expired (inference 401) — {SIGN_IN_HINT}")
        }
    }
}

/// A gateway's block codes read better than their raw text; the gateway's own
/// `param` follows when it carries the real reason.
fn friendly_message(profile: &CompatProfile, detail: Option<&JsonValue>, message: &str) -> String {
    let code = detail.and_then(|d| lowered(d.get("code")));
    let base = code
        .as_deref()
        .and_then(|code| {
            profile
                .chat
                .friendly_codes
                .iter()
                .find(|(c, _)| *c == code)
                .map(|(_, text)| *text)
        })
        .unwrap_or(message);
    match detail.and_then(|d| d.get("param")).and_then(JsonValue::as_str) {
        Some(param) if !param.is_empty() && param != base && !base.is_empty() => {
            format!("{base}: {param}")
        }
        _ => base.to_owned(),
    }
}

/// `WireCodec::classify` for the family.
pub fn classify(profile: &CompatProfile, response: &ErrorResponse) -> ProviderError {
    // A body that is not JSON adds no detail; the status still classifies.
    let body = serde_json::from_slice::<JsonValue>(&response.body).unwrap_or(JsonValue::Null);
    classify_parts(profile, response.status, &response.headers, &body, SystemTime::now())
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixdog_core_api::domain::provider::ErrorKind;
    use serde_json::json;

    fn run(profile: &CompatProfile, status: u16, headers: &[(&str, &str)], body: JsonValue) -> ProviderError {
        let headers: Vec<(String, String)> = headers
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        classify_parts(profile, Some(status), &headers, &body, UNIX_EPOCH + Duration::from_secs(1_000))
    }

    #[test]
    fn typed_code_outranks_status_and_envelope_type() {
        let p = CompatProfile::mimo_oauth();
        let err = run(&p, 429, &[], json!({"error":{"code":"insufficient_quota","type":"rate_limit_error"}}));
        assert_eq!(err.kind, ErrorKind::Billing);
        assert_eq!(err.code.as_deref(), Some("insufficient_quota"));
        assert_eq!(err.delivery, DeliveryState::Accepted);
    }

    #[test]
    fn envelope_type_decides_when_the_code_is_not_typed() {
        let p = CompatProfile::deepseek();
        let err = run(&p, 400, &[], json!({"error":{"code":"weird","type":"context_length_exceeded"}}));
        assert_eq!(err.kind, ErrorKind::ContextOverflow);
    }

    #[test]
    fn status_classifies_without_a_code() {
        let p = CompatProfile::deepseek();
        for (status, kind) in [
            (401, ErrorKind::Auth),
            (402, ErrorKind::Billing),
            (413, ErrorKind::RequestTooLarge),
            (429, ErrorKind::RateLimited),
            (503, ErrorKind::Transient),
            (404, ErrorKind::InvalidRequest),
            (526, ErrorKind::Unknown),
        ] {
            assert_eq!(run(&p, status, &[], JsonValue::Null).kind, kind, "{status}");
        }
    }

    #[test]
    fn in_flight_budget_is_a_wait_not_a_bill() {
        let p = CompatProfile::openrouter();
        let body = json!({"error":{"code":"openrouter_in_flight_budget"}});
        let waited = run(&p, 402, &[("retry-after", "5")], body.clone());
        assert_eq!(waited.kind, ErrorKind::Transient);
        assert_eq!(waited.retry_after, Some(Duration::from_secs(5)));
        assert_eq!(run(&p, 402, &[("retry-after", "61")], body).kind, ErrorKind::Billing);
    }

    #[test]
    fn gateway_error_type_supersedes_the_native_code() {
        let p = CompatProfile::openrouter();
        let body = json!({"error":{"code":"server_error","metadata":{"error_type":"authentication"}}});
        assert_eq!(run(&p, 500, &[], body).kind, ErrorKind::Auth);
    }

    #[test]
    fn resets_and_friendly_codes() {
        let p = CompatProfile::mimo_oauth();
        let err = run(&p, 400, &[], json!({"error":{"code":421,"message":"raw","param":"prompt"}}));
        assert_eq!(err.message, "Request blocked by content moderation: prompt");
        let err = run(&p, 429, &[], json!({"error":{"code":"rate_limit_exceeded","resets_in_seconds":12}}));
        assert_eq!(err.reset_at, Some(UNIX_EPOCH + Duration::from_secs(1_012)));
        assert_eq!(err.kind, ErrorKind::RateLimited);
    }

    #[test]
    fn credential_rejection_asks_for_a_new_login_only_where_nothing_refreshes() {
        assert!(run(&CompatProfile::mimo_oauth(), 401, &[], JsonValue::Null).reauth_required);
        assert!(!run(&CompatProfile::xai(), 401, &[], JsonValue::Null).reauth_required);
    }

    #[test]
    fn an_in_band_error_without_any_evidence_is_transient() {
        let p = CompatProfile::xai();
        let err = classify_parts(&p, None, &[], &json!({"error":{"message":"boom"}}), SystemTime::now());
        assert_eq!(err.kind, ErrorKind::Transient);
    }
}
