//! Antigravity image adapter (`antigravity-oauth` lane; `adapters/antigravity-image.mjs`).
//!
//! Nano Banana models behind the Cloud Code Assist gateway take the same Gemini
//! `generateContent` payload as the API-key lane, wrapped in the gateway envelope the chat
//! provider sends. Only the streaming route returns image parts: the unary route answers 200
//! with an empty candidate list. The image arrives as one inline part; the whole SSE body is read
//! before decoding.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use mixdog_js::value_to_string;
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use super::adapter_http::JsonPost;
use super::download::AdapterError;
use super::gemini_image::{gemini_image_request_body, is_safety_finish_reason, pick_gemini_image_part_with_finish};
use super::image_api::{GeneratedImage, truthy};
use super::references::{References, Target};
use super::upstream::{Headers, upstream_error_with_headers};
use super::usage::{gemini_usage, reported_usage};

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

struct ParsedStream {
    parts: Vec<Value>,
    failure: Option<String>,
    finish_reason: Option<String>,
    block_reason: Option<String>,
    in_band_error: Option<Value>,
    usage: Option<Value>,
}

fn apply_sse_record(
    value: Value,
    parts: &mut Vec<Value>,
    failure: &mut Option<String>,
    finish_reason: &mut Option<String>,
    block_reason: &mut Option<String>,
    in_band_error: &mut Option<Value>,
    usage_metadata: &mut Value,
) {
    let root = match &value {
        Value::Array(items) => items.first().unwrap_or(&value),
        _ => &value,
    };
    // In-band error events stay top level; content chunks are nested.
    if let Some(error) = root.get("error").filter(|e| truthy(Some(e))) {
        *in_band_error = Some(error.clone());
        *failure = Some(match error.get("message").filter(|m| truthy(Some(m))) {
            Some(message) => value_to_string(message),
            None => mixdog_js::json_stringify(error),
        });
    }
    let chunk = match root.get("response") {
        Some(nested) if truthy(Some(nested)) && (nested.is_object() || nested.is_array()) => nested,
        _ => root,
    };
    if let Some(candidate) = chunk.get("candidates").and_then(|c| c.get(0)) {
        if let Some(content) = candidate.get("content").and_then(|c| c.get("parts")).and_then(Value::as_array) {
            parts.extend(content.iter().cloned());
        }
        if let Some(reason) =
            candidate.get("finishReason").or_else(|| candidate.get("finish_reason")).and_then(Value::as_str).map(mixdog_js::js_trim).filter(|r| !r.is_empty())
        {
            *finish_reason = Some(reason.to_owned());
        }
    }
    // usageMetadata is cumulative; the last chunk that carries it is the total.
    if let Some(meta) = chunk.get("usageMetadata").filter(|m| truthy(Some(m))) {
        *usage_metadata = meta.clone();
    }
    let blocked = chunk
        .get("promptFeedback")
        .or_else(|| chunk.get("prompt_feedback"))
        .and_then(|f| f.get("blockReason").or_else(|| f.get("block_reason")))
        .filter(|b| truthy(Some(b)))
        .map(value_to_string);
    if let Some(reason) = blocked {
        *block_reason = Some(reason.clone());
        if failure.as_deref().is_none_or(str::is_empty) {
            *failure = Some(format!("prompt blocked ({reason})"));
        }
    }
}

fn flush_sse_event(
    data_lines: &mut Vec<&str>,
    parts: &mut Vec<Value>,
    failure: &mut Option<String>,
    finish_reason: &mut Option<String>,
    block_reason: &mut Option<String>,
    in_band_error: &mut Option<Value>,
    usage_metadata: &mut Value,
) {
    if data_lines.is_empty() {
        return;
    }
    let joined = data_lines.join("\n");
    let trimmed = mixdog_js::js_trim(&joined);
    if !trimmed.is_empty() && trimmed != "[DONE]" {
        if let Ok(value) = mixdog_js::json_parse(trimmed) {
            apply_sse_record(value, parts, failure, finish_reason, block_reason, in_band_error, usage_metadata);
        } else if data_lines.len() > 1 {
            // Fall back to line-by-line parsing if consecutive single-line JSON events lacked blank separators.
            for raw_line in data_lines.iter() {
                let line = mixdog_js::js_trim(raw_line);
                if line.is_empty() || line == "[DONE]" {
                    continue;
                }
                if let Ok(value) = mixdog_js::json_parse(line) {
                    apply_sse_record(value, parts, failure, finish_reason, block_reason, in_band_error, usage_metadata);
                }
            }
        }
    }
    data_lines.clear();
}

fn parse_antigravity_stream(sse_text: &str) -> ParsedStream {
    let mut parts = Vec::new();
    let mut failure: Option<String> = None;
    let mut finish_reason: Option<String> = None;
    let mut block_reason: Option<String> = None;
    let mut in_band_error: Option<Value> = None;
    let mut usage_metadata = Value::Null;
    let mut data_lines: Vec<&str> = Vec::new();
    for raw_line in sse_text.split('\n') {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        if line.is_empty() {
            flush_sse_event(&mut data_lines, &mut parts, &mut failure, &mut finish_reason, &mut block_reason, &mut in_band_error, &mut usage_metadata);
            continue;
        }
        if let Some(rest) = line.strip_prefix("data:") {
            data_lines.push(rest.strip_prefix(' ').unwrap_or(rest));
        }
    }
    flush_sse_event(&mut data_lines, &mut parts, &mut failure, &mut finish_reason, &mut block_reason, &mut in_band_error, &mut usage_metadata);
    ParsedStream { parts, failure, finish_reason, block_reason, in_band_error, usage: gemini_usage(&usage_metadata) }
}

/// Candidate parts across the stream; the gateway nests each chunk under `response`.
pub fn antigravity_image_parts(sse_text: &str) -> StreamParts {
    let ParsedStream { parts, mut failure, finish_reason, usage, .. } = parse_antigravity_stream(sse_text);
    if failure.as_deref().is_none_or(str::is_empty)
        && let Some(reason) = finish_reason.as_deref().filter(|r| is_safety_finish_reason(r))
    {
        failure = Some(format!("blocked by safety ({reason})"));
    }
    StreamParts { parts, failure, usage }
}

fn grpc_code_to_http(code: u16) -> Option<u16> {
    match code {
        400..=599 => Some(code),
        3 | 9 | 11 => Some(400),
        4 => Some(504),
        5 => Some(404),
        6 | 10 => Some(409),
        7 => Some(403),
        8 => Some(429),
        12 => Some(501),
        2 | 13 | 15 => Some(500),
        14 => Some(503),
        16 => Some(401),
        _ => None,
    }
}

fn in_band_http_status(error: &Value) -> Option<u16> {
    if let Some(code) = error.get("code").and_then(Value::as_u64).and_then(|c| u16::try_from(c).ok())
        && let Some(http) = grpc_code_to_http(code)
    {
        return Some(http);
    }
    match error.get("status").and_then(Value::as_str).map(|s| mixdog_js::js_trim(s).to_ascii_uppercase()).as_deref() {
        Some("INVALID_ARGUMENT" | "FAILED_PRECONDITION" | "OUT_OF_RANGE") => return Some(400),
        Some("UNAUTHENTICATED") => return Some(401),
        Some("PERMISSION_DENIED") => return Some(403),
        Some("NOT_FOUND") => return Some(404),
        Some("ALREADY_EXISTS" | "ABORTED") => return Some(409),
        Some("RESOURCE_EXHAUSTED") => return Some(429),
        Some("INTERNAL" | "DATA_LOSS" | "UNKNOWN") => return Some(500),
        Some("UNIMPLEMENTED") => return Some(501),
        Some("UNAVAILABLE") => return Some(503),
        Some("DEADLINE_EXCEEDED") => return Some(504),
        _ => {}
    }
    if let Some(details) = error.get("details").or_else(|| error.get("errorDetails")).and_then(Value::as_array) {
        for entry in details {
            let reason = entry.get("reason").and_then(Value::as_str).map(|s| mixdog_js::js_trim(s).to_ascii_uppercase());
            match reason.as_deref() {
                Some("TOS_VIOLATION" | "VALIDATION_REQUIRED" | "BILLING_DISABLED" | "BILLING_NOT_ACTIVE" | "ACCOUNT_SUSPENDED") => return Some(403),
                Some("UNAUTHENTICATED") => return Some(401),
                Some("QUOTA_EXHAUSTED" | "RATE_LIMIT_EXCEEDED" | "INSUFFICIENT_G1_CREDITS_BALANCE") => return Some(429),
                Some("MODEL_CAPACITY_EXHAUSTED" | "MODEL_CAPACITY_EXCEEDED") => return Some(503),
                Some("INVALID_ARGUMENT") => return Some(400),
                Some("INTERNAL") => return Some(500),
                _ => {}
            }
        }
    }
    None
}

/// `generateImage({ model, prompt, options, references, signal })`.
#[allow(clippy::result_large_err, reason = "preserve the canonical media AdapterError payload and existing caller/error contract without API boxing")]
pub async fn generate_image(
    http: &dyn JsonPost,
    session: &dyn AntigravitySession,
    model: &str,
    prompt: &str,
    options: &Value,
    references: &References,
    cancel: &CancellationToken,
) -> Result<GeneratedImage, AdapterError> {
    let auth = session.auth().await?;
    let url = format!("{}/v1internal:streamGenerateContent?alt=sse", session.endpoint());
    let references = references.prepare(&Target { endpoint: &url, account: &auth.project_id, model, operation: "image-generation" }).await?;
    let request = gemini_image_request_body(prompt, options, &references);
    let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis());
    let request_id = format!("image_gen/{now_ms}/{}/12", session.uuid());
    let project_id = mixdog_js::js_trim(&auth.project_id);
    let mut envelope = Map::new();
    if !project_id.is_empty() {
        envelope.insert("project".to_owned(), Value::String(project_id.to_owned()));
    }
    envelope.insert("model".to_owned(), Value::String(model.to_owned()));
    envelope.insert("userAgent".to_owned(), Value::String("antigravity".to_owned()));
    envelope.insert("requestType".to_owned(), Value::String("image_gen".to_owned()));
    envelope.insert("requestId".to_owned(), Value::String(request_id));
    envelope.insert("request".to_owned(), request);
    let body = Value::Object(envelope);
    let mut headers = vec![
        ("Authorization".to_owned(), format!("Bearer {}", auth.token)),
        ("Content-Type".to_owned(), "application/json".to_owned()),
        ("Accept".to_owned(), "text/event-stream".to_owned()),
    ];
    headers.extend(session.headers());
    let reply = http.post(&url, &headers, &body, REQUEST_TIMEOUT, cancel).await.map_err(|failure| AdapterError::plain(failure.message))?;
    if !(200..300).contains(&reply.status) {
        return Err(upstream_error_with_headers("Antigravity image", reply.status, &Headers(&reply.headers), &reply.body));
    }
    let ParsedStream { parts, failure, finish_reason, block_reason, in_band_error, usage } = parse_antigravity_stream(&reply.body);
    let safety_reason =
        finish_reason.as_deref().filter(|r| is_safety_finish_reason(r)).or_else(|| block_reason.as_deref().filter(|r| is_safety_finish_reason(r)));
    match pick_gemini_image_part_with_finish(&parts, "Antigravity", failure, safety_reason, usage.clone()) {
        Ok(image) => Ok(image),
        Err(empty_err) => {
            if let Some(error_obj) = in_band_error
                && let Some(status) = in_band_http_status(&error_obj)
            {
                let wrapped = json!({ "error": error_obj }).to_string();
                let mut err = upstream_error_with_headers("Antigravity image", status, &Headers(&reply.headers), &wrapped);
                err.usage = reported_usage(usage).map(Box::new);
                return Err(err);
            }
            Err(empty_err)
        }
    }
}
