//! The code graph's on-disk cache: what Node's `disk-cache.mjs` does for a graph, in the Rust
//! core's own format. `<dir>/manifest.json` maps a root's key to `{hash, builtAt, bytes, root}`
//! and `<dir>/<hash>.json` holds that root's parsed files, each with the size and modification
//! time it was parsed at. A build reuses a cached file only while both still match (the
//! signature check), so a stale entry never answers a query.
//!
//! The hash is the first 16 hex characters of SHA-256 over the root's key, as in Node. The key is
//! the workspace's shared path key (case-insensitive on Windows), the same everywhere. Writes are
//! debounced (250 ms), atomic (temp file then rename), merged into the manifest as it stands,
//! pruned to 24 roots and `MIXDOG_CODE_GRAPH_CACHE_MAX_MB` (default 80, at least 1) oldest first,
//! and followed by a sweep of orphaned payloads and aged temp files. Node's call-site sidecar and
//! legacy single-file cleanup have no counterpart: the Rust graph rebuilds calls with the file,
//! and Node's files are not ours.
//!
//! Every file operation here runs inside a maintenance-lane job.
#![allow(
    clippy::disallowed_types,
    clippy::disallowed_methods,
    reason = "every std::fs call here is the body of a maintenance-lane job (GraphCache::flush/load run on lanes)"
)]

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};

use mixdog_graph::outline::SymbolInfo;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::graph::{Graph, Node, inventory_signature};
use super::roots::{identity_key, path_key};

const FORMAT_VERSION: u32 = 5;
/// `CODE_GRAPH_DISK_MAX_ENTRIES`.
const MAX_ENTRIES: usize = 24;
const DEFAULT_MAX_MB: f64 = 80.0;
/// The debounce before a staged graph is written (`_scheduleDiskCodeGraphCacheFlush`).
const FLUSH_DELAY: Duration = Duration::from_millis(250);
/// A temp file younger than this may belong to a live writer (`ORPHAN_TMP_MIN_AGE_MS`).
const ORPHAN_TMP_MIN_AGE: Duration = Duration::from_millis(120_000);

/// A `&'static str` for a kind or language read back from disk. The vocabulary is a few dozen
/// words, so each distinct word is leaked once.
fn intern(word: &str) -> &'static str {
    static WORDS: OnceLock<Mutex<HashSet<&'static str>>> = OnceLock::new();
    let mut words = WORDS.get_or_init(Mutex::default).lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(known) = words.get(word) {
        return known;
    }
    let leaked: &'static str = Box::leak(word.to_owned().into_boxed_str());
    words.insert(leaked);
    leaked
}

#[derive(Serialize, Deserialize)]
pub(super) struct CachedSymbol {
    name: String,
    kind: String,
    start_line: u32,
    end_line: u32,
    start_col: u32,
    end_col: u32,
    exported: bool,
    sig: String,
    parent: String,
}

impl CachedSymbol {
    fn of(symbol: &SymbolInfo) -> Self {
        Self {
            name: symbol.name.clone(),
            kind: symbol.kind.to_owned(),
            start_line: symbol.start_line,
            end_line: symbol.end_line,
            start_col: symbol.start_col,
            end_col: symbol.end_col,
            exported: symbol.exported,
            sig: symbol.sig.clone(),
            parent: symbol.parent.clone(),
        }
    }

    pub(super) fn into_symbol(self) -> SymbolInfo {
        SymbolInfo {
            name: self.name,
            kind: intern(&self.kind),
            start_line: self.start_line,
            end_line: self.end_line,
            start_col: self.start_col,
            end_col: self.end_col,
            exported: self.exported,
            sig: self.sig,
            parent: self.parent,
        }
    }
}

/// One parsed file and the signature it was parsed at.
#[derive(Serialize, Deserialize)]
pub(super) struct CachedFile {
    pub rel: String,
    pub size: u64,
    pub mtime_ns: u64,
    /// Why the file was not indexed (`parseError`); empty when it was.
    pub(super) parse_error: String,
    pub(super) symbols: Vec<CachedSymbol>,
    pub(super) raw_imports: Vec<String>,
    pub(super) package_name: String,
    pub(super) namespace_name: String,
    pub(super) go_package_name: String,
    pub(super) top_level_types: Vec<String>,
    pub(super) tokens: Vec<String>,
    /// The Node-model bytes of the file's call sites (`None`: none were extracted); the call sites themselves are
    /// extracted from the source when a query asks.
    pub(super) calls_bytes: Option<u64>,
    /// SHA-256 (hex) of the bytes the record was parsed from; a record without one (an older schema) is parsed again.
    #[serde(default)]
    pub(super) digest: String,
}

/// A [`CachedFile`] written straight from a graph node: the token lists are borrowed, so persisting a graph copies
/// none of them. No source text is stored: queries read it from the file when they need it.
#[derive(Serialize)]
struct FileRef<'a> {
    rel: &'a str,
    size: u64,
    mtime_ns: u64,
    parse_error: &'a str,
    symbols: Vec<CachedSymbol>,
    raw_imports: &'a [String],
    package_name: &'a str,
    namespace_name: &'a str,
    go_package_name: &'a str,
    top_level_types: &'a [String],
    tokens: Vec<&'a str>,
    calls_bytes: Option<u64>,
    digest: String,
}

impl<'a> FileRef<'a> {
    /// `None` for a node with no signature (it was never read from a file).
    fn of(node: &'a Node, words: &'a [Arc<str>]) -> Option<Self> {
        let (size, mtime_ns) = node.fingerprint?;
        Some(Self {
            rel: &node.rel,
            size,
            mtime_ns,
            parse_error: &node.parse_error,
            symbols: node.symbols.iter().map(CachedSymbol::of).collect(),
            raw_imports: &node.raw_imports,
            package_name: &node.package_name,
            namespace_name: &node.namespace_name,
            go_package_name: &node.go_package_name,
            top_level_types: &node.top_level_types,
            tokens: node.tokens.iter().map(|id| &*words[*id as usize]).collect(),
            calls_bytes: node.calls_bytes,
            digest: super::graph::digest_hex(&node.digest),
        })
    }
}

/// The files of a built graph, serialised at flush time from the graph itself (no staged copy of its text).
pub(super) struct GraphFiles(pub(super) Arc<Graph>);

impl Serialize for GraphFiles {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let words = self.0.word_table();
        serializer.collect_seq(self.0.nodes.iter().filter_map(|node| FileRef::of(node, &words)))
    }
}

#[derive(Serialize, Deserialize)]
struct Payload<T> {
    version: u32,
    key: String,
    /// The [`Ledger`] lifetime the receipts are revisions of: a payload outlives the process, a ledger does not, so
    /// receipts are trusted only by the lifetime that wrote them (an older payload has none).
    #[serde(default)]
    epoch: String,
    /// The revisions of the hinted files this payload's generation processed, by file identity.
    #[serde(default)]
    receipts: Receipts,
    files: T,
}

#[derive(Serialize, Deserialize, Clone)]
struct Row {
    hash: String,
    #[serde(rename = "builtAt")]
    built_at: i64,
    bytes: u64,
    /// The root as the graph was built from it, for display: the key itself may be lowercase.
    root: String,
}

/// The write a staged graph runs at the flush.
type StagedWrite = Box<dyn FnOnce(&mut dyn io::Write) -> io::Result<()> + Send>;

struct Staged {
    root: String,
    write: StagedWrite,
    built_at: i64,
    /// The graph a queued write reads, held weakly: a staged write must not keep a graph alive that the cache evicted and no
    /// call uses (it would count against the heap budget until the flush). A graph gone by the flush is not written.
    released: Option<std::sync::Weak<Graph>>,
    generation: u64,
}

/// The bound on the heap of all held graphs. Node's `CODE_GRAPH_MEMORY_MAX_BYTES` is 48 MiB of its own estimate and it
/// keeps the newest graph past it; this bound is hard. Measured on this repository's tree (10,000 indexed files) a graph
/// weighs about 70 MiB (~7 KiB a file), so the whole tree of ~11,200 files needs ~80 and 160 holds one of up to ~22,000.
const DEFAULT_GRAPH_HEAP_MB: f64 = 160.0;
/// A held generation no call used for this long is released: the next call of its root starts from the disk cache.
const GRAPH_IDLE: Duration = Duration::from_secs(10 * 60);

/// A graph for one call: the generation that was current when its refresh published, shared by whoever holds it. It owns
/// nothing else: no permit, no gate, so a graph the cache did not retain blocks no other root's work.
#[derive(Clone)]
pub(super) struct Lease {
    pub(super) graph: Arc<Graph>,
}

impl Lease {
    /// A graph nobody else shares (one parsed from a single file).
    pub(super) fn alone(graph: Arc<Graph>) -> Self {
        Self { graph }
    }
}

impl std::ops::Deref for Lease {
    type Target = Graph;

    fn deref(&self) -> &Graph {
        &self.graph
    }
}

/// A built graph kept for reuse: Node's `_codeGraphCache` entry.
struct Held {
    key: String,
    graph: Arc<Graph>,
    /// The graph's heap bytes (it holds no source text).
    bytes: u64,
    /// When a call last took it (`GRAPH_IDLE`).
    used: Instant,
}

/// Where one call's time went in the graph work, for its trace row. Every duration is the calling thread's own for the call
/// that took it (a call's graph work runs on one lane thread; its parse workers add nothing here).
#[derive(Clone, Copy)]
pub(super) struct Timings {
    /// Waiting for the root's refresh turn.
    pub root_wait_ms: u64,
    pub inventory_ms: u64,
    /// Re-opening and digesting the indexed sources before answering.
    pub verify_ms: u64,
    pub resolver_check_ms: u64,
    pub cache_load_ms: u64,
    pub parse_ms: u64,
    pub link_ms: u64,
    /// Assembling the generation (lookups, runtime caches).
    pub assemble_ms: u64,
    /// Publishing: the held budget's decision and the synchronous `heap.note` write.
    pub admission_ms: u64,
    pub reused: usize,
    pub parsed: usize,
    pub omitted: usize,
    pub verified: usize,
    /// Whether the published generation was kept (`None`: the call took no generation).
    pub retained: Option<bool>,
    pub generation: u64,
}

impl Timings {
    const ZERO: Self = Self {
        root_wait_ms: 0,
        inventory_ms: 0,
        verify_ms: 0,
        resolver_check_ms: 0,
        cache_load_ms: 0,
        parse_ms: 0,
        link_ms: 0,
        assemble_ms: 0,
        admission_ms: 0,
        reused: 0,
        parsed: 0,
        omitted: 0,
        verified: 0,
        retained: None,
        generation: 0,
    };

    /// The durations that are the graph's own.
    pub fn graph_ms(&self) -> u64 {
        self.root_wait_ms
            + self.inventory_ms
            + self.verify_ms
            + self.resolver_check_ms
            + self.cache_load_ms
            + self.parse_ms
            + self.link_ms
            + self.assemble_ms
            + self.admission_ms
    }
}

impl Default for Timings {
    fn default() -> Self {
        Self::ZERO
    }
}

thread_local! {
    static TIMINGS: std::cell::Cell<Timings> = const { std::cell::Cell::new(Timings::ZERO) };
}

/// Adds to the calling thread's timings.
pub(super) fn note(add: impl FnOnce(&mut Timings)) {
    TIMINGS.with(|cell| {
        let mut timings = cell.get();
        add(&mut timings);
        cell.set(timings);
    });
}

/// The calling thread's timings since the last take, and a fresh start.
pub(super) fn take_timings() -> Timings {
    TIMINGS.with(|cell| cell.replace(Timings::ZERO))
}

pub(super) fn elapsed_ms(since: Instant) -> u64 {
    u64::try_from(since.elapsed().as_millis()).unwrap_or(u64::MAX)
}

/// The revisions of the hinted files an artifact processed, by file identity ([`identity_key`]).
pub(super) type Receipts = HashMap<String, u64>;

/// The hooks a test pauses the ledger with; each runs once, on the thread that reaches it.
#[cfg(test)]
#[derive(Default)]
pub(super) struct LedgerHooks {
    pub before_note: Option<Box<dyn FnOnce() + Send>>,
    pub under_note: Option<Box<dyn FnOnce() + Send>>,
    pub before_snapshot: Option<Box<dyn FnOnce() + Send>>,
    pub after_snapshot: Option<Box<dyn FnOnce() + Send>>,
}

#[derive(Default)]
struct LedgerState {
    next: u64,
    latest: HashMap<String, u64>,
}

/// The hints: the files a session tool wrote, or whose source was found not to be its record's, so their records must not
/// be reused. A hint is a revision of a canonical file path (its path key), not a message owned by a root: one revision
/// allocator and the latest revision of each path, both behind one lock, so a revision is assigned and visible at once and a
/// repeated write replaces the path's revision. Every root, whenever it is first queried, projects the same ledger; an
/// artifact (a generation, a payload) acknowledges only the exact revisions it processed ([`Receipts`]), and nothing is
/// ever removed from the ledger by acknowledging.
///
/// Revisions are numbers of this lifetime only. A payload outlives the process, so it carries the ledger's `epoch` (random
/// per lifetime) with its receipts, and receipts of another epoch are not trusted: a hinted file of such a payload is parsed.
pub(super) struct Ledger {
    epoch: String,
    state: Mutex<LedgerState>,
    #[cfg(test)]
    hooks: Mutex<LedgerHooks>,
}

impl Ledger {
    pub(super) fn new() -> Self {
        Self {
            epoch: uuid::Uuid::new_v4().simple().to_string(),
            state: Mutex::default(),
            #[cfg(test)]
            hooks: Mutex::default(),
        }
    }

    /// The one entry a notice whose location is unknown is recorded under: no identity is ever empty, so it names no file.
    /// Every root's snapshot includes it, and an artifact's reuse of any file needs its receipt for it to match.
    pub(super) const UNKNOWN: &'static str = "";

    pub(super) fn epoch(&self) -> &str {
        &self.epoch
    }

    #[cfg(test)]
    fn hook(&self, pick: fn(&mut LedgerHooks) -> &mut Option<Box<dyn FnOnce() + Send>>) {
        let hook = pick(&mut self.hooks.lock().unwrap_or_else(std::sync::PoisonError::into_inner)).take();
        if let Some(hook) = hook {
            hook();
        }
    }

    #[cfg(test)]
    pub(super) fn set_hooks(&self, hooks: LedgerHooks) {
        *self.hooks.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = hooks;
    }

    /// The file at `path` (a path key) has a new revision; returns it.
    pub(super) fn note(&self, path: &str) -> u64 {
        #[cfg(test)]
        self.hook(|h| &mut h.before_note);
        let mut state = self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        state.next += 1;
        let revision = state.next;
        #[cfg(test)]
        self.hook(|h| &mut h.under_note);
        state.latest.insert(path.to_owned(), revision);
        revision
    }

    /// How many paths have a revision.
    #[cfg(test)]
    pub(super) fn len(&self) -> usize {
        self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner).latest.len()
    }

    /// The latest revision of every path under root `key` (on a path boundary), by identity, and of [`Self::UNKNOWN`]. Non-destructive and no
    /// filesystem access: the identities were resolved when the notices were ingested. The lock is released before the
    /// caller does any work with it.
    pub(super) fn snapshot(&self, key: &str) -> Receipts {
        #[cfg(test)]
        self.hook(|h| &mut h.before_snapshot);
        let prefix = format!("{}/", key.trim_end_matches('/'));
        let state = self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let seen: Receipts = state
            .latest
            .iter()
            .filter(|(path, _)| path.as_str() == Self::UNKNOWN || path.starts_with(&prefix))
            .map(|(path, revision)| (path.clone(), *revision))
            .collect();
        drop(state);
        #[cfg(test)]
        self.hook(|h| &mut h.after_snapshot);
        seen
    }
}
pub struct GraphCache {
    dir: PathBuf,
    max_bytes: u64,
    pending: Mutex<HashMap<String, Staged>>,
    /// Built graphs, least recently used first (`_codeGraphCache`): at most `resident_max_entries` and
    /// `graph_heap_max_bytes` of real heap. A generation stays until a newer one of its root replaces it, the budget
    /// evicts it, or no call took it for `graph_idle` (`release_idle`).
    graphs: Arc<Mutex<Vec<Held>>>,
    graph_idle: Duration,
    /// An idle release is scheduled (`schedule_flush`).
    idle_scheduled: AtomicBool,
    /// One lock per root: a root's refresh (choosing its base, reconciling it with the tree, publishing) is single-flight,
    /// and the refreshes of different roots never wait on each other.
    roots: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// Files whose record must not be reused ([`Ledger`]): the session's own writes and sources found not to be their
    /// record's. The inventory is the authority on what changed; these force a re-read the stamp could not show.
    ledger: Arc<Ledger>,
    /// Numbers the generations published, so a call's row and the background write of its generation name the same one.
    generations: AtomicU64,
    /// Every graph admitted to `graphs`, with its heap bytes: one the cache evicted while a call still uses it stays
    /// alive and counts against the heap budget until that call is done.
    tracked: Mutex<Vec<(Weak<Graph>, u64)>>,
    /// Each root's last built graph as `(file-set signature, heap bytes)`, kept in `<dir>/heap.note` across restarts:
    /// what a warm asks to know whether the root's current graph would be admitted. Loaded on first use.
    heap_notes: Mutex<Option<BTreeMap<String, (u64, u64)>>>,
    graph_heap_max_bytes: u64,
    #[cfg(test)]
    builds: std::sync::atomic::AtomicUsize,
    scheduled: AtomicBool,
    /// Serialises the commit (merge, write, prune, sweep) within this core.
    commit: Mutex<()>,
    /// Node's resident graphs (`memory-cache.mjs`), least recently used first: per project root, the indexed
    /// file set's signature, the names looked up in that graph and the graph's own bytes.
    resident: Mutex<Vec<Resident>>,
    resident_max_entries: usize,
    resident_max_bytes: u64,
}

struct Resident {
    root: String,
    signature: u64,
    lookups: super::graph::Lookups,
    base_bytes: u64,
    token_index_bytes: u64,
}

impl Resident {
    /// graph-model.mjs:204 `_estimateGraphRetainedBytes`: the base graph, its token index once a query built it,
    /// and the runtime caches.
    fn retained(&self, runtime: &super::graph::Runtime) -> u64 {
        self.base_bytes + if runtime.queried { self.token_index_bytes } else { 0 } + runtime.cache_bytes()
    }
}

#[cfg(test)]
thread_local! {
    /// Runs inside a prune once every resident is measured and before any is cleared, on the pruning thread.
    static PRUNE_GATE: std::cell::RefCell<Option<Box<dyn FnMut(&[Resident])>>> = std::cell::RefCell::new(None);
}

/// memory-cache.mjs:26 `_pruneCodeGraphMemoryCache` over residents ordered oldest first: past the byte budget the
/// oldest graphs first lose their runtime caches (the lookups among them), then graphs other than the newest leave;
/// past the entry budget the oldest leave. Returns the retained bytes left, as Node's `totalRetainedBytes`.
///
/// Node measures and evicts in one stretch of its single thread; here every resident's runtime caches stay locked from
/// the first measure to the last clear, so a query on another thread waits instead of filling them in between.
fn prune_resident(all: &mut Vec<Resident>, max_entries: usize, max_bytes: u64) -> u64 {
    let mut total;
    let mut rows: Vec<u64>;
    {
        let mut runtimes: Vec<_> = all.iter().map(|r| r.lookups.lock().unwrap_or_else(std::sync::PoisonError::into_inner)).collect();
        rows = all.iter().zip(&runtimes).map(|(r, runtime)| r.retained(runtime)).collect();
        total = rows.iter().sum::<u64>();
        #[cfg(test)]
        PRUNE_GATE.with(|gate| {
            if let Some(gate) = gate.borrow_mut().as_mut() {
                gate(all);
            }
        });
        for ((r, runtime), row) in all.iter().zip(runtimes.iter_mut()).zip(rows.iter_mut()) {
            if total <= max_bytes {
                break;
            }
            runtime.clear();
            let after = r.retained(runtime);
            total -= row.saturating_sub(after);
            *row = after;
        }
    }
    let newest = all.len().saturating_sub(1);
    let keep: Vec<bool> = rows
        .iter()
        .enumerate()
        .map(|(index, row)| {
            let keep = total <= max_bytes || index == newest;
            if !keep {
                total -= row;
            }
            keep
        })
        .collect();
    let mut kept = keep.iter();
    all.retain(|_| kept.next() == Some(&true));
    let mut kept = keep.iter();
    rows.retain(|_| kept.next() == Some(&true));
    let excess = all.len().saturating_sub(max_entries);
    all.drain(..excess);
    total - rows.drain(..excess).sum::<u64>()
}

/// `<first 16 hex of SHA-256(key)>`.
fn hash_of(key: &str) -> String {
    let digest = Sha256::digest(key.as_bytes());
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

fn is_cache_hash(value: &str) -> bool {
    (8..=64).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_hexdigit())
}

/// A temp name of [`write_atomic`]: `<name>.mixdog-tmp-<16 hex>`.
pub fn is_tmp_name(name: &str) -> bool {
    name.rsplit_once(".mixdog-tmp-").is_some_and(|(_, hex)| (16..=24).contains(&hex.len()) && hex.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// A writer that refuses bytes past `left`, so a payload over its budget is abandoned as it is written, never stored.
struct Limited<'a, W: io::Write> {
    inner: W,
    left: u64,
    over: &'a std::cell::Cell<bool>,
}

impl<W: io::Write> io::Write for Limited<'_, W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if buf.len() as u64 > self.left {
            self.over.set(true);
            return Err(io::Error::other("payload over its budget"));
        }
        // Only what the inner writer took is spent: a partial write leaves the rest of the request to the retry.
        let written = self.inner.write(buf)?;
        self.left -= written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// Streams `fill` into a temp file and renames it over `path`; returns the bytes written, or `None` (nothing stored)
/// when it would pass `limit`.
fn write_atomic_with(path: &Path, limit: u64, fill: impl FnOnce(&mut dyn io::Write) -> io::Result<()>) -> io::Result<Option<u64>> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = path.with_file_name(format!("{name}.mixdog-tmp-{}", &uuid::Uuid::new_v4().simple().to_string()[..16]));
    let over = std::cell::Cell::new(false);
    let written = (|| {
        let file = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        let mut out = Limited { inner: io::BufWriter::new(file), left: limit, over: &over };
        fill(&mut out)?;
        let file = out.inner.into_inner().map_err(io::IntoInnerError::into_error)?;
        file.sync_all()?;
        let len = file.metadata()?.len();
        drop(file);
        std::fs::rename(&tmp, path)?;
        Ok(Some(len))
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    match written {
        Err(_) if over.get() => Ok(None),
        other => other,
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    write_atomic_with(path, u64::MAX, |out| io::Write::write_all(out, bytes)).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(rel: &str, text: &str) -> CachedFile {
        CachedFile {
            rel: rel.to_owned(),
            size: text.len() as u64,
            mtime_ns: 5,
            parse_error: String::new(),
            symbols: Vec::new(),
            // Stands in for a payload of `text`'s size.
            raw_imports: vec![text.to_owned()],
            package_name: String::new(),
            namespace_name: String::new(),
            go_package_name: String::new(),
            top_level_types: Vec::new(),
            tokens: vec!["a".to_owned()],
            calls_bytes: None,
            digest: String::new(),
        }
    }

    /// A writer that takes three bytes at most per call.
    struct Trickle(Vec<u8>);

    impl io::Write for Trickle {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            let taken = buf.len().min(3);
            self.0.extend_from_slice(&buf[..taken]);
            Ok(taken)
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn a_partial_write_spends_only_the_bytes_the_writer_took() {
        let over = std::cell::Cell::new(false);
        let mut out = Limited { inner: Trickle(Vec::new()), left: 10, over: &over };
        io::Write::write_all(&mut out, &[7; 10]).unwrap();
        assert!(!over.get(), "ten bytes fit a limit of ten however the writer split them");
        assert_eq!(out.inner.0.len(), 10);
    }

    fn root(base: &Path, name: &str) -> PathBuf {
        let root = base.join(name);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn a_staged_root_is_written_listed_loaded_and_forgotten() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = GraphCache::new(tmp.path().join("cache"));
        let proj = root(tmp.path(), "Proj");
        assert!(cache.roots().is_empty());
        cache.stage(&proj, vec![file("a.mjs", "export const a = 1;")]);
        assert!(cache.load(&proj).is_none(), "nothing is readable before the flush");
        cache.flush().unwrap();
        assert_eq!(cache.roots(), vec![proj.clone()], "the root is listed as it was built");
        let loaded = cache.load(&proj).unwrap();
        assert_eq!(loaded["a.mjs"].raw_imports, ["export const a = 1;"]);
        assert_eq!((loaded["a.mjs"].size, loaded["a.mjs"].mtime_ns), (19, 5));
        let (removed, kept) = cache.forget(&proj);
        assert!(kept.is_empty() && removed.len() == 2, "{removed:?}");
        assert!(cache.roots().is_empty() && cache.load(&proj).is_none());
    }

    #[test]
    fn one_key_names_a_root_however_its_case_and_separators_are_written() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = GraphCache::new(tmp.path().join("cache"));
        let proj = root(tmp.path(), "Proj");
        cache.stage(&proj, vec![file("a.mjs", "x")]);
        cache.flush().unwrap();
        let spelled = PathBuf::from(format!("{}/", proj.to_string_lossy().replace('\\', "/")));
        assert!(cache.load(&spelled).is_some());
        let shouted = PathBuf::from(proj.to_string_lossy().to_uppercase());
        // Only a filesystem that finds the shouted spelling (Windows, a default macOS volume) names the same root by it.
        assert_eq!(cache.load(&shouted).is_some(), shouted.exists());
    }

    #[test]
    fn the_budget_drops_the_oldest_builds_and_the_sweep_removes_their_payloads() {
        let tmp = tempfile::tempdir().unwrap();
        let big = "x".repeat(600 * 1024);
        let cache = GraphCache::new(tmp.path().join("cache")).with_max_bytes(1024 * 1024);
        let roots: Vec<PathBuf> = (0..3).map(|n| root(tmp.path(), &format!("r{n}"))).collect();
        for r in &roots {
            cache.stage(r, vec![file("a.mjs", &big)]);
            cache.flush().unwrap();
            std::thread::sleep(Duration::from_millis(5));
        }
        let listed = cache.roots();
        assert_eq!(listed, vec![roots[2].clone()], "only the newest fits 1 MB");
        let payloads = std::fs::read_dir(tmp.path().join("cache")).unwrap().flatten().filter(|e| e.file_name().to_string_lossy() != "manifest.json").count();
        assert_eq!(payloads, 1, "evicted payloads are swept");
    }

    /// A payload over the disk budget is abandoned as it is written: it is not stored, and does not push the roots
    /// already cached out of the budget (writing it and pruning afterwards would).
    #[test]
    fn a_payload_over_the_disk_budget_is_never_stored_and_evicts_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = GraphCache::new(tmp.path().join("cache")).with_max_bytes(1024 * 1024);
        let (small, big) = (root(tmp.path(), "small"), root(tmp.path(), "big"));
        cache.stage(&small, vec![file("a.mjs", "x")]);
        cache.flush().unwrap();
        cache.stage(&big, vec![file("a.mjs", &"y".repeat(2 * 1024 * 1024))]);
        cache.flush().unwrap();
        assert_eq!(cache.roots(), vec![small.clone()]);
        assert!(cache.load(&big).is_none() && cache.load(&small).is_some());
        let files: Vec<_> = std::fs::read_dir(tmp.path().join("cache")).unwrap().flatten().collect();
        assert_eq!(files.len(), 2, "manifest and the small payload only: {files:?}");
    }

    #[test]
    fn a_damaged_manifest_or_payload_reads_as_no_cache_and_orphans_are_swept() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("cache");
        let cache = GraphCache::new(dir.clone());
        let proj = root(tmp.path(), "p");
        cache.stage(&proj, vec![file("a.mjs", "x")]);
        cache.flush().unwrap();
        std::fs::write(dir.join(format!("{}.json", hash_of(&identity_key(&proj).unwrap()))), "{ torn").unwrap();
        assert!(cache.load(&proj).is_none(), "a torn payload is not trusted");
        std::fs::write(dir.join("0123456789abcdef.json"), "{}").unwrap();
        std::fs::write(dir.join("manifest.json"), "{ torn").unwrap();
        assert!(cache.roots().is_empty(), "a torn manifest lists nothing");
        let other = root(tmp.path(), "q");
        cache.stage(&other, vec![file("a.mjs", "y")]);
        cache.flush().unwrap();
        assert!(!dir.join("0123456789abcdef.json").exists(), "an unreferenced payload is swept");
    }

    /// Two calls on one resident graph: a prune (the end of one call) and a query of another call that starts on the
    /// graph (its token index built) while the prune has measured and not yet cleared. As on Node's single thread the
    /// query cannot change what the prune measured: it waits, the prune's accounting stays whole, and the bytes it
    /// reports are the residents' as it leaves them.
    #[test]
    fn a_query_starting_on_a_graph_while_it_is_pruned_waits_for_the_prune() {
        let tmp = tempfile::tempdir().unwrap();
        let mut cache = GraphCache::new(tmp.path().join("cache"));
        let old = cache.lookups_for("old", 1, || (100, 5_000));
        cache.lookups_for("new", 2, || (2_000, 0));
        cache.resident_max_bytes = 1_000;
        let gate_old = old.clone();
        let query = Arc::new(Mutex::new(None));
        let seen = query.clone();
        PRUNE_GATE.with(|gate| {
            *gate.borrow_mut() = Some(Box::new(move |_: &[Resident]| {
                let lookups = gate_old.clone();
                // The other call, on a thread of its own: it takes the graph's runtime caches if it can.
                let started = std::thread::spawn(move || match lookups.try_lock() {
                    Ok(mut runtime) => {
                        runtime.queried = true;
                        true
                    }
                    Err(_) => false,
                })
                .join()
                .unwrap();
                *seen.lock().unwrap() = Some(started);
            }));
        });
        let total = {
            let mut all = cache.resident.lock().unwrap();
            let total = prune_resident(&mut all, cache.resident_max_entries, cache.resident_max_bytes);
            let left: u64 = all.iter().map(|r| r.retained(&r.lookups.lock().unwrap())).sum();
            assert_eq!(total, left, "the bytes reported are the residents' as the prune left them");
            assert_eq!(all.iter().map(|r| r.root.as_str()).collect::<Vec<_>>(), ["new"]);
            total
        };
        PRUNE_GATE.with(|gate| *gate.borrow_mut() = None);
        assert_eq!(*query.lock().unwrap(), Some(false), "the query waited for the prune");
        assert!(!old.lock().unwrap().queried, "nothing reached the graph's caches during the prune");
        assert!(total > cache.resident_max_bytes, "the newest graph stays over the budget");
        // The query goes on once the prune is done.
        old.lock().unwrap().queried = true;
    }

    /// `constants.mjs:26`: `MIXDOG_CODE_GRAPH_CACHE_MAX_MB || 80` megabytes of disk cache.
    #[test]
    fn the_disk_cache_default_is_eighty_megabytes() {
        if std::env::var_os("MIXDOG_CODE_GRAPH_CACHE_MAX_MB").is_none() {
            assert_eq!(GraphCache::new(PathBuf::from("unused")).max_bytes, 80 * 1024 * 1024);
        }
    }
    /// The cleanup of a removed worktree's root (`cache-cleanups.mjs`, `code-graph`: `forgetCodeGraphStateRoot` and
    /// `forgetDiskCodeGraphRoot`): its resident graph, manifest row and payload go on the lane; another root keeps all of its own.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_removed_roots_cache_is_forgotten_with_its_resident_graph_and_no_other_roots() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = Arc::new(GraphCache::new(tmp.path().join("cache")));
        let (gone, stays) = (root(tmp.path(), "Gone"), root(tmp.path(), "Stays"));
        for proj in [&gone, &stays] {
            cache.stage(proj, vec![file("a.mjs", "export const a = 1;")]);
            cache.lookups_for(&identity_key(proj).unwrap(), 1, || (10, 0));
        }
        cache.flush().unwrap();
        let lane = mixdog_rt::testing::tokens().maintenance_io;
        let (removed, kept) = cache.forget_root(lane, &tokio_util::sync::CancellationToken::new(), &gone).await.unwrap();
        assert!(kept.is_empty(), "{kept:?}");
        assert!(removed.iter().any(|name| name.starts_with("resident-graph:")) && removed.iter().any(|name| name.starts_with("manifest:")), "{removed:?}");
        assert_eq!(cache.roots(), vec![stays.clone()]);
        assert!(cache.load(&gone).is_none() && cache.load(&stays).is_some());
        let resident: Vec<String> = cache.resident.lock().unwrap().iter().map(|entry| entry.root.clone()).collect();
        assert_eq!(resident, [identity_key(&stays).unwrap()]);
        // Nothing left to forget: nothing removed, nothing kept.
        assert_eq!(cache.forget_root(lane, &tokio_util::sync::CancellationToken::new(), &gone).await.unwrap(), (Vec::new(), Vec::new()));
    }
}

/// The held key of `key`'s root scoped to leave out `excluded`, whatever their order.
fn scoped_key(key: &str, excluded: &[PathBuf]) -> String {
    let mut paths: Vec<String> = excluded.iter().map(|path| path.to_string_lossy().into_owned()).collect();
    paths.sort();
    paths.dedup();
    let mut held = format!("{key}\u{0}scoped");
    for path in paths {
        held.push('\u{0}');
        held.push_str(&path);
    }
    held
}

/// `Math.max(min, Math.floor(Number(process.env[name]) || fallback))`.
fn env_count(name: &str, fallback: f64, min: f64) -> f64 {
    let parsed = std::env::var(name).ok().map(|raw| mixdog_js::string_to_number(&raw)).filter(|n| *n != 0.0 && !n.is_nan()).unwrap_or(fallback);
    parsed.max(min)
}
fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}
impl GraphCache {
    /// A cache under `dir` (created on the first write).
    pub fn new(dir: PathBuf) -> Self {
        let mb = std::env::var("MIXDOG_CODE_GRAPH_CACHE_MAX_MB").ok().and_then(|v| v.trim().parse::<f64>().ok()).filter(|v| *v > 0.0).unwrap_or(DEFAULT_MAX_MB);
        Self {
            dir,
            max_bytes: ((mb * 1024.0 * 1024.0).floor() as u64).max(1024 * 1024),
            pending: Mutex::default(),
            graphs: Arc::default(),
            graph_idle: GRAPH_IDLE,
            idle_scheduled: AtomicBool::new(false),
            roots: Mutex::default(),
            ledger: Arc::new(Ledger::new()),
            generations: AtomicU64::new(0),
            tracked: Mutex::default(),
            heap_notes: Mutex::new(None),
            graph_heap_max_bytes: (env_count("MIXDOG_CODE_GRAPH_HEAP_MAX_MB", DEFAULT_GRAPH_HEAP_MB, 1.0) * 1024.0 * 1024.0).floor() as u64,
            #[cfg(test)]
            builds: std::sync::atomic::AtomicUsize::new(0),
            scheduled: AtomicBool::new(false),
            commit: Mutex::new(()),
            resident: Mutex::default(),
            // `CODE_GRAPH_MEMORY_MAX_ENTRIES` and `CODE_GRAPH_MEMORY_MAX_BYTES`.
            resident_max_entries: env_count("MIXDOG_CODE_GRAPH_MEMORY_MAX_ENTRIES", 6.0, 1.0).floor().max(1.0) as usize,
            resident_max_bytes: (env_count("MIXDOG_CODE_GRAPH_MEMORY_MAX_MB", 48.0, 0.0) * 1024.0 * 1024.0).floor().max(1024.0 * 1024.0) as u64,
        }
    }

    /// The runtime caches of `root`'s resident graph: kept while the graph stays resident over the indexed file set it
    /// was built for (Node's `_touchCodeGraphCache`: the root becomes the newest); a graph built over a changed set, or
    /// after its root was evicted, starts with none and is measured (`measure`: base and token index bytes) as Node's
    /// `_setCodeGraphCache` adds it, then the residents are pruned.
    pub(super) fn lookups_for(&self, root: &str, signature: u64, measure: impl FnOnce() -> (u64, u64)) -> super::graph::Lookups {
        let mut all = self.resident.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let kept = all.iter().position(|r| r.root == root).map(|at| all.remove(at));
        if let Some(entry) = kept.filter(|r| r.signature == signature) {
            let lookups = entry.lookups.clone();
            all.push(entry);
            return lookups;
        }
        let (base_bytes, token_index_bytes) = measure();
        let lookups = super::graph::Lookups::default();
        all.push(Resident { root: root.to_owned(), signature, lookups: lookups.clone(), base_bytes, token_index_bytes });
        prune_resident(&mut all, self.resident_max_entries, self.resident_max_bytes);
        lookups
    }

    /// The next generation of `root` takes over its resident entry: the names looked up in the previous one stay known.
    pub(super) fn carry_lookups(&self, root: &str, from: u64, to: u64) -> Option<super::graph::Lookups> {
        let mut all = self.resident.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let resident = all.iter_mut().find(|r| r.root == root && r.signature == from)?;
        resident.signature = to;
        Some(resident.lookups.clone())
    }

    /// dispatch.mjs:377: every call ends with the resident graphs pruned, the runtime caches it filled counted.
    pub(super) fn prune_after_call(&self) {
        let mut all = self.resident.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        prune_resident(&mut all, self.resident_max_entries, self.resident_max_bytes);
        drop(all);
        self.prune_graphs(&mut self.graphs.lock().unwrap_or_else(std::sync::PoisonError::into_inner));
    }

    /// Drops the oldest while the heap budget or the entry count is exceeded. A dropped graph a
    /// call still uses keeps counting (`retired_bytes`), so the budget holds for what is alive, not for what is listed.
    fn prune_graphs(&self, all: &mut Vec<Held>) {
        while !all.is_empty() {
            let total = all.iter().map(|h| h.bytes).sum::<u64>() + self.retired_bytes(all);
            if total <= self.graph_heap_max_bytes && all.len() <= self.resident_max_entries {
                break;
            }
            all.remove(0);
        }
    }

    /// Heap bytes of the admitted graphs that are no longer in `all` but are alive: a call is still using them.
    fn retired_bytes(&self, all: &[Held]) -> u64 {
        let mut tracked = self.tracked.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        tracked.retain(|(graph, _)| graph.strong_count() > 0);
        tracked.iter().filter(|(graph, _)| !all.iter().any(|h| std::ptr::eq(Arc::as_ptr(&h.graph), graph.as_ptr()))).map(|(_, bytes)| bytes).sum()
    }

    /// The one admission rule: a graph of `bytes` is kept when it fits the heap budget beside every graph still
    /// alive that is not in `all`. Holding a built graph and warming a root both ask it.
    fn admits(&self, bytes: u64, all: &[Held]) -> bool {
        bytes + self.retired_bytes(all) <= self.graph_heap_max_bytes
    }

    /// The graph of `root` as its tree is now. Before answering, the held generation is reconciled with the current
    /// eligible files and resolver inputs, whoever changed them: files added or changed are parsed, files gone or no longer
    /// eligible are left out, the links are made again over the result, and the new generation replaces the old in one
    /// step. A file that did not change keeps its parse. Nothing drops a graph because a file changed. The refresh is
    /// single-flight per root (a second caller of the root waits its turn and then finds the published generation current);
    /// other roots proceed independently, and persistence happens after the call, outside this turn. A scoped build
    /// (`excluded` roots) is never held, as Node's `cache: false`.
    pub(super) fn graph(&self, root: &Path, excluded: &[PathBuf]) -> Result<Lease, String> {
        if !excluded.is_empty() {
            let key = identity_key(root)?;
            let held = scoped_key(&key, excluded);
            let lock = self.root_lock(&held);
            let waited = Instant::now();
            let _turn = lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            note(|t| t.root_wait_ms += elapsed_ms(waited));
            return self.reconcile_scoped(root, &key, &held, excluded).map(|graph| Lease { graph });
        }
        let key = identity_key(root)?;
        let lock = self.root_lock(&key);
        let waited = Instant::now();
        let _turn = lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        note(|t| t.root_wait_ms += elapsed_ms(waited));
        self.reconcile(root, &key).map(|graph| Lease { graph })
    }

    /// One refresh, inside the root's turn: the inventory of the tree, the base chosen once, the generation made over it
    /// and published.
    fn reconcile(&self, root: &Path, key: &str) -> Result<Arc<Graph>, String> {
        // The hints before the inventory: a write noted after this snapshot is not acknowledged by this refresh, and one
        // noted before it has its bytes in the inventory that follows.
        let hints = self.ledger.snapshot(key);
        let entries = Graph::inventory(root, key, &[])?;
        self.reconcile_over(root, key, hints, entries)
    }

    /// [`reconcile`](Self::reconcile) over an inventory taken after `hints` were: a warm's, which measured the tree with it.
    fn reconcile_over(&self, root: &Path, key: &str, hints: Receipts, entries: Vec<super::graph::Entry>) -> Result<Arc<Graph>, String> {
        let signature = inventory_signature(&entries);
        let base = self.current(key);
        if let Some(base) = &base
            && base.signature == signature
            && hints.iter().all(|(identity, revision)| base.receipts.get(identity) == Some(revision))
            && base.is_fresh()
        {
            note(|t| t.retained = Some(true));
            return Ok(base.clone());
        }
        #[cfg(test)]
        self.builds.fetch_add(1, Ordering::SeqCst);
        let graph = match &base {
            Some(base) => base.refreshed(key, &entries, &hints, self)?,
            None => Graph::first(root, key, &entries, &hints, self)?,
        };
        // The old generation no longer counts against the budget the new one is admitted under (unless a call still uses it).
        drop(base);
        let generation = self.generations.fetch_add(1, Ordering::SeqCst) + 1;
        let admitting = Instant::now();
        let kept = self.hold(key.to_owned(), graph.clone());
        note(|t| {
            t.admission_ms += elapsed_ms(admitting);
            t.retained = Some(kept);
            t.generation = generation;
        });
        if kept {
            // Only a generation the cache keeps is queued for the disk: what is staged stays alive until it is written, so
            // staging a graph over the budget would keep it in memory beside the budget.
            if !graph.unchanged {
                self.stage_held(root, key, &graph, generation);
            }
        } else {
            tracing::info!(
                target: "code_graph",
                root = %root.display(),
                generation,
                bytes = graph.base_heap_bytes(),
                budget = self.graph_heap_max_bytes,
                "code_graph generation not retained: over the held budget (an estimate); it serves this query and is rebuilt on the next"
            );
        }
        Ok(graph)
    }

    /// [`reconcile`](Self::reconcile) of a scoped build (`root` minus its nested project roots `excluded`), held in memory
    /// under `held` and never written to the disk (the disk copy is the whole root's): the next call over the same scope
    /// refreshes it as a whole root's generation is refreshed, by the same fingerprints, hints and resolver inputs, instead
    /// of parsing every file again.
    fn reconcile_scoped(&self, root: &Path, key: &str, held: &str, excluded: &[PathBuf]) -> Result<Arc<Graph>, String> {
        let hints = self.ledger.snapshot(key);
        let entries = Graph::inventory(root, key, excluded)?;
        let signature = inventory_signature(&entries);
        let base = self.current(held);
        if let Some(base) = &base
            && base.signature == signature
            && hints.iter().all(|(identity, revision)| base.receipts.get(identity) == Some(revision))
            && base.is_fresh()
        {
            note(|t| t.retained = Some(true));
            return Ok(base.clone());
        }
        #[cfg(test)]
        self.builds.fetch_add(1, Ordering::SeqCst);
        let graph = match &base {
            Some(base) => base.refreshed(key, &entries, &hints, self)?,
            None => Graph::scoped(root, key, &entries)?,
        };
        drop(base);
        let kept = self.hold_with(held.to_owned(), graph.clone(), false);
        note(|t| t.retained = Some(kept));
        Ok(graph)
    }

    pub(super) fn ledger(&self) -> Arc<Ledger> {
        self.ledger.clone()
    }

    fn root_lock(&self, key: &str) -> Arc<Mutex<()>> {
        self.roots.lock().unwrap_or_else(std::sync::PoisonError::into_inner).entry(key.to_owned()).or_insert_with(|| Arc::new(Mutex::new(()))).clone()
    }

    /// The warm of a project: loads its graph only when the same admission rule that would keep it says it is kept.
    /// What the rule needs is a graph's weight, which only a built graph has: the note of the root's last build
    /// (kept across restarts) gives it for the files the root has now, and no note for the current files means no
    /// speculative work: the first foreground query builds and records.
    pub(super) fn prewarm(&self, root: &Path) {
        let Ok(key) = identity_key(root) else { return };
        // The hints before the inventory, as a refresh takes them: the warm's refresh is made over this inventory, not a second walk.
        let hints = self.ledger.snapshot(&key);
        let Ok(entries) = Graph::inventory(root, &key, &[]) else { return };
        let signature = inventory_signature(&entries);
        let Some((noted, bytes)) = self.heap_note(&key) else { return };
        let admitted = noted == signature && self.admits(bytes, &self.graphs.lock().unwrap_or_else(std::sync::PoisonError::into_inner));
        if admitted {
            let lock = self.root_lock(&key);
            let _turn = lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            let _ = self.reconcile_over(root, &key, hints, entries);
        }
    }

    fn note_path(&self) -> PathBuf {
        self.dir.join("heap.note")
    }

    /// `(signature, heap bytes)` of `key`'s last built graph.
    fn heap_note(&self, key: &str) -> Option<(u64, u64)> {
        let mut notes = self.heap_notes.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        notes
            .get_or_insert_with(|| std::fs::read(self.note_path()).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default())
            .get(key)
            .copied()
    }

    /// Notes what `key`'s graph over the files of `signature` weighs.
    fn record_heap(&self, key: &str, signature: u64, bytes: u64) {
        self.heap_note(key);
        let mut notes = self.heap_notes.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(notes) = notes.as_mut() else { return };
        if notes.insert(key.to_owned(), (signature, bytes)) == Some((signature, bytes)) {
            return;
        }
        while notes.len() > MAX_ENTRIES * 4 {
            notes.pop_first();
        }
        if std::fs::create_dir_all(&self.dir).is_ok() {
            let _ = write_atomic(&self.note_path(), &serde_json::to_vec(&*notes).unwrap_or_default());
        }
    }

    /// Files the session's own tools wrote (`ReadState`'s invalidation signal): a hint that their records must be parsed
    /// again, a new revision of each path in the [`Ledger`], which every root, queried before or after, projects. The
    /// inventory decides what else changed; a hint covers what the clock's granularity cannot show.
    ///
    /// Each path is identified by its link-resolved location ([`identity_key`]) outside the ledger's lock. A path that
    /// cannot be resolved has no identity to key a hint by, and none is invented from its spelling: the change is at an
    /// unknown location, so it is a new revision of [`Ledger::UNKNOWN`], which every root projects and which keeps any
    /// record from being reused unverified until a refresh has processed it. It is also reported (a `warn` event).
    pub fn note_changed(&self, paths: &[String]) {
        for (path, why) in self.note_resolved(paths) {
            tracing::warn!(target: "code_graph", path = %path, reason = %why, "code_graph: the written path has no resolvable identity; every root parses its files again once");
        }
    }

    /// [`note_changed`](Self::note_changed) returning the paths it could not identify, with why.
    pub(super) fn note_resolved(&self, paths: &[String]) -> Vec<(String, String)> {
        let mut unresolved = Vec::new();
        for path in paths {
            match identity_key(Path::new(path)) {
                Ok(identity) => {
                    self.ledger.note(&identity);
                }
                Err(why) => {
                    self.ledger.note(Ledger::UNKNOWN);
                    unresolved.push((path.clone(), why));
                }
            }
        }
        unresolved
    }

    /// The generation held for `key` (now the newest).
    fn current(&self, key: &str) -> Option<Arc<Graph>> {
        let mut all = self.graphs.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let at = all.iter().position(|h| h.key == key)?;
        let mut entry = all.remove(at);
        entry.used = Instant::now();
        let graph = entry.graph.clone();
        all.push(entry);
        Some(graph)
    }

    /// Publishes `graph` as its root's generation, replacing the previous one in one step under the lock; `false` when it
    /// does not fit the heap budget beside the graphs still alive (it serves the call that made it and is not kept: the
    /// answer is the same, only the next call starts from the disk cache). What it weighs is noted for the warm.
    fn hold(&self, key: String, graph: Arc<Graph>) -> bool {
        self.hold_with(key, graph, true)
    }

    /// [`hold`](Self::hold); `noted`: its weight is noted for the warm (a whole root's, which a warm loads; not a scope's).
    fn hold_with(&self, key: String, graph: Arc<Graph>, noted: bool) -> bool {
        let bytes = graph.base_heap_bytes();
        if noted {
            self.record_heap(&key, graph.signature, bytes);
        }
        let mut all = self.graphs.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        all.retain(|h| h.key != key);
        if !self.admits(bytes, &all) {
            return false;
        }
        let weak = Arc::downgrade(&graph);
        all.push(Held { key, bytes, graph, used: Instant::now() });
        self.prune_graphs(&mut all);
        // The newest is the last to go, so it is gone only when it could not stay beside graphs still in use.
        if !all.last().is_some_and(|h| std::ptr::eq(Arc::as_ptr(&h.graph), weak.as_ptr())) {
            return false;
        }
        self.tracked.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push((weak, bytes));
        true
    }

    #[cfg(test)]
    fn with_max_bytes(mut self, max_bytes: u64) -> Self {
        self.max_bytes = max_bytes;
        self
    }

    #[cfg(test)]
    pub(super) fn set_max_bytes(&mut self, max_bytes: u64) {
        self.max_bytes = max_bytes;
    }

    /// Drops what is staged, as a write that never happened leaves it.
    #[cfg(test)]
    pub(super) fn discard_staged(&self) {
        self.pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clear();
    }

    #[cfg(test)]
    pub(super) fn with_graph_budget(mut self, entries: usize, heap_bytes: u64) -> Self {
        self.resident_max_entries = entries;
        self.graph_heap_max_bytes = heap_bytes;
        self
    }

    #[cfg(test)]
    pub(super) fn with_graph_idle(mut self, idle: Duration) -> Self {
        self.graph_idle = idle;
        self
    }

    /// Drops every held generation, as the budget's eviction would.
    #[cfg(test)]
    pub(super) fn evict_all(&self) {
        self.graphs.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clear();
    }

    /// Takes a root's refresh turn, as a refresh in progress would.
    #[cfg(test)]
    pub(super) fn hold_root(&self, root: &Path) -> Arc<Mutex<()>> {
        self.root_lock(&identity_key(root).unwrap())
    }

    #[cfg(test)]
    pub(super) fn builds(&self) -> usize {
        self.builds.load(Ordering::SeqCst)
    }

    #[cfg(test)]
    pub(super) fn held_roots(&self) -> Vec<String> {
        self.graphs.lock().unwrap().iter().map(|h| h.key.clone()).collect()
    }

    fn manifest_path(&self) -> PathBuf {
        self.dir.join("manifest.json")
    }

    /// The manifest as stored; absent or unparsable reads as empty.
    fn read_manifest(&self) -> BTreeMap<String, Row> {
        std::fs::read(self.manifest_path()).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
    }

    /// The roots with a cached graph (`listCachedCodeGraphRoots`), as they were built. Reads the
    /// manifest only: nothing is initialised, pruned or loaded.
    pub fn roots(&self) -> Vec<PathBuf> {
        self.read_manifest().into_values().filter(|row| !row.root.is_empty()).map(|row| PathBuf::from(row.root)).collect()
    }

    /// The cached files of `root`, by rel, or none when there is no valid entry.
    #[cfg(test)]
    pub(super) fn load(&self, root: &Path) -> Option<HashMap<String, CachedFile>> {
        self.load_with_receipts(root).map(|(files, _)| files)
    }

    /// The cached files of `root` and the receipts of its payload: empty unless the payload was written in this lifetime
    /// of the ledger (see [`Ledger`]).
    pub(super) fn load_with_receipts(&self, root: &Path) -> Option<(HashMap<String, CachedFile>, Receipts)> {
        let key = identity_key(root).ok()?;
        let row = self.read_manifest().remove(&key)?;
        if !is_cache_hash(&row.hash) {
            return None;
        }
        // Streamed: the payload's bytes are never held next to the files parsed out of them.
        let file = std::fs::File::open(self.dir.join(format!("{}.json", row.hash))).ok()?;
        let payload: Payload<Vec<CachedFile>> = serde_json::from_reader(io::BufReader::new(file)).ok()?;
        (payload.version == FORMAT_VERSION && payload.key == key).then(|| {
            let receipts = if payload.epoch == self.ledger.epoch() { payload.receipts } else { Receipts::new() };
            (payload.files.into_iter().map(|f| (f.rel.clone(), f)).collect(), receipts)
        })
    }

    /// Queues `root`'s parsed files for the next flush (the newest staging of a root wins). They are serialised
    /// at the flush, straight into the payload file.
    #[cfg(test)]
    pub(super) fn stage<T: Serialize + Send + 'static>(&self, root: &Path, files: T) {
        self.stage_with(root, identity_key(root).unwrap(), files, Receipts::new());
    }

    /// [`stage`](Self::stage) for files that processed `receipts`, under root identity `key`.
    #[cfg(test)]
    pub(super) fn stage_with<T: Serialize + Send + 'static>(&self, root: &Path, key: String, files: T, receipts: Receipts) {
        let payload = Payload { version: FORMAT_VERSION, key: key.clone(), epoch: self.ledger.epoch().to_owned(), receipts, files };
        let write = Box::new(move |out: &mut dyn io::Write| serde_json::to_writer(out, &payload).map_err(io::Error::other));
        let staged = Staged { root: root.to_string_lossy().into_owned(), write, built_at: now_ms(), released: None, generation: 0 };
        self.pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(key, staged);
    }

    /// Queues a generation the cache keeps, as [`stage`](Self::stage) does, without keeping it alive.
    fn stage_held(&self, root: &Path, key: &str, graph: &Arc<Graph>, generation: u64) {
        let key = key.to_owned();
        let weak = Arc::downgrade(graph);
        let reader = weak.clone();
        let payload_key = key.clone();
        let (epoch, receipts) = (self.ledger.epoch().to_owned(), graph.receipts.clone());
        let write = Box::new(move |out: &mut dyn io::Write| {
            let graph = reader.upgrade().ok_or_else(|| io::Error::other("graph released before it was written"))?;
            serde_json::to_writer(out, &Payload { version: FORMAT_VERSION, key: payload_key, epoch, receipts, files: GraphFiles(graph) })
                .map_err(io::Error::other)
        });
        let staged = Staged { root: root.to_string_lossy().into_owned(), write, built_at: now_ms(), released: Some(weak), generation };
        self.pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(key, staged);
    }

    pub(super) fn has_pending(&self) -> bool {
        !self.pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner).is_empty()
    }

    /// Writes what is staged: merge into the manifest as it stands, prune, sweep. A lane job.
    pub fn flush(&self) -> io::Result<()> {
        if !self.has_pending() {
            return Ok(());
        }
        self.flush_staged()
    }

    fn flush_staged(&self) -> io::Result<()> {
        if !self.has_pending() {
            return Ok(());
        }
        // Queue for the commit before taking what is staged: a flush waiting its turn must not hold staged graphs.
        let _commit = self.commit.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let staged = std::mem::take(&mut *self.pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner));
        if staged.is_empty() {
            return Ok(());
        }
        std::fs::create_dir_all(&self.dir)?;
        let mut manifest = self.read_manifest();
        for (key, entry) in staged {
            if entry.released.as_ref().is_some_and(|graph| graph.strong_count() == 0) {
                continue;
            }
            let hash = hash_of(&key);
            let writing = Instant::now();
            // A payload over the disk budget would be evicted by the prune below at once: it is not written.
            let Some(bytes) = write_atomic_with(&self.dir.join(format!("{hash}.json")), self.max_bytes, entry.write)? else {
                continue;
            };
            tracing::info!(target: "code_graph", event = "persist", root = %entry.root, generation = entry.generation, bytes, persist_ms = elapsed_ms(writing), "code_graph generation persisted");
            manifest.insert(key, Row { hash, built_at: entry.built_at, bytes, root: entry.root });
        }
        self.prune(&mut manifest);
        write_atomic(&self.manifest_path(), &serde_json::to_vec(&manifest).map_err(io::Error::other)?)?;
        self.sweep(&manifest);
        Ok(())
    }

    /// `_pruneCodeGraphManifestForBudget`: rows whose payload is gone drop out, then the oldest
    /// builds go until both the entry count and the byte budget hold.
    fn prune(&self, manifest: &mut BTreeMap<String, Row>) {
        let mut rows: Vec<(String, Row, u64)> = manifest
            .iter()
            .filter(|(key, row)| !key.is_empty() && is_cache_hash(&row.hash))
            .filter_map(|(key, row)| {
                let size = std::fs::metadata(self.dir.join(format!("{}.json", row.hash))).ok()?.len();
                Some((key.clone(), row.clone(), size))
            })
            .collect();
        rows.sort_by(|a, b| a.1.built_at.cmp(&b.1.built_at).then_with(|| a.0.cmp(&b.0)));
        let mut total: u64 = rows.iter().map(|r| r.2).sum();
        let mut kept = rows.len();
        let mut evicted: HashSet<String> = HashSet::new();
        for (key, _, size) in &rows {
            if kept <= MAX_ENTRIES {
                break;
            }
            evicted.insert(key.clone());
            total -= size;
            kept -= 1;
        }
        for (key, _, size) in &rows {
            if total <= self.max_bytes {
                break;
            }
            if evicted.insert(key.clone()) {
                total -= size;
            }
        }
        *manifest = rows.into_iter().filter(|(key, _, _)| !evicted.contains(key)).map(|(key, row, _)| (key, row)).collect();
    }

    /// Removes payloads no manifest row references and temp files aged past the guard.
    fn sweep(&self, manifest: &BTreeMap<String, Row>) {
        let valid: HashSet<&str> = manifest.values().map(|row| row.hash.as_str()).collect();
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let orphan = match name.strip_suffix(".json") {
                Some("manifest") => false,
                Some(hash) => !valid.contains(hash),
                None => {
                    is_tmp_name(&name)
                        && entry.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > ORPHAN_TMP_MIN_AGE)
                }
            };
            if orphan {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    /// Drops `root` from the cache (`forgetCodeGraphStateRoot`, `forgetDiskCodeGraphRoot`): its resident
    /// graph, the staged copy, the manifest row and its payload. Only this exact root; nested roots are
    /// other roots. Returns what was removed and the files that matched but could not be deleted. A lane
    /// job; never creates the directory.
    pub fn forget(&self, root: &Path) -> (Vec<String>, Vec<PathBuf>) {
        let mut removed = Vec::new();
        // A root with no resolvable identity names no cache entry: it is reported as kept, not matched by its spelling.
        let Ok(key) = identity_key(root) else { return (removed, vec![root.to_path_buf()]) };
        self.forget_in_memory(&key, &mut removed);
        if !self.dir.exists() {
            return (removed, Vec::new());
        }
        let kept = self.forget_on_disk(&key, &mut removed);
        (removed, kept)
    }

    fn forget_in_memory(&self, key: &str, removed: &mut Vec<String>) {
        {
            let mut resident = self.resident.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            let before = resident.len();
            resident.retain(|entry| path_key(Path::new(&entry.root)) != key);
            if resident.len() != before {
                removed.push(format!("resident-graph:{key}"));
            }
        }
        // The root's scoped builds go with it.
        let scoped = format!("{key}\u{0}");
        self.graphs.lock().unwrap_or_else(std::sync::PoisonError::into_inner).retain(|h| h.key != key && !h.key.starts_with(&scoped));
        if self.heap_note(key).is_some() {
            let mut notes = self.heap_notes.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(notes) = notes.as_mut() {
                notes.remove(key);
                if self.dir.exists() {
                    let _ = write_atomic(&self.note_path(), &serde_json::to_vec(&*notes).unwrap_or_default());
                }
            }
        }
        if self.pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(key).is_some() {
            removed.push(format!("pending:{key}"));
        }
    }

    fn forget_on_disk(&self, key: &str, removed: &mut Vec<String>) -> Vec<PathBuf> {
        let mut kept = Vec::new();
        let _commit = self.commit.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut manifest = self.read_manifest();
        let mut hashes: HashSet<String> = HashSet::from([hash_of(key)]);
        if let Some(row) = manifest.remove(key) {
            if is_cache_hash(&row.hash) {
                hashes.insert(row.hash);
            }
            removed.push(format!("manifest:{key}"));
            if write_atomic(&self.manifest_path(), &serde_json::to_vec(&manifest).unwrap_or_default()).is_err() {
                kept.push(self.manifest_path());
            }
        }
        for hash in hashes {
            let file = self.dir.join(format!("{hash}.json"));
            if !file.exists() {
                continue;
            }
            match std::fs::remove_file(&file) {
                Ok(()) => removed.push(file.to_string_lossy().into_owned()),
                Err(_) => kept.push(file),
            }
        }
        kept
    }

    /// [`Self::forget`] on `lane`: the cleanup a removed worktree's root runs (`cache-cleanups.mjs`, `code-graph`).
    pub async fn forget_root(
        self: &Arc<Self>,
        lane: mixdog_rt::MaintenanceIo,
        cancel: &tokio_util::sync::CancellationToken,
        root: &Path,
    ) -> io::Result<(Vec<String>, Vec<PathBuf>)> {
        let (cache, root) = (self.clone(), root.to_path_buf());
        mixdog_scm::repo::on_lane(lane, cancel, move || cache.forget(&root)).await.map_err(io::Error::other)
    }

    /// Writes everything staged now, on `lane` (the exit drain; a failed write is the error).
    pub async fn drain(self: &Arc<Self>, lane: mixdog_rt::MaintenanceIo, cancel: &tokio_util::sync::CancellationToken) -> io::Result<()> {
        let cache = self.clone();
        mixdog_scm::repo::on_lane(lane, cancel, move || cache.flush()).await.map_err(io::Error::other)?
    }

    /// Debounced flush: one task waits 250 ms and then writes whatever has been staged since.
    /// A failed write is dropped; the roots are staged again by the next build that changes them.
    pub fn schedule_flush(self: &Arc<Self>, lane: mixdog_rt::MaintenanceIo) {
        self.schedule_idle_release();
        if !self.has_pending() || self.scheduled.swap(true, Ordering::SeqCst) {
            return;
        }
        let cache = self.clone();
        tokio::spawn(async move {
            mixdog_rt::time::sleep(FLUSH_DELAY).await;
            cache.scheduled.store(false, Ordering::SeqCst);
            let _ = cache.drain(lane, &tokio_util::sync::CancellationToken::new()).await;
        });
    }
}
impl GraphCache {
    /// Releases the held generations no call took for `graph_idle`; `true` while some are still held.
    pub(super) fn release_idle(&self) -> bool {
        let mut all = self.graphs.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        all.retain(|h| h.used.elapsed() < self.graph_idle);
        !all.is_empty()
    }

    /// Once per idle period while generations are held, a release of the idle ones, so a root nobody queries again does
    /// not keep its graph for the life of the process.
    fn schedule_idle_release(self: &Arc<Self>) {
        if self.idle_scheduled.swap(true, Ordering::SeqCst) {
            return;
        }
        let cache = Arc::downgrade(self);
        let idle = self.graph_idle;
        tokio::spawn(async move {
            loop {
                mixdog_rt::time::sleep(idle).await;
                let Some(cache) = cache.upgrade() else { return };
                if !cache.release_idle() {
                    cache.idle_scheduled.store(false, Ordering::SeqCst);
                    return;
                }
            }
        });
    }
}
