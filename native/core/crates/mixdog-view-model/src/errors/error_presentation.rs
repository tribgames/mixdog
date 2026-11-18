//! The presentation of a failure: a kind, a one-line summary, a recovery step and a stable fingerprint
//! (`error-presentation.mjs`), with the `safeErrorDetails` redaction every diagnostic text goes through before it reaches a
//! view, a copy button or a log. Presentation only: it never changes retry policy or the underlying failure.

use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::js_trim;
use mixdog_js::js_trim_end;
use mixdog_js::json_stringify as stringify;
use mixdog_js::json_number;
use mixdog_js::json_parse;
use mixdog_js::slice_utf16;
use mixdog_js::time::local_fields;
use mixdog_js::utf16_len;
use serde_json::Value;
use serde_json::json;

use super::js_value::ERROR_INSTANCE_KEY;
use super::js_value::Js;
use super::js_value::get;
use super::js_value::is_object;
use super::js_value::js_string;
use super::js_value::num_text;
use super::js_value::number;
use super::js_value::path;
use super::js_value::str_of;
use super::js_value::string_or_empty;
use super::js_value::system_now_ms;
use super::js_value::truthy;
use super::provider_error_kind::KindDescriptor;
use super::provider_error_kind::KindOptions;
use super::provider_error_kind::PROVIDER_ERROR_KINDS;
use super::provider_error_kind::provider_error_kind;
use super::transport_error_text::transport_error_text;

const DETAILS_LIMIT: usize = 12_000;
const SUMMARY_LIMIT: usize = 180;

macro_rules! js_re {
    ($name:ident, $pattern:expr, $flags:expr) => {
        static $name: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static($pattern, $flags));
    };
}

// "<wrapper>: The latest message cannot fit this model (CODE): <sizes>. <cause and remedy>"
js_re!(
    LATEST_TURN,
    r"The latest message cannot fit this model \(LATEST_TURN_EXCEEDS_CONTEXT\)(: it needs about [\d,]+ tokens, but the [^.]* window leaves [\d,]+ for it\.)([\s\S]*)$",
    ""
);
js_re!(WHITESPACE, r"\s+", "");
js_re!(ANSI, r"\x1b\[[0-?]*[ -/]*[@-~]", "");
js_re!(LINE_BREAKS, r"\r\n?", "");
js_re!(URL_CREDENTIALS, r"\b((?:https?|ssh)://)[^/\s@]+@", "i");
js_re!(AUTH_SCHEME, r"\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+", "i");
js_re!(URL_SECRET_PARAM, r#"([?&](?:token|access_token|refresh_token|api_key|key|code|signature|sig)=)[^&\s"'<>]+"#, "i");
js_re!(
    SECRET_FIELD,
    r#"(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password|secret|client_secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)"#,
    "i"
);
js_re!(
    TOKEN_SHAPE,
    r"\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b",
    ""
);
js_re!(DATA_URL, r"data:[\w.+/-]+;base64,[A-Za-z0-9+/=\s]+", "");
js_re!(DATA_FIELD, r#"(["']data["']\s*:\s*["'])[A-Za-z0-9+/=]{256,}(["'])"#, "");
js_re!(API_STATUS, r"\b(?:API|HTTP(?: fallback)?)\s+([45]\d\d)\b", "i");
js_re!(REJECTED_429, r"\bAPI 429 request rejected\b", "");
js_re!(REAUTH, r"invalid_grant|refresh token (?:expired|revoked|not available)|sign in again|sign-in expired|Reauth Required", "i");
js_re!(AUTH_WORDING, r"\b(?:invalid|expired)\s+(?:api[ _-]?key|access token|credentials?)\b|Provider authentication failed", "i");
js_re!(
    IMAGE_SIZE,
    r"image.*dimensions.*exceed|image.*(?:too large|maximum.*(?:size|dimension))|many-image requests|An attached image exceeds the provider limit",
    "i"
);
js_re!(PAYLOAD_SIZE, r"payload too large|request (?:body )?too large|The request exceeds the size limit", "i");
js_re!(REMOTE_METHOD_PREFIX, r#"^(?:Error invoking remote method ['"][^'"]+['"]:\s*)?(?:Error:\s*)?"#, "i");
js_re!(
    TOOL_SCHEMA,
    r"invalid schema for (?:function|tool)\b|\btools\.\d+\.(?:custom\.)?input_schema\b|\bfunction_declarations\[\d+\]\.parameters\b|\btools\[\d+\]\.function\.parameters\b|\binvalid (?:tool|function) (?:schema|parameters|definition)\b",
    "i"
);
js_re!(UNREADABLE_LINE, r"^at\s|^\{|^<!doctype|^<html", "i");
js_re!(UNREADABLE_FIRST, r"^[{[]|^<|(?:API|HTTP)\s+[45]\d\d.*[<{]", "i");
js_re!(LEGACY_QUOTA_TEXT, r"The provider usage limit was reached|quota.*(?:hit|exceed)|usage limit", "i");
js_re!(LEGACY_RATE_TEXT, r"rate[_ -]?limit|too many requests", "i");
js_re!(LEGACY_WAIT, r"retryAfter=(\d+)(ms|s|m)\b", "i");

// A refused request that names its model as unknown, retired or not offered to this account. Read only for
// request-refusal kinds, so a typed overload, quota or auth failure never reads as a missing model.
const MODEL_REFUSAL_KINDS: &[&str] = &["invalid_request", "permission", "unknown"];
const MODEL_UNAVAILABLE_CODES: &[&str] = &["model_not_found", "model_not_supported"];
// The model must be the subject of the refusal, at the start of a line or sentence ("The model `x` does not exist",
// "models/x is not found", Ollama's `model "x" not found`), or the refusal names it ("Unknown model", "... is not a valid
// model ID", Anthropic's bare "model: x"). A model merely mentioned beside some other missing thing ("For model x, tool
// lookup: route not found") does not count.
const MODEL_REFUSAL_PREDICATE: &str = r"(?:(?:is|was|has been)\s+)?(?:not found|does not exist|doesn'?t exist|not (?:supported|available)|(?:currently\s+)?unavailable|no longer (?:available|supported)|deprecated|retired|removed)\b";
const SENTENCE_START: &str = r"(?:^|[.:;!]\s+)";
static MODEL_UNAVAILABLE: LazyLock<JsRegex> = LazyLock::new(|| {
    let pattern = [
        // "The model `x` does not exist", "models/x is not found", Vertex "Publisher Model `...` was not found", Ollama
        // `model "x" not found`.
        format!(
            r#"{SENTENCE_START}(?:(?:the|this|that|requested|selected|publisher)\s+)*models?(?:\/\S+|\s+[`'"]?[\w./:@-]+[`'"]?)?\s+{MODEL_REFUSAL_PREDICATE}"#
        ),
        // OpenAI "The 'gpt-x' model is not supported when using Codex ...".
        format!(r#"{SENTENCE_START}(?:the\s+)?[`'"][^`'"\n]+[`'"]\s+model\s+{MODEL_REFUSAL_PREDICATE}"#),
        format!(r"{SENTENCE_START}(?:unknown|invalid|unsupported) model\b"),
        // OpenRouter: no provider serves this model id.
        format!(r"{SENTENCE_START}no endpoints found for [\w.-]+\/[\w.:-]+"),
        r"\bis not a valid model\b".to_owned(),
        r"^model: \S+$".to_owned(),
    ]
    .join("|");
    JsRegex::new_static(&pattern, "im")
});

/// Diagnostic text must be safe before it reaches a view, copy button or log: control sequences, credentials and image
/// data are removed.
pub fn safe_error_details(value: &str) -> String {
    let text = ANSI.replace_all_with(value, |_| String::new());
    let text = LINE_BREAKS.replace_all_with(&text, |_| "\n".into());
    let text = URL_CREDENTIALS.replace_all_with(&text, |found| format!("{}[redacted]@", found.get(1).unwrap_or("")));
    let text = AUTH_SCHEME.replace_all_with(&text, |found| format!("{} [redacted]", found.get(1).unwrap_or("")));
    let text = URL_SECRET_PARAM.replace_all_with(&text, |found| format!("{}[redacted]", found.get(1).unwrap_or("")));
    let text = SECRET_FIELD.replace_all_with(&text, |found| format!("{}[redacted]", found.get(1).unwrap_or("")));
    let text = TOKEN_SHAPE.replace_all_with(&text, |_| "[redacted]".into());
    let text = DATA_URL.replace_all_with(&text, |_| "[image data]".into());
    let text = DATA_FIELD.replace_all_with(&text, |found| format!("{}[image data]{}", found.get(1).unwrap_or(""), found.get(2).unwrap_or("")));
    let text = js_trim(&text);
    if utf16_len(text) > DETAILS_LIMIT {
        return format!("{}\n…", slice_utf16(text, DETAILS_LIMIT));
    }
    text.to_owned()
}

fn message_of(value: Js) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(object @ (Value::Object(_) | Value::Array(_))) => {
            if let Some(message) = str_of(get(Some(object), "message")) {
                return message.to_owned();
            }
            if let Some(detail) = str_of(get(Some(object), "detail")) {
                return detail.to_owned();
            }
            stringify(object)
        }
        None | Some(Value::Null) => String::new(),
        Some(other) => js_string(Some(other)),
    }
}

struct Unwrapped {
    raw: String,
    message: String,
    status: f64,
    code: String,
}

fn unwrap(value: Js) -> Unwrapped {
    let raw = js_trim(&message_of(value)).to_owned();
    let parsed = raw.find('{').and_then(|start| json_parse(&raw[start..]).ok());
    let envelope = match parsed.as_ref().filter(|parsed| is_object(Some(*parsed))) {
        Some(parsed) => Some(parsed),
        None => value,
    };
    let nested = get(envelope, "error");
    let message = str_of(nested)
        .or_else(|| str_of(get(nested, "message")))
        .or_else(|| str_of(get(envelope, "message")))
        .map_or_else(|| raw.clone(), str::to_owned);
    let from_text = API_STATUS.captures(&raw).and_then(|found| found.get(1)).map(|status| Value::String(status.to_owned()));
    let status = [get(value, "httpStatus"), get(value, "status"), path(value, &["response", "status"]), get(envelope, "status"), from_text.as_ref()]
        .into_iter()
        .find(|candidate| truthy(*candidate))
        .map_or(0.0, |candidate| number(candidate));
    let code = [get(nested, "code"), get(nested, "type"), get(envelope, "code")]
        .into_iter()
        .find(|candidate| truthy(*candidate))
        .map_or_else(String::new, |candidate| js_string(candidate));
    Unwrapped { raw, message, status, code }
}

/// A 429 the provider sent without quota headers: a refusal, not an exhausted limit.
pub fn is_rejected_429(value: Js) -> bool {
    REJECTED_429.is_match(&message_of(value))
}

// Provider kind -> (presentation kind, summary, recovery). Summaries are also the persisted form of a failure, so each maps
// back to its kind when only the text survives.
const KIND_COPY: &[(&str, &str, &str, &str)] = &[
    ("overloaded", "overloaded", "The provider is busy right now.", "Try again later or choose another model."),
    ("rate_limited", "rate-limit", "The provider is temporarily rate-limiting requests.", "Try again shortly."),
    ("quota_exhausted", "quota", "The provider usage limit was reached.", "Wait for the limit to reset or choose another account."),
    ("entitlement", "entitlement", "This model isn't included in your plan.", "Upgrade your plan, or choose another model or provider."),
    ("billing", "billing", "The provider account is out of credits or at its spend limit.", "Check your billing with the provider, then try again."),
    ("permission", "permission", "You don't have access to this resource.", "Check your account permissions, or choose another model."),
    ("context_overflow", "context-overflow", "The conversation is too long for this model.", "Compact the conversation or start a new one."),
    ("request_too_large", "payload-size", "The request exceeds the size limit.", "Reduce the attachments or request size, then try again."),
    ("policy", "policy", "The provider refused this request under its safety policy.", "Rephrase the request or choose another model."),
    ("service_tier_unavailable", "service-tier", "The requested service tier is unavailable right now.", "Switch to the standard tier or try again later."),
];

fn kind_copy(provider_kind: &str) -> Option<(&'static str, &'static str, &'static str)> {
    KIND_COPY.iter().find(|(kind, ..)| *kind == provider_kind).map(|(_, kind, summary, recovery)| (*kind, *summary, *recovery))
}

fn summary_kind(summary: &str) -> Option<&'static str> {
    KIND_COPY.iter().find(|(_, _, copy, _)| *copy == summary).map(|(kind, ..)| *kind)
}

const MODEL_UNAVAILABLE_COPY: (&str, &str, &str) = (
    "model-unavailable",
    "This model isn't available for this account.",
    "Choose another model, or check the model and endpoint in Providers.",
);
const NOT_FOUND_SUMMARY: &str = "The provider couldn't find the requested model or endpoint.";
// A tool definition the provider's schema validator refused (an MCP or custom tool schema), named by the field path or
// wording each API uses.
const TOOL_SCHEMA_COPY: (&str, &str, &str) =
    ("tool-schema", "The provider rejected a tool definition.", "Disable the tool or MCP server named in the details, then try again.");
const REQUEST_REJECTED_SUMMARY: &str = "The provider rejected this request.";

fn wait_label(ms: f64) -> String {
    let seconds = (ms / 1000.0).ceil().max(1.0);
    if seconds < 60.0 {
        return format!("{}s", num_text(seconds));
    }
    let minutes = (seconds / 60.0).ceil();
    if minutes < 60.0 {
        return format!("{}m", num_text(minutes));
    }
    let hours = (minutes / 60.0).floor();
    let rest = minutes % 60.0;
    if rest != 0.0 { format!("{}h {}m", num_text(hours), num_text(rest)) } else { format!("{}h", num_text(hours)) }
}

/// Local HH:mm, prefixed with month/day when the reset is not today.
fn reset_label(reset_at: f64, now_ms: f64) -> String {
    let Some(reset) = local_fields(reset_at) else { return "NaN/NaN NaN:NaN".into() };
    let time = format!("{:02}:{:02}", reset.hour, reset.minute);
    match local_fields(now_ms) {
        Some(today) if (today.year, today.month, today.day) == (reset.year, reset.month, reset.day) => time,
        _ => format!("{}/{} {time}", reset.month, reset.day),
    }
}

/// True when `error` (or its text) says the requested model is unknown, retired or not offered to this account: a typed
/// model code, or provider wording with the model as the subject of the refusal.
pub fn names_unavailable_model(error: Js) -> bool {
    if !truthy(error) {
        return false;
    }
    if let Some(text) = str_of(error) {
        return MODEL_UNAVAILABLE.is_match(text);
    }
    let codes = [get(error, "code"), get(error, "providerErrorCode"), path(error, &["error", "code"]), path(error, &["providerError", "code"])];
    if codes.into_iter().any(|code| MODEL_UNAVAILABLE_CODES.contains(&mixdog_js::js_to_lowercase(&string_or_empty(code)).as_str())) {
        return true;
    }
    [get(error, "message"), path(error, &["error", "message"]), path(error, &["providerError", "message"]), get(error, "detail")]
        .into_iter()
        .filter_map(str_of)
        .any(|text| !text.is_empty() && MODEL_UNAVAILABLE.is_match(text))
}

// The first line of a provider message worth showing as-is; "" for a stack frame, a markup page or a raw JSON body.
fn first_readable_line(clean: &str) -> String {
    let lines = clean.split('\n').map(js_trim).filter(|line| !line.is_empty());
    let first = lines.into_iter().find(|line| !UNREADABLE_LINE.is_match(line)).unwrap_or("");
    if !first.is_empty() && !UNREADABLE_FIRST.is_match(first) { first.to_owned() } else { String::new() }
}

/// The provider kind descriptor: the persisted one, else typed evidence, else wording. The flag is true when the kind came
/// from a persisted descriptor or a typed error: wording heuristics must then never override it.
fn classify(value: Js, raw: &str, clean: &str, status: f64, code: &str, now_ms: f64) -> (KindDescriptor, bool) {
    let persisted = get(value, "errorKind");
    if let Some(kind) = str_of(get(persisted, "kind")).and_then(|kind| PROVIDER_ERROR_KINDS.iter().copied().find(|known| *known == kind)) {
        let positive = |key: &str| Some(number(get(persisted, key))).filter(|n| *n > 0.0);
        let status = number(get(persisted, "status"));
        let descriptor = KindDescriptor {
            kind,
            code: string_or_empty(get(persisted, "code")),
            status: if status.is_nan() { 0.0 } else { status },
            retry_after_ms: positive("retryAfterMs"),
            reset_at: positive("resetAt"),
        };
        return (descriptor, kind != "unknown");
    }
    let typed_fields = is_object(value)
        && [get(value, "status"), get(value, "httpStatus"), path(value, &["response", "status"]), get(value, "code"), get(value, "retryAfterMs")]
            .into_iter()
            .any(truthy);
    if !typed_fields {
        // Legacy persisted strings: their wording (and wait) is the only evidence.
        if let Some(legacy) = legacy_kind(clean) {
            let retry_after_ms = LEGACY_WAIT.captures(raw).and_then(|wait| {
                let unit = match mixdog_js::js_to_lowercase(wait.get(2)?).as_str() {
                    "ms" => 1.0,
                    "s" => 1000.0,
                    _ => 60_000.0,
                };
                Some(wait.get(1)?.parse::<f64>().ok()? * unit)
            });
            let descriptor = KindDescriptor { kind: legacy, retry_after_ms: retry_after_ms.filter(|n| *n != 0.0), ..KindDescriptor::unknown() };
            return (descriptor, false);
        }
    }
    let options = KindOptions { now_ms: Some(now_ms), ..KindOptions::default() };
    let mut descriptor = if is_object(value) { Some(provider_error_kind(value, &options)) } else { None };
    let typed = descriptor.as_ref().is_some_and(|descriptor| descriptor.kind != "unknown");
    if !typed {
        let mut error = json!({ "name": "Error", "message": raw });
        error[ERROR_INSTANCE_KEY] = json!(true);
        if status != 0.0 && !status.is_nan() {
            error["status"] = json_number(status);
        }
        if !code.is_empty() {
            error["code"] = json!(code);
        }
        descriptor = Some(provider_error_kind(Some(&error), &options));
    }
    let mut descriptor = descriptor.unwrap_or_else(KindDescriptor::unknown);
    if descriptor.kind == "unknown" {
        if let Some(legacy) = legacy_kind(clean) {
            descriptor.kind = legacy;
            return (descriptor, false);
        }
    }
    (descriptor, typed)
}

// Only legacy items (no persisted descriptor) and untyped strings reach this.
fn legacy_kind(clean: &str) -> Option<&'static str> {
    summary_kind(clean).or_else(|| {
        if LEGACY_QUOTA_TEXT.is_match(clean) {
            Some("quota_exhausted")
        } else if LEGACY_RATE_TEXT.is_match(clean) {
            Some("rate_limited")
        } else {
            None
        }
    })
}

/// The presentation of a failure.
#[derive(Clone, Debug, PartialEq)]
pub struct Presentation {
    /// The presentation kind: `reauth`, `authentication`, `request`, `image-size`, `model-unavailable`, `tool-schema`,
    /// `not-found`, `latest-turn-size`, `connection`, a provider kind's own (`rate-limit`, `quota`, ...) or `unknown`.
    pub kind: String,
    pub summary: String,
    pub recovery: String,
    /// A recovery that carries a value is given as a template, for the renderer's translation.
    pub recovery_template: String,
    pub params: Option<Value>,
    pub provider_kind: &'static str,
    pub reset_at: Option<f64>,
    pub retry_after_ms: Option<f64>,
    pub details: String,
    /// Known structured failures ignore volatile indexes; unknown failures retain their diagnostic identity rather than
    /// merging unrelated work.
    pub fingerprint: String,
}

impl Presentation {
    /// The object Node answers.
    pub fn to_value(&self) -> Value {
        let number = |value: Option<f64>| value.map_or(Value::Null, json_number);
        json!({
            "kind": self.kind,
            "summary": self.summary,
            "recovery": self.recovery,
            "recoveryTemplate": self.recovery_template,
            "params": self.params,
            "providerKind": self.provider_kind,
            "resetAt": number(self.reset_at),
            "retryAfterMs": number(self.retry_after_ms),
            "details": self.details,
            "fingerprint": self.fingerprint,
        })
    }
}

fn nonzero(n: f64) -> f64 {
    if n.is_nan() { 0.0 } else { n }
}

/// `describeError`: presentation only, never changes retry policy or the underlying failure. `now_ms` is `Date.now()` (the
/// wall clock when `None`).
pub fn describe_error(value: Js, now_ms: Option<f64>) -> Presentation {
    let now_ms = now_ms.unwrap_or_else(system_now_ms);
    let Unwrapped { raw, message, status: text_status, code: text_code } = unwrap(value);
    let details = safe_error_details(&raw);
    let cleaned = safe_error_details(&message);
    let cleaned = REMOTE_METHOD_PREFIX.find(&cleaned).map_or(cleaned.as_str(), |prefix| &cleaned[prefix.end..]);
    let clean = js_trim(cleaned).to_owned();
    let (descriptor, typed) = classify(value, &raw, &clean, text_status, &text_code, now_ms);
    // A typed or persisted kind owns the verdict: its own status and code stand in for the text-derived ones, and wording
    // below may only refine it.
    let status = if typed { nonzero(descriptor.status) } else { text_status };
    let code = if typed { descriptor.code.clone() } else { text_code };
    // A 429 refusal without quota headers refines a rate limit, nothing else.
    let rejected_429 = is_rejected_429(value) && (!typed || descriptor.kind == "rate_limited");
    let copy = kind_copy(descriptor.kind);
    let retry_after_ms = descriptor.retry_after_ms.filter(|n| *n > 0.0);
    let reset_at = descriptor.reset_at.filter(|n| *n > 0.0);
    let (mut kind, mut summary, mut recovery) = ("unknown".to_owned(), String::new(), String::new());
    let mut recovery_template = String::new();
    let mut params = None;
    // A persisted descriptor keeps the status and errno code, not the cause chain: rebuild the transport evidence from them.
    // Wording only reads for untyped failures and transient ones (a bare "fetch failed" is that evidence).
    let transport = transport_error_text(value)
        .or_else(|| {
            if typed { transport_error_text(Some(&json!({ "code": code.to_uppercase(), "status": json_number(status) }))) } else { None }
        })
        .or_else(|| if !typed || descriptor.kind == "transient" { transport_error_text(Some(&json!(raw))) } else { None });
    let mut set = |copy: (&str, &str, &str)| {
        kind = copy.0.to_owned();
        summary = copy.1.to_owned();
        recovery = copy.2.to_owned();
    };
    if get(value, "reauthRequired") == Some(&Value::Bool(true)) || (!typed && REAUTH.is_match(&raw)) {
        set(("reauth", "Sign-in expired.", "Sign in again from Providers."));
    } else if descriptor.kind == "auth" || (descriptor.kind == "unknown" && AUTH_WORDING.is_match(&clean)) {
        set(("authentication", "Provider authentication failed", "Check your sign-in or API key, then try again."));
    } else if rejected_429 {
        set(("request", REQUEST_REJECTED_SUMMARY, "Review the request details before trying again."));
    } else if matches!(descriptor.kind, "invalid_request" | "unknown" | "request_too_large") && IMAGE_SIZE.is_match(&clean) {
        set((
            "image-size",
            "An attached image exceeds the provider limit.",
            "Reduce the image dimensions or number of images, then try again.",
        ));
    } else if clean == MODEL_UNAVAILABLE_COPY.1
        || (MODEL_REFUSAL_KINDS.contains(&descriptor.kind) && (MODEL_UNAVAILABLE_CODES.contains(&code.as_str()) || MODEL_UNAVAILABLE.is_match(&clean)))
    {
        set(MODEL_UNAVAILABLE_COPY);
    } else if clean == TOOL_SCHEMA_COPY.1 || (matches!(descriptor.kind, "invalid_request" | "unknown") && TOOL_SCHEMA.is_match(&clean)) {
        set(TOOL_SCHEMA_COPY);
    } else if clean == NOT_FOUND_SUMMARY || (MODEL_REFUSAL_KINDS.contains(&descriptor.kind) && (status == 404.0 || status == 410.0)) {
        // The provider's own words name what is missing; the next step is the same.
        let readable = first_readable_line(&clean);
        set(("not-found", if readable.is_empty() { NOT_FOUND_SUMMARY } else { readable.as_str() }, MODEL_UNAVAILABLE_COPY.2));
    } else if let Some(latest) = LATEST_TURN.captures(&clean) {
        // The latest message cannot fit the window (compact/runner.mjs): the sizes are the headline, the cause and remedy the
        // next step.
        let headline = latest.get(1).unwrap_or("");
        let rest = latest.get(2).unwrap_or("");
        let headline_text = format!("The latest message cannot fit this model{headline}");
        set(("latest-turn-size", headline_text.as_str(), js_trim(rest)));
    } else if descriptor.kind == "unknown" && PAYLOAD_SIZE.is_match(&clean) {
        set(kind_copy("request_too_large").unwrap_or_default());
    } else if let Some((copy_kind, copy_summary, copy_recovery)) = copy {
        set((copy_kind, copy_summary, copy_recovery));
        if descriptor.kind == "rate_limited" {
            if let Some(wait) = retry_after_ms {
                recovery = format!("Try again in {}.", wait_label(wait));
                recovery_template = "Try again in {{wait}}.".into();
                params = Some(json!({ "wait": wait_label(wait) }));
            }
        } else if descriptor.kind == "quota_exhausted" {
            if let Some(reset) = reset_at {
                recovery = format!("It resets at {}. Switch accounts or providers to continue now.", reset_label(reset, now_ms));
                recovery_template = "It resets at {{time}}. Switch accounts or providers to continue now.".into();
                params = Some(json!({ "time": reset_label(reset, now_ms) }));
            }
        }
    } else if let Some(transport) = transport {
        set(("connection", transport.strip_suffix('.').unwrap_or(&transport), "Check the connection, then try again."));
    } else if status == 400.0 || status == 422.0 || code == "invalid_request_error" || clean == REQUEST_REJECTED_SUMMARY {
        set(("request", REQUEST_REJECTED_SUMMARY, "Review the request details before trying again."));
    } else {
        summary = first_readable_line(&clean);
    }
    let mut summary = js_trim(&WHITESPACE.replace_all_with(&summary, |_| " ".into())).to_owned();
    if summary.is_empty() {
        summary = "Something went wrong.".into();
    }
    if utf16_len(&summary) > SUMMARY_LIMIT {
        summary = format!("{}…", js_trim_end(&slice_utf16(&summary, SUMMARY_LIMIT - 1)));
    }
    let fingerprint_status = if kind == "reauth" || status == 0.0 || status.is_nan() { String::new() } else { num_text(status) };
    let fingerprint = if kind == "unknown" { details.clone() } else { format!("{kind}:{fingerprint_status}") };
    Presentation { kind, summary, recovery, recovery_template, params, provider_kind: descriptor.kind, reset_at, retry_after_ms, details, fingerprint }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const NOW: f64 = 1_700_000_000_000.0;

    #[test]
    fn credentials_and_image_data_never_reach_a_view() {
        let text = "GET https://user:pw@host/x Bearer abc.def password=hunter2 data:image/png;base64,AAAA==\u{1b}[31m";
        assert_eq!(safe_error_details(text), "GET https://[redacted]@host/x Bearer [redacted] password=[redacted] [image data]");
        assert_eq!(safe_error_details("see /x?token=abc&ok=1"), "see /x?token=[redacted]&ok=1");
        assert!(utf16_len(&safe_error_details(&"x".repeat(13_000))) <= DETAILS_LIMIT + 2);
    }


    fn describe(value: Value) -> Presentation {
        mixdog_js::time::with_local_zone(mixdog_js::time::Tz::UTC, || describe_error(Some(&value), Some(NOW)))
    }
    #[test]
    fn a_typed_kind_owns_the_verdict() {
        let found = describe(json!({ "status": 429, "retryAfterMs": 90_000, "message": "slow" }));
        assert_eq!((found.kind.as_str(), found.provider_kind), ("rate-limit", "rate_limited"));
        assert_eq!(found.recovery, "Try again in 2m.");
        assert_eq!(found.params, Some(json!({ "wait": "2m" })));
        assert_eq!(found.fingerprint, "rate-limit:429");
        let quota = describe(json!({ "status": 429, "quotaScope": "day", "resetAt": NOW + 3_600_000.0 }));
        assert_eq!(quota.recovery, "It resets at 23:13. Switch accounts or providers to continue now.");
    }
    #[test]
    fn persisted_summaries_and_wording_map_back() {
        assert_eq!(describe(json!("The provider usage limit was reached.")).provider_kind, "quota_exhausted");
        let model = describe(json!({ "status": 400, "message": "The model `x` does not exist" }));
        assert_eq!(model.kind, "model-unavailable");
        assert!(names_unavailable_model(Some(&json!({ "error": { "code": "Model_Not_Found" } }))));
        assert!(!names_unavailable_model(Some(&json!("For model x, tool lookup: route not found"))));
        assert_eq!(describe(json!({ "message": "fetch failed" })).kind, "connection");
        assert_eq!(describe(json!({ "message": "boom\nsecond" })).summary, "boom");
        assert_eq!(describe(json!(null)).summary, "Something went wrong.");
    }
}
