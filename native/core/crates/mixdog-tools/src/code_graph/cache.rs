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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};

use mixdog_graph::outline::SymbolInfo;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::graph::{Graph, Node};
use super::roots::path_key;

const FORMAT_VERSION: u32 = 4;
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

struct Staged {
    root: String,
    write: Box<dyn FnOnce(&mut dyn io::Write) -> io::Result<()> + Send>,
    built_at: i64,
}

/// Node's `CODE_GRAPH_TTL_MS`: a held graph answers for this long after its build.
const GRAPH_TTL: Duration = Duration::from_millis(30_000);
/// The bound on the heap of all held graphs. Node's `CODE_GRAPH_MEMORY_MAX_BYTES` is 48 MiB of its own estimate and it
/// keeps the newest graph past it; this bound is hard. Measured on this repository's tree (10,000 indexed files, the
/// file cap) a graph weighs about 70 MiB, so 48 would never hold the largest trees; 80 holds one of them.
const DEFAULT_GRAPH_HEAP_MB: f64 = 80.0;

/// The one-at-a-time lock of graph work. Not a `MutexGuard`: a [`Permit`] is released by whichever thread drops the
/// last [`Lease`] that holds it.
struct Gate {
    busy: Mutex<bool>,
    idle: Condvar,
}

pub(super) struct Permit(Arc<Gate>);

impl Gate {
    fn acquire(self: &Arc<Self>) -> Arc<Permit> {
        let mut busy = self.busy.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        while *busy {
            busy = self.idle.wait(busy).unwrap_or_else(std::sync::PoisonError::into_inner);
        }
        *busy = true;
        Arc::new(Permit(self.clone()))
    }
}

impl Drop for Permit {
    fn drop(&mut self) {
        *self.0.busy.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = false;
        self.0.idle.notify_all();
    }
}

/// A graph for one call. One that is not held in the cache keeps the gate until the call is done with it, so no
/// second full graph is built or persisted while it lives.
#[derive(Clone)]
pub(super) struct Lease {
    pub(super) graph: Arc<Graph>,
    _permit: Option<Arc<Permit>>,
}

impl Lease {
    /// A graph nobody else shares and no gate guards (one parsed from a single file).
    pub(super) fn alone(graph: Arc<Graph>) -> Self {
        Self { graph, _permit: None }
    }
}

impl std::ops::Deref for Lease {
    type Target = Graph;

    fn deref(&self) -> &Graph {
        &self.graph
    }
}

/// The result of a build, for the callers of its root that waited for it.
#[derive(Default)]
struct Slot {
    result: Mutex<Option<Result<Lease, String>>>,
    ready: Condvar,
}

impl Slot {
    fn fulfil(&self, outcome: Result<Lease, String>) {
        let mut result = self.result.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if result.is_none() {
            *result = Some(outcome);
        }
        self.ready.notify_all();
    }

    fn wait(&self) -> Result<Lease, String> {
        let mut result = self.result.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        loop {
            if let Some(outcome) = result.as_ref() {
                return outcome.clone();
            }
            result = self.ready.wait(result).unwrap_or_else(std::sync::PoisonError::into_inner);
        }
    }
}

/// Ends a root's in-flight build when it is dropped, with an error if the builder never reported (a panic), so
/// waiters are never left behind.
struct Leading<'a> {
    cache: &'a GraphCache,
    key: &'a str,
    slot: Arc<Slot>,
}

impl Drop for Leading<'_> {
    fn drop(&mut self) {
        self.slot.fulfil(Err("code_graph: the graph build did not finish".to_owned()));
        self.cache.inflight.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(self.key);
    }
}

/// A built graph kept for reuse: Node's `_codeGraphCache` entry.
struct Held {
    key: String,
    signature: u64,
    built_at: Instant,
    graph: Arc<Graph>,
    /// The graph's heap bytes (it holds no source text).
    bytes: u64,
}

impl Held {
    fn expired(&self) -> bool {
        self.built_at.elapsed() >= GRAPH_TTL
    }
}

pub struct GraphCache {
    dir: PathBuf,
    max_bytes: u64,
    pending: Mutex<HashMap<String, Staged>>,
    /// Built graphs, least recently used first (`_codeGraphCache`): at most `resident_max_entries` and
    /// `graph_heap_max_bytes` of real heap, each for [`GRAPH_TTL`] after its build.
    graphs: Arc<Mutex<Vec<Held>>>,
    /// Only one graph is built, persisted and (when it is not held) served at a time.
    gate: Arc<Gate>,
    /// The build each root has under way: callers of that root wait for it and share its result, held or not.
    inflight: Mutex<HashMap<String, Arc<Slot>>>,
    /// Every graph admitted to `graphs`, with its heap bytes: one the cache evicted while a call still uses it stays
    /// alive and counts against the heap budget until that call is done.
    tracked: Mutex<Vec<(Weak<Graph>, u64)>>,
    /// Each root's last built graph as `(file-set signature, heap bytes)`, kept in `<dir>/heap.note` across restarts:
    /// what a warm asks to know whether the root's current graph would be admitted. Loaded on first use.
    heap_notes: Mutex<Option<BTreeMap<String, (u64, u64)>>>,
    graph_heap_max_bytes: u64,
    purge_armed: Arc<AtomicBool>,
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
    built_at: i64,
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

/// `Math.max(min, Math.floor(Number(process.env[name]) || fallback))`.
fn env_count(name: &str, fallback: f64, min: f64) -> f64 {
    let parsed = std::env::var(name).ok().map(|raw| mixdog_js::string_to_number(&raw)).filter(|n| *n != 0.0 && !n.is_nan()).unwrap_or(fallback);
    parsed.max(min)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
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

impl GraphCache {
    /// A cache under `dir` (created on the first write).
    pub fn new(dir: PathBuf) -> Self {
        let mb = std::env::var("MIXDOG_CODE_GRAPH_CACHE_MAX_MB")
            .ok()
            .and_then(|v| v.trim().parse::<f64>().ok())
            .filter(|v| *v > 0.0)
            .unwrap_or(DEFAULT_MAX_MB);
        Self {
            dir,
            max_bytes: ((mb * 1024.0 * 1024.0).floor() as u64).max(1024 * 1024),
            pending: Mutex::default(),
            graphs: Arc::default(),
            gate: Arc::new(Gate { busy: Mutex::new(false), idle: Condvar::new() }),
            inflight: Mutex::default(),
            tracked: Mutex::default(),
            heap_notes: Mutex::new(None),
            graph_heap_max_bytes: (env_count("MIXDOG_CODE_GRAPH_HEAP_MAX_MB", DEFAULT_GRAPH_HEAP_MB, 1.0) * 1024.0 * 1024.0).floor() as u64,
            purge_armed: Arc::new(AtomicBool::new(false)),
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
        // build.mjs:658: a resident graph answers for CODE_GRAPH_TTL_MS after its build; later the set is loaded anew.
        if let Some(entry) = kept.filter(|r| r.signature == signature && now_ms() - r.built_at < 30_000) {
            let lookups = entry.lookups.clone();
            all.push(entry);
            return lookups;
        }
        let (base_bytes, token_index_bytes) = measure();
        let lookups = super::graph::Lookups::default();
        all.push(Resident { root: root.to_owned(), signature, lookups: lookups.clone(), base_bytes, token_index_bytes, built_at: now_ms() });
        prune_resident(&mut all, self.resident_max_entries, self.resident_max_bytes);
        lookups
    }

    /// dispatch.mjs:377: every call ends with the resident graphs pruned, the runtime caches it filled counted.
    pub(super) fn prune_after_call(&self) {
        let mut all = self.resident.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        prune_resident(&mut all, self.resident_max_entries, self.resident_max_bytes);
        drop(all);
        self.prune_graphs(&mut self.graphs.lock().unwrap_or_else(std::sync::PoisonError::into_inner));
    }

    /// Drops expired graphs, then the oldest while the heap budget or the entry count is exceeded. A dropped graph a
    /// call still uses keeps counting (`retired_bytes`), so the budget holds for what is alive, not for what is listed.
    fn prune_graphs(&self, all: &mut Vec<Held>) {
        all.retain(|h| !h.expired());
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

    /// The graph of `root`, built at most once while it stays valid: a held graph whose indexed files still carry
    /// the signature it was built from (`build.mjs:658`) and is under [`GRAPH_TTL`] old is returned as it is; else
    /// the one build the process runs at a time makes it (callers of the same root that waited behind that build
    /// take its graph). A scoped build (`excluded` roots) is never held, as Node's `cache: false`.
    pub(super) fn graph(&self, root: &Path, excluded: &[PathBuf]) -> Result<Lease, String> {
        if !excluded.is_empty() {
            let permit = self.gate.acquire();
            let graph = self.build(root, excluded)?;
            return Ok(Lease { graph, _permit: Some(permit) });
        }
        let key = path_key(root);
        loop {
            let signature = Graph::probe(root)?;
            if let Some(graph) = self.held(&key, signature) {
                return Ok(Lease { graph, _permit: None });
            }
            let (slot, leading) = {
                let mut inflight = self.inflight.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                match inflight.get(&key) {
                    Some(slot) => (slot.clone(), false),
                    None => {
                        let slot = Arc::new(Slot::default());
                        inflight.insert(key.clone(), slot.clone());
                        (slot, true)
                    }
                }
            };
            if !leading {
                // The build under way serves every caller of this root, held or not; one whose files changed
                // since goes round again.
                let lease = slot.wait()?;
                if lease.graph.signature == signature && lease.graph.is_fresh() {
                    return Ok(lease);
                }
                continue;
            }
            let leader = Leading { cache: self, key: &key, slot };
            let outcome = self.lead(root, &key, signature);
            leader.slot.fulfil(outcome.clone());
            return outcome;
        }
    }

    /// Builds `root`'s graph inside the gate and persists it there too, so a later build never overlaps this graph's
    /// persistence. A graph over the heap budget is not held: the lease keeps the gate until the call is done with it.
    fn lead(&self, root: &Path, key: &str, signature: u64) -> Result<Lease, String> {
        let permit = self.gate.acquire();
        if let Some(graph) = self.held(key, signature) {
            return Ok(Lease { graph, _permit: None });
        }
        let graph = self.build(root, &[])?;
        let admitted = self.hold(key.to_owned(), graph.clone());
        // The build staged its files holding the graph: they are written now, so nothing keeps it alive but `graphs`
        // (budgeted, expiring) and this lease. A failed write is dropped; the next changed build stages again.
        let _ = self.flush();
        Ok(Lease { graph, _permit: (!admitted).then_some(permit) })
    }

    /// The warm of a project: loads its graph only when the same admission rule that would keep it says it is kept.
    /// What the rule needs is a graph's weight, which only a built graph has: the note of the root's last build
    /// (kept across restarts) gives it for the files the root has now, and no note for the current files means no
    /// speculative work: the first foreground query builds and records.
    pub(super) fn prewarm(&self, root: &Path) {
        let Ok(signature) = Graph::probe(root) else { return };
        let Some((noted, bytes)) = self.heap_note(&path_key(root)) else { return };
        let admitted = noted == signature && self.admits(bytes, &self.graphs.lock().unwrap_or_else(std::sync::PoisonError::into_inner));
        if admitted {
            let _ = self.graph(root, &[]);
        }
    }

    fn note_path(&self) -> PathBuf {
        self.dir.join("heap.note")
    }

    /// `(signature, heap bytes)` of `key`'s last built graph.
    fn heap_note(&self, key: &str) -> Option<(u64, u64)> {
        let mut notes = self.heap_notes.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        notes.get_or_insert_with(|| std::fs::read(self.note_path()).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()).get(key).copied()
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

    /// Drops `root`'s held graph (its sources no longer match it).
    pub(super) fn drop_held(&self, root: &Path) {
        let key = path_key(root);
        self.graphs.lock().unwrap_or_else(std::sync::PoisonError::into_inner).retain(|h| h.key != key);
    }

    fn build(&self, root: &Path, excluded: &[PathBuf]) -> Result<Arc<Graph>, String> {
        #[cfg(test)]
        self.builds.fetch_add(1, Ordering::SeqCst);
        Graph::build(root, excluded, self)
    }

    /// The valid held graph of `key` (now the newest); a stale or expired one is dropped at once.
    fn held(&self, key: &str, signature: u64) -> Option<Arc<Graph>> {
        let mut all = self.graphs.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let at = all.iter().position(|h| h.key == key)?;
        let entry = all.remove(at);
        if entry.signature != signature || entry.expired() || !entry.graph.is_fresh() {
            return None;
        }
        let graph = entry.graph.clone();
        all.push(entry);
        Some(graph)
    }

    /// Keeps `graph` for reuse; `false` when it does not fit the heap budget beside the graphs still alive (it serves
    /// the call that built it and is not kept). What it weighs is noted for the warm.
    fn hold(&self, key: String, graph: Arc<Graph>) -> bool {
        let bytes = graph.base_heap_bytes();
        self.record_heap(&key, graph.signature, bytes);
        let mut all = self.graphs.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        all.retain(|h| h.key != key);
        if !self.admits(bytes, &all) {
            return false;
        }
        let weak = Arc::downgrade(&graph);
        all.push(Held { key, signature: graph.signature, built_at: Instant::now(), bytes, graph });
        self.prune_graphs(&mut all);
        // The newest is the last to go, so it is gone only when it could not stay beside graphs still in use.
        if !all.last().is_some_and(|h| std::ptr::eq(Arc::as_ptr(&h.graph), weak.as_ptr())) {
            return false;
        }
        self.tracked.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push((weak, bytes));
        if !self.purge_armed.swap(true, Ordering::SeqCst) {
            let (graphs, armed) = (self.graphs.clone(), self.purge_armed.clone());
            // Nothing else would drop an idle graph: expire it when its time is up.
            std::thread::spawn(move || {
                loop {
                    let wait = {
                        let mut all = graphs.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                        all.retain(|h| !h.expired());
                        let Some(next) = all.iter().map(|h| GRAPH_TTL.saturating_sub(h.built_at.elapsed())).min() else {
                            armed.store(false, Ordering::SeqCst);
                            return;
                        };
                        next
                    };
                    std::thread::sleep(wait + Duration::from_millis(50));
                }
            });
        }
        true
    }

    #[cfg(test)]
    fn with_max_bytes(mut self, max_bytes: u64) -> Self {
        self.max_bytes = max_bytes;
        self
    }

    #[cfg(test)]
    pub(super) fn with_graph_budget(mut self, entries: usize, heap_bytes: u64) -> Self {
        self.resident_max_entries = entries;
        self.graph_heap_max_bytes = heap_bytes;
        self
    }

    /// Takes the gate, as a build in progress would.
    #[cfg(test)]
    pub(super) fn hold_gate(&self) -> Arc<Permit> {
        self.gate.acquire()
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
    pub(super) fn load(&self, root: &Path) -> Option<HashMap<String, CachedFile>> {
        let key = path_key(root);
        let row = self.read_manifest().remove(&key)?;
        if !is_cache_hash(&row.hash) {
            return None;
        }
        // Streamed: the payload's bytes are never held next to the files parsed out of them.
        let file = std::fs::File::open(self.dir.join(format!("{}.json", row.hash))).ok()?;
        let payload: Payload<Vec<CachedFile>> = serde_json::from_reader(io::BufReader::new(file)).ok()?;
        (payload.version == FORMAT_VERSION && payload.key == key).then(|| payload.files.into_iter().map(|f| (f.rel.clone(), f)).collect())
    }

    /// Queues `root`'s parsed files for the next flush (the newest staging of a root wins). They are serialised
    /// at the flush, straight into the payload file.
    pub(super) fn stage<T: Serialize + Send + 'static>(&self, root: &Path, files: T) {
        let key = path_key(root);
        let payload = Payload { version: FORMAT_VERSION, key: key.clone(), files };
        let write = Box::new(move |out: &mut dyn io::Write| serde_json::to_writer(out, &payload).map_err(io::Error::other));
        let staged = Staged { root: root.to_string_lossy().into_owned(), write, built_at: now_ms() };
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
        // Queue for the commit before taking what is staged: a flush waiting its turn must not hold staged graphs.
        let _commit = self.commit.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let staged = std::mem::take(&mut *self.pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner));
        if staged.is_empty() {
            return Ok(());
        }
        std::fs::create_dir_all(&self.dir)?;
        let mut manifest = self.read_manifest();
        for (key, entry) in staged {
            let hash = hash_of(&key);
            // A payload over the disk budget would be evicted by the prune below at once: it is not written.
            let Some(bytes) = write_atomic_with(&self.dir.join(format!("{hash}.json")), self.max_bytes, entry.write)? else {
                continue;
            };
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
        let key = path_key(root);
        let mut removed = Vec::new();
        let mut kept = Vec::new();
        {
            let mut resident = self.resident.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            let before = resident.len();
            resident.retain(|entry| path_key(Path::new(&entry.root)) != key);
            if resident.len() != before {
                removed.push(format!("resident-graph:{key}"));
            }
        }
        self.graphs.lock().unwrap_or_else(std::sync::PoisonError::into_inner).retain(|h| h.key != key);
        if self.heap_note(&key).is_some() {
            let mut notes = self.heap_notes.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(notes) = notes.as_mut() {
                notes.remove(&key);
                if self.dir.exists() {
                    let _ = write_atomic(&self.note_path(), &serde_json::to_vec(&*notes).unwrap_or_default());
                }
            }
        }
        if self.pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(&key).is_some() {
            removed.push(format!("pending:{key}"));
        }
        if !self.dir.exists() {
            return (removed, kept);
        }
        let _commit = self.commit.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut manifest = self.read_manifest();
        let mut hashes: HashSet<String> = HashSet::from([hash_of(&key)]);
        if let Some(row) = manifest.remove(&key) {
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
        (removed, kept)
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
    pub async fn drain(
        self: &Arc<Self>,
        lane: mixdog_rt::MaintenanceIo,
        cancel: &tokio_util::sync::CancellationToken,
    ) -> io::Result<()> {
        let cache = self.clone();
        mixdog_scm::repo::on_lane(lane, cancel, move || cache.flush())
            .await
            .map_err(io::Error::other)?
    }

    /// Debounced flush: one task waits 250 ms and then writes whatever has been staged since.
    /// A failed write is dropped; the roots are staged again by the next build that changes them.
    pub fn schedule_flush(self: &Arc<Self>, lane: mixdog_rt::MaintenanceIo) {
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

    /// The cleanup of a removed worktree's root (`cache-cleanups.mjs`, `code-graph`: `forgetCodeGraphStateRoot` and
    /// `forgetDiskCodeGraphRoot`): its resident graph, manifest row and payload go on the lane; another root keeps all of its own.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_removed_roots_cache_is_forgotten_with_its_resident_graph_and_no_other_roots() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = Arc::new(GraphCache::new(tmp.path().join("cache")));
        let (gone, stays) = (root(tmp.path(), "Gone"), root(tmp.path(), "Stays"));
        for proj in [&gone, &stays] {
            cache.stage(proj, vec![file("a.mjs", "export const a = 1;")]);
            cache.lookups_for(&proj.to_string_lossy(), 1, || (10, 0));
        }
        cache.flush().unwrap();
        let lane = mixdog_rt::testing::tokens().maintenance_io;
        let (removed, kept) = cache.forget_root(lane, &tokio_util::sync::CancellationToken::new(), &gone).await.unwrap();
        assert!(kept.is_empty(), "{kept:?}");
        assert!(removed.iter().any(|name| name.starts_with("resident-graph:")) && removed.iter().any(|name| name.starts_with("manifest:")), "{removed:?}");
        assert_eq!(cache.roots(), vec![stays.clone()]);
        assert!(cache.load(&gone).is_none() && cache.load(&stays).is_some());
        let resident: Vec<String> = cache.resident.lock().unwrap().iter().map(|entry| entry.root.clone()).collect();
        assert_eq!(resident, [stays.to_string_lossy().into_owned()]);
        // Nothing left to forget: nothing removed, nothing kept.
        assert_eq!(cache.forget_root(lane, &tokio_util::sync::CancellationToken::new(), &gone).await.unwrap(), (Vec::new(), Vec::new()));
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
        assert_eq!(cache.load(&shouted).is_some(), cfg!(windows));
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
        std::fs::write(dir.join(format!("{}.json", hash_of(&path_key(&proj)))), "{ torn").unwrap();
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
}
