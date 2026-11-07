//! Antigravity image adapter (`antigravity-oauth` lane; `adapters/antigravity-image.mjs`).
//!
//! Nano Banana models behind the Cloud Code Assist gateway take the same Gemini
//! `generateContent` payload as the API-key lane, wrapped in the gateway envelope the chat
//! provider sends. Only the streaming route returns image parts: the unary route answers 200
//! with an empty candidate list. The image arrives as one inline part; the whole SSE body is read
//! before decoding. The stream is framed by the Gemini dialect's own line rule
//! ([`mixdog_ai::providers::google::decode::sse_data`]).

use std::time::Duration;

use async_trait::async_trait;
use mixdog_ai::providers::google::decode::sse_data;
use mixdog_js::value_to_string;
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use super::adapter_http::JsonPost;
use super::download::AdapterError;
use super::gemini_image::{gemini_image_request_body, pick_gemini_image_part};
use super::image_api::{GeneratedImage, ImageReference, truthy};
use super::upstream::upstream_error;
use super::usage::gemini_usage;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(180);

/// The Cloud Code Assist login: the bearer and the project (`resolveAntigravityAuth`).
#[derive(Debug, Clone)]
pub struct AntigravityAuth {
    pub token: String,
    pub project_id: String,
}

/// What the adapter takes from the chat provider's world (wp-ai): the token store, the client
/// identity header, the gateway address and the random ids of a request.
#[async_trait]
pub trait AntigravitySession: Send + Sync {
    async fn auth(&self) -> Result<AntigravityAuth, AdapterError>;
    /// `antigravityHeaders()`.
    fn headers(&self) -> Vec<(String, String)>;
    /// `CONTENT_ENDPOINTS[0]`.
    fn endpoint(&self) -> String;
    /// `randomUUID()`.
    fn uuid(&self) -> String;
}

/// What the stream held: candidate parts, a failure to report, the last cumulative usage.
#[derive(Debug, Clone, PartialEq)]
pub struct StreamParts {
    pub parts: Vec<Value>,
    pub failure: Option<String>,
    pub usage: Option<Value>,
}

/// Candidate parts across the stream; the gateway nests each chunk under `response`.
pub fn antigravity_image_parts(sse_text: &str) -> StreamParts {
    let mut parts = Vec::new();
    let mut failure: Option<String> = None;
    let mut usage_metadata = Value::Null;
    for line in sse_text.split('\n') {
        let Some(data) = sse_data(line) else { continue };
        // A record that does not parse is skipped without discarding its neighbours.
        let Ok(value) = mixdog_js::json_parse(data) else { continue };
        // In-band error events stay top level; content chunks are nested.
        if let Some(error) = value.get("error").filter(|e| truthy(Some(e))) {
            failure = Some(match error.get("message").filter(|m| truthy(Some(m))) {
                Some(message) => value_to_string(message),
                None => mixdog_js::json_stringify(error),
            });
        }
        let chunk = match value.get("response") {
            Some(nested) if truthy(Some(nested)) && (nested.is_object() || nested.is_array()) => nested,
            _ => &value,
        };
        if let Some(content) = chunk.get("candidates").and_then(|c| c.get(0)).and_then(|c| c.get("content")).and_then(|c| c.get("parts")).and_then(Value::as_array) {
            parts.extend(content.iter().cloned());
        }
        // usageMetadata is cumulative; the last chunk that carries it is the total.
        if let Some(meta) = chunk.get("usageMetadata").filter(|m| truthy(Some(m))) {
            usage_metadata = meta.clone();
        }
        let blocked = chunk.get("promptFeedback").and_then(|f| f.get("blockReason")).filter(|b| truthy(Some(b)));
        if let Some(reason) = blocked {
            if failure.as_deref().is_none_or(str::is_empty) {
                failure = Some(format!("prompt blocked ({})", value_to_string(reason)));
            }
        }
    }
    StreamParts { parts, failure, usage: gemini_usage(&usage_metadata) }
}

/// `generateImage({ model, prompt, options, references, signal })`.
pub async fn generate_image(http: &dyn JsonPost, session: &dyn AntigravitySession, model: &str, prompt: &str, options: &Value, references: &[ImageReference], cancel: &CancellationToken) -> Result<GeneratedImage, AdapterError> {
    let auth = session.auth().await?;
    let mut request = match gemini_image_request_body(prompt, options, references) {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    let request_id = format!("agent-{}", session.uuid());
    request.insert("sessionId".into(), json!(format!("-{}", session.uuid())));
    let body = json!({ "project": auth.project_id, "model": model, "userAgent": "antigravity", "requestType": "agent", "requestId": request_id, "request": Value::Object(request) });
    let mut headers = vec![
        ("Authorization".to_owned(), format!("Bearer {}", auth.token)),
        ("Content-Type".to_owned(), "application/json".to_owned()),
        ("Accept".to_owned(), "text/event-stream".to_owned()),
    ];
    headers.extend(session.headers());
    let url = format!("{}/v1internal:streamGenerateContent?alt=sse", session.endpoint());
    let reply = http.post(&url, &headers, &body, REQUEST_TIMEOUT, cancel).await.map_err(|failure| AdapterError::plain(failure.message))?;
    if !(200..300).contains(&reply.status) {
        return Err(upstream_error("Antigravity image", reply.status, &reply.body).into());
    }
    let StreamParts { parts, failure, usage } = antigravity_image_parts(&reply.body);
    pick_gemini_image_part(&parts, "Antigravity", failure, usage)
}