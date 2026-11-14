//! The logic of four desktop main-process files, in the core (owner direction 14: a file that handles no Electron object
//! moves to Rust): `session-attachments.ts` and `transcript-file-links.ts` (the attachments a conversation names and the
//! host paths its links name), `workflow-config.ts` (a JSONC settings file) and `system-fonts.ts` (the installed font
//! families of Settings, Appearance).
//!
//! - `desktop/link/resolve`: the absolute host path a link's href names (decoded as the renderer's MarkdownLink decodes it,
//!   `:line` / `#L` dropped, resolved against the session's folder), or `null` for a web link, a UNC target and a relative
//!   link with no known folder.
//! - `desktop/link/resolvePath`: the same resolution for an already decoded path.
//! - `desktop/attachment/resolve`: an attachment of a session by content hash, served only when THIS session's transcript
//!   (the window it holds, else its whole stored conversation) names the id, and only when the stored bytes hash to the
//!   id. The refusals carry the download reasons (`file-download:not-linked`, `:not-found`, `:changed`) that the paired
//!   devices' download path reports. Answers the attachment's record, its verified byte count, its previewable
//!   name and the bytes as a data URL (what the desktop's `readSessionAttachment` IPC answered).
//! - `desktop/attachment/stage`: the same check, then the bytes written to `<temp>/mixdog-attachments/<id16>-<name>`.
//! - `desktop/workflowConfig/read`: the object a JSONC file holds (`null` when it is missing, empty or NUL-filled).
//! - `desktop/fonts/list`: the installed font families, listed once per process.
//!
//! Path rules are Node's: `PathFlavor` carries the platform's, so both are replayed in tests on any host.

#![allow(clippy::disallowed_methods, reason = "file work runs as the body of a durability-io lane job; the font listing waits on its child with a channel timeout")]

use std::io::Read;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::OnceLock;
use std::sync::mpsc;
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_core_api::service::DomainService;
use mixdog_core_base::support::coded;
use mixdog_core_base::support::decode;
use mixdog_core_base::support::failed;
use mixdog_core_base::support::invalid;
use mixdog_core_base::support::on_lane_wait;
use mixdog_core_base::support::wrong_method;
use mixdog_js::is_js_space;
use mixdog_js::js_to_lowercase;
use mixdog_js::js_trim;
use mixdog_js::json_number;
use mixdog_js::json_parse;
use mixdog_js::locale_compare;
use mixdog_js::slice_utf16;
use mixdog_js::to_number_of;
use mixdog_js::utf16_len;
use mixdog_js::v8_json_parse_error;
use mixdog_js::value_to_string;
use mixdog_rt::DurabilityIo;
use mixdog_rt::LaneTokens;
use regex::Regex;
use serde::Deserialize;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;

const DOMAIN: &str = "desktop";

// ---------------------------------------------------------------------------------------------------------------------
// Link paths (transcript-file-links.ts)
// ---------------------------------------------------------------------------------------------------------------------

/// The path rules of one platform, as Node's `path` module applies them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PathFlavor {
    pub windows: bool,
    /// The drive a rooted path without one (`/srv/x`) takes on Windows: the process's current drive.
    pub drive: char,
}

impl PathFlavor {
    pub fn host() -> Self {
        let drive = std::env::current_dir()
            .ok()
            .and_then(|dir| dir.to_string_lossy().chars().next().filter(char::is_ascii_alphabetic))
            .unwrap_or('C');
        Self { windows: cfg!(windows), drive }
    }

    fn separator(self, c: char) -> bool {
        c == '/' || (self.windows && c == '\\')
    }

    /// `path.isAbsolute`.
    pub fn is_absolute(self, path: &str) -> bool {
        let mut chars = path.chars();
        let first = chars.next();
        if first.is_some_and(|c| self.separator(c)) {
            return true;
        }
        self.windows
            && first.is_some_and(|c| c.is_ascii_alphabetic())
            && chars.next() == Some(':')
            && chars.next().is_some_and(|c| self.separator(c))
    }

    /// `path.resolve(cwd, path)` for an absolute `cwd`, or `path.resolve(path)` for an absolute `path` (`cwd` empty).
    fn resolve(self, cwd: &str, path: &str) -> String {
        if !self.windows {
            let joined = if path.starts_with('/') { path.to_owned() } else { format!("{cwd}/{path}") };
            return normalize(&joined, false, "/");
        }
        let (cwd_drive, cwd_rest) = split_drive(cwd);
        let cwd_drive = cwd_drive.unwrap_or(self.drive);
        let (drive, rest) = split_drive(path);
        let rooted = rest.starts_with(['/', '\\']);
        let (drive, tail) = match (drive, rooted) {
            (named, true) => (named.unwrap_or(cwd_drive), rest.to_owned()),
            // `C:foo`: relative to that drive's folder; only the current folder's drive is known here.
            (Some(named), false) if named.eq_ignore_ascii_case(&cwd_drive) => (named, format!("{cwd_rest}\\{rest}")),
            (Some(named), false) => (named, format!("\\{rest}")),
            (None, false) => (cwd_drive, format!("{cwd_rest}\\{rest}")),
        };
        normalize(&tail, true, &format!("{drive}:\\"))
    }
}

/// The drive a Windows path names (a letter and `:` at its start), and the rest.
fn split_drive(path: &str) -> (Option<char>, &str) {
    let mut chars = path.chars();
    match (chars.next(), chars.next()) {
        (Some(drive), Some(':')) if drive.is_ascii_alphabetic() => (Some(drive), &path[2..]),
        _ => (None, path),
    }
}

/// Segments of `path` split on `/` (and `\` on Windows), `.` and empty ones dropped, `..` popping (never above the root),
/// joined after `root`.
fn normalize(path: &str, windows: bool, root: &str) -> String {
    let mut stack: Vec<&str> = Vec::new();
    for part in path.split(|c: char| c == '/' || (windows && c == '\\')) {
        match part {
            "" | "." => {}
            ".." => {
                stack.pop();
            }
            other => stack.push(other),
        }
    }
    format!("{root}{}", stack.join(if windows { "\\" } else { "/" }))
}

fn scheme_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)^[a-z][a-z0-9+.-]*:").expect("static pattern"))
}

fn windows_path_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)^[a-z]:(?:[/\\]|%2f|%5c)").expect("static pattern"))
}

fn hash_location_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)#L[0-9]+(?:C[0-9]+)?(?:-L?[0-9]+(?:C[0-9]+)?)?$").expect("static pattern"))
}

fn colon_location_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r":[0-9]+(?::[0-9]+)?(?:-[0-9]+)?$").expect("static pattern"))
}

fn is_file_scheme(text: &str) -> bool {
    text.get(..5).is_some_and(|head| head.eq_ignore_ascii_case("file:"))
}

/// `isLocalMarkdownLink` (renderer/markdown-url.ts).
fn is_local_markdown_link(value: &str) -> bool {
    let target = js_trim(value);
    if target.is_empty() || target.starts_with(['#', '?']) || target.starts_with("//") {
        return false;
    }
    if is_file_scheme(target) || windows_path_pattern().is_match(target) {
        return true;
    }
    !scheme_pattern().is_match(target)
}

/// `decodeURIComponent`; the text unchanged when it is malformed (`decodePath`).
fn decode_path(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] != b'%' {
            out.push(bytes[at]);
            at += 1;
            continue;
        }
        let byte = value
            .get(at + 1..at + 3)
            .filter(|pair| pair.bytes().all(|b| b.is_ascii_hexdigit()))
            .and_then(|pair| u8::from_str_radix(pair, 16).ok());
        let Some(byte) = byte else { return value.to_owned() };
        out.push(byte);
        at += 3;
    }
    String::from_utf8(out).unwrap_or_else(|_| value.to_owned())
}

/// `localMarkdownPath`: a local href decoded once, `?`/`#` dropped, backslashes turned to slashes.
fn local_markdown_path(path: &str) -> String {
    let mut target = js_trim(path).to_owned();
    if is_file_scheme(&target) {
        if target.get(5..7) == Some("//") {
            target.replace_range(..7, "");
            if target.get(..9).is_some_and(|head| head.eq_ignore_ascii_case("localhost")) {
                target.replace_range(..9, "");
            }
        }
        let mut chars = target.chars();
        if chars.next() == Some('/') && chars.next().is_some_and(|c| c.is_ascii_alphabetic()) && chars.next() == Some(':') {
            target.remove(0);
        }
    }
    let end = target.find(['?', '#']).unwrap_or(target.len());
    decode_path(&target[..end]).replace('\\', "/")
}

/// The path of `parseLocalFileLocation(href)`: the text before a `:12`, `:12:4`, `:12-20`, `#L12`, `#L12C4` or `#L12-L20`
/// suffix, whether or not the suffix is a valid position (an invalid one is dropped as well). A drive letter (`C:/`) is
/// never taken for a line.
fn location_path(href: &str) -> &str {
    let raw = js_trim(href);
    if let Some(found) = hash_location_pattern().find(raw) {
        return &raw[..found.start()];
    }
    if let Some(found) = colon_location_pattern().find(raw) {
        let prefix = &raw[..found.start()];
        let letter = prefix.len() == 1 && prefix.as_bytes()[0].is_ascii_alphabetic();
        if found.start() > 0 && !letter {
            return prefix;
        }
    }
    raw
}

/// One href decoded the way MarkdownLink decodes a local href, without its location; `None` for web links and empty targets.
fn link_path(raw: &str) -> Option<String> {
    let text = js_trim(raw).trim_end_matches(['.', ',', ';', ':', '!', '?', '\'', '"', ')', ']', '}', '>']);
    if text.is_empty() || !is_local_markdown_link(text) {
        return None;
    }
    let path = local_markdown_path(location_path(text));
    (!path.is_empty() && !path.contains('\0')).then_some(path)
}

/// `resolveLinkedPath`: the absolute host path a decoded link names, absolute as written or relative to the session's folder.
/// `None` for network (UNC) targets and for a relative link when the session's folder is unknown.
pub fn resolve_linked_path(flavor: PathFlavor, path: &str, cwd: &str) -> Option<String> {
    let mut head = path.chars();
    if head.next().is_some_and(|c| c == '/' || c == '\\') && head.next().is_some_and(|c| c == '/' || c == '\\') {
        return None;
    }
    if flavor.is_absolute(path) {
        return Some(flavor.resolve("", path));
    }
    if cwd.is_empty() || !flavor.is_absolute(cwd) {
        return None;
    }
    Some(flavor.resolve(cwd, path))
}

/// `requestedLinkPath`: the absolute host path a link's `href` names; `None` for web links and unresolvable targets.
pub fn requested_link_path(flavor: PathFlavor, href: &str, cwd: &str) -> Option<String> {
    link_path(href).and_then(|path| resolve_linked_path(flavor, &path, cwd))
}

// ---------------------------------------------------------------------------------------------------------------------
// Attachments a conversation names (transcript-file-links.ts `sessionAttachments`)
// ---------------------------------------------------------------------------------------------------------------------

/// One attachment record; `kind` is whatever the row carried (`image`, `file`, `text`), `file` when it carried none.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionAttachment {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub kind: Value,
    pub size: f64,
}

impl SessionAttachment {
    pub fn to_json(&self) -> Value {
        json!({ "id": self.id, "name": self.name, "mimeType": self.mime_type, "kind": self.kind, "size": json_number(self.size) })
    }
}

fn attachment_id_shape(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// JavaScript's `Number(value) || 0` for a JSON value.
fn number_or_zero(value: Option<&Value>) -> f64 {
    let number = to_number_of(value);
    if number.is_nan() { 0.0 } else { number }
}

/// JavaScript's `String(value || fallback)`: a truthy value's string form, else the fallback.
fn text_or(value: Option<&Value>, fallback: &str) -> String {
    match value {
        None | Some(Value::Null | Value::Bool(false)) => fallback.to_owned(),
        Some(Value::String(s)) if s.is_empty() => fallback.to_owned(),
        Some(Value::Number(n)) if n.as_f64().is_none_or(|f| f == 0.0) => fallback.to_owned(),
        Some(other) => value_to_string(other),
    }
}

fn objects<'a>(value: Option<&'a Value>) -> impl Iterator<Item = &'a Map<String, Value>> {
    value.and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object)
}

/// The attachments the session's USER rows carry, by content hash, in first-seen order: the message metadata's
/// `attachments` and, for rows sent before that was recorded, the images' own `attachmentRef` / `imageRefs`; plus the files a
/// task report or a member's room speech returned. Nothing else in a transcript names an attachment the host will serve.
pub fn session_attachments(snapshot: &Value) -> Vec<SessionAttachment> {
    let mut found: Vec<SessionAttachment> = Vec::new();
    let mut add = |id: Option<&Value>, name: String, mime_type: String, kind: Value, size: f64| {
        let Some(id) = id.and_then(Value::as_str).filter(|id| attachment_id_shape(id)) else { return };
        if found.iter().any(|known| known.id == id) {
            return;
        }
        // `String(info.name || 'attachment')` again over the caller's text (an image's `[]` name prints as empty).
        let name = if name.is_empty() { "attachment".to_owned() } else { name };
        let mime_type = if mime_type.is_empty() { "application/octet-stream".to_owned() } else { mime_type };
        found.push(SessionAttachment { id: id.to_owned(), name: slice_utf16(&name, 200), mime_type: slice_utf16(&mime_type, 100), kind, size });
    };
    for item in objects(snapshot.get("items")) {
        let kind_of = |key: &str| item.get(key).and_then(|v| v.get("kind")).and_then(Value::as_str);
        let item_kind = item.get("kind").and_then(Value::as_str);
        // The runtime's own rows that return files a bot or agent produced: a task report and a member's room speech.
        let returned = item_kind == Some("notice") && (kind_of("routine") == Some("task") || kind_of("room") == Some("speech"));
        if item_kind != Some("user") && !returned {
            continue;
        }
        for entry in objects(item.get("attachments")) {
            add(
                entry.get("id"),
                text_or(entry.get("name"), "attachment"),
                text_or(entry.get("mimeType"), "application/octet-stream"),
                entry.get("kind").filter(|kind| !kind.is_null()).cloned().unwrap_or_else(|| json!("file")),
                number_or_zero(entry.get("size")),
            );
        }
        for image in objects(item.get("images")) {
            add(
                image.get("attachmentRef"),
                text_or(image.get("name"), "image"),
                text_or(image.get("mimeType"), "image/png"),
                json!("image"),
                number_or_zero(image.get("bytes")),
            );
        }
        for slot in objects(item.get("imageRefs")) {
            add(slot.get("ref"), "image".into(), "image/png".into(), json!("image"), 0.0);
        }
    }
    found
}

// ---------------------------------------------------------------------------------------------------------------------
// Session attachments by id (session-attachments.ts)
// ---------------------------------------------------------------------------------------------------------------------

/// What reading a session's attachments needs of the core.
#[async_trait]
pub trait AttachmentHost: Send + Sync {
    /// The transcript window the host holds for the session (`readSessionTranscript`); `None` when it holds none.
    async fn session_transcript(&self, session_id: &str) -> Option<Value>;
    /// The session's whole stored conversation, the rows a compaction moved to the archive included (`readSessionHistory`);
    /// `None` when the host cannot read it, and the window alone then serves.
    async fn session_history(&self, _session_id: &str) -> Option<Value> {
        None
    }
    /// The stored bytes of an attachment by content hash (`readAttachmentImage`); `None` when the store no longer has it.
    async fn attachment_bytes(&self, id: &str) -> Option<Vec<u8>>;
}

#[derive(Debug, PartialEq, Eq)]
pub enum AttachmentError {
    /// The attachment id is not a 64-character lowercase hex hash.
    InvalidId,
    /// A download refusal: `reason` is `not-linked`, `not-found` or `changed`.
    Refused { reason: &'static str, message: &'static str },
}

const NOT_LINKED: AttachmentError = AttachmentError::Refused { reason: "not-linked", message: "This conversation has no such attachment." };
const NOT_FOUND: AttachmentError = AttachmentError::Refused { reason: "not-found", message: "This attachment is no longer stored on the PC." };
const CHANGED: AttachmentError = AttachmentError::Refused { reason: "changed", message: "The stored attachment failed its integrity check." };

/// The attachment this session's conversation names by `id`: the transcript window, else (a compaction moves older rows into
/// the archive, so a chip the pane still shows can name an id only the whole stored conversation holds) the whole history.
async fn named_attachment(host: &dyn AttachmentHost, session_id: &str, id: &str) -> Option<SessionAttachment> {
    let find = |snapshot: Value| session_attachments(&snapshot).into_iter().find(|attachment| attachment.id == id);
    if let Some(found) = host.session_transcript(session_id).await.and_then(find) {
        return Some(found);
    }
    host.session_history(session_id).await.and_then(find)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The attachment of `session_id` with this id and its verified bytes. `not-linked` for an id the session's conversation does
/// not name (another session's, a guessed hash), `not-found` when the store no longer has it, `changed` for bytes that do not
/// hash to the id (the store is content-addressed).
pub async fn read_session_attachment(host: &dyn AttachmentHost, session_id: &str, attachment_id: &str) -> Result<(SessionAttachment, Vec<u8>), AttachmentError> {
    if !attachment_id_shape(attachment_id) {
        return Err(AttachmentError::InvalidId);
    }
    let Some(meta) = named_attachment(host, session_id, attachment_id).await else { return Err(NOT_LINKED) };
    let bytes = host.attachment_bytes(attachment_id).await.filter(|bytes| !bytes.is_empty()).ok_or(NOT_FOUND)?;
    if hex(&Sha256::digest(&bytes)) != attachment_id {
        return Err(CHANGED);
    }
    Ok((meta, bytes))
}

fn extension_of_type(mime_type: &str) -> &'static str {
    match mime_type {
        "image/png" => ".png",
        "image/jpeg" => ".jpg",
        "image/gif" => ".gif",
        "image/webp" => ".webp",
        "application/pdf" => ".pdf",
        "text/plain" => ".txt",
        "text/markdown" => ".md",
        _ => "",
    }
}

/// `sanitizedFileName` (ipc-validation.ts): no separators or reserved characters, at most 120 UTF-16 units.
fn sanitized_file_name(value: &str) -> String {
    let mut replaced = String::with_capacity(value.len());
    let mut in_run = false;
    for c in value.chars() {
        if matches!(c, '\u{0}'..='\u{1f}' | '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
            if !in_run {
                replaced.push('-');
            }
            in_run = true;
        } else {
            replaced.push(c);
            in_run = false;
        }
    }
    let trimmed = replaced
        .trim_start_matches(|c: char| is_js_space(c) || c == '.' || c == '-')
        .trim_end_matches(|c: char| is_js_space(c) || c == '.');
    let name = slice_utf16(trimmed, 120);
    if name.is_empty() { "download".to_owned() } else { name }
}

/// Node's `path.extname` of a name without separators.
fn extension_of(name: &str) -> &str {
    match name.rfind('.') {
        None | Some(0) => "",
        Some(_) if name == ".." => "",
        Some(at) => &name[at..],
    }
}

/// A file name that previews by its extension: the attachment's own name, or its media type's extension when the name has none.
pub fn attachment_view_name(meta: &SessionAttachment) -> String {
    let name = sanitized_file_name(&meta.name);
    if extension_of(&name).is_empty() {
        let extension = extension_of_type(&js_to_lowercase(&meta.mime_type));
        format!("{name}{extension}")
    } else {
        name
    }
}

/// Writes the attachment to `<temp>/mixdog-attachments/<id16>-<name>` (the same temp convention as an opened data: attachment)
/// and returns its path, so the file previews through the ordinary file preview paths.
pub fn stage_session_attachment(temp: &Path, meta: &SessionAttachment, bytes: &[u8]) -> Result<PathBuf, String> {
    if temp.as_os_str().is_empty() {
        return Err("Unable to open file: no temporary directory.".to_owned());
    }
    let directory = temp.join("mixdog-attachments");
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let file = directory.join(format!("{}-{}", &meta.id[..16], attachment_view_name(meta)));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    std::io::Write::write_all(&mut options.open(&file).map_err(|error| error.to_string())?, bytes).map_err(|error| error.to_string())?;
    Ok(file)
}

// ---------------------------------------------------------------------------------------------------------------------
// JSONC settings (workflow-config.ts)
// ---------------------------------------------------------------------------------------------------------------------

const JSONC_MAX_UTF16: usize = 2_000_000;

fn strip_json_comments(source: &str) -> String {
    let chars: Vec<char> = source.chars().collect();
    let mut result = String::with_capacity(source.len());
    let (mut quoted, mut escaped) = (false, false);
    let mut index = 0;
    while index < chars.len() {
        let c = chars[index];
        let next = chars.get(index + 1).copied();
        if quoted {
            result.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                quoted = false;
            }
        } else if c == '"' {
            quoted = true;
            result.push(c);
        } else if c == '/' && next == Some('/') {
            while index < chars.len() && chars[index] != '\n' {
                index += 1;
            }
            result.push('\n');
        } else if c == '/' && next == Some('*') {
            index += 2;
            while index < chars.len() && !(chars[index] == '*' && chars.get(index + 1) == Some(&'/')) {
                if chars[index] == '\n' {
                    result.push('\n');
                }
                index += 1;
            }
            index += 1;
        } else {
            result.push(c);
        }
        index += 1;
    }
    result
}

fn strip_trailing_commas(source: &str) -> String {
    let chars: Vec<char> = source.chars().collect();
    let mut result = String::with_capacity(source.len());
    let (mut quoted, mut escaped) = (false, false);
    for (index, &c) in chars.iter().enumerate() {
        if quoted {
            result.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                quoted = false;
            }
            continue;
        }
        if c == '"' {
            quoted = true;
        } else if c == ',' {
            let mut cursor = index + 1;
            while cursor < chars.len() && is_js_space(chars[cursor]) {
                cursor += 1;
            }
            if matches!(chars.get(cursor).copied(), Some('}' | ']')) {
                continue;
            }
        }
        result.push(c);
    }
    result
}

/// `parseJsonc`: JSON with `//` and `/* */` comments and trailing commas. A source over 2,000,000 UTF-16 units is refused.
pub fn parse_jsonc(source: &str) -> Result<Value, String> {
    if utf16_len(source) > JSONC_MAX_UTF16 {
        return Err("JSON configuration is too large.".to_owned());
    }
    let text = strip_trailing_commas(&strip_json_comments(source));
    json_parse(&text).map_err(|error| v8_json_parse_error(&text).unwrap_or_else(|| error.to_string()))
}

/// `objectRecord`: the value when it is an object (not an array), else `None`.
pub fn object_record(value: Value) -> Option<Map<String, Value>> {
    match value {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

/// Text that holds no data: empty, or only NULs and whitespace (`holdsNoData`).
fn holds_no_data(text: &str) -> bool {
    text.chars().all(|c| c == '\0' || is_js_space(c))
}

/// The object a JSONC file holds; `None` when it is missing, or empty / NUL-filled (what a crash leaves of a user-edited
/// file), which means "no settings". A file that is not an object also answers `None`; a parse failure or a read failure other
/// than a missing file is an error.
pub fn read_jsonc_file(path: &Path) -> Result<Option<Map<String, Value>>, String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("{}: {error}", path.display())),
    };
    let text = String::from_utf8_lossy(&bytes);
    if holds_no_data(&text) {
        return Ok(None);
    }
    Ok(object_record(parse_jsonc(&text)?))
}

// ---------------------------------------------------------------------------------------------------------------------
// Installed font families (system-fonts.ts)
// ---------------------------------------------------------------------------------------------------------------------

const LIST_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_BUFFER: usize = 4 * 1024 * 1024;
const NAME_MAX: usize = 100;

/// The listing command of a platform (`process.platform` names): Windows asks .NET's InstalledFontCollection (the family names
/// DirectWrite matches), macOS asks NSFontManager through JXA, Linux asks fontconfig.
fn listing_command(platform: &str) -> Option<(&'static str, Vec<&'static str>)> {
    match platform {
        "win32" => Some((
            "powershell.exe",
            vec![
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Add-Type -AssemblyName System.Drawing; (New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }",
            ],
        )),
        "darwin" => Some((
            "osascript",
            vec!["-l", "JavaScript", "-e", "ObjC.import('AppKit'); $.NSFontManager.sharedFontManager.availableFontFamilies.js.map((f) => f.js).join('\\n')"],
        )),
        "linux" => Some(("fc-list", vec!["--format=%{family}\\n"])),
        _ => None,
    }
}

/// Family names from a listing: one per line (fontconfig joins a family's localized names with commas), trimmed, de-duplicated
/// and sorted by `localeCompare`; hidden system faces (a leading dot) and names over 100 UTF-16 units are dropped.
pub fn parse_font_families(platform: &str, stdout: &str) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for line in stdout.split('\n').map(|line| line.strip_suffix('\r').unwrap_or(line)) {
        let pieces: Vec<&str> = if platform == "linux" { line.split(',').collect() } else { vec![line] };
        for name in pieces.into_iter().map(js_trim) {
            if !name.is_empty() && utf16_len(name) <= NAME_MAX && !name.starts_with('.') && !names.iter().any(|known| known == name) {
                names.push(name.to_owned());
            }
        }
    }
    names.sort_by(|a, b| locale_compare(a, b));
    names
}

/// The platform's name in Node's vocabulary.
pub fn host_platform() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

/// The stdout of a listing command that exits 0 within the time limit and prints at most the buffer limit; any failure is `None`.
fn run_listing(file: &str, args: &[&str]) -> Option<String> {
    let mut command = std::process::Command::new(file);
    command.args(args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0800_0000);
    let mut child = command.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = stdout.by_ref().take(MAX_BUFFER as u64 + 1).read_to_end(&mut buffer);
        let _ = sender.send(buffer);
    });
    let buffer = match receiver.recv_timeout(LIST_TIMEOUT) {
        Ok(buffer) if buffer.len() <= MAX_BUFFER => buffer,
        _ => {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
    };
    child.wait().ok().filter(|status| status.success())?;
    Some(String::from_utf8_lossy(&buffer).into_owned())
}

/// The families of one OS listing, uncached; a platform without a listing, or any failure, answers an empty list (the
/// renderer keeps free-text entry).
pub fn list_system_fonts_uncached(platform: &str) -> Vec<String> {
    let Some((file, args)) = listing_command(platform) else { return Vec::new() };
    run_listing(file, &args).map(|stdout| parse_font_families(platform, &stdout)).unwrap_or_default()
}

/// One OS listing per process, cached (an empty answer included).
pub fn list_system_fonts() -> &'static [String] {
    static CACHED: OnceLock<Vec<String>> = OnceLock::new();
    CACHED.get_or_init(|| list_system_fonts_uncached(host_platform()))
}

// ---------------------------------------------------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LinkParams {
    href: String,
    #[serde(default)]
    cwd: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PathParams {
    path: String,
    #[serde(default)]
    cwd: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AttachmentParams {
    session_id: String,
    attachment_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConfigParams {
    path: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NoParams {}

const METHODS: &[&str] = &[
    "desktop/link/resolve",
    "desktop/link/resolvePath",
    "desktop/attachment/resolve",
    "desktop/attachment/stage",
    "desktop/workflowConfig/read",
    "desktop/fonts/list",
];

pub struct DesktopResidualService {
    attachments: Arc<dyn AttachmentHost>,
    durability: DurabilityIo,
    flavor: PathFlavor,
    temp: PathBuf,
}

impl DesktopResidualService {
    pub fn new(attachments: Arc<dyn AttachmentHost>, tokens: &LaneTokens) -> Self {
        Self { attachments, durability: tokens.durability_io, flavor: PathFlavor::host(), temp: std::env::temp_dir() }
    }

    async fn attachment(&self, params: &AttachmentParams) -> Result<(SessionAttachment, Vec<u8>), CoreError> {
        let session_id = required_session_id(&params.session_id).ok_or_else(|| invalid("sessionId", "a session id"))?;
        read_session_attachment(&*self.attachments, session_id, &params.attachment_id).await.map_err(|error| match error {
            AttachmentError::InvalidId => invalid("attachmentId", "a 64-character lowercase hex attachment id"),
            AttachmentError::Refused { reason, message } => coded(DOMAIN, &format!("file-download:{reason}"), message),
        })
    }
}

/// `requiredSessionId` (desktop-state.ts): the trimmed id, 1 to 256 characters of letters, digits, `_` and `-`.
fn required_session_id(value: &str) -> Option<&str> {
    let id = value.trim();
    (!id.is_empty() && id.len() <= 256 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')).then_some(id)
}

fn reply(value: Value) -> Result<Reply, CoreError> {
    Ok(Reply::Value(value))
}

#[async_trait]
impl DomainService for DesktopResidualService {
    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        match req.method.as_str() {
            "desktop/link/resolve" => {
                let params: LinkParams = decode(&req)?;
                reply(json!({ "path": requested_link_path(self.flavor, &params.href, params.cwd.as_deref().unwrap_or("")) }))
            }
            "desktop/link/resolvePath" => {
                let params: PathParams = decode(&req)?;
                reply(json!({ "path": resolve_linked_path(self.flavor, &params.path, params.cwd.as_deref().unwrap_or("")) }))
            }
            "desktop/attachment/resolve" => {
                let params: AttachmentParams = decode(&req)?;
                let (meta, bytes) = self.attachment(&params).await?;
                // What the desktop's `readSessionAttachment` IPC answered: the previewable name and the bytes as a data URL.
                let data_url = format!("data:{};base64,{}", meta.mime_type, base64::engine::general_purpose::STANDARD.encode(&bytes));
                reply(json!({ "attachment": meta.to_json(), "bytes": bytes.len(), "viewName": attachment_view_name(&meta), "dataUrl": data_url }))
            }
            "desktop/attachment/stage" => {
                let params: AttachmentParams = decode(&req)?;
                let (meta, bytes) = self.attachment(&params).await?;
                let temp = self.temp.clone();
                let record = meta.clone();
                let path = on_lane_wait(self.durability, &req.ctx.cancel, move |_| stage_session_attachment(&temp, &record, &bytes))
                    .await?
                    .map_err(|error| failed(DOMAIN, error))?;
                reply(json!({ "path": path.to_string_lossy(), "attachment": meta.to_json() }))
            }
            "desktop/workflowConfig/read" => {
                let params: ConfigParams = decode(&req)?;
                let path = PathBuf::from(params.path);
                let config = on_lane_wait(self.durability, &req.ctx.cancel, move |_| read_jsonc_file(&path)).await?.map_err(|error| failed(DOMAIN, error))?;
                reply(json!({ "config": config }))
            }
            "desktop/fonts/list" => {
                let _params: NoParams = decode(&req)?;
                let families = on_lane_wait(self.durability, &req.ctx.cancel, move |_| list_system_fonts().to_vec()).await?;
                reply(json!({ "families": families }))
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
#[path = "desktop_residual_tests.rs"]
mod tests;
