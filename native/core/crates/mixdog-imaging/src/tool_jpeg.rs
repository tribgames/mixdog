//! Tool-result image compaction. A tool-result image rides every later request of its session, so its wire bytes are
//! paid again on each send. It is re-encoded once, when the result enters the transcript: a JPEG inside the profile's
//! display box, white-flattened, stepping the quality down toward a base64 budget. The box is the one per-send
//! preparation resizes to, so that pass finds nothing left to change and the cached prefix keeps its bytes.

use crate::decode::DECODE_PIXEL_LIMIT;
use crate::decode::DEFAULT_PIXEL_LIMIT;
use crate::decode::Raster;
use crate::decode::decode;
use crate::encode::encode_jpeg;
use crate::error::ImagingError;
use crate::policy::Dimensions;
use crate::policy::Profile;
use crate::policy::target_dimensions;
use crate::resize::fit_inside_view;

/// `TOOL_IMAGE_TARGET_BASE64_SIZE`: 256 KiB of base64.
pub const TOOL_IMAGE_TARGET_BASE64_SIZE: usize = 256 * 1024;

/// `TOOL_IMAGE_JPEG_QUALITIES`: tried in this order until the image fits the budget.
pub const TOOL_IMAGE_JPEG_QUALITIES: [u8; 3] = [85, 70, 50];

/// `TOOL_IMAGE_SOURCE_FORMATS`: the stills a tool-result image is re-encoded from.
pub const TOOL_IMAGE_SOURCE_FORMATS: [&str; 3] = ["png", "jpeg", "webp"];

/// One JPEG re-encode and the size it came out at.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct EncodedJpeg {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// `encodeToolImageJpeg` on pixels already decoded: the box, white-flattened, as a JPEG.
fn encode_raster(raster: &Raster, width: u32, height: u32, allow_enlargement: bool, quality: u8) -> EncodedJpeg {
    let fitted = fit_inside_view(raster, width, height, !allow_enlargement);
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

/// One JPEG ladder result at the model profile's display box.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct FittedToolJpeg {
    pub data: Vec<u8>,
    pub quality: u8,
    pub fits: bool,
    pub dimensions: Dimensions,
}

/// Steps through [`TOOL_IMAGE_JPEG_QUALITIES`] synchronously until `fits(&attempt)` holds, or returns the final
/// lowest-quality attempt (`matched == false`).
pub fn run_tool_jpeg_ladder<T, E, Enc, Fits>(mut encode: Enc, mut fits: Fits) -> Result<(T, u8, bool), E>
where
    Enc: FnMut(u8) -> Result<T, E>,
    Fits: FnMut(&T) -> bool,
{
    let mut chosen = None;
    let mut matched = false;
    for quality in TOOL_IMAGE_JPEG_QUALITIES {
        let attempt = encode(quality)?;
        matched = fits(&attempt);
        chosen = Some((attempt, quality));
        if matched {
            break;
        }
    }
    let (value, quality) = chosen.expect("TOOL_IMAGE_JPEG_QUALITIES is non-empty");
    Ok((value, quality, matched))
}

/// Async counterpart of [`run_tool_jpeg_ladder`] for callers backed by an async codec (e.g. `ToolImageCompactor`).
pub async fn run_tool_jpeg_ladder_async<T, E, Enc, Fut, Fits>(mut encode: Enc, mut fits: Fits) -> Result<(T, u8, bool), E>
where
    Enc: FnMut(u8) -> Fut,
    Fut: std::future::Future<Output = Result<T, E>>,
    Fits: FnMut(&T) -> bool,
{
    let mut chosen = None;
    let mut matched = false;
    for quality in TOOL_IMAGE_JPEG_QUALITIES {
        let attempt = encode(quality).await?;
        matched = fits(&attempt);
        chosen = Some((attempt, quality));
        if matched {
            break;
        }
    }
    let (value, quality) = chosen.expect("TOOL_IMAGE_JPEG_QUALITIES is non-empty");
    Ok((value, quality, matched))
}

/// Decodes `bytes`, fits them inside the Anthropic display box, white-flattens alpha, and steps through
/// [`TOOL_IMAGE_JPEG_QUALITIES`] via [`run_tool_jpeg_ladder`] until `fits(jpeg.len())` holds (or returns the
/// lowest-quality attempt with `fits == false`).
pub fn fit_tool_image_jpeg<F>(bytes: &[u8], mut fits: F) -> Result<FittedToolJpeg, ImagingError>
where
    F: FnMut(usize) -> bool,
{
    let decoded = decode(bytes, DECODE_PIXEL_LIMIT)?;
    let target = target_dimensions(decoded.width, decoded.height, Profile::Anthropic);
    let fitted = fit_inside_view(&decoded.raster, target.width, target.height, !target.allow_enlargement);
    let rgb = crate::encode::flattened_rgb(&fitted, 255);
    let (data, quality, matched) = run_tool_jpeg_ladder(
        |quality| Ok::<_, ImagingError>(crate::jpeg_enc::encode_rgb(fitted.width, fitted.height, &rgb, quality)),
        |attempt| fits(attempt.len()),
    )?;
    Ok(FittedToolJpeg {
        data,
        quality,
        fits: matched,
        dimensions: Dimensions { original_width: decoded.width, original_height: decoded.height, display_width: fitted.width, display_height: fitted.height },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decode::Format;
    use crate::encode::encode_in_format;
    use crate::policy::base64_len;

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
    fn fit_tool_image_jpeg_re_encodes_inside_display_box_within_budget() {
        let png = encode_in_format(&noisy(500, 400), Format::Png).unwrap();
        assert!(base64_len(png.len()) > TOOL_IMAGE_TARGET_BASE64_SIZE, "fixture must exceed budget");
        let fitted = fit_tool_image_jpeg(&png, |len| base64_len(len) <= TOOL_IMAGE_TARGET_BASE64_SIZE).expect("fitted");
        assert!(fitted.fits);
        assert!(fitted.data.len() < png.len());
        assert_eq!(&fitted.data[..2], &[0xFF, 0xD8]);
        assert_eq!(fitted.dimensions, Dimensions { original_width: 500, original_height: 400, display_width: 500, display_height: 400 });
    }

    #[test]
    fn run_tool_jpeg_ladder_steps_through_qualities_and_stops_once_fit() {
        let mut tried = Vec::new();
        let (value, quality, matched) = run_tool_jpeg_ladder(
            |q| {
                tried.push(q);
                Ok::<_, ()>(usize::from(q) * 10)
            },
            |size| *size <= 700,
        )
        .unwrap();
        assert_eq!(tried, vec![85, 70]);
        assert_eq!((value, quality, matched), (700, 70, true));

        let mut all = Vec::new();
        let (value, quality, matched) = run_tool_jpeg_ladder(
            |q| {
                all.push(q);
                Ok::<_, ()>(usize::from(q) * 10)
            },
            |_| false,
        )
        .unwrap();
        assert_eq!(all, vec![85, 70, 50]);
        assert_eq!((value, quality, matched), (500, 50, false));
    }
}
