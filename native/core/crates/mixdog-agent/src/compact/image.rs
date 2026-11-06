//! Tool-result image compaction (`compactResultImages` in `finalize.mjs`, over
//! `compactToolResultImage` and `supersedingImageMetadataText` in
//! `read-image-resize.mjs`).
//!
//! An inline image of a tool result rides every later request, so it is validated and
//! re-encoded once, as the result enters the transcript. Everything that decides what happens
//! to an image lives here and is checked against Node's own outputs. Decoding, resizing and
//! JPEG encoding are the codec's (Node's is `sharp`): [`ImageCodec`] is that seam, and the
//! bytes a result carries are only as equal to Node's as the codec's encoder.

use std::sync::Arc;

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;

use super::pressure::node_base64;
use crate::offload::ImageCompactor;
use crate::offload::ImageOutcome;

/// `TOOL_IMAGE_TARGET_BASE64_SIZE`: an image whose base64 is no longer is left alone.
const TARGET_BASE64_LEN: usize = 256 * 1024;
/// `TOOL_IMAGE_JPEG_QUALITIES`: tried in order until the base64 fits the target.
const JPEG_QUALITIES: [u8; 3] = [85, 70, 50];
/// `IMAGE_PROFILE_LIMITS.anthropic`.
const MAX_EDGE: f64 = 1568.0;
const PATCH_SIZE: u32 = 28;
const MAX_PATCHES: u64 = 1568;
/// `IMAGE_MIN_DIMENSION`.
const MIN_DIMENSION: f64 = 200.0;
const UNDECODABLE_TEXT: &str = "[image omitted: could not be decoded]";

/// Why the codec gave no answer for an image.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CodecError {
    /// The decoder rejected these bytes (`InvalidImageDataError` whose cause is not the machine's).
    Invalid,
    /// No decoder, or the machine failed (`isEnvironmentError`): the image is not judged and stays.
    /// The text is the host's error when the extension host itself could not answer; `None` is the
    /// decoder's own absence or machine failure, which Node reports with nothing more.
    Environment(Option<String>),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ImageSize {
    pub width: u32,
    pub height: u32,
}

pub struct Encoded {
    pub bytes: Vec<u8>,
    pub size: ImageSize,
}

/// `sharp`'s part of the pipeline.
#[async_trait]
pub trait ImageCodec: Send + Sync {
    /// `decodedImageMeta`: the dimensions after one full pixel decode (a zero is "unknown").
    async fn probe(&self, bytes: &[u8]) -> Result<ImageSize, CodecError>;

    /// `sharp(bytes).resize(width, height, { fit: 'inside', withoutEnlargement: !allow_enlargement })
    /// .flatten({ background: '#ffffff' }).jpeg({ quality })`, with the size it came out at.
    async fn jpeg(&self, bytes: &[u8], width: u32, height: u32, allow_enlargement: bool, quality: u8) -> Result<Encoded, CodecError>;

    /// Whether `resizeImageBuffer(bytes, format)` takes the image (`Ok`) or the decoder rejects it.
    async fn validate(&self, bytes: &[u8], format: &str) -> Result<(), CodecError>;
}

/// `targetDimensions(width, height, 'anthropic')`: the box the model sees the image in and whether
/// a sub-patch image may be scaled up to the floor.
pub fn target_dimensions(original_width: u32, original_height: u32) -> (u32, u32, bool) {
    let (w, h) = (f64::from(original_width), f64::from(original_height));
    let patch_area = f64::from(PATCH_SIZE).powi(2);
    let scale = 1.0_f64.min(MAX_EDGE / w).min(MAX_EDGE / h).min(((MAX_PATCHES as f64 * patch_area) / (w * h)).sqrt());
    let mut width = ((w * scale).floor() as u32).max(1);
    let mut height = ((h * scale).floor() as u32).max(1);
    let mut allow_enlargement = false;
    let shortest = f64::from(width.min(height));
    if shortest < MIN_DIMENSION {
        let upscale = (MIN_DIMENSION / shortest).min(MAX_EDGE / f64::from(width.max(height)));
        if upscale > 1.0 {
            width = ((f64::from(width) * upscale).round() as u32).max(1);
            height = ((f64::from(height) * upscale).round() as u32).max(1);
            allow_enlargement = true;
        }
    }
    let patches = |w: u32, h: u32| u64::from(w.max(1).div_ceil(PATCH_SIZE)) * u64::from(h.max(1).div_ceil(PATCH_SIZE));
    while patches(width, height) > MAX_PATCHES && (width > 1 || height > 1) {
        if width >= height {
            width -= 1;
        } else {
            height -= 1;
        }
    }
    (width, height, allow_enlargement)
}

/// `supersedingImageMetadataText(dims)` for an image whose display size differs from its original.
pub fn superseding_metadata_text(original: ImageSize, display: ImageSize) -> String {
    let scale = mixdog_js::math::to_fixed(f64::from(original.width) / f64::from(display.width), 2);
    format!(
        "[Image: {}x{}, displayed at {}x{}. Multiply coordinates by {scale} to map to the original image.] \
         These display dimensions supersede any earlier display-size annotation for the following image.",
        original.width, original.height, display.width, display.height
    )
}

/// `normalizeFmt`: a missing or empty format reads as png, `jpg` as jpeg.
fn normalize_format(format: Option<&str>) -> String {
    let format = format.filter(|f| !f.is_empty()).map_or_else(|| "png".to_owned(), str::to_lowercase);
    if format == "jpg" { "jpeg".to_owned() } else { format }
}

pub struct ToolImageCompactor {
    codec: Arc<dyn ImageCodec>,
}

impl ToolImageCompactor {
    pub fn new(codec: Arc<dyn ImageCodec>) -> Self {
        Self { codec }
    }

    /// `compactToolResultImage`: `None` when the image is within budget, no re-encodable still,
    /// undecodable, or would not shrink.
    async fn reencode(&self, base64: &str, mime: &str) -> Option<ImageOutcome> {
        if mixdog_js::utf16_len(base64) <= TARGET_BASE64_LEN {
            return None;
        }
        let format = normalize_format(mime.split('/').nth(1));
        if !matches!(format.as_str(), "png" | "jpeg" | "webp") {
            return None;
        }
        let bytes = node_base64(base64);
        let original = self.codec.probe(&bytes).await.ok()?;
        if original.width == 0 || original.height == 0 {
            return None;
        }
        let (width, height, allow_enlargement) = target_dimensions(original.width, original.height);
        let mut encoded = None;
        for quality in JPEG_QUALITIES {
            let next = self.codec.jpeg(&bytes, width, height, allow_enlargement, quality).await.ok()?;
            let fits = next.bytes.len().div_ceil(3) * 4 <= TARGET_BASE64_LEN;
            encoded = Some(next);
            if fits {
                break;
            }
        }
        let encoded = encoded?;
        let data = STANDARD.encode(&encoded.bytes);
        if mixdog_js::utf16_len(&data) >= mixdog_js::utf16_len(base64) {
            return None;
        }
        let note = (original != encoded.size).then(|| superseding_metadata_text(original, encoded.size));
        Some(ImageOutcome::Compacted { data, mime: "image/jpeg".to_owned(), note })
    }

    /// `rejectedImageText`: fixed text for an image no provider can take, `None` for one to keep.
    async fn rejection(&self, base64: &str, mime: &str) -> Option<String> {
        let raw = if mime.is_empty() { "image/png" } else { mime };
        let mime_type = mixdog_js::js_trim(raw.split(';').next().unwrap_or_default()).to_lowercase();
        if !matches!(mime_type.as_str(), "image/png" | "image/jpeg" | "image/gif" | "image/webp") {
            return Some(format!("[image omitted: {mime_type} is not a supported image type]"));
        }
        let bytes = node_base64(base64);
        if bytes.is_empty() {
            return None;
        }
        let format = mime_type.split('/').nth(1).unwrap_or_default();
        match self.codec.validate(&bytes, format).await {
            Err(CodecError::Invalid) => Some(UNDECODABLE_TEXT.to_owned()),
            Ok(()) | Err(CodecError::Environment(_)) => None,
        }
    }
}

#[async_trait]
impl ImageCompactor for ToolImageCompactor {
    async fn compact(&self, data: &str, mime: &str) -> ImageOutcome {
        if let Some(outcome) = self.reencode(data, mime).await {
            return outcome;
        }
        match self.rejection(data, mime).await {
            Some(text) => ImageOutcome::Omitted(text),
            None => ImageOutcome::Keep,
        }
    }
}
