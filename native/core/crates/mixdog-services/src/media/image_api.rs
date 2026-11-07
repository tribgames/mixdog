//! Normalized Image API adapter for the `openrouter` and `nano-gpt` lanes
//! (`adapters/image-api.mjs`). Both gateways document the same contract: POST `{base}/images`
//! with `model`, `prompt`, the model's advertised enum parameters and `input_references`
//! (image_url parts; data URLs accepted), answering `data[].b64_json` (NanoGPT may answer a
//! signed `url` instead) plus `usage`.

use std::time::Duration;

use mixdog_js::{slice_utf16, value_to_string};
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use super::adapter_http::JsonPost;
use super::catalog_fetch::Auth;
use super::download::{AdapterError, Limits, PublicFetch, download_public_media};
use super::lanes::LaneError;
use super::upstream::{decode_base64_media, upstream_error};
use super::usage::{image_api_usage, reported_usage};

const IMAGE_TIMEOUT: Duration = Duration::from_secs(180);
/// Request field per Studio option; values come from the model's own enums.
const PARAMS: [(&str, &str); 4] = [("aspectRatio", "aspect_ratio"), ("resolution", "resolution"), ("quality", "quality"), ("background", "background")];

/// A reference image: base64 data (or a data URL) and its mime type.
pub struct ImageReference {
    pub base64: String,
    pub mime: String,
}

/// What a generation returns.
#[derive(Debug, Clone, PartialEq)]
pub struct GeneratedImage {
    pub bytes: Vec<u8>,
    pub mime: String,
    pub revised_prompt: Option<String>,
    pub usage: Option<Value>,
}

fn label_of(lane: &str) -> &'static str {
    match lane {
        "openrouter" => "OpenRouter image",
        "nano-gpt" => "NanoGPT image",
        _ => "Image API",
    }
}

pub(super) fn reference_url(reference: &ImageReference) -> String {
    if reference.base64.starts_with("data:") {
        return reference.base64.clone();
    }
    let mime = if reference.mime.is_empty() { "image/png" } else { reference.mime.as_str() };
    format!("data:{mime};base64,{}", reference.base64)
}

/// The stored format comes from the bytes, not a label: only rasters the store keeps.
pub fn raster_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() >= 8 && bytes[..4] == [0x89, 0x50, 0x4e, 0x47] {
        return Some("image/png");
    }
    if bytes.len() >= 3 && bytes[..3] == [0xff, 0xd8, 0xff] {
        return Some("image/jpeg");
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

pub(super) fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn media(message: String, code: &'static str, status: u16) -> AdapterError {
    LaneError { message, code, status }.into()
}

/// `generateImage({ lane, model, prompt, options, references, signal })`.
#[allow(clippy::too_many_arguments, reason = "the adapter's own parameters, one per field of Node's call")]
pub async fn generate_image(http: &dyn JsonPost, public: &dyn PublicFetch, auth: &Auth, lane: &str, model: &str, prompt: &str, options: &Value, references: &[ImageReference], cancel: &CancellationToken) -> Result<GeneratedImage, AdapterError> {
    let label = label_of(lane);
    let mut body = Map::new();
    body.insert("model".into(), json!(model));
    body.insert("prompt".into(), json!(prompt));
    body.insert("n".into(), json!(1));
    for (option, param) in PARAMS {
        let value = options.get(option);
        let text = if truthy(value) { value.map(value_to_string).unwrap_or_default() } else { String::new() };
        let text = mixdog_js::js_trim(&text);
        if !text.is_empty() {
            body.insert(param.into(), json!(text));
        }
    }
    if !references.is_empty() {
        body.insert("input_references".into(), references.iter().map(|r| json!({ "type": "image_url", "image_url": { "url": reference_url(r) } })).collect());
    }
    let headers = [("Content-Type".to_owned(), "application/json".to_owned()), ("Authorization".to_owned(), format!("Bearer {}", auth.token))];
    let url = format!("{}/images", auth.base_url);
    let reply = match http.post(&url, &headers, &Value::Object(body), IMAGE_TIMEOUT, cancel).await {
        Ok(reply) => reply,
        Err(failure) if failure.timed_out => return Err(media(format!("{label} timed out"), "MEDIA_TIMEOUT", 504)),
        Err(failure) => return Err(AdapterError::plain(failure.message)),
    };
    if !(200..300).contains(&reply.status) {
        return Err(upstream_error(label, reply.status, &slice_utf16(&reply.body, 400)).into());
    }
    let data = serde_json::from_str::<Value>(&reply.body).unwrap_or(Value::Null);
    let usage = image_api_usage(&data);
    let with_usage = |mut error: AdapterError| {
        error.usage = reported_usage(usage.clone());
        error
    };
    let entry = data.get("data").and_then(Value::as_array).and_then(|list| list.first()).cloned().unwrap_or(Value::Null);
    let bytes = if truthy(entry.get("b64_json")) {
        decode_base64_media(&entry["b64_json"], label).map_err(|e| with_usage(e.into()))?
    } else if truthy(entry.get("url")) {
        download_public_media(public, &value_to_string(&entry["url"]), &Limits { label, ..Limits::default() }, cancel).await.map_err(with_usage)?
    } else {
        return Err(with_usage(media(format!("{label} returned no image data"), "MEDIA_EMPTY_RESULT", 502)));
    };
    let Some(mime) = raster_mime(&bytes) else {
        return Err(with_usage(media(format!("{label} returned an unsupported image format"), "MEDIA_UPSTREAM_FAILED", 502)));
    };
    let revised_prompt = entry.get("revised_prompt").filter(|v| truthy(Some(v))).map(value_to_string);
    Ok(GeneratedImage { bytes, mime: mime.to_owned(), revised_prompt, usage })
}
