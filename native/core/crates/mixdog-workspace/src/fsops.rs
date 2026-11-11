#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "blocking file bodies run only as lane jobs (lanes::run_fallible); the service never calls them on an async thread")]
//! Project file operations (port of `project-files.ts`): traversal-guarded
//! listing, editor read/stat, in-place compare-and-set saves with recovery
//! journals, and tree mutations. Everything here blocks; the service runs each
//! call on its lane with the path claims already held.

use std::collections::HashSet;
use std::fs;
use std::fs::File;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use base64::Engine;
use serde::Serialize;

use crate::claims::IdentityLocks;
use crate::error::Reason;
use crate::error::WsError;
use crate::error::WsResult;
use crate::ident::mtime_ms;
use crate::ident::path_id;
use crate::inplace::Opened;
use crate::nodeerr::AtPath;
use crate::nodeerr::io_error2;
use crate::inplace::open_authorized_ro;
use crate::inplace::open_authorized_rw;
use crate::inplace::read_all;
use crate::inplace::rewrite;
use crate::inplace::rewrite_or_restore;
use crate::pathguard::canonical;
use crate::pathguard::lexical;
use crate::pathguard::project_entry_path;
use crate::recovery::Identity;
use crate::recovery::PreparedFile;
use crate::recovery::RECOVERY_MAX_BYTES;
use crate::recovery::RecoveryStore;
use crate::recovery::identity_of;
use crate::recovery::recovery_err;
use crate::text;
use crate::text::Decoded;
use crate::text::Encoding;

const EDIT_MAX: u64 = 1_048_576;
const VIEW_MAX: u64 = 10_485_760;
const CONTENT_MAX_UNITS: usize = 4_194_304;
const LOCAL_FILE_MAX: u64 = 20 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DirItem {
    pub name: String,
    pub dir: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    pub content: String,
    pub mtime_ms: f64,
    pub binary: bool,
    pub too_large: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_only: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_only_reason: Option<&'static str>,
    pub encoding: &'static str,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatInfo {
    pub mtime_ms: f64,
    pub size: u64,
    pub directory: bool,
}

#[derive(Clone, Debug)]
pub struct BatchFile {
    pub rel_path: String,
    pub content: String,
    pub expected_content: String,
    /// The content held an unpaired surrogate escape on the wire, read as U+FFFD (`CallContext::lone_surrogates`).
    pub content_lone: bool,
    /// The expected content held one: it equals no lossless file text, as Node's lone unit equalled none.
    pub expected_lone: bool,
}

/// Node's `encodeProjectText` (project-files.ts:96): a save of content holding a lone surrogate is refused, the file untouched.
/// The core reads the unit as U+FFFD, so the request says whether the content held one; it is refused at the point Node encodes.
fn check_paired(content_lone: bool) -> WsResult<()> {
    if content_lone {
        return Err(WsError::invalid("File content contains unpaired Unicode surrogates."));
    }
    Ok(())
}

pub fn parse_encoding(name: &str) -> WsResult<Encoding> {
    match name {
        "utf8" => Ok(Encoding::Utf8),
        "utf8bom" => Ok(Encoding::Utf8Bom),
        "utf16le" => Ok(Encoding::Utf16Le),
        "utf16be" => Ok(Encoding::Utf16Be),
        _ => Err(WsError::invalid("File encoding is invalid.")),
    }
}

/// Node's `a.localeCompare(b)` (ICU, the process's default locale)
fn locale_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    mixdog_js::locale_compare(a, b)
}

pub fn list_dir(root: &Path, rel: &str) -> WsResult<Vec<DirItem>> {
    let target = project_entry_path(root, rel)?;
    let mut items: Vec<DirItem> = fs::read_dir(&target).at("scandir", &target)?
        .filter_map(Result::ok)
        .filter_map(|e| {
            let kind = e.file_type().ok()?;
            Some(DirItem { name: e.file_name().to_string_lossy().into_owned(), dir: kind.is_dir() })
        })
        .collect();
    items.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| locale_cmp(&a.name, &b.name)));
    Ok(items)
}

pub fn text_reply(bytes: &[u8], mtime: f64) -> TextFile {
    let decoded = text::decode(bytes);
    let read_only = !decoded.binary && (!decoded.lossless || bytes.len() as u64 > EDIT_MAX);
    TextFile {
        content: if decoded.binary { String::new() } else { decoded.content },
        mtime_ms: mtime,
        binary: decoded.binary,
        too_large: false,
        read_only: read_only.then_some(true),
        read_only_reason: (!decoded.binary && !decoded.lossless).then_some("encoding"),
        encoding: decoded.encoding.name(),
    }
}

pub fn read_text(root: &Path, rel: &str) -> WsResult<TextFile> {
    let file = project_entry_path(root, rel)?;
    let meta = fs::metadata(&file).at("stat", &file)?;
    if !meta.is_file() {
        return Err(WsError::new(Reason::NotAFile, "Not a file."));
    }
    let mtime = mtime_ms(&meta);
    if meta.len() > VIEW_MAX {
        return Ok(TextFile {
            content: String::new(),
            mtime_ms: mtime,
            binary: false,
            too_large: true,
            read_only: None,
            read_only_reason: None,
            encoding: "utf8",
        });
    }
    Ok(text_reply(&fs::read(&file).at("open", &file)?, mtime))
}

/// The paired device's read (Node's `readProjectTextFileAuthorized`): the file is opened first and the open file is checked to be a regular
/// file inside `root`; the bytes come through that handle.
pub fn read_text_authorized(root: &Path, rel: &str) -> WsResult<TextFile> {
    let file = project_entry_path(root, rel)?;
    let mut opened = open_authorized_ro(&file, root)?;
    let meta = opened.file.metadata().at("fstat", &file)?;
    let mtime = mtime_ms(&meta);
    if meta.len() > VIEW_MAX {
        return Ok(TextFile {
            content: String::new(),
            mtime_ms: mtime,
            binary: false,
            too_large: true,
            read_only: None,
            read_only_reason: None,
            encoding: "utf8",
        });
    }
    Ok(text_reply(&read_all(&mut opened.file).at("read", &file)?, mtime))
}

pub fn stat(root: &Path, rel: &str) -> WsResult<StatInfo> {
    let path = project_entry_path(root, rel)?;
    let meta = fs::metadata(&path).at("stat", &path)?;
    Ok(StatInfo { mtime_ms: mtime_ms(&meta), size: meta.len(), directory: meta.is_dir() })
}

fn check_content(content: &str, expected: &str) -> WsResult<()> {
    if content.encode_utf16().count() > CONTENT_MAX_UNITS {
        return Err(WsError::invalid("File content is invalid."));
    }
    if expected.encode_utf16().count() > CONTENT_MAX_UNITS {
        return Err(WsError::invalid("Expected file content is invalid."));
    }
    Ok(())
}

/// The current text of an open file, checked as a save's precondition: lossless
/// text equal to `expected`.
/// `expected_lone`: `expected` held an unpaired surrogate on the wire (now U+FFFD); it matches nothing, so a real U+FFFD on
/// disk is no match (Node: project-files.ts:320, the lone unit never equals decoded text).
fn expected_text(file: &mut File, expected: &str, expected_lone: bool, label: &str) -> WsResult<(Vec<u8>, Decoded)> {
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Err(WsError::new(Reason::NotAFile, "Not a file."));
    }
    if meta.len() > VIEW_MAX {
        return Err(WsError::new(Reason::Changed, format!("File changed on disk: {label}")));
    }
    let bytes = read_all(file)?;
    let decoded = text::decode(&bytes);
    if !decoded.lossless {
        return Err(WsError::new(
            Reason::InvalidEncoding,
            "File has invalid text encoding. Convert or repair it in an external editor before saving.",
        ));
    }
    if decoded.binary || expected_lone || decoded.content != expected {
        return Err(WsError::precondition(expected, &decoded.content));
    }
    Ok((bytes, decoded))
}

fn path_names_file(root: &Path, rel: &str, opened: &Opened) -> WsResult<()> {
    let still = project_entry_path(root, rel).ok().and_then(|p| path_id(&p).ok());
    if still != Some(opened.id) {
        return Err(WsError::new(Reason::Changed, "Project path changed while waiting. Retry the operation."));
    }
    Ok(())
}

pub struct ProjectFs {
    pub recovery: Arc<RecoveryStore>,
    pub identities: IdentityLocks,
}

impl ProjectFs {
    pub fn new(recovery: Arc<RecoveryStore>) -> Self {
        Self { recovery, identities: IdentityLocks::default() }
    }

    /// In-place compare-and-set save of one file. Keeps the file's identity (hard
    /// links, ACLs) and writes through a leaf symlink.
    pub fn write_text(
        &self,
        root: &Path,
        rel: &str,
        content: &str,
        expected: &str,
        encoding: Option<Encoding>,
        (content_lone, expected_lone): (bool, bool),
    ) -> WsResult<f64> {
        check_content(content, expected)?;
        let file = project_entry_path(root, rel)?;
        let mut opened = open_authorized_rw(&file, root)?;
        let _claim = self.identities.lock(vec![opened.id.key()]);
        path_names_file(root, rel, &opened)?;
        let (original, decoded) = expected_text(&mut opened.file, expected, expected_lone, rel)?;
        check_paired(content_lone)?;
        let bytes = text::encode(
            content,
            encoding.unwrap_or(decoded.encoding),
            if encoding.is_none() { decoded.has_bom } else { true },
        );
        rewrite_or_restore(&mut opened.file, &bytes, &original)?;
        Ok(mtime_ms(&opened.file.metadata()?))
    }

    /// All files or none: every file is opened, checked, journaled, then
    /// rewritten in place through its own handle; a failure puts back the bytes
    /// of every file already written.
    pub fn write_batch(&self, root: &Path, writes: &[BatchFile], journaled: bool) -> WsResult<()> {
        if writes.is_empty() || writes.len() > 100 {
            return Err(WsError::invalid("Workspace edit files are invalid."));
        }
        let normalized: Vec<(String, &BatchFile)> =
            writes.iter().map(|w| (w.rel_path.replace('\\', "/"), w)).collect();
        let lower: HashSet<String> = normalized.iter().map(|(r, _)| r.to_lowercase()).collect();
        if lower.len() != normalized.len() {
            return Err(WsError::invalid("Workspace edit contains duplicate files."));
        }
        for (_, write) in &normalized {
            check_content(&write.content, &write.expected_content)?;
        }
        let mut opened = Vec::with_capacity(normalized.len());
        for (rel, _) in &normalized {
            opened.push(open_authorized_rw(&project_entry_path(root, rel)?, root)?);
        }
        let keys: Vec<String> = opened.iter().map(|o| o.id.key()).collect();
        if keys.iter().collect::<HashSet<_>>().len() != keys.len() {
            return Err(WsError::invalid("Workspace edit contains duplicate files."));
        }
        let _claim = self.identities.lock(keys);
        struct Staged {
            rel: String,
            before: Vec<u8>,
            after: Vec<u8>,
        }
        let mut staged = Vec::new();
        for (index, (rel, write)) in normalized.iter().enumerate() {
            path_names_file(root, rel, &opened[index])?;
            let (before, decoded) = expected_text(&mut opened[index].file, &write.expected_content, write.expected_lone, rel)?;
            check_paired(write.content_lone)?;
            let after = text::encode(&write.content, decoded.encoding, decoded.has_bom);
            staged.push(Staged { rel: rel.clone(), before, after });
        }
        let mut journal = if journaled {
            Some(self.recovery.begin(root, self.prepared(root, &opened, &staged.iter().map(|s| (s.rel.clone(), s.before.clone(), s.after.clone())).collect::<Vec<_>>())?)?)
        } else {
            None
        };
        let mut written: Vec<usize> = Vec::new();
        let mut restored: HashSet<String> = HashSet::new();
        let mut failure: Option<WsError> = None;
        for (index, file) in staged.iter().enumerate() {
            // Recorded before the write: a failure part-way leaves the file modified,
            // and it is restored with the earlier ones.
            written.push(index);
            if let Err(error) = rewrite(&mut opened[index].file, &file.after) {
                failure = Some(error.into());
                break;
            }
            crate::killpoint::hit(&format!("write:{index}"));
        }
        if let Some(error) = failure.take() {
            let mut unrestored = Vec::new();
            for &index in written.iter().rev() {
                match rewrite(&mut opened[index].file, &staged[index].before) {
                    Ok(()) => {
                        restored.insert(staged[index].rel.clone());
                    }
                    Err(_) => unrestored.push(staged[index].rel.clone()),
                }
            }
            failure = Some(if unrestored.is_empty() {
                error
            } else {
                WsError::new(
                    Reason::Io,
                    format!("Workspace edit failed: {}. Not restored: {unrestored:?}.", error.message),
                )
            });
        }
        let mut bookkeeping = Vec::new();
        let mut journal_id = None;
        if let Some(journal) = journal.as_mut() {
            journal_id = Some(journal.id.clone());
            let message = failure.as_ref().map(|f| f.message.clone()).unwrap_or_default();
            bookkeeping = self.recovery.settle(journal, failure.is_some(), &message, &restored);
        }
        let tag = |mut error: WsError| {
            if let Some(id) = &journal_id {
                error.message.push_str(&format!("\n[file-recovery] {id}"));
            }
            error
        };
        if let Some(error) = failure {
            return Err(tag(error));
        }
        if let Some(error) = bookkeeping.into_iter().next() {
            return Err(tag(WsError::new(
                Reason::Io,
                format!(
                    "Files were saved, but recovery bookkeeping failed. Inspect retained recovery records before retrying. ({})",
                    error.message
                ),
            )));
        }
        Ok(())
    }

    fn prepared(&self, root: &Path, opened: &[Opened], staged: &[(String, Vec<u8>, Vec<u8>)]) -> WsResult<Vec<PreparedFile>> {
        let mut bytes = 0u64;
        let mut out = Vec::new();
        for (file, (rel, before, after)) in opened.iter().zip(staged) {
            bytes += (before.len() + after.len()) as u64;
            if bytes > RECOVERY_MAX_BYTES {
                return Err(recovery_err(
                    "RECOVERY_BATCH_LIMIT",
                    "Workspace edit exceeds the 16 MiB recovery budget. Split the edit.",
                ));
            }
            let destination = canonical(&project_entry_path(root, rel)?)?;
            if path_id(&destination)? != file.id {
                return Err(WsError::new(Reason::Changed, format!("Project path changed before saving: {rel}")));
            }
            let parent: Identity = identity_of(destination.parent().unwrap_or(&destination))?;
            #[cfg(unix)]
            let mode = {
                use std::os::unix::fs::MetadataExt;
                file.file.metadata()?.mode()
            };
            #[cfg(not(unix))]
            let mode = 0;
            out.push(PreparedFile {
                rel_path: rel.clone(),
                destination,
                parent,
                mode,
                before: before.clone(),
                after: after.clone(),
            });
        }
        Ok(out)
    }
}

// biome-parity: rejects `: * ? " < > |` and C0 controls in a name segment.
fn invalid_segment(s: &str) -> bool {
    s.chars().any(|c| ":*?\"<>|".contains(c) || (c as u32) < 0x20) || s == "." || s == ".."
}

pub fn entry_segments(name: &str) -> WsResult<Vec<String>> {
    let segments: Vec<String> =
        name.replace('\\', "/").split('/').map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()).collect();
    if segments.is_empty() || segments.iter().any(|s| invalid_segment(s)) {
        return Err(WsError::invalid("Entry name is invalid."));
    }
    Ok(segments)
}

pub fn create_entry(root: &Path, rel_dir: &str, name: &str, dir: bool) -> WsResult<()> {
    let segments = entry_segments(name)?;
    let mut rel = PathBuf::from(rel_dir);
    rel.extend(&segments);
    let target = project_entry_path(root, &rel.to_string_lossy())?;
    if dir {
        fs::create_dir_all(&target).at("mkdir", &target)?;
        return Ok(());
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).at("mkdir", parent)?;
    }
    fs::OpenOptions::new().write(true).create_new(true).open(&target).at("open", &target)?;
    Ok(())
}

fn entry_exists(path: &Path) -> WsResult<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(crate::nodeerr::io_error(&e, "lstat", path)),
    }
}

const EXISTS: &str = "An entry with that name already exists in the target folder.";

/// The relative path an operation claims besides its source.
pub fn rename_destination_rel(rel: &str, new_name: &str) -> WsResult<String> {
    let trimmed = new_name.trim();
    if trimmed.is_empty() || trimmed.chars().any(|c| "\\/:*?\"<>|".contains(c) || (c as u32) < 0x20) || trimmed == "." || trimmed == ".." {
        return Err(WsError::invalid("Entry name is invalid."));
    }
    let rel = rel.replace('\\', "/");
    let dir = rel.rsplit_once('/').map_or("", |(d, _)| d);
    Ok(if dir.is_empty() { trimmed.to_owned() } else { format!("{dir}/{trimmed}") })
}

pub fn rename_entry(root: &Path, rel: &str, new_name: &str) -> WsResult<()> {
    let destination_rel = rename_destination_rel(rel, new_name)?;
    let trimmed = new_name.trim();
    let from = project_entry_path(root, rel)?;
    if from == lexical(root) {
        return Err(WsError::invalid("Cannot rename the project root."));
    }
    let destination = project_entry_path(root, &destination_rel)?;
    fs::symlink_metadata(&from).at("lstat", &from)?;
    if from == destination {
        return Ok(());
    }
    if entry_exists(&destination)? {
        let parent = from.parent().unwrap_or(&from);
        let names: Vec<String> =
            fs::read_dir(parent).at("scandir", parent)?.filter_map(Result::ok).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        let base = from.file_name().unwrap_or_default().to_string_lossy().into_owned();
        let case_only = base.to_lowercase() == trimmed.to_lowercase()
            && names.contains(&base)
            && !names.iter().any(|n| n == trimmed);
        if !case_only {
            return Err(WsError::new(Reason::AlreadyExists, EXISTS));
        }
    }
    fs::rename(&from, &destination).map_err(|e| io_error2(&e, "rename", &from, &destination))?;
    Ok(())
}

fn target_dir(root: &Path, source: &Path, target_rel: &str, verb: &str, noun: &str) -> WsResult<PathBuf> {
    if source == lexical(root) {
        return Err(WsError::invalid(format!("Cannot {verb} the project root.")));
    }
    let dir = project_entry_path(root, target_rel)?;
    if !fs::metadata(&dir).at("stat", &dir)?.is_dir() {
        return Err(WsError::invalid(format!("{noun} target is not a folder.")));
    }
    if crate::pathguard::is_within(source, &dir) {
        return Err(WsError::invalid(format!("Cannot {verb} a folder into itself.")));
    }
    Ok(dir)
}

pub fn move_entry(root: &Path, rel: &str, target_dir_rel: &str) -> WsResult<()> {
    let source = project_entry_path(root, rel)?;
    let dir = target_dir(root, &source, target_dir_rel, "move", "Move")?;
    let destination = dir.join(source.file_name().unwrap_or_default());
    if destination == source {
        return Ok(());
    }
    if entry_exists(&destination)? {
        return Err(WsError::new(Reason::AlreadyExists, EXISTS));
    }
    fs::rename(&source, &destination).map_err(|e| io_error2(&e, "rename", &source, &destination))?;
    Ok(())
}

fn copy_tree(from: &Path, to: &Path) -> WsResult<()> {
    let meta = fs::symlink_metadata(from)?;
    if meta.file_type().is_symlink() {
        let target = fs::read_link(from)?;
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, to)?;
        #[cfg(windows)]
        {
            if fs::metadata(from).is_ok_and(|m| m.is_dir()) {
                std::os::windows::fs::symlink_dir(target, to)?;
            } else {
                std::os::windows::fs::symlink_file(target, to)?;
            }
        }
    } else if meta.is_dir() {
        fs::create_dir(to)?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            copy_tree(&entry.path(), &to.join(entry.file_name()))?;
        }
    } else {
        fs::copy(from, to)?;
    }
    Ok(())
}

pub fn copy_entry(root: &Path, rel: &str, target_dir_rel: &str) -> WsResult<String> {
    let source = project_entry_path(root, rel)?;
    let dir = target_dir(root, &source, target_dir_rel, "copy", "Copy")?;
    let source_is_dir = fs::metadata(&source).at("stat", &source)?.is_dir();
    let mut name = source.file_name().unwrap_or_default().to_string_lossy().into_owned();
    if entry_exists(&dir.join(&name))? {
        let dot = if source_is_dir { None } else { name.rfind('.') };
        let (stem, extension) = match dot {
            Some(d) if d > 0 => (name[..d].to_owned(), name[d..].to_owned()),
            _ => (name.clone(), String::new()),
        };
        let mut counter = 0;
        while entry_exists(&dir.join(&name))? {
            counter += 1;
            name = if counter == 1 { format!("{stem} copy{extension}") } else { format!("{stem} copy {counter}{extension}") };
        }
    }
    copy_tree(&source, &dir.join(&name))?;
    Ok(name)
}

pub fn mime_type(path: &Path) -> &'static str {
    // Node's `fileExtension`: the text after the last dot of the last component, none when the
    // dot ends the name (so `.png` is `png`, `a.` has no type).
    let text = path.to_string_lossy();
    let name = text.rsplit(['/', '\\']).next().unwrap_or_default();
    let extension = match name.rfind('.') {
        Some(dot) if dot + 1 < name.len() => name[dot + 1..].to_lowercase(),
        _ => String::new(),
    };
    match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" | "jfif" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "pdf" => "application/pdf",
        "json" | "jsonl" => "application/json",
        "xml" => "application/xml",
        "yaml" | "yml" => "application/yaml",
        "toml" => "application/toml",
        "csv" => "text/csv",
        "tsv" => "text/tab-separated-values",
        "md" | "mdx" => "text/markdown",
        "txt" | "log" => "text/plain",
        "js" | "jsx" | "mjs" | "cjs" => "text/javascript",
        "ts" | "tsx" => "text/typescript",
        "css" => "text/css",
        "html" | "htm" => "text/html",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "mp4" => "video/mp4",
        "m4v" => "video/x-m4v",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        _ => "application/octet-stream",
    }
}

fn display_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string_lossy().into_owned())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEntry {
    pub absolute_path: String,
    pub name: String,
    pub dir: bool,
    pub size: u64,
}

pub fn stat_local(path: &str) -> WsResult<LocalEntry> {
    let absolute = crate::pathguard::absolute_local_path(path)?;
    let meta = fs::metadata(&absolute).at("stat", &absolute)?;
    Ok(LocalEntry {
        name: display_name(&absolute),
        absolute_path: absolute.to_string_lossy().into_owned(),
        dir: meta.is_dir(),
        size: meta.len(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFile {
    pub name: String,
    pub size: u64,
    pub mime_type: &'static str,
    pub data: String,
}

pub fn read_local(path: &str) -> WsResult<LocalFile> {
    let (file, name, size) = local_file(path)?;
    Ok(LocalFile { name, size, mime_type: mime_type(&file), data: base64::engine::general_purpose::STANDARD.encode(fs::read(&file)?) })
}

/// The checks of `readLocalFileAbs` before the read (an absolute path to a file of at most 20 MB): the file, its display name and size.
pub fn local_file(path: &str) -> WsResult<(PathBuf, String, u64)> {
    let file = crate::pathguard::absolute_local_path(path)?;
    let meta = fs::metadata(&file).at("stat", &file)?;
    let name = display_name(&file);
    if !meta.is_file() {
        return Err(WsError::new(Reason::NotAFile, "Only files can be attached."));
    }
    if meta.len() > LOCAL_FILE_MAX {
        return Err(WsError::new(Reason::TooLarge, format!("{name}: files must be 20 MB or smaller.")));
    }
    Ok((file, name, meta.len()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, PathBuf, ProjectFs) {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical(dir.path()).unwrap();
        fs::write(root.join("utf8.txt"), "héllo\nworld\n").unwrap();
        fs::write(root.join("crlf.txt"), "a\r\nb\r\n").unwrap();
        fs::write(root.join("bom8.txt"), b"\xef\xbb\xbfbom\n").unwrap();
        fs::write(root.join("bin.dat"), [0u8, 1, 2, 3]).unwrap();
        fs::create_dir(root.join("dir")).unwrap();
        fs::write(root.join("dir/inner.txt"), "i").unwrap();
        let store = Arc::new(RecoveryStore::new(root.join("..").join(format!("rec-{}", uuid::Uuid::new_v4()))));
        (dir, root, ProjectFs::new(store))
    }

    /// Node's `a.localeCompare(b)` puts "a" before "B" before "c" and "é" next to "e"; a lowercase-byte sort does not.
    #[test]
    fn listing_orders_names_as_node_locale_compare_does() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical(dir.path()).unwrap();
        for name in ["c.txt", "B.txt", "a.txt", "é.txt", "e2.txt", "e10.txt"] {
            fs::write(root.join(name), "").unwrap();
        }
        let names: Vec<String> = list_dir(&root, ".").unwrap().into_iter().map(|i| i.name).collect();
        // ICU: case and accents are secondary to the letters, and "." sorts before digits, so "é.txt" precedes "e10.txt".
        assert_eq!(names, ["a.txt", "B.txt", "c.txt", "é.txt", "e10.txt", "e2.txt"]);
    }

    /// The phone shows the words of Node's failed `stat`: code, description, call, path.
    #[test]
    fn a_missing_file_fails_with_nodes_system_error_text() {
        let (_d, root, _fs) = fixture();
        let error = stat(&root, "missing.txt").unwrap_err();
        assert!(error.message.starts_with("ENOENT: no such file or directory, stat '"), "{}", error.message);
    }

    #[test]
    fn list_read_stat_match_the_recorded_cases() {
        let (_d, root, _fs) = fixture();
        let top = list_dir(&root, ".").unwrap();
        assert_eq!(top[0], DirItem { name: "dir".into(), dir: true });
        assert_eq!(top[1].name, "bin.dat");
        let bom = read_text(&root, "bom8.txt").unwrap();
        assert_eq!((bom.encoding, bom.content.as_str()), ("utf8bom", "bom\n"));
        assert!(read_text(&root, "bin.dat").unwrap().binary);
        assert_eq!(read_text(&root, "missing.txt").unwrap_err().reason, Reason::Coded("ENOENT".into()));
        assert_eq!(read_text(&root, "../escape.txt").unwrap_err().message, "Path is outside the project.");
        assert_eq!(stat(&root, "utf8.txt").unwrap().size, 13);
    }

    #[test]
    fn cas_write_keeps_identity_and_refuses_stale_content() {
        let (_d, root, fs_) = fixture();
        let before = path_id(&root.join("utf8.txt")).unwrap();
        let stale = fs_.write_text(&root, "utf8.txt", "x", "other", None, (false, false)).unwrap_err();
        assert_eq!(stale.message, "File changed on disk. Reload or keep your edits before saving.");
        fs_.write_text(&root, "utf8.txt", "rewritten\n", "héllo\nworld\n", None, (false, false)).unwrap();
        assert_eq!(fs::read_to_string(root.join("utf8.txt")).unwrap(), "rewritten\n");
        assert_eq!(path_id(&root.join("utf8.txt")).unwrap(), before);
    }

    #[test]
    fn hard_link_sees_the_in_place_write() {
        let (_d, root, fs_) = fixture();
        fs::hard_link(root.join("utf8.txt"), root.join("link.txt")).unwrap();
        fs_.write_text(&root, "utf8.txt", "new", "héllo\nworld\n", None, (false, false)).unwrap();
        assert_eq!(fs::read_to_string(root.join("link.txt")).unwrap(), "new");
    }

    /// Node refuses a save whose content holds a lone surrogate and leaves the file as it was (project-files.ts:96, recorded as
    /// native/core/fixtures/inbound-lone-surrogate `file-content-lone`, `batch-content-lone`); content holding a real U+FFFD is saved.
    #[test]
    fn a_save_of_content_that_held_a_lone_surrogate_is_refused_and_the_file_kept() {
        let (_d, root, fs_) = fixture();
        let refused = fs_.write_text(&root, "utf8.txt", "x\u{fffd}", "héllo\nworld\n", None, (true, false)).unwrap_err();
        assert_eq!(refused.message, "File content contains unpaired Unicode surrogates.");
        assert_eq!(fs::read_to_string(root.join("utf8.txt")).unwrap(), "héllo\nworld\n");
        let batch = |content_lone| {
            vec![
                BatchFile { rel_path: "utf8.txt".into(), content: "A".into(), expected_content: "héllo\nworld\n".into(), content_lone: false, expected_lone: false },
                BatchFile { rel_path: "crlf.txt".into(), content: "B\u{fffd}".into(), expected_content: "a\r\nb\r\n".into(), content_lone, expected_lone: false },
            ]
        };
        let refused = fs_.write_batch(&root, &batch(true), true).unwrap_err();
        assert_eq!(refused.message, "File content contains unpaired Unicode surrogates.");
        assert_eq!(fs::read_to_string(root.join("utf8.txt")).unwrap(), "héllo\nworld\n");
        assert_eq!(fs::read_to_string(root.join("crlf.txt")).unwrap(), "a\r\nb\r\n");
        fs_.write_batch(&root, &batch(false), true).unwrap();
        assert_eq!(fs::read_to_string(root.join("crlf.txt")).unwrap(), "B\u{fffd}");
        fs_.write_text(&root, "utf8.txt", "x\u{fffd}", "A", None, (false, false)).unwrap();
        assert_eq!(fs::read_to_string(root.join("utf8.txt")).unwrap(), "x\u{fffd}");
    }

    /// An expected content that held a lone surrogate equals no file text, a real U+FFFD on disk included: the save is refused as
    /// stale, the file untouched (Node project-files.ts:320; recorded as native/core/fixtures/inbound-lone-surrogate
    /// `expected-content-lone`).
    #[test]
    fn an_expected_content_that_held_a_lone_surrogate_matches_no_file() {
        let (_d, root, fs_) = fixture();
        fs::write(root.join("r.txt"), "a\u{fffd}b\n").unwrap();
        let stale = fs_.write_text(&root, "r.txt", "new", "a\u{fffd}b\n", None, (false, true)).unwrap_err();
        assert_eq!(stale.message, "File changed on disk. Reload or keep your edits before saving.");
        let batch = [BatchFile { rel_path: "r.txt".into(), content: "new".into(), expected_content: "a\u{fffd}b\n".into(), content_lone: false, expected_lone: true }];
        assert_eq!(fs_.write_batch(&root, &batch, true).unwrap_err().reason.code(), "preconditionFailed");
        assert_eq!(fs::read_to_string(root.join("r.txt")).unwrap(), "a\u{fffd}b\n");
    }

    #[test]
    fn tree_mutations() {
        let (_d, root, _fs) = fixture();
        create_entry(&root, "dir", "sub", true).unwrap();
        assert_eq!(create_entry(&root, "dir", "a/../b", false).unwrap_err().message, "Entry name is invalid.");
        rename_entry(&root, "dir/inner.txt", "renamed.txt").unwrap();
        move_entry(&root, "dir/renamed.txt", "dir/sub").unwrap();
        assert_eq!(copy_entry(&root, "crlf.txt", "dir").unwrap(), "crlf.txt");
        assert_eq!(copy_entry(&root, "crlf.txt", "dir").unwrap(), "crlf copy.txt");
        let names: Vec<_> = list_dir(&root, "dir").unwrap().into_iter().map(|i| i.name).collect();
        assert_eq!(names, ["sub", "crlf copy.txt", "crlf.txt"]);
    }

    #[test]
    fn batch_is_all_or_nothing_and_journal_is_retired() {
        let (_d, root, fs_) = fixture();
        let files = |second: &str| {
            vec![
                BatchFile { rel_path: "utf8.txt".into(), content: "A".into(), expected_content: "héllo\nworld\n".into(), content_lone: false, expected_lone: false },
                BatchFile { rel_path: "crlf.txt".into(), content: "B".into(), expected_content: second.into(), content_lone: false, expected_lone: false },
            ]
        };
        let bad = fs_.write_batch(&root, &files("wrong"), true).unwrap_err();
        assert_eq!(bad.reason.code(), "preconditionFailed");
        assert_eq!(fs::read_to_string(root.join("utf8.txt")).unwrap(), "héllo\nworld\n");
        fs_.write_batch(&root, &files("a\r\nb\r\n"), true).unwrap();
        assert_eq!(fs::read_to_string(root.join("crlf.txt")).unwrap(), "B");
        assert!(fs_.recovery.list(&root).unwrap().is_empty());
    }
}
