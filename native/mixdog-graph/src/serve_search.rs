// Resident search server: JSONL over stdio, one request per line.
//
// Motivation (measured): every grep pays ~100ms of Windows process spawn +
// AV on-access scan for rg while the actual match work is ~5-10ms. This mode
// keeps ONE warm process and answers rg-COMPATIBLE content searches without a
// spawn. The Node side forwards the exact rg argv it would have used;
// unsupported requests fail explicitly; there is no external rg fallback.
//
// Request : {"id":1,"cwd":"C:/repo","args":["--color","never",...],"offset":0,"limit":400}
// Response: {"id":1,"lines":[...],"complete":true,"totalSeen":N}
//         | {"id":1,"unsupported":"reason"} | {"id":1,"error":"..."}
use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::io::{self, BufRead, Read, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock, Weak};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use grep::matcher::Matcher;
use grep::printer::{StandardBuilder, SummaryBuilder, SummaryKind};
use grep::searcher::{
    BinaryDetection, Searcher, SearcherBuilder, Sink, SinkContext, SinkFinish, SinkMatch,
};
use ignore::overrides::{Override, OverrideBuilder};
use ignore::types::{Types, TypesBuilder};
use ignore::WalkBuilder;
use notify::event::ModifyKind;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use nucleo_matcher::pattern::{AtomKind, CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config as FuzzyConfig, Matcher as FuzzyMatcher, Utf32String};
use rayon::prelude::*;
use rayon::{ThreadPool, ThreadPoolBuilder};
use serde::Deserialize;

const CANCELLED: &str = "cancelled";
const SOFT_TIMEOUT: &str = "soft timeout";
const FILE_LIST_CACHE_MAX: usize = 8;
const WATCH_ROOT_MAX: usize = 16;
const DEFAULT_SEARCH_QUEUE_CAPACITY: usize = 2_048;
const DEFAULT_RESPONSE_QUEUE_CAPACITY: usize = 512;
const MAX_SEARCH_THREADS: usize = 16;
const MAX_SEARCH_QUEUE_CAPACITY: usize = 8_192;
const MAX_RESPONSE_QUEUE_CAPACITY: usize = 2_048;
const DEFAULT_SEARCH_READER_CHUNK_BYTES: usize = 64 * 1_024;
const DEFAULT_SEARCH_HEAP_BYTES: usize = 32 * 1_024 * 1_024;
const DEFAULT_FILE_LIST_CACHE_BYTES: usize = 64 * 1_024 * 1_024;
const DEFAULT_FUZZY_CACHE_BYTES: usize = 64 * 1_024 * 1_024;
const DEFAULT_AIMD_TARGET_MS: usize = 250;
const DEFAULT_AIMD_INCREASE_EVERY: usize = 8;
const WALK_ERROR_DETAIL_MAX: usize = 8;
const WALK_ERROR_DETAIL_CHARS: usize = 300;

fn bounded_env_usize(name: &str, default: usize, min: usize, max: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|raw| raw.parse::<usize>().ok())
        .unwrap_or(default)
        .clamp(min, max)
}

fn search_reader_chunk_bytes() -> usize {
    bounded_env_usize(
        "MIXDOG_SEARCH_READER_CHUNK_BYTES",
        DEFAULT_SEARCH_READER_CHUNK_BYTES,
        4 * 1_024,
        1_024 * 1_024,
    )
}

fn search_heap_bytes() -> usize {
    bounded_env_usize(
        "MIXDOG_SEARCH_HEAP_BYTES",
        DEFAULT_SEARCH_HEAP_BYTES,
        1_024 * 1_024,
        128 * 1_024 * 1_024,
    )
}

fn file_list_cache_bytes() -> usize {
    bounded_env_usize(
        "MIXDOG_SEARCH_FILELIST_CACHE_BYTES",
        DEFAULT_FILE_LIST_CACHE_BYTES,
        1_024 * 1_024,
        512 * 1_024 * 1_024,
    )
}

fn fuzzy_cache_bytes() -> usize {
    bounded_env_usize(
        "MIXDOG_SEARCH_FUZZY_CACHE_BYTES",
        DEFAULT_FUZZY_CACHE_BYTES,
        1_024 * 1_024,
        512 * 1_024 * 1_024,
    )
}

fn aimd_target() -> Duration {
    Duration::from_millis(bounded_env_usize(
        "MIXDOG_SEARCH_AIMD_TARGET_MS",
        DEFAULT_AIMD_TARGET_MS,
        10,
        10_000,
    ) as u64)
}

fn aimd_increase_every() -> usize {
    bounded_env_usize(
        "MIXDOG_SEARCH_AIMD_INCREASE_EVERY",
        DEFAULT_AIMD_INCREASE_EVERY,
        1,
        1_024,
    )
}

fn file_list_ttl() -> Option<Duration> {
    match std::env::var("MIXDOG_SEARCH_FILELIST_TTL_MS") {
        Ok(raw) if raw.trim() == "0" => None,
        Ok(raw) => raw
            .parse::<u64>()
            .ok()
            .filter(|ms| *ms > 0)
            .map(Duration::from_millis),
        Err(_) => Some(Duration::from_millis(30_000)),
    }
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct WalkKey {
    operand: PathBuf,
    hidden: bool,
    no_ignore: bool,
    no_require_git: bool,
    max_depth: Option<usize>,
    directories: bool,
    // Negative globs are applied DURING the walk (directory pruning), so two
    // requests with different exclusions cannot share one inventory. Positive
    // globs stay out of the key: they only filter an already-built inventory.
    prune: Vec<String>,
}

/// Directory basenames that are never worth enumerating. Mirrors the JS
/// `NOISE_DIR_NAMES` list so walker pruning and tool-side filtering agree.
const NOISE_SEGMENTS: &[&str] = &[
    "node_modules",
    ".git",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".cache",
    ".parcel-cache",
    ".turbo",
    "venv",
    ".venv",
    "__pycache__",
    ".pytest_cache",
    ".gradle",
];

fn path_has_segment(path: &Path, segment: &str) -> bool {
    path.components()
        .any(|component| component.as_os_str() == segment)
}

fn is_noise_path(path: &Path) -> bool {
    NOISE_SEGMENTS
        .iter()
        .any(|segment| path_has_segment(path, segment))
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct FuzzyKey {
    walk: WalkKey,
    globs: Vec<String>,
    iglobs: Vec<String>,
}

fn normalized_operand(operand: &Path) -> PathBuf {
    std::fs::canonicalize(operand).unwrap_or_else(|_| operand.to_path_buf())
}

fn wire_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{rest}");
        }
        if let Some(rest) = value.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }
    value.into_owned()
}

/// Exclusion globs that the walker itself can honor. Only negations qualify:
/// a positive glob may not prune a directory (its children can still match),
/// while `!**/node_modules/**` makes the whole subtree dead weight. Each
/// `!<dir>/**` gains a `!<dir>` companion so the directory entry is rejected
/// before it is descended. `.git` is always pruned — matching ripgrep's
/// practical behavior — unless the caller deliberately targets a path inside
/// it.
fn prune_globs(operand: &Path, parsed: &ParsedArgs) -> Vec<String> {
    let mut prune: Vec<String> = Vec::new();
    for glob in &parsed.globs {
        let Some(rest) = glob.strip_prefix('!') else {
            continue;
        };
        if rest.is_empty() {
            continue;
        }
        prune.push(glob.clone());
        if let Some(dir) = rest.strip_suffix("/**") {
            prune.push(format!("!{dir}"));
        }
    }
    if !path_has_segment(operand, ".git") {
        prune.push("!**/.git".to_string());
        prune.push("!**/.git/**".to_string());
    }
    prune.sort();
    prune.dedup();
    prune
}

fn prune_overrides(operand: &Path, prune: &[String]) -> Option<Override> {
    if prune.is_empty() {
        return None;
    }
    let root = if operand.is_file() {
        operand.parent().unwrap_or(operand)
    } else {
        operand
    };
    let mut builder = OverrideBuilder::new(root);
    for glob in prune {
        // A malformed exclusion must never abort the walk; the post-walk
        // PathFilter still rejects the same paths.
        if builder.add(glob).is_err() {
            return None;
        }
    }
    builder.build().ok()
}

fn walk_key(operand: &Path, parsed: &ParsedArgs) -> WalkKey {
    WalkKey {
        operand: normalized_operand(operand),
        hidden: parsed.hidden,
        no_ignore: parsed.no_ignore,
        no_require_git: parsed.no_require_git,
        max_depth: parsed.max_depth,
        directories: parsed.directories,
        prune: prune_globs(operand, parsed),
    }
}

fn fuzzy_key(operand: &Path, parsed: &ParsedArgs) -> FuzzyKey {
    let mut globs = parsed.globs.clone();
    globs.sort();
    let mut iglobs = parsed.iglobs.clone();
    iglobs.sort();
    FuzzyKey {
        walk: walk_key(operand, parsed),
        globs,
        iglobs,
    }
}

struct ReadyEntry {
    files: Arc<Vec<PathBuf>>,
    expires_at: Instant,
    generation: u64,
    touched_at: Instant,
    estimated_bytes: usize,
}

struct FuzzyIndexedPath {
    path: String,
    matcher_text: Utf32String,
}

struct FuzzyCorpus {
    paths: Vec<FuzzyIndexedPath>,
}

struct FuzzyEntry {
    corpus: Arc<FuzzyCorpus>,
    touched_at: Instant,
    estimated_bytes: usize,
}

fn paths_storage_bytes(files: &[PathBuf]) -> usize {
    files.iter().fold(0usize, |total, path| {
        total
            .saturating_add(std::mem::size_of::<PathBuf>())
            .saturating_add(path.as_os_str().to_string_lossy().len().saturating_mul(2))
    })
}

fn fuzzy_storage_bytes(corpus: &FuzzyCorpus) -> usize {
    corpus
        .paths
        .iter()
        .fold(std::mem::size_of::<FuzzyCorpus>(), |total, indexed| {
            total
                .saturating_add(std::mem::size_of::<FuzzyIndexedPath>())
                .saturating_add(indexed.path.len().saturating_mul(5))
        })
}

enum LiveState {
    Running,
    Done(Arc<Vec<PathBuf>>),
    Abandoned,
    Failed(String),
}

struct LiveWalk {
    files: Mutex<Vec<PathBuf>>,
    state: Mutex<LiveState>,
    // `cond` pairs exclusively with the `state` mutex and `files_cond` with the
    // `files` mutex. std::sync::Condvar panics when one condvar is waited on
    // with two different mutexes, which killed searches whenever a streaming
    // consumer and a complete-inventory waiter shared one walk.
    cond: Condvar,
    files_cond: Condvar,
    waiters: AtomicUsize,
    cancelled: AtomicBool,
    keep_warm: AtomicBool,
    cacheable: AtomicBool,
    walk_errors: AtomicUsize,
    walk_error_details: Mutex<Vec<String>>,
    generation: u64,
}

struct FileListStore {
    ready: Mutex<HashMap<WalkKey, ReadyEntry>>,
    live: Mutex<HashMap<WalkKey, Arc<LiveWalk>>>,
    fuzzy: Mutex<HashMap<FuzzyKey, FuzzyEntry>>,
    generations: Mutex<HashMap<PathBuf, u64>>,
    watcher: Mutex<Option<RecommendedWatcher>>,
    watcher_healthy: AtomicBool,
    watched_roots: Mutex<HashMap<PathBuf, Instant>>,
}

struct LiveWaiterGuard<'a> {
    store: &'a FileListStore,
    key: WalkKey,
    live: Arc<LiveWalk>,
}

impl Drop for LiveWaiterGuard<'_> {
    fn drop(&mut self) {
        self.store.release_live(&self.key, &self.live);
    }
}

impl FileListStore {
    fn new() -> Self {
        Self {
            ready: Mutex::new(HashMap::new()),
            live: Mutex::new(HashMap::new()),
            fuzzy: Mutex::new(HashMap::new()),
            generations: Mutex::new(HashMap::new()),
            watcher: Mutex::new(None),
            watcher_healthy: AtomicBool::new(false),
            watched_roots: Mutex::new(HashMap::new()),
        }
    }

    fn generation(&self, operand: &Path) -> u64 {
        self.generations
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(operand)
            .copied()
            .unwrap_or(0)
    }

    fn paths_overlap(left: &Path, right: &Path) -> bool {
        left == right || left.starts_with(right) || right.starts_with(left)
    }

    fn has_noise_root(&self) -> bool {
        self.watched_roots
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .any(|root| is_noise_path(root))
    }

    fn affected_roots(&self, paths: &[PathBuf]) -> Vec<PathBuf> {
        self.watched_roots
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .filter(|root| {
                paths.is_empty() || paths.iter().any(|path| Self::paths_overlap(root, path))
            })
            .cloned()
            .collect()
    }

    fn invalidate_paths(&self, paths: &[PathBuf]) -> Vec<PathBuf> {
        let roots = self.affected_roots(paths);
        if roots.is_empty() {
            return roots;
        }
        self.invalidate_roots(&roots);
        roots
    }

    fn invalidate_roots(&self, roots: &[PathBuf]) {
        if roots.is_empty() {
            return;
        }
        {
            let mut generations = self.generations.lock().unwrap_or_else(|e| e.into_inner());
            for root in roots {
                *generations.entry(root.clone()).or_insert(0) += 1;
            }
        }
        self.ready
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|key, _| {
                !roots
                    .iter()
                    .any(|root| Self::paths_overlap(&key.operand, root))
            });
        self.fuzzy
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|key, _| {
                !roots
                    .iter()
                    .any(|root| Self::paths_overlap(&key.walk.operand, root))
            });
        let stale: Vec<Arc<LiveWalk>> = {
            let mut live = self.live.lock().unwrap_or_else(|e| e.into_inner());
            let stale = live
                .iter()
                .filter(|(key, _)| {
                    roots
                        .iter()
                        .any(|root| Self::paths_overlap(&key.operand, root))
                })
                .map(|(_, value)| Arc::clone(value))
                .collect();
            live.retain(|key, _| {
                !roots
                    .iter()
                    .any(|root| Self::paths_overlap(&key.operand, root))
            });
            stale
        };
        for live in stale {
            // Cache invalidation applies to future searches. Existing waiters
            // still receive the snapshot they started; it simply cannot be
            // cached under the newer generation.
            live.keep_warm.store(false, Ordering::Release);
            if live.waiters.load(Ordering::Acquire) == 0 {
                live.cancelled.store(true, Ordering::Release);
                let mut state = live.state.lock().unwrap_or_else(|e| e.into_inner());
                if matches!(&*state, LiveState::Running) {
                    *state = LiveState::Abandoned;
                }
                live.cond.notify_all();
            }
        }
    }

    fn watch_root(self: &Arc<Self>, operand: &Path) -> bool {
        let watch_operand = if operand.is_file() {
            operand.parent().unwrap_or(operand)
        } else {
            operand
        };
        if !watch_operand.is_dir() {
            return false;
        }
        let root = normalized_operand(watch_operand);
        if !self.watcher_healthy.load(Ordering::Acquire) {
            let stale_roots = {
                let mut watcher = self.watcher.lock().unwrap_or_else(|e| e.into_inner());
                if self.watcher_healthy.load(Ordering::Acquire) {
                    Vec::new()
                } else {
                    *watcher = None;
                    let mut roots = self.watched_roots.lock().unwrap_or_else(|e| e.into_inner());
                    roots.drain().map(|(path, _)| path).collect::<Vec<_>>()
                }
            };
            if !stale_roots.is_empty() {
                self.invalidate_roots(&stale_roots);
            }
        }
        // An existing recursive watch on an ancestor already covers this root.
        // Registering every explicit file operand's parent as its own root
        // churned the WATCH_ROOT_MAX-bounded set (evict → invalidate
        // broadcast → client in-flight abort → retry → re-register), which
        // looped candidate-scoped fan-out greps indefinitely. Invalidation
        // stays correct: affected_roots/invalidate_roots match cache keys by
        // path overlap, so events under the ancestor reach descendant
        // operands. Refresh the covering root so hot ancestors stay resident.
        {
            let mut roots = self.watched_roots.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(covering) = roots
                .keys()
                .find(|existing| root.starts_with(existing.as_path()))
                .cloned()
            {
                roots.insert(covering, Instant::now());
                return true;
            }
        }
        let mut watcher = self.watcher.lock().unwrap_or_else(|e| e.into_inner());
        if watcher.is_none() {
            let weak: Weak<Self> = Arc::downgrade(self);
            let created =
                notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                    let Some(store) = weak.upgrade() else { return };
                    let (paths, inventory_changed) = match event {
                        Ok(event) => {
                            let Some(inventory_changed) = inventory_changed_by_event(&event.kind)
                            else {
                                return;
                            };
                            let raw_paths = event.paths;
                            let had_paths = !raw_paths.is_empty();
                            // Writes inside pruned directories (.git objects,
                            // node_modules installs, build caches) cannot alter
                            // any served result, so they must not invalidate the
                            // inventory — that churn used to force a full
                            // re-walk on every request.
                            let paths: Vec<PathBuf> = raw_paths
                                .iter()
                                .filter(|path| !is_noise_path(path))
                                .cloned()
                                .collect();
                            if had_paths && paths.is_empty() {
                                // A root deliberately opened inside a noise
                                // directory still needs its own events.
                                if !store.has_noise_root() {
                                    return;
                                }
                                (raw_paths, inventory_changed)
                            } else {
                                (paths, inventory_changed)
                            }
                        }
                        Err(_) => {
                            store.watcher_healthy.store(false, Ordering::Release);
                            (Vec::new(), true)
                        }
                    };
                    let changed = if inventory_changed {
                        store.invalidate_paths(&paths)
                    } else {
                        // Content/metadata changes invalidate JS grep and mtime
                        // result caches, but the file-name inventory is still
                        // current and remains reusable.
                        store.affected_roots(&paths)
                    };
                    if !changed.is_empty() {
                        write_response(&serde_json::json!({
                            "event": "invalidate",
                            "paths": changed.iter().map(|path| wire_path(path)).collect::<Vec<_>>()
                        }));
                    }
                });
            let Ok(created) = created else { return false };
            *watcher = Some(created);
            self.watcher_healthy.store(true, Ordering::Release);
        }
        // Never hold watched_roots across the OS watch/unwatch calls. Windows
        // may synchronously emit an initial notify callback from watch(); that
        // callback re-enters affected_roots/invalidate_paths and needs this
        // mutex. Holding it here deadlocked every concurrent directory search
        // until the outer 20s deadline killed the resident server.
        let evicted = {
            let mut roots = self.watched_roots.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(touched) = roots.get_mut(&root) {
                *touched = Instant::now();
                return self.watcher_healthy.load(Ordering::Acquire);
            }
            if roots.len() >= WATCH_ROOT_MAX {
                let oldest = roots
                    .iter()
                    .min_by_key(|(_, touched)| **touched)
                    .map(|(path, _)| path.clone());
                if let Some(oldest) = oldest.as_ref() {
                    roots.remove(oldest);
                }
                oldest
            } else {
                None
            }
        };
        if let Some(oldest) = evicted.as_ref() {
            if let Some(watcher) = watcher.as_mut() {
                let _ = watcher.unwatch(oldest);
            }
            self.invalidate_roots(std::slice::from_ref(oldest));
            write_response(&serde_json::json!({
                "event": "invalidate",
                "paths": [wire_path(oldest)],
            }));
        }
        let watched = watcher
            .as_mut()
            .is_some_and(|watcher| watcher.watch(&root, RecursiveMode::Recursive).is_ok());
        if watched {
            self.watched_roots
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(root, Instant::now());
        }
        watched
    }

    fn take_ready(&self, key: &WalkKey) -> Option<Arc<Vec<PathBuf>>> {
        let generation = self.generation(&key.operand);
        let mut ready = self.ready.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        ready.retain(|_, entry| entry.expires_at > now);
        if !ready.contains_key(key) {
            self.fuzzy
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .retain(|fuzzy, _| &fuzzy.walk != key);
        }
        let entry = ready
            .get_mut(key)
            .filter(|entry| entry.generation == generation)?;
        entry.touched_at = now;
        Some(Arc::clone(&entry.files))
    }

    fn remember(&self, key: WalkKey, files: Arc<Vec<PathBuf>>, generation: u64) {
        let Some(ttl) = file_list_ttl() else { return };
        if self.generation(&key.operand) != generation {
            return;
        }
        let estimated_bytes = paths_storage_bytes(&files);
        let bytes_limit = file_list_cache_bytes();
        if estimated_bytes > bytes_limit {
            return;
        }
        let mut ready = self.ready.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        ready.retain(|_, entry| entry.expires_at > now);
        ready.remove(&key);
        while !ready.is_empty()
            && (ready.len() >= FILE_LIST_CACHE_MAX
                || ready.values().fold(estimated_bytes, |total, entry| {
                    total.saturating_add(entry.estimated_bytes)
                }) > bytes_limit)
        {
            if let Some(oldest) = ready
                .iter()
                .min_by_key(|(_, entry)| entry.touched_at)
                .map(|(k, _)| k.clone())
            {
                ready.remove(&oldest);
            } else {
                break;
            }
        }
        ready.insert(
            key.clone(),
            ReadyEntry {
                files,
                expires_at: now + ttl,
                generation,
                touched_at: now,
                estimated_bytes,
            },
        );
        self.fuzzy
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|fuzzy, _| fuzzy.walk != key);
    }

    fn fuzzy_corpus(
        &self,
        key: &FuzzyKey,
        files: &Arc<Vec<PathBuf>>,
        root: &Path,
        filter: &PathFilter,
    ) -> Arc<FuzzyCorpus> {
        {
            let mut fuzzy = self.fuzzy.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(entry) = fuzzy.get_mut(key) {
                entry.touched_at = Instant::now();
                return Arc::clone(&entry.corpus);
            }
        }
        let corpus = Arc::new(FuzzyCorpus {
            paths: files
                .iter()
                .filter(|file| filter.allows(file))
                .map(|file| {
                    let relative = file.strip_prefix(root).unwrap_or(file);
                    let path = relative.to_string_lossy().replace('\\', "/");
                    FuzzyIndexedPath {
                        matcher_text: Utf32String::from(path.clone()),
                        path,
                    }
                })
                .collect(),
        });
        let estimated_bytes = fuzzy_storage_bytes(&corpus);
        let bytes_limit = fuzzy_cache_bytes();
        if estimated_bytes > bytes_limit {
            return corpus;
        }
        let mut fuzzy = self.fuzzy.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = fuzzy.get_mut(key) {
            entry.touched_at = Instant::now();
            return Arc::clone(&entry.corpus);
        }
        while !fuzzy.is_empty()
            && (fuzzy.len() >= FILE_LIST_CACHE_MAX
                || fuzzy.values().fold(estimated_bytes, |total, entry| {
                    total.saturating_add(entry.estimated_bytes)
                }) > bytes_limit)
        {
            if let Some(oldest) = fuzzy
                .iter()
                .min_by_key(|(_, entry)| entry.touched_at)
                .map(|(key, _)| key.clone())
            {
                fuzzy.remove(&oldest);
            } else {
                break;
            }
        }
        fuzzy.insert(
            key.clone(),
            FuzzyEntry {
                corpus: Arc::clone(&corpus),
                touched_at: Instant::now(),
                estimated_bytes,
            },
        );
        corpus
    }

    fn begin_live(&self, key: WalkKey, keep_warm: bool) -> (Arc<LiveWalk>, bool) {
        // Read the generation before taking the live-map lock; generation()
        // locks the generations mutex and nesting it under `live` invites
        // lock-order inversions with invalidation.
        let generation = self.generation(&key.operand);
        let mut live = self.live.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = live.get(&key) {
            if keep_warm {
                existing.keep_warm.store(true, Ordering::Release);
            }
            existing.waiters.fetch_add(1, Ordering::Relaxed);
            return (Arc::clone(existing), false);
        }
        let created = Arc::new(LiveWalk {
            files: Mutex::new(Vec::new()),
            state: Mutex::new(LiveState::Running),
            cond: Condvar::new(),
            files_cond: Condvar::new(),
            waiters: AtomicUsize::new(1),
            cancelled: AtomicBool::new(false),
            keep_warm: AtomicBool::new(keep_warm),
            cacheable: AtomicBool::new(true),
            walk_errors: AtomicUsize::new(0),
            walk_error_details: Mutex::new(Vec::new()),
            generation,
        });
        live.insert(key, Arc::clone(&created));
        (created, true)
    }

    fn waiter_guard<'a>(&'a self, key: WalkKey, live: Arc<LiveWalk>) -> LiveWaiterGuard<'a> {
        LiveWaiterGuard {
            store: self,
            key,
            live,
        }
    }

    fn release_live(&self, key: &WalkKey, live: &Arc<LiveWalk>) {
        let previous = live.waiters.fetch_sub(1, Ordering::AcqRel);
        debug_assert!(previous > 0, "live inventory waiter underflow");
        if previous != 1 || live.keep_warm.load(Ordering::Acquire) {
            return;
        }
        let should_cancel = {
            let mut live_map = self.live.lock().unwrap_or_else(|e| e.into_inner());
            let same = live_map
                .get(key)
                .is_some_and(|current| Arc::ptr_eq(current, live));
            let idle = live.waiters.load(Ordering::Acquire) == 0
                && !live.keep_warm.load(Ordering::Acquire);
            if same && idle {
                live_map.remove(key);
            }
            idle
        };
        if should_cancel {
            live.cancelled.store(true, Ordering::Release);
            let mut state = live.state.lock().unwrap_or_else(|e| e.into_inner());
            if matches!(&*state, LiveState::Running) {
                *state = LiveState::Abandoned;
            }
            live.cond.notify_all();
        }
    }

    fn finish_live(
        &self,
        key: WalkKey,
        live: &Arc<LiveWalk>,
        result: Result<Arc<Vec<PathBuf>>, Option<String>>,
    ) -> bool {
        // Same ordering rule as begin_live: never lock generations under the
        // live-map lock. remember() re-checks the current generation, so a
        // racing invalidation still prevents caching a stale inventory.
        let current_generation = self.generation(&key.operand);
        let cacheable = {
            let mut live_map = self.live.lock().unwrap_or_else(|e| e.into_inner());
            let same = live_map
                .get(&key)
                .is_some_and(|current| Arc::ptr_eq(current, live));
            if same {
                live_map.remove(&key);
            }
            same && current_generation == live.generation
                && live.cacheable.load(Ordering::Acquire)
                && live.walk_errors.load(Ordering::Acquire) == 0
        };
        let mut state = live.state.lock().unwrap_or_else(|e| e.into_inner());
        *state = match result {
            Ok(files) => {
                if cacheable {
                    self.remember(key, Arc::clone(&files), live.generation);
                }
                LiveState::Done(files)
            }
            Err(Some(err)) => LiveState::Failed(err),
            Err(None) => LiveState::Abandoned,
        };
        live.cond.notify_all();
        live.files_cond.notify_all();
        cacheable
    }
}

fn inventory_changed_by_event(kind: &EventKind) -> Option<bool> {
    match kind {
        EventKind::Create(_) | EventKind::Modify(ModifyKind::Name(_)) | EventKind::Remove(_) => {
            Some(true)
        }
        EventKind::Modify(_) => Some(false),
        _ => None,
    }
}

#[derive(Deserialize)]
struct ServeRequest {
    id: u64,
    cwd: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    offset: usize,
    #[serde(default)]
    limit: usize,
    #[serde(default, rename = "deadlineMs")]
    deadline_ms: Option<u64>,
    #[serde(default, rename = "keepWarm")]
    keep_warm: bool,
    // Client-supplied breadth hint: broad directory content scans (multi-
    // pattern fan-out combined pass and its speculative prefilter) opt into
    // the bulk lane so they cannot saturate the interactive worker pool.
    #[serde(default, rename = "bulkHint")]
    bulk_hint: bool,
    #[serde(default)]
    fuzzy: Option<String>,
    #[serde(default)]
    hidden: bool,
    #[serde(default, rename = "includeNoise")]
    include_noise: bool,
    #[serde(default, rename = "maxDepth")]
    max_depth: Option<usize>,
    #[serde(default)]
    exclude: Vec<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum WireRequest {
    Search(ServeRequest),
    Cancel {
        cancel: u64,
    },
    ProcessSnapshot {
        id: u64,
        #[serde(rename = "processSnapshot")]
        process_snapshot: bool,
    },
}

#[derive(Clone)]
struct ParsedArgs {
    patterns: Vec<String>,
    globs: Vec<String>,
    iglobs: Vec<String>,
    targets: Vec<String>,
    before: usize,
    after: usize,
    case_insensitive: bool,
    fixed_strings: bool,
    hidden: bool,
    no_ignore: bool,
    no_require_git: bool,
    max_depth: Option<usize>,
    line_numbers: bool,
    with_filename: bool,
    files_with_matches: bool,
    count: bool,
    only_matching: bool,
    pcre2: bool,
    multiline: bool,
    multiline_dotall: bool,
    file_types: Vec<String>,
    files_list: bool,
    directories: bool,
    max_columns: usize,
}

struct PathFilter {
    globs: Override,
    iglobs: Option<Override>,
    types: Option<Types>,
}

impl PathFilter {
    fn new(root: &Path, parsed: &ParsedArgs) -> Result<Self, String> {
        // `OverrideBuilder` requires a directory root. When rg's positional
        // operand is an exact file, using that file as the root makes its
        // relative path empty, so ordinary filters such as `*.mjs` reject the
        // file. Match ripgrep by evaluating file operands from their parent.
        let filter_root = if root.is_file() {
            root.parent().unwrap_or(root)
        } else {
            root
        };
        let mut globs = OverrideBuilder::new(filter_root);
        for glob in &parsed.globs {
            globs.add(glob).map_err(|error| format!("glob: {error}"))?;
        }
        let globs = globs.build().map_err(|error| format!("glob: {error}"))?;
        let iglobs = if parsed.iglobs.is_empty() {
            None
        } else {
            let mut builder = OverrideBuilder::new(filter_root);
            builder
                .case_insensitive(true)
                .map_err(|error| format!("iglob: {error}"))?;
            for glob in &parsed.iglobs {
                builder
                    .add(glob)
                    .map_err(|error| format!("iglob: {error}"))?;
            }
            Some(builder.build().map_err(|error| format!("iglob: {error}"))?)
        };
        let types = if parsed.file_types.is_empty() {
            None
        } else {
            let mut builder = TypesBuilder::new();
            builder.add_defaults();
            for file_type in &parsed.file_types {
                builder.select(file_type);
            }
            Some(builder.build().map_err(|error| format!("type: {error}"))?)
        };
        Ok(Self {
            globs,
            iglobs,
            types,
        })
    }

    fn allows(&self, path: &Path) -> bool {
        !self.globs.matched(path, false).is_ignore()
            && !self
                .iglobs
                .as_ref()
                .is_some_and(|matcher| matcher.matched(path, false).is_ignore())
            && !self
                .types
                .as_ref()
                .is_some_and(|matcher| matcher.matched(path, false).is_ignore())
    }
}

fn parse_args(args: &[String]) -> Result<ParsedArgs, String> {
    let mut p = ParsedArgs {
        patterns: Vec::new(),
        globs: Vec::new(),
        iglobs: Vec::new(),
        targets: Vec::new(),
        before: 0,
        after: 0,
        case_insensitive: false,
        fixed_strings: false,
        hidden: false,
        no_ignore: false,
        no_require_git: false,
        max_depth: None,
        line_numbers: false,
        with_filename: false,
        files_with_matches: false,
        count: false,
        only_matching: false,
        pcre2: false,
        multiline: false,
        multiline_dotall: false,
        file_types: Vec::new(),
        files_list: false,
        directories: false,
        max_columns: 0,
    };
    let mut i = 0usize;
    let mut options = true;
    let take = |i: &mut usize, args: &[String]| -> Result<String, String> {
        *i += 1;
        args.get(*i)
            .cloned()
            .ok_or_else(|| "missing flag value".to_string())
    };
    while i < args.len() {
        let a = args[i].as_str();
        if !options {
            p.targets.push(a.to_string());
            i += 1;
            continue;
        }
        match a {
            "--" => options = false,
            "--color" => {
                take(&mut i, args)?;
            }
            "--threads" | "-j" => {
                take(&mut i, args)?;
            }
            "--hidden" => p.hidden = true,
            "--no-ignore" => p.no_ignore = true,
            "--no-require-git" => p.no_require_git = true,
            "--no-heading" | "--max-columns-preview" => {}
            "-H" => p.with_filename = true,
            "--line-number" | "-n" => p.line_numbers = true,
            "-i" => p.case_insensitive = true,
            "-F" => p.fixed_strings = true,
            "-P" => p.pcre2 = true,
            "-U" => p.multiline = true,
            "--multiline-dotall" => p.multiline_dotall = true,
            "--only-matching" | "-o" => p.only_matching = true,
            "--count" => p.count = true,
            "--files-with-matches" | "-l" => p.files_with_matches = true,
            "--files" => p.files_list = true,
            "--directories" => p.directories = true,
            "--type" => p.file_types.push(take(&mut i, args)?),
            "-e" => p.patterns.push(take(&mut i, args)?),
            "--glob" => {
                p.globs.push(take(&mut i, args)?);
            }
            "--iglob" => {
                p.iglobs.push(take(&mut i, args)?);
            }
            "--max-depth" => {
                p.max_depth = Some(take(&mut i, args)?.parse().map_err(|_| "bad --max-depth")?);
            }
            "-B" => p.before = take(&mut i, args)?.parse().map_err(|_| "bad -B")?,
            "-A" => p.after = take(&mut i, args)?.parse().map_err(|_| "bad -A")?,
            "-C" => {
                let n: usize = take(&mut i, args)?.parse().map_err(|_| "bad -C")?;
                p.before = n;
                p.after = n;
            }
            _ if a.starts_with("--max-columns=") => {
                p.max_columns = a["--max-columns=".len()..]
                    .parse()
                    .map_err(|_| "bad --max-columns")?;
            }
            _ if a.starts_with("--threads=") || a.starts_with("-j") && a.len() > 2 => {}
            _ if !a.starts_with('-') => p.targets.push(a.to_string()),
            other => return Err(format!("unsupported flag {other}")),
        }
        i += 1;
    }
    if p.patterns.is_empty() && !p.files_list {
        return Err("no -e patterns".to_string());
    }
    if p.targets.is_empty() {
        return Err("no target path".to_string());
    }
    Ok(p)
}

enum CompiledMatcher {
    Rust(grep::regex::RegexMatcher),
    Pcre(grep::pcre2::RegexMatcher),
}

fn build_matcher(parsed: &ParsedArgs) -> Result<CompiledMatcher, String> {
    if parsed.pcre2 {
        let mut builder = grep::pcre2::RegexMatcherBuilder::new();
        builder
            .caseless(parsed.case_insensitive)
            .fixed_strings(parsed.fixed_strings)
            .multi_line(true)
            .dotall(parsed.multiline_dotall)
            .utf(true)
            .ucp(true)
            .jit_if_available(true);
        return builder
            .build_many(&parsed.patterns)
            .map(CompiledMatcher::Pcre)
            .map_err(|error| format!("regex parse error: {error}"));
    }
    let mut builder = grep::regex::RegexMatcherBuilder::new();
    builder
        .case_insensitive(parsed.case_insensitive)
        .fixed_strings(parsed.fixed_strings)
        .multi_line(true)
        .dot_matches_new_line(parsed.multiline_dotall);
    if !parsed.multiline {
        builder.line_terminator(Some(b'\n'));
    }
    builder
        .build_many(&parsed.patterns)
        .map(CompiledMatcher::Rust)
        .map_err(|error| format!("regex parse error: {error}"))
}

struct CancelSink<'a, S> {
    inner: S,
    cancelled: &'a AtomicBool,
    match_limit: Option<usize>,
    matches: usize,
}

impl<S: Sink> Sink for CancelSink<'_, S> {
    type Error = S::Error;

    fn matched(&mut self, searcher: &Searcher, mat: &SinkMatch<'_>) -> Result<bool, Self::Error> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Ok(false);
        }
        let keep_going = self.inner.matched(searcher, mat)?;
        self.matches += 1;
        Ok(keep_going && self.match_limit.is_none_or(|limit| self.matches < limit))
    }

    fn context(
        &mut self,
        searcher: &Searcher,
        context: &SinkContext<'_>,
    ) -> Result<bool, Self::Error> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Ok(false);
        }
        self.inner.context(searcher, context)
    }

    fn context_break(&mut self, searcher: &Searcher) -> Result<bool, Self::Error> {
        self.inner.context_break(searcher)
    }

    fn binary_data(
        &mut self,
        searcher: &Searcher,
        binary_byte_offset: u64,
    ) -> Result<bool, Self::Error> {
        self.inner.binary_data(searcher, binary_byte_offset)
    }

    fn begin(&mut self, searcher: &Searcher) -> Result<bool, Self::Error> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Ok(false);
        }
        self.inner.begin(searcher)
    }

    fn finish(&mut self, searcher: &Searcher, finish: &SinkFinish) -> Result<(), Self::Error> {
        self.inner.finish(searcher, finish)
    }
}

struct CancellableReader<'a, R> {
    inner: R,
    cancelled: &'a AtomicBool,
    deadline_at: Option<Instant>,
    chunk_bytes: usize,
}

impl<'a, R> CancellableReader<'a, R> {
    fn new(inner: R, cancelled: &'a AtomicBool, deadline_at: Option<Instant>) -> Self {
        Self {
            inner,
            cancelled,
            deadline_at,
            chunk_bytes: search_reader_chunk_bytes(),
        }
    }
}

impl<R: Read> Read for CancellableReader<'_, R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(io::Error::new(io::ErrorKind::Interrupted, CANCELLED));
        }
        if self
            .deadline_at
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            return Err(io::Error::new(io::ErrorKind::TimedOut, SOFT_TIMEOUT));
        }
        let bounded = buffer.len().min(self.chunk_bytes);
        self.inner.read(&mut buffer[..bounded])
    }
}

fn searcher(parsed: &ParsedArgs) -> Searcher {
    let mut builder = SearcherBuilder::new();
    builder
        .line_number(parsed.line_numbers)
        .multi_line(parsed.multiline)
        .before_context(parsed.before)
        .after_context(parsed.after)
        .heap_limit(Some(search_heap_bytes()))
        .binary_detection(BinaryDetection::quit(b'\x00'));
    builder.build()
}

fn output_lines(bytes: Vec<u8>) -> Option<Vec<String>> {
    let lines: Vec<String> = String::from_utf8_lossy(&bytes)
        .lines()
        .map(str::to_string)
        .collect();
    (!lines.is_empty()).then_some(lines)
}

fn scan_standard<M: Matcher>(
    path: &Path,
    prefix: &str,
    matcher: &M,
    p: &ParsedArgs,
    cancelled: &AtomicBool,
    deadline_at: Option<Instant>,
    match_limit: Option<usize>,
    scan_errors: &AtomicUsize,
) -> Option<Vec<String>> {
    let mut printer_builder = StandardBuilder::new();
    printer_builder
        .heading(false)
        .path(!prefix.is_empty())
        .only_matching(p.only_matching)
        .max_columns((p.max_columns > 0).then_some(p.max_columns as u64))
        .max_columns_preview(true);
    let mut printer = printer_builder.build_no_color(Vec::new());
    let mut searcher = searcher(p);
    // An unreadable file must not read as "no matches in this file": count it
    // so the response downgrades to partial (rg reports the same condition on
    // stderr and exits 2).
    let file = match File::open(path) {
        Ok(file) => file,
        Err(_) => {
            scan_errors.fetch_add(1, Ordering::Relaxed);
            return None;
        }
    };
    let reader = CancellableReader::new(file, cancelled, deadline_at);
    let result = if prefix.is_empty() {
        let inner = printer.sink(matcher);
        let mut sink = CancelSink {
            inner,
            cancelled,
            match_limit,
            matches: 0,
        };
        searcher.search_reader(matcher, reader, &mut sink)
    } else {
        let printer_path = PathBuf::from(prefix);
        let inner = printer.sink_with_path(matcher, &printer_path);
        let mut sink = CancelSink {
            inner,
            cancelled,
            match_limit,
            matches: 0,
        };
        searcher.search_reader(matcher, reader, &mut sink)
    };
    if cancelled.load(Ordering::Relaxed) {
        return None;
    }
    if result.is_err() {
        // Either the soft deadline fired mid-scan (surfaced by the response-
        // level deadline re-check) or a real read error. Count only the
        // latter so a genuine I/O failure downgrades the response to partial.
        if !deadline_at.is_some_and(|deadline| Instant::now() >= deadline) {
            scan_errors.fetch_add(1, Ordering::Relaxed);
        }
        return None;
    }
    output_lines(printer.into_inner().into_inner())
}

fn scan_summary<M: Matcher>(
    path: &Path,
    prefix: &str,
    matcher: &M,
    p: &ParsedArgs,
    cancelled: &AtomicBool,
    deadline_at: Option<Instant>,
    scan_errors: &AtomicUsize,
) -> Option<Vec<String>> {
    let kind = if p.files_with_matches {
        SummaryKind::PathWithMatch
    } else {
        SummaryKind::Count
    };
    let mut printer_builder = SummaryBuilder::new();
    printer_builder
        .kind(kind)
        .path(!prefix.is_empty())
        .exclude_zero(true);
    let mut printer = printer_builder.build_no_color(Vec::new());
    let mut searcher = searcher(p);
    // Same unreadable-file accounting as scan_standard.
    let file = match File::open(path) {
        Ok(file) => file,
        Err(_) => {
            scan_errors.fetch_add(1, Ordering::Relaxed);
            return None;
        }
    };
    let reader = CancellableReader::new(file, cancelled, deadline_at);
    let result = if prefix.is_empty() {
        let inner = printer.sink(matcher);
        let mut sink = CancelSink {
            inner,
            cancelled,
            match_limit: None,
            matches: 0,
        };
        searcher.search_reader(matcher, reader, &mut sink)
    } else {
        let printer_path = PathBuf::from(prefix);
        let inner = printer.sink_with_path(matcher, &printer_path);
        let mut sink = CancelSink {
            inner,
            cancelled,
            match_limit: None,
            matches: 0,
        };
        searcher.search_reader(matcher, reader, &mut sink)
    };
    if cancelled.load(Ordering::Relaxed) {
        return None;
    }
    if result.is_err() {
        // Same deadline-vs-real-error split as scan_standard.
        if !deadline_at.is_some_and(|deadline| Instant::now() >= deadline) {
            scan_errors.fetch_add(1, Ordering::Relaxed);
        }
        return None;
    }
    output_lines(printer.into_inner().into_inner())
}

fn scan_file(
    path: &Path,
    prefix: &str,
    matcher: &CompiledMatcher,
    parsed: &ParsedArgs,
    cancelled: &AtomicBool,
    deadline_at: Option<Instant>,
    match_limit: Option<usize>,
    scan_errors: &AtomicUsize,
) -> Option<Vec<String>> {
    macro_rules! scan {
        ($matcher:expr) => {
            if parsed.files_with_matches || parsed.count {
                scan_summary(
                    path,
                    prefix,
                    $matcher,
                    parsed,
                    cancelled,
                    deadline_at,
                    scan_errors,
                )
            } else {
                scan_standard(
                    path,
                    prefix,
                    $matcher,
                    parsed,
                    cancelled,
                    deadline_at,
                    match_limit,
                    scan_errors,
                )
            }
        };
    }
    match matcher {
        CompiledMatcher::Rust(matcher) => scan!(matcher),
        CompiledMatcher::Pcre(matcher) => scan!(matcher),
    }
}

fn display_path(operand: &str, operand_path: &Path, file: &Path) -> String {
    if operand_path.is_file() {
        return operand.to_string();
    }
    let rel = file.strip_prefix(operand_path).unwrap_or(file);
    let sep = if operand.contains('/') && !operand.contains('\\') {
        "/"
    } else {
        std::path::MAIN_SEPARATOR_STR
    };
    let rel = rel.to_string_lossy().replace(['/', '\\'], sep);
    let trimmed = operand.trim_end_matches(['/', '\\']);
    format!("{trimmed}{sep}{rel}")
}

fn append_scanned_matches(
    files: &[PathBuf],
    operand: &str,
    operand_path: &Path,
    use_prefix: bool,
    matcher: &CompiledMatcher,
    parsed: &ParsedArgs,
    filter: &PathFilter,
    cancelled: &AtomicBool,
    deadline_at: Option<Instant>,
    all_lines: &mut Vec<String>,
    emitted_blocks: &mut usize,
    collect_until: usize,
    scan_errors: &AtomicUsize,
    files_scanned: &AtomicUsize,
) -> bool {
    if files.is_empty() || all_lines.len() >= collect_until {
        return all_lines.len() >= collect_until;
    }
    let per_file: Vec<Option<Vec<String>>> = files
        .par_iter()
        .map(|file| {
            if cancelled.load(Ordering::Relaxed)
                || deadline_at.is_some_and(|deadline| Instant::now() >= deadline)
                || !filter.allows(file)
            {
                return None;
            }
            let prefix = if use_prefix {
                display_path(operand, operand_path, file)
            } else {
                String::new()
            };
            files_scanned.fetch_add(1, Ordering::Relaxed);
            scan_file(
                file,
                &prefix,
                matcher,
                parsed,
                cancelled,
                deadline_at,
                (collect_until != usize::MAX).then_some(collect_until),
                scan_errors,
            )
        })
        .collect();
    for block in per_file.into_iter().flatten() {
        if *emitted_blocks > 0
            && (parsed.before > 0 || parsed.after > 0)
            && !parsed.files_with_matches
        {
            all_lines.push("--".to_string());
        }
        *emitted_blocks += 1;
        all_lines.extend(block);
        if all_lines.len() >= collect_until {
            all_lines.truncate(collect_until);
            return true;
        }
    }
    all_lines.len() >= collect_until
}

fn append_scanned_matches_unordered(
    files: &[PathBuf],
    operand: &str,
    operand_path: &Path,
    use_prefix: bool,
    matcher: &CompiledMatcher,
    parsed: &ParsedArgs,
    filter: &PathFilter,
    cancelled: &AtomicBool,
    deadline_at: Option<Instant>,
    all_lines: &mut Vec<String>,
    emitted_blocks: &mut usize,
    collect_until: usize,
    scan_errors: &AtomicUsize,
    files_scanned: &AtomicUsize,
) -> bool {
    let remaining = collect_until.saturating_sub(all_lines.len());
    if files.is_empty() || remaining == 0 {
        return remaining == 0;
    }
    let done = AtomicBool::new(false);
    let gathered = Mutex::new((Vec::new(), 0usize));
    files.par_iter().for_each(|file| {
        if done.load(Ordering::Relaxed)
            || cancelled.load(Ordering::Relaxed)
            || deadline_at.is_some_and(|deadline| Instant::now() >= deadline)
            || !filter.allows(file)
        {
            return;
        }
        let prefix = if use_prefix {
            display_path(operand, operand_path, file)
        } else {
            String::new()
        };
        files_scanned.fetch_add(1, Ordering::Relaxed);
        let Some(block) = scan_file(
            file,
            &prefix,
            matcher,
            parsed,
            cancelled,
            deadline_at,
            Some(remaining),
            scan_errors,
        ) else {
            return;
        };
        let mut state = gathered.lock().unwrap_or_else(|e| e.into_inner());
        if state.0.len() >= remaining {
            done.store(true, Ordering::Relaxed);
            return;
        }
        if *emitted_blocks + state.1 > 0
            && (parsed.before > 0 || parsed.after > 0)
            && !parsed.files_with_matches
        {
            state.0.push("--".to_string());
        }
        state.1 += 1;
        let available = remaining.saturating_sub(state.0.len());
        state.0.extend(block.into_iter().take(available));
        if state.0.len() >= remaining {
            done.store(true, Ordering::Relaxed);
        }
    });
    let (lines, blocks) = gathered.into_inner().unwrap_or_else(|e| e.into_inner());
    *emitted_blocks += blocks;
    all_lines.extend(lines);
    all_lines.len() >= collect_until
}

fn publish_live_files(live: &LiveWalk, files: &[PathBuf]) {
    if files.is_empty() {
        return;
    }
    if let Ok(mut guard) = live.files.lock() {
        guard.extend(files.iter().cloned());
    }
    live.files_cond.notify_all();
}

fn inventory_parallelism() -> usize {
    let available = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2);
    std::env::var("MIXDOG_SEARCH_INVENTORY_INFLIGHT")
        .ok()
        .and_then(|raw| raw.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or_else(|| available.clamp(1, 2))
        .clamp(1, 8)
}

fn inventory_publish_batch() -> usize {
    std::env::var("MIXDOG_SEARCH_INVENTORY_PUBLISH_BATCH")
        .ok()
        .and_then(|raw| raw.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(256)
        .clamp(128, 512)
}

fn inventory_pool() -> &'static ThreadPool {
    static POOL: OnceLock<ThreadPool> = OnceLock::new();
    POOL.get_or_init(|| {
        ThreadPoolBuilder::new()
            .num_threads(inventory_parallelism())
            .thread_name(|index| format!("mixdog-search-inventory-{index}"))
            .build()
            .expect("mixdog inventory worker pool")
    })
}

fn inventory_walk_threads() -> usize {
    std::env::var("MIXDOG_SEARCH_INVENTORY_THREADS")
        .ok()
        .and_then(|raw| raw.parse::<usize>().ok())
        .filter(|threads| *threads > 0)
        .unwrap_or_else(|| {
            std::thread::available_parallelism()
                .map(usize::from)
                .unwrap_or(2)
        })
        .clamp(2, 4)
}

struct CollectedWalk {
    files: Vec<PathBuf>,
}

struct WorkerWalkBatch<'a> {
    collected: &'a Mutex<CollectedWalk>,
    live: &'a LiveWalk,
    files: Vec<PathBuf>,
    capacity: usize,
}

fn contain_search_panic<T, F>(label: &str, run: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String>,
{
    catch_unwind(AssertUnwindSafe(run))
        .unwrap_or_else(|_| Err(format!("{label} panicked; request isolated")))
}

fn record_walk_error(live: &LiveWalk, detail: impl ToString) {
    live.walk_errors.fetch_add(1, Ordering::Relaxed);
    let mut details = live
        .walk_error_details
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if details.len() >= WALK_ERROR_DETAIL_MAX {
        return;
    }
    details.push(
        detail
            .to_string()
            .chars()
            .take(WALK_ERROR_DETAIL_CHARS)
            .collect(),
    );
}

fn live_walk_error_details(live: &LiveWalk) -> Vec<String> {
    live.walk_error_details
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

fn append_walk_error_details(target: &mut Vec<String>, details: Vec<String>) {
    for detail in details {
        if target.len() >= WALK_ERROR_DETAIL_MAX {
            break;
        }
        if !target.contains(&detail) {
            target.push(detail);
        }
    }
}

impl<'a> WorkerWalkBatch<'a> {
    fn new(collected: &'a Mutex<CollectedWalk>, live: &'a LiveWalk, capacity: usize) -> Self {
        Self {
            collected,
            live,
            files: Vec::with_capacity(capacity),
            capacity,
        }
    }

    fn push(&mut self, path: PathBuf) {
        self.files.push(path);
        if self.files.len() >= self.capacity {
            self.flush();
        }
    }

    fn flush(&mut self) {
        if self.files.is_empty() {
            return;
        }
        if let Ok(mut collected) = self.collected.lock() {
            let start = collected.files.len();
            collected.files.append(&mut self.files);
            publish_live_files(self.live, &collected.files[start..]);
        } else {
            self.files.clear();
        }
    }
}

impl Drop for WorkerWalkBatch<'_> {
    fn drop(&mut self) {
        self.flush();
    }
}

fn start_live_walk(
    store: Arc<FileListStore>,
    key: WalkKey,
    live: Arc<LiveWalk>,
    operand: PathBuf,
    parsed: ParsedArgs,
) {
    inventory_pool().spawn(move || {
        let result = contain_search_panic("native inventory worker", || {
            if operand.is_file() {
                let files = vec![operand];
                publish_live_files(&live, &files);
                return Ok(Arc::new(files));
            }
            if !operand.is_dir() {
                return Err(format!("no such path {}", operand.display()));
            }
            let mut walk = WalkBuilder::new(&operand);
            walk.hidden(!parsed.hidden)
                .threads(inventory_walk_threads());
            if parsed.no_ignore {
                walk.ignore(false)
                    .git_ignore(false)
                    .git_global(false)
                    .git_exclude(false);
            } else if parsed.no_require_git {
                walk.require_git(false);
            }
            if let Some(max_depth) = parsed.max_depth {
                walk.max_depth(Some(max_depth));
            }
            // Prune excluded directories while walking. Without this the
            // inventory descends into .git/node_modules on every request and
            // only discards them later, at scan time.
            let prune = prune_globs(&operand, &parsed);
            if let Some(overrides) = prune_overrides(&operand, &prune) {
                walk.overrides(overrides);
            }
            let collected = Mutex::new(CollectedWalk { files: Vec::new() });
            let publish_batch = inventory_publish_batch();
            walk.build_parallel().run(|| {
                let collected = &collected;
                let live = &live;
                let operand = &operand;
                let mut batch = WorkerWalkBatch::new(collected, live, publish_batch);
                Box::new(move |entry| {
                    if live.cancelled.load(Ordering::Acquire) {
                        return ignore::WalkState::Quit;
                    }
                    let entry = match entry {
                        Ok(entry) => entry,
                        Err(error) => {
                            record_walk_error(live, error);
                            return ignore::WalkState::Continue;
                        }
                    };
                    let (is_file, is_dir) = if let Some(kind) = entry.file_type() {
                        (kind.is_file(), kind.is_dir())
                    } else {
                        match entry.metadata() {
                            Ok(metadata) => (metadata.is_file(), metadata.is_dir()),
                            Err(error) => {
                                record_walk_error(live, error);
                                return ignore::WalkState::Continue;
                            }
                        }
                    };
                    if !is_file
                        && !(parsed.directories && is_dir && entry.path() != operand.as_path())
                    {
                        return ignore::WalkState::Continue;
                    }
                    let path = entry.into_path();
                    batch.push(path);
                    ignore::WalkState::Continue
                })
            });
            if live.cancelled.load(Ordering::Acquire) {
                return Err(CANCELLED.to_string());
            }
            let collected = collected
                .into_inner()
                .map_err(|_| "parallel file collector poisoned".to_string())?;
            let mut files = collected.files;
            files.sort();
            Ok(Arc::new(files))
        });
        match result {
            Ok(files) => {
                store.finish_live(key, &live, Ok(files));
            }
            Err(error) if error == CANCELLED => {
                store.finish_live(key, &live, Err(None));
            }
            Err(error) => {
                store.finish_live(key, &live, Err(Some(error)));
            }
        }
    });
}

fn wait_live_complete(
    live: &LiveWalk,
    cancelled: &AtomicBool,
    deadline_at: Option<Instant>,
) -> Result<Option<Arc<Vec<PathBuf>>>, String> {
    let mut state = live.state.lock().unwrap_or_else(|e| e.into_inner());
    loop {
        if cancelled.load(Ordering::Relaxed) {
            return Err(CANCELLED.to_string());
        }
        if deadline_at.is_some_and(|deadline| Instant::now() >= deadline) {
            return Err(SOFT_TIMEOUT.to_string());
        }
        match &*state {
            LiveState::Running => {
                state = live
                    .cond
                    .wait_timeout(state, Duration::from_millis(10))
                    .unwrap_or_else(|e| e.into_inner())
                    .0;
            }
            LiveState::Done(files) => return Ok(Some(Arc::clone(files))),
            LiveState::Abandoned => return Ok(None),
            LiveState::Failed(err) => return Err(err.clone()),
        }
    }
}

fn complete_operand_files(
    store: &Arc<FileListStore>,
    operand_path: &Path,
    parsed: &ParsedArgs,
    cancelled: &AtomicBool,
    deadline_at: Option<Instant>,
    keep_warm: bool,
) -> Result<(Arc<Vec<PathBuf>>, bool, usize, Vec<String>, bool), String> {
    let watched = store.watch_root(operand_path);
    // A walk abandoned by cache invalidation restarts from scratch. Under
    // continuous writes under the root that can repeat until the request
    // deadline, so cap it: after one restart the partial snapshot is served
    // instead of burning the whole budget on re-walks.
    const MAX_WALK_RESTARTS: usize = 1;
    let mut restarts = 0usize;
    loop {
        let key = walk_key(operand_path, parsed);
        if let Some(hit) = store.take_ready(&key) {
            return Ok((hit, true, 0, Vec::new(), watched));
        }
        let (live, owner) = store.begin_live(key.clone(), keep_warm);
        if !watched {
            live.cacheable.store(false, Ordering::Release);
        }
        let _waiter = store.waiter_guard(key.clone(), Arc::clone(&live));
        if owner {
            start_live_walk(
                Arc::clone(store),
                key,
                Arc::clone(&live),
                operand_path.to_path_buf(),
                parsed.clone(),
            );
        }
        match wait_live_complete(&live, cancelled, deadline_at) {
            Ok(Some(files)) => {
                return Ok((
                    files,
                    true,
                    live.walk_errors.load(Ordering::Acquire),
                    live_walk_error_details(&live),
                    live.cacheable.load(Ordering::Acquire),
                ))
            }
            Ok(None) => {
                restarts += 1;
                if restarts > MAX_WALK_RESTARTS {
                    let snapshot = live.files.lock().unwrap_or_else(|e| e.into_inner()).clone();
                    return Ok((
                        Arc::new(snapshot),
                        false,
                        live.walk_errors.load(Ordering::Acquire),
                        live_walk_error_details(&live),
                        false,
                    ));
                }
                continue;
            }
            Err(reason) if reason == SOFT_TIMEOUT => {
                let snapshot = live.files.lock().unwrap_or_else(|e| e.into_inner()).clone();
                return Ok((
                    Arc::new(snapshot),
                    false,
                    live.walk_errors.load(Ordering::Acquire),
                    live_walk_error_details(&live),
                    false,
                ));
            }
            Err(reason) => return Err(reason),
        }
    }
}

fn scan_limited_operand(
    store: &Arc<FileListStore>,
    operand: &str,
    operand_path: &Path,
    parsed: &ParsedArgs,
    filter: &PathFilter,
    matcher: &CompiledMatcher,
    cancelled: &AtomicBool,
    deadline_at: Option<Instant>,
    keep_warm: bool,
    _chunk_size: usize,
    use_prefix: bool,
    all_lines: &mut Vec<String>,
    emitted_blocks: &mut usize,
    collect_until: usize,
    scan_errors: &AtomicUsize,
    files_scanned: &AtomicUsize,
) -> Result<(bool, bool, bool, Vec<String>), String> {
    let watched = store.watch_root(operand_path);
    if deadline_at.is_some_and(|deadline| Instant::now() >= deadline) {
        return Ok((false, true, watched, Vec::new()));
    }
    let key = walk_key(operand_path, parsed);
    if let Some(files) = store.take_ready(&key) {
        let reached_limit = append_scanned_matches_unordered(
            &files,
            operand,
            operand_path,
            use_prefix,
            matcher,
            parsed,
            filter,
            cancelled,
            deadline_at,
            all_lines,
            emitted_blocks,
            collect_until,
            scan_errors,
            files_scanned,
        );
        let timed_out = deadline_at.is_some_and(|deadline| Instant::now() >= deadline);
        return Ok((reached_limit, timed_out, watched, Vec::new()));
    }
    let (live, owner) = store.begin_live(key.clone(), keep_warm);
    if !watched {
        live.cacheable.store(false, Ordering::Release);
    }
    let _waiter = store.waiter_guard(key.clone(), Arc::clone(&live));
    if owner {
        start_live_walk(
            Arc::clone(store),
            key,
            Arc::clone(&live),
            operand_path.to_path_buf(),
            parsed.clone(),
        );
    }
    let mut cursor = 0usize;
    let account_walk_errors = || {
        let count = live.walk_errors.load(Ordering::Acquire);
        if count > 0 {
            scan_errors.fetch_add(count, Ordering::Relaxed);
        }
    };
    let outcome = |reached_limit, timed_out| {
        (
            reached_limit,
            timed_out,
            live.cacheable.load(Ordering::Acquire),
            live_walk_error_details(&live),
        )
    };
    loop {
        if cancelled.load(Ordering::Relaxed) {
            return Err(CANCELLED.to_string());
        }
        if deadline_at.is_some_and(|deadline| Instant::now() >= deadline) {
            account_walk_errors();
            return Ok(outcome(false, true));
        }
        let batch = {
            let mut files = live.files.lock().unwrap_or_else(|e| e.into_inner());
            while cursor >= files.len() {
                let state = live.state.lock().unwrap_or_else(|e| e.into_inner());
                match &*state {
                    LiveState::Done(_) => {
                        account_walk_errors();
                        return Ok(outcome(false, false));
                    }
                    LiveState::Abandoned => return Err(CANCELLED.to_string()),
                    LiveState::Failed(error) => return Err(error.clone()),
                    LiveState::Running => {}
                }
                drop(state);
                let waited = live
                    .files_cond
                    .wait_timeout(files, Duration::from_millis(10))
                    .unwrap_or_else(|e| e.into_inner());
                files = waited.0;
                if cancelled.load(Ordering::Relaxed) {
                    return Err(CANCELLED.to_string());
                }
                if deadline_at.is_some_and(|deadline| Instant::now() >= deadline) {
                    account_walk_errors();
                    return Ok(outcome(false, true));
                }
            }
            let batch = files[cursor..].to_vec();
            cursor = files.len();
            batch
        };
        let reached_limit = append_scanned_matches_unordered(
            &batch,
            operand,
            operand_path,
            use_prefix,
            matcher,
            parsed,
            filter,
            cancelled,
            deadline_at,
            all_lines,
            emitted_blocks,
            collect_until,
            scan_errors,
            files_scanned,
        );
        if deadline_at.is_some_and(|deadline| Instant::now() >= deadline) {
            account_walk_errors();
            return Ok(outcome(reached_limit, true));
        }
        if reached_limit {
            account_walk_errors();
            return Ok(outcome(true, false));
        }
    }
}

#[derive(Eq, PartialEq)]
struct FuzzyHit {
    score: u32,
    path: String,
}

impl Ord for FuzzyHit {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        other
            .score
            .cmp(&self.score)
            .then_with(|| self.path.cmp(&other.path))
    }
}

impl PartialOrd for FuzzyHit {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

fn handle_fuzzy(
    req: &ServeRequest,
    cancelled: &AtomicBool,
    store: &Arc<FileListStore>,
    deadline_at: Option<Instant>,
) -> Result<serde_json::Value, String> {
    use std::collections::BinaryHeap;

    let query = req
        .fuzzy
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "empty fuzzy query".to_string())?;
    let limit = req.limit.clamp(1, 1_000);
    let parsed = ParsedArgs {
        patterns: Vec::new(),
        globs: req.exclude.clone(),
        iglobs: Vec::new(),
        targets: vec![".".to_string()],
        before: 0,
        after: 0,
        case_insensitive: true,
        fixed_strings: false,
        hidden: req.hidden,
        no_ignore: req.include_noise,
        no_require_git: !req.include_noise,
        max_depth: req.max_depth,
        line_numbers: false,
        with_filename: false,
        files_with_matches: false,
        count: false,
        only_matching: false,
        pcre2: false,
        multiline: false,
        multiline_dotall: false,
        file_types: Vec::new(),
        files_list: true,
        directories: true,
        max_columns: 0,
    };
    let root = Path::new(&req.cwd);
    let key = fuzzy_key(root, &parsed);
    let filter = PathFilter::new(root, &parsed)?;
    let (files, walk_complete, walk_errors, walk_error_details, cache_safe) =
        complete_operand_files(store, root, &parsed, cancelled, deadline_at, req.keep_warm)?;
    let inventory_complete = walk_complete && walk_errors == 0;
    let corpus = if inventory_complete {
        store.fuzzy_corpus(&key, &files, root, &filter)
    } else {
        Arc::new(FuzzyCorpus {
            paths: files
                .iter()
                .filter(|file| filter.allows(file))
                .map(|file| {
                    let relative = file.strip_prefix(root).unwrap_or(file);
                    let path = relative.to_string_lossy().replace('\\', "/");
                    FuzzyIndexedPath {
                        matcher_text: Utf32String::from(path.clone()),
                        path,
                    }
                })
                .collect(),
        })
    };
    let pattern = Pattern::new(
        query,
        CaseMatching::Ignore,
        Normalization::Smart,
        AtomKind::Fuzzy,
    );
    let mut matcher = FuzzyMatcher::new(FuzzyConfig::DEFAULT.match_paths());
    let mut matches = BinaryHeap::with_capacity(limit + 1);
    let mut total_matches = 0usize;
    let mut total_seen = 0usize;
    let mut timed_out = !walk_complete;
    for (index, indexed) in corpus.paths.iter().enumerate() {
        if index & 1023 == 0 {
            if cancelled.load(Ordering::Relaxed) {
                return Err(CANCELLED.to_string());
            }
            if deadline_at.is_some_and(|deadline| Instant::now() >= deadline) {
                timed_out = true;
                break;
            }
        }
        total_seen = index + 1;
        let score = pattern.score(indexed.matcher_text.slice(..), &mut matcher);
        let Some(score) = score else { continue };
        total_matches += 1;
        let candidate = FuzzyHit {
            score,
            path: indexed.path.clone(),
        };
        if matches.len() < limit {
            matches.push(candidate);
            continue;
        }
        let replace = matches.peek().is_some_and(|worst| {
            candidate.score > worst.score
                || (candidate.score == worst.score && candidate.path < worst.path)
        });
        if replace {
            matches.pop();
            matches.push(candidate);
        }
    }
    let mut matches = matches.into_vec();
    matches.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.path.cmp(&right.path))
    });
    let paths: Vec<String> = matches.into_iter().map(|entry| entry.path).collect();
    Ok(serde_json::json!({
        "id": req.id,
        "matches": paths,
        "hasMore": total_matches > limit,
        "totalMatches": total_matches,
        "totalSeen": total_seen,
        "complete": inventory_complete && !timed_out,
        "partial": timed_out || walk_errors > 0,
        "timeout": timed_out,
        "scanErrors": walk_errors,
        "walkErrorDetails": walk_error_details,
        "inventoryChecked": inventory_complete,
        "cacheSafe": cache_safe,
    }))
}

fn handle(
    req: &ServeRequest,
    cancelled: &AtomicBool,
    store: &Arc<FileListStore>,
    deadline_at: Option<Instant>,
) -> Result<serde_json::Value, String> {
    if req.fuzzy.is_some() {
        return handle_fuzzy(req, cancelled, store, deadline_at);
    }
    let parsed = parse_args(&req.args)?;
    let collect_until = if req.limit > 0 {
        req.offset.saturating_add(req.limit).saturating_add(1)
    } else {
        usize::MAX
    };
    // Inventory mode for glob/find: consume paths as the two-thread walker
    // discovers them while the shared inventory continues to completion.
    if parsed.files_list {
        let cwd = Path::new(&req.cwd);
        let mut all_lines: Vec<String> = Vec::new();
        let mut timed_out = false;
        let mut scan_error_count = 0usize;
        let mut walk_error_details = Vec::new();
        let mut cache_safe = true;
        for operand in &parsed.targets {
            if cancelled.load(Ordering::Relaxed) {
                return Err(CANCELLED.to_string());
            }
            if deadline_at.is_some_and(|deadline| Instant::now() >= deadline) {
                timed_out = true;
                break;
            }
            let operand_path = if Path::new(operand).is_absolute() {
                PathBuf::from(operand)
            } else {
                cwd.join(operand)
            };
            let watched = store.watch_root(&operand_path);
            cache_safe &= watched;
            let filter = PathFilter::new(&operand_path, &parsed)?;
            if collect_until == usize::MAX {
                let (files, complete, walk_errors, details, operand_cache_safe) =
                    complete_operand_files(
                        store,
                        &operand_path,
                        &parsed,
                        cancelled,
                        deadline_at,
                        req.keep_warm,
                    )?;
                cache_safe &= operand_cache_safe;
                scan_error_count = scan_error_count.saturating_add(walk_errors);
                append_walk_error_details(&mut walk_error_details, details);
                for file in files.iter().filter(|file| filter.allows(file)) {
                    all_lines.push(display_path(operand, &operand_path, file));
                }
                if !complete {
                    timed_out = true;
                }
            } else {
                let key = walk_key(&operand_path, &parsed);
                if let Some(files) = store.take_ready(&key) {
                    for file in files.iter().filter(|file| filter.allows(file)) {
                        all_lines.push(display_path(operand, &operand_path, file));
                        if all_lines.len() >= collect_until {
                            break;
                        }
                    }
                } else {
                    let (live, owner) = store.begin_live(key.clone(), req.keep_warm);
                    if !watched {
                        live.cacheable.store(false, Ordering::Release);
                    }
                    let _waiter = store.waiter_guard(key.clone(), Arc::clone(&live));
                    if owner {
                        start_live_walk(
                            Arc::clone(store),
                            key,
                            Arc::clone(&live),
                            operand_path.clone(),
                            parsed.clone(),
                        );
                    }
                    let mut cursor = 0usize;
                    'inventory: loop {
                        let batch = {
                            let mut files = live.files.lock().unwrap_or_else(|e| e.into_inner());
                            while cursor >= files.len() {
                                let state = live.state.lock().unwrap_or_else(|e| e.into_inner());
                                match &*state {
                                    LiveState::Done(_) => break 'inventory,
                                    LiveState::Abandoned => {
                                        return Err(CANCELLED.to_string());
                                    }
                                    LiveState::Failed(error) => return Err(error.clone()),
                                    LiveState::Running => {}
                                }
                                drop(state);
                                files = live
                                    .files_cond
                                    .wait_timeout(files, Duration::from_millis(10))
                                    .unwrap_or_else(|e| e.into_inner())
                                    .0;
                                if cancelled.load(Ordering::Relaxed) {
                                    return Err(CANCELLED.to_string());
                                }
                                if deadline_at.is_some_and(|deadline| Instant::now() >= deadline) {
                                    timed_out = true;
                                    break 'inventory;
                                }
                            }
                            let batch = files[cursor..].to_vec();
                            cursor = files.len();
                            batch
                        };
                        for file in batch.iter().filter(|file| filter.allows(file)) {
                            all_lines.push(display_path(operand, &operand_path, file));
                            if all_lines.len() >= collect_until {
                                break 'inventory;
                            }
                        }
                        if deadline_at.is_some_and(|deadline| Instant::now() >= deadline) {
                            timed_out = true;
                            break 'inventory;
                        }
                    }
                    scan_error_count =
                        scan_error_count.saturating_add(live.walk_errors.load(Ordering::Acquire));
                    cache_safe &= live.cacheable.load(Ordering::Acquire);
                    append_walk_error_details(
                        &mut walk_error_details,
                        live_walk_error_details(&live),
                    );
                }
            }
            if timed_out || all_lines.len() >= collect_until {
                break;
            }
        }
        let total_after_offset = all_lines.len().saturating_sub(req.offset);
        let window: Vec<&String> = all_lines
            .iter()
            .skip(req.offset)
            .take(if req.limit > 0 { req.limit } else { usize::MAX })
            .collect();
        let complete = !timed_out
            && scan_error_count == 0
            && all_lines.len() < collect_until
            && (req.limit == 0 || total_after_offset <= req.limit);
        return Ok(serde_json::json!({
            "id": req.id,
            "lines": window,
            "complete": complete,
            "totalSeen": total_after_offset,
            "partial": timed_out || scan_error_count > 0,
            "timeout": timed_out,
            "scanErrors": scan_error_count,
            "walkErrorDetails": walk_error_details,
            "inventoryChecked": complete,
            "cacheSafe": cache_safe,
        }));
    }
    let matcher = build_matcher(&parsed)?;
    let cwd = Path::new(&req.cwd);
    let multi_target = parsed.targets.len() > 1;
    let mut all_lines: Vec<String> = Vec::new();
    let mut emitted_blocks = 0usize;
    let mut timed_out = false;
    let scan_errors = AtomicUsize::new(0);
    // Observability for silent-empty diagnosis: how many files the scan loops
    // actually opened. An empty result with filesScanned=0 on a scope that
    // demonstrably contains files is a server-state anomaly, not a no-match
    // (observed once in the wild; JS retries that signature once).
    let files_scanned = AtomicUsize::new(0);
    let mut walk_error_details = Vec::new();
    let mut cache_safe = true;
    let chunk_size = rayon::current_num_threads().max(4);
    'operands: for operand in &parsed.targets {
        if cancelled.load(Ordering::Relaxed) {
            return Err(CANCELLED.to_string());
        }
        if deadline_at.is_some_and(|deadline| Instant::now() >= deadline) {
            timed_out = true;
            break;
        }
        let operand_path = if Path::new(operand).is_absolute() {
            PathBuf::from(operand)
        } else {
            cwd.join(operand)
        };
        let use_prefix = parsed.with_filename
            || parsed.files_with_matches
            || multi_target
            || operand_path.is_dir();
        let filter = PathFilter::new(&operand_path, &parsed)?;
        if collect_until != usize::MAX {
            let (reached_limit, operand_timed_out, operand_cache_safe, details) =
                scan_limited_operand(
                    store,
                    operand,
                    &operand_path,
                    &parsed,
                    &filter,
                    &matcher,
                    cancelled,
                    deadline_at,
                    req.keep_warm,
                    chunk_size,
                    use_prefix,
                    &mut all_lines,
                    &mut emitted_blocks,
                    collect_until,
                    &scan_errors,
                    &files_scanned,
                )?;
            cache_safe &= operand_cache_safe;
            append_walk_error_details(&mut walk_error_details, details);
            if operand_timed_out {
                timed_out = true;
                break 'operands;
            }
            if reached_limit {
                break 'operands;
            }
            if all_lines.len() >= collect_until {
                break 'operands;
            }
            continue;
        }
        let (files, complete, walk_errors, details, operand_cache_safe) = complete_operand_files(
            store,
            &operand_path,
            &parsed,
            cancelled,
            deadline_at,
            req.keep_warm,
        )?;
        cache_safe &= operand_cache_safe;
        append_walk_error_details(&mut walk_error_details, details);
        if walk_errors > 0 {
            scan_errors.fetch_add(walk_errors, Ordering::Relaxed);
        }
        for file_chunk in files.chunks(chunk_size) {
            if cancelled.load(Ordering::Relaxed) {
                return Err(CANCELLED.to_string());
            }
            if deadline_at.is_some_and(|deadline| Instant::now() >= deadline) {
                timed_out = true;
                break 'operands;
            }
            if append_scanned_matches(
                file_chunk,
                operand,
                &operand_path,
                use_prefix,
                &matcher,
                &parsed,
                &filter,
                cancelled,
                deadline_at,
                &mut all_lines,
                &mut emitted_blocks,
                collect_until,
                &scan_errors,
                &files_scanned,
            ) {
                break 'operands;
            }
        }
        if !complete {
            timed_out = true;
            break;
        }
    }
    // scan_standard/scan_summary swallow a mid-file soft-deadline expiry: the
    // CancellableReader's TimedOut error surfaces as `None`, indistinguishable
    // from "no matches in this file", and the between-chunks deadline checks
    // never run again after the LAST file. Re-check the deadline once after
    // every scan loop so that expiry is reported as a partial, timed-out
    // response instead of a silent (possibly empty) complete one — observed
    // in the wild as a false "(no matches)" under 8-way host saturation.
    let timed_out = timed_out || deadline_at.is_some_and(|deadline| Instant::now() >= deadline);
    // Files that failed to open/read mid-walk were skipped, not searched:
    // surface the count so the caller can distinguish "no matches" from
    // "not fully searched" (rg's stderr + exit-2 contract, JSONL-shaped).
    let scan_error_count = scan_errors.load(Ordering::Relaxed);
    let total_after_offset = all_lines.len().saturating_sub(req.offset);
    let window: Vec<&String> = all_lines
        .iter()
        .skip(req.offset)
        .take(if req.limit > 0 { req.limit } else { usize::MAX })
        .collect();
    let complete = !timed_out
        && scan_error_count == 0
        && all_lines.len() < collect_until
        && (req.limit == 0 || total_after_offset <= req.limit);
    Ok(serde_json::json!({
        "id": req.id,
        "lines": window,
        "complete": complete,
        "totalSeen": total_after_offset,
        "partial": timed_out || scan_error_count > 0,
        "timeout": timed_out,
        "scanErrors": scan_error_count,
        "walkErrorDetails": walk_error_details,
        "filesScanned": files_scanned.load(Ordering::Relaxed),
        "inventoryChecked": complete,
        "cacheSafe": cache_safe,
    }))
}

fn server_parallelism() -> usize {
    let available = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2);
    std::env::var("MIXDOG_SEARCH_SERVER_MAX_INFLIGHT")
        .ok()
        .and_then(|raw| raw.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or_else(|| available.clamp(2, 8))
        .clamp(1, MAX_SEARCH_THREADS)
}

fn bulk_parallelism() -> usize {
    std::env::var("MIXDOG_SEARCH_SERVER_MAX_BULK_INFLIGHT")
        .ok()
        .and_then(|raw| raw.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(2)
        .min(server_parallelism())
}

fn interactive_reserve(total_limit: usize) -> usize {
    std::env::var("MIXDOG_SEARCH_INTERACTIVE_RESERVE")
        .ok()
        .and_then(|raw| raw.parse::<usize>().ok())
        .unwrap_or(1)
        .min(total_limit)
}

fn queue_capacity() -> usize {
    bounded_env_usize(
        "MIXDOG_SEARCH_SERVER_QUEUE_CAPACITY",
        DEFAULT_SEARCH_QUEUE_CAPACITY,
        1,
        MAX_SEARCH_QUEUE_CAPACITY,
    )
}

fn priority_queue_reserve(capacity: usize) -> usize {
    if capacity <= 1 {
        return 0;
    }
    bounded_env_usize(
        "MIXDOG_SEARCH_PRIORITY_QUEUE_RESERVE",
        capacity.div_ceil(8).clamp(1, 64),
        1,
        capacity - 1,
    )
}

fn queue_admission_capacity(class: SearchClass, capacity: usize, priority_reserve: usize) -> usize {
    if class == SearchClass::Bulk {
        capacity.saturating_sub(priority_reserve).max(1)
    } else {
        capacity
    }
}

fn response_queue_capacity() -> usize {
    bounded_env_usize(
        "MIXDOG_SEARCH_RESPONSE_QUEUE_CAPACITY",
        DEFAULT_RESPONSE_QUEUE_CAPACITY,
        1,
        MAX_RESPONSE_QUEUE_CAPACITY,
    )
}

struct ResponseQueueState {
    control: VecDeque<String>,
    normal: VecDeque<String>,
    writing: bool,
    closed: bool,
}

struct ResponseQueue {
    state: Mutex<ResponseQueueState>,
    changed: Condvar,
    space: Condvar,
    drained: Condvar,
    capacity: usize,
}

impl ResponseQueue {
    fn new(capacity: usize) -> Self {
        Self {
            state: Mutex::new(ResponseQueueState {
                control: VecDeque::new(),
                normal: VecDeque::new(),
                writing: false,
                closed: false,
            }),
            changed: Condvar::new(),
            space: Condvar::new(),
            drained: Condvar::new(),
            capacity,
        }
    }

    fn push(&self, line: String, control: bool) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        while !state.closed
            && state.control.len().saturating_add(state.normal.len()) >= self.capacity
        {
            state = self.space.wait(state).unwrap_or_else(|e| e.into_inner());
        }
        if state.closed {
            return;
        }
        if control {
            state.control.push_back(line);
        } else {
            state.normal.push_back(line);
        }
        self.changed.notify_one();
    }

    fn run(&self) {
        let stdout = std::io::stdout();
        let mut out = stdout.lock();
        loop {
            let line = {
                let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                while !state.closed && state.control.is_empty() && state.normal.is_empty() {
                    state = self.changed.wait(state).unwrap_or_else(|e| e.into_inner());
                }
                if state.closed && state.control.is_empty() && state.normal.is_empty() {
                    return;
                }
                let line = state
                    .control
                    .pop_front()
                    .or_else(|| state.normal.pop_front())
                    .expect("response queue line");
                state.writing = true;
                self.space.notify_all();
                line
            };
            let failed = writeln!(out, "{line}").and_then(|_| out.flush()).is_err();
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state.writing = false;
            if failed {
                state.closed = true;
                state.control.clear();
                state.normal.clear();
                self.changed.notify_all();
                self.space.notify_all();
            }
            if state.control.is_empty() && state.normal.is_empty() {
                self.drained.notify_all();
            }
            if failed {
                return;
            }
        }
    }

    fn flush(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        while !state.closed
            && (state.writing || !state.control.is_empty() || !state.normal.is_empty())
        {
            state = self.drained.wait(state).unwrap_or_else(|e| e.into_inner());
        }
    }
}

fn response_queue() -> &'static Arc<ResponseQueue> {
    static QUEUE: OnceLock<Arc<ResponseQueue>> = OnceLock::new();
    QUEUE.get_or_init(|| {
        let queue = Arc::new(ResponseQueue::new(response_queue_capacity()));
        let writer_queue = Arc::clone(&queue);
        std::thread::Builder::new()
            .name("mixdog-search-response-writer".to_string())
            .spawn(move || writer_queue.run())
            .expect("mixdog response writer");
        queue
    })
}

fn enqueue_response(response: &serde_json::Value, control: bool) {
    response_queue().push(response.to_string(), control);
}

fn write_response(response: &serde_json::Value) {
    enqueue_response(response, false);
}

fn write_control_response(response: &serde_json::Value) {
    enqueue_response(response, true);
}

fn flush_responses() {
    response_queue().flush();
}

fn write_cancelled(id: u64) {
    write_control_response(&serde_json::json!({ "id": id, "event": "cancelled" }));
}

fn search_pool(threads: usize) -> ThreadPool {
    ThreadPoolBuilder::new()
        .num_threads(threads)
        .thread_name(|index| format!("mixdog-search-{index}"))
        .build()
        .expect("mixdog search worker pool")
}

fn bulk_search_pool(threads: usize) -> ThreadPool {
    ThreadPoolBuilder::new()
        .num_threads(threads)
        .thread_name(|index| format!("mixdog-search-bulk-{index}"))
        .build()
        .expect("mixdog bulk search worker pool")
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SearchClass {
    Interactive,
    Fuzzy,
    Bulk,
}

fn search_class(req: &ServeRequest) -> SearchClass {
    if req.fuzzy.is_some() {
        SearchClass::Fuzzy
    } else if req.bulk_hint || req.args.iter().any(|arg| arg == "--files") {
        SearchClass::Bulk
    } else {
        SearchClass::Interactive
    }
}

struct ScheduledSearch {
    req: ServeRequest,
    cancelled: Arc<AtomicBool>,
    queued_at: Instant,
}

struct SchedulerState {
    interactive: VecDeque<ScheduledSearch>,
    fuzzy: VecDeque<ScheduledSearch>,
    bulk: VecDeque<ScheduledSearch>,
    interactive_inflight: usize,
    fuzzy_inflight: usize,
    bulk_inflight: usize,
    bulk_window: usize,
    queue_ewma_us: u64,
    handler_ewma_us: u64,
    healthy_completions: usize,
    saturation_count: u64,
    closed: bool,
}

impl SchedulerState {
    fn new(bulk_limit: usize) -> Self {
        Self {
            interactive: VecDeque::new(),
            fuzzy: VecDeque::new(),
            bulk: VecDeque::new(),
            interactive_inflight: 0,
            fuzzy_inflight: 0,
            bulk_inflight: 0,
            bulk_window: bulk_limit.max(1),
            queue_ewma_us: 0,
            handler_ewma_us: 0,
            healthy_completions: 0,
            saturation_count: 0,
            closed: false,
        }
    }
}

#[derive(Clone, Copy)]
struct SchedulerTelemetry {
    queue_depth: usize,
    inflight: usize,
    bulk_window: usize,
    bulk_limit: usize,
    queue_capacity: usize,
    priority_queue_reserve: usize,
    saturation_count: u64,
    queue_ewma_ms: u64,
    handler_ewma_ms: u64,
}

fn scheduler_telemetry(inner: &SchedulerInner, state: &SchedulerState) -> SchedulerTelemetry {
    SchedulerTelemetry {
        queue_depth: state
            .interactive
            .len()
            .saturating_add(state.fuzzy.len())
            .saturating_add(state.bulk.len()),
        inflight: state
            .interactive_inflight
            .saturating_add(state.fuzzy_inflight)
            .saturating_add(state.bulk_inflight),
        bulk_window: state.bulk_window,
        bulk_limit: inner.bulk_limit,
        queue_capacity: inner.queue_capacity,
        priority_queue_reserve: inner.priority_queue_reserve,
        saturation_count: state.saturation_count,
        queue_ewma_ms: state.queue_ewma_us / 1_000,
        handler_ewma_ms: state.handler_ewma_us / 1_000,
    }
}

fn telemetry_json(telemetry: SchedulerTelemetry) -> serde_json::Value {
    serde_json::json!({
        "queueDepth": telemetry.queue_depth,
        "inflight": telemetry.inflight,
        "bulkWindow": telemetry.bulk_window,
        "bulkLimit": telemetry.bulk_limit,
        "queueCapacity": telemetry.queue_capacity,
        "priorityQueueReserve": telemetry.priority_queue_reserve,
        "saturationCount": telemetry.saturation_count,
        "queueEwmaMs": telemetry.queue_ewma_ms,
        "handlerEwmaMs": telemetry.handler_ewma_ms,
    })
}

struct SchedulerInner {
    state: Mutex<SchedulerState>,
    changed: Condvar,
    interactive_pool: Arc<ThreadPool>,
    fuzzy_pool: Arc<ThreadPool>,
    bulk_pool: Arc<ThreadPool>,
    interactive_limit: usize,
    fuzzy_limit: usize,
    bulk_limit: usize,
    total_limit: usize,
    interactive_reserve: usize,
    queue_capacity: usize,
    priority_queue_reserve: usize,
    file_lists: Arc<FileListStore>,
    cancellations: Arc<Mutex<HashMap<u64, Arc<AtomicBool>>>>,
}

struct SearchScheduler {
    inner: Arc<SchedulerInner>,
    dispatcher: Option<JoinHandle<()>>,
}

impl SearchScheduler {
    fn new(
        file_lists: Arc<FileListStore>,
        cancellations: Arc<Mutex<HashMap<u64, Arc<AtomicBool>>>>,
    ) -> Self {
        let total_limit = server_parallelism();
        let interactive_reserve = interactive_reserve(total_limit);
        let interactive_limit = total_limit.saturating_add(interactive_reserve);
        let fuzzy_limit = total_limit;
        let bulk_limit = bulk_parallelism();
        let queue_capacity = queue_capacity();
        let inner = Arc::new(SchedulerInner {
            state: Mutex::new(SchedulerState::new(bulk_limit)),
            changed: Condvar::new(),
            interactive_pool: Arc::new(search_pool(interactive_limit)),
            fuzzy_pool: Arc::new(search_pool(fuzzy_limit)),
            bulk_pool: Arc::new(bulk_search_pool(bulk_limit)),
            interactive_limit,
            fuzzy_limit,
            bulk_limit,
            total_limit,
            interactive_reserve,
            queue_capacity,
            priority_queue_reserve: priority_queue_reserve(queue_capacity),
            file_lists,
            cancellations,
        });
        let dispatch_inner = Arc::clone(&inner);
        let dispatcher = std::thread::Builder::new()
            .name("mixdog-search-dispatch".to_string())
            .spawn(move || dispatch_searches(dispatch_inner))
            .expect("mixdog search dispatcher");
        Self {
            inner,
            dispatcher: Some(dispatcher),
        }
    }

    fn enqueue(&self, search: ScheduledSearch) -> Result<(), ScheduledSearch> {
        let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.closed {
            return Err(search);
        }
        let class = search_class(&search.req);
        let queue_depth = state
            .interactive
            .len()
            .saturating_add(state.fuzzy.len())
            .saturating_add(state.bulk.len());
        let admission_capacity = queue_admission_capacity(
            class,
            self.inner.queue_capacity,
            self.inner.priority_queue_reserve,
        );
        if queue_depth >= admission_capacity {
            state.saturation_count = state.saturation_count.saturating_add(1);
            return Err(search);
        }
        match class {
            SearchClass::Interactive => state.interactive.push_back(search),
            SearchClass::Fuzzy => state.fuzzy.push_back(search),
            SearchClass::Bulk => state.bulk.push_back(search),
        }
        self.inner.changed.notify_one();
        Ok(())
    }

    fn cancel_queued(&self, id: u64) -> bool {
        let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        let before = state.interactive.len() + state.fuzzy.len() + state.bulk.len();
        state.interactive.retain(|search| search.req.id != id);
        state.fuzzy.retain(|search| search.req.id != id);
        state.bulk.retain(|search| search.req.id != id);
        let removed = before != state.interactive.len() + state.fuzzy.len() + state.bulk.len();
        if removed {
            self.inner.changed.notify_all();
        }
        removed
    }

    fn telemetry(&self) -> SchedulerTelemetry {
        let state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        scheduler_telemetry(&self.inner, &state)
    }

    fn shutdown(mut self) {
        {
            let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
            state.closed = true;
            self.inner.changed.notify_all();
        }
        if let Some(dispatcher) = self.dispatcher.take() {
            let _ = dispatcher.join();
        }
    }
}

fn interactive_dispatch_ceiling(
    total_limit: usize,
    reserve: usize,
    has_pending_interactive: bool,
) -> usize {
    total_limit.saturating_add(if has_pending_interactive { reserve } else { 0 })
}

fn adaptive_bulk_limit(configured: usize, state: &SchedulerState) -> usize {
    let adaptive = configured.min(state.bulk_window.max(1));
    if state.interactive_inflight > 0 || !state.interactive.is_empty() {
        adaptive.min(1)
    } else {
        adaptive
    }
}

fn update_ewma(current: u64, sample: u64) -> u64 {
    if current == 0 {
        sample
    } else {
        current
            .saturating_mul(7)
            .saturating_add(sample)
            .saturating_div(8)
    }
}

fn duration_micros(duration: Duration) -> u64 {
    duration.as_micros().min(u128::from(u64::MAX)) as u64
}

fn observe_scheduler_latency(
    state: &mut SchedulerState,
    queue_elapsed: Duration,
    handler_elapsed: Duration,
    configured_bulk_limit: usize,
) {
    let queue_us = duration_micros(queue_elapsed);
    let handler_us = duration_micros(handler_elapsed);
    state.queue_ewma_us = update_ewma(state.queue_ewma_us, queue_us);
    state.handler_ewma_us = update_ewma(state.handler_ewma_us, handler_us);
    let target = aimd_target();
    if queue_elapsed > target || handler_elapsed > target {
        state.bulk_window = state.bulk_window.max(1).div_ceil(2);
        state.healthy_completions = 0;
        return;
    }
    if queue_elapsed <= target / 4
        && handler_elapsed <= target
        && state.interactive.is_empty()
        && state.bulk_window < configured_bulk_limit
    {
        state.healthy_completions = state.healthy_completions.saturating_add(1);
        if state.healthy_completions >= aimd_increase_every() {
            state.bulk_window = state
                .bulk_window
                .saturating_add(1)
                .min(configured_bulk_limit);
            state.healthy_completions = 0;
        }
    } else {
        state.healthy_completions = 0;
    }
}

fn dispatch_searches(inner: Arc<SchedulerInner>) {
    loop {
        let ready = {
            let mut state = inner.state.lock().unwrap_or_else(|e| e.into_inner());
            loop {
                let mut ready = Vec::new();
                let mut total_inflight = state
                    .interactive_inflight
                    .saturating_add(state.fuzzy_inflight)
                    .saturating_add(state.bulk_inflight);
                let interactive_ceiling = interactive_dispatch_ceiling(
                    inner.total_limit,
                    inner.interactive_reserve,
                    !state.interactive.is_empty(),
                );
                while state.interactive_inflight < inner.interactive_limit
                    && total_inflight < interactive_ceiling
                {
                    let Some(search) = state.interactive.pop_front() else {
                        break;
                    };
                    state.interactive_inflight += 1;
                    total_inflight += 1;
                    ready.push((SearchClass::Interactive, search));
                }
                while state.fuzzy_inflight < inner.fuzzy_limit && total_inflight < inner.total_limit
                {
                    let Some(search) = state.fuzzy.pop_front() else {
                        break;
                    };
                    state.fuzzy_inflight += 1;
                    total_inflight += 1;
                    ready.push((SearchClass::Fuzzy, search));
                }
                let current_bulk_limit = adaptive_bulk_limit(inner.bulk_limit, &state);
                while state.bulk_inflight < current_bulk_limit && total_inflight < inner.total_limit
                {
                    let Some(search) = state.bulk.pop_front() else {
                        break;
                    };
                    state.bulk_inflight += 1;
                    total_inflight += 1;
                    ready.push((SearchClass::Bulk, search));
                }
                if !ready.is_empty() {
                    break ready;
                }
                if state.closed
                    && state.interactive.is_empty()
                    && state.fuzzy.is_empty()
                    && state.bulk.is_empty()
                    && state.interactive_inflight == 0
                    && state.fuzzy_inflight == 0
                    && state.bulk_inflight == 0
                {
                    return;
                }
                state = inner.changed.wait(state).unwrap_or_else(|e| e.into_inner());
            }
        };

        for (class, search) in ready {
            let task_inner = Arc::clone(&inner);
            let pool = match class {
                SearchClass::Interactive => Arc::clone(&inner.interactive_pool),
                SearchClass::Fuzzy => Arc::clone(&inner.fuzzy_pool),
                SearchClass::Bulk => Arc::clone(&inner.bulk_pool),
            };
            pool.spawn(move || execute_scheduled_search(task_inner, class, search));
        }
    }
}

fn response_for_handler_result(
    id: u64,
    result: Result<serde_json::Value, String>,
    request_cancelled: bool,
) -> Option<serde_json::Value> {
    if request_cancelled {
        return None;
    }
    match result {
        Ok(value) => Some(value),
        Err(reason) if reason == CANCELLED => Some(serde_json::json!({
            "id": id,
            "error": "native inventory abandoned without request cancellation",
        })),
        Err(reason) => Some(serde_json::json!({ "id": id, "unsupported": reason })),
    }
}

fn execute_scheduled_search(
    inner: Arc<SchedulerInner>,
    class: SearchClass,
    search: ScheduledSearch,
) {
    let ScheduledSearch {
        req,
        cancelled,
        queued_at,
    } = search;
    let id = req.id;
    let queue_elapsed = queued_at.elapsed();
    let queue_ms = queue_elapsed.as_millis();
    let handler_started = Instant::now();
    let mut response = if cancelled.load(Ordering::Relaxed) {
        None
    } else {
        let deadline_at = req
            .deadline_ms
            .map(|deadline_ms| queued_at + Duration::from_millis(deadline_ms));
        let handled = contain_search_panic("native search handler", || {
            handle(&req, &cancelled, &inner.file_lists, deadline_at)
        });
        response_for_handler_result(req.id, handled, cancelled.load(Ordering::Relaxed))
    };
    let handler_elapsed = handler_started.elapsed();
    let handler_ms = handler_elapsed.as_millis();
    let telemetry = {
        let mut state = inner.state.lock().unwrap_or_else(|e| e.into_inner());
        match class {
            SearchClass::Interactive => {
                state.interactive_inflight = state.interactive_inflight.saturating_sub(1);
            }
            SearchClass::Fuzzy => {
                state.fuzzy_inflight = state.fuzzy_inflight.saturating_sub(1);
            }
            SearchClass::Bulk => {
                state.bulk_inflight = state.bulk_inflight.saturating_sub(1);
            }
        }
        observe_scheduler_latency(&mut state, queue_elapsed, handler_elapsed, inner.bulk_limit);
        let telemetry = scheduler_telemetry(&inner, &state);
        inner.changed.notify_all();
        telemetry
    };
    if let Some(value) = response.as_mut().and_then(serde_json::Value::as_object_mut) {
        value.insert("queueMs".to_string(), serde_json::json!(queue_ms));
        value.insert("handlerMs".to_string(), serde_json::json!(handler_ms));
        value.insert(
            "class".to_string(),
            serde_json::json!(match class {
                SearchClass::Interactive => "interactive",
                SearchClass::Fuzzy => "fuzzy",
                SearchClass::Bulk => "bulk",
            }),
        );
        value.insert("scheduler".to_string(), telemetry_json(telemetry));
    }
    if let Ok(mut map) = inner.cancellations.lock() {
        map.remove(&id);
    }
    if cancelled.load(Ordering::Relaxed) {
        write_cancelled(id);
    } else {
        if let Some(response) = response {
            write_response(&response);
        }
    }
}

#[cfg(target_os = "windows")]
fn process_snapshot(id: u64) -> serde_json::Value {
    use std::ffi::c_void;
    use std::mem;

    type Handle = *mut c_void;
    const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;
    const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;

    #[repr(C)]
    #[allow(non_snake_case)]
    struct ProcessEntry32W {
        dwSize: u32,
        cntUsage: u32,
        th32ProcessID: u32,
        th32DefaultHeapID: usize,
        th32ModuleID: u32,
        cntThreads: u32,
        th32ParentProcessID: u32,
        pcPriClassBase: i32,
        dwFlags: u32,
        szExeFile: [u16; 260],
    }

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct FileTime {
        low: u32,
        high: u32,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateToolhelp32Snapshot(flags: u32, process_id: u32) -> Handle;
        fn Process32FirstW(snapshot: Handle, entry: *mut ProcessEntry32W) -> i32;
        fn Process32NextW(snapshot: Handle, entry: *mut ProcessEntry32W) -> i32;
        fn OpenProcess(access: u32, inherit: i32, process_id: u32) -> Handle;
        fn GetProcessTimes(
            process: Handle,
            creation: *mut FileTime,
            exit: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }

    fn creation_identity(pid: u32) -> String {
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if process.is_null() {
            return String::new();
        }
        let mut creation = FileTime::default();
        let mut exit = FileTime::default();
        let mut kernel = FileTime::default();
        let mut user = FileTime::default();
        let ok =
            unsafe { GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) };
        unsafe {
            CloseHandle(process);
        }
        if ok == 0 {
            String::new()
        } else {
            ((u64::from(creation.high) << 32) | u64::from(creation.low)).to_string()
        }
    }

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return serde_json::json!({ "id": id, "error": "process snapshot failed" });
    }
    let mut entry = ProcessEntry32W {
        dwSize: mem::size_of::<ProcessEntry32W>() as u32,
        cntUsage: 0,
        th32ProcessID: 0,
        th32DefaultHeapID: 0,
        th32ModuleID: 0,
        cntThreads: 0,
        th32ParentProcessID: 0,
        pcPriClassBase: 0,
        dwFlags: 0,
        szExeFile: [0; 260],
    };
    let mut rows = Vec::new();
    let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) };
    while ok != 0 {
        if entry.th32ProcessID > 0 {
            rows.push(serde_json::json!({
                "pid": entry.th32ProcessID,
                "parentPid": entry.th32ParentProcessID,
                "identity": creation_identity(entry.th32ProcessID),
            }));
        }
        ok = unsafe { Process32NextW(snapshot, &mut entry) };
    }
    unsafe {
        CloseHandle(snapshot);
    }
    serde_json::json!({ "id": id, "rows": rows })
}

#[cfg(not(target_os = "windows"))]
fn process_snapshot(id: u64) -> serde_json::Value {
    serde_json::json!({ "id": id, "error": "process snapshot is only available on Windows" })
}

pub fn run() {
    write_control_response(&serde_json::json!({ "ready": true }));
    let file_lists = Arc::new(FileListStore::new());
    let cancellations: Arc<Mutex<HashMap<u64, Arc<AtomicBool>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let scheduler = SearchScheduler::new(Arc::clone(&file_lists), Arc::clone(&cancellations));
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<WireRequest>(&line) {
            Ok(WireRequest::Cancel { cancel }) => {
                let running = cancellations
                    .lock()
                    .ok()
                    .and_then(|map| map.get(&cancel).cloned())
                    .is_some_and(|flag| {
                        flag.store(true, Ordering::Relaxed);
                        true
                    });
                let removed = scheduler.cancel_queued(cancel);
                if removed || !running {
                    if let Ok(mut map) = cancellations.lock() {
                        map.remove(&cancel);
                    }
                    write_cancelled(cancel);
                }
            }
            Ok(WireRequest::ProcessSnapshot {
                id,
                process_snapshot: true,
            }) => write_control_response(&process_snapshot(id)),
            Ok(WireRequest::ProcessSnapshot { id, .. }) => write_control_response(
                &serde_json::json!({ "id": id, "error": "invalid process snapshot request" }),
            ),
            Ok(WireRequest::Search(req)) => {
                let id = req.id;
                let cancelled = Arc::new(AtomicBool::new(false));
                if let Ok(mut map) = cancellations.lock() {
                    map.insert(id, Arc::clone(&cancelled));
                }
                let scheduled = ScheduledSearch {
                    req,
                    cancelled,
                    queued_at: Instant::now(),
                };
                if let Err(search) = scheduler.enqueue(scheduled) {
                    if let Ok(mut map) = cancellations.lock() {
                        map.remove(&id);
                    }
                    let telemetry = scheduler.telemetry();
                    write_response(&serde_json::json!({
                        "id": search.req.id,
                        "error": "native search queue saturated",
                        "saturated": true,
                        "scheduler": telemetry_json(telemetry),
                    }));
                }
            }
            Err(error) => write_response(
                &serde_json::json!({ "id": 0, "error": format!("bad request: {error}") }),
            ),
        }
    }
    scheduler.shutdown();
    flush_responses();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(args: &[&str], limit: usize) -> ServeRequest {
        ServeRequest {
            id: 1,
            cwd: ".".to_string(),
            args: args.iter().map(|value| (*value).to_string()).collect(),
            offset: 0,
            limit,
            deadline_ms: None,
            keep_warm: false,
            bulk_hint: false,
            fuzzy: None,
            hidden: false,
            include_noise: false,
            max_depth: None,
            exclude: Vec::new(),
        }
    }

    #[test]
    fn every_file_enumeration_uses_the_bulk_lane() {
        assert_eq!(
            search_class(&request(&["--files", "."], 0)),
            SearchClass::Bulk
        );
        assert_eq!(
            search_class(&request(&["--files", "."], 50_000)),
            SearchClass::Bulk
        );
        assert_eq!(
            search_class(&request(&["-e", "needle", "."], 400)),
            SearchClass::Interactive
        );
        let mut broad = request(&["-e", "needle", "."], 400);
        broad.bulk_hint = true;
        assert_eq!(search_class(&broad), SearchClass::Bulk);
        let mut fuzzy = request(&[], 20);
        fuzzy.fuzzy = Some("needle".to_string());
        assert_eq!(search_class(&fuzzy), SearchClass::Fuzzy);
    }

    #[test]
    fn inventory_key_is_shared_across_request_globs() {
        let first = request(&["--files", "--glob", "*.rs", "."], 20);
        let second = request(&["--files", "--glob", "*.ts", "."], 20);
        let first = parse_args(&first.args).unwrap();
        let second = parse_args(&second.args).unwrap();
        assert!(walk_key(Path::new("."), &first) == walk_key(Path::new("."), &second));
        assert!(fuzzy_key(Path::new("."), &first) != fuzzy_key(Path::new("."), &second));
    }

    #[test]
    fn negative_globs_prune_the_walk_and_split_the_inventory_key() {
        let plain = parse_args(&request(&["--files", "."], 20).args).unwrap();
        let excluded = parse_args(
            &request(
                &["--files", "--glob", "!**/node_modules/**", "."],
                20,
            )
            .args,
        )
        .unwrap();
        let prune = prune_globs(Path::new("."), &excluded);
        // The directory entry itself must be rejected, otherwise the walker
        // descends into node_modules before discarding its contents.
        assert!(prune.iter().any(|glob| glob == "!**/node_modules"));
        assert!(prune.iter().any(|glob| glob == "!**/node_modules/**"));
        assert!(walk_key(Path::new("."), &plain) != walk_key(Path::new("."), &excluded));
        assert!(prune_overrides(Path::new("."), &prune).is_some());
    }

    #[test]
    fn git_directory_is_pruned_unless_the_caller_targets_it() {
        let parsed = parse_args(&request(&["--files", "."], 20).args).unwrap();
        let prune = prune_globs(Path::new("."), &parsed);
        assert!(prune.iter().any(|glob| glob == "!**/.git"));
        assert!(prune.iter().any(|glob| glob == "!**/.git/**"));
        let inside = prune_globs(Path::new("repo/.git"), &parsed);
        assert!(inside.is_empty());
    }

    #[test]
    fn descendant_operands_reuse_the_ancestor_watch_root() {
        let store = Arc::new(FileListStore::new());
        let dir = std::env::temp_dir().join("mixdog-watch-cover-test");
        let sub = dir.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        assert!(store.watch_root(&dir));
        assert!(store.watch_root(&sub));
        assert_eq!(
            store
                .watched_roots
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .len(),
            1
        );
    }

    #[test]
    fn noise_writes_do_not_invalidate_the_inventory() {
        assert!(is_noise_path(Path::new("repo/.git/objects/ab/cdef")));
        assert!(is_noise_path(Path::new("repo/node_modules/pkg/index.js")));
        assert!(!is_noise_path(Path::new("repo/src/main.rs")));
    }

    #[test]
    fn watcher_preserves_inventory_for_content_changes_only() {
        assert_eq!(
            inventory_changed_by_event(&EventKind::Modify(ModifyKind::Any)),
            Some(false)
        );
        assert_eq!(
            inventory_changed_by_event(&EventKind::Modify(ModifyKind::Name(
                notify::event::RenameMode::Any,
            ))),
            Some(true)
        );
        assert_eq!(
            inventory_changed_by_event(&EventKind::Create(notify::event::CreateKind::Any)),
            Some(true)
        );
        assert_eq!(
            inventory_changed_by_event(&EventKind::Remove(notify::event::RemoveKind::Any)),
            Some(true)
        );
        assert_eq!(inventory_changed_by_event(&EventKind::Other), None);
    }

    #[test]
    fn inventory_walk_parallelism_stays_bounded() {
        assert!((2..=4).contains(&inventory_walk_threads()));
    }

    #[test]
    fn complete_inventory_wait_honors_request_cancellation() {
        let live = LiveWalk {
            files: Mutex::new(Vec::new()),
            state: Mutex::new(LiveState::Running),
            cond: Condvar::new(),
            files_cond: Condvar::new(),
            waiters: AtomicUsize::new(0),
            cancelled: AtomicBool::new(false),
            keep_warm: AtomicBool::new(false),
            cacheable: AtomicBool::new(true),
            walk_errors: AtomicUsize::new(0),
            walk_error_details: Mutex::new(Vec::new()),
            generation: 0,
        };
        let cancelled = AtomicBool::new(true);
        assert_eq!(
            wait_live_complete(&live, &cancelled, None).unwrap_err(),
            CANCELLED
        );
    }

    #[test]
    fn complete_inventory_wait_honors_soft_deadline() {
        let live = LiveWalk {
            files: Mutex::new(Vec::new()),
            state: Mutex::new(LiveState::Running),
            cond: Condvar::new(),
            files_cond: Condvar::new(),
            waiters: AtomicUsize::new(0),
            cancelled: AtomicBool::new(false),
            keep_warm: AtomicBool::new(false),
            cacheable: AtomicBool::new(true),
            walk_errors: AtomicUsize::new(0),
            walk_error_details: Mutex::new(Vec::new()),
            generation: 0,
        };
        let cancelled = AtomicBool::new(false);
        assert_eq!(
            wait_live_complete(
                &live,
                &cancelled,
                Some(Instant::now() - Duration::from_millis(1)),
            )
            .unwrap_err(),
            SOFT_TIMEOUT
        );
    }

    #[test]
    fn unreadable_file_counts_a_scan_error_instead_of_silent_no_match() {
        let parsed = parse_args(&request(&["-e", "x", "."], 10).args).unwrap();
        let matcher = build_matcher(&parsed).unwrap();
        let cancelled = AtomicBool::new(false);
        let scan_errors = AtomicUsize::new(0);
        // A file that vanished (or is unreadable) between the walk and the
        // scan: the scan yields None, but the error counter must record that
        // this file was skipped rather than searched-and-empty.
        let missing = std::env::temp_dir().join("mg-vanished-during-walk.txt");
        std::fs::remove_file(&missing).ok();
        assert!(scan_file(
            &missing,
            "",
            &matcher,
            &parsed,
            &cancelled,
            None,
            None,
            &scan_errors,
        )
        .is_none());
        assert_eq!(scan_errors.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn expired_deadline_never_reports_a_silent_complete_empty_result() {
        let dir = std::env::temp_dir().join(format!("mg-deadline-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("sample.py");
        std::fs::write(&file, "raise ValueError\n").unwrap();
        let store = Arc::new(FileListStore::new());
        let cancelled = AtomicBool::new(false);
        let mut req = request(
            &[
                "--no-heading",
                "--line-number",
                "-e",
                "raise",
                "--",
                &file.to_string_lossy(),
            ],
            50,
        );
        req.cwd = dir.to_string_lossy().into_owned();
        // scan_standard swallows a mid-scan TimedOut read error into `None`
        // ("no matches in this file"); the response-level deadline re-check
        // must still surface partial/timeout instead of complete-empty.
        let expired = Some(Instant::now() - Duration::from_millis(1));
        let response = handle(&req, &cancelled, &store, expired).unwrap();
        assert_eq!(response["timeout"], true);
        assert_eq!(response["partial"], true);
        assert_eq!(response["complete"], false);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn last_waiter_cancels_normal_inventory_but_explicit_prewarm_survives() {
        let store = FileListStore::new();
        let parsed = parse_args(&request(&["--files", "."], 20).args).unwrap();
        let key = walk_key(Path::new("."), &parsed);
        let (live, owner) = store.begin_live(key.clone(), false);
        assert!(owner);
        let (joined, owner) = store.begin_live(key.clone(), false);
        assert!(!owner);
        assert!(Arc::ptr_eq(&live, &joined));
        store.release_live(&key, &live);
        assert!(!live.cancelled.load(Ordering::Acquire));
        store.release_live(&key, &joined);
        assert!(live.cancelled.load(Ordering::Acquire));
        assert!(matches!(
            &*live.state.lock().unwrap_or_else(|e| e.into_inner()),
            LiveState::Abandoned
        ));
        assert!(store
            .live
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&key)
            .is_none());

        let warm_key = walk_key(Path::new("warm"), &parsed);
        let (warm, owner) = store.begin_live(warm_key.clone(), true);
        assert!(owner);
        store.release_live(&warm_key, &warm);
        assert!(!warm.cancelled.load(Ordering::Acquire));
        assert!(store
            .live
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&warm_key)
            .is_some());
    }

    #[test]
    fn invalidation_detaches_active_snapshot_without_dropping_its_waiter() {
        let store = FileListStore::new();
        let root = PathBuf::from("mutable-root");
        store
            .watched_roots
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(root.clone(), Instant::now());
        let parsed = parse_args(&request(&["--files", "."], 20).args).unwrap();
        let key = walk_key(&root, &parsed);
        let (live, owner) = store.begin_live(key.clone(), false);
        assert!(owner);

        assert_eq!(
            store.invalidate_paths(&[root.join("changed.log")]),
            vec![root.clone()]
        );
        assert!(!live.cancelled.load(Ordering::Acquire));
        assert!(matches!(
            &*live.state.lock().unwrap_or_else(|e| e.into_inner()),
            LiveState::Running
        ));
        assert!(store
            .live
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&key)
            .is_none());

        let snapshot = Arc::new(vec![root.join("snapshot.log")]);
        assert!(!store.finish_live(key.clone(), &live, Ok(snapshot)));
        assert!(matches!(
            &*live.state.lock().unwrap_or_else(|e| e.into_inner()),
            LiveState::Done(files) if files.len() == 1
        ));
        assert!(store.take_ready(&key).is_none());
        store.release_live(&key, &live);
    }

    #[test]
    fn inventory_with_walk_errors_is_never_cached_as_complete() {
        let store = FileListStore::new();
        let parsed = parse_args(&request(&["--files", "."], 20).args).unwrap();
        let key = walk_key(Path::new("partial"), &parsed);
        let (live, owner) = store.begin_live(key.clone(), false);
        assert!(owner);
        live.walk_errors.store(1, Ordering::Release);
        assert!(!store.finish_live(
            key.clone(),
            &live,
            Ok(Arc::new(vec![PathBuf::from("partial/visible.rs")])),
        ));
        assert!(store.take_ready(&key).is_none());
        assert_eq!(live.walk_errors.load(Ordering::Acquire), 1);
    }

    #[test]
    fn streaming_and_complete_waiters_share_one_walk_without_panicking() {
        let store = FileListStore::new();
        let parsed = parse_args(&request(&["--files", "."], 20).args).unwrap();
        let key = walk_key(Path::new("shared"), &parsed);
        let (live, owner) = store.begin_live(key.clone(), false);
        assert!(owner);

        // Complete-inventory waiter binds `cond` to the state mutex on its own
        // thread while this thread streams via `files_cond`/`files`. Before the
        // condvars were split this combination panicked and the search died.
        let complete = std::thread::spawn({
            let live = Arc::clone(&live);
            move || {
                let cancelled = AtomicBool::new(false);
                wait_live_complete(&live, &cancelled, None)
            }
        });
        std::thread::sleep(Duration::from_millis(30));

        publish_live_files(&live, &[PathBuf::from("streamed.rs")]);
        {
            let files = live.files.lock().unwrap_or_else(|e| e.into_inner());
            assert_eq!(files.len(), 1);
            let (files, _) = live
                .files_cond
                .wait_timeout(files, Duration::from_millis(10))
                .unwrap_or_else(|e| e.into_inner());
            assert_eq!(files.len(), 1);
        }

        assert!(store.finish_live(key, &live, Ok(Arc::new(vec![PathBuf::from("streamed.rs")])),));
        let completed = complete
            .join()
            .expect("complete waiter must not panic")
            .expect("walk must finish")
            .expect("walk must produce files");
        assert_eq!(completed.len(), 1);
    }

    #[test]
    fn internal_abandonment_returns_an_error_instead_of_silence() {
        let response = response_for_handler_result(7, Err(CANCELLED.to_string()), false).unwrap();
        assert_eq!(response["id"], 7);
        assert!(response["error"]
            .as_str()
            .is_some_and(|error| error.contains("without request cancellation")));
        assert!(response_for_handler_result(7, Err(CANCELLED.to_string()), true).is_none());
    }

    #[test]
    fn adaptive_scheduler_reserves_interactive_capacity_and_throttles_bulk() {
        assert_eq!(interactive_dispatch_ceiling(4, 1, true), 5);
        assert_eq!(interactive_dispatch_ceiling(4, 1, false), 4);
        assert_eq!(queue_admission_capacity(SearchClass::Bulk, 16, 2), 14);
        assert_eq!(
            queue_admission_capacity(SearchClass::Interactive, 16, 2),
            16
        );
        let mut state = SchedulerState::new(2);
        assert_eq!(adaptive_bulk_limit(2, &state), 2);
        state.interactive_inflight = 1;
        assert_eq!(adaptive_bulk_limit(2, &state), 1);
    }

    #[test]
    fn handler_panics_are_isolated_as_request_errors() {
        let result: Result<(), String> =
            contain_search_panic("probe handler", || panic!("isolated panic"));
        assert!(result
            .unwrap_err()
            .contains("probe handler panicked; request isolated"));
    }

    #[test]
    fn single_file_reader_checks_cancellation_between_bounded_chunks() {
        let cancelled = AtomicBool::new(false);
        let source = std::io::Cursor::new(vec![b'x'; search_reader_chunk_bytes() * 2]);
        let mut reader = CancellableReader::new(source, &cancelled, None);
        let mut buffer = vec![0u8; search_reader_chunk_bytes() * 2];
        assert_eq!(
            reader.read(&mut buffer).unwrap(),
            search_reader_chunk_bytes()
        );
        cancelled.store(true, Ordering::Relaxed);
        assert_eq!(
            reader.read(&mut buffer).unwrap_err().kind(),
            io::ErrorKind::Interrupted
        );
    }

    #[test]
    fn scheduler_aimd_uses_observed_queue_and_handler_latency() {
        let mut state = SchedulerState::new(4);
        let target = aimd_target();
        observe_scheduler_latency(&mut state, target * 2, Duration::from_millis(1), 4);
        assert_eq!(state.bulk_window, 2);
        for _ in 0..aimd_increase_every() {
            observe_scheduler_latency(&mut state, Duration::ZERO, Duration::from_millis(1), 4);
        }
        assert_eq!(state.bulk_window, 3);
    }
}
