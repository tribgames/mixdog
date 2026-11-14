//! Tool-result image compaction. A tool-result image rides every later request of its session, so its wire bytes are
//! paid again on each send. It is re-encoded once, when the result enters the transcript: a JPEG inside the profile's
//! display box, white-flattened, stepping the quality down toward a base64 budget. The box is the one per-send
//! preparation resizes to, so that pass finds nothing left to change and the cached prefix keeps its bytes.

use base64::Engine;
use base64::alphabet;
use base64::engine::DecodePaddingMode;
use base64::engine::GeneralPurpose;
use base64::engine::GeneralPurposeConfig;
use base64::engine::general_purpose::STANDARD;

use crate::decode::DECODE_PIXEL_LIMIT;
use crate::decode::DEFAULT_PIXEL_LIMIT;
use crate::decode::Raster;
use crate::decode::decode;
use crate::encode::encode_jpeg;
use crate::error::ImagingError;
use crate::policy::Dimensions;
use crate::policy::Profile;
use crate::policy::base64_len;
use crate::policy::normalize_fmt;
use crate::policy::target_dimensions;
use crate::resize::fit_inside;

/// `TOOL_IMAGE_TARGET_BASE64_SIZE`: 256 KiB of base64.
pub const TOOL_IMAGE_TARGET_BASE64_SIZE: usize = 256 * 1024;

/// `TOOL_IMAGE_JPEG_QUALITIES`: tried in this order until the image fits the budget.
pub const TOOL_IMAGE_JPEG_QUALITIES: [u8; 3] = [85, 70, 50];

/// `TOOL_IMAGE_SOURCE_FORMATS`: the stills a tool-result image is re-encoded from.
const TOOL_IMAGE_SOURCE_FORMATS: [&str; 3] = ["png", "jpeg", "webp"];

/// One JPEG re-encode and the size it came out at.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct EncodedJpeg {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// `encodeToolImageJpeg` on pixels already decoded: the box, white-flattened, as a JPEG.
fn encode_raster(raster: &Raster, width: u32, height: u32, allow_enlargement: bool, quality: u8) -> EncodedJpeg {
    let fitted = fit_inside(raster, width, height, !allow_enlargement);
    EncodedJpeg { data: encode_jpeg(&fitted, quality, 255), width: fitted.width, height: fitted.height }
}

/// `encodeToolImageJpeg` (the `image.jpeg` call): one re-encode of a tool-result image at one quality. The decode is
/// sharp's own, under its default pixel limit.
pub fn encode_tool_image_jpeg(bytes: &[u8], width: u32, height: u32, allow_enlargement: bool, quality: u8) -> Result<EncodedJpeg, ImagingError> {
    for (name, value) in [("width", width), ("height", height)] {
        if value == 0 {
            return Err(ImagingError::invalid(format!("Expected positive integer for {name} but received 0 of type number")));
        }
    }
    let decoded = decode(bytes, DEFAULT_PIXEL_LIMIT)?;
    Ok(encode_raster(&decoded.raster, width, height, allow_enlargement, quality))
}

/// A tool-result image after compaction.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct CompactedImage {
    /// Base64 of the JPEG.
    pub data: String,
    /// Always `image/jpeg`.
    pub mime: String,
    pub dimensions: Dimensions,
}

/// Node's `Buffer.from(data, 'base64')`, which the compaction decodes with: characters outside the alphabet are
/// skipped, both alphabets are read and padding may be missing.
fn node_base64(data: &str) -> Vec<u8> {
    const LENIENT: GeneralPurpose = GeneralPurpose::new(
        &alphabet::STANDARD,
        GeneralPurposeConfig::new().with_decode_allow_trailing_bits(true).with_decode_padding_mode(DecodePaddingMode::Indifferent),
    );
    let mut cleaned: String = data
        .chars()
        .take_while(|c| *c != '=')
        .filter_map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '+' | '/' => Some(c),
            '-' => Some('+'),
            '_' => Some('/'),
            _ => None,
        })
        .collect();
    if cleaned.len() % 4 == 1 {
        cleaned.pop();
    }
    LENIENT.decode(&cleaned).unwrap_or_default()
}

/// `compactToolResultImage`: the compacted image, or `None` when the image is already within budget, not a
/// re-encodable still, undecodable, or would not shrink (the original stays; per-send preparation still validates
/// it).
pub fn compact_tool_result_image(base64: &str, mime_type: &str) -> Option<CompactedImage> {
    if base64.len() <= TOOL_IMAGE_TARGET_BASE64_SIZE {
        return None;
    }
    let format = normalize_fmt(mime_type.split('/').nth(1));
    if !TOOL_IMAGE_SOURCE_FORMATS.contains(&format.as_str()) {
        return None;
    }
    let decoded = decode(&node_base64(base64), DECODE_PIXEL_LIMIT).ok()?;
    let target = target_dimensions(decoded.width, decoded.height, Profile::Anthropic);
    let mut encoded = None;
    for quality in TOOL_IMAGE_JPEG_QUALITIES {
        let attempt = encode_raster(&decoded.raster, target.width, target.height, target.allow_enlargement, quality);
        let fits = base64_len(attempt.data.len()) <= TOOL_IMAGE_TARGET_BASE64_SIZE;
        encoded = Some(attempt);
        if fits {
            break;
        }
    }
    let encoded = encoded?;
    let data = STANDARD.encode(&encoded.data);
    if data.len() >= base64.len() {
        return None;
    }
    Some(CompactedImage {
        data,
        mime: "image/jpeg".to_owned(),
        dimensions: Dimensions {
            original_width: decoded.width,
            original_height: decoded.height,
            display_width: encoded.width,
            display_height: encoded.height,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encode::encode_in_format;
    use crate::decode::Format;

    fn noisy(width: u32, height: u32) -> Raster {
        let mut data = Vec::new();
        let mut state = 7u32;
        for _ in 0..width * height {
            for _ in 0..3 {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                data.push((state >> 24) as u8);
            }
        }
        Raster { width, height, has_alpha: false, data }
    }

    #[test]
    fn the_constants_are_the_nodes() {
        assert_eq!(TOOL_IMAGE_TARGET_BASE64_SIZE, 262_144);
        assert_eq!(TOOL_IMAGE_JPEG_QUALITIES, [85, 70, 50]);
    }

    #[test]
    fn one_re_encode_reports_the_size_it_came_out_at() {
        let png = encode_in_format(&noisy(60, 40), Format::Png).unwrap();
        let encoded = encode_tool_image_jpeg(&png, 30, 20, false, 85).unwrap();
        assert_eq!((encoded.width, encoded.height), (30, 20));
        assert_eq!(&encoded.data[..2], &[0xFF, 0xD8]);
        // Never enlarged unless the caller says so.
        let same = encode_tool_image_jpeg(&png, 600, 400, false, 85).unwrap();
        assert_eq!((same.width, same.height), (60, 40));
        let larger = encode_tool_image_jpeg(&png, 600, 400, true, 85).unwrap();
        assert_eq!((larger.width, larger.height), (600, 400));
    }

    #[test]
    fn an_empty_or_undecodable_input_is_invalid() {
        assert_eq!(encode_tool_image_jpeg(b"", 1, 1, false, 85).unwrap_err().sentence(), "Input Buffer is empty");
        assert!(!encode_tool_image_jpeg(b"not an image", 1, 1, false, 85).unwrap_err().is_environment());
    }

    #[test]
    fn an_image_within_budget_or_of_another_format_is_left_alone() {
        let small = STANDARD.encode(encode_in_format(&noisy(8, 8), Format::Png).unwrap());
        assert_eq!(compact_tool_result_image(&small, "image/png"), None);
        let big = "A".repeat(TOOL_IMAGE_TARGET_BASE64_SIZE + 1);
        assert_eq!(compact_tool_result_image(&big, "image/gif"), None);
        assert_eq!(compact_tool_result_image(&big, "image/png"), None, "undecodable bytes stay");
        assert_eq!(compact_tool_result_image(&big, ""), None);
    }

    #[test]
    fn a_large_noisy_png_is_re_encoded_as_a_smaller_jpeg_inside_the_display_box() {
        let png = encode_in_format(&noisy(500, 400), Format::Png).unwrap();
        let base64 = STANDARD.encode(&png);
        assert!(base64.len() > TOOL_IMAGE_TARGET_BASE64_SIZE, "the fixture must be over budget ({})", base64.len());
        let compacted = compact_tool_result_image(&base64, "image/png").expect("compacted");
        assert_eq!(compacted.mime, "image/jpeg");
        assert!(compacted.data.len() < base64.len());
        assert_eq!(
            compacted.dimensions,
            Dimensions { original_width: 500, original_height: 400, display_width: 500, display_height: 400 }
        );
        let jpeg = STANDARD.decode(&compacted.data).unwrap();
        assert_eq!(&jpeg[..2], &[0xFF, 0xD8]);
        // Base64 as Buffer.from reads it: line breaks skipped, the URL-safe alphabet taken, padding optional.
        let wrapped: String = base64.trim_end_matches('=').replace('+', "-").replace('/', "_").as_bytes().chunks(76).map(|line| format!("{}\r\n", String::from_utf8_lossy(line))).collect();
        assert_eq!(compact_tool_result_image(&wrapped, "image/png").map(|image| image.dimensions), Some(compacted.dimensions));
    }

    #[test]
    fn base64_is_read_as_buffer_from_reads_it() {
        assert_eq!(node_base64("aGVsbG8="), b"hello");
        assert_eq!(node_base64("aGVs\nbG8"), b"hello");
        assert_eq!(node_base64("-_8"), [0xFB, 0xFF]);
        assert_eq!(node_base64(""), b"");
    }
}
