//! `promptHistoryList`: the composer's Up-arrow recall, derived exactly as today's session
//! runtime derives it (`src/tui/session/prompt-history.mjs`, `src/tui/prompt-history-store.mjs`):
//!
//! - the session part: the thread's `user` rows over the whole transcript, newest first,
//!   trimmed, deduped by key (whitespace runs collapsed), at most 50 (`recomputePromptHistory`);
//! - merged with the per-cwd persisted history (oldest → newest on disk, read newest first):
//!   session entries first, then persisted ones not already present, at most 50
//!   (`buildMergedPromptHistory`);
//! - a user-submitted prompt is appended to the persisted history of the thread's cwd
//!   (drop the earlier duplicate, push, keep the newest 50: `appendPromptHistory`);
//! - a prompt handed back to the composer (abort or rewind restore) leaves the published
//!   list until the next recompute (`promptHistoryWithout`).
//!
//! The session part is maintained incrementally on every acked `user` row. A clear recomputes
//! it from the store over the remaining lineage and republishes the merge (`replaceItems`); a
//! rewind recomputes it too but publishes only the list without the restored prompt
//! (`replaceItems(.., {preserveSpill})` then `promptHistoryWithout`), as today.

use std::path::Component;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;

use mixdog_app_protocol::v2::thread::PromptHistoryChange;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InLane;
use mixdog_rt::InteractiveIo;
use mixdog_store::fsio::Access;
use mixdog_store::fsio::publish_file_with;
use serde::Serialize;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;

pub const PROMPT_HISTORY_LIMIT: usize = 50;

/// JavaScript's whitespace (`\s`, `String.prototype.trim`): Unicode `Zs` plus the line
/// terminators, tab, VT, FF and BOM. Rust's `char::is_whitespace` differs (it has U+0085 and
/// lacks U+FEFF), so keys would not match Node's.
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// `String(value).trim()`.
fn trim(text: &str) -> &str {
    text.trim_matches(js_space)
}

/// `promptHistoryKey`: trimmed, every whitespace run collapsed to one space.
pub fn key(text: &str) -> String {
    text.split(js_space)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// A newer `user` row: it moves to the front of the session part (newest first).
pub(crate) fn push_session(session: &mut Vec<String>, text: &str) {
    let k = key(text);
    session.retain(|entry| key(entry) != k);
    session.insert(0, trim(text).to_owned());
    session.truncate(PROMPT_HISTORY_LIMIT);
}

/// `buildMergedPromptHistory(session, persisted)`; `persisted` is oldest → newest.
pub(crate) fn merge(session: &[String], persisted: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for raw in session.iter().chain(persisted.iter().rev()) {
        if out.len() >= PROMPT_HISTORY_LIMIT {
            break;
        }
        let text = trim(raw);
        let k = key(text);
        if k.is_empty() || !seen.insert(k) {
            continue;
        }
        out.push(text.to_owned());
    }
    out
}

/// `promptHistoryWithout(list, text)`.
pub(crate) fn without(list: &[String], text: &str) -> Vec<String> {
    let k = key(text);
    list.iter().filter(|entry| key(entry) != k).cloned().collect()
}

/// The client's apply of `PromptHistoryChange::Added`: drop the entry with the same key, put
/// `prompt` in front, keep the first 50.
fn added(list: &[String], prompt: &str) -> Vec<String> {
    let k = key(prompt);
    let mut next = vec![prompt.to_owned()];
    next.extend(list.iter().filter(|entry| key(entry) != k).cloned());
    next.truncate(PROMPT_HISTORY_LIMIT);
    next
}

/// The `thread/promptHistory/updated` value taking `before` to `after`: `added` when the
/// client's apply of it reproduces `after` exactly, else the whole list.
pub(crate) fn change(before: &[String], after: &[String]) -> Option<PromptHistoryChange> {
    if before == after {
        return None;
    }
    Some(match after.first() {
        Some(prompt) if added(before, prompt) == after => PromptHistoryChange::Added {
            prompt: prompt.clone(),
        },
        _ => PromptHistoryChange::Replaced {
            prompts: after.to_vec(),
        },
    })
}

/// `applyAppend`:the persisted list (oldest → newest) after `text` was submitted.
pub fn append_persisted(persisted: &[String], text: &str) -> Vec<String> {
    let k = key(text);
    let mut next: Vec<String> = persisted
        .iter()
        .filter(|entry| key(entry) != k)
        .cloned()
        .collect();
    next.push(trim(text).to_owned());
    let excess = next.len().saturating_sub(PROMPT_HISTORY_LIMIT);
    next.drain(..excess);
    next
}

/// `recomputePromptHistory(items)` over the prompt texts of the `user` rows, oldest first.
pub(crate) fn recompute(rows: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for raw in rows.iter().rev() {
        if out.len() >= PROMPT_HISTORY_LIMIT {
            break;
        }
        let text = trim(raw);
        let k = key(text);
        if k.is_empty() || !seen.insert(k) {
            continue;
        }
        out.push(text.to_owned());
    }
    out
}

/// The per-cwd persisted history (`src/tui/prompt-history-store.mjs`).
pub trait PromptHistoryStore: Send + Sync + 'static {
    /// `loadPromptHistory(cwd)`: oldest → newest, at most 50 (empty for an empty cwd).
    fn load(&self, lane: &InLane<InteractiveIo>, cwd: &str) -> Vec<String>;

    /// `appendPromptHistory(cwd, text)`: re-reads the file, applies [`append_persisted`],
    /// publishes it, and returns the list (also when the write failed, as today's optimistic
    /// in-memory list).
    fn append(&self, lane: &InLane<DurabilityIo>, cwd: &str, text: &str) -> Vec<String>;
}

/// The files of today's store: `<data>/tui-prompt-history/<sha256(cwd key)[..32]>.json`,
/// `{"version": 1, "entries": [..]}` two-space JSON, owner-only. Appends are written through
/// at once (today coalesces them for 250 ms); a damaged file is kept aside as
/// `<file>.corrupt-<ms>` and its `.bak`, when one parses, restored (`readJsonStateSync`).
pub struct FilePromptHistory {
    dir: PathBuf,
    /// Read-modify-write of one file at a time (one owner process per data dir).
    writes: Mutex<()>,
}

#[derive(Serialize)]
struct HistoryDoc<'a> {
    version: u32,
    entries: &'a [String],
}

impl FilePromptHistory {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            dir: data_dir.join("tui-prompt-history"),
            writes: Mutex::new(()),
        }
    }

    pub(crate) fn file(&self, cwd: &str) -> Option<PathBuf> {
        let key = cwd_key(cwd);
        if key.is_empty() {
            return None;
        }
        let digest = Sha256::digest(key.as_bytes());
        let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        Some(self.dir.join(format!("{}.json", &hex[..32])))
    }
}

/// `promptHistoryCwdKey`: trimmed, `path.resolve`d, trailing separators dropped; lowercased
/// on Windows.
fn cwd_key(raw: &str) -> String {
    let text = trim(raw);
    if text.is_empty() {
        return String::new();
    }
    let path = Path::new(text);
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    let mut out = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    let resolved = out.to_string_lossy().into_owned();
    if cfg!(windows) {
        resolved.trim_end_matches(['\\', '/']).to_lowercase()
    } else {
        resolved.trim_end_matches('/').to_owned()
    }
}

/// `String(entry || '').trim()` of one stored entry.
fn entry_text(value: &Value) -> String {
    let text = match value {
        Value::String(text) => text.clone(),
        Value::Null | Value::Bool(false) => String::new(),
        Value::Bool(true) => "true".to_owned(),
        Value::Number(number) if number.as_f64() == Some(0.0) => String::new(),
        Value::Number(number) => number.to_string(),
        Value::Array(_) | Value::Object(_) => "[object Object]".to_owned(),
    };
    trim(&text).to_owned()
}

/// The entries of a file's bytes; `None` when they are damaged.
fn parse_entries(bytes: &[u8]) -> Option<Vec<String>> {
    let text = std::str::from_utf8(bytes).ok()?;
    let doc: Value = serde_json::from_str(text.strip_prefix('\u{feff}').unwrap_or(text)).ok()?;
    let entries = doc.get("entries")?.as_array()?;
    Some(
        entries
            .iter()
            .map(entry_text)
            .filter(|entry| !key(entry).is_empty())
            .collect(),
    )
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// `readEntries`: a missing or unreadable file is empty; a damaged one is set aside and its
/// last good copy restored.
fn read_entries(path: &Path) -> Vec<String> {
    let Ok(bytes) = std::fs::read(path) else {
        return Vec::new();
    };
    if let Some(entries) = parse_entries(&bytes) {
        return entries;
    }
    let mut name = path.as_os_str().to_owned();
    let mut stamp = now_ms();
    let aside = loop {
        let mut candidate = name.clone();
        candidate.push(format!(".corrupt-{stamp}"));
        if !Path::new(&candidate).exists() {
            break PathBuf::from(candidate);
        }
        stamp += 1;
    };
    if std::fs::rename(path, &aside).is_err() {
        return Vec::new();
    }
    name.push(".bak");
    let Some((backup, entries)) = std::fs::read(&name)
        .ok()
        .and_then(|bytes| parse_entries(&bytes).map(|entries| (bytes, entries)))
    else {
        return Vec::new();
    };
    let _ = publish_file_with(path, &backup, Access::OwnerOnly);
    entries
}

fn last_fifty(mut entries: Vec<String>) -> Vec<String> {
    let excess = entries.len().saturating_sub(PROMPT_HISTORY_LIMIT);
    entries.drain(..excess);
    entries
}

impl PromptHistoryStore for FilePromptHistory {
    fn load(&self, _lane: &InLane<InteractiveIo>, cwd: &str) -> Vec<String> {
        self.file(cwd).map(|path| last_fifty(read_entries(&path))).unwrap_or_default()
    }

    fn append(&self, _lane: &InLane<DurabilityIo>, cwd: &str, text: &str) -> Vec<String> {
        let Some(path) = self.file(cwd) else {
            return Vec::new();
        };
        if key(text).is_empty() {
            return last_fifty(read_entries(&path));
        }
        let _guard = self.writes.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let next = append_persisted(&read_entries(&path), text);
        let _ = publish_file_with(&path, &file_bytes(&next), Access::OwnerOnly);
        next
    }
}

/// `buildPayload(entries)`: `JSON.stringify({version: 1, entries}, null, 2) + "\n"`.
fn file_bytes(entries: &[String]) -> Vec<u8> {
    let mut bytes = serde_json::to_vec_pretty(&HistoryDoc {
        version: 1,
        entries,
    })
    .expect("strings serialize");
    bytes.push(b'\n');
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(items: &[&str]) -> Vec<String> {
        items.iter().map(|t| (*t).to_owned()).collect()
    }

    #[test]
    fn session_part_is_newest_first_deduped_by_collapsed_key_and_capped() {
        let mut session = Vec::new();
        for text in ["one", "two", " one ", "two\n  more"] {
            push_session(&mut session, text);
        }
        assert_eq!(session, s(&["two\n  more", "one", "two"]));
        for n in 0..60 {
            push_session(&mut session, &format!("p{n}"));
        }
        assert_eq!(session.len(), PROMPT_HISTORY_LIMIT);
        assert_eq!(session[0], "p59");
    }

    #[test]
    fn merge_puts_session_first_then_persisted_newest_first_without_duplicates() {
        let merged = merge(&s(&["b", "a"]), &s(&["x", "a", "y"]));
        assert_eq!(merged, s(&["b", "a", "y", "x"]));
        assert_eq!(without(&merged, " a "), s(&["b", "y", "x"]));
    }

    #[test]
    fn files_keep_todays_format_and_a_damaged_one_is_set_aside() {
        let dir = tempfile::tempdir().unwrap();
        let store = FilePromptHistory::new(dir.path());
        let path = store.file("/ws/").expect("a cwd has a file");
        assert_eq!(store.file("/ws"), Some(path.clone()));
        assert_eq!(store.file("  "), None);
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(name.len(), 32 + ".json".len());

        let bytes = file_bytes(&s(&["a", "b"]));
        assert_eq!(
            String::from_utf8(bytes.clone()).unwrap(),
            "{\n  \"version\": 1,\n  \"entries\": [\n    \"a\",\n    \"b\"\n  ]\n}\n"
        );
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, br#"{"entries": [" x ", "", null, 0, 7, true]}"#).unwrap();
        assert_eq!(read_entries(&path), s(&["x", "7", "true"]));

        std::fs::write(&path, b"{torn").unwrap();
        let mut bak = path.as_os_str().to_owned();
        bak.push(".bak");
        std::fs::write(&bak, &bytes).unwrap();
        assert_eq!(read_entries(&path), s(&["a", "b"]));
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        let kept = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().contains(".corrupt-"))
            .count();
        assert_eq!(kept, 1);
    }

    #[test]
    fn recompute_scans_newest_first() {
        assert_eq!(recompute(&s(&["a", "b", " a", ""])), s(&["a", "b"]));
    }

    #[test]
    fn keys_use_javascript_whitespace() {
        assert_eq!(key("\u{feff} a\u{3000}\u{a0}b \u{feff}"), "a b");
        assert_eq!(key("a\u{85}b"), "a\u{85}b");
        assert_eq!(trim("\u{feff}x\u{2028}"), "x");
    }

    #[test]
    fn updates_are_added_when_the_client_rule_reproduces_the_list() {
        assert_eq!(change(&s(&["a"]), &s(&["a"])), None);
        assert_eq!(
            change(&s(&["a", "b"]), &s(&["b", "a"])),
            Some(PromptHistoryChange::Added { prompt: "b".into() })
        );
        assert_eq!(
            change(&s(&["a", "b"]), &s(&["a"])),
            Some(PromptHistoryChange::Replaced { prompts: s(&["a"]) })
        );
    }

    #[test]
    fn persisted_append_moves_a_duplicate_to_the_end_and_keeps_fifty() {
        assert_eq!(append_persisted(&s(&["a", "b"]), " a"), s(&["b", "a"]));
        let full: Vec<String> = (0..50).map(|n| format!("p{n}")).collect();
        let next = append_persisted(&full, "new");
        assert_eq!(next.len(), 50);
        assert_eq!(next[0], "p1");
        assert_eq!(next[49], "new");
    }
}
