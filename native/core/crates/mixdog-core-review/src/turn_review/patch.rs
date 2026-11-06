//! Replay-safe patches of a turn's own writes (Node `turn-changes.mjs`): the git-format patch of a
//! file's exact before/after bytes, its stored form, the sections of a multi-file patch and the
//! display text of a record's patch.

use std::io::Write;

use base64::Engine;
use mixdog_core_api::turn_review::ReviewContent;
use mixdog_core_api::turn_review::ReviewError;
use mixdog_js::js_trim;
use serde_json::Value;
use sha1::Digest;

use super::content::decode_text;
use super::line_diff::LineDiffBudget;
use super::line_diff::LineDiffer;
use super::nodepath;
use super::review_diff::Obj;

/// Largest single-file patch a record keeps replayable.
pub const TURN_CHANGE_FILE_PATCH_MAX_BYTES: usize = 8 * 1024 * 1024;

pub fn clean(value: &str) -> &str {
    js_trim(value)
}

/// `changePathKey`: forward slashes, folded on Windows.
pub fn change_path_key(value: &str) -> String {
    let text = clean(value).replace('\\', "/");
    if cfg!(windows) { text.to_lowercase() } else { text }
}

fn unsafe_path_character(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\r' | '"' | '\0')
}

/// A root-relative forward-slash path that a patch may name, or `None`.
pub fn safe_change_path(value: &str) -> Option<String> {
    let text = clean(value).replace('\\', "/");
    if text.is_empty() || text.starts_with('/') || nodepath::is_absolute_host(&text) {
        return None;
    }
    let mut chars = text.chars();
    if let (Some(first), Some(':')) = (chars.next(), chars.next())
        && first.is_ascii_alphabetic() {
            return None;
        }
    if text.chars().any(unsafe_path_character) {
        return None;
    }
    if text.split('/').any(|part| part.is_empty() || part == "." || part == ".." || part.to_lowercase() == ".git") {
        return None;
    }
    Some(text)
}

/// Store form of a patch: UTF-8 text when that round-trips exactly, else base64. Returns the
/// patch string and its encoding name.
pub fn encode_change_patch(bytes: &[u8]) -> (String, &'static str) {
    match std::str::from_utf8(bytes) {
        Ok(text) => (text.to_owned(), "utf8"),
        Err(_) => (base64::engine::general_purpose::STANDARD.encode(bytes), "base64"),
    }
}

/// `changePatchBuffer(file)`: the bytes of a record file's stored patch.
pub fn change_patch_buffer(file: &Obj) -> Option<Vec<u8>> {
    let patch = file.get("patch")?.as_str()?;
    if file.get("patchEncoding").and_then(Value::as_str) == Some("base64") {
        // Node's decoder skips what is not base64 instead of failing.
        let cleaned: String = patch.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '-' | '_')).collect();
        let normalized = cleaned.replace('-', "+").replace('_', "/");
        let trimmed = normalized.trim_end_matches('=');
        return Some(base64::engine::general_purpose::STANDARD_NO_PAD.decode(trimmed).unwrap_or_default());
    }
    Some(patch.as_bytes().to_vec())
}

// ── Patch sections ──────────────────────────────────────────────────────────

fn utf16(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn from_utf16(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

/// Decode one git C-quoted path (`"a/\303\244.txt"`); unquoted text passes through.
pub fn unquote_git_path(text: &str) -> String {
    let Some(rest) = text.strip_prefix('"') else { return text.to_owned() };
    let mut bytes: Vec<u8> = Vec::new();
    let chars: Vec<char> = rest.chars().collect();
    let mut index = 0usize;
    while index < chars.len() {
        let c = chars[index];
        if c == '"' {
            break;
        }
        if c != '\\' {
            let mut buf = [0u8; 4];
            bytes.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
            index += 1;
            continue;
        }
        index += 1;
        let next = chars.get(index).copied();
        if let Some(n) = next.filter(|n| ('0'..='7').contains(n)) {
            let _ = n;
            let digits: String = chars[index..(index + 3).min(chars.len())].iter().collect();
            let octal: String = digits.chars().take_while(|d| ('0'..='7').contains(d)).collect();
            bytes.push((u32::from_str_radix(&octal, 8).unwrap_or(0) & 0xff) as u8);
            index += 3;
            continue;
        }
        let byte = match next {
            Some('n') => 10,
            Some('t') => 9,
            Some('a') => 7,
            Some('b') => 8,
            Some('f') => 12,
            Some('r') => 13,
            Some('v') => 11,
            Some('\\') => 92,
            Some('"') => 34,
            Some(other) => (other as u32 & 0xff) as u8,
            None => 0,
        };
        bytes.push(byte);
        index += 1;
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// `---`/`+++` operand: the path without its `a/` or `b/` prefix, `None` for /dev/null.
fn header_name(raw: &str, prefix: &str) -> Option<String> {
    let value = raw.strip_suffix('\t').unwrap_or(raw);
    if value == "/dev/null" {
        return None;
    }
    let name = unquote_git_path(value);
    Some(name.strip_prefix(prefix).map(str::to_owned).unwrap_or(name))
}

fn js_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// The two operands of `diff --git a/X b/Y` when they can be told apart.
fn diff_git_line_paths(line: &str) -> Option<(Option<String>, Option<String>)> {
    let rest = line.strip_prefix("diff --git ")?;
    if rest.starts_with('"') {
        // /^("(?:[^"\\]|\\.)*") (.*)$/
        let chars: Vec<(usize, char)> = rest.char_indices().collect();
        let mut i = 1usize;
        loop {
            let (_, c) = *chars.get(i)?;
            if c == '"' {
                break;
            }
            if c == '\\' {
                let (_, escaped) = *chars.get(i + 1)?;
                if js_line_terminator(escaped) {
                    return None;
                }
                i += 2;
            } else {
                i += 1;
            }
        }
        let quoted_end = chars[i].0 + 1;
        let after = &rest[quoted_end..];
        let second = after.strip_prefix(' ')?;
        if second.chars().any(js_line_terminator) {
            return None;
        }
        return Some((header_name(&rest[..quoted_end], "a/"), header_name(second, "b/")));
    }
    let units = utf16(rest);
    if (units.len() as isize - 5).rem_euclid(2) != 0 || units.len() < 5 {
        return None;
    }
    let length = (units.len() - 5) / 2;
    let left = from_utf16(&units[..(length + 2).min(units.len())]);
    let right = from_utf16(&units[(length + 3).min(units.len())..]);
    if !left.starts_with("a/") || !right.starts_with("b/") || left[2..] != right[2..] {
        return None;
    }
    Some((Some(left[2..].to_owned()), Some(right[2..].to_owned())))
}

/// One `diff --git` section of a multi-file patch.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Section {
    pub old_path: Option<String>,
    pub new_path: Option<String>,
    pub start: usize,
    pub end: usize,
}

fn find(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || from > haystack.len() {
        return None;
    }
    haystack[from..].windows(needle.len()).position(|w| w == needle).map(|p| p + from)
}

/// Old/new path of one section (`None` for the /dev/null side).
fn patch_section_paths(section: &[u8]) -> (Option<String>, Option<String>) {
    let mut end = section.len();
    for marker in [&b"\n@@ "[..], &b"\nGIT binary patch"[..], &b"\nBinary files "[..]] {
        if let Some(index) = find(section, marker, 0)
            && index < end {
                end = index;
            }
    }
    let head = String::from_utf8_lossy(&section[..end.min(65_536)]).into_owned();
    let lines: Vec<&str> = head.split('\n').collect();
    // undefined (`None`) is distinct from null (`Some(None)`): only undefined falls back to the
    // `diff --git` line.
    let mut old_path: Option<Option<String>> = None;
    let mut new_path: Option<Option<String>> = None;
    let (mut created, mut deleted) = (false, false);
    let assign = |slot: &mut Option<Option<String>>, value: Option<String>| {
        if matches!(slot, None | Some(None)) {
            *slot = Some(value);
        }
    };
    for line in lines.iter().skip(1) {
        if let Some(rest) = line.strip_prefix("rename from ") {
            old_path = Some(Some(unquote_git_path(rest)));
        } else if let Some(rest) = line.strip_prefix("rename to ") {
            new_path = Some(Some(unquote_git_path(rest)));
        } else if line.starts_with("new file mode") {
            created = true;
        } else if line.starts_with("deleted file mode") {
            deleted = true;
        } else if let Some(rest) = line.strip_prefix("--- ") {
            assign(&mut old_path, header_name(rest, "a/"));
        } else if let Some(rest) = line.strip_prefix("+++ ") {
            assign(&mut new_path, header_name(rest, "b/"));
        }
    }
    if old_path.is_none() || new_path.is_none() {
        let first = lines.first().copied().unwrap_or("");
        let pair = if first.starts_with("diff --git ") { diff_git_line_paths(first) } else { None };
        if let Some((a, b)) = pair {
            assign_if_undefined(&mut old_path, a);
            assign_if_undefined(&mut new_path, b);
        }
    }
    (
        if created { None } else { old_path.flatten() },
        if deleted { None } else { new_path.flatten() },
    )
}

fn assign_if_undefined(slot: &mut Option<Option<String>>, value: Option<String>) {
    // `oldPath ??= pair[0]`: assigns when undefined or null.
    if matches!(slot, None | Some(None)) {
        *slot = Some(value);
    }
}

/// Split a multi-file git patch into its `diff --git` sections. A hunk line always starts with
/// ' ', '+', '-' or '\\' and base85 has no space, so a line starting `diff --git ` only ever
/// opens a section.
pub fn split_patch_sections(buffer: &[u8]) -> Vec<Section> {
    if buffer.is_empty() {
        return Vec::new();
    }
    let opener = b"diff --git ";
    let separator = b"\ndiff --git ";
    let mut starts: Vec<usize> = Vec::new();
    if buffer.starts_with(opener) {
        starts.push(0);
    }
    let mut from = 0usize;
    while let Some(index) = find(buffer, separator, from) {
        starts.push(index + 1);
        from = index + 1;
    }
    starts
        .iter()
        .enumerate()
        .map(|(i, start)| {
            let end = starts.get(i + 1).copied().unwrap_or(buffer.len());
            let (old_path, new_path) = patch_section_paths(&buffer[*start..end]);
            Section { old_path, new_path, start: *start, end }
        })
        .collect()
}

// ── Exact tracker patches (the session's own tool bytes) ────────────────────

const BASE85: &[u8; 85] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~";

/// One line of a git binary hunk: a length letter, then 4-byte groups as base85.
fn base85_line(chunk: &[u8]) -> String {
    let len = chunk.len();
    let mut line = String::new();
    line.push(char::from(if len <= 26 { 64 + len as u8 } else { 70 + len as u8 }));
    for group in chunk.chunks(4) {
        let mut value: u64 = 0;
        for index in 0..4 {
            value = value * 256 + u64::from(*group.get(index).unwrap_or(&0));
        }
        let mut out = [0u8; 5];
        for slot in (0..5).rev() {
            out[slot] = BASE85[(value % 85) as usize];
            value /= 85;
        }
        line.push_str(std::str::from_utf8(&out).expect("ascii"));
    }
    line
}

fn binary_literal(bytes: &[u8]) -> String {
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(bytes).expect("in-memory write");
    let deflated = encoder.finish().expect("in-memory finish");
    let mut text = format!("literal {}\n", bytes.len());
    for chunk in deflated.chunks(52) {
        text.push_str(&base85_line(chunk));
        text.push('\n');
    }
    text.push('\n');
    text
}

fn blob_id(bytes: &[u8], object_format: &str) -> String {
    let header = format!("blob {}\0", bytes.len());
    let hex = |digest: &[u8]| digest.iter().map(|b| format!("{b:02x}")).collect::<String>();
    if object_format == "sha256" {
        let mut hasher = sha2::Sha256::new();
        hasher.update(header.as_bytes());
        hasher.update(bytes);
        hex(&hasher.finalize())
    } else {
        let mut hasher = sha1::Sha1::new();
        hasher.update(header.as_bytes());
        hasher.update(bytes);
        hex(&hasher.finalize())
    }
}

/// The `index` line and `GIT binary patch` body of a byte change. Full blob ids make `git apply`
/// verify the file still holds the recorded bytes on either side before it writes, so a binary
/// file changed since is refused.
fn binary_patch_body(before: Option<&[u8]>, after: Option<&[u8]>, status: char, object_format: &str) -> String {
    let zero = "0".repeat(if object_format == "sha256" { 64 } else { 40 });
    let old_id = before.map_or_else(|| zero.clone(), |b| blob_id(b, object_format));
    let new_id = after.map_or(zero, |b| blob_id(b, object_format));
    let mode = if status == 'M' { " 100644" } else { "" };
    format!(
        "index {old_id}..{new_id}{mode}\nGIT binary patch\n{}{}",
        binary_literal(after.unwrap_or(&[])),
        binary_literal(before.unwrap_or(&[]))
    )
}

fn header_tab(path: &str) -> &'static str {
    if path.contains(' ') { "\t" } else { "" }
}

/// A record file before its stored form: its metadata in Node's key order, and the replayable
/// patch bytes when there is one.
#[derive(Clone, PartialEq, Debug, Default)]
pub struct RawFile {
    pub meta: Obj,
    pub patch: Option<Vec<u8>>,
}

fn base_meta(path: &str, old_path: Option<&str>, status: char) -> Obj {
    let mut meta = Obj::new();
    meta.insert("path".into(), Value::String(path.to_owned()));
    if let Some(old) = old_path {
        meta.insert("oldPath".into(), Value::String(old.to_owned()));
    }
    meta.insert("status".into(), Value::String(status.to_string()));
    meta.insert("additions".into(), Value::from(0));
    meta.insert("deletions".into(), Value::from(0));
    meta
}

pub struct TrackedFileInput<'a> {
    pub old_path: &'a str,
    pub new_path: &'a str,
    pub before: &'a ReviewContent,
    pub after: &'a ReviewContent,
    pub object_format: &'a str,
}

fn content_bytes(content: &ReviewContent) -> Option<&[u8]> {
    match content {
        ReviewContent::Bytes(bytes) => Some(bytes),
        _ => None,
    }
}

/// One git-format patch from exact before/after bytes (absent = a missing file). Paths are
/// root-relative. Text diffs as hunks within `budget`; binary content as a full-index binary patch
/// hashed in `object_format`. Returns the record file without its state.
pub fn tracked_change_file(differ: &LineDiffer, input: &TrackedFileInput<'_>, budget: &mut LineDiffBudget) -> RawFile {
    let TrackedFileInput { old_path, new_path, before, after, object_format } = *input;
    let status = if matches!(before, ReviewContent::Absent) {
        'A'
    } else if matches!(after, ReviewContent::Absent) {
        'D'
    } else if old_path != new_path {
        'R'
    } else {
        'M'
    };
    let path = if status == 'D' { old_path } else { new_path };
    let renamed_from = if status == 'R' { Some(old_path) } else { None };
    let mut meta = base_meta(path, renamed_from, status);
    if safe_change_path(path).is_none() || (status == 'R' && safe_change_path(old_path).is_none()) {
        meta.insert("revertable".into(), Value::Bool(false));
        meta.insert("reason".into(), Value::String("path cannot be represented in a patch".into()));
        return RawFile { meta, patch: None };
    }
    let (old_text, new_text) = (decode_text(before), decode_text(after));
    let old_name = if status == 'A' { new_path } else { old_path };
    let new_name = if status == 'D' { old_path } else { new_path };
    let (Some(old_text), Some(new_text)) = (old_text, new_text) else {
        let mut patch = format!("diff --git a/{old_name} b/{new_name}\n");
        if status == 'A' {
            patch.push_str("new file mode 100644\n");
        }
        if status == 'D' {
            patch.push_str("deleted file mode 100644\n");
        }
        if status == 'R' {
            patch.push_str(&format!("rename from {old_path}\nrename to {new_path}\n"));
        }
        // A pure rename carries the full-index body too: `git apply` then moves the file only
        // while it still holds the recorded bytes.
        patch.push_str(&binary_patch_body(content_bytes(before), content_bytes(after), status, object_format));
        meta.insert("binary".into(), Value::Bool(true));
        meta.insert("revertable".into(), Value::Bool(true));
        return RawFile { meta, patch: Some(patch.into_bytes()) };
    };
    let hunks = differ.hunks(old_text, new_text, budget, [content_bytes(before), content_bytes(after)]);
    let mut patch = format!("diff --git a/{old_name} b/{new_name}\n");
    if status == 'A' {
        patch.push_str("new file mode 100644\n");
    }
    if status == 'D' {
        patch.push_str("deleted file mode 100644\n");
    }
    if status == 'R' {
        let similarity = if hunks.hunks.is_empty() { "similarity index 100%\n" } else { "" };
        patch.push_str(&format!("{similarity}rename from {old_path}\nrename to {new_path}\n"));
    }
    let (mut additions, mut deletions) = (0u64, 0u64);
    if !hunks.hunks.is_empty() {
        let old_header = if status == 'A' { "/dev/null".to_owned() } else { format!("a/{old_name}{}", header_tab(old_name)) };
        let new_header = if status == 'D' { "/dev/null".to_owned() } else { format!("b/{new_name}{}", header_tab(new_name)) };
        patch.push_str(&format!("--- {old_header}\n+++ {new_header}\n"));
        for hunk in &hunks.hunks {
            let old_start = if hunk.old_lines == 0 { hunk.old_start - 1 } else { hunk.old_start };
            let new_start = if hunk.new_lines == 0 { hunk.new_start - 1 } else { hunk.new_start };
            patch.push_str(&format!("@@ -{old_start},{} +{new_start},{} @@\n", hunk.old_lines, hunk.new_lines));
            for line in &hunk.lines {
                if line.starts_with('+') {
                    additions += 1;
                } else if line.starts_with('-') {
                    deletions += 1;
                }
                patch.push_str(line);
                patch.push('\n');
            }
        }
    }
    meta.insert("additions".into(), Value::from(additions));
    meta.insert("deletions".into(), Value::from(deletions));
    meta.insert("revertable".into(), Value::Bool(true));
    RawFile { meta, patch: Some(patch.into_bytes()) }
}

/// Bound a frozen file's patch and convert it to its stored form (an `Obj` in Node's key order).
pub fn stored_change_file(file: RawFile) -> Obj {
    let RawFile { mut meta, patch } = file;
    let revertable_false = meta.get("revertable") == Some(&Value::Bool(false));
    match patch {
        Some(patch) if !revertable_false => {
            if patch.len() > TURN_CHANGE_FILE_PATCH_MAX_BYTES {
                meta.insert("revertable".into(), Value::Bool(false));
                meta.insert("reason".into(), Value::String("change is too large to keep for undo".into()));
                meta.insert("patchOmitted".into(), Value::Bool(true));
                meta.insert("patch".into(), Value::Null);
                return meta;
            }
            meta.insert("revertable".into(), Value::Bool(true));
            let (text, encoding) = encode_change_patch(&patch);
            meta.insert("patch".into(), Value::String(text));
            meta.insert("patchEncoding".into(), Value::String(encoding.into()));
            meta
        }
        _ => {
            meta.insert("revertable".into(), Value::Bool(false));
            let reason = meta.get("reason").and_then(Value::as_str).filter(|r| !r.is_empty()).map(str::to_owned);
            meta.insert(
                "reason".into(),
                Value::String(reason.unwrap_or_else(|| "no replayable patch was recorded".into())),
            );
            meta.insert("patch".into(), Value::Null);
            meta
        }
    }
}

// ── Reply ───────────────────────────────────────────────────────────────────

pub fn obj_str<'a>(obj: &'a Obj, key: &str) -> &'a str {
    obj.get(key).and_then(Value::as_str).unwrap_or("")
}

pub fn obj_f64(obj: &Obj, key: &str) -> f64 {
    mixdog_js::to_number_of(obj.get(key))
}

/// `Number(x) || 0` for a JSON count.
pub fn count_of(obj: &Obj, key: &str) -> Value {
    let n = obj_f64(obj, key);
    if n.is_nan() || n == 0.0 { Value::from(0) } else { mixdog_js::json_number(n) }
}

pub fn obj_true(obj: &Obj, key: &str) -> bool {
    obj.get(key) == Some(&Value::Bool(true))
}

pub fn file_state(file: &Obj) -> &'static str {
    if obj_str(file, "state") == "reverted" { "reverted" } else { "applied" }
}

/// The record file the caller named: its current path first, then a rename's old path. Absolute
/// paths are taken relative to the recorded root.
pub fn find_change_file<'a>(record: &'a Obj, value: &str) -> Option<&'a Obj> {
    let mut target = clean(value).replace('\\', "/");
    if target.is_empty() {
        return None;
    }
    let root = obj_str(record, "root");
    if nodepath::is_absolute_host(&target) && !root.is_empty() {
        target = nodepath::relative_host(root, &nodepath::resolve_host(&[&target])).replace('\\', "/");
    }
    let key = change_path_key(&target);
    let files: Vec<&Obj> = record.get("files").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_object).collect()).unwrap_or_default();
    files
        .iter()
        .find(|file| change_path_key(obj_str(file, "path")) == key)
        .or_else(|| files.iter().find(|file| !obj_str(file, "oldPath").is_empty() && change_path_key(obj_str(file, "oldPath")) == key))
        .copied()
}

/// Why a file can no longer be undone or reapplied: a state change touched the worktree but could
/// neither be recorded nor rolled back.
pub const CHANGE_STATE_UNKNOWN_REASON: &str = "its undo state could not be recorded, so the file on disk may not match this turn; check it manually";

/// The record file with its worktree state marked unknown (`unknownStateChangeFile`).
pub fn unknown_state_change_file(file: &Obj) -> Obj {
    let mut next = file.clone();
    next.insert("revertable".into(), Value::Bool(false));
    next.insert("reason".into(), Value::String(CHANGE_STATE_UNKNOWN_REASON.into()));
    next
}

/// The patch text of a record file: its stored patch, else its display-only one.
pub fn patch_of(file: &Obj) -> String {
    if let Some(buffer) = change_patch_buffer(file) {
        let text = String::from_utf8_lossy(&buffer).into_owned();
        if !text.is_empty() {
            return text;
        }
    }
    file.get("viewPatch").and_then(Value::as_str).unwrap_or("").to_owned()
}

/// A new file whose record kept neither counts nor a diff (an old outside-root edit): its numbers
/// are unknown, not zero.
pub fn is_unmeasured_file(file: &Obj) -> bool {
    obj_str(file, "status") == "A"
        && obj_str(file, "state") != "reverted"
        && !obj_true(file, "binary")
        && file.get("patchOmitted") != Some(&Value::Bool(true))
        && patch_of(file).is_empty()
        && {
            let sum = obj_f64(file, "additions");
            let sum = if sum.is_nan() { 0.0 } else { sum } + {
                let d = obj_f64(file, "deletions");
                if d.is_nan() { 0.0 } else { d }
            };
            sum == 0.0
        }
}

fn public_change_file(file: &Obj) -> Obj {
    let mut out = Obj::new();
    out.insert("path".into(), file.get("path").cloned().unwrap_or(Value::Null));
    if !obj_str(file, "oldPath").is_empty() {
        out.insert("oldPath".into(), file.get("oldPath").cloned().unwrap_or(Value::Null));
    }
    out.insert("status".into(), file.get("status").cloned().unwrap_or(Value::Null));
    out.insert("additions".into(), count_of(file, "additions"));
    out.insert("deletions".into(), count_of(file, "deletions"));
    if obj_true(file, "binary") {
        out.insert("binary".into(), Value::Bool(true));
    }
    out.insert("state".into(), Value::String(file_state(file).into()));
    let revertable = obj_true(file, "revertable");
    out.insert("revertable".into(), Value::Bool(revertable));
    if !revertable && file.get("reason").is_some_and(is_truthy) {
        out.insert("reason".into(), file.get("reason").cloned().unwrap_or(Value::Null));
    }
    // Its replay/preview patch was dropped for size (per-file ceiling or the session byte budget).
    if file.get("patchOmitted") == Some(&Value::Bool(true)) {
        out.insert("patchOmitted".into(), Value::Bool(true));
    }
    // The record kept no counts for it: a viewer may complete them.
    if is_unmeasured_file(file) {
        out.insert("unmeasured".into(), Value::Bool(true));
    }
    out
}

/// JS truthiness of a JSON value.
pub fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

fn record_files<'a>(record: Option<&'a Obj>, key: &str) -> Vec<&'a Obj> {
    record
        .and_then(|r| r.get(key))
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_object).collect())
        .unwrap_or_default()
}

/// Why a whole-turn Undo is unavailable, or `""`.
fn undo_blocker(files: &[&Obj]) -> String {
    let applied: Vec<&&Obj> = files.iter().filter(|file| obj_str(file, "state") != "reverted").collect();
    if applied.is_empty() {
        return "all changes in this turn are already undone".to_owned();
    }
    match applied.iter().find(|file| !obj_true(file, "revertable")) {
        Some(blocked) => {
            let reason = blocked.get("reason").filter(|r| is_truthy(r)).and_then(Value::as_str).unwrap_or("no replayable patch was recorded");
            format!("{} cannot be undone: {reason}", obj_str(blocked, "path"))
        }
        None => String::new(),
    }
}

/// The fixed TurnChangesReply contract.
pub fn turn_changes_reply(
    status: &str,
    checkpoint_id: &str,
    record: Option<&Obj>,
    patch: bool,
    file: Option<&str>,
) -> Result<Obj, ReviewError> {
    let files = record_files(record, "files");
    // Edits outside a Git turn's root are listed beside its files but are view-only: Undo, Reapply
    // and the blocker never see them.
    let outside = record_files(record, "outside");
    let ready = status == "ready";
    let blocker = undo_blocker(&files);
    let mut reason = String::new();
    if !files.is_empty() {
        if status == "pending" {
            reason = "the turn is still running".to_owned();
        } else if !blocker.is_empty() {
            reason = blocker.clone();
        }
    }
    let mut listed: Vec<Obj> = files.iter().map(|f| public_change_file(f)).collect();
    for entry in &outside {
        let mut copy = (*entry).clone();
        copy.insert("revertable".into(), Value::Bool(false));
        listed.push(public_change_file(&copy));
    }
    let revision = record.map_or(0.0, |r| obj_f64(r, "revision"));
    let mut reply = Obj::new();
    reply.insert("status".into(), Value::String(status.to_owned()));
    reply.insert("checkpointId".into(), Value::String(checkpoint_id.to_owned()));
    reply.insert("revision".into(), if revision.is_nan() || revision == 0.0 { Value::from(0) } else { mixdog_js::json_number(revision) });
    reply.insert("root".into(), Value::String(record.map_or("", |r| clean(obj_str(r, "root"))).to_owned()));
    reply.insert("files".into(), Value::Array(listed.into_iter().map(Value::Object).collect()));
    reply.insert("canUndo".into(), Value::Bool(ready && blocker.is_empty()));
    reply.insert(
        "canReapply".into(),
        Value::Bool(ready && files.iter().any(|entry| obj_str(entry, "state") == "reverted" && obj_true(entry, "revertable"))),
    );
    if !reason.is_empty() {
        reply.insert("reason".into(), Value::String(reason));
    }
    if patch {
        let mut selected: Vec<&Obj> = files.iter().chain(outside.iter()).copied().collect();
        if let Some(file) = file {
            let found = record.and_then(|r| find_change_file(r, file)).or_else(|| find_outside_change(&outside, file));
            if found.is_none() && !selected.is_empty() {
                return Err(ReviewError::new(format!("{file} is not part of this turn's changes")));
            }
            selected = found.into_iter().collect();
        }
        reply.insert("patch".into(), Value::String(selected.iter().map(|entry| patch_of(entry)).collect::<String>()));
    }
    Ok(reply)
}

fn find_outside_change<'a>(outside: &[&'a Obj], value: &str) -> Option<&'a Obj> {
    let key = change_path_key(value);
    outside.iter().find(|entry| change_path_key(obj_str(entry, "path")) == key).copied()
}

/// A record file's patch as a review shows it: a binary body becomes the `Binary files … differ`
/// line a diff viewer renders.
pub fn change_display_patch(file: &Obj) -> String {
    let buffer = change_patch_buffer(file).or_else(|| file.get("viewPatch").and_then(Value::as_str).map(|s| s.as_bytes().to_vec()));
    let Some(buffer) = buffer else { return String::new() };
    let mut out = String::new();
    for section in split_patch_sections(&buffer) {
        let text = String::from_utf8_lossy(&buffer[section.start..section.end]).into_owned();
        let Some(body) = text.find("\nGIT binary patch\n") else {
            out.push_str(&text);
            continue;
        };
        let head = &text[..body + 1];
        let head = strip_index_line(head);
        let old = section.old_path.as_deref().map_or("/dev/null".to_owned(), |p| format!("a/{p}"));
        let new = section.new_path.as_deref().map_or("/dev/null".to_owned(), |p| format!("b/{p}"));
        out.push_str(&format!("{head}Binary files {old} and {new} differ\n"));
    }
    out
}

/// `head.replace(/^index .*\n/m, '')`: the first `index ` line goes.
fn strip_index_line(head: &str) -> String {
    for starts in super::review_diff::line_starts(head) {
        if head[starts..].starts_with("index ") {
            let line_end = head[starts..].find(['\n', '\r', '\u{2028}', '\u{2029}']);
            if let Some(rel) = line_end
                && head[starts + rel..].starts_with('\n') {
                    return format!("{}{}", &head[..starts], &head[starts + rel + 1..]);
                }
        }
    }
    head.to_owned()
}
