//! The per-cwd persisted prompt history (`src/tui/prompt-history-store.mjs`): the file of a cwd, its format, the append rule,
//! the write-behind backoff and the bounded in-memory view. The session service merges it with a thread's own prompts
//! (`mixdog_core_session::session::prompt_history`); the terminal interface reads it when no list was published.

use std::path::Component;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;

use mixdog_rt::DurabilityIo;
use mixdog_rt::InLane;
use mixdog_rt::InteractiveIo;
use mixdog_statefile::Invalid;
use mixdog_statefile::Opts;
use mixdog_statefile::Peek;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;

pub const PROMPT_HISTORY_LIMIT: usize = 50;

/// `WRITE_BEHIND_MS` (`prompt-history-store.mjs:92`): the window appends are coalesced in, and the
/// base of the retry delay.
pub const WRITE_BEHIND_MS: u64 = 250;
/// `FLUSH_CAP` (:93): this many queued appends flush at once.
pub const FLUSH_CAP: usize = 5;
/// `WRITE_RETRY_MAX_MS` (:97).
pub const WRITE_RETRY_MAX_MS: u64 = 30_000;

/// `writeRetryDelayMs(failures)` (`prompt-history-store.mjs:157-159`): the delay before retry number
/// `failures` (1-based) of a failing flush: doubles from the window up to the cap.
pub fn write_retry_delay(failures: u32) -> Duration {
    let doubled = 1u64.checked_shl(failures).unwrap_or(u64::MAX);
    Duration::from_millis(WRITE_RETRY_MAX_MS.min(WRITE_BEHIND_MS.saturating_mul(doubled)))
}

/// JavaScript's whitespace (`\s`, `String.prototype.trim`): Unicode `Zs` plus the line
/// terminators, tab, VT, FF and BOM. Rust's `char::is_whitespace` differs (it has U+0085 and
/// lacks U+FEFF), so keys would not match Node's.
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// `String(value).trim()`.
pub fn trim(text: &str) -> &str {
    text.trim_matches(js_space)
}

/// `promptHistoryKey`: trimmed, every whitespace run collapsed to one space.
pub fn key(text: &str) -> String {
    text.split(js_space).filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ")
}

/// `applyAppend`:the persisted list (oldest → newest) after `text` was submitted.
pub fn append_persisted(persisted: &[String], text: &str) -> Vec<String> {
    let k = key(text);
    let mut next: Vec<String> = persisted.iter().filter(|entry| key(entry) != k).cloned().collect();
    next.push(trim(text).to_owned());
    let excess = next.len().saturating_sub(PROMPT_HISTORY_LIMIT);
    next.drain(..excess);
    next
}

/// What one append did: the list as the writer sees it (also when the write failed, as today's
/// optimistic in-memory list) and whether it reached the file.
pub struct Appended {
    pub list: Vec<String>,
    pub written: bool,
}

/// The per-cwd persisted history (`src/tui/prompt-history-store.mjs`).
pub trait PromptHistoryStore: Send + Sync + 'static {
    /// `loadPromptHistory(cwd)`: oldest → newest, at most 50 (empty for an empty cwd).
    fn load(&self, lane: &InLane<InteractiveIo>, cwd: &str) -> Vec<String>;

    /// `appendPromptHistory(cwd, text)`: re-reads the file, applies [`append_persisted`],
    /// publishes it, and returns the list with whether the write landed.
    fn append(&self, lane: &InLane<DurabilityIo>, cwd: &str, text: &str) -> Appended;

    /// Every stored entry of `cwd` through `redact` (a value a session of that cwd marked sensitive leaves the file);
    /// nothing is written when no entry changes.
    fn redact(&self, lane: &InLane<DurabilityIo>, cwd: &str, redact: &dyn Fn(&str) -> String);
}

/// The files of today's store: `<data>/tui-prompt-history/<sha256(cwd key)[..32]>.json`,
/// `{"version": 1, "entries": [..]}` two-space JSON, owner-only. Appends are written through
/// at once (today coalesces them for 250 ms) under the file's lock (`mixdog-statefile`); a
/// damaged file is kept aside as `<file>.corrupt-<ms>` and its `.bak`, when one parses,
/// restored (`readJsonStateSync`) by the next append, while a load answers from that `.bak`
/// without touching the files (a read lane cannot take the lock).
pub struct FilePromptHistory {
    dir: PathBuf,
    cache: std::sync::Mutex<CwdCache>,
}

/// `PROMPT_HISTORY_CACHE_LIMIT`: how many cwds' histories stay in memory (`MIXDOG_PROMPT_HISTORY_CACHE_LIMIT`, at least 8).
const DEFAULT_CACHE_LIMIT: usize = 128;
const MIN_CACHE_LIMIT: usize = 8;

/// The per-cwd in-memory view of the persisted history (`memCache`): a read answers from it after the first, an append
/// replaces it with the list it wrote, and the least recently used cwd leaves once more than `limit` are held, so the
/// process holds a bounded number however many cwds it has worked in.
struct CwdCache {
    limit: usize,
    /// Least recently used first.
    order: std::collections::VecDeque<PathBuf>,
    lists: std::collections::HashMap<PathBuf, Vec<String>>,
}

impl CwdCache {
    fn new(limit: usize) -> Self {
        Self { limit: limit.max(MIN_CACHE_LIMIT), order: std::collections::VecDeque::new(), lists: std::collections::HashMap::new() }
    }

    /// `rememberCachedEntries`: the list becomes the most recently used one; the oldest cwds beyond the limit go.
    fn remember(&mut self, path: &Path, entries: Vec<String>) {
        self.order.retain(|held| held != path);
        self.order.push_back(path.to_path_buf());
        self.lists.insert(path.to_path_buf(), entries);
        while self.order.len() > self.limit {
            if let Some(oldest) = self.order.pop_front() {
                self.lists.remove(&oldest);
            }
        }
    }

    /// `cachedEntries` of a cwd already held: a read keeps it among the most recently used.
    fn touch(&mut self, path: &Path) -> Option<Vec<String>> {
        let entries = self.lists.get(path)?.clone();
        self.order.retain(|held| held != path);
        self.order.push_back(path.to_path_buf());
        Some(entries)
    }

    fn forget(&mut self, path: &Path) {
        self.order.retain(|held| held != path);
        self.lists.remove(path);
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

/// The entries of a parsed file; `None` when they are damaged (no `entries` list).
fn entries_of(doc: &Value) -> Option<Vec<String>> {
    let entries = doc.get("entries")?.as_array()?;
    Some(entries.iter().map(entry_text).filter(|entry| !key(entry).is_empty()).collect())
}

/// The `validate` of the history file: a document without an `entries` list is damaged.
fn has_entries(doc: &Value) -> Result<(), Invalid> {
    entries_of(doc).map(drop).ok_or_else(|| Invalid::Damaged("prompt history has no entries".to_owned()))
}

fn file_opts() -> Opts {
    Opts { secret: true, ..Opts::default() }
}

fn backup_of(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".bak");
    PathBuf::from(name)
}

/// `readEntries` for a read lane: a missing or unreadable file is empty; a damaged one answers
/// with its last good copy, and nothing is moved.
fn peek_entries(lane: &InLane<InteractiveIo>, path: &Path) -> Vec<String> {
    let of = |path: &Path| match mixdog_statefile::peek(lane, path, Some(&has_entries)) {
        Ok(Peek::Value(doc)) => entries_of(&doc),
        _ => None,
    };
    match mixdog_statefile::peek(lane, path, Some(&has_entries)) {
        Ok(Peek::Value(doc)) => entries_of(&doc).unwrap_or_default(),
        Ok(Peek::Damaged(_)) => of(&backup_of(path)).unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// `readEntries` for the writer: a damaged file is set aside under its lock and its last good
/// copy restored.
fn recover_entries(lane: &InLane<DurabilityIo>, path: &Path) -> Vec<String> {
    match mixdog_statefile::read_json(lane, path, Some(&has_entries), &file_opts()) {
        Ok(Some(doc)) => entries_of(&doc).unwrap_or_default(),
        _ => Vec::new(),
    }
}

fn last_fifty(mut entries: Vec<String>) -> Vec<String> {
    let excess = entries.len().saturating_sub(PROMPT_HISTORY_LIMIT);
    entries.drain(..excess);
    entries
}

impl PromptHistoryStore for FilePromptHistory {
    fn load(&self, lane: &InLane<InteractiveIo>, cwd: &str) -> Vec<String> {
        let Some(path) = self.file(cwd) else { return Vec::new() };
        let held = self.cache().touch(&path);
        let entries = held.unwrap_or_else(|| {
            let read = peek_entries(lane, &path);
            // An append that ran while the file was read has remembered its own list, which is newer than this read.
            let mut cache = self.cache();
            match cache.touch(&path) {
                Some(newer) => newer,
                None => {
                    cache.remember(&path, read.clone());
                    read
                }
            }
        });
        last_fifty(entries)
    }

    fn append(&self, lane: &InLane<DurabilityIo>, cwd: &str, text: &str) -> Appended {
        // Nothing to write for an empty cwd or an empty prompt (`appendPromptHistory` returns null).
        let Some(path) = self.file(cwd) else {
            return Appended { list: Vec::new(), written: true };
        };
        let before = recover_entries(lane, &path);
        if key(text).is_empty() {
            return Appended { list: last_fifty(before), written: true };
        }

        let mut appended = None;
        let written = mixdog_statefile::update_json::<_, std::convert::Infallible>(
            lane,
            &path,
            |current| {
                let entries = current.as_ref().and_then(entries_of).unwrap_or_default();
                let next = append_persisted(&entries, text);
                let doc = history_doc(&next);
                appended = Some(next);
                Ok(Some(doc))
            },
            &file_opts(),
        );
        // The list is the optimistic in-memory one also when the write failed; the caller retries.
        let list = appended.unwrap_or_else(|| append_persisted(&before, text));
        self.cache().remember(&path, list.clone());
        Appended { list, written: written.is_ok() }
    }

    fn redact(&self, lane: &InLane<DurabilityIo>, cwd: &str, redact: &dyn Fn(&str) -> String) {
        let Some(path) = self.file(cwd) else { return };
        let written = mixdog_statefile::update_json::<_, std::convert::Infallible>(
            lane,
            &path,
            |current| {
                let entries = current.as_ref().and_then(entries_of).unwrap_or_default();
                let next: Vec<String> = entries.iter().map(|entry| redact(entry)).collect();
                Ok((next != entries).then(|| history_doc(&next)))
            },
            &file_opts(),
        );
        // The next read sees the redacted file.
        self.cache().forget(&path);
        if let Err(error) = written {
            tracing::warn!("the prompt history of a cwd kept a value marked sensitive: {error}");
        }
    }
}

/// `buildPayload(entries)`: `{version: 1, entries}`, written as `JSON.stringify(.., null, 2)`.
fn history_doc(entries: &[String]) -> Value {
    json!({ "version": 1, "entries": entries })
}

impl FilePromptHistory {
    pub fn new(data_dir: &Path) -> Self {
        let limit = std::env::var("MIXDOG_PROMPT_HISTORY_CACHE_LIMIT")
            .ok()
            .and_then(|raw| raw.trim().parse::<f64>().ok())
            .filter(|n| !n.is_nan() && *n != 0.0)
            .map_or(DEFAULT_CACHE_LIMIT, |n| n.max(0.0) as usize);
        Self::with_cache_limit(data_dir, limit)
    }

    /// `new` holding at most `limit` cwds in memory (at least 8).
    pub fn with_cache_limit(data_dir: &Path, limit: usize) -> Self {
        Self { dir: data_dir.join("tui-prompt-history"), cache: std::sync::Mutex::new(CwdCache::new(limit)) }
    }

    fn cache(&self) -> std::sync::MutexGuard<'_, CwdCache> {
        self.cache.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The history file of `cwd`; none for an empty cwd.
    pub fn file(&self, cwd: &str) -> Option<PathBuf> {
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
    let absolute = if path.is_absolute() { path.to_path_buf() } else { std::env::current_dir().unwrap_or_default().join(path) };
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
    if cfg!(windows) { resolved.trim_end_matches(['\\', '/']).to_lowercase() } else { resolved.trim_end_matches('/').to_owned() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(items: &[&str]) -> Vec<String> {
        items.iter().map(|t| (*t).to_owned()).collect()
    }

    #[test]
    fn keys_use_javascript_whitespace() {
        assert_eq!(key("\u{feff} a\u{3000}\u{a0}b \u{feff}"), "a b");
        assert_eq!(key("a\u{85}b"), "a\u{85}b");
        assert_eq!(trim("\u{feff}x\u{2028}"), "x");
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

    /// `Math.max(8, Number(raw) || 128)`: an infinite value keeps every cwd, a fraction is floored by the comparison.
    #[test]
    fn an_infinite_cache_limit_keeps_every_cwd() {
        let mut cache = CwdCache::new(f64::INFINITY as usize);
        for n in 0..300 {
            cache.remember(Path::new(&format!("cwd-{n}")), s(&["x"]));
        }
        assert_eq!(cache.lists.len(), 300);
    }

    /// Reads after the first come from memory; an append replaces the held list; the least recently used cwd leaves
    /// once more than the limit are held (a limit under 8 is 8).
    #[test]
    fn the_cwd_cache_is_bounded_and_least_recently_used_first() {
        let mut cache = CwdCache::new(2);
        assert_eq!(cache.limit, 8);
        let paths: Vec<PathBuf> = (0..10).map(|n| PathBuf::from(format!("cwd-{n}"))).collect();
        for (n, path) in paths.iter().enumerate().take(8) {
            cache.remember(path, s(&[n.to_string().as_str()]));
        }
        // A read keeps cwd-0 among the recent ones, so the ninth entry pushes out cwd-1.
        assert_eq!(cache.touch(&paths[0]), Some(s(&["0"])));
        cache.remember(&paths[8], s(&["8"]));
        assert_eq!(cache.touch(&paths[1]), None);
        assert_eq!(cache.touch(&paths[0]), Some(s(&["0"])));
        assert_eq!(cache.lists.len(), 8);
        cache.remember(&paths[0], s(&["replaced"]));
        assert_eq!(cache.touch(&paths[0]), Some(s(&["replaced"])));
        cache.forget(&paths[0]);
        assert_eq!((cache.touch(&paths[0]), cache.lists.len(), cache.order.len()), (None, 7, 7));
    }

    fn recovered(path: &Path) -> Vec<String> {
        use mixdog_rt::LaneToken;
        let path = path.to_owned();
        tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(async {
            mixdog_rt::testing::tokens()
                .durability_io
                .submit(&mixdog_rt::CancellationToken::new(), move |lane| recover_entries(lane, &path))
                .unwrap()
                .await
                .unwrap()
        })
    }
    fn peeked(path: &Path) -> Vec<String> {
        use mixdog_rt::LaneToken;
        let path = path.to_owned();
        tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(async {
            mixdog_rt::testing::tokens()
                .interactive_io
                .submit(&mixdog_rt::CancellationToken::new(), move |lane| peek_entries(lane, &path))
                .unwrap()
                .await
                .unwrap()
        })
    }
    #[test]
    #[allow(clippy::disallowed_methods, reason = "test setup writes and inspects the history files")]
    fn files_keep_todays_format_and_a_damaged_one_is_set_aside() {
        let dir = tempfile::tempdir().unwrap();
        let store = FilePromptHistory::new(dir.path());
        let path = store.file("/ws/").expect("a cwd has a file");
        assert_eq!(store.file("/ws"), Some(path.clone()));
        assert_eq!(store.file("  "), None);
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(name.len(), 32 + ".json".len());

        let bytes = mixdog_statefile::json_bytes(&history_doc(&s(&["a", "b"])), &Opts::default());
        assert_eq!(String::from_utf8(bytes.clone()).unwrap(), "{\n  \"version\": 1,\n  \"entries\": [\n    \"a\",\n    \"b\"\n  ]\n}\n");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, br#"{"entries": [" x ", "", null, 0, 7, true]}"#).unwrap();
        assert_eq!(recovered(&path), s(&["x", "7", "true"]));

        std::fs::write(&path, b"{torn").unwrap();
        let bak = backup_of(&path);
        std::fs::write(&bak, &bytes).unwrap();
        // A read lane answers from the copy and moves nothing.
        assert_eq!(peeked(&path), s(&["a", "b"]));
        assert_eq!(std::fs::read(&path).unwrap(), b"{torn");
        assert_eq!(recovered(&path), s(&["a", "b"]));
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        let kept =
            std::fs::read_dir(path.parent().unwrap()).unwrap().filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().contains(".corrupt-")).count();
        assert_eq!(kept, 1);
    }
}
