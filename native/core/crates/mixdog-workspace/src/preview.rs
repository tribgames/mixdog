#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "blocking file bodies run only as lane jobs (lanes::run_fallible); the service never calls them on an async thread")]
//! A paired device's file previews (Node `remote-file-preview.ts`): what a file is for a preview (`previewProjectFile`), one bounded
//! window of its bytes (`previewProjectFileRange`). No media lease is minted: a paired device streams by ranged reads. Every read opens the file first and authorizes the OPEN file (`inplace::open_authorized_ro`), so a path swapped
//! for a link between the checks and the read reaches nothing.

use std::io::Read;
use std::io::Seek;
use std::io::SeekFrom;
use std::path::Path;

use base64::Engine;
use serde_json::Value;
use serde_json::json;

use crate::error::WsError;
use crate::error::WsResult;
use crate::ident::mtime_ms;
use crate::inplace::open_authorized_ro;
use crate::nodeerr::AtPath;
use crate::pathguard::is_within;
use crate::pathguard::project_entry_path;

/// `REMOTE_PREVIEW_MAX_READ_BYTES`.
pub const RANGE_MAX: u64 = 4 * 1024 * 1024;
const UNSUPPORTED: &str = "This file type does not support an in-app preview.";

/// `fileExtension`: the text after the last dot of the last path segment, lower case; none when the dot ends the name.
fn extension(path: &Path) -> String {
    let text = path.to_string_lossy();
    let name = text.rsplit(['/', '\\']).next().unwrap_or_default();
    match name.rfind('.') {
        Some(dot) if dot + 1 < name.len() => name[dot + 1..].to_lowercase(),
        _ => String::new(),
    }
}

/// `FILE_PREVIEW_TYPES` (`shared/file-preview.ts`): the kind and mime of a browser-native preview.
pub fn file_preview_type(path: &Path) -> Option<(&'static str, &'static str)> {
    Some(match extension(path).as_str() {
        "png" => ("image", "image/png"),
        "jpg" | "jpeg" | "jfif" => ("image", "image/jpeg"),
        "gif" => ("image", "image/gif"),
        "webp" => ("image", "image/webp"),
        "avif" => ("image", "image/avif"),
        "svg" => ("image", "image/svg+xml"),
        "bmp" => ("image", "image/bmp"),
        "ico" => ("image", "image/x-icon"),
        "pdf" => ("pdf", "application/pdf"),
        "mp3" => ("audio", "audio/mpeg"),
        "wav" => ("audio", "audio/wav"),
        "ogg" | "oga" | "opus" => ("audio", "audio/ogg"),
        "m4a" => ("audio", "audio/mp4"),
        "aac" => ("audio", "audio/aac"),
        "flac" => ("audio", "audio/flac"),
        "mp4" => ("video", "video/mp4"),
        "m4v" => ("video", "video/x-m4v"),
        "webm" => ("video", "video/webm"),
        "ogv" => ("video", "video/ogg"),
        "mov" => ("video", "video/quicktime"),
        _ => return None,
    })
}

/// `pageAssetType` (`local-page-server.ts`) with the data root equal to the root: the mime of a web asset or data file under `root`,
/// none when the file is outside it, below a hidden folder, or not a web asset.
fn page_asset_type(root: &Path, file: &Path) -> Option<&'static str> {
    if !is_within(root, file) {
        return None;
    }
    let relative = file.strip_prefix(root).ok()?;
    if relative.components().any(|part| part.as_os_str().to_string_lossy().starts_with('.')) {
        return None;
    }
    Some(match extension(file).as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "map" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "m4a" => "audio/mp4",
        "wasm" => "application/wasm",
        "gltf" => "model/gltf+json",
        "glb" => "model/gltf-binary",
        "json" => "application/json; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "txt" => "text/plain; charset=utf-8",
        "md" => "text/markdown; charset=utf-8",
        "xml" => "application/xml; charset=utf-8",
        "webmanifest" => "application/manifest+json; charset=utf-8",
        "pdf" => "application/pdf",
        "bin" => "application/octet-stream",
        _ => return None,
    })
}

/// `previewProjectFile`: what the file is for a preview, its size and time.
pub fn preview_file(root: &Path, rel: &str) -> WsResult<Value> {
    let absolute = project_entry_path(root, rel)?;
    let (kind, mime) = file_preview_type(&absolute).ok_or_else(|| WsError::plain(UNSUPPORTED))?;
    let opened = open_authorized_ro(&absolute, root)?;
    let meta = opened.file.metadata().at("fstat", &absolute)?;
    Ok(json!({ "kind": kind, "mime": mime, "mtimeMs": mtime_ms(&meta), "size": meta.len() }))
}

/// `readPreviewRange`: up to `length` bytes of the file from `offset`, base64, with the file's size and time.
pub fn preview_range(root: &Path, rel: &str, offset: u64, length: u64) -> WsResult<Value> {
    let absolute = project_entry_path(root, rel)?;
    let mime = match file_preview_type(&absolute) {
        Some((_, mime)) => mime,
        None => page_asset_type(root, &absolute).ok_or_else(|| WsError::plain(UNSUPPORTED))?,
    };
    let mut opened = open_authorized_ro(&absolute, root)?;
    let meta = opened.file.metadata().at("fstat", &absolute)?;
    let wanted = length.min(meta.len().saturating_sub(offset)) as usize;
    let mut bytes = vec![0u8; wanted];
    let mut filled = 0;
    if wanted > 0 {
        opened.file.seek(SeekFrom::Start(offset)).at("read", &absolute)?;
        while filled < wanted {
            let read = opened.file.read(&mut bytes[filled..]).at("read", &absolute)?;
            if read == 0 {
                break;
            }
            filled += read;
        }
    }
    bytes.truncate(filled);
    Ok(json!({
        "data": base64::engine::general_purpose::STANDARD.encode(&bytes),
        "mime": mime,
        "offset": offset,
        "mtimeMs": mtime_ms(&meta),
        "size": meta.len(),
    }))
}