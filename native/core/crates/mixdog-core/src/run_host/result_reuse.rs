//! `ResultReuse`: one freshness authority for a session's cached read-only tool results
//! (`session/cache/tool-result-reuse.mjs`, `read-cache.mjs`, `scoped-cache.mjs`, and the
//! invalidation in `tool-batch/record-outcome.mjs`).
//!
//! `read` results require unchanged bytes within the hash budget;
//! scoped results require uninterrupted watcher coverage as well as a bounded TTL.
//! Keys use the executor's inputs; the cache does not interpret grep aliases.
//! Code graph requests use their own graph cache instead of caching the tool answer.

use mixdog_core_run::run_host::guards::{is_git_mutation, is_shell_tool, strip_mcp};
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use mixdog_agent::env::Clock;
use mixdog_agent::env::Reused;
use mixdog_agent::env::{ResultReuse, ReuseKind, ReuseWrite};
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_core_api::domain::tool::ToolIo;
use mixdog_core_api::domain::tool::ToolOutput;
use mixdog_js::device_paths;
use mixdog_js::utf16_len;
use mixdog_protocol::JsonValue;
use mixdog_rt::{CancellationToken, InLane, InteractiveIo, LaneToken};
use mixdog_tools::fs::ReadState;
use mixdog_workspace::pathguard;

const MAX_PER_SESSION: usize = 100;
const TEXT_CACHE_MAX_BYTES: usize = 8 * 1024 * 1024;
const SCOPED_TTL_MS: i64 = 30_000;
/// The bounded validator certifies a whole file only within this budget.
const READ_PREFIX_HASH_BYTES: u64 = 65_536;
const CURSOR_NATIVE_PREFIX: &str = "cursor_native_";

// ---- paths ----

fn is_abs(path: &str) -> bool {
    if cfg!(windows) {
        let b = path.as_bytes();
        path.starts_with(['/', '\\']) || (b.len() >= 3 && b[1] == b':' && b[0].is_ascii_alphabetic() && (b[2] == b'/' || b[2] == b'\\'))
    } else {
        path.starts_with('/')
    }
}

/// `path.normalize`, lexically: separators folded to `/`, `.` and empty parts dropped, `..`
/// resolved (a rooted path cannot climb above its root).
fn normalize(path: &str) -> String {
    let text: String = if cfg!(windows) { path.replace('\\', "/") } else { path.to_owned() };
    let (root, rest) = {
        let b = text.as_bytes();
        if cfg!(windows) && b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
            let after = &text[2..];
            if after.starts_with('/') { (format!("{}/", &text[..2]), &text[3..]) } else { (text[..2].to_owned(), after) }
        } else if cfg!(windows) && text.starts_with("//") {
            ("//".to_owned(), &text[2..])
        } else if let Some(rest) = text.strip_prefix('/') {
            ("/".to_owned(), rest)
        } else {
            (String::new(), text.as_str())
        }
    };
    let mut parts: Vec<&str> = Vec::new();
    for part in rest.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|p| *p != "..") {
                    parts.pop();
                } else if root.is_empty() {
                    parts.push("..");
                }
            }
            other => parts.push(other),
        }
    }
    let body = parts.join("/");
    if root.is_empty() && body.is_empty() { ".".to_owned() } else { format!("{root}{body}") }
}

// ---- stat tuples ----

/// What a file was when looked at: the metadata, and the hash of its bytes when it fits the budget. The bytes are the
/// only proof of sameness: a same-size rewrite inside the clock's granularity, a write by another process and a file
/// replaced by rename all leave the metadata as it was or change it unseen.
#[derive(Clone, PartialEq, Debug)]
struct Stat {
    size: u64,
    times: [u128; 2],
    ino: u64,
    dev: u64,
    digest: Option<String>,
}

fn cacheable(stat: &Option<Stat>) -> bool {
    stat.as_ref().is_some_and(|s| s.size <= READ_PREFIX_HASH_BYTES && s.digest.is_some())
}

// ---- bounded text cache ----

struct Entry<T> {
    key: String,
    content: String,
    ts: i64,
    first: Option<String>,
    meta: T,
}

/// Insertion-ordered map bounded in entries and retained UTF-16 bytes; a hit moves to the back.
struct Bounded<T> {
    entries: Vec<Entry<T>>,
}

impl<T> Bounded<T> {
    fn new() -> Self {
        Self { entries: Vec::new() }
    }

    fn position(&self, key: &str) -> Option<usize> {
        self.entries.iter().position(|e| e.key == key)
    }

    fn remove(&mut self, key: &str) -> Option<Entry<T>> {
        self.position(key).map(|i| self.entries.remove(i))
    }

    fn bytes(e: &Entry<T>) -> usize {
        (utf16_len(&e.key) + utf16_len(&e.content)) * 2
    }

    /// `setBoundedTextCacheEntry`: false when the entry alone exceeds the byte budget.
    fn set(&mut self, entry: Entry<T>) -> bool {
        self.set_within(entry, MAX_PER_SESSION, TEXT_CACHE_MAX_BYTES).0
    }

    /// The bounded put, with the keys it dropped in drop order (`onEvict`'s calls): the replaced key first.
    fn set_within(&mut self, entry: Entry<T>, max_entries: usize, max_bytes: usize) -> (bool, Vec<String>) {
        let mut dropped: Vec<String> = self.remove(&entry.key).map(|e| e.key).into_iter().collect();
        let incoming = Self::bytes(&entry);
        if incoming > max_bytes {
            return (false, dropped);
        }
        let mut retained = incoming + self.entries.iter().map(Self::bytes).sum::<usize>();
        while self.entries.len() >= max_entries || retained > max_bytes {
            let oldest = self.entries.remove(0);
            retained -= Self::bytes(&oldest);
            dropped.push(oldest.key);
        }
        self.entries.push(entry);
        (true, dropped)
    }
}

// ---- read cache ----

struct ReadMeta {
    /// Each constituent file with the stat the body was read against.
    stats: Vec<(String, Option<Stat>)>,
    explicit_success: bool,
}

fn arg<'a>(args: &'a JsonValue, name: &str) -> Option<&'a JsonValue> {
    args.get(name).filter(|v| !v.is_null())
}

fn path_arg(args: &JsonValue) -> Option<&JsonValue> {
    match (arg(args, "path"), arg(args, "file_path")) {
        (Some(path), None) | (None, Some(path)) => Some(path),
        _ => None,
    }
}

// ---- scoped cache ----

struct ScopedMeta {
    coverage: Vec<Coverage>,
    explicit_success: bool,
}

#[derive(Clone)]
struct Coverage {
    root: PathBuf,
    revision: Arc<()>,
    file_only: bool,
}

type Revision = Arc<dyn Fn(&Path) -> Option<Arc<()>> + Send + Sync>;

fn scoped_key(tool: &str, args: &JsonValue, cwd: &str) -> String {
    // Preserve types, nulls and empty strings: a cache-only alias or default
    // can turn a refused call or a different grep mode into a false hit.
    serde_json::to_string(&(tool, cwd, args)).expect("JSON cache key")
}

fn collect_paths(value: Option<&JsonValue>, out: &mut Vec<String>) {
    match value {
        Some(JsonValue::String(s)) if !s.is_empty() => out.push(s.clone()),
        Some(JsonValue::Array(items)) => items.iter().for_each(|i| collect_paths(Some(i), out)),
        _ => {}
    }
}

/// Touched paths of a patch (`*** Update/Add/Delete File:` lines and unified-diff headers), as
/// written in it.
pub(crate) fn touched_paths(patch: &str) -> Vec<String> {
    let lines: Vec<&str> = patch.split('\n').collect();
    let mut out = Vec::new();
    push_marker_paths(&lines, &mut out);
    push_diff_header_paths(&lines, &mut out);
    out
}

fn strip_metadata(raw: &str) -> String {
    let mut text = mixdog_js::js_trim(raw).to_owned();
    if let Some(tab) = text.find('\t') {
        text = text[..tab].trim_end().to_owned();
    }
    if let Some(q @ ('"' | '\'')) = text.chars().next()
        && text.len() > 1
        && let Some(end) = text[1..].find(q)
    {
        text = text[1..1 + end].to_owned();
    }
    text
}

fn push_touched(raw: &str, out: &mut Vec<String>) {
    let mut touched = strip_metadata(raw);
    if touched.is_empty() || touched == "/dev/null" {
        return;
    }
    touched = touched.trim_matches(['"', '\'']).replace('\\', "/");
    if let Some(rest) = touched.strip_prefix("a/").or_else(|| touched.strip_prefix("b/")) {
        touched = rest.to_owned();
    }
    if touched.is_empty() || touched == "/dev/null" || out.contains(&touched) {
        return;
    }
    out.push(touched);
}

fn push_marker_paths(lines: &[&str], out: &mut Vec<String>) {
    for line in lines {
        for marker in ["*** Update File:", "*** Add File:", "*** Delete File:"] {
            if let Some(rest) = line.strip_prefix(marker) {
                push_touched(rest, out);
            }
        }
    }
}

fn push_diff_header_paths(lines: &[&str], out: &mut Vec<String>) {
    let mut i = 0;
    while i + 1 < lines.len() {
        let (minus, plus) = (lines[i], lines[i + 1]);
        if minus.starts_with("--- ") && plus.starts_with("+++ ") {
            let from = mixdog_js::js_trim(&minus[4..]);
            let to = mixdog_js::js_trim(&plus[4..]);
            let from = from.strip_prefix("a/").unwrap_or(from);
            let to = to.strip_prefix("b/").unwrap_or(to);
            if to == "/dev/null" {
                if from != "/dev/null" {
                    push_touched(from, out);
                }
            } else {
                push_touched(to, out);
            }
            i += 1;
        }
        i += 1;
    }
}

/// A stored read result that is not a body: a receipt of an earlier delivery, or an error.
fn is_stub_or_error(content: &str) -> bool {
    const STUBS: [&str; 3] = ["[file unchanged:", "[cross-turn-dedup]", "[intra-turn-dedup]"];
    let head = content.trim_start();
    STUBS.iter().any(|p| head.starts_with(p)) || head.starts_with("Error:") || head.starts_with("Error [code") || head.starts_with("[error")
}

// ---- the seam ----

/// What one session has cached (`_bySession` and `_scopedBySession`): it outlives the runs of its turns.
struct Inner {
    read: Bounded<ReadMeta>,
    scoped: Bounded<ScopedMeta>,
    read_epoch: Arc<()>,
    scoped_epoch: Arc<()>,
}

impl Inner {
    fn new() -> Self {
        Self { read: Bounded::new(), scoped: Bounded::new(), read_epoch: Arc::new(()), scoped_epoch: Arc::new(()) }
    }

    fn reset_read(&mut self) {
        self.read = Bounded::new();
        self.read_epoch = Arc::new(());
    }

    /// Writes begun under the earlier epochs can no longer land.
    fn fence_pending_writes(&mut self) {
        self.read_epoch = Arc::new(());
        self.scoped_epoch = Arc::new(());
    }
}

/// The caches of the sessions by session id: Node's `_bySession` / `_scopedBySession`, looked up by id at every use.
type Sessions = Arc<Mutex<std::collections::HashMap<String, Inner>>>;

/// The result caches of the sessions, for the lifetime of each session: Node keeps them in module maps keyed by the
/// session id (`read-cache.mjs` `_bySession`, `scoped-cache.mjs` `_scopedBySession`), so a turn that starts after another
/// of the same session finds what the earlier one read. They end with the session (`clearReadDedupSession`: a rest, a close,
/// a delete, a working-folder change), a compaction (`resetReadStateAfterCompaction`: the read cache only), the process, and,
/// entry by entry, the 100-entry / 8 MiB bound of each cache. An execution that began before a clear cannot refill it.
#[derive(Default)]
pub struct LiveReuses {
    sessions: Sessions,
    mutations: Arc<AtomicUsize>,
    snapshots: std::sync::OnceLock<Arc<ReadState>>,
    revision: std::sync::OnceLock<Revision>,
}

#[cfg(test)]
#[path = "result_reuse_bounds_tests.rs"]
mod budget_tests;

#[cfg(test)]
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup builds fixture trees")]
mod tests {
    use serde_json::json;

    use super::*;

    struct Fixed(i64);
    impl Clock for Fixed {
        fn now_ms(&self) -> i64 {
            self.0
        }
    }

    /// A temporary folder at its real path: a read of a path through a symlink or a short name is never cached.
    fn tempdir() -> tempfile::TempDir {
        tempfile::Builder::new().tempdir_in(pathguard::canonical(&std::env::temp_dir()).unwrap()).unwrap()
    }

    fn call(name: &str, args: JsonValue) -> ToolCall {
        ToolCall { id: "c1".into(), name: name.into(), arguments: args, native_type: None }
    }

    #[test]
    fn touched_paths_follow_the_diff_headers() {
        let patch = "*** Update File: a.txt\n--- a/b.txt\n+++ b/b.txt\n--- a/c.txt\n+++ /dev/null\n";
        assert_eq!(touched_paths(patch), ["a.txt", "b.txt", "c.txt"]);
    }

    #[test]
    fn lexical_normalize_resolves_dots() {
        assert_eq!(normalize("/a/b/../c/./d"), "/a/c/d");
    }

    fn io() -> ToolIo {
        let tokens = mixdog_rt::testing::tokens();
        ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io }
    }
    struct CacheAt<'a>(Arc<ToolResultReuse>, &'a Path);

    impl CacheAt<'_> {
        async fn lookup(&self, call: &ToolCall, touch: bool) -> Option<Reused> {
            self.0.lookup(call, self.1, touch).await
        }

        async fn prepare(&self, call: &ToolCall, id: &str) -> Option<Box<dyn ReuseWrite>> {
            let call = ToolCall { id: id.to_owned(), ..call.clone() };
            self.0.prepare(&call, self.1).await
        }

        async fn fill(&self, call: &ToolCall, content: &str, id: &str) {
            self.prepare(call, id).await.unwrap().store(content, &complete_output()).await;
        }

        async fn after_call(&self, call: &ToolCall, failed: bool) {
            self.0.after_call(&call.name, &call.arguments, self.1, failed).await;
        }
    }

    fn complete_output() -> ToolOutput {
        ToolOutput { meta: Some(json!({"complete": true})), ..ToolOutput::default() }
    }

    fn watched() -> LiveReuses {
        let live = LiveReuses::default();
        let revision = Arc::new(());
        let _ = live.revision.set(Arc::new(move |_| Some(revision.clone())));
        live
    }

    fn reuse(dir: &Path, now: i64) -> CacheAt<'_> {
        CacheAt(watched().run(io(), "sess_1", Arc::new(Fixed(now))), dir)
    }
    #[tokio::test]
    async fn a_read_is_reused_until_the_file_changes() {
        let dir = tempdir();
        let file = dir.path().join("a.txt");
        std::fs::write(&file, "one").unwrap();
        let r = reuse(dir.path(), 0);
        let c = call("read", json!({"path": "a.txt"}));
        assert!(r.lookup(&c, true).await.is_none());
        r.fill(&c, "one", "t1").await;
        let hit = r.lookup(&c, true).await.unwrap();
        assert_eq!((hit.content.as_str(), hit.first_tool_use_id.as_str()), ("one", "t1"));
        // another offset is another key
        assert!(r.lookup(&call("read", json!({"path": "a.txt", "offset": 3})), true).await.is_none());
        std::fs::write(&file, "two!").unwrap();
        assert!(r.lookup(&c, true).await.is_none());
    }
    #[tokio::test]
    async fn a_same_size_rewrite_with_the_old_timestamps_is_not_reused() {
        let dir = tempdir();
        let file = dir.path().join("a.txt");
        std::fs::write(&file, "one").unwrap();
        let before = std::fs::metadata(&file).unwrap().modified().unwrap();
        let r = reuse(dir.path(), 0);
        let c = call("read", json!({"path": "a.txt"}));
        assert!(r.lookup(&c, true).await.is_none());
        r.fill(&c, "one", "t1").await;
        std::fs::write(&file, "two").unwrap();
        std::fs::OpenOptions::new().write(true).open(&file).unwrap().set_modified(before).unwrap();
        assert!(r.lookup(&c, true).await.is_none(), "the bytes differ though size and mtime are as stored");
    }
    #[tokio::test]
    async fn a_file_replaced_by_rename_is_not_reused_unless_its_bytes_are_the_same() {
        let dir = tempdir();
        let file = dir.path().join("a.txt");
        std::fs::write(&file, "one").unwrap();
        let r = reuse(dir.path(), 0);
        let c = call("read", json!({"path": "a.txt"}));
        r.fill(&c, "one", "t1").await;
        std::fs::write(dir.path().join("b.txt"), "two").unwrap();
        std::fs::rename(dir.path().join("b.txt"), &file).unwrap();
        assert!(r.lookup(&c, true).await.is_none());
    }
    #[tokio::test]
    async fn a_body_read_while_something_else_wrote_the_file_is_not_stored() {
        let dir = tempdir();
        let file = dir.path().join("a.txt");
        std::fs::write(&file, "").unwrap();
        let r = reuse(dir.path(), 0);
        let c = call("read", json!({"path": "a.txt"}));
        let write = r.prepare(&c, "t1").await.unwrap();
        std::fs::write(&file, "written by a shell").unwrap();
        write.store("[empty]", &ToolOutput::default()).await;
        assert!(r.lookup(&c, true).await.is_none(), "the empty body must never answer for the written file");
    }
    #[tokio::test]
    async fn a_read_without_a_valid_pre_execution_snapshot_cannot_fill_the_cache() {
        let dir = tempdir();
        let r = reuse(dir.path(), 0);
        let c = call("read", json!({"path": "a.txt"}));
        assert!(r.prepare(&c, "t1").await.is_none());
        std::fs::write(dir.path().join("a.txt"), "one").unwrap();
        assert!(r.lookup(&c, true).await.is_none());
    }
    /// Decided departure from Node: a read is only ever replayed as a body, on every route (`reuse` here is not the Cursor one).
    #[tokio::test]
    async fn a_stored_stub_receipt_or_error_is_never_replayed_for_a_read_but_a_body_is() {
        let dir = tempdir();
        std::fs::write(dir.path().join("a.txt"), "one").unwrap();
        let r = reuse(dir.path(), 0);
        let c = call("read", json!({"path": "a.txt"}));
        for stored in [
            "[file unchanged: a.txt]",
            "[cross-turn-dedup] `read` already ran in iteration 3; result unchanged, already in context.",
            "[intra-turn-dedup] identical read-only `read` call was already executed in this same assistant turn as tool_use_id=t0.",
            "Error: cannot read a.txt",
        ] {
            r.fill(&c, stored, "t1").await;
            assert!(r.lookup(&c, true).await.is_none(), "{stored}");
        }
        r.fill(&c, "[lines 1-1]\none", "t2").await;
        assert_eq!(r.lookup(&c, true).await.unwrap().content, "[lines 1-1]\none");
    }
    #[tokio::test]
    async fn public_and_legacy_read_offsets_do_not_collide() {
        let dir = tempdir();
        std::fs::write(dir.path().join("a.txt"), "x").unwrap();
        let cache = reuse(dir.path(), 0);
        let public = call("read", json!({"file_path": "a.txt", "offset": 1}));
        cache.fill(&public, "first line", "public").await;
        assert_eq!(cache.lookup(&public, true).await.unwrap().content, "first line");
        let legacy = call("read", json!({"path": "a.txt", "offset": 1}));
        assert!(cache.lookup(&legacy, true).await.is_none());
    }
    #[tokio::test]
    async fn a_patch_drops_the_files_it_touches_and_the_scoped_entries_over_them() {
        let dir = tempdir();
        std::fs::create_dir(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src/a.txt"), "one").unwrap();
        let r = reuse(dir.path(), 0);
        let read = call("read", json!({"path": "src/a.txt"}));
        let list = call("list", json!({"path": "src"}));
        r.fill(&read, "one", "t1").await;
        r.fill(&list, "a.txt", "t2").await;
        assert!(r.lookup(&list, true).await.is_some());
        r.after_call(&call("apply_patch", json!({"patch": "--- a/src/a.txt\n+++ b/src/a.txt\n@@\n-x\n+y\n"})), false).await;
        assert!(r.lookup(&read, true).await.is_none());
        assert!(r.lookup(&list, true).await.is_none());
    }
    #[tokio::test]
    async fn scoped_entries_expire_after_thirty_seconds() {
        let dir = tempdir();
        let clock = Arc::new(Mutex::new(0i64));
        struct Shared(Arc<Mutex<i64>>);
        impl Clock for Shared {
            fn now_ms(&self) -> i64 {
                *self.0.lock().unwrap()
            }
        }
        let r = CacheAt(watched().run(io(), "s", Arc::new(Shared(clock.clone()))), dir.path());
        let c = call("glob", json!({"pattern": "*.rs", "root": ".", "include_noise": true}));
        r.fill(&c, "a.rs", "t").await;
        assert!(r.lookup(&c, true).await.is_some());
        *clock.lock().unwrap() = 30_000;
        assert!(r.lookup(&c, true).await.is_none());
    }
    #[tokio::test]
    async fn shell_and_git_mutations_clear_scoped_entries() {
        let dir = tempdir();
        let r = reuse(dir.path(), 0);
        let list = call("list", json!({}));
        r.fill(&list, "x", "t").await;
        assert!(r.lookup(&list, true).await.is_some());
        r.after_call(&call("shell", json!({"command": "rm x"})), false).await;
        assert!(r.lookup(&list, true).await.is_none());
    }
    #[tokio::test]
    async fn grep_cache_keeps_executor_modes_and_argument_types_distinct() {
        let dir = tempdir();
        let r = reuse(dir.path(), 0);
        let stored = call("grep", json!({"pattern": "foo", "mode": "count", "head_limit": 5, "include_noise": true}));
        r.fill(&stored, "hit", "t").await;
        assert_eq!(r.lookup(&stored, true).await.unwrap().content, "hit");
        for request in [
            json!({"pattern": "foo", "output_mode": "count", "head_limit": 5, "include_noise": true}),
            json!({"pattern": "foo", "mode": "count", "head_limit": "5", "include_noise": true}),
            json!({"query": "foo", "mode": "count", "head_limit": 5, "include_noise": true}),
        ] {
            assert!(r.lookup(&call("grep", request), true).await.is_none());
        }
    }
    #[tokio::test]
    async fn clearing_a_session_empties_the_caches_of_its_live_runs_only() {
        let dir = tempdir();
        std::fs::write(dir.path().join("a.txt"), "one").unwrap();
        let live = watched();
        let mine = CacheAt(live.run(io(), "sess_1", Arc::new(Fixed(0))), dir.path());
        let other = CacheAt(live.run(io(), "sess_2", Arc::new(Fixed(0))), dir.path());
        let read = call("read", json!({"path": "a.txt"}));
        let list = call("list", json!({}));
        for r in [&mine, &other] {
            r.fill(&read, "one", "t1").await;
            r.fill(&list, "a.txt", "t2").await;
        }
        live.clear_session("sess_1");
        assert!(mine.lookup(&read, true).await.is_none(), "the read cache is cleared");
        assert!(mine.lookup(&list, true).await.is_none(), "so is the scoped cache");
        assert!(other.lookup(&read, true).await.is_some() && other.lookup(&list, true).await.is_some(), "another session keeps its entries");
    }
    #[tokio::test]
    async fn a_project_switch_rejects_in_flight_fills_and_keys_new_fills_to_the_project_that_ran() {
        let dir = tempdir();
        let next = tempdir();
        std::fs::write(dir.path().join("a.txt"), "one").unwrap();
        std::fs::write(next.path().join("a.txt"), "two").unwrap();
        let live = watched();
        let run = live.run(io(), "sess_1", Arc::new(Fixed(0)));
        let old = CacheAt(run.clone(), dir.path());
        let new = CacheAt(run, next.path());
        let read = call("read", json!({"path": "a.txt"}));
        let list = call("list", json!({}));
        let read_before_switch = old.prepare(&read, "t1").await.unwrap();
        let list_before_switch = old.prepare(&list, "t2").await.unwrap();
        live.clear_session("sess_1");
        new.fill(&read, "two", "t3").await;
        new.fill(&list, "new listing", "t4").await;
        read_before_switch.store("one", &ToolOutput::default()).await;
        list_before_switch.store("old listing", &complete_output()).await;
        assert!(old.lookup(&read, true).await.is_none());
        assert!(old.lookup(&list, true).await.is_none());
        assert_eq!(new.lookup(&read, true).await.unwrap().content, "two");
        assert_eq!(new.lookup(&list, true).await.unwrap().content, "new listing");
    }

    #[tokio::test]
    async fn a_scoped_result_started_before_invalidation_cannot_replace_a_fresh_result() {
        let dir = tempdir();
        let other = tempdir();
        let live = watched();
        let cache = CacheAt(live.run(io(), "reader", Arc::new(Fixed(0))), dir.path());
        let writer = CacheAt(live.run(io(), "writer", Arc::new(Fixed(0))), dir.path());
        let unrelated = CacheAt(live.run(io(), "unrelated", Arc::new(Fixed(0))), other.path());
        let grep = call("grep", json!({"pattern": "x", "include_noise": true}));
        cache.fill(&grep, "old row", "old-row").await;
        unrelated.fill(&grep, "unrelated row", "unrelated-row").await;
        let pending = cache.prepare(&grep, "old").await.unwrap();
        let active = writer.0.mutation_guard();
        assert!(cache.lookup(&grep, true).await.is_none());
        writer.after_call(&call("edit", json!({"file_path": "a.txt"})), true).await;
        drop(active);
        assert!(cache.lookup(&grep, true).await.is_none());
        assert_eq!(unrelated.lookup(&grep, true).await.unwrap().content, "unrelated row");
        cache.fill(&grep, "fresh", "new").await;
        pending.store("stale", &complete_output()).await;
        let hit = cache.lookup(&grep, true).await.unwrap();
        assert_eq!((hit.first_tool_use_id.as_str(), hit.content.as_str()), ("new", "fresh"));
    }

    #[tokio::test]
    async fn external_glob_coverage_is_required_and_its_loss_rejects_hits_and_pending_fills() {
        let cwd = tempdir();
        let external = tempdir();
        let root = pathguard::canonical(external.path()).unwrap();
        let live = LiveReuses::default();
        let revision = Arc::new(Mutex::new(None));
        let state = revision.clone();
        let _ = live.revision.set(Arc::new(move |path| (path == root).then(|| state.lock().unwrap().clone()).flatten()));
        let cache = CacheAt(live.run(io(), "reader", Arc::new(Fixed(0))), cwd.path());
        let glob = call("glob", json!({"pattern": external.path().join("*.rs").to_string_lossy(), "include_noise": true}));
        assert!(cache.prepare(&glob, "cold").await.is_none());
        *revision.lock().unwrap() = Some(Arc::new(()));
        cache.fill(&glob, "external.rs", "fresh").await;
        let pending = cache.prepare(&glob, "pending").await.unwrap();
        assert_eq!(cache.lookup(&glob, true).await.unwrap().content, "external.rs");
        *revision.lock().unwrap() = None;
        pending.store("must not fill", &complete_output()).await;
        assert!(cache.lookup(&glob, true).await.is_none());
        *revision.lock().unwrap() = Some(Arc::new(()));
        assert!(cache.lookup(&glob, true).await.is_none());
    }

    #[tokio::test]
    async fn scoped_reuse_requires_known_complete_and_cache_safe_output() {
        let dir = tempdir();
        let cache = reuse(dir.path(), 0);
        let list = call("list", json!({"mode": "tree"}));
        for meta in [None, Some(json!({"complete": false})), Some(json!({"complete": true, "cacheSafe": false}))] {
            let output = ToolOutput { meta, ..ToolOutput::default() };
            cache.prepare(&list, "partial").await.unwrap().store("partial", &output).await;
            assert!(cache.lookup(&list, true).await.is_none());
        }
        cache.fill(&list, "whole", "whole").await;
        assert_eq!(cache.lookup(&list, true).await.unwrap().content, "whole");
    }

    #[tokio::test]
    async fn directory_watch_alone_does_not_prove_global_or_parent_ignore_inputs() {
        let dir = tempdir();
        std::fs::write(dir.path().join("a.rs"), "x").unwrap();
        let cache = reuse(dir.path(), 0);
        for request in [call("glob", json!({"pattern": "*.rs"})), call("grep", json!({"pattern": "x"})), call("code_graph", json!({"mode": "overview"}))] {
            assert!(cache.prepare(&request, "uncovered").await.is_none());
        }
        let glob = call("glob", json!({"pattern": "*.rs", "include_noise": true}));
        let grep = call("grep", json!({"pattern": "x", "path": "a.rs"}));
        for request in [glob, grep] {
            cache.fill(&request, "a.rs", "covered").await;
            assert_eq!(cache.lookup(&request, true).await.unwrap().content, "a.rs");
        }
    }

    #[tokio::test]
    async fn only_static_find_windows_can_be_reused() {
        let dir = tempdir();
        let cache = reuse(dir.path(), 0);
        for args in [json!({"mode": "find", "modified_after": "90m"}), json!({"path": "*.rs", "modified_before": "12h"})] {
            assert!(cache.prepare(&call("list", args), "relative").await.is_none());
        }
        let absolute = call("list", json!({"mode": "find", "modified_after": "2026-01-01T00:00:00Z"}));
        cache.fill(&absolute, "a.rs", "fixed").await;
        assert_eq!(cache.lookup(&absolute, true).await.unwrap().content, "a.rs");
    }

    #[tokio::test]
    async fn pdf_reads_cannot_fill_the_route_independent_text_cache() {
        let dir = tempdir();
        std::fs::write(dir.path().join("manual.PDF"), b"fake PDF").unwrap();
        std::fs::write(dir.path().join("manual"), b"%PDF-1.7").unwrap();
        let cache = reuse(dir.path(), 0);
        for path in ["manual.PDF", "manual"] {
            let read = call("read", json!({"path": path}));
            assert!(cache.prepare(&read, "pdf").await.is_none());
            assert!(cache.lookup(&read, true).await.is_none());
        }
    }

    #[tokio::test]
    async fn resting_a_session_releases_its_cached_texts_and_repopulates_on_next_read() {
        let dir = tempdir();
        std::fs::write(dir.path().join("a.txt"), "hello").unwrap();
        let live = watched();
        let s1 = CacheAt(live.run(io(), "s1", Arc::new(Fixed(0))), dir.path());
        let s2 = CacheAt(live.run(io(), "s2", Arc::new(Fixed(0))), dir.path());
        let read = call("read", json!({"path": "a.txt"}));
        s1.fill(&read, "hello", "r1").await;
        s2.fill(&read, "hello", "r2").await;
        let in_flight = s1.prepare(&read, "r-pending").await.unwrap();
        assert!(live.has_session("s1") && live.has_session("s2"));

        live.release_rested("s1");
        assert!(!live.has_session("s1"), "resting drops the session's text caches");
        assert!(live.has_session("s2"), "other sessions stay cached");
        assert!(s1.lookup(&read, true).await.is_none());
        in_flight.store("stale", &complete_output()).await;
        assert!(!live.has_session("s1"), "writes prepared before rest cannot refill it");

        s1.fill(&read, "hello", "r3").await;
        assert!(live.has_session("s1"));
        assert_eq!(s1.lookup(&read, true).await.unwrap().content, "hello");
    }

    #[tokio::test]
    async fn a_read_cannot_hit_or_fill_while_a_mutation_guard_is_active_and_cannot_land_after_invalidation() {
        let dir = tempdir();
        let file = dir.path().join("a.txt");
        std::fs::write(&file, "one").unwrap();
        let live = watched();
        let cache = CacheAt(live.run(io(), "reader", Arc::new(Fixed(0))), dir.path());
        let read = call("read", json!({"path": "a.txt"}));
        let glob = call("glob", json!({"pattern": "*.txt", "include_noise": true}));
        cache.fill(&read, "one", "r1").await;
        cache.fill(&glob, "a.txt", "g1").await;
        let pending_read = cache.prepare(&read, "r-pending").await.unwrap();

        let active = cache.0.mutation_guard();
        assert!(!cache.0.has_candidate(&read, dir.path()).await);
        assert!(!cache.0.has_candidate(&glob, dir.path()).await);
        assert!(cache.lookup(&read, true).await.is_none());
        assert!(cache.lookup(&glob, true).await.is_none());
        assert!(cache.prepare(&read, "during").await.is_none());
        assert!(cache.prepare(&glob, "during").await.is_none());

        std::fs::write(&file, "two").unwrap();
        cache.after_call(&call("edit", json!({"file_path": "a.txt"})), false).await;
        drop(active);

        pending_read.store("one", &complete_output()).await;
        assert!(cache.lookup(&read, true).await.is_none());
        assert!(cache.lookup(&glob, true).await.is_none());
        cache.fill(&read, "two", "r2").await;
        assert_eq!(cache.lookup(&read, true).await.unwrap().content, "two");
    }
}

pub(crate) fn resolve(base: &str, path: &str) -> String {
    if is_abs(path) {
        return normalize(path);
    }
    let base = if base.is_empty() { std::env::current_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default() } else { base.to_owned() };
    normalize(&format!("{base}/{path}"))
}
fn normalize_abs(path: &str, cwd: &str) -> Option<String> {
    let path = mixdog_tools::fs::read_result_file(Path::new(cwd), path)?;
    Some(path.to_str()?.to_owned())
}
/// The sha256 of the file's bytes, `None` when it is unreadable or past the budget.
#[allow(clippy::disallowed_methods, reason = "runs inside a lane job body")]
fn digest_of(lane: &InLane<InteractiveIo>, abs: &str) -> Option<String> {
    use sha2::Digest;
    use std::io::Read;
    let mut bytes = Vec::new();
    mixdog_fsio::File::open(lane, abs).ok()?.take(READ_PREFIX_HASH_BYTES + 1).read_to_end(&mut bytes).ok()?;
    // A text-only PDF result on one route does not prove that another route
    // would return text rather than pages or a native attachment.
    (!bytes.starts_with(b"%PDF-") && bytes.len() as u64 <= READ_PREFIX_HASH_BYTES).then(|| format!("{:x}", sha2::Sha256::digest(&bytes)))
}
/// Node's `statSync`: one metadata call per path argument, taken inside an io-interactive lane job.
#[allow(clippy::disallowed_methods, reason = "takes the lane's proof: it runs inside a lane job body")]
fn stat_tuple(lane: &InLane<InteractiveIo>, abs: &str) -> Option<Stat> {
    if Path::new(abs).extension().and_then(|ext| ext.to_str()).is_some_and(|ext| ext.eq_ignore_ascii_case("pdf")) {
        return None;
    }
    if device_paths::is_unc_path(abs)
        || device_paths::is_windows_device_path(abs)
        || device_paths::has_unsafe_win32_component(abs)
        || device_paths::is_blocked_device_path(abs)
    {
        return None;
    }
    let meta = std::fs::metadata(abs).ok()?;
    if !meta.is_file() || meta.len() > READ_PREFIX_HASH_BYTES {
        return None;
    }
    // The tool can refuse symlinks even when their target has unchanged bytes.
    let requested = Path::new(abs);
    let real = pathguard::canonical(requested).ok()?;
    if pathguard::comparable(&real) != pathguard::comparable(requested) {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let ns = |s: i64, n: i64| (s as i128 * 1_000_000_000 + n as i128).max(0) as u128;
        Some(Stat {
            size: meta.size(),
            times: [ns(meta.mtime(), meta.mtime_nsec()), ns(meta.ctime(), meta.ctime_nsec())],
            ino: meta.ino(),
            dev: meta.dev(),
            digest: digest_of(lane, abs),
        })
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        Some(Stat {
            size: meta.file_size(),
            times: [meta.last_write_time() as u128, meta.creation_time() as u128],
            ino: 0,
            dev: 0,
            digest: digest_of(lane, abs),
        })
    }
}
/// The stat tuples of `paths`, in one lane job. A stat that cannot be taken (the lane refused or
/// went away) reads as a missing file, which is a cache miss and never a stale hit.
async fn stats_of(io: &ToolIo, paths: Vec<String>) -> Vec<Option<Stat>> {
    let missing = vec![None; paths.len()];
    let Ok(job) = io.interactive.submit(&CancellationToken::new(), move |lane| paths.iter().map(|path| stat_tuple(lane, path)).collect::<Vec<_>>()) else {
        return missing;
    };
    job.await.unwrap_or(missing)
}
fn dependency_roots(tool: &str, args: &JsonValue, cwd: &Path) -> Option<Vec<PathBuf>> {
    let roots = match tool {
        "glob" => mixdog_tools::fs::glob_result_roots(args)?,
        "list" => vec![mixdog_tools::fs::list_result_root(args)?],
        "grep" => match args.get("path") {
            None | Some(JsonValue::Null) => vec![".".to_owned()],
            Some(JsonValue::String(s)) if mixdog_js::js_trim(s).is_empty() => vec![".".to_owned()],
            Some(JsonValue::String(s)) => vec![s.clone()],
            Some(JsonValue::Array(paths)) if (1..=10).contains(&paths.len()) => {
                paths.iter().map(|p| p.as_str().map(mixdog_js::js_trim).filter(|s| !s.is_empty()).map(str::to_owned)).collect::<Option<_>>()?
            }
            _ => return None,
        },
        _ => return None,
    };
    roots.iter().map(|root| mixdog_tools::fs::result_root(cwd, root)).collect()
}
/// One run's view of its session's cache.
#[derive(Clone)]
pub struct ToolResultReuse {
    io: ToolIo,
    session_id: String,
    clock: Arc<dyn Clock>,
    sessions: Sessions,
    mutations: Arc<AtomicUsize>,
    /// The session's read snapshots, which a compaction resets together with the cached results.
    snapshots: Option<Arc<ReadState>>,
    revision: Option<Revision>,
}

struct Write {
    cache: ToolResultReuse,
    epoch: Arc<()>,
    key: String,
    first: Option<String>,
    target: WriteTarget,
}

enum WriteTarget {
    Read(Vec<(String, Option<Stat>)>),
    Scoped(Vec<Coverage>),
}

struct ActiveMutation(Arc<AtomicUsize>);

impl Drop for ActiveMutation {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl ToolResultReuse {
    /// The entry key and the files a read call depends on.
    fn read_target(args: &JsonValue, cwd: &str) -> Option<(String, Vec<String>)> {
        let path = path_arg(args)?;
        let mut paths = Vec::new();
        match path {
            JsonValue::String(path) => paths.push(normalize_abs(path, cwd)?),
            JsonValue::Array(items) if !items.is_empty() => {
                for item in items {
                    let path = item.as_str().or_else(|| path_arg(item).and_then(JsonValue::as_str))?;
                    let abs = normalize_abs(path, cwd)?;
                    if !paths.contains(&abs) {
                        paths.push(abs);
                    }
                }
            }
            _ => return None,
        }
        // Even an absolute read can render differently relative to the calling project.
        Some((scoped_key("read", args, cwd), paths))
    }

    /// `_bySession.get(sessionId)`: the session's cache as it is now, None when the id holds none (a lookup never creates one).
    fn with<R>(&self, f: impl FnOnce(&mut Inner) -> R) -> Option<R> {
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        if self.mutations.load(Ordering::SeqCst) != 0 {
            return None;
        }
        sessions.get_mut(&self.session_id).map(f)
    }

    /// `_getOrCreate(sessionId)`: a store makes the id's cache again after a clear, for whoever reads next under the id.
    fn with_create<R>(&self, f: impl FnOnce(&mut Inner) -> R) -> Option<R> {
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        if self.mutations.load(Ordering::SeqCst) != 0 {
            return None;
        }
        Some(f(sessions.entry(self.session_id.clone()).or_insert_with(Inner::new)))
    }

    /// Compaction removed prior tool results from the context: start a fresh read epoch.
    pub fn reset_after_compaction(&self) {
        if let Some(inner) = self.sessions.lock().unwrap_or_else(|e| e.into_inner()).get_mut(&self.session_id) {
            inner.reset_read();
        }
        if let Some(snapshots) = &self.snapshots {
            snapshots.forget_snapshots(&self.session_id);
        }
    }

    async fn cover(&self, roots: Vec<(PathBuf, bool)>) -> Option<Vec<Coverage>> {
        let revision = self.revision.clone()?;
        if roots.is_empty() {
            return None;
        }
        let job = self
            .io
            .interactive
            .submit(&CancellationToken::new(), move |lane| {
                roots
                    .into_iter()
                    .map(|(root, file_only)| {
                        let raw = root.to_str()?;
                        if device_paths::is_unc_path(raw)
                            || device_paths::is_windows_device_path(raw)
                            || device_paths::has_unsafe_win32_component(raw)
                            || device_paths::is_blocked_device_path(raw)
                        {
                            return None;
                        }
                        let real = pathguard::canonical(&root).ok()?;
                        if pathguard::comparable(&real) != pathguard::comparable(&root) {
                            return None;
                        }
                        if file_only && !mixdog_fsio::metadata(lane, &real).ok()?.is_file() {
                            return None;
                        }
                        Some(Coverage { revision: revision(&real)?, root: real, file_only })
                    })
                    .collect::<Option<Vec<_>>>()
            })
            .ok()?;
        job.await.ok().flatten()
    }

    fn revisions_match(&self, coverage: &[Coverage]) -> bool {
        self.revision.as_ref().is_some_and(|revision| coverage.iter().all(|proof| revision(&proof.root).is_some_and(|now| Arc::ptr_eq(&now, &proof.revision))))
    }

    async fn lookup_read(&self, call: &ToolCall, cwd: &str, touch: bool) -> Option<Reused> {
        let (key, paths) = Self::read_target(&call.arguments, cwd)?;
        let epoch = self.with(|inner| inner.read.position(&key).map(|_| inner.read_epoch.clone())).flatten()?;
        let current = stats_of(&self.io, paths).await;
        self.with(|inner| {
            if !Arc::ptr_eq(&epoch, &inner.read_epoch) {
                return None;
            }
            let index = inner.read.position(&key)?;
            let entry = &inner.read.entries[index];
            // The bytes are the same, or the body is not reused, whatever the timestamps say.
            let fresh = entry.meta.stats.len() == current.len()
                && entry
                    .meta
                    .stats
                    .iter()
                    .zip(&current)
                    .all(|((_, stored), now)| cacheable(stored) && cacheable(now) && stored.as_ref().map(|s| &s.digest) == now.as_ref().map(|s| &s.digest));
            if !fresh {
                inner.read.entries.remove(index);
                return None;
            }
            let reused = Reused {
                content: entry.content.clone(),
                first_tool_use_id: entry.first.clone().unwrap_or_default(),
                kind: ReuseKind::Read,
                explicit_success: entry.meta.explicit_success,
            };
            if touch {
                let entry = inner.read.entries.remove(index);
                inner.read.entries.push(entry);
            }
            Some(reused)
        })
        .flatten()
    }

    async fn lookup_scoped(&self, tool: &str, call: &ToolCall, cwd: &str, touch: bool) -> Option<Reused> {
        let key = scoped_key(tool, &call.arguments, cwd);
        let (epoch, coverage) = self
            .with(|inner| {
                let row = &inner.scoped.entries[inner.scoped.position(&key)?];
                Some((inner.scoped_epoch.clone(), row.meta.coverage.clone()))
            })
            .flatten()?;
        let verified = self.cover(coverage.iter().map(|proof| (proof.root.clone(), proof.file_only)).collect()).await;
        let valid = verified.is_some_and(|verified| verified.iter().zip(&coverage).all(|(now, then)| Arc::ptr_eq(&now.revision, &then.revision)));
        let now = self.clock.now_ms();
        self.with(|inner| {
            if !Arc::ptr_eq(&inner.scoped_epoch, &epoch) {
                return None;
            }
            let index = inner.scoped.position(&key)?;
            let current = &inner.scoped.entries[index].meta.coverage;
            if current.len() != coverage.len() || !current.iter().zip(&coverage).all(|(a, b)| a.root == b.root && Arc::ptr_eq(&a.revision, &b.revision)) {
                return None;
            }
            if now - inner.scoped.entries[index].ts >= SCOPED_TTL_MS {
                inner.scoped.entries.remove(index);
                return None;
            }
            // An unavailable revision can be transient: the watcher may be
            // draining an unrelated event. Never serve it until proven current.
            if !valid || !self.revisions_match(current) {
                return None;
            }
            let entry = &inner.scoped.entries[index];
            let reused = Reused {
                content: entry.content.clone(),
                first_tool_use_id: entry.first.clone().unwrap_or_default(),
                kind: ReuseKind::Scoped,
                explicit_success: entry.meta.explicit_success,
            };
            if touch {
                let entry = inner.scoped.entries.remove(index);
                inner.scoped.entries.push(entry);
            }
            Some(reused)
        })
        .flatten()
    }

    fn patch_base(args: &JsonValue, cwd: &str) -> String {
        match args.get("base_path").and_then(|b| b.as_str()) {
            Some(base) if !base.is_empty() => {
                if is_abs(base) {
                    base.to_owned()
                } else {
                    PathBuf::from(cwd).join(base).to_string_lossy().into_owned()
                }
            }
            _ => cwd.to_owned(),
        }
    }

    /// The paths a mutating call names and the directory they are relative to; `None` for a call that mutates nothing the caches track.
    fn written_paths(name: &str, args: &JsonValue, cwd: &Path) -> Option<(Vec<String>, PathBuf)> {
        let mut paths = Vec::new();
        let base: PathBuf = if name == "apply_patch" {
            paths = touched_paths(args.get("patch").and_then(|p| p.as_str()).unwrap_or_default());
            Self::patch_base(args, &cwd.to_string_lossy()).into()
        } else if matches!(name, "edit" | "write") {
            for key in ["file_path", "path", "file"] {
                collect_paths(args.get(key), &mut paths);
            }
            cwd.to_path_buf()
        } else if is_shell_tool(name) || is_git_mutation(name, args) {
            // These commands can write outside their invocation cwd.
            cwd.to_path_buf()
        } else {
            return None;
        };
        Some((paths, base))
    }

    /// `paths` resolved under `base`, each with its canonical form; `None` when one is unresolvable or a device path.
    async fn resolve_touched(&self, paths: Vec<String>, base: PathBuf) -> Option<Vec<PathBuf>> {
        let job = self.io.interactive.submit(&CancellationToken::new(), move |_| {
            let mut touched = Vec::new();
            for path in paths {
                let lexical = mixdog_tools::fs::result_root(&base, &path)?;
                let text = lexical.to_str()?;
                if device_paths::is_unc_path(text)
                    || device_paths::is_windows_device_path(text)
                    || device_paths::has_unsafe_win32_component(text)
                    || device_paths::is_blocked_device_path(text)
                {
                    return None;
                }
                touched.push(pathguard::canonical_through_existing(&lexical).ok()?);
                touched.push(lexical);
            }
            Some(touched)
        });
        match job {
            Ok(job) => job.await.ok().flatten(),
            Err(_) => None,
        }
    }
}
#[async_trait::async_trait]
impl ResultReuse for ToolResultReuse {
    async fn has_candidate(&self, call: &ToolCall, cwd: &Path) -> bool {
        if call.id.starts_with(CURSOR_NATIVE_PREFIX) || self.session_id.is_empty() {
            return false;
        }
        let Some(cwd) = cwd.to_str() else { return false };
        let tool = strip_mcp(&call.name);
        let key = scoped_key(tool, &call.arguments, cwd);
        self.with(|inner| match tool {
            "read" => inner.read.position(&key).is_some(),
            "glob" | "list" | "grep" => inner.scoped.position(&key).is_some(),
            _ => false,
        })
        .unwrap_or(false)
    }

    async fn lookup(&self, call: &ToolCall, cwd: &Path, touch: bool) -> Option<Reused> {
        if call.id.starts_with(CURSOR_NATIVE_PREFIX) || self.session_id.is_empty() {
            return None;
        }
        let cwd = cwd.to_str()?;
        match strip_mcp(&call.name) {
            "read" => self.lookup_read(call, cwd, touch).await,
            tool @ ("glob" | "list" | "grep") => self.lookup_scoped(tool, call, cwd, touch).await,
            _ => None,
        }
    }

    async fn prepare(&self, call: &ToolCall, cwd: &Path) -> Option<Box<dyn ReuseWrite>> {
        if call.id.starts_with(CURSOR_NATIVE_PREFIX) || self.session_id.is_empty() {
            return None;
        }
        let tool = strip_mcp(&call.name);
        let cwd_text = cwd.to_str()?;
        let (key, target, epoch) = if tool == "read" {
            let (key, paths) = Self::read_target(&call.arguments, cwd_text)?;
            if paths.is_empty() {
                return None;
            }
            let epoch = self.with_create(|inner| inner.read_epoch.clone())?;
            let before = stats_of(&self.io, paths.clone()).await;
            if !before.iter().all(cacheable) {
                return None;
            }
            (key, WriteTarget::Read(paths.into_iter().zip(before).collect()), epoch)
        } else {
            // Graph indexing always uses standard ignore filters. The
            // graph's own cache reconciles those inputs; tool-result reuse
            // cannot certify them from the reported workspace roots.
            let dep_roots = dependency_roots(tool, &call.arguments, cwd)?;
            // Directory searches with ignore rules can read ancestor ignore
            // files and global git excludes. A project watch cannot certify
            // that set. Explicit file grep disables ignore rules in execution.
            let ignore_uncovered = call.arguments.get("include_noise").and_then(JsonValue::as_bool) != Some(true);
            if tool == "glob" && ignore_uncovered {
                return None;
            }
            let file_only = tool == "grep" && ignore_uncovered;
            let key = scoped_key(tool, &call.arguments, cwd_text);
            let epoch = self.with_create(|inner| inner.scoped_epoch.clone())?;
            let coverage = self.cover(dep_roots.into_iter().map(|root| (root, file_only)).collect()).await?;
            (key, WriteTarget::Scoped(coverage), epoch)
        };
        Some(Box::new(Write { cache: self.clone(), epoch, key, first: (!call.id.is_empty()).then(|| call.id.clone()), target }))
    }

    fn mutation_guard(&self) -> Option<Box<dyn Send + Sync>> {
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        self.mutations.fetch_add(1, Ordering::SeqCst);
        for inner in sessions.values_mut() {
            inner.fence_pending_writes();
        }
        Some(Box::new(ActiveMutation(self.mutations.clone())))
    }

    async fn after_call(&self, name: &str, args: &JsonValue, cwd: &Path, _failed: bool) {
        let Some((paths, base)) = Self::written_paths(strip_mcp(name), args, cwd) else { return };
        let touched = if paths.is_empty() { None } else { self.resolve_touched(paths, base).await };
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        for inner in sessions.values_mut() {
            // Fills can discover additional dependencies during execution.
            // Fence pending writes without evicting established nonoverlapping rows.
            inner.fence_pending_writes();
            if let Some(touched) = &touched {
                let overlaps = |root: &Path| touched.iter().any(|path| pathguard::is_within(root, path) || pathguard::is_within(path, root));
                inner.read.entries.retain(|row| !row.meta.stats.iter().any(|(path, _)| overlaps(Path::new(path))));
                inner.scoped.entries.retain(|row| !row.meta.coverage.iter().any(|proof| overlaps(&proof.root)));
            } else {
                inner.read = Bounded::new();
                inner.scoped = Bounded::new();
            }
        }
    }
    fn after_compaction(&self) {
        self.reset_after_compaction();
    }
}

#[async_trait::async_trait]
impl ReuseWrite for Write {
    async fn store(self: Box<Self>, content: &str, output: &ToolOutput) {
        if content.is_empty() {
            return;
        }
        let Self { cache, epoch, key, first, target } = *self;
        let ts = cache.clock.now_ms();
        match target {
            WriteTarget::Read(stats) => {
                if is_stub_or_error(content) {
                    return;
                }
                let after = stats_of(&cache.io, stats.iter().map(|(path, _)| path.clone()).collect()).await;
                if !stats.iter().zip(after).all(|((_, before), after)| before == &after) {
                    return;
                }
                cache.with(|inner| {
                    if Arc::ptr_eq(&inner.read_epoch, &epoch) {
                        inner.read.set(Entry {
                            key,
                            content: content.to_owned(),
                            ts,
                            first,
                            meta: ReadMeta { stats, explicit_success: output.explicit_success },
                        });
                    }
                });
            }
            WriteTarget::Scoped(coverage) => {
                let Some(meta) = output.meta.as_ref() else { return };
                if meta.get("complete").and_then(JsonValue::as_bool) != Some(true) || meta.get("cacheSafe").is_some_and(|safe| safe.as_bool() != Some(true)) {
                    return;
                }
                let Some(after) = cache.cover(coverage.iter().map(|proof| (proof.root.clone(), proof.file_only)).collect()).await else { return };
                if !after.iter().zip(&coverage).all(|(now, then)| Arc::ptr_eq(&now.revision, &then.revision)) {
                    return;
                }
                cache.with(|inner| {
                    if Arc::ptr_eq(&inner.scoped_epoch, &epoch) && cache.revisions_match(&coverage) {
                        inner.scoped.set(Entry {
                            key,
                            content: content.to_owned(),
                            ts,
                            first,
                            meta: ScopedMeta { coverage, explicit_success: output.explicit_success },
                        });
                    }
                });
            }
        }
    }
}
impl LiveReuses {
    pub fn bind_watcher(&self, watcher: Arc<mixdog_workspace::watcher::FolderWatcher>) {
        let _ = self.revision.set(Arc::new(move |root| watcher.recursive_revision(root)));
    }

    /// Ties the caches to the read state: a session it releases (closed) or forgets (deleted) loses its caches
    /// (`registerSessionPurgeHook` and `releaseSessionReadCaches`), and a compaction resets its snapshots with them.
    pub fn bind(self: &Arc<Self>, read_state: &Arc<ReadState>) {
        let _ = self.snapshots.set(read_state.clone());
        let live = Arc::downgrade(self);
        read_state.on_released(Arc::new(move |session_id| {
            if let Some(live) = live.upgrade() {
                live.clear_session(session_id);
            }
        }));
    }

    /// A run's view of its session's cache; it finds the cache by the session id at every use.
    pub fn run(&self, io: ToolIo, session_id: &str, clock: Arc<dyn Clock>) -> Arc<ToolResultReuse> {
        Arc::new(ToolResultReuse {
            io,
            session_id: session_id.to_owned(),
            clock,
            sessions: self.sessions.clone(),
            mutations: self.mutations.clone(),
            snapshots: self.snapshots.get().cloned(),
            revision: self.revision.get().cloned(),
        })
    }

    /// `clearReadDedupSession(session_id)`: the read and scoped caches of the id are dropped.
    pub fn clear_session(&self, session_id: &str) {
        self.sessions.lock().unwrap_or_else(|e| e.into_inner()).remove(session_id);
    }

    /// Releases a resting session's cached texts without discarding its `ReadState` snapshots;
    /// the next turn repopulates from disk if needed.
    pub fn release_rested(&self, session_id: &str) {
        self.clear_session(session_id);
    }

    #[cfg(test)]
    fn has_session(&self, session_id: &str) -> bool {
        self.sessions.lock().unwrap_or_else(|e| e.into_inner()).contains_key(session_id)
    }

    /// `resetReadStateAfterCompaction(session_id)`, for a compaction that ran outside a turn.
    pub fn compacted(&self, session_id: &str) {
        if let Some(inner) = self.sessions.lock().unwrap_or_else(|e| e.into_inner()).get_mut(session_id) {
            inner.reset_read();
        }
        if let Some(snapshots) = self.snapshots.get() {
            snapshots.forget_snapshots(session_id);
        }
    }
}
