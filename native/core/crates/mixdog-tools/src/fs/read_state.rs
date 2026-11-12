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

/// The identity of a file's content on disk (`fileVersion`): modification time, change time, size,
/// inode and device. Times are Node's float milliseconds and the file index goes through a JS
/// number, so two stamps are equal exactly when Node's are.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FileVersion {
    pub mtime_ms: f64,
    pub size: u64,
    pub ctime_ms: Option<f64>,
    pub ino: Option<f64>,
    pub dev: Option<f64>,
}

/// libuv's `mtimeMs`: seconds times 1000 plus the nanoseconds over 1e6.
fn epoch_ms(t: std::time::SystemTime) -> f64 {
    match t.duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_secs() as f64 * 1e3 + f64::from(d.subsec_nanos()) / 1e6,
        Err(e) => -(e.duration().as_secs() as f64 * 1e3 + f64::from(e.duration().subsec_nanos()) / 1e6),
    }
}

impl FileVersion {
    pub fn of(stat: &mixdog_core_api::domain::fs::FileStat) -> Option<Self> {
        Some(Self {
            mtime_ms: epoch_ms(stat.modified?),
            size: stat.len,
            ctime_ms: stat.ctime.map(epoch_ms),
            ino: Some(stat.inode as f64),
            dev: Some(stat.device as f64),
        })
    }
}

/// `sameFileVersion`: every one of the five fields must be present on both sides and equal.
pub fn same_version(a: &FileVersion, b: &FileVersion) -> bool {
    let eq = |x: Option<f64>, y: Option<f64>| matches!((x, y), (Some(x), Some(y)) if x.is_finite() && x == y);
    a.mtime_ms.is_finite() && a.mtime_ms == b.mtime_ms && a.size == b.size && eq(a.ctime_ms, b.ctime_ms) && eq(a.ino, b.ino) && eq(a.dev, b.dev)
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
    /// Sessions with a flush timer pending, each with its generation: releasing a session cancels
    /// its timer (`persistPending`), and a timer that finds a newer generation does nothing.
    timers: Vec<(String, u64)>,
    next_timer: u64,
    /// Persistence work in the order it was asked for, run one at a time on the durability lane.
    outbox: std::collections::VecDeque<Job>,
    draining: bool,
    /// Per session, the numbers ([`Shared::marks`]) of its changes no write has taken yet: the next flush or save of the
    /// session takes them all.
    unwritten: Vec<(String, Vec<u64>)>,
}

impl Inner {
    fn take_unwritten(&mut self, scope: &str) -> Vec<u64> {
        match self.unwritten.iter().position(|(s, _)| s == scope) {
            Some(at) => self.unwritten.swap_remove(at).1,
            None => Vec::new(),
        }
    }
}

/// One unit of persistence, run on the durability lane and never under the state's mutex.
enum Job {
    /// A session's file, read for its first use.
    Load { scope: String, reply: tokio::sync::oneshot::Sender<Option<String>> },
    /// The session's snapshots as they are when the job runs (`persistScopeSync`), with the changes unwritten then.
    Flush { scope: String },
    /// A released session's last content, or its deletion (`releaseReadSnapshotScope`), and the changes it writes.
    Save { scope: String, json: Option<String>, marks: Vec<u64> },
    /// A forgotten path leaves every persisted file (`deleteReadSnapshotPathEverywhere`).
    Sweep { path: String, mark: u64 },
}

/// Where a session's snapshots survive a restart: `read-snapshots/<scope>.json` under the plugin
/// data directory, in Node's format. Calls are blocking; the state makes them only as durability
/// lane jobs. The store also owns Node's 30-day sweep of stale scope files.
pub trait SnapshotPersist: Send + Sync {
    fn load(&self, scope: &str) -> Option<String>;
    /// Every session that has a persisted file.
    fn scopes(&self) -> Vec<String>;
    /// `None` removes the scope's file (an empty scope leaves none behind).
    fn save(&self, scope: &str, json: Option<&str>);
}

/// A store, and the durability lane its calls run on.
#[derive(Clone)]
pub struct Persistence {
    store: Arc<dyn SnapshotPersist>,
    lane: mixdog_rt::DurabilityIo,
}

impl Persistence {
    pub fn new(store: Arc<dyn SnapshotPersist>, lane: mixdog_rt::DurabilityIo) -> Self {
        Self { store, lane }
    }

    async fn run<R: Send + 'static>(&self, work: impl FnOnce(&dyn SnapshotPersist) -> R + Send + 'static) -> Option<R> {
        use mixdog_rt::LaneToken;
        let store = Arc::clone(&self.store);
        let job = self.lane.submit_wait(&tokio_util::sync::CancellationToken::new(), move |_| work(store.as_ref())).await.ok()?;
        job.await.ok()
    }
}

type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

struct Shared {
    inner: Mutex<Inner>,
    clock: Clock,
    persist: Option<Persistence>,
    /// How long a change waits before its session is written.
    debounce: std::time::Duration,
    /// Signalled when the outbox has been emptied.
    idle: tokio::sync::Notify,
    /// `registerCacheInvalidationListener`: told the paths of every invalidation.
    watchers: Mutex<Vec<Arc<dyn Fn(&[String]) + Send + Sync>>>,
    /// `registerSessionPurgeHook`: told the id of every session that is closed or deleted.
    releases: Mutex<Vec<Arc<dyn Fn(&str) + Send + Sync>>>,
    /// Every change owed to the store (a session's change, a release, a path sweep) numbered as it is made, reported once
    /// the write that carries it ran.
    marks: mixdog_rt::WriteMarks,
}

pub struct ReadState {
    shared: Arc<Shared>,
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

impl Shared {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Queues persistence work and makes sure one drain task is running. With no store the work
    /// is dropped (a load answers nothing).
    fn enqueue(self: &Arc<Self>, inner: &mut Inner, job: Job) {
        if self.persist.is_none() {
            match job {
                Job::Load { reply, .. } => {
                    let _ = reply.send(None);
                }
                Job::Save { marks, .. } => marks.into_iter().for_each(|mark| self.marks.withdrawn(mark)),
                Job::Sweep { mark, .. } => self.marks.withdrawn(mark),
                Job::Flush { .. } => {}
            }
            return;
        }
        inner.outbox.push_back(job);
        self.kick(inner);
    }

    fn kick(self: &Arc<Self>, inner: &mut Inner) {
        if inner.draining || inner.outbox.is_empty() {
            return;
        }
        let Ok(handle) = tokio::runtime::Handle::try_current() else { return };
        inner.draining = true;
        let shared = Arc::clone(self);
        handle.spawn(async move { shared.drain().await });
    }

    /// Runs the outbox front to back, one job at a time, the lock held only to take a job.
    async fn drain(self: Arc<Self>) {
        let Some(persist) = self.persist.clone() else { return };
        loop {
            let job = {
                let mut inner = self.lock();
                match inner.outbox.pop_front() {
                    Some(job) => job,
                    None => {
                        inner.draining = false;
                        drop(inner);
                        self.idle.notify_waiters();
                        return;
                    }
                }
            };
            match job {
                Job::Load { scope, reply } => {
                    let text = persist.run(move |store| store.load(&scope)).await.flatten();
                    let _ = reply.send(text);
                }
                Job::Flush { scope } => {
                    let (json, marks) = {
                        let mut inner = self.lock();
                        let json = inner.scopes.iter().find(|s| s.key == scope).map(|s| files_to_json(&s.files));
                        (json, inner.take_unwritten(&scope))
                    };
                    // A session released since the flush was asked for has its own save queued, with its changes.
                    match json {
                        Some(json) => {
                            let ran = persist.run(move |store| store.save(&scope, json.as_deref())).await;
                            self.report(&marks, ran);
                        }
                        None => marks.into_iter().for_each(|mark| self.marks.withdrawn(mark)),
                    }
                }
                Job::Save { scope, json, marks } => {
                    let ran = persist.run(move |store| store.save(&scope, json.as_deref())).await;
                    self.report(&marks, ran);
                }
                Job::Sweep { path, mark } => {
                    let ran = persist
                        .run(move |store| {
                            for scope in store.scopes() {
                                let Some(text) = store.load(&scope) else { continue };
                                let Ok(JsonValue::Object(mut obj)) = serde_json::from_str::<JsonValue>(&text) else { continue };
                                if obj.shift_remove(&path).is_none() {
                                    continue;
                                }
                                if obj.is_empty() {
                                    store.save(&scope, None);
                                } else if let Ok(json) = serde_json::to_string(&JsonValue::Object(obj)) {
                                    store.save(&scope, Some(&json));
                                }
                            }
                        })
                        .await;
                    self.report(&[mark], ran);
                }
            }
        }
    }

    /// The write carrying `marks` ran (`Some`), or its lane did not run it.
    fn report(&self, marks: &[u64], ran: Option<()>) {
        for &mark in marks {
            match ran {
                Some(()) => self.marks.written(mark),
                None => self.marks.failed(mark, "the durability lane did not run the write"),
            }
        }
    }

    /// `releaseReadSnapshotScope`: the session's flush is cancelled, it leaves memory, and its last
    /// content (or, for a deleted session, nothing) is queued to be written.
    fn release(self: &Arc<Self>, inner: &mut Inner, released: Scope, delete: bool) {
        let key = released.key;
        inner.timers.retain(|(s, _)| *s != key);
        inner.outbox.retain(|job| !matches!(job, Job::Flush { scope } if *scope == key));
        inner.hydrated.retain(|k| *k != key);
        let json = if delete { None } else { files_to_json(&released.files) };
        let mut marks = inner.take_unwritten(&key);
        marks.push(self.marks.accept());
        self.enqueue(inner, Job::Save { scope: key, json, marks });
    }

    /// Scope access order: the used scope moves to the end; past 32 the oldest is released.
    fn touch<'a>(self: &Arc<Self>, inner: &'a mut Inner, scope: &str) -> &'a mut Scope {
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

    fn prune(self: &Arc<Self>, inner: &mut Inner, protected: &str) {
        while inner.scopes.len() > SCOPES_IN_MEMORY {
            let Some(at) = inner.scopes.iter().position(|s| s.key != protected) else { break };
            let released = inner.scopes.remove(at);
            self.release(inner, released, false);
        }
    }

    /// `scheduleScopePersist`: one flush per session, 500 ms after the first change.
    fn schedule_persist(self: &Arc<Self>, scope: &str) {
        if self.persist.is_none() {
            return;
        }
        let Ok(handle) = tokio::runtime::Handle::try_current() else { return };
        let generation = {
            let mut inner = self.lock();
            let mark = self.marks.accept();
            match inner.unwritten.iter_mut().find(|(s, _)| s == scope) {
                Some((_, marks)) => marks.push(mark),
                None => inner.unwritten.push((scope.to_owned(), vec![mark])),
            }
            if inner.timers.iter().any(|(s, _)| s == scope) {
                return;
            }
            inner.next_timer += 1;
            let generation = inner.next_timer;
            inner.timers.push((scope.to_owned(), generation));
            generation
        };
        let (shared, scope) = (Arc::clone(self), scope.to_owned());
        handle.spawn(async move {
            mixdog_rt::time::sleep(shared.debounce).await;
            let mut inner = shared.lock();
            // Only the timer that is still the session's own fires; a release cancelled the rest.
            if inner.timers.iter().any(|(s, g)| *s == scope && *g == generation) {
                inner.timers.retain(|(s, _)| *s != scope);
                shared.enqueue(&mut inner, Job::Flush { scope });
            }
        });
    }
}

impl ReadState {
    pub fn new(persist: Option<Persistence>) -> Self {
        Self::with_clock(persist, Arc::new(now_ms))
    }

    /// A state on a given clock (milliseconds), so a cache lifetime can be tested.
    pub fn with_clock(persist: Option<Persistence>, clock: Clock) -> Self {
        Self::build(persist, clock, std::time::Duration::from_millis(PERSIST_DEBOUNCE_MS))
    }

    fn build(persist: Option<Persistence>, clock: Clock, debounce: std::time::Duration) -> Self {
        let marks = mixdog_rt::WriteMarks::new("the read-state snapshots");
        Self { shared: Arc::new(Shared { inner: Mutex::new(Inner::default()), clock, persist, debounce, idle: tokio::sync::Notify::new(), watchers: Mutex::new(Vec::new()), releases: Mutex::new(Vec::new()), marks }) }
    }

    /// The changes' numbers: a barrier takes `accepted()` when it arrives, calls [`Self::flush_pending`], and waits for
    /// `reached` of it.
    pub fn marks(&self) -> &mixdog_rt::WriteMarks {
        &self.shared.marks
    }

    /// `registerCacheInvalidationListener(fn)`: `fn` runs with the paths of every `invalidate` (an edit, a patch, a
    /// tidy write, a rejected cached read), after the cached answers are dropped.
    pub fn on_invalidated(&self, listener: Arc<dyn Fn(&[String]) + Send + Sync>) {
        self.shared.watchers.lock().unwrap_or_else(|e| e.into_inner()).push(listener);
    }

    /// Brings a session's persisted snapshots into memory on its first use (`readFilesForScope`'s
    /// lazy hydration), through the same ordered queue as every write.
    pub async fn ensure_scope(&self, scope: &str) {
        if self.shared.persist.is_none() {
            return;
        }
        let reply = {
            let mut inner = self.shared.lock();
            if inner.hydrated.iter().any(|s| s == scope) {
                return;
            }
            let (tx, rx) = tokio::sync::oneshot::channel();
            self.shared.enqueue(&mut inner, Job::Load { scope: scope.to_owned(), reply: tx });
            rx
        };
        let loaded = reply.await.ok().flatten();
        let mut inner = self.shared.lock();
        if inner.hydrated.iter().any(|s| s == scope) {
            return;
        }
        inner.hydrated.push(scope.to_owned());
        if inner.scopes.iter().all(|s| s.key != scope) {
            let files = loaded.map(|text| files_from_json(&text)).unwrap_or_default();
            inner.scopes.push(Scope { key: scope.to_owned(), files });
            self.shared.prune(&mut inner, scope);
        }
    }

    /// Waits until every queued persistence job has run.
    pub async fn settle(&self) {
        loop {
            let notified = self.shared.idle.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let mut inner = self.shared.lock();
                if inner.outbox.is_empty() && !inner.draining {
                    return;
                }
                self.shared.kick(&mut inner);
            }
            notified.await;
        }
    }

    /// Every session waiting on its flush timer is queued to be written now.
    pub fn flush_pending(&self) {
        let mut inner = self.shared.lock();
        let pending: Vec<String> = inner.timers.drain(..).map(|(s, _)| s).collect();
        for scope in pending {
            self.shared.enqueue(&mut inner, Job::Flush { scope });
        }
    }

    /// The exit drain (`flushAllScopesSync`): every pending flush runs now, and the queue is emptied.
    pub async fn flush_all(&self) {
        self.flush_pending();
        self.settle().await;
    }

    /// `getReadSnapshot`.
    pub fn snapshot(&self, scope: Option<&str>, path: &str) -> Option<Snapshot> {
        let scope = scope?;
        let mut inner = self.shared.lock();
        let s = self.shared.touch(&mut inner, scope);
        s.files.iter().find(|(p, _)| p == path).map(|(_, snap)| snap.clone())
    }

    /// `recordReadSnapshot`.
    pub fn record(&self, scope: Option<&str>, path: &str, version: Option<FileVersion>, meta: SnapshotMeta) {
        let Some(scope) = scope else { return };
        let Some(identity) = version else { return };
        {
            let mut inner = self.shared.lock();
            let files = &mut self.shared.touch(&mut inner, scope).files;
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
        }
        self.shared.schedule_persist(scope);
    }

    /// `releaseReadSnapshotScope(scope, { deletePersisted: true })`: a deleted session forgets its
    /// snapshots, in memory and in the store (the `read_cache` purge hook).
    pub fn forget_session(&self, scope: &str) {
        self.forget_snapshots(scope);
        self.notify_released(scope);
    }

    /// `registerSessionPurgeHook` / `releaseSessionReadCaches`: `listener` runs with the id of every session that is deleted
    /// ([`forget_session`](Self::forget_session)) or closed ([`release_session`](Self::release_session)), the two points at which Node
    /// drops everything a session cached (`clearReadDedupSession` beside `releaseReadSnapshotScope`).
    pub fn on_released(&self, listener: Arc<dyn Fn(&str) + Send + Sync>) {
        self.shared.releases.lock().unwrap_or_else(|e| e.into_inner()).push(listener);
    }

    fn notify_released(&self, scope: &str) {
        let listeners: Vec<_> = self.shared.releases.lock().unwrap_or_else(|e| e.into_inner()).clone();
        for listener in listeners {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| listener(scope)));
        }
    }

    /// `releaseReadSnapshotScope(scope, { deletePersisted: true, persist: false })`: the snapshots of a session whose context was
    /// compacted away leave memory and the store (`resetReadStateAfterCompaction`). The session itself goes on.
    pub fn forget_snapshots(&self, scope: &str) {
        let mut inner = self.shared.lock();
        match inner.scopes.iter().position(|s| s.key == scope) {
            Some(at) => {
                let released = inner.scopes.remove(at);
                self.shared.release(&mut inner, released, true);
            }
            None => {
                inner.timers.retain(|(s, _)| s != scope);
                inner.outbox.retain(|job| !matches!(job, Job::Flush { scope: s } if s == scope));
                inner.hydrated.retain(|k| k != scope);
                let mut marks = inner.take_unwritten(scope);
                marks.push(self.shared.marks.accept());
                self.shared.enqueue(&mut inner, Job::Save { scope: scope.to_owned(), json: None, marks });
            }
        }
    }

    /// `releaseReadSnapshotScope(scope)` of a closing session (`session-close.mjs:releaseSessionReadCaches`):
    /// its snapshots leave memory and their last content is written, so a resumed session reads
    /// them back. (`forget_session` is the deleted session's: the stored copy goes too.)
    pub fn release_session(&self, scope: &str) {
        {
            let mut inner = self.shared.lock();
            match inner.scopes.iter().position(|s| s.key == scope) {
                Some(at) => {
                    let released = inner.scopes.remove(at);
                    self.shared.release(&mut inner, released, false);
                }
                None => {
                    inner.timers.retain(|(s, _)| s != scope);
                    inner.outbox.retain(|job| !matches!(job, Job::Flush { scope: s } if s == scope));
                    inner.hydrated.retain(|k| k != scope);
                    // A session out of memory was saved when it left, with its changes.
                    for mark in inner.take_unwritten(scope) {
                        self.shared.marks.withdrawn(mark);
                    }
                }
            }
        }
        self.notify_released(scope);
    }

    /// `clearReadSnapshotForPath`: the path's cached answers and every session's snapshot of it,
    /// in memory and in every persisted file.
    pub fn forget_path(&self, path: &str) {
        self.invalidate(&[path]);
        self.sweep_path(path);
    }

    /// `forget_path` for a caller that already invalidated the path (and so signalled it).
    pub(super) fn sweep_path(&self, path: &str) {
        let touched: Vec<String> = {
            let mut inner = self.shared.lock();
            let mut touched = Vec::new();
            for s in &mut inner.scopes {
                let before = s.files.len();
                s.files.retain(|(p, _)| p != path);
                if s.files.len() != before {
                    touched.push(s.key.clone());
                }
            }
            let mark = self.shared.marks.accept();
            self.shared.enqueue(&mut inner, Job::Sweep { path: path.to_owned(), mark });
            touched
        };
        for key in touched {
            self.shared.schedule_persist(&key);
        }
    }

    /// `invalidateBuiltinResultCache(paths)`: cached answers about these paths (or inside, or
    /// holding them) are dropped.
    pub fn invalidate(&self, paths: &[&str]) {
        self.drop_cached(paths);
        let watchers: Vec<_> = self.shared.watchers.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if watchers.is_empty() {
            return;
        }
        let paths: Vec<String> = paths.iter().map(|p| (*p).to_owned()).collect();
        for watcher in watchers {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| watcher(&paths)));
        }
    }

    /// The dropping half of [`invalidate`](Self::invalidate), for a caller whose invalidation was already announced.
    pub(super) fn drop_cached(&self, paths: &[&str]) {
        let mut inner = self.shared.lock();
        let before = inner.cache.len();
        inner.cache.retain(|e| !e.paths.iter().any(|p| paths.iter().any(|a| paths_overlap(p, a))));
        if inner.cache.len() != before {
            inner.cache_bytes = inner.cache.iter().map(|e| e.bytes).sum();
        }
    }

    /// `cacheGetEntry`: a live entry, expiring those past 30 s.
    pub fn cache_get(&self, key: &str) -> Option<CacheHit> {
        let now = (self.shared.clock)();
        let mut inner = self.shared.lock();
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
        let now = (self.shared.clock)();
        let mut inner = self.shared.lock();
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

/// A JS number: whole values print without a fraction, as `JSON.stringify` does.
fn number(v: f64) -> JsonValue {
    if v.fract() == 0.0 && v.abs() < 9.007_199_254_740_992e15 { JsonValue::from(v as i64) } else { JsonValue::from(v) }
}

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
        o.insert("mtimeMs".into(), number(s.version.mtime_ms));
        o.insert("size".into(), JsonValue::from(s.version.size));
        if let Some(v) = s.version.ctime_ms {
            o.insert("ctimeMs".into(), number(v));
        }
        if let Some(v) = s.version.ino {
            o.insert("ino".into(), number(v));
        }
        if let Some(v) = s.version.dev {
            o.insert("dev".into(), number(v));
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
        let (Some(mtime_ms), Some(size)) = (o.shift_remove("mtimeMs").and_then(|v| v.as_f64()), o.shift_remove("size").and_then(|v| v.as_u64())) else {
            continue;
        };
        let ranges = match o.shift_remove("ranges") {
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
            ctime_ms: o.shift_remove("ctimeMs").and_then(|v| v.as_f64()),
            ino: o.shift_remove("ino").and_then(|v| v.as_f64()),
            dev: o.shift_remove("dev").and_then(|v| v.as_f64()),
        };
        let source = o.shift_remove("source").and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default();
        let body_delivered = o.shift_remove("bodyDelivered").and_then(|v| v.as_bool());
        let content_hash = o.shift_remove("contentHash").and_then(|v| v.as_str().map(str::to_owned));
        let grep_only = o.shift_remove("grepOnly").and_then(|v| v.as_bool()).unwrap_or(false);
        let file_line_count = o.shift_remove("fileLineCount").and_then(|v| v.as_u64());
        out.push((path, Snapshot { version, ranges, source, body_delivered, content_hash, grep_only, file_line_count, extra: o }));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn version(mtime: f64, size: u64) -> FileVersion {
        FileVersion { mtime_ms: mtime, size, ctime_ms: Some(mtime), ino: Some(7.0), dev: Some(3.0) }
    }

    /// A store that keeps its files in memory.
    #[derive(Default)]
    struct Memory(Mutex<Vec<(String, String)>>);

    impl SnapshotPersist for Memory {
        fn load(&self, scope: &str) -> Option<String> {
            self.0.lock().unwrap().iter().find(|(s, _)| s == scope).map(|(_, j)| j.clone())
        }
        fn scopes(&self) -> Vec<String> {
            self.0.lock().unwrap().iter().map(|(s, _)| s.clone()).collect()
        }
        fn save(&self, scope: &str, json: Option<&str>) {
            let mut files = self.0.lock().unwrap();
            files.retain(|(s, _)| s != scope);
            if let Some(json) = json {
                files.push((scope.to_owned(), json.to_owned()));
            }
        }
    }

    const DEBOUNCE: std::time::Duration = std::time::Duration::from_millis(30);

    /// A state whose flush timer is short enough to wait out.
    fn persistent(store: Arc<dyn SnapshotPersist>) -> ReadState {
        let lane = mixdog_rt::testing::tokens().durability_io;
        ReadState::build(Some(Persistence::new(store, lane)), Arc::new(now_ms), DEBOUNCE)
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
    fn a_file_is_the_same_version_only_when_all_five_identity_fields_agree() {
        let base = version(5.0, 10);
        assert!(same_version(&base, &base));
        for changed in [
            FileVersion { mtime_ms: 6.0, ..base },
            FileVersion { size: 11, ..base },
            FileVersion { ctime_ms: Some(6.0), ..base },
            FileVersion { ino: Some(8.0), ..base },
            FileVersion { dev: Some(4.0), ..base },
            FileVersion { ctime_ms: None, ..base },
        ] {
            assert!(!same_version(&base, &changed), "{changed:?}");
        }
        // A stamp missing a field (a legacy persisted file) is never the same as anything.
        let legacy = FileVersion { ino: None, ..base };
        assert!(!same_version(&legacy, &legacy));
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
        let files = state.shared.lock().scopes[0].files.clone();
        let text = files_to_json(&files).unwrap();
        assert!(text.contains(INFINITY_SENTINEL));
        assert_eq!(files_from_json(&text), files);
    }

    /// 33 sessions, the first one touched earliest: it is released when the 33rd arrives.
    fn fill_past_the_scope_cap(state: &ReadState) {
        state.record(Some("s0"), "/x", Some(version(1.0, 1)), SnapshotMeta::new("read"));
        for i in 1..=SCOPES_IN_MEMORY {
            state.record(Some(&format!("s{i}")), "/y", Some(version(1.0, 1)), SnapshotMeta::new("read"));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_released_session_keeps_what_its_release_saved_when_its_flush_timer_would_have_fired() {
        let store = Arc::new(Memory::default());
        let state = persistent(store.clone());
        fill_past_the_scope_cap(&state);
        // s0's debounce timer would fire during this wait; the release cancelled it.
        mixdog_rt::time::sleep(DEBOUNCE * 4).await;
        state.settle().await;
        assert!(state.shared.lock().timers.iter().all(|(s, _)| s != "s0"), "the release cancelled the flush timer");
        let saved = store.load("s0").expect("the released session's file survives its cancelled flush");
        assert!(saved.contains("\"/x\""));
    }

    #[tokio::test]
    async fn a_released_session_loads_back_what_it_saved_in_the_order_it_was_asked() {
        let store = Arc::new(Memory::default());
        let state = persistent(store.clone());
        fill_past_the_scope_cap(&state);
        state.ensure_scope("s0").await;
        assert!(state.snapshot(Some("s0"), "/x").is_some());
    }

    #[tokio::test(start_paused = true)]
    async fn a_deleted_session_loses_its_file_and_its_pending_flush() {
        let store = Arc::new(Memory::default());
        let state = persistent(store.clone());
        state.record(Some("gone"), "/x", Some(version(1.0, 1)), SnapshotMeta::new("read"));
        state.forget_session("gone");
        mixdog_rt::time::sleep(DEBOUNCE * 4).await;
        state.settle().await;
        assert!(store.load("gone").is_none());
        assert!(state.snapshot(Some("gone"), "/x").is_none());
    }

    /// `session-close.mjs:releaseSessionReadCaches`: a closing session's snapshots leave memory
    /// and their last content is saved, where a deleted session's file goes.
    #[tokio::test(start_paused = true)]
    async fn a_closed_session_leaves_memory_but_keeps_its_file() {
        let store = Arc::new(Memory::default());
        let state = persistent(store.clone());
        state.record(Some("closed"), "/x", Some(version(1.0, 1)), SnapshotMeta::new("read"));
        state.release_session("closed");
        mixdog_rt::time::sleep(DEBOUNCE * 4).await;
        state.settle().await;
        assert!(state.shared.lock().scopes.iter().all(|s| s.key != "closed"), "gone from memory");
        assert!(store.load("closed").unwrap().contains("\"/x\""), "its file is what a resume reads");
    }

    #[tokio::test]
    async fn the_exit_drain_writes_every_session_that_is_still_waiting() {
        let store = Arc::new(Memory::default());
        let state = persistent(store.clone());
        state.record(Some("a"), "/x", Some(version(1.0, 1)), SnapshotMeta::new("read"));
        assert!(store.load("a").is_none(), "not before the debounce");
        state.flush_all().await;
        assert!(store.load("a").unwrap().contains("\"/x\""));
    }

    /// A store whose save of a held session signals its arrival and waits for its release.
    #[derive(Default)]
    struct Gated {
        files: Memory,
        gates: Mutex<Vec<(String, Arc<tokio::sync::Notify>, std::sync::mpsc::Receiver<()>)>>,
    }

    impl Gated {
        fn hold(&self, scope: &str) -> (Arc<tokio::sync::Notify>, std::sync::mpsc::Sender<()>) {
            let (arrived, (go, wait)) = (Arc::new(tokio::sync::Notify::new()), std::sync::mpsc::channel());
            self.gates.lock().unwrap().push((scope.to_owned(), arrived.clone(), wait));
            (arrived, go)
        }
    }

    impl SnapshotPersist for Gated {
        fn load(&self, scope: &str) -> Option<String> {
            self.files.load(scope)
        }
        fn scopes(&self) -> Vec<String> {
            self.files.scopes()
        }
        fn save(&self, scope: &str, json: Option<&str>) {
            let gate = {
                let mut gates = self.gates.lock().unwrap();
                gates.iter().position(|(s, _, _)| s == scope).map(|at| gates.remove(at))
            };
            if let Some((_, arrived, wait)) = gate {
                arrived.notify_one();
                let _ = wait.recv();
            }
            self.files.save(scope, json);
        }
    }

    const HELD: std::time::Duration = std::time::Duration::from_secs(10);

    /// The replay's barrier on the snapshots: a change made before it holds it until written, a change made after it, held at
    /// the store, does not.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_barrier_waits_for_the_changes_before_it_and_not_the_later_ones() {
        use futures::FutureExt;
        let store = Arc::new(Gated::default());
        let state = persistent(store.clone());
        let (before_arrived, before_go) = store.hold("before");
        let (after_arrived, after_go) = store.hold("after");
        state.record(Some("before"), "/x", Some(version(1.0, 1)), SnapshotMeta::new("read"));
        let mark = state.marks().accepted();
        state.flush_pending();
        tokio::time::timeout(HELD, before_arrived.notified()).await.expect("the earlier session's write did not start within 10 s");
        let mut settled = Box::pin(state.marks().reached(mark));
        assert!(settled.as_mut().now_or_never().is_none(), "the change from before the barrier is still unwritten");

        state.record(Some("after"), "/y", Some(version(1.0, 1)), SnapshotMeta::new("read"));
        state.flush_pending();
        before_go.send(()).expect("the write waits");
        tokio::time::timeout(HELD, after_arrived.notified()).await.expect("the later session's write did not start within 10 s");
        let answer = tokio::time::timeout(HELD, settled).await.expect("the barrier did not answer within 10 s although the earlier change was written");
        assert_eq!(answer, Ok(()));
        assert_eq!(state.marks().committed(), mark, "the later change was still unwritten when the barrier answered");
        after_go.send(()).expect("the write waits");
        state.settle().await;
    }

    /// A store whose every call asks the state a question: if the state made the call while
    /// holding its mutex, the question would never be answered.
    struct Asking {
        state: std::sync::OnceLock<Arc<ReadState>>,
        files: Mutex<Vec<(String, String)>>,
        asked: std::sync::atomic::AtomicUsize,
    }

    impl Asking {
        fn ask(&self) {
            let state = self.state.get().expect("set before use");
            let _ = state.snapshot(Some("probe"), "/p");
            self.asked.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }

    impl SnapshotPersist for Asking {
        fn load(&self, scope: &str) -> Option<String> {
            self.ask();
            self.files.lock().unwrap().iter().find(|(s, _)| s == scope).map(|(_, j)| j.clone())
        }
        fn scopes(&self) -> Vec<String> {
            self.ask();
            self.files.lock().unwrap().iter().map(|(s, _)| s.clone()).collect()
        }
        fn save(&self, scope: &str, json: Option<&str>) {
            self.ask();
            let mut files = self.files.lock().unwrap();
            files.retain(|(s, _)| s != scope);
            if let Some(json) = json {
                files.push((scope.to_owned(), json.to_owned()));
            }
        }
    }

    /// The one thread of a current-thread runtime would hang if a store call ran under the mutex.
    #[tokio::test]
    async fn persistence_runs_outside_the_state_mutex() {
        let store = Arc::new(Asking { state: std::sync::OnceLock::new(), files: Mutex::new(Vec::new()), asked: std::sync::atomic::AtomicUsize::new(0) });
        let state = Arc::new(persistent(store.clone()));
        store.state.set(Arc::clone(&state)).ok();
        fill_past_the_scope_cap(&state);
        state.ensure_scope("s0").await;
        state.forget_path("/x");
        state.forget_session("s1");
        state.flush_all().await;
        assert!(store.asked.load(std::sync::atomic::Ordering::SeqCst) >= 4);
    }

    #[tokio::test]
    async fn forgetting_a_path_rewrites_every_persisted_session_file_and_removes_an_emptied_one() {
        let one = ReadState::default();
        one.record(Some("a"), "/x", Some(version(1.0, 1)), SnapshotMeta::new("read"));
        one.record(Some("a"), "/y", Some(version(1.0, 1)), SnapshotMeta::new("read"));
        one.record(Some("b"), "/x", Some(version(1.0, 1)), SnapshotMeta::new("read"));
        let files: Vec<(String, String)> = one.shared.lock().scopes.iter().map(|s| (s.key.clone(), files_to_json(&s.files).unwrap())).collect();
        let disk = Arc::new(Memory(Mutex::new(files)));
        // A fresh process: nothing in memory, both sessions on disk.
        let state = persistent(disk.clone());
        state.forget_path("/x");
        state.settle().await;
        let left = disk.0.lock().unwrap().clone();
        assert_eq!(left.len(), 1, "session b had only /x and its file is gone");
        assert_eq!(left[0].0, "a");
        assert!(!left[0].1.contains("\"/x\"") && left[0].1.contains("\"/y\""));
    }

    /// Node: `delete obj["/a"]` on `{"/a":…,"/b":…,"/c":…}` leaves `/b` before `/c`.
    #[tokio::test]
    async fn forgetting_a_path_keeps_the_survivors_in_their_persisted_order() {
        let stored = r#"{"/a":{"mtimeMs":1,"size":1},"/b":{"mtimeMs":2,"size":2},"/c":{"mtimeMs":3,"size":3}}"#;
        let disk = Arc::new(Memory(Mutex::new(vec![("a".to_owned(), stored.to_owned())])));
        let state = persistent(disk.clone());
        state.forget_path("/a");
        state.settle().await;
        let left = disk.0.lock().unwrap().clone();
        assert_eq!(left, [("a".to_owned(), r#"{"/b":{"mtimeMs":2,"size":2},"/c":{"mtimeMs":3,"size":3}}"#.to_owned())]);
    }

    /// Node: deleting the known keys one by one from `{mtimeMs, x, y, size}` leaves `x` before `y`.
    #[test]
    fn the_unknown_keys_of_a_persisted_entry_stay_in_their_stored_order() {
        let files = files_from_json(r#"{"/a":{"mtimeMs":1,"x":1,"y":2,"size":1}}"#);
        assert_eq!(serde_json::to_string(&files[0].1.extra).unwrap(), r#"{"x":1,"y":2}"#);
    }
}
