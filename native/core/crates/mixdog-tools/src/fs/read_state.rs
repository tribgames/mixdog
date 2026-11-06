//! What the file tools remember between calls, as Node's does: a process-wide result cache of
//! recent `read` answers (`cache-layers.mjs`: 30 s, 200 entries, 32 MiB) and, per session, a
//! snapshot of what each file looked like when it was last read or edited
//! (`read-snapshot-runtime.mjs`, `snapshot-store.mjs`: 32 sessions in memory, 1024 files each,
//! persisted by an injected store). Together they answer a repeated `read` with
//! `[file unchanged: <path>]` when the session already holds the body.
//!
//! The session key is the call's thread id (Node's `sessionId`); a call with no session records
//! and finds nothing. Node's `widenReadWindow` needs an object scope and is never reached with a
//! string session id, so it has no counterpart here.

use std::sync::Arc;
use std::sync::Mutex;

use mixdog_protocol::JsonValue;
use sha2::Digest;

const CACHE_TTL_MS: u64 = 30_000;
const CACHE_MAX_ENTRIES: usize = 200;
const CACHE_MAX_BYTES: usize = 32 * 1024 * 1024;
const SCOPES_IN_MEMORY: usize = 32;
const FILES_PER_SCOPE: usize = 1024;
const PERSIST_DEBOUNCE_MS: u64 = 500;
/// A file larger than this is never cached or trusted by metadata alone (`READ_PREFIX_HASH_BYTES`).
pub const CACHEABLE_BYTES: u64 = 64 * 1024;
const INFINITY_SENTINEL: &str = "__mixdog_Infinity_sentinel__";

/// `hashText`: sha256 hex of the text.
pub fn hash_text(text: &str) -> String {
    format!("{:x}", sha2::Sha256::digest(text.as_bytes()))
}

/// `hashText(buffer)`: sha256 hex of the bytes.
pub fn hash_bytes(bytes: &[u8]) -> String {
    format!("{:x}", sha2::Sha256::digest(bytes))
}

/// The identity of a file's content on disk (`fileVersion`). Node compares modification time,
/// change time, size, inode and device; the file service reports the first and the size, so the
/// others are compared only where both sides have them.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FileVersion {
    pub mtime_ms: f64,
    pub size: u64,
    pub ctime_ms: Option<f64>,
    pub ino: Option<u64>,
    pub dev: Option<u64>,
}

impl FileVersion {
    pub fn new(mtime: Option<std::time::SystemTime>, size: u64) -> Option<Self> {
        let at = mtime?.duration_since(std::time::UNIX_EPOCH).ok()?;
        Some(Self { mtime_ms: at.as_nanos() as f64 / 1e6, size, ctime_ms: None, ino: None, dev: None })
    }
}

/// `sameFileVersion`.
pub fn same_version(a: &FileVersion, b: &FileVersion) -> bool {
    a.mtime_ms == b.mtime_ms && a.size == b.size && a.ctime_ms == b.ctime_ms && a.ino == b.ino && a.dev == b.dev
}

/// A 1-based inclusive line range; `end: None` runs to the end of the file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LineRange {
    pub start: u64,
    pub end: Option<u64>,
}

impl LineRange {
    pub const WHOLE: Self = Self { start: 1, end: None };
}

/// `mergeReadRanges`.
pub fn merge_ranges(ranges: &[LineRange]) -> Vec<LineRange> {
    let mut sorted: Vec<LineRange> = ranges
        .iter()
        .map(|r| LineRange { start: r.start.max(1), end: r.end })
        .filter(|r| r.end.map_or(true, |e| e >= r.start))
        .collect();
    sorted.sort_by_key(|r| r.start);
    let mut out: Vec<LineRange> = Vec::new();
    for cur in sorted {
        match out.last_mut() {
            Some(top) if top.end.map_or(true, |e| cur.start <= e + 1) => {
                top.end = match (top.end, cur.end) {
                    (Some(a), Some(b)) => Some(a.max(b)),
                    _ => None,
                };
            }
            _ => out.push(cur),
        }
    }
    out
}

/// What one session knows about one file.
#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    pub version: FileVersion,
    pub ranges: Vec<LineRange>,
    pub source: String,
    pub body_delivered: Option<bool>,
    pub content_hash: Option<String>,
    pub grep_only: bool,
    pub file_line_count: Option<u64>,
    /// Fields this port does not use, kept so a persisted file round-trips.
    pub extra: serde_json::Map<String, JsonValue>,
}

/// `snapshotCoversFullFile`.
pub fn covers_full_file(s: &Snapshot) -> bool {
    s.ranges.iter().any(|r| r.start <= 1 && r.end.is_none())
}

/// `snapshotRangesCoverAllLines`.
fn covers_all_lines(s: &Snapshot, line_count: u64) -> bool {
    if s.ranges.is_empty() {
        return false;
    }
    if line_count == 0 {
        return true;
    }
    let mut ranges: Vec<(u64, u64)> = s
        .ranges
        .iter()
        .map(|r| (r.start.max(1), r.end.map_or(line_count, |e| e.min(line_count))))
        .filter(|(a, b)| b >= a)
        .collect();
    ranges.sort();
    let mut covered = 0;
    for (a, b) in ranges {
        if a > covered + 1 {
            break;
        }
        covered = covered.max(b);
    }
    covered >= line_count
}

pub fn is_mutation_source(source: &str) -> bool {
    source == "edit" || source.starts_with("apply_patch_")
}

/// What a caller records (`recordReadSnapshot`'s `meta`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SnapshotMeta {
    pub source: String,
    /// `None` is the whole file.
    pub ranges: Option<Vec<LineRange>>,
    pub replace_existing: bool,
    pub content_hash: Option<String>,
    pub file_line_count: Option<u64>,
    /// The target's identity just before a write, which proves the earlier read still described it.
    pub pre_mutation: Option<FileVersion>,
}

impl SnapshotMeta {
    pub fn new(source: &str) -> Self {
        Self { source: source.to_owned(), ..Self::default() }
    }
}

/// A cached `read` answer.
#[derive(Clone, Debug)]
pub struct CacheHit {
    pub value: String,
    pub meta: Option<SnapshotMeta>,
    pub prefix_hash: String,
}

struct CacheEntry {
    key: String,
    ts: u64,
    hit: CacheHit,
    paths: Vec<String>,
    bytes: usize,
}

struct Scope {
    key: String,
    files: Vec<(String, Snapshot)>,
}

#[derive(Default)]
struct Inner {
    cache: Vec<CacheEntry>,
    cache_bytes: usize,
    scopes: Vec<Scope>,
    hydrated: Vec<String>,
    persisting: Vec<String>,
}

/// Where a session's snapshots survive a restart: `read-snapshots/<scope>.json` under the plugin
/// data directory, in Node's format. Calls are blocking and are made off the async path. The store
/// also owns Node's 30-day sweep of stale scope files.
pub trait SnapshotPersist: Send + Sync {
    fn load(&self, scope: &str) -> Option<String>;
    /// `None` removes the scope's file (an empty scope leaves none behind).
    fn save(&self, scope: &str, json: Option<&str>);
}

type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

pub struct ReadState {
    inner: Arc<Mutex<Inner>>,
    clock: Clock,
    persist: Option<Arc<dyn SnapshotPersist>>,
}

impl Default for ReadState {
    fn default() -> Self {
        Self::new(None)
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn sep_prefix(path: &str) -> String {
    if path.ends_with(['/', '\\']) { path.to_owned() } else { format!("{path}/") }
}

/// `cachePathsOverlap` after path normalization (`/` separators): equal, or one holds the other.
fn paths_overlap(a: &str, b: &str) -> bool {
    a == b || a.starts_with(&sep_prefix(b)) || b.starts_with(&sep_prefix(a))
}

impl ReadState {
    pub fn new(persist: Option<Arc<dyn SnapshotPersist>>) -> Self {
        Self { inner: Arc::new(Mutex::new(Inner::default())), clock: Arc::new(now_ms), persist }
    }

    /// A state on a given clock (milliseconds), so a cache lifetime can be tested.
    pub fn with_clock(persist: Option<Arc<dyn SnapshotPersist>>, clock: Clock) -> Self {
        Self { inner: Arc::new(Mutex::new(Inner::default())), clock, persist }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Brings a session's persisted snapshots into memory on its first use (`readFilesForScope`'s
    /// lazy hydration). Only the first call per session does any work.
    pub async fn ensure_scope(&self, scope: &str) {
        let Some(persist) = self.persist.clone() else { return };
        if self.lock().hydrated.iter().any(|s| s == scope) {
            return;
        }
        let owned = scope.to_owned();
        let loaded = tokio::task::spawn_blocking(move || persist.load(&owned)).await.ok().flatten();
        let mut inner = self.lock();
        if inner.hydrated.iter().any(|s| s == scope) {
            return;
        }
        inner.hydrated.push(scope.to_owned());
        if inner.scopes.iter().all(|s| s.key != scope) {
            let files = loaded.map(|text| files_from_json(&text)).unwrap_or_default();
            inner.scopes.push(Scope { key: scope.to_owned(), files });
            self.prune(&mut inner, scope);
        }
    }

    /// Scope access order: the used scope moves to the end; past 32 the oldest is released.
    fn touch<'a>(&self, inner: &'a mut Inner, scope: &str) -> &'a mut Scope {
        match inner.scopes.iter().position(|s| s.key == scope) {
            Some(at) => {
                let s = inner.scopes.remove(at);
                inner.scopes.push(s);
            }
            None => {
                inner.hydrated.push(scope.to_owned());
                inner.scopes.push(Scope { key: scope.to_owned(), files: Vec::new() });
                self.prune(inner, scope);
            }
        }
        inner.scopes.last_mut().expect("just pushed")
    }

    fn prune(&self, inner: &mut Inner, protected: &str) {
        while inner.scopes.len() > SCOPES_IN_MEMORY {
            let Some(at) = inner.scopes.iter().position(|s| s.key != protected) else { break };
            let released = inner.scopes.remove(at);
            inner.hydrated.retain(|k| *k != released.key);
            if let Some(persist) = &self.persist {
                persist.save(&released.key, files_to_json(&released.files).as_deref());
            }
        }
    }

    /// `getReadSnapshot`.
    pub fn snapshot(&self, scope: Option<&str>, path: &str) -> Option<Snapshot> {
        let scope = scope?;
        let mut inner = self.lock();
        let s = self.touch(&mut inner, scope);
        s.files.iter().find(|(p, _)| p == path).map(|(_, snap)| snap.clone())
    }

    /// `recordReadSnapshot`.
    pub fn record(&self, scope: Option<&str>, path: &str, version: Option<FileVersion>, meta: SnapshotMeta) {
        let Some(scope) = scope else { return };
        let Some(identity) = version else { return };
        let mut inner = self.lock();
        let files = &mut self.touch(&mut inner, scope).files;
        let mutation = is_mutation_source(&meta.source);
        let incoming = meta.ranges.clone().unwrap_or_else(|| vec![LineRange::WHOLE]);
        let fresh_large = identity.size > CACHEABLE_BYTES && !mutation;
        let replace = meta.replace_existing || fresh_large;
        let prior = files.iter().find(|(p, _)| p == path).map(|(_, s)| s.clone());
        let existing = if replace { None } else { prior.clone() };
        let same_file = existing.as_ref().filter(|e| same_version(&identity, &e.version));
        let undelivered_mutation = same_file.is_some_and(|e| is_mutation_source(&e.source) && e.body_delivered != Some(true));
        let retained: Vec<LineRange> = match same_file {
            Some(e) if !undelivered_mutation => e.ranges.clone(),
            _ => Vec::new(),
        };
        let merged = merge_ranges(&[retained, incoming].concat());
        let mut next = Snapshot {
            version: identity,
            ranges: merged,
            source: meta.source.clone(),
            body_delivered: None,
            content_hash: meta.content_hash.clone(),
            grep_only: false,
            file_line_count: None,
            extra: serde_json::Map::new(),
        };
        if next.content_hash.is_none() {
            next.content_hash = same_file.and_then(|e| e.content_hash.clone());
        }
        let incoming_is_grep = meta.source == "grep";
        next.grep_only = incoming_is_grep && same_file.map_or(true, |e| e.grep_only);
        let prior_for_delivery = if fresh_large { None } else { prior.as_ref() };
        if let Some(delivered) = resolve_body_delivered(&next, &meta, prior_for_delivery, &identity, incoming_is_grep) {
            next.body_delivered = Some(delivered);
        }
        if let Some(count) = meta.file_line_count {
            next.file_line_count = Some(count);
        } else if let Some(count) = same_file.and_then(|e| e.file_line_count) {
            next.file_line_count = Some(count);
        }
        // The session keeps its newest file last; past the cap the oldest goes.
        files.retain(|(p, _)| p != path);
        files.push((path.to_owned(), next));
        while files.len() > FILES_PER_SCOPE {
            files.remove(0);
        }
        drop(inner);
        self.schedule_persist(scope);
    }

    /// `releaseReadSnapshotScope(scope, { deletePersisted: true })`: a deleted session forgets its
    /// snapshots, in memory and in the store (the `read_cache` purge hook).
    pub fn forget_session(&self, scope: &str) {
        {
            let mut inner = self.lock();
            inner.scopes.retain(|s| s.key != scope);
            inner.hydrated.retain(|k| k != scope);
        }
        if let Some(persist) = &self.persist {
            persist.save(scope, None);
        }
    }

    /// `clearReadSnapshotForPath`: the path's cached answers and every session's snapshot of it.
    pub fn forget_path(&self, path: &str) {
        self.invalidate(&[path]);
        let mut touched = Vec::new();
        {
            let mut inner = self.lock();
            for s in &mut inner.scopes {
                let before = s.files.len();
                s.files.retain(|(p, _)| p != path);
                if s.files.len() != before {
                    touched.push(s.key.clone());
                }
            }
        }
        for key in touched {
            self.schedule_persist(&key);
        }
    }

    /// `invalidateBuiltinResultCache(paths)`: cached answers about these paths (or inside, or
    /// holding them) are dropped.
    pub fn invalidate(&self, paths: &[&str]) {
        let mut inner = self.lock();
        let before = inner.cache.len();
        inner.cache.retain(|e| !e.paths.iter().any(|p| paths.iter().any(|a| paths_overlap(p, a))));
        if inner.cache.len() != before {
            inner.cache_bytes = inner.cache.iter().map(|e| e.bytes).sum();
        }
    }

    /// `cacheGetEntry`: a live entry, expiring those past 30 s.
    pub fn cache_get(&self, key: &str) -> Option<CacheHit> {
        let now = (self.clock)();
        let mut inner = self.lock();
        let at = inner.cache.iter().position(|e| e.key == key)?;
        if now.saturating_sub(inner.cache[at].ts) > CACHE_TTL_MS {
            let gone = inner.cache.remove(at);
            inner.cache_bytes = inner.cache_bytes.saturating_sub(gone.bytes);
            return None;
        }
        Some(inner.cache[at].hit.clone())
    }

    /// `cacheSet`: replace in place, refuse an entry as large as the whole budget, evict oldest.
    pub fn cache_set(&self, key: &str, value: String, paths: &[&str], meta: Option<SnapshotMeta>, prefix_hash: String) {
        let bytes = value.len();
        if bytes >= CACHE_MAX_BYTES {
            return;
        }
        let now = (self.clock)();
        let mut inner = self.lock();
        if let Some(at) = inner.cache.iter().position(|e| e.key == key) {
            let gone = inner.cache.remove(at);
            inner.cache_bytes = inner.cache_bytes.saturating_sub(gone.bytes);
        }
        inner.cache.push(CacheEntry {
            key: key.to_owned(),
            ts: now,
            hit: CacheHit { value, meta, prefix_hash },
            paths: paths.iter().map(|p| (*p).to_owned()).collect(),
            bytes,
        });
        inner.cache_bytes += bytes;
        while inner.cache.len() > CACHE_MAX_ENTRIES || inner.cache_bytes > CACHE_MAX_BYTES {
            if inner.cache.len() < 2 || inner.cache[0].key == key {
                break;
            }
            let gone = inner.cache.remove(0);
            inner.cache_bytes = inner.cache_bytes.saturating_sub(gone.bytes);
        }
    }

    /// `scheduleScopePersist`: one flush per session, 500 ms after the first change.
    fn schedule_persist(&self, scope: &str) {
        let Some(persist) = self.persist.clone() else { return };
        let Ok(handle) = tokio::runtime::Handle::try_current() else { return };
        {
            let mut inner = self.lock();
            if inner.persisting.iter().any(|s| s == scope) {
                return;
            }
            inner.persisting.push(scope.to_owned());
        }
        let owned = scope.to_owned();
        let state = Arc::clone(&self.inner);
        handle.spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(PERSIST_DEBOUNCE_MS)).await;
            let json = {
                let mut inner = state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                inner.persisting.retain(|s| *s != owned);
                inner.scopes.iter().find(|s| s.key == owned).and_then(|s| files_to_json(&s.files))
            };
            let _ = tokio::task::spawn_blocking(move || persist.save(&owned, json.as_deref())).await;
        });
    }
}

/// `resolveBodyDelivered`: whether the session has been given this file's body.
fn resolve_body_delivered(
    next: &Snapshot,
    meta: &SnapshotMeta,
    prior: Option<&Snapshot>,
    identity: &FileVersion,
    incoming_is_grep: bool,
) -> Option<bool> {
    if is_mutation_source(&meta.source) {
        let prior_paged_full = prior
            .and_then(|p| p.file_line_count.filter(|c| *c > 0).map(|c| covers_all_lines(p, c)))
            .unwrap_or(false);
        let prior_current = match (prior, meta.pre_mutation.as_ref()) {
            (Some(p), Some(pre)) => same_version(pre, &p.version),
            _ => false,
        };
        let prior_ranges_are_reads = prior.map_or(true, |p| !is_mutation_source(&p.source));
        return Some(
            prior_current
                && prior.is_some_and(|p| {
                    !p.grep_only
                        && (p.body_delivered == Some(true)
                            || (prior_ranges_are_reads && (covers_full_file(p) || prior_paged_full)))
                }),
        );
    }
    if !incoming_is_grep && covers_full_file(next) {
        return Some(true);
    }
    if prior.is_some_and(|p| p.body_delivered == Some(true) && same_version(identity, &p.version)) {
        return Some(true);
    }
    None
}

// ---- Node's persisted format ----

fn range_to_json(r: &LineRange) -> JsonValue {
    serde_json::json!({
        "startLine": r.start,
        "endLine": r.end.map_or_else(|| JsonValue::String(INFINITY_SENTINEL.to_owned()), JsonValue::from),
    })
}

fn files_to_json(files: &[(String, Snapshot)]) -> Option<String> {
    if files.is_empty() {
        return None;
    }
    let mut obj = serde_json::Map::new();
    for (path, s) in files {
        let mut o = s.extra.clone();
        o.insert("mtimeMs".into(), JsonValue::from(s.version.mtime_ms));
        o.insert("size".into(), JsonValue::from(s.version.size));
        if let Some(v) = s.version.ctime_ms {
            o.insert("ctimeMs".into(), JsonValue::from(v));
        }
        if let Some(v) = s.version.ino {
            o.insert("ino".into(), JsonValue::from(v));
        }
        if let Some(v) = s.version.dev {
            o.insert("dev".into(), JsonValue::from(v));
        }
        o.insert("ranges".into(), JsonValue::Array(s.ranges.iter().map(range_to_json).collect()));
        o.insert("source".into(), JsonValue::String(s.source.clone()));
        if let Some(v) = s.body_delivered {
            o.insert("bodyDelivered".into(), JsonValue::Bool(v));
        }
        if let Some(v) = &s.content_hash {
            o.insert("contentHash".into(), JsonValue::String(v.clone()));
        }
        o.insert("grepOnly".into(), JsonValue::Bool(s.grep_only));
        if let Some(v) = s.file_line_count {
            o.insert("fileLineCount".into(), JsonValue::from(v));
        }
        obj.insert(path.clone(), JsonValue::Object(o));
    }
    serde_json::to_string(&JsonValue::Object(obj)).ok()
}

fn files_from_json(text: &str) -> Vec<(String, Snapshot)> {
    let Ok(JsonValue::Object(obj)) = serde_json::from_str::<JsonValue>(text) else { return Vec::new() };
    let mut out = Vec::new();
    for (path, entry) in obj {
        let JsonValue::Object(mut o) = entry else { continue };
        let (Some(mtime_ms), Some(size)) = (o.remove("mtimeMs").and_then(|v| v.as_f64()), o.remove("size").and_then(|v| v.as_u64())) else {
            continue;
        };
        let ranges = match o.remove("ranges") {
            Some(JsonValue::Array(rows)) => rows
                .iter()
                .filter_map(|r| {
                    let start = r.get("startLine")?.as_u64()?;
                    let end = match r.get("endLine")? {
                        JsonValue::String(s) if s == INFINITY_SENTINEL => None,
                        other => Some(other.as_u64()?),
                    };
                    Some(LineRange { start, end })
                })
                .collect(),
            _ => Vec::new(),
        };
        let version = FileVersion {
            mtime_ms,
            size,
            ctime_ms: o.remove("ctimeMs").and_then(|v| v.as_f64()),
            ino: o.remove("ino").and_then(|v| v.as_u64()),
            dev: o.remove("dev").and_then(|v| v.as_u64()),
        };
        let source = o.remove("source").and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default();
        let body_delivered = o.remove("bodyDelivered").and_then(|v| v.as_bool());
        let content_hash = o.remove("contentHash").and_then(|v| v.as_str().map(str::to_owned));
        let grep_only = o.remove("grepOnly").and_then(|v| v.as_bool()).unwrap_or(false);
        let file_line_count = o.remove("fileLineCount").and_then(|v| v.as_u64());
        out.push((path, Snapshot { version, ranges, source, body_delivered, content_hash, grep_only, file_line_count, extra: o }));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn version(mtime: f64, size: u64) -> FileVersion {
        FileVersion { mtime_ms: mtime, size, ctime_ms: None, ino: None, dev: None }
    }

    #[test]
    fn ranges_merge_across_adjacent_lines_and_keep_an_open_end() {
        let merged = merge_ranges(&[
            LineRange { start: 5, end: Some(7) },
            LineRange { start: 1, end: Some(4) },
            LineRange { start: 10, end: None },
        ]);
        assert_eq!(merged, vec![LineRange { start: 1, end: Some(7) }, LineRange { start: 10, end: None }]);
    }

    #[test]
    fn a_full_read_then_a_partial_one_still_covers_the_file_and_a_mutation_inherits_delivery() {
        let state = ReadState::default();
        let v = version(1.0, 10);
        state.record(Some("s"), "/a", Some(v), SnapshotMeta::new("read"));
        state.record(Some("s"), "/a", Some(v), SnapshotMeta { ranges: Some(vec![LineRange { start: 2, end: Some(2) }]), ..SnapshotMeta::new("read") });
        let snap = state.snapshot(Some("s"), "/a").unwrap();
        assert!(covers_full_file(&snap));
        let after = version(2.0, 11);
        state.record(
            Some("s"),
            "/a",
            Some(after),
            SnapshotMeta { replace_existing: true, pre_mutation: Some(v), ..SnapshotMeta::new("edit") },
        );
        assert_eq!(state.snapshot(Some("s"), "/a").unwrap().body_delivered, Some(true));
        assert!(state.snapshot(None, "/a").is_none());
        assert!(state.snapshot(Some("other"), "/a").is_none());
    }

    #[test]
    fn a_mutation_of_an_unread_or_changed_file_delivers_no_body() {
        let state = ReadState::default();
        let v = version(1.0, 10);
        state.record(Some("s"), "/a", Some(version(2.0, 11)), SnapshotMeta { replace_existing: true, pre_mutation: Some(v), ..SnapshotMeta::new("edit") });
        assert_eq!(state.snapshot(Some("s"), "/a").unwrap().body_delivered, Some(false));
        state.record(Some("s"), "/b", Some(v), SnapshotMeta::new("read"));
        // The file changed under the session before the edit: the earlier read proves nothing.
        state.record(Some("s"), "/b", Some(version(9.0, 12)), SnapshotMeta { replace_existing: true, pre_mutation: Some(version(8.0, 10)), ..SnapshotMeta::new("edit") });
        assert_eq!(state.snapshot(Some("s"), "/b").unwrap().body_delivered, Some(false));
    }

    #[test]
    fn cached_answers_expire_after_30_seconds_and_die_with_their_path() {
        let now = Arc::new(std::sync::atomic::AtomicU64::new(1_000));
        let clock = Arc::clone(&now);
        let state = ReadState::with_clock(None, Arc::new(move || clock.load(std::sync::atomic::Ordering::SeqCst)));
        state.cache_set("k", "body".to_owned(), &["/d/a"], None, String::new());
        state.cache_set("j", "other".to_owned(), &["/d/b"], None, String::new());
        assert!(state.cache_get("k").is_some());
        state.invalidate(&["/d/a"]);
        assert!(state.cache_get("k").is_none());
        assert!(state.cache_get("j").is_some());
        now.store(1_000 + 30_001, std::sync::atomic::Ordering::SeqCst);
        assert!(state.cache_get("j").is_none());
    }

    #[test]
    fn snapshots_round_trip_through_node_s_file_format() {
        let state = ReadState::default();
        state.record(Some("s"), "/a", Some(version(1.5, 10)), SnapshotMeta { content_hash: Some("ab".to_owned()), ..SnapshotMeta::new("read") });
        let files = state.lock().scopes[0].files.clone();
        let text = files_to_json(&files).unwrap();
        assert!(text.contains(INFINITY_SENTINEL));
        assert_eq!(files_from_json(&text), files);
    }
}
