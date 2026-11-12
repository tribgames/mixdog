//! Google RPC errors → [`ProviderError`], as Node's `geminiRestError` / `antigravityError` / `geminiInBandError` build
//! them: the message names the route, the typed contract (`geminiErrorContract`: code, retry advice, reset instant,
//! quota scope) comes from the `ErrorInfo` / `QuotaFailure` / `RetryInfo` details, and the kind is read from the typed
//! codes (ranked as `providerErrorKind` ranks them), then the status.

use std::sync::LazyLock;
use std::time::Duration;
use std::time::SystemTime;

use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ErrorResponse;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::QuotaScope;
use mixdog_js::JsRegex;
use mixdog_js::to_number;
use mixdog_js::value_to_string;
use serde_json::Value;

use crate::retry::classify::kind_from_code;
use crate::retry::classify::kind_from_status;

/// The route an error belongs to: what its messages name and how it reads an overload.
#[derive(Clone, Debug)]
pub struct ErrorDialect {
    /// The route's name in its messages: `geminiRestError`'s label and the stream consumer's (`Gemini REST
    /// streamGenerateContent`, `Vertex AI Gemini streamGenerateContent`, `Antigravity streamGenerateContent`).
    pub label: &'static str,
    /// Antigravity (`antigravityError(res, text, endpoint)`): the endpoint its HTTP refusals name. A 503/529 there is
    /// the shared model pool's capacity, not a plain server fault.
    pub antigravity_endpoint: Option<String>,
}

impl ErrorDialect {
    pub fn gemini(label: &'static str) -> Self {
        Self { label, antigravity_endpoint: None }
    }

    pub fn antigravity(endpoint: impl Into<String>) -> Self {
        Self { label: "Antigravity streamGenerateContent", antigravity_endpoint: Some(endpoint.into()) }
    }
}

const CAPACITY_REASONS: [&str; 2] = ["model_capacity_exhausted", "model_capacity_exceeded"];
/// `ErrorInfo` reasons that name a spent allowance with no window of its own.
const TERMINAL_REASONS: [&str; 2] = ["quota_exhausted", "insufficient_g1_credits_balance"];
/// A per-minute quota with no RetryInfo is retried after one quota window (`GEMINI_PER_MINUTE_RETRY_MS`).
const PER_MINUTE_RETRY_MS: f64 = 60_000.0;

fn re(pattern: &str, flags: &str) -> JsRegex {
    JsRegex::new_static(pattern, flags)
}

static DURATION: LazyLock<JsRegex> = LazyLock::new(|| re(r"^(?:\d+(?:\.\d+)?(?:ms|s|m|h))+$", ""));
static DURATION_PART: LazyLock<JsRegex> = LazyLock::new(|| re(r"(\d+(?:\.\d+)?)(ms|s|m|h)", "g"));
static BARE_SECONDS: LazyLock<JsRegex> = LazyLock::new(|| re(r"^\d+(?:\.\d+)?$", ""));
/// "Please retry in 34.07s" (Gemini API) / "reset after 2h1m1s" (Cloud Code).
static MESSAGE_DELAY: LazyLock<JsRegex> =
    LazyLock::new(|| re(r"(?:please retry in|reset after)\s+((?:\d+(?:\.\d+)?(?:ms|h|m|s))+)", "i"));
static LIMIT_ZERO: LazyLock<JsRegex> = LazyLock::new(|| re(r"limit:\s*0(?!\d|\.\d)", "i"));
static CONTRACT_CAPACITY_MESSAGE: LazyLock<JsRegex> =
    LazyLock::new(|| re(r"exhausted your capacity|capacity exceeded|model_capacity_exhausted", "i"));
static SCOPE_DAY: LazyLock<JsRegex> = LazyLock::new(|| re(r"per[\s_-]?day|daily", "i"));
static SCOPE_MINUTE: LazyLock<JsRegex> = LazyLock::new(|| re(r"per[\s_-]?minute", "i"));
/// `antigravityError`'s rate-limit wordings, read on an untyped 429 only.
static ANTIGRAVITY_CAPACITY_MESSAGE: LazyLock<JsRegex> =
    LazyLock::new(|| re(r"capacity|overloaded|resource exhausted|server (?:is )?(?:currently )?busy", "i"));
static ANTIGRAVITY_RATE_LIMIT_MESSAGE: LazyLock<JsRegex> = LazyLock::new(|| re(r"per minute|rate limit|too many requests", "i"));
static VALIDATION_REQUIRED: LazyLock<JsRegex> = LazyLock::new(|| re(r"VALIDATION_REQUIRED", "i"));
static GOOGLE_ACCOUNT_URL: LazyLock<JsRegex> = LazyLock::new(|| re(r"https:\/\/\S*(?:accounts|console)\.google\.com\/\S+", ""));

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

/// `durationMs`: `"12.5s"`, `"1h2m3s"`, `"500ms"`, a bare number of seconds, or a `{seconds, nanos}` object, in whole
/// milliseconds rounded up; `None` for anything else.
fn duration_ms(value: &Value) -> Option<f64> {
    match value {
        Value::String(text) => {
            let text = mixdog_js::js_trim(text);
            if BARE_SECONDS.is_match(text) {
                return Some((mixdog_js::string_to_number(text) * 1000.0).ceil());
            }
            if !DURATION.is_match(text) {
                return None;
            }
            let mut total = 0.0;
            for part in DURATION_PART.captures_iter(text) {
                let unit = match part.get(2).unwrap_or_default() {
                    "ms" => 1.0,
                    "s" => 1000.0,
                    "m" => 60_000.0,
                    _ => 3_600_000.0,
                };
                total += mixdog_js::string_to_number(part.get(1).unwrap_or_default()) * unit;
            }
            Some(total.ceil())
        }
        Value::Object(map) => {
            // `Number(value.seconds || 0) * 1000 + Number(value.nanos || 0) / 1_000_000`.
            let number = |key: &str| map.get(key).filter(|v| js_truthy(v)).map_or(0.0, to_number);
            let ms = number("seconds") * 1000.0 + number("nanos") / 1_000_000.0;
            (ms.is_finite() && ms >= 0.0).then(|| ms.ceil())
        }
        _ => None,
    }
}

/// `adviceMs`: a zero wait is no advice.
fn advice_ms(value: Option<&Value>) -> Option<f64> {
    value.and_then(duration_ms).filter(|ms| *ms > 0.0)
}

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// `String(value || '')`.
fn js_string_or_empty(value: Option<&Value>) -> String {
    value.filter(|v| js_truthy(v)).map(value_to_string).unwrap_or_default()
}

/// `scopeOf`: day wins over minute.
fn scope_of(text: &str) -> Option<QuotaScope> {
    if SCOPE_DAY.is_match(text) {
        Some(QuotaScope::Day)
    } else if SCOPE_MINUTE.is_match(text) {
        Some(QuotaScope::Minute)
    } else {
        None
    }
}

/// `geminiErrorContract`'s output: the typed fields an error carries.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Contract {
    pub code: Option<String>,
    pub retry_after_ms: Option<f64>,
    /// Epoch milliseconds.
    pub reset_at_ms: Option<f64>,
    pub quota_scope: Option<QuotaScope>,
}

impl Contract {
    pub fn retry_after(&self) -> Option<Duration> {
        self.retry_after_ms.map(|ms| Duration::from_millis(ms as u64))
    }

    pub fn reset_at(&self) -> Option<SystemTime> {
        self.reset_at_ms.map(|ms| SystemTime::UNIX_EPOCH + Duration::from_millis(ms.max(0.0) as u64))
    }
}

/// `geminiErrorContract({ details, googleStatus, message })` at `now_ms` (`Date.now()`): `quotaScope` is
/// minute / day from the typed quota ids only, plan for a spent quota with no window (ErrorInfo QUOTA_EXHAUSTED, or a
/// QuotaFailure violation with a zero limit); capacity (MODEL_CAPACITY_EXHAUSTED, or capacity wording when nothing
/// typed said otherwise) is an overload of the shared pool, code `model_capacity_exhausted`, never a quota scope.
pub fn contract(details: Option<&Value>, google_status: Option<&Value>, message: Option<&Value>, now_ms: f64) -> Contract {
    let list = details.and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    let mut reason = String::new();
    let mut retry_after_ms: Option<f64> = None;
    let mut reset_at_ms: Option<f64> = None;
    let mut day = false;
    let mut minute = false;
    let mut add_scope = |scope: Option<QuotaScope>| match scope {
        Some(QuotaScope::Day) => day = true,
        Some(QuotaScope::Minute) => minute = true,
        _ => {}
    };
    let mut zero_limit = false;
    for entry in list {
        let kind = entry.get("@type").and_then(Value::as_str).unwrap_or("");
        if kind.ends_with(".RetryInfo") || entry.get("retryDelay").is_some() {
            if retry_after_ms.is_none() {
                retry_after_ms = advice_ms(entry.get("retryDelay"));
            }
        }
        if kind.ends_with(".QuotaFailure") || entry.get("violations").is_some_and(Value::is_array) {
            let violations = entry.get("violations").filter(|v| js_truthy(v)).and_then(Value::as_array);
            for violation in violations.into_iter().flatten() {
                add_scope(scope_of(&js_string_or_empty(violation.get("quotaId"))));
                let value = violation.get("quotaValue").filter(|v| !v.is_null()).map(value_to_string).unwrap_or_default();
                if mixdog_js::js_trim(&value) == "0" || LIMIT_ZERO.is_match(&js_string_or_empty(violation.get("description"))) {
                    zero_limit = true;
                }
            }
        }
        let typed_reason = entry.get("reason").and_then(Value::as_str);
        if kind.ends_with(".ErrorInfo") || typed_reason.is_some() {
            if reason.is_empty()
                && let Some(typed) = typed_reason
            {
                reason = mixdog_js::js_trim(typed).to_lowercase();
            }
            let metadata = entry.get("metadata").filter(|m| m.is_object() || m.is_array());
            let meta = |key: &str| metadata.and_then(|m| m.get(key));
            if retry_after_ms.is_none() {
                retry_after_ms = advice_ms(meta("quotaResetDelay"));
            }
            let stamp = mixdog_js::time::date_parse(&js_string_or_empty(meta("quotaResetTimeStamp")));
            if reset_at_ms.is_none() && stamp.is_finite() {
                reset_at_ms = Some(stamp);
            }
            let named: Vec<String> = [meta("quotaId"), meta("quota_limit"), meta("quota_metric"), entry.get("reason")]
                .into_iter()
                .flatten()
                .filter(|v| js_truthy(v))
                .map(value_to_string)
                .collect();
            add_scope(scope_of(&named.join(" ")));
        }
    }
    let text = message.and_then(Value::as_str).unwrap_or("");
    // The message names capacity only when nothing typed said otherwise.
    let capacity = CAPACITY_REASONS.contains(&reason.as_str())
        || (reason.is_empty() && !day && !minute && retry_after_ms.is_none() && CONTRACT_CAPACITY_MESSAGE.is_match(text));
    let mut quota_scope = if day {
        Some(QuotaScope::Day)
    } else if minute {
        Some(QuotaScope::Minute)
    } else {
        None
    };
    if retry_after_ms.is_none()
        && let Some(named) = MESSAGE_DELAY.captures(text)
    {
        retry_after_ms = advice_ms(Some(&Value::String(named.get(1).unwrap_or_default().to_owned())));
    }
    if retry_after_ms.is_none() && quota_scope == Some(QuotaScope::Minute) && !capacity {
        retry_after_ms = Some(PER_MINUTE_RETRY_MS);
    }
    if reset_at_ms.is_none()
        && let Some(ms) = retry_after_ms
    {
        reset_at_ms = Some(now_ms + ms);
    }
    if !capacity && quota_scope.is_none() && (TERMINAL_REASONS.contains(&reason.as_str()) || zero_limit) {
        quota_scope = Some(QuotaScope::Plan);
    }
    let status = google_status.and_then(Value::as_str).map(|s| mixdog_js::js_trim(s).to_lowercase()).unwrap_or_default();
    let code = if capacity {
        "model_capacity_exhausted".to_owned()
    } else if !reason.is_empty() {
        reason
    } else {
        status
    };
    Contract { code: (!code.is_empty()).then_some(code), retry_after_ms, reset_at_ms, quota_scope }
}

/// `KIND_RANK`: the most specific kind first.
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
    KIND_RANK.iter().position(|k| *k == kind).unwrap_or(KIND_RANK.len())
}

/// `providerErrorKind` over a Google error's typed facts: the most specific kind its typed codes name (the contract's
/// code and `error.status`; `resource_exhausted` reads the quota scope), else its status; then the quota window
/// adjusts a rate limit / quota reading.
fn kind_of(codes: &[String], status: Option<u16>, scope: Option<QuotaScope>) -> ErrorKind {
    let mut kind: Option<ErrorKind> = None;
    for code in codes {
        let candidate = if code == "resource_exhausted" {
            Some(match scope {
                Some(QuotaScope::Day | QuotaScope::Plan) => ErrorKind::QuotaExhausted,
                _ => ErrorKind::RateLimited,
            })
        } else {
            kind_from_code(code)
        };
        if let Some(candidate) = candidate
            && kind.is_none_or(|k| rank(candidate) < rank(k))
        {
            kind = Some(candidate);
        }
    }
    let kind = kind.or_else(|| status.and_then(kind_from_status)).unwrap_or(ErrorKind::Unknown);
    match (kind, scope) {
        (ErrorKind::QuotaExhausted, Some(QuotaScope::Minute)) => ErrorKind::RateLimited,
        (ErrorKind::RateLimited, Some(QuotaScope::Day | QuotaScope::Plan)) => ErrorKind::QuotaExhausted,
        (kind, _) => kind,
    }
}

/// `typedCodes`: the error's string codes, lowercased, once each (its `code`, then `error.status`).
fn typed_codes(code: Option<&str>, detail: Option<&Value>) -> Vec<String> {
    let mut codes: Vec<String> = Vec::new();
    let error_fields = ["code", "type", "status"].map(|key| detail.and_then(|d| d.get(key)).and_then(Value::as_str));
    for field in std::iter::once(code).chain(error_fields) {
        let Some(field) = field else { continue };
        let field = mixdog_js::js_trim(field).to_lowercase();
        if !field.is_empty() && !codes.contains(&field) {
            codes.push(field);
        }
    }
    codes
}

fn now_ms(now: SystemTime) -> f64 {
    now.duration_since(SystemTime::UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64)
}

/// The typed error both builders share: status, contract fields, kind.
fn typed_error(message: String, status: Option<u16>, code: Option<String>, detail: Option<&Value>, contract: &Contract) -> ProviderError {
    let mut err = ProviderError::new(ErrorKind::Unknown, DeliveryState::Accepted);
    err.kind = kind_of(&typed_codes(code.as_deref(), detail), status, contract.quota_scope);
    err.status = status;
    err.code = code;
    err.retry_after = contract.retry_after();
    err.reset_at = contract.reset_at();
    err.quota_scope = contract.quota_scope;
    err.message = message;
    err
}

/// The contract of an error object (`details ?? errorDetails`, `status`, `message`).
fn contract_of(detail: Option<&Value>, now: SystemTime) -> Contract {
    let Some(detail) = detail else { return Contract::default() };
    let details = detail.get("details").filter(|d| !d.is_null()).or_else(|| detail.get("errorDetails"));
    contract(details, detail.get("status"), detail.get("message"), now_ms(now))
}

/// `geminiRestError(res, text, label)`: a non-success response of the Gemini API or Vertex AI.
fn rest_error(response: &ErrorResponse, text: &str, label: &str, now: SystemTime) -> ProviderError {
    let payload: Option<Value> = if text.is_empty() { None } else { serde_json::from_str(text).ok() };
    // `payload?.error || payload || null`.
    let detail = payload.as_ref().and_then(|p| p.get("error").filter(|e| js_truthy(e))).or(payload.as_ref().filter(|p| js_truthy(p)));
    let status = response.status.map_or_else(|| "undefined".to_owned(), |s| s.to_string());
    let message = format!("{label} {status}: {}", mixdog_js::slice_utf16(text, 300));
    let contract = contract_of(detail, now);
    let mut err = typed_error(message, response.status, contract.code.clone(), detail, &contract);
    err.retry_after = err.retry_after.or_else(|| header_advice(&response.headers));
    err
}

/// `antigravityError(res, text, endpoint)`: a non-success response of the Antigravity gateway.
fn antigravity_error(response: &ErrorResponse, text: &str, endpoint: &str, now: SystemTime) -> ProviderError {
    let payload: Option<Value> = if text.is_empty() { None } else { serde_json::from_str(text).ok() };
    let detail = payload.as_ref().and_then(|p| p.get("error")).filter(|e| js_truthy(e));
    // `detail?.message || text?.slice(0, 300) || ''`.
    let message = detail
        .and_then(|d| d.get("message"))
        .filter(|m| js_truthy(m))
        .map(value_to_string)
        .unwrap_or_else(|| mixdog_js::slice_utf16(text, 300));
    let status = response.status.map_or_else(|| "undefined".to_owned(), |s| s.to_string());
    let scrubbed = crate::oauth::scrub::scrub_oauth_secrets(&message, &[]);
    let contract = if detail.is_some() {
        let details = detail.and_then(|d| d.get("details").filter(|v| !v.is_null()).or_else(|| d.get("errorDetails")));
        contract(details, detail.and_then(|d| d.get("status")), Some(&Value::String(message.clone())), now_ms(now))
    } else {
        Contract::default()
    };
    let mut err = typed_error(format!("Antigravity {status} ({endpoint}): {scrubbed}"), response.status, contract.code.clone(), detail, &contract);
    // Rate-limit reason: 503/529 are capacity by status unless a typed refusal names this request; a typed ErrorInfo
    // reason decides next; wording is the last resort for a 429.
    let capacity = || Some("model_capacity_exhausted".to_owned());
    match response.status {
        Some(503 | 529) if !err.kind.is_deterministic() => err.code = capacity(),
        Some(429)
            if !matches!(err.code.as_deref(), Some("quota_exhausted" | "rate_limit_exceeded" | "model_capacity_exhausted")) =>
        {
            if ANTIGRAVITY_CAPACITY_MESSAGE.is_match(&message) {
                err.code = capacity();
            } else if ANTIGRAVITY_RATE_LIMIT_MESSAGE.is_match(&message) {
                err.code = Some("rate_limit_exceeded".to_owned());
            }
        }
        _ => {}
    }
    err.kind = kind_of(&typed_codes(err.code.as_deref(), detail), response.status, contract.quota_scope);
    // Account verification is terminal and actionable: the URL Google puts in the details (Help links, then the
    // VALIDATION_REQUIRED metadata), else one the message names.
    if response.status == Some(403) && VALIDATION_REQUIRED.is_match(text) {
        let entries = detail.and_then(|d| d.get("details")).and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
        let help = entries
            .iter()
            .filter_map(|e| e.get("links").and_then(Value::as_array))
            .flatten()
            .filter_map(|l| l.get("url").and_then(Value::as_str))
            .find(|u| !u.is_empty());
        let metadata = |key: &str| {
            entries
                .iter()
                .find(|e| {
                    e.get("reason").and_then(Value::as_str) == Some("VALIDATION_REQUIRED")
                        && e.pointer(&format!("/metadata/{key}")).and_then(Value::as_str).is_some_and(|u| !u.is_empty())
                })
                .and_then(|e| e.pointer(&format!("/metadata/{key}")).and_then(Value::as_str))
        };
        let url = help
            .or_else(|| metadata("validation_url"))
            .or_else(|| metadata("validation_link"))
            .map(str::to_owned)
            .or_else(|| GOOGLE_ACCOUNT_URL.find(&message).map(|r| message[r].to_owned()))
            .unwrap_or_default();
        err.message = if url.is_empty() {
            "Antigravity requires account verification".to_owned()
        } else {
            format!("Antigravity requires account verification: open {url} , complete the check, then retry")
        };
        err.verification_url = (!url.is_empty()).then(|| url.as_str().into());
        err.unsafe_to_retry = true;
        err.account_blocked = true;
        if err.code.as_deref().is_none_or(str::is_empty) {
            err.code = Some("validation_required".to_owned());
        }
        err.kind = kind_of(&typed_codes(err.code.as_deref(), detail), response.status, contract.quota_scope);
    }
    err
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
}

/// `retry-after-ms`, then `retry-after` in seconds.
fn header_advice(headers: &[(String, String)]) -> Option<Duration> {
    if let Some(ms) = header(headers, "retry-after-ms").map(mixdog_js::string_to_number)
        && ms > 0.0
    {
        return Some(Duration::from_millis(ms.ceil() as u64));
    }
    let seconds = mixdog_js::string_to_number(header(headers, "retry-after")?);
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

/// A non-success HTTP response at `now` (the instant a retry advice's reset is counted from).
pub fn classify(response: &ErrorResponse, dialect: &ErrorDialect, now: SystemTime) -> ProviderError {
    let text = String::from_utf8_lossy(&response.body);
    match &dialect.antigravity_endpoint {
        Some(endpoint) => {
            let mut err = antigravity_error(response, &text, endpoint, now);
            err.retry_after = err.retry_after.or_else(|| header_advice(&response.headers));
            err
        }
        None => rest_error(response, &text, dialect.label, now),
    }
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
    let detail = mixdog_js::slice_utf16(&error.message, 200);
    error.message = format!(
        "[vertex-ai] {publisher}/{model} was not found or is not enabled for project {project} in {location}. \
         Check the model id and enable the model in Model Garden: {MODEL_GARDEN}/{publisher}/model-garden/{model}. \
         If {location} does not serve it, use {elsewhere} that does: {LOCATIONS_DOC} (HTTP {status}: {detail})"
    );
    error.code = Some(VERTEX_MODEL_NOT_ENABLED.to_owned());
}

/// `geminiInBandError(chunk, label)`: the `{error: ...}` envelope a stream carries in-band instead of a status, at
/// `now`; `None` for an ordinary payload.
pub fn in_band(chunk: &Value, dialect: &ErrorDialect, now: SystemTime) -> Option<ProviderError> {
    let detail = chunk.get("error").filter(|d| js_truthy(d) && (d.is_object() || d.is_string()))?;
    let body = match detail {
        Value::String(text) => serde_json::json!({ "message": text }),
        other => other.clone(),
    };
    let google_status = body.get("status").and_then(Value::as_str).unwrap_or("");
    let numeric = body.get("code").map_or(f64::NAN, to_number);
    let status = if numeric.is_finite() && numeric > 0.0 {
        Some(numeric as u16)
    } else {
        http_status_of(google_status)
    };
    // `String(body.message || googleStatus || 'unknown')`.
    let shown = match body.get("message").filter(|m| js_truthy(m)) {
        Some(message) => value_to_string(message),
        None if !google_status.is_empty() => google_status.to_owned(),
        None => "unknown".to_owned(),
    };
    let message = format!(
        "{} in-band error{}: {}",
        dialect.label,
        status.map(|s| format!(" {s}")).unwrap_or_default(),
        mixdog_js::slice_utf16(&shown, 300)
    );
    let contract = contract_of(Some(&body), now);
    // `applyGeminiErrorContract` keeps no prior code: the error has none.
    Some(typed_error(message, status, contract.code.clone(), Some(&body), &contract))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[derive(Clone, Copy)]
    enum Route {
        Gemini,
        Antigravity,
    }
    use Route::Antigravity as ANTIGRAVITY;
    use Route::Gemini as GEMINI;

    fn dialect(route: Route) -> ErrorDialect {
        match route {
            Route::Gemini => ErrorDialect::gemini("Vertex AI Gemini streamGenerateContent"),
            Route::Antigravity => ErrorDialect::antigravity("https://daily-cloudcode-pa.googleapis.com"),
        }
    }

    fn classify(response: &ErrorResponse, route: Route) -> ProviderError {
        super::classify(response, &dialect(route), SystemTime::UNIX_EPOCH)
    }

    fn in_band(chunk: &Value, route: Route) -> Option<ProviderError> {
        super::in_band(chunk, &dialect(route), SystemTime::UNIX_EPOCH)
    }

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
        // `vertexModelAccessError`'s detail is the error's own message (`geminiRestError`'s), cut at 200 units.
        assert!(err.message.ends_with("(HTTP 404: Vertex AI Gemini streamGenerateContent 404: {\"error\":{\"code\":404,\"message\":\"Publisher Model was not found\",\"status\":\"NOT_FOUND\"}})"));

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
        // An untyped 429 is a rate limit unless its wording names capacity (`antigravityError`).
        let untyped = classify(&response(429, json!({"error":{"message":"slow down"}})), ANTIGRAVITY);
        assert_eq!(untyped.kind, ErrorKind::RateLimited);
        let worded = classify(&response(429, json!({"error":{"message":"server busy, capacity exceeded"}})), ANTIGRAVITY);
        assert_eq!((worded.kind, worded.code.as_deref()), (ErrorKind::Overloaded, Some("model_capacity_exhausted")));
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
