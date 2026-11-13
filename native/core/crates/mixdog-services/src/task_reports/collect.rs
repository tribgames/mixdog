//! The files a finished turn produced (`collectTurnArtifacts` of
//! `session-runtime/handoff-attachments.mjs`): the paths its final reply and its tool calls name,
//! read once each inside the session's folders, typed and stored as attachments. Every file read
//! goes through the statefile lane functions, so the caller runs [`collect_turn_artifacts`] inside
//! a lane job and hands it a `store` for the attachment bytes (see [`store_attachment`]).

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;

use mixdog_js::{JsRegex, js_trim, value_to_string};
use mixdog_rt::InLane;
use mixdog_statefile::{IoLane, WriteLane, metadata, read_range, symlink_metadata};
use mixdog_store::blobs::BlobStore;
use serde_json::{Map, Value, json};

use super::artifacts::sensitive;
use super::runtime_state::truthy;

/// `HANDOFF_LIMITS.count`.
const MAX_FILES: usize = 8;
/// `MAX_ATTACHMENT_BLOB_BYTES`: the largest blob the attachment store accepts.
const MAX_BLOB_BYTES: usize = 64 * 1024 * 1024;
const HEAD_BYTES: usize = 4096;

const IMAGE_TYPES: [(&str, &str); 5] =
    [(".png", "image/png"), (".jpg", "image/jpeg"), (".jpeg", "image/jpeg"), (".gif", "image/gif"), (".webp", "image/webp")];
const DOCUMENT_TYPES: [(&str, &str); 8] = [
    (".pdf", "application/pdf"),
    (".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    (".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
    (".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    (".xlsm", "application/vnd.ms-excel.sheet.macroEnabled.12"),
    (".doc", "application/msword"),
    (".xls", "application/vnd.ms-excel"),
    (".ppt", "application/vnd.ms-powerpoint"),
];
const TEXT_TYPES: [(&str, &str); 6] = [
    (".md", "text/markdown"),
    (".html", "text/html"),
    (".htm", "text/html"),
    (".csv", "text/csv"),
    (".json", "application/json"),
    (".svg", "image/svg+xml"),
];
const TEXT_EXTENSIONS: &str = ".mdx .txt .log .jsonl .yaml .yml .toml .xml .tsv .js .jsx .mjs .cjs .ts .tsx .mts .cts .py .rb .rs .go .java .kt .swift .cs .cpp .cc .c .h .hh .hpp .sh .zsh .ps1 .bat .cmd .sql .css .scss .sass .vue .svelte .ini .conf .cfg .gql .graphql";
const SUPPORTED_IMAGE_MIME_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const OFFICE_WRITE_ACTIONS: [&str; 10] = ["author", "create", "batch", "render", "save", "finalize", "secure", "commit", "refine", "design"];

static PATCH_FILE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^\*\*\* (?:Add File|Update File|Move to): (.+)$", "gm"));
static MARKDOWN_LINK: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\]\(\s*<?([^)\s>]+)>?\s*\)", "g"));
static BACKTICK_PATH: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"`([^`\s]+\.[A-Za-z0-9]{1,8})`", "g"));
static ABSOLUTE_PATH: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r#"(?:^|[\s(])((?:[A-Za-z]:[\\/]|\/)[^\s"'<>|*?()[\]`]+\.[A-Za-z0-9]{1,8})"#, "g"));
static URL_SCHEME: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^[a-z][a-z0-9+.-]*://", "i"));
static NOT_A_FILE_LINK: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(?:https?|mailto|data):", "i"));
static FILE_SCHEME: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^file:///?", "i"));
static FRAGMENT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"#.*$", ""));
static POSITION: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r":\d+(?::\d+)?$", ""));

/// What a caller gives `collect_turn_artifacts` besides the messages.
pub struct Options {
    /// The directory relative paths are read from; the process directory when empty.
    pub cwd: String,
    /// The session's folders (already resolved); a file outside them is left out.
    pub roots: Vec<PathBuf>,
    /// Mixdog's home and data folders as [`sensitive_scopes`] makes them.
    pub scopes: Vec<Vec<String>>,
}

/// `{ files, omitted }`; each file `{ path, name, kind, mimeType, size, id? }`.
#[derive(Debug, PartialEq)]
pub struct Artifacts {
    pub files: Vec<Value>,
    pub omitted: usize,
}

impl Artifacts {
    pub fn to_json(&self) -> Value {
        json!({"files": self.files, "omitted": self.omitted})
    }
}

#[derive(Clone, Copy)]
struct Typ {
    kind: &'static str,
    mime: &'static str,
}

fn same_platform_path(path: &str) -> String {
    if cfg!(windows) { path.to_lowercase() } else { path.to_owned() }
}

/// `path.resolve(base, path)`, lexically.
fn resolve(base: &Path, path: &str) -> PathBuf {
    let path = Path::new(path);
    let joined = if path.is_absolute() { path.to_path_buf() } else { base.join(path) };
    let mut parts: Vec<Component> = Vec::new();
    for part in joined.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(parts.last(), Some(Component::Normal(_))) {
                    parts.pop();
                }
            }
            other => parts.push(other),
        }
    }
    parts.iter().collect()
}

fn base_dir(cwd: &str) -> PathBuf {
    if cwd.is_empty() { std::env::current_dir().unwrap_or_default() } else { PathBuf::from(cwd) }
}

/// `sessionRoots(session)`: the session's folders (its cwd, project and worktree, as the caller
/// lists them), each resolved to its real path; an empty, missing or filesystem-root one is left
/// out, and a folder listed twice counts once. Reads the file system: run it in a lane job.
pub fn session_roots(candidates: &[String]) -> Vec<PathBuf> {
    let base = base_dir("");
    let mut roots: Vec<PathBuf> = Vec::new();
    for candidate in candidates {
        if js_trim(candidate).is_empty() {
            continue;
        }
        let Ok(real) = mixdog_workspace::pathguard::canonical(&resolve(&base, candidate)) else { continue };
        if real.parent().is_none() {
            continue;
        }
        let key = same_platform_path(&real.to_string_lossy());
        if !roots.iter().any(|root| same_platform_path(&root.to_string_lossy()) == key) {
            roots.push(real);
        }
    }
    roots
}

fn within(root: &Path, path: &Path) -> bool {
    let base = same_platform_path(&root.to_string_lossy());
    let target = same_platform_path(&path.to_string_lossy());
    let prefix = if base.ends_with(std::path::MAIN_SEPARATOR) { base.clone() } else { format!("{base}{}", std::path::MAIN_SEPARATOR) };
    target == base || target.starts_with(&prefix)
}

/// `realOrSelf`: the canonical path, or the canonical parent with the missing tail put back.
fn real_or_self(path: &Path) -> PathBuf {
    if let Ok(real) = mixdog_workspace::pathguard::canonical(path) {
        return real;
    }
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) if parent != path => real_or_self(parent).join(name),
        _ => path.to_path_buf(),
    }
}

/// `mixdogSensitiveScopes`: the segments of each folder (home, data, extra), as written and as
/// their links resolve.
pub fn sensitive_scopes(folders: &[PathBuf]) -> Vec<Vec<String>> {
    let mut scopes = Vec::new();
    for folder in folders.iter().filter(|f| !f.as_os_str().is_empty()) {
        let resolved = resolve(&std::env::current_dir().unwrap_or_default(), &folder.to_string_lossy());
        let mut forms = vec![resolved.clone()];
        let real = real_or_self(&resolved);
        if real != resolved {
            forms.push(real);
        }
        scopes.extend(forms.iter().map(|form| sensitive::segments_of(&form.to_string_lossy())));
    }
    scopes
}

/// `isSensitiveLocalPath(path)`: the path as written or what its links lead to is a secret file.
fn is_sensitive_local_path(path: &Path, scopes: &[Vec<String>]) -> bool {
    let absolute = resolve(&std::env::current_dir().unwrap_or_default(), &path.to_string_lossy());
    sensitive::matches_sensitive_path(&absolute.to_string_lossy(), scopes) || sensitive::matches_sensitive_path(&real_or_self(&absolute).to_string_lossy(), scopes)
}

/// The identity of an opened file: its device and file number where the OS gives them, and its
/// creation time.
#[derive(PartialEq)]
struct Identity {
    file: (u64, u64),
    created: Option<std::time::SystemTime>,
}

#[cfg(unix)]
fn file_number(info: &std::fs::Metadata) -> (u64, u64) {
    use std::os::unix::fs::MetadataExt;
    (info.dev(), info.ino())
}

#[cfg(not(unix))]
fn file_number(_info: &std::fs::Metadata) -> (u64, u64) {
    (0, 0)
}

fn identity(info: &std::fs::Metadata) -> Identity {
    Identity { file: file_number(info), created: info.created().ok() }
}

/// `samePathAndHandle`: every directory on the way to `real` is a real directory, never a link,
/// and the final entry is the file that was opened.
fn same_path_and_handle<L: IoLane>(lane: &InLane<L>, real: &Path, opened: &Identity) -> bool {
    let mut chain: Vec<&Path> = real.ancestors().take_while(|ancestor| ancestor.parent().is_some()).collect();
    chain.reverse();
    for (index, current) in chain.iter().enumerate() {
        let Ok(info) = symlink_metadata(lane, current) else { return false };
        if info.file_type().is_symlink() {
            return false;
        }
        let last = index + 1 == chain.len();
        if !last && !info.is_dir() {
            return false;
        }
        if last {
            return info.is_file() && identity(&info) == *opened;
        }
    }
    false
}

/// `extname`.
fn extname(name: &str) -> &str {
    match name.rfind('.') {
        Some(0) | None => "",
        Some(dot) => &name[dot..],
    }
}

/// `classify(name, head)`.
fn classify(name: &str, head: &[u8]) -> Option<Typ> {
    let ext = extname(name).to_lowercase();
    let find = |table: &[(&'static str, &'static str)]| table.iter().find(|(e, _)| *e == ext).map(|(_, mime)| *mime);
    if let Some(mime) = find(&IMAGE_TYPES) {
        return Some(Typ { kind: "image", mime });
    }
    let pdf = head.starts_with(b"%PDF-");
    if let Some(mime) = find(&DOCUMENT_TYPES) {
        return Some(Typ { kind: "file", mime: if pdf { "application/pdf" } else { mime } });
    }
    if pdf {
        return Some(Typ { kind: "file", mime: "application/pdf" });
    }
    let text_ext = find(&TEXT_TYPES).is_some() || TEXT_EXTENSIONS.split(' ').any(|e| e == ext);
    if text_ext || (ext.is_empty() && !head.is_empty() && !head.contains(&0)) {
        return Some(Typ { kind: "text", mime: find(&TEXT_TYPES).unwrap_or("text/plain") });
    }
    None
}

/// `limitsOf(kind)`: `(each, total, slot)`.
fn limits_of(kind: &str) -> (u64, u64, usize) {
    match kind {
        "image" => (12_000_000, 22_500_000, 0),
        "text" => (750_000, 850_000, 1),
        _ => (20 * 1024 * 1024, 21_000_000, 2),
    }
}

/// `createBudget`: running totals per kind.
#[derive(Default)]
struct Budget([u64; 3]);

impl Budget {
    fn take(&mut self, kind: &str, size: u64) -> bool {
        let (each, total, slot) = limits_of(kind);
        if size > each || self.0[slot] + size > total {
            return false;
        }
        self.0[slot] += size;
        true
    }
}

struct ContainedFile {
    path: PathBuf,
    name: String,
    typ: Option<Typ>,
    bytes: Option<Vec<u8>>,
    size: u64,
}

/// `readContained`: one file inside the roots, read once; `Err` is the reason it was left out, in Node's words without
/// the surface that leads them (`handoffError`).
fn read_contained<L: IoLane>(lane: &InLane<L>, raw: &str, options: &Options) -> Result<ContainedFile, String> {
    let value = js_trim(raw);
    if value.is_empty() || value.contains('\0') {
        return Err("an attachment path is empty or invalid".to_owned());
    }
    let absolute = resolve(&base_dir(&options.cwd), value);
    let missing = || format!("attachment \"{value}\" does not exist");
    let info = metadata(lane, &absolute).map_err(|_| missing())?;
    if !info.is_file() {
        return Err(format!("attachment \"{value}\" is not a file"));
    }
    let opened = identity(&info);
    let real = mixdog_workspace::pathguard::canonical(&absolute).map_err(|_| missing())?;
    if !options.roots.iter().any(|root| within(root, &real)) {
        return Err(format!("attachment \"{value}\" is outside this session's folders"));
    }
    if is_sensitive_local_path(&absolute, &options.scopes) || is_sensitive_local_path(&real, &options.scopes) {
        return Err(format!("attachment \"{value}\" can hold credentials or secrets and is never attached"));
    }
    if !same_path_and_handle(lane, &real, &opened) {
        return Err(format!("attachment \"{value}\" changed while it was opened"));
    }
    let name = real.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let head = read_range(lane, &real, 0, HEAD_BYTES).map_err(|e| e.to_string())?;
    let typ = classify(&name, &head);
    // At most `each + 1` bytes are ever read, whatever the file claims or grows to.
    let bytes = match typ {
        Some(typ) => {
            let each = limits_of(typ.kind).0 as usize;
            let read = read_range(lane, &real, 0, each + 1).map_err(|e| e.to_string())?;
            (read.len() <= each).then_some(read)
        }
        None => None,
    };
    if !same_path_and_handle(lane, &real, &opened) {
        return Err(format!("attachment \"{value}\" changed while it was read"));
    }
    let size = bytes.as_ref().map_or(info.len(), |b| b.len() as u64);
    Ok(ContainedFile { path: real, name, typ, bytes, size })
}

/// `decodeURI`: percent escapes decoded except those of reserved characters; `None` for a
/// malformed sequence (Node throws there).
fn decode_uri(text: &str) -> Option<String> {
    const RESERVED: &str = ";/?:@&=+$,#";
    let bytes = text.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    let hex = |at: usize| -> Option<u8> {
        if bytes.get(at) != Some(&b'%') {
            return None;
        }
        let pair = bytes.get(at + 1..at + 3)?;
        u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok()
    };
    while i < bytes.len() {
        if bytes[i] != b'%' {
            let ch = text[i..].chars().next()?;
            out.push(ch);
            i += ch.len_utf8();
            continue;
        }
        let first = hex(i)?;
        if first < 0x80 {
            if RESERVED.contains(first as char) {
                out.push_str(&text[i..i + 3]);
            } else {
                out.push(first as char);
            }
            i += 3;
            continue;
        }
        let count = match first {
            0xC0..=0xDF => 2,
            0xE0..=0xEF => 3,
            0xF0..=0xF7 => 4,
            _ => return None,
        };
        let mut sequence = vec![first];
        for n in 1..count {
            let next = hex(i + 3 * n)?;
            if next & 0xC0 != 0x80 {
                return None;
            }
            sequence.push(next);
        }
        out.push_str(std::str::from_utf8(&sequence).ok()?);
        i += 3 * count;
    }
    Some(out)
}

/// `replyPaths`: file references in a reply's text; URLs never count.
fn reply_paths(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut add = |raw: &str| {
        let value = js_trim(raw);
        if value.is_empty() || NOT_A_FILE_LINK.is_match(value) {
            return;
        }
        let strip = |regex: &JsRegex, text: String| regex.replace_all_with(&text, |_| String::new());
        let value = strip(&POSITION, strip(&FRAGMENT, strip(&FILE_SCHEME, value.to_owned())));
        let value = decode_uri(&value).unwrap_or(value);
        if !value.is_empty() {
            found.push(value);
        }
    };
    for regex in [&*MARKDOWN_LINK, &*BACKTICK_PATH, &*ABSOLUTE_PATH] {
        for caps in regex.captures_iter(text) {
            if let Some(path) = caps.get(1) {
                add(path);
            }
        }
    }
    found
}

/// `textOf(content)`.
fn text_of(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .map(|part| match part {
                Value::String(text) => text.as_str(),
                other => other.get("text").and_then(Value::as_str).unwrap_or(""),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// `String(call?.function?.name || call?.name || '')`.
fn call_name(call: &Value) -> String {
    [call.pointer("/function/name"), call.get("name")].into_iter().flatten().find(|v| truthy(v)).map(value_to_string).unwrap_or_default()
}

/// `callArgs(call)`: the call's arguments as an object (parsed when text); anything else is empty.
fn call_args(call: &Value) -> Value {
    let given = [call.pointer("/function/arguments"), call.get("arguments"), call.get("input")].into_iter().flatten().find(|v| !v.is_null());
    let args = match given {
        Some(Value::String(text)) => serde_json::from_str(text).unwrap_or(Value::Null),
        Some(other) => other.clone(),
        None => Value::Null,
    };
    if args.is_object() || args.is_array() { args } else { Value::Object(Map::new()) }
}

fn trimmed(value: Option<&Value>) -> Vec<String> {
    value.and_then(Value::as_str).map(js_trim).filter(|s| !s.is_empty()).map(str::to_owned).into_iter().collect()
}

/// `toolCallOutputs(call, false)`: the paths one tool call wrote or produced.
fn tool_call_outputs(call: &Value) -> Vec<String> {
    let name = call_name(call);
    let args = call_args(call);
    let action = args.get("action").and_then(Value::as_str).unwrap_or("");
    match name.as_str() {
        "edit" => trimmed(args.get("file_path")),
        "apply_patch" => {
            let patch = args.get("patch").filter(|v| truthy(v)).map(value_to_string).unwrap_or_default();
            PATCH_FILE.captures_iter(&patch).filter_map(|caps| caps.get(1).map(|path| js_trim(path).to_owned())).collect()
        }
        "media" if action == "generate" || action == "status" => trimmed(args.get("path")),
        "office" if OFFICE_WRITE_ACTIONS.contains(&action) => [trimmed(args.get("output")), trimmed(args.get("path"))].concat(),
        "visualize" => {
            let input = args.get("input").cloned().unwrap_or(Value::Null);
            let targets = if action == "open" { input.get("targets").and_then(Value::as_array).cloned().unwrap_or_default() } else { Vec::new() };
            let targets: Vec<String> = targets.iter().filter_map(Value::as_str).filter(|t| !URL_SCHEME.is_match(t)).map(str::to_owned).collect();
            trimmed(input.get("output")).into_iter().chain(targets).collect()
        }
        _ => Vec::new(),
    }
}

/// `turnArtifactCandidates(messages)`: what the final reply names, then media, office and
/// visualize outputs, then the files the turn edited.
fn turn_artifact_candidates(messages: &Value) -> Vec<String> {
    let list: &[Value] = messages.as_array().map_or(&[], Vec::as_slice);
    let assistant = |message: &Value| message.get("role").and_then(Value::as_str) == Some("assistant");
    let content_of = |message: &Value| text_of(message.get("content").unwrap_or(&Value::Null));
    let reply = list.iter().rev().find(|m| assistant(m) && !js_trim(&content_of(m)).is_empty());
    let (mut produced, mut edited) = (Vec::new(), Vec::new());
    for message in list.iter().filter(|m| assistant(m)) {
        let calls = ["tool_calls", "toolCalls"].iter().find_map(|key| message.get(*key).and_then(Value::as_array)).map_or(&[][..], Vec::as_slice);
        for call in calls {
            let bucket = if matches!(call_name(call).as_str(), "edit" | "apply_patch") { &mut edited } else { &mut produced };
            bucket.extend(tool_call_outputs(call));
        }
    }
    let mut out = reply.map(|m| reply_paths(&content_of(m))).unwrap_or_default();
    out.extend(produced);
    out.extend(edited);
    out
}

/// `readableCandidates`: the distinct files among `candidates` that can be read inside the roots.
fn readable_candidates<L: IoLane>(lane: &InLane<L>, candidates: &[String], options: &Options) -> Vec<ContainedFile> {
    let base = base_dir(&options.cwd);
    let mut seen = HashSet::new();
    let mut files = Vec::new();
    for candidate in candidates {
        let lexical = same_platform_path(&resolve(&base, candidate).to_string_lossy());
        if !seen.insert(lexical.clone()) {
            continue;
        }
        let Ok(file) = read_contained(lane, candidate, options) else { continue };
        let key = same_platform_path(&file.path.to_string_lossy());
        if key != lexical && seen.contains(&key) {
            continue;
        }
        seen.insert(key);
        files.push(file);
    }
    files
}

/// `collectTurnArtifacts(messages, { cwd, roots })`: the files one turn (see `turn_slice`)
/// produced, inside the roots. A file that fits a prompt's types and limits is stored through
/// `store` and carries its attachment `id`; otherwise it is a path-only entry. Secret files,
/// folders and anything outside the roots are left out silently; at most eight are kept.
pub fn collect_turn_artifacts<L: IoLane>(
    lane: &InLane<L>,
    messages: &Value,
    options: &Options,
    store: &dyn Fn(&[u8]) -> Result<String, String>,
) -> Artifacts {
    let mut files = Vec::new();
    let mut omitted = 0;
    let mut budget = Budget::default();
    for file in readable_candidates(lane, &turn_artifact_candidates(messages), options) {
        if files.len() >= MAX_FILES {
            omitted += 1;
            continue;
        }
        let (kind, mime) = file.typ.map_or(("file", "application/octet-stream"), |t| (t.kind, t.mime));
        let mut entry = json!({
            "path": file.path.to_string_lossy(),
            "name": file.name,
            "kind": kind,
            "mimeType": mime,
            "size": file.size,
        });
        if let (Some(typ), Some(bytes)) = (file.typ, &file.bytes) {
            let storable = typ.kind != "image" || SUPPORTED_IMAGE_MIME_TYPES.contains(&typ.mime);
            if storable
                && budget.take(typ.kind, bytes.len() as u64)
                && let Ok(id) = store(bytes)
            {
                entry["id"] = Value::String(id);
            }
        }
        files.push(entry);
    }
    Artifacts { files, omitted }
}

/// The prompt parts and attachment records of a call's `attachments` (`resolveHandoffAttachments`).
#[derive(Debug, Default, PartialEq)]
pub struct Handoff {
    /// The stored reference parts a forwarded prompt carries (`referencePart`).
    pub parts: Vec<Value>,
    /// `{ id, attachmentRef, kind, name, mimeType, size }` of each.
    pub records: Vec<Value>,
}

/// `ATTACHMENT_ID`.
fn is_attachment_id(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// An attachment a conversation shows: its id, kind, name and type.
#[derive(Clone, Debug, PartialEq)]
struct Shown {
    id: String,
    kind: &'static str,
    name: String,
    mime: String,
}

/// `conversationAttachments(messages)`: the attachments a conversation already shows, newest last. Only what the runtime
/// recorded in structured fields counts: a user message's stored reference parts and attachment records, and a room speech
/// row's stored files. Assistant and tool messages hold what a model or tool wrote and never name one.
fn conversation_attachments(messages: &Value) -> Vec<Shown> {
    let mut found: Vec<Shown> = Vec::new();
    // `String(a || b || fallback).slice(0, limit)`.
    let text = |values: [Option<&Value>; 2], fallback: &str, limit: usize| {
        let picked = values.into_iter().flatten().find(|v| truthy(v)).map_or_else(|| fallback.to_owned(), value_to_string);
        mixdog_js::slice_utf16(&picked, limit)
    };
    let mut add = |id: Option<&Value>, kind: Option<&str>, name: [Option<&Value>; 2], mime: [Option<&Value>; 2]| {
        let id = id.filter(|v| truthy(v)).map(value_to_string).unwrap_or_default();
        if !is_attachment_id(&id) {
            return;
        }
        let kind = match kind {
            Some("image") => "image",
            Some("text") => "text",
            _ => "file",
        };
        // A later occurrence moves the id to the end: the order is recency.
        found.retain(|shown| shown.id != id);
        let mime = text(mime, if kind == "image" { "image/png" } else { "application/octet-stream" }, 100);
        found.push(Shown { id, kind, name: text(name, "attachment", 200), mime });
    };
    for message in messages.as_array().map_or(&[][..], Vec::as_slice) {
        let meta = message.get("meta");
        let user = message.get("role").and_then(Value::as_str) == Some("user");
        let room = meta.and_then(|m| m.get("room"));
        let speech = meta.and_then(|m| m.get("source")).and_then(Value::as_str) == Some(mixdog_core_base::rooms::ids::ROOM_ROW_SOURCE)
            && room.and_then(|r| r.get("kind")).and_then(Value::as_str) == Some("speech");
        if !user && !speech {
            continue;
        }
        let content = message.get("content").and_then(Value::as_array).filter(|_| user);
        let room_parts = room.and_then(|r| r.get("parts")).and_then(Value::as_array);
        for part in content.into_iter().flatten().chain(room_parts.into_iter().flatten()) {
            let Some(kind) = part.get("type").and_then(Value::as_str).filter(|k| matches!(*k, "image" | "file" | "text")) else { continue };
            if !part.get("attachmentRef").is_some_and(truthy) || (kind == "text" && !part.get("textKind").is_some_and(truthy)) {
                continue;
            }
            add(part.get("attachmentRef"), Some(kind), [part.get("filename"), part.get("name")], [part.get("mimeType"), part.get("mediaType")]);
        }
        let records = crate::bots::delivery::rows::normalize_attachments(meta.and_then(|m| m.get("transcript")).and_then(|t| t.get("attachments")));
        for record in &records {
            add(record.get("id"), record.get("kind").and_then(Value::as_str), [record.get("name"), None], [record.get("mimeType"), None]);
        }
    }
    found
}

/// `referencePart`: a stored reference part of one attachment, as a desktop prompt carries it.
fn reference_part(kind: &str, reference: &str, mime: &str, name: &str, size: u64) -> Value {
    let mut part = Map::new();
    part.insert("type".into(), json!(kind));
    if kind == "text" {
        part.insert("textKind".into(), json!("file"));
    }
    part.insert("attachmentRef".into(), json!(reference));
    part.insert("sizeBytes".into(), json!(size));
    part.insert("mimeType".into(), json!(mime));
    part.insert("filename".into(), json!(name));
    Value::Object(part)
}

/// `resolveHandoffAttachments(refs, { messages, roots, cwd, surface })`: the prompt parts for the `attachments` of a
/// `session` or `agent` call. Each reference is an attachment the caller's conversation shows (`messages`), by its id or
/// by its file name (the newest of that name), or a file path inside the roots, which is read once and stored through
/// `store`. `stored_len` answers the size of a stored attachment (`readAttachmentBuffer(id).length`), `None` when the
/// store no longer holds it. `Err` is the text Node throws: an unknown id, a path outside the roots, a secret file, an
/// unsupported type or a limit, naming the reference.
pub fn resolve_handoff_attachments<L: IoLane>(
    lane: &InLane<L>,
    refs: &Value,
    messages: &Value,
    options: &Options,
    surface: &str,
    stored_len: &dyn Fn(&str) -> Option<u64>,
    store: &dyn Fn(&[u8]) -> Result<String, String>,
) -> Result<Handoff, String> {
    let refused = |message: String| format!("{surface}: {message}");
    if refs.is_null() {
        return Ok(Handoff::default());
    }
    let Some(given) = refs.as_array().filter(|list| list.iter().all(Value::is_string)) else {
        return Err(refused("attachments must be a list of attachment ids or file paths".to_owned()));
    };
    let mut list: Vec<&str> = Vec::new();
    for reference in given.iter().filter_map(Value::as_str).map(js_trim).filter(|r| !r.is_empty()) {
        if !list.contains(&reference) {
            list.push(reference);
        }
    }
    if list.len() > MAX_FILES {
        return Err(refused(format!("at most {MAX_FILES} attachments can be passed at once")));
    }
    let known = conversation_attachments(messages);
    let mut budget = Budget::default();
    let mut out = Handoff::default();
    for reference in list {
        // An upload the model knows only by the name its prompt showed: the newest attachment of that name.
        let by_id = is_attachment_id(reference);
        let shown = if by_id { known.iter().find(|s| s.id == reference) } else { known.iter().rev().find(|s| s.name == reference) };
        if by_id && shown.is_none() {
            return Err(refused(format!("attachment {reference} is not in this conversation")));
        }
        let (id, kind, name, mime, size) = match shown {
            Some(shown) => {
                let size = stored_len(&shown.id).ok_or_else(|| refused(format!("attachment \"{reference}\" is no longer stored")))?;
                (shown.id.clone(), shown.kind, shown.name.clone(), shown.mime.clone(), size)
            }
            None => {
                let file = read_contained(lane, reference, options).map_err(refused)?;
                let Some(typ) = file.typ else {
                    return Err(refused(format!("attachment \"{reference}\" is not an image, PDF, Office or text file")));
                };
                let Some(bytes) = file.bytes else {
                    return Err(refused(format!("attachment \"{reference}\" is larger than the attachment limit")));
                };
                if typ.kind == "image" && !SUPPORTED_IMAGE_MIME_TYPES.contains(&typ.mime) {
                    return Err(refused(format!("attachment \"{reference}\" is not a PNG, JPEG, GIF or WebP image")));
                }
                // The store's own refusal (an empty file) is thrown as it is, without the surface.
                (store(&bytes)?, typ.kind, file.name, typ.mime.to_owned(), bytes.len() as u64)
            }
        };
        if !budget.take(kind, size) {
            return Err(refused(format!("attachment \"{name}\" exceeds the attachment size limits")));
        }
        out.parts.push(reference_part(kind, &id, &mime, &name, size));
        out.records.push(json!({ "id": id, "attachmentRef": id, "kind": kind, "name": name, "mimeType": mime, "size": size }));
    }
    Ok(out)
}

/// `storeAttachmentBuffer(bytes)`: the bytes stored under their content address; the reference is
/// the digest's 64 hex digits.
pub fn store_attachment<L: WriteLane>(blobs: &BlobStore, lane: &InLane<L>, bytes: &[u8]) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("prompt attachment is empty".to_owned());
    }
    if bytes.len() > MAX_BLOB_BYTES {
        return Err("prompt attachment exceeds the 64 MiB input limit".to_owned());
    }
    let pin = blobs.put(lane, bytes).map_err(|e| e.to_string())?;
    Ok(pin.digest().as_str().trim_start_matches("sha256:").to_owned())
}

#[cfg(test)]
mod tests {
    use mixdog_rt::{CancellationToken, DurabilityIo, LaneToken};

    use super::*;

    const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/session-activity/golden.json");

    fn on_lane<R: Send + 'static>(job: impl FnOnce(&InLane<DurabilityIo>) -> R + Send + 'static) -> R {
        let lanes = mixdog_rt::testing::tokens();
        tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(async {
            lanes.durability_io.submit(&CancellationToken::new(), job).unwrap().await.unwrap()
        })
    }

    /// The recorded `<tmp>` / `<tmp/>` tokens made real, in every string of `value`.
    fn fill(value: &Value, tmp: &str) -> Value {
        match value {
            Value::String(text) => Value::String(text.replace("<tmp/>", &tmp.replace('\\', "/")).replace("<tmp>", tmp)),
            Value::Array(items) => Value::Array(items.iter().map(|v| fill(v, tmp)).collect()),
            Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), fill(v, tmp))).collect()),
            other => other.clone(),
        }
    }

    /// Separators and the tree's real root made comparable with the recording.
    fn tokenized(value: &Value, tmp: &str) -> Value {
        match value {
            Value::String(text) => Value::String(text.replace(tmp, "<tmp>").replace('\\', "/")),
            Value::Array(items) => Value::Array(items.iter().map(|v| tokenized(v, tmp)).collect()),
            Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), tokenized(v, tmp))).collect()),
            other => other.clone(),
        }
    }

    fn native(path: &str) -> PathBuf {
        Path::new(path).components().collect()
    }

    fn tree(collect: &Value) -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let root = mixdog_workspace::pathguard::canonical(dir.path()).unwrap();
        // Each entry is a directory (`None`) or a file with its bytes; written on the lane.
        let mut entries: Vec<(PathBuf, Option<Vec<u8>>)> = Vec::new();
        for file in collect["files"].as_array().unwrap() {
            let target = root.join(native(file["path"].as_str().unwrap()));
            if file.get("dir").is_some() {
                entries.push((target, None));
                continue;
            }
            let bytes = if let Some(fill) = file.get("fill") {
                vec![fill[0].as_str().unwrap().as_bytes()[0]; fill[1].as_u64().unwrap() as usize]
            } else if let Some(hex) = file.get("hex") {
                let hex = hex.as_str().unwrap();
                (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect()
            } else {
                file["text"].as_str().unwrap().as_bytes().to_vec()
            };
            entries.push((target, Some(bytes)));
        }
        on_lane(move |lane| {
            for (target, bytes) in entries {
                match bytes {
                    None => mixdog_statefile::create_private_dir_all(lane, &target).unwrap(),
                    Some(bytes) => {
                        mixdog_statefile::create_private_dir_all(lane, target.parent().unwrap()).unwrap();
                        mixdog_statefile::append_file(lane, &target, &bytes).unwrap();
                    }
                }
            }
        });
        let text = root.to_string_lossy().into_owned();
        (dir, text)
    }

    #[test]
    fn every_recorded_collection_equals_node() {
        let golden: Value = serde_json::from_str::<Value>(&GOLDEN).unwrap()["handoff"]["collect"].clone();
        let (_dir, tmp) = tree(&golden);
        let data = PathBuf::from(&tmp).join("data-dir");
        let scopes = sensitive_scopes(&[PathBuf::from(&tmp).join("home"), data.clone(), data.clone()]);
        for case in golden["cases"].as_array().unwrap() {
            let input = fill(case, &tmp);
            let options = Options {
                cwd: native(input["cwd"].as_str().unwrap()).to_string_lossy().into_owned(),
                roots: input["roots"].as_array().unwrap().iter().map(|r| resolve(Path::new(&tmp), &native(r.as_str().unwrap()).to_string_lossy())).collect(),
                scopes: scopes.clone(),
            };
            let (messages, blobs) = (input["messages"].clone(), BlobStore::new(&data));
            let got = on_lane(move |lane| collect_turn_artifacts(lane, &messages, &options, &|bytes| store_attachment(&blobs, lane, bytes)).to_json());
            assert_eq!(tokenized(&got, &tmp), tokenized(&case["result"], "\0"), "{}", case["name"]);
        }
    }

    /// `resolveHandoffAttachments` over the same tree: the parts and records of each recorded `attachments`, and each
    /// refusal in Node's words. The attachments a case's messages name are stored first, as the recorder stored them.
    #[test]
    fn every_recorded_attachment_resolution_equals_node() {
        let golden: Value = serde_json::from_str::<Value>(&GOLDEN).unwrap()["handoff"].clone();
        let (_dir, tmp) = tree(&golden["collect"]);
        let data = PathBuf::from(&tmp).join("data-dir");
        let scopes = sensitive_scopes(&[PathBuf::from(&tmp).join("home"), data.clone(), data.clone()]);
        let seeds: Vec<Vec<u8>> = golden["resolve"]["stored"].as_array().unwrap().iter().map(|text| text.as_str().unwrap().as_bytes().to_vec()).collect();
        let blobs = BlobStore::new(&data);
        on_lane(move |lane| seeds.iter().for_each(|bytes| drop(store_attachment(&blobs, lane, bytes).unwrap())));
        let cases = golden["resolve"]["cases"].as_array().unwrap();
        assert!(cases.len() > 30, "the recording holds the resolution cases");
        for case in cases {
            let input = fill(case, &tmp);
            let options = Options {
                cwd: native(input["cwd"].as_str().unwrap()).to_string_lossy().into_owned(),
                roots: input["roots"].as_array().unwrap().iter().map(|r| resolve(Path::new(&tmp), &native(r.as_str().unwrap()).to_string_lossy())).collect(),
                scopes: scopes.clone(),
            };
            let (refs, messages, surface, blobs) = (input["refs"].clone(), input["messages"].clone(), input["surface"].as_str().unwrap().to_owned(), BlobStore::new(&data));
            let got = on_lane(move |lane| {
                let stored_len = |id: &str| blobs.read(lane, &mixdog_store::schema::bounded::Digest::try_from(format!("sha256:{id}")).ok()?).ok().map(|bytes| bytes.len() as u64);
                match resolve_handoff_attachments(lane, &refs, &messages, &options, &surface, &stored_len, &|bytes| store_attachment(&blobs, lane, bytes)) {
                    Ok(found) => json!({ "parts": found.parts, "records": found.records }),
                    Err(error) => json!({ "error": error }),
                }
            });
            assert_eq!(tokenized(&got, &tmp), tokenized(&case["result"], "\0"), "{}", case["name"]);
        }
    }

    #[test]
    fn a_stored_attachment_is_readable_under_its_reference() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().to_path_buf();
        let blobs = BlobStore::new(&data);
        let reference = on_lane(move |lane| store_attachment(&blobs, lane, b"hello\n")).unwrap();
        assert_eq!(reference.len(), 64);
        let stored = data.join("prompt-attachments").join("sha256").join(&reference[..2]).join(&reference);
        assert_eq!(mixdog_statefile::read_content(&stored).unwrap().unwrap(), b"hello\n");
        let blobs = BlobStore::new(&data);
        assert!(on_lane(move |lane| store_attachment(&blobs, lane, b"")).is_err());
    }

    #[test]
    fn session_roots_are_real_distinct_non_root_folders() {
        let dir = tempfile::tempdir().unwrap();
        let real = mixdog_workspace::pathguard::canonical(dir.path()).unwrap();
        let inner = real.join("inner");
        let made = inner.clone();
        on_lane(move |lane| mixdog_statefile::create_private_dir_all(lane, &made).unwrap());
        let text = |path: &Path| path.to_string_lossy().into_owned();
        let roots = session_roots(&[
            String::new(),
            "  ".into(),
            text(&real),
            text(&real.join("inner").join("..")),
            text(&inner),
            text(&real.join("missing")),
            text(real.ancestors().last().unwrap()),
        ]);
        assert_eq!(roots, [real, inner]);
    }

    #[test]
    fn percent_escapes_decode_as_decode_uri_does() {
        assert_eq!(decode_uri("sp%20ace.txt").as_deref(), Some("sp ace.txt"));
        assert_eq!(decode_uri("a%2Fb%23c%E2%82%AC").as_deref(), Some("a%2Fb%23c\u{20ac}"));
        assert_eq!(decode_uri("%E0%A4%A.txt"), None);
        assert_eq!(decode_uri("%C0%80"), None);
    }
}
