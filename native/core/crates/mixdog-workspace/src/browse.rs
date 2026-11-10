//! Read-only, directories-only listing for the add-project browser and the server folder picker
//! (Node `host-directories.ts`): usable before any project is registered, it validates like
//! `addProject` (a canonical existing directory) and never returns files or file contents.

use std::path::Path;

use serde_json::Value;
use serde_json::json;

use crate::error::WsError;
use crate::error::WsResult;
use crate::nodeerr::AtPath;
use crate::pathguard::canonical;

/// `HOST_DIRECTORY_LIST_LIMIT`: entries per listing; the client sees `truncated` past it.
const LIST_LIMIT: usize = 1_000;
/// `HOST_DIRECTORY_PATH_MAX`, in UTF-16 units like `String.length`.
const PATH_MAX: usize = 32_768;

/// Node's `path.isAbsolute` for the platform this runs on (win32 counts a leading slash).
fn is_absolute(path: &str) -> bool {
    if cfg!(windows) {
        let bytes = path.as_bytes();
        matches!(bytes.first(), Some(b'/' | b'\\')) || (bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'/' | b'\\'))
    } else {
        path.starts_with('/')
    }
}

fn home_dir() -> String {
    let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var(key).unwrap_or_default()
}

/// `validatedHostDirectoryPath`: an empty request starts at the host user's home directory.
fn validated_path(value: &str) -> WsResult<String> {
    if mixdog_js::utf16_len(value) > PATH_MAX {
        return Err(WsError::invalid("path is too long."));
    }
    let path = mixdog_js::js_trim(value);
    if path.is_empty() {
        return Ok(home_dir());
    }
    if path.contains('\0') {
        return Err(WsError::invalid("path is invalid."));
    }
    // Win32 device namespaces (\\?\ and \\.\) are never a project folder.
    let bytes = path.as_bytes();
    if bytes.len() >= 4 && matches!(bytes[0], b'/' | b'\\') && matches!(bytes[1], b'/' | b'\\') && matches!(bytes[2], b'?' | b'.') && matches!(bytes[3], b'/' | b'\\') {
        return Err(WsError::invalid("path is invalid."));
    }
    if !is_absolute(path) {
        return Err(WsError::invalid("path must be absolute."));
    }
    Ok(path.to_owned())
}

/// The canonical directory behind `raw` and the sorted names of its subdirectories (a symlink is
/// not one: `Dirent.isDirectory()`).
#[allow(clippy::disallowed_methods, reason = "runs as a lane job")]
fn directory_names(raw: &str, include_hidden: bool) -> WsResult<(String, Vec<String>)> {
    let given = validated_path(raw)?;
    let canonical_dir = canonical(Path::new(&given)).at("realpath", Path::new(&given))?;
    if !std::fs::metadata(&canonical_dir).at("stat", &canonical_dir)?.is_dir() {
        return Err(WsError::plain("path is not a directory."));
    }
    let listing = std::fs::read_dir(&canonical_dir).at("scandir", &canonical_dir)?;
    let mut names = Vec::new();
    for entry in listing {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if entry.file_type()?.is_dir() && (include_hidden || !name.starts_with('.')) {
            names.push(name);
        }
    }
    names.sort_by(|a, b| mixdog_js::locale_compare(a, b));
    Ok((canonical_dir.to_string_lossy().into_owned(), names))
}

/// `projectFs/browseDirs`. Without `includeHidden` it is `listHostDirectories` (hidden folders
/// included, `{ path, folders, truncated }`); with it, `listServerDirectories` (hidden ones only
/// when true, each folder with its git marker, `{ path, entries, truncated }`).
pub fn browse_dirs(raw: &str, include_hidden: Option<bool>) -> WsResult<Value> {
    let (path, names) = directory_names(raw, include_hidden.unwrap_or(true))?;
    let truncated = names.len() > LIST_LIMIT;
    let shown = &names[..names.len().min(LIST_LIMIT)];
    if include_hidden.is_none() {
        return Ok(json!({ "path": path, "folders": shown, "truncated": truncated }));
    }
    #[allow(clippy::disallowed_methods, reason = "runs as a lane job")]
    let entries: Vec<Value> = shown
        .iter()
        .map(|name| json!({ "name": name, "git": std::fs::metadata(Path::new(&path).join(name).join(".git")).is_ok() }))
        .collect();
    Ok(json!({ "path": path, "entries": entries, "truncated": truncated }))
}
