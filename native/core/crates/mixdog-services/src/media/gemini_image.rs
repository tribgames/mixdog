//! Gemini image adapter, API-key lane (`adapters/gemini-image.mjs`): the Generative Language
//! `generateContent` route, the final non-thought inline image part of the candidate. Explicit
//! output modalities prevent image-capable models from ending with text only. A requested output
//! setting is never silently discarded and a paid request is never retried.

use std::time::Duration;

use mixdog_js::{slice_utf16, value_to_string};
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use super::adapter_http::JsonPost;
use super::download::{AdapterError, parse_json_body};
use super::image_api::{GeneratedImage, truthy};
use super::lanes::LaneError;
use super::references::{ImageReference, References, Target, key_account};
use super::upstream::{Headers, decode_base64_media, upstream_error_with_headers};
use super::usage::{gemini_usage, reported_usage};

const BASE_URL: &str = "https://generativelanguage.googleapis.com/v1beta/models";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(180);

const SAFETY_FINISH_REASONS: [&str; 8] =
    ["IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION", "SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION"];

pub(super) fn is_safety_finish_reason(reason: &str) -> bool {
    let trimmed = mixdog_js::js_trim(reason);
    let normalized = if trimmed.get(.."FINISH_REASON_".len()).is_some_and(|p| p.eq_ignore_ascii_case("FINISH_REASON_")) {
        &trimmed["FINISH_REASON_".len()..]
    } else if trimmed.get(.."BLOCK_REASON_".len()).is_some_and(|p| p.eq_ignore_ascii_case("BLOCK_REASON_")) {
        &trimmed["BLOCK_REASON_".len()..]
    } else {
        trimmed
    };
    SAFETY_FINISH_REASONS.iter().any(|candidate| candidate.eq_ignore_ascii_case(normalized))
}

fn is_thought_part(part: &Value) -> bool {
    part.get("thought").and_then(Value::as_bool) == Some(true)
}

fn inline_data_of(part: &Value) -> Option<&Value> {
    part.get("inlineData").or_else(|| part.get("inline_data")).filter(|v| v.is_object())
}

fn inline_mime_of(inline: &Value) -> String {
    inline.get("mimeType").or_else(|| inline.get("mime_type")).filter(|v| truthy(Some(v))).map(value_to_string).unwrap_or_else(|| "image/png".to_owned())
}

fn non_thought_text(parts: &[Value]) -> Option<String> {
    let mut joined = String::new();
    for part in parts {
        if is_thought_part(part) {
            continue;
        }
        if let Some(text) = part.get("text").and_then(Value::as_str) {
            joined.push_str(text);
        }
    }
    let trimmed = mixdog_js::js_trim(&joined);
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

/// `encodeURIComponent`: everything but letters, digits and `-_.!~*'()`.
pub(super) fn encode_uri_component(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// `geminiImageRequestBody(prompt, options, references)`.
pub fn gemini_image_request_body(prompt: &str, options: &Value, references: &[ImageReference]) -> Value {
    let mut parts: Vec<Value> = references.iter().map(|r| json!({ "inlineData": { "mimeType": r.mime(), "data": r.base64() } })).collect();
    parts.push(json!({ "text": prompt }));
    let mut config = Map::new();
    config.insert("responseModalities".into(), json!(["TEXT", "IMAGE"]));
    let aspect = options.get("aspectRatio");
    let aspect = if truthy(aspect) { aspect.map(value_to_string).unwrap_or_default() } else { "auto".to_owned() };
    if aspect != "auto" {
        config.insert("imageConfig".into(), json!({ "aspectRatio": aspect }));
    }
    json!({ "generationConfig": Value::Object(config), "contents": [{ "role": "user", "parts": parts }] })
}

/// Last non-thought inline image among a candidate's parts, with non-thought text kept as
/// `revised_prompt`. A safety finish reason or text-only refusal surfaces as such and is never
/// retried.
#[allow(clippy::result_large_err, reason = "preserve the canonical media AdapterError payload and existing caller/error contract without API boxing")]
pub(super) fn pick_gemini_image_part_with_finish(
    parts: &[Value],
    label: &str,
    failure: Option<String>,
    finish_reason: Option<&str>,
    usage: Option<Value>,
) -> Result<GeneratedImage, AdapterError> {
    let inline = parts.iter().rev().find_map(|part| (!is_thought_part(part)).then(|| inline_data_of(part)).flatten().filter(|d| truthy(d.get("data"))));
    let Some(inline) = inline else {
        let non_thought = non_thought_text(parts);
        if let Some(reason) = finish_reason.map(mixdog_js::js_trim).filter(|r| is_safety_finish_reason(r)) {
            let suffix = non_thought.map_or_else(String::new, |text| format!(": {}", slice_utf16(&text, 200)));
            let mut error: AdapterError = LaneError {
                message: format!("{label}: image generation blocked by safety filter ({reason}){suffix}"),
                code: "MEDIA_SAFETY_BLOCKED",
                status: 422,
            }
            .into();
            error.usage = reported_usage(usage).map(Box::new);
            return Err(error);
        }
        let refusal = failure.filter(|f| !f.is_empty()).or(non_thought).unwrap_or_default();
        let suffix = if refusal.is_empty() { String::new() } else { format!(": {}", slice_utf16(&refusal, 200)) };
        let mut error: AdapterError = LaneError { message: format!("{label} returned no image data{suffix}"), code: "MEDIA_EMPTY_RESULT", status: 502 }.into();
        error.usage = reported_usage(usage).map(Box::new);
        return Err(error);
    };
    let bytes = decode_base64_media(&inline["data"], &format!("{label} image"))?;
    let mime = inline_mime_of(inline);
    let revised_prompt = non_thought_text(parts);
    // Without reported tokens the one image is priced per image, if the catalog lists it.
    Ok(GeneratedImage { bytes, mime, revised_prompt, usage: Some(usage.unwrap_or_else(|| json!({ "images": 1 }))) })
}

/// Last non-thought inline image among a candidate's parts.
#[allow(clippy::result_large_err, reason = "preserve the canonical media AdapterError payload and existing caller/error contract without API boxing")]
pub fn pick_gemini_image_part(parts: &[Value], label: &str, failure: Option<String>, usage: Option<Value>) -> Result<GeneratedImage, AdapterError> {
    pick_gemini_image_part_with_finish(parts, label, failure, None, usage)
}

/// `generateImage({ model, prompt, options, references, signal })`; `key` is the Gemini API key.
#[allow(clippy::result_large_err, reason = "preserve the canonical media AdapterError payload and existing caller/error contract without API boxing")]
pub async fn generate_image(
    http: &dyn JsonPost,
    key: &str,
    model: &str,
    prompt: &str,
    options: &Value,
    references: &References,
    cancel: &CancellationToken,
) -> Result<GeneratedImage, AdapterError> {
    let url = format!("{BASE_URL}/{}:generateContent", encode_uri_component(model));
    let account = key_account(key);
    let references = references.prepare(&Target { endpoint: &url, account: &account, model, operation: "image-generation" }).await?;
    let headers = [("Content-Type".to_owned(), "application/json".to_owned()), ("x-goog-api-key".to_owned(), key.to_owned())];
    let body = gemini_image_request_body(prompt, options, &references);
    let reply = http.post(&url, &headers, &body, REQUEST_TIMEOUT, cancel).await.map_err(|failure| AdapterError::plain(failure.message))?;
    if !(200..300).contains(&reply.status) {
        return Err(upstream_error_with_headers("Gemini image", reply.status, &Headers(&reply.headers), &reply.body));
    }
    let data = parse_json_body(&reply.body)?;
    let candidate = data.get("candidates").and_then(|c| c.get(0));
    let parts = candidate.and_then(|c| c.get("content")).and_then(|c| c.get("parts")).and_then(Value::as_array).cloned().unwrap_or_default();
    let finish_reason = candidate.and_then(|c| c.get("finishReason").or_else(|| c.get("finish_reason"))).and_then(Value::as_str);
    let block_reason = data
        .get("promptFeedback")
        .or_else(|| data.get("prompt_feedback"))
        .and_then(|f| f.get("blockReason").or_else(|| f.get("block_reason")))
        .filter(|b| truthy(Some(b)))
        .map(value_to_string);
    let blocked = block_reason.as_deref().map(|reason| format!("prompt blocked ({reason})"));
    let safety_reason = finish_reason.filter(|r| is_safety_finish_reason(r)).or_else(|| block_reason.as_deref().filter(|r| is_safety_finish_reason(r)));
    pick_gemini_image_part_with_finish(&parts, "Gemini", blocked, safety_reason, gemini_usage(data.get("usageMetadata").unwrap_or(&Value::Null)))
}
