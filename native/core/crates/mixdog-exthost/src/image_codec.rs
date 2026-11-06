//! `ImageCodec` over the pool: Node's own `sharp` calls, run by a worker, so the bytes are Node's
//! (`media/src/ext-host/image.mjs`). One mechanism for tool-result image compaction (`probe`,
//! `jpeg`, `validate`), the read tool's resize ([`ExtImageCodec::read_resize`]) and the media
//! store's still renditions ([`ExtImageCodec::still_rendition`]). Dropping a future cancels the call.
//!
//! Three outcomes are kept apart. Bytes the decoder rejects are Node's `INVALID_IMAGE_DATA`
//! ([`CodecError::Invalid`], [`ReadResizeError::Invalid`]). No sharp is Node's `null`
//! ([`CodecError::Environment`], `Ok(None)`). A host that is down or cannot answer is neither: the
//! inherent methods carry the [`ExtError`]; the `ImageCodec` ops answer `Environment` carrying its
//! text (and log it), so the image is kept and the caller still sees why.

use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_agent::compact::image::CodecError;
use mixdog_agent::compact::image::Encoded;
use mixdog_agent::compact::image::ImageCodec;
use mixdog_agent::compact::image::ImageSize;
use mixdog_core_api::domain::ext::ExtCall;
use mixdog_core_api::domain::ext::ExtError;
use mixdog_core_api::domain::ext::ExtFrame;
use mixdog_core_api::domain::ext::ExtPool;
use mixdog_core_api::domain::ext::ImageResizeError;
use mixdog_core_api::domain::ext::ImageResizer;
use mixdog_core_api::domain::ext::ResizedImage;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ThreadId;
use serde_json::json;

/// The fairness key of the compaction calls, which have no thread of their own.
const COMPACT_THREAD: &str = "image-codec";

/// `resizeImageBuffer`'s answer for the read tool: the (possibly re-encoded) image and its sizes.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ReadResize {
    /// Base64, as Node returns it.
    pub data_base64: String,
    /// `image/<format>`.
    pub mime: String,
    pub original_w: u32,
    pub original_h: u32,
    pub display_w: u32,
    pub display_h: u32,
}

/// Why the read tool's resize gave no image other than there being no sharp.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum ReadResizeError {
    /// Node's `INVALID_IMAGE_DATA`: the decoder rejected the bytes.
    Invalid,
    /// The host could not do the work: it is down, overloaded, cancelled, crashed, or answered
    /// something that is not an answer. Not a judgement of the image, and not "sharp is absent".
    Host(ExtError),
}

/// A still rendition of the media store (`renditions.mjs` `SPECS`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RenditionVariant {
    /// 512 px longest edge, quality 70.
    Thumb,
    /// 2048 px longest edge, quality 82.
    Display,
}

/// `encodeStill`'s answer.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct StillRendition {
    /// Always `.webp`, as Node returns it.
    pub extension: String,
    pub bytes: Vec<u8>,
}

/// What an image call can end in, besides an answer.
enum Failure {
    Invalid,
    /// No sharp, or the machine failed (`isEnvironmentError`).
    Environment,
    Host(ExtError),
}

fn bad_answer(method: &str) -> ExtError {
    ExtError::Failed { code: "bad_answer".to_owned(), message: format!("{method} answered something that is not an image result") }
}

/// The error a failure other than a host failure becomes where only the host can fail: the worker
/// answered something the method never answers.
fn host_error(failure: Failure) -> ExtError {
    match failure {
        Failure::Host(error) => error,
        Failure::Invalid | Failure::Environment => bad_answer("image"),
    }
}

fn codec_error(failure: Failure) -> CodecError {
    match failure {
        Failure::Invalid => CodecError::Invalid,
        Failure::Environment => CodecError::Environment(None),
        Failure::Host(error) => {
            tracing::warn!(?error, "the image host could not answer; the image is not judged");
            CodecError::Environment(Some(format!("{error:?}")))
        }
    }
}

pub struct ExtImageCodec {
    pool: Arc<dyn ExtPool>,
}

impl ExtImageCodec {
    pub fn new(pool: Arc<dyn ExtPool>) -> Self {
        Self { pool }
    }

    /// The read tool's `resizeImageBuffer(bytes, ext)` end to end, with Node's defaults: the decode
    /// check, the 1568 px edge and 1568-patch limits, the upscale under 200 px, the token budget
    /// and the JPEG q50 and 400x400 q20 fallbacks. `ext` is the extension (`png`, `jpeg`, ...).
    ///
    /// `Ok(None)` only when there is no resizer, Node's `null` (no sharp, or an empty buffer).
    /// `Err(Invalid)` is the decoder rejecting the bytes; `Err(Host(_))` is a host that is down or
    /// cannot answer.
    pub async fn read_resize(&self, thread: &ThreadId, bytes: &[u8], ext: &str) -> Result<Option<ReadResize>, ReadResizeError> {
        let method = "image.resize";
        match self.ask(thread, method, json!({ "data": STANDARD.encode(bytes), "ext": ext })).await {
            Ok(JsonValue::Null) => Ok(None),
            // `resizeImageBuffer` throws for every decoder failure, so the worker never answers
            // "environment" here; if it did, that is not an answer.
            Ok(ok) => read_resized(&ok).map(Some).ok_or_else(|| ReadResizeError::Host(bad_answer(method))),
            Err(Failure::Invalid) => Err(ReadResizeError::Invalid),
            Err(other) => Err(ReadResizeError::Host(host_error(other))),
        }
    }

    /// The media store's `encodeStill`: the webp rendition of a still, EXIF-rotated, at the
    /// variant's size and quality. `Ok(None)` is Node's `null`: no sharp, or a source that does not
    /// decode (Node does not tell them apart). `Err` is a host that could not answer.
    pub async fn still_rendition(
        &self,
        thread: &ThreadId,
        bytes: &[u8],
        variant: RenditionVariant,
    ) -> Result<Option<StillRendition>, ExtError> {
        let method = "image.still";
        let variant = match variant {
            RenditionVariant::Thumb => "thumb",
            RenditionVariant::Display => "display",
        };
        let ok = match self.ask(thread, method, json!({ "data": STANDARD.encode(bytes), "variant": variant })).await {
            Ok(ok) => ok,
            // Node's `encodeStill` has no third outcome: it answers `null` for these.
            Err(Failure::Invalid | Failure::Environment) => return Ok(None),
            Err(Failure::Host(error)) => return Err(error),
        };
        if ok.is_null() {
            return Ok(None);
        }
        let parsed = ok
            .get("extension")
            .and_then(JsonValue::as_str)
            .zip(ok.get("data").and_then(JsonValue::as_str).and_then(|d| STANDARD.decode(d).ok()))
            .map(|(extension, bytes)| StillRendition { extension: extension.to_owned(), bytes });
        parsed.map(Some).ok_or_else(|| bad_answer(method))
    }

    /// The answer's `ok`, or the way the call failed.
    async fn ask(&self, thread: &ThreadId, method: &str, params: JsonValue) -> Result<JsonValue, Failure> {
        let mut stream = self
            .pool
            .call(ExtCall { thread: thread.clone(), method: method.to_owned(), params, paths: Vec::new() })
            .map_err(Failure::Host)?;
        let answer = loop {
            match stream.next().await {
                Some(ExtFrame::Chunk(_)) => {}
                Some(ExtFrame::Done(outcome)) => break outcome.map_err(Failure::Host)?,
                None => return Err(Failure::Host(ExtError::UnknownWorker)),
            }
        };
        match answer.get("error").and_then(JsonValue::as_str) {
            Some("invalid") => Err(Failure::Invalid),
            Some(_) => Err(Failure::Environment),
            None => answer.get("ok").cloned().ok_or_else(|| Failure::Host(bad_answer(method))),
        }
    }

    fn compact_thread() -> ThreadId {
        ThreadId::from(COMPACT_THREAD)
    }
}

fn size(value: &JsonValue, width: &str, height: &str) -> Option<ImageSize> {
    Some(ImageSize { width: u32::try_from(value.get(width)?.as_u64()?).ok()?, height: u32::try_from(value.get(height)?.as_u64()?).ok()? })
}

fn read_resized(ok: &JsonValue) -> Option<ReadResize> {
    let dimensions = ok.get("dimensions")?;
    let original = size(dimensions, "originalWidth", "originalHeight")?;
    let display = size(dimensions, "displayWidth", "displayHeight")?;
    Some(ReadResize {
        data_base64: ok.get("data")?.as_str()?.to_owned(),
        mime: ok.get("mimeType")?.as_str()?.to_owned(),
        original_w: original.width,
        original_h: original.height,
        display_w: display.width,
        display_h: display.height,
    })
}

#[async_trait::async_trait]
impl ImageResizer for ExtImageCodec {
    async fn resize(&self, thread: &ThreadId, bytes: &[u8], ext: &str) -> Result<Option<ResizedImage>, ImageResizeError> {
        match self.read_resize(thread, bytes, ext).await {
            Ok(resized) => Ok(resized.map(|r| ResizedImage {
                data_base64: r.data_base64,
                mime: r.mime,
                original_w: r.original_w,
                original_h: r.original_h,
                display_w: r.display_w,
                display_h: r.display_h,
            })),
            Err(ReadResizeError::Invalid) => Err(ImageResizeError::Invalid),
            Err(ReadResizeError::Host(error)) => Err(ImageResizeError::Host(error)),
        }
    }
}

#[async_trait::async_trait]
impl ImageCodec for ExtImageCodec {
    async fn probe(&self, bytes: &[u8]) -> Result<ImageSize, CodecError> {
        let method = "image.probe";
        let ok = self.ask(&Self::compact_thread(), method, json!({ "data": STANDARD.encode(bytes) })).await.map_err(codec_error)?;
        size(&ok, "width", "height").ok_or_else(|| codec_error(Failure::Host(bad_answer(method))))
    }

    async fn jpeg(&self, bytes: &[u8], width: u32, height: u32, allow_enlargement: bool, quality: u8) -> Result<Encoded, CodecError> {
        let params = json!({
            "data": STANDARD.encode(bytes),
            "width": width,
            "height": height,
            "allowEnlargement": allow_enlargement,
            "quality": quality,
        });
        let method = "image.jpeg";
        let malformed = || codec_error(Failure::Host(bad_answer(method)));
        let ok = self.ask(&Self::compact_thread(), method, params).await.map_err(codec_error)?;
        let data = ok.get("data").and_then(JsonValue::as_str).ok_or_else(malformed)?;
        Ok(Encoded {
            bytes: STANDARD.decode(data).map_err(|_| malformed())?,
            size: size(&ok, "width", "height").ok_or_else(malformed)?,
        })
    }

    async fn validate(&self, bytes: &[u8], format: &str) -> Result<(), CodecError> {
        let params = json!({ "data": STANDARD.encode(bytes), "format": format });
        self.ask(&Self::compact_thread(), "image.validate", params).await.map_err(codec_error)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::domain::common::EventSource;
    use mixdog_core_api::domain::ext::ExtWorkerId;
    use mixdog_core_api::domain::ext::ExtWorkerStatus;

    use super::*;

    struct One(Option<ExtFrame>);

    #[async_trait::async_trait]
    impl EventSource<ExtFrame> for One {
        async fn next(&mut self) -> Option<ExtFrame> {
            self.0.take()
        }
    }

    struct Scripted(Result<JsonValue, ExtError>);

    impl ExtPool for Scripted {
        fn call(&self, _: ExtCall) -> Result<Box<dyn EventSource<ExtFrame>>, ExtError> {
            Ok(Box::new(One(Some(ExtFrame::Done(self.0.clone())))))
        }
        fn status(&self) -> Vec<ExtWorkerStatus> {
            Vec::new()
        }
        fn stop_worker(&self, _: ExtWorkerId) -> Result<(), ExtError> {
            Err(ExtError::UnknownWorker)
        }
    }

    fn codec(answer: Result<JsonValue, ExtError>) -> ExtImageCodec {
        ExtImageCodec::new(Arc::new(Scripted(answer)))
    }

    fn bad_answer_error(method: &str) -> ReadResizeError {
        ReadResizeError::Host(bad_answer(method))
    }

    #[tokio::test]
    async fn no_sharp_is_none_for_the_read_resize_and_environment_for_the_ops() {
        let thread = ThreadId::from("t");
        // Node's `null`: the only time the read tool sees "sharp is absent".
        assert_eq!(codec(Ok(json!({ "ok": null }))).read_resize(&thread, b"x", "png").await, Ok(None));
        let absent = codec(Ok(json!({ "error": "environment" })));
        assert_eq!(absent.probe(b"x").await, Err(CodecError::Environment(None)));
        assert_eq!(absent.validate(b"x", "png").await, Err(CodecError::Environment(None)));
        assert_eq!(absent.jpeg(b"x", 1, 1, false, 85).await.err(), Some(CodecError::Environment(None)));
    }

    #[tokio::test]
    async fn a_host_that_cannot_answer_is_a_host_error_never_sharp_absent() {
        let thread = ThreadId::from("t");
        for failure in [
            ExtError::UnknownWorker,
            ExtError::Overloaded,
            ExtError::Cancelled,
            ExtError::HostExited { exit: mixdog_core_api::domain::ext::ExtExit::Code(1) },
            ExtError::Unavailable { reason: "no node".into() },
            ExtError::Failed { code: "EIO".into(), message: "boom".into() },
        ] {
            let dead = codec(Err(failure.clone()));
            let text = Some(format!("{failure:?}"));
            assert_eq!(dead.read_resize(&thread, b"x", "png").await, Err(ReadResizeError::Host(failure.clone())));
            assert_eq!(dead.still_rendition(&thread, b"x", RenditionVariant::Thumb).await, Err(failure));
            // The image is not judged, and the caller gets the host's error text.
            assert_eq!(dead.probe(b"x").await, Err(CodecError::Environment(text.clone())));
            assert_eq!(dead.validate(b"x", "png").await, Err(CodecError::Environment(text)));
        }
        // A stream that ends without an answer is a dead worker too.
        struct Silent;
        impl ExtPool for Silent {
            fn call(&self, _: ExtCall) -> Result<Box<dyn EventSource<ExtFrame>>, ExtError> {
                Ok(Box::new(One(None)))
            }
            fn status(&self) -> Vec<ExtWorkerStatus> {
                Vec::new()
            }
            fn stop_worker(&self, _: ExtWorkerId) -> Result<(), ExtError> {
                Err(ExtError::UnknownWorker)
            }
        }
        let silent = ExtImageCodec::new(Arc::new(Silent));
        assert_eq!(silent.read_resize(&thread, b"x", "png").await, Err(ReadResizeError::Host(ExtError::UnknownWorker)));
    }

    #[tokio::test]
    async fn a_decoder_rejection_is_invalid_and_a_malformed_answer_is_a_host_error() {
        let thread = ThreadId::from("t");
        let invalid = codec(Ok(json!({ "error": "invalid" })));
        assert_eq!(invalid.probe(b"x").await, Err(CodecError::Invalid));
        assert_eq!(invalid.read_resize(&thread, b"x", "png").await, Err(ReadResizeError::Invalid));
        assert_eq!(
            codec(Ok(json!({ "ok": { "width": 3 } }))).probe(b"x").await,
            Err(CodecError::Environment(Some(format!("{:?}", bad_answer("image.probe")))))
        );
        assert_eq!(
            codec(Ok(json!({ "ok": { "data": "AA==" } }))).read_resize(&thread, b"x", "png").await,
            Err(bad_answer_error("image.resize"))
        );
        assert_eq!(
            codec(Ok(json!({}))).read_resize(&thread, b"x", "png").await,
            Err(bad_answer_error("image.resize"))
        );
    }

    #[tokio::test]
    async fn the_resizer_trait_maps_every_outcome_unchanged() {
        let thread = ThreadId::from("t");
        let answer = json!({ "ok": {
            "data": "AA==", "mimeType": "image/png",
            "dimensions": { "originalWidth": 3, "originalHeight": 4, "displayWidth": 5, "displayHeight": 6 },
        } });
        let want = ResizedImage { data_base64: "AA==".into(), mime: "image/png".into(), original_w: 3, original_h: 4, display_w: 5, display_h: 6 };
        assert_eq!(codec(Ok(answer)).resize(&thread, b"x", "png").await, Ok(Some(want)));
        assert_eq!(codec(Ok(json!({ "ok": null }))).resize(&thread, b"x", "png").await, Ok(None));
        assert_eq!(codec(Ok(json!({ "error": "invalid" }))).resize(&thread, b"x", "png").await, Err(ImageResizeError::Invalid));
        let down = ExtError::Overloaded;
        assert_eq!(codec(Err(down.clone())).resize(&thread, b"x", "png").await, Err(ImageResizeError::Host(down)));
    }

    #[tokio::test]
    async fn a_still_rendition_is_the_webp_or_nodes_null_or_a_host_error() {
        let thread = ThreadId::from("t");
        let got = codec(Ok(json!({ "ok": { "extension": ".webp", "data": "AQID" } })))
            .still_rendition(&thread, b"x", RenditionVariant::Display)
            .await;
        assert_eq!(got, Ok(Some(StillRendition { extension: ".webp".into(), bytes: vec![1, 2, 3] })));
        assert_eq!(codec(Ok(json!({ "ok": null }))).still_rendition(&thread, b"x", RenditionVariant::Thumb).await, Ok(None));
        let partial = codec(Ok(json!({ "ok": { "extension": ".webp" } })));
        assert_eq!(partial.still_rendition(&thread, b"x", RenditionVariant::Thumb).await, Err(bad_answer("image.still")));
    }
}
