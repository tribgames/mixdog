//! A tool's image as an agent's history keeps it: fitted to the display box and the history budget (1568 px, at most
//! 256 KiB base64 through the shared q85/70/50 JPEG ladder) inside the agent's own byte ceiling.

use crate::Branch;
use crate::ResizeOptions;
use crate::policy::Dimensions;
use crate::policy::base64_len;
use crate::policy::normalize_fmt;
use crate::resize_image_buffer;
use crate::tool_jpeg::TOOL_IMAGE_SOURCE_FORMATS;
use crate::tool_jpeg::TOOL_IMAGE_TARGET_BASE64_SIZE;
use crate::tool_jpeg::fit_tool_image_jpeg;

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ToolImage {
    pub data: Vec<u8>,
    /// `image/<format>`.
    pub mime: String,
    pub dimensions: Dimensions,
    /// Re-encoded at a lower quality than its source.
    pub recompressed: bool,
}

/// Why a tool's image is left out.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ToolImageRefusal {
    /// Empty, or the decoder rejected it.
    Unreadable,
    /// Over `max_raw_bytes` even at the lowest quality.
    TooLarge,
}

/// Fits `bytes` (of format `ext`) for an agent whose images may be `max_raw_bytes` at most.
pub fn fit_tool_image(bytes: &[u8], ext: &str, max_raw_bytes: usize) -> Result<ToolImage, ToolImageRefusal> {
    let Some(resized) = resize_image_buffer(bytes, ext, ResizeOptions::default()).map_err(|_| ToolImageRefusal::Unreadable)? else {
        return Err(ToolImageRefusal::Unreadable);
    };
    if resized.branch == Branch::TokenFallback {
        return Err(ToolImageRefusal::TooLarge);
    }
    let target_b64 = TOOL_IMAGE_TARGET_BASE64_SIZE;
    let fmt = normalize_fmt(resized.mime.split('/').nth(1));
    let reencodable_still = TOOL_IMAGE_SOURCE_FORMATS.contains(&fmt.as_str());
    let over_history_target = reencodable_still && base64_len(resized.data.len()) > target_b64;
    if over_history_target || resized.data.len() > max_raw_bytes {
        let fitted = fit_tool_image_jpeg(bytes, |len| len <= max_raw_bytes && base64_len(len) <= target_b64).map_err(|_| ToolImageRefusal::Unreadable)?;
        if fitted.data.len() <= max_raw_bytes && (fitted.data.len() < resized.data.len() || resized.data.len() > max_raw_bytes) {
            return Ok(ToolImage { data: fitted.data, mime: "image/jpeg".to_owned(), dimensions: fitted.dimensions, recompressed: true });
        }
    }
    if resized.data.len() <= max_raw_bytes {
        return Ok(ToolImage { data: resized.data, mime: resized.mime, dimensions: resized.dimensions, recompressed: resized.branch == Branch::TokenJpeg });
    }
    Err(ToolImageRefusal::TooLarge)
}
