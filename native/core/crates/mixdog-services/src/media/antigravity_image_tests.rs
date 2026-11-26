use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine as _;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::adapter_http::{JsonPost, PostReply};
use super::antigravity_image::{self, AntigravityAuth, AntigravitySession};
use super::catalog::{CatalogFailure, catalog_http_code, project_media_models};
use super::catalog_fetch::{Auth, HttpFailure};
use super::download::AdapterError;
use super::gemini_image::{self, pick_gemini_image_part, pick_gemini_image_part_with_finish};
use super::lanes::{CatalogRows, LaneSources, MediaLanes};
use super::provider_layer::antigravity_rows;
use super::references::References;
use super::upstream::{Headers, upstream_error, upstream_error_with_headers};

#[derive(Clone)]
struct Sent {
    body: Value,
}

struct ScriptedHttp {
    replies: Mutex<VecDeque<Result<PostReply, HttpFailure>>>,
    sent: Mutex<Vec<Sent>>,
}

impl ScriptedHttp {
    fn with(replies: Vec<PostReply>) -> Self {
        Self { replies: Mutex::new(replies.into_iter().map(Ok).collect()), sent: Mutex::default() }
    }

    fn sent(&self) -> Vec<Sent> {
        self.sent.lock().unwrap().clone()
    }
}

#[async_trait]
impl JsonPost for ScriptedHttp {
    async fn post(&self, _: &str, _: &[(String, String)], body: &Value, _: Duration, _: &CancellationToken) -> Result<PostReply, HttpFailure> {
        self.sent.lock().unwrap().push(Sent { body: body.clone() });
        self.replies.lock().unwrap().pop_front().expect("scripted reply")
    }

    async fn get(&self, _: &str, _: &[(String, String)], _: Duration, _: &CancellationToken) -> Result<PostReply, HttpFailure> {
        unreachable!("unexpected GET")
    }
}

struct FakeSession;

#[async_trait]
impl AntigravitySession for FakeSession {
    async fn auth(&self) -> Result<AntigravityAuth, AdapterError> {
        Ok(AntigravityAuth { token: "tok".to_owned(), project_id: "proj".to_owned() })
    }

    fn headers(&self) -> Vec<(String, String)> {
        vec![("User-Agent".to_owned(), "antigravity/hub/1.0.0".to_owned())]
    }

    fn endpoint(&self) -> String {
        "https://gateway.example".to_owned()
    }

    fn uuid(&self) -> String {
        "test-uuid".to_owned()
    }
}

fn reply(status: u16, body: impl ToString) -> PostReply {
    PostReply { status, headers: Vec::new(), body: body.to_string() }
}

fn reply_with_headers(status: u16, headers: &[(&str, &str)], body: impl ToString) -> PostReply {
    PostReply { status, headers: headers.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect(), body: body.to_string() }
}

fn sse(chunks: &[Value]) -> String {
    chunks.iter().map(|chunk| format!("data: {chunk}\n\n")).collect()
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn none_refs() -> References {
    References::new(Vec::new(), 3)
}

#[derive(Default)]
struct MockSources {
    models: HashMap<String, Result<CatalogRows, CatalogFailure>>,
}

#[async_trait]
impl LaneSources for MockSources {
    async fn authenticated(&self, lane: &str) -> bool {
        self.models.contains_key(lane)
    }

    async fn models(&self, lane: &str) -> Result<CatalogRows, CatalogFailure> {
        self.models.get(lane).cloned().unwrap_or_else(|| Ok(CatalogRows::default()))
    }
}

#[tokio::test]
async fn picks_last_non_thought_image_part_and_supports_snake_case() {
    let draft = b"draft-thought-bytes";
    let intermediate = b"earlier-final-bytes";
    let final_img = b"final-webp-bytes";
    let stream = sse(&[
        json!({"response": {"candidates": [{"content": {"parts": [
            {"thought": true, "inlineData": {"mimeType": "image/png", "data": b64(draft)}},
            {"inlineData": {"mimeType": "image/jpeg", "data": b64(intermediate)}}
        ]}}]}}),
        json!({"response": {"candidates": [{"content": {"parts": [
            {"thought": true, "inline_data": {"mime_type": "image/png", "data": b64(draft)}},
            {"inline_data": {"mime_type": "image/webp", "data": b64(final_img)}}
        ]}}]}}),
    ]);
    let http = ScriptedHttp::with(vec![reply(200, stream)]);
    let image = antigravity_image::generate_image(&http, &FakeSession, "gemini-3-pro-image", "a mountain", &json!({}), &none_refs(), &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(image.bytes, final_img);
    assert_eq!(image.mime, "image/webp");

    let gemini_body = json!({"candidates": [{"content": {"parts": [
        {"thought": true, "inlineData": {"mimeType": "image/png", "data": b64(draft)}},
        {"inline_data": {"mime_type": "image/jpeg", "data": b64(final_img)}}
    ]}}]});
    let gemini_http = ScriptedHttp::with(vec![reply(200, gemini_body)]);
    let gemini_img = gemini_image::generate_image(&gemini_http, "key", "gemini-3-pro-image", "a mountain", &json!({}), &none_refs(), &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(gemini_img.bytes, final_img);
    assert_eq!(gemini_img.mime, "image/jpeg");

    let thought_only = vec![json!({"thought": true, "inlineData": {"mimeType": "image/png", "data": b64(draft)}})];
    let err = pick_gemini_image_part(&thought_only, "Antigravity", None, None).unwrap_err();
    assert_eq!(err.code.as_deref(), Some("MEDIA_EMPTY_RESULT"));
}

#[tokio::test]
async fn antigravity_envelope_uses_image_gen_request_type_and_omits_session_id() {
    let stream = sse(&[json!({"response": {"candidates": [{"content": {"parts": [{"inlineData": {"mimeType": "image/png", "data": b64(b"img")}}]}}]}})]);
    let http = ScriptedHttp::with(vec![reply(200, stream)]);
    antigravity_image::generate_image(
        &http,
        &FakeSession,
        "gemini-3-pro-image",
        "a fox",
        &json!({"aspectRatio": "3:2"}),
        &none_refs(),
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    let sent = http.sent();
    assert_eq!(sent.len(), 1);
    let body = &sent[0].body;
    assert_eq!(body["requestType"], "image_gen");
    assert_eq!(body["project"], "proj");
    assert_eq!(body["model"], "gemini-3-pro-image");
    assert_eq!(body["userAgent"], "antigravity");
    let request_id = body["requestId"].as_str().unwrap();
    let segments: Vec<&str> = request_id.split('/').collect();
    assert_eq!(segments.len(), 4, "unexpected requestId: {request_id}");
    assert_eq!(segments[0], "image_gen");
    assert!(!segments[1].is_empty() && segments[1].bytes().all(|b| b.is_ascii_digit()), "timestamp segment must be numeric: {request_id}");
    assert_eq!(segments[2], "test-uuid");
    assert_eq!(segments[3], "12");
    assert!(body["request"].get("sessionId").is_none(), "image_gen envelope must not include request.sessionId");
    assert_eq!(body["request"]["generationConfig"]["imageConfig"]["aspectRatio"], "3:2");
}

#[tokio::test]
async fn antigravity_catalog_offers_advertised_image_model_ids_with_first_as_default() {
    let payload = json!({
        "models": {
            "gemini-2.5-flash-image": {"displayName": "Unadvertised Old"},
            "gemini-3-pro-image": {"displayName": "Gemini 3 Pro Image"},
            "gemini-2.5-pro": {"displayName": "Chat Only"}
        },
        "imageGenerationModelIds": [
            "gemini-3.1-flash-image-preview",
            "imagen-4-custom",
            "gemini-3-pro-image"
        ]
    });
    let http = ScriptedHttp::with(vec![reply(200, payload)]);
    let auth = Auth { token: "tok".into(), project_id: Some("proj".into()), ..Auth::default() };
    let rows_val = antigravity_rows(&http, "1.0.0", &auth).await.unwrap();
    let rows = rows_val.as_array().unwrap().clone();
    let projected = project_media_models("antigravity-oauth", &rows);
    let ids: Vec<&str> = projected.image.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, vec!["gemini-3.1-flash-image-preview", "imagen-4-custom", "gemini-3-pro-image"]);

    let mut sources = MockSources::default();
    sources.models.insert("antigravity-oauth".to_owned(), Ok(CatalogRows { rows, warning: None }));
    let views = MediaLanes::new(Arc::new(sources)).list(None).await;
    let agy = views.iter().find(|v| v["id"] == "antigravity-oauth").unwrap();
    assert_eq!(agy["image"]["defaultModel"], "gemini-3.1-flash-image-preview");

    let ids_only_http = ScriptedHttp::with(vec![reply(200, json!({"imageGenerationModelIds": ["imagen-only"]}))]);
    let ids_only = antigravity_rows(&ids_only_http, "1.0.0", &auth).await.unwrap();
    let projected_only = project_media_models("antigravity-oauth", ids_only.as_array().unwrap());
    assert_eq!(projected_only.image.len(), 1);
    assert_eq!(projected_only.image[0].id, "imagen-only");
}

#[tokio::test]
async fn quota_429_reports_rate_limit_with_reset_and_keeps_lane_visible() {
    let quota_body = json!({
        "error": {
            "code": 429,
            "message": "You have exhausted your capacity on this model. Your quota will reset after 2h1m1s.",
            "status": "RESOURCE_EXHAUSTED",
            "details": [{
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                "reason": "QUOTA_EXHAUSTED",
                "metadata": {
                    "quotaResetDelay": "2h1m1s",
                    "quotaResetTimeStamp": "2026-11-26T03:36:00Z"
                }
            }]
        }
    });
    let http = ScriptedHttp::with(vec![reply(429, &quota_body)]);
    let err = antigravity_image::generate_image(&http, &FakeSession, "gemini-3-pro-image", "a fox", &json!({}), &none_refs(), &CancellationToken::new())
        .await
        .unwrap_err();
    assert_eq!(http.sent().len(), 1, "429 must not retry");
    assert_eq!(err.code.as_deref(), Some("MEDIA_RATE_LIMITED"));
    assert_eq!(err.status, Some(429));
    assert!(!err.message.contains("no usable balance"), "must not misclassify quota 429 as billing: {}", err.message);
    assert!(err.message.contains("2h1m1s"), "expected reset delay in message: {}", err.message);
    assert!(err.message.contains("2026-11-26 03:36 UTC"), "expected reset timestamp in message: {}", err.message);
    assert_eq!(err.resets_at.as_deref(), Some("2026-11-26T03:36:00.000Z"));

    let header_http = ScriptedHttp::with(vec![reply_with_headers(429, &[("Retry-After", "45")], "Quota exceeded")]);
    let header_err =
        antigravity_image::generate_image(&header_http, &FakeSession, "gemini-3-pro-image", "a fox", &json!({}), &none_refs(), &CancellationToken::new())
            .await
            .unwrap_err();
    assert_eq!(header_err.code.as_deref(), Some("MEDIA_RATE_LIMITED"));
    assert!(header_err.message.contains("45s"), "expected Retry-After delay in message: {}", header_err.message);

    assert_eq!(catalog_http_code(429, &quota_body.to_string()), "MEDIA_RATE_LIMITED");
    assert_eq!(catalog_http_code(429, r#"{"error":{"message":"Insufficient credits"}}"#), "MEDIA_BILLING_BLOCKED");
    assert_eq!(catalog_http_code(429, r#"{"error":{"code":"insufficient_quota"}}"#), "MEDIA_BILLING_BLOCKED");
    let billing_429 = upstream_error("OpenRouter image", 429, r#"{"error":{"message":"Insufficient credits"}}"#);
    assert_eq!(billing_429.code, "MEDIA_BILLING_BLOCKED");
    assert_eq!(billing_429.status, 429);
    assert!(billing_429.message.contains("Insufficient credits"), "{}", billing_429.message);

    let in_band_stream = sse(&[json!({
        "error": {
            "code": 429,
            "status": "RESOURCE_EXHAUSTED",
            "message": "Quota exceeded"
        }
    })]);
    let in_band_http = ScriptedHttp::with(vec![reply_with_headers(200, &[("Retry-After", "30")], in_band_stream)]);
    let in_band_err =
        antigravity_image::generate_image(&in_band_http, &FakeSession, "gemini-3-pro-image", "a fox", &json!({}), &none_refs(), &CancellationToken::new())
            .await
            .unwrap_err();
    assert_eq!(in_band_err.code.as_deref(), Some("MEDIA_RATE_LIMITED"));
    assert_eq!(in_band_err.status, Some(429));
    assert!(in_band_err.message.contains("30s"), "in-band SSE 429 must preserve Retry-After header: {}", in_band_err.message);

    let catalog_http = ScriptedHttp::with(vec![reply(429, &quota_body)]);
    let auth = Auth { token: "tok".into(), project_id: Some("proj".into()), ..Auth::default() };
    let fetch_err = antigravity_rows(&catalog_http, "1.0.0", &auth).await.unwrap_err();
    assert_eq!(fetch_err.code.as_deref(), Some("MEDIA_RATE_LIMITED"));

    let mut sources = MockSources::default();
    sources.models.insert("antigravity-oauth".to_owned(), Err(fetch_err.failure()));
    let views = MediaLanes::new(Arc::new(sources)).list(None).await;
    let agy = views.iter().find(|v| v["id"] == "antigravity-oauth").expect("429 quota must not hide lane");
    assert_eq!(agy["catalogErrorCode"], "MEDIA_RATE_LIMITED");
}

#[tokio::test]
async fn capacity_503_reports_google_capacity_without_retry() {
    let capacity_body = json!({
        "error": {
            "code": 503,
            "message": "No capacity available for model gemini-3-pro-image on the server",
            "status": "UNAVAILABLE",
            "details": [
                {
                    "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                    "reason": "MODEL_CAPACITY_EXHAUSTED"
                },
                {
                    "@type": "type.googleapis.com/google.rpc.RetryInfo",
                    "retryDelay": "15s"
                }
            ]
        }
    });
    let lane_err = upstream_error("Antigravity image", 503, &capacity_body.to_string());
    assert_eq!(lane_err.code, "MEDIA_CAPACITY_EXHAUSTED");
    assert_eq!(lane_err.status, 503);
    assert!(lane_err.message.contains("Google model capacity exhausted"), "{}", lane_err.message);
    assert!(lane_err.message.contains("15s"), "{}", lane_err.message);

    let http = ScriptedHttp::with(vec![reply(503, &capacity_body)]);
    let err = antigravity_image::generate_image(&http, &FakeSession, "gemini-3-pro-image", "a fox", &json!({}), &none_refs(), &CancellationToken::new())
        .await
        .unwrap_err();
    assert_eq!(http.sent().len(), 1, "503 capacity must not retry");
    assert_eq!(err.code.as_deref(), Some("MEDIA_CAPACITY_EXHAUSTED"));
    assert_eq!(err.status, Some(503));
    assert!(err.message.contains("Google model capacity exhausted"), "{}", err.message);
}

#[tokio::test]
async fn gemini_and_antigravity_controls_include_3_2_and_2_3_only() {
    let mut sources = MockSources::default();
    sources
        .models
        .insert("antigravity-oauth".to_owned(), Ok(CatalogRows { rows: vec![json!({"id": "gemini-3-pro-image", "imageGeneration": true})], warning: None }));
    sources.models.insert(
        "gemini".to_owned(),
        Ok(CatalogRows { rows: vec![json!({"name": "models/gemini-2.5-flash-image", "supportedGenerationMethods": ["generateContent"]})], warning: None }),
    );
    let views = MediaLanes::new(Arc::new(sources)).list(None).await;
    for lane_id in ["antigravity-oauth", "gemini"] {
        let lane = views.iter().find(|v| v["id"] == lane_id).unwrap();
        let controls = &lane["image"]["controls"];
        assert_eq!(controls["aspectRatio"], json!(["auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]), "{lane_id}");
    }
}

#[tokio::test]
async fn safety_finish_reasons_report_safety_block_instead_of_empty_result() {
    for reason in [
        "IMAGE_SAFETY",
        "IMAGE_PROHIBITED_CONTENT",
        "IMAGE_RECITATION",
        "FINISH_REASON_IMAGE_SAFETY",
        "SAFETY",
        "PROHIBITED_CONTENT",
        "BLOCKLIST",
        "SPII",
        "RECITATION",
    ] {
        let stream = sse(&[
            json!({"response": {"candidates": [{"content": {"parts": [{"thought": true, "inlineData": {"mimeType": "image/png", "data": b64(b"draft")}}]}}]}}),
            json!({"response": {"candidates": [{"finishReason": reason}]}}),
        ]);
        let agy_http = ScriptedHttp::with(vec![reply(200, stream)]);
        let agy_err =
            antigravity_image::generate_image(&agy_http, &FakeSession, "gemini-3-pro-image", "prompt", &json!({}), &none_refs(), &CancellationToken::new())
                .await
                .unwrap_err();
        assert_eq!(agy_err.code.as_deref(), Some("MEDIA_SAFETY_BLOCKED"), "{reason}");
        assert!(agy_err.message.contains(reason), "{reason}: {}", agy_err.message);
        assert!(agy_err.message.to_lowercase().contains("safety"), "{reason}: {}", agy_err.message);
        assert!(!agy_err.message.contains("returned no image data"), "{reason}: {}", agy_err.message);

        let gemini_http = ScriptedHttp::with(vec![reply(200, json!({"candidates": [{"finishReason": reason}]}))]);
        let gemini_err =
            gemini_image::generate_image(&gemini_http, "key", "gemini-2.5-flash-image", "prompt", &json!({}), &none_refs(), &CancellationToken::new())
                .await
                .unwrap_err();
        assert_eq!(gemini_err.code.as_deref(), Some("MEDIA_SAFETY_BLOCKED"), "{reason}");
        assert!(gemini_err.message.contains(reason), "{reason}: {}", gemini_err.message);
        assert!(!gemini_err.message.contains("returned no image data"), "{reason}: {}", gemini_err.message);
    }
}

#[tokio::test]
async fn non_thought_text_becomes_revised_prompt_and_thought_text_is_excluded() {
    let stream = sse(&[
        json!({"response": {"candidates": [{"content": {"parts": [{"thought": true, "text": "internal plan"}]}}]}}),
        json!({"response": {"candidates": [{"content": {"parts": [{"text": "A sunlit "}]}}]}}),
        json!({"response": {"candidates": [{"content": {"parts": [{"text": "meadow."}, {"inlineData": {"mimeType": "image/png", "data": b64(b"final")}}]}}]}}),
    ]);
    let agy_http = ScriptedHttp::with(vec![reply(200, stream)]);
    let agy_img =
        antigravity_image::generate_image(&agy_http, &FakeSession, "gemini-3-pro-image", "meadow", &json!({}), &none_refs(), &CancellationToken::new())
            .await
            .unwrap();
    assert_eq!(agy_img.revised_prompt.as_deref(), Some("A sunlit meadow."));

    let gemini_body = json!({"candidates": [{"content": {"parts": [
        {"thought": true, "text": "thinking..."},
        {"text": "Polished watercolor fox."},
        {"inlineData": {"mimeType": "image/png", "data": b64(b"fox")}}
    ]}}]});
    let gemini_http = ScriptedHttp::with(vec![reply(200, gemini_body)]);
    let gemini_img =
        gemini_image::generate_image(&gemini_http, "key", "gemini-2.5-flash-image", "fox", &json!({}), &none_refs(), &CancellationToken::new()).await.unwrap();
    assert_eq!(gemini_img.revised_prompt.as_deref(), Some("Polished watercolor fox."));

    let thought_only_text = vec![json!({"thought": true, "text": "secret reasoning"}), json!({"inlineData": {"mimeType": "image/png", "data": b64(b"img")}})];
    let img = pick_gemini_image_part(&thought_only_text, "Antigravity", None, None).unwrap();
    assert_eq!(img.revised_prompt, None);
}

#[tokio::test]
async fn google_429_billing_mentions_and_g1_credits_classify_as_rate_limited() {
    let billing_mention_429 = json!({
        "error": {
            "code": 429,
            "status": "RESOURCE_EXHAUSTED",
            "message": "You exceeded your current quota, please check your plan and billing details. Please retry in 40s.",
            "details": [
                {"@type": "type.googleapis.com/google.rpc.QuotaFailure", "violations": [{"quotaMetric": "generativelanguage.googleapis.com/generate_content_free_tier_requests"}]},
                {"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "40s"}
            ]
        }
    });
    let err = upstream_error_with_headers("Gemini image", 429, &Headers(&[]), &billing_mention_429.to_string());
    assert_eq!(err.code.as_deref(), Some("MEDIA_RATE_LIMITED"));
    assert_eq!(err.status, Some(429));
    assert!(err.message.contains("40s"), "{}", err.message);
    assert!(!err.message.contains("no usable balance"), "{}", err.message);
    assert_eq!(catalog_http_code(429, &billing_mention_429.to_string()), "MEDIA_RATE_LIMITED");

    // Even without details, Google 429 RESOURCE_EXHAUSTED mentioning billing stays rate-limited.
    let minimal_resource_exhausted = json!({
        "error": {
            "code": 429,
            "status": "RESOURCE_EXHAUSTED",
            "message": "You exceeded your current quota, please check your plan and billing details. Please retry in 40s."
        }
    });
    let err_min = upstream_error("Gemini image", 429, &minimal_resource_exhausted.to_string());
    assert_eq!(err_min.code, "MEDIA_RATE_LIMITED");
    assert!(err_min.message.contains("40s"), "{}", err_min.message);
    assert_eq!(catalog_http_code(429, &minimal_resource_exhausted.to_string()), "MEDIA_RATE_LIMITED");

    let g1_credits = json!({
        "error": {
            "code": 429,
            "status": "RESOURCE_EXHAUSTED",
            "message": "Insufficient G1 credits balance",
            "details": [{
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                "reason": "INSUFFICIENT_G1_CREDITS_BALANCE",
                "metadata": {
                    "quotaResetDelay": "1h30m",
                    "quotaResetTimeStamp": "2026-11-26T06:00:00Z"
                }
            }]
        }
    });
    let g1_err = upstream_error_with_headers("Antigravity image", 429, &Headers(&[]), &g1_credits.to_string());
    assert_eq!(g1_err.code.as_deref(), Some("MEDIA_RATE_LIMITED"));
    assert_eq!(g1_err.status, Some(429));
    assert!(g1_err.message.contains("1h30m"), "{}", g1_err.message);
    assert_eq!(g1_err.resets_at.as_deref(), Some("2026-11-26T06:00:00.000Z"));
    assert_eq!(catalog_http_code(429, &g1_credits.to_string()), "MEDIA_RATE_LIMITED");

    // Genuine billing blocks still classify as MEDIA_BILLING_BLOCKED.
    assert_eq!(upstream_error("Gemini image", 402, "Payment required").code, "MEDIA_BILLING_BLOCKED");
    assert_eq!(catalog_http_code(402, "Payment required"), "MEDIA_BILLING_BLOCKED");
    let billing_disabled = json!({
        "error": {
            "code": 403,
            "status": "PERMISSION_DENIED",
            "message": "This API method requires billing to be enabled.",
            "details": [{"@type": "type.googleapis.com/google.rpc.ErrorInfo", "reason": "BILLING_DISABLED"}]
        }
    });
    assert_eq!(upstream_error("Gemini image", 403, &billing_disabled.to_string()).code, "MEDIA_BILLING_BLOCKED");
    assert_eq!(catalog_http_code(403, &billing_disabled.to_string()), "MEDIA_BILLING_BLOCKED");
    assert_eq!(upstream_error("OpenRouter image", 429, r#"{"error":{"message":"Account suspended"}}"#).code, "MEDIA_BILLING_BLOCKED");
}

#[tokio::test]
async fn model_capacity_exhausted_classifies_across_429_503_529_and_bare_overloads() {
    for status in [429u16, 503, 529] {
        let body = json!({
            "error": {
                "code": status,
                "status": if status == 429 { "RESOURCE_EXHAUSTED" } else { "UNAVAILABLE" },
                "message": "No capacity available for model",
                "details": [
                    {"@type": "type.googleapis.com/google.rpc.ErrorInfo", "reason": "MODEL_CAPACITY_EXHAUSTED"},
                    {"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "20s"}
                ]
            }
        });
        let err = upstream_error_with_headers("Antigravity image", status, &Headers(&[]), &body.to_string());
        assert_eq!(err.code.as_deref(), Some("MEDIA_CAPACITY_EXHAUSTED"), "status={status}");
        assert_eq!(err.status, Some(status));
        assert!(err.message.contains("20s"), "status={status}: {}", err.message);
    }

    for (status, body) in [
        (503u16, r#"{"error":{"code":503,"status":"UNAVAILABLE","message":"The model is overloaded."}}"#),
        (503, "Service Unavailable"),
        (503, ""),
        (529, ""),
        (529, r#"{"error":{"message":"Overloaded"}}"#),
    ] {
        let err = upstream_error("Antigravity image", status, body);
        assert_eq!(err.code, "MEDIA_CAPACITY_EXHAUSTED", "status={status} body={body}");
        assert_eq!(err.status, status);
    }
}

#[tokio::test]
async fn prompt_feedback_safety_block_reasons_return_media_safety_blocked_422() {
    for reason in ["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "IMAGE_SAFETY", "BLOCK_REASON_SAFETY", "BLOCK_REASON_PROHIBITED_CONTENT"] {
        let stream = sse(&[json!({"response": {"promptFeedback": {"blockReason": reason}}})]);
        let agy_http = ScriptedHttp::with(vec![reply(200, stream)]);
        let agy_err =
            antigravity_image::generate_image(&agy_http, &FakeSession, "gemini-3-pro-image", "prompt", &json!({}), &none_refs(), &CancellationToken::new())
                .await
                .unwrap_err();
        assert_eq!(agy_err.code.as_deref(), Some("MEDIA_SAFETY_BLOCKED"), "{reason}");
        assert_eq!(agy_err.status, Some(422), "{reason}");
        assert!(agy_err.message.contains(reason), "{reason}: {}", agy_err.message);

        let gemini_http = ScriptedHttp::with(vec![reply(200, json!({"promptFeedback": {"blockReason": reason}}))]);
        let gemini_err =
            gemini_image::generate_image(&gemini_http, "key", "gemini-2.5-flash-image", "prompt", &json!({}), &none_refs(), &CancellationToken::new())
                .await
                .unwrap_err();
        assert_eq!(gemini_err.code.as_deref(), Some("MEDIA_SAFETY_BLOCKED"), "{reason}");
        assert_eq!(gemini_err.status, Some(422), "{reason}");
        assert!(gemini_err.message.contains(reason), "{reason}: {}", gemini_err.message);
    }

    // Even when a formatted failure string is passed alongside a safety reason, classify as 422 safety block.
    let err = pick_gemini_image_part_with_finish(&[], "Gemini", Some("prompt blocked (SAFETY)".into()), Some("SAFETY"), None).unwrap_err();
    assert_eq!(err.code.as_deref(), Some("MEDIA_SAFETY_BLOCKED"));
    assert_eq!(err.status, Some(422));

    // Non-safety block reasons continue returning MEDIA_EMPTY_RESULT (502).
    let other_http = ScriptedHttp::with(vec![reply(200, json!({"promptFeedback": {"blockReason": "OTHER"}}))]);
    let other_err = gemini_image::generate_image(&other_http, "key", "gemini-2.5-flash-image", "prompt", &json!({}), &none_refs(), &CancellationToken::new())
        .await
        .unwrap_err();
    assert_eq!(other_err.code.as_deref(), Some("MEDIA_EMPTY_RESULT"));
    assert_eq!(other_err.status, Some(502));
}

#[tokio::test]
async fn multiline_sse_frames_and_all_in_band_4xx_5xx_errors_are_classified() {
    let img_b64 = b64(b"multiline-png");
    let multiline_ok = format!(
        "data: {{\r\ndata:   \"response\": {{\r\ndata:     \"candidates\": [{{\"content\": {{\"parts\": [{{\"inlineData\": {{\"mimeType\": \"image/png\", \"data\": \"{img_b64}\"}}}}]}}}}]\r\ndata:   }}\r\ndata: }}\r\n\r\n"
    );
    let ok_http = ScriptedHttp::with(vec![reply(200, multiline_ok)]);
    let img = antigravity_image::generate_image(&ok_http, &FakeSession, "gemini-3-pro-image", "a tree", &json!({}), &none_refs(), &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(img.bytes, b"multiline-png");

    let multiline_403 = "data: {\ndata:   \"error\": {\ndata:     \"code\": 403,\ndata:     \"status\": \"PERMISSION_DENIED\",\ndata:     \"message\": \"Account validation required\",\ndata:     \"details\": [{\"@type\": \"type.googleapis.com/google.rpc.ErrorInfo\", \"reason\": \"VALIDATION_REQUIRED\"}]\ndata:   }\ndata: }\n\n";
    let http_403 = ScriptedHttp::with(vec![reply(200, multiline_403)]);
    let err_403 =
        antigravity_image::generate_image(&http_403, &FakeSession, "gemini-3-pro-image", "a tree", &json!({}), &none_refs(), &CancellationToken::new())
            .await
            .unwrap_err();
    assert_eq!(err_403.code.as_deref(), Some("MEDIA_AUTH_REJECTED"));
    assert_eq!(err_403.status, Some(403));

    for (payload, expected_code, expected_status) in [
        (
            json!({"error": {"code": 403, "status": "PERMISSION_DENIED", "message": "TOS violation", "details": [{"reason": "TOS_VIOLATION"}]}}),
            "MEDIA_AUTH_REJECTED",
            403u16,
        ),
        (json!({"error": {"code": 401, "status": "UNAUTHENTICATED", "message": "Expired token"}}), "MEDIA_AUTH_REJECTED", 401),
        (json!({"error": {"code": 400, "status": "INVALID_ARGUMENT", "message": "Bad aspect ratio"}}), "MEDIA_UPSTREAM_FAILED", 400),
        (json!({"error": {"code": 500, "status": "INTERNAL", "message": "Internal error"}}), "MEDIA_UPSTREAM_FAILED", 500),
        (json!({"error": {"code": 429, "status": "RESOURCE_EXHAUSTED", "details": [{"reason": "MODEL_CAPACITY_EXHAUSTED"}]}}), "MEDIA_CAPACITY_EXHAUSTED", 429),
        (json!({"error": {"status": "UNAVAILABLE", "message": "Model overloaded"}}), "MEDIA_CAPACITY_EXHAUSTED", 503),
        (json!({"error": {"status": "PERMISSION_DENIED", "message": "Denied"}}), "MEDIA_AUTH_REJECTED", 403),
    ] {
        let http = ScriptedHttp::with(vec![reply(200, sse(&[payload]))]);
        let err = antigravity_image::generate_image(&http, &FakeSession, "gemini-3-pro-image", "p", &json!({}), &none_refs(), &CancellationToken::new())
            .await
            .unwrap_err();
        assert_eq!(err.code.as_deref(), Some(expected_code), "status={expected_status} msg={}", err.message);
        assert_eq!(err.status, Some(expected_status), "msg={}", err.message);
    }
}

#[tokio::test]
async fn array_wrapped_streaming_rest_errors_preserve_metadata() {
    let array_429 = json!([{
        "error": {
            "code": 429,
            "status": "RESOURCE_EXHAUSTED",
            "message": "You exceeded your current quota, please check your plan and billing details.",
            "details": [{
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                "reason": "QUOTA_EXHAUSTED",
                "metadata": {
                    "quotaResetDelay": "15m",
                    "quotaResetTimeStamp": "2026-11-26T04:15:00Z"
                }
            }]
        }
    }]);
    let err = upstream_error_with_headers("Antigravity image", 429, &Headers(&[]), &array_429.to_string());
    assert_eq!(err.code.as_deref(), Some("MEDIA_RATE_LIMITED"));
    assert_eq!(err.status, Some(429));
    assert!(err.message.contains("15m"), "{}", err.message);
    assert_eq!(err.resets_at.as_deref(), Some("2026-11-26T04:15:00.000Z"));
    assert_eq!(catalog_http_code(429, &array_429.to_string()), "MEDIA_RATE_LIMITED");

    let array_cap = json!([{
        "error": {
            "code": 429,
            "status": "RESOURCE_EXHAUSTED",
            "message": "No capacity",
            "details": [{"@type": "type.googleapis.com/google.rpc.ErrorInfo", "reason": "MODEL_CAPACITY_EXHAUSTED"}]
        }
    }]);
    let cap_err = upstream_error("Antigravity image", 429, &array_cap.to_string());
    assert_eq!(cap_err.code, "MEDIA_CAPACITY_EXHAUSTED");
    assert_eq!(cap_err.status, 429);
}

#[tokio::test]
async fn authoritative_empty_image_generation_model_ids_returns_zero_models() {
    let auth = Auth { token: "tok".into(), project_id: Some("proj".into()), ..Auth::default() };
    let empty_advertised = json!({
        "models": {
            "gemini-3-pro-image": {"displayName": "Gemini 3 Pro Image"},
            "gemini-2.5-flash-image": {"displayName": "Gemini 2.5 Flash Image"}
        },
        "imageGenerationModelIds": []
    });
    let empty_http = ScriptedHttp::with(vec![reply(200, empty_advertised)]);
    let rows = antigravity_rows(&empty_http, "1.0.0", &auth).await.unwrap();
    assert_eq!(rows, json!([]));
    assert!(project_media_models("antigravity-oauth", rows.as_array().unwrap()).image.is_empty());

    // Absent or null imageGenerationModelIds still falls back to models keys.
    for payload in [
        json!({"models": {"gemini-3-pro-image": {"displayName": "Gemini 3 Pro Image"}}, "imageGenerationModelIds": null}),
        json!({"models": {"gemini-3-pro-image": {"displayName": "Gemini 3 Pro Image"}}}),
    ] {
        let http = ScriptedHttp::with(vec![reply(200, payload)]);
        let fallback_rows = antigravity_rows(&http, "1.0.0", &auth).await.unwrap();
        let projected = project_media_models("antigravity-oauth", fallback_rows.as_array().unwrap());
        assert_eq!(projected.image.len(), 1);
        assert_eq!(projected.image[0].id, "gemini-3-pro-image");
    }

    // Explicit imageGeneration: false on a row prevents regex fallback.
    let explicit_false = project_media_models("antigravity-oauth", &[json!({"id": "gemini-3-pro-image", "imageGeneration": false})]);
    assert!(explicit_false.image.is_empty());
}

#[tokio::test]
async fn duration_retry_after_http_date_and_empty_project_hygiene() {
    let upper_err = upstream_error("Antigravity image", 429, "Your quota will reset after 1H2M3S");
    assert_eq!(upper_err.code, "MEDIA_RATE_LIMITED");
    assert!(upper_err.message.contains("1h2m3s"), "{}", upper_err.message);

    let false_match_err = upstream_error("Antigravity image", 429, "Your quota will reset after 3models");
    assert_eq!(false_match_err.code, "MEDIA_RATE_LIMITED");
    assert!(!false_match_err.message.contains("resets in"), "must not false-match 3m from 3models: {}", false_match_err.message);

    let future = (chrono::Utc::now() + chrono::Duration::seconds(180)).format("%a, %d %b %Y %H:%M:%S GMT").to_string();
    let date_http = ScriptedHttp::with(vec![reply_with_headers(429, &[("Retry-After", &future)], "Quota exceeded")]);
    let date_err =
        antigravity_image::generate_image(&date_http, &FakeSession, "gemini-3-pro-image", "a fox", &json!({}), &none_refs(), &CancellationToken::new())
            .await
            .unwrap_err();
    assert_eq!(date_err.code.as_deref(), Some("MEDIA_RATE_LIMITED"));
    assert!(date_err.message.contains("resets in"), "{}", date_err.message);
    assert!(date_err.resets_at.is_some(), "HTTP-date Retry-After should populate resets_at");

    struct EmptyProjectSession;
    #[async_trait]
    impl AntigravitySession for EmptyProjectSession {
        async fn auth(&self) -> Result<AntigravityAuth, AdapterError> {
            Ok(AntigravityAuth { token: "tok".to_owned(), project_id: "   ".to_owned() })
        }
        fn headers(&self) -> Vec<(String, String)> {
            vec![("User-Agent".to_owned(), "antigravity/hub/1.0.0".to_owned())]
        }
        fn endpoint(&self) -> String {
            "https://gateway.example".to_owned()
        }
        fn uuid(&self) -> String {
            "test-uuid".to_owned()
        }
    }

    let stream = sse(&[json!({"response": {"candidates": [{"content": {"parts": [{"inlineData": {"mimeType": "image/png", "data": b64(b"img")}}]}}]}})]);
    let http = ScriptedHttp::with(vec![reply(200, stream)]);
    antigravity_image::generate_image(&http, &EmptyProjectSession, "gemini-3-pro-image", "a fox", &json!({}), &none_refs(), &CancellationToken::new())
        .await
        .unwrap();
    let sent = http.sent();
    assert!(sent[0].body.get("project").is_none(), "empty project_id must omit project field: {}", sent[0].body);
}
