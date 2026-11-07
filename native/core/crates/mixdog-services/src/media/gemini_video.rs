//! Gemini video adapter, API-key lane (`adapters/gemini-video.mjs`). Two upstream shapes live
//! behind one lane: Omni Flash answers on the Interactions API in a single call, with the mp4
//! inline as base64 on a `model_output` step; Veo 3.1 is a long-running predict: submit, poll the
//! operation, then pull the sample URI with `alt=media`.

use std::time::Duration;

use mixdog_js::value_to_string;
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use super::adapter_http::JsonPost;
use super::download::{AdapterError, Limits, PublicFetch, download_gemini_media, parse_json_body};
use super::gemini_image::encode_uri_component;
use super::image_api::{ImageReference, truthy};
use super::lanes::LaneError;
use super::upstream::{decode_base64_media, upstream_error};
use super::usage::{interactions_usage, reported_usage};
use super::xai::Pacer;

const VEO_DEFAULT_SECONDS: i64 = 8;
const BASE_URL: &str = "https://generativelanguage.googleapis.com/v1beta";
const OMNI_TIMEOUT: Duration = Duration::from_secs(600);
const POLL_INTERVAL_MS: u64 = 8_000;
const TOTAL_TIMEOUT_MS: i64 = 900_000;
/// Submission and each poll need their own ceiling: an unbounded request keeps the 15-minute
/// budget from ever starting (or ever ending).
const REQUEST_TIMEOUT_MS: i64 = 60_000;

/// What a generation returns.
#[derive(Debug, Clone, PartialEq)]
pub struct GeminiVideo {
    pub bytes: Vec<u8>,
    pub mime: String,
    pub usage: Option<Value>,
}

fn media(message: String, code: &'static str, status: u16) -> AdapterError {
    LaneError { message, code, status }.into()
}

fn plain(failure: super::catalog_fetch::HttpFailure) -> AdapterError {
    AdapterError::plain(failure.message)
}

fn is_ok(status: u16) -> bool {
    (200..300).contains(&status)
}

fn aspect_for(options: &Value) -> String {
    let aspect = options.get("aspectRatio");
    let aspect = if truthy(aspect) { aspect.map(value_to_string).unwrap_or_default() } else { "auto".to_owned() };
    if aspect == "auto" { "16:9".to_owned() } else { aspect }
}

fn key_headers(key: &str) -> Vec<(String, String)> {
    vec![("Content-Type".to_owned(), "application/json".to_owned()), ("x-goog-api-key".to_owned(), key.to_owned())]
}

async fn via_omni(http: &dyn JsonPost, key: &str, model: &str, prompt: &str, options: &Value, references: &[ImageReference], cancel: &CancellationToken) -> Result<GeminiVideo, AdapterError> {
    // Omni takes a multimodal input array; a reference image switches the task from
    // text-to-video to image-to-video.
    let input = if references.is_empty() {
        json!(prompt)
    } else {
        let mut parts: Vec<Value> = references.iter().map(|r| json!({ "type": "image", "data": r.base64, "mime_type": if r.mime.is_empty() { "image/png" } else { r.mime.as_str() } })).collect();
        parts.push(json!({ "type": "text", "text": prompt }));
        Value::Array(parts)
    };
    let body = json!({
        "model": model,
        "input": input,
        "response_format": { "type": "video", "aspect_ratio": aspect_for(options) },
        "generation_config": { "video_config": { "task": if references.is_empty() { "text_to_video" } else { "image_to_video" } } },
    });
    let reply = http.post(&format!("{BASE_URL}/interactions"), &key_headers(key), &body, OMNI_TIMEOUT, cancel).await.map_err(plain)?;
    if !is_ok(reply.status) {
        return Err(upstream_error("Gemini Omni video", reply.status, &reply.body).into());
    }
    let data = parse_json_body(&reply.body)?;
    let usage = interactions_usage(data.get("usage").unwrap_or(&Value::Null));
    let steps: &[Value] = data.get("steps").and_then(Value::as_array).map_or(&[], Vec::as_slice);
    for step in steps {
        let content: Vec<&Value> = match step.get("content") {
            Some(Value::Array(items)) => items.iter().collect(),
            Some(single) if truthy(Some(single)) => vec![single],
            _ => Vec::new(),
        };
        let video = content.into_iter().find(|item| item.get("type").and_then(Value::as_str) == Some("video") && item.get("data").is_some_and(Value::is_string));
        if let Some(video) = video {
            let bytes = decode_base64_media(&video["data"], "Gemini Omni video")?;
            let mime = if truthy(video.get("mime_type")) { value_to_string(&video["mime_type"]) } else { "video/mp4".to_owned() };
            return Ok(GeminiVideo { bytes, mime, usage });
        }
    }
    let mut error = media("Gemini Omni returned no video data".to_owned(), "MEDIA_EMPTY_RESULT", 502);
    error.usage = reported_usage(usage);
    Err(error)
}

#[allow(clippy::too_many_arguments, reason = "the adapter's own parameters, one per field of Node's call")]
async fn via_veo(
    http: &dyn JsonPost,
    public: &dyn PublicFetch,
    pacer: &dyn Pacer,
    key: &str,
    model: &str,
    prompt: &str,
    options: &Value,
    references: &[ImageReference],
    cancel: &CancellationToken,
    on_progress: &(dyn Fn(f64) + Send + Sync),
) -> Result<GeminiVideo, AdapterError> {
    let headers = key_headers(key);
    let mut parameters = Map::new();
    parameters.insert("aspectRatio".into(), json!(aspect_for(options)));
    let mut instance = Map::new();
    instance.insert("prompt".into(), json!(prompt));
    // Veo accepts a single seed image for image-to-video.
    if let Some(seed) = references.first() {
        instance.insert("image".into(), json!({ "bytesBase64Encoded": seed.base64, "mimeType": if seed.mime.is_empty() { "image/png" } else { seed.mime.as_str() } }));
    }
    let resolution = if truthy(options.get("resolution")) { options.get("resolution").map(value_to_string).unwrap_or_default() } else { String::new() };
    if resolution == "720p" || resolution == "1080p" {
        parameters.insert("resolution".into(), json!(resolution));
    }
    // Veo takes discrete clip lengths; anything else is rejected upstream, so an out-of-contract
    // value is dropped rather than forwarded.
    let wanted = mixdog_js::to_number_of(options.get("duration"));
    let duration = if wanted.is_nan() { 0 } else { wanted.trunc() as i64 };
    if [4, 6, 8].contains(&duration) {
        parameters.insert("durationSeconds".into(), json!(duration));
    }

    // The budget starts at submission, not after it: a hung predictLongRunning POST would
    // otherwise run without any ceiling of its own.
    let deadline = pacer.now() + TOTAL_TIMEOUT_MS;
    let bounded = || Duration::from_millis((deadline - pacer.now()).clamp(1, REQUEST_TIMEOUT_MS) as u64);
    let body = json!({ "instances": [Value::Object(instance)], "parameters": Value::Object(parameters.clone()) });
    let started = http.post(&format!("{BASE_URL}/models/{}:predictLongRunning", encode_uri_component(model)), &headers, &body, bounded(), cancel).await.map_err(plain)?;
    if !is_ok(started.status) {
        return Err(upstream_error("Veo video", started.status, &started.body).into());
    }
    let operation = parse_json_body(&started.body)?;
    let Some(name) = operation.get("name").filter(|n| truthy(Some(n))).map(value_to_string) else {
        return Err(media("Veo returned no operation name".to_owned(), "MEDIA_UPSTREAM_FAILED", 502));
    };

    loop {
        if cancel.is_cancelled() {
            return Err(media("canceled".to_owned(), "MEDIA_CANCELED", 499));
        }
        if pacer.now() > deadline {
            return Err(media("Veo poll budget exceeded".to_owned(), "MEDIA_TIMEOUT", 504));
        }
        pacer.sleep(POLL_INTERVAL_MS).await;
        let poll = http.get(&format!("{BASE_URL}/{name}"), &headers, bounded(), cancel).await.map_err(plain)?;
        if !is_ok(poll.status) {
            return Err(upstream_error("Veo poll", poll.status, &poll.body).into());
        }
        let data = parse_json_body(&poll.body)?;
        if !truthy(data.get("done")) {
            // The operation exposes no percentage; keep the UI moving with a coarse heartbeat
            // instead of a fake number.
            on_progress(50.0);
            continue;
        }
        if let Some(error) = data.get("error").filter(|e| truthy(Some(e))) {
            let message = error.get("message").filter(|m| truthy(Some(m))).map_or_else(|| "unknown error".to_owned(), value_to_string);
            return Err(media(format!("Veo generation failed: {message}"), "MEDIA_UPSTREAM_FAILED", 502));
        }
        let response = data.get("response");
        let sample = [response.and_then(|r| r.get("generateVideoResponse")).and_then(|g| g.get("generatedSamples")).and_then(|s| s.get(0)), response.and_then(|r| r.get("generatedVideos")).and_then(|s| s.get(0))].into_iter().find(|s| truthy(*s)).flatten();
        let video = sample.and_then(|s| s.get("video"));
        let uri = [video.and_then(|v| v.get("uri")), video.and_then(|v| v.get("fileUri"))].into_iter().find(|u| truthy(*u)).flatten();
        let Some(uri) = uri else {
            return Err(media("Veo finished without a video URI".to_owned(), "MEDIA_EMPTY_RESULT", 502));
        };
        // Veo reports no usage; it bills per generated second. The response does not echo the
        // length, so the requested one (default 8s) is the billed one. A failed download still
        // leaves the generated seconds billed.
        let seconds = parameters.get("durationSeconds").and_then(Value::as_i64).unwrap_or(VEO_DEFAULT_SECONDS);
        let usage = json!({ "seconds": seconds, "resolution": parameters.get("resolution").cloned().unwrap_or_else(|| json!("720p")) });
        let limits = Limits { label: "Veo video", ..Limits::default() };
        return match download_gemini_media(public, &value_to_string(uri), key, &limits, cancel).await {
            Ok(bytes) => Ok(GeminiVideo { bytes, mime: "video/mp4".to_owned(), usage: Some(usage) }),
            Err(mut error) => {
                error.usage = reported_usage(Some(usage));
                Err(error)
            }
        };
    }
}

/// `generateVideo({ model, prompt, options, references, signal, onProgress })`; `key` is the
/// Gemini API key.
#[allow(clippy::too_many_arguments, reason = "the adapter's own parameters, one per field of Node's call")]
pub async fn generate_video(
    http: &dyn JsonPost,
    public: &dyn PublicFetch,
    pacer: &dyn Pacer,
    key: &str,
    model: &str,
    prompt: &str,
    options: &Value,
    references: &[ImageReference],
    cancel: &CancellationToken,
    on_progress: &(dyn Fn(f64) + Send + Sync),
) -> Result<GeminiVideo, AdapterError> {
    if model.to_lowercase().contains("omni") {
        via_omni(http, key, model, prompt, options, references, cancel).await
    } else {
        via_veo(http, public, pacer, key, model, prompt, options, references, cancel, on_progress).await
    }
}