//! The `feedback` domain: `feedback/upload`, today's `submitFeedback` of the desktop's main
//! process (`apps/desktop/src/main/feedback-client.ts`). Only explicitly entered feedback
//! leaves the app; the caller cannot choose the recipient or URL. The input is checked as
//! `contract-feedback.ts` and `relay/lib/feedback-attachments.mjs` check it, then posted to
//! the relay's `/feedback`; the relay's 202 receipt is the result.

use std::sync::Arc;
use std::sync::OnceLock;
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_app_protocol::v2::params::FeedbackUploadParams;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_core_api::service::DomainService;
use regex::Regex;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use url::Url;

use super::support::OpScopes;
use super::support::decode;
use super::support::failed;
use super::support::js_trim;
use super::support::wrong_method;

const DOMAIN: &str = "feedback";
const ATTACHMENT_MAX_COUNT: usize = 3;
const ATTACHMENT_MAX_BYTES: usize = 2_097_152;
const ATTACHMENT_MAX_TOTAL_BYTES: usize = 6_291_456;
const ATTACHMENT_MAX_NAME_CHARS: usize = 100;
const MAX_BASE64_CHARS: usize = ATTACHMENT_MAX_BYTES.div_ceil(3) * 4;
const MESSAGE_MAX: usize = 8_000;
const REPLY_MAX: usize = 254;
const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const INVALID_FEEDBACK: &str = "Feedback is invalid.";
const INVALID_REPLY: &str = "Reply email is invalid.";
const INVALID_ATTACHMENTS: &str = "Feedback attachments are invalid.";

/// The relay base URL (`resolveRelayUrl`): `Ok(None)` when the relay is switched off,
/// `Err(message)` for a configured URL that is not allowed.
pub type RelayUrl = Arc<dyn Fn() -> Result<Option<String>, String> + Send + Sync>;

fn reply_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        let part = r#"[^\s\u{feff}@<>(),;:\\"]+"#;
        Regex::new(&format!("^{part}@{part}\\.{part}$")).expect("static pattern")
    })
}

fn uuid_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
            .expect("static pattern")
    })
}

/// JavaScript string length, in UTF-16 code units.
fn js_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn unsafe_name_char(c: char) -> bool {
    matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}' | '\u{2028}' | '\u{2029}')
        || matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
}

/// Strict canonical base64: alphabet, padding and zeroed trailing bits.
fn canonical_base64(data: &str) -> bool {
    let bytes = data.as_bytes();
    if bytes.is_empty() || !bytes.len().is_multiple_of(4) {
        return false;
    }
    let pad = bytes.iter().rev().take_while(|b| **b == b'=').count();
    if pad > 2 || !bytes[..bytes.len() - pad].iter().all(|b| ALPHABET.contains(b)) {
        return false;
    }
    if pad == 0 {
        return true;
    }
    let last = ALPHABET.iter().position(|a| *a == bytes[bytes.len() - pad - 1]).unwrap_or(0);
    last % if pad == 2 { 16 } else { 4 } == 0
}

fn has_signature(mime: &str, data: &str) -> bool {
    let Ok(head) = STANDARD.decode(&data.as_bytes()[..16.min(data.len())]) else { return false };
    match mime {
        "image/png" => head.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        "image/jpeg" => head.starts_with(&[0xff, 0xd8, 0xff]),
        _ => head.len() >= 12 && &head[..4] == b"RIFF" && &head[8..12] == b"WEBP",
    }
}

/// `normalizeFeedbackAttachments`: absent → none; anything invalid refuses; unknown fields drop.
fn normalize_attachments(value: Option<&Value>) -> Result<Vec<Value>, &'static str> {
    let Some(value) = value else { return Ok(Vec::new()) };
    let Value::Array(items) = value else { return Err(INVALID_ATTACHMENTS) };
    if items.len() > ATTACHMENT_MAX_COUNT {
        return Err(INVALID_ATTACHMENTS);
    }
    let mut total = 0usize;
    let mut result = Vec::new();
    for item in items {
        let Value::Object(item) = item else { return Err(INVALID_ATTACHMENTS) };
        let field = |key: &str| item.get(key).and_then(Value::as_str);
        let (Some(name), Some(mime), Some(data)) = (field("name"), field("mimeType"), field("data")) else {
            return Err(INVALID_ATTACHMENTS);
        };
        if !["image/png", "image/jpeg", "image/webp"].contains(&mime) {
            return Err(INVALID_ATTACHMENTS);
        }
        if name.is_empty()
            || js_len(name) > ATTACHMENT_MAX_NAME_CHARS
            || name != js_trim(name)
            || name.starts_with('.')
            || name.ends_with('.')
            || name.chars().any(unsafe_name_char)
        {
            return Err(INVALID_ATTACHMENTS);
        }
        if data.len() > MAX_BASE64_CHARS || !canonical_base64(data) {
            return Err(INVALID_ATTACHMENTS);
        }
        let padding = data.bytes().rev().take_while(|b| *b == b'=').count();
        let bytes = data.len() / 4 * 3 - padding;
        total += bytes;
        if !(12..=ATTACHMENT_MAX_BYTES).contains(&bytes) || total > ATTACHMENT_MAX_TOTAL_BYTES {
            return Err(INVALID_ATTACHMENTS);
        }
        if !has_signature(mime, data) {
            return Err(INVALID_ATTACHMENTS);
        }
        result.push(json!({ "name": name, "mimeType": mime, "data": data }));
    }
    Ok(result)
}

/// `normalizeDesktopFeedback`: the body that is posted, or the sentence of the refusal.
fn normalize(value: &Value) -> Result<Value, &'static str> {
    let Value::Object(input) = value else { return Err(INVALID_FEEDBACK) };
    let id = input.get("id").and_then(Value::as_str).filter(|id| uuid_pattern().is_match(id));
    let kind = input.get("kind").and_then(Value::as_str).filter(|k| ["bug", "suggestion", "other"].contains(k));
    let message = input.get("message").and_then(Value::as_str).map(js_trim);
    let (Some(id), Some(kind), Some(message)) = (id, kind, message) else { return Err(INVALID_FEEDBACK) };
    if message.is_empty() || js_len(message) > MESSAGE_MAX {
        return Err(INVALID_FEEDBACK);
    }
    let Some(reply_to) = input.get("replyTo").and_then(Value::as_str) else { return Err(INVALID_REPLY) };
    let reply_to = js_trim(reply_to);
    if reply_to.is_empty() || js_len(reply_to) > REPLY_MAX || !reply_pattern().is_match(reply_to) {
        return Err(INVALID_REPLY);
    }
    let attachments = normalize_attachments(input.get("attachments"))?;
    let mut body = Map::new();
    body.insert("id".into(), json!(id.to_lowercase()));
    body.insert("kind".into(), json!(kind));
    body.insert("message".into(), json!(message));
    body.insert("replyTo".into(), json!(reply_to));
    if !attachments.is_empty() {
        body.insert("attachments".into(), Value::Array(attachments));
    }
    Ok(Value::Object(body))
}

fn endpoint(relay: &str) -> Option<Url> {
    let mut url = Url::parse(relay).ok()?;
    url.set_scheme(if url.scheme() == "wss" { "https" } else { "http" }).ok()?;
    url.set_path("/feedback");
    url.set_query(None);
    url.set_fragment(None);
    Some(url)
}

pub struct FeedbackService {
    relay: RelayUrl,
    client: reqwest::Client,
    ops: OpScopes,
}

impl FeedbackService {
    pub fn new(relay: RelayUrl, ops: OpScopes) -> Arc<Self> {
        // `redirect: 'error'`: a redirect is a failure, never followed.
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("the HTTP client builds with static options");
        Arc::new(Self { relay, client, ops })
    }

    async fn post(&self, url: Url, body: &Value, with_attachments: bool) -> Result<Value, CoreError> {
        let id = body["id"].clone();
        let timeout = Duration::from_secs(if with_attachments { 60 } else { 15 });
        let sent = self
            .client
            .post(url)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .timeout(timeout)
            .body(body.to_string())
            .send()
            .await;
        let response = match sent {
            Ok(response) if !response.status().is_redirection() => response,
            _ => return Err(failed(DOMAIN, "SUBMIT_FAILED", "Unable to submit feedback. Please try again.")),
        };
        let status = response.status().as_u16();
        if status == 429 {
            return Err(failed(DOMAIN, "RATE_LIMITED", "Too many feedback requests. Please try again later."));
        }
        if status != 202 {
            return Err(failed(DOMAIN, "UNAVAILABLE", "Feedback service is unavailable. Please try again later."));
        }
        let receipt: Option<Value> = match response.bytes().await {
            Ok(bytes) => serde_json::from_slice(&bytes).ok(),
            Err(_) => None,
        };
        let accepted = receipt
            .as_ref()
            .is_some_and(|receipt| receipt["id"] == id && receipt["status"] == "accepted");
        if !accepted {
            return Err(failed(DOMAIN, "RECEIPT_INVALID", "Feedback receipt is invalid. Please try again."));
        }
        Ok(json!({ "id": id, "status": "accepted" }))
    }

    async fn upload(&self, req: &CoreRequest) -> Result<Reply, CoreError> {
        let params: FeedbackUploadParams = decode(req)?;
        let body = normalize(&params.input).map_err(|message| failed(DOMAIN, "INVALID_FEEDBACK", message))?;
        let relay = (self.relay)()
            .map_err(|message| failed(DOMAIN, "INVALID_RELAY_URL", message))?
            .ok_or_else(|| failed(DOMAIN, "UNAVAILABLE", "Feedback service is unavailable."))?;
        let url = endpoint(&relay).ok_or_else(|| failed(DOMAIN, "INVALID_RELAY_URL", "MIXDOG_RELAY_URL is invalid."))?;
        let with_attachments = body.get("attachments").is_some();
        let receipt = json!({ "id": body["id"], "status": "accepted" });
        let target = url.to_string();
        self.ops
            .run(
                req,
                Some(("feedback.submit", target)),
                || self.post(url, &body, with_attachments),
                || async { Ok(receipt) },
            )
            .await
    }
}

#[async_trait]
impl DomainService for FeedbackService {
    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        match req.method.as_str() {
            "feedback/upload" => self.upload(&req).await,
            other => Err(wrong_method(DOMAIN, other)),
        }
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}

#[cfg(test)]
mod tests;
