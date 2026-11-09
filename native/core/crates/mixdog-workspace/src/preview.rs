#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "blocking file bodies run only as lane jobs (lanes::run_fallible); the service never calls them on an async thread")]
//! A paired device's file previews (Node `remote-file-preview.ts`): what a file is for a preview (`previewProjectFile`), one bounded
//! window of its bytes (`previewProjectFileRange`), and the short-lived media lease the encrypted media lane serves it by
//! (`media-leases.ts`). Every read opens the file first and authorizes the OPEN file (`inplace::open_authorized_ro`), so a path swapped
//! for a link between the checks and the read reaches nothing.

use std::collections::VecDeque;
use std::fs::File;
use std::io::Read;
use std::io::Seek;
use std::io::SeekFrom;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;

use base64::Engine;
use serde_json::Value;
use serde_json::json;

use crate::error::WsError;
use crate::error::WsResult;
use crate::ident::FileId;
use crate::ident::file_id;
use crate::ident::mtime_ms;
use crate::inplace::open_authorized_ro;
use crate::nodeerr::AtPath;
use crate::pathguard::canonical;
use crate::pathguard::is_within;
use crate::pathguard::project_entry_path;

/// `REMOTE_PREVIEW_MAX_READ_BYTES`.
pub const RANGE_MAX: u64 = 4 * 1024 * 1024;
/// `MAX_LEASES` and `LEASE_TTL_MS` of `media-leases.ts`.
const MAX_LEASES: usize = 256;
const LEASE_TTL_MS: i64 = 60 * 60 * 1000;
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
fn file_preview_type(path: &Path) -> Option<(&'static str, &'static str)> {
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

/// A leased file: where it was authorized and which file that was.
struct Lease {
    id: String,
    location: PathBuf,
    mime: String,
    within: PathBuf,
    identity: FileId,
    expires_at: i64,
}

/// The file previews' media leases (`leaseMediaFile` / `leasedMediaFile`): an unguessable id for a file a preview authorized, which the
/// media lane resolves back to the file and authorizes again.
#[derive(Default)]
pub struct FileLeases {
    leases: Mutex<VecDeque<Lease>>,
}

/// A leased file opened again for the media lane: the open file, its size and mime.
pub struct LeasedFile {
    pub file: File,
    pub size: u64,
    pub mime: String,
    pub mtime_ms: f64,
}

impl FileLeases {
    fn mint(&self, location: PathBuf, mime: &str, within: PathBuf, identity: FileId) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let mut leases = self.leases.lock().expect("file leases");
        leases.push_back(Lease { id: id.clone(), location, mime: mime.to_owned(), within, identity, expires_at: crate::catalog::now_ms() + LEASE_TTL_MS });
        while leases.len() > MAX_LEASES {
            leases.pop_front();
        }
        id
    }

    /// The leased file, opened again and authorized again inside the folder it was authorized within, and still the very file that was
    /// authorized; none when the lease is unknown, expired, or its file is not that file any more.
    pub fn open(&self, asset_id: &str) -> Option<LeasedFile> {
        let (location, mime, within, identity) = {
            let mut leases = self.leases.lock().expect("file leases");
            let at = leases.iter().position(|lease| lease.id == asset_id)?;
            if leases[at].expires_at <= crate::catalog::now_ms() {
                leases.remove(at);
                return None;
            }
            let lease = &leases[at];
            (lease.location.clone(), lease.mime.clone(), lease.within.clone(), lease.identity)
        };
        let opened = open_authorized_ro(&location, &within).ok()?;
        if opened.id != identity {
            return None;
        }
        let meta = opened.file.metadata().ok()?;
        Some(LeasedFile { size: meta.len(), mtime_ms: mtime_ms(&meta), file: opened.file, mime })
    }
}

/// `previewProjectFile`: what the file is for a preview, its size and time, and a lease of it when the kind streams.
pub fn preview_file(leases: &FileLeases, root: &Path, rel: &str) -> WsResult<Value> {
    let absolute = project_entry_path(root, rel)?;
    let (kind, mime) = file_preview_type(&absolute).ok_or_else(|| WsError::plain(UNSUPPORTED))?;
    let opened = open_authorized_ro(&absolute, root)?;
    let meta = opened.file.metadata().at("fstat", &absolute)?;
    let mut answer = json!({ "kind": kind, "mime": mime, "mtimeMs": mtime_ms(&meta), "size": meta.len() });
    if kind != "pdf" {
        let location = canonical(&absolute).at("realpath", &absolute)?;
        let within = canonical(root).at("realpath", root)?;
        answer["mediaAssetId"] = Value::String(leases.mint(location, mime, within, file_id(&opened.file).at("fstat", &absolute)?));
    }
    Ok(answer)
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