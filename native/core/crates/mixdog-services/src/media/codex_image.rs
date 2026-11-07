//! ChatGPT OAuth image adapter (`openai-oauth` lane; `adapters/codex-image.mjs`) and the usage
//! window lookup it uses (`chatgpt-usage.mjs`).
//!
//! Primary path: the subscription's Images endpoints on the Codex backend (`images/generations`,
//! or `images/edits` when reference images are given), a plain JSON request answered with the
//! finished image as base64. Fallback path, used only when those endpoints are not served
//! (404/405/501, or the edge's HTML 403 for an unknown route): the hosted `image_generation` tool
//! on the responses backend. Its final image arrives on the `image_generation_call` item; a
//! stream that only produced partial preview frames fails instead of saving a draft as the
//! result. Usage-limit failures name the reset time, looked up from the account's usage summary
//! when the failure itself omits it.

use std::time::Duration;

use async_trait::async_trait;
use mixdog_js::{js_trim, to_number_of, value_to_string};
use reqwest::Url;
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use super::adapter_http::{JsonPost, PostReply};
use super::download::AdapterError;
use super::image_api::{ImageReference, truthy};
use super::lanes::LaneError;
use super::upstream::{Headers, UsageLimit, decode_base64_media, upstream_error, usage_limit_error, usage_limit_from_response, usage_limit_info};
use super::usage::{reported_usage, responses_usage};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(400);
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(10);
const LABEL: &str = "ChatGPT image";
const CODEX_IMAGE_MODEL: &str = "gpt-image-2";
pub const CHATGPT_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";

/// The signed-in ChatGPT session (`OpenAIOAuthProvider.ensureAuth()`).
#[derive(Debug, Clone)]
pub struct CodexAuth {
    pub access_token: String,
    pub account_id: Option<String>,
}

/// What the adapter takes from the chat provider's world: the login, the client identity the
/// backend version-gates on, and the reset-time lookup. Implemented in the provider layer
/// (`resolveCodexAuth`, `codex-client-meta.mjs`); `lookup_reset` is [`chatgpt_limit_reset_at`].
#[async_trait]
pub trait CodexSession: Send + Sync {
    async fn auth(&self) -> Result<CodexAuth, AdapterError>;
    /// `warmCodexClientVersion()`: discovery and generation report the same client version.
    async fn warm_version(&self);
    fn user_agent(&self) -> String;
    fn version_header(&self) -> String;
    fn originator(&self) -> String;
    /// `CODEX_RESPONSES_URL`.
    fn responses_url(&self) -> String;
    /// `randomBytes(16).toString('hex')`.
    fn request_id(&self) -> String;
    async fn lookup_reset(&self, auth: &CodexAuth, limit_id: &str, cancel: &CancellationToken) -> Option<i64>;
}

/// What a generation returns.
#[derive(Debug, Clone, PartialEq)]
pub struct CodexImage {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
    pub revised_prompt: Option<String>,
    pub actual_model: Option<String>,
    pub usage: Option<Value>,
}

fn media(message: String, code: &'static str, status: u16) -> AdapterError {
    LaneError { message, code, status }.into()
}

fn plain(failure: super::catalog_fetch::HttpFailure) -> AdapterError {
    AdapterError::plain(failure.message)
}

fn header(reply: &PostReply, name: &str) -> Option<String> {
    reply.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.clone())
}

fn data_url(reference: &ImageReference) -> String {
    let mime = if reference.mime.is_empty() { "image/png" } else { reference.mime.as_str() };
    format!("data:{mime};base64,{}", reference.base64)
}

fn images_url(session: &dyn CodexSession, route: &str) -> String {
    Url::parse(&session.responses_url()).and_then(|base| base.join(route)).map(|url| url.to_string()).unwrap_or_default()
}

fn images_headers(session: &dyn CodexSession, auth: &CodexAuth) -> Vec<(String, String)> {
    let mut headers = vec![
        ("Authorization".to_owned(), format!("Bearer {}", auth.access_token)),
        ("Content-Type".to_owned(), "application/json".to_owned()),
        ("Accept".to_owned(), "application/json".to_owned()),
        ("originator".to_owned(), session.originator()),
        ("x-client-request-id".to_owned(), session.request_id()),
        ("version".to_owned(), session.version_header()),
        ("User-Agent".to_owned(), session.user_agent()),
    ];
    if let Some(account) = auth.account_id.as_ref().filter(|a| !a.is_empty()) {
        headers.push(("ChatGPT-Account-ID".to_owned(), account.clone()));
    }
    headers
}

fn responses_headers(session: &dyn CodexSession, auth: &CodexAuth) -> Vec<(String, String)> {
    vec![
        ("Authorization".to_owned(), format!("Bearer {}", auth.access_token)),
        ("Content-Type".to_owned(), "application/json".to_owned()),
        ("Accept".to_owned(), "text/event-stream".to_owned()),
        ("OpenAI-Beta".to_owned(), "responses=experimental".to_owned()),
        ("originator".to_owned(), session.originator()),
        ("chatgpt-account-id".to_owned(), auth.account_id.clone().unwrap_or_default()),
        ("x-client-request-id".to_owned(), session.request_id()),
        ("version".to_owned(), session.version_header()),
        ("User-Agent".to_owned(), session.user_agent()),
    ]
}

/// The endpoint is not served for this backend: a missing route or method, or the edge's HTML 403
/// page that unknown backend routes answer with. Auth, billing and limit failures come back as
/// JSON and are reported, not retried.
fn images_endpoint_unavailable(reply: &PostReply) -> bool {
    if [404, 405, 501].contains(&reply.status) {
        return true;
    }
    reply.status == 403 && !header(reply, "content-type").unwrap_or_default().to_lowercase().contains("json")
}

fn images_usage(usage: &Value) -> Option<Value> {
    let tokens = responses_usage(usage);
    let counted = to_number_of(usage.get("output_tokens_details").and_then(|d| d.get("image_tokens")));
    let image_tokens = if counted.is_nan() { 0.0 } else { counted.trunc() };
    if image_tokens > 0.0 {
        let mut out = tokens.and_then(|v| v.as_object().cloned()).unwrap_or_default();
        out.insert("outputImageTokens".into(), mixdog_js::json_number(image_tokens));
        return Some(Value::Object(out));
    }
    tokens
}

async fn limit_error(limit: &UsageLimit, session: &dyn CodexSession, auth: &CodexAuth, cancel: &CancellationToken) -> AdapterError {
    let resets_at = match limit.resets_at {
        Some(at) => Some(at),
        None => session.lookup_reset(auth, &limit.limit_id, cancel).await,
    };
    let (error, resets) = usage_limit_error(LABEL, &UsageLimit { limit_id: limit.limit_id.clone(), resets_at });
    let mut error: AdapterError = error.into();
    error.resets_at = resets;
    error
}

async fn failed_response(reply: &PostReply, session: &dyn CodexSession, auth: &CodexAuth, cancel: &CancellationToken) -> AdapterError {
    if let Some(limit) = usage_limit_from_response(reply.status, &reply.body, &Headers(&reply.headers)) {
        return limit_error(&limit, session, auth, cancel).await;
    }
    upstream_error(LABEL, reply.status, &reply.body).into()
}

fn with_usage(mut error: AdapterError, usage: Option<Value>) -> AdapterError {
    error.usage = reported_usage(usage);
    error
}

async fn via_images_endpoint(
    http: &dyn JsonPost,
    session: &dyn CodexSession,
    auth: &CodexAuth,
    prompt: &str,
    options: &Value,
    references: &[ImageReference],
    cancel: &CancellationToken,
) -> Result<Option<CodexImage>, AdapterError> {
    let mut body = Map::new();
    body.insert("prompt".into(), json!(prompt));
    body.insert("model".into(), json!(CODEX_IMAGE_MODEL));
    body.insert("size".into(), json!("auto"));
    body.insert("quality".into(), json!("auto"));
    if truthy(options.get("background")) {
        body.insert("background".into(), options["background"].clone());
    }
    let (url, body) = if references.is_empty() {
        (images_url(session, "images/generations"), body)
    } else {
        let mut edit = Map::new();
        edit.insert("images".into(), references.iter().map(|r| json!({ "image_url": data_url(r) })).collect());
        edit.extend(body);
        (images_url(session, "images/edits"), edit)
    };
    let reply = http.post(&url, &images_headers(session, auth), &Value::Object(body), REQUEST_TIMEOUT, cancel).await.map_err(plain)?;
    if images_endpoint_unavailable(&reply) {
        return Ok(None);
    }
    if !(200..300).contains(&reply.status) {
        return Err(failed_response(&reply, session, auth, cancel).await);
    }
    let json: Value = serde_json::from_str(&reply.body).unwrap_or(Value::Null);
    let usage = images_usage(json.get("usage").unwrap_or(&Value::Null));
    let b64 = json.get("data").and_then(|d| d.get(0)).and_then(|e| e.get("b64_json")).and_then(Value::as_str).filter(|s| !s.is_empty());
    let Some(b64) = b64 else {
        return Err(with_usage(media(format!("{LABEL}: returned no image data"), "MEDIA_EMPTY_RESULT", 502), usage));
    };
    let bytes = decode_base64_media(&Value::String(b64.to_owned()), LABEL)?;
    Ok(Some(CodexImage { bytes, mime: "image/png", revised_prompt: None, actual_model: Some(CODEX_IMAGE_MODEL.to_owned()), usage }))
}

#[derive(Default)]
struct StreamState {
    final_image: String,
    partial: String,
    revised_prompt: Option<String>,
    actual_model: Option<String>,
    usage: Option<Value>,
}

fn collect_image(event: &Value, state: &mut StreamState) {
    let kind = event.get("type").and_then(Value::as_str);
    let item = event.get("item");
    // Terminal Responses events carry the orchestrator's token usage. It does not include the
    // hosted image tool's own tokens.
    if matches!(kind, Some("response.completed" | "response.failed" | "response.incomplete")) {
        let usage = event.get("response").and_then(|r| r.get("usage")).and_then(responses_usage);
        state.usage = usage.or_else(|| state.usage.take());
        return;
    }
    if kind == Some("response.output_item.done") && item.and_then(|i| i.get("type")).and_then(Value::as_str) == Some("image_generation_call") {
        let item = item.unwrap();
        if let Some(result) = item.get("result").and_then(Value::as_str).filter(|r| !r.is_empty()) {
            state.final_image = result.to_owned();
        }
        if let Some(model) = item.get("model").and_then(Value::as_str) {
            state.actual_model = Some(model.to_owned());
        }
        if let Some(prompt) = item.get("revised_prompt").and_then(Value::as_str) {
            state.revised_prompt = Some(prompt.to_owned());
        }
        return;
    }
    if kind == Some("response.image_generation_call.partial_image") {
        if let Some(partial) = event.get("partial_image_b64").and_then(Value::as_str) {
            if partial.encode_utf16().count() > state.partial.encode_utf16().count() {
                state.partial = partial.to_owned();
            }
        }
    }
}

async fn via_responses(
    http: &dyn JsonPost,
    session: &dyn CodexSession,
    auth: &CodexAuth,
    model: &str,
    prompt: &str,
    options: &Value,
    references: &[ImageReference],
    cancel: &CancellationToken,
) -> Result<CodexImage, AdapterError> {
    // Reference images ride as input_image parts on the user turn: the same shape the chat path
    // uses for pasted images.
    let mut content: Vec<Value> = references.iter().map(|r| json!({ "type": "input_image", "image_url": data_url(r) })).collect();
    content.push(json!({ "type": "input_text", "text": prompt }));
    let mut tool = Map::new();
    tool.insert("type".into(), json!("image_generation"));
    if truthy(options.get("background")) && options["background"] != "auto" {
        tool.insert("background".into(), options["background"].clone());
    }
    let body = json!({
        "model": model,
        "stream": true,
        "store": false,
        "instructions": "You generate images with the image_generation tool. Call the tool once for the user request; do not ask follow-up questions.",
        "input": [{ "type": "message", "role": "user", "content": content }],
        "tools": [Value::Object(tool)],
        // Smaller mainline models may answer with text when left on auto even though they support
        // the hosted tool. Studio always requests an image.
        "tool_choice": { "type": "image_generation" },
    });
    let reply = http.post(&session.responses_url(), &responses_headers(session, auth), &body, REQUEST_TIMEOUT, cancel).await.map_err(plain)?;
    if !(200..300).contains(&reply.status) {
        return Err(failed_response(&reply, session, auth, cancel).await);
    }
    let mut state = StreamState::default();
    let mut failure: Option<Value> = None;
    let mut lines: Vec<&str> = reply.body.split('\n').collect();
    // What follows the last newline is a line still being received: it is never processed.
    lines.pop();
    for line in lines {
        let Some(rest) = line.strip_prefix("data:") else { continue };
        let raw = js_trim(rest);
        if raw.is_empty() || raw == "[DONE]" {
            continue;
        }
        let Ok(event) = serde_json::from_str::<Value>(raw) else { continue };
        if matches!(event.get("type").and_then(Value::as_str), Some("response.failed" | "error")) {
            // A top-level `error` event carries code/type/resets_at on itself.
            let nested = event.get("response").and_then(|r| r.get("error")).filter(|v| truthy(Some(v)));
            let direct = event.get("error").filter(|v| truthy(Some(v)));
            failure = Some(nested.or(direct).cloned().unwrap_or_else(|| event.clone()));
        }
        collect_image(&event, &mut state);
    }
    if state.final_image.is_empty() {
        if let Some(limit) = failure.as_ref().and_then(|f| usage_limit_info(f, &Headers(&reply.headers))) {
            return Err(with_usage(limit_error(&limit, session, auth, cancel).await, state.usage));
        }
        let reason = match &failure {
            Some(Value::String(text)) => text.clone(),
            Some(other) => other.get("message").filter(|m| truthy(Some(m))).map(value_to_string).unwrap_or_else(|| "stream failed".to_owned()),
            None => "stream failed".to_owned(),
        };
        // A partial frame is a low-fidelity preview of an unfinished render; it is never saved as
        // the result.
        let error = if state.partial.is_empty() {
            let suffix = if failure.is_some() { format!(": {reason}") } else { String::new() };
            media(format!("ChatGPT returned no image data{suffix}"), "MEDIA_EMPTY_RESULT", 502)
        } else {
            let suffix = if failure.is_some() { format!(" ({reason})") } else { String::new() };
            media(format!("{LABEL}: generation stopped after a partial preview; no final image was produced{suffix}"), "MEDIA_PARTIAL_ONLY", 502)
        };
        return Err(with_usage(error, state.usage));
    }
    let bytes = decode_base64_media(&Value::String(state.final_image.clone()), LABEL)?;
    Ok(CodexImage { bytes, mime: "image/png", revised_prompt: state.revised_prompt, actual_model: state.actual_model, usage: state.usage })
}

/// `generateImage({ model, prompt, options, references, signal })`.
pub async fn generate_image(http: &dyn JsonPost, session: &dyn CodexSession, model: &str, prompt: &str, options: &Value, references: &[ImageReference], cancel: &CancellationToken) -> Result<CodexImage, AdapterError> {
    let unsupported = |message: &str| AdapterError::from(LaneError { message: message.to_owned(), code: "MEDIA_OPTION_UNSUPPORTED", status: 400 });
    if ["size", "quality", "resolution", "aspectRatio"].iter().any(|key| truthy(options.get(*key)) && options[*key] != "auto") {
        return Err(unsupported("ChatGPT selects image output settings; explicit size and quality are not supported on this connection."));
    }
    if truthy(options.get("background")) && !matches!(options["background"].as_str(), Some("transparent" | "opaque" | "auto")) {
        return Err(unsupported("background must be transparent, opaque or auto."));
    }
    let auth = session.auth().await?;
    // Discovery and generation must report the same client version; otherwise a newly discovered
    // model can still be rejected by the Codex version gate.
    session.warm_version().await;
    if let Some(image) = via_images_endpoint(http, session, &auth, prompt, options, references, cancel).await? {
        return Ok(image);
    }
    via_responses(http, session, &auth, model, prompt, options, references, cancel).await
}

// ── chatgpt-usage.mjs ─────────────────────────────────────────────────────

fn exhausted_reset_at(rate_limit: &Value) -> Option<i64> {
    if !truthy(Some(rate_limit)) || !(rate_limit.is_object() || rate_limit.is_array()) {
        return None;
    }
    let windows: Vec<&Value> = ["primary_window", "secondary_window"].iter().filter_map(|key| rate_limit.get(*key)).filter(|w| to_number_of(w.get("reset_at")) > 0.0).collect();
    let full: Vec<&Value> = windows.iter().copied().filter(|w| to_number_of(w.get("used_percent")) >= 100.0).collect();
    let candidates = if !full.is_empty() {
        full
    } else if truthy(rate_limit.get("limit_reached")) {
        windows
    } else {
        Vec::new()
    };
    candidates.iter().map(|w| to_number_of(w.get("reset_at")).trunc() as i64).max()
}

/// Reset time (epoch seconds) of the exhausted limit in a usage summary. The limit named
/// `limit_id` wins; an image limit is next; the account's main window is last.
pub fn limit_reset_from_usage(payload: &Value, limit_id: &str) -> Option<i64> {
    let extra: &[Value] = payload.get("additional_rate_limits").and_then(Value::as_array).map_or(&[], Vec::as_slice);
    let id = limit_id.to_lowercase();
    let names = |entry: &Value| -> Vec<String> {
        ["metered_feature", "limit_name"].iter().map(|key| entry.get(*key).filter(|v| truthy(Some(v))).map(value_to_string).unwrap_or_default().to_lowercase()).collect()
    };
    let named = (!id.is_empty()).then(|| extra.iter().find(|entry| names(entry).contains(&id))).flatten().or_else(|| extra.iter().find(|entry| names(entry).iter().any(|n| n.contains("image"))));
    exhausted_reset_at(match named {
        Some(entry) => entry.get("rate_limit").unwrap_or(&Value::Null),
        None => payload.get("rate_limit").unwrap_or(&Value::Null),
    })
}

/// Looks the reset time up for the signed-in account. A failed lookup yields `None`: the caller
/// still reports the limit, just without a time.
pub async fn chatgpt_limit_reset_at(http: &dyn JsonPost, user_agent: &str, auth: &CodexAuth, limit_id: &str, cancel: &CancellationToken) -> Option<i64> {
    let mut headers = vec![("Authorization".to_owned(), format!("Bearer {}", auth.access_token)), ("User-Agent".to_owned(), user_agent.to_owned())];
    if let Some(account) = auth.account_id.as_ref().filter(|a| !a.is_empty()) {
        headers.push(("ChatGPT-Account-Id".to_owned(), account.clone()));
    }
    let reply = http.get(CHATGPT_USAGE_URL, &headers, LOOKUP_TIMEOUT, cancel).await.ok()?;
    if !(200..300).contains(&reply.status) {
        return None;
    }
    let payload: Value = serde_json::from_str(&reply.body).ok()?;
    limit_reset_from_usage(&payload, limit_id)
}
