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
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{self, File};
use std::hash::{Hash, Hasher};
use std::io::{self, BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex, OnceLock, RwLock, Weak};
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
const CONTENT_SIGNATURE_BITS: usize = 16_384;
const CONTENT_SIGNATURE_WORDS: usize = CONTENT_SIGNATURE_BITS / 64;
const CONTENT_SIGNATURE_CACHE_MAX: usize = 16_384;
const CONTENT_SIGNATURE_CACHE_SHARDS: usize = 64;
const CONTENT_SIGNATURE_SNAPSHOT_MAGIC: &[u8; 8] = b"MDCSIG02";
const CONTENT_SIGNATURE_SNAPSHOT_VERSION: u32 = 2;
const CONTENT_SIGNATURE_SNAPSHOT_MAX_BYTES: u64 = 256 * 1024 * 1024;
const CONTENT_SIGNATURE_SNAPSHOT_MAX_PATH_BYTES: usize = 1024 * 1024;

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

fn path_starts_with(rooted: &Path, root: &Path) -> bool {
    #[cfg(target_os = "windows")]
    {
        let rooted = rooted.to_string_lossy();
        let root = root.to_string_lossy();
        let rooted = rooted.strip_prefix(r"\\?\").unwrap_or(&rooted);
        let root = root.strip_prefix(r"\\?\").unwrap_or(&root);
        let rooted = rooted.as_bytes();
        let root = root.as_bytes();
        if rooted.eq_ignore_ascii_case(root) {
            return true;
        }
        if rooted.len() <= root.len() || !rooted[..root.len()].eq_ignore_ascii_case(root) {
            return false;
        }
        matches!(rooted[root.len()], b'\\' | b'/')
    }
    #[cfg(not(target_os = "windows"))]
    {
        rooted.starts_with(root)
    }
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
    root_identity: Option<crate::serve_search_usn::FileIdentity>,
}

struct FuzzyIndexedPath {
    path: String,
    ascii_mask: Option<(u64, u64)>,
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

const INVENTORY_SNAPSHOT_MAGIC: &[u8; 8] = b"MDINV001";
const INVENTORY_SNAPSHOT_VERSION: u32 = 2;
const INVENTORY_SNAPSHOT_MAX_BYTES: u64 = 256 * 1024 * 1024;
const INVENTORY_SNAPSHOT_MAX_STRING_BYTES: usize = 1024 * 1024;

fn inventory_snapshot_path() -> Option<PathBuf> {
    content_signature_snapshot_path().map(|path| path.with_file_name("file-inventories-v1.bin"))
}

fn read_snapshot_string<R: Read>(reader: &mut R) -> io::Result<String> {
    let len = read_snapshot_u32(reader)? as usize;
    if len == 0 || len > INVENTORY_SNAPSHOT_MAX_STRING_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "inventory string length",
        ));
    }
    let mut bytes = vec![0u8; len];
    reader.read_exact(&mut bytes)?;
    String::from_utf8(bytes)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "inventory utf8"))
}

fn write_snapshot_string<W: Write>(writer: &mut W, value: &Path) -> io::Result<()> {
    let value = value.to_string_lossy();
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.len() > INVENTORY_SNAPSHOT_MAX_STRING_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "inventory path length",
        ));
    }
    writer.write_all(&(bytes.len() as u32).to_le_bytes())?;
    writer.write_all(bytes)
}

fn load_file_list_snapshot() -> (
    HashMap<WalkKey, ReadyEntry>,
    Option<Vec<crate::serve_search_usn::JournalCheckpoint>>,
) {
    ensure_content_signature_cache_loaded();
    let Some(ttl) = file_list_ttl() else {
        return (HashMap::new(), None);
    };
    let Some(path) = inventory_snapshot_path() else {
        return (HashMap::new(), None);
    };
    if fs::metadata(&path)
        .ok()
        .is_none_or(|metadata| metadata.len() > INVENTORY_SNAPSHOT_MAX_BYTES)
    {
        return (HashMap::new(), None);
    }
    let Ok(file) = File::open(path) else {
        return (HashMap::new(), None);
    };
    let loaded = (|| -> io::Result<_> {
        let mut reader = BufReader::new(file);
        let mut magic = [0u8; 8];
        reader.read_exact(&mut magic)?;
        if &magic != INVENTORY_SNAPSHOT_MAGIC
            || read_snapshot_u32(&mut reader)? != INVENTORY_SNAPSHOT_VERSION
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "inventory header",
            ));
        }
        let checkpoint_count = read_snapshot_u32(&mut reader)? as usize;
        let entry_count = read_snapshot_u32(&mut reader)? as usize;
        if checkpoint_count > 256 || entry_count > FILE_LIST_CACHE_MAX {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "inventory counts",
            ));
        }
        let mut checkpoints = Vec::with_capacity(checkpoint_count);
        for _ in 0..checkpoint_count {
            checkpoints.push(crate::serve_search_usn::JournalCheckpoint {
                volume: read_snapshot_u16(&mut reader)?,
                volume_serial: read_snapshot_u32(&mut reader)?,
                journal_id: read_snapshot_u64(&mut reader)?,
                next_usn: read_snapshot_i64(&mut reader)?,
            });
        }
        let mut ready = HashMap::new();
        let now = Instant::now();
        let mut total_bytes = 0usize;
        for _ in 0..entry_count {
            let operand = PathBuf::from(read_snapshot_string(&mut reader)?);
            let root_identity = Some(crate::serve_search_usn::FileIdentity {
                volume: read_snapshot_u32(&mut reader)?,
                file_id: read_snapshot_u64(&mut reader)?,
            });
            let mut flags = [0u8; 1];
            reader.read_exact(&mut flags)?;
            let max_depth = read_snapshot_u32(&mut reader)?;
            let prune_count = read_snapshot_u32(&mut reader)? as usize;
            let file_count = read_snapshot_u32(&mut reader)? as usize;
            if prune_count > 4096 || file_count > 2_000_000 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "inventory entry counts",
                ));
            }
            let mut prune = Vec::with_capacity(prune_count);
            for _ in 0..prune_count {
                prune.push(read_snapshot_string(&mut reader)?);
            }
            let mut files = Vec::with_capacity(file_count);
            for _ in 0..file_count {
                files.push(PathBuf::from(read_snapshot_string(&mut reader)?));
            }
            let estimated_bytes = paths_storage_bytes(&files);
            total_bytes = total_bytes.saturating_add(estimated_bytes);
            if total_bytes > file_list_cache_bytes() {
                continue;
            }
            ready.insert(
                WalkKey {
                    operand,
                    hidden: flags[0] & 1 != 0,
                    no_ignore: flags[0] & 2 != 0,
                    no_require_git: flags[0] & 4 != 0,
                    directories: flags[0] & 8 != 0,
                    max_depth: (max_depth != u32::MAX).then_some(max_depth as usize),
                    prune,
                },
                ReadyEntry {
                    files: Arc::new(files),
                    expires_at: now + ttl,
                    generation: 0,
                    touched_at: now,
                    estimated_bytes,
                    root_identity,
                },
            );
        }
        Ok((ready, checkpoints))
    })();
    match loaded {
        Ok((ready, checkpoints)) if !checkpoints.is_empty() => {
            crate::serve_search_usn::restore_journal_checkpoints(&checkpoints);
            (ready, Some(checkpoints))
        }
        _ => (HashMap::new(), None),
    }
}

fn persist_file_list_snapshot(ready_cache: &Mutex<HashMap<WalkKey, ReadyEntry>>) {
    let Some(path) = inventory_snapshot_path() else {
        return;
    };
    let checkpoints = crate::serve_search_usn::journal_checkpoints();
    if checkpoints.is_empty() {
        return;
    }
    let entries = ready_cache
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .iter()
        .filter_map(|(key, entry)| {
            entry
                .root_identity
                .map(|identity| (key.clone(), Arc::clone(&entry.files), identity))
        })
        .collect::<Vec<_>>();
    let Some(parent) = path.parent() else {
        return;
    };
    if fs::create_dir_all(parent).is_err() {
        return;
    }
    let temp = path.with_extension(format!("tmp-{}", std::process::id()));
    let written = (|| -> io::Result<()> {
        let file = File::create(&temp)?;
        let mut writer = BufWriter::new(file);
        writer.write_all(INVENTORY_SNAPSHOT_MAGIC)?;
        writer.write_all(&INVENTORY_SNAPSHOT_VERSION.to_le_bytes())?;
        writer.write_all(&(checkpoints.len() as u32).to_le_bytes())?;
        writer.write_all(&0u32.to_le_bytes())?;
        for checkpoint in &checkpoints {
            writer.write_all(&checkpoint.volume.to_le_bytes())?;
            writer.write_all(&checkpoint.volume_serial.to_le_bytes())?;
            writer.write_all(&checkpoint.journal_id.to_le_bytes())?;
            writer.write_all(&checkpoint.next_usn.to_le_bytes())?;
        }
        let mut count = 0u32;
        for (key, files, root_identity) in &entries {
            write_snapshot_string(&mut writer, &key.operand)?;
            writer.write_all(&root_identity.volume.to_le_bytes())?;
            writer.write_all(&root_identity.file_id.to_le_bytes())?;
            let flags = u8::from(key.hidden)
                | (u8::from(key.no_ignore) << 1)
                | (u8::from(key.no_require_git) << 2)
                | (u8::from(key.directories) << 3);
            writer.write_all(&[flags])?;
            writer.write_all(
                &key.max_depth
                    .map(|depth| depth as u32)
                    .unwrap_or(u32::MAX)
                    .to_le_bytes(),
            )?;
            writer.write_all(&(key.prune.len() as u32).to_le_bytes())?;
            writer.write_all(&(files.len() as u32).to_le_bytes())?;
            for prune in &key.prune {
                write_snapshot_string(&mut writer, Path::new(prune))?;
            }
            for file in files.iter() {
                write_snapshot_string(&mut writer, file)?;
            }
            count = count.saturating_add(1);
        }
        writer.flush()?;
        writer.seek(SeekFrom::Start(16))?;
        writer.write_all(&count.to_le_bytes())?;
        writer.flush()
    })()
    .is_ok();
    if !written
        || (path.exists() && fs::remove_file(&path).is_err())
        || fs::rename(&temp, &path).is_err()
    {
        let _ = fs::remove_file(temp);
    }
}

static INVENTORY_SNAPSHOT_DIRTY: AtomicBool = AtomicBool::new(false);
static INVENTORY_SNAPSHOT_WRITING: AtomicBool = AtomicBool::new(false);

fn schedule_file_list_snapshot(ready: Arc<Mutex<HashMap<WalkKey, ReadyEntry>>>) {
    INVENTORY_SNAPSHOT_DIRTY.store(true, Ordering::Release);
    if INVENTORY_SNAPSHOT_WRITING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    std::thread::spawn(move || {
        loop {
            INVENTORY_SNAPSHOT_DIRTY.store(false, Ordering::Release);
            persist_file_list_snapshot(&ready);
            if !INVENTORY_SNAPSHOT_DIRTY.swap(false, Ordering::AcqRel) {
                break;
            }
        }
        INVENTORY_SNAPSHOT_WRITING.store(false, Ordering::Release);
        if INVENTORY_SNAPSHOT_DIRTY.load(Ordering::Acquire) {
            schedule_file_list_snapshot(ready);
        }
    });
}

fn fuzzy_storage_bytes(corpus: &FuzzyCorpus) -> usize {
    corpus
        .paths
        .iter()
        .fold(std::mem::size_of::<FuzzyCorpus>(), |total, indexed| {
            total
                .saturating_add(std::mem::size_of::<FuzzyIndexedPath>())
                .saturating_add(indexed.path.len())
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
    enumeration_done: AtomicBool,
    keep_warm: AtomicBool,
    keep_inventory: AtomicBool,
    cacheable: AtomicBool,
    walk_errors: AtomicUsize,
    walk_error_details: Mutex<Vec<String>>,
    generation: u64,
}

struct FileListStore {
    ready: Arc<Mutex<HashMap<WalkKey, ReadyEntry>>>,
    persisted_checkpoints: Mutex<Option<Vec<crate::serve_search_usn::JournalCheckpoint>>>,
    live: Mutex<HashMap<WalkKey, Arc<LiveWalk>>>,
    fuzzy: Mutex<HashMap<FuzzyKey, FuzzyEntry>>,
    generations: Mutex<HashMap<PathBuf, u64>>,
    pending_repairs: Mutex<HashMap<WalkKey, PendingInventoryRepair>>,
    repair_worker_running: AtomicBool,
    repair_changed: Condvar,
    watcher: Mutex<Option<RecommendedWatcher>>,
    watcher_healthy: AtomicBool,
    watched_roots: Mutex<HashMap<PathBuf, Instant>>,
    noise_sensitive_roots: Mutex<HashSet<PathBuf>>,
}

struct PendingInventoryRepair {
    base: Arc<Vec<PathBuf>>,
    paths: HashSet<PathBuf>,
    processing: bool,
}

#[derive(Clone)]
struct TrigramSignature {
    bits: [u64; CONTENT_SIGNATURE_WORDS],
    folded_bits: [u64; CONTENT_SIGNATURE_WORDS],
    previous: [u8; 2],
    folded_previous: [u8; 2],
    seen: usize,
    complete: bool,
}

impl TrigramSignature {
    fn new() -> Self {
        Self {
            bits: [0; CONTENT_SIGNATURE_WORDS],
            folded_bits: [0; CONTENT_SIGNATURE_WORDS],
            previous: [0; 2],
            folded_previous: [0; 2],
            seen: 0,
            complete: false,
        }
    }

    fn push(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            if self.seen >= 2 {
                let (first, second) = trigram_bits(self.previous[0], self.previous[1], byte);
                self.bits[first / 64] |= 1u64 << (first % 64);
                self.bits[second / 64] |= 1u64 << (second % 64);
                let folded = byte.to_ascii_lowercase();
                let (folded_first, folded_second) =
                    trigram_bits(self.folded_previous[0], self.folded_previous[1], folded);
                self.folded_bits[folded_first / 64] |= 1u64 << (folded_first % 64);
                self.folded_bits[folded_second / 64] |= 1u64 << (folded_second % 64);
            }
            self.previous[0] = self.previous[1];
            self.previous[1] = byte;
            self.folded_previous[0] = self.folded_previous[1];
            self.folded_previous[1] = byte.to_ascii_lowercase();
            self.seen = self.seen.saturating_add(1);
        }
    }

    fn contains(&self, first: usize, second: usize, folded: bool) -> bool {
        let bits = if folded {
            &self.folded_bits
        } else {
            &self.bits
        };
        (bits[first / 64] & (1u64 << (first % 64))) != 0
            && (bits[second / 64] & (1u64 << (second % 64))) != 0
    }
}

#[derive(Clone)]
struct ContentSignatureEntry {
    size: u64,
    modified_ns: u128,
    identity: Option<crate::serve_search_usn::FileIdentity>,
    persisted: bool,
    signature: TrigramSignature,
}

#[derive(Clone)]
struct FileMetadataEntry {
    size: u64,
    modified_ns: u128,
    mtime_ms: u128,
    identity: Option<crate::serve_search_usn::FileIdentity>,
}

static CONTENT_SIGNATURE_CACHE: OnceLock<
    [Mutex<HashMap<PathBuf, ContentSignatureEntry>>; CONTENT_SIGNATURE_CACHE_SHARDS],
> = OnceLock::new();
// Not a OnceLock: an in-process server releases this cache on idle and must be
// able to reload it from the snapshot on the next search, exactly as a fresh
// standalone process would. A OnceLock can never be re-armed.
static CONTENT_SIGNATURE_CACHE_LOADED: AtomicBool = AtomicBool::new(false);
static CONTENT_SIGNATURE_CACHE_LOAD: Mutex<()> = Mutex::new(());
static CONTENT_SIGNATURE_CACHE_DIRTY: AtomicUsize = AtomicUsize::new(0);
static CONTENT_SIGNATURE_CACHE_PERSISTING: AtomicBool = AtomicBool::new(false);
static FILE_METADATA_CACHE: OnceLock<
    [Mutex<HashMap<PathBuf, FileMetadataEntry>>; CONTENT_SIGNATURE_CACHE_SHARDS],
> = OnceLock::new();
static TRUSTED_USN_VOLUMES: OnceLock<Mutex<HashSet<u32>>> = OnceLock::new();
static TRUSTED_WATCH_ROOTS: OnceLock<RwLock<HashSet<PathBuf>>> = OnceLock::new();

fn content_signature_cache(
) -> &'static [Mutex<HashMap<PathBuf, ContentSignatureEntry>>; CONTENT_SIGNATURE_CACHE_SHARDS] {
    ensure_content_signature_cache_loaded();
    raw_content_signature_cache()
}

fn raw_content_signature_cache(
) -> &'static [Mutex<HashMap<PathBuf, ContentSignatureEntry>>; CONTENT_SIGNATURE_CACHE_SHARDS] {
    CONTENT_SIGNATURE_CACHE.get_or_init(|| std::array::from_fn(|_| Mutex::new(HashMap::new())))
}

fn content_signature_snapshot_path() -> Option<PathBuf> {
    let data_dir = std::env::var_os("MIXDOG_DATA_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            let home = std::env::var_os("MIXDOG_HOME")
                .map(PathBuf::from)
                .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))?;
            Some(home.join(if std::env::var_os("MIXDOG_HOME").is_some() {
                "data"
            } else {
                ".mixdog/data"
            }))
        })?;
    Some(data_dir.join("search-index/content-signatures-v2.bin"))
}

fn read_snapshot_u16<R: Read>(reader: &mut R) -> io::Result<u16> {
    let mut bytes = [0u8; 2];
    reader.read_exact(&mut bytes)?;
    Ok(u16::from_le_bytes(bytes))
}

fn read_snapshot_u32<R: Read>(reader: &mut R) -> io::Result<u32> {
    let mut bytes = [0u8; 4];
    reader.read_exact(&mut bytes)?;
    Ok(u32::from_le_bytes(bytes))
}

fn read_snapshot_u64<R: Read>(reader: &mut R) -> io::Result<u64> {
    let mut bytes = [0u8; 8];
    reader.read_exact(&mut bytes)?;
    Ok(u64::from_le_bytes(bytes))
}

fn read_snapshot_u128<R: Read>(reader: &mut R) -> io::Result<u128> {
    let mut bytes = [0u8; 16];
    reader.read_exact(&mut bytes)?;
    Ok(u128::from_le_bytes(bytes))
}

fn read_snapshot_i64<R: Read>(reader: &mut R) -> io::Result<i64> {
    let mut bytes = [0u8; 8];
    reader.read_exact(&mut bytes)?;
    Ok(i64::from_le_bytes(bytes))
}

fn load_content_signature_cache_binary(path: &Path) -> bool {
    if fs::metadata(path)
        .ok()
        .is_none_or(|metadata| metadata.len() > CONTENT_SIGNATURE_SNAPSHOT_MAX_BYTES)
    {
        return false;
    }
    let Ok(file) = File::open(path) else {
        return false;
    };
    let mut reader = BufReader::new(file);
    let mut inserted = Vec::new();
    let loaded = (|| -> io::Result<Vec<crate::serve_search_usn::JournalCheckpoint>> {
        let mut magic = [0u8; 8];
        reader.read_exact(&mut magic)?;
        if &magic != CONTENT_SIGNATURE_SNAPSHOT_MAGIC
            || read_snapshot_u32(&mut reader)? != CONTENT_SIGNATURE_SNAPSHOT_VERSION
            || read_snapshot_u32(&mut reader)? as usize != CONTENT_SIGNATURE_WORDS
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "signature snapshot header",
            ));
        }
        let checkpoint_count = read_snapshot_u32(&mut reader)? as usize;
        let entry_count = read_snapshot_u32(&mut reader)? as usize;
        if checkpoint_count > 256 || entry_count > CONTENT_SIGNATURE_CACHE_MAX {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "signature snapshot count",
            ));
        }
        let mut checkpoints = Vec::with_capacity(checkpoint_count);
        for _ in 0..checkpoint_count {
            checkpoints.push(crate::serve_search_usn::JournalCheckpoint {
                volume: read_snapshot_u16(&mut reader)?,
                volume_serial: read_snapshot_u32(&mut reader)?,
                journal_id: read_snapshot_u64(&mut reader)?,
                next_usn: read_snapshot_i64(&mut reader)?,
            });
        }
        inserted.reserve(entry_count);
        for _ in 0..entry_count {
            let path_len = read_snapshot_u32(&mut reader)? as usize;
            if path_len == 0 || path_len > CONTENT_SIGNATURE_SNAPSHOT_MAX_PATH_BYTES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "signature snapshot path",
                ));
            }
            let mut path_bytes = vec![0u8; path_len];
            reader.read_exact(&mut path_bytes)?;
            let path = PathBuf::from(String::from_utf8(path_bytes).map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidData, "signature snapshot utf8")
            })?);
            let size = read_snapshot_u64(&mut reader)?;
            let modified_ns = read_snapshot_u128(&mut reader)?;
            let identity = crate::serve_search_usn::FileIdentity {
                volume: read_snapshot_u32(&mut reader)?,
                file_id: read_snapshot_u64(&mut reader)?,
            };
            let mut bits = [0u64; CONTENT_SIGNATURE_WORDS];
            let mut folded_bits = [0u64; CONTENT_SIGNATURE_WORDS];
            for word in &mut bits {
                *word = read_snapshot_u64(&mut reader)?;
            }
            for word in &mut folded_bits {
                *word = read_snapshot_u64(&mut reader)?;
            }
            raw_content_signature_cache()[content_signature_shard(&path)]
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .insert(
                    path.clone(),
                    ContentSignatureEntry {
                        size,
                        modified_ns,
                        identity: Some(identity),
                        persisted: true,
                        signature: TrigramSignature {
                            bits,
                            folded_bits,
                            previous: [0; 2],
                            folded_previous: [0; 2],
                            seen: 0,
                            complete: true,
                        },
                    },
                );
            inserted.push(path);
        }
        Ok(checkpoints)
    })();
    match loaded {
        Ok(checkpoints) if !checkpoints.is_empty() => {
            crate::serve_search_usn::restore_journal_checkpoints(&checkpoints);
            true
        }
        _ => {
            for path in inserted {
                raw_content_signature_cache()[content_signature_shard(&path)]
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .remove(&path);
            }
            false
        }
    }
}

fn ensure_content_signature_cache_loaded() {
    if CONTENT_SIGNATURE_CACHE_LOADED.load(Ordering::Acquire) {
        return;
    }
    let _guard = CONTENT_SIGNATURE_CACHE_LOAD
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    // Re-check under the lock: the snapshot read is expensive enough that two
    // threads racing here would both pay for it.
    if CONTENT_SIGNATURE_CACHE_LOADED.load(Ordering::Acquire) {
        return;
    }
    if let Some(path) = content_signature_snapshot_path() {
        let _ = load_content_signature_cache_binary(&path);
    }
    // A missing snapshot path still counts as loaded: there is nothing to read
    // and retrying per call would probe the environment on every search.
    CONTENT_SIGNATURE_CACHE_LOADED.store(true, Ordering::Release);
}

fn persist_content_signature_cache() {
    let dirty = CONTENT_SIGNATURE_CACHE_DIRTY.swap(0, Ordering::AcqRel);
    if dirty == 0 {
        return;
    }
    let mut volumes = HashSet::new();
    for shard in content_signature_cache() {
        let cache = shard.lock().unwrap_or_else(|error| error.into_inner());
        for path in cache.keys() {
            if let Some(volume) = crate::serve_search_usn::volume_for_path(path) {
                volumes.insert(volume);
            }
        }
    }
    for volume in volumes {
        apply_content_signature_journal_sync(crate::serve_search_usn::sync_volume(volume));
    }
    let checkpoints = crate::serve_search_usn::journal_checkpoints();
    if checkpoints.is_empty() {
        return;
    }
    let trusted_serials = checkpoints
        .iter()
        .map(|checkpoint| checkpoint.volume_serial)
        .collect::<HashSet<_>>();
    let Some(path) = content_signature_snapshot_path() else {
        return;
    };
    let Some(parent) = path.parent() else {
        return;
    };
    if fs::create_dir_all(parent).is_err() {
        CONTENT_SIGNATURE_CACHE_DIRTY.fetch_add(dirty, Ordering::Relaxed);
        return;
    }
    let temp = path.with_extension(format!("tmp-{}", std::process::id()));
    let written = (|| -> io::Result<()> {
        let file = File::create(&temp)?;
        let mut writer = BufWriter::new(file);
        writer.write_all(CONTENT_SIGNATURE_SNAPSHOT_MAGIC)?;
        writer.write_all(&CONTENT_SIGNATURE_SNAPSHOT_VERSION.to_le_bytes())?;
        writer.write_all(&(CONTENT_SIGNATURE_WORDS as u32).to_le_bytes())?;
        writer.write_all(&(checkpoints.len() as u32).to_le_bytes())?;
        writer.write_all(&0u32.to_le_bytes())?;
        for checkpoint in &checkpoints {
            writer.write_all(&checkpoint.volume.to_le_bytes())?;
            writer.write_all(&checkpoint.volume_serial.to_le_bytes())?;
            writer.write_all(&checkpoint.journal_id.to_le_bytes())?;
            writer.write_all(&checkpoint.next_usn.to_le_bytes())?;
        }
        let mut entry_count = 0u32;
        for shard in content_signature_cache() {
            let cache = shard.lock().unwrap_or_else(|error| error.into_inner());
            for (path, entry) in cache.iter() {
                let Some(identity) = entry
                    .identity
                    .filter(|identity| trusted_serials.contains(&identity.volume))
                else {
                    continue;
                };
                let path_bytes = path.to_string_lossy();
                let path_bytes = path_bytes.as_bytes();
                if path_bytes.is_empty()
                    || path_bytes.len() > CONTENT_SIGNATURE_SNAPSHOT_MAX_PATH_BYTES
                {
                    continue;
                }
                writer.write_all(&(path_bytes.len() as u32).to_le_bytes())?;
                writer.write_all(path_bytes)?;
                writer.write_all(&entry.size.to_le_bytes())?;
                writer.write_all(&entry.modified_ns.to_le_bytes())?;
                writer.write_all(&identity.volume.to_le_bytes())?;
                writer.write_all(&identity.file_id.to_le_bytes())?;
                for word in entry.signature.bits {
                    writer.write_all(&word.to_le_bytes())?;
                }
                for word in entry.signature.folded_bits {
                    writer.write_all(&word.to_le_bytes())?;
                }
                entry_count = entry_count.saturating_add(1);
            }
        }
        writer.flush()?;
        writer.seek(SeekFrom::Start(20))?;
        writer.write_all(&entry_count.to_le_bytes())?;
        writer.flush()
    })()
    .is_ok();
    if !written
        || (path.exists() && fs::remove_file(&path).is_err())
        || fs::rename(&temp, &path).is_err()
    {
        let _ = fs::remove_file(&temp);
        CONTENT_SIGNATURE_CACHE_DIRTY.fetch_add(dirty, Ordering::Relaxed);
    }
}

fn schedule_content_signature_cache_persist() {
    if CONTENT_SIGNATURE_CACHE_DIRTY.load(Ordering::Acquire) == 0
        || CONTENT_SIGNATURE_CACHE_PERSISTING
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
    {
        return;
    }
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_millis(50));
        persist_content_signature_cache();
        CONTENT_SIGNATURE_CACHE_PERSISTING.store(false, Ordering::Release);
        if CONTENT_SIGNATURE_CACHE_DIRTY.load(Ordering::Acquire) > 0 {
            schedule_content_signature_cache_persist();
        }
    });
}

fn file_metadata_cache(
) -> &'static [Mutex<HashMap<PathBuf, FileMetadataEntry>>; CONTENT_SIGNATURE_CACHE_SHARDS] {
    FILE_METADATA_CACHE.get_or_init(|| std::array::from_fn(|_| Mutex::new(HashMap::new())))
}

fn trusted_usn_volumes() -> &'static Mutex<HashSet<u32>> {
    TRUSTED_USN_VOLUMES.get_or_init(|| Mutex::new(HashSet::new()))
}

fn trusted_watch_roots() -> &'static RwLock<HashSet<PathBuf>> {
    TRUSTED_WATCH_ROOTS.get_or_init(|| RwLock::new(HashSet::new()))
}

#[derive(Clone)]
struct TrustSnapshot {
    usn_volumes: Arc<HashSet<u32>>,
    watch_roots: Arc<Vec<PathBuf>>,
}

impl TrustSnapshot {
    fn capture() -> Self {
        Self {
            usn_volumes: Arc::new(
                trusted_usn_volumes()
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .clone(),
            ),
            watch_roots: Arc::new(
                trusted_watch_roots()
                    .read()
                    .unwrap_or_else(|error| error.into_inner())
                    .iter()
                    .cloned()
                    .collect(),
            ),
        }
    }

    fn watcher_covers(&self, path: &Path) -> bool {
        self.watch_roots
            .iter()
            .any(|root| path.starts_with(root) || path_starts_with(path, root))
    }
}

fn apply_content_signature_journal_sync(result: crate::serve_search_usn::SyncResult) {
    let mut trusted = trusted_usn_volumes()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let Some(serial) = result.volume_serial.filter(|_| result.trusted) else {
        trusted.clear();
        drop(trusted);
        for shard in raw_content_signature_cache() {
            shard
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .retain(|_, entry| !entry.persisted);
        }
        CONTENT_SIGNATURE_CACHE_DIRTY.fetch_add(1, Ordering::Relaxed);
        return;
    };
    trusted.insert(serial);
    drop(trusted);
    if result.changed.is_empty() {
        return;
    }
    CONTENT_SIGNATURE_CACHE_DIRTY.fetch_add(1, Ordering::Relaxed);
    for shard in content_signature_cache() {
        let mut cache = shard.lock().unwrap_or_else(|error| error.into_inner());
        cache.retain(|_, entry| {
            !entry.identity.is_some_and(|identity| {
                identity.volume == serial && result.changed.contains(&identity.file_id)
            })
        });
    }
    for shard in file_metadata_cache() {
        let mut cache = shard.lock().unwrap_or_else(|error| error.into_inner());
        cache.retain(|_, entry| {
            !entry.identity.is_some_and(|identity| {
                identity.volume == serial && result.changed.contains(&identity.file_id)
            })
        });
    }
}

fn refresh_content_signature_journals(targets: &[String], cwd: &Path) {
    ensure_content_signature_cache_loaded();
    let absolute_targets = targets
        .iter()
        .map(|target| {
            let target_path = Path::new(target);
            if target_path.is_absolute() {
                target_path.to_path_buf()
            } else {
                cwd.join(target_path)
            }
        })
        .collect::<Vec<_>>();
    let mut volumes = HashSet::new();
    for absolute in absolute_targets {
        if let Some(volume) = crate::serve_search_usn::volume_for_path(&absolute) {
            volumes.insert(volume);
        }
    }
    for volume in volumes {
        apply_content_signature_journal_sync(crate::serve_search_usn::sync_volume(volume));
    }
}

fn content_signature_shard(path: &Path) -> usize {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hasher);
    hasher.finish() as usize & (CONTENT_SIGNATURE_CACHE_SHARDS - 1)
}

fn trigram_bits(first: u8, second: u8, third: u8) -> (usize, usize) {
    let packed = ((first as u32) << 16) | ((second as u32) << 8) | third as u32;
    let one = packed.wrapping_mul(0x9E37_79B1) as usize & (CONTENT_SIGNATURE_BITS - 1);
    let two =
        packed.rotate_left(13).wrapping_mul(0x85EB_CA6B) as usize & (CONTENT_SIGNATURE_BITS - 1);
    (one, two)
}

fn literal_trigram_requirements(parsed: &ParsedArgs) -> Option<Vec<Vec<(usize, usize)>>> {
    if parsed.patterns.is_empty() {
        return None;
    }
    let mut all = Vec::with_capacity(parsed.patterns.len());
    for pattern in &parsed.patterns {
        let literal = if parsed.fixed_strings {
            pattern.as_bytes().to_vec()
        } else {
            mandatory_regex_literal(pattern)?
        };
        if literal.len() < 3 || (parsed.case_insensitive && !literal.is_ascii()) {
            return None;
        }
        let folded;
        let bytes = if parsed.case_insensitive {
            folded = literal
                .iter()
                .map(|byte| byte.to_ascii_lowercase())
                .collect::<Vec<_>>();
            folded.as_slice()
        } else {
            literal.as_slice()
        };
        all.push(
            bytes
                .windows(3)
                .map(|window| trigram_bits(window[0], window[1], window[2]))
                .collect(),
        );
    }
    Some(all)
}

fn mandatory_regex_literal(pattern: &str) -> Option<Vec<u8>> {
    let bytes = pattern.as_bytes();
    let mut index = usize::from(bytes.first() == Some(&b'^'));
    let end = bytes
        .len()
        .saturating_sub(usize::from(bytes.last() == Some(&b'$')));
    let mut runs = Vec::<Vec<u8>>::new();
    let mut current = Vec::new();
    while index < end {
        if bytes[index] == b'\\' {
            index += 1;
            let escaped = *bytes.get(index)?;
            if !b".*+?()[]{}|^$\\".contains(&escaped) {
                return None;
            }
            current.push(escaped);
            index += 1;
            continue;
        }
        if bytes[index] == b'.' {
            if !current.is_empty() {
                runs.push(std::mem::take(&mut current));
            }
            index += 1;
            if index < end && matches!(bytes[index], b'*' | b'+') {
                index += 1;
            }
            continue;
        }
        if b"*+?()[]{}|^$".contains(&bytes[index]) {
            return None;
        }
        current.push(bytes[index]);
        index += 1;
    }
    if !current.is_empty() {
        runs.push(current);
    }
    runs.into_iter().max_by_key(Vec::len)
}

fn file_content_fingerprint(path: &Path) -> Option<(u64, u128)> {
    let metadata = std::fs::metadata(path).ok()?;
    let modified_ns = metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    Some((metadata.len(), modified_ns))
}

fn file_mtime_ms(path: &Path, trust: &TrustSnapshot) -> Option<u128> {
    let shard = content_signature_shard(path);
    let cached = {
        let cache = file_metadata_cache()[shard]
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        cache.get(path).cloned()
    };
    if let Some(entry) = cached.as_ref() {
        if entry
            .identity
            .is_some_and(|identity| trust.usn_volumes.contains(&identity.volume))
        {
            return Some(entry.mtime_ms);
        }
    }
    let (metadata, identity) = crate::serve_search_usn::metadata_and_identity(path)?;
    let modified_ns = metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    if cached
        .as_ref()
        .is_some_and(|entry| entry.size == metadata.len() && entry.modified_ns == modified_ns)
    {
        return cached.map(|entry| entry.mtime_ms);
    }
    let entry = FileMetadataEntry {
        size: metadata.len(),
        modified_ns,
        mtime_ms: modified_ns / 1_000_000,
        identity,
    };
    let mtime_ms = entry.mtime_ms;
    file_metadata_cache()[shard]
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(path.to_path_buf(), entry);
    Some(mtime_ms)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CachedSignatureState {
    Missing,
    Reusable,
    Excludes,
}

fn cached_signature_state(
    path: &Path,
    requirements: &[Vec<(usize, usize)>],
    folded: bool,
    trust: &TrustSnapshot,
) -> CachedSignatureState {
    let shard = content_signature_shard(path);
    let watcher_trusted = trust.watcher_covers(path);
    let entry = {
        let cache = content_signature_cache()[shard]
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let Some(entry) = cache.get(path) else {
            return CachedSignatureState::Missing;
        };
        let usn_trusted = entry
            .identity
            .is_some_and(|identity| trust.usn_volumes.contains(&identity.volume));
        if usn_trusted || (!entry.persisted && watcher_trusted) {
            return if !requirements.is_empty()
                && signature_excludes_requirements(&entry.signature, requirements, folded)
            {
                CachedSignatureState::Excludes
            } else {
                CachedSignatureState::Reusable
            };
        }
        entry.clone()
    };
    let Some((size, modified_ns)) = file_content_fingerprint(path) else {
        return CachedSignatureState::Missing;
    };
    if entry.size != size || entry.modified_ns != modified_ns {
        let mut cache = content_signature_cache()[shard]
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        cache.remove(path);
        return CachedSignatureState::Missing;
    }
    if !requirements.is_empty()
        && signature_excludes_requirements(&entry.signature, requirements, folded)
    {
        CachedSignatureState::Excludes
    } else {
        CachedSignatureState::Reusable
    }
}

fn signature_excludes_requirements(
    signature: &TrigramSignature,
    requirements: &[Vec<(usize, usize)>],
    folded: bool,
) -> bool {
    requirements.iter().all(|pattern| {
        pattern
            .iter()
            .any(|&(first, second)| !signature.contains(first, second, folded))
    })
}

fn remember_content_signature(
    path: &Path,
    signature: &TrigramSignature,
    identity: Option<crate::serve_search_usn::FileIdentity>,
) {
    if !signature.complete {
        return;
    }
    let Some((size, modified_ns)) = file_content_fingerprint(path) else {
        return;
    };
    let mut cache = content_signature_cache()[content_signature_shard(path)]
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if cache.len() >= CONTENT_SIGNATURE_CACHE_MAX / CONTENT_SIGNATURE_CACHE_SHARDS {
        if let Some(oldest) = cache.keys().next().cloned() {
            cache.remove(&oldest);
        }
    }
    cache.insert(
        path.to_path_buf(),
        ContentSignatureEntry {
            size,
            modified_ns,
            identity,
            persisted: false,
            signature: signature.clone(),
        },
    );
    CONTENT_SIGNATURE_CACHE_DIRTY.fetch_add(1, Ordering::Relaxed);
}

static SIGNATURE_PREWARM_RUNNING: AtomicBool = AtomicBool::new(false);

fn schedule_signature_prewarm(files: Arc<Vec<PathBuf>>) {
    if SIGNATURE_PREWARM_RUNNING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    std::thread::spawn(move || {
        let mut total_bytes = 0u64;
        let mut buffer = vec![0u8; 256 * 1024];
        for path in files.iter().take(8_192) {
            if raw_content_signature_cache()[content_signature_shard(path)]
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .contains_key(path)
            {
                continue;
            }
            let Ok(metadata) = fs::metadata(path) else {
                continue;
            };
            total_bytes = total_bytes.saturating_add(metadata.len());
            if total_bytes > 256 * 1024 * 1024 {
                break;
            }
            let Ok(mut file) = File::open(path) else {
                continue;
            };
            let identity = crate::serve_search_usn::file_identity(&file);
            let mut signature = TrigramSignature::new();
            loop {
                match file.read(&mut buffer) {
                    Ok(0) => {
                        signature.complete = true;
                        break;
                    }
                    Ok(read) => signature.push(&buffer[..read]),
                    Err(_) => break,
                }
            }
            remember_content_signature(path, &signature, identity);
        }
        SIGNATURE_PREWARM_RUNNING.store(false, Ordering::Release);
    });
}

fn invalidate_content_signatures(paths: &[PathBuf], recursive: bool) {
    if !recursive && !paths.is_empty() {
        for path in paths {
            raw_content_signature_cache()[content_signature_shard(path)]
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(path);
        }
        return;
    }
    for shard in content_signature_cache() {
        let mut cache = shard.lock().unwrap_or_else(|error| error.into_inner());
        if paths.is_empty() {
            cache.clear();
        } else {
            cache.retain(|cached, _| {
                !paths
                    .iter()
                    .any(|changed| FileListStore::paths_overlap(cached, changed))
            });
        }
    }
}

fn invalidate_file_metadata(paths: &[PathBuf], recursive: bool) {
    if !recursive && !paths.is_empty() {
        for path in paths {
            file_metadata_cache()[content_signature_shard(path)]
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(path);
        }
        return;
    }
    for shard in file_metadata_cache() {
        let mut cache = shard.lock().unwrap_or_else(|error| error.into_inner());
        if paths.is_empty() {
            cache.clear();
        } else {
            cache.retain(|cached, _| {
                !paths
                    .iter()
                    .any(|changed| FileListStore::paths_overlap(cached, changed))
            });
        }
    }
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
    #[cfg(test)]
    fn new() -> Self {
        Self {
            ready: Arc::new(Mutex::new(HashMap::new())),
            persisted_checkpoints: Mutex::new(None),
            live: Mutex::new(HashMap::new()),
            fuzzy: Mutex::new(HashMap::new()),
            generations: Mutex::new(HashMap::new()),
            pending_repairs: Mutex::new(HashMap::new()),
            repair_worker_running: AtomicBool::new(false),
            repair_changed: Condvar::new(),
            watcher: Mutex::new(None),
            watcher_healthy: AtomicBool::new(false),
            watched_roots: Mutex::new(HashMap::new()),
            noise_sensitive_roots: Mutex::new(HashSet::new()),
        }
    }

    /// Drop every warm cache without tearing the server down.
    ///
    /// A standalone server reclaims by exiting and letting the OS take the
    /// pages back. An in-process server has no exit to reclaim through — the
    /// host owns the process — so the same idle window frees the inventory,
    /// the fuzzy corpus, the trigram signatures and the OS watchers instead.
    /// Only cached RESULTS are dropped: walks in flight hold their own Arc and
    /// finish untouched, and everything persisted first is reloaded on demand,
    /// exactly as a freshly spawned process would.
    fn release_caches(&self) {
        persist_file_list_snapshot(&self.ready);
        persist_content_signature_cache();
        self.ready
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
        self.fuzzy
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
        self.generations
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
        self.pending_repairs
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
        self.noise_sensitive_roots
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
        // Dropping the watcher unwatches every root at once. An idle server
        // pinning one OS handle per watched root is exactly the cost this
        // release exists to remove; the next search re-arms it.
        *self
            .watcher
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = None;
        self.watcher_healthy.store(false, Ordering::Release);
        self.watched_roots
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
        trusted_watch_roots()
            .write()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
        for shard in raw_content_signature_cache() {
            shard
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .clear();
        }
        // Re-arm the loader so the next search reads the snapshot just
        // persisted rather than rebuilding every signature from scratch.
        CONTENT_SIGNATURE_CACHE_LOADED.store(false, Ordering::Release);
    }

    fn new_persistent() -> Self {
        let (ready, persisted_checkpoints) = load_file_list_snapshot();
        Self {
            ready: Arc::new(Mutex::new(ready)),
            persisted_checkpoints: Mutex::new(persisted_checkpoints),
            live: Mutex::new(HashMap::new()),
            fuzzy: Mutex::new(HashMap::new()),
            generations: Mutex::new(HashMap::new()),
            pending_repairs: Mutex::new(HashMap::new()),
            repair_worker_running: AtomicBool::new(false),
            repair_changed: Condvar::new(),
            watcher: Mutex::new(None),
            watcher_healthy: AtomicBool::new(false),
            watched_roots: Mutex::new(HashMap::new()),
            noise_sensitive_roots: Mutex::new(HashSet::new()),
        }
    }

    fn validate_persisted_ready(&self) {
        let checkpoints = self
            .persisted_checkpoints
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        let Some(checkpoints) = checkpoints else {
            return;
        };
        let mut changed_paths = HashMap::new();
        for checkpoint in &checkpoints {
            let result = crate::serve_search_usn::sync_volume(checkpoint.volume);
            let trusted = result.trusted && result.volume_serial == Some(checkpoint.volume_serial);
            let current = crate::serve_search_usn::journal_checkpoints()
                .into_iter()
                .find(|current| current.volume == checkpoint.volume);
            let continuous = trusted
                && current.is_some_and(|current| {
                    current.volume_serial == checkpoint.volume_serial
                        && current.journal_id == checkpoint.journal_id
                        && current.next_usn >= checkpoint.next_usn
                });
            let resolved = if continuous {
                let mut ids = result.changed.clone();
                ids.extend(result.parents.iter().copied());
                crate::serve_search_usn::resolve_file_ids(checkpoint.volume, &ids)
            } else {
                None
            };
            apply_content_signature_journal_sync(result);
            changed_paths.insert(checkpoint.volume, resolved);
        }
        self.ready
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .retain(|key, entry| {
                let Some(volume) = crate::serve_search_usn::volume_for_path(&key.operand) else {
                    return false;
                };
                let Some(Some(paths)) = changed_paths.get(&volume) else {
                    return false;
                };
                if entry.root_identity != crate::serve_search_usn::path_identity(&key.operand) {
                    return false;
                }
                !paths
                    .iter()
                    .any(|path| Self::paths_overlap(path, &key.operand))
            });
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
        path_starts_with(left, right) || path_starts_with(right, left)
    }

    fn has_noise_root(&self) -> bool {
        !self
            .noise_sensitive_roots
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty()
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

    fn schedule_inventory_repairs(self: &Arc<Self>, paths: &[PathBuf]) -> Vec<PathBuf> {
        let roots = self.affected_roots(paths);
        if roots.is_empty() {
            return roots;
        }
        let repair_paths = if paths.iter().any(|path| {
            matches!(
                path.file_name().and_then(|name| name.to_str()),
                Some(".gitignore" | ".ignore" | "exclude")
            )
        }) {
            roots.clone()
        } else {
            paths.to_vec()
        };
        let cached = self
            .ready
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .filter(|(key, _)| {
                roots
                    .iter()
                    .any(|root| Self::paths_overlap(&key.operand, root))
            })
            .map(|(key, entry)| (key.clone(), Arc::clone(&entry.files)))
            .collect::<Vec<_>>();
        {
            let mut pending = self
                .pending_repairs
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            for (key, entry) in pending.iter_mut() {
                if roots
                    .iter()
                    .any(|root| Self::paths_overlap(&key.operand, root))
                {
                    entry.paths.extend(repair_paths.iter().cloned());
                }
            }
            for (key, base) in cached {
                let entry = pending
                    .entry(key)
                    .or_insert_with(|| PendingInventoryRepair {
                        base,
                        paths: HashSet::new(),
                        processing: false,
                    });
                entry.paths.extend(repair_paths.iter().cloned());
            }
        }
        self.invalidate_roots(&roots);
        self.start_inventory_repair_worker();
        roots
    }

    fn start_inventory_repair_worker(self: &Arc<Self>) {
        if self
            .repair_worker_running
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let store = Arc::clone(self);
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(Duration::from_millis(50));
                let jobs = {
                    let mut pending = store
                        .pending_repairs
                        .lock()
                        .unwrap_or_else(|error| error.into_inner());
                    pending
                        .iter_mut()
                        .filter(|(_, entry)| !entry.processing && !entry.paths.is_empty())
                        .map(|(key, entry)| {
                            entry.processing = true;
                            (
                                key.clone(),
                                Arc::clone(&entry.base),
                                entry.paths.drain().collect::<Vec<_>>(),
                            )
                        })
                        .collect::<Vec<_>>()
                };
                if jobs.is_empty() {
                    break;
                }
                for (key, base, paths) in jobs {
                    let repaired = repair_inventory(&key, &base, &paths);
                    let mut pending = store
                        .pending_repairs
                        .lock()
                        .unwrap_or_else(|error| error.into_inner());
                    let Some(entry) = pending.get_mut(&key) else {
                        continue;
                    };
                    match repaired {
                        Ok(files) => {
                            entry.base = files;
                            entry.processing = false;
                            if entry.paths.is_empty() {
                                let files = Arc::clone(&entry.base);
                                let generation = store.generation(&key.operand);
                                store.remember(key.clone(), files, generation);
                                pending.remove(&key);
                                store.repair_changed.notify_all();
                            }
                        }
                        Err(_) => {
                            pending.remove(&key);
                            store.repair_changed.notify_all();
                        }
                    }
                }
            }
            store.repair_worker_running.store(false, Ordering::Release);
            let restart = store
                .pending_repairs
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .values()
                .any(|entry| !entry.processing && !entry.paths.is_empty());
            if restart {
                store.start_inventory_repair_worker();
            }
        });
    }

    fn schedule_noise_prewarm(self: &Arc<Self>) {
        let keys = self
            .ready
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .keys()
            .filter(|key| key.no_ignore)
            .cloned()
            .collect::<Vec<_>>();
        if keys.is_empty() {
            return;
        }
        let store = Arc::clone(self);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(250));
            let cancelled = AtomicBool::new(false);
            for key in keys {
                let parsed = ParsedArgs {
                    patterns: Vec::new(),
                    globs: Vec::new(),
                    iglobs: Vec::new(),
                    targets: vec![key.operand.to_string_lossy().into_owned()],
                    before: 0,
                    after: 0,
                    case_insensitive: false,
                    fixed_strings: false,
                    hidden: key.hidden,
                    no_ignore: key.no_ignore,
                    no_require_git: key.no_require_git,
                    max_depth: key.max_depth,
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
                    directories: key.directories,
                    max_columns: 0,
                    literal_trigrams: None,
                };
                let _ =
                    complete_operand_files(&store, &key.operand, &parsed, &cancelled, None, true);
            }
        });
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

    fn watch_root(self: &Arc<Self>, operand: &Path, include_noise: bool) -> bool {
        // Watching is an optional cache optimization, never a prerequisite for
        // searching. An exact-file operand is already cheap to scan; watching
        // its parent recursively can block indefinitely on virtual, network, or
        // otherwise non-watchable filesystems. Serve the search uncached instead.
        if operand.is_file() {
            return false;
        }
        let watch_operand = operand;
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
                    let stale = roots.drain().map(|(path, _)| path).collect::<Vec<_>>();
                    self.noise_sensitive_roots
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .clear();
                    trusted_watch_roots()
                        .write()
                        .unwrap_or_else(|e| e.into_inner())
                        .clear();
                    stale
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
                if include_noise {
                    self.noise_sensitive_roots
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .insert(covering.clone());
                }
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
                            trusted_watch_roots()
                                .write()
                                .unwrap_or_else(|e| e.into_inner())
                                .clear();
                            (Vec::new(), true)
                        }
                    };
                    invalidate_content_signatures(&paths, inventory_changed);
                    invalidate_file_metadata(&paths, inventory_changed);
                    let changed = if inventory_changed {
                        if paths.is_empty() {
                            // Watcher failure/overflow has no exact repair
                            // boundary; preserve correctness with full eviction.
                            store.invalidate_paths(&paths)
                        } else {
                            store.schedule_inventory_repairs(&paths)
                        }
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
                    self.noise_sensitive_roots
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .remove(oldest);
                    trusted_watch_roots()
                        .write()
                        .unwrap_or_else(|e| e.into_inner())
                        .remove(oldest);
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
            let mut trusted = trusted_watch_roots()
                .write()
                .unwrap_or_else(|e| e.into_inner());
            trusted.insert(root.clone());
            trusted.insert(watch_operand.to_path_buf());
            drop(trusted);
            self.watched_roots
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(root.clone(), Instant::now());
            if include_noise {
                self.noise_sensitive_roots
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(root);
            }
        }
        watched
    }

    fn take_ready(&self, key: &WalkKey) -> Option<Arc<Vec<PathBuf>>> {
        self.validate_persisted_ready();
        {
            let deadline = Instant::now() + Duration::from_millis(250);
            let mut pending = self
                .pending_repairs
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            while pending.contains_key(key) {
                let now = Instant::now();
                if now >= deadline {
                    break;
                }
                pending = self
                    .repair_changed
                    .wait_timeout(pending, deadline.saturating_duration_since(now))
                    .unwrap_or_else(|error| error.into_inner())
                    .0;
            }
        }
        let generation = self.generation(&key.operand);
        let watched_roots = self
            .watched_roots
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        let mut ready = self.ready.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        ready.retain(|ready_key, entry| {
            entry.expires_at > now
                || watched_roots
                    .iter()
                    .any(|root| Self::paths_overlap(&ready_key.operand, root))
        });
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
        let root_identity = crate::serve_search_usn::path_identity(&key.operand);
        let estimated_bytes = paths_storage_bytes(&files);
        let bytes_limit = file_list_cache_bytes();
        if estimated_bytes > bytes_limit {
            return;
        }
        let watched_roots = self
            .watched_roots
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        let mut ready = self.ready.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        ready.retain(|ready_key, entry| {
            entry.expires_at > now
                || watched_roots
                    .iter()
                    .any(|root| Self::paths_overlap(&ready_key.operand, root))
        });
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
                root_identity,
            },
        );
        drop(ready);
        schedule_file_list_snapshot(Arc::clone(&self.ready));
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
                    let ascii_mask = fuzzy_ascii_presence(&path);
                    FuzzyIndexedPath { path, ascii_mask }
                })
                .collect(),
        });
        self.remember_fuzzy_corpus(key, corpus)
    }

    fn take_fuzzy_corpus(&self, key: &FuzzyKey) -> Option<Arc<FuzzyCorpus>> {
        let mut fuzzy = self.fuzzy.lock().unwrap_or_else(|e| e.into_inner());
        let entry = fuzzy.get_mut(key)?;
        entry.touched_at = Instant::now();
        Some(Arc::clone(&entry.corpus))
    }

    fn remember_fuzzy_corpus(&self, key: &FuzzyKey, corpus: Arc<FuzzyCorpus>) -> Arc<FuzzyCorpus> {
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
        self.begin_live_with_inventory(key, keep_warm, false)
    }

    fn begin_live_with_inventory(
        &self,
        key: WalkKey,
        keep_warm: bool,
        keep_inventory: bool,
    ) -> (Arc<LiveWalk>, bool) {
        // Read the generation before taking the live-map lock; generation()
        // locks the generations mutex and nesting it under `live` invites
        // lock-order inversions with invalidation.
        let generation = self.generation(&key.operand);
        let mut live = self.live.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = live.get(&key) {
            if keep_warm {
                existing.keep_warm.store(true, Ordering::Release);
            }
            if keep_inventory {
                existing.keep_inventory.store(true, Ordering::Release);
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
            enumeration_done: AtomicBool::new(false),
            keep_warm: AtomicBool::new(keep_warm),
            keep_inventory: AtomicBool::new(keep_inventory),
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
        if previous != 1
            || live.keep_warm.load(Ordering::Acquire)
            || live.keep_inventory.load(Ordering::Acquire)
        {
            return;
        }
        let should_cancel = {
            let mut live_map = self.live.lock().unwrap_or_else(|e| e.into_inner());
            let same = live_map
                .get(key)
                .is_some_and(|current| Arc::ptr_eq(current, live));
            let idle = live.waiters.load(Ordering::Acquire) == 0
                && !live.keep_warm.load(Ordering::Acquire)
                && !live.keep_inventory.load(Ordering::Acquire);
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
                if live.keep_warm.load(Ordering::Acquire) {
                    schedule_signature_prewarm(Arc::clone(&files));
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
    // Keep only the query-independent path inventory alive after a fuzzy
    // deadline. Unlike keepWarm this never pre-reads file contents.
    #[serde(default, rename = "keepInventory")]
    keep_inventory: bool,
    // Client-supplied breadth hint: broad directory content scans (multi-
    // pattern fan-out combined pass and its speculative prefilter) opt into
    // the bulk lane so they cannot saturate the interactive worker pool.
    #[serde(default, rename = "bulkHint")]
    bulk_hint: bool,
    #[serde(default, rename = "mtimeTopK")]
    mtime_top_k: bool,
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

#[cfg(unix)]
fn list_metadata_mode(metadata: &std::fs::Metadata) -> u32 {
    use std::os::unix::fs::MetadataExt;
    metadata.mode()
}

#[cfg(not(unix))]
fn list_metadata_mode(metadata: &std::fs::Metadata) -> u32 {
    if metadata.is_dir() {
        0o777
    } else if metadata.permissions().readonly() {
        0o444
    } else {
        0o666
    }
}

fn list_metadata_response(id: u64, cwd: &str, paths: &[String]) -> serde_json::Value {
    if paths.len() > 50_000 {
        return serde_json::json!({
            "id": id,
            "error": "list metadata request exceeds 50000 paths",
        });
    }
    let cwd = Path::new(cwd);
    let entries = paths
        .iter()
        .map(|raw| {
            let input = Path::new(raw);
            let path = if input.is_absolute() {
                input.to_path_buf()
            } else {
                cwd.join(input)
            };
            match std::fs::symlink_metadata(&path) {
                Ok(metadata) => {
                    let file_type = metadata.file_type();
                    let kind = if file_type.is_dir() {
                        "dir"
                    } else if file_type.is_file() {
                        "file"
                    } else if file_type.is_symlink() {
                        "symlink"
                    } else {
                        "other"
                    };
                    let mtime_ms = metadata
                        .modified()
                        .ok()
                        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|value| value.as_millis().min(u64::MAX as u128) as u64)
                        .unwrap_or(0);
                    serde_json::json!({
                        "path": raw,
                        "type": kind,
                        "size": metadata.len(),
                        "mtimeMs": mtime_ms,
                        "mode": list_metadata_mode(&metadata),
                    })
                }
                Err(error) => serde_json::json!({
                    "path": raw,
                    "error": error.to_string(),
                }),
            }
        })
        .collect::<Vec<_>>();
    serde_json::json!({ "id": id, "entries": entries })
}

#[derive(Deserialize)]
#[serde(untagged)]
enum WireRequest {
    ListMetadata {
        id: u64,
        cwd: String,
        #[serde(rename = "listMetadata")]
        list_metadata: Vec<String>,
    },
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
    literal_trigrams: Option<Vec<Vec<(usize, usize)>>>,
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
        literal_trigrams: None,
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
    p.literal_trigrams = literal_trigram_requirements(&p);
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
    signature: Option<&'a mut TrigramSignature>,
}

impl<'a, R> CancellableReader<'a, R> {
    fn new(
        inner: R,
        cancelled: &'a AtomicBool,
        deadline_at: Option<Instant>,
        signature: Option<&'a mut TrigramSignature>,
    ) -> Self {
        Self {
            inner,
            cancelled,
            deadline_at,
            chunk_bytes: search_reader_chunk_bytes(),
            signature,
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
        let read = self.inner.read(&mut buffer[..bounded])?;
        if let Some(signature) = self.signature.as_deref_mut() {
            if read == 0 {
                signature.complete = true;
            } else {
                signature.push(&buffer[..read]);
            }
        }
        Ok(read)
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
    build_signature: bool,
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
    let mut signature = build_signature.then(TrigramSignature::new);
    let identity = signature
        .as_ref()
        .and_then(|_| crate::serve_search_usn::file_identity(&file));
    let mut reader = CancellableReader::new(file, cancelled, deadline_at, signature.as_mut());
    let result = if prefix.is_empty() {
        let inner = printer.sink(matcher);
        let mut sink = CancelSink {
            inner,
            cancelled,
            match_limit,
            matches: 0,
        };
        searcher.search_reader(matcher, &mut reader, &mut sink)
    } else {
        let printer_path = PathBuf::from(prefix);
        let inner = printer.sink_with_path(matcher, &printer_path);
        let mut sink = CancelSink {
            inner,
            cancelled,
            match_limit,
            matches: 0,
        };
        searcher.search_reader(matcher, &mut reader, &mut sink)
    };
    drop(reader);
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
    if let Some(signature) = signature.as_ref() {
        remember_content_signature(path, signature, identity);
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
    build_signature: bool,
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
    let mut signature = build_signature.then(TrigramSignature::new);
    let identity = signature
        .as_ref()
        .and_then(|_| crate::serve_search_usn::file_identity(&file));
    let mut reader = CancellableReader::new(file, cancelled, deadline_at, signature.as_mut());
    let result = if prefix.is_empty() {
        let inner = printer.sink(matcher);
        let mut sink = CancelSink {
            inner,
            cancelled,
            match_limit: None,
            matches: 0,
        };
        searcher.search_reader(matcher, &mut reader, &mut sink)
    } else {
        let printer_path = PathBuf::from(prefix);
        let inner = printer.sink_with_path(matcher, &printer_path);
        let mut sink = CancelSink {
            inner,
            cancelled,
            match_limit: None,
            matches: 0,
        };
        searcher.search_reader(matcher, &mut reader, &mut sink)
    };
    drop(reader);
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
    if let Some(signature) = signature.as_ref() {
        remember_content_signature(path, signature, identity);
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
    trust: &TrustSnapshot,
    scan_errors: &AtomicUsize,
) -> Option<Vec<String>> {
    let signature_state = cached_signature_state(
        path,
        parsed.literal_trigrams.as_deref().unwrap_or(&[]),
        parsed.case_insensitive,
        trust,
    );
    if signature_state == CachedSignatureState::Excludes {
        return None;
    }
    let build_signature = signature_state == CachedSignatureState::Missing;
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
                    build_signature,
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
                    build_signature,
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
    trust: &TrustSnapshot,
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
                trust,
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
    trust: &TrustSnapshot,
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
            trust,
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

struct WorkerWalkBatch<'a> {
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
    fn new(live: &'a LiveWalk, capacity: usize) -> Self {
        Self {
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
        if let Ok(mut published) = self.live.files.lock() {
            published.append(&mut self.files);
            self.live.files_cond.notify_all();
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

fn merge_sorted_inventory(left: &[PathBuf], right: &[PathBuf]) -> Vec<PathBuf> {
    let mut merged = Vec::with_capacity(left.len().saturating_add(right.len()));
    let (mut left_index, mut right_index) = (0usize, 0usize);
    while left_index < left.len() || right_index < right.len() {
        let next = match (left.get(left_index), right.get(right_index)) {
            (Some(left), Some(right)) if left <= right => {
                left_index += 1;
                left
            }
            (Some(_), Some(right)) => {
                right_index += 1;
                right
            }
            (Some(left), None) => {
                left_index += 1;
                left
            }
            (None, Some(right)) => {
                right_index += 1;
                right
            }
            (None, None) => break,
        };
        if merged.last() != Some(next) {
            merged.push(next.clone());
        }
    }
    merged
}

fn repair_anchors(root: &Path, paths: &[PathBuf]) -> Vec<PathBuf> {
    let mut anchors = paths
        .iter()
        .map(|path| {
            if path_starts_with(path, root) {
                path.clone()
            } else if path_starts_with(root, path) {
                root.to_path_buf()
            } else {
                path.clone()
            }
        })
        .filter(|path| FileListStore::paths_overlap(path, root))
        .collect::<Vec<_>>();
    anchors.sort_by_key(|path| path.components().count());
    let mut minimal: Vec<PathBuf> = Vec::new();
    for path in anchors {
        if !minimal
            .iter()
            .any(|ancestor| path_starts_with(&path, ancestor))
        {
            minimal.push(path);
        }
    }
    minimal
}

fn scan_inventory_subtree(key: &WalkKey, anchor: &Path) -> Result<Vec<PathBuf>, String> {
    if !anchor.exists() {
        return Ok(Vec::new());
    }
    let relative_depth = anchor
        .strip_prefix(&key.operand)
        .ok()
        .map(|relative| relative.components().count())
        .unwrap_or(0);
    if key
        .max_depth
        .is_some_and(|max_depth| relative_depth > max_depth)
    {
        return Ok(Vec::new());
    }
    let mut walk = WalkBuilder::new(anchor);
    walk.hidden(!key.hidden).threads(inventory_walk_threads());
    if key.no_ignore {
        walk.ignore(false)
            .git_ignore(false)
            .git_global(false)
            .git_exclude(false);
    } else if key.no_require_git {
        walk.require_git(false);
    }
    if let Some(max_depth) = key.max_depth {
        walk.max_depth(Some(max_depth.saturating_sub(relative_depth)));
    }
    if let Some(overrides) = prune_overrides(&key.operand, &key.prune) {
        walk.overrides(overrides);
    }
    let mut files = Vec::new();
    for entry in walk.build() {
        let entry = entry.map_err(|error| error.to_string())?;
        if !path_starts_with(entry.path(), &key.operand) {
            continue;
        }
        let (is_file, is_dir, is_symlink) = if let Some(kind) = entry.file_type() {
            (kind.is_file(), kind.is_dir(), kind.is_symlink())
        } else {
            let metadata = std::fs::symlink_metadata(entry.path())
                .map_err(|error| error.to_string())?;
            let kind = metadata.file_type();
            (kind.is_file(), kind.is_dir(), kind.is_symlink())
        };
        if is_file
            || key.directories
                && ((is_dir && entry.path() != key.operand) || is_symlink)
        {
            files.push(entry.into_path());
        }
    }
    files.par_sort_unstable();
    files.dedup();
    Ok(files)
}

fn repair_inventory(
    key: &WalkKey,
    base: &[PathBuf],
    changed_paths: &[PathBuf],
) -> Result<Arc<Vec<PathBuf>>, String> {
    let anchors = repair_anchors(&key.operand, changed_paths);
    if anchors.is_empty() {
        return Ok(Arc::new(base.to_vec()));
    }
    let retained = base
        .iter()
        .filter(|path| !anchors.iter().any(|anchor| path_starts_with(path, anchor)))
        .cloned()
        .collect::<Vec<_>>();
    let mut additions = Vec::new();
    for anchor in &anchors {
        additions.extend(scan_inventory_subtree(key, anchor)?);
    }
    additions.par_sort_unstable();
    additions.dedup();
    Ok(Arc::new(merge_sorted_inventory(&retained, &additions)))
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
                live.enumeration_done.store(true, Ordering::Release);
                live.files_cond.notify_all();
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
            let publish_batch = inventory_publish_batch();
            walk.build_parallel().run(|| {
                let live = &live;
                let operand = &operand;
                let mut batch = WorkerWalkBatch::new(live, publish_batch);
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
                    let (is_file, is_dir, is_symlink) = if let Some(kind) = entry.file_type() {
                        (kind.is_file(), kind.is_dir(), kind.is_symlink())
                    } else {
                        match std::fs::symlink_metadata(entry.path()) {
                            Ok(metadata) => {
                                let kind = metadata.file_type();
                                (kind.is_file(), kind.is_dir(), kind.is_symlink())
                            }
                            Err(error) => {
                                record_walk_error(live, error);
                                return ignore::WalkState::Continue;
                            }
                        }
                    };
                    if !is_file
                        && !(parsed.directories
                            && ((is_dir && entry.path() != operand.as_path()) || is_symlink))
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
            // Fuzzy consumers rank the published stream in discovery order and
            // do not depend on inventory ordering. Let them return as soon as
            // enumeration is complete while this worker finishes the
            // deterministic sorted cache in the background.
            live.enumeration_done.store(true, Ordering::Release);
            live.files_cond.notify_all();
            let mut files = live
                .files
                .lock()
                .map_err(|_| "parallel file collector poisoned".to_string())?
                .clone();
            // Inventory order is deterministic but duplicate paths are
            // equivalent, so stability buys nothing. Parallel unstable sort
            // removes the single-core tail that cold broad finds previously
            // paid after the parallel walk had already completed.
            files.par_sort_unstable();
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
    let watched = store.watch_root(operand_path, parsed.no_ignore);
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
    let watched = store.watch_root(operand_path, parsed.no_ignore);
    let trust = TrustSnapshot::capture();
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
            &trust,
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
            &trust,
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

// Nucleo fuzzy matching requires every ASCII query byte to occur in order.
// Rejecting paths that fail that necessary condition is exact, not heuristic.
// Keep non-ASCII paths on the full matcher path because Smart normalization
// may fold Unicode characters onto an ASCII query.
fn fuzzy_ascii_subsequence_possible(query: &str, path: &str) -> bool {
    if !query.is_ascii() || !path.is_ascii() {
        return true;
    }
    let mut query = query.bytes().map(|byte| byte.to_ascii_lowercase());
    let mut wanted = query.next();
    if wanted.is_none() {
        return true;
    }
    for byte in path.bytes() {
        if Some(byte.to_ascii_lowercase()) == wanted {
            wanted = query.next();
            if wanted.is_none() {
                return true;
            }
        }
    }
    false
}

fn fuzzy_ascii_presence(value: &str) -> Option<(u64, u64)> {
    if !value.is_ascii() {
        return None;
    }
    let mut low = 0u64;
    let mut high = 0u64;
    for byte in value.bytes().map(|byte| byte.to_ascii_lowercase()) {
        if byte < 64 {
            low |= 1u64 << byte;
        } else {
            high |= 1u64 << (byte - 64);
        }
    }
    Some((low, high))
}

struct FuzzyQueryToken {
    text: String,
    mask: Option<(u64, u64)>,
    pattern: Pattern,
}

fn retain_fuzzy_path(
    tokens: &[FuzzyQueryToken],
    path: &str,
    path_mask: Option<(u64, u64)>,
    matcher: &mut FuzzyMatcher,
    matches: &mut std::collections::BinaryHeap<FuzzyHit>,
    limit: usize,
    total_matches: &mut usize,
) {
    for token in tokens {
        if let (Some((query_low, query_high)), Some((path_low, path_high))) =
            (token.mask, path_mask)
        {
            if path_low & query_low != query_low || path_high & query_high != query_high {
                return;
            }
        }
        if !fuzzy_ascii_subsequence_possible(&token.text, path) {
            return;
        }
    }
    let matcher_text = Utf32String::from(path.to_string());
    let mut score = 0u32;
    for token in tokens {
        let Some(token_score) = token.pattern.score(matcher_text.slice(..), matcher) else {
            return;
        };
        score = score.saturating_add(token_score);
    }
    *total_matches += 1;
    let candidate = FuzzyHit {
        score,
        path: path.to_string(),
    };
    if matches.len() < limit {
        matches.push(candidate);
        return;
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
        literal_trigrams: None,
    };
    let root = Path::new(&req.cwd);
    let key = fuzzy_key(root, &parsed);
    let filter = PathFilter::new(root, &parsed)?;
    let tokens = query
        .split_whitespace()
        .map(|text| FuzzyQueryToken {
            text: text.to_string(),
            mask: fuzzy_ascii_presence(text),
            pattern: Pattern::new(
                text,
                CaseMatching::Ignore,
                Normalization::Smart,
                AtomKind::Fuzzy,
            ),
        })
        .collect::<Vec<_>>();
    let mut matcher = FuzzyMatcher::new(FuzzyConfig::DEFAULT.match_paths());
    let mut matches = BinaryHeap::with_capacity(limit + 1);
    let mut total_matches = 0usize;
    let mut total_seen = 0usize;
    let mut timed_out = false;
    let mut walk_complete = false;
    let mut walk_errors = 0usize;
    let mut walk_error_details = Vec::new();
    let mut cache_safe = true;
    let mut rank_ms = 0.0;
    let inventory_started_at = Instant::now();
    let cached_corpus = store.take_fuzzy_corpus(&key).or_else(|| {
        store
            .take_ready(&key.walk)
            .map(|files| store.fuzzy_corpus(&key, &files, root, &filter))
    });
    if let Some(corpus) = cached_corpus {
        walk_complete = true;
        let rank_started_at = Instant::now();
        for (index, indexed) in corpus.paths.iter().enumerate() {
            if index & 1023 == 0 {
                if cancelled.load(Ordering::Relaxed) {
                    return Err(CANCELLED.to_string());
                }
                if deadline_at.is_some_and(|deadline| Instant::now() >= deadline) {
                    timed_out = true;
                    walk_complete = false;
                    break;
                }
            }
            total_seen = index + 1;
            retain_fuzzy_path(
                &tokens,
                &indexed.path,
                indexed.ascii_mask,
                &mut matcher,
                &mut matches,
                limit,
                &mut total_matches,
            );
        }
        rank_ms += rank_started_at.elapsed().as_secs_f64() * 1_000.0;
    } else {
        let watched = store.watch_root(root, parsed.no_ignore);
        cache_safe = watched;
        let walk_key = key.walk.clone();
        let (live, owner) = store.begin_live_with_inventory(
            walk_key.clone(),
            req.keep_warm,
            req.keep_inventory,
        );
        if !watched {
            live.cacheable.store(false, Ordering::Release);
        }
        let _waiter = store.waiter_guard(walk_key.clone(), Arc::clone(&live));
        if owner {
            start_live_walk(
                Arc::clone(store),
                walk_key,
                Arc::clone(&live),
                root.to_path_buf(),
                parsed.clone(),
            );
        }
        let mut cursor = 0usize;
        'stream: loop {
            let batch = {
                let mut files = live.files.lock().unwrap_or_else(|e| e.into_inner());
                while cursor >= files.len() {
                    if live.enumeration_done.load(Ordering::Acquire) {
                        walk_complete = true;
                        break 'stream;
                    }
                    let state = live.state.lock().unwrap_or_else(|e| e.into_inner());
                    match &*state {
                        LiveState::Done(_) => {
                            walk_complete = true;
                            break 'stream;
                        }
                        LiveState::Abandoned => break 'stream,
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
                        break 'stream;
                    }
                }
                // Materialize the wire-relative strings once while advancing
                // the published cursor. The old path cloned every PathBuf into
                // a temporary batch and then allocated the same strings, which
                // was costly across hundreds of thousands of broad candidates.
                let batch: Vec<String> = files[cursor..]
                    .iter()
                    .filter(|file| filter.allows(file))
                    .map(|file| {
                        file.strip_prefix(root)
                            .unwrap_or(file)
                            .to_string_lossy()
                            .replace('\\', "/")
                    })
                    .collect::<Vec<_>>();
                cursor = files.len();
                batch
            };
            let rank_started_at = Instant::now();
            for path in batch {
                if total_seen & 1023 == 0 {
                    if cancelled.load(Ordering::Relaxed) {
                        return Err(CANCELLED.to_string());
                    }
                    if deadline_at.is_some_and(|deadline| Instant::now() >= deadline) {
                        timed_out = true;
                        break;
                    }
                }
                total_seen += 1;
                let ascii_mask = fuzzy_ascii_presence(&path);
                retain_fuzzy_path(
                    &tokens,
                    &path,
                    ascii_mask,
                    &mut matcher,
                    &mut matches,
                    limit,
                    &mut total_matches,
                );
            }
            rank_ms += rank_started_at.elapsed().as_secs_f64() * 1_000.0;
            if timed_out {
                break;
            }
        }
        walk_errors = live.walk_errors.load(Ordering::Acquire);
        walk_error_details = live_walk_error_details(&live);
        cache_safe &= live.cacheable.load(Ordering::Acquire);
        if walk_complete {
            // The response no longer waits for deterministic inventory sort;
            // retain the completed walk until finish_live installs its cache.
            live.keep_warm.store(true, Ordering::Release);
        }
    }

    let inventory_ms = inventory_started_at.elapsed().as_secs_f64() * 1_000.0;
    let inventory_complete = walk_complete && walk_errors == 0;
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
        "partial": !walk_complete || timed_out || walk_errors > 0,
        "timeout": timed_out,
        "scanErrors": walk_errors,
        "walkErrorDetails": walk_error_details,
        "inventoryChecked": inventory_complete,
        "cacheSafe": cache_safe,
        "inventoryMs": inventory_ms,
        "rankMs": rank_ms,
    }))
}

#[derive(Eq, PartialEq)]
struct MtimeHit {
    mtime_ms: u128,
    path: String,
}

impl Ord for MtimeHit {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        other
            .mtime_ms
            .cmp(&self.mtime_ms)
            .then_with(|| self.path.cmp(&other.path))
    }
}

impl PartialOrd for MtimeHit {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

#[derive(Eq, PartialEq)]
struct UnstattedHit {
    index: usize,
    path: String,
}

impl Ord for UnstattedHit {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.index.cmp(&other.index)
    }
}

impl PartialOrd for UnstattedHit {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

fn retain_bounded<T: Ord>(heap: &mut std::collections::BinaryHeap<T>, candidate: T, cap: usize) {
    if heap.len() < cap {
        heap.push(candidate);
    } else if heap.peek().is_some_and(|worst| candidate < *worst) {
        heap.pop();
        heap.push(candidate);
    }
}

fn collect_mtime_candidates(
    files: &[PathBuf],
    base_index: usize,
    operand: &str,
    operand_path: &Path,
    filter: &PathFilter,
    trust: &TrustSnapshot,
) -> Vec<(usize, String, Option<u128>)> {
    files
        .par_iter()
        .enumerate()
        .filter(|(_, file)| filter.allows(file))
        .map(|(index, file)| {
            let path = display_path(operand, operand_path, file);
            let mtime_ms = file_mtime_ms(file, trust);
            (base_index + index, path, mtime_ms)
        })
        .collect()
}

fn handle_mtime_inventory(
    req: &ServeRequest,
    parsed: &ParsedArgs,
    cancelled: &AtomicBool,
    store: &Arc<FileListStore>,
    deadline_at: Option<Instant>,
) -> Result<serde_json::Value, String> {
    use std::collections::BinaryHeap;

    let cwd = Path::new(&req.cwd);
    refresh_content_signature_journals(&parsed.targets, cwd);
    let cap = req.offset.saturating_add(req.limit.max(1));
    let mut statted = BinaryHeap::with_capacity(cap + 1);
    let mut unstatted = BinaryHeap::with_capacity(cap + 1);
    let mut total_seen = 0usize;
    let mut timed_out = false;
    let mut scan_error_count = 0usize;
    let mut walk_error_details = Vec::new();
    let mut cache_safe = true;

    for operand in &parsed.targets {
        let operand_path = if Path::new(operand).is_absolute() {
            PathBuf::from(operand)
        } else {
            cwd.join(operand)
        };
        let filter = PathFilter::new(&operand_path, parsed)?;
        let watched = store.watch_root(&operand_path, parsed.no_ignore);
        let trust = TrustSnapshot::capture();
        cache_safe &= watched;
        let walk_key = walk_key(&operand_path, parsed);
        if let Some(files) = store.take_ready(&walk_key) {
            let candidates =
                collect_mtime_candidates(&files, 0, operand, &operand_path, &filter, &trust);
            total_seen = total_seen.saturating_add(candidates.len());
            for (index, path, mtime_ms) in candidates {
                if let Some(mtime_ms) = mtime_ms {
                    retain_bounded(&mut statted, MtimeHit { mtime_ms, path }, cap);
                } else {
                    retain_bounded(&mut unstatted, UnstattedHit { index, path }, cap);
                }
            }
            continue;
        }

        let (live, owner) = store.begin_live(walk_key.clone(), req.keep_warm);
        if !watched {
            live.cacheable.store(false, Ordering::Release);
        }
        let _waiter = store.waiter_guard(walk_key.clone(), Arc::clone(&live));
        if owner {
            start_live_walk(
                Arc::clone(store),
                walk_key,
                Arc::clone(&live),
                operand_path.clone(),
                parsed.clone(),
            );
        }
        let mut cursor = 0usize;
        let mut operand_complete = false;
        'stream: loop {
            let (batch_start, batch) = {
                let mut files = live.files.lock().unwrap_or_else(|e| e.into_inner());
                while cursor >= files.len() {
                    if live.enumeration_done.load(Ordering::Acquire) {
                        operand_complete = true;
                        break 'stream;
                    }
                    let state = live.state.lock().unwrap_or_else(|e| e.into_inner());
                    match &*state {
                        LiveState::Done(_) => {
                            operand_complete = true;
                            break 'stream;
                        }
                        LiveState::Abandoned => break 'stream,
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
                        break 'stream;
                    }
                }
                let start = cursor;
                let batch: Vec<PathBuf> = files[cursor..]
                    .iter()
                    .filter(|file| filter.allows(file))
                    .cloned()
                    .collect();
                cursor = files.len();
                (start, batch)
            };
            let candidates = collect_mtime_candidates(
                &batch,
                batch_start,
                operand,
                &operand_path,
                &filter,
                &trust,
            );
            total_seen = total_seen.saturating_add(candidates.len());
            for (index, path, mtime_ms) in candidates {
                if cancelled.load(Ordering::Relaxed) {
                    return Err(CANCELLED.to_string());
                }
                if deadline_at.is_some_and(|deadline| Instant::now() >= deadline) {
                    timed_out = true;
                    break;
                }
                if let Some(mtime_ms) = mtime_ms {
                    retain_bounded(&mut statted, MtimeHit { mtime_ms, path }, cap);
                } else {
                    retain_bounded(&mut unstatted, UnstattedHit { index, path }, cap);
                }
            }
            if timed_out {
                break;
            }
        }
        let walk_errors = live.walk_errors.load(Ordering::Acquire);
        scan_error_count = scan_error_count.saturating_add(walk_errors);
        append_walk_error_details(&mut walk_error_details, live_walk_error_details(&live));
        cache_safe &= live.cacheable.load(Ordering::Acquire);
        if operand_complete {
            live.keep_warm.store(true, Ordering::Release);
        } else {
            timed_out = true;
        }
        if timed_out {
            break;
        }
    }

    let mut statted = statted.into_vec();
    statted.sort_by(|left, right| {
        right
            .mtime_ms
            .cmp(&left.mtime_ms)
            .then_with(|| left.path.cmp(&right.path))
    });
    let mut unstatted = unstatted.into_vec();
    unstatted.sort_by_key(|entry| entry.index);
    let ordered: Vec<String> = statted
        .into_iter()
        .map(|entry| entry.path)
        .chain(unstatted.into_iter().map(|entry| entry.path))
        .skip(req.offset)
        .take(req.limit.max(1))
        .collect();
    let complete = !timed_out && scan_error_count == 0;
    Ok(serde_json::json!({
        "id": req.id,
        "lines": ordered,
        "complete": complete,
        "totalSeen": total_seen,
        "partial": timed_out || scan_error_count > 0,
        "timeout": timed_out,
        "scanErrors": scan_error_count,
        "walkErrorDetails": walk_error_details,
        "inventoryChecked": complete,
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
    refresh_content_signature_journals(&parsed.targets, Path::new(&req.cwd));
    if parsed.files_list && req.mtime_top_k && req.limit > 0 {
        return handle_mtime_inventory(req, &parsed, cancelled, store, deadline_at);
    }
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
            let watched = store.watch_root(&operand_path, parsed.no_ignore);
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
    refresh_content_signature_journals(&parsed.targets, cwd);
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
        let trust = TrustSnapshot::capture();
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
                &trust,
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
    let response = serde_json::json!({
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
    });
    schedule_content_signature_cache_persist();
    Ok(response)
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

    // Generic over the sink so one queue type serves both transports: the
    // stdio server writes to stdout, and a shared pipe server gives every
    // accepted connection its own queue + writer thread. Responses must never
    // cross connections, so ownership of the writer belongs to the queue.
    fn run<W: Write>(&self, writer: W) {
        let mut out = BufWriter::new(writer);
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

    /// Release the writer thread. Queued lines are dropped rather than
    /// written: a caller reaching teardown has already flushed whatever it
    /// still cared about, and blocking shutdown behind a writer whose consumer
    /// may itself be gone is how a hung teardown starts.
    fn close(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.closed = true;
        state.control.clear();
        state.normal.clear();
        self.changed.notify_all();
        self.space.notify_all();
        self.drained.notify_all();
    }
}

/// The process-wide outbound route for UNSOLICITED events.
///
/// Watcher invalidations are emitted deep inside the engine with no request in
/// hand, so they cannot travel through a per-request sink. That route is
/// installable rather than hard-wired to stdout: the in-process addon shares
/// its host's stdout, and writing JSONL there would corrupt whatever the host
/// is printing. The addon therefore installs its own queue before the engine
/// can emit anything; an empty slot means the standalone process, which owns
/// stdout outright.
static RESPONSE_QUEUE: RwLock<Option<Arc<ResponseQueue>>> = RwLock::new(None);

fn response_queue() -> Arc<ResponseQueue> {
    if let Some(queue) = RESPONSE_QUEUE
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
    {
        return Arc::clone(queue);
    }
    let mut slot = RESPONSE_QUEUE.write().unwrap_or_else(|e| e.into_inner());
    // Another thread may have installed one while this thread upgraded the
    // lock; a second stdout writer would interleave half-lines.
    if let Some(queue) = slot.as_ref() {
        return Arc::clone(queue);
    }
    let queue = Arc::new(ResponseQueue::new(response_queue_capacity()));
    let writer_queue = Arc::clone(&queue);
    std::thread::Builder::new()
        .name("mixdog-search-response-writer".to_string())
        .spawn(move || writer_queue.run(std::io::stdout()))
        .expect("mixdog response writer");
    *slot = Some(Arc::clone(&queue));
    queue
}

/// Redirect unsolicited events, returning the route that was replaced.
fn install_response_queue(queue: Option<Arc<ResponseQueue>>) -> Option<Arc<ResponseQueue>> {
    let mut slot = RESPONSE_QUEUE.write().unwrap_or_else(|e| e.into_inner());
    std::mem::replace(&mut *slot, queue)
}

// ── Idle reclaim watchdog ───────────────────────────────────────────────────
// A resident server that has gone quiet must not keep pinning its warm file
// inventory and signature cache. How it lets go depends on who owns the
// process, which is what IdlePolicy selects.
//
// Standalone (`--serve-search`): exit. The server normally dies with its owner
// — when the host's stdin write handle closes, the request loop reads EOF and
// returns — but that signal never arrives if the owner is force-killed while
// another process still holds the pipe's write end, and Windows reaps nothing
// on parent exit, so orphaned servers piled up across restarts. The JS client
// respawns transparently on the next call. Mirrors the mixdog-patch watchdog.
//
// In-process (Node-API addon): the host owns the process, so exiting would
// take the host down with it. Drop the caches instead and keep serving.
//
// Tunable via MIXDOG_SEARCH_SERVER_IDLE_MS (default 300000ms); 0 disables it.
const DEFAULT_SERVE_SEARCH_IDLE_MS: u64 = 300_000;

/// How a server reclaims once the idle window expires.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum IdlePolicy {
    /// Owns its process: exit and let the OS reclaim every page.
    ExitProcess,
    /// Hosted inside someone else's process: release caches, keep serving.
    ReleaseCaches,
}

static SERVE_SEARCH_STARTED: OnceLock<Instant> = OnceLock::new();
static SERVE_SEARCH_LAST_ACTIVITY_MS: AtomicU64 = AtomicU64::new(0);

fn serve_search_uptime_ms() -> u64 {
    SERVE_SEARCH_STARTED
        .get_or_init(Instant::now)
        .elapsed()
        .as_millis() as u64
}

fn note_serve_search_activity() {
    SERVE_SEARCH_LAST_ACTIVITY_MS.store(serve_search_uptime_ms(), Ordering::Relaxed);
}

fn start_serve_search_idle_watchdog(
    file_lists: Arc<FileListStore>,
    policy: IdlePolicy,
    alive: Arc<AtomicBool>,
) {
    let idle_ms = std::env::var("MIXDOG_SEARCH_SERVER_IDLE_MS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(DEFAULT_SERVE_SEARCH_IDLE_MS);
    if idle_ms == 0 {
        return;
    }
    note_serve_search_activity();
    // A long scan is not idleness: the request that started it stamps the clock
    // on the way in and its response stamps it again on the way out, so
    // in-flight work can never age past the window.
    let step = Duration::from_millis(idle_ms.clamp(250, 5_000));
    let _ = std::thread::Builder::new()
        .name("mixdog-search-idle-watchdog".to_string())
        .spawn(move || {
            // Which activity stamp was already reclaimed. A released server
            // stays idle indefinitely, and repeating the release every step
            // would re-persist an empty snapshot on a loop.
            let mut reclaimed: Option<u64> = None;
            while alive.load(Ordering::Acquire) {
                std::thread::sleep(step);
                if !alive.load(Ordering::Acquire) {
                    return;
                }
                let last_activity = SERVE_SEARCH_LAST_ACTIVITY_MS.load(Ordering::Relaxed);
                let idle_for = serve_search_uptime_ms().saturating_sub(last_activity);
                if idle_for < idle_ms {
                    reclaimed = None;
                    continue;
                }
                match policy {
                    IdlePolicy::ExitProcess => {
                        // Exit the same way the normal loop-exit path does, so
                        // the next server starts warm instead of re-walking.
                        persist_file_list_snapshot(&file_lists.ready);
                        flush_responses();
                        std::process::exit(0);
                    }
                    IdlePolicy::ReleaseCaches => {
                        if reclaimed == Some(last_activity) {
                            continue;
                        }
                        reclaimed = Some(last_activity);
                        file_lists.release_caches();
                    }
                }
            }
        });
}

fn enqueue_response(response: &serde_json::Value, control: bool) {
    note_serve_search_activity();
    response_queue().push(response.to_string(), control);
}

fn write_response(response: &serde_json::Value) {
    enqueue_response(response, false);
}

fn flush_responses() {
    response_queue().flush();
}

/// One connected client's outbound channel.
///
/// The stdio server has exactly one of these (wrapping the process-wide stdout
/// queue); a shared server hands every accepted connection its own queue and
/// writer thread. Request ids are only unique WITHIN a client — each JS client
/// starts its sequence at 1 — so a response must travel back through the sink
/// that carried its request, never through a global.
#[derive(Clone)]
struct ClientSink {
    queue: Arc<ResponseQueue>,
}

impl ClientSink {
    fn enqueue(&self, response: &serde_json::Value, control: bool) {
        note_serve_search_activity();
        self.queue.push(response.to_string(), control);
    }

    fn write(&self, response: &serde_json::Value) {
        self.enqueue(response, false);
    }

    fn write_control(&self, response: &serde_json::Value) {
        self.enqueue(response, true);
    }

    fn write_cancelled(&self, id: u64) {
        self.write_control(&serde_json::json!({ "id": id, "event": "cancelled" }));
    }

    fn flush(&self) {
        self.queue.flush();
    }
}

fn stdio_sink() -> ClientSink {
    ClientSink {
        queue: response_queue(),
    }
}

/// Scopes a request id to the client that issued it. Cancellation and
/// completion both look up through this key, so two clients using the same id
/// can never cancel or answer each other's search.
type RequestKey = (u64, u64);

/// Reserved for the single client of the stdio transport.
const STDIO_CLIENT_ID: u64 = 0;

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
    client_id: u64,
    sink: ClientSink,
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
    cancellations: Arc<Mutex<HashMap<RequestKey, Arc<AtomicBool>>>>,
}

struct SearchScheduler {
    inner: Arc<SchedulerInner>,
    dispatcher: Option<JoinHandle<()>>,
}

impl SearchScheduler {
    fn new(
        file_lists: Arc<FileListStore>,
        cancellations: Arc<Mutex<HashMap<RequestKey, Arc<AtomicBool>>>>,
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

    fn cancel_queued(&self, client_id: u64, id: u64) -> bool {
        let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        let before = state.interactive.len() + state.fuzzy.len() + state.bulk.len();
        // Ids repeat across clients, so a queued search only matches when BOTH
        // the issuing client and the id line up.
        let mine = |search: &ScheduledSearch| search.client_id == client_id && search.req.id == id;
        state.interactive.retain(|search| !mine(search));
        state.fuzzy.retain(|search| !mine(search));
        state.bulk.retain(|search| !mine(search));
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
        client_id,
        sink,
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
        map.remove(&(client_id, id));
    }
    if cancelled.load(Ordering::Relaxed) {
        sink.write_cancelled(id);
    } else {
        if let Some(response) = response {
            sink.write(&response);
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

/// The resident search engine, independent of how requests reach it.
///
/// `--serve-search` (stdin lines) and the Node-API addon (host calls) are the
/// same server: request lines go in, JSONL response lines come out. The engine
/// runs on its own thread, so a host sitting on a JavaScript main thread never
/// blocks on snapshot loading, scheduling, or teardown.
pub struct SearchServer {
    /// Dropped on shutdown; that is what ends the engine's receive loop.
    requests: Option<Sender<String>>,
    engine: Option<JoinHandle<()>>,
    /// Present only when this server created the queue (the addon transport).
    /// The standalone process shares the stdout-backed process-wide queue and
    /// must not close it out from under the writer thread.
    owned_queue: Option<Arc<ResponseQueue>>,
    alive: Arc<AtomicBool>,
}

impl SearchServer {
    /// The standalone `--serve-search` process: responses go to stdout and the
    /// idle window ends the process.
    pub fn standalone() -> Self {
        Self::start(stdio_sink(), None, IdlePolicy::ExitProcess)
    }

    /// An in-process host (Node-API addon): responses are written as JSONL
    /// lines into `writer`, and the idle window releases caches rather than
    /// exiting — the host owns this process.
    pub fn embedded<W: Write + Send + 'static>(writer: W) -> Self {
        let queue = Arc::new(ResponseQueue::new(response_queue_capacity()));
        let writer_queue = Arc::clone(&queue);
        std::thread::Builder::new()
            .name("mixdog-search-response-writer".to_string())
            .spawn(move || writer_queue.run(writer))
            .expect("mixdog response writer");
        // Unsolicited watcher events must reach THIS host rather than a stdout
        // the addon does not own. Installed before the engine starts, so no
        // event can escape down the wrong route.
        install_response_queue(Some(Arc::clone(&queue)));
        let sink = ClientSink {
            queue: Arc::clone(&queue),
        };
        Self::start(sink, Some(queue), IdlePolicy::ReleaseCaches)
    }

    fn start(
        sink: ClientSink,
        owned_queue: Option<Arc<ResponseQueue>>,
        policy: IdlePolicy,
    ) -> Self {
        std::thread::spawn(ensure_content_signature_cache_loaded);
        // Readiness is announced before the engine touches the disk snapshot,
        // so a host never waits on inventory load to learn the server is up.
        sink.write_control(&serde_json::json!({ "ready": true }));
        let (requests, incoming) = channel::<String>();
        let alive = Arc::new(AtomicBool::new(true));
        let engine_alive = Arc::clone(&alive);
        let engine = std::thread::Builder::new()
            .name("mixdog-search-engine".to_string())
            .spawn(move || run_engine(sink, incoming, policy, engine_alive))
            .expect("mixdog search engine");
        Self {
            requests: Some(requests),
            engine: Some(engine),
            owned_queue,
            alive,
        }
    }

    /// Queue one request line. Returns false once the engine is gone. Never
    /// blocks on search work — the caller may be a JavaScript main thread.
    pub fn dispatch(&self, line: &str) -> bool {
        note_serve_search_activity();
        match self.requests.as_ref() {
            Some(requests) => requests.send(line.to_string()).is_ok(),
            None => false,
        }
    }

    /// Drain, stop, and release. Ordered on purpose: closing the request
    /// channel ends the engine loop, which persists its snapshot and flushes
    /// every queued response BEFORE the writer thread is released.
    pub fn shutdown(&mut self) {
        self.alive.store(false, Ordering::Release);
        self.requests = None;
        if let Some(engine) = self.engine.take() {
            let _ = engine.join();
        }
        let Some(queue) = self.owned_queue.take() else {
            return;
        };
        queue.close();
        // Only retract the route this server installed: a later server may
        // already own it.
        let installed = install_response_queue(None);
        if let Some(installed) = installed {
            if !Arc::ptr_eq(&installed, &queue) {
                install_response_queue(Some(installed));
            }
        }
    }
}

impl Drop for SearchServer {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn run_engine(
    sink: ClientSink,
    incoming: Receiver<String>,
    policy: IdlePolicy,
    alive: Arc<AtomicBool>,
) {
    let file_lists = Arc::new(FileListStore::new_persistent());
    file_lists.schedule_noise_prewarm();
    let cancellations: Arc<Mutex<HashMap<RequestKey, Arc<AtomicBool>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let scheduler = SearchScheduler::new(Arc::clone(&file_lists), Arc::clone(&cancellations));
    start_serve_search_idle_watchdog(Arc::clone(&file_lists), policy, alive);
    // One server serves exactly one client, so it owns the reserved id 0 and a
    // single sink. Request ids are unique only WITHIN a client, which is why
    // cancellation keys pair the client with the id.
    let client_id = STDIO_CLIENT_ID;
    for line in incoming {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<WireRequest>(&line) {
            Ok(WireRequest::ListMetadata {
                id,
                cwd,
                list_metadata,
            }) => {
                let sink = sink.clone();
                std::thread::spawn(move || {
                    sink.write_control(&list_metadata_response(id, &cwd, &list_metadata));
                });
            }
            Ok(WireRequest::Cancel { cancel }) => {
                let running = cancellations
                    .lock()
                    .ok()
                    .and_then(|map| map.get(&(client_id, cancel)).cloned())
                    .is_some_and(|flag| {
                        flag.store(true, Ordering::Relaxed);
                        true
                    });
                let removed = scheduler.cancel_queued(client_id, cancel);
                if removed || !running {
                    if let Ok(mut map) = cancellations.lock() {
                        map.remove(&(client_id, cancel));
                    }
                    sink.write_cancelled(cancel);
                }
            }
            Ok(WireRequest::ProcessSnapshot {
                id,
                process_snapshot: true,
            }) => sink.write_control(&process_snapshot(id)),
            Ok(WireRequest::ProcessSnapshot { id, .. }) => sink.write_control(
                &serde_json::json!({ "id": id, "error": "invalid process snapshot request" }),
            ),
            Ok(WireRequest::Search(req)) => {
                let id = req.id;
                let cancelled = Arc::new(AtomicBool::new(false));
                if let Ok(mut map) = cancellations.lock() {
                    map.insert((client_id, id), Arc::clone(&cancelled));
                }
                let scheduled = ScheduledSearch {
                    req,
                    cancelled,
                    queued_at: Instant::now(),
                    client_id,
                    sink: sink.clone(),
                };
                if let Err(search) = scheduler.enqueue(scheduled) {
                    if let Ok(mut map) = cancellations.lock() {
                        map.remove(&(client_id, id));
                    }
                    let telemetry = scheduler.telemetry();
                    sink.write(&serde_json::json!({
                        "id": search.req.id,
                        "error": "native search queue saturated",
                        "saturated": true,
                        "scheduler": telemetry_json(telemetry),
                    }));
                }
            }
            Err(error) => sink.write(
                &serde_json::json!({ "id": 0, "error": format!("bad request: {error}") }),
            ),
        }
    }
    scheduler.shutdown();
    persist_file_list_snapshot(&file_lists.ready);
    sink.flush();
}

/// The standalone `--serve-search` transport: one request per stdin line.
pub fn run() {
    let mut server = SearchServer::standalone();
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if !server.dispatch(&line) {
            break;
        }
    }
    server.shutdown();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn request(args: &[&str], limit: usize) -> ServeRequest {
        ServeRequest {
            id: 1,
            cwd: ".".to_string(),
            args: args.iter().map(|value| (*value).to_string()).collect(),
            offset: 0,
            limit,
            deadline_ms: None,
            keep_warm: false,
            keep_inventory: false,
            bulk_hint: false,
            mtime_top_k: false,
            fuzzy: None,
            hidden: false,
            include_noise: false,
            max_depth: None,
            exclude: Vec::new(),
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn path_prefix_checks_are_utf8_boundary_safe() {
        assert!(path_starts_with(
            Path::new(r"C:\한\child"),
            Path::new(r"C:\한"),
        ));
        assert!(!path_starts_with(
            Path::new(r"C:\€\child"),
            Path::new(r"C:\é"),
        ));
    }

    #[test]
    fn journal_sync_evicts_changed_signatures_and_metadata() {
        let serial = u32::MAX - 17;
        let file_id = u64::MAX - 19;
        let path = PathBuf::from(format!("mixdog-journal-eviction-{file_id}"));
        let identity = crate::serve_search_usn::FileIdentity {
            volume: serial,
            file_id,
        };
        let shard = content_signature_shard(&path);
        raw_content_signature_cache()[shard]
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(
                path.clone(),
                ContentSignatureEntry {
                    size: 1,
                    modified_ns: 1,
                    identity: Some(identity),
                    persisted: true,
                    signature: TrigramSignature::new(),
                },
            );
        file_metadata_cache()[shard]
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(
                path.clone(),
                FileMetadataEntry {
                    size: 1,
                    modified_ns: 1,
                    mtime_ms: 1,
                    identity: Some(identity),
                },
            );
        apply_content_signature_journal_sync(crate::serve_search_usn::SyncResult {
            trusted: true,
            volume_serial: Some(serial),
            changed: HashSet::from([file_id]),
            parents: HashSet::new(),
        });
        assert!(!raw_content_signature_cache()[shard]
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .contains_key(&path));
        assert!(!file_metadata_cache()[shard]
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .contains_key(&path));
        trusted_usn_volumes()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&serial);
    }

    #[test]
    fn binary_signature_payload_stays_within_the_memory_budget() {
        assert_eq!(
            CONTENT_SIGNATURE_WORDS * std::mem::size_of::<u64>() * 2,
            4096
        );
        assert!(
            CONTENT_SIGNATURE_WORDS * std::mem::size_of::<u64>() * 2 * CONTENT_SIGNATURE_CACHE_MAX
                <= 64 * 1024 * 1024
        );
        let mut bytes = std::io::Cursor::new(Vec::new());
        bytes.write_all(&(u128::MAX - 7).to_le_bytes()).unwrap();
        bytes.set_position(0);
        assert_eq!(read_snapshot_u128(&mut bytes).unwrap(), u128::MAX - 7);
    }

    #[test]
    fn trusted_cached_signature_is_reused_without_rebuilding() {
        let serial = u32::MAX - 31;
        let file_id = u64::MAX - 37;
        let path = PathBuf::from(format!("mixdog-signature-reuse-{file_id}"));
        let mut signature = TrigramSignature::new();
        signature.push(b"prefix needle suffix");
        signature.complete = true;
        let shard = content_signature_shard(&path);
        raw_content_signature_cache()[shard]
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(
                path.clone(),
                ContentSignatureEntry {
                    size: 1,
                    modified_ns: 1,
                    identity: Some(crate::serve_search_usn::FileIdentity {
                        volume: serial,
                        file_id,
                    }),
                    persisted: false,
                    signature,
                },
            );
        let trust = TrustSnapshot {
            usn_volumes: Arc::new(HashSet::from([serial])),
            watch_roots: Arc::new(Vec::new()),
        };
        let present = b"needle"
            .windows(3)
            .map(|window| trigram_bits(window[0], window[1], window[2]))
            .collect::<Vec<_>>();
        assert_eq!(
            cached_signature_state(&path, &[present], false, &trust),
            CachedSignatureState::Reusable
        );
        raw_content_signature_cache()[shard]
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&path);
    }

    #[test]
    fn exact_watcher_invalidation_does_not_scan_or_remove_siblings() {
        let changed = PathBuf::from("src/change.rs");
        let sibling = PathBuf::from("src/change.rs.backup");
        for path in [&changed, &sibling] {
            raw_content_signature_cache()[content_signature_shard(path)]
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .insert(
                    path.clone(),
                    ContentSignatureEntry {
                        size: 1,
                        modified_ns: 1,
                        identity: None,
                        persisted: false,
                        signature: TrigramSignature::new(),
                    },
                );
        }
        invalidate_content_signatures(std::slice::from_ref(&changed), false);
        assert!(
            !raw_content_signature_cache()[content_signature_shard(&changed)]
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .contains_key(&changed)
        );
        assert!(
            raw_content_signature_cache()[content_signature_shard(&sibling)]
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .contains_key(&sibling)
        );
        raw_content_signature_cache()[content_signature_shard(&sibling)]
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&sibling);
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
    fn fuzzy_ascii_prefilter_rejects_only_impossible_candidates() {
        assert!(fuzzy_ascii_subsequence_possible(
            "TLSMOKE",
            "scripts/tool-smoke.mjs"
        ));
        assert!(!fuzzy_ascii_subsequence_possible(
            "tool-smoke",
            "scripts/trace-store.mjs"
        ));
        // Unicode stays on Nucleo's Smart-normalization path.
        assert!(fuzzy_ascii_subsequence_possible("resume", "src/résumé.rs"));
    }

    #[test]
    fn trigram_signature_only_excludes_impossible_literal_patterns() {
        let mut signature = TrigramSignature::new();
        signature.push(b"prefix needle suffix");
        signature.complete = true;
        let present = b"needle"
            .windows(3)
            .map(|window| trigram_bits(window[0], window[1], window[2]))
            .collect::<Vec<_>>();
        let absent = b"definitely-absent"
            .windows(3)
            .map(|window| trigram_bits(window[0], window[1], window[2]))
            .collect::<Vec<_>>();
        assert!(!signature_excludes_requirements(
            &signature,
            &[present],
            false
        ));
        assert!(signature_excludes_requirements(
            &signature,
            &[absent],
            false
        ));
        let folded = b"NEEDLE"
            .windows(3)
            .map(|window| {
                trigram_bits(
                    window[0].to_ascii_lowercase(),
                    window[1].to_ascii_lowercase(),
                    window[2].to_ascii_lowercase(),
                )
            })
            .collect::<Vec<_>>();
        assert!(!signature_excludes_requirements(
            &signature,
            &[folded],
            true
        ));
    }

    #[test]
    fn literal_prefilter_accepts_utf8_and_extracts_mandatory_regex_runs() {
        let utf8 = parse_args(&request(&["-F", "-e", "한글", "."], 10).args).unwrap();
        assert!(utf8.literal_trigrams.is_some());

        let regex = parse_args(&request(&["-e", "log.*Error", "."], 10).args).unwrap();
        assert!(regex.literal_trigrams.is_some());
        assert_eq!(mandatory_regex_literal("log.*Error").unwrap(), b"Error");
        assert!(mandatory_regex_literal("(optional)?required").is_none());

        let utf8_folded = parse_args(&request(&["-i", "-F", "-e", "한글", "."], 10).args).unwrap();
        assert!(utf8_folded.literal_trigrams.is_none());
    }

    #[test]
    fn negative_globs_prune_the_walk_and_split_the_inventory_key() {
        let plain = parse_args(&request(&["--files", "."], 20).args).unwrap();
        let excluded =
            parse_args(&request(&["--files", "--glob", "!**/node_modules/**", "."], 20).args)
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
    fn exact_file_search_skips_parent_watch_and_stays_complete() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("mixdog-exact-file-{nonce}"));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("mountinfo");
        std::fs::write(&file, "overlay / overlay\n").unwrap();
        let store = Arc::new(FileListStore::new());
        let cancelled = AtomicBool::new(false);
        let req = request(
            &[
                "--no-heading",
                "--line-number",
                "-e",
                "overlay",
                "--",
                &file.to_string_lossy(),
            ],
            20,
        );

        let response = handle(&req, &cancelled, &store, None).unwrap();

        assert_eq!(response["complete"], true);
        assert_eq!(response["partial"], false);
        assert_eq!(response["cacheSafe"], false);
        assert!(response["lines"]
            .as_array()
            .is_some_and(|lines| lines.iter().any(|line| {
                line.as_str()
                    .is_some_and(|value| value.contains("overlay / overlay"))
            })));
        assert!(store
            .watched_roots
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn descendant_operands_reuse_the_ancestor_watch_root() {
        let store = Arc::new(FileListStore::new());
        let dir = std::env::temp_dir().join("mixdog-watch-cover-test");
        let sub = dir.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        assert!(store.watch_root(&dir, false));
        assert!(store.watch_root(&sub, false));
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
            enumeration_done: AtomicBool::new(false),
            keep_warm: AtomicBool::new(false),
            keep_inventory: AtomicBool::new(false),
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
            enumeration_done: AtomicBool::new(false),
            keep_warm: AtomicBool::new(false),
            keep_inventory: AtomicBool::new(false),
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
            &TrustSnapshot {
                usn_volumes: Arc::new(HashSet::new()),
                watch_roots: Arc::new(Vec::new()),
            },
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

        let inventory_key = walk_key(Path::new("inventory"), &parsed);
        let (inventory, owner) =
            store.begin_live_with_inventory(inventory_key.clone(), false, true);
        assert!(owner);
        store.release_live(&inventory_key, &inventory);
        assert!(!inventory.cancelled.load(Ordering::Acquire));
        assert!(!inventory.keep_warm.load(Ordering::Acquire));
        assert!(inventory.keep_inventory.load(Ordering::Acquire));
        assert!(store
            .live
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&inventory_key)
            .is_some());
    }

    #[cfg(unix)]
    #[test]
    fn fuzzy_inventory_includes_symlink_leaves_without_following_symlink_directories() {
        use std::os::unix::fs::symlink;

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mg-fuzzy-links-{nonce}"));
        let outside = std::env::temp_dir().join(format!("mg-fuzzy-links-outside-{nonce}"));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let outside_file = outside.join("real-tool");
        std::fs::write(&outside_file, "tool\n").unwrap();
        std::fs::write(outside.join("nested-only-marker"), "nested\n").unwrap();
        symlink(&outside_file, root.join("tool-link")).unwrap();
        symlink(&outside, root.join("external-dir-link")).unwrap();

        let store = Arc::new(FileListStore::new());
        let cancelled = AtomicBool::new(false);
        let mut req = request(&[], 10);
        req.cwd = root.to_string_lossy().into_owned();
        req.fuzzy = Some("tool-link".to_string());
        req.hidden = true;
        req.include_noise = true;
        req.keep_inventory = true;

        let linked_file = handle_fuzzy(&req, &cancelled, &store, None).unwrap();
        assert_eq!(linked_file["complete"], true);
        assert!(linked_file["matches"]
            .as_array()
            .unwrap()
            .iter()
            .any(|path| path.as_str() == Some("tool-link")));

        req.fuzzy = Some("nested-only-marker".to_string());
        let linked_directory = handle_fuzzy(&req, &cancelled, &store, None).unwrap();
        assert_eq!(linked_directory["complete"], true);
        assert!(linked_directory["matches"].as_array().unwrap().is_empty());

        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&outside).ok();
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
    fn watched_inventory_survives_ttl_until_watch_is_removed() {
        let store = FileListStore::new();
        let root = PathBuf::from("watched-ttl-root");
        let parsed = parse_args(&request(&["--files", "."], 20).args).unwrap();
        let key = walk_key(&root, &parsed);
        store
            .watched_roots
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(root.clone(), Instant::now());
        store
            .ready
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(
                key.clone(),
                ReadyEntry {
                    files: Arc::new(vec![root.join("cached.rs")]),
                    expires_at: Instant::now() - Duration::from_secs(1),
                    generation: 0,
                    touched_at: Instant::now(),
                    estimated_bytes: 1,
                    root_identity: None,
                },
            );

        assert_eq!(store.take_ready(&key).map(|files| files.len()), Some(1));
        store
            .watched_roots
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
        assert!(store.take_ready(&key).is_none());
    }

    #[test]
    fn incremental_inventory_repair_splices_changed_paths() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "mixdog-inventory-repair-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).expect("fixture root");
        let keep = root.join("keep.rs");
        let removed = root.join("removed.rs");
        let added = root.join("added.rs");
        std::fs::write(&keep, "keep").expect("keep");
        std::fs::write(&added, "added").expect("added");
        let parsed =
            parse_args(&request(&["--files", root.to_string_lossy().as_ref()], 20).args).unwrap();
        let key = walk_key(&root, &parsed);
        let mut base = vec![keep.clone(), removed.clone()];
        base.sort();

        let repaired = repair_inventory(&key, &base, &[removed, added.clone()]).expect("repair");
        assert_eq!(repaired.as_ref(), &vec![added, keep]);
        std::fs::remove_dir_all(root).ok();
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
        let mut reader = CancellableReader::new(source, &cancelled, None, None);
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
