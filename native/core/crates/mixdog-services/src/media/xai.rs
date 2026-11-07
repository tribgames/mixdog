//! xAI Imagine adapter (images + video) for the `xai` and `grok-oauth` lanes
//! (`adapters/xai-media.mjs`). Both lanes speak the same api.x.ai contract; only the bearer
//! differs. Video is a submit + poll job: POST `/videos/generations` returns a request id and the
//! poll route answers 202 while pending, 200 with a signed URL when done.

use std::time::Duration;

use async_trait::async_trait;
use mixdog_js::{json_number, slice_utf16, to_number_of, value_to_string};
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use super::adapter_http::{JsonPost, PostReply};
use super::catalog_fetch::Auth;
use super::download::{AdapterError, Limits, PublicFetch, download_public_media, parse_json_body};
use super::image_api::{GeneratedImage, ImageReference, reference_url, truthy};
use super::lanes::LaneError;
use super::upstream::{decode_base64_media, upstream_error};
use super::usage::{reported_usage, xai_usage};

const POLL_INTERVAL_MS: u64 = 4_000;
const START_TIMEOUT: Duration = Duration::from_secs(60);
const TOTAL_TIMEOUT_MS: i64 = 900_000;
const IMAGE_TIMEOUT: Duration = Duration::from_secs(180);
/// Each poll needs its own ceiling: one hung request would otherwise keep the loop from ever
/// reaching its deadline check.
const POLL_REQUEST_TIMEOUT_MS: i64 = 60_000;

/// Time for the poll loop: the clock and the wait between polls.
#[async_trait]
pub trait Pacer: Send + Sync {
    fn now(&self) -> i64;
    async fn sleep(&self, ms: u64);
}

/// What a finished video is.
#[derive(Debug, Clone, PartialEq)]
pub struct GeneratedVideo {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
    pub duration_seconds: Value,
    pub usage: Value,
}

fn media(message: String, code: &'static str, status: u16) -> AdapterError {
    LaneError { message, code, status }.into()
}

fn headers(auth: &Auth) -> Vec<(String, String)> {
    vec![("Content-Type".to_owned(), "application/json".to_owned()), ("Authorization".to_owned(), format!("Bearer {}", auth.token))]
}

fn plain(failure: super::catalog_fetch::HttpFailure) -> AdapterError {
    AdapterError::plain(failure.message)
}

/// `readError(res)`: the first 400 characters of the body.
fn read_error(reply: &PostReply) -> String {
    slice_utf16(&reply.body, 400)
}

fn is_ok(reply: &PostReply) -> bool {
    (200..300).contains(&reply.status)
}

/// `String(value || fallback)`.
fn text_or(value: Option<&Value>, fallback: &str) -> String {
    if truthy(value) { value.map(value_to_string).unwrap_or_default() } else { fallback.to_owned() }
}

/// One reference edits that image; several composite into a new one.
fn reference_params(refs: &[Value], body: &mut Map<String, Value>) {
    match refs.len() {
        0 => {}
        1 => {
            body.insert("image".into(), refs[0].clone());
        }
        _ => {
            body.insert("images".into(), Value::Array(refs.to_vec()));
        }
    }
}

fn size_params(options: &Value, body: &mut Map<String, Value>) {
    let aspect = text_or(options.get("aspectRatio"), "auto");
    if !aspect.is_empty() && aspect != "auto" {
        body.insert("aspect_ratio".into(), json!(aspect));
    }
    let resolution = text_or(options.get("resolution"), "").to_lowercase();
    if resolution == "1k" || resolution == "2k" {
        body.insert("resolution".into(), json!(resolution));
    }
}

/// `generateImage({ lane, model, prompt, options, references, signal })`.
#[allow(clippy::too_many_arguments, reason = "the adapter's own parameters, one per field of Node's call")]
pub async fn generate_image(http: &dyn JsonPost, auth: &Auth, model: &str, prompt: &str, options: &Value, references: &[ImageReference], cancel: &CancellationToken) -> Result<GeneratedImage, AdapterError> {
    let refs: Vec<Value> = references.iter().map(|r| json!({ "type": "image_url", "url": reference_url(r) })).collect();
    let mut body = Map::new();
    body.insert("model".into(), json!(model));
    body.insert("prompt".into(), json!(prompt));
    body.insert("n".into(), json!(1));
    body.insert("response_format".into(), json!("b64_json"));
    reference_params(&refs, &mut body);
    size_params(options, &mut body);
    let route = if refs.is_empty() { "images/generations" } else { "images/edits" };
    let url = format!("{}/{route}", auth.base_url);
    let reply = http.post(&url, &headers(auth), &Value::Object(body), IMAGE_TIMEOUT, cancel).await.map_err(plain)?;
    if !is_ok(&reply) {
        return Err(upstream_error("xAI image", reply.status, &read_error(&reply)).into());
    }
    let data = parse_json_body(&reply.body)?;
    let entry = data.get("data").and_then(|d| d.get(0)).unwrap_or(&Value::Null);
    if !truthy(entry.get("b64_json")) {
        return Err(media("xAI returned no image data".to_owned(), "MEDIA_EMPTY_RESULT", 502));
    }
    let bytes = decode_base64_media(&entry["b64_json"], "xAI image")?;
    Ok(GeneratedImage {
        bytes,
        mime: text_or(entry.get("mime_type"), "image/png"),
        revised_prompt: truthy(entry.get("revised_prompt")).then(|| value_to_string(&entry["revised_prompt"])),
        usage: xai_usage(data.get("usage").unwrap_or(&Value::Null)),
    })
}

/// `generateVideo({ lane, model, prompt, options, references, signal, onProgress })`.
#[allow(clippy::too_many_arguments, reason = "the adapter's own parameters, one per field of Node's call")]
pub async fn generate_video(
    http: &dyn JsonPost,
    public: &dyn PublicFetch,
    pacer: &dyn Pacer,
    auth: &Auth,
    model: &str,
    prompt: &str,
    options: &Value,
    references: &[ImageReference],
    cancel: &CancellationToken,
    on_progress: &(dyn Fn(f64) + Send + Sync),
) -> Result<GeneratedVideo, AdapterError> {
    let headers = headers(auth);
    let wanted = to_number_of(options.get("duration"));
    let wanted = if wanted.is_nan() || wanted == 0.0 { 5.0 } else { wanted };
    let duration = wanted.trunc().clamp(1.0, 15.0) as i64;
    let resolution = match options.get("resolution").and_then(Value::as_str) {
        Some(r @ ("480p" | "720p" | "1080p")) => r,
        _ => "480p",
    };
    let mut body = Map::new();
    body.insert("model".into(), json!(model));
    body.insert("prompt".into(), json!(prompt));
    body.insert("duration".into(), json!(duration));
    body.insert("resolution".into(), json!(resolution));
    let aspect = text_or(options.get("aspectRatio"), "auto");
    if !aspect.is_empty() && aspect != "auto" {
        body.insert("aspect_ratio".into(), json!(aspect));
    }
    // Mode is inferred from the reference count: 1 = image-to-video, 2+ = reference-to-video
    // (capped at the documented 7).
    let refs: Vec<String> = references.iter().take(7).map(reference_url).collect();
    match refs.len() {
        0 => {}
        1 => {
            body.insert("image".into(), json!({ "url": refs[0] }));
        }
        _ => {
            body.insert("reference_images".into(), refs.iter().map(|url| json!({ "url": url })).collect());
        }
    }

    let started = http.post(&format!("{}/videos/generations", auth.base_url), &headers, &Value::Object(body), START_TIMEOUT, cancel).await.map_err(plain)?;
    if !is_ok(&started) {
        return Err(upstream_error("xAI video", started.status, &read_error(&started)).into());
    }
    let start_data = parse_json_body(&started.body)?;
    let request_id = [start_data.get("request_id"), start_data.get("id")].into_iter().find(|v| truthy(*v)).flatten().map(value_to_string);
    let Some(request_id) = request_id else {
        return Err(media("xAI video start returned no request id".to_owned(), "MEDIA_UPSTREAM_FAILED", 502));
    };

    let deadline = pacer.now() + TOTAL_TIMEOUT_MS;
    loop {
        if cancel.is_cancelled() {
            return Err(media("canceled".to_owned(), "MEDIA_CANCELED", 499));
        }
        if pacer.now() > deadline {
            return Err(media("xAI video poll budget exceeded".to_owned(), "MEDIA_TIMEOUT", 504));
        }
        pacer.sleep(POLL_INTERVAL_MS).await;
        let remaining = (deadline - pacer.now()).max(1);
        let timeout = Duration::from_millis(remaining.min(POLL_REQUEST_TIMEOUT_MS) as u64);
        let poll = http.get(&format!("{}/videos/{request_id}", auth.base_url), &headers, timeout, cancel).await.map_err(plain)?;
        if !is_ok(&poll) && poll.status != 202 {
            return Err(upstream_error("xAI video poll", poll.status, &read_error(&poll)).into());
        }
        let data: Value = mixdog_js::json_parse(&poll.body).unwrap_or_else(|_| json!({}));
        if let Some(progress) = data.get("progress").and_then(Value::as_f64) {
            on_progress(progress);
        }
        match data.get("status").and_then(Value::as_str) {
            Some("done") => {
                let video = data.get("video").unwrap_or(&Value::Null);
                // The billed cost (when reported) is the price; seconds + resolution let the
                // catalog's per-second rate price it otherwise.
                let reported = to_number_of(video.get("duration"));
                let seconds = if reported.is_nan() || reported == 0.0 { duration as f64 } else { reported };
                let mut usage = xai_usage(data.get("usage").unwrap_or(&Value::Null)).and_then(|v| v.as_object().cloned()).unwrap_or_default();
                usage.insert("seconds".into(), json_number(seconds));
                usage.insert("resolution".into(), json!(resolution));
                let usage = Value::Object(usage);
                let with_usage = |mut error: AdapterError| {
                    error.usage = reported_usage(Some(usage.clone()));
                    error
                };
                if !truthy(video.get("url")) {
                    return Err(with_usage(media("xAI video finished without a URL".to_owned(), "MEDIA_EMPTY_RESULT", 502)));
                }
                let bytes = download_public_media(public, &value_to_string(&video["url"]), &Limits { label: "xAI video", ..Limits::default() }, cancel).await.map_err(with_usage)?;
                return Ok(GeneratedVideo { bytes, mime: "video/mp4", duration_seconds: json_number(seconds), usage });
            }
            Some(status @ ("failed" | "expired")) => {
                let code = data.get("error").and_then(|e| e.get("code")).filter(|c| truthy(Some(c))).map(value_to_string);
                let suffix = code.map(|c| format!(": {c}")).unwrap_or_default();
                let mut error = media(format!("xAI video {status}{suffix}"), "MEDIA_UPSTREAM_FAILED", 502);
                error.usage = reported_usage(xai_usage(data.get("usage").unwrap_or(&Value::Null)));
                return Err(error);
            }
            _ => {}
        }
    }
}
