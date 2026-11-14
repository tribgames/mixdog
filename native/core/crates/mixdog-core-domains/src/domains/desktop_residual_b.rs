//! The logic of the second batch of desktop main-process files that handle no Electron object, in the core (owner direction 14).
//!
//! Methods (all of the PC the core runs on, so Local origin only):
//! - `desktop/localLink/open` (`local-file-links.ts`): the decision for a chat link to a file or folder under a project: the link is
//!   validated, resolved against the project, checked twice against the project boundary (lexically and through the real paths, so a
//!   junction or symlink cannot escape) and answered as `{result: "editor"}` (hand the file to Mixdog's editor), `{result: "file" | "folder",
//!   path}` (the OS opens `path`; the OS hand-off itself is Electron's `shell.openPath`, which the caller performs) or
//!   `{confirmationPath}` (an executable target, which needs the user's confirmation first; asking again with `confirmedPath` equal to it
//!   proceeds). The allowlists are `shared/local-files.ts` and `shared/file-preview.ts`.
//! - `desktop/attachment/write` (`attachment-files.ts`): a `data:` attachment written under `<temp>/mixdog-attachments` with a stem and an
//!   extension that cannot launch code; answers its path.
//! - `desktop/attachment/thumbnail` (`attachment-thumbnail.ts`): the thumbnail data URL of a stored attachment image.
//! - `desktop/launchVersion/record` and `desktop/launchVersion/acknowledge` (`launch-version.ts`): the launch/update record of the profile.
//! - `desktop/modelBootstrap/read` (`model-bootstrap.ts`): the persisted model route for the first snapshot, read from the config file.
//! - `desktop/nativeToolCache/gc` (`native-runtime-cache-gc.mjs`): the caches of native tools a bundled copy superseded.
//! - `desktop/userFile/write` (`user-file-write.ts`): a user-owned file written so that a crash cannot leave it NUL-filled.
//! - `desktop/computer/inputAccess/request` (`linux-input-access.ts`): the `/dev/uinput` access rule of Computer Use on Linux.
//!
//! Library parts with no method: [`ImportProgress`] (`conversation-import-progress.ts`), [`NetworkWatcher`] (`network-watch.ts`) and the
//! login shell environment read (`login-shell-environment.ts`, which runs before the core exists).
//!
//! The other rows of the verdict table's batch are already in Rust and are not repeated here: `agent-memory.ts` (`agent/memory/*`),
//! `approval-grant-change.ts` (the approval answer announces `permissions`), `child-environment.ts` (`mixdog-tools` exec env),
//! `feedback-client.ts` (`feedback/upload`), `git-contract.mjs` and `ipc-control-chars.ts` (the boundary validators), `mixy-first.ts`
//! (`lead_service`, `greetings`) and `session-sidebar-actions.ts` (the session settings of `mixdog-core-session`).

#![allow(clippy::disallowed_methods, reason = "file work runs as the body of a durability-io lane job; helpers wait on child processes and time")]

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::io::Write;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine;
use futures::future::BoxFuture;
use futures::future::FutureExt;
use futures::future::Shared;
use mixdog_app_protocol::common::repository_cwd;
use mixdog_app_protocol::common::required_text;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_core_api::service::DomainService;
use mixdog_core_base::support::decode;
use mixdog_core_base::support::failed;
use mixdog_core_base::support::invalid;
use mixdog_core_base::support::on_lane_wait;
use mixdog_core_base::support::write_atomic;
use mixdog_core_base::support::wrong_method;
use mixdog_js::is_js_space;
use mixdog_js::js_trim;
use mixdog_js::json_parse;
use mixdog_js::value_to_string;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InLane;
use mixdog_rt::LaneTokens;
use serde::Deserialize;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;
use url::Url;

use super::desktop_residual::AttachmentHost;
use super::desktop_residual::host_platform;
use super::update::compare_semver;

const DOMAIN: &str = "desktop";

fn type_error(message: &str) -> CoreError {
    failed(DOMAIN, message)
}

/// `fileExtension` (`shared/file-extension.ts`): the text after the last dot of the last path segment, lower case; none when the dot
/// ends the name.
fn file_extension(path: &str) -> String {
    let name = path.rsplit(['/', '\\']).next().unwrap_or_default();
    match name.rfind('.') {
        Some(dot) if dot + 1 < name.len() => name[dot + 1..].to_lowercase(),
        _ => String::new(),
    }
}

/// `String(value || '')`: the text of a truthy value, empty for a falsy one.
fn js_text(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null | Value::Bool(false)) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) if number.as_f64() == Some(0.0) => String::new(),
        Some(other) => value_to_string(other),
    }
}

/// Text that holds no data: empty, or only NULs and white space (a crash leaves a user-edited file so).
fn holds_no_data(text: &str) -> bool {
    text.chars().all(|c| c == '\0' || is_js_space(c))
}

// ---------------------------------------------------------------------------------------------------------------------
// Local file links (local-file-links.ts, file-launch.ts, shared/local-files.ts, shared/file-preview.ts)
// ---------------------------------------------------------------------------------------------------------------------

const EXECUTABLE_PACKAGE_EXTENSIONS: &[&str] = &["exe", "msi", "msix", "msixbundle", "appx", "appxbundle", "dmg", "pkg", "app"];
const FILE_LAUNCH_EXTENSIONS: &[&str] = &[
    "com", "scr", "bat", "cmd", "ps1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "hta", "lnk", "url", "appref-ms", "scf", "sh", "command", "desktop",
    "appimage",
];
const OS_DOCUMENT_EXTENSIONS: &[&str] = &[
    "zip", "7z", "rar", "iso", "pptx", "ppt", "pdf", "docx", "doc", "dotx", "xlsx", "xls", "rtf", "odt", "ods", "odp", "png", "jpg", "jpeg", "jfif", "gif",
    "webp", "avif", "svg", "bmp", "tif", "tiff", "ico", "mp3", "wav", "ogg", "flac", "m4a", "mp4", "m4v", "mov", "webm", "mkv",
];
const DOCUMENT_PREVIEW_FORMATS: &[&str] =
    &["docx", "doc", "docm", "dotx", "rtf", "odt", "xlsx", "xls", "xlsm", "ods", "pptx", "ppt", "pptm", "odp"];

/// `requiresFileLaunchConfirmation`: a file the OS would run needs Mixdog's confirmation before it is handed over.
pub fn requires_file_launch_confirmation(path: &str) -> bool {
    let extension = file_extension(path);
    EXECUTABLE_PACKAGE_EXTENSIONS.contains(&extension.as_str()) || FILE_LAUNCH_EXTENSIONS.contains(&extension.as_str())
}

/// `editorFileOpener`: `true` when the OS default app opens the file; everything the editor can show (native previews, convertible
/// documents, text) stays in Mixdog.
pub fn opens_in_os(path: &str) -> bool {
    let extension = file_extension(path);
    if mixdog_workspace::preview::file_preview_type(Path::new(path)).is_some() || DOCUMENT_PREVIEW_FORMATS.contains(&extension.as_str()) {
        return false;
    }
    EXECUTABLE_PACKAGE_EXTENSIONS.contains(&extension.as_str()) || OS_DOCUMENT_EXTENSIONS.contains(&extension.as_str())
}

/// `decodeURIComponent`: `None` for a malformed escape or bytes that are not UTF-8.
fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = bytes.get(index + 1..index + 3)?;
            if !hex.iter().all(u8::is_ascii_hexdigit) {
                return None;
            }
            out.push(u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Whether a path segment names a Windows device or ends in a dot or a space (`localLinkPath`'s Windows rule).
fn windows_invalid_segment(part: &str) -> bool {
    if part != "." && part != ".." && part.ends_with(['.', ' ']) {
        return true;
    }
    let stem = part.split('.').next().unwrap_or_default().to_ascii_lowercase();
    matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
        || (stem.len() == 4 && (stem.starts_with("com") || stem.starts_with("lpt")) && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}

/// `localLinkPath`: the path a link's href names, with `/` separators; refuses what is not a plain local path.
pub fn local_link_path(raw: &str, windows: bool) -> Result<String, CoreError> {
    if raw.chars().any(|c| c < '\u{20}' || c == '\u{7f}') {
        return Err(type_error("Invalid file link."));
    }
    let mut target = if raw.get(..5).is_some_and(|scheme| scheme.eq_ignore_ascii_case("file:")) {
        let url = Url::parse(raw).map_err(|_| type_error("Invalid file link."))?;
        if url.host_str().is_some_and(|host| !host.is_empty() && !host.eq_ignore_ascii_case("localhost")) {
            return Err(type_error("Network file links are not supported."));
        }
        let path = url.to_file_path().map_err(|()| type_error("Invalid local file path."))?;
        path.to_string_lossy().into_owned()
    } else {
        let without_query = raw.split(['?', '#']).next().unwrap_or_default();
        decode_uri_component(without_query).ok_or_else(|| type_error("URI malformed"))?
    };
    target = target.replace('\\', "/");
    let bytes = target.as_bytes();
    let drive_path = bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/';
    let colon_scope = if drive_path { &target[2..] } else { target.as_str() };
    if target.is_empty()
        || target.starts_with("//")
        || target.chars().any(|c| c < '\u{20}' || c == '\u{7f}' || matches!(c, '<' | '>' | '|' | '*' | '"'))
        // `path.isAbsolute('C:/x')` is true on Windows only.
        || (drive_path && !windows)
        || colon_scope.contains(':')
    {
        return Err(type_error("Invalid local file path."));
    }
    if windows && target.split('/').any(windows_invalid_segment) {
        return Err(type_error("Invalid local file path."));
    }
    Ok(target)
}

/// `path.resolve(root, target)` without touching the disk: `.` dropped, `..` popping (never above the root).
fn lexical_resolve(root: &Path, target: &str) -> PathBuf {
    let mut out = PathBuf::new();
    for component in root.join(target).components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn components_of(path: &Path, windows: bool) -> Vec<String> {
    path.components()
        .map(|component| {
            let text = component.as_os_str().to_string_lossy().into_owned();
            if windows { text.to_lowercase() } else { text }
        })
        .collect()
}

/// `assertInsideProject`: the target is the root or below it.
fn is_inside(root: &Path, target: &Path, windows: bool) -> bool {
    let (root, target) = (components_of(root, windows), components_of(target, windows));
    target.len() >= root.len() && root.iter().zip(&target).all(|(a, b)| a == b)
}

/// `relative(root, target)` with `/` separators, for a target inside the root.
fn relative_slash(root: &Path, target: &Path) -> String {
    let skip = root.components().count();
    target.components().skip(skip).map(|component| component.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/")
}

/// `realpath` as Node answers it: Windows' verbatim prefix is dropped.
fn real_path(path: &Path) -> std::io::Result<PathBuf> {
    let real = std::fs::canonicalize(path)?;
    if !cfg!(windows) {
        return Ok(real);
    }
    let text = real.to_string_lossy().into_owned();
    Ok(match (text.strip_prefix(r"\\?\UNC\"), text.strip_prefix(r"\\?\")) {
        (Some(rest), _) => PathBuf::from(format!(r"\\{rest}")),
        (None, Some(rest)) => PathBuf::from(rest),
        (None, None) => real,
    })
}

/// What opening a local link comes to.
#[derive(Debug, PartialEq, Eq)]
pub enum LocalLinkOutcome {
    /// An executable target: ask the user, then ask again with `confirmedPath` set to this path.
    Confirm(String),
    /// Mixdog's editor shows the file; nothing is launched.
    Editor,
    /// The OS opens `path` (a `file` with an allowlisted type, or a `folder`).
    Open { kind: &'static str, path: String },
}

/// `launchFile`: the canonical path when it needs the user's confirmation that `confirmed` does not give; a changed symlink needs a
/// new answer because the path is resolved again.
fn launch_decision(file: &Path, confirmed: Option<&str>) -> std::io::Result<Option<String>> {
    let canonical = real_path(file)?;
    let info = std::fs::metadata(&canonical)?;
    let text = canonical.to_string_lossy().into_owned();
    #[cfg(unix)]
    let executable = {
        use std::os::unix::fs::PermissionsExt;
        info.is_file() && info.permissions().mode() & 0o111 != 0
    };
    #[cfg(not(unix))]
    let executable = {
        let _ = &info;
        false
    };
    Ok(((executable || requires_file_launch_confirmation(&text)) && confirmed != Some(text.as_str())).then_some(text))
}

fn io_error(path: &Path, error: &std::io::Error) -> CoreError {
    failed(DOMAIN, format!("{}: {error}", path.display()))
}

/// `openLocalFileLink` up to the OS hand-off.
pub fn decide_local_link(project: &str, href: &str, confirmed: Option<&str>, windows: bool) -> Result<LocalLinkOutcome, CoreError> {
    let root = lexical_resolve(Path::new(project), ".");
    let absolute = lexical_resolve(&root, &local_link_path(href, windows)?);
    let escapes = || type_error("The file path escapes the project directory.");
    if !is_inside(&root, &absolute, windows) {
        return Err(escapes());
    }
    // Real targets too: a directory junction or renamed symlink must not bypass the project boundary.
    let real_root = real_path(&root).map_err(|error| io_error(&root, &error))?;
    let real_target = match real_path(&absolute) {
        Ok(path) => path,
        // A chat link outlives its file: working copies get renamed or removed after the reply is written.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(failed(DOMAIN, format!("The file no longer exists: {}", relative_slash(&root, &absolute))));
        }
        Err(error) => return Err(io_error(&absolute, &error)),
    };
    if !is_inside(&real_root, &real_target, windows) {
        return Err(escapes());
    }
    let info = std::fs::metadata(&real_target).map_err(|error| io_error(&real_target, &error))?;
    let launch = |kind: &'static str| -> Result<LocalLinkOutcome, CoreError> {
        Ok(match launch_decision(&real_target, confirmed).map_err(|error| io_error(&real_target, &error))? {
            Some(path) => LocalLinkOutcome::Confirm(path),
            None => LocalLinkOutcome::Open { kind, path: real_target.to_string_lossy().into_owned() },
        })
    };
    if info.is_dir() {
        return launch("folder");
    }
    if !info.is_file() {
        return Err(type_error("The link must point to a file or folder."));
    }
    if !opens_in_os(&real_target.to_string_lossy()) {
        return Ok(LocalLinkOutcome::Editor);
    }
    launch("file")
}

// ---------------------------------------------------------------------------------------------------------------------
// Attachment files (attachment-files.ts, ipc-validation.ts requiredAttachmentFile)
// ---------------------------------------------------------------------------------------------------------------------

const MAX_DATA_URL_BYTES: usize = 256 * 1024 * 1024;
const MIME_EXTENSIONS: &[(&str, &str)] = &[
    ("application/pdf", "pdf"),
    ("application/json", "json"),
    ("text/plain", "txt"),
    ("text/markdown", "md"),
    ("text/csv", "csv"),
    ("image/png", "png"),
    ("image/jpeg", "jpg"),
    ("image/webp", "webp"),
    ("image/gif", "gif"),
    ("image/bmp", "bmp"),
    ("audio/mpeg", "mp3"),
    ("video/mp4", "mp4"),
];
/// The inert document, media and plain-text types: anything else (scripts, installers, markup a browser would run) is never handed to
/// the OS from a file this process just wrote.
const OPENABLE_ATTACHMENT_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "tif", "tiff", "heic", "ico", "pdf", "doc", "docx", "dot", "dotx", "xls", "xlsx", "ppt", "pptx", "odt",
    "ods", "odp", "rtf", "txt", "md", "csv", "tsv", "json", "log", "yaml", "yml", "toml", "ini", "mp3", "wav", "ogg", "flac", "m4a", "mp4", "webm", "mov", "mkv",
];

/// `decodeDataUrl`: the lower-cased mime and the bytes of a base64 or percent-encoded `data:` URL.
fn decode_data_url(value: &str) -> Result<(String, Vec<u8>), CoreError> {
    let bad = || type_error("data URL is invalid.");
    let text = js_trim(value);
    let rest = text.get(..5).filter(|scheme| scheme.eq_ignore_ascii_case("data:")).map(|_| &text[5..]).ok_or_else(bad)?;
    let (head, payload) = rest.split_once(',').ok_or_else(bad)?;
    let params: Vec<&str> = head.split(';').map(js_trim).collect();
    let mime = if params[0].is_empty() { "text/plain".to_owned() } else { params[0].to_lowercase() };
    let bytes = if params.iter().skip(1).any(|part| part.eq_ignore_ascii_case("base64")) {
        let body: String = payload.chars().filter(|c| !is_js_space(*c)).collect();
        let digits = body.trim_end_matches('=');
        if body.len() - digits.len() > 2 || !digits.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/') {
            return Err(bad());
        }
        let config = base64::engine::GeneralPurposeConfig::new()
            .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true);
        base64::engine::GeneralPurpose::new(&base64::alphabet::STANDARD, config).decode(digits).map_err(|_| bad())?
    } else {
        decode_uri_component(payload).ok_or_else(bad)?.into_bytes()
    };
    if bytes.len() > MAX_DATA_URL_BYTES {
        return Err(type_error("data URL is too large."));
    }
    Ok((mime, bytes))
}

/// `attachmentImageBaseName`: a stem of word characters and dashes, at most 60 long, `image` when nothing is left.
fn attachment_base_name(name: &str) -> String {
    let stem = match name.rfind('.') {
        Some(dot) if !name[dot + 1..].contains(['/', '\\']) => &name[..dot],
        _ => name,
    };
    let mut label = String::new();
    let mut dashed = false;
    for c in stem.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            label.push(c);
            dashed = false;
        } else if !dashed {
            label.push('-');
            dashed = true;
        }
    }
    let label: String = label.trim_matches('-').chars().take(60).collect();
    if label.is_empty() { "image".to_owned() } else { label }
}

/// `requiredAttachmentFile`: the bytes with a stem and an extension that cannot launch code.
pub fn required_attachment_file(data_url: &Value, name: &Value) -> Result<(Vec<u8>, String, String), CoreError> {
    let Value::String(data_url) = data_url else { return Err(type_error("data URL must be a string.")) };
    let (mime, bytes) = decode_data_url(data_url)?;
    if bytes.is_empty() {
        return Err(type_error("attachment data URL is empty."));
    }
    let name = name.as_str().unwrap_or_default();
    let trimmed = js_trim(name);
    let named = trimmed
        .rfind('.')
        .map(|dot| trimmed[dot + 1..].to_lowercase())
        .filter(|ext| (1..=10).contains(&ext.len()) && ext.bytes().all(|b| b.is_ascii_alphanumeric()));
    let text_kind = mime.starts_with("text/")
        || matches!(mime.as_str(), "application/json" | "application/xml" | "application/x-yaml")
        || mime.ends_with("+json")
        || mime.ends_with("+xml");
    let derived = MIME_EXTENSIONS.iter().find(|(known, _)| *known == mime).map(|(_, extension)| (*extension).to_owned());
    let extension = [named, derived]
        .into_iter()
        .flatten()
        .find(|candidate| OPENABLE_ATTACHMENT_EXTENSIONS.contains(&candidate.as_str()))
        .or_else(|| text_kind.then(|| "txt".to_owned()))
        .ok_or_else(|| type_error("attachment type cannot be opened."))?;
    Ok((bytes, attachment_base_name(name), extension))
}

fn hex16(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().take(8).map(|byte| format!("{byte:02x}")).collect()
}

/// `writeAttachmentFile`: `<temp>/mixdog-attachments/<stem>-<digest16>.<extension>`, owner-only. Nothing touches the disk before the type
/// is accepted.
pub fn write_attachment_file(temp: &Path, data_url: &Value, name: &Value) -> Result<PathBuf, CoreError> {
    let (bytes, base, extension) = required_attachment_file(data_url, name)?;
    if temp.as_os_str().is_empty() {
        return Err(type_error("Unable to open file: no temporary directory."));
    }
    let directory = temp.join("mixdog-attachments");
    std::fs::create_dir_all(&directory).map_err(|error| io_error(&directory, &error))?;
    let file = directory.join(format!("{base}-{}.{extension}", hex16(&bytes)));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(&file).and_then(|mut handle| handle.write_all(&bytes)).map_err(|error| io_error(&file, &error))?;
    Ok(file)
}

// ---------------------------------------------------------------------------------------------------------------------
// Attachment thumbnails (attachment-thumbnail.ts)
// ---------------------------------------------------------------------------------------------------------------------

const THUMBNAIL_MAX_SIDE: f64 = 320.0;
const THUMBNAIL_FALLBACK_MAX_BYTES: usize = 512 * 1024;
const JPEG_QUALITY: u8 = 82;

fn is_attachment_ref(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `sniffImageMime`: the image type a byte stream's signature names.
fn sniff_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

fn data_url_of(mime: &str, bytes: &[u8]) -> String {
    format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// A JPEG picture scaled to fit 320 pixels on its longest side and encoded at quality 82; `None` when it does not decode.
fn downscaled_jpeg(bytes: &[u8]) -> Option<Vec<u8>> {
    let decoded = image::load_from_memory_with_format(bytes, image::ImageFormat::Jpeg).ok()?.to_rgb8();
    let (width, height) = decoded.dimensions();
    if width == 0 || height == 0 {
        return None;
    }
    let scale = (THUMBNAIL_MAX_SIDE / f64::from(width.max(height))).min(1.0);
    let rgb = if scale < 1.0 {
        let side = |length: u32| ((f64::from(length) * scale + 0.5).floor() as u32).max(1);
        image::imageops::resize(&decoded, side(width), side(height), image::imageops::FilterType::Lanczos3)
    } else {
        decoded
    };
    let (width, height) = rgb.dimensions();
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY).encode(&rgb.into_raw(), width, height, image::ExtendedColorType::Rgb8).ok()?;
    Some(out)
}

/// `readAttachmentThumbnail` over stored bytes: a downscaled JPEG when the picture decodes, else the original (bounded) which the phone's
/// renderer downscales before caching, else nothing. Only JPEG decodes here: no PNG, GIF or WebP decoder is in the build.
pub fn thumbnail_of(bytes: &[u8], fallback_max_bytes: usize) -> Option<String> {
    if bytes.is_empty() {
        return None;
    }
    let mime = sniff_image_mime(bytes);
    if mime == Some("image/jpeg")
        && let Some(jpeg) = downscaled_jpeg(bytes)
    {
        return Some(data_url_of("image/jpeg", &jpeg));
    }
    let mime = mime?;
    (bytes.len() <= fallback_max_bytes).then(|| data_url_of(mime, bytes))
}

// ---------------------------------------------------------------------------------------------------------------------
// Launch record (launch-version.ts)
// ---------------------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
struct LaunchRecord {
    last_launched: String,
    /// The update announced on the next launches until it is acknowledged.
    pending_announcement: Option<String>,
}

impl LaunchRecord {
    fn to_text(&self) -> String {
        let mut record = Map::new();
        record.insert("lastLaunched".into(), json!(self.last_launched));
        if let Some(pending) = &self.pending_announcement {
            record.insert("pendingAnnouncement".into(), json!(pending));
        }
        format!("{}\n", Value::Object(record))
    }
}

/// The first form of the record: the bare version, e.g. `1.1.0`.
fn is_bare_version(text: &str) -> bool {
    let body = text.strip_prefix('v').unwrap_or(text);
    let mut parts = body.splitn(3, '.');
    let digits = |part: Option<&str>| part.is_some_and(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()));
    if !digits(parts.next()) || !digits(parts.next()) {
        return false;
    }
    let tail = parts.next().unwrap_or_default();
    let patch = tail.bytes().take_while(u8::is_ascii_digit).count();
    patch > 0 && tail[patch..].bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'+' | b'-'))
}

/// A record a crash left empty or NUL-filled is no record (read as a version it would be 0.0.0, and every launch after it would
/// announce an update), nor is truncated JSON or junk.
fn read_launch_record(path: &Path) -> Option<LaunchRecord> {
    let text = String::from_utf8_lossy(&std::fs::read(path).ok()?).into_owned();
    if holds_no_data(&text) {
        return None;
    }
    let text = js_trim(&text);
    if let Ok(Value::Object(parsed)) = json_parse(text)
        && let Some(last) = parsed.get("lastLaunched").and_then(Value::as_str)
    {
        return Some(LaunchRecord {
            last_launched: last.to_owned(),
            pending_announcement: parsed.get("pendingAnnouncement").and_then(Value::as_str).map(str::to_owned),
        });
    }
    is_bare_version(text).then(|| LaunchRecord { last_launched: text.to_owned(), pending_announcement: None })
}

/// The launch goes on when the write fails; this only costs the announcement's retry evidence, so the failure is reported, not raised.
fn write_launch_record(lane: &InLane<DurabilityIo>, path: &Path, record: &LaunchRecord) -> Option<String> {
    write_atomic(lane, path, record.to_text().as_bytes(), false).err().map(|failure| format!("{}: {}", path.display(), failure.error))
}

/// `recordLaunchVersion`: records `version` as launched and answers whether its update is still to be announced (plus the write failure,
/// if any). An update is a strictly newer version than the recorded previous launch (a downgrade announces nothing) or, with no
/// record, a relaunch after an update (`--updated`). The pending announcement survives later launches until acknowledged.
pub fn record_launch_version(lane: &InLane<DurabilityIo>, path: &Path, version: &str, argv: &[String]) -> (bool, Option<String>) {
    let previous = read_launch_record(path);
    let updated = match &previous {
        Some(record) => compare_semver(version, &record.last_launched) == std::cmp::Ordering::Greater,
        None => argv.iter().any(|arg| arg == "--updated"),
    };
    let pending = (updated || previous.as_ref().and_then(|record| record.pending_announcement.as_deref()) == Some(version)).then(|| version.to_owned());
    let next = LaunchRecord { last_launched: version.to_owned(), pending_announcement: pending.clone() };
    let error = if previous.as_ref() != Some(&next) { write_launch_record(lane, path, &next) } else { None };
    (pending.is_some(), error)
}

/// `acknowledgeAnnouncement`: the renderer showed (or could never show) `version`'s notice: stop retrying it.
pub fn acknowledge_announcement(lane: &InLane<DurabilityIo>, path: &Path, version: &str) -> Option<String> {
    let record = read_launch_record(path)?;
    if record.pending_announcement.as_deref() != Some(version) {
        return None;
    }
    write_launch_record(lane, path, &LaunchRecord { last_launched: record.last_launched, pending_announcement: None })
}

// ---------------------------------------------------------------------------------------------------------------------
// Model bootstrap (model-bootstrap.ts)
// ---------------------------------------------------------------------------------------------------------------------

fn selected_preset(agent: &Map<String, Value>) -> Option<Map<String, Value>> {
    // Storage holds only the delta from the shipped presets; the effective list is rebuilt.
    let presets: Vec<Map<String, Value>> =
        mixdog_core_config::workflow::effective_presets(agent).into_iter().filter_map(|preset| preset.as_object().cloned()).collect();
    let key = agent.get("default").filter(|key| !matches!(key, Value::Null) && key.as_str() != Some(""))?;
    let key_text = value_to_string(key);
    if key.is_number() || (!key_text.is_empty() && key_text.bytes().all(|b| b.is_ascii_digit())) {
        return key_text.parse::<usize>().ok().and_then(|index| presets.get(index).cloned());
    }
    presets.into_iter().find(|preset| {
        let id = js_text(preset.get("id"));
        (if id.is_empty() { js_text(preset.get("name")) } else { id }) == key_text
    })
}

/// `desktopModelBootstrapFromConfig`: the first snapshot's model route (provider, model, effort, fast) of a config document, `None` when
/// the document names no usable default.
pub fn model_bootstrap_from_config(config: &Value) -> Option<Value> {
    let mut agent = config.get("agent")?.as_object()?;
    if let Some(inner) = agent.get("agent").and_then(Value::as_object)
        && !js_text(inner.get("providers")).is_empty()
    {
        agent = inner;
    }
    let preset = selected_preset(agent);
    let text = |key: &str| js_trim(&js_text(preset.as_ref().and_then(|preset| preset.get(key)))).to_owned();
    let (provider, model) = (text("provider"), text("model"));
    if provider.is_empty() || model.is_empty() {
        return None;
    }
    let route = format!("{provider}/{model}");
    let setting = agent.get("modelSettings").and_then(Value::as_object).and_then(|settings| settings.get(&route)).and_then(Value::as_object);
    let effort_text = [setting.and_then(|s| s.get("effort")), preset.as_ref().and_then(|p| p.get("effort"))]
        .into_iter()
        .map(js_text)
        .find(|text| !text.is_empty())
        .unwrap_or_default();
    let effort = js_trim(&effort_text);
    let fast = if let Some(setting) = setting.filter(|setting| setting.contains_key("fast")) {
        Some(setting.get("fast") == Some(&Value::Bool(true)))
    } else if agent.get("fastModels").and_then(Value::as_object).and_then(|models| models.get(&route)) == Some(&Value::Bool(true)) {
        Some(true)
    } else {
        preset.as_ref().filter(|preset| preset.contains_key("fast")).map(|preset| preset.get("fast") == Some(&Value::Bool(true)))
    };
    let mut snapshot = json!({ "items": [], "queued": [], "busy": false, "commandBusy": false, "provider": provider, "model": model });
    if !effort.is_empty() {
        snapshot["effort"] = json!(effort);
    }
    if let Some(fast) = fast {
        snapshot["fast"] = json!(fast);
    }
    Some(snapshot)
}

/// `readDesktopModelBootstrapSnapshot`: `None` when the file is missing, unreadable or not JSON.
pub fn read_model_bootstrap(config_path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(config_path).ok()?;
    model_bootstrap_from_config(&json_parse(&text).ok()?)
}

// ---------------------------------------------------------------------------------------------------------------------
// Native tool caches (native-runtime-cache-gc.mjs)
// ---------------------------------------------------------------------------------------------------------------------

const CACHE_DIRECTORIES: &[(&str, &str)] = &[("graph", "graph-bin"), ("patch", "patch-bin"), ("spawn", "spawn-bin"), ("supervisor", "supervisor-bin")];
const GC_RETRIES: usize = 5;
const GC_RETRY_DELAY: Duration = Duration::from_millis(250);

/// The cache folder of a kind of native tool, `None` for a kind that has none.
fn cache_directory(kind: &str) -> Option<&'static str> {
    CACHE_DIRECTORIES.iter().find(|(known, _)| *known == kind).map(|(_, directory)| *directory)
}

/// `rm -rf <dir>`: a folder that is not there is removed already.
fn remove_tree(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_dir_all(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// User files (user-file-write.ts)
// ---------------------------------------------------------------------------------------------------------------------

/// `writeUserFile`: an existing file is rewritten in place (it keeps its inode, links, ACLs and mode; a symlink stays a link) and
/// flushed before the write returns, a longer old tail cut after the new bytes are down so it is never empty midway; a new file is created
/// through a temp file. Never backed up or moved aside: user files belong to the user.
pub fn write_user_file(lane: &InLane<DurabilityIo>, path: &Path, data: &[u8]) -> Result<(), String> {
    let target = match std::fs::canonicalize(path) {
        Ok(target) => target,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return write_atomic(lane, path, data, false).map_err(|failure| format!("{}: {}", path.display(), failure.error));
        }
        Err(error) => return Err(format!("{}: {error}", path.display())),
    };
    let write = || -> std::io::Result<()> {
        let mut file = std::fs::OpenOptions::new().read(true).write(true).open(&target)?;
        file.write_all(data)?;
        file.set_len(data.len() as u64)?;
        file.sync_all()
    };
    write().map_err(|error| format!("{}: {error}", target.display()))
}

// ---------------------------------------------------------------------------------------------------------------------
// Linux input access (linux-input-access.ts)
// ---------------------------------------------------------------------------------------------------------------------

const UINPUT_DEVICE: &str = "/dev/uinput";
const RULE_FILE: &str = "70-mixdog-uinput.rules";
// Identical to apps/desktop/build/linux/70-mixdog-uinput.rules and mixdog-uinput.conf.
const RULE_LINES: [&str; 3] = [
    "# Mixdog Computer Use: grant the active local seat user access to /dev/uinput",
    "# (uaccess ACL; no group membership or re-login needed).",
    "KERNEL==\"uinput\", SUBSYSTEM==\"misc\", TAG+=\"uaccess\", OPTIONS+=\"static_node=uinput\"",
];
const MODULES_LINES: [&str; 2] = ["# Mixdog Computer Use: load the uinput module at boot.", "uinput"];
/// Bounded wait for udev to apply the ACL after the repair script exits.
const RECHECK_ATTEMPTS: usize = 12;
const RECHECK_INTERVAL_MS: u64 = 250;

fn shell_lines(lines: &[&str]) -> String {
    lines.iter().map(|line| format!("'{line}'")).collect::<Vec<_>>().join(" ")
}

/// The one privileged script: constants only, so nothing user-controlled reaches the shell.
pub fn install_script() -> String {
    [
        "set -e".to_owned(),
        format!("printf '%s\\n' {} > /etc/udev/rules.d/{RULE_FILE}", shell_lines(&RULE_LINES)),
        format!("printf '%s\\n' {} > /etc/modules-load.d/mixdog-uinput.conf", shell_lines(&MODULES_LINES)),
        "modprobe uinput".to_owned(),
        "udevadm control --reload".to_owned(),
        "udevadm trigger --action=add --subsystem-match=misc --sysname-match=uinput".to_owned(),
        "udevadm settle --timeout=5".to_owned(),
    ]
    .join("\n")
}

/// How `pkexec /bin/sh -c <script>` ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PkexecStatus {
    /// `pkexec` cannot be started.
    Missing,
    Exit(i32),
}

/// What the repair needs of the machine.
#[async_trait]
pub trait InputAccessProbe: Send + Sync {
    fn platform(&self) -> &'static str;
    /// Effective access as the current user: the same write probe the Computer Use readiness check uses.
    fn can_access(&self) -> bool;
    /// Whether the `/dev/uinput` node exists at all (separates a missing module from a missing permission).
    fn device_exists(&self) -> bool;
    async fn run_pkexec(&self, script: &str) -> PkexecStatus;
    /// A pause between access rechecks while udev applies the ACL.
    async fn wait(&self, millis: u64);
}

/// The machine this process runs on.
pub struct SystemInputAccess;

#[async_trait]
impl InputAccessProbe for SystemInputAccess {
    fn platform(&self) -> &'static str {
        host_platform()
    }

    fn can_access(&self) -> bool {
        std::fs::OpenOptions::new().write(true).open(UINPUT_DEVICE).is_ok()
    }

    fn device_exists(&self) -> bool {
        Path::new(UINPUT_DEVICE).exists()
    }

    async fn run_pkexec(&self, script: &str) -> PkexecStatus {
        let script = script.to_owned();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        std::thread::spawn(move || {
            let status = match std::process::Command::new("pkexec")
                .args(["/bin/sh", "-c", &script])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
            {
                Ok(status) => PkexecStatus::Exit(status.code().unwrap_or(1)),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => PkexecStatus::Missing,
                Err(_) => PkexecStatus::Exit(1),
            };
            let _ = sender.send(status);
        });
        receiver.await.unwrap_or(PkexecStatus::Exit(1))
    }

    async fn wait(&self, millis: u64) {
        mixdog_rt::time::sleep(Duration::from_millis(millis)).await;
    }
}

async fn repair_input_access(probe: &dyn InputAccessProbe) -> Value {
    let status = match probe.run_pkexec(&install_script()).await {
        PkexecStatus::Missing => {
            return json!({ "ok": false, "reason": "pkexec_missing", "message": "pkexec (polkit) is not installed, so the /dev/uinput access rule cannot be installed from here." });
        }
        PkexecStatus::Exit(status) => status,
    };
    // pkexec exits 126 when the user dismisses the dialog or is not authorized.
    if status == 126 {
        return json!({ "ok": false, "reason": "cancelled", "message": "Authorization was cancelled or denied." });
    }
    if status != 0 {
        return json!({ "ok": false, "reason": "failed", "exitCode": status, "message": format!("The repair script failed (exit {status}); the /dev/uinput access rule was not applied.") });
    }
    // A clean exit is not proof: confirm the signed-in user can really open the device.
    for _ in 0..RECHECK_ATTEMPTS {
        if probe.can_access() {
            return json!({ "ok": true });
        }
        probe.wait(RECHECK_INTERVAL_MS).await;
    }
    if probe.can_access() {
        return json!({ "ok": true });
    }
    if probe.device_exists() {
        json!({ "ok": false, "reason": "access_unavailable", "detail": "relogin", "message": "The access rule is installed but /dev/uinput is still not writable for this session. Sign out and sign in again (or restart), and make sure you are on a local desktop seat; if it persists, add your user to the input group." })
    } else {
        json!({ "ok": false, "reason": "access_unavailable", "detail": "no-module", "message": "/dev/uinput does not exist: the uinput kernel module is not loaded or is unavailable on this kernel. Run `sudo modprobe uinput` or restart, then try again." })
    }
}

type InFlight = Shared<BoxFuture<'static, Value>>;

/// `requestLinuxInputAccess`: one prompt at a time (an in-flight repair is never bypassed, even once its rule file or ACL has appeared,
/// and its result is every waiting caller's); privileged work is skipped only when access really works.
#[derive(Default)]
struct InputAccessRequests {
    in_flight: Mutex<Option<InFlight>>,
}

impl InputAccessRequests {
    async fn request(&self, probe: Arc<dyn InputAccessProbe>) -> Value {
        if probe.platform() != "linux" {
            return json!({ "ok": false, "reason": "failed" });
        }
        let pending = {
            let mut slot = self.in_flight.lock().unwrap_or_else(PoisonError::into_inner);
            if let Some(pending) = slot.as_ref() {
                pending.clone()
            } else if probe.can_access() {
                return json!({ "ok": true });
            } else {
                let pending: InFlight = async move { repair_input_access(&*probe).await }.boxed().shared();
                *slot = Some(pending.clone());
                pending
            }
        };
        let result = pending.await;
        *self.in_flight.lock().unwrap_or_else(PoisonError::into_inner) = None;
        result
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Conversation import progress (conversation-import-progress.ts)
// ---------------------------------------------------------------------------------------------------------------------

/// The desktop event one import job snapshot is published as.
pub const CONVERSATION_IMPORT_PROGRESS_EVENT: &str = "conversation-import-progress";
pub const CONVERSATION_IMPORT_POLL_MS: u64 = 750;

/// Where the import jobs come from and go to.
#[async_trait]
pub trait ImportJobSource: Send + Sync {
    /// The runtime's job list (`getConversationImportJobs`).
    async fn fetch_jobs(&self) -> Result<Vec<Value>, String>;
    fn publish(&self, event: &str, job: &Value);
}

fn is_job(value: &Value) -> bool {
    value.get("jobId").is_some_and(Value::is_string)
}

fn is_job_active(job: &Value) -> bool {
    matches!(job.get("state").and_then(Value::as_str), Some("running" | "stopping"))
}

/// `${value}` of a template literal: `undefined` for a missing field.
fn template_text(value: Option<&Value>) -> String {
    value.map_or_else(|| "undefined".to_owned(), value_to_string)
}

/// While a conversation-import job is active, polls the runtime's job list at a bounded interval and publishes each changed snapshot.
pub struct ImportProgress {
    source: Arc<dyn ImportJobSource>,
    interval: Duration,
    published: Mutex<HashMap<String, String>>,
    scheduled: AtomicBool,
    polling: AtomicBool,
    disposed: AtomicBool,
}

impl ImportProgress {
    pub fn new(source: Arc<dyn ImportJobSource>, interval: Duration) -> Arc<Self> {
        Arc::new(Self {
            source,
            interval,
            published: Mutex::new(HashMap::new()),
            scheduled: AtomicBool::new(false),
            polling: AtomicBool::new(false),
            disposed: AtomicBool::new(false),
        })
    }

    /// Publishes a job whose `seq:state:processed` changed since the last publication; whether it is still running.
    fn emit(&self, job: &Value) -> bool {
        let stamp = format!("{}:{}:{}", template_text(job.get("seq")), template_text(job.get("state")), template_text(job.get("processed")));
        let id = job.get("jobId").and_then(Value::as_str).unwrap_or_default().to_owned();
        let before = self.published.lock().unwrap_or_else(PoisonError::into_inner).insert(id, stamp.clone());
        if before.as_deref() != Some(stamp.as_str()) {
            self.source.publish(CONVERSATION_IMPORT_PROGRESS_EVENT, job);
        }
        is_job_active(job)
    }

    fn emit_all<'a>(&self, jobs: impl IntoIterator<Item = &'a Value>) -> bool {
        // Every job is published (a finished one once, with its final state); no short-circuit.
        jobs.into_iter().filter(|job| is_job(job)).fold(false, |active, job| self.emit(job) | active)
    }

    fn schedule(self: &Arc<Self>) {
        if self.disposed.load(Ordering::SeqCst) || self.scheduled.swap(true, Ordering::SeqCst) {
            return;
        }
        let this = Arc::clone(self);
        drop(mixdog_rt::spawn("conversation-import-poll", mixdog_rt::TaskClass::Work, async move {
            mixdog_rt::time::sleep_unrefed(this.interval).await;
            this.scheduled.store(false, Ordering::SeqCst);
            this.poll().await;
        }));
    }

    async fn poll(self: &Arc<Self>) {
        if self.disposed.load(Ordering::SeqCst) || self.polling.swap(true, Ordering::SeqCst) {
            return;
        }
        match self.source.fetch_jobs().await {
            Ok(jobs) => {
                if self.emit_all(&jobs) {
                    self.schedule();
                }
            }
            // A failed read retries on the next tick while a job was being followed.
            Err(_) => self.schedule(),
        }
        self.polling.store(false, Ordering::SeqCst);
    }

    /// Sees the result of a capability call; a job in it starts or keeps the poll.
    pub fn observe(self: &Arc<Self>, capability: &str, value: &Value) {
        if self.disposed.load(Ordering::SeqCst) {
            return;
        }
        let active = match capability {
            "startConversationImport" | "cancelConversationImport" => self.emit_all(std::slice::from_ref(value)),
            "getConversationImportJobs" => self.emit_all(value.get("jobs").and_then(Value::as_array).map_or(&[][..], Vec::as_slice)),
            _ => return,
        };
        if active {
            self.schedule();
        }
    }

    pub fn dispose(&self) {
        self.disposed.store(true, Ordering::SeqCst);
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Network change detection (network-watch.ts)
// ---------------------------------------------------------------------------------------------------------------------

pub const NETWORK_POLL_MS: u64 = 2_000;

/// What one look at the network found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetworkSnapshot {
    pub online: bool,
    /// A stable signature of the machine's external addresses.
    pub signature: String,
}

/// `networkSignature`: the sorted `name:address` of every external interface address, joined with `|`.
pub fn network_signature(addresses: &[(&str, &str, bool)]) -> String {
    let mut external: Vec<String> = addresses.iter().filter(|(_, _, internal)| !internal).map(|(name, address, _)| format!("{name}:{address}")).collect();
    external.sort();
    external.join("|")
}

/// The local address the routing table gives a datagram to a public address of each family: connecting a UDP socket sends nothing, it
/// only picks the route. No route in either family is offline; a Wi-Fi switch, a VPN toggle or a dock changes the address.
pub fn network_snapshot() -> NetworkSnapshot {
    let local = |bind: &str, remote: &str| -> Option<String> {
        let socket = std::net::UdpSocket::bind(bind).ok()?;
        socket.connect(remote).ok()?;
        socket.local_addr().ok().map(|address| address.ip().to_string())
    };
    let v4 = local("0.0.0.0:0", "1.1.1.1:53");
    let v6 = local("[::]:0", "[2606:4700:4700::1111]:53");
    let found: Vec<(&str, &str, bool)> =
        [("route4", v4.as_deref()), ("route6", v6.as_deref())].into_iter().filter_map(|(name, address)| address.map(|address| (name, address, false))).collect();
    NetworkSnapshot { online: !found.is_empty(), signature: network_signature(&found) }
}

/// Whether the leg should redial: the machine came back online, or its addresses changed while online.
pub fn network_changed(before: &NetworkSnapshot, now: &NetworkSnapshot) -> bool {
    now.online && (!before.online || now.signature != before.signature)
}

/// Fires the moment the machine comes back online or its set of network addresses changes, so the relay leg redials immediately
/// instead of noticing a dead network only when a ping goes unanswered.
pub struct NetworkWatcher {
    stopped: Arc<AtomicBool>,
}

impl NetworkWatcher {
    pub fn start(interval: Duration, probe: Arc<dyn Fn() -> NetworkSnapshot + Send + Sync>, on_change: Arc<dyn Fn() + Send + Sync>) -> Self {
        let stopped = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&stopped);
        drop(mixdog_rt::spawn("network-watch", mixdog_rt::TaskClass::Work, async move {
            let mut before = probe();
            loop {
                mixdog_rt::time::sleep_unrefed(interval).await;
                if flag.load(Ordering::SeqCst) {
                    return;
                }
                let now = probe();
                let changed = network_changed(&before, &now);
                before = now;
                if changed {
                    on_change();
                }
            }
        }));
        Self { stopped }
    }

    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Login shell environment (login-shell-environment.ts)
// ---------------------------------------------------------------------------------------------------------------------
//
// A Dock/Finder (macOS) or desktop-entry (Linux) launch inherits only the session manager's environment: the PATH additions and keys a user
// exports from ~/.zprofile or ~/.zshrc are missing, so the daemon it spawns, and every terminal and tool call under it, cannot find what a
// terminal launch finds. One interactive login shell prints its environment once, before the daemon starts; this runs before the core
// exists, so it is a library function of the launcher. Windows GUI launches already carry the registry environment and skip the read.

const LOGIN_ENV_MARK: &str = "__MIXDOG_LOGIN_ENV__";
const FALLBACK_SHELLS: [&str; 3] = ["/bin/zsh", "/bin/bash", "/bin/sh"];
/// oh-my-zsh update prompts and tmux autostart plugins would otherwise block a shell that has no terminal attached.
const PROBE_ENV: [(&str, &str); 3] = [("DISABLE_AUTO_UPDATE", "true"), ("ZSH_TMUX_AUTOSTARTED", "true"), ("ZSH_TMUX_AUTOSTART", "false")];
/// Whole-read budget across every candidate shell: the daemon waits for it.
pub const LOGIN_SHELL_READ_BUDGET: Duration = Duration::from_millis(5_000);
/// Homebrew's prefixes (Apple Silicon, then Intel).
const HOMEBREW_PATH_DIRS: [&str; 4] = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/sbin"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoginShellFailure {
    pub shell: String,
    /// `exit <code>`, a signal, a spawn error, `timeout`, or `unparsed`.
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LoginShellRead {
    /// The first successful shell's variables; `None` when every candidate failed.
    pub environment: Option<BTreeMap<String, String>>,
    pub failures: Vec<LoginShellFailure>,
}

/// The variables printed between the two marks (the marks bracket the dump so rc-file chatter before or after it is ignored), or `None`
/// until both arrived.
pub fn extract_login_shell_environment(output: &str) -> Option<BTreeMap<String, String>> {
    let fields: Vec<&str> = output.split('\0').collect();
    let start = fields.iter().position(|field| *field == LOGIN_ENV_MARK)?;
    let end = fields.iter().rposition(|field| *field == LOGIN_ENV_MARK)?;
    if end <= start {
        return None;
    }
    Some(
        fields[start + 1..end]
            .iter()
            .filter_map(|field| field.find('=').filter(|separator| *separator > 0).map(|separator| (field[..separator].to_owned(), field[separator + 1..].to_owned())))
            .collect(),
    )
}

/// The shell values this process should adopt. The shell wins, except for the probe's own process variables, Electron's runtime switches,
/// and `MIXDOG_*` values the launcher already set (the desktop resolves those, bundled tool paths and isolated profiles, before the read).
pub fn login_shell_overrides(inherited: &BTreeMap<String, String>, shell: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    let probe_key = |key: &str| matches!(key, "PWD" | "OLDPWD" | "SHLVL" | "_") || PROBE_ENV.iter().any(|(name, _)| *name == key);
    shell
        .iter()
        .filter(|(key, _)| !probe_key(key) && !key.starts_with("ELECTRON_") && !(key.starts_with("MIXDOG_") && inherited.contains_key(*key)))
        .filter(|(key, value)| inherited.get(*key) != Some(*value))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

/// `PATH` with every existing Homebrew directory it lacks appended, never prepended, so the order the user's shell chose keeps winning. The
/// original string is kept verbatim, empty components (the current directory) included. Also answers the directories added.
pub fn with_homebrew_path(path: Option<&str>, exists: impl Fn(&str) -> bool) -> (String, Vec<String>) {
    let original = path.unwrap_or_default();
    let segments: Vec<&str> = original.split(':').collect();
    let added: Vec<String> = HOMEBREW_PATH_DIRS.iter().filter(|dir| !segments.contains(dir) && exists(dir)).map(|dir| (*dir).to_owned()).collect();
    if added.is_empty() {
        return (original.to_owned(), added);
    }
    let joined = added.join(":");
    (if original.is_empty() { joined } else { format!("{original}:{joined}") }, added)
}

/// The account's login shell (what `chsh` chose; a Dock launch's `$SHELL` comes from launchd, not the user), then the fixed system shells.
fn login_shell_candidates() -> Vec<String> {
    let account = std::env::var("USER").or_else(|_| std::env::var("LOGNAME")).ok().and_then(|user| {
        if cfg!(target_os = "macos") {
            let output = std::process::Command::new("dscl").args([".", "-read", &format!("/Users/{user}"), "UserShell"]).output().ok()?;
            String::from_utf8_lossy(&output.stdout).split_once(':').map(|(_, shell)| shell.trim().to_owned())
        } else {
            let passwd = std::fs::read_to_string("/etc/passwd").ok()?;
            passwd.lines().find_map(|line| {
                let fields: Vec<&str> = line.split(':').collect();
                if fields.first() == Some(&user.as_str()) { fields.get(6).map(|shell| (*shell).to_owned()) } else { None }
            })
        }
    });
    let mut shells: Vec<String> = Vec::new();
    for shell in account.into_iter().filter(|shell| !shell.is_empty()).chain(FALLBACK_SHELLS.iter().map(|shell| (*shell).to_owned())) {
        if !shells.contains(&shell) {
            shells.push(shell);
        }
    }
    shells
}

#[cfg(unix)]
fn read_shell(shell: &str, timeout: Duration) -> Result<BTreeMap<String, String>, String> {
    use std::io::Read;
    use std::os::unix::process::CommandExt;
    use std::os::unix::process::ExitStatusExt;
    let script = format!("printf '\\0%s\\0' {LOGIN_ENV_MARK}; command env -0 || exit 1; printf '\\0%s\\0' {LOGIN_ENV_MARK}; exit 0");
    // Interactive login mode runs the profile AND rc files, where most users export PATH. stdin is closed so a prompting rc file reads EOF.
    let mut child = std::process::Command::new(shell)
        .args(["-ilc", &script])
        .current_dir(std::env::var_os("HOME").map_or_else(|| PathBuf::from("/"), PathBuf::from))
        .envs(PROBE_ENV)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .process_group(0)
        .spawn()
        .map_err(|error| error.to_string())?;
    let pid = child.id();
    let mut stdout = child.stdout.take().ok_or_else(|| "no stdout".to_owned())?;
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let (mut collected, mut chunk, mut sent) = (Vec::new(), [0u8; 8192], false);
        // Background jobs an rc file starts inherit stdout and can hold it open long after the shell exits, so the closing mark, not the
        // end of the stream, ends the read; the rest is drained so a late writer does not die of a broken pipe.
        while let Ok(count @ 1..) = stdout.read(&mut chunk) {
            collected.extend_from_slice(&chunk[..count]);
            if !sent && let Some(environment) = extract_login_shell_environment(&String::from_utf8_lossy(&collected)) {
                sent = true;
                let _ = sender.send(Ok(environment));
            }
        }
        let status = child.wait();
        if !sent {
            let _ = sender.send(match status {
                Ok(status) if status.success() => extract_login_shell_environment(&String::from_utf8_lossy(&collected)).ok_or_else(|| "unparsed".to_owned()),
                Ok(status) => Err(status.signal().map_or_else(|| format!("exit {}", status.code().unwrap_or(-1)), |signal| format!("signal {signal}"))),
                Err(error) => Err(error.to_string()),
            });
        }
    });
    receiver.recv_timeout(timeout).unwrap_or_else(|_| {
        // The whole group: rc files may have started children of their own.
        let _ = std::process::Command::new("kill").args(["-KILL", &format!("-{pid}")]).status();
        Err("timeout".to_owned())
    })
}

#[cfg(not(unix))]
fn read_shell(_shell: &str, _timeout: Duration) -> Result<BTreeMap<String, String>, String> {
    Err("a login shell cannot be read on this platform".to_owned())
}

/// Reads the login-shell environment once (`platform` in Node's names; `shells` defaults to the account's login shell, then the fixed
/// system shells). Never fails: each failing candidate is recorded and the next one tried within one shared budget.
pub fn read_login_shell_environment(platform: &str, shells: Option<Vec<String>>, budget: Duration) -> LoginShellRead {
    let mut read = LoginShellRead::default();
    if platform == "win32" {
        return read;
    }
    let deadline = std::time::Instant::now() + budget;
    for shell in shells.unwrap_or_else(login_shell_candidates) {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            read.failures.push(LoginShellFailure { shell, reason: "timeout".to_owned() });
            break;
        }
        match read_shell(&shell, remaining) {
            Ok(environment) => {
                read.environment = Some(environment);
                return read;
            }
            Err(reason) => read.failures.push(LoginShellFailure { shell, reason }),
        }
    }
    read
}

// ---------------------------------------------------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalLinkParams {
    project_path: Value,
    href: Value,
    #[serde(default)]
    confirmed_path: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AttachmentWriteParams {
    data_url: Value,
    #[serde(default)]
    name: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ThumbnailParams {
    attachment_ref: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LaunchRecordParams {
    path: String,
    version: String,
    #[serde(default)]
    argv: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LaunchAcknowledgeParams {
    path: String,
    version: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CacheGcParams {
    bundled_kinds: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UserFileParams {
    path: String,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    data_base64: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NoParams {}

const METHODS: &[&str] = &[
    "desktop/localLink/open",
    "desktop/attachment/write",
    "desktop/attachment/thumbnail",
    "desktop/launchVersion/record",
    "desktop/launchVersion/acknowledge",
    "desktop/modelBootstrap/read",
    "desktop/nativeToolCache/gc",
    "desktop/userFile/write",
    "desktop/computer/inputAccess/request",
];

pub struct DesktopResidualBService {
    attachments: Arc<dyn AttachmentHost>,
    durability: DurabilityIo,
    temp: PathBuf,
    data_dir: PathBuf,
    input_access: Arc<dyn InputAccessProbe>,
    input_requests: InputAccessRequests,
}

impl DesktopResidualBService {
    /// `data_dir` is the profile folder: it holds `mixdog-config.json` and the native tool caches.
    pub fn new(attachments: Arc<dyn AttachmentHost>, tokens: &LaneTokens, data_dir: PathBuf) -> Self {
        Self {
            attachments,
            durability: tokens.durability_io,
            temp: std::env::temp_dir(),
            data_dir,
            input_access: Arc::new(SystemInputAccess),
            input_requests: InputAccessRequests::default(),
        }
    }

    async fn on_lane<R: Send + 'static>(&self, req: &CoreRequest, job: impl FnOnce(&InLane<DurabilityIo>) -> R + Send + 'static) -> Result<R, CoreError> {
        on_lane_wait(self.durability, &req.ctx.cancel, job).await
    }

    async fn local_link(&self, req: &CoreRequest) -> Result<Reply, CoreError> {
        let params: LocalLinkParams = decode(req)?;
        let project = repository_cwd(Some(&params.project_path)).ok_or_else(|| type_error("A project directory is required."))?.to_owned();
        let href = required_text(Some(&params.href), 4_096).ok_or_else(|| invalid("href", "a non-empty string of at most 4096 characters"))?.to_owned();
        let confirmed = params.confirmed_path.and_then(|value| value.as_str().map(str::to_owned));
        let windows = cfg!(windows);
        let outcome = self.on_lane(req, move |_| decide_local_link(&project, &href, confirmed.as_deref(), windows)).await??;
        reply(match outcome {
            LocalLinkOutcome::Confirm(path) => json!({ "confirmationPath": path }),
            LocalLinkOutcome::Editor => json!({ "result": "editor" }),
            LocalLinkOutcome::Open { kind, path } => json!({ "result": kind, "path": path }),
        })
    }
}

fn reply(value: Value) -> Result<Reply, CoreError> {
    Ok(Reply::Value(value))
}

fn with_write_error(mut value: Value, error: Option<String>) -> Value {
    if let Some(error) = error {
        tracing::warn!(target: "mixdog_desktop", "launch record not written: {error}");
        value["writeError"] = json!(error);
    }
    value
}

#[async_trait]
impl DomainService for DesktopResidualBService {
    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        match req.method.as_str() {
            "desktop/localLink/open" => self.local_link(&req).await,
            "desktop/attachment/write" => {
                let params: AttachmentWriteParams = decode(&req)?;
                let temp = self.temp.clone();
                let path = self.on_lane(&req, move |_| write_attachment_file(&temp, &params.data_url, &params.name)).await??;
                reply(json!({ "path": path.to_string_lossy() }))
            }
            "desktop/attachment/thumbnail" => {
                let params: ThumbnailParams = decode(&req)?;
                let Some(attachment_ref) = params.attachment_ref.as_str().filter(|text| is_attachment_ref(text)) else { return reply(json!({ "dataUrl": null })) };
                let Some(bytes) = self.attachments.attachment_bytes(attachment_ref).await else { return reply(json!({ "dataUrl": null })) };
                let url = self.on_lane(&req, move |_| thumbnail_of(&bytes, THUMBNAIL_FALLBACK_MAX_BYTES)).await?;
                reply(json!({ "dataUrl": url }))
            }
            "desktop/launchVersion/record" => {
                let params: LaunchRecordParams = decode(&req)?;
                let (announce, error) = self.on_lane(&req, move |lane| record_launch_version(lane, Path::new(&params.path), &params.version, &params.argv)).await?;
                reply(with_write_error(json!({ "announce": announce }), error))
            }
            "desktop/launchVersion/acknowledge" => {
                let params: LaunchAcknowledgeParams = decode(&req)?;
                let error = self.on_lane(&req, move |lane| acknowledge_announcement(lane, Path::new(&params.path), &params.version)).await?;
                reply(with_write_error(json!({}), error))
            }
            "desktop/modelBootstrap/read" => {
                let _params: NoParams = decode(&req)?;
                let path = self.data_dir.join("mixdog-config.json");
                let snapshot = self.on_lane(&req, move |_| read_model_bootstrap(&path)).await?;
                reply(json!({ "snapshot": snapshot }))
            }
            "desktop/nativeToolCache/gc" => {
                let params: CacheGcParams = decode(&req)?;
                let (mut removed, mut errors): (Vec<String>, Vec<Value>) = (Vec::new(), Vec::new());
                let mut seen: Vec<String> = Vec::new();
                for kind in params.bundled_kinds {
                    let Some(directory) = cache_directory(&kind) else { continue };
                    if seen.contains(&kind) {
                        continue;
                    }
                    seen.push(kind.clone());
                    let path = self.data_dir.join(directory);
                    let mut outcome = Ok(());
                    for attempt in 0..=GC_RETRIES {
                        let target = path.clone();
                        outcome = self.on_lane(&req, move |_| remove_tree(&target)).await?;
                        if outcome.is_ok() || attempt == GC_RETRIES {
                            break;
                        }
                        mixdog_rt::time::sleep(GC_RETRY_DELAY).await;
                    }
                    match outcome {
                        Ok(()) => removed.push(kind),
                        Err(error) => errors.push(json!({ "kind": kind, "error": format!("{}: {error}", path.display()) })),
                    }
                }
                reply(json!({ "removed": removed, "failed": errors }))
            }
            "desktop/userFile/write" => {
                let params: UserFileParams = decode(&req)?;
                let data = match (params.text, params.data_base64) {
                    (Some(text), None) => text.into_bytes(),
                    (None, Some(encoded)) => base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|_| invalid("dataBase64", "base64"))?,
                    _ => return Err(invalid("params", "exactly one of text and dataBase64")),
                };
                let length = data.len();
                self.on_lane(&req, move |lane| write_user_file(lane, Path::new(&params.path), &data)).await?.map_err(|error| failed(DOMAIN, error))?;
                reply(json!({ "bytes": length }))
            }
            "desktop/computer/inputAccess/request" => {
                let _params: NoParams = decode(&req)?;
                reply(self.input_requests.request(Arc::clone(&self.input_access)).await)
            }
            other => Err(wrong_method(DOMAIN, other)),
        }
    }

    fn methods(&self) -> &'static [&'static str] {
        METHODS
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}

#[cfg(test)]
#[path = "desktop_residual_b_tests.rs"]
mod tests;
