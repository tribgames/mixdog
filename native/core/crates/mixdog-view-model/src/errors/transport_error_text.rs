//! Connection-level failure to one short user-facing sentence (`transport-error-text.mjs`).
//!
//! Transport errors reach the UI in many shapes: a Node errno on the error itself, an undici `SocketError` buried in
//! `cause`, a bare fetch message (`fetch failed`, `terminated`) with no code at all, or a gateway 5xx. Every surface
//! that shows a failure reads them through this one classifier, so the user sees "Connection to the provider was lost
//! (UND_ERR_SOCKET)." instead of the runtime's raw wording while the code stays visible for diagnosis.

use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::js_trim;
use serde_json::Value;

use super::js_value::Js;
use super::js_value::get;
use super::js_value::is_integer;
use super::js_value::is_object;
use super::js_value::num_text;
use super::js_value::number;
use super::js_value::path;
use super::js_value::string_or_empty;
use super::js_value::truthy;

const MAX_CAUSE_DEPTH: usize = 8;

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
const UNAVAILABLE_STATUSES: &[f64] = &[502.0, 503.0, 504.0, 521.0, 522.0, 523.0, 524.0];
const WS_LOST_CLOSE_CODES: &[f64] = &[1000.0, 1001.0, 1005.0, 1006.0, 1011.0, 1012.0];

static TLS_CODE: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"^(?:UNABLE_TO_|CERT_|DEPTH_ZERO_SELF_SIGNED|SELF_SIGNED_CERT|ERR_TLS_|HOSTNAME_MISMATCH)", ""));
// Bare runtime messages that carry no code: undici body abort, Node/Chromium/WebKit fetch failures, the Anthropic/OpenAI SDK
// connection wrapper. Matched whole so a shell job "terminated by signal" or a session "terminated" notice never reads as a
// provider disconnect.
static LOST_BARE_MESSAGE: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"^(?:terminated|socket hang up|other side closed|connection error\.?)$", "i"));
static FETCH_BARE_MESSAGE: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"^(?:fetch failed|failed to fetch|couldn'?t fetch\.?|load failed|network error)$", "i"));
static LOST_PHRASE: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new_static(
        r"\b(?:socket hang up|other side closed|connection (?:was )?reset(?: by peer)?|network unreachable|premature close|stream (?:was )?destroyed)\b",
        "i",
    )
});
static UNREACHABLE_PHRASE: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"\b(?:connection refused|getaddrinfo|dns lookup failed|host (?:not found|unreachable))\b", "i"));
static TIMEOUT_PHRASE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\b(?:connect(?:ion)? timed? ?out|headers timeout|body timeout)\b", "i"));
static GATEWAY_STATUS_MESSAGE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\b(?:API|HTTP(?: fallback)?)\s+(50[234]|52[1-4])\b", ""));
// Exact provider messages survive persistence/IPC without wsCloseCode.
static WS_CLOSE_MESSAGE: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new_static(
        r"^(?:Error:\s*)?(?:OpenAI(?: OAuth)?|xAI) WS (?:closed before response\.completed|handshake closed before open) \(code=(\d{4})(?:, reason=[\s\S]*)?\)$",
        "",
    )
});

/// What `classifyTransportError` answered: `kind` is `lost`, `unreachable`, `timeout`, `tls` or `unavailable`; `code` is the
/// innermost errno/undici code (the most specific cause) or `WS <close code>`; `status` is the gateway status or 0.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TransportVerdict {
    pub kind: &'static str,
    pub code: String,
    pub status: u32,
}

fn verdict(kind: &'static str, code: impl Into<String>, status: u32) -> Option<TransportVerdict> {
    Some(TransportVerdict { kind, code: code.into(), status })
}

fn cause_chain(error: Js<'_>) -> Vec<&Value> {
    let mut chain = Vec::new();
    let mut cursor = error;
    while let Some(item) = cursor.filter(|item| is_object(Some(*item))) {
        if chain.len() >= MAX_CAUSE_DEPTH {
            break;
        }
        chain.push(item);
        cursor = get(Some(item), "cause").filter(|cause| truthy(Some(*cause)));
    }
    chain
}

fn message_of(value: Js) -> String {
    match value {
        Some(Value::String(text)) => js_trim(text).to_owned(),
        _ => get(value, "message").and_then(Value::as_str).map(|text| js_trim(text).to_owned()).unwrap_or_default(),
    }
}

fn typed_status(error: Js) -> u32 {
    if !is_object(error) {
        return 0;
    }
    for value in [get(error, "httpStatus"), get(error, "status"), path(error, &["response", "status"])] {
        let n = number(value);
        if is_integer(n) && (100.0..=599.0).contains(&n) {
            return n as u32;
        }
    }
    0
}

// Innermost typed code wins: an outer TypeError('fetch failed') wraps the SocketError that actually explains the failure.
fn typed_transport_kind(chain: &[&Value]) -> Option<TransportVerdict> {
    for item in chain.iter().rev() {
        let item = Some(*item);
        let code = string_or_empty(get(item, "code")).to_uppercase();
        let name = string_or_empty(get(item, "name"));
        if !code.is_empty() && TLS_CODE.is_match(&code) {
            return verdict("tls", code, 0);
        }
        if LOST_CODES.contains(&code.as_str()) {
            return verdict("lost", code, 0);
        }
        if UNREACHABLE_CODES.contains(&code.as_str()) {
            return verdict("unreachable", code, 0);
        }
        if TIMEOUT_CODES.contains(&code.as_str()) {
            return verdict("timeout", code, 0);
        }
        if name == "SocketError" {
            return verdict("lost", code, 0);
        }
        if matches!(name.as_str(), "ConnectTimeoutError" | "HeadersTimeoutError" | "BodyTimeoutError") {
            return verdict("timeout", code, 0);
        }
    }
    None
}

// A gateway status, or a WebSocket close code that means the transport dropped.
fn status_transport_kind(chain: &[&Value], messages: &[String]) -> Option<TransportVerdict> {
    let status = typed_status(chain.first().copied());
    if UNAVAILABLE_STATUSES.contains(&f64::from(status)) {
        return verdict("unavailable", "", status);
    }
    if let Some(gateway) = GATEWAY_STATUS_MESSAGE.captures(messages.first().map_or("", String::as_str)) {
        return verdict("unavailable", "", gateway.get(1).and_then(|code| code.parse().ok()).unwrap_or(0));
    }
    for item in chain.iter().rev() {
        let close = number(get(Some(*item), "wsCloseCode"));
        if WS_LOST_CLOSE_CODES.contains(&close) {
            return verdict("lost", format!("WS {}", num_text(close)), 0);
        }
    }
    None
}

// The message text is the last resort: runtimes that carry no code or status.
fn message_transport_kind(messages: &[String]) -> Option<TransportVerdict> {
    for message in messages {
        if message.is_empty() {
            continue;
        }
        let close = WS_CLOSE_MESSAGE.captures(message).and_then(|found| found.get(1)).and_then(|code| code.parse::<f64>().ok());
        if let Some(close) = close.filter(|close| WS_LOST_CLOSE_CODES.contains(close)) {
            return verdict("lost", format!("WS {}", num_text(close)), 0);
        }
        if LOST_BARE_MESSAGE.is_match(message) || LOST_PHRASE.is_match(message) {
            return verdict("lost", "", 0);
        }
        if UNREACHABLE_PHRASE.is_match(message) {
            return verdict("unreachable", "", 0);
        }
        if TIMEOUT_PHRASE.is_match(message) {
            return verdict("timeout", "", 0);
        }
        if FETCH_BARE_MESSAGE.is_match(message) {
            return verdict("unreachable", "", 0);
        }
    }
    None
}

/// Classifies a connection-level failure by walking the error and its `cause` chain; `None` when the failure is not a
/// transport problem.
pub fn classify_transport_error(error: Js) -> Option<TransportVerdict> {
    let text = error.and_then(Value::as_str);
    let chain = if text.is_some() { Vec::new() } else { cause_chain(error) };
    let messages: Vec<String> = match text {
        Some(text) => vec![js_trim(text).to_owned()],
        None => chain.iter().copied().map(|item| message_of(Some(item))).collect(),
    };
    if let Some(typed) = typed_transport_kind(&chain) {
        return Some(TransportVerdict { status: 0, ..typed });
    }
    status_transport_kind(&chain, &messages).or_else(|| message_transport_kind(&messages))
}

/// The user-facing sentence for a transport failure, `None` when it is not one.
pub fn transport_error_text(error: Js) -> Option<String> {
    let verdict = classify_transport_error(error)?;
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn text(value: Value) -> Option<String> {
        transport_error_text(Some(&value))
    }

    #[test]
    fn the_innermost_code_names_the_failure() {
        let error = json!({ "name": "TypeError", "message": "fetch failed", "cause": { "name": "SocketError", "code": "UND_ERR_SOCKET" } });
        assert_eq!(text(error).as_deref(), Some("Connection to the provider was lost (UND_ERR_SOCKET)."));
        assert_eq!(text(json!({ "code": "enotfound" })).as_deref(), Some("Could not reach the provider (ENOTFOUND)."));
        assert_eq!(text(json!({ "code": "CERT_HAS_EXPIRED" })).as_deref(), Some("Provider TLS certificate check failed (CERT_HAS_EXPIRED)."));
    }

    #[test]
    fn statuses_close_codes_and_bare_messages() {
        assert_eq!(text(json!({ "status": 503 })).as_deref(), Some("Provider is temporarily unavailable (503)."));
        assert_eq!(text(json!({ "message": "API 502 Bad Gateway" })).as_deref(), Some("Provider is temporarily unavailable (502)."));
        assert_eq!(text(json!({ "wsCloseCode": 1006 })).as_deref(), Some("Connection to the provider was lost."));
        assert_eq!(text(json!("fetch failed")).as_deref(), Some("Could not reach the provider."));
        assert_eq!(text(json!("terminated")).as_deref(), Some("Connection to the provider was lost."));
        assert_eq!(text(json!("shell job terminated by signal")), None);
        assert_eq!(text(json!({ "status": 500 })), None);
        assert_eq!(transport_error_text(None), None);
    }
}
