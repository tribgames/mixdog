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
use std::time::Duration;

use mixdog_app_protocol::v2::thread::PromptHistoryChange;
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

/// What the next step of an [`AppendQueue`] is.
#[derive(Debug, PartialEq, Eq)]
pub enum Next {
    Idle,
    /// Append these now, oldest first.
    Flush(Vec<String>),
    /// Wake with `due(epoch)` after `delay`; any later wait replaces this one.
    Wait { epoch: u64, delay: Duration },
}

/// The appends not yet on disk of one thread (`pendingAppends`, `pendingTimers`, `writeFailures`,
/// `prompt-history-store.mjs:94-98, 161-197, 255-271`). An append arms the write-behind timer at
/// [`WRITE_BEHIND_MS`], replacing whatever wait was armed (a backoff included), and
/// [`FLUSH_CAP`] queued appends flush at once. A flush that did not land puts its appends back ahead
/// of newer ones and arms the timer at [`write_retry_delay`] of the failures in a row, for ever;
/// a landed one resets the count. One flush runs at a time here (Node lets them overlap).
#[derive(Debug, Default)]
pub struct AppendQueue {
    pending: Vec<String>,
    failures: u32,
    in_flight: bool,
    /// The wait whose `due` still counts.
    timer: Option<u64>,
    /// A flush came due while one was running: it goes when that one ends.
    flush_after: bool,
    epoch: u64,
}

impl AppendQueue {
    fn begin(&mut self) -> Vec<String> {
        self.in_flight = true;
        self.timer = None;
        self.flush_after = false;
        std::mem::take(&mut self.pending)
    }

    fn arm(&mut self, delay: Duration) -> Next {
        self.epoch += 1;
        self.timer = Some(self.epoch);
        Next::Wait { epoch: self.epoch, delay }
    }

    /// A prompt to append.
    pub fn push(&mut self, text: String) -> Next {
        self.pending.push(text);
        if self.pending.len() >= FLUSH_CAP {
            if self.in_flight {
                self.timer = None;
                self.flush_after = true;
                return Next::Idle;
            }
            return Next::Flush(self.begin());
        }
        self.arm(Duration::from_millis(WRITE_BEHIND_MS))
    }

    /// The flush ended; `unwritten` is what did not land (oldest first).
    pub fn flushed(&mut self, unwritten: Vec<String>) -> Next {
        self.in_flight = false;
        if unwritten.is_empty() {
            self.failures = 0;
            return if self.flush_after && !self.pending.is_empty() { Next::Flush(self.begin()) } else { Next::Idle };
        }
        self.failures += 1;
        let newer = std::mem::take(&mut self.pending);
        self.pending = unwritten;
        self.pending.extend(newer);
        self.flush_after = false;
        self.arm(write_retry_delay(self.failures))
    }

    /// The wait `epoch` ended; `Some(batch)` when it is still the current one and nothing runs.
    pub fn due(&mut self, epoch: u64) -> Option<Vec<String>> {
        if self.timer != Some(epoch) {
            return None;
        }
        self.timer = None;
        if self.in_flight {
            self.flush_after = true;
            return None;
        }
        (!self.pending.is_empty()).then(|| self.begin())
    }
}

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
}

/// The files of today's store: `<data>/tui-prompt-history/<sha256(cwd key)[..32]>.json`,
/// `{"version": 1, "entries": [..]}` two-space JSON, owner-only. Appends are written through
/// at once (today coalesces them for 250 ms) under the file's lock (`mixdog-statefile`); a
/// damaged file is kept aside as `<file>.corrupt-<ms>` and its `.bak`, when one parses,
/// restored (`readJsonStateSync`) by the next append, while a load answers from that `.bak`
/// without touching the files (a read lane cannot take the lock).
pub struct FilePromptHistory {
    dir: PathBuf,
}

impl FilePromptHistory {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            dir: data_dir.join("tui-prompt-history"),
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

/// The entries of a parsed file; `None` when they are damaged (no `entries` list).
fn entries_of(doc: &Value) -> Option<Vec<String>> {
    let entries = doc.get("entries")?.as_array()?;
    Some(
        entries
            .iter()
            .map(entry_text)
            .filter(|entry| !key(entry).is_empty())
            .collect(),
    )
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
        self.file(cwd).map(|path| last_fifty(peek_entries(lane, &path))).unwrap_or_default()
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
        Appended { list: appended.unwrap_or_else(|| append_persisted(&before, text)), written: written.is_ok() }
    }
}

/// `buildPayload(entries)`: `{version: 1, entries}`, written as `JSON.stringify(.., null, 2)`.
fn history_doc(entries: &[String]) -> Value {
    json!({ "version": 1, "entries": entries })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(items: &[&str]) -> Vec<String> {
        items.iter().map(|t| (*t).to_owned()).collect()
    }

    fn recovered(path: &Path) -> Vec<String> {
        use mixdog_rt::LaneToken;
        let path = path.to_owned();
        tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(async {
            mixdog_rt::testing::tokens()
                .durability_io
                .submit(&tokio_util::sync::CancellationToken::new(), move |lane| recover_entries(lane, &path))
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
                .submit(&tokio_util::sync::CancellationToken::new(), move |lane| peek_entries(lane, &path))
                .unwrap()
                .await
                .unwrap()
        })
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
        assert_eq!(
            String::from_utf8(bytes.clone()).unwrap(),
            "{\n  \"version\": 1,\n  \"entries\": [\n    \"a\",\n    \"b\"\n  ]\n}\n"
        );
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
        let kept = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().contains(".corrupt-"))
            .count();
        assert_eq!(kept, 1);
    }

    fn golden() -> Value {
        serde_json::from_str(include_str!("../../../../fixtures/prompt-history-retry/golden.json")).expect("golden.json")
    }

    fn wait(next: Next) -> (u64, u64) {
        match next {
            Next::Wait { epoch, delay } => (epoch, delay.as_millis() as u64),
            other => panic!("a wait was expected, got {other:?}"),
        }
    }

    /// Recorded from Node's own `writeRetryDelayMs` (`record-prompt-history-retry.mjs`).
    #[test]
    fn the_retry_delay_is_nodes() {
        for (failures, ms) in golden()["retryDelaysMs"].as_object().unwrap() {
            assert_eq!(write_retry_delay(failures.parse().unwrap()), Duration::from_millis(ms.as_u64().unwrap()), "failures {failures}");
        }
        assert_eq!(write_retry_delay(u32::MAX), Duration::from_millis(WRITE_RETRY_MAX_MS));
        assert_eq!(golden()["windowMs"].as_u64().unwrap(), WRITE_BEHIND_MS);
    }

    /// Node's real `appendPromptHistory` with an unwritable directory, under a fake clock: when its
    /// flush attempts come.
    #[test]
    fn a_failed_flush_waits_as_nodes_does() {
        let golden = golden();
        let recorded: Vec<u64> = golden["scenarioA"]["gapsMs"].as_array().unwrap().iter().map(|g| g.as_u64().unwrap()).collect();
        let mut queue = AppendQueue::default();
        let (mut epoch, first) = wait(queue.push("first".into()));
        assert_eq!(first, golden["scenarioA"]["firstAttemptAtMs"].as_u64().unwrap(), "the first flush waits the window");
        let mut waits = Vec::new();
        for _ in &recorded {
            let batch = queue.due(epoch).expect("the wait ends in a flush");
            assert_eq!(batch, s(&["first"]), "the same append is retried");
            let (next, delay) = wait(queue.flushed(batch));
            epoch = next;
            waits.push(delay);
        }
        assert_eq!(waits, recorded);
        let batch = queue.due(epoch).unwrap();
        assert_eq!(queue.flushed(Vec::new()), Next::Idle, "a landed flush ends it");
        assert_eq!(batch, s(&["first"]));
        assert_eq!(wait(queue.push("again".into())).1, WRITE_BEHIND_MS);
        let batch = queue.due(7 + 1).expect("a new append waits the window again");
        assert_eq!(wait(queue.flushed(batch)).1, write_retry_delay(1).as_millis() as u64, "and the failure count starts over");
    }

    /// An append during a backoff wait re-arms the window (Node `scheduleWriteBehind`, :269): the next
    /// attempt came 350 ms after the second one against a 1000 ms backoff.
    #[test]
    fn an_append_during_a_backoff_wait_re_arms_the_window_as_nodes_does() {
        let golden = golden()["scenarioB"].clone();
        let mut queue = AppendQueue::default();
        let (epoch, _) = wait(queue.push("first".into()));
        let batch = queue.due(epoch).unwrap();
        let (epoch, delay) = wait(queue.flushed(batch));
        let batch = queue.due(epoch).unwrap();
        let (backoff_epoch, backoff) = wait(queue.flushed(batch));
        assert_eq!(WRITE_BEHIND_MS + delay, golden["secondAttemptAtMs"].as_u64().unwrap(), "the second attempt: the window, then the first backoff");
        assert_eq!(backoff, golden["backoffWouldHaveBeenMs"].as_u64().unwrap());
        // 100 ms into the wait a second prompt arrives.
        let (window_epoch, window) = wait(queue.push("second".into()));
        assert_eq!(golden["arrivedAfterSecondAttemptMs"].as_u64().unwrap() + window, golden["thirdAttemptAfterSecondAttemptMs"].as_u64().unwrap());
        assert_eq!(queue.due(backoff_epoch), None, "the backoff wait it replaced wakes nothing");
        assert_eq!(queue.due(window_epoch), Some(s(&["first", "second"])), "the retry goes with the new prompt, oldest first");
    }

    /// `FLUSH_CAP` appends flush at once, fewer at the window (the recording of 4 and of 5).
    #[test]
    fn the_cap_flushes_at_once_and_fewer_wait_the_window() {
        let recorded = golden()["scenarioC"].clone();
        for run in recorded.as_array().unwrap() {
            let count = run["appends"].as_u64().unwrap() as usize;
            let mut queue = AppendQueue::default();
            let mut last = Next::Idle;
            for n in 0..count {
                last = queue.push(format!("p{n}"));
            }
            match (run["firstAttemptAtMs"].as_u64().unwrap(), last) {
                (0, Next::Flush(batch)) => assert_eq!(batch.len(), count),
                (ms, Next::Wait { delay, .. }) => assert_eq!(delay.as_millis() as u64, ms),
                (ms, other) => panic!("{count} appends flushed at {ms} ms in Node, got {other:?}"),
            }
        }
    }

    struct Flaky {
        fail: std::sync::atomic::AtomicU32,
        stamps: std::sync::Mutex<Vec<tokio::time::Instant>>,
        landed: std::sync::Mutex<Vec<String>>,
        /// Woken after every attempted write, landed or not.
        attempted: tokio::sync::Notify,
    }

    impl PromptHistoryStore for Flaky {
        fn load(&self, _: &InLane<InteractiveIo>, _: &str) -> Vec<String> {
            Vec::new()
        }
        fn append(&self, _: &InLane<DurabilityIo>, _: &str, text: &str) -> Appended {
            use std::sync::atomic::Ordering::SeqCst;
            self.stamps.lock().unwrap().push(tokio::time::Instant::now());
            let failing = self.fail.try_update(SeqCst, SeqCst, |n| n.checked_sub(1)).is_ok();
            if !failing {
                self.landed.lock().unwrap().push(text.to_owned());
            }
            self.attempted.notify_waiters();
            Appended { list: s(&[text]), written: !failing }
        }
    }

    /// A prompt whose write failed is not lost: the thread flushes it after the window and retries on
    /// Node's backoff. The clock is paused and held, so it moves only by the advances below: each follows the actor's arming of the
    /// timer it brings to its end, and is followed by the write it brings.
    #[tokio::test(start_paused = true)]
    async fn a_prompt_whose_write_failed_is_retried_on_nodes_backoff_until_it_lands() {
        use std::sync::atomic::Ordering::SeqCst;

        use crate::eventually_on;
        use crate::session::SessionDirectory;
        use crate::session::testing::{HeldClock, Rig};
        use crate::session::tests::{start_thread, turn};

        let _held = HeldClock::hold();
        let rig = Rig::new();
        let flaky = std::sync::Arc::new(Flaky { fail: 2.into(), stamps: Default::default(), landed: Default::default(), attempted: Default::default() });
        let mut deps = rig.deps_parts(rig.store.clone());
        deps.prompts = flaky.clone();
        let directory = SessionDirectory::new(std::sync::Arc::new(deps));
        let handle = start_thread(&directory).await;
        let asked = tokio::time::Instant::now();
        turn(&handle, "remember me", "op-1").await;
        for (armed, wait) in [(1, Duration::from_millis(WRITE_BEHIND_MS)), (2, write_retry_delay(1)), (3, write_retry_delay(2))] {
            eventually_on!(&[&handle.cell.stepped], || (handle.cell.prompt_timers.load(SeqCst) == armed).then_some(())).await;
            assert_eq!(flaky.stamps.lock().unwrap().len(), armed as usize - 1, "no write before its timer has ended");
            tokio::time::advance(wait).await;
            eventually_on!(&[&flaky.attempted], || (flaky.stamps.lock().unwrap().len() == armed as usize).then_some(())).await;
        }
        let stamps = flaky.stamps.lock().unwrap().clone();
        assert_eq!(stamps.len(), 3);
        assert_eq!(stamps[0] - asked, Duration::from_millis(WRITE_BEHIND_MS), "the first flush waits the window");
        assert_eq!(stamps[1] - stamps[0], write_retry_delay(1));
        assert_eq!(stamps[2] - stamps[1], write_retry_delay(2));
        assert_eq!(*flaky.landed.lock().unwrap(), s(&["remember me"]));
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
