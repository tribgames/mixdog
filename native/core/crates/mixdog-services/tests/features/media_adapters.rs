//! The media provider adapters against a scripted upstream: the request each one sends, how it reads each answer and each
//! failure, and what it hands back.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine as _;
use mixdog_services::media::adapter_http::{JsonPost, PostReply};
use mixdog_services::media::antigravity_image::{self, AntigravityAuth, AntigravitySession, StreamParts, antigravity_image_parts};
use mixdog_services::media::catalog_fetch::{Auth, HttpFailure};
use mixdog_services::media::codex_image::{self, CHATGPT_USAGE_URL, CodexAuth, CodexSession, chatgpt_limit_reset_at, limit_reset_from_usage};
use mixdog_services::media::download::{AdapterError, Limits, PublicFetch, PublicResponse, download_gemini_media, download_public_media, read_response_buffer};
use mixdog_services::media::gemini_image::{self, gemini_image_request_body, pick_gemini_image_part};
use mixdog_services::media::gemini_video;
use mixdog_services::media::image_api::{self, raster_mime};
use mixdog_services::media::references::{Reference, References};
use mixdog_services::media::upstream::{gemini_media_download_url, upstream_error};
use mixdog_services::media::xai::{self, Pacer};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

// ---- the scripted upstream ----

#[derive(Clone, Debug)]
struct Sent {
    method: &'static str,
    url: String,
    headers: Vec<(String, String)>,
    body: Value,
    timeout: Duration,
}

#[derive(Default)]
struct Http {
    replies: Mutex<VecDeque<Result<PostReply, HttpFailure>>>,
    sent: Mutex<Vec<Sent>>,
}

impl Http {
    fn with(replies: Vec<Result<PostReply, HttpFailure>>) -> Self {
        Self { replies: Mutex::new(replies.into()), sent: Mutex::default() }
    }
    fn sent(&self) -> Vec<Sent> {
        self.sent.lock().unwrap().clone()
    }
    fn next(&self, sent: Sent) -> Result<PostReply, HttpFailure> {
        self.sent.lock().unwrap().push(sent);
        self.replies.lock().unwrap().pop_front().expect("the adapter asked for more than the script holds")
    }
}

#[async_trait]
impl JsonPost for Http {
    async fn post(&self, url: &str, headers: &[(String, String)], body: &Value, timeout: Duration, _: &CancellationToken) -> Result<PostReply, HttpFailure> {
        self.next(Sent { method: "POST", url: url.to_owned(), headers: headers.to_vec(), body: body.clone(), timeout })
    }
    async fn get(&self, url: &str, headers: &[(String, String)], timeout: Duration, _: &CancellationToken) -> Result<PostReply, HttpFailure> {
        self.next(Sent { method: "GET", url: url.to_owned(), headers: headers.to_vec(), body: Value::Null, timeout })
    }
}

fn answer(status: u16, body: impl ToString) -> Result<PostReply, HttpFailure> {
    Ok(PostReply { status, headers: Vec::new(), body: body.to_string() })
}

fn answer_with(status: u16, headers: &[(&str, &str)], body: &str) -> Result<PostReply, HttpFailure> {
    Ok(PostReply { status, headers: headers.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect(), body: body.to_owned() })
}

fn no_answer(message: &str, timed_out: bool) -> Result<PostReply, HttpFailure> {
    Err(HttpFailure { message: message.to_owned(), timed_out })
}

struct Piece {
    status: u16,
    headers: Vec<(String, String)>,
    chunks: VecDeque<Vec<u8>>,
    body: bool,
}

#[async_trait]
impl PublicResponse for Piece {
    fn status(&self) -> u16 {
        self.status
    }
    fn header(&self, name: &str) -> Option<String> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.clone())
    }
    fn has_body(&self) -> bool {
        self.body
    }
    async fn chunk(&mut self) -> Result<Option<Vec<u8>>, AdapterError> {
        Ok(self.chunks.pop_front())
    }
}

#[derive(Default)]
struct Public {
    /// url -> (status, headers, chunks); a url without an entry is refused as a private address.
    routes: Mutex<HashMap<String, (u16, Vec<(String, String)>, Vec<Vec<u8>>)>>,
    asked: Mutex<Vec<(String, Vec<(String, String)>)>>,
}

impl Public {
    fn serve(&self, url: &str, status: u16, headers: &[(&str, &str)], chunks: Vec<Vec<u8>>) {
        self.routes.lock().unwrap().insert(url.to_owned(), (status, headers.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect(), chunks));
    }
    fn asked(&self) -> Vec<String> {
        self.asked.lock().unwrap().iter().map(|(url, _)| url.clone()).collect()
    }
}

#[async_trait]
impl PublicFetch for Public {
    async fn get(&self, url: &str, headers: &[(String, String)], _: &CancellationToken) -> Result<Box<dyn PublicResponse>, AdapterError> {
        self.asked.lock().unwrap().push((url.to_owned(), headers.to_vec()));
        match self.routes.lock().unwrap().get(url) {
            Some((status, headers, chunks)) => Ok(Box::new(Piece { status: *status, headers: headers.clone(), chunks: chunks.clone().into(), body: true })),
            None => Err(AdapterError::plain(format!("Blocked request to private address: {url}"))),
        }
    }
}

/// A clock that moves only when the adapter waits: `step` ms per wait.
struct Wait {
    now: AtomicI64,
    step: i64,
    waits: Mutex<Vec<u64>>,
}

impl Wait {
    fn new(step: i64) -> Self {
        Self { now: AtomicI64::new(0), step, waits: Mutex::default() }
    }
    fn waits(&self) -> Vec<u64> {
        self.waits.lock().unwrap().clone()
    }
}

#[async_trait]
impl Pacer for Wait {
    fn now(&self) -> i64 {
        self.now.load(Ordering::SeqCst)
    }
    async fn sleep(&self, ms: u64) {
        self.waits.lock().unwrap().push(ms);
        self.now.fetch_add(self.step, Ordering::SeqCst);
    }
}

fn png() -> Vec<u8> {
    let mut bytes = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    bytes.extend([1, 2, 3, 4]);
    bytes
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn reference(data: &str) -> Reference {
    Reference::base64(data)
}

/// A job's references, judged by the double supply, for a model that takes `max`.
fn list_max(items: Vec<Reference>, max: usize) -> References {
    mixdog_core_api::mock::install_mock_image_supply();
    References::new(items, max)
}

fn list(items: Vec<Reference>) -> References {
    list_max(items, 7)
}

fn none() -> References {
    list(Vec::new())
}

fn cancel() -> CancellationToken {
    CancellationToken::new()
}

fn failure_of(error: &AdapterError) -> (&str, Option<&str>, Option<u16>) {
    (error.message.as_str(), error.code.as_deref(), error.status)
}

fn header<'a>(sent: &'a Sent, name: &str) -> Option<&'a str> {
    sent.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
}

const NOP: &(dyn Fn(f64) + Send + Sync) = &|_| {};

// ---- the Image API lane (OpenRouter, NanoGPT) ----

fn gateway() -> Auth {
    Auth { token: "tok".into(), base_url: "https://gw.example/v1".into(), ..Auth::default() }
}

async fn image_api(http: &Http, public: &Public, lane: &str, options: Value, refs: &References) -> Result<image_api::GeneratedImage, AdapterError> {
    image_api::generate_image(http, public, &gateway(), lane, "m", "a cat", &options, refs, &cancel()).await
}

#[tokio::test]
async fn the_image_api_request_names_the_model_the_trimmed_options_and_the_references() {
    let http = Http::with(vec![answer(
        200,
        json!({"data": [{"b64_json": b64(&png()), "revised_prompt": "a better cat"}], "usage": {"prompt_tokens": 7, "completion_tokens": 3}}),
    )]);
    let refs = list(vec![reference("AAAA"), reference("data:image/jpeg;base64,/9j/AA==")]);
    let image = image_api(
        &http,
        &Public::default(),
        "openrouter",
        json!({"aspectRatio": " 16:9 ", "resolution": "2K", "quality": "", "background": null, "other": "x"}),
        &refs,
    )
    .await
    .unwrap();
    let sent = http.sent();
    assert_eq!(sent.len(), 1);
    assert_eq!((sent[0].method, sent[0].url.as_str(), sent[0].timeout), ("POST", "https://gw.example/v1/images", Duration::from_secs(180)));
    assert_eq!(sent[0].headers, vec![("Content-Type".to_owned(), "application/json".to_owned()), ("Authorization".to_owned(), "Bearer tok".to_owned())]);
    assert_eq!(
        mixdog_js::json_stringify(&sent[0].body),
        r#"{"model":"m","prompt":"a cat","n":1,"aspect_ratio":"16:9","resolution":"2K","input_references":[{"type":"image_url","image_url":{"url":"data:image/png;base64,AAAA"}},{"type":"image_url","image_url":{"url":"data:image/jpeg;base64,/9j/AA=="}}]}"#
    );
    assert_eq!((image.bytes, image.mime.as_str(), image.revised_prompt.as_deref()), (png(), "image/png", Some("a better cat")));
    assert_eq!(image.usage, Some(json!({"inputTokens": 7, "outputTokens": 3})));
}

#[tokio::test]
async fn a_gateway_answer_that_is_an_address_is_fetched_from_the_public_internet() {
    let http = Http::with(vec![answer(200, json!({"data": [{"url": "https://cdn.example/x.png"}]}))]);
    let public = Public::default();
    public.serve("https://cdn.example/x.png", 200, &[], vec![png()]);
    let image = image_api(&http, &public, "nano-gpt", json!({}), &none()).await.unwrap();
    assert_eq!(image.bytes, png());
    assert_eq!(public.asked(), vec!["https://cdn.example/x.png"]);
    // A private address is refused by the public fetch and the refusal is the failure.
    let http = Http::with(vec![answer(200, json!({"data": [{"url": "http://10.0.0.5/x.png"}]}))]);
    let error = image_api(&http, &public, "nano-gpt", json!({}), &none()).await.unwrap_err();
    assert_eq!(error.message, "Blocked request to private address: http://10.0.0.5/x.png");
}

#[tokio::test]
async fn an_image_api_answer_without_a_usable_image_is_an_error_that_keeps_billable_usage() {
    let empty = Http::with(vec![answer(200, json!({"data": [{}], "usage": {"cost": 0.04}}))]);
    let error = image_api(&empty, &Public::default(), "openrouter", json!({}), &none()).await.unwrap_err();
    assert_eq!(failure_of(&error), ("OpenRouter image returned no image data", Some("MEDIA_EMPTY_RESULT"), Some(502)));
    assert_eq!(error.usage, Some(Box::new(json!({"costUsd": 0.04}))), "what the provider billed is kept");
    let gif = Http::with(vec![answer(200, json!({"data": [{"b64_json": b64(b"GIF89a....")}]}))]);
    let error = image_api(&gif, &Public::default(), "nano-gpt", json!({}), &none()).await.unwrap_err();
    assert_eq!(failure_of(&error), ("NanoGPT image returned an unsupported image format", Some("MEDIA_UPSTREAM_FAILED"), Some(502)));
    assert_eq!(error.usage, None);
}

#[tokio::test]
async fn image_api_failures_say_what_went_wrong_in_the_lanes_own_words() {
    let refused = Http::with(vec![answer(429, "slow down")]);
    let error = image_api(&refused, &Public::default(), "openrouter", json!({}), &none()).await.unwrap_err();
    let expected = upstream_error("OpenRouter image", 429, "slow down");
    assert_eq!(failure_of(&error), (expected.message.as_str(), Some(expected.code), Some(expected.status)));
    let slow = Http::with(vec![no_answer("The operation was aborted due to timeout", true)]);
    let error = image_api(&slow, &Public::default(), "openrouter", json!({}), &none()).await.unwrap_err();
    assert_eq!(failure_of(&error), ("OpenRouter image timed out", Some("MEDIA_TIMEOUT"), Some(504)));
    let down = Http::with(vec![no_answer("fetch failed", false)]);
    let error = image_api(&down, &Public::default(), "other", json!({}), &none()).await.unwrap_err();
    assert_eq!(failure_of(&error), ("fetch failed", None, None));
    let unnamed = Http::with(vec![answer(200, "{}")]);
    let error = image_api(&unnamed, &Public::default(), "other", json!({}), &none()).await.unwrap_err();
    assert_eq!(error.message, "Image API returned no image data");
}

#[test]
fn only_the_raster_formats_the_store_keeps_are_recognised_by_their_bytes() {
    assert_eq!(raster_mime(&png()), Some("image/png"));
    assert_eq!(raster_mime(&[0xff, 0xd8, 0xff, 0xe0]), Some("image/jpeg"));
    assert_eq!(raster_mime(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
    assert_eq!(raster_mime(b"GIF89a......"), None);
    assert_eq!(raster_mime(&[0x89, 0x50]), None);
}

// ---- xAI Imagine ----

fn xai_auth() -> Auth {
    Auth { token: "xk".into(), base_url: "https://api.x.ai/v1".into(), ..Auth::default() }
}

#[tokio::test]
async fn an_xai_image_goes_to_generations_or_to_edits_by_whether_there_are_references() {
    let reply = || {
        answer(200, json!({"data": [{"b64_json": b64(&png()), "mime_type": "image/webp", "revised_prompt": "r"}], "usage": {"cost_in_usd_ticks": 500_000_000}}))
    };
    let http = Http::with(vec![reply(), reply(), reply()]);
    let options = json!({"aspectRatio": "3:2", "resolution": "2K"});
    let image = xai::generate_image(&http, &xai_auth(), "grok-img", "a dog", &options, &none(), &cancel()).await.unwrap();
    assert_eq!(
        (image.bytes, image.mime.as_str(), image.revised_prompt.as_deref(), image.usage),
        (png(), "image/webp", Some("r"), Some(json!({"costUsd": 0.05})))
    );
    xai::generate_image(
        &http,
        &xai_auth(),
        "grok-img",
        "a dog",
        &json!({"aspectRatio": "auto", "resolution": "4k"}),
        &list(vec![reference("AAAA")]),
        &cancel(),
    )
    .await
    .unwrap();
    xai::generate_image(&http, &xai_auth(), "grok-img", "a dog", &json!({}), &list(vec![reference("AAAA"), reference("BBBB")]), &cancel()).await.unwrap();
    let sent = http.sent();
    assert_eq!(sent[0].url, "https://api.x.ai/v1/images/generations");
    assert_eq!(
        mixdog_js::json_stringify(&sent[0].body),
        r#"{"model":"grok-img","prompt":"a dog","n":1,"response_format":"b64_json","aspect_ratio":"3:2","resolution":"2k"}"#
    );
    assert_eq!(sent[0].timeout, Duration::from_secs(180));
    assert_eq!(header(&sent[0], "Authorization"), Some("Bearer xk"));
    assert_eq!(sent[1].url, "https://api.x.ai/v1/images/edits");
    assert_eq!(
        mixdog_js::json_stringify(&sent[1].body),
        r#"{"model":"grok-img","prompt":"a dog","n":1,"response_format":"b64_json","image":{"type":"image_url","url":"data:image/png;base64,AAAA"}}"#,
        "auto aspect and an unlisted resolution are not sent; one reference edits it"
    );
    assert_eq!(sent[2].body["images"].as_array().map(Vec::len), Some(2), "several references composite");
    assert!(sent[2].body.get("image").is_none());
}

#[tokio::test]
async fn an_xai_image_answer_without_data_or_with_an_error_status_fails_in_the_providers_words() {
    let empty = Http::with(vec![answer(200, json!({"data": []}))]);
    let error = xai::generate_image(&empty, &xai_auth(), "m", "p", &json!({}), &none(), &cancel()).await.unwrap_err();
    assert_eq!(failure_of(&error), ("xAI returned no image data", Some("MEDIA_EMPTY_RESULT"), Some(502)));
    let refused = Http::with(vec![answer(401, "no")]);
    let error = xai::generate_image(&refused, &xai_auth(), "m", "p", &json!({}), &none(), &cancel()).await.unwrap_err();
    let expected = upstream_error("xAI image", 401, "no");
    assert_eq!(failure_of(&error), (expected.message.as_str(), Some(expected.code), Some(expected.status)));
    let down = Http::with(vec![no_answer("fetch failed", false)]);
    assert_eq!(xai::generate_image(&down, &xai_auth(), "m", "p", &json!({}), &none(), &cancel()).await.unwrap_err().message, "fetch failed");
}

async fn video(
    http: &Http,
    public: &Public,
    pacer: &Wait,
    options: Value,
    refs: &References,
    cancel: &CancellationToken,
    progress: &(dyn Fn(f64) + Send + Sync),
) -> Result<xai::GeneratedVideo, AdapterError> {
    xai::generate_video(http, public, pacer, &xai_auth(), "grok-vid", "a wave", &options, refs, cancel, progress).await
}

#[tokio::test]
async fn an_xai_video_is_submitted_polled_every_four_seconds_and_downloaded_when_done() {
    let http = Http::with(vec![
        answer(200, json!({"request_id": "req1"})),
        answer(202, json!({"status": "pending", "progress": 0.4})),
        answer(200, json!({"status": "done", "video": {"url": "https://cdn.example/v.mp4", "duration": 6}, "usage": {"cost_in_usd_ticks": 500_000_000}})),
    ]);
    let public = Public::default();
    public.serve("https://cdn.example/v.mp4", 200, &[], vec![b"mp4".to_vec()]);
    let pacer = Wait::new(4_000);
    let seen = Mutex::new(Vec::new());
    let progress = |p: f64| seen.lock().unwrap().push(p);
    let video =
        video(&http, &public, &pacer, json!({"duration": 99, "resolution": "720p", "aspectRatio": "9:16"}), &none(), &cancel(), &progress).await.unwrap();
    assert_eq!((video.bytes.as_slice(), video.mime, video.duration_seconds), (&b"mp4"[..], "video/mp4", json!(6)));
    assert_eq!(video.usage, json!({"costUsd": 0.05, "seconds": 6, "resolution": "720p"}));
    assert_eq!(pacer.waits(), vec![4_000, 4_000]);
    assert_eq!(*seen.lock().unwrap(), vec![0.4]);
    let sent = http.sent();
    assert_eq!((sent[0].method, sent[0].url.as_str(), sent[0].timeout), ("POST", "https://api.x.ai/v1/videos/generations", Duration::from_secs(60)));
    assert_eq!(
        mixdog_js::json_stringify(&sent[0].body),
        r#"{"model":"grok-vid","prompt":"a wave","duration":15,"resolution":"720p","aspect_ratio":"9:16"}"#,
        "a longer clip is capped at 15 s"
    );
    assert_eq!((sent[1].method, sent[1].url.as_str()), ("GET", "https://api.x.ai/v1/videos/req1"));
}

#[tokio::test]
async fn the_xai_video_mode_follows_the_number_of_references_and_the_defaults_fill_the_rest() {
    let start = || vec![answer(200, json!({"id": "r"})), answer(200, json!({"status": "done", "video": {"url": "https://cdn.example/v.mp4"}}))];
    let public = Public::default();
    public.serve("https://cdn.example/v.mp4", 200, &[], vec![b"v".to_vec()]);
    let one = Http::with(start());
    let done = video(&one, &public, &Wait::new(1), json!({"resolution": "4k", "duration": 0}), &list(vec![reference("AAAA")]), &cancel(), NOP).await.unwrap();
    assert_eq!(one.sent()[0].body["image"], json!({"url": "data:image/png;base64,AAAA"}));
    assert_eq!(one.sent()[0].body["duration"], 5, "no usable duration is five seconds");
    assert_eq!(one.sent()[0].body["resolution"], "480p");
    assert_eq!(done.usage, json!({"seconds": 5, "resolution": "480p"}), "the length asked for prices it when the provider names none");
    let many = Http::with(start());
    let seven = list((0..7).map(|n| reference(&format!("AAA{n}"))).collect());
    video(&many, &public, &Wait::new(1), json!({}), &seven, &cancel(), NOP).await.unwrap();
    assert_eq!(many.sent()[0].body["reference_images"].as_array().map(Vec::len), Some(7), "seven references are all sent, in order");
    assert_eq!(many.sent()[0].body["reference_images"][6], json!({"url": "data:image/png;base64,AAA6"}));
    assert!(many.sent()[0].body.get("image").is_none());
}

#[tokio::test]
async fn an_eighth_xai_video_reference_is_refused_and_nothing_is_sent() {
    let refused = Http::default();
    let nine = list((0..8).map(|n| reference(&format!("AAA{n}"))).collect());
    let error = video(&refused, &Public::default(), &Wait::new(1), json!({}), &nine, &cancel(), NOP).await.unwrap_err();
    // The count is refused before any picture is read, with how many must go.
    assert_eq!(error.code.as_deref(), Some("MEDIA_TOO_MANY_REFERENCES"));
    assert_eq!(error.message, "xAI video takes at most 7 reference images; 8 were given. Remove 1 and try again.");
    assert!(refused.sent().is_empty());
}

#[tokio::test]
async fn a_reference_the_destination_cannot_take_names_every_blocker_and_sends_nothing() {
    let http = Http::default();
    // Two pictures past what a model that takes one allows, and one that is not an image at all.
    let list_of_three = list_max(vec![Reference { name: "a.png".into(), ..reference("AAAA") }, reference("AAAB"), reference("!!!")], 1);
    let error = xai::generate_image(&http, &xai_auth(), "grok-img", "a dog", &json!({}), &list_of_three, &cancel()).await.unwrap_err();
    assert_eq!(error.code.as_deref(), Some("MEDIA_REFERENCE_REFUSED"));
    assert!(error.message.starts_with("Nothing was sent."), "{}", error.message);
    assert!(error.message.contains("past the 1 images") && error.message.contains("is not a valid image"), "every blocker is named: {}", error.message);
    assert!(http.sent().is_empty(), "no request left the app");
}

#[tokio::test]
async fn veo_takes_one_start_image_and_a_second_is_refused() {
    let http = Http::default();
    let two = list(vec![reference("AAAA"), reference("AAAB")]);
    let error = gemini_video::generate_video(&http, &Public::default(), &Wait::new(1), "gk", "veo-3", "p", &json!({}), &two, &cancel(), NOP).await.unwrap_err();
    assert_eq!(error.code.as_deref(), Some("MEDIA_TOO_MANY_REFERENCES"));
    assert_eq!(error.message, "Veo takes one start image; 2 were given. Remove 1 and try again.");
    assert!(http.sent().is_empty());
}

#[tokio::test]
async fn each_codex_branch_prepares_its_own_target_and_a_refused_reference_blocks_both() {
    let http = Http::default();
    let error = codex(&http, &Codex::new(None), json!({}), &list(vec![reference("!!!")])).await.unwrap_err();
    assert_eq!(error.code.as_deref(), Some("MEDIA_REFERENCE_REFUSED"));
    assert!(http.sent().is_empty());
}

#[tokio::test]
async fn an_xai_video_that_cannot_start_or_finish_fails_with_the_reason() {
    let public = Public::default();
    let no_id = Http::with(vec![answer(200, json!({}))]);
    let error = video(&no_id, &public, &Wait::new(1), json!({}), &none(), &cancel(), NOP).await.unwrap_err();
    assert_eq!(failure_of(&error), ("xAI video start returned no request id", Some("MEDIA_UPSTREAM_FAILED"), Some(502)));
    let refused = Http::with(vec![answer(400, "bad prompt")]);
    let error = video(&refused, &public, &Wait::new(1), json!({}), &none(), &cancel(), NOP).await.unwrap_err();
    assert_eq!(error.message, upstream_error("xAI video", 400, "bad prompt").message);
    for (poll, expected) in [
        (json!({"status": "failed", "error": {"code": "content_policy"}, "usage": {"cost_in_usd_ticks": 100_000_000}}), "xAI video failed: content_policy"),
        (json!({"status": "expired"}), "xAI video expired"),
    ] {
        let http = Http::with(vec![answer(200, json!({"request_id": "r"})), answer(200, poll)]);
        let error = video(&http, &public, &Wait::new(1), json!({}), &none(), &cancel(), NOP).await.unwrap_err();
        assert_eq!(failure_of(&error), (expected, Some("MEDIA_UPSTREAM_FAILED"), Some(502)));
        assert_eq!(error.usage.is_some(), expected.ends_with("content_policy"), "reported cost is kept on a failure");
    }
    let no_url = Http::with(vec![answer(200, json!({"request_id": "r"})), answer(200, json!({"status": "done", "video": {}}))]);
    let error = video(&no_url, &public, &Wait::new(1), json!({}), &none(), &cancel(), NOP).await.unwrap_err();
    assert_eq!(failure_of(&error), ("xAI video finished without a URL", Some("MEDIA_EMPTY_RESULT"), Some(502)));
    assert_eq!(error.usage, Some(Box::new(json!({"seconds": 5, "resolution": "480p"}))), "the seconds are billed even without a file");
    let poll_failed = Http::with(vec![answer(200, json!({"request_id": "r"})), answer(500, "boom")]);
    let error = video(&poll_failed, &public, &Wait::new(1), json!({}), &none(), &cancel(), NOP).await.unwrap_err();
    assert_eq!(error.message, upstream_error("xAI video poll", 500, "boom").message);
}

#[tokio::test]
async fn an_xai_video_that_never_finishes_stops_at_fifteen_minutes_and_a_cancel_stops_it_at_once() {
    let mut replies = vec![answer(200, json!({"request_id": "r"}))];
    replies.extend((0..3).map(|_| answer(202, json!({"status": "pending"}))));
    let http = Http::with(replies);
    let pacer = Wait::new(400_000);
    let error = video(&http, &Public::default(), &pacer, json!({}), &none(), &cancel(), NOP).await.unwrap_err();
    assert_eq!(failure_of(&error), ("xAI video poll budget exceeded", Some("MEDIA_TIMEOUT"), Some(504)));
    assert_eq!(http.sent().len(), 4, "the submit and three polls");
    let stopped = cancel();
    stopped.cancel();
    let http = Http::with(vec![answer(200, json!({"request_id": "r"}))]);
    let error = video(&http, &Public::default(), &Wait::new(1), json!({}), &none(), &stopped, NOP).await.unwrap_err();
    assert_eq!(failure_of(&error), ("canceled", Some("MEDIA_CANCELED"), Some(499)));
}

// ---- Gemini image (API key) ----

fn candidate(parts: Value, usage: Value) -> String {
    json!({"candidates": [{"content": {"parts": parts}}], "usageMetadata": usage}).to_string()
}

#[tokio::test]
async fn a_gemini_image_request_asks_for_text_and_image_and_names_the_aspect_only_when_chosen() {
    let http = Http::with(vec![
        answer(
            200,
            candidate(
                json!([{"text": "here"}, {"inlineData": {"mimeType": "image/jpeg", "data": b64(&[0xff, 0xd8, 0xff, 1])}}]),
                json!({"promptTokenCount": 5, "candidatesTokenCount": 2}),
            ),
        ),
        answer(200, candidate(json!([{"inlineData": {"data": b64(&png())}}]), Value::Null)),
    ]);
    let image = gemini_image::generate_image(
        &http,
        "gk",
        "gemini-2.5-flash-image",
        "a bird",
        &json!({"aspectRatio": "4:3"}),
        &list(vec![reference("AAAA")]),
        &cancel(),
    )
    .await
    .unwrap();
    assert_eq!((image.mime.as_str(), image.bytes), ("image/jpeg", vec![0xff, 0xd8, 0xff, 1]));
    assert!(image.usage.is_some_and(|usage| usage != json!({"images": 1})), "reported tokens are kept");
    let plain =
        gemini_image::generate_image(&http, "gk", "gemini-2.5-flash-image", "a bird", &json!({"aspectRatio": "auto"}), &none(), &cancel()).await.unwrap();
    assert_eq!((plain.mime.as_str(), plain.usage), ("image/png", Some(json!({"images": 1}))), "no mime is png and no tokens is one priced image");
    let sent = http.sent();
    assert_eq!(sent[0].url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent");
    assert_eq!(sent[0].headers, vec![("Content-Type".to_owned(), "application/json".to_owned()), ("x-goog-api-key".to_owned(), "gk".to_owned())]);
    assert_eq!(sent[0].timeout, Duration::from_secs(180));
    assert_eq!(
        mixdog_js::json_stringify(&sent[0].body),
        r#"{"generationConfig":{"responseModalities":["TEXT","IMAGE"],"imageConfig":{"aspectRatio":"4:3"}},"contents":[{"role":"user","parts":[{"inlineData":{"mimeType":"image/png","data":"AAAA"}},{"text":"a bird"}]}]}"#
    );
    assert!(sent[1].body["generationConfig"].get("imageConfig").is_none());
    assert_eq!(gemini_image_request_body("a bird", &json!({"aspectRatio": "auto"}), &[]), sent[1].body);
}

#[tokio::test]
async fn a_model_name_is_escaped_into_the_gemini_address() {
    let http = Http::with(vec![answer(200, candidate(json!([{"inlineData": {"data": b64(&png())}}]), Value::Null))]);
    gemini_image::generate_image(&http, "gk", "tuned/x y", "p", &json!({}), &none(), &cancel()).await.unwrap();
    assert_eq!(http.sent()[0].url, "https://generativelanguage.googleapis.com/v1beta/models/tuned%2Fx%20y:generateContent");
}

#[tokio::test]
async fn a_gemini_answer_with_no_image_is_the_models_refusal_and_keeps_reported_usage() {
    let refusal = Http::with(vec![answer(200, candidate(json!([{"text": "I cannot draw that"}]), json!({"promptTokenCount": 5, "candidatesTokenCount": 2})))]);
    let error = gemini_image::generate_image(&refusal, "gk", "m", "p", &json!({}), &none(), &cancel()).await.unwrap_err();
    assert_eq!(failure_of(&error), ("Gemini returned no image data: I cannot draw that", Some("MEDIA_EMPTY_RESULT"), Some(502)));
    assert!(error.usage.is_some());
    let silent = Http::with(vec![answer(200, json!({"candidates": []}))]);
    let error = gemini_image::generate_image(&silent, "gk", "m", "p", &json!({}), &none(), &cancel()).await.unwrap_err();
    assert_eq!((error.message.as_str(), error.usage), ("Gemini returned no image data", None));
    let long = Http::with(vec![answer(200, candidate(json!([{"text": "x".repeat(500)}]), Value::Null))]);
    let error = gemini_image::generate_image(&long, "gk", "m", "p", &json!({}), &none(), &cancel()).await.unwrap_err();
    assert_eq!(error.message.len(), "Gemini returned no image data: ".len() + 200, "a refusal is quoted up to 200 characters");
    let refused = Http::with(vec![answer(403, "forbidden")]);
    let error = gemini_image::generate_image(&refused, "gk", "m", "p", &json!({}), &none(), &cancel()).await.unwrap_err();
    assert_eq!(error.message, upstream_error("Gemini image", 403, "forbidden").message);
    let down = Http::with(vec![no_answer("fetch failed", false)]);
    assert_eq!(gemini_image::generate_image(&down, "gk", "m", "p", &json!({}), &none(), &cancel()).await.unwrap_err().message, "fetch failed");
}

#[test]
fn a_candidate_names_its_failure_before_its_text_and_the_first_inline_image_wins() {
    let parts = vec![json!({"text": "a note"})];
    let error = pick_gemini_image_part(&parts, "Antigravity", Some("prompt blocked (SAFETY)".into()), None).unwrap_err();
    assert_eq!(error.message, "Antigravity returned no image data: prompt blocked (SAFETY)");
    let two = vec![json!({"inlineData": {"data": b64(&png())}}), json!({"inlineData": {"data": b64(b"second")}})];
    assert_eq!(pick_gemini_image_part(&two, "Gemini", None, None).unwrap().bytes, png());
}

// ---- Antigravity ----

struct Session {
    uuids: AtomicUsize,
    auth: Result<AntigravityAuth, AdapterError>,
}

#[async_trait]
impl AntigravitySession for Session {
    async fn auth(&self) -> Result<AntigravityAuth, AdapterError> {
        self.auth.clone()
    }
    fn headers(&self) -> Vec<(String, String)> {
        vec![("X-Client".to_owned(), "antigravity/1".to_owned())]
    }
    fn endpoint(&self) -> String {
        "https://gateway.example".to_owned()
    }
    fn uuid(&self) -> String {
        format!("u{}", self.uuids.fetch_add(1, Ordering::SeqCst) + 1)
    }
}

fn session() -> Session {
    Session { uuids: AtomicUsize::new(0), auth: Ok(AntigravityAuth { token: "at".into(), project_id: "proj".into() }) }
}

fn sse(chunks: &[Value]) -> String {
    chunks.iter().map(|c| format!("data: {c}\n\n")).collect()
}

#[tokio::test]
async fn an_antigravity_image_streams_through_the_gateway_envelope() {
    let body = sse(&[
        json!({"response": {"candidates": [{"content": {"parts": [{"text": "working"}]}}], "usageMetadata": {"promptTokenCount": 1}}}),
        json!({"response": {"candidates": [{"content": {"parts": [{"inlineData": {"mimeType": "image/png", "data": b64(&png())}}]}}], "usageMetadata": {"promptTokenCount": 4, "candidatesTokenCount": 9}}}),
    ]);
    let http = Http::with(vec![answer(200, body)]);
    let image = antigravity_image::generate_image(&http, &session(), "nano-banana", "a fox", &json!({}), &none(), &cancel()).await.unwrap();
    assert_eq!((image.bytes, image.mime.as_str()), (png(), "image/png"));
    let sent = http.sent();
    assert_eq!(sent[0].url, "https://gateway.example/v1internal:streamGenerateContent?alt=sse");
    assert_eq!(
        sent[0].headers,
        vec![
            ("Authorization".to_owned(), "Bearer at".to_owned()),
            ("Content-Type".to_owned(), "application/json".to_owned()),
            ("Accept".to_owned(), "text/event-stream".to_owned()),
            ("X-Client".to_owned(), "antigravity/1".to_owned())
        ]
    );
    let envelope = &sent[0].body;
    assert_eq!(
        (envelope["project"].as_str(), envelope["model"].as_str(), envelope["userAgent"].as_str(), envelope["requestType"].as_str()),
        (Some("proj"), Some("nano-banana"), Some("antigravity"), Some("agent"))
    );
    assert_eq!((envelope["requestId"].as_str(), envelope["request"]["sessionId"].as_str()), (Some("agent-u1"), Some("-u2")));
    assert_eq!(envelope["request"]["contents"][0]["parts"][0], json!({"text": "a fox"}));
}

#[tokio::test]
async fn antigravity_failures_come_from_the_login_the_stream_or_the_status() {
    let signed_out = Session { uuids: AtomicUsize::new(0), auth: Err(AdapterError::plain("sign in")) };
    let http = Http::default();
    assert_eq!(antigravity_image::generate_image(&http, &signed_out, "m", "p", &json!({}), &none(), &cancel()).await.unwrap_err().message, "sign in");
    assert!(http.sent().is_empty(), "nothing is sent without a login");
    let blocked = Http::with(vec![answer(200, sse(&[json!({"response": {"promptFeedback": {"blockReason": "SAFETY"}}})]))]);
    let error = antigravity_image::generate_image(&blocked, &session(), "m", "p", &json!({}), &none(), &cancel()).await.unwrap_err();
    assert_eq!(failure_of(&error), ("Antigravity returned no image data: prompt blocked (SAFETY)", Some("MEDIA_EMPTY_RESULT"), Some(502)));
    let refused = Http::with(vec![answer(503, "later")]);
    let error = antigravity_image::generate_image(&refused, &session(), "m", "p", &json!({}), &none(), &cancel()).await.unwrap_err();
    assert_eq!(error.message, upstream_error("Antigravity image", 503, "later").message);
}

#[test]
fn the_stream_reader_keeps_parts_across_chunks_skips_broken_records_and_takes_the_last_usage() {
    let text = format!(
        "{}data: {{not json\n\n{}{}",
        sse(&[json!({"response": {"candidates": [{"content": {"parts": [{"text": "a"}]}}], "usageMetadata": {"promptTokenCount": 1}}})]),
        sse(&[json!({"candidates": [{"content": {"parts": [{"text": "b"}]}}]})]),
        sse(&[json!({"error": {"message": "overloaded"}}), json!({"response": {"usageMetadata": {"promptTokenCount": 8}}})]),
    );
    let StreamParts { parts, failure, usage } = antigravity_image_parts(&text);
    assert_eq!(parts, vec![json!({"text": "a"}), json!({"text": "b"})]);
    assert_eq!(failure.as_deref(), Some("overloaded"), "an in-band error is the failure");
    assert!(usage.is_some());
    let nothing = antigravity_image_parts("");
    assert_eq!((nothing.parts.len(), nothing.failure, nothing.usage), (0, None, None));
}

// ---- Gemini video (Omni and Veo) ----

#[tokio::test]
async fn gemini_omni_answers_in_one_call_with_the_video_inline() {
    let ok = answer(
        200,
        json!({"steps": [{"content": [{"type": "text"}, {"type": "video", "data": b64(b"webm!"), "mime_type": "video/webm"}]}], "usage": {"total_input_tokens": 4}}),
    );
    let plain = answer(200, json!({"steps": [{"content": {"type": "video", "data": b64(b"mp4!")}}]}));
    let http = Http::with(vec![ok, plain]);
    let public = Public::default();
    let video = gemini_video::generate_video(
        &http,
        &public,
        &Wait::new(1),
        "gk",
        "gemini-omni-flash",
        "a sea",
        &json!({"aspectRatio": "auto"}),
        &none(),
        &cancel(),
        NOP,
    )
    .await
    .unwrap();
    assert_eq!((video.bytes.as_slice(), video.mime.as_str()), (&b"webm!"[..], "video/webm"));
    let single = gemini_video::generate_video(
        &http,
        &public,
        &Wait::new(1),
        "gk",
        "Omni-2",
        "a sea",
        &json!({"aspectRatio": "9:16"}),
        &list(vec![reference("/9j/AA==")]),
        &cancel(),
        NOP,
    )
    .await
    .unwrap();
    assert_eq!((single.bytes.as_slice(), single.mime.as_str()), (&b"mp4!"[..], "video/mp4"));
    let sent = http.sent();
    assert_eq!((sent[0].url.as_str(), sent[0].timeout), ("https://generativelanguage.googleapis.com/v1beta/interactions", Duration::from_secs(600)));
    assert_eq!(
        mixdog_js::json_stringify(&sent[0].body),
        r#"{"model":"gemini-omni-flash","input":"a sea","response_format":{"type":"video","aspect_ratio":"16:9"},"generation_config":{"video_config":{"task":"text_to_video"}}}"#
    );
    assert_eq!(
        mixdog_js::json_stringify(&sent[1].body),
        r#"{"model":"Omni-2","input":[{"type":"image","data":"/9j/AA==","mime_type":"image/jpeg"},{"type":"text","text":"a sea"}],"response_format":{"type":"video","aspect_ratio":"9:16"},"generation_config":{"video_config":{"task":"image_to_video"}}}"#
    );
    assert!(public.asked().is_empty());
}

#[tokio::test]
async fn gemini_omni_without_a_video_or_with_an_error_fails_with_the_reason() {
    let public = Public::default();
    let empty = Http::with(vec![answer(200, json!({"steps": [{"content": [{"type": "text"}]}], "usage": {"total_input_tokens": 4}}))]);
    let error = gemini_video::generate_video(&empty, &public, &Wait::new(1), "gk", "omni", "p", &json!({}), &none(), &cancel(), NOP).await.unwrap_err();
    assert_eq!(failure_of(&error), ("Gemini Omni returned no video data", Some("MEDIA_EMPTY_RESULT"), Some(502)));
    let refused = Http::with(vec![answer(500, "boom")]);
    let error = gemini_video::generate_video(&refused, &public, &Wait::new(1), "gk", "omni", "p", &json!({}), &none(), &cancel(), NOP).await.unwrap_err();
    assert_eq!(error.message, upstream_error("Gemini Omni video", 500, "boom").message);
}

const VEO_URI: &str = "https://generativelanguage.googleapis.com/v1beta/files/abc:download";

fn veo_done(uri: &str) -> Result<PostReply, HttpFailure> {
    answer(200, json!({"done": true, "response": {"generateVideoResponse": {"generatedSamples": [{"video": {"uri": uri}}]}}}))
}

#[tokio::test]
async fn a_veo_video_is_submitted_polled_with_a_heartbeat_and_pulled_with_the_key() {
    let http = Http::with(vec![answer(200, json!({"name": "operations/op1"})), answer(200, json!({"done": false})), veo_done(VEO_URI)]);
    let public = Public::default();
    let media_url = gemini_media_download_url(&json!(VEO_URI)).unwrap();
    public.serve(&media_url, 200, &[], vec![b"veo".to_vec()]);
    let pacer = Wait::new(8_000);
    let seen = Mutex::new(Vec::new());
    let progress = |p: f64| seen.lock().unwrap().push(p);
    let options = json!({"aspectRatio": "auto", "resolution": "1080p", "duration": 6});
    let video = gemini_video::generate_video(
        &http,
        &public,
        &pacer,
        "gk",
        "veo-3.1-generate-preview",
        "a hill",
        &options,
        &list(vec![reference("AAAA")]),
        &cancel(),
        &progress,
    )
    .await
    .unwrap();
    assert_eq!((video.bytes.as_slice(), video.mime.as_str(), video.usage), (&b"veo"[..], "video/mp4", Some(json!({"seconds": 6, "resolution": "1080p"}))));
    assert_eq!(pacer.waits(), vec![8_000, 8_000]);
    assert_eq!(*seen.lock().unwrap(), vec![50.0], "the operation reports no percentage: a coarse heartbeat");
    let sent = http.sent();
    assert_eq!(
        (sent[0].url.as_str(), sent[0].timeout),
        ("https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-generate-preview:predictLongRunning", Duration::from_secs(60))
    );
    assert_eq!(
        mixdog_js::json_stringify(&sent[0].body),
        r#"{"instances":[{"prompt":"a hill","image":{"bytesBase64Encoded":"AAAA","mimeType":"image/png"}}],"parameters":{"aspectRatio":"16:9","resolution":"1080p","durationSeconds":6}}"#
    );
    assert_eq!(sent[1].url, "https://generativelanguage.googleapis.com/v1beta/operations/op1");
    let asked = public.asked.lock().unwrap().clone();
    assert_eq!((asked[0].0.as_str(), asked[0].1.clone()), (media_url.as_str(), vec![("x-goog-api-key".to_owned(), "gk".to_owned())]));
}

#[tokio::test]
async fn veo_drops_a_resolution_or_length_it_does_not_take_and_bills_the_defaults() {
    let http = Http::with(vec![answer(200, json!({"name": "op"})), veo_done(VEO_URI)]);
    let public = Public::default();
    public.serve(&gemini_media_download_url(&json!(VEO_URI)).unwrap(), 200, &[], vec![b"v".to_vec()]);
    let video = gemini_video::generate_video(
        &http,
        &public,
        &Wait::new(1),
        "gk",
        "veo-3",
        "p",
        &json!({"resolution": "480p", "duration": 5, "aspectRatio": "9:16"}),
        &none(),
        &cancel(),
        NOP,
    )
    .await
    .unwrap();
    assert_eq!(http.sent()[0].body["parameters"], json!({"aspectRatio": "9:16"}));
    assert_eq!(video.usage, Some(json!({"seconds": 8, "resolution": "720p"})));
}

#[tokio::test]
async fn veo_failures_name_the_step_that_failed() {
    let public = Public::default();
    let run = |replies: Vec<Result<PostReply, HttpFailure>>| {
        let http = Http::with(replies);
        let public = &public;
        async move { gemini_video::generate_video(&http, public, &Wait::new(1), "gk", "veo-3", "p", &json!({}), &none(), &cancel(), NOP).await.unwrap_err() }
    };
    let error = run(vec![answer(200, json!({}))]).await;
    assert_eq!(failure_of(&error), ("Veo returned no operation name", Some("MEDIA_UPSTREAM_FAILED"), Some(502)));
    let error = run(vec![answer(429, "quota")]).await;
    assert_eq!(error.message, upstream_error("Veo video", 429, "quota").message);
    let error = run(vec![answer(200, json!({"name": "op"})), answer(404, "gone")]).await;
    assert_eq!(error.message, upstream_error("Veo poll", 404, "gone").message);
    let error = run(vec![answer(200, json!({"name": "op"})), answer(200, json!({"done": true, "error": {"message": "unsafe"}}))]).await;
    assert_eq!(failure_of(&error), ("Veo generation failed: unsafe", Some("MEDIA_UPSTREAM_FAILED"), Some(502)));
    let error = run(vec![answer(200, json!({"name": "op"})), answer(200, json!({"done": true, "error": {}}))]).await;
    assert_eq!(error.message, "Veo generation failed: unknown error");
    let error = run(vec![answer(200, json!({"name": "op"})), answer(200, json!({"done": true, "response": {}}))]).await;
    assert_eq!(failure_of(&error), ("Veo finished without a video URI", Some("MEDIA_EMPTY_RESULT"), Some(502)));
    let error = run(vec![answer(200, json!({"name": "op"})), veo_done("https://evil.example/f")]).await;
    assert_eq!(error.message, "Veo returned an untrusted video URI");
}

#[tokio::test]
async fn a_veo_download_that_fails_still_bills_the_generated_seconds() {
    let http = Http::with(vec![answer(200, json!({"name": "op"})), veo_done(VEO_URI)]);
    let public = Public::default();
    public.serve(&gemini_media_download_url(&json!(VEO_URI)).unwrap(), 500, &[], vec![]);
    let error = gemini_video::generate_video(&http, &public, &Wait::new(1), "gk", "veo-3", "p", &json!({}), &none(), &cancel(), NOP).await.unwrap_err();
    assert_eq!(failure_of(&error), ("Veo video download failed (500)", Some("MEDIA_UPSTREAM_FAILED"), Some(500)));
    assert_eq!(error.usage, Some(Box::new(json!({"seconds": 8, "resolution": "720p"}))));
}

#[tokio::test]
async fn a_veo_operation_that_never_completes_runs_out_of_budget() {
    let mut replies = vec![answer(200, json!({"name": "op"}))];
    replies.extend((0..3).map(|_| answer(200, json!({"done": false}))));
    let http = Http::with(replies);
    let error = gemini_video::generate_video(&http, &Public::default(), &Wait::new(400_000), "gk", "veo-3", "p", &json!({}), &none(), &cancel(), NOP)
        .await
        .unwrap_err();
    assert_eq!(failure_of(&error), ("Veo poll budget exceeded", Some("MEDIA_TIMEOUT"), Some(504)));
}

/// A public fetch that never answers.
struct Hang;

#[async_trait]
impl PublicFetch for Hang {
    async fn get(&self, _: &str, _: &[(String, String)], _: &CancellationToken) -> Result<Box<dyn PublicResponse>, AdapterError> {
        std::future::pending().await
    }
}

#[tokio::test]
async fn a_veo_download_that_hangs_runs_out_of_the_generation_budget_and_bills_the_seconds() {
    let http = Http::with(vec![answer(200, json!({"name": "op"})), veo_done(VEO_URI)]);
    let pacer = Wait::new(1);
    let error = gemini_video::generate_video(&http, &Hang, &pacer, "gk", "veo-3", "p", &json!({}), &none(), &cancel(), NOP).await.unwrap_err();
    assert_eq!(error.message, "The operation was aborted due to timeout");
    assert_eq!(error.usage, Some(Box::new(json!({"seconds": 8, "resolution": "720p"}))));
    assert_eq!(pacer.waits.lock().unwrap().last(), Some(&899_999));
}

// ---- ChatGPT (Codex) image ----

struct Codex {
    warmed: AtomicUsize,
    reset: Option<i64>,
    looked_up: Mutex<Vec<String>>,
}

impl Codex {
    fn new(reset: Option<i64>) -> Self {
        Self { warmed: AtomicUsize::new(0), reset, looked_up: Mutex::default() }
    }
}

#[async_trait]
impl CodexSession for Codex {
    async fn auth(&self) -> Result<CodexAuth, AdapterError> {
        Ok(CodexAuth { access_token: "ct".into(), account_id: Some("acct".into()) })
    }
    async fn warm_version(&self) {
        self.warmed.fetch_add(1, Ordering::SeqCst);
    }
    fn user_agent(&self) -> String {
        "ua/1".into()
    }
    fn version_header(&self) -> String {
        "9.9.9".into()
    }
    fn originator(&self) -> String {
        "mixdog".into()
    }
    fn responses_url(&self) -> String {
        "https://chatgpt.com/backend-api/codex/responses".into()
    }
    fn request_id(&self) -> String {
        "rid".into()
    }
    async fn lookup_reset(&self, _: &CodexAuth, limit_id: &str, _: &CancellationToken) -> Option<i64> {
        self.looked_up.lock().unwrap().push(limit_id.to_owned());
        self.reset
    }
}

async fn codex(http: &Http, session: &Codex, options: Value, refs: &References) -> Result<codex_image::CodexImage, AdapterError> {
    codex_image::generate_image(http, session, "gpt-5", "a lamp", &options, refs, &cancel()).await
}

fn event(value: Value) -> String {
    format!("data: {value}\n")
}

#[tokio::test]
async fn the_chatgpt_images_endpoint_is_tried_first_with_the_clients_identity() {
    let usage = json!({"input_tokens": 5, "output_tokens": 9, "output_tokens_details": {"image_tokens": 2}});
    let http = Http::with(vec![answer(200, json!({"data": [{"b64_json": b64(&png())}], "usage": usage}))]);
    let session = Codex::new(None);
    let image = codex(&http, &session, json!({"background": "transparent", "size": "auto"}), &none()).await.unwrap();
    assert_eq!((image.bytes, image.mime, image.actual_model.as_deref(), image.revised_prompt), (png(), "image/png", Some("gpt-image-2"), None));
    assert_eq!(image.usage.as_ref().and_then(|u| u["outputImageTokens"].as_i64()), Some(2));
    assert_eq!(session.warmed.load(Ordering::SeqCst), 1, "the client version is reported before the request");
    let sent = http.sent();
    assert_eq!((sent[0].url.as_str(), sent[0].timeout), ("https://chatgpt.com/backend-api/codex/images/generations", Duration::from_secs(400)));
    let names: Vec<&str> = sent[0].headers.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(names, ["Authorization", "Content-Type", "Accept", "originator", "x-client-request-id", "version", "User-Agent", "ChatGPT-Account-ID"]);
    assert_eq!(
        (header(&sent[0], "Authorization"), header(&sent[0], "version"), header(&sent[0], "ChatGPT-Account-ID")),
        (Some("Bearer ct"), Some("9.9.9"), Some("acct"))
    );
    assert_eq!(
        mixdog_js::json_stringify(&sent[0].body),
        r#"{"prompt":"a lamp","model":"gpt-image-2","size":"auto","quality":"auto","background":"transparent"}"#
    );
}

#[tokio::test]
async fn references_turn_the_request_into_an_edit() {
    let http = Http::with(vec![answer(200, json!({"data": [{"b64_json": b64(&png())}]}))]);
    codex(&http, &Codex::new(None), json!({}), &list(vec![reference("/9j/AA==")])).await.unwrap();
    let sent = http.sent();
    assert_eq!(sent[0].url, "https://chatgpt.com/backend-api/codex/images/edits");
    assert_eq!(
        mixdog_js::json_stringify(&sent[0].body),
        r#"{"images":[{"image_url":"data:image/jpeg;base64,/9j/AA=="}],"prompt":"a lamp","model":"gpt-image-2","size":"auto","quality":"auto"}"#
    );
}

#[tokio::test]
async fn output_settings_the_connection_cannot_honour_are_refused_before_any_request() {
    let http = Http::default();
    let session = Codex::new(None);
    for options in [json!({"size": "1024x1024"}), json!({"quality": "high"}), json!({"resolution": "2K"}), json!({"aspectRatio": "16:9"})] {
        let error = codex(&http, &session, options, &none()).await.unwrap_err();
        assert_eq!(
            failure_of(&error),
            (
                "ChatGPT selects image output settings; explicit size and quality are not supported on this connection.",
                Some("MEDIA_OPTION_UNSUPPORTED"),
                Some(400)
            )
        );
    }
    let error = codex(&http, &session, json!({"background": "red"}), &none()).await.unwrap_err();
    assert_eq!(error.message, "background must be transparent, opaque or auto.");
    assert!(http.sent().is_empty() && session.warmed.load(Ordering::SeqCst) == 0);
}

#[tokio::test]
async fn a_backend_that_does_not_serve_the_images_endpoint_falls_back_to_the_hosted_tool() {
    for first in [answer(404, ""), answer(405, ""), answer(501, ""), answer_with(403, &[("content-type", "text/html")], "<html>")] {
        let stream = [
            event(json!({"type": "response.image_generation_call.partial_image", "partial_image_b64": "AAAA"})),
            event(json!({"type": "response.output_item.done", "item": {"type": "image_generation_call", "result": b64(&png()), "model": "gpt-image-2", "revised_prompt": "a brighter lamp"}})),
            event(json!({"type": "response.completed", "response": {"usage": {"input_tokens": 3, "output_tokens": 4}}})),
            "data: [DONE]\n".to_owned(),
        ]
        .concat();
        let http = Http::with(vec![first, answer(200, stream)]);
        let image = codex(&http, &Codex::new(None), json!({"background": "opaque"}), &list(vec![reference("AAAA")])).await.unwrap();
        assert_eq!((image.bytes, image.revised_prompt.as_deref(), image.actual_model.as_deref()), (png(), Some("a brighter lamp"), Some("gpt-image-2")));
        assert!(image.usage.is_some());
        let sent = http.sent();
        assert_eq!(sent[1].url, "https://chatgpt.com/backend-api/codex/responses");
        assert_eq!(header(&sent[1], "Accept"), Some("text/event-stream"));
        assert_eq!(header(&sent[1], "OpenAI-Beta"), Some("responses=experimental"));
        assert_eq!(
            mixdog_js::json_stringify(&sent[1].body),
            r#"{"model":"gpt-5","stream":true,"store":false,"instructions":"You generate images with the image_generation tool. Call the tool once for the user request; do not ask follow-up questions.","input":[{"type":"message","role":"user","content":[{"type":"input_image","image_url":"data:image/png;base64,AAAA"},{"type":"input_text","text":"a lamp"}]}],"tools":[{"type":"image_generation","background":"opaque"}],"tool_choice":{"type":"image_generation"}}"#
        );
    }
    // A JSON 403 is a real refusal, not a missing route: it is reported and nothing is retried.
    let http = Http::with(vec![answer_with(403, &[("content-type", "application/json")], r#"{"error":"no"}"#)]);
    let error = codex(&http, &Codex::new(None), json!({}), &none()).await.unwrap_err();
    assert_eq!(error.message, upstream_error("ChatGPT image", 403, r#"{"error":"no"}"#).message);
    assert_eq!(http.sent().len(), 1);
}

#[tokio::test]
async fn a_stream_without_a_final_image_says_why() {
    let run = |stream: String| async move {
        let http = Http::with(vec![answer(404, ""), answer(200, stream)]);
        codex(&http, &Codex::new(None), json!({}), &none()).await.unwrap_err()
    };
    let partial = run(event(json!({"type": "response.image_generation_call.partial_image", "partial_image_b64": "AAAA"}))).await;
    assert_eq!(
        failure_of(&partial),
        ("ChatGPT image: generation stopped after a partial preview; no final image was produced", Some("MEDIA_PARTIAL_ONLY"), Some(502))
    );
    let nothing = run(String::new()).await;
    assert_eq!(failure_of(&nothing), ("ChatGPT returned no image data", Some("MEDIA_EMPTY_RESULT"), Some(502)));
    let failed = run(event(json!({"type": "response.failed", "response": {"error": {"message": "boom"}, "usage": {"input_tokens": 3}}}))).await;
    assert_eq!(failed.message, "ChatGPT returned no image data: boom");
    assert!(failed.usage.is_some(), "billed tokens are kept");
    let unfinished = run(format!("{}data: {{\"type\":\"response.output_item.done\"", event(json!({"type": "noise"})))).await;
    assert_eq!(unfinished.message, "ChatGPT returned no image data", "a line still being received is never processed");
}

#[tokio::test]
async fn a_usage_limit_names_its_reset_looked_up_when_the_failure_has_none() {
    let limited = r#"{"error":{"type":"usage_limit_reached","limit_id":"codex_image"}}"#;
    let http = Http::with(vec![answer(429, limited)]);
    let session = Codex::new(Some(1_800_000_000));
    let error = codex(&http, &session, json!({}), &none()).await.unwrap_err();
    assert_eq!(failure_of(&error), ("ChatGPT image: image generation usage limit reached — resets 2027-01-15 08:00 UTC", Some("MEDIA_USAGE_LIMIT"), Some(429)));
    assert_eq!(error.resets_at.as_deref(), Some("2027-01-15T08:00:00.000Z"));
    assert_eq!(*session.looked_up.lock().unwrap(), vec!["codex_image"]);
    let dated = Http::with(vec![answer(429, r#"{"error":{"type":"usage_limit_reached","limit_id":"codex_image","resets_at":1800000900}}"#)]);
    let session = Codex::new(Some(1));
    let error = codex(&dated, &session, json!({}), &none()).await.unwrap_err();
    assert_eq!(error.resets_at.as_deref(), Some("2027-01-15T08:15:00.000Z"));
    assert!(session.looked_up.lock().unwrap().is_empty(), "no lookup when the failure carries the time");
    let unknown = Http::with(vec![answer(429, limited)]);
    let error = codex(&unknown, &Codex::new(None), json!({}), &none()).await.unwrap_err();
    assert_eq!(
        (error.resets_at, error.message.as_str()),
        (None, "ChatGPT image: image generation usage limit reached — try again after the usage window resets")
    );
}

#[test]
fn the_reset_of_an_exhausted_window_is_read_from_the_account_usage_summary() {
    let both = json!({"rate_limit": {"primary_window": {"used_percent": 100, "reset_at": 1800000100}, "secondary_window": {"used_percent": 10, "reset_at": 1800009999}}});
    assert_eq!(limit_reset_from_usage(&both, ""), Some(1_800_000_100), "only a used-up window counts");
    let reached = json!({"rate_limit": {"limit_reached": true, "primary_window": {"used_percent": 50, "reset_at": 1800000100}, "secondary_window": {"used_percent": 60, "reset_at": 1800000500}}});
    assert_eq!(limit_reset_from_usage(&reached, ""), Some(1_800_000_500), "a reached limit takes the latest window");
    assert_eq!(limit_reset_from_usage(&json!({"rate_limit": {"primary_window": {"used_percent": 20, "reset_at": 1}}}), ""), None);
    let extra = json!({
        "rate_limit": {"primary_window": {"used_percent": 100, "reset_at": 1800000100}},
        "additional_rate_limits": [
            {"metered_feature": "codex_other", "rate_limit": {"primary_window": {"used_percent": 100, "reset_at": 1800000200}}},
            {"limit_name": "GPT Image", "rate_limit": {"primary_window": {"used_percent": 100, "reset_at": 1800000300}}},
        ]
    });
    assert_eq!(limit_reset_from_usage(&extra, "codex_other"), Some(1_800_000_200), "the named limit wins");
    assert_eq!(limit_reset_from_usage(&extra, "unknown"), Some(1_800_000_300), "else an image limit");
    assert_eq!(
        limit_reset_from_usage(&json!({"rate_limit": {"primary_window": {"used_percent": 100, "reset_at": 1800000100}}}), "x"),
        Some(1_800_000_100),
        "else the main window"
    );
}

#[tokio::test]
async fn the_reset_lookup_asks_the_usage_endpoint_once_with_the_account_and_gives_up_quietly() {
    let usage = json!({"rate_limit": {"primary_window": {"used_percent": 100, "reset_at": 1800000100}}}).to_string();
    let http = Http::with(vec![answer(200, usage)]);
    let auth = CodexAuth { access_token: "ct".into(), account_id: Some("acct".into()) };
    assert_eq!(chatgpt_limit_reset_at(&http, "ua/1", &auth, "", &cancel()).await, Some(1_800_000_100));
    let sent = http.sent();
    assert_eq!((sent[0].method, sent[0].url.as_str(), sent[0].timeout), ("GET", CHATGPT_USAGE_URL, Duration::from_secs(10)));
    assert_eq!(
        sent[0].headers,
        vec![
            ("Authorization".to_owned(), "Bearer ct".to_owned()),
            ("User-Agent".to_owned(), "ua/1".to_owned()),
            ("ChatGPT-Account-Id".to_owned(), "acct".to_owned())
        ]
    );
    for reply in [answer(500, "x"), answer(200, "not json"), no_answer("fetch failed", false)] {
        let http = Http::with(vec![reply]);
        let alone = CodexAuth { access_token: "ct".into(), account_id: None };
        assert_eq!(chatgpt_limit_reset_at(&http, "ua/1", &alone, "", &cancel()).await, None);
        assert_eq!(http.sent()[0].headers.len(), 2, "no account header without an account");
    }
}

// ---- downloading generated media ----

#[tokio::test]
async fn a_generated_address_is_followed_through_at_most_five_redirects() {
    let public = Public::default();
    public.serve("https://a.example/start", 302, &[("Location", "/next")], vec![]);
    public.serve("https://a.example/next", 301, &[("location", "https://b.example/file.png")], vec![]);
    public.serve("https://b.example/file.png", 200, &[], vec![b"ab".to_vec(), b"cd".to_vec()]);
    let bytes = download_public_media(&public, "https://a.example/start", &Limits::default(), &cancel()).await.unwrap();
    assert_eq!(bytes, b"abcd");
    assert_eq!(public.asked(), vec!["https://a.example/start", "https://a.example/next", "https://b.example/file.png"]);
    assert!(public.asked.lock().unwrap().iter().all(|(_, headers)| headers.is_empty()), "no credential travels");
    let looping = Public::default();
    looping.serve("https://a.example/loop", 302, &[("location", "/loop")], vec![]);
    let error = download_public_media(&looping, "https://a.example/loop", &Limits::default(), &cancel()).await.unwrap_err();
    assert_eq!(failure_of(&error), ("generated media download redirected too many times", Some("MEDIA_UPSTREAM_FAILED"), Some(502)));
    assert_eq!(looping.asked().len(), 6, "the first request and five redirects");
}

#[tokio::test]
async fn a_download_that_fails_or_is_too_big_is_refused_in_the_callers_label() {
    let public = Public::default();
    public.serve("https://a.example/missing", 404, &[], vec![]);
    let error = download_public_media(&public, "https://a.example/missing", &Limits { max_bytes: 10, label: "Grok video" }, &cancel()).await.unwrap_err();
    assert_eq!(failure_of(&error), ("Grok video download failed (404)", Some("MEDIA_UPSTREAM_FAILED"), Some(404)));
    public.serve("https://a.example/advertised", 200, &[("Content-Length", "11")], vec![b"x".to_vec()]);
    let error = download_public_media(&public, "https://a.example/advertised", &Limits { max_bytes: 10, label: "Grok video" }, &cancel()).await.unwrap_err();
    assert_eq!(error.message, "Grok video: response exceeds the 10 byte limit");
    public.serve("https://a.example/streamed", 200, &[], vec![vec![0; 6], vec![0; 6]]);
    let error = download_public_media(&public, "https://a.example/streamed", &Limits { max_bytes: 10, label: "Grok video" }, &cancel()).await.unwrap_err();
    assert_eq!(error.message, "Grok video: response exceeds the 10 byte limit", "the bytes actually read are bounded too");
    public.serve("https://a.example/exact", 200, &[("content-length", "10")], vec![vec![0; 10]]);
    assert_eq!(download_public_media(&public, "https://a.example/exact", &Limits { max_bytes: 10, label: "x" }, &cancel()).await.unwrap().len(), 10);
    let refused = download_public_media(&public, "http://10.0.0.1/x", &Limits::default(), &cancel()).await.unwrap_err();
    assert_eq!(refused.message, "Blocked request to private address: http://10.0.0.1/x");
}

#[tokio::test]
async fn a_response_without_a_body_or_read_after_a_cancel_is_an_error() {
    let mut no_body = Piece { status: 200, headers: vec![], chunks: VecDeque::new(), body: false };
    let error = read_response_buffer(&mut no_body, &Limits { max_bytes: 10, label: "Grok video" }, &cancel()).await.unwrap_err();
    assert_eq!(error.message, "Grok video: response has no body");
    let stopped = cancel();
    stopped.cancel();
    let mut some = Piece { status: 200, headers: vec![], chunks: VecDeque::from([vec![1]]), body: true };
    let error = read_response_buffer(&mut some, &Limits::default(), &stopped).await.unwrap_err();
    assert_eq!(error.message, "This operation was aborted");
}

#[tokio::test]
async fn a_gemini_download_sends_the_key_in_a_header_and_never_follows_a_redirect() {
    let public = Public::default();
    let url = gemini_media_download_url(&json!(VEO_URI)).unwrap();
    public.serve(&url, 200, &[], vec![b"clip".to_vec()]);
    assert_eq!(download_gemini_media(&public, VEO_URI, "gk", &Limits::default(), &cancel()).await.unwrap(), b"clip");
    assert_eq!(public.asked.lock().unwrap()[0].1, vec![("x-goog-api-key".to_owned(), "gk".to_owned())]);
    public.serve(&url, 302, &[("location", "https://evil.example/")], vec![]);
    let error = download_gemini_media(&public, VEO_URI, "gk", &Limits { max_bytes: 5, label: "Veo video" }, &cancel()).await.unwrap_err();
    assert_eq!(failure_of(&error), ("Veo video download redirect was rejected", Some("MEDIA_UPSTREAM_FAILED"), Some(502)));
    public.serve(&url, 403, &[], vec![]);
    let error = download_gemini_media(&public, VEO_URI, "gk", &Limits { max_bytes: 5, label: "Veo video" }, &cancel()).await.unwrap_err();
    assert_eq!(error.message, "Veo video download failed (403)");
    assert_eq!(
        download_gemini_media(&public, "https://evil.example/x", "gk", &Limits::default(), &cancel()).await.unwrap_err().message,
        "Veo returned an untrusted video URI"
    );
}
