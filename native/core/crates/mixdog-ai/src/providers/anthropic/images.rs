//! The Messages wire's image preparation (`prepareAnthropicImages`, `lib/anthropic-image-input.mjs`), run on every
//! request a Messages engine sends (the API-key and subscription routes, the gateways' and custom Messages engines,
//! Claude on Vertex AI), over the lowered request body (`body.messages`), not the conversation: each inline image is fitted by `resizeImageBuffer` under the `anthropic` profile (the extension
//! host's `sharp`, so the bytes are Node's), a resized one is announced by a text part ahead of it, and an image that
//! cannot be prepared fails the request before anything is sent.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use mixdog_core_api::domain::ext::ImageProfile;
use mixdog_core_api::domain::ext::ProfiledImageResizer;
use mixdog_core_api::domain::ext::ProfiledResizeError;
use mixdog_core_api::domain::ext::ResizedImage;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::FailingImage;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_protocol::ThreadId;
use mixdog_rt::CancellationToken;
use mixdog_rt::CpuBulk;
use mixdog_rt::LaneToken;
use mixdog_rt::Liveness;
use serde_json::Value;
use serde_json::json;
use sha2::Digest as _;
use sha2::Sha256;

/// What a body that carries an image block holds (`"type":"image"`, compact JSON); a body without it is not parsed.
const IMAGE_TYPE: &[u8] = b"\"image\"";

/// `MAX_INPUT_BASE64_SIZE`: 64 MiB of bytes as base64.
const MAX_INPUT_BASE64: usize = (64 * 1024 * 1024_usize).div_ceil(3) * 4;
/// `API_IMAGE_MAX_BASE64_SIZE`.
const API_IMAGE_MAX_BASE64: usize = 5 * 1024 * 1024;
/// `IMAGE_MAX_WIDTH` and `IMAGE_MAX_HEIGHT`.
const MAX_EDGE: u32 = 1568;

/// `AnthropicImagePreparationError.code`; the agent's image-strip recovery reads it (`isInvalidImageCode`).
pub const PREPARATION_FAILED: &str = "ANTHROPIC_IMAGE_PREPARATION_FAILED";
/// `AnthropicImageRuntimeError.code`: the machine cannot resize, which says nothing of the image.
pub const RUNTIME_UNAVAILABLE: &str = "ANTHROPIC_IMAGE_RUNTIME_UNAVAILABLE";

/// `supersedingImageMetadataText(dims)` of an image whose display size differs from its original.
pub fn superseding_metadata_text(original: (u32, u32), display: (u32, u32)) -> String {
    let scale = mixdog_js::math::to_fixed(f64::from(original.0) / f64::from(display.0), 2);
    format!(
        "[Image: {}x{}, displayed at {}x{}. Multiply coordinates by {scale} to map to the original image.] \
         These display dimensions supersede any earlier display-size annotation for the following image.",
        original.0, original.1, display.0, display.1
    )
}

fn local_400(code: &str, message: String) -> ProviderError {
    let mut error = ProviderError::new(ErrorKind::InvalidRequest, DeliveryState::NotSent);
    error.status = Some(400);
    error.code = Some(code.to_owned());
    error.message = message;
    error
}

/// `failing`: the image where Node names it (`failingImageData`: a decoder's rejection and an image still too large; not
/// an empty or over-long one).
fn preparation_failed(path: &str, detail: &str, failing: Option<FailingImage>) -> ProviderError {
    let mut error = local_400(
        PREPARATION_FAILED,
        format!("Anthropic image preparation failed at {path}: {detail}. The original image and conversation were not changed."),
    );
    error.failing_image = failing.map(Box::new);
    error
}

/// The bound on one request's whole image preparation, from the bulk lane's admission to the last answer. Node has none:
/// `resizeImageBuffer` calls `sharp` directly and nothing ends a resize that never returns (a worker that hangs holds the
/// turn). The largest accepted input resizes in 0.13-0.47 s on this machine (cold, 8192 x 8192 px PNG and JPEG, a 4000 x
/// 5600 px 67 MiB PNG; `limitInputPixels` is 64 Mi pixels), so 100 images (the Messages API's cap per request) cost 47 s at
/// worst; 120 s is 2.5 times that. Not the 600 s a model has for its first byte, which says nothing of a resize.
const PREPARATION: Liveness = Liveness::unary(Duration::from_secs(120));

/// What fits the images of a request: the extension host's resizer, and the bulk lane the body is parsed on and the base64
/// of a large image is decoded and hashed on (never on the turn's thread).
#[derive(Clone)]
pub struct ImageFitter {
    resizer: Arc<dyn ProfiledImageResizer>,
    lane: CpuBulk,
}

type Fitted<'a> = Pin<Box<dyn Future<Output = Result<bool, ProviderError>> + Send + 'a>>;

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

impl ImageFitter {
    pub fn new(resizer: Arc<dyn ProfiledImageResizer>, lane: CpuBulk) -> Self {
        Self { resizer, lane }
    }

    /// `None` when the lane never ran the job (full, wedged, or the job was dropped).
    async fn on_lane<R: Send + 'static>(&self, job: impl FnOnce() -> R + Send + 'static) -> Option<R> {
        let cancel = CancellationToken::new();
        let _cancel_on_drop = cancel.clone().drop_guard();
        let handle = self.lane.submit_wait(&cancel, move |_| job()).await.ok()?;
        handle.await.ok()
    }

    /// `prepareAnthropicImages(body.messages)` on the request's lowered wire body, so a location names the image where the
    /// body holds it: a tool's images inside `tool_result`, results merged into one user message, no system message. The
    /// whole preparation (queueing on the lane included) is under [`PREPARATION`]; its expiry reads as a machine that
    /// cannot resize.
    pub async fn fit_wire(&self, request: &ModelRequest, mut wire: WireRequest) -> Result<WireRequest, ProviderError> {
        if !wire.body.windows(IMAGE_TYPE.len()).any(|w| w == IMAGE_TYPE) {
            return Ok(wire);
        }
        let thread = ThreadId::from(request.options.session_id.clone().unwrap_or_default());
        let at = Mutex::new(String::from("messages"));
        let body = std::mem::take(&mut wire.body);
        match PREPARATION.bound_head(self.fit_body(&thread, body, &at)).await {
            Ok(body) => {
                wire.body = body?;
                Ok(wire)
            }
            Err(_) => Err(runtime_unavailable(&at.lock().unwrap())),
        }
    }

    async fn fit_body(&self, thread: &ThreadId, body: Vec<u8>, at: &Mutex<String>) -> Result<Vec<u8>, ProviderError> {
        let parsed = self
            .on_lane(move || match serde_json::from_slice::<Value>(&body) {
                Ok(json) => Ok((json, body)),
                Err(_) => Err(body),
            })
            .await
            .ok_or_else(|| runtime_unavailable("messages"))?;
        let (mut json, body) = match parsed {
            Ok(parsed) => parsed,
            Err(body) => return Ok(body),
        };
        let Some(messages) = json.get_mut("messages").and_then(Value::as_array_mut) else { return Ok(body) };
        let mut changed = false;
        for (index, message) in messages.iter_mut().enumerate() {
            let Some(content) = message.get_mut("content").and_then(Value::as_array_mut) else { continue };
            changed |= self.content(thread, content, format!("messages.{index}.content"), at).await?;
        }
        if !changed {
            return Ok(body);
        }
        let bytes = self.on_lane(move || serde_json::to_vec(&json)).await.ok_or_else(|| runtime_unavailable("messages"))?;
        Ok(bytes.expect("a JSON value serialises"))
    }

    /// `prepareContent`: the parts of one content array, a tool result's own content under its own path.
    fn content<'a>(&'a self, thread: &'a ThreadId, list: &'a mut Vec<Value>, path: String, at: &'a Mutex<String>) -> Fitted<'a> {
        Box::pin(async move {
            let mut changed = false;
            let parts = std::mem::take(list);
            let mut next = Vec::with_capacity(parts.len());
            for (index, mut part) in parts.into_iter().enumerate() {
                let here = format!("{path}.{index}");
                match part.get("type").and_then(Value::as_str) {
                    Some("tool_result") => {
                        if let Some(inner) = part.get_mut("content").and_then(Value::as_array_mut) {
                            changed |= self.content(thread, inner, format!("{here}.content"), at).await?;
                        }
                    }
                    // Remote URLs and file ids stay server-owned.
                    Some("image") if part.pointer("/source/type").and_then(Value::as_str) == Some("base64") => {
                        at.lock().unwrap().clone_from(&here);
                        if let Some(resized) = self.image(thread, &here, &part).await? {
                            changed = true;
                            if (resized.original_w, resized.original_h) != (resized.display_w, resized.display_h) {
                                let text = superseding_metadata_text((resized.original_w, resized.original_h), (resized.display_w, resized.display_h));
                                next.push(json!({ "type": "text", "text": text }));
                            }
                            part["source"]["data"] = Value::String(resized.data_base64);
                            part["source"]["media_type"] = Value::String(resized.mime);
                        }
                    }
                    _ => {}
                }
                next.push(part);
            }
            *list = next;
            Ok(changed)
        })
    }

    /// The resized form of one image block; `None` when it is already as it should be sent.
    async fn image(&self, thread: &ThreadId, path: &str, part: &Value) -> Result<Option<ResizedImage>, ProviderError> {
        let source = &part["source"];
        let Some(data) = source.get("data").and_then(Value::as_str).filter(|d| !d.is_empty() && d.len() <= MAX_INPUT_BASE64) else {
            return Err(preparation_failed(path, "image is empty or exceeds the 64 MiB input limit; use a smaller image", None));
        };
        let mime = source.get("media_type").and_then(Value::as_str).unwrap_or_default();
        let raw = data.to_owned();
        let Some(decoded) = self.on_lane(move || STANDARD.decode(raw)).await else { return Err(runtime_unavailable(path)) };
        let Ok(bytes) = decoded else {
            return Err(self.undecodable(path, data, None).await);
        };
        let bytes = Arc::new(bytes);
        let declared = if mime.is_empty() { "image/png" } else { mime };
        let ext = declared.split('/').nth(1).unwrap_or_default();
        let resized = match self.resizer.resize_profiled(thread, &bytes, ext, ImageProfile::Anthropic).await {
            Ok(Some(resized)) => resized,
            Ok(None) | Err(ProfiledResizeError::Host(_)) => return Err(runtime_unavailable(path)),
            Err(ProfiledResizeError::Invalid(_)) => return Err(self.undecodable(path, data, Some(&bytes)).await),
        };
        if resized.display_w == 0
            || resized.display_h == 0
            || resized.display_w > MAX_EDGE
            || resized.display_h > MAX_EDGE
            || resized.data_base64.len() > API_IMAGE_MAX_BASE64
        {
            let failing = self.failing(data, Some(&bytes)).await;
            return Err(preparation_failed(path, "image still exceeds the supported size; use a smaller image", Some(failing)));
        }
        if resized.data_base64 == data && resized.mime == mime {
            return Ok(None);
        }
        Ok(Some(resized))
    }

    async fn undecodable(&self, path: &str, data: &str, bytes: Option<&Arc<Vec<u8>>>) -> ProviderError {
        let failing = self.failing(data, bytes).await;
        preparation_failed(path, "image could not be decoded; reattach a valid image", Some(failing))
    }

    /// The refused image as the recovery names it: its base64, and the hash of its bytes (the content address of a stored
    /// copy) when they decoded, computed here on the lane so the recovery decodes nothing.
    async fn failing(&self, data: &str, bytes: Option<&Arc<Vec<u8>>>) -> FailingImage {
        let sha256 = match bytes {
            Some(bytes) => {
                let bytes = bytes.clone();
                self.on_lane(move || sha256_hex(&bytes)).await.map(Box::from)
            }
            None => None,
        };
        FailingImage { data: data.into(), sha256 }
    }
}

fn runtime_unavailable(path: &str) -> ProviderError {
    local_400(
        RUNTIME_UNAVAILABLE,
        format!(
            "Anthropic image preparation unavailable at {path}: image resizing is unavailable; repair the sharp runtime. \
             The original image and conversation were not changed."
        ),
    )
}
#[cfg(test)]
mod tests {
    use mixdog_core_api::domain::ext::ExtError;
    use mixdog_core_api::domain::keepalive::TransportKind;
    use mixdog_core_api::domain::provider::RequestOptions;

    use super::*;

    /// A resizer that answers what it is told for every image.
    struct Answer(Result<Option<ResizedImage>, ProfiledResizeError>);

    #[async_trait::async_trait]
    impl ProfiledImageResizer for Answer {
        async fn resize_profiled(&self, _: &ThreadId, _: &[u8], _: &str, profile: ImageProfile) -> Result<Option<ResizedImage>, ProfiledResizeError> {
            assert_eq!(profile, ImageProfile::Anthropic);
            self.0.clone()
        }
    }

    fn resized(data: &str, mime: &str, original: (u32, u32), display: (u32, u32)) -> ResizedImage {
        ResizedImage { data_base64: data.into(), mime: mime.into(), original_w: original.0, original_h: original.1, display_w: display.0, display_h: display.1 }
    }

    fn request() -> ModelRequest {
        ModelRequest { model: "m".into(), messages: Vec::new(), tools: Vec::new(), options: RequestOptions::default() }
    }

    /// The Messages request the codec built: its lowered `messages` array.
    fn wire(messages: &Value) -> WireRequest {
        WireRequest {
            transport: TransportKind::Http1,
            method: "POST".into(),
            url: "http://127.0.0.1:1/v1/messages".into(),
            headers: Vec::new(),
            body: serde_json::to_vec(&json!({ "model": "m", "messages": messages, "stream": true })).unwrap(),
        }
    }

    fn image(data: &str) -> Value {
        json!({ "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": data } })
    }

    fn user(blocks: Value) -> Value {
        json!({ "role": "user", "content": blocks })
    }

    fn fitter(resizer: impl ProfiledImageResizer + 'static) -> ImageFitter {
        ImageFitter::new(Arc::new(resizer), mixdog_rt::testing::tokens().cpu_bulk)
    }

    async fn fit(answer: Result<Option<ResizedImage>, ProfiledResizeError>, messages: &Value) -> Result<Value, ProviderError> {
        let sent = fitter(Answer(answer)).fit_wire(&request(), wire(messages)).await?;
        Ok(serde_json::from_slice::<Value>(&sent.body).unwrap()["messages"].clone())
    }

    fn invalid() -> Result<Option<ResizedImage>, ProfiledResizeError> {
        Err(ProfiledResizeError::Invalid("bad".into()))
    }

    /// A worker that is asked and never answers.
    struct Hang(Arc<tokio::sync::Notify>);

    #[async_trait::async_trait]
    impl ProfiledImageResizer for Hang {
        async fn resize_profiled(&self, _: &ThreadId, _: &[u8], _: &str, _: ImageProfile) -> Result<Option<ResizedImage>, ProfiledResizeError> {
            self.0.notify_one();
            std::future::pending().await
        }
    }

    const RUNTIME_DOWN_AT: &str = "Anthropic image preparation unavailable at ";
    const RUNTIME_DOWN_TAIL: &str = ": image resizing is unavailable; repair the sharp runtime. The original image and conversation were not changed.";

    /// A worker that never answers holds the preparation until its own bound (on the runtime's clock, which moves here
    /// only by `advance`), then the turn is told what Node tells when the machine cannot resize.
    #[tokio::test(start_paused = true)]
    async fn a_worker_that_never_answers_ends_the_preparation_at_its_bound() {
        let asked = Arc::new(tokio::sync::Notify::new());
        let fitter = fitter(Hang(asked.clone()));
        let sent = wire(&json!([user(json!([{ "type": "text", "text": "look" }, image("QUFB")]))]));
        let task = tokio::spawn(async move { fitter.fit_wire(&request(), sent).await });
        asked.notified().await;
        let bound = PREPARATION.head_deadline().unwrap();
        assert_eq!(bound, Duration::from_secs(120));
        tokio::time::advance(bound - Duration::from_millis(1)).await;
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
        assert!(!task.is_finished(), "ended a millisecond before the bound");
        tokio::time::advance(Duration::from_millis(1)).await;
        let error = task.await.unwrap().unwrap_err();
        assert_eq!((error.status, error.code.as_deref(), error.failing_image), (Some(400), Some(RUNTIME_UNAVAILABLE), None));
        assert_eq!(error.message, format!("{RUNTIME_DOWN_AT}messages.0.content.1{RUNTIME_DOWN_TAIL}"));
    }

    /// Answers the first image after the test releases it and never answers the second.
    struct Stalled {
        calls: std::sync::atomic::AtomicUsize,
        asked: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    }

    #[async_trait::async_trait]
    impl ProfiledImageResizer for Stalled {
        async fn resize_profiled(&self, _: &ThreadId, _: &[u8], _: &str, _: ImageProfile) -> Result<Option<ResizedImage>, ProfiledResizeError> {
            if self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                self.asked.notify_one();
                self.release.notified().await;
                return Ok(Some(resized("QUFB", "image/png", (640, 480), (640, 480))));
            }
            std::future::pending().await
        }
    }

    /// The bound is the whole preparation's, not each image's: a first image that took 100 s leaves 20 s for the rest.
    #[tokio::test(start_paused = true)]
    async fn the_bound_covers_the_whole_preparation_not_each_image() {
        let (asked, release) = (Arc::new(tokio::sync::Notify::new()), Arc::new(tokio::sync::Notify::new()));
        let fitter = fitter(Stalled { calls: 0.into(), asked: asked.clone(), release: release.clone() });
        let sent = wire(&json!([user(json!([image("QUFB"), image("QUFC")]))]));
        let task = tokio::spawn(async move { fitter.fit_wire(&request(), sent).await });
        asked.notified().await;
        tokio::time::advance(Duration::from_secs(100)).await;
        release.notify_one();
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
        tokio::time::advance(Duration::from_secs(20) - Duration::from_millis(1)).await;
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
        assert!(!task.is_finished(), "ended before the bound of the whole");
        tokio::time::advance(Duration::from_millis(1)).await;
        let error = task.await.unwrap().unwrap_err();
        assert_eq!(error.message, format!("{RUNTIME_DOWN_AT}messages.0.content.1{RUNTIME_DOWN_TAIL}"));
    }

    /// The body is parsed, decoded and re-serialised on the bulk lane, whose admission is under the bound too: a lane
    /// that takes no job leaves the turn a refusal, and nothing was done on the turn's thread.
    #[tokio::test]
    async fn the_body_is_prepared_on_the_bulk_lane_and_never_on_the_turns_thread() {
        let _refuse = mixdog_rt::testing::refuse_jobs_on_this_thread();
        let error = fitter(Answer(Ok(None))).fit_wire(&request(), wire(&json!([user(json!([image("QUFB")]))]))).await.unwrap_err();
        assert_eq!(error.code.as_deref(), Some(RUNTIME_UNAVAILABLE));
        assert_eq!(error.message, format!("{RUNTIME_DOWN_AT}messages{RUNTIME_DOWN_TAIL}"));
    }

    /// A refusal names the image where the lowered body holds it (`prepareAnthropicImages` over `body.messages`): a tool's
    /// image inside its `tool_result`, results merged into one user message after a text, the system message nowhere.
    #[tokio::test]
    async fn a_refusal_names_the_image_where_the_lowered_body_holds_it() {
        let location = |error: ProviderError| {
            assert_eq!(error.code.as_deref(), Some(PREPARATION_FAILED));
            error.message.strip_prefix("Anthropic image preparation failed at ").unwrap().split_once(':').unwrap().0.to_owned()
        };
        // A user text, then a tool's image merged into the same user message.
        let merged = json!([user(json!([{ "type": "text", "text": "look" }, { "type": "tool_result", "tool_use_id": "t", "content": [image("QUFB")] }]))]);
        assert_eq!(location(fit(invalid(), &merged).await.unwrap_err()), "messages.0.content.1.content.0");
        // Two tool results merged into one user message: the second one's image.
        let two = json!([
            { "role": "assistant", "content": [{ "type": "text", "text": "reading" }] },
            user(json!([
                { "type": "tool_result", "tool_use_id": "a", "content": "ok" },
                { "type": "tool_result", "tool_use_id": "b", "content": [{ "type": "text", "text": "x" }, image("QUFB")] },
            ])),
        ]);
        assert_eq!(location(fit(invalid(), &two).await.unwrap_err()), "messages.1.content.1.content.1");
        // A plain image of a user message.
        let plain = json!([user(json!([{ "type": "text", "text": "look" }, image("QUFB")]))]);
        assert_eq!(location(fit(invalid(), &plain).await.unwrap_err()), "messages.0.content.1");
    }

    /// The refusal carries the image's base64 and, when its bytes decoded, their SHA-256 (the recovery decodes nothing);
    /// its `Debug` is a length and a hash, never megabytes of the user's image.
    #[tokio::test]
    async fn a_refusal_carries_the_image_and_its_hash_and_debug_prints_neither_bytes() {
        use sha2::Digest as _;
        let data = "QUFB".repeat(5000);
        let hash: String = sha2::Sha256::digest(vec![b'A'; 15000]).iter().map(|b| format!("{b:02x}")).collect();
        let error = fit(invalid(), &json!([user(json!([image(&data)]))])).await.unwrap_err();
        let failing = error.failing_image.as_deref().unwrap();
        assert_eq!((&*failing.data, failing.sha256.as_deref()), (data.as_str(), Some(hash.as_str())));
        let too_big = fit(Ok(Some(resized("QkJC", "image/png", (3000, 100), (1569, 52)))), &json!([user(json!([image(&data)]))])).await.unwrap_err();
        assert_eq!(too_big.failing_image.as_deref().unwrap().sha256.as_deref(), Some(hash.as_str()));
        let shown = format!("{error:?}");
        assert!(!shown.contains("QUFBQUFB"), "the image is printed");
        assert!(shown.contains(&hash) && shown.contains("base64_len: 20000"), "{shown}");
        // Not base64 at all: the same refusal, naming the same image, with no hash.
        let error = fit(Ok(None), &json!([user(json!([image("not base64!")]))])).await.unwrap_err();
        let failing = error.failing_image.as_deref().unwrap();
        assert_eq!((&*failing.data, failing.sha256.as_deref()), ("not base64!", None));
    }

    /// A resized image is announced by a text block ahead of it, in the content array it is in (a tool result's own), and
    /// carries the resized bytes; a body no image changes is the very bytes it was.
    #[tokio::test]
    async fn a_resized_image_is_announced_where_it_is_and_an_unchanged_body_is_left_alone() {
        let tool = json!([user(json!([{ "type": "tool_result", "tool_use_id": "t", "content": [image("QUFB")], "is_error": false }]))]);
        let got = fit(Ok(Some(resized("QkJC", "image/png", (1, 1), (200, 200)))), &tool).await.unwrap();
        let note = superseding_metadata_text((1, 1), (200, 200));
        assert_eq!(
            got,
            json!([user(json!([{ "type": "tool_result", "tool_use_id": "t", "content": [{ "type": "text", "text": note }, image("QkJC")], "is_error": false }]))])
        );
        assert!(note.starts_with("[Image: 1x1, displayed at 200x200. Multiply coordinates by 0.01 to map"));
        let plain = wire(&json!([user(json!([image("QUFB")]))]));
        let same = fitter(Answer(Ok(Some(resized("QUFB", "image/png", (640, 480), (640, 480)))))).fit_wire(&request(), plain.clone()).await.unwrap();
        assert_eq!(same.body, plain.body);
        // The same bytes under another format name are a change without an annotation.
        let got = fit(Ok(Some(resized("QUFB", "image/jpeg", (640, 480), (640, 480)))), &json!([user(json!([image("QUFB")]))])).await.unwrap();
        assert_eq!(got, json!([user(json!([{ "type": "image", "source": { "type": "base64", "media_type": "image/jpeg", "data": "QUFB" } }]))]));
    }

    /// An image that cannot be prepared fails the request before it is sent: a decoder's rejection or an image that is
    /// still too large is Node's preparation error, a machine that cannot resize is the runtime error (no strip).
    #[tokio::test]
    async fn an_image_that_cannot_be_prepared_is_refused_with_nodes_error() {
        let messages = json!([user(json!([{ "type": "text", "text": "look" }, image("QUFB")]))]);
        let refused = |error: ProviderError, code: &str, text: &str| {
            assert_eq!((error.status, error.code.as_deref(), error.kind), (Some(400), Some(code), ErrorKind::InvalidRequest));
            assert_eq!(error.message, text);
        };
        refused(
            fit(invalid(), &messages).await.unwrap_err(),
            PREPARATION_FAILED,
            "Anthropic image preparation failed at messages.0.content.1: image could not be decoded; reattach a valid image. The original image and conversation were not changed.",
        );
        refused(
            fit(Ok(Some(resized("QkJC", "image/png", (3000, 100), (1569, 52)))), &messages).await.unwrap_err(),
            PREPARATION_FAILED,
            "Anthropic image preparation failed at messages.0.content.1: image still exceeds the supported size; use a smaller image. The original image and conversation were not changed.",
        );
        let over_cap = fit(Ok(Some(resized(&"A".repeat(API_IMAGE_MAX_BASE64 + 1), "image/jpeg", (10, 10), (200, 200)))), &messages).await.unwrap_err();
        assert_eq!(over_cap.code.as_deref(), Some(PREPARATION_FAILED));
        let empty = fit(Ok(None), &json!([user(json!([image("")]))])).await.unwrap_err();
        assert_eq!((empty.code.as_deref(), empty.failing_image), (Some(PREPARATION_FAILED), None));
        let down = format!("{RUNTIME_DOWN_AT}messages.0.content.1{RUNTIME_DOWN_TAIL}");
        refused(fit(Ok(None), &messages).await.unwrap_err(), RUNTIME_UNAVAILABLE, &down);
        refused(fit(Err(ProfiledResizeError::Host(ExtError::Overloaded)), &messages).await.unwrap_err(), RUNTIME_UNAVAILABLE, &down);
    }
}