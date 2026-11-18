//! The image codec behind the `image.*` methods and the read tool: what sharp (libvips) did for
//! `src/ext-host/image.mjs` and `runtime/shared/read-image-resize.mjs`, in Rust, with no Node and no native addon.
//!
//! * [`resize_image_buffer`] is `resizeImageBuffer`: decode once (every pixel, so a corrupt stream is refused), fit
//!   the image into the profile's edge and patch limits (only when it is over them or over the 3.75 MB raw target),
//!   keep its format, and when the result still costs more than the token budget re-encode it as JPEG q50, then as a
//!   400x400 JPEG q20. Results are cached (64 MiB, least recently used).
//! * [`probe`] is `decodedImageMeta`, [`validate`] is "does the decoder take it", and
//!   [`tool_jpeg::encode_tool_image_jpeg`] / [`tool_jpeg::compact_tool_result_image`] are the tool-result
//!   compaction.
//!
//! Every failure is an [`ImagingError`]: the decoder rejected the bytes (with libvips's sentence), or the machine
//! could not do the work (there is no encoder for the format, or memory ran out).

pub mod avif;
pub mod cache;
mod color;
pub mod decode;
pub mod encode;
pub mod error;
pub mod format_table;
mod heif;
pub mod jpeg_enc;
pub mod policy;
pub mod resize;
pub mod still;
pub mod svg_limits;
pub mod tool_jpeg;
pub mod os_heic;
pub mod validate;

pub use cache::CacheStats;
pub use cache::image_resize_cache_stats;
pub use color::rgb_to_srgb;
pub use decode::DECODE_PIXEL_LIMIT;
pub use decode::DEFAULT_PIXEL_LIMIT;
pub use decode::Decoded;
pub use decode::Format;
pub use decode::Raster;
pub use decode::decode;
pub use decode::decoded_dimensions;
pub use error::ErrorClass;
pub use error::ImagingError;
pub use policy::DEFAULT_IMAGE_MAX_TOKENS;
pub use policy::Dimensions;
pub use policy::Profile;
pub use policy::image_metadata_text;
pub use policy::image_profile_for_provider;
pub use policy::openai_image_patch_count;
pub use policy::superseding_image_metadata_text;
pub use tool_jpeg::CompactedImage;
pub use tool_jpeg::EncodedJpeg;
pub use tool_jpeg::compact_tool_result_image;
pub use tool_jpeg::encode_tool_image_jpeg;

use crate::cache::recall;
use crate::cache::remember;
use crate::cache::resize_cache_key;
use crate::encode::encode_in_format;
use crate::encode::encode_jpeg;
use crate::policy::IMAGE_TARGET_RAW_SIZE;
use crate::policy::est_tokens_of_bytes;
use crate::policy::js_round;
use crate::policy::target_dimensions;
use crate::resize::fit_inside;

/// How a rendition came to be, so the token gate can be told from a plain resize (the twin corpus checks it).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Branch {
    /// The input bytes, unchanged: the image already fit.
    Original,
    /// Resized, or re-encoded because it was over the raw-size target, in its own format.
    Rendition,
    /// Over the token budget: JPEG q50 at the display size.
    TokenJpeg,
    /// Still over the budget: the 400x400 JPEG q20 fallback.
    TokenFallback,
}

/// `resizeImageBuffer`'s answer.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Resized {
    /// The image bytes (Node returns them as base64).
    pub data: Vec<u8>,
    /// The media type of `data`: one of `image/png`, `image/jpeg`, `image/gif`, `image/webp`.
    pub mime: String,
    pub dimensions: Dimensions,
    pub branch: Branch,
}

/// The options of `resizeImageBuffer`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct ResizeOptions {
    /// The token budget of the image (`maxTokens`).
    pub max_tokens: u64,
    pub profile: Profile,
}

impl Default for ResizeOptions {
    fn default() -> Self {
        Self { max_tokens: DEFAULT_IMAGE_MAX_TOKENS, profile: Profile::Anthropic }
    }
}

/// An image on its way to being the answer.
struct Rendition {
    data: Vec<u8>,
    media_type: String,
    display: (u32, u32),
    branch: Branch,
}

/// The rendition inside the profile's target box. Trimming the edges separately can leave a box the picture does not
/// fill (`fit: 'inside'` keeps the aspect ratio), so what came out is reported, not what was asked for: the metadata
/// line and its coordinate scale are read as the truth about this image.
fn render_rendition(bytes: &[u8], decoded: &Decoded, profile: Profile) -> Result<Rendition, ImagingError> {
    let target = target_dimensions(decoded.width, decoded.height, profile);
    let needs_resize = target.width != decoded.width || target.height != decoded.height;
    // A provider takes PNG, JPEG, GIF or WebP: an image in any other format (markup, TIFF, AVIF) is never handed on
    // as it is but as the PNG of its pixels, and the media type names what is written.
    let carried = decoded.format.carried_as();
    if needs_resize || carried != decoded.format || bytes.len() as u64 > IMAGE_TARGET_RAW_SIZE {
        let resized = fit_inside(&decoded.raster, target.width, target.height, !target.allow_enlargement);
        let data = encode_in_format(&resized, carried)?;
        return Ok(Rendition { data, media_type: carried.media_type().to_owned(), display: (resized.width, resized.height), branch: Branch::Rendition });
    }
    Ok(Rendition { data: bytes.to_vec(), media_type: decoded.format.media_type().to_owned(), display: (decoded.width, decoded.height), branch: Branch::Original })
}

/// The token-budget gate: recompress to JPEG q50 at the (already resized) display size, then the 400x400 JPEG q20
/// hard fallback.
fn fit_to_token_budget(decoded: &Decoded, rendition: &mut Rendition, max_tokens: u64) {
    let (display_width, display_height) = rendition.display;
    let at_display = fit_inside(&decoded.raster, display_width, display_height, true);
    rendition.data = encode_jpeg(&at_display, 50, 0);
    rendition.media_type = Format::Jpeg.media_type().to_owned();
    rendition.display = (at_display.width, at_display.height);
    rendition.branch = Branch::TokenJpeg;
    if est_tokens_of_bytes(rendition.data.len()) <= max_tokens {
        return;
    }
    let fallback = fit_inside(&decoded.raster, 400, 400, true);
    rendition.data = encode_jpeg(&fallback, 20, 0);
    let scale = (400.0 / f64::from(decoded.width)).min(400.0 / f64::from(decoded.height)).min(1.0);
    let scaled = |side: u32| (js_round(f64::from(side) * scale).max(1.0)) as u32;
    rendition.display = (scaled(decoded.width), scaled(decoded.height));
    rendition.branch = Branch::TokenFallback;
}

fn resize_uncached(bytes: &[u8], options: ResizeOptions) -> Result<Resized, ImagingError> {
    let decoded = decode(bytes, DECODE_PIXEL_LIMIT)?;
    let mut rendition = render_rendition(bytes, &decoded, options.profile)?;
    if est_tokens_of_bytes(rendition.data.len()) > options.max_tokens {
        fit_to_token_budget(&decoded, &mut rendition, options.max_tokens);
    }
    Ok(Resized {
        mime: rendition.media_type,
        dimensions: Dimensions {
            original_width: decoded.width,
            original_height: decoded.height,
            display_width: rendition.display.0,
            display_height: rendition.display.1,
        },
        branch: rendition.branch,
        data: rendition.data,
    })
}

/// `resizeImageBuffer(buffer, ext, { maxTokens, profile })`. `Ok(None)` for an empty buffer, as Node's `null`. A
/// failure of any step is the decoder's judgement of the payload (an `InvalidImageDataError`: passing the original
/// bytes through would poison the conversation and make every later request 400), and carries the class of its
/// cause.
pub fn resize_image_buffer(bytes: &[u8], ext: &str, options: ResizeOptions) -> Result<Option<Resized>, ImagingError> {
    if bytes.is_empty() {
        return Ok(None);
    }
    let key = resize_cache_key(bytes, ext, options.max_tokens, options.profile);
    if let Some(cached) = recall(&key) {
        return Ok(Some(cached));
    }
    let result = resize_uncached(bytes, options).map_err(ImagingError::wrapped)?;
    remember(key, &result);
    Ok(Some(result))
}

/// `imageBlocksFromBuffer`'s answer: the image block, with the metadata line that precedes it.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ImageBlocks {
    /// `imageMetadataText` of the sizes (and the source path), when there is one.
    pub text: Option<String>,
    pub data: Vec<u8>,
    pub mime: String,
}

/// `imageBlocksFromBuffer`, used by the notebook reader to embed cell-output images: the resized image and its
/// metadata line, or `None` when there is no image to embed (an empty buffer, or a decoder that rejects the bytes).
pub fn image_blocks_from_buffer(bytes: &[u8], mime_type: &str, source_path: Option<&str>, max_tokens: Option<u64>) -> Option<ImageBlocks> {
    let ext = mime_type.split('/').nth(1).filter(|ext| !ext.is_empty()).unwrap_or("png");
    let options = ResizeOptions { max_tokens: max_tokens.filter(|tokens| *tokens > 0).unwrap_or(DEFAULT_IMAGE_MAX_TOKENS), ..ResizeOptions::default() };
    let resized = resize_image_buffer(bytes, ext, options).ok().flatten()?;
    Some(ImageBlocks { text: image_metadata_text(Some(&resized.dimensions), source_path), data: resized.data, mime: resized.mime })
}

/// The `image.probe` call: the dimensions after one full decode (a corrupt stream the header does not show is
/// rejected).
pub fn probe(bytes: &[u8]) -> Result<(u32, u32), ImagingError> {
    decoded_dimensions(bytes)
}

/// The `image.validate` call: whether the decoder takes the image, as the provider image preparation asks it (the
/// Anthropic profile, the default budget, the rendition itself not returned). `format` is the extension. An empty
/// buffer gives no resizer answer, which Node reports as an environment failure and so does this.
pub fn validate(bytes: &[u8], format: &str) -> Result<(), ImagingError> {
    match resize_image_buffer(bytes, format, ResizeOptions::default())? {
        Some(_) => Ok(()),
        None => Err(ImagingError::environment("there is no image to validate")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn picture(width: u32, height: u32, noise: bool) -> Raster {
        let mut data = Vec::new();
        let mut state = 99u32;
        for y in 0..height {
            for x in 0..width {
                let n = if noise {
                    state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                    (state >> 24) as u8
                } else {
                    0
                };
                data.extend_from_slice(&[((x * 255 / width) as u8).wrapping_add(n), (y * 255 / height) as u8, 90u8.wrapping_add(n)]);
            }
        }
        Raster { width, height, has_alpha: false, data }
    }

    fn png(width: u32, height: u32, noise: bool) -> Vec<u8> {
        encode_in_format(&picture(width, height, noise), Format::Png).unwrap()
    }

    #[test]
    fn an_empty_buffer_is_nothing_and_bad_bytes_are_invalid_image_data() {
        assert_eq!(resize_image_buffer(b"", "png", ResizeOptions::default()), Ok(None));
        let error = resize_image_buffer(b"definitely not an image", "png", ResizeOptions::default()).unwrap_err();
        assert_eq!(error.message(), "invalid or corrupt image data: Input buffer contains unsupported image format");
        assert_eq!(error.class(), ErrorClass::Invalid);
    }

    #[test]
    fn an_image_that_already_fits_answers_its_own_bytes() {
        let bytes = png(300, 220, false);
        let resized = resize_image_buffer(&bytes, "png", ResizeOptions::default()).unwrap().unwrap();
        assert_eq!(resized.data, bytes);
        assert_eq!(resized.mime, "image/png");
        assert_eq!(resized.branch, Branch::Original);
        assert_eq!(resized.dimensions, Dimensions { original_width: 300, original_height: 220, display_width: 300, display_height: 220 });
    }

    #[test]
    fn a_sub_patch_image_is_scaled_up_and_a_wide_one_down() {
        let small = resize_image_buffer(&png(100, 100, false), "png", ResizeOptions::default()).unwrap().unwrap();
        assert_eq!((small.dimensions.display_width, small.dimensions.display_height, small.branch), (200, 200, Branch::Rendition));
        let wide = resize_image_buffer(&png(2000, 100, false), "png", ResizeOptions::default()).unwrap().unwrap();
        assert_eq!((wide.dimensions.original_width, wide.dimensions.display_width, wide.dimensions.display_height), (2000, 1560, 78));
        assert_eq!(wide.mime, "image/png");
        let back = decode(&wide.data, DECODE_PIXEL_LIMIT).unwrap();
        assert_eq!((back.width, back.height), (1560, 78));
    }

    #[test]
    fn the_profile_decides_the_box() {
        let bytes = png(1800, 600, false);
        let anthropic = resize_image_buffer(&bytes, "png", ResizeOptions { profile: Profile::Anthropic, ..ResizeOptions::default() }).unwrap().unwrap();
        let openai = resize_image_buffer(&bytes, "png", ResizeOptions { profile: Profile::OpenAi, ..ResizeOptions::default() }).unwrap().unwrap();
        assert_eq!(anthropic.dimensions.display_width, 1566, "1800x600 is boxed at 1568x522, and the picture inside the box is 1566 wide");
        assert_eq!(openai.branch, Branch::Original, "1800x600 is inside OpenAI's 2048 edge and 1536 patches");
    }

    #[test]
    fn a_token_budget_the_rendition_exceeds_sends_a_jpeg_and_then_the_small_fallback() {
        let bytes = png(300, 300, true);
        // A budget between what the PNG costs and what its JPEG q50 costs.
        let png_tokens = est_tokens_of_bytes(bytes.len());
        let jpeg_tokens = est_tokens_of_bytes(encode_jpeg(&picture(300, 300, true), 50, 0).len());
        assert!(jpeg_tokens < png_tokens, "{jpeg_tokens} vs {png_tokens}");
        let between = ResizeOptions { max_tokens: (png_tokens + jpeg_tokens) / 2, ..ResizeOptions::default() };
        let jpeg = resize_image_buffer(&bytes, "png", between).unwrap().unwrap();
        assert_eq!((jpeg.branch, jpeg.mime.as_str()), (Branch::TokenJpeg, "image/jpeg"));
        assert_eq!((jpeg.dimensions.display_width, jpeg.dimensions.display_height), (300, 300));
        let fallback = resize_image_buffer(&bytes, "png", ResizeOptions { max_tokens: 1, ..ResizeOptions::default() }).unwrap().unwrap();
        assert_eq!((fallback.branch, fallback.mime.as_str()), (Branch::TokenFallback, "image/jpeg"));
        assert_eq!((fallback.dimensions.display_width, fallback.dimensions.display_height), (300, 300));
        let big = resize_image_buffer(&png(800, 600, true), "png", ResizeOptions { max_tokens: 1, ..ResizeOptions::default() }).unwrap().unwrap();
        assert_eq!((big.dimensions.display_width, big.dimensions.display_height), (400, 300));
    }

    #[test]
    fn a_repeat_call_is_answered_from_the_cache_with_the_same_answer() {
        let bytes = png(210, 205, true);
        let before = image_resize_cache_stats();
        let first = resize_image_buffer(&bytes, "png", ResizeOptions { max_tokens: 5_000, ..ResizeOptions::default() }).unwrap().unwrap();
        let second = resize_image_buffer(&bytes, "png", ResizeOptions { max_tokens: 5_000, ..ResizeOptions::default() }).unwrap().unwrap();
        assert_eq!(first, second);
        assert!(image_resize_cache_stats().hits > before.hits);
    }

    #[test]
    fn the_notebook_reader_gets_the_image_and_its_metadata_line_or_nothing() {
        let blocks = image_blocks_from_buffer(&png(100, 100, false), "image/png", Some("cell.png"), None).expect("an image block");
        assert_eq!(blocks.mime, "image/png");
        assert_eq!(
            blocks.text.as_deref(),
            Some("[Image: source: cell.png, 100x100, displayed at 200x200. Multiply coordinates by 0.50 to map to the original image.]")
        );
        assert_eq!(image_blocks_from_buffer(b"", "image/png", None, None), None);
        assert_eq!(image_blocks_from_buffer(b"not an image", "image/png", None, None), None);
        // No slash in the type: the extension is png, and a bare type still resizes.
        assert!(image_blocks_from_buffer(&png(300, 220, false), "", None, Some(0)).is_some());
    }

    #[test]
    fn probe_gives_the_dimensions_and_validate_whether_the_decoder_takes_the_image() {
        assert_eq!(probe(&png(31, 17, false)).unwrap(), (31, 17));
        assert_eq!(probe(b"").unwrap_err().sentence(), "Input Buffer is empty");
        assert!(!probe(b"nope").unwrap_err().is_environment());
        assert_eq!(validate(&png(40, 30, false), "png"), Ok(()));
        assert!(!validate(b"nope", "png").unwrap_err().is_environment());
        assert!(validate(b"", "png").unwrap_err().is_environment());
    }
}
