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
    clippy::disallowed_methods,
    reason = "every std::fs call here is the body of a maintenance-lane job (GraphCache::flush/load run on lanes)"
)]

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use mixdog_graph::calls::CallInfo;
use mixdog_graph::outline::SymbolInfo;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::graph::Node;
use super::roots::path_key;

const FORMAT_VERSION: u32 = 1;
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

#[derive(Serialize, Deserialize)]
pub(super) struct CachedCall {
    name: String,
    line: u32,
    col: u32,
    end_col: u32,
    kind: String,
    recv: String,
    in_symbol: String,
}

impl CachedCall {
    fn of(call: &CallInfo) -> Self {
        Self {
            name: call.name.clone(),
            line: call.line,
            col: call.col,
            end_col: call.end_col,
            kind: call.kind.to_owned(),
            recv: call.recv.clone(),
            in_symbol: call.in_symbol.clone(),
        }
    }

    pub(super) fn into_call(self) -> CallInfo {
        CallInfo {
            name: self.name,
            line: self.line,
            col: self.col,
            end_col: self.end_col,
            kind: intern(&self.kind),
            recv: self.recv,
            in_symbol: self.in_symbol,
        }
    }
}

/// One parsed file and the signature it was parsed at.
#[derive(Serialize, Deserialize)]
pub(super) struct CachedFile {
    pub rel: String,
    pub size: u64,
    pub mtime_ns: u64,
    pub text: String,
    pub(super) symbols: Vec<CachedSymbol>,
    pub(super) raw_imports: Vec<String>,
    pub(super) tokens: Vec<String>,
    pub(super) calls: Option<Vec<CachedCall>>,
}

impl CachedFile {
    /// `None` for a node with no signature (it was never read from a file).
    pub(super) fn of(node: &Node) -> Option<Self> {
        let (size, mtime_ns) = node.fingerprint?;
        Some(Self {
            rel: node.rel.clone(),
            size,
            mtime_ns,
            text: node.text.clone(),
            symbols: node.symbols.iter().map(CachedSymbol::of).collect(),
            raw_imports: node.raw_imports.clone(),
            tokens: node.tokens.clone(),
            calls: node.calls.as_ref().map(|calls| calls.iter().map(CachedCall::of).collect()),
        })
    }
}

#[derive(Serialize, Deserialize)]
struct Payload {
    version: u32,
    key: String,
    files: Vec<CachedFile>,
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
    bytes: Vec<u8>,
    built_at: i64,
}

pub struct GraphCache {
    dir: PathBuf,
    max_bytes: u64,
    pending: Mutex<HashMap<String, Staged>>,
    scheduled: AtomicBool,
    /// Serialises the commit (merge, write, prune, sweep) within this core.
    commit: Mutex<()>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
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
fn is_tmp_name(name: &str) -> bool {
    name.rsplit_once(".mixdog-tmp-").is_some_and(|(_, hex)| (16..=24).contains(&hex.len()) && hex.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = path.with_file_name(format!("{name}.mixdog-tmp-{}", &uuid::Uuid::new_v4().simple().to_string()[..16]));
    let written = (|| {
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        io::Write::write_all(&mut file, bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp, path)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written
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
            scheduled: AtomicBool::new(false),
            commit: Mutex::new(()),
        }
    }

    #[cfg(test)]
    fn with_max_bytes(mut self, max_bytes: u64) -> Self {
        self.max_bytes = max_bytes;
        self
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
        let payload: Payload = serde_json::from_slice(&std::fs::read(self.dir.join(format!("{}.json", row.hash))).ok()?).ok()?;
        (payload.version == FORMAT_VERSION && payload.key == key).then(|| payload.files.into_iter().map(|f| (f.rel.clone(), f)).collect())
    }

    /// Queues `root`'s parsed files for the next flush (the newest staging of a root wins).
    pub(super) fn stage(&self, root: &Path, files: Vec<CachedFile>) {
        let key = path_key(root);
        let Ok(bytes) = serde_json::to_vec(&Payload { version: FORMAT_VERSION, key: key.clone(), files }) else {
            return;
        };
        let staged = Staged { root: root.to_string_lossy().into_owned(), bytes, built_at: now_ms() };
        self.pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(key, staged);
    }

    fn has_pending(&self) -> bool {
        !self.pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner).is_empty()
    }

    /// Writes what is staged: merge into the manifest as it stands, prune, sweep. A lane job.
    pub fn flush(&self) -> io::Result<()> {
        let staged = std::mem::take(&mut *self.pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner));
        if staged.is_empty() {
            return Ok(());
        }
        let _commit = self.commit.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        std::fs::create_dir_all(&self.dir)?;
        let mut manifest = self.read_manifest();
        for (key, entry) in staged {
            let hash = hash_of(&key);
            write_atomic(&self.dir.join(format!("{hash}.json")), &entry.bytes)?;
            manifest.insert(key, Row { hash, built_at: entry.built_at, bytes: entry.bytes.len() as u64, root: entry.root });
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

    /// Drops `root` from the cache (`forgetDiskCodeGraphRoot`): the staged copy, the manifest row
    /// and its payload. Only this exact root; nested roots are other roots. Returns what was
    /// removed and the files that matched but could not be deleted. A lane job; never creates the
    /// directory.
    pub fn forget(&self, root: &Path) -> (Vec<String>, Vec<PathBuf>) {
        let key = path_key(root);
        let mut removed = Vec::new();
        let mut kept = Vec::new();
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
            tokio::time::sleep(FLUSH_DELAY).await;
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
            text: text.to_owned(),
            symbols: Vec::new(),
            raw_imports: vec!["./x".to_owned()],
            tokens: vec!["a".to_owned()],
            calls: None,
        }
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
        assert_eq!(loaded["a.mjs"].text, "export const a = 1;");
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
}
