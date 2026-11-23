//! `presentErrorText` (`runtime/shared/err-text.mjs`) with the `describeError`
//! (`error-presentation.mjs`), `transportErrorText` (`transport-error-text.mjs`) and
//! `safeErrorDetails` it is built from: the one user-facing text of a provider failure.
//!
//! Node reads a thrown object's fields; Rust reads an [`ErrorView`] of the same fields. A
//! [`ProviderError`] converts with `ErrorView::from`, any other failure (a watchdog, a bare
//! string) is built with [`ErrorView::message`] and its fields. `providerErrorKind` is
//! `retry::classify` (typed facts plus its wording fallbacks): Rust providers stamp
//! [`ErrorKind`] at the adapter boundary, so the view carries that verdict as its
//! [`Descriptor`]. A failure with no descriptor reads as
//! `unknown`, and then only the wording rules of `presentErrorText` itself apply.

use std::sync::LazyLock;

use mixdog_core_api::domain::provider::{DeliveryState, ErrorKind, ProviderError, TransportFault};
use mixdog_js::{js_trim, number_to_string, slice_utf16, utf16_len, value_to_string};
use regex::Regex;
use serde_json::Value;

macro_rules! re {
    ($pattern:expr) => {{
        static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new($pattern).expect("static pattern"));
        &*RE
    }};
}

const DETAILS_LIMIT: usize = 12_000;
const SUMMARY_LIMIT: usize = 180;
/// The longest a failure that already names its causes (a fallback chain's every model) is cut at.
const PRESENTED_LIMIT: f64 = 1_200.0;

/// The phase a provider timeout names (`provider-timeout-phase.mjs`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TimeoutPhase {
    Headers,
    FirstChunk,
    Idle,
    Auth,
}

/// What `providerErrorKind` answered for the failure.
#[derive(Clone, PartialEq, Debug)]
pub struct Descriptor {
    /// One of `PROVIDER_ERROR_KINDS`.
    pub kind: String,
    pub code: String,
    pub status: u32,
    pub retry_after_ms: Option<u64>,
    pub reset_at: Option<u64>,
}

impl Descriptor {
    pub fn unknown() -> Self {
        Self { kind: "unknown".into(), code: String::new(), status: 0, retry_after_ms: None, reset_at: None }
    }
}

/// The fields of a failure `presentErrorText` reads.
#[derive(Clone, PartialEq, Debug, Default)]
pub struct ErrorView {
    /// False for a bare string: Node's `typeof error === 'object'` checks.
    pub is_object: bool,
    pub message: String,
    pub name: String,
    /// `error.code`, as sent.
    pub code: String,
    /// `httpStatus || status || response.status`; 0 when none.
    pub status: u32,
    pub retry_after_ms: u64,
    pub descriptor: Option<Descriptor>,
    pub reauth_required: bool,
    pub cancelled: bool,
    pub stream_corruption: bool,
    pub timeout_phase: Option<TimeoutPhase>,
    pub waited_ms: u64,
    pub attempts: u64,
    pub ws_close_code: Option<u32>,
    /// What ended the link or stream, for a failure that came from a Rust transport.
    pub fault: Option<TransportFault>,
    /// How far the request got when it failed, for a failure that came from a Rust provider adapter: the text of a failure
    /// with no message of its own is derived from it.
    pub delivery: Option<DeliveryState>,
}

/// The text of a provider failure for a surface: its own message, else what the kind, the delivery and the fault say. An empty
/// message is never shown as `Error` or `Unknown error`.
pub fn provider_error_text(error: &ProviderError, surface: &str) -> String {
    if !error.message.trim().is_empty() {
        return error.message.clone();
    }
    present_error_text(&ErrorView::from(error), &PresentOptions { surface: surface.into(), ..PresentOptions::default() })
}

/// A rate-limit or quota refusal as an agent task hands it to its spawner: the provider by name and the provider's own words,
/// read from the `"message"` of a JSON body the text carries (also one cut short), else the whole text.
pub fn provider_limit_line(provider: &str, message: &str) -> String {
    let own = re!(r#""message"\s*:\s*"((?:[^"\\]|\\.)*)"#)
        .captures(message)
        .map(|c| serde_json::from_str::<String>(&format!("\"{}\"", &c[1])).unwrap_or_else(|_| c[1].to_owned()))
        .unwrap_or_else(|| message.to_owned());
    format!("{provider} quota/rate limit hit: {}", one_line(&strip_error_prefix(&own)))
}

/// `providerDisplayName` (`shared/provider-display-name.mjs`): a known provider id's display name, any other id as itself.
pub fn provider_display_name(provider: &str) -> String {
    let name = match provider.to_lowercase().as_str() {
        "openai-oauth" => "OpenAI OAuth",
        "anthropic-oauth" => "Anthropic OAuth",
        "grok-oauth" => "Grok OAuth",
        "muse-code-oauth" => "Muse Code",
        "command-code-oauth" => "Command Code",
        "mimo-oauth" => "MiMo",
        "cursor-oauth" => "Cursor OAuth",
        "devin-oauth" => "Devin",
        "antigravity-oauth" => "Antigravity OAuth",
        "openai" | "openai-api" => "OpenAI API",
        "anthropic" | "anthropic-api" => "Anthropic API",
        "gemini" | "gemini-api" => "Gemini API",
        "xai" | "xai-api" => "xAI API",
        "deepseek" | "deepseek-api" => "DeepSeek API",
        "opencode-go-oauth" => "OpenCode Go OAuth",
        "openrouter" => "OpenRouter",
        "mixdog-local" => "Local Provider",
        "default" => "Default",
        _ => provider,
    };
    name.to_owned()
}

/// A route whose provider cannot run now, as the user reads it: the provider by name, why (the registry's own cause when it
/// recorded one), and what to do about it.
pub fn provider_unavailable_text(provider: &str, cause: Option<&str>, switched_off: bool) -> String {
    let name = provider_display_name(provider);
    let recorded = cause.map(|cause| {
        let own = re!(r#"^\[provider\] Failed to init "[^"]*":\s*"#).replace(cause, "");
        re!(r"\s*[—-]\s*run /login\s*$").replace(&own, "").trim().to_owned()
    });
    let why = match recorded.filter(|why| !why.is_empty()) {
        Some(why) => why,
        None if switched_off => "it is switched off".to_owned(),
        None => "it is not signed in and has no API key".to_owned(),
    };
    let step = if why.contains("/providers") { "" } else { " Sign in under /providers, or add an API key there." };
    format!("{name} is not available: {why}.{step}")
}

/// A readiness failure that says no provider family of this core serves `provider`: `Some(provider)`.
pub fn unserved_provider_of(message: &str) -> Option<String> {
    let found = re!(r#"^\[provider\] Failed to init "([^"]+)": unknown enabled provider: (.+)$"#).captures(message.trim())?;
    (found[1] == found[2]).then(|| found[1].to_owned())
}

/// A route-save readiness failure as a sentence: a provider this core does not offer is named as such, any other failure
/// stands as it is.
pub fn route_ready_error_text(message: String) -> String {
    match unserved_provider_of(&message) {
        Some(provider) => {
            let name = provider_display_name(&provider);
            let shown = if name == provider { format!("\"{provider}\"") } else { format!("{name} (\"{provider}\")") };
            format!("This core does not offer the provider {shown}; choose a route on another provider.")
        }
        None => message,
    }
}

/// The chain lines a surfaced failure carries after its own message (`annotateEndedChain`): every model tried and why each
/// failed, or where the chain stopped.
fn chain_line(message: &str) -> Option<String> {
    let found = re!(r"(?m)^(?:Every model in the fallback chain failed|Fallback chain stopped before)[^\n]*$").find(message)?;
    Some(one_line(found.as_str()))
}

/// The provider's own reason in a refusal's message: the `"message"` of a JSON body it carries, else the text after the
/// status; `None` when nothing is left.
fn refusal_reason(message: &str) -> Option<String> {
    let message = message.split("\nSkipped fallback").next().unwrap_or(message);
    let own = match re!(r#""message"\s*:\s*"((?:[^"\\]|\\.)*)"#).captures(message) {
        Some(c) => serde_json::from_str::<String>(&format!("\"{}\"", &c[1])).unwrap_or_else(|_| c[1].to_owned()),
        None => re!(r"^[^{]*?\b[0-9]{3}\s*:\s*").replace(message, "").into_owned(),
    };
    let own = one_line(&strip_error_prefix(&own));
    (!own.is_empty()).then(|| cap_text(&own, 300.0))
}

/// The sentence for a failure that has no message and no fault: what its kind and delivery state tell.
fn empty_cause_text(error: &ErrorView, delivery: DeliveryState) -> String {
    let kind = error.descriptor.as_ref().map_or("unknown", |d| d.kind.as_str());
    let reached = match delivery {
        DeliveryState::NotSent => "before the request was sent",
        DeliveryState::NotProcessed => "before the provider processed the request",
        DeliveryState::Ambiguous => "while the request was in flight",
        DeliveryState::Accepted => "after the provider accepted the request",
    };
    format!("The provider request failed ({kind}, {reached}).")
}

impl ErrorView {
    /// A bare string failure.
    pub fn message(text: impl Into<String>) -> Self {
        Self { message: text.into(), ..Self::default() }
    }

    /// An error object with just a message.
    pub fn object(message: impl Into<String>) -> Self {
        Self { is_object: true, message: message.into(), ..Self::default() }
    }
}

fn kind_name(kind: ErrorKind) -> &'static str {
    match kind {
        ErrorKind::Overloaded => "overloaded",
        ErrorKind::RateLimited => "rate_limited",
        ErrorKind::QuotaExhausted => "quota_exhausted",
        ErrorKind::Entitlement => "entitlement",
        ErrorKind::Billing => "billing",
        ErrorKind::Auth => "auth",
        ErrorKind::Permission => "permission",
        ErrorKind::ContextOverflow => "context_overflow",
        ErrorKind::RequestTooLarge => "request_too_large",
        ErrorKind::Policy => "policy",
        ErrorKind::ServiceTierUnavailable => "service_tier_unavailable",
        // Node has no kind of its own for these three: they are request refusals whose wording
        // `describeError` reads (image size, tool schema).
        ErrorKind::InvalidRequest | ErrorKind::ImageRejected | ErrorKind::ReplayRejected | ErrorKind::ToolSchemaRejected => "invalid_request",
        ErrorKind::Transient => "transient",
        ErrorKind::Unknown => "unknown",
    }
}

/// `error.code` as the provider error states it: its own code, else `TRUNCATED_STREAM` for a cut stream and the
/// code of a socket fault (`ECONNRESET`, `UND_ERR_SOCKET`, `ENOTFOUND`, `EPIPE`, `ETIMEDOUT`, `ECONNREFUSED`: Node's sentence reads
/// "(EPIPE)", here and in the persisted errorKind).
pub fn sent_code(error: &ProviderError) -> String {
    let code = error.code.clone().unwrap_or_default();
    if code.is_empty() {
        match &error.transport {
            Some(TransportFault::TruncatedStream) => return "TRUNCATED_STREAM".into(),
            Some(fault) => {
                if let Some(name) = fault.errno_name() {
                    return name.into();
                }
            }
            None => {}
        }
    }
    code
}

impl From<&ProviderError> for ErrorView {
    fn from(error: &ProviderError) -> Self {
        let status = error.status.map_or(0, u32::from);
        let retry_after_ms = error.retry_after.map_or(0, |d| d.as_millis() as u64);
        let code = sent_code(error);
        let ws_close_code = match error.transport {
            Some(TransportFault::WsClose { code: Some(c) }) => Some(u32::from(c)),
            _ => None,
        };
        Self {
            is_object: true,
            message: error.message.clone(),
            name: String::new(),
            descriptor: Some(Descriptor::of(error)),
            code,
            status,
            retry_after_ms,
            reauth_required: error.reauth_required,
            ws_close_code,
            fault: error.transport.clone(),
            delivery: Some(error.delivery),
            ..Self::default()
        }
    }
}

/// `presentErrorText`'s options.
#[derive(Clone, Debug, Default)]
pub struct PresentOptions {
    /// `surface || tool`.
    pub surface: String,
    /// Longest text; Node's default is 240.
    pub max: Option<f64>,
    /// The caller's own provider name, for a first-byte timeout.
    pub provider_label: Option<String>,
}

/// The one user-facing text of a failure: `presentErrorText(error, options)`.
pub fn present_error_text(error: &ErrorView, options: &PresentOptions) -> String {
    // A response the provider sent and the client refuses: not a connection failure, and the reason is the point.
    match error.fault {
        Some(TransportFault::TooManyEncodings) => return "The provider's response could not be decoded: too many content encodings.".into(),
        Some(TransportFault::CorruptBody) => return "The provider's response could not be decoded: the compressed body is corrupt.".into(),
        _ => {}
    }
    if re!(
        r"^(?:\S[^:]{0,40} quota/rate limit hit: |Provider usage limit reached|Out of credits or at spend limit|Not included in your plan|Access denied by the provider|Provider is rate-limited|Every model in the fallback chain failed|Fallback chain stopped before)"
    )
    .is_match(error.message.trim())
    {
        return cap_text(&one_line(&error.message), options.max.unwrap_or(240.0).max(PRESENTED_LIMIT));
    }
    if let Some(chain) = chain_line(&error.message) {
        return cap_text(&chain, options.max.unwrap_or(240.0).max(PRESENTED_LIMIT));
    }
    let presentation = describe_error(error);
    if matches!(presentation.kind, "image-size" | "payload-size" | "request" | "model-unavailable" | "tool-schema") {
        return presentation.summary;
    }
    if has_typed_evidence(error)
        && presentation.kind != "unknown"
        && let Some(line) = kind_line(&presentation.provider_kind, presentation.retry_after_ms)
    {
        let line = match refusal_reason(&error.message).filter(|_| presentation.provider_kind == "permission") {
            Some(reason) => format!("{}: {reason}", line.trim_end_matches('.')),
            None => line,
        };
        return re!(r"(?m)^Skipped fallback [^\n]*$").find_iter(&error.message).fold(line, |text, skipped| format!("{text} {}", one_line(skipped.as_str())));
    }
    let surface = options.surface.as_str();
    let subject = subject_for_surface(surface);
    let max = options.max.unwrap_or(240.0);
    let mut text = err_text(error);
    let name = if error.is_object { error.name.as_str() } else { "" };
    let code = if error.is_object { error.code.as_str() } else { "" };
    let status = if error.is_object { error.status } else { 0 };
    if code == "TOOL_SURFACE_EXCEEDS_CONTEXT" || text.contains("(TOOL_SURFACE_EXCEEDS_CONTEXT)") {
        return strip_error_prefix(&text);
    }
    if let Some(found) = re!(r"The latest message cannot fit this model \(LATEST_TURN_EXCEEDS_CONTEXT\)(?s:.*)$").find(&text) {
        return found.as_str().replacen(" (LATEST_TURN_EXCEEDS_CONTEXT)", "", 1);
    }
    if let Some(inner) = extract_json_error(&text) {
        text = inner;
    }
    if let Some(embedded) = extract_embedded_error(&text) {
        text = embedded;
    }
    let text = one_line(&strip_error_prefix(&text));
    if text.is_empty() {
        return "Unknown error".into();
    }
    if let Some(stream) = typed_stream_failure_text(error, &text, options.provider_label.as_deref()) {
        return stream;
    }
    if code == "PROVIDER_PREFIX_MUTATION" || name == "ProviderPrefixMutationError" {
        return "Session state changed unexpectedly.".into();
    }
    if re!(r"(?i)currently at capacity|at capacity due to high demand|provider overloaded|server overloaded").is_match(&text) {
        return "Provider is busy at capacity.".into();
    }
    if status == 401 || status == 403 || re!(r"(?i)\b(?:invalid|expired)\s+(?:api[ _-]?key|access token|credentials?)\b").is_match(&text) {
        return "Provider authentication failed.".into();
    }
    if let Some(transport) = transport_error_text(&TransportInput::of(error)) {
        return transport;
    }
    if error.is_object
        && error.message.is_empty()
        && let Some(delivery) = error.delivery
    {
        return empty_cause_text(error, delivery);
    }
    if re!(r"(?i)\bAGENT_CONTEXT_OVERFLOW\b|agent context overflow|latest turn cannot fit|context budget|context window").is_match(&text) {
        return "Context too large.".into();
    }
    if re!(r"(?i)\bcompact(?:ion)?\b.*\b(?:failed|error|overflow)\b|\b(?:failed|error)\b.*\bcompact(?:ion)?\b").is_match(&text) {
        if surface.to_lowercase().contains("compact") {
            return cap_text(&text, max);
        }
        return "Compact failed.".into();
    }
    let quota_retry = re!(r"(?i)retryAfter=([^\s:]+)").captures(&text).map(|c| c[1].to_owned());
    if re!(r"(?i)\b429\b|rate[_ -]?limit|quota|too many requests|resource exhausted|insufficient_quota|quota_exceeded").is_match(&text) {
        let provider = if re!(r"(?i)Anthropic OAuth").is_match(&text) { "Anthropic" } else { "Provider" };
        let hint = if re!(r"(?i)cooldown").is_match(&text) { " Re-login or switch the provider account to continue now." } else { "" };
        let retry = quota_retry.map(|token| format!("; retry after {}", humanize_retry_after_token(&token))).unwrap_or_default();
        return format!("{provider} quota/rate limit hit{retry}.{hint}");
    }
    if is_cancel_like(error) || name == "SessionClosedError" {
        return if subject == "request" { "Cancelled".into() } else { format!("{} was cancelled.", capitalize(subject)) };
    }
    let inactivity = re!(r"(?i)timed out after ([0-9]+)ms of inactivity").captures(&text).map(|c| digits(&c[1]));
    if name == "StreamStalledError" || name == "StreamStalledAbortError" || code == "ESTREAMSTALL" || inactivity.is_some() {
        let ms = inactivity.unwrap_or(0.0);
        return if ms > 0.0 { format!("No progress {}.", format_duration_ms(ms)) } else { "No progress.".into() };
    }
    let first_byte = re!(r"(?i)first byte timed out after ([0-9]+)ms").captures(&text).map(|c| digits(&c[1]));
    if name == "ProviderTimeoutError" || code == "EPROVIDERTIMEOUT" || first_byte.is_some() {
        let ms = first_byte.unwrap_or(0.0);
        return if ms > 0.0 { format!("No first response {}.", format_duration_ms(ms)) } else { "No first response.".into() };
    }
    if let Some(c) = re!(r"(?i)first (?:transport|semantic response) stale\s*\(([0-9]+)ms\)").captures(&text) {
        return format!("Agent watchdog stopped the run: no model response in {}.", format_duration_ms(digits(&c[1])));
    }
    if let Some(c) = re!(r"(?i)(?:agent\s+)?first response stale\s*\(([0-9]+)ms\)").captures(&text) {
        return format!("No first response from the {subject} within {}.", format_duration_ms(digits(&c[1])));
    }
    let stale = re!(r"(?i)agent (?:task|tool running) stale\s*\(([0-9]+)ms[^)]*\)")
        .captures(&text)
        .or_else(|| re!(r"(?i)tool running stale\s*\(([0-9]+)ms[^)]*\)").captures(&text))
        .or_else(|| re!(r"(?i)task stale\s*\(([0-9]+)ms[^)]*\)").captures(&text));
    if let Some(c) = stale {
        return format!("The {subject} went stale after {} without new stream/tool progress.", format_duration_ms(digits(&c[1])));
    }
    if re!(r#"(?i)Session\s+"sess_[^"]+"\s+closed:\s*aborted during call"#).is_match(&text) {
        return format!("{} stopped while waiting for a response.", capitalize(subject));
    }
    if re!(r#"(?i)Session\s+"sess_[^"]+"\s+closed:\s*closed during call"#).is_match(&text) {
        return format!("{} stopped before the response completed.", capitalize(subject));
    }
    if re!(r"(?i)^Session closed:\s*(?:closeSession|closed|aborted)\b").is_match(&text) {
        return format!("{} stopped.", capitalize(subject));
    }
    if re!(r"(?i)parent signal aborted").is_match(&text) {
        return format!("{} was cancelled by its caller.", capitalize(subject));
    }
    let text = re!(r#"(?i)Session\s+"sess_[^"]+"\s+closed:\s*"#).replace_all(&text, "Session closed: ").into_owned();
    let text = re!(r"\bsess_[A-Za-z0-9_-]+\b").replace_all(&text, "session").into_owned();
    let text = re!(r"\brun_[A-Za-z0-9_-]{16,}\b").replace_all(&text, "run").into_owned();
    let text = re!(r"\s+").replace_all(&text, " ").trim().to_owned();
    let safe = safe_error_details(&text);
    cap_text(if safe.is_empty() { "Unknown error" } else { &safe }, max)
}

/// `errorLine`: `Error: <text>` unless the text already starts that way.
pub fn error_line(error: &ErrorView, options: &PresentOptions) -> String {
    let text = present_error_text(error, options);
    if re!(r"(?i)^error\s*:").is_match(&text) { text } else { format!("Error: {text}") }
}

/// `errText`: the message of a failure.
pub fn err_text(error: &ErrorView) -> String {
    if !error.is_object {
        return error.message.clone();
    }
    if !error.message.is_empty() {
        return error.message.clone();
    }
    if !error.name.is_empty() {
        return error.name.clone();
    }
    "Error".into()
}

/// `errText` of a parsed JSON value (a nested `error` member).
fn err_text_json(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            if let Some(Value::String(m)) = map.get("message")
                && !m.is_empty()
            {
                return m.clone();
            }
            for key in ["error", "reason"] {
                if let Some(v) = map.get(key)
                    && !v.is_null()
                {
                    return err_text_json(v);
                }
            }
            if let Some(Value::String(t)) = map.get("type")
                && !t.is_empty()
            {
                return format!("{t} event");
            }
            let json = value.to_string();
            if json != "{}" && json != "null" { json } else { "[object Object]".into() }
        }
        Value::Array(_) => value.to_string(),
        other => value_to_string(other),
    }
}

// safeErrorDetails

/// Diagnostic text made safe to show: control sequences, credentials and image data removed.
pub fn safe_error_details(value: &str) -> String {
    let text = re!(r"\x1b\[[0-?]*[ -/]*[@-~]").replace_all(value, "").into_owned();
    let text = re!(r"\r\n?").replace_all(&text, "\n").into_owned();
    let text = re!(r"(?i)\b((?:https?|ssh)://)[^/\s@]+@").replace_all(&text, "${1}[redacted]@").into_owned();
    let text = re!(r"(?i)\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+").replace_all(&text, "${1} [redacted]").into_owned();
    let text =
        re!(r#"(?i)([?&](?:token|access_token|refresh_token|api_key|key|code|signature|sig)=)[^&\s"'<>]+"#).replace_all(&text, "${1}[redacted]").into_owned();
    let text = re!(
        r#"(?i)(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password|secret|client_secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)"#
    )
    .replace_all(&text, "${1}[redacted]")
    .into_owned();
    let text = re!(r"\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b")
        .replace_all(&text, "[redacted]")
        .into_owned();
    let text = re!(r"data:[A-Za-z0-9_.+/-]+;base64,[A-Za-z0-9+/=\s]+").replace_all(&text, "[image data]").into_owned();
    let text = re!(r#"(["']data["']\s*:\s*["'])[A-Za-z0-9+/=]{256,}(["'])"#).replace_all(&text, "${1}[image data]${2}").into_owned();
    let text = js_trim(&text);
    if utf16_len(text) > DETAILS_LIMIT {
        return format!("{}\n…", slice_utf16(text, DETAILS_LIMIT));
    }
    text.to_owned()
}

// transportErrorText

const LOST_CODES: &[&str] = &[
    "ECONNRESET",
    "EPIPE",
    "ECONNABORTED",
    "ENETRESET",
    "EPROTO",
    "UND_ERR_SOCKET",
    "UND_ERR_DESTROYED",
    "UND_ERR_CLOSED",
    "UND_ERR_ABORTED",
    "ERR_STREAM_DESTROYED",
    "ERR_STREAM_PREMATURE_CLOSE",
    "ERR_HTTP2_STREAM_ERROR",
    "ERR_HTTP2_SESSION_ERROR",
    "ERR_HTTP2_INVALID_SESSION",
    "ERR_HTTP2_GOAWAY_SESSION",
    "ERR_HTTP2_STREAM_CANCEL",
];
const UNREACHABLE_CODES: &[&str] = &[
    "ECONNREFUSED",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "ENETDOWN",
    "EADDRNOTAVAIL",
    "ENOTFOUND",
    "EAI_AGAIN",
    "EAI_NODATA",
    "EAI_FAIL",
    "EAI_NONAME",
    "UND_ERR_CONNECT",
];
const TIMEOUT_CODES: &[&str] =
    &["ETIMEDOUT", "ESOCKETTIMEDOUT", "ERR_SOCKET_CONNECTION_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"];
const WS_LOST_CLOSE_CODES: &[u32] = &[1000, 1001, 1005, 1006, 1011, 1012];
const UNAVAILABLE_STATUSES: &[u32] = &[502, 503, 504, 521, 522, 523, 524];

/// The chain `classifyTransportError` walks. Rust failures carry no `cause`, so it is one item
/// (or none for a bare string).
#[derive(Default)]
pub struct TransportInput {
    chain: bool,
    code: String,
    name: String,
    status: u32,
    ws_close_code: Option<u32>,
    message: String,
    fault: Option<TransportFault>,
}

impl TransportInput {
    fn of(view: &ErrorView) -> Self {
        if !view.is_object {
            return Self { message: view.message.trim().to_owned(), ..Self::default() };
        }
        Self {
            chain: true,
            code: view.code.to_uppercase(),
            name: view.name.clone(),
            status: view.status,
            ws_close_code: view.ws_close_code,
            message: view.message.trim().to_owned(),
            fault: view.fault.clone(),
        }
    }

    fn text(text: &str) -> Self {
        Self { message: text.trim().to_owned(), ..Self::default() }
    }

    /// `{ code, status }`: the evidence a persisted descriptor keeps.
    fn code_status(code: &str, status: u32) -> Self {
        Self { chain: true, code: code.to_owned(), status, ..Self::default() }
    }
}

struct Verdict {
    kind: &'static str,
    code: String,
    status: u32,
}

fn verdict(kind: &'static str, code: impl Into<String>, status: u32) -> Option<Verdict> {
    Some(Verdict { kind, code: code.into(), status })
}

fn typed_transport_kind(input: &TransportInput) -> Option<Verdict> {
    if !input.chain {
        return None;
    }
    let code = input.code.as_str();
    if !code.is_empty() && re!(r"^(?:UNABLE_TO_|CERT_|DEPTH_ZERO_SELF_SIGNED|SELF_SIGNED_CERT|ERR_TLS_|HOSTNAME_MISMATCH)").is_match(code) {
        return verdict("tls", code, 0);
    }
    if LOST_CODES.contains(&code) {
        return verdict("lost", code, 0);
    }
    if UNREACHABLE_CODES.contains(&code) {
        return verdict("unreachable", code, 0);
    }
    if TIMEOUT_CODES.contains(&code) {
        return verdict("timeout", code, 0);
    }
    match input.name.as_str() {
        "SocketError" => return verdict("lost", code, 0),
        "ConnectTimeoutError" | "HeadersTimeoutError" | "BodyTimeoutError" => return verdict("timeout", code, 0),
        _ => {}
    }
    match input.fault {
        Some(TransportFault::Tls) => verdict("tls", "", 0),
        Some(TransportFault::Connect { .. } | TransportFault::Dns) => verdict("unreachable", "", 0),
        Some(
            TransportFault::Reset | TransportFault::Closed | TransportFault::H2GoAway { .. } | TransportFault::H2RstStream { .. } | TransportFault::Io { .. },
        ) => verdict("lost", "", 0),
        Some(TransportFault::KeepaliveExpired { .. }) => verdict("timeout", "", 0),
        _ => None,
    }
}

fn status_transport_kind(input: &TransportInput) -> Option<Verdict> {
    if input.chain && (100..=599).contains(&input.status) && UNAVAILABLE_STATUSES.contains(&input.status) {
        return verdict("unavailable", "", input.status);
    }
    if let Some(c) = re!(r"\b(?:API|HTTP(?: fallback)?)\s+(50[234]|52[1-4])\b").captures(&input.message) {
        return verdict("unavailable", "", c[1].parse().unwrap_or(0));
    }
    if input.chain
        && let Some(close) = input.ws_close_code.filter(|c| WS_LOST_CLOSE_CODES.contains(c))
    {
        return verdict("lost", format!("WS {close}"), 0);
    }
    None
}

fn message_transport_kind(message: &str) -> Option<Verdict> {
    if message.is_empty() {
        return None;
    }
    let close = re!(r"^(?:Error:\s*)?(?:OpenAI(?: OAuth)?|xAI) WS (?:closed before response\.completed|handshake closed before open) \(code=([0-9]{4})(?:, reason=(?s:.*))?\)$")
        .captures(message)
        .and_then(|c| c[1].parse::<u32>().ok());
    if let Some(close) = close.filter(|c| WS_LOST_CLOSE_CODES.contains(c)) {
        return verdict("lost", format!("WS {close}"), 0);
    }
    if re!(r"(?i)^(?:terminated|socket hang up|other side closed|connection error\.?)$").is_match(message)
        || re!(
            r"(?i)\b(?:socket hang up|other side closed|connection (?:was )?reset(?: by peer)?|network unreachable|premature close|stream (?:was )?destroyed)\b"
        )
        .is_match(message)
    {
        return verdict("lost", "", 0);
    }
    if re!(r"(?i)\b(?:connection refused|getaddrinfo|dns lookup failed|host (?:not found|unreachable))\b").is_match(message) {
        return verdict("unreachable", "", 0);
    }
    if re!(r"(?i)\b(?:connect(?:ion)? timed? ?out|headers timeout|body timeout)\b").is_match(message) {
        return verdict("timeout", "", 0);
    }
    if re!(r"(?i)^(?:fetch failed|failed to fetch|couldn'?t fetch\.?|load failed|network error)$").is_match(message) {
        return verdict("unreachable", "", 0);
    }
    None
}

/// `transportErrorText`: the sentence for a connection-level failure, `None` when it is not one.
pub fn transport_error_text(input: &TransportInput) -> Option<String> {
    let verdict = typed_transport_kind(input)
        .map(|v| Verdict { status: 0, ..v })
        .or_else(|| status_transport_kind(input))
        .or_else(|| message_transport_kind(&input.message))?;
    let sentence = match verdict.kind {
        "lost" => "Connection to the provider was lost",
        "unreachable" => "Could not reach the provider",
        "timeout" => "The provider did not respond in time",
        "tls" => "Provider TLS certificate check failed",
        _ => "Provider is temporarily unavailable",
    };
    let detail = if verdict.code.starts_with("WS ") {
        String::new()
    } else if !verdict.code.is_empty() {
        verdict.code.clone()
    } else if verdict.status > 0 {
        verdict.status.to_string()
    } else {
        String::new()
    };
    Some(if detail.is_empty() { format!("{sentence}.") } else { format!("{sentence} ({detail}).") })
}

// describeError

struct Presentation {
    kind: &'static str,
    summary: String,
    provider_kind: String,
    retry_after_ms: Option<u64>,
}

// provider kind -> (presentation kind, summary)
const KIND_COPY: &[(&str, &str, &str)] = &[
    ("overloaded", "overloaded", "The provider is busy right now."),
    ("rate_limited", "rate-limit", "The provider is temporarily rate-limiting requests."),
    ("quota_exhausted", "quota", "The provider usage limit was reached."),
    ("entitlement", "entitlement", "This model isn't included in your plan."),
    ("billing", "billing", "The provider account is out of credits or at its spend limit."),
    ("permission", "permission", "You don't have access to this resource."),
    ("context_overflow", "context-overflow", "The conversation is too long for this model."),
    ("request_too_large", "payload-size", "The request exceeds the size limit."),
    ("policy", "policy", "The provider refused this request under its safety policy."),
    ("service_tier_unavailable", "service-tier", "The requested service tier is unavailable right now."),
];
const MODEL_UNAVAILABLE_SUMMARY: &str = "This model isn't available for this account.";
const TOOL_SCHEMA_SUMMARY: &str = "The provider rejected a tool definition.";
const NOT_FOUND_SUMMARY: &str = "The provider couldn't find the requested model or endpoint.";

fn model_unavailable_re() -> &'static Regex {
    static RE: LazyLock<Regex> = LazyLock::new(|| {
        let predicate = r"(?:(?:is|was|has been)\s+)?(?:not found|does not exist|doesn'?t exist|not (?:supported|available)|(?:currently\s+)?unavailable|no longer (?:available|supported)|deprecated|retired|removed)\b";
        let start = r"(?:^|[.:;!]\s+)";
        let parts = [
            format!(r#"{start}(?:(?:the|this|that|requested|selected|publisher)\s+)*models?(?:/\S+|\s+[`'"]?[A-Za-z0-9_./:@-]+[`'"]?)?\s+{predicate}"#),
            format!(r#"{start}(?:the\s+)?[`'"][^`'"\n]+[`'"]\s+model\s+{predicate}"#),
            format!(r"{start}(?:unknown|invalid|unsupported) model\b"),
            format!(r"{start}no endpoints found for [A-Za-z0-9_.-]+/[A-Za-z0-9_.:-]+"),
            r"\bis not a valid model\b".to_owned(),
            r"^model: \S+$".to_owned(),
        ];
        Regex::new(&format!("(?im){}", parts.join("|"))).expect("static pattern")
    });
    &RE
}

fn first_readable_line(clean: &str) -> String {
    let first = clean.split('\n').map(js_trim).filter(|l| !l.is_empty()).find(|l| !re!(r"(?i)^at\s|^\{|^<!doctype|^<html").is_match(l)).unwrap_or("");
    if !first.is_empty() && !re!(r"(?i)^[{\[]|^<|(?:API|HTTP)\s+[45][0-9][0-9].*[<{]").is_match(first) { first.to_owned() } else { String::new() }
}

fn truthy(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::Null | Value::Bool(false) => None,
        Value::String(s) => (!s.is_empty()).then(|| s.clone()),
        Value::Number(n) => n.as_f64().filter(|f| *f != 0.0 && !f.is_nan()).map(|_| value_to_string(&Value::Number(n.clone()))),
        other => Some(value_to_string(other)),
    }
}

struct Unwrapped {
    raw: String,
    message: String,
    status: u32,
    code: String,
}

fn unwrap_error(view: &ErrorView) -> Unwrapped {
    let raw = js_trim(&view.message).to_owned();
    let parsed: Option<Value> = raw.find('{').and_then(|start| serde_json::from_str(&raw[start..]).ok()).filter(|v: &Value| v.is_object() || v.is_array());
    let (message, envelope_status, nested_code, envelope_code) = match &parsed {
        Some(envelope) => {
            let nested = envelope.get("error");
            let message = match nested {
                Some(Value::String(s)) => s.clone(),
                _ => match nested.and_then(|n| n.get("message")) {
                    Some(Value::String(s)) => s.clone(),
                    _ => match envelope.get("message") {
                        Some(Value::String(s)) => s.clone(),
                        _ => raw.clone(),
                    },
                },
            };
            let nested_code = nested.filter(|n| n.is_object()).and_then(|n| truthy(n.get("code")).or_else(|| truthy(n.get("type"))));
            (message, truthy(envelope.get("status")), nested_code, truthy(envelope.get("code")))
        }
        None if view.is_object => (view.message.clone(), None, None, (!view.code.is_empty()).then(|| view.code.clone())),
        None => (raw.clone(), None, None, None),
    };
    let status = if view.status > 0 {
        view.status
    } else if let Some(s) = envelope_status.as_deref().and_then(|s| s.trim().parse::<f64>().ok()).filter(|n| *n > 0.0) {
        s as u32
    } else {
        re!(r"(?i)\b(?:API|HTTP(?: fallback)?)\s+([45][0-9][0-9])\b").captures(&raw).and_then(|c| c[1].parse().ok()).unwrap_or(0)
    };
    Unwrapped { raw, message, status, code: nested_code.or(envelope_code).unwrap_or_default() }
}

fn legacy_kind(clean: &str) -> Option<&'static str> {
    KIND_COPY.iter().find(|(_, _, summary)| *summary == clean).map(|(kind, _, _)| *kind).or_else(|| {
        if re!(r"(?i)The provider usage limit was reached|quota.*(?:hit|exceed)|usage limit").is_match(clean) {
            Some("quota_exhausted")
        } else if re!(r"(?i)rate[_ -]?limit|too many requests").is_match(clean) {
            Some("rate_limited")
        } else {
            None
        }
    })
}

/// `classify`: the verdict and whether it is typed (wording must not override a typed one).
fn classify(view: &ErrorView, raw: &str, clean: &str) -> (Descriptor, bool) {
    let has_typed_fields = view.is_object && (view.status > 0 || !view.code.is_empty() || view.retry_after_ms > 0);
    if !has_typed_fields && let Some(kind) = legacy_kind(clean) {
        let wait = re!(r"(?i)retryAfter=([0-9]+)(ms|s|m)\b").captures(raw).and_then(|c| {
            let n: u64 = c[1].parse().ok()?;
            Some(
                n * match c[2].to_lowercase().as_str() {
                    "ms" => 1,
                    "s" => 1000,
                    _ => 60_000,
                },
            )
        });
        return (Descriptor { kind: kind.into(), retry_after_ms: wait.filter(|w| *w > 0), ..Descriptor::unknown() }, false);
    }
    let mut descriptor = view.descriptor.clone().unwrap_or_else(Descriptor::unknown);
    let typed = view.is_object && descriptor.kind != "unknown";
    if descriptor.kind == "unknown"
        && let Some(kind) = legacy_kind(clean)
    {
        descriptor.kind = kind.into();
        return (descriptor, false);
    }
    (descriptor, typed)
}

fn kind_copy(kind: &str) -> Option<(&'static str, &'static str)> {
    KIND_COPY.iter().find(|(k, _, _)| *k == kind).map(|(_, presentation, summary)| (*presentation, *summary))
}

const REJECTED_SUMMARY: &str = "The provider rejected this request";
const REJECTED_LINE_LIMIT: usize = 300;

/// The refusal with its HTTP status and the provider's own first line of text (already redacted by
/// `safe_error_details`), so the cause is visible. Text that already carries the summary is kept as it is.
fn rejected_summary(status: u32, clean: &str) -> String {
    let mut status = status;
    let mut line = first_readable_line(clean);
    // Text that already carries the summary (a failure presented once before) is taken apart and put together again, so its
    // status, its cap and its redaction are the same as a first presentation's.
    if let Some(rest) = line.strip_prefix(REJECTED_SUMMARY) {
        let carried = re!(r"^\s*(?:\(HTTP ([0-9]+)\))?\s*[:.]?\s*((?s:.*))$")
            .captures(rest)
            .map(|c| (c.get(1).and_then(|m| m.as_str().parse::<u32>().ok()), c[2].trim().to_owned()));
        let (carried_status, text) = carried.unwrap_or((None, String::new()));
        if status == 0 {
            status = carried_status.unwrap_or(0);
        }
        line = text;
    }
    let line = if line.chars().count() > REJECTED_LINE_LIMIT {
        format!("{}…", line.chars().take(REJECTED_LINE_LIMIT - 1).collect::<String>().trim_end())
    } else {
        line
    };
    match (status, line.is_empty()) {
        (0, true) => format!("{REJECTED_SUMMARY}."),
        (0, false) => format!("{REJECTED_SUMMARY}: {line}"),
        (status, true) => format!("{REJECTED_SUMMARY} (HTTP {status})."),
        (status, false) => format!("{REJECTED_SUMMARY} (HTTP {status}): {line}"),
    }
}

fn describe_error(view: &ErrorView) -> Presentation {
    let Unwrapped { raw, message, status: text_status, code: text_code } = unwrap_error(view);
    let clean = safe_error_details(&message);
    let clean = re!(r#"(?i)^(?:Error invoking remote method ['"][^'"]+['"]:\s*)?(?:Error:\s*)?"#).replace(&clean, "").into_owned();
    let clean = js_trim(&clean).to_owned();
    let (descriptor, typed) = classify(view, &raw, &clean);
    let status = if typed { descriptor.status } else { text_status };
    let code = if typed { descriptor.code.clone() } else { text_code };
    let rejected_429 = re!(r"\bAPI 429 request rejected\b").is_match(&view.message) && (!typed || descriptor.kind == "rate_limited");
    let retry_after_ms = descriptor.retry_after_ms.filter(|ms| *ms > 0);
    let kind_is = |k: &str| descriptor.kind == k;
    let refusal_kind = matches!(descriptor.kind.as_str(), "invalid_request" | "permission" | "unknown");
    let transport = transport_error_text(&TransportInput::of(view))
        .or_else(|| if typed { transport_error_text(&TransportInput::code_status(&code.to_uppercase(), status)) } else { None })
        .or_else(|| if !typed || kind_is("transient") { transport_error_text(&TransportInput::text(&raw)) } else { None });

    let (kind, summary): (&'static str, String) = if view.reauth_required
        || (!typed && re!(r"(?i)invalid_grant|refresh token (?:expired|revoked|not available)|sign in again|sign-in expired|Reauth Required").is_match(&raw))
    {
        ("reauth", "Sign-in expired.".into())
    } else if kind_is("auth")
        || (kind_is("unknown")
            && re!(r"(?i)\b(?:invalid|expired)\s+(?:api[ _-]?key|access token|credentials?)\b|Provider authentication failed").is_match(&clean))
    {
        ("authentication", "Provider authentication failed".into())
    } else if rejected_429 {
        ("request", rejected_summary(status, &clean))
    } else if matches!(descriptor.kind.as_str(), "invalid_request" | "unknown" | "request_too_large")
        && re!(r"(?i)image.*dimensions.*exceed|image.*(?:too large|maximum.*(?:size|dimension))|many-image requests|An attached image exceeds the provider limit").is_match(&clean)
    {
        ("image-size", "An attached image exceeds the provider limit.".into())
    } else if clean == MODEL_UNAVAILABLE_SUMMARY
        || (refusal_kind && (matches!(code.as_str(), "model_not_found" | "model_not_supported") || model_unavailable_re().is_match(&clean)))
    {
        ("model-unavailable", MODEL_UNAVAILABLE_SUMMARY.into())
    } else if clean == TOOL_SCHEMA_SUMMARY
        || (matches!(descriptor.kind.as_str(), "invalid_request" | "unknown")
            && re!(r"(?i)invalid schema for (?:function|tool)\b|\btools\.[0-9]+\.(?:custom\.)?input_schema\b|\bfunction_declarations\[[0-9]+\]\.parameters\b|\btools\[[0-9]+\]\.function\.parameters\b|\binvalid (?:tool|function) (?:schema|parameters|definition)\b").is_match(&clean))
    {
        ("tool-schema", TOOL_SCHEMA_SUMMARY.into())
    } else if clean == NOT_FOUND_SUMMARY || (refusal_kind && (status == 404 || status == 410)) {
        let line = first_readable_line(&clean);
        ("not-found", if line.is_empty() { NOT_FOUND_SUMMARY.into() } else { line })
    } else if let Some(c) = re!(r"The latest message cannot fit this model \(LATEST_TURN_EXCEEDS_CONTEXT\)(: it needs about [0-9,]+ tokens, but the [^.]* window leaves [0-9,]+ for it\.)((?s:.*))$").captures(&clean) {
        ("latest-turn-size", format!("The latest message cannot fit this model{}", &c[1]))
    } else if kind_is("unknown") && re!(r"(?i)payload too large|request (?:body )?too large|The request exceeds the size limit").is_match(&clean) {
        ("payload-size", "The request exceeds the size limit.".into())
    } else if let Some((presentation, summary)) = kind_copy(&descriptor.kind) {
        (presentation, summary.into())
    } else if let Some(transport) = transport {
        ("connection", transport.strip_suffix('.').unwrap_or(&transport).to_owned())
    } else if rejected_429 || status == 400 || status == 422 || code == "invalid_request_error" || clean.starts_with(REJECTED_SUMMARY) {
        ("request", rejected_summary(status, &clean))
    } else {
        let line = first_readable_line(&clean);
        ("unknown", if line.is_empty() { "Something went wrong.".into() } else { line })
    };
    let mut summary = re!(r"\s+").replace_all(&summary, " ").trim().to_owned();
    if summary.is_empty() {
        summary = "Something went wrong.".into();
    }
    // A rejected request carries the provider's own line, capped on its own (`REJECTED_LINE_LIMIT`).
    if kind != "request" && utf16_len(&summary) > SUMMARY_LIMIT {
        summary = format!("{}…", slice_utf16(&summary, SUMMARY_LIMIT - 1).trim_end());
    }
    Presentation { kind, summary, provider_kind: descriptor.kind, retry_after_ms }
}

// presentErrorText helpers

fn kind_line(provider_kind: &str, retry_after_ms: Option<u64>) -> Option<String> {
    Some(match provider_kind {
        "overloaded" => "Provider is busy at capacity.".to_owned(),
        "rate_limited" => match retry_after_ms {
            Some(ms) if ms > 0 => format!("Provider is rate-limited (retry in {}).", format_duration_ms(ms as f64)),
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

fn has_typed_evidence(error: &ErrorView) -> bool {
    error.is_object && (error.status > 0 || !error.code.is_empty() || error.retry_after_ms > 0)
}

fn is_cancel_like(error: &ErrorView) -> bool {
    if error.is_object && (error.cancelled || matches!(error.name.as_str(), "SessionClosedError" | "AbortError" | "APIUserAbortError")) {
        return true;
    }
    let text = err_text(error);
    re!(r"(?i)aborted by session close").is_match(&text)
        || re!(r"(?i)withRetry:\s*(?:sleep )?aborted").is_match(&text)
        || re!(r"(?i)^sleep aborted$").is_match(&text)
}

fn subject_for_surface(surface: &str) -> &'static str {
    let value = surface.to_lowercase();
    if value.contains("search") || value.contains("web") {
        "web search agent"
    } else if value == "turn" || value.contains("request") {
        "request"
    } else if value.contains("agent") || value.contains("task") {
        "agent"
    } else {
        "tool"
    }
}

fn capitalize(value: &str) -> String {
    let mut chars = value.chars();
    chars.next().map_or_else(String::new, |c| c.to_uppercase().collect::<String>() + chars.as_str())
}

fn cap_text(value: &str, max: f64) -> String {
    let text = js_trim(value);
    let limit = if max.is_finite() && max != 0.0 { max.max(32.0) } else { 240.0 };
    if (utf16_len(text) as f64) > limit {
        let keep = (limit - 3.0).max(1.0) as usize;
        return format!("{}...", slice_utf16(text, keep));
    }
    text.to_owned()
}

fn one_line(value: &str) -> String {
    re!(r"\s+").replace_all(value, " ").trim().to_owned()
}

fn strip_error_prefix(value: &str) -> String {
    js_trim(&re!(r"(?i)^\s*(?:\[[^\]]*error[^\]]*\]|error)\s*[:-]\s*").replace(value, "")).to_owned()
}

fn extract_json_error(text: &str) -> Option<String> {
    let value = js_trim(text);
    if !value.starts_with('{') && !value.starts_with('[') {
        return None;
    }
    let parsed: Value = serde_json::from_str(value).ok()?;
    let map = parsed.as_object()?;
    for key in ["error", "message"] {
        if let Some(Value::String(s)) = map.get(key)
            && !js_trim(s).is_empty()
        {
            return Some(s.clone());
        }
    }
    match map.get("error") {
        Some(v) if !v.is_null() => Some(err_text_json(v)),
        _ => None,
    }
}

fn extract_embedded_error(text: &str) -> Option<String> {
    text.split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .find_map(|line| re!(r"(?i)^\s*(?:error|failure|failed)\s*[:=]\s*([^\n\r\u2028\u2029]+?)\s*$").captures(line).map(|c| c[1].to_owned()))
}

fn digits(text: &str) -> f64 {
    text.parse().unwrap_or(0.0)
}

fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

pub(crate) fn format_duration_ms(value: f64) -> String {
    let ms = if value.is_finite() { value.max(0.0) } else { 0.0 };
    if ms >= 60_000.0 && ms % 60_000.0 == 0.0 {
        return format!("{}m", number_to_string(js_round(ms / 60_000.0)));
    }
    if ms >= 1_000.0 {
        return format!("{}s", number_to_string(js_round(ms / 1_000.0)));
    }
    format!("{}ms", number_to_string(ms))
}

fn parse_duration_token_ms(token: &str) -> Option<f64> {
    let lower = js_trim(token).to_lowercase();
    let c = re!(r"^([0-9]+)(ms|m|s)$").captures(&lower)?;
    let n = digits(&c[1]);
    Some(match &c[2] {
        "m" => n * 60_000.0,
        "s" => n * 1_000.0,
        _ => n,
    })
}

fn humanize_retry_after_token(token: &str) -> String {
    let Some(ms) = parse_duration_token_ms(token).filter(|ms| *ms >= 60_000.0) else { return token.to_owned() };
    let total = (ms / 1_000.0).floor() as u64;
    let (days, hours, minutes, seconds) = (total / 86_400, total % 86_400 / 3_600, total % 3_600 / 60, total % 60);
    let mut parts = Vec::new();
    if days > 0 {
        parts.push(format!("{days}d"));
    }
    if hours > 0 {
        parts.push(format!("{hours}h"));
    }
    if minutes > 0 {
        parts.push(format!("{minutes}m"));
    }
    if days == 0 && hours == 0 && seconds > 0 {
        parts.push(format!("{seconds}s"));
    }
    if parts.is_empty() { token.to_owned() } else { parts.join(" ") }
}

/// The window a provider timeout names, or 0.
pub(crate) fn timed_out_ms(text: &str) -> f64 {
    re!(r"(?i)(?:timed out after|within) ([0-9]+)ms").captures(text).map_or(0.0, |c| digits(&c[1]))
}

fn typed_stream_failure_text(error: &ErrorView, text: &str, provider_label: Option<&str>) -> Option<String> {
    if !error.is_object {
        return None;
    }
    match error.timeout_phase {
        Some(TimeoutPhase::Headers | TimeoutPhase::FirstChunk) => {
            let waited = error.waited_ms as f64;
            let ms = if waited > 0.0 { waited } else { timed_out_ms(text) };
            let provider = provider_label.filter(|p| !p.is_empty()).unwrap_or("the provider");
            let attempts = if error.attempts > 0 { format!("; attempts: {}", error.attempts) } else { String::new() };
            return Some(format!("Model still thinking: no output in {}; {provider} sent nothing yet{attempts}.", format_duration_ms(ms)));
        }
        Some(TimeoutPhase::Idle) => {
            let ms = timed_out_ms(text);
            return Some(if ms > 0.0 { format!("No progress {}.", format_duration_ms(ms)) } else { "No progress.".into() });
        }
        _ => {}
    }
    if error.code == "TRUNCATED_STREAM" && !error.stream_corruption {
        return Some("Connection to the provider was lost (TRUNCATED_STREAM).".into());
    }
    None
}

#[cfg(test)]
mod tests {

    use super::*;

    fn typed(kind: ErrorKind, status: u16, message: &str) -> ProviderError {
        let mut error = ProviderError::new(kind, DeliveryState::Accepted);
        error.status = Some(status);
        error.message = message.to_owned();
        error
    }

    fn shown(error: &ProviderError) -> String {
        present_error_text(&ErrorView::from(error), &PresentOptions::default())
    }

    /// A route whose provider is signed out names the provider, the registry's cause, and the step to take.
    #[test]
    fn an_unavailable_provider_is_named_with_its_cause_and_the_step_to_take() {
        let cause = "[provider] Failed to init \"cursor-oauth\": not signed in — run /login";
        let text = provider_unavailable_text("cursor-oauth", Some(cause), false);
        assert_eq!(text, "Cursor OAuth is not available: not signed in. Sign in under /providers, or add an API key there.");
        assert!(provider_unavailable_text("openai", None, true).contains("OpenAI API is not available: it is switched off"));
    }

    /// A chain that ended names every model tried on the failure's last line, whatever the kind of the last error.
    #[test]
    fn a_failure_after_a_fallback_chain_names_every_model_tried() {
        let message =
            "Gemini REST 429: {}\nEvery model in the fallback chain failed — Gemini 4: Provider is rate-limited.; Opus 5: Provider usage limit reached.";
        let shown = shown(&typed(ErrorKind::RateLimited, 429, message));
        assert_eq!(shown, "Every model in the fallback chain failed — Gemini 4: Provider is rate-limited.; Opus 5: Provider usage limit reached.");
        assert_eq!(present_error_text(&ErrorView::message(shown.clone()), &PresentOptions::default()), shown, "a spawner's re-reading keeps it");
    }

    /// A suspended account's refusal carries the provider's own reason.
    #[test]
    fn an_access_denial_carries_the_providers_reason() {
        let body = "Gemini REST streamGenerateContent 403: {\"error\":{\"code\":403,\"message\":\"Your account has been suspended.\",\"status\":\"PERMISSION_DENIED\"}}";
        assert_eq!(shown(&typed(ErrorKind::Permission, 403, body)), "Access denied by the provider: Your account has been suspended.");
    }

    /// A failure that passed over several fallbacks names each of them, not only the first.
    #[test]
    fn a_failure_names_every_fallback_it_skipped() {
        let message = "overloaded\nSkipped fallback GPT 6: OpenAI OAuth is not available: not signed in.\nSkipped fallback Gemini 4: Google is not available: it is switched off.";
        assert_eq!(
            shown(&typed(ErrorKind::Overloaded, 503, message)),
            "Provider is busy at capacity. Skipped fallback GPT 6: OpenAI OAuth is not available: not signed in. Skipped fallback Gemini 4: Google is not available: it is switched off."
        );
    }

    /// A route saved on a provider this core does not serve says so in a sentence.
    #[test]
    fn a_provider_this_core_does_not_offer_is_named_in_a_sentence() {
        let raw = "[provider] Failed to init \"acp-antigravity\": unknown enabled provider: acp-antigravity".to_owned();
        assert_eq!(route_ready_error_text(raw), "This core does not offer the provider \"acp-antigravity\"; choose a route on another provider.");
        assert_eq!(route_ready_error_text("the token store is locked".into()), "the token store is locked");
    }

    /// A peer that closed or a failed lookup carries the code Node's `cause` names, as a reset does.
    #[test]
    fn a_closed_socket_and_a_failed_lookup_name_their_node_codes() {
        use mixdog_core_api::domain::provider::DeliveryState;
        for (fault, text) in [
            (TransportFault::Closed, "Connection to the provider was lost (UND_ERR_SOCKET)."),
            (TransportFault::Dns, "Could not reach the provider (ENOTFOUND)."),
        ] {
            let error = ProviderError::transport(fault, DeliveryState::Ambiguous);
            assert_eq!(present_error_text(&ErrorView::from(&error), &PresentOptions::default()), text);
        }
    }

    /// An accepted stream cut by a connection-level error has no message; its text names the lost connection and the cause the
    /// fault carries: a reset, a peer's EOF without GOAWAY, a GOAWAY. Never `Error` or `Unknown error`.
    #[test]
    fn a_cut_stream_without_a_message_names_the_lost_connection() {
        use mixdog_core_api::domain::provider::DeliveryState;
        for (fault, text) in [
            (TransportFault::Reset, "Connection to the provider was lost (ECONNRESET)."),
            (TransportFault::Closed, "Connection to the provider was lost (UND_ERR_SOCKET)."),
            (TransportFault::H2GoAway { code: 11 }, "Connection to the provider was lost (ERR_HTTP2_GOAWAY_SESSION)."),
        ] {
            let error = ProviderError::transport(fault, DeliveryState::Accepted);
            assert_eq!(provider_error_text(&error, "agent"), text);
        }
        let bare = ProviderError::new(ErrorKind::Transient, DeliveryState::Accepted);
        assert_eq!(provider_error_text(&bare, "agent"), "The provider request failed (transient, after the provider accepted the request).");
        let mut worded = ProviderError::new(ErrorKind::Transient, DeliveryState::Accepted);
        worded.message = "terminated".into();
        assert_eq!(provider_error_text(&worded, "agent"), "terminated");
    }

    #[test]
    fn a_provider_error_reads_through_its_stamped_kind() {
        use mixdog_core_api::domain::provider::DeliveryState;
        let mut error = ProviderError::new(ErrorKind::RateLimited, DeliveryState::Accepted);
        error.status = Some(429);
        error.retry_after = Some(std::time::Duration::from_secs(4));
        assert_eq!(present_error_text(&ErrorView::from(&error), &PresentOptions::default()), "Provider is rate-limited (retry in 4s).");
        let cut = ProviderError::transport(TransportFault::TruncatedStream, DeliveryState::Accepted);
        assert_eq!(present_error_text(&ErrorView::from(&cut), &PresentOptions::default()), "Connection to the provider was lost (TRUNCATED_STREAM).");
    }
}

impl Descriptor {
    /// The verdict a classified provider error carries (`providerErrorKind`'s answer): the kind the adapter
    /// stamped, the code trimmed and lower-cased, the status, and the positive retry advice and reset it named.
    pub fn of(error: &ProviderError) -> Self {
        let retry_after_ms = error.retry_after.map_or(0, |d| d.as_millis() as u64);
        Self {
            kind: kind_name(error.kind).into(),
            code: sent_code(error).trim().to_lowercase(),
            status: error.status.map_or(0, u32::from),
            retry_after_ms: (retry_after_ms > 0).then_some(retry_after_ms),
            reset_at: error.reset_at.and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64),
        }
    }
}
