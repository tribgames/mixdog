//! On-disk store for generated media under `<data>/media`: assets as real files in
//! `assets/`, `index.json` (newest first), `boards.json` and `defaults.json`. A catalog
//! read-modify-write holds `<file>.lock` in Node's file-lock protocol, as `updateJsonAtomicSync`
//! does, because the core is not the only writer of the folder: the CLI's headless run and REPL
//! load Node's session runtime in their own process (`src/headless-exec.mjs:412`,
//! `src/repl.mjs:46`), whose media store writes the same `index.json`. Each write is
//! atomic (temp file + rename) and keeps the previous catalog as `<file>.bak`. A damaged file is
//! set aside as `<file>.corrupt-<ts>` and the last good copy restored; any other read failure
//! propagates, so a mutation never writes an empty catalog over an unreadable one.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use mixdog_core_base::support::{FsFailure, FsStep};
use mixdog_rt::DurabilityIo;
use serde_json::{Map, Value, json};

use crate::lane::on_lane;
use unicode_normalization::UnicodeNormalization;

pub const MEDIA_KINDS: [&str; 2] = ["image", "video"];
const MAX_INLINE_BYTES: u64 = 48 * 1024 * 1024;
const MAX_ID_CHARS: usize = 512;
const PINNED: &str = "pinned";

#[derive(Debug, thiserror::Error)]
pub enum MediaError {
    #[error("{0}")]
    Invalid(String),
    #[error("board not found")]
    BoardNotFound,
    #[error("media asset is too large to preview")]
    TooLarge,
    /// The extension host could not build a rendition, or the cache could not hold it.
    #[error("media rendition: {0}")]
    Rendition(String),
    #[error("media store: {0}")]
    Io(#[from] std::io::Error),
    /// A catalog write that failed at a named `fs` call: answered as Node throws it.
    #[error("media store: {}", .0.error)]
    Fs(FsFailure),
    #[error("media store: {0}")]
    Json(#[from] serde_json::Error),
}

impl MediaError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Invalid(_) => "invalid",
            Self::BoardNotFound => "boardNotFound",
            Self::TooLarge => "MEDIA_ASSET_TOO_LARGE",
            Self::Rendition(_) => "renditionFailed",
            Self::Io(_) | Self::Fs(_) | Self::Json(_) => "storeFailed",
        }
    }
}

fn invalid(message: &str) -> MediaError {
    MediaError::Invalid(message.to_owned())
}

/// An asset's original on disk: the index entry with its path, and whether it may be read.
pub enum Located {
    Readable(Value),
    /// A FIFO, device or socket: reading it would hang or never end.
    Special(Value),
}

/// The clock and the id source of the media domain: the stamps of a job and the ids of its jobs and
/// assets. Production draws the system's; a test supplies its own, as the Node recording does.
#[derive(Clone)]
pub struct Marks {
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
    pub id: Arc<dyn Fn() -> String + Send + Sync>,
}

impl Default for Marks {
    fn default() -> Self {
        Self { now: Arc::new(now_ms), id: Arc::new(|| uuid::Uuid::new_v4().to_string()) }
    }
}

pub struct MediaStore {
    dir: PathBuf,
    lock: Mutex<()>,
    /// Every store call of an async path runs on this lane (see [`MediaStore::run`]).
    lane: DurabilityIo,
    marks: Marks,
    /// `layoutMigrationChecked`: the flat v1 assets were moved by this store's first save.
    layout_checked: std::sync::atomic::AtomicBool,
    /// The catalog as last read or written, kept while `index.json` is unchanged on disk (`store.mjs`
    /// `readIndex`): a screen of thumbnails reads it once. Held across a disk read, so a burst of
    /// readers finds one read.
    index: Mutex<IndexCache>,
    /// Runs in a catalog mutation while it holds `index.json.lock`, after its read of the
    /// catalog and before its write: a test does another process's save there.
    #[cfg(test)]
    holding_index: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

/// `indexSignature` (`store.mjs:61-65`): `mtimeMs:ctimeMs:size` of `index.json`. The ctime is the
/// inode change time on Unix and `FILE_BASIC_INFO.ChangeTime` on Windows, as libuv reports it.
/// The times are Node's float milliseconds (`mtimeMs`, `ctimeMs`), so two changes whose times are
/// one double keep the cached catalog here as they do there.
#[derive(Clone, PartialEq)]
enum IndexSignature {
    Missing,
    File { mtime_ms: f64, ctime_ms: f64, size: u64 },
}

/// `indexCacheSignature` / `indexCacheAssets` and the counters of `mediaStoreCacheStats`.
#[derive(Default)]
struct IndexCache {
    signature: Option<IndexSignature>,
    assets: Arc<Vec<Value>>,
    disk_reads: u64,
    hits: u64,
}

fn extension_for(mime: &str) -> &'static str {
    match mime.to_lowercase().as_str() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "video/mp4" => "mp4",
        _ => "bin",
    }
}

fn folder_segment(value: &str, fallback: &str) -> String {
    let normalized: String = value.nfkc().collect();
    let replaced: String = normalized
        .chars()
        .map(|c| if "<>:\"/\\|?*".contains(c) || (c as u32) < 0x20 { '-' } else { c })
        .collect();
    let collapsed = mixdog_js::js_words(&replaced).collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim_end_matches(['.', ' ']);
    let cut = mixdog_js::slice_utf16(trimmed, 80);
    let lower = cut.to_lowercase();
    let reserved = matches!(lower.as_str(), "con" | "prn" | "aux" | "nul")
        || ((lower.starts_with("com") || lower.starts_with("lpt"))
            && lower.len() == 4
            && lower.as_bytes()[3].is_ascii_digit()
            && lower.as_bytes()[3] != b'0');
    if cut.is_empty() || reserved { fallback.to_owned() } else { cut }
}

fn text_of(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).map(|s| mixdog_js::slice_utf16(mixdog_js::js_trim(s), MAX_ID_CHARS)).unwrap_or_default()
}

fn str_field<'a>(entry: &'a Value, key: &str) -> &'a str {
    entry.get(key).and_then(Value::as_str).unwrap_or("")
}

/// `organizedAssetFile`: the date folder is the local date of `new Date(Number(createdAt) || now)` in
/// the zone Node's `Date` reads (`TZ`, else the OS zone).
fn organized_asset_file(entry: &Value, now: i64) -> String {
    let kind = if str_field(entry, "kind") == "video" { "videos" } else { "images" };
    let created = mixdog_js::to_number_of(entry.get("createdAt"));
    let created = if created.is_nan() || created == 0.0 { now as f64 } else { created };
    let date = mixdog_js::time::local_fields(created)
        .map_or_else(|| "NaN-NaN-NaN".to_owned(), |d| format!("{}-{:02}-{:02}", d.year, d.month, d.day));
    format!(
        "{kind}/{}/{}/{date}/{}.{}",
        folder_segment(str_field(entry, "lane"), "unknown-provider"),
        folder_segment(str_field(entry, "model"), "unknown-model"),
        folder_segment(str_field(entry, "id"), "asset"),
        extension_for(str_field(entry, "mime")),
    )
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

pub(crate) fn write_atomic(path: &Path, bytes: &[u8], backup: bool) -> std::io::Result<()> {
    write_atomic_stepped(path, bytes, backup).map_err(|failure| failure.error)
}

/// `writeFileAtomicSync` / `updateJsonAtomicSync`'s publication: a sibling temp file
/// `<name>.mixdog-tmp-<16 hex>`, synced, then renamed over the file (the replaced copy kept as
/// `<file>.bak` when asked). A failure names the call that failed, as Node's error text does; the
/// temp file of a failed publication is removed.
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "runs as a durability-lane job")]
pub(crate) fn write_atomic_stepped(path: &Path, bytes: &[u8], backup: bool) -> Result<(), FsFailure> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| FsFailure { error, step: FsStep::Mkdir(parent.to_owned()) })?;
    }
    let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(format!(".mixdog-tmp-{:016x}", uuid::Uuid::new_v4().as_u64_pair().0));
    let tmp = path.with_file_name(name);
    let written = (|| {
        let mut file = fs::File::create(&tmp).map_err(|error| FsFailure { error, step: FsStep::Open(tmp.clone()) })?;
        file.write_all(bytes).map_err(|error| FsFailure { error, step: FsStep::Write })?;
        file.sync_all().map_err(|error| FsFailure { error, step: FsStep::Fsync })
    })();
    let published = written.and_then(|()| {
        if backup && path.exists() {
            let _ = fs::copy(path, backup_path(path));
        }
        fs::rename(&tmp, path).map_err(|error| FsFailure { error, step: FsStep::Rename(tmp.clone(), path.to_owned()) })
    });
    if published.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    published
}

fn backup_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".bak");
    path.with_file_name(name)
}

/// Reads a JSON state file. Absent → `None`. Damaged (unparsable or failing `valid`) → set
/// aside, the backup restored when it is good, else `None`. Other failures propagate.
pub(crate) fn read_state(path: &Path, valid: impl Fn(&Value) -> bool) -> Result<Option<Value>, MediaError> {
    read_state_at(path, valid, now_ms())
}

/// [`read_state`] whose set-aside copy is stamped `now` (`.corrupt-<Date.now()>`).
#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn read_state_at(path: &Path, valid: impl Fn(&Value) -> bool, now: i64) -> Result<Option<Value>, MediaError> {
    let parse = |p: &Path| -> std::io::Result<Option<Value>> {
        match fs::read(p) {
            // Node cuts a prompt (4000 units) and a board name (120) inside an emoji: half of one is U+FFFD here.
            Ok(bytes) => Ok(serde_json::from_slice::<Value>(&mixdog_js::json_well_formed(&bytes)).ok().filter(|v| valid(v))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    };
    if !path.exists() {
        return Ok(None);
    }
    if let Some(value) = parse(path)? {
        return Ok(Some(value));
    }
    let mut aside = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    aside.push(format!(".corrupt-{now}"));
    let _ = fs::rename(path, path.with_file_name(aside));
    let restored = parse(&backup_path(path))?;
    if let Some(value) = &restored {
        write_atomic(path, &serde_json::to_vec(value)?, false)?;
    }
    Ok(restored)
}

/// `withFileLockSync(`${file}.lock`)` of `updateJsonAtomicSync`, in Node's protocol and with its
/// wait (`MIXDOG_LOCK_TIMEOUT_MS`, else 2 s, one deadline over the line and the file), held until
/// the returned value is dropped. Callers run on the durability lane (`MediaStore::run`), never on
/// an async worker.
fn file_lock(file: &Path) -> Result<mixdog_statefile::LockHold, MediaError> {
    let (sent, taken) = std::sync::mpsc::channel();
    let hold = mixdog_statefile::hold_lock_one_deadline(&mixdog_statefile::lock_path(file), &mixdog_statefile::LockOpts::default(), move |outcome| {
        let _ = sent.send(outcome);
    });
    match taken.recv() {
        Ok(Ok(())) => Ok(hold),
        Ok(Err(mixdog_statefile::LockError::Io(error))) => Err(error.into()),
        Ok(Err(busy)) => Err(MediaError::Io(std::io::Error::new(std::io::ErrorKind::TimedOut, busy.to_string()))),
        Err(_) => Err(MediaError::Io(std::io::Error::other("the lock thread ended without an answer"))),
    }
}

fn has_array(key: &'static str) -> impl Fn(&Value) -> bool {
    move |v| v.get(key).is_some_and(Value::is_array)
}

impl MediaStore {
    pub fn new(data_dir: &Path, lane: DurabilityIo) -> Self {
        Self::with_marks(data_dir, lane, Marks::default())
    }

    pub fn with_marks(data_dir: &Path, lane: DurabilityIo, marks: Marks) -> Self {
        Self {
            dir: data_dir.join("media"),
            lock: Mutex::new(()),
            lane,
            marks,
            layout_checked: std::sync::atomic::AtomicBool::new(false),
            index: Mutex::new(IndexCache::default()),
            #[cfg(test)]
            holding_index: Mutex::new(None),
        }
    }

    fn now(&self) -> i64 {
        (self.marks.now)()
    }

    /// `ensureDirs()`: the assets folder exists once the catalog is touched.
    #[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
    fn ensure_dirs(&self) -> Result<(), MediaError> {
        fs::create_dir_all(self.assets_dir())?;
        Ok(())
    }

    /// `migrateAssetLayout`: flat v1 assets move into their kind/provider/model/date folders, once
    /// per store, on the first save (a write-side task: a read never waits on it). An asset whose
    /// file is already in place is renamed in the index only; one that cannot move stays as it is.
    #[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
    fn migrate_asset_layout(&self) -> Result<(), MediaError> {
        use std::sync::atomic::Ordering;
        if self.layout_checked.load(Ordering::Acquire) {
            return Ok(());
        }
        let now = self.now();
        self.mutate_assets(|current| {
            let mut changed = false;
            let assets: Vec<Value> = current
                .into_iter()
                .map(|entry| {
                    let target_file = organized_asset_file(&entry, now);
                    let source = self.stored_asset_path(str_field(&entry, "file"));
                    let Some(target) = self.stored_asset_path(&target_file) else { return entry };
                    if str_field(&entry, "file").replace('\\', "/") == target_file {
                        return entry;
                    }
                    let moved = |mut entry: Value| {
                        entry["file"] = json!(target_file);
                        entry
                    };
                    if target.exists() {
                        changed = true;
                        return moved(entry);
                    }
                    let Some(source) = source.filter(|source| source.exists()) else { return entry };
                    let renamed = target.parent().map_or(Ok(()), fs::create_dir_all).and_then(|()| fs::rename(&source, &target));
                    if renamed.is_err() {
                        return entry;
                    }
                    changed = true;
                    moved(entry)
                })
                .collect();
            (changed.then_some(assets), ())
        })?;
        self.layout_checked.store(true, Ordering::Release);
        Ok(())
    }

    /// The clock and ids the jobs over this store stamp with.
    pub fn marks(&self) -> &Marks {
        &self.marks
    }

    /// Runs one store operation as a job on the durability lane. The methods below read and
    /// write files, so an async caller never calls them directly.
    pub async fn run<T: Send + 'static>(self: &Arc<Self>, work: impl FnOnce(&MediaStore) -> T + Send + 'static) -> Result<T, MediaError> {
        let this = self.clone();
        Ok(on_lane(self.lane, move || work(&this)).await?)
    }

    fn assets_dir(&self) -> PathBuf {
        self.dir.join("assets")
    }
    fn index_path(&self) -> PathBuf {
        self.dir.join("index.json")
    }
    fn boards_path(&self) -> PathBuf {
        self.dir.join("boards.json")
    }
    fn defaults_path(&self) -> PathBuf {
        self.dir.join("defaults.json")
    }

    /// The asset's file when it stays inside the assets root. Index entries are data on disk, so
    /// a name that reaches the network, a device or an alternate stream is refused too.
    fn stored_asset_path(&self, file: &str) -> Option<PathBuf> {
        use mixdog_js::device_paths::{has_unsafe_win32_component, is_unc_path, is_windows_device_path};
        if is_unc_path(file) || is_windows_device_path(file) || has_unsafe_win32_component(file) {
            return None;
        }
        // Node's `storedAssetPath` (`store.mjs:171-175`): `resolve(root, file)`, lexically (an absolute name stands on its own, `..` steps
        // back), kept only when it is under the root. A name that steps out and back in (`images/../a.png`) is served, as Node serves it.
        let root = self.assets_dir();
        let mut path = PathBuf::new();
        for part in root.join(file.replace('\\', "/")).components() {
            match part {
                std::path::Component::CurDir => {}
                std::path::Component::ParentDir => {
                    path.pop();
                }
                std::path::Component::Normal(name) if name.to_string_lossy().contains(':') => return None,
                other => path.push(other),
            }
        }
        // The root itself is accepted as Node accepts it (`path === root`); a reader then finds a folder, not a file, and refuses it
        // there (a download answers `not-a-file`), and a discard's `remove_file` cannot remove a folder.
        path.starts_with(&root).then_some(path)
    }

    /// The catalog from disk, a damaged file set aside.
    fn read_assets(&self) -> Result<Vec<Value>, MediaError> {
        Ok(read_state_at(&self.index_path(), has_array("assets"), self.now())?
            .and_then(|v| v.get("assets").and_then(Value::as_array).cloned())
            .unwrap_or_default())
    }

    /// `indexSignature`: only an absent file is missing; any other failure to look propagates.
    fn index_signature(&self) -> Result<IndexSignature, MediaError> {
        match mixdog_workspace::ident::stat_version(&self.index_path()) {
            Ok(version) => Ok(IndexSignature::File {
                mtime_ms: mixdog_workspace::ident::ms_from_ns(version.mtime_ns),
                ctime_ms: mixdog_workspace::ident::ms_from_ns(version.ctime_ns),
                size: version.size,
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(IndexSignature::Missing),
            Err(error) => Err(error.into()),
        }
    }

    /// `readIndex`: the cached catalog while `index.json` is unchanged, else a read of it.
    fn read_index(&self) -> Result<Arc<Vec<Value>>, MediaError> {
        let mut cache = self.index.lock().unwrap();
        let signature = self.index_signature()?;
        if cache.signature.as_ref() == Some(&signature) {
            cache.hits += 1;
            return Ok(cache.assets.clone());
        }
        let assets = Arc::new(self.read_assets()?);
        if signature != IndexSignature::Missing {
            cache.disk_reads += 1;
        }
        cache.signature = Some(signature);
        cache.assets = assets.clone();
        Ok(assets)
    }

    /// `mediaStoreCacheStats`.
    #[cfg(test)]
    pub(crate) fn cache_stats(&self) -> Value {
        let cache = self.index.lock().unwrap();
        json!({"indexDiskReads": cache.disk_reads, "indexCacheHits": cache.hits, "indexEntries": cache.assets.len()})
    }

    fn write_assets(&self, assets: &[Value]) -> Result<(), MediaError> {
        write_atomic_stepped(&self.index_path(), &serde_json::to_vec(&json!({"version": 2, "assets": assets}))?, true).map_err(MediaError::Fs)
    }

    /// The one catalog read-modify-write (`mutateIndex`); `mutate` returning `None` writes nothing.
    /// The catalog is read through the cache first (which sets a damaged one aside), then afresh
    /// under `index.json.lock` for the change, as `updateJsonAtomicSync` reads it
    /// (`atomic-file.mjs:668-679`): a save that read the catalog before another's write, in this
    /// process or another, still changes the catalog that write left. What was written becomes
    /// the cached catalog, and a failed write leaves the cache as it was.
    fn mutate_assets<T>(&self, mutate: impl FnOnce(Vec<Value>) -> (Option<Vec<Value>>, T)) -> Result<T, MediaError> {
        self.read_index()?;
        let _held = file_lock(&self.index_path())?;
        let current = self.read_assets()?;
        #[cfg(test)]
        {
            let hook = self.holding_index.lock().unwrap().clone();
            if let Some(hook) = hook {
                hook();
            }
        }
        let (next, out) = mutate(current);
        if let Some(next) = next {
            self.write_assets(&next)?;
            let mut cache = self.index.lock().unwrap();
            cache.signature = Some(self.index_signature()?);
            cache.assets = Arc::new(next);
        }
        Ok(out)
    }

    fn read_boards(&self) -> Result<Vec<Value>, MediaError> {
        Ok(read_state_at(&self.boards_path(), has_array("boards"), self.now())?
            .and_then(|v| v.get("boards").and_then(Value::as_array).cloned())
            .unwrap_or_default())
    }

    /// `mutateBoards`: the boards' read-modify-write under `boards.json.lock`.
    fn mutate_boards<T>(&self, mutate: impl FnOnce(Vec<Value>) -> (Option<Vec<Value>>, T)) -> Result<T, MediaError> {
        let _held = file_lock(&self.boards_path())?;
        let (next, out) = mutate(self.read_boards()?);
        if let Some(next) = next {
            write_atomic_stepped(&self.boards_path(), &serde_json::to_vec(&json!({"version": 1, "boards": next}))?, true).map_err(MediaError::Fs)?;
        }
        Ok(out)
    }

    /// Persists one generated artifact and returns its index entry.
    pub fn save_asset(&self, kind: &str, lane: &str, model: &str, prompt: &str, options: Value, mime: &str, bytes: &[u8], meta: Map<String, Value>) -> Result<Value, MediaError> {
        self.ensure_dirs()?;
        self.migrate_asset_layout()?;
        let now = self.now();
        let mut entry = json!({
            "id": (self.marks.id)(),
            "kind": kind, "lane": lane, "model": model,
            "prompt": mixdog_js::slice_utf16(prompt, 4000),
            "options": options, "mime": mime, "bytes": bytes.len(), "createdAt": now,
        });
        for (k, v) in meta {
            entry[k] = v;
        }
        let file = organized_asset_file(&entry, now);
        let path = self.stored_asset_path(&file).ok_or_else(|| invalid("invalid media asset path"))?;
        // Durable before the index names it.
        write_atomic(&path, bytes, false)?;
        mixdog_workspace::killpoint::hit("media-save:before-index");
        entry["file"] = json!(file);
        let saved = entry.clone();
        self.mutate_assets(|mut assets| {
            assets.insert(0, entry);
            (Some(assets), ())
        })?;
        Ok(saved)
    }

    pub fn list_assets(&self, limit: Option<f64>, offset: Option<f64>, kind: Option<&str>, board_id: &str) -> Result<Value, MediaError> {
        self.ensure_dirs()?;
        let assets = self.read_index()?;
        let all: Vec<&Value> =
            assets.iter().filter(|e| kind.is_none_or(|k| str_field(e, "kind") == k) && (board_id.is_empty() || str_field(e, "boardId") == board_id)).collect();
        let start = offset.filter(|v| v.is_finite()).map_or(0, |v| v.trunc().max(0.0) as usize);
        let count = limit.filter(|v| v.is_finite() && *v != 0.0).map_or(60, |v| v.trunc().clamp(1.0, 200.0) as usize);
        let page: Vec<Value> = all.iter().skip(start).take(count).map(|e| (*e).clone()).collect();
        Ok(json!({"total": all.len(), "assets": page}))
    }

    pub(crate) fn get_asset(&self, id: &str) -> Result<Option<Value>, MediaError> {
        self.ensure_dirs()?;
        Ok(self.read_index()?.iter().find(|e| str_field(e, "id") == id).cloned())
    }

    /// Derived tile/detail renditions: a rebuildable cache beside the assets, never inside them.
    pub fn renditions_dir(&self) -> PathBuf {
        self.dir.join("renditions")
    }

    /// Persists a duration probed while building a rendition, so the gallery badge survives a
    /// restart. Nothing is written for no duration or one the row already has.
    pub fn remember_duration(&self, id: &str, seconds: i64) -> Result<(), MediaError> {
        if seconds == 0 {
            return Ok(());
        }
        self.mutate_assets(|assets| {
            let Some(row) = assets.iter().find(|e| str_field(e, "id") == id) else { return (None, ()) };
            if row.get("durationSeconds").and_then(Value::as_f64) == Some(seconds as f64) {
                return (None, ());
            }
            let next = assets
                .iter()
                .map(|e| {
                    let mut e = e.clone();
                    if str_field(&e, "id") == id {
                        e["durationSeconds"] = json!(seconds);
                    }
                    e
                })
                .collect();
            (Some(next), ())
        })
    }

    /// Base64 of a file for the inline path; larger files belong on the file route.
    #[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
    pub fn inline_base64(path: &Path) -> Result<String, MediaError> {
        use base64::Engine;
        if fs::metadata(path)?.len() > MAX_INLINE_BYTES {
            return Err(MediaError::TooLarge);
        }
        Ok(base64::engine::general_purpose::STANDARD.encode(fs::read(path)?))
    }

    /// The asset's original as a file. `None` when unknown or its bytes are gone.
    #[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
    pub fn resolve_file(&self, id: &str) -> Result<Option<Value>, MediaError> {
        Ok(match self.locate_file(id)? {
            Some(Located::Readable(entry)) => Some(entry),
            Some(Located::Special(_)) | None => None,
        })
    }

    /// [`resolve_file`](Self::resolve_file) that says why a file that exists is not served: a FIFO,
    /// device or socket behind an asset name would hang the reader, so it is reported, never opened.
    #[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
    pub fn locate_file(&self, id: &str) -> Result<Option<Located>, MediaError> {
        let Some(mut entry) = self.get_asset(id)? else { return Ok(None) };
        let Some(path) = self.stored_asset_path(str_field(&entry, "file")) else { return Ok(None) };
        let Ok(meta) = fs::metadata(&path) else { return Ok(None) };
        entry["variant"] = json!("original");
        entry["path"] = json!(path.to_string_lossy());
        entry["available"] = json!(true);
        Ok(Some(if mixdog_js::device_paths::is_special_file(&meta) { Located::Special(entry) } else { Located::Readable(entry) }))
    }

    /// Base64 for the inline path; larger files belong on the file route.
    #[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
    pub fn read_asset(&self, id: &str) -> Result<Option<Value>, MediaError> {
        let Some(mut file) = self.resolve_file(id)? else { return Ok(None) };
        file["base64"] = json!(Self::inline_base64(Path::new(str_field(&file, "path")))?);
        Ok(Some(file))
    }

    #[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
    pub fn asset_path(&self, id: &str) -> Result<Option<PathBuf>, MediaError> {
        Ok(self.get_asset(id)?.and_then(|e| self.stored_asset_path(str_field(&e, "file"))).filter(|p| p.exists()))
    }

    #[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
    pub fn assets_root(&self) -> PathBuf {
        let _ = fs::create_dir_all(self.assets_dir());
        self.assets_dir()
    }

    pub fn delete_asset(&self, id: &str) -> Result<Value, MediaError> {
        self.ensure_dirs()?;
        let removed = self.mutate_assets(|assets| match assets.iter().find(|e| str_field(e, "id") == id) {
            None => (None, false),
            Some(entry) => {
                self.discard(entry);
                (Some(assets.iter().filter(|e| str_field(e, "id") != id).cloned().collect()), true)
            }
        })?;
        Ok(json!({"id": id, "removed": removed}))
    }

    #[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
    fn discard(&self, entry: &Value) {
        if let Some(path) = self.stored_asset_path(str_field(entry, "file")) {
            let _ = fs::remove_file(path);
        }
        super::renditions::remove_renditions(&self.renditions_dir(), str_field(entry, "id"));
    }

    /// Bulk cleanup. Filters AND together; one selector (ids, before, missing, all) is required
    /// so an empty request can never wipe the gallery. `dry_run` answers the matching ids.
    #[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
    pub fn delete_assets(&self, p: &Value) -> Result<Value, MediaError> {
        let ids: Option<Vec<String>> = p.get("ids").and_then(Value::as_array).map(|a| a.iter().map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_owned)).collect());
        let before = p.get("before").and_then(Value::as_f64).filter(|v| v.is_finite() && *v > 0.0);
        let flag = |k: &str| p.get(k).and_then(Value::as_bool).unwrap_or(false);
        let (missing, all, dry_run) = (flag("missing"), flag("all"), flag("dryRun"));
        if ids.is_none() && before.is_none() && !missing && !all {
            return Err(invalid("deleteMediaAssets needs ids, before, missing, or all"));
        }
        self.ensure_dirs()?;
        let kind = p.get("kind").and_then(Value::as_str).filter(|k| !k.is_empty());
        let board = p.get("boardId").and_then(Value::as_str).unwrap_or("");
        let matches = |e: &Value| {
            kind.is_none_or(|k| str_field(e, "kind") == k)
                && (board.is_empty() || str_field(e, "boardId") == board)
                && ids.as_ref().is_none_or(|ids| ids.iter().any(|i| i == str_field(e, "id")))
                && before.is_none_or(|b| (e.get("createdAt").and_then(Value::as_f64).unwrap_or(0.0)) < b)
                && (!missing || self.stored_asset_path(str_field(e, "file")).is_none_or(|p| !p.exists()))
        };
        if dry_run {
            let ids: Vec<String> = self.read_index()?.iter().filter(|e| matches(e)).map(|e| str_field(e, "id").to_owned()).collect();
            return Ok(json!({"ids": ids}));
        }
        let removed = self.mutate_assets(|assets| {
            let doomed: Vec<&Value> = assets.iter().filter(|e| matches(e)).collect();
            if doomed.is_empty() {
                return (None, Vec::new());
            }
            doomed.iter().for_each(|e| self.discard(e));
            let gone: Vec<String> = doomed.iter().map(|e| str_field(e, "id").to_owned()).collect();
            let keep = assets.iter().filter(|e| !gone.iter().any(|g| g == str_field(e, "id"))).cloned().collect();
            (Some(keep), gone)
        })?;
        Ok(json!({"ids": removed}))
    }

    // ---- Boards: membership is the asset entry's `boardId`.

    pub fn list_boards(&self) -> Result<Value, MediaError> {
        self.ensure_dirs()?;
        let assets = self.read_index()?;
        let mut boards = self.read_boards()?;
        boards.sort_by(|a, b| b.get("createdAt").and_then(Value::as_f64).partial_cmp(&a.get("createdAt").and_then(Value::as_f64)).unwrap_or(std::cmp::Ordering::Equal));
        let rows: Vec<Value> = boards
            .iter()
            .map(|b| {
                let id = str_field(b, "id");
                json!({"id": id, "name": b.get("name"), "createdAt": b.get("createdAt"),
                       "count": assets.iter().filter(|e| str_field(e, "boardId") == id).count()})
            })
            .collect();
        Ok(json!({"total": assets.len(), "boards": rows}))
    }

    fn board_name(name: Option<&Value>) -> Result<String, MediaError> {
        let name = name.and_then(Value::as_str).ok_or_else(|| invalid("board name must be a string"))?;
        let text = mixdog_js::slice_utf16(&mixdog_js::js_words(name).collect::<Vec<_>>().join(" "), 120);
        let text = mixdog_js::js_trim(&text).to_owned();
        if text.is_empty() { Err(invalid("board name is required")) } else { Ok(text) }
    }

    fn board_id(id: Option<&Value>) -> Result<&str, MediaError> {
        id.and_then(Value::as_str).filter(|s| !s.is_empty() && s.len() <= 128).ok_or_else(|| invalid("board id must be a string"))
    }

    pub fn create_board(&self, name: Option<&Value>) -> Result<Value, MediaError> {
        // `{ id: randomUUID(), name: boardName(name), createdAt: Date.now() }`: the id is drawn before the name is judged.
        let board = json!({"id": (self.marks.id)(), "name": Self::board_name(name)?, "createdAt": self.now()});
        let saved = board.clone();
        self.mutate_boards(|mut boards| {
            boards.insert(0, board);
            (Some(boards), ())
        })?;
        Ok(saved)
    }

    pub fn rename_board(&self, id: Option<&Value>, name: Option<&Value>) -> Result<Value, MediaError> {
        let id = Self::board_id(id)?;
        let name = Self::board_name(name)?;
        self.mutate_boards(|boards| match boards.iter().position(|b| str_field(b, "id") == id) {
            None => (None, Err(MediaError::BoardNotFound)),
            Some(i) => {
                let mut next = boards;
                next[i]["name"] = json!(name);
                let renamed = next[i].clone();
                (Some(next), Ok(renamed))
            }
        })?
    }

    /// Deletes the board only; its results stay in the catalog without a board.
    pub fn delete_board(&self, id: Option<&Value>) -> Result<Value, MediaError> {
        let id = Self::board_id(id)?;
        let removed = self.mutate_boards(|boards| {
            if boards.iter().any(|b| str_field(b, "id") == id) {
                (Some(boards.into_iter().filter(|b| str_field(b, "id") != id).collect()), true)
            } else {
                (None, false)
            }
        })?;
        self.mutate_assets(|assets| {
            if !assets.iter().any(|e| str_field(e, "boardId") == id) {
                return (None, ());
            }
            let next = assets
                .into_iter()
                .map(|mut e| {
                    if str_field(&e, "boardId") == id {
                        e.as_object_mut().map(|o| o.shift_remove("boardId"));
                    }
                    e
                })
                .collect();
            (Some(next), ())
        })?;
        Ok(json!({"id": id, "removed": removed}))
    }

    /// Moves results into a board; `null` takes them out of any board.
    pub fn set_asset_board(&self, ids: &Value, board: &Value) -> Result<Value, MediaError> {
        let list: Vec<String> = match ids {
            Value::Array(a) => a.iter().map(|v| v.as_str().filter(|s| !s.is_empty()).map(str::to_owned).ok_or_else(|| invalid("asset ids must be strings"))).collect::<Result<_, _>>()?,
            Value::String(s) if !s.is_empty() => vec![s.clone()],
            _ => return Err(invalid("asset ids must be strings")),
        };
        let target = if board.is_null() { String::new() } else { Self::board_id(Some(board))?.to_owned() };
        if !target.is_empty() && !self.read_boards()?.iter().any(|b| str_field(b, "id") == target) {
            return Err(MediaError::BoardNotFound);
        }
        self.ensure_dirs()?;
        let moved = self.mutate_assets(|assets| {
            let mut moved = Vec::new();
            let next: Vec<Value> = assets
                .into_iter()
                .map(|mut e| {
                    if !list.iter().any(|i| i == str_field(&e, "id")) || str_field(&e, "boardId") == target {
                        return e;
                    }
                    moved.push(str_field(&e, "id").to_owned());
                    if target.is_empty() {
                        e.as_object_mut().map(|o| o.shift_remove("boardId"));
                    } else {
                        e["boardId"] = json!(target);
                    }
                    e
                })
                .collect();
            if moved.is_empty() { (None, moved) } else { (Some(next), moved) }
        })?;
        Ok(json!({"ids": moved, "boardId": target}))
    }

    // ---- Remembered selection and user pins (`defaults.json`).

    #[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
    fn read_defaults(&self) -> Map<String, Value> {
        fs::read(self.defaults_path())
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .and_then(|v| if let Value::Object(o) = v { Some(o) } else { None })
            .unwrap_or_default()
    }

    fn write_defaults(&self, all: Map<String, Value>) -> Result<(), MediaError> {
        write_atomic(&self.defaults_path(), &serde_json::to_vec(&Value::Object(all))?, false)?;
        Ok(())
    }

    fn kind_key(kind: Option<&Value>) -> Result<String, MediaError> {
        let key = text_of(kind);
        if MEDIA_KINDS.contains(&key.as_str()) { Ok(key) } else { Err(invalid("kind must be one of image, video")) }
    }

    pub fn get_default(&self, kind: Option<&Value>) -> Value {
        let key = text_of(kind);
        if !MEDIA_KINDS.contains(&key.as_str()) {
            return Value::Null;
        }
        let all = self.read_defaults();
        let row = all.get(&key);
        let lane = text_of(row.and_then(|r| r.get("lane")));
        if lane.is_empty() { Value::Null } else { json!({"kind": key, "lane": lane, "model": text_of(row.and_then(|r| r.get("model")))}) }
    }

    pub fn set_default(&self, p: &Value) -> Result<Value, MediaError> {
        let key = Self::kind_key(p.get("kind"))?;
        let lane = text_of(p.get("lane"));
        if lane.is_empty() {
            return Err(invalid("lane is required"));
        }
        let model = text_of(p.get("model"));
        let _guard = self.lock.lock().unwrap();
        let mut all = self.read_defaults();
        all.insert(key.clone(), json!({"lane": lane, "model": model, "updatedAt": now_ms()}));
        self.write_defaults(all)?;
        Ok(json!({"kind": key, "lane": lane, "model": model}))
    }

    fn pin_of(&self, key: &str) -> Value {
        let all = self.read_defaults();
        let row = all.get(PINNED).and_then(|p| p.get(key));
        let lane = text_of(row.and_then(|r| r.get("lane")));
        if lane.is_empty() {
            Value::Null
        } else {
            json!({"kind": key, "lane": lane, "model": text_of(row.and_then(|r| r.get("model"))), "account": text_of(row.and_then(|r| r.get("account")))})
        }
    }

    pub fn get_pins(&self) -> Value {
        Value::Object(MEDIA_KINDS.iter().map(|k| ((*k).to_owned(), self.pin_of(k))).collect())
    }

    /// Pins one kind; an empty `lane` returns it to auto.
    pub fn set_pin(&self, p: &Value) -> Result<Value, MediaError> {
        let key = Self::kind_key(p.get("kind"))?;
        let lane = text_of(p.get("lane"));
        let _guard = self.lock.lock().unwrap();
        let mut all = self.read_defaults();
        let mut pins = all.get(PINNED).and_then(Value::as_object).cloned().unwrap_or_default();
        pins.shift_remove(&key);
        if !lane.is_empty() {
            pins.insert(key.clone(), json!({"lane": lane, "model": text_of(p.get("model")), "account": text_of(p.get("account"))}));
        }
        all.insert(PINNED.to_owned(), Value::Object(pins));
        self.write_defaults(all)?;
        Ok(self.pin_of(&key))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, MediaStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = MediaStore::new(dir.path(), mixdog_rt::testing::tokens().durability_io);
        (dir, store)
    }

    fn save(store: &MediaStore, kind: &str) -> Value {
        store.save_asset(kind, "gemini", "m/1", "p", json!({}), if kind == "video" { "video/mp4" } else { "image/png" }, b"bytes", Map::new()).unwrap()
    }

    /// Node's catalog with a prompt cut at 4000 units and a board name cut at 120, each inside an emoji
    /// (`native/core/fixtures/lone-surrogate-files`, record-lone-surrogate-files.mjs): read whole, and the next writes keep
    /// every entry and field Node's own next writes keep.
    #[test]
    fn a_catalog_node_cut_inside_an_emoji_is_read_whole_and_written_back_whole() {
        let set = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/lone-surrogate-files");
        let cases: Value = serde_json::from_slice(&fs::read(set.join("cases.json")).unwrap()).unwrap();
        let case = cases.as_array().unwrap().iter().find(|c| c["name"] == "media-store").unwrap();
        let (dir, s) = store();
        let media = dir.path().join("media");
        fs::create_dir_all(&media).unwrap();
        for file in ["index.json", "boards.json"] {
            fs::copy(set.join("media-store/before").join(file), media.join(file)).unwrap();
        }
        let asset_id = case["assetId"].as_str().unwrap();
        assert_eq!(s.get_asset(asset_id).unwrap().unwrap(), case["before"]["index.json"]["assets"][0]);
        assert_eq!(s.list_boards().unwrap(), case["nodeRead"]["boards"]);
        let op = &case["op"];
        s.set_asset_board(&op["setAssetBoard"][0], &op["setAssetBoard"][1]).unwrap();
        s.rename_board(Some(&op["renameBoard"][0]), Some(&op["renameBoard"][1])).unwrap();
        for file in ["index.json", "boards.json"] {
            let written: Value = serde_json::from_slice(&fs::read(media.join(file)).unwrap()).unwrap();
            // As text: entry and key order count too.
            assert_eq!(written.to_string(), case["after"][file].to_string(), "{file}");
        }
    }

    #[test]
    fn assets_are_organized_listed_newest_first_and_deleted_with_their_file() {
        let (_d, s) = store();
        let a = save(&s, "image");
        let b = save(&s, "video");
        assert!(str_field(&a, "file").starts_with("images/gemini/m-1/"));
        assert!(str_field(&b, "file").ends_with(".mp4"));
        let page = s.list_assets(None, None, None, "").unwrap();
        assert_eq!(page["total"], 2);
        assert_eq!(page["assets"][0]["id"], b["id"]);
        assert_eq!(s.list_assets(None, None, Some("image"), "").unwrap()["total"], 1);
        let path = s.asset_path(str_field(&a, "id")).unwrap().unwrap();
        assert_eq!(s.delete_asset(str_field(&a, "id")).unwrap()["removed"], true);
        assert!(!path.exists());
        assert_eq!(s.delete_asset("nope").unwrap()["removed"], false);
    }

    #[test]
    fn a_file_is_readable_gone_or_special_and_only_the_readable_one_resolves() {
        let (_d, s) = store();
        let a = save(&s, "image");
        let id = str_field(&a, "id");
        assert!(matches!(s.locate_file(id).unwrap(), Some(Located::Readable(_))));
        assert!(s.resolve_file(id).unwrap().is_some());
        assert!(s.locate_file("missing").unwrap().is_none());
        let path = s.asset_path(id).unwrap().unwrap();
        std::fs::remove_file(&path).unwrap();
        assert!(s.locate_file(id).unwrap().is_none() && s.resolve_file(id).unwrap().is_none());
        // A FIFO behind the asset's name: located, so the caller can say why, and never resolved.
        #[cfg(unix)]
        {
            let c = std::ffi::CString::new(path.to_string_lossy().as_bytes()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
            assert!(matches!(s.locate_file(id).unwrap(), Some(Located::Special(_))));
            assert!(s.resolve_file(id).unwrap().is_none());
        }
    }

    #[test]
    fn inline_read_returns_base64_and_unknown_ids_are_none() {
        let (_d, s) = store();
        let a = save(&s, "image");
        let read = s.read_asset(str_field(&a, "id")).unwrap().unwrap();
        assert_eq!(read["base64"], "Ynl0ZXM=");
        assert!(s.read_asset("missing").unwrap().is_none());
    }

    #[test]
    fn bulk_delete_needs_a_selector_and_dry_run_deletes_nothing() {
        let (_d, s) = store();
        let a = save(&s, "image");
        save(&s, "video");
        assert!(s.delete_assets(&json!({})).is_err());
        assert_eq!(s.delete_assets(&json!({"kind": "image"})).is_err(), true);
        let dry = s.delete_assets(&json!({"all": true, "kind": "image", "dryRun": true})).unwrap();
        assert_eq!(dry["ids"], json!([a["id"]]));
        assert_eq!(s.list_assets(None, None, None, "").unwrap()["total"], 2);
        assert_eq!(s.delete_assets(&json!({"all": true, "kind": "image"})).unwrap()["ids"], json!([a["id"]]));
        assert_eq!(s.list_assets(None, None, None, "").unwrap()["total"], 1);
    }

    #[test]
    fn boards_group_results_and_deleting_one_keeps_them() {
        let (_d, s) = store();
        let a = save(&s, "image");
        let id = str_field(&a, "id").to_owned();
        let board = s.create_board(Some(&json!("  My   board "))).unwrap();
        assert_eq!(board["name"], "My board");
        let bid = board["id"].clone();
        assert_eq!(s.set_asset_board(&json!([id]), &bid).unwrap()["ids"], json!([id]));
        assert_eq!(s.list_boards().unwrap()["boards"][0]["count"], 1);
        assert_eq!(s.list_assets(None, None, None, bid.as_str().unwrap()).unwrap()["total"], 1);
        assert_eq!(s.rename_board(Some(&bid), Some(&json!("Z"))).unwrap()["name"], "Z");
        assert!(matches!(s.set_asset_board(&json!([id]), &json!("nope")), Err(MediaError::BoardNotFound)));
        assert_eq!(s.delete_board(Some(&bid)).unwrap()["removed"], true);
        let page = s.list_assets(None, None, None, "").unwrap();
        assert_eq!(page["total"], 1);
        assert!(page["assets"][0].get("boardId").is_none());
        assert!(s.create_board(Some(&json!("   "))).is_err());
    }

    #[test]
    fn defaults_and_pins_round_trip_independently() {
        let (_d, s) = store();
        assert_eq!(s.get_default(Some(&json!("image"))), Value::Null);
        s.set_default(&json!({"kind": "image", "lane": "gemini", "model": "m"})).unwrap();
        s.set_pin(&json!({"kind": "video", "lane": "xai", "account": "a"})).unwrap();
        assert_eq!(s.get_default(Some(&json!("image")))["lane"], "gemini");
        assert_eq!(s.get_pins()["video"]["account"], "a");
        assert_eq!(s.get_pins()["image"], Value::Null);
        s.set_pin(&json!({"kind": "video", "lane": ""})).unwrap();
        assert_eq!(s.get_pins()["video"], Value::Null);
        assert_eq!(s.get_default(Some(&json!("image")))["model"], "m");
        assert!(s.set_default(&json!({"kind": "audio", "lane": "x"})).is_err());
    }

    #[test]
    fn a_damaged_index_is_set_aside_and_the_backup_restored() {
        let (_d, s) = store();
        save(&s, "image");
        save(&s, "image");
        fs::write(s.index_path(), b"\0\0\0").unwrap();
        assert_eq!(s.list_assets(None, None, None, "").unwrap()["total"], 1);
        assert!(fs::read_dir(&s.dir).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().contains(".corrupt-")));
    }

    fn files_under(dir: &Path) -> Vec<PathBuf> {
        let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
        entries
            .flat_map(|entry| {
                let path = entry.unwrap().path();
                if path.is_dir() { files_under(&path) } else { vec![path] }
            })
            .collect()
    }

    /// An edit from outside that keeps the size and the mtime still changes the change time, which
    /// `indexSignature` includes: the next read sees it.
    #[test]
    fn an_outside_rewrite_of_the_same_size_with_the_mtime_restored_is_seen() {
        let (_d, s) = store();
        let a = save(&s, "image");
        assert_eq!(s.list_assets(None, None, None, "").unwrap()["assets"][0]["prompt"], "p");
        let path = s.index_path();
        let before = mixdog_workspace::ident::stat_version(&path).unwrap();
        let mtime = fs::metadata(&path).unwrap().modified().unwrap();
        let edited = String::from_utf8(fs::read(&path).unwrap()).unwrap().replace("\"prompt\":\"p\"", "\"prompt\":\"q\"");
        // File times tick: the edit is repeated until it lands in a later tick than the cached
        // read, as an outside editor's would; a change time that never moves fails the test.
        const REWRITES: usize = 100;
        let moved = (0..REWRITES).any(|_| {
            fs::write(&path, &edited).unwrap();
            fs::OpenOptions::new().write(true).open(&path).unwrap().set_modified(mtime).unwrap();
            let after = mixdog_workspace::ident::stat_version(&path).unwrap();
            assert_eq!((after.size, after.mtime_ns), (before.size, before.mtime_ns), "same size, mtime restored");
            after.ctime_ns != before.ctime_ns
        });
        assert!(moved, "the change time of index.json did not move in {REWRITES} rewrites");
        let listed = s.list_assets(None, None, None, "").unwrap();
        assert_eq!((listed["assets"][0]["id"].clone(), listed["assets"][0]["prompt"].clone()), (a["id"].clone(), json!("q")));
    }

    /// How long a child test process may run.
    const CHILD_DEADLINE: std::time::Duration = std::time::Duration::from_secs(60);

    /// Runs this binary's test `name` alone in a child process with `env` and returns its output;
    /// a child still running at [`CHILD_DEADLINE`] is killed and the test fails.
    fn child(name: &str, env: &[(&str, &std::ffi::OsStr)]) -> std::process::Output {
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", name, "--nocapture", "--test-threads=1"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        for (key, value) in env {
            command.env(key, value);
        }
        let running = command.spawn().unwrap();
        let pid = running.id();
        let (done, waited) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = done.send(running.wait_with_output());
        });
        match waited.recv_timeout(CHILD_DEADLINE) {
            Ok(output) => output.unwrap(),
            Err(_) => {
                #[cfg(windows)]
                let killed = std::process::Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).output();
                #[cfg(unix)]
                let killed = std::process::Command::new("kill").args(["-9", &pid.to_string()]).output();
                panic!("timed out after {CHILD_DEADLINE:?} awaiting the child test {name} (pid {pid}, killed: {:?})", killed.map(|o| o.status));
            }
        }
    }

    /// The child of the kill test: a save over the parent's folder, aborted at the kill point
    /// between the asset and the index (`MIXDOG_KILL_AT`).
    #[test]
    fn kill_child() {
        let Ok(dir) = std::env::var("MIXDOG_MEDIA_KILL_DIR") else { return };
        let s = MediaStore::new(Path::new(&dir), mixdog_rt::testing::tokens().durability_io);
        save(&s, "video");
        unreachable!("the save is killed before its index");
    }

    /// The child of the two-process test: one save over the parent's folder, its outcome printed
    /// as `save-result <json>`.
    #[test]
    fn save_child() {
        let Ok(dir) = std::env::var("MIXDOG_MEDIA_SAVE_DIR") else { return };
        let s = MediaStore::new(Path::new(&dir), mixdog_rt::testing::tokens().durability_io);
        let saved = s.save_asset("image", "gemini", "m/1", "p", json!({}), "image/png", b"bytes", Map::new());
        let outcome = match saved {
            Ok(entry) => json!({"id": entry["id"]}),
            Err(error) => json!({"error": error.to_string()}),
        };
        println!("save-result {outcome}");
    }

    /// One save in another process over `dir` (with `MIXDOG_LOCK_TIMEOUT_MS` when given): its
    /// `save-result`.
    fn save_in_another_process(dir: &Path, lock_timeout_ms: Option<&str>) -> Value {
        let mut env: Vec<(&str, &std::ffi::OsStr)> = vec![("MIXDOG_MEDIA_SAVE_DIR", dir.as_os_str())];
        if let Some(ms) = lock_timeout_ms {
            env.push(("MIXDOG_LOCK_TIMEOUT_MS", std::ffi::OsStr::new(ms)));
        }
        let output = child("media::store::tests::save_child", &env);
        let stdout = String::from_utf8_lossy(&output.stdout);
        // libtest prints the test's name and then, on the same line, what the test printed.
        let line = stdout.lines().find_map(|line| line.split_once("save-result ").map(|(_, result)| result)).unwrap_or_else(|| {
            panic!("the child printed no save-result (status {:?}):\n{stdout}\n{}", output.status, String::from_utf8_lossy(&output.stderr))
        });
        serde_json::from_str(line).unwrap()
    }

    /// A process killed after the asset is written and before the index names it leaves what Node's
    /// `saveMediaAsset` leaves: the asset's file, listed nowhere, and the index as it was, readable.
    #[test]
    fn a_save_killed_before_the_index_leaves_an_orphan_file_and_the_index_intact() {
        let (dir, s) = store();
        let kept = save(&s, "image");
        let index = fs::read(s.index_path()).unwrap();
        let output = child(
            "media::store::tests::kill_child",
            &[("MIXDOG_MEDIA_KILL_DIR", dir.path().as_os_str()), ("MIXDOG_KILL_AT", std::ffi::OsStr::new("media-save:before-index"))],
        );
        assert!(!output.status.success(), "the child dies at the kill point");
        assert_eq!(fs::read(s.index_path()).unwrap(), index, "the index is untouched");
        let orphans = files_under(&s.assets_dir().join("videos"));
        assert_eq!(orphans.len(), 1, "the asset's bytes are on disk: {orphans:?}");
        assert_eq!(fs::read(&orphans[0]).unwrap(), b"bytes");
        // The next process reads the index whole; the orphan is not in it.
        let next = MediaStore::new(dir.path(), mixdog_rt::testing::tokens().durability_io);
        assert_eq!(next.list_assets(None, None, None, "").unwrap(), json!({"total": 1, "assets": [kept]}));
        assert!(!fs::read_dir(&next.dir).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().contains(".corrupt-")), "nothing was set aside");
    }

    /// A save in another process while this one holds `index.json.lock` between its read of the
    /// catalog and its write: told to try the lock once (`MIXDOG_LOCK_TIMEOUT_MS=0`), it is
    /// refused, so it never writes a catalog this one then overwrites (a save answered done and
    /// lost). With the lock free, the same save waits its turn, and all three are in the catalog.
    #[test]
    fn a_save_in_another_process_cannot_write_the_index_this_one_is_changing() {
        let (dir, s) = store();
        let first = save(&s, "image");
        let during = Arc::new(Mutex::new(None));
        *s.holding_index.lock().unwrap() = Some(Arc::new({
            let (during, dir) = (during.clone(), dir.path().to_owned());
            move || {
                *during.lock().unwrap() = Some(save_in_another_process(&dir, Some("0")));
            }
        }));
        let second = save(&s, "video");
        *s.holding_index.lock().unwrap() = None;
        let during = during.lock().unwrap().take().expect("the other process saved while the lock was held");
        assert!(during["error"].as_str().is_some_and(|error| error.contains("atomic lock contended")), "the other process's save: {during}");
        let after = save_in_another_process(dir.path(), None);
        let id = |entry: &Value| str_field(entry, "id").to_owned();
        let listed: Vec<String> = s.list_assets(None, None, None, "").unwrap()["assets"].as_array().unwrap().iter().map(id).collect();
        assert_eq!(listed, [id(&after), id(&second), id(&first)]);
    }

    /// Two stores over one folder (the daemon has two, `compose_domains/local.rs:209` and
    /// `compose_flip.rs:2434`) saving on two threads at once: both entries are in the catalog.
    /// It does not force an interleaving; the exclusion itself is shown across processes above.
    #[test]
    fn two_stores_over_one_folder_saving_at_once_keep_both() {
        let (dir, s) = store();
        save(&s, "image");
        let first = s.list_assets(None, None, None, "").unwrap()["assets"][0].clone();
        let other = MediaStore::new(dir.path(), mixdog_rt::testing::tokens().durability_io);
        let (a, b) = std::thread::scope(|scope| {
            let a = scope.spawn(|| save(&s, "image"));
            let b = scope.spawn(|| save(&other, "video"));
            (a.join().unwrap(), b.join().unwrap())
        });
        let ids = |listed: Value| {
            let mut ids: Vec<String> = listed["assets"].as_array().unwrap().iter().map(|e| str_field(e, "id").to_owned()).collect();
            ids.sort();
            ids
        };
        let mut want = vec![str_field(&first, "id").to_owned(), str_field(&a, "id").to_owned(), str_field(&b, "id").to_owned()];
        want.sort();
        assert_eq!(ids(s.list_assets(None, None, None, "").unwrap()), want);
        let next = MediaStore::new(dir.path(), mixdog_rt::testing::tokens().durability_io);
        assert_eq!(ids(next.list_assets(None, None, None, "").unwrap()), want, "both are on disk");
    }

    #[test]
    fn asset_paths_cannot_leave_the_assets_root() {
        let (_d, s) = store();
        assert!(s.stored_asset_path("../index.json").is_none());
        assert!(s.stored_asset_path("C:/x").is_none());
        assert!(s.stored_asset_path("//server/share/a.png").is_none() && s.stored_asset_path("\\\\.\\PhysicalDrive0").is_none());
        assert!(s.stored_asset_path("images/a.png").is_some());
        // Node resolves the name lexically: a step out and back in names the same file, a step past the root is refused, and a root
        // name (`/a.png`) stands on its own, outside.
        assert_eq!(s.stored_asset_path("images/../a.png"), s.stored_asset_path("a.png"));
        assert!(s.stored_asset_path("images/../a.png").is_some());
        assert!(s.stored_asset_path("images/../../index.json").is_none());
        assert!(s.stored_asset_path("/a.png").is_none());
        assert_eq!(s.stored_asset_path(""), Some(s.assets_dir()), "an empty name is the root, as Node's `resolve(root, '')`");
    }
}
