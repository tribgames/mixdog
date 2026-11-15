//! Paste attachments and the paste policy (`src/tui/paste-attachments.mjs`, `src/tui/paste-text-policy.mjs`; the buffers
//! that hold them are the prompt's, `src/tui/app/use-pasted-buffers.mjs`).
//!
//! A pasted image becomes the reference `[Image #N]` and a long pasted text `[Pasted text #N +M lines]`; the payloads live
//! in the prompt's buffers until submit expands them. This module formats and parses the references, splits a paste into
//! image-path candidates, reads an image from a path or from the clipboard, reads the clipboard text, and builds the
//! prompt content that carries the images.
//!
//! Images are not downsampled here: the caller passes a [`Resizer`] that calls the core's `thread/resizeImage`, which is
//! the one implementation of the resize, the size limits and the metadata text.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use mixdog_fsio::Unlaned;

use crate::clipboard::no_clipboard_reader_error;
use crate::os::{HelperCommand, Platform, Runner};

/// Only a paste longer than this many characters (UTF-16 units) folds into a chip; the line count never matters.
pub const PASTE_TOKEN_MIN_CHARS: usize = 1000;

/// The visible lines of `text`: a copy that ends in a newline (`a\nb\n`) is two lines, not three.
pub fn pasted_text_line_count(text: &str) -> usize {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let visible = normalized.trim_end_matches('\n');
    if visible.is_empty() { 0 } else { visible.split('\n').count() }
}

/// Whether a paste is folded into a chip.
pub fn should_fold_pasted_text(text: &str) -> bool {
    mixdog_js::utf16_len(text) > PASTE_TOKEN_MIN_CHARS
}

/// `[Pasted text #N +M lines]`.
pub fn format_pasted_text_ref(id: u64, text: &str) -> String {
    format!("[Pasted text #{id} +{} lines]", pasted_text_line_count(text))
}

/// `[Image #N]`.
pub fn format_image_ref(id: u64) -> String {
    format!("[Image #{id}]")
}

/// The ids of the references that start with `prefix` and end with what `tail` accepts after the digits (`tail` answers
/// how many bytes it consumed). A zero id (`Number(...) || 0` filtered out) and an id past u64 are left out.
fn reference_ids(input: &str, prefix: &str, tail: fn(&str) -> Option<usize>) -> BTreeSet<u64> {
    let mut ids = BTreeSet::new();
    let mut at = 0;
    while let Some(found) = input[at..].find(prefix) {
        let start = at + found + prefix.len();
        let digits = input[start..].bytes().take_while(u8::is_ascii_digit).count();
        let end = start + digits;
        let consumed = if digits > 0 { tail(&input[end..]) } else { None };
        match consumed {
            Some(length) => {
                if let Ok(id) = input[start..end].parse::<u64>()
                    && id != 0
                {
                    ids.insert(id);
                }
                at = end + length;
            }
            None => at += found + 1,
        }
    }
    ids
}

/// The ids named by `[Image #N]` references in `input`.
pub fn image_reference_ids(input: &str) -> BTreeSet<u64> {
    reference_ids(input, "[Image #", |rest| rest.starts_with(']').then_some(1))
}

/// The ids named by `[Pasted text #N +M lines]` references in `input`.
pub fn pasted_text_reference_ids(input: &str) -> BTreeSet<u64> {
    reference_ids(input, "[Pasted text #", |rest| {
        let rest = rest.strip_prefix(" +")?;
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        rest[digits..].starts_with(" lines]").then_some(2 + digits + " lines]".len())
    })
}

/// A pasted image held by the prompt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PastedImage {
    pub id: u64,
    /// Base64 of the image.
    pub content: String,
    pub media_type: Option<String>,
    pub metadata_text: Option<String>,
}

/// One part of a prompt that carries images.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PromptPart {
    Text(String),
    /// `{ type: 'image', data, mimeType, pasteId }`: `paste_id` pairs the part with its pasted image by identity.
    Image { data: String, mime_type: String, paste_id: u64 },
}

/// A prompt: the text alone, or the text and the images it references.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PromptContent {
    Text(String),
    Parts(Vec<PromptPart>),
}

/// The prompt content of `text` with the pasted images it references (in ascending id order, each after its metadata
/// text); the text alone when it references none.
pub fn build_prompt_content_with_images(text: &str, pasted_images: &BTreeMap<u64, PastedImage>) -> PromptContent {
    let refs = image_reference_ids(text);
    let mut image_parts = Vec::new();
    for image in pasted_images.values().filter(|image| refs.contains(&image.id)) {
        if let Some(metadata) = image.metadata_text.as_ref().filter(|metadata| !metadata.is_empty()) {
            image_parts.push(PromptPart::Text(metadata.clone()));
        }
        image_parts.push(PromptPart::Image {
            data: image.content.clone(),
            mime_type: image.media_type.clone().filter(|media| !media.is_empty()).unwrap_or_else(|| "image/png".to_owned()),
            paste_id: image.id,
        });
    }
    if image_parts.is_empty() {
        return PromptContent::Text(text.to_owned());
    }
    let mut parts = Vec::new();
    if !mixdog_js::js_trim(text).is_empty() {
        parts.push(PromptPart::Text(text.to_owned()));
    }
    parts.extend(image_parts);
    PromptContent::Parts(parts)
}

// ---- paths -------------------------------------------------------------------------------------------------------------

/// `decodeURIComponent`: `None` where it throws (a `%` without two hex digits, or bytes that are not UTF-8).
fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let hex = text.get(at + 1..at + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok().filter(|_| hex.bytes().all(|b| b.is_ascii_hexdigit()))?);
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn is_dot_segment(segment: &str) -> bool {
    segment == "." || segment.eq_ignore_ascii_case("%2e")
}

fn is_double_dot_segment(segment: &str) -> bool {
    let lower = segment.to_ascii_lowercase();
    matches!(lower.as_str(), ".." | ".%2e" | "%2e." | "%2e%2e")
}

/// `new URL(text).pathname` of a `file://` URL: the host, the query and the fragment are dropped, backslashes are slashes
/// and the dot segments are resolved.
fn file_url_pathname(text: &str) -> String {
    let cleaned: String = text.chars().filter(|c| !matches!(c, '\t' | '\n' | '\r')).collect();
    let rest = &cleaned["file://".len()..];
    let rest = &rest[..rest.find(['?', '#']).unwrap_or(rest.len())];
    let path = &rest[rest.find(['/', '\\']).unwrap_or(rest.len())..];
    let mut segments: Vec<String> = Vec::new();
    let pieces: Vec<&str> = path.split(['/', '\\']).skip(1).collect();
    let last = pieces.len().saturating_sub(1);
    for (index, piece) in pieces.iter().enumerate() {
        if is_double_dot_segment(piece) {
            let at_drive = segments.len() == 1 && is_drive_segment(&segments[0]);
            if !at_drive {
                segments.pop();
            }
            if index == last {
                segments.push(String::new());
            }
        } else if is_dot_segment(piece) {
            if index == last {
                segments.push(String::new());
            }
        } else if segments.is_empty() && piece.len() == 2 && piece.as_bytes()[0].is_ascii_alphabetic() && piece.ends_with('|') {
            segments.push(format!("{}:", &piece[..1]));
        } else {
            segments.push((*piece).to_owned());
        }
    }
    format!("/{}", segments.join("/"))
}

fn is_drive_segment(segment: &str) -> bool {
    segment.len() == 2 && segment.as_bytes()[0].is_ascii_alphabetic() && segment.ends_with(':')
}

/// The text of a pasted path: trimmed, unquoted, a `file://` URL as a path, and (off Windows) backslash escapes removed.
pub fn clean_path_text(value: &str, platform: Platform) -> String {
    let trimmed = mixdog_js::js_trim(value);
    let quoted = (trimmed.starts_with('"') && trimmed.ends_with('"')) || (trimmed.starts_with('\'') && trimmed.ends_with('\''));
    let mut text = if quoted { trimmed.get(1..trimmed.len().saturating_sub(1)).unwrap_or("").to_owned() } else { trimmed.to_owned() };
    if text.starts_with("file://") {
        if let Some(decoded) = decode_uri_component(&file_url_pathname(&text)) {
            text = decoded;
        }
        if platform == Platform::Windows {
            let without_slashes = text.trim_start_matches('/');
            let drive = without_slashes.len() >= 2
                && without_slashes.as_bytes()[0].is_ascii_alphabetic()
                && without_slashes.as_bytes()[1] == b':'
                && text.starts_with('/');
            if drive {
                text = without_slashes.to_owned();
            }
            text = text.replace('/', "\\");
        }
    }
    if platform != Platform::Windows {
        text = unescape_backslashes(&text);
    }
    text
}

/// `replace(/\\(.)/g, '$1')`: `.` is any character but a line terminator.
fn unescape_backslashes(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\'
            && let Some(&next) = chars.peek()
            && !matches!(next, '\n' | '\r' | '\u{2028}' | '\u{2029}')
        {
            out.push(next);
            chars.next();
        } else {
            out.push(c);
        }
    }
    out
}

/// The image MIME type of a path's extension.
pub fn mime_for_path(path: &str) -> Option<&'static str> {
    let extension = Path::new(path).extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

fn is_image_path_text(value: &str, platform: Platform) -> bool {
    let lower = clean_path_text(value, platform).to_ascii_lowercase();
    [".png", ".jpg", ".jpeg", ".gif", ".webp"].iter().any(|suffix| lower.ends_with(suffix))
}

/// A piece of a paste: a path-like chunk (with whether it names an image) or a newline between lines.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PathCandidate {
    pub text: String,
    pub image_path: bool,
}

/// A space that starts a new path: `/`, `~/`, `./`, `../`, `X:\` or `file://` follows it.
fn path_starts_at(rest: &str) -> bool {
    let bytes = rest.as_bytes();
    rest.starts_with('/')
        || rest.starts_with("~/")
        || rest.starts_with("./")
        || rest.starts_with("../")
        || (bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\')
        || rest.starts_with("file://")
}

/// Split a paste into path candidates: per line, at every space that is followed by the start of a path, with a
/// `"\n"` candidate between lines.
pub fn split_pasted_image_path_candidates(text: &str, platform: Platform) -> Vec<PathCandidate> {
    let mut out = Vec::new();
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();
    for (index, line) in lines.iter().enumerate() {
        let mut chunk_start = 0;
        let mut chunks = Vec::new();
        for (at, c) in line.char_indices() {
            if c == ' ' && path_starts_at(&line[at + 1..]) {
                chunks.push(&line[chunk_start..at]);
                chunk_start = at + 1;
            }
        }
        chunks.push(&line[chunk_start..]);
        for raw in chunks.into_iter().filter(|raw| !raw.is_empty()) {
            out.push(PathCandidate { text: raw.to_owned(), image_path: is_image_path_text(raw, platform) });
        }
        if index + 1 < lines.len() {
            out.push(PathCandidate { text: "\n".to_owned(), image_path: false });
        }
    }
    out
}

// ---- image attachments ---------------------------------------------------------------------------------------------

/// What the caller's resize is asked: the image and how it is described.
#[derive(Clone, Copy, Debug)]
pub struct ResizeRequest<'a> {
    pub bytes: &'a [u8],
    pub mime_type: &'a str,
    /// The source named in the metadata text: the file's path, else its name.
    pub label: &'a str,
    pub provider: &'a str,
}

/// What the caller's resize answers (the `thread/resizeImage` result).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResizedImage {
    /// Base64 of the (possibly re-encoded) image.
    pub data: String,
    pub media_type: String,
    pub metadata_text: Option<String>,
}

/// The caller's resize: a call of the core's `thread/resizeImage`. Its error is the message to show (the image is too
/// large, or cannot be fitted).
pub type Resizer<'a> = &'a dyn Fn(&ResizeRequest<'_>) -> Result<ResizedImage, String>;

/// An image ready to attach to a prompt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImageAttachment {
    /// Base64.
    pub content: String,
    pub media_type: String,
    pub filename: String,
    pub source_path: String,
    pub metadata_text: Option<String>,
}

/// Where an image came from.
#[derive(Clone, Copy, Debug)]
pub struct AttachmentSource<'a> {
    pub filename: &'a str,
    pub source_path: &'a str,
    pub provider: &'a str,
}

impl Default for AttachmentSource<'_> {
    fn default() -> Self {
        AttachmentSource { filename: "Pasted image", source_path: "", provider: "" }
    }
}

/// `imageAttachmentFromBuffer`: the image through the caller's resize.
pub fn image_attachment_from_buffer(
    buffer: &[u8],
    mime_type: &str,
    source: &AttachmentSource<'_>,
    resize: Resizer<'_>,
) -> Result<ImageAttachment, String> {
    if buffer.is_empty() {
        return Err("image is empty".to_owned());
    }
    let label = if source.source_path.is_empty() { source.filename } else { source.source_path };
    let resized = resize(&ResizeRequest { bytes: buffer, mime_type, label, provider: source.provider })?;
    Ok(ImageAttachment {
        content: resized.data,
        media_type: resized.media_type,
        filename: source.filename.to_owned(),
        source_path: source.source_path.to_owned(),
        metadata_text: resized.metadata_text,
    })
}

/// Read an image named by a pasted path. `Ok(None)` when the text is not an image path or no such file exists; an error
/// when the file cannot be read or the resize refuses it. A relative path is taken from `cwd` (the current directory when
/// `None`).
pub fn read_image_attachment_from_path(
    raw_path: &str,
    cwd: Option<&Path>,
    provider: &str,
    platform: Platform,
    resize: Resizer<'_>,
) -> Result<Option<ImageAttachment>, String> {
    let cleaned = clean_path_text(raw_path, platform);
    let Some(mime_type) = mime_for_path(&cleaned) else {
        return Ok(None);
    };
    // `isAbsolute(cleaned) ? cleaned : resolve(cwd || process.cwd(), cleaned)`: an empty `cwd` is skipped by `resolve`,
    // which then starts from the process directory.
    let full_path = if mixdog_js::nodepath::is_absolute_host(&cleaned) {
        PathBuf::from(&cleaned)
    } else {
        let base = cwd.map(|dir| dir.to_string_lossy().into_owned()).unwrap_or_default();
        PathBuf::from(mixdog_js::nodepath::resolve_host(&[&base, &cleaned]))
    };
    match mixdog_fsio::metadata(&Unlaned, &full_path) {
        Ok(metadata) if metadata.is_file() => {}
        _ => return Ok(None),
    }
    let buffer = mixdog_fsio::read(&Unlaned, &full_path).map_err(|error| error.to_string())?;
    let filename = full_path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    let source_path = full_path.to_string_lossy().into_owned();
    image_attachment_from_buffer(
        &buffer,
        mime_type,
        &AttachmentSource { filename: &filename, source_path: &source_path, provider },
        resize,
    )
    .map(Some)
}

// ---- the clipboard readers -----------------------------------------------------------------------------------------

/// What a helper may write to stdout (Node's `maxBuffer`).
const MAX_HELPER_STDOUT: usize = 16 * 1024 * 1024;
const IMAGE_TIMEOUT: Duration = Duration::from_millis(5000);
const READ_TIMEOUT: Duration = Duration::from_millis(3000);

/// The PowerShell that saves the clipboard image to the path in `MIXDOG_CLIPBOARD_IMAGE_PATH` (exit 2: no image).
pub const WINDOWS_CLIPBOARD_IMAGE_SCRIPT: &str = "$p=$env:MIXDOG_CLIPBOARD_IMAGE_PATH; Add-Type -AssemblyName System.Drawing; $img=Get-Clipboard -Format Image; if ($null -eq $img) { exit 2 }; $img.Save($p, [System.Drawing.Imaging.ImageFormat]::Png)";
/// Base64 of `bytes` (the standard alphabet, padded).
pub fn base64_encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// The PowerShell that writes the clipboard text to stdout as base64 of UTF-8, so non-ASCII survives the console code page.
pub const WINDOWS_CLIPBOARD_TEXT_SCRIPT: &str = "$t=Get-Clipboard -Raw; if ($null -eq $t) { exit 2 }; [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t)))";

fn capture(program: &str, args: &[&str], timeout: Duration) -> HelperCommand {
    HelperCommand {
        capture_stdout: true,
        timeout: Some(timeout),
        max_stdout: Some(MAX_HELPER_STDOUT),
        ..HelperCommand::new(program, args)
    }
}

fn powershell(script: &str, timeout: Duration) -> HelperCommand {
    capture("powershell.exe", &["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], timeout)
}

/// The AppleScript that writes the clipboard image to `out`.
pub fn macos_clipboard_image_script(out: &str) -> String {
    format!(
        "set png_data to (the clipboard as «class PNGf»)\nset fp to open for access POSIX file \"{}\" with write permission\nwrite png_data to fp\nclose access fp",
        out.replace('"', "\\\"")
    )
}

/// `mixdog-clipboard-<pid>-<millis>-<8 hex digits>.png` in `dir`.
pub fn temp_png_path(dir: &Path, pid: u32, millis: u128, random: u32) -> PathBuf {
    dir.join(format!("mixdog-clipboard-{pid}-{millis}-{random:08x}.png"))
}

fn fresh_temp_png_path() -> PathBuf {
    use std::hash::{BuildHasher, Hasher};
    let millis = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis());
    let random = std::collections::hash_map::RandomState::new().build_hasher().finish() as u32;
    temp_png_path(&std::env::temp_dir(), std::process::id(), millis, random)
}

/// The clipboard image saved to a temporary file by the system's own tool (Windows PowerShell, macOS `osascript`), read
/// and removed. `None` when the clipboard holds no image.
fn read_clipboard_image_via_file(
    platform: Platform,
    runner: &dyn Runner,
    source: &AttachmentSource<'_>,
    resize: Resizer<'_>,
) -> Result<Option<ImageAttachment>, String> {
    let out = fresh_temp_png_path();
    let out_text = out.to_string_lossy().into_owned();
    let outcome = match platform {
        Platform::Windows => {
            let mut command = powershell(WINDOWS_CLIPBOARD_IMAGE_SCRIPT, IMAGE_TIMEOUT);
            command.env.push(("MIXDOG_CLIPBOARD_IMAGE_PATH".to_owned(), out_text.clone()));
            runner.run(&command)
        }
        Platform::Macos => runner.run(&capture("osascript", &["-e", &macos_clipboard_image_script(&out_text)], IMAGE_TIMEOUT)),
        _ => return Ok(None),
    };
    if !outcome.succeeded() || !mixdog_fsio::exists(&Unlaned, &out).unwrap_or(false) {
        return Ok(None);
    }
    let result = mixdog_fsio::read(&Unlaned, &out)
        .map_err(|error| error.to_string())
        .and_then(|buffer| image_attachment_from_buffer(&buffer, "image/png", source, resize));
    let _ = mixdog_fsio::remove_file(&Unlaned, &out);
    result.map(Some)
}

/// The image on the clipboard as an attachment: Linux asks `wl-paste` then `xclip` (3 s each); Windows and macOS save it
/// to a temporary file (5 s). `Ok(None)` when there is no image; an error when no Linux reader is installed.
pub fn read_clipboard_image_attachment(
    platform: Platform,
    runner: &dyn Runner,
    provider: &str,
    resize: Resizer<'_>,
) -> Result<Option<ImageAttachment>, String> {
    let source = AttachmentSource { provider, ..AttachmentSource::default() };
    if platform != Platform::Linux {
        return read_clipboard_image_via_file(platform, runner, &source, resize);
    }
    let wl = runner.run(&capture("wl-paste", &["--type", "image/png"], READ_TIMEOUT));
    if wl.succeeded() && !wl.stdout().is_empty() {
        return image_attachment_from_buffer(wl.stdout(), "image/png", &source, resize).map(Some);
    }
    let xc = runner.run(&capture("xclip", &["-selection", "clipboard", "-t", "image/png", "-o"], READ_TIMEOUT));
    if xc.succeeded() && !xc.stdout().is_empty() {
        return image_attachment_from_buffer(xc.stdout(), "image/png", &source, resize).map(Some);
    }
    if wl.not_found() && xc.not_found() {
        return Err(no_clipboard_reader_error().0);
    }
    Ok(None)
}

/// The text on the clipboard, `""` on any miss. Windows asks PowerShell (base64 of UTF-8, 3 s), macOS `pbpaste`, Linux
/// `wl-paste --no-newline` then `xclip -selection clipboard -o`; an error only when no Linux reader is installed.
pub fn read_clipboard_text(platform: Platform, runner: &dyn Runner) -> Result<String, String> {
    match platform {
        Platform::Windows => {
            let outcome = runner.run(&powershell(WINDOWS_CLIPBOARD_TEXT_SCRIPT, READ_TIMEOUT));
            if !outcome.succeeded() || outcome.stdout().is_empty() {
                return Ok(String::new());
            }
            let encoded = String::from_utf8_lossy(outcome.stdout()).trim().to_owned();
            let engine = base64::engine::GeneralPurpose::new(
                &base64::alphabet::STANDARD,
                base64::engine::GeneralPurposeConfig::new().with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent),
            );
            Ok(engine.decode(encoded).map(|bytes| String::from_utf8_lossy(&bytes).into_owned()).unwrap_or_default())
        }
        Platform::Macos => {
            let outcome = runner.run(&capture("pbpaste", &[], READ_TIMEOUT));
            Ok(if outcome.succeeded() { String::from_utf8_lossy(outcome.stdout()).into_owned() } else { String::new() })
        }
        Platform::Linux => {
            let wl = runner.run(&capture("wl-paste", &["--no-newline"], READ_TIMEOUT));
            if wl.succeeded() && !wl.stdout().is_empty() {
                return Ok(String::from_utf8_lossy(wl.stdout()).into_owned());
            }
            let xc = runner.run(&capture("xclip", &["-selection", "clipboard", "-o"], READ_TIMEOUT));
            if xc.succeeded() && !xc.stdout().is_empty() {
                return Ok(String::from_utf8_lossy(xc.stdout()).into_owned());
            }
            if wl.not_found() && xc.not_found() {
                return Err(no_clipboard_reader_error().0);
            }
            Ok(String::new())
        }
        Platform::Other => Ok(String::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_trailing_newline_is_not_a_line() {
        assert_eq!(pasted_text_line_count("a\nb\n"), 2);
        assert_eq!(pasted_text_line_count("a\r\nb\r\n\r\n"), 2);
        assert_eq!(pasted_text_line_count("\n\n"), 0);
        assert_eq!(pasted_text_line_count(""), 0);
        assert_eq!(format_pasted_text_ref(3, "x\ny\nz"), "[Pasted text #3 +3 lines]");
    }

    #[test]
    fn a_paste_folds_only_above_a_thousand_characters() {
        assert!(!should_fold_pasted_text(&"x".repeat(999)));
        assert!(!should_fold_pasted_text(&"x".repeat(1000)));
        assert!(should_fold_pasted_text(&"x".repeat(1001)));
        assert!(!should_fold_pasted_text(""));
        // UTF-16 units: 501 astral characters are 1002 units.
        assert!(should_fold_pasted_text(&"\u{1F600}".repeat(501)));
    }

    #[test]
    fn references_are_found_where_they_stand() {
        let ids = image_reference_ids("a [Image #2] b [Image #10][Image #2] [Image #0] [Image #x] [Image #3");
        assert_eq!(ids.into_iter().collect::<Vec<_>>(), vec![2, 10]);
        let ids = pasted_text_reference_ids("[Pasted text #1 +4 lines] [Pasted text #7 +x lines] [Pasted text #9 +12 lines]");
        assert_eq!(ids.into_iter().collect::<Vec<_>>(), vec![1, 9]);
        assert!(image_reference_ids("[Image #[Image #5]").contains(&5));
    }

    #[test]
    fn the_prompt_carries_only_the_images_it_references() {
        let mut images = BTreeMap::new();
        for id in [1_u64, 2] {
            images.insert(
                id,
                PastedImage {
                    id,
                    content: format!("data{id}"),
                    media_type: (id == 2).then(|| "image/jpeg".to_owned()),
                    metadata_text: (id == 1).then(|| "[Image: 1x1]".to_owned()),
                },
            );
        }
        assert_eq!(build_prompt_content_with_images("hi", &images), PromptContent::Text("hi".to_owned()));
        assert_eq!(
            build_prompt_content_with_images(" see [Image #1] and [Image #2] ", &images),
            PromptContent::Parts(vec![
                PromptPart::Text(" see [Image #1] and [Image #2] ".to_owned()),
                PromptPart::Text("[Image: 1x1]".to_owned()),
                PromptPart::Image { data: "data1".to_owned(), mime_type: "image/png".to_owned(), paste_id: 1 },
                PromptPart::Image { data: "data2".to_owned(), mime_type: "image/jpeg".to_owned(), paste_id: 2 },
            ])
        );
        assert_eq!(
            build_prompt_content_with_images("  [Image #2]", &images),
            PromptContent::Parts(vec![
                PromptPart::Text("  [Image #2]".to_owned()),
                PromptPart::Image { data: "data2".to_owned(), mime_type: "image/jpeg".to_owned(), paste_id: 2 },
            ])
        );
    }

    #[test]
    fn a_paste_splits_at_spaces_before_paths() {
        let parts = split_pasted_image_path_candidates("/a/one.png ~/two.JPG C:\\three.gif\r\nnote file:///x/four.webp  x", Platform::Linux);
        let texts: Vec<(&str, bool)> = parts.iter().map(|part| (part.text.as_str(), part.image_path)).collect();
        assert_eq!(
            texts,
            vec![
                ("/a/one.png", true),
                ("~/two.JPG", true),
                ("C:\\three.gif", true),
                ("\n", false),
                ("note", false),
                ("file:///x/four.webp  x", false),
            ]
        );
    }

    #[test]
    fn a_pasted_path_is_cleaned() {
        assert_eq!(clean_path_text("  \"/a b/c.png\"  ", Platform::Linux), "/a b/c.png");
        assert_eq!(clean_path_text("'/a/c.png'", Platform::Linux), "/a/c.png");
        assert_eq!(clean_path_text("\"", Platform::Linux), "");
        assert_eq!(clean_path_text("/a\\ b/c\\(1\\).png", Platform::Linux), "/a b/c(1).png");
        assert_eq!(clean_path_text("/a\\ b/c.png", Platform::Windows), "/a\\ b/c.png");
        assert_eq!(clean_path_text("file:///home/u/a%20b.png", Platform::Linux), "/home/u/a b.png");
        assert_eq!(clean_path_text("file:///C:/Users/u/a%20b.png", Platform::Windows), "C:\\Users\\u\\a b.png");
        assert_eq!(clean_path_text("file:///C:/Users/u/a%20b.png", Platform::Linux), "/C:/Users/u/a b.png");
        assert_eq!(clean_path_text("file:///x/%ZZ.png", Platform::Linux), "file:///x/%ZZ.png");
        assert_eq!(clean_path_text("file://host/x/../y.png?q=1#f", Platform::Linux), "/y.png");
    }

    #[test]
    fn the_extension_names_the_image_type() {
        assert_eq!(mime_for_path("/a/b.PNG"), Some("image/png"));
        assert_eq!(mime_for_path("b.jpeg"), Some("image/jpeg"));
        assert_eq!(mime_for_path("b.webp"), Some("image/webp"));
        assert_eq!(mime_for_path("b.bmp"), None);
        assert_eq!(mime_for_path("png"), None);
    }

    #[test]
    fn the_temporary_file_is_named_for_the_process_and_time() {
        assert_eq!(
            temp_png_path(Path::new("/tmp"), 42, 1700000000000, 0xAB),
            Path::new("/tmp").join("mixdog-clipboard-42-1700000000000-000000ab.png")
        );
    }
}
