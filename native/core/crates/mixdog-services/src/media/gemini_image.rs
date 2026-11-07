//! Gemini image adapter, API-key lane (`adapters/gemini-image.mjs`): the Generative Language
//! `generateContent` route, the first inline image part of the candidate. Explicit output
//! modalities prevent image-capable models from ending with text only. A requested output setting
//! is never silently discarded and a paid request is never retried.

use std::time::Duration;

use mixdog_js::{slice_utf16, value_to_string};
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use super::adapter_http::JsonPost;
use super::download::{AdapterError, parse_json_body};
use super::image_api::{GeneratedImage, ImageReference, truthy};
use super::lanes::LaneError;
use super::upstream::{decode_base64_media, upstream_error};
use super::usage::{gemini_usage, reported_usage};

const BASE_URL: &str = "https://generativelanguage.googleapis.com/v1beta/models";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(180);

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
    let mut parts: Vec<Value> = references
        .iter()
        .map(|r| json!({ "inlineData": { "mimeType": if r.mime.is_empty() { "image/png" } else { r.mime.as_str() }, "data": r.base64 } }))
        .collect();
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

/// First inline image among a candidate's parts. A text-only answer is the model's refusal and
/// surfaces as such; it is never retried.
pub fn pick_gemini_image_part(parts: &[Value], label: &str, failure: Option<String>, usage: Option<Value>) -> Result<GeneratedImage, AdapterError> {
    let image = parts.iter().find(|part| truthy(part.get("inlineData").and_then(|d| d.get("data"))));
    let Some(image) = image else {
        let refusal = failure.filter(|f| !f.is_empty()).or_else(|| parts.iter().filter_map(|p| p.get("text").and_then(Value::as_str)).find(|t| !mixdog_js::js_trim(t).is_empty()).map(str::to_owned)).unwrap_or_default();
        let suffix = if refusal.is_empty() { String::new() } else { format!(": {}", slice_utf16(&refusal, 200)) };
        let mut error: AdapterError = LaneError { message: format!("{label} returned no image data{suffix}"), code: "MEDIA_EMPTY_RESULT", status: 502 }.into();
        error.usage = reported_usage(usage);
        return Err(error);
    };
    let inline = &image["inlineData"];
    let bytes = decode_base64_media(&inline["data"], &format!("{label} image"))?;
    let mime = if truthy(inline.get("mimeType")) { value_to_string(&inline["mimeType"]) } else { "image/png".to_owned() };
    // Without reported tokens the one image is priced per image, if the catalog lists it.
    Ok(GeneratedImage { bytes, mime, revised_prompt: None, usage: Some(usage.unwrap_or_else(|| json!({ "images": 1 }))) })
}

/// `generateImage({ model, prompt, options, references, signal })`; `key` is the Gemini API key.
pub async fn generate_image(http: &dyn JsonPost, key: &str, model: &str, prompt: &str, options: &Value, references: &[ImageReference], cancel: &CancellationToken) -> Result<GeneratedImage, AdapterError> {
    let url = format!("{BASE_URL}/{}:generateContent", encode_uri_component(model));
    let headers = [("Content-Type".to_owned(), "application/json".to_owned()), ("x-goog-api-key".to_owned(), key.to_owned())];
    let body = gemini_image_request_body(prompt, options, references);
    let reply = http.post(&url, &headers, &body, REQUEST_TIMEOUT, cancel).await.map_err(|failure| AdapterError::plain(failure.message))?;
    if !(200..300).contains(&reply.status) {
        return Err(upstream_error("Gemini image", reply.status, &reply.body).into());
    }
    let data = parse_json_body(&reply.body)?;
    let parts = data.get("candidates").and_then(|c| c.get(0)).and_then(|c| c.get("content")).and_then(|c| c.get("parts")).and_then(Value::as_array).cloned().unwrap_or_default();
    pick_gemini_image_part(&parts, "Gemini", None, gemini_usage(data.get("usageMetadata").unwrap_or(&Value::Null)))
}