use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_ai::providers::file_text::FileKind;
use mixdog_ai::providers::file_text::base64_byte_length;
use mixdog_ai::providers::file_text::inline_file_kind;
use mixdog_browser_engine::limits::DOWNLOAD_ATTACH_MAX_BYTES;
use mixdog_browser_engine::reply::reply::ReplyImage;
use mixdog_browser_engine::reply::screenshot::MAX_INLINE_IMAGE_BYTES;
use mixdog_core_api::domain::tool::ImageData;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_core_api::domain::tool::ToolPart;
use serde_json::Map;
use serde_json::Value;

use super::host::bridge_error;

/// `SUPPORTED_IMAGE_MIME_TYPES` (`attachments/limits.mjs`).
const SUPPORTED_IMAGE_MIME: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];
/// What the engine's reply says after it attached a download (`attached_note` of the engine's `downloads_text`).
const ATTACHED: &str = "\n\nAttached download ";

fn invalid_image() -> ToolError {
    bridge_error("browser bridge returned an invalid image")
}

fn invalid_file() -> ToolError {
    bridge_error("browser bridge returned an invalid file")
}

/// `result.image`: a jpeg or png within the image limit.
#[allow(clippy::result_large_err, reason = "Keep the canonical structured tool error by value, as the other browser reply mappings do")]
pub fn image_part(image: &Map<String, Value>) -> Result<Option<ToolPart>, ToolError> {
    let mime = image.get("mimeType").and_then(Value::as_str).unwrap_or_default();
    let data = image.get("data").and_then(Value::as_str).unwrap_or_default();
    if data.is_empty() || mime.is_empty() {
        return Ok(None);
    }
    // STANDARD requires complete, padded quanta. Anything this bound rejects
    // would either fail that decoder or already exceed the decoded limit.
    let padding = if data.ends_with("==") { 2 } else { usize::from(data.ends_with('=')) };
    if !screenshot_fits(mime, (data.len() / 4 * 3).saturating_sub(padding)) {
        return Err(invalid_image());
    }
    let bytes = STANDARD.decode(data).map_err(|_| invalid_image())?;
    Ok(Some(screenshot_image(mime.to_owned(), bytes)))
}

fn screenshot_fits(mime: &str, len: usize) -> bool {
    matches!(mime, "image/jpeg" | "image/png") && len <= MAX_INLINE_IMAGE_BYTES
}

fn screenshot_image(mime: String, bytes: Vec<u8>) -> ToolPart {
    ToolPart::Image { mime, data: ImageData::Bytes(bytes), width: None, height: None }
}

#[allow(clippy::result_large_err, reason = "Keep the canonical structured tool error by value")]
pub(super) fn screenshot_part(image: ReplyImage) -> Result<Option<ToolPart>, ToolError> {
    if image.bytes.is_empty() || image.mime_type.is_empty() {
        return Ok(None);
    }
    if !screenshot_fits(&image.mime_type, image.bytes.len()) {
        return Err(invalid_image());
    }
    Ok(Some(screenshot_image(image.mime_type, image.bytes.into())))
}

/// A mime type of the `type/subtype` form Node accepted for a file (`/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i`).
fn plain_mime(mime: &str) -> bool {
    let word = |part: &str| !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '+' | '-'));
    mime.split_once('/').is_some_and(|(kind, subtype)| word(kind) && word(subtype))
}

/// A file name Node accepted: at most 255 units, no control character, no path separator.
fn plain_name(name: &str) -> bool {
    mixdog_js::utf16_len(name) <= 255 && !name.chars().any(|c| c <= '\u{1f}' || c == '/' || c == '\\')
}

/// The reply's "Attached download <id> as <name>." sentence for a file that was not attached: the one claim the engine makes before
/// the kind of the file is known.
fn retract_attached(text: &mut String, name: &str) {
    let Some(at) = text.rfind(ATTACHED) else { return };
    let tail = &text[at + ATTACHED.len()..];
    if let Some(id) = tail.strip_suffix(&format!(" as {name}.")) {
        let sentence = format!("\n\nDownload {id} ({name}) was not attached inline.");
        text.truncate(at);
        text.push_str(&sentence);
    }
}

/// `result.file`: an attached download as the part its kind is, appended to `parts`; a binary one adds only its note and takes the
/// reply's "Attached" sentence back in `text`, so the text never says more than was done.
#[allow(clippy::result_large_err, reason = "Keep the canonical structured tool error by value, as the other browser reply mappings do")]
pub fn file_parts(file: &Map<String, Value>, text: &mut String, parts: &mut Vec<ToolPart>) -> Result<(), ToolError> {
    let mime = file.get("mimeType").and_then(Value::as_str).filter(|m| !m.is_empty()).unwrap_or("application/octet-stream");
    let name = file.get("name").and_then(Value::as_str).filter(|n| !n.is_empty()).unwrap_or("download");
    let data = file.get("data").and_then(Value::as_str).unwrap_or_default();
    let bytes = STANDARD.decode(data).map_err(|_| invalid_file())?;
    if !plain_mime(mime) || !plain_name(name) || bytes.len() as u64 > DOWNLOAD_ATTACH_MAX_BYTES {
        return Err(invalid_file());
    }
    if SUPPORTED_IMAGE_MIME.contains(&mime.to_ascii_lowercase().as_str()) {
        parts.push(ToolPart::Image { mime: mime.to_ascii_lowercase(), data: ImageData::Bytes(bytes), width: None, height: None });
        return Ok(());
    }
    match inline_file_kind(mime, data, name) {
        FileKind::Pdf => parts.push(ToolPart::Document { mime: "application/pdf".to_owned(), data: bytes }),
        FileKind::Text | FileKind::Office => parts.push(ToolPart::File { mime: mime.to_owned(), data: bytes, filename: Some(name.to_owned()) }),
        FileKind::Binary => {
            retract_attached(text, name);
            parts.push(ToolPart::Text(format!(
                "Download {name} ({mime}, {} bytes) is binary and stays on disk; open it from the path listed above with read.",
                base64_byte_length(data)
            )));
        }
    }
    Ok(())
}
