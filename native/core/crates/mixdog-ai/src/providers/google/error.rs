//! Google RPC errors → [`ProviderError`], classified once from typed fields:
//! the HTTP status, `error.status`, the `ErrorInfo` reason and the quota
//! details. Message text is carried for logs and never matched.

use std::time::Duration;
use std::time::SystemTime;

use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ErrorResponse;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::QuotaScope;
use serde_json::Value;

/// How the endpoint reads an overload.
#[derive(Clone, Copy, Debug)]
pub struct ErrorDialect {
    /// A 503/529 names a saturated shared model pool (Antigravity), not a
    /// plain server fault.
    pub capacity_by_status: bool,
}

const CAPACITY_REASONS: [&str; 2] = ["model_capacity_exhausted", "model_capacity_exceeded"];
/// `ErrorInfo` reasons that name a spent allowance with no window of its own.
const TERMINAL_REASONS: [&str; 2] = ["quota_exhausted", "insufficient_g1_credits_balance"];

/// `error.status` → the HTTP status Google documents for it.
pub fn http_status_of(google_status: &str) -> Option<u16> {
    Some(match google_status.to_ascii_uppercase().as_str() {
        "INVALID_ARGUMENT" => 400,
        "UNAUTHENTICATED" => 401,
        "PERMISSION_DENIED" => 403,
        "NOT_FOUND" => 404,
        "RESOURCE_EXHAUSTED" => 429,
        "INTERNAL" => 500,
        "UNAVAILABLE" => 503,
        "DEADLINE_EXCEEDED" => 504,
        _ => return None,
    })
}

/// `"12.5s"`, `"1h2m3s"`, `"500ms"`, a bare number of seconds, or a
/// `{seconds, nanos}` object. Zero is no advice.
fn duration_of(value: &Value) -> Option<Duration> {
    let ms = match value {
        Value::String(text) => {
            let text = text.trim();
            if let Ok(seconds) = text.parse::<f64>() {
                (seconds * 1000.0).ceil()
            } else {
                let mut total = 0.0;
                let mut rest = text;
                if rest.is_empty() {
                    return None;
                }
                while !rest.is_empty() {
                    let end = rest.find(|c: char| !(c.is_ascii_digit() || c == '.'))?;
                    let amount: f64 = rest[..end].parse().ok()?;
                    rest = &rest[end..];
                    let (unit, len) = if rest.starts_with("ms") {
                        (1.0, 2)
                    } else if rest.starts_with('s') {
                        (1000.0, 1)
                    } else if rest.starts_with('m') {
                        (60_000.0, 1)
                    } else if rest.starts_with('h') {
                        (3_600_000.0, 1)
                    } else {
                        return None;
                    };
                    total += amount * unit;
                    rest = &rest[len..];
                }
                total.ceil()
            }
        }
        Value::Object(map) => {
            let seconds = map.get("seconds").and_then(as_f64_lenient).unwrap_or(0.0);
            let nanos = map.get("nanos").and_then(as_f64_lenient).unwrap_or(0.0);
            (seconds * 1000.0 + nanos / 1_000_000.0).ceil()
        }
        _ => return None,
    };
    (ms.is_finite() && ms > 0.0).then(|| Duration::from_millis(ms as u64))
}

fn as_f64_lenient(v: &Value) -> Option<f64> {
    v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))
}

/// Day wins over minute: a per-day violation outlasts a per-minute one
/// reported with it. The quota id is the only carrier of the window.
fn scope_of(text: &str) -> Option<QuotaScope> {
    let flat: String = text
        .chars()
        .filter(|c| !matches!(c, ' ' | '_' | '-' | '\t'))
        .flat_map(char::to_lowercase)
        .collect();
    if flat.contains("perday") || flat.contains("daily") {
        Some(QuotaScope::Day)
    } else if flat.contains("perminute") {
        Some(QuotaScope::Minute)
    } else {
        None
    }
}

#[derive(Default)]
struct Details {
    reason: String,
    retry_after: Option<Duration>,
    reset_at: Option<SystemTime>,
    scopes: Vec<QuotaScope>,
    zero_limit: bool,
    /// `google.rpc.Help` link or `VALIDATION_REQUIRED` metadata URL.
    validation_url: Option<String>,
}

fn read_details(list: &[Value]) -> Details {
    let mut out = Details::default();
    for entry in list {
        let kind = entry.get("@type").and_then(Value::as_str).unwrap_or("");
        if let Some(delay) = entry.get("retryDelay")
            && out.retry_after.is_none()
        {
            out.retry_after = duration_of(delay);
        }
        if kind.ends_with(".QuotaFailure") || entry.get("violations").is_some_and(Value::is_array) {
            for violation in entry.get("violations").and_then(Value::as_array).into_iter().flatten() {
                if let Some(scope) = violation.get("quotaId").and_then(Value::as_str).and_then(scope_of) {
                    out.scopes.push(scope);
                }
                let value = violation.get("quotaValue");
                let zero = match value {
                    Some(Value::String(s)) => s.trim() == "0",
                    Some(Value::Number(n)) => n.as_f64() == Some(0.0),
                    _ => false,
                };
                out.zero_limit |= zero;
            }
        }
        if kind.ends_with(".ErrorInfo") || entry.get("reason").is_some_and(Value::is_string) {
            let reason = entry.get("reason").and_then(Value::as_str).unwrap_or("").trim().to_lowercase();
            let meta = entry.get("metadata").and_then(Value::as_object);
            let meta_str = |k: &str| meta.and_then(|m| m.get(k)).and_then(Value::as_str);
            if out.reason.is_empty() {
                out.reason = reason.clone();
            }
            if out.retry_after.is_none()
                && let Some(delay) = meta.and_then(|m| m.get("quotaResetDelay"))
            {
                out.retry_after = duration_of(delay);
            }
            if out.reset_at.is_none()
                && let Some(stamp) = meta_str("quotaResetTimeStamp")
                && let at = mixdog_js::time::date_parse(stamp)
                && at.is_finite()
            {
                out.reset_at = Some(SystemTime::UNIX_EPOCH + Duration::from_millis(at.max(0.0) as u64));
            }
            let joined: Vec<&str> = ["quotaId", "quota_limit", "quota_metric"]
                .iter()
                .filter_map(|k| meta_str(k))
                .chain((!reason.is_empty()).then_some(reason.as_str()))
                .collect();
            if let Some(scope) = scope_of(&joined.join(" ")) {
                out.scopes.push(scope);
            }
            if reason == "validation_required" {
                out.validation_url = ["validation_url", "validation_link"]
                    .iter()
                    .filter_map(|k| meta_str(k))
                    .find(|u| !u.is_empty())
                    .map(str::to_owned);
            }
        }
        if out.validation_url.is_none() {
            out.validation_url = entry
                .get("links")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|l| l.get("url").and_then(Value::as_str))
                .find(|u| !u.is_empty())
                .map(str::to_owned);
        }
    }
    out
}

fn kind_of_code(code: &str, scope: Option<QuotaScope>) -> Option<ErrorKind> {
    Some(match code {
        "quota_exhausted" | "quota_exceeded" | "usage_limit_reached" => ErrorKind::QuotaExhausted,
        "insufficient_g1_credits_balance" | "billing_not_active" | "payment_required" => ErrorKind::Billing,
        "model_capacity_exhausted" | "model_capacity_exceeded" | "overloaded" | "server_overloaded" => {
            ErrorKind::Overloaded
        }
        "rate_limit_exceeded" | "rate_limited" | "too_many_requests" => ErrorKind::RateLimited,
        "resource_exhausted" => match scope {
            Some(QuotaScope::Day | QuotaScope::Plan) => ErrorKind::QuotaExhausted,
            _ => ErrorKind::RateLimited,
        },
        "unauthenticated" | "api_key_invalid" | "api_key_expired" | "access_token_expired" => ErrorKind::Auth,
        "permission_denied" | "service_disabled" | "api_key_service_blocked" | "iam_permission_denied"
        | "validation_required" => ErrorKind::Permission,
        "safety" | "recitation" | "content_filter" | "blocklist" | "prohibited_content" => ErrorKind::Policy,
        "context_length_exceeded" | "model_context_window_exceeded" => ErrorKind::ContextOverflow,
        "invalid_argument" | "failed_precondition" | "not_found" | "out_of_range" | "model_not_found" => {
            ErrorKind::InvalidRequest
        }
        "unavailable" | "internal" | "deadline_exceeded" | "aborted" | "server_error" => ErrorKind::Transient,
        _ => return None,
    })
}

fn kind_of_status(status: u16) -> ErrorKind {
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

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
}

/// `retry-after-ms`, then `retry-after` in seconds.
fn header_advice(headers: &[(String, String)]) -> Option<Duration> {
    if let Some(ms) = header(headers, "retry-after-ms").and_then(|v| v.trim().parse::<f64>().ok())
        && ms > 0.0
    {
        return Some(Duration::from_millis(ms.ceil() as u64));
    }
    let seconds = header(headers, "retry-after")?.trim().parse::<f64>().ok()?;
    (seconds > 0.0).then(|| Duration::from_millis((seconds * 1000.0).ceil() as u64))
}

/// The body's `{error: ...}` object; an array wrapper (Vertex) is unwrapped.
fn error_object(body: &Value) -> Option<Value> {
    let body = match body {
        Value::Array(items) => items.iter().find(|i| i.get("error").is_some())?,
        other => other,
    };
    match body.get("error")? {
        Value::Object(map) => Some(Value::Object(map.clone())),
        Value::String(text) => Some(serde_json::json!({ "message": text })),
        _ => None,
    }
}

fn build(
    status: Option<u16>,
    headers: &[(String, String)],
    error: Option<&Value>,
    raw_text: &str,
    delivery: DeliveryState,
    dialect: ErrorDialect,
) -> ProviderError {
    let google_status = error
        .and_then(|e| e.get("status"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let list: Vec<Value> = ["details", "errorDetails"]
        .iter()
        .filter_map(|k| error.and_then(|e| e.get(*k)).and_then(Value::as_array))
        .flatten()
        .cloned()
        .collect();
    let details = read_details(&list);
    let capacity = CAPACITY_REASONS.contains(&details.reason.as_str());
    let mut scope = if details.scopes.contains(&QuotaScope::Day) {
        Some(QuotaScope::Day)
    } else if details.scopes.contains(&QuotaScope::Minute) {
        Some(QuotaScope::Minute)
    } else {
        None
    };
    if !capacity
        && scope.is_none()
        && (TERMINAL_REASONS.contains(&details.reason.as_str()) || details.zero_limit)
    {
        scope = Some(QuotaScope::Plan);
    }
    let code = if capacity {
        "model_capacity_exhausted".to_owned()
    } else if !details.reason.is_empty() {
        details.reason.clone()
    } else {
        google_status.clone()
    };
    let by_code = [details.reason.as_str(), google_status.as_str()]
        .iter()
        .find_map(|c| kind_of_code(c, scope));
    let mut kind = by_code.or_else(|| status.map(kind_of_status)).unwrap_or(ErrorKind::Unknown);
    kind = match (kind, scope) {
        (ErrorKind::RateLimited, Some(QuotaScope::Day | QuotaScope::Plan)) => ErrorKind::QuotaExhausted,
        (ErrorKind::QuotaExhausted, Some(QuotaScope::Minute)) => ErrorKind::RateLimited,
        (kind, _) => kind,
    };
    if dialect.capacity_by_status && matches!(status, Some(503 | 529)) && !kind.is_deterministic() {
        kind = ErrorKind::Overloaded;
    }
    let message = error
        .and_then(|e| e.get("message"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| raw_text.chars().take(300).collect());
    let mut err = ProviderError::new(kind, delivery);
    err.status = status;
    err.code = (!code.is_empty()).then_some(code);
    err.retry_after = details.retry_after.or_else(|| header_advice(headers));
    err.reset_at = details.reset_at;
    err.quota_scope = scope;
    err.message = match (&details.validation_url, details.reason.as_str()) {
        (url, "validation_required") => format!(
            "account verification required{}",
            url.as_ref().map(|u| format!(": open {u}, complete the check, then retry")).unwrap_or_default()
        ),
        _ => message,
    };
    err
}

/// A non-success HTTP response.
pub fn classify(response: &ErrorResponse, dialect: ErrorDialect) -> ProviderError {
    let text = String::from_utf8_lossy(&response.body);
    let parsed: Option<Value> = serde_json::from_str(&text).ok();
    let error = parsed.as_ref().and_then(error_object);
    build(response.status, &response.headers, error.as_ref(), &text, DeliveryState::Accepted, dialect)
}

const MODEL_GARDEN: &str = "https://console.cloud.google.com/agent-platform/publishers";
const LOCATIONS_DOC: &str =
    "https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/locations";
/// The error code of a model the project cannot use.
pub const VERTEX_MODEL_NOT_ENABLED: &str = "VERTEX_MODEL_NOT_ENABLED";

/// A Vertex 404 means the model is not enabled for the project (or the id is
/// wrong). The message says so and where to enable it; status and the retry
/// classification stay as they were. An IAM denial (`IAM_PERMISSION_DENIED` in
/// the ErrorInfo details) is left alone. Only structured fields decide: the
/// HTTP status and `details[].reason`.
pub fn vertex_model_access(
    error: &mut ProviderError,
    response: &ErrorResponse,
    publisher: &str,
    model: &str,
    project: &str,
    location: &str,
) {
    let parsed: Option<Value> = serde_json::from_slice(&response.body).ok();
    let body = parsed.as_ref().and_then(error_object);
    let iam_reason = ["details", "errorDetails"]
        .iter()
        .filter_map(|k| body.as_ref().and_then(|e| e.get(*k)).and_then(Value::as_array))
        .flatten()
        .filter(|d| d.get("@type").and_then(Value::as_str).is_some_and(|t| t.ends_with("google.rpc.ErrorInfo")))
        .any(|d| d.get("reason").and_then(Value::as_str) == Some("IAM_PERMISSION_DENIED"));
    let status = error.status.unwrap_or(0);
    if status != 404 || iam_reason || error.code.as_deref() == Some(VERTEX_MODEL_NOT_ENABLED) {
        return;
    }
    // NOT_FOUND is also what a location that does not serve the model answers.
    let elsewhere = if location == "global" { "a region" } else { "the global location or a region" };
    let detail: String = error.message.chars().take(200).collect();
    error.message = format!(
        "[vertex-ai] {publisher}/{model} was not found or is not enabled for project {project} in {location}. \
         Check the model id and enable the model in Model Garden: {MODEL_GARDEN}/{publisher}/model-garden/{model}. \
         If {location} does not serve it, use {elsewhere} that does: {LOCATIONS_DOC} (HTTP {status}: {detail})"
    );
    error.code = Some(VERTEX_MODEL_NOT_ENABLED.to_owned());
}

/// The `{error: ...}` envelope a stream carries in-band instead of a status.
pub fn in_band(chunk: &Value, dialect: ErrorDialect) -> Option<ProviderError> {
    let error = error_object(chunk)?;
    let numeric = error.get("code").and_then(Value::as_u64).filter(|c| *c > 0).map(|c| c as u16);
    let status = numeric.or_else(|| {
        error.get("status").and_then(Value::as_str).and_then(http_status_of)
    });
    Some(build(status, &[], Some(&error), "", DeliveryState::Accepted, dialect))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const GEMINI: ErrorDialect = ErrorDialect { capacity_by_status: false };
    const ANTIGRAVITY: ErrorDialect = ErrorDialect { capacity_by_status: true };

    fn response(status: u16, body: Value) -> ErrorResponse {
        ErrorResponse { status: Some(status), headers: Vec::new(), body: body.to_string().into_bytes() }
    }

    #[test]
    fn vertex_404_names_model_garden_but_an_iam_denial_is_left_alone() {
        let not_found = response(404, json!({"error":{"code":404,"message":"Publisher Model was not found","status":"NOT_FOUND"}}));
        let mut err = classify(&not_found, GEMINI);
        let kind = err.kind;
        vertex_model_access(&mut err, &not_found, "google", "gemini-x", "p1", "us-central1");
        assert_eq!(err.code.as_deref(), Some(VERTEX_MODEL_NOT_ENABLED));
        assert_eq!(err.kind, kind);
        assert!(err.message.starts_with("[vertex-ai] google/gemini-x was not found or is not enabled for project p1 in us-central1. "));
        assert!(err.message.contains("If us-central1 does not serve it, use the global location or a region that does"));
        assert!(err.message.ends_with("(HTTP 404: Publisher Model was not found)"));

        let iam = response(404, json!({"error":{"code":404,"status":"NOT_FOUND","message":"x",
            "details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"IAM_PERMISSION_DENIED"}]}}));
        let mut err = classify(&iam, GEMINI);
        vertex_model_access(&mut err, &iam, "google", "gemini-x", "p1", "global");
        assert_ne!(err.code.as_deref(), Some(VERTEX_MODEL_NOT_ENABLED));

        // The enablement wording under another status is not a 404: no text is read.
        let wording = response(403, json!({"error":{"code":403,"status":"PERMISSION_DENIED",
            "message":"Project `p` is not allowed to use Publisher Model `m`"}}));
        let mut err = classify(&wording, GEMINI);
        vertex_model_access(&mut err, &wording, "google", "gemini-x", "p1", "global");
        assert_ne!(err.code.as_deref(), Some(VERTEX_MODEL_NOT_ENABLED));
    }

    #[test]
    fn recorded_fixture_bodies_classify_by_status() {
        let body = json!({"error":{"message":"fixture upstream error","type":"fixture_error","code":"401"}});
        assert_eq!(classify(&response(401, body.clone()), GEMINI).kind, ErrorKind::Auth);
        assert_eq!(classify(&response(400, body), GEMINI).kind, ErrorKind::InvalidRequest);
    }

    #[test]
    fn antigravity_capacity_and_rate_limit_come_from_status_and_code_fields() {
        let reason = |r: &str| json!({"error":{"code":429,"message":"x","status":"RESOURCE_EXHAUSTED",
            "details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":r,"metadata":{"quotaResetDelay":"3.5s"}}]}});
        let capacity = classify(&response(429, reason("MODEL_CAPACITY_EXHAUSTED")), ANTIGRAVITY);
        assert_eq!(capacity.kind, ErrorKind::Overloaded);
        assert_eq!(capacity.retry_after, Some(Duration::from_millis(3500)));
        assert_eq!(capacity.code.as_deref(), Some("model_capacity_exhausted"));
        let quota = classify(&response(429, reason("QUOTA_EXHAUSTED")), ANTIGRAVITY);
        assert_eq!((quota.kind, quota.quota_scope), (ErrorKind::QuotaExhausted, Some(QuotaScope::Plan)));
        let rpm = classify(&response(429, reason("RATE_LIMIT_EXCEEDED")), ANTIGRAVITY);
        assert_eq!(rpm.kind, ErrorKind::RateLimited);
        // Wording alone decides nothing: an untyped 429 is a rate limit.
        let untyped = classify(&response(429, json!({"error":{"message":"server busy, capacity exceeded"}})), ANTIGRAVITY);
        assert_eq!(untyped.kind, ErrorKind::RateLimited);
        let overloaded = classify(&response(503, json!({"error":{"message":"oops"}})), ANTIGRAVITY);
        assert_eq!(overloaded.kind, ErrorKind::Overloaded);
        assert_eq!(classify(&response(503, json!({"error":{"message":"oops"}})), GEMINI).kind, ErrorKind::Transient);
        assert_eq!(classify(&response(529, json!({})), ANTIGRAVITY).kind, ErrorKind::Overloaded);
        let denied = classify(
            &response(503, json!({"error":{"status":"PERMISSION_DENIED","message":"no"}})),
            ANTIGRAVITY,
        );
        assert_eq!(denied.kind, ErrorKind::Permission, "a typed refusal is not an overload");
    }

    #[test]
    fn google_quota_window_decides_between_rate_limit_and_quota() {
        let failure = |quota_id: &str| json!({"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"q",
            "details":[{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[{"quotaId":quota_id}]},
                       {"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"12s"}]}});
        let minute = classify(&response(429, failure("GenerateRequestsPerMinutePerProject")), GEMINI);
        assert_eq!((minute.kind, minute.retry_after), (ErrorKind::RateLimited, Some(Duration::from_secs(12))));
        let day = classify(&response(429, failure("GenerateRequestsPerDayPerProject")), GEMINI);
        assert_eq!((day.kind, day.quota_scope), (ErrorKind::QuotaExhausted, Some(QuotaScope::Day)));
    }

    #[test]
    fn vertex_array_wrapper_and_in_band_envelope() {
        let wrapped = json!([{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"slow"}}]);
        assert_eq!(classify(&response(429, wrapped), GEMINI).kind, ErrorKind::RateLimited);
        let err = in_band(&json!({"error":{"status":"UNAVAILABLE","message":"down"}}), GEMINI).unwrap();
        assert_eq!((err.kind, err.status), (ErrorKind::Transient, Some(503)));
        assert!(in_band(&json!({"candidates":[]}), GEMINI).is_none());
    }

    #[test]
    fn retry_after_headers_follow_body_advice() {
        let mut r = response(503, json!({"error":{"message":"x"}}));
        r.headers = vec![("Retry-After".into(), "2".into())];
        assert_eq!(classify(&r, GEMINI).retry_after, Some(Duration::from_secs(2)));
        r.headers.push(("retry-after-ms".into(), "1500".into()));
        assert_eq!(classify(&r, GEMINI).retry_after, Some(Duration::from_millis(1500)));
    }
}
