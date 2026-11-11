#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "blocking file bodies run only as lane jobs (`on`) or on a stream's own producer thread (`streamed`); the service never calls them on an async thread")]
//! The real [`FileService`] (DS §4.2) for the agent tools and the tidy write host, over absolute
//! paths on the local disk.
//!
//! Writes are Node's `atomicWrite` (`atomic-write.mjs`): a `wx` temp file beside the target, fsync,
//! rename into place with the Windows retry ladder, directory fsync, write *through* a leaf symlink,
//! the target's mode kept. Batches are `apply_patch`'s rollback (`rollback-state.mjs`): a pre-image
//! of every path, an in-place restore on failure. Walks and text search are ripgrep's own
//! `ignore`/`grep` crates, which is what Node's resident search server runs. Their producers run
//! on threads of their own rather than as lane jobs: a producer waits whenever its consumer's
//! queue is full, mid-file included, and may sit in an OS call nothing can interrupt, neither of
//! which a pooled lane job may do (its lease, its slot); see [`Streamed`].
//!
//! Project text saves (`projectFs/writeText`) are not this service: they keep the in-place rewrite
//! and recovery journal of [`crate::fsops`].

use std::ffi::OsString;
use std::fs;
use std::fs::File;
use std::fs::OpenOptions;
use std::io;
use std::io::Read;
use std::io::Seek;
use std::io::SeekFrom;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::LazyLock;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::PoisonError;
use std::time::Duration;

use async_trait::async_trait;
use grep::matcher::Matcher;
use grep::regex::RegexMatcherBuilder;
use grep::searcher::BinaryDetection;
use grep::searcher::Searcher;
use grep::searcher::SearcherBuilder;
use grep::searcher::Sink;
use grep::searcher::SinkMatch;
use ignore::WalkBuilder;
use ignore::overrides::OverrideBuilder;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::common::EventSource;
use mixdog_core_api::domain::fs::DirEntry;
use mixdog_core_api::domain::fs::EntryKind;
use mixdog_core_api::domain::fs::FileBytes;
use mixdog_core_api::domain::fs::FileService;
use mixdog_core_api::domain::fs::FileStat;
use mixdog_core_api::domain::fs::FsError;
use mixdog_core_api::domain::fs::FsErrorKind;
use mixdog_core_api::domain::fs::FsStep;
use mixdog_core_api::domain::fs::ReadRange;
use mixdog_core_api::domain::fs::SearchMatch;
use mixdog_core_api::domain::fs::SearchRequest;
use mixdog_core_api::domain::fs::WalkRequest;
use mixdog_core_api::domain::fs::WritePrecondition;
use mixdog_core_api::domain::fs::WriteRequest;
use crate::ident::StatVersion;
use crate::ident::names_equal;
use crate::ident::stat_version;
use crate::ident::stat_with_version;
use crate::pathguard::canonical;
use crate::pathguard::lexical;
use crate::lanes::counted;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InteractiveIo;
use mixdog_rt::LaneToken;
use mixdog_rt::MaintenanceIo;
use std::sync::atomic::AtomicBool;
#[cfg(test)]
use std::sync::atomic::AtomicU64;
use std::sync::atomic::AtomicU8;
#[cfg(feature = "replay-controls")]
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Instant;
use tokio::sync::Notify;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

/// Node: `WINDOWS_RENAME_RETRY_BACKOFFS_MS`.
const RENAME_BACKOFFS_MS: [u64; 8] = [25, 50, 100, 200, 400, 800, 1200, 1600];
/// Windows `ERROR_SHARING_VIOLATION`, Node's `EBUSY`.
const SHARING_VIOLATION: i32 = 32;

/// The agent tools' file service. Stateless apart from the write locks: construct one and share it.
pub struct LocalFileService {
    locks: Arc<PathLocks>,
}

impl Default for LocalFileService {
    fn default() -> Self {
        Self::new()
    }
}

impl LocalFileService {
    pub fn new() -> Self {
        Self { locks: Arc::new(PathLocks::default()) }
    }
}

/// The files being written right now, one entry per resolved file, so writers of different files
/// never wait on each other (the mutex only guards this list; waiting is for the same file alone).
/// Across processes the version check before the rename is the guard (as in Node).
#[derive(Default)]
struct PathLocks {
    held: Mutex<Vec<LockKey>>,
    released: Condvar,
}

/// A file as the file system names it: its resolved directory and leaf name, with the directory's
/// own case rule. Two spellings of one file, or `foo` and `FOO` in a case-insensitive directory,
/// are the same key whether or not the file exists yet.
#[derive(Clone, Debug)]
struct LockKey {
    dir: PathBuf,
    leaf: OsString,
}

impl LockKey {
    fn same(&self, other: &Self) -> bool {
        // Node's key is the whole resolved path, lowercased on win32 only
        // (`path-locks.mjs:5-7`, `advisory-lock.mjs:47`).
        names_equal(self.dir.join(&self.leaf).as_os_str(), other.dir.join(&other.leaf).as_os_str())
    }
}

/// The locks of one operation; released on drop.
struct Held {
    locks: Arc<PathLocks>,
    keys: Vec<LockKey>,
}

impl PathLocks {
    /// Takes every key at once or waits: a batch holds nothing while it waits, so two batches cannot
    /// deadlock.
    fn acquire(self: &Arc<Self>, keys: impl IntoIterator<Item = LockKey>) -> Held {
        let mut unique: Vec<LockKey> = Vec::new();
        for key in keys {
            if !unique.iter().any(|k| k.same(&key)) {
                unique.push(key);
            }
        }
        let mut held = self.held.lock().unwrap_or_else(|e| e.into_inner());
        while unique.iter().any(|k| held.iter().any(|h| h.same(k))) {
            held = self.released.wait(held).unwrap_or_else(|e| e.into_inner());
        }
        held.extend(unique.iter().cloned());
        drop(held);
        Held { locks: self.clone(), keys: unique }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.held.lock().unwrap_or_else(|e| e.into_inner()).len()
    }
}

impl Drop for Held {
    fn drop(&mut self) {
        let mut held = self.locks.held.lock().unwrap_or_else(|e| e.into_inner());
        held.retain(|h| !self.keys.iter().any(|k| k.same(h)));
        drop(held);
        self.locks.released.notify_all();
    }
}

/// Where a write lands, resolved once: every step of the write (lock, precondition, temp file,
/// rename, restore) uses [`Resolved::path`], never the caller's spelling, so a link retargeted
/// after this point cannot redirect it.
#[derive(Debug)]
struct Resolved {
    path: PathBuf,
    key: LockKey,
}

/// Node: the write target is [`canonical_lock_target`]: resolved through junctions, symlinks (a
/// leaf symlink is written through) and `..`, names in the case the file system stores. A parent
/// that does not exist is kept as given, so the write fails with `NotFound` before it touches
/// anything.
fn resolve_write(path: &Path) -> Result<Resolved, FsError> {
    let full = canonical_lock_target(path);
    let (Some(dir), Some(leaf)) = (full.parent(), full.file_name()) else {
        return Ok(Resolved { path: full.clone(), key: LockKey { dir: full, leaf: OsString::new() } });
    };
    let (dir, leaf) = (dir.to_path_buf(), leaf.to_owned());
    Ok(Resolved { path: full, key: LockKey { dir, leaf } })
}

/// Node `canonicalLockTarget` (`advisory-lock.mjs:17`): the deepest existing component (the target
/// itself when present, so a leaf symlink shares its referent's lock) is resolved, and components
/// not created yet are appended as given.
fn canonical_lock_target(path: &Path) -> PathBuf {
    let resolved = lexical(path);
    let mut tail: Vec<OsString> = Vec::new();
    let mut dir = resolved.clone();
    loop {
        if let Ok(real) = canonical(&dir) {
            return tail.iter().rev().fold(real, |acc, part| acc.join(part));
        }
        let (Some(parent), Some(name)) = (dir.parent().map(Path::to_path_buf), dir.file_name().map(OsString::from)) else {
            return resolved;
        };
        tail.push(name);
        dir = parent;
    }
}

fn io_error(error: &io::Error, path: &Path) -> FsError {
    let kind = match error.kind() {
        io::ErrorKind::NotFound => FsErrorKind::NotFound,
        io::ErrorKind::PermissionDenied => FsErrorKind::PermissionDenied,
        io::ErrorKind::AlreadyExists => FsErrorKind::AlreadyExists,
        io::ErrorKind::NotADirectory => FsErrorKind::NotADirectory,
        io::ErrorKind::IsADirectory => FsErrorKind::IsADirectory,
        _ => FsErrorKind::Io { os_code: error.raw_os_error() },
    };
    FsError::new(kind, AbsPath::new(path))
}

fn plain(kind: FsErrorKind, path: &Path) -> FsError {
    FsError::new(kind, AbsPath::new(path))
}

fn entry_kind(file_type: fs::FileType) -> EntryKind {
    if file_type.is_symlink() {
        EntryKind::Symlink
    } else if file_type.is_dir() {
        EntryKind::Dir
    } else if file_type.is_file() {
        EntryKind::File
    } else {
        EntryKind::Special
    }
}

/// `fs.stat` of `path` (links followed). The change time, inode and device are `fileVersion`'s own
/// reading (`stat_version`), so the two never disagree.
fn stat_path(path: &Path) -> Result<FileStat, FsError> {
    let (meta, version) = stat_with_version(path).map_err(|e| io_error(&e, path))?;
    let ns = version.ctime_ns;
    let magnitude = std::time::Duration::from_nanos(u64::try_from(ns.unsigned_abs()).unwrap_or(u64::MAX));
    let ctime = if ns >= 0 { std::time::UNIX_EPOCH.checked_add(magnitude) } else { std::time::UNIX_EPOCH.checked_sub(magnitude) };
    Ok(FileStat {
        kind: entry_kind(meta.file_type()),
        len: meta.len(),
        modified: meta.modified().ok(),
        ctime,
        inode: version.ino,
        device: version.dev,
        readonly: meta.permissions().readonly(),
    })
}

/// Runs `job` on `lane`; dropping the future cancels a job that has not started.
async fn on<L, R, F>(lane: L, job: F) -> Result<R, FsError>
where
    L: LaneToken,
    R: Send + 'static,
    F: FnOnce() -> R + Send + 'static,
{
    let cancel = CancellationToken::new();
    let _guard = cancel.clone().drop_guard();
    let job = counted(job);
    let handle = lane.submit(&cancel, move |_| job()).map_err(|_| FsError::new(FsErrorKind::Io { os_code: None }, None))?;
    handle.await.map_err(|_| FsError::new(FsErrorKind::Io { os_code: None }, None))
}

enum Expect {
    Nothing,
    /// `wx`: the target must still be absent right before the rename.
    Absent,
    /// The target must still be this version (mtime, ctime, size, inode, device: Node's `fileVersion`).
    Version(StatVersion),
}

fn current_content(path: &Path) -> Result<Option<Vec<u8>>, FsError> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(io_error(&e, path)),
    }
}

fn precondition_failed(path: &Path) -> FsError {
    match current_content(path) {
        Ok(actual) => plain(FsErrorKind::PreconditionFailed { actual }, path),
        Err(e) => e,
    }
}

/// Checks the caller's compare-and-set condition and returns what must still hold at the rename.
fn evaluate(target: &Path, precondition: &WritePrecondition) -> Result<Expect, FsError> {
    let existing = match fs::metadata(target) {
        Ok(meta) => Some(meta),
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        Err(e) => return Err(io_error(&e, target)),
    };
    if let Some(meta) = &existing {
        if meta.is_dir() {
            return Err(plain(FsErrorKind::IsADirectory, target));
        }
        if !meta.is_file() {
            return Err(plain(FsErrorKind::Special, target));
        }
    }
    match (precondition, existing) {
        (WritePrecondition::Unconditional, _) => Ok(Expect::Nothing),
        (WritePrecondition::Absent, None) => Ok(Expect::Absent),
        (WritePrecondition::Absent, Some(_)) => Err(precondition_failed(target)),
        (WritePrecondition::ContentEquals(_), None) => Err(plain(FsErrorKind::PreconditionFailed { actual: None }, target)),
        (WritePrecondition::ContentEquals(expected), Some(_)) => {
            // Version first, content second: a change in between fails the check at the rename.
            let version = stat_version(target).map_err(|e| io_error(&e, target))?;
            let actual = fs::read(target).map_err(|e| io_error(&e, target))?;
            if &actual == expected {
                Ok(Expect::Version(version))
            } else {
                Err(plain(FsErrorKind::PreconditionFailed { actual: Some(actual) }, target))
            }
        }
    }
}

/// Node: `atomicWriteShouldFsync`; `MIXDOG_ATOMIC_FSYNC=0|false|no|off` opts out.
fn fsync_wanted() -> bool {
    !matches!(std::env::var("MIXDOG_ATOMIC_FSYNC").map(|v| v.to_lowercase()).as_deref(), Ok("0" | "false" | "no" | "off"))
}

/// Filesystems that refuse fsync answer with one of these; durability is best-effort there.
fn sync_tolerated(error: &io::Error) -> bool {
    matches!(error.kind(), io::ErrorKind::PermissionDenied | io::ErrorKind::Unsupported | io::ErrorKind::InvalidInput)
}

fn sync(file: &File) -> io::Result<()> {
    match file.sync_all() {
        Err(e) if sync_tolerated(&e) => Ok(()),
        other => other,
    }
}

fn temp_name(target: &Path) -> PathBuf {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let name = target.file_name().unwrap_or_default().to_string_lossy();
    // No leading dot: sync-drive folders refuse dot-prefixed names (Node).
    target.with_file_name(format!("{name}.mixdog-tmp-{}", &id[..8]))
}

/// Mode of the temp file: the existing target's, else 0o644 (Node).
fn create_temp(tmp: &Path, existing: Option<&fs::Metadata>) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(existing.map_or(0o644, |m| m.mode() & 0o777));
    }
    #[cfg(not(unix))]
    let _ = existing;
    options.open(tmp)
}

/// Removes an empty `wx` placeholder; another writer's content is never deleted (Node).
fn cleanup_empty_placeholder(target: &Path) {
    if fs::metadata(target).is_ok_and(|m| m.len() == 0) {
        let _ = fs::remove_file(target);
    }
}

/// One single-file write at its resolved path.
fn write_resolved(locks: &Arc<PathLocks>, resolved: &Resolved, request: &WriteRequest) -> Result<FileStat, FsError> {
    let _held = locks.acquire([resolved.key.clone()]);
    let target = resolved.path.as_path();
    let expect = evaluate(target, &request.precondition)?;
    atomic_write(target, &request.content, &expect)?;
    stat_path(target)
}

/// Node: `atomicWrite`. The caller holds the write lock of `target`.
fn atomic_write(target: &Path, content: &[u8], expect: &Expect) -> Result<(), FsError> {
    let existing = fs::metadata(target).ok();
    let tmp = temp_name(target);
    let fsync = fsync_wanted();
    let written = (|| -> Result<(), (FsStep, io::Error)> {
        let open_step = || FsStep::Open { path: AbsPath::new(&tmp).expect("a resolved target is absolute") };
        let mut file = create_temp(&tmp, existing.as_ref()).map_err(|e| (open_step(), e))?;
        let result = file
            .write_all(content)
            .map_err(|e| (FsStep::Write, e))
            .and_then(|()| if fsync { sync(&file).map_err(|e| (FsStep::Fsync, e)) } else { Ok(()) });
        drop(file);
        if result.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        result
    })();
    written.map_err(|(step, e)| io_error(&e, target).at(step))?;
    #[cfg(windows)]
    if existing.as_ref().is_some_and(|m| m.permissions().readonly()) {
        // A mode without the write bit is the read-only attribute; the rename below then fails
        // exactly as it does for Node.
        let mut permissions = fs::metadata(&tmp).map_err(|e| io_error(&e, target))?.permissions();
        permissions.set_readonly(true);
        let _ = fs::set_permissions(&tmp, permissions);
    }
    if matches!(expect, Expect::Absent) {
        // assertExclusiveCreate: the placeholder claims the name.
        if let Err(e) = OpenOptions::new().write(true).create_new(true).open(target) {
            let _ = fs::remove_file(&tmp);
            return Err(if e.kind() == io::ErrorKind::AlreadyExists { precondition_failed(target) } else { io_error(&e, target) });
        }
    }
    let attempts = if cfg!(windows) { RENAME_BACKOFFS_MS.len() + 1 } else { 1 };
    for attempt in 0..attempts {
        if let Expect::Version(expected) = expect {
            // assertTargetUnchanged (TOCTOU).
            let unchanged = stat_version(target).is_ok_and(|v| v == *expected);
            if !unchanged {
                let _ = fs::remove_file(&tmp);
                return Err(precondition_failed(target));
            }
        }
        match fs::rename(&tmp, target) {
            Ok(()) => {
                if fsync {
                    sync_directory(target);
                }
                return Ok(());
            }
            Err(e) => {
                let transient = cfg!(windows) && (e.kind() == io::ErrorKind::PermissionDenied || e.raw_os_error() == Some(SHARING_VIOLATION));
                if transient && attempt + 1 < attempts {
                    let jitter = u64::from(uuid::Uuid::new_v4().as_bytes()[0]) % 40;
                    std::thread::sleep(Duration::from_millis(RENAME_BACKOFFS_MS[attempt] + jitter));
                    continue;
                }
                let _ = fs::remove_file(&tmp);
                if matches!(expect, Expect::Absent) {
                    cleanup_empty_placeholder(target);
                }
                let step = FsStep::Rename {
                    from: AbsPath::new(&tmp).expect("a resolved target is absolute"),
                    to: AbsPath::new(target).expect("a resolved target is absolute"),
                };
                return Err(io_error(&e, target).at(step));
            }
        }
    }
    unreachable!("the last attempt returns")
}

/// Makes the rename itself durable across power loss; unsupported on Windows (Node: best effort).
fn sync_directory(target: &Path) {
    if let Some(dir) = target.parent() {
        if let Ok(handle) = File::open(dir) {
            let _ = handle.sync_all();
        }
    }
}

/// Node: `writeRestoredFile` + chmod. The restore rewrites in place, through the handle that wrote it.
fn restore_in_place(path: &Path, content: &[u8], mode: Option<u32>) -> io::Result<()> {
    let mut file = OpenOptions::new().write(true).create(true).truncate(true).open(path)?;
    file.write_all(content)?;
    sync(&file)?;
    drop(file);
    #[cfg(unix)]
    if let Some(mode) = mode {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode & 0o7777))?;
    }
    #[cfg(not(unix))]
    let _ = mode;
    Ok(())
}

struct PreImage {
    target: PathBuf,
    /// `None`: the file did not exist.
    content: Option<Vec<u8>>,
    mode: Option<u32>,
}

fn pre_image(target: &Path) -> Result<PreImage, FsError> {
    match fs::metadata(target) {
        Ok(meta) if meta.is_file() => {
            #[cfg(unix)]
            let mode = {
                use std::os::unix::fs::MetadataExt;
                Some(meta.mode())
            };
            #[cfg(not(unix))]
            let mode = None;
            let content = fs::read(target).map_err(|e| io_error(&e, target))?;
            Ok(PreImage { target: target.to_path_buf(), content: Some(content), mode })
        }
        Ok(meta) if meta.is_dir() => Err(plain(FsErrorKind::IsADirectory, target)),
        Ok(_) => Err(plain(FsErrorKind::Special, target)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(PreImage { target: target.to_path_buf(), content: None, mode: None }),
        Err(e) => Err(io_error(&e, target)),
    }
}

fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(from)?;
    if meta.file_type().is_symlink() {
        let target = fs::read_link(from)?;
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, to)?;
        #[cfg(windows)]
        if fs::metadata(from).is_ok_and(|m| m.is_dir()) {
            std::os::windows::fs::symlink_dir(target, to)?;
        } else {
            std::os::windows::fs::symlink_file(target, to)?;
        }
    } else if meta.is_dir() {
        fs::create_dir_all(to)?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            copy_tree(&entry.path(), &to.join(entry.file_name()))?;
        }
    } else {
        fs::copy(from, to)?;
    }
    Ok(())
}

fn exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

/// `EXDEV` / `ERROR_NOT_SAME_DEVICE`.
fn crosses_devices(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(18) if cfg!(unix)) || matches!(error.raw_os_error(), Some(17) if cfg!(windows))
}

fn remove_any(path: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(path)?;
    if meta.is_dir() {
        fs::remove_dir_all(path)
    } else if meta.file_type().is_symlink() && fs::metadata(path).is_ok_and(|m| m.is_dir()) {
        // A directory symlink or junction is removed as a directory entry, never followed.
        fs::remove_dir(path)
    } else {
        fs::remove_file(path)
    }
}

#[async_trait]
impl FileService for LocalFileService {
    async fn stat(&self, lane: InteractiveIo, path: AbsPath) -> Result<FileStat, FsError> {
        on(lane, move || {
            let p = path.as_path();
            stat_path(&p)
        })
        .await?
    }

    async fn read(&self, lane: InteractiveIo, path: AbsPath, range: ReadRange) -> Result<FileBytes, FsError> {
        on(lane, move || {
            let p = path.as_path();
            let meta = fs::metadata(p).map_err(|e| io_error(&e, p))?;
            if meta.is_dir() {
                return Err(plain(FsErrorKind::IsADirectory, p));
            }
            if !meta.is_file() {
                return Err(plain(FsErrorKind::Special, p));
            }
            let mut file = File::open(p).map_err(|e| io_error(&e, p))?;
            let total = file.metadata().map_err(|e| io_error(&e, p))?.len();
            let start = range.offset.min(total);
            file.seek(SeekFrom::Start(start)).map_err(|e| io_error(&e, p))?;
            let mut bytes = Vec::new();
            let read = match range.max_len {
                Some(n) => file.take(n).read_to_end(&mut bytes),
                None => file.read_to_end(&mut bytes),
            };
            read.map_err(|e| io_error(&e, p))?;
            Ok(FileBytes { offset: start, bytes, total_len: total })
        })
        .await?
    }

    async fn list_dir(&self, lane: InteractiveIo, path: AbsPath) -> Result<Vec<DirEntry>, FsError> {
        on(lane, move || {
            let p = path.as_path();
            if fs::metadata(p).is_ok_and(|m| !m.is_dir()) {
                return Err(plain(FsErrorKind::NotADirectory, p));
            }
            let mut out = Vec::new();
            for entry in fs::read_dir(p).map_err(|e| io_error(&e, p))? {
                let entry = entry.map_err(|e| io_error(&e, p))?;
                let kind = entry.file_type().map(entry_kind).map_err(|e| io_error(&e, &entry.path()))?;
                if let Some(path) = AbsPath::new(entry.path()) {
                    out.push(DirEntry { path, kind });
                }
            }
            out.sort_by(|a, b| a.path.as_path().cmp(b.path.as_path()));
            Ok(out)
        })
        .await?
    }

    async fn write(&self, lane: DurabilityIo, request: WriteRequest) -> Result<FileStat, FsError> {
        let locks = self.locks.clone();
        on(lane, move || write_resolved(&locks, &resolve_write(request.path.as_path())?, &request)).await?
    }

    async fn write_batch(&self, lane: DurabilityIo, requests: Vec<WriteRequest>) -> Result<Vec<FileStat>, FsError> {
        let locks = self.locks.clone();
        on(lane, move || {
            let resolved = requests.iter().map(|r| resolve_write(r.path.as_path())).collect::<Result<Vec<Resolved>, FsError>>()?;
            let targets: Vec<PathBuf> = resolved.iter().map(|r| r.path.clone()).collect();
            let _held = locks.acquire(resolved.iter().map(|r| r.key.clone()));
            // Every precondition and pre-image first: a failed condition writes nothing.
            let mut images = Vec::with_capacity(requests.len());
            let mut expects = Vec::with_capacity(requests.len());
            for (request, target) in requests.iter().zip(&targets) {
                expects.push(evaluate(target, &request.precondition)?);
                images.push(pre_image(target)?);
            }
            let mut written = 0;
            let mut failure = None;
            for (index, (request, target)) in requests.iter().zip(&targets).enumerate() {
                if let Err(e) = atomic_write(target, &request.content, &expects[index]) {
                    failure = Some(e);
                    break;
                }
                written = index + 1;
            }
            if let Some(error) = failure {
                // Rollback: put every earlier file back in place, remove what the batch created.
                let mut unrestored = None;
                for image in images[..written].iter().rev() {
                    let outcome = match &image.content {
                        Some(content) => restore_in_place(&image.target, content, image.mode),
                        None => match fs::remove_file(&image.target) {
                            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
                            _ => Ok(()),
                        },
                    };
                    if outcome.is_err() {
                        unrestored.get_or_insert_with(|| image.target.clone());
                    }
                }
                return Err(match unrestored {
                    Some(path) => plain(FsErrorKind::OutcomeUnknown, &path),
                    None => error,
                });
            }
            targets.iter().map(|t| stat_path(t)).collect()
        })
        .await?
    }

    async fn create_dir(&self, lane: DurabilityIo, path: AbsPath, recursive: bool) -> Result<(), FsError> {
        on(lane, move || {
            let p = path.as_path();
            let made = if recursive { fs::create_dir_all(p) } else { fs::create_dir(p) };
            made.map_err(|e| io_error(&e, p))
        })
        .await?
    }

    async fn rename(&self, lane: DurabilityIo, from: AbsPath, to: AbsPath, overwrite: bool) -> Result<(), FsError> {
        on(lane, move || {
            let (f, t) = (from.as_path(), to.as_path());
            if !exists(f) {
                return Err(plain(FsErrorKind::NotFound, f));
            }
            if !overwrite && exists(t) {
                return Err(plain(FsErrorKind::AlreadyExists, t));
            }
            match fs::rename(f, t) {
                Ok(()) => Ok(()),
                Err(e) if crosses_devices(&e) => {
                    copy_tree(f, t).and_then(|()| remove_any(f)).map_err(|e| io_error(&e, f))
                }
                Err(e) => Err(io_error(&e, f)),
            }
        })
        .await?
    }

    async fn copy(&self, lane: DurabilityIo, from: AbsPath, to: AbsPath, overwrite: bool) -> Result<(), FsError> {
        on(lane, move || {
            let (f, t) = (from.as_path(), to.as_path());
            if !exists(f) {
                return Err(plain(FsErrorKind::NotFound, f));
            }
            if !overwrite && exists(t) {
                return Err(plain(FsErrorKind::AlreadyExists, t));
            }
            copy_tree(f, t).map_err(|e| io_error(&e, t))
        })
        .await?
    }

    async fn remove(&self, lane: DurabilityIo, path: AbsPath, recursive: bool) -> Result<(), FsError> {
        on(lane, move || {
            let p = path.as_path();
            let meta = fs::symlink_metadata(p).map_err(|e| io_error(&e, p))?;
            let removed = if meta.is_dir() && !recursive { fs::remove_dir(p) } else { remove_any(p) };
            removed.map_err(|e| io_error(&e, p))
        })
        .await?
    }

    /// The walker runs on its own thread, at most [`QUEUE`] entries ahead of the consumer (see [`Streamed`]).
    fn walk(&self, _lane: MaintenanceIo, request: WalkRequest) -> Box<dyn EventSource<Result<DirEntry, FsError>>> {
        let root = request.root.as_path();
        let mut builder = WalkBuilder::new(root);
        builder.hidden(!request.include_hidden).sort_by_file_path(|a, b| a.cmp(b));
        if !request.recursive {
            builder.max_depth(Some(1));
        }
        match overrides_for(root, Vec::new()) {
            Ok(overrides) => builder.overrides(overrides),
            Err(error) => return failed(invalid_pattern(&error, root)),
        };
        ignore_rules(&mut builder, request.respect_ignore);
        let prune: Vec<PathBuf> = request.prune.iter().map(|p| p.as_path().to_path_buf()).collect();
        if !prune.is_empty() {
            builder.filter_entry(move |entry| !prune.iter().any(|p| entry.path() == p));
        }
        streamed(&PRODUCERS, Box::new(Walking { walk: builder.build(), root: root.to_path_buf(), include_dirs: request.include_dirs }), Deadline::default())
    }

    /// The search runs on its own thread, at most [`QUEUE`] matches ahead of the consumer (see [`Streamed`]).
    fn search_text(&self, _lane: MaintenanceIo, request: SearchRequest) -> Box<dyn EventSource<Result<SearchMatch, FsError>>> {
        let root = request.root.as_path();
        // ripgrep's rule: later globs win, so the excludes follow the includes.
        let globs = request.include_globs.iter().cloned().chain(request.exclude_globs.iter().map(|g| format!("!{g}"))).collect();
        let overrides = match overrides_for(root, globs) {
            Ok(overrides) => overrides,
            Err(error) => return failed(invalid_pattern(&error, root)),
        };
        let mut builder = WalkBuilder::new(root);
        // Siblings in name order, depth first: the walk yields the files in `PathBuf` order, the order Node's server
        // answers in, so each is searched as the walk reaches it.
        builder.hidden(!request.include_hidden).overrides(overrides).sort_by_file_path(|a, b| a.cmp(b));
        ignore_rules(&mut builder, request.respect_ignore);
        let walk_root = root.to_path_buf();
        let listing: Listing = Box::new(builder.build().map(move |item| match item {
            Ok(entry) => Ok(entry.file_type().is_some_and(|t| t.is_file()).then(|| entry.into_path())),
            Err(error) => Err(walk_error(&error, &walk_root)),
        }));
        let open: Opener = Box::new(|path| Ok(Box::new(File::open(path)?) as Box<dyn Read + Send>));
        search_over(&PRODUCERS, &request, listing, open)
    }
}

/// `request`'s search of the files `listing` names, each read through `open`, its producer counted in `producers`.
fn search_over(
    producers: &Arc<Producers>,
    request: &SearchRequest,
    listing: Listing,
    open: Opener,
) -> Box<dyn EventSource<Result<SearchMatch, FsError>>> {
    // The matcher Node's resident search server builds: Rust regex, line mode, \n terminator.
    // A pattern that does not parse is reported with the parser's own text, as Node shows it.
    let matcher = match RegexMatcherBuilder::new()
        .case_insensitive(!request.case_sensitive)
        .fixed_strings(!request.regex)
        .multi_line(true)
        .line_terminator(Some(b'\n'))
        .build(&request.pattern)
    {
        Ok(m) => m,
        Err(error) => {
            return failed(FsError::new(FsErrorKind::InvalidPattern { message: error.to_string() }, Some(request.root.clone())));
        }
    };
    let searching = Searching {
        matcher,
        searcher: SearcherBuilder::new().line_number(true).binary_detection(BinaryDetection::quit(b'\x00')).build(),
        listing,
        open,
        left: request.limit,
        #[cfg(feature = "count-jobs")]
        root: request.root.as_path().to_path_buf(),
        #[cfg(feature = "count-jobs")]
        _live: probe::Live::new(request.root.as_path()),
    };
    #[cfg(feature = "replay-controls")]
    let after_files = match deadline_script::for_root(request.root.as_path()) {
        Some(deadline_script::Script::Silent) => return streamed(producers, Box::new(deadline_script::Silent { _search: Box::new(searching) }), Deadline::default()),
        Some(deadline_script::Script::AfterFiles(n)) => Some(n),
        None => None,
    };
    #[cfg(feature = "replay-controls")]
    let deadline = Deadline { at: request.deadline, after_files };
    #[cfg(not(feature = "replay-controls"))]
    let deadline = Deadline { at: request.deadline };
    streamed(producers, Box::new(searching), deadline)
}

/// The request's globs, then the resident search server's implicit `.git` exclusions
/// (`serve_search/keys.rs`, `prune_globs`): kept unless the root is itself inside a `.git` directory.
fn overrides_for(root: &Path, mut globs: Vec<String>) -> Result<ignore::overrides::Override, ignore::Error> {
    if !root.components().any(|c| c.as_os_str() == ".git") {
        globs.push("!**/.git".to_owned());
        globs.push("!**/.git/**".to_owned());
    }
    let mut overrides = OverrideBuilder::new(root);
    for glob in &globs {
        overrides.add(glob)?;
    }
    overrides.build()
}

fn invalid_pattern(error: &ignore::Error, root: &Path) -> FsError {
    plain(FsErrorKind::InvalidPattern { message: error.to_string() }, root)
}

/// Node: `apply_ignore_rules` (`--no-ignore` turns off all four sources).
fn ignore_rules(builder: &mut WalkBuilder, respect_ignore: bool) {
    if !respect_ignore {
        builder.ignore(false).git_ignore(false).git_global(false).git_exclude(false);
    }
}

fn walk_error(error: &ignore::Error, root: &Path) -> FsError {
    match error.io_error() {
        Some(io) => io_error(io, root),
        None => plain(FsErrorKind::Io { os_code: None }, root),
    }
}

/// The match text a stream item keeps: the search server's printer clip (`--max-columns=500 --max-columns-preview`,
/// grep-printer `write_exceeded_line`), whose mark the renderer adds. A line of 500 bytes or more keeps its first 500
/// characters, so an item holds at most 2,000 bytes of text however long the line.
const MAX_COLUMNS: usize = 500;

/// A match line's text: `str::lines`, as the resident server does (only the terminator, `\n` or `\r\n`, goes), clipped
/// at [`MAX_COLUMNS`]. Bytes past the clip are never decoded.
fn match_text(bytes: &[u8]) -> String {
    let line = bytes.strip_suffix(b"\n").map_or(bytes, |l| l.strip_suffix(b"\r").unwrap_or(l));
    // 500 characters take at most 2,000 bytes; four more bytes show whether a 501st follows.
    let head = &line[..line.len().min(MAX_COLUMNS * 4 + 4)];
    let text = String::from_utf8_lossy(head);
    if head.len() == line.len() && text.len() < MAX_COLUMNS {
        return text.into_owned();
    }
    text.chars().take(MAX_COLUMNS).collect()
}

/// One line per match, like ripgrep's standard printer; the column is the first match's byte start. Stops the file
/// when the request's match budget is spent or the stream is closed.
struct Collect<'a> {
    matcher: &'a grep::regex::RegexMatcher,
    path: &'a AbsPath,
    out: &'a Out<SearchMatch>,
    left: &'a mut Option<usize>,
    /// Matches queued from this file.
    sent: usize,
    /// The stream was closed under the sink.
    closed: bool,
    #[cfg(feature = "count-jobs")]
    root: &'a Path,
}

impl Sink for Collect<'_> {
    type Error = io::Error;

    fn matched(&mut self, _: &Searcher, found: &SinkMatch<'_>) -> Result<bool, io::Error> {
        if *self.left == Some(0) {
            return Ok(false);
        }
        let bytes = found.bytes();
        let column = self.matcher.find(bytes).ok().flatten().map_or(0, |m| m.start()) as u64 + 1;
        let line = found.line_number().unwrap_or(0);
        if !self.out.send(Ok(SearchMatch { path: self.path.clone(), line, column, text: match_text(bytes) })) {
            self.closed = true;
            return Ok(false);
        }
        self.sent += 1;
        #[cfg(feature = "count-jobs")]
        probe::found(self.root);
        if let Some(left) = self.left.as_mut() {
            *left -= 1;
        }
        Ok(*self.left != Some(0))
    }
}

/// Items a stream holds ahead of its consumer, the capacity of its queue. A search item is one match: its path and at
/// most 2,000 bytes of text ([`MAX_COLUMNS`]), so a full queue holds at most `QUEUE` × (2,000 bytes + one path) whatever
/// the files hold; the producer waits while it is full.
pub const QUEUE: usize = 256;

/// How long `close` waits for a stopped producer to end (Node's `CANCEL_GRACE_MS`, after which its client ends the
/// search server).
const CLOSE_GRACE: Duration = Duration::from_secs(1);

/// The bytes one read of a searched file asks for: the stop and the deadline are checked before each, as Node's search
/// server checks them before each read of its 64 KiB chunks (`serve_search/matching.rs`, `CancellableReader`).
const READ_CHUNK: usize = 64 * 1024;

/// The most stream producer threads alive at once, process-wide, abandoned ones included.
///
/// Node's search server runs at most `server_parallelism()` searches at once (2 to 8, `serve_search/config.rs:139`) and
/// queues 2,048 more (`config.rs:17`, `scheduler.rs:234`). A search held in a read that never returns keeps its worker
/// until the client's cancellation watchdog ends the whole server 1 s after its cancel (native-search-client.mjs:501,
/// `CANCEL_GRACE_MS`), which ends the stuck threads with it. Nothing ends a thread here, so the cap counts the abandoned
/// ones until they really end; it is wider than Node's worker count so that a few reads stuck on a dead share do not
/// stop every other search, and it bounds what they hold: a stack, one file's searcher buffers and a walker's state.
pub const MAX_PRODUCERS: usize = 64;

/// Every stream's producer threads, process-wide.
static PRODUCERS: LazyLock<Arc<Producers>> = LazyLock::new(|| Arc::new(Producers::new(MAX_PRODUCERS)));

/// The stream producer threads alive now, process-wide ([`Producers`]).
pub fn producer_counts() -> ProducerCounts {
    PRODUCERS.counts()
}

/// What [`Producers`] counts.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ProducerCounts {
    /// Producer threads started that have not ended.
    pub live: usize,
    /// Of those, the ones their stream has let go of (closed, or dropped, a `close` cut short included) that are still
    /// running: a thread held in a blocking OS call (a directory or file read on a dead network share), which nothing
    /// interrupts. Each ends when its call returns; nothing waits for it.
    pub abandoned: usize,
}

/// A producer's state, changed only under [`Producers`]' lock, so each start, release and end is counted once.
const WAITING: u8 = 0;
const RUNNING: u8 = 1;
const RELEASED: u8 = 2;
const ENDED: u8 = 3;

/// The producer threads of a set of streams, at most `cap` alive. A stream's state moves through [`WAITING`] (no thread
/// yet: every slot is taken), [`RUNNING`], [`RELEASED`] (its stream let go of it while it ran: abandoned until it ends)
/// and [`ENDED`]; the counts change with it, under one lock, whichever of the stream (close, drop) and the thread (its
/// end) gets there first.
pub struct Producers {
    cap: usize,
    counts: Mutex<ProducerCounts>,
    /// Notified on every change of the counts.
    changed: Notify,
}

impl Producers {
    fn new(cap: usize) -> Self {
        Self { cap, counts: Mutex::new(ProducerCounts::default()), changed: Notify::new() }
    }

    fn lock(&self) -> MutexGuard<'_, ProducerCounts> {
        self.counts.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn counts(&self) -> ProducerCounts {
        *self.lock()
    }

    /// `state`'s producer takes a slot and starts, if a slot is free.
    fn admit(&self, state: &AtomicU8) -> bool {
        let mut counts = self.lock();
        if counts.live >= self.cap {
            return false;
        }
        counts.live += 1;
        state.store(RUNNING, Ordering::SeqCst);
        true
    }

    /// `state`'s stream lets go of its producer: one still running is abandoned until it ends.
    fn release(&self, state: &AtomicU8) {
        let mut counts = self.lock();
        match state.load(Ordering::SeqCst) {
            RUNNING => {
                state.store(RELEASED, Ordering::SeqCst);
                counts.abandoned += 1;
            }
            WAITING => state.store(ENDED, Ordering::SeqCst),
            _ => return,
        }
        drop(counts);
        self.changed.notify_waiters();
    }

    /// `state`'s producer thread ends.
    fn end(&self, state: &AtomicU8) {
        let mut counts = self.lock();
        if state.swap(ENDED, Ordering::SeqCst) == RELEASED {
            counts.abandoned -= 1;
        }
        counts.live -= 1;
        drop(counts);
        self.changed.notify_waiters();
    }
}

/// A started producer's hold on its count, given up when its thread ends, however it ends.
struct Started {
    producers: Arc<Producers>,
    state: Arc<AtomicU8>,
}

impl Drop for Started {
    fn drop(&mut self) {
        self.producers.end(&self.state);
    }
}

/// When a search's deadline passes.
#[derive(Clone, Copy, Default)]
struct Deadline {
    /// The soft deadline ([`SearchRequest::deadline`]).
    at: Option<Instant>,
    /// A replay's scripted deadline ([`deadline_script`]): it passes once this many files with matches were searched,
    /// or when the search ends, whichever comes first.
    #[cfg(feature = "replay-controls")]
    after_files: Option<usize>,
}

/// What a stream and its producer thread share.
struct Control {
    /// Set by `close` and by dropping the stream: the producer ends at its next check.
    stop: AtomicBool,
    deadline: Deadline,
    /// Files searched that had matches (for [`Deadline::after_files`]).
    #[cfg(feature = "replay-controls")]
    files_with_lines: AtomicUsize,
    /// The producer is inside one file's search. A deadline that passes now is reported by the file's next read; a read
    /// that never returns leaves the stream unanswered, as Node's server, stuck in a file, never answers.
    in_file: AtomicBool,
}

impl Control {
    fn new(deadline: Deadline) -> Self {
        Self {
            stop: AtomicBool::new(false),
            deadline,
            #[cfg(feature = "replay-controls")]
            files_with_lines: AtomicUsize::new(0),
            in_file: AtomicBool::new(false),
        }
    }

    fn stopped(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }

    fn expired(&self) -> bool {
        #[cfg(feature = "replay-controls")]
        if self.deadline.after_files.is_some_and(|n| self.files_with_lines.load(Ordering::SeqCst) >= n) {
            return true;
        }
        self.deadline.at.is_some_and(|at| Instant::now() >= at)
    }

    /// The check after the search's last file (Node's `handle_content_search` checks its deadline once more).
    fn expired_at_end(&self) -> bool {
        #[cfg(feature = "replay-controls")]
        if self.deadline.after_files.is_some() {
            return true;
        }
        self.expired()
    }

    /// A searched file had matches.
    fn file_with_lines(&self) {
        #[cfg(feature = "replay-controls")]
        self.files_with_lines.fetch_add(1, Ordering::SeqCst);
    }
}

/// The producer's end of a stream.
struct Out<T> {
    tx: mpsc::Sender<Result<T, FsError>>,
    ctl: Arc<Control>,
}

impl<T> Out<T> {
    /// Queues `item`, waiting while the queue is full; `false` once the stream is stopped or gone.
    fn send(&self, item: Result<T, FsError>) -> bool {
        !self.ctl.stopped() && self.tx.blocking_send(item).is_ok()
    }
}

fn timed_out(path: Option<AbsPath>) -> FsError {
    FsError::new(FsErrorKind::TimedOut, path)
}

/// A stream's producer: runs on a thread of its own until it is done or stopped.
trait Produce<T>: Send {
    /// Sends every item through `out`; returns once done, once `out` refuses an item, or at a check that finds the
    /// stream stopped.
    fn run(self: Box<Self>, out: &Out<T>);
}

struct Walking {
    walk: ignore::Walk,
    root: PathBuf,
    include_dirs: bool,
}

impl Produce<DirEntry> for Walking {
    fn run(self: Box<Self>, out: &Out<DirEntry>) {
        for item in self.walk {
            if out.ctl.stopped() {
                return;
            }
            let sent = match item {
                Ok(entry) if entry.depth() == 0 => true,
                Ok(entry) => {
                    let Some(kind) = entry.file_type().map(entry_kind) else { continue };
                    if kind == EntryKind::Dir && !self.include_dirs {
                        continue;
                    }
                    let Some(path) = AbsPath::new(entry.into_path()) else { continue };
                    out.send(Ok(DirEntry { path, kind }))
                }
                Err(error) => out.send(Err(walk_error(&error, &self.root))),
            };
            if !sent {
                return;
            }
        }
    }
}

/// The search's walk, one entry at a time: a file to search, another entry (`None`), or a walk error.
type Listing = Box<dyn Iterator<Item = Result<Option<PathBuf>, FsError>> + Send>;
/// Opens a file for its search.
type Opener = Box<dyn Fn(&Path) -> io::Result<Box<dyn Read + Send>> + Send>;

/// Why a searched file's read stopped short.
#[derive(Debug)]
enum Halt {
    Stopped,
    Deadline,
}

impl std::fmt::Display for Halt {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Halt::Stopped => "search stopped",
            Halt::Deadline => "search deadline passed",
        })
    }
}

impl std::error::Error for Halt {}

fn halt_of(error: &io::Error) -> Option<&Halt> {
    error.get_ref()?.downcast_ref::<Halt>()
}

/// A searched file, read at most [`READ_CHUNK`] bytes at a time, each read after a check of the stop and the deadline.
struct Checked<'a> {
    inner: Box<dyn Read + Send>,
    ctl: &'a Control,
}

impl Read for Checked<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.ctl.stopped() {
            return Err(io::Error::other(Halt::Stopped));
        }
        if self.ctl.expired() {
            return Err(io::Error::other(Halt::Deadline));
        }
        let n = buf.len().min(READ_CHUNK);
        self.inner.read(&mut buf[..n])
    }
}

/// The text search, each file searched as the walk reaches it, in `PathBuf` order (the walk sorts siblings): Node's
/// server answers in that order (`serve_search/search.rs`, `scan_operand`). Nothing of the tree is held beyond the
/// walker's own state and one file's search; Node's server, which scans while its walk publishes, also holds the whole
/// inventory, so this holds less. It stops once the request's `limit` matches are found, and checks the stop and the
/// deadline before each entry of the walk and before every read of a file.
struct Searching {
    matcher: grep::regex::RegexMatcher,
    searcher: Searcher,
    listing: Listing,
    open: Opener,
    left: Option<usize>,
    #[cfg(feature = "count-jobs")]
    root: PathBuf,
    #[cfg(feature = "count-jobs")]
    _live: probe::Live,
}

impl Produce<SearchMatch> for Searching {
    fn run(mut self: Box<Self>, out: &Out<SearchMatch>) {
        let ctl = &*out.ctl;
        #[cfg(feature = "count-jobs")]
        let root = self.root.clone();
        let Searching { matcher, searcher, listing, open, left, .. } = &mut *self;
        let matcher = &*matcher;
        while *left != Some(0) {
            if ctl.stopped() {
                return;
            }
            if ctl.expired() {
                out.send(Err(timed_out(None)));
                return;
            }
            let file = match listing.next() {
                None => break,
                Some(Ok(Some(file))) => file,
                Some(Ok(None)) => continue,
                Some(Err(error)) => {
                    if !out.send(Err(error)) {
                        return;
                    }
                    continue;
                }
            };
            let Some(path) = AbsPath::new(&file) else { continue };
            ctl.in_file.store(true, Ordering::SeqCst);
            let searched = open(&file).and_then(|inner| {
                let mut sink = Collect {
                    matcher,
                    path: &path,
                    out,
                    left,
                    sent: 0,
                    closed: false,
                    #[cfg(feature = "count-jobs")]
                    root: &root,
                };
                searcher.search_reader(matcher, Checked { inner, ctl }, &mut sink).map(|()| (sink.closed, sink.sent))
            });
            ctl.in_file.store(false, Ordering::SeqCst);
            match searched {
                Ok((true, _)) => return,
                Ok((false, sent)) => {
                    if sent > 0 {
                        ctl.file_with_lines();
                    }
                }
                Err(error) => match halt_of(&error) {
                    Some(Halt::Stopped) => return,
                    Some(Halt::Deadline) => {
                        out.send(Err(timed_out(Some(path))));
                        return;
                    }
                    None => {
                        if !out.send(Err(io_error(&error, &file))) {
                            return;
                        }
                    }
                },
            }
        }
        if ctl.expired_at_end() {
            out.send(Err(timed_out(None)));
        }
    }
}

/// A stream fed by a producer thread through a queue of [`QUEUE`] items: the producer runs ahead of the consumer by at
/// most that many and waits while the queue is full.
///
/// [`EventSource::close`] stops the producer and waits for its thread to end, at most [`CLOSE_GRACE`]: a producer
/// checks the stop between entries, before every read of a file and at every item it queues, so it ends at once unless
/// a blocking OS call holds it (a directory or file read on a dead network share), which nothing can interrupt. Such a
/// thread is abandoned by design: counted ([`ProducerCounts::abandoned`]) from the moment its stream lets go of it,
/// never awaited, it ends when its call returns. Dropping the stream, or a `close` cut short by its caller's deadline or
/// cancellation, stops the producer and counts it the same way without waiting for it.
///
/// A producer starts once a slot of its [`Producers`] is free ([`MAX_PRODUCERS`]); until then the stream answers nothing,
/// its deadline included, as a search waiting in Node's server queue gets no answer until a worker takes it. One that
/// starts past its deadline answers [`FsErrorKind::TimedOut`] at its first check, as Node's server answers a search
/// dequeued past its deadline (`scheduler.rs:467`, the deadline counted from `queued_at`); the caller's own hard
/// deadline answers one that never starts, as Node's client times out a request its server never answers.
///
/// With a deadline, the stream ends with a [`FsErrorKind::TimedOut`] item once it passes: from the producer at its next
/// check, or at once while the producer is in the walk (its directory read may never return), as Node's server answers
/// what it found when its walk outlives the deadline.
struct Streamed<T> {
    rx: Option<mpsc::Receiver<Result<T, FsError>>>,
    ctl: Arc<Control>,
    /// Ends when the producer's thread ends.
    finished: Option<oneshot::Receiver<()>>,
    /// The deadline passed while the producer was inside a file: that file's read reports it.
    late: bool,
    producers: Arc<Producers>,
    /// The producer's state in `producers`.
    state: Arc<AtomicU8>,
    /// The producer, while it waits for a slot.
    waiting: Option<Waiting<T>>,
}

/// A producer that has not started, with its end of the queue and the end `close` waits for.
struct Waiting<T> {
    producer: Box<dyn Produce<T>>,
    out: Out<T>,
    done: oneshot::Sender<()>,
}

/// A queue holding one item.
fn one_item<T>(item: Result<T, FsError>) -> mpsc::Receiver<Result<T, FsError>> {
    let (tx, rx) = mpsc::channel(1);
    let _ = tx.try_send(item);
    rx
}

/// A stream that is one error: no producer.
fn failed<T: Send + 'static>(error: FsError) -> Box<dyn EventSource<Result<T, FsError>>> {
    Box::new(Streamed {
        rx: Some(one_item(Err(error))),
        ctl: Arc::new(Control::new(Deadline::default())),
        finished: None,
        late: false,
        producers: PRODUCERS.clone(),
        state: Arc::new(AtomicU8::new(ENDED)),
        waiting: None,
    })
}

fn streamed<T: Send + 'static>(
    producers: &Arc<Producers>,
    producer: Box<dyn Produce<T>>,
    deadline: Deadline,
) -> Box<dyn EventSource<Result<T, FsError>>> {
    let (tx, rx) = mpsc::channel(QUEUE);
    let ctl = Arc::new(Control::new(deadline));
    let (done, finished) = oneshot::channel::<()>();
    let out = Out { tx, ctl: ctl.clone() };
    let mut stream = Streamed {
        rx: Some(rx),
        ctl,
        finished: Some(finished),
        late: false,
        producers: producers.clone(),
        state: Arc::new(AtomicU8::new(WAITING)),
        waiting: Some(Waiting { producer, out, done }),
    };
    stream.try_start();
    Box::new(stream)
}

impl<T: Send + 'static> Streamed<T> {
    /// Starts the waiting producer if a slot is free; `false` while it still waits.
    fn try_start(&mut self) -> bool {
        if self.waiting.is_none() {
            return true;
        }
        if !self.producers.admit(&self.state) {
            return false;
        }
        let Some(Waiting { producer, out, done }) = self.waiting.take() else { return true };
        let started = Started { producers: self.producers.clone(), state: self.state.clone() };
        let spawned = std::thread::Builder::new().name("mixdog-fs-stream".into()).spawn(move || {
            // Dropped when the thread ends, however it ends, in this order: the slot, then the end `close` waits for.
            let _done = done;
            let _started = started;
            producer.run(&out);
        });
        // The closure, dropped unrun, gave up the slot and ended the queue.
        if let Err(error) = spawned {
            self.rx = Some(one_item(Err(FsError::new(FsErrorKind::Io { os_code: error.raw_os_error() }, None))));
            self.finished = None;
        }
        true
    }

    /// Waits for a slot and starts the producer. Dropping this wait keeps the producer waiting in the stream.
    async fn started(&mut self) {
        let producers = self.producers.clone();
        loop {
            let freed = producers.changed.notified();
            let mut freed = std::pin::pin!(freed);
            freed.as_mut().enable();
            if self.try_start() {
                return;
            }
            freed.await;
        }
    }
}

#[async_trait]
impl<T: Send + 'static> EventSource<Result<T, FsError>> for Streamed<T> {
    async fn next(&mut self) -> Option<Result<T, FsError>> {
        self.rx.as_ref()?;
        self.started().await;
        let rx = self.rx.as_mut()?;
        let item = match self.ctl.deadline.at.filter(|_| !self.late) {
            Some(at) => tokio::select! {
                biased;
                item = rx.recv() => item,
                () = tokio::time::sleep_until(at.into()) => {
                    if self.ctl.in_file.load(Ordering::SeqCst) {
                        self.late = true;
                        rx.recv().await
                    } else {
                        self.ctl.stop.store(true, Ordering::SeqCst);
                        Some(Err(timed_out(None)))
                    }
                }
            },
            None => rx.recv().await,
        };
        if matches!(item, None | Some(Err(FsError { kind: FsErrorKind::TimedOut, .. }))) {
            self.rx = None;
        }
        item
    }

    async fn close(&mut self) {
        self.ctl.stop.store(true, Ordering::SeqCst);
        // A producer waiting on a full queue is released; one waiting for a slot never starts.
        self.rx = None;
        self.waiting = None;
        // Counted before the wait, so a caller that drops this `close` leaves the count right.
        self.producers.release(&self.state);
        if let Some(finished) = self.finished.take() {
            let _ = tokio::time::timeout(CLOSE_GRACE, finished).await;
        }
    }
}

impl<T> Drop for Streamed<T> {
    fn drop(&mut self) {
        self.ctl.stop.store(true, Ordering::SeqCst);
        self.producers.release(&self.state);
    }
}

/// What a test can observe of the text searches: per search root, the matches produced and the searches whose
/// producer is still alive.
#[cfg(feature = "count-jobs")]
pub mod probe {
    use std::collections::HashMap;
    use std::path::Path;
    use std::path::PathBuf;
    use std::sync::Mutex;
    use std::sync::PoisonError;

    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    pub struct SearchProbe {
        pub found: u64,
        pub live: u64,
    }

    static ROOTS: Mutex<Option<HashMap<PathBuf, SearchProbe>>> = Mutex::new(None);

    fn with<R>(root: &Path, f: impl FnOnce(&mut SearchProbe) -> R) -> R {
        let mut roots = ROOTS.lock().unwrap_or_else(PoisonError::into_inner);
        f(roots.get_or_insert_with(HashMap::new).entry(root.to_path_buf()).or_default())
    }

    pub fn search(root: &Path) -> SearchProbe {
        with(root, |p| *p)
    }

    /// The searches whose producer is alive, over every root under `scope`.
    pub fn live_under(scope: &Path) -> u64 {
        let roots = ROOTS.lock().unwrap_or_else(PoisonError::into_inner);
        roots.as_ref().map_or(0, |roots| roots.iter().filter(|(root, _)| root.starts_with(scope)).map(|(_, p)| p.live).sum())
    }

    pub(super) fn found(root: &Path) {
        with(root, |p| p.found += 1);
    }

    pub(super) struct Live(PathBuf);

    impl Live {
        pub(super) fn new(root: &Path) -> Self {
            with(root, |p| p.live += 1);
            Self(root.to_path_buf())
        }
    }

    impl Drop for Live {
        fn drop(&mut self) {
            with(&self.0, |p| p.live -= 1);
        }
    }
}

/// Search deadlines a replay scripts instead of a clock, for the searches whose root lies under a scripted scope. The
/// rest of the deadline's handling is the production one.
#[cfg(feature = "replay-controls")]
pub mod deadline_script {
    use std::path::Path;
    use std::path::PathBuf;
    use std::sync::Mutex;
    use std::sync::PoisonError;

    #[derive(Clone, Copy, Debug)]
    pub enum Script {
        /// The soft deadline passes once this many files with matches were searched, or when the search ends (a
        /// deadline that passed during its last file).
        AfterFiles(usize),
        /// The search never answers: it queues nothing and ends only when stopped (a server stuck past every deadline).
        Silent,
    }

    static SCRIPTS: Mutex<Vec<(PathBuf, Script)>> = Mutex::new(Vec::new());

    /// Scripts the searches under `scope` (`None` removes the script).
    pub fn set(scope: &Path, script: Option<Script>) {
        let mut scripts = SCRIPTS.lock().unwrap_or_else(PoisonError::into_inner);
        scripts.retain(|(s, _)| s != scope);
        if let Some(script) = script {
            scripts.push((scope.to_path_buf(), script));
        }
    }

    pub(super) fn for_root(root: &Path) -> Option<Script> {
        let scripts = SCRIPTS.lock().unwrap_or_else(PoisonError::into_inner);
        scripts.iter().find(|(scope, _)| root.starts_with(scope)).map(|(_, script)| *script)
    }

    /// A search that queues nothing and ends when stopped, holding the search it stands for until then.
    pub(super) struct Silent {
        pub(super) _search: Box<dyn Send>,
    }

    impl super::Produce<mixdog_core_api::domain::fs::SearchMatch> for Silent {
        fn run(self: Box<Self>, out: &super::Out<mixdog_core_api::domain::fs::SearchMatch>) {
            while !out.ctl.stopped() {
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::domain::conformance::FsLanes;
    use mixdog_core_api::domain::conformance::check_file_service;

    use super::*;

    fn lanes() -> FsLanes {
        let tokens = mixdog_rt::testing::tokens();
        FsLanes { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io }
    }

    fn root() -> (tempfile::TempDir, AbsPath) {
        let dir = tempfile::tempdir().unwrap();
        let root = AbsPath::new(crate::pathguard::canonical(dir.path()).unwrap()).unwrap();
        (dir, root)
    }

    #[tokio::test]
    async fn passes_the_shared_file_service_conformance() {
        let (_dir, root) = root();
        check_file_service(&LocalFileService::new(), lanes(), root).await;
    }

    #[tokio::test]
    async fn concurrent_compare_and_set_has_one_winner() {
        let (_dir, root) = root();
        let fs = std::sync::Arc::new(LocalFileService::new());
        let file = root.join("f.txt");
        let l = lanes();
        let seed = |content: &[u8], precondition| WriteRequest { path: file.clone(), content: content.to_vec(), precondition };
        fs.write(l.durability, seed(b"base", WritePrecondition::Absent)).await.unwrap();
        let mut tasks = Vec::new();
        for i in 0..8u8 {
            let (fs, file) = (fs.clone(), file.clone());
            tasks.push(tokio::spawn(async move {
                let request = WriteRequest { path: file, content: vec![b'a' + i], precondition: WritePrecondition::ContentEquals(b"base".to_vec()) };
                fs.write(l.durability, request).await
            }));
        }
        let mut winners = 0;
        for task in tasks {
            match task.await.unwrap() {
                Ok(_) => winners += 1,
                Err(e) => assert!(matches!(e.kind, FsErrorKind::PreconditionFailed { .. })),
            }
        }
        assert_eq!(winners, 1);
    }

    #[tokio::test]
    async fn batch_rolls_back_and_leaves_no_temp_files() {
        let (_dir, root) = root();
        let fs = LocalFileService::new();
        let l = lanes();
        let (a, b) = (root.join("a.txt"), root.join("sub"));
        fs.write(l.durability, WriteRequest { path: a.clone(), content: b"old".to_vec(), precondition: WritePrecondition::Unconditional }).await.unwrap();
        // The second target is a directory: its write fails after the first file was replaced.
        std::fs::create_dir(b.as_path()).unwrap();
        let err = fs
            .write_batch(
                l.durability,
                vec![
                    WriteRequest { path: a.clone(), content: b"new".to_vec(), precondition: WritePrecondition::Unconditional },
                    WriteRequest { path: b.clone(), content: b"x".to_vec(), precondition: WritePrecondition::Unconditional },
                ],
            )
            .await
            .unwrap_err();
        assert_eq!(err.kind, FsErrorKind::IsADirectory);
        assert_eq!(std::fs::read(a.as_path()).unwrap(), b"old");
        let names: Vec<_> = std::fs::read_dir(root.as_path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert!(names.iter().all(|n| !n.contains("mixdog-tmp")), "{names:?}");
    }

    fn put(path: &AbsPath, content: &[u8], precondition: WritePrecondition) -> WriteRequest {
        WriteRequest { path: path.clone(), content: content.to_vec(), precondition }
    }

    #[tokio::test]
    async fn stat_reports_nodes_ctime_inode_and_device() {
        let (_dir, root) = root();
        let file = root.join("f.txt");
        fs::write(file.as_path(), b"one").unwrap();
        let service = LocalFileService::new();
        let stat = service.stat(lanes().interactive, file.clone()).await.unwrap();
        let ctime_ns = stat.ctime.unwrap().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos() as i128;
        let version = stat_version(file.as_path()).unwrap();
        assert_eq!((ctime_ns, stat.inode, stat.device), (version.ctime_ns, version.ino, version.dev));
        assert!(stat.inode != 0);
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let meta = fs::metadata(file.as_path()).unwrap();
            assert_eq!((stat.inode, stat.device), (u128::from(meta.ino()), meta.dev()));
            assert_eq!(ctime_ns, i128::from(meta.ctime()) * 1_000_000_000 + i128::from(meta.ctime_nsec()));
        }
        // Another file is another inode on the same device; a rewrite moves the change time on.
        let other = root.join("g.txt");
        fs::write(other.as_path(), b"x").unwrap();
        let second = service.stat(lanes().interactive, other).await.unwrap();
        assert_eq!((second.device, second.inode == stat.inode), (stat.device, false));
        std::thread::sleep(Duration::from_millis(50));
        fs::write(file.as_path(), b"two").unwrap();
        let after = service.stat(lanes().interactive, file).await.unwrap();
        assert!(after.ctime > stat.ctime);
        assert_eq!((after.inode, after.device), (stat.inode, stat.device));
    }

    fn tmp_suffix_is_eight_hex(tmp_name: &str, target_name: &str) -> bool {
        tmp_name
            .strip_prefix(target_name)
            .and_then(|rest| rest.strip_prefix(".mixdog-tmp-"))
            .is_some_and(|id| id.len() == 8 && id.bytes().all(|b| b.is_ascii_hexdigit()))
    }

    #[test]
    fn a_temp_file_that_cannot_be_created_names_the_open_step_with_the_temp_path() {
        let dir = tempfile::tempdir().unwrap();
        // The temp name is the target's plus 20 characters: past the 255-character name limit.
        let name = "n".repeat(250);
        let target = dir.path().join(&name);
        let error = atomic_write(&target, b"x", &Expect::Nothing).unwrap_err();
        let Some(FsStep::Open { path }) = &error.step else { panic!("{error:?}") };
        let tmp_name = path.as_path().file_name().unwrap().to_string_lossy().into_owned();
        assert!(tmp_suffix_is_eight_hex(&tmp_name, &name), "{tmp_name}");
        assert!(!target.exists());
    }

    #[test]
    fn a_blocked_rename_names_the_rename_step_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        // A non-empty directory cannot be replaced by a file.
        let target = dir.path().join("occupied");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("inner"), b"x").unwrap();
        let error = atomic_write(&target, b"x", &Expect::Nothing).unwrap_err();
        let Some(FsStep::Rename { from, to }) = &error.step else { panic!("{error:?}") };
        assert_eq!(to.as_path(), target);
        assert!(tmp_suffix_is_eight_hex(&from.as_path().file_name().unwrap().to_string_lossy(), "occupied"));
        assert!(!from.as_path().exists(), "the temp file is removed");
    }

    #[test]
    fn a_successful_write_and_other_failures_carry_no_step() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("f.txt");
        atomic_write(&target, b"x", &Expect::Nothing).unwrap();
        assert!(plain(FsErrorKind::NotFound, &target).step.is_none());
    }

    #[test]
    fn version_catches_a_same_size_same_mtime_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("f.txt");
        fs::write(&target, b"one").unwrap();
        let before = stat_version(&target).unwrap();
        // A different file of the same size, given the same mtime, moved over the target: only the
        // inode and the change time tell the two apart (length and mtime alone cannot).
        let other = dir.path().join("other.txt");
        fs::write(&other, b"two").unwrap();
        OpenOptions::new().write(true).open(&other).unwrap().set_modified(fs::metadata(&target).unwrap().modified().unwrap()).unwrap();
        fs::rename(&other, &target).unwrap();
        let after = stat_version(&target).unwrap();
        assert_eq!((after.size, after.mtime_ns), (before.size, before.mtime_ns));
        assert_ne!(after, before);
        let err = atomic_write(&target, b"new", &Expect::Version(before)).unwrap_err();
        assert!(matches!(err.kind, FsErrorKind::PreconditionFailed { actual: Some(ref a) } if a == b"two"), "{err:?}");
        assert_eq!(fs::read(&target).unwrap(), b"two");
        atomic_write(&target, b"new", &Expect::Version(after)).unwrap();
    }

    #[tokio::test]
    async fn two_spellings_of_one_file_have_one_winner() {
        let (_dir, root) = root();
        let fs = Arc::new(LocalFileService::new());
        let l = lanes();
        std::fs::create_dir(root.join("sub").as_path()).unwrap();
        let plain = root.join("f.txt");
        let dotted = AbsPath::new(root.as_path().join("sub").join("..").join("f.txt")).unwrap();
        assert!(resolve_write(plain.as_path()).unwrap().key.same(&resolve_write(dotted.as_path()).unwrap().key));
        fs.write(l.durability, put(&plain, b"base", WritePrecondition::Absent)).await.unwrap();
        #[cfg(unix)]
        let mut spellings = vec![plain.clone(), dotted.clone()];
        #[cfg(not(unix))]
        let spellings = vec![plain.clone(), dotted.clone()];
        #[cfg(unix)]
        {
            let alias = root.join("alias");
            std::os::unix::fs::symlink(root.as_path(), alias.as_path()).unwrap();
            spellings.push(AbsPath::new(alias.as_path().join("f.txt")).unwrap());
        }
        let mut tasks = Vec::new();
        for i in 0..12u8 {
            let (fs, file) = (fs.clone(), spellings[usize::from(i) % spellings.len()].clone());
            tasks.push(tokio::spawn(async move { fs.write(l.durability, put(&file, &[b'a' + i], WritePrecondition::ContentEquals(b"base".to_vec()))).await }));
        }
        let mut winners = 0;
        for task in tasks {
            match task.await.unwrap() {
                Ok(_) => winners += 1,
                Err(e) => assert!(matches!(e.kind, FsErrorKind::PreconditionFailed { .. }), "{e:?}"),
            }
        }
        assert_eq!(winners, 1);
    }

    /// A directory link (symlink on Unix, junction on Windows, which needs no privilege).
    fn make_dir_link(link: &Path, target: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
        #[cfg(windows)]
        {
            let status = std::process::Command::new("cmd").arg("/C").arg("mklink").arg("/J").arg(link).arg(target).output().unwrap();
            assert!(status.status.success(), "{}", String::from_utf8_lossy(&status.stdout));
        }
    }

    fn remove_dir_link(link: &Path) {
        fs::remove_dir(link).unwrap();
    }

    #[tokio::test]
    async fn a_parent_link_retargeted_after_resolving_cannot_redirect_the_write() {
        let (_dir, root) = root();
        let (a, b) = (root.join("a"), root.join("b"));
        fs::create_dir(a.as_path()).unwrap();
        fs::create_dir(b.as_path()).unwrap();
        let link = root.join("link");
        make_dir_link(link.as_path(), a.as_path());
        let request = put(&AbsPath::new(link.as_path().join("f.txt")).unwrap(), b"payload", WritePrecondition::Absent);
        let resolved = resolve_write(request.path.as_path()).unwrap();
        // The link now points at B, as an attacker (or a racing process) would leave it.
        remove_dir_link(link.as_path());
        make_dir_link(link.as_path(), b.as_path());
        let locks = Arc::new(PathLocks::default());
        write_resolved(&locks, &resolved, &request).unwrap();
        assert_eq!(fs::read(a.join("f.txt").as_path()).unwrap(), b"payload", "the write must land where the path resolved");
        assert!(!b.join("f.txt").as_path().exists(), "the retargeted link redirected the write");
        assert!(fs::read_dir(b.as_path()).unwrap().next().is_none());
    }

    #[test]
    fn a_missing_intermediate_directory_under_an_alias_has_the_canonical_key() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical(dir.path()).unwrap();
        let real = root.join("Real");
        fs::create_dir(real.as_path()).unwrap();
        let link = root.join("link");
        make_dir_link(link.as_path(), real.as_path());
        let canonical_spelling = resolve_write(&real.join("new1").join("new2").join("f.txt")).unwrap();
        let aliased = resolve_write(&link.join("new1").join("new2").join("f.txt")).unwrap();
        assert!(aliased.key.same(&canonical_spelling.key));
        assert_eq!(aliased.path, canonical_spelling.path);
        if cfg!(windows) {
            // A case alias of the existing ancestor resolves to its stored case.
            let cased = resolve_write(&root.join("REAL").join("new1").join("new2").join("f.txt")).unwrap();
            assert_eq!(cased.path, canonical_spelling.path);
        }
    }

    #[test]
    fn names_that_differ_only_in_case_are_one_key_when_the_directory_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical(dir.path()).unwrap();
        let (lower, upper) = (resolve_write(&root.join("foo.txt")).unwrap(), resolve_write(&root.join("FOO.TXT")).unwrap());
        let insensitive = cfg!(windows);
        assert_eq!(lower.key.same(&upper.key), insensitive);
        // The key does not change once the file exists (and is found under the other spelling).
        fs::write(root.join("foo.txt"), b"x").unwrap();
        let created = resolve_write(&root.join("FOO.TXT")).unwrap();
        assert_eq!(created.key.same(&lower.key), insensitive);
        assert!(resolve_write(&root.join("foo.txt")).unwrap().key.same(&lower.key));
    }

    #[tokio::test]
    async fn case_variants_of_a_new_file_have_one_winner_in_an_insensitive_directory() {
        let (_dir, root) = root();
        if !cfg!(windows) {
            return;
        }
        let fs = Arc::new(LocalFileService::new());
        let l = lanes();
        let mut tasks = Vec::new();
        for i in 0..12u8 {
            let name = if i % 2 == 0 { "new.txt" } else { "NEW.TXT" };
            let (fs, file) = (fs.clone(), root.join(name));
            tasks.push(tokio::spawn(async move { fs.write(l.durability, put(&file, &[b'a' + i], WritePrecondition::Absent)).await }));
        }
        let mut winners = 0;
        for task in tasks {
            match task.await.unwrap() {
                Ok(_) => winners += 1,
                Err(e) => assert!(matches!(e.kind, FsErrorKind::PreconditionFailed { .. }), "{e:?}"),
            }
        }
        assert_eq!(winners, 1);
    }

    #[tokio::test]
    async fn a_held_file_does_not_stall_other_files_and_the_lock_map_empties() {
        let (_dir, root) = root();
        let fs = LocalFileService::new();
        let l = lanes();
        let busy = root.join("busy.txt");
        let held = fs.locks.acquire([resolve_write(busy.as_path()).unwrap().key]);
        for i in 0..80 {
            let file = root.join(&format!("other{i}.txt"));
            tokio::time::timeout(Duration::from_secs(5), fs.write(l.durability, put(&file, b"x", WritePrecondition::Unconditional)))
                .await
                .expect("a write to another file waited on the held one")
                .unwrap();
        }
        assert_eq!(fs.locks.len(), 1, "only the held file keeps a lock");
        let waiting = {
            let locks = fs.locks.clone();
            let key = resolve_write(busy.as_path()).unwrap().key;
            tokio::task::spawn_blocking(move || drop(locks.acquire([key])))
        };
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(!waiting.is_finished(), "the same file must wait");
        drop(held);
        waiting.await.unwrap();
        assert_eq!(fs.locks.len(), 0);
    }

    #[tokio::test]
    async fn an_unparseable_pattern_is_reported_with_the_parser_text() {
        let (_dir, root) = root();
        let fs = LocalFileService::new();
        let request = SearchRequest {
            root: root.clone(),
            pattern: "(".into(),
            regex: true,
            case_sensitive: true,
            include_globs: Vec::new(),
            exclude_globs: Vec::new(),
            include_hidden: true,
            respect_ignore: true,
            limit: None,
            deadline: None,
        };
        let mut stream = fs.search_text(lanes().maintenance, request);
        let err = stream.next().await.unwrap().unwrap_err();
        let FsErrorKind::InvalidPattern { message } = err.kind else { panic!("{err:?}") };
        assert!(message.starts_with("regex parse error:") && message.contains("unclosed group"), "{message}");
        assert!(stream.next().await.is_none());
    }

    #[tokio::test]
    async fn the_git_directory_is_pruned_unless_the_root_is_inside_it() {
        let (_dir, root) = root();
        let fs = LocalFileService::new();
        let l = lanes();
        std::fs::create_dir_all(root.join(".git/refs").as_path()).unwrap();
        std::fs::write(root.join(".git/config").as_path(), "needle\n").unwrap();
        std::fs::write(root.join("a.txt").as_path(), "needle\n").unwrap();
        let search = |root: AbsPath| {
            let request = SearchRequest {
                root,
                pattern: "needle".into(),
                regex: false,
                case_sensitive: true,
                include_globs: Vec::new(),
                exclude_globs: Vec::new(),
                include_hidden: true,
                respect_ignore: false,
                limit: None,
                deadline: None,
            };
            let mut s = fs.search_text(l.maintenance, request);
            async move {
                let mut out = Vec::new();
                while let Some(m) = s.next().await {
                    out.push(m.unwrap().path.as_path().file_name().unwrap().to_string_lossy().into_owned());
                }
                out
            }
        };
        assert_eq!(search(root.clone()).await, vec!["a.txt"]);
        assert_eq!(search(root.join(".git")).await, vec!["config"]);
        let mut walk = fs.walk(l.maintenance, WalkRequest { root: root.clone(), recursive: true, include_dirs: true, include_hidden: true, respect_ignore: false, prune: Vec::new() });
        let mut names = Vec::new();
        while let Some(e) = walk.next().await {
            names.push(e.unwrap().path.as_path().file_name().unwrap().to_string_lossy().into_owned());
        }
        assert_eq!(names, vec!["a.txt"]);
    }

    #[tokio::test]
    async fn only_the_line_terminator_is_removed_from_a_match() {
        let (_dir, root) = root();
        let fs = LocalFileService::new();
        std::fs::write(root.join("f.txt").as_path(), b"needle\r\r\nneedle\r\nneedle\r").unwrap();
        let request = SearchRequest {
            root: root.clone(),
            pattern: "needle".into(),
            regex: false,
            case_sensitive: true,
            include_globs: Vec::new(),
            exclude_globs: Vec::new(),
            include_hidden: true,
            respect_ignore: true,
            limit: None,
            deadline: None,
        };
        let mut s = fs.search_text(lanes().maintenance, request);
        let mut texts = Vec::new();
        while let Some(m) = s.next().await {
            texts.push(m.unwrap().text);
        }
        assert_eq!(texts, vec!["needle\r", "needle", "needle\r"]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn writes_through_a_leaf_symlink() {
        let (_dir, root) = root();
        let fs = LocalFileService::new();
        let (real, link) = (root.join("real.txt"), root.join("link.txt"));
        std::fs::write(real.as_path(), b"one").unwrap();
        std::os::unix::fs::symlink(real.as_path(), link.as_path()).unwrap();
        fs.write(lanes().durability, WriteRequest { path: link.clone(), content: b"two".to_vec(), precondition: WritePrecondition::Unconditional }).await.unwrap();
        assert!(std::fs::symlink_metadata(link.as_path()).unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read(real.as_path()).unwrap(), b"two");
    }

    #[tokio::test]
    async fn search_honours_ignore_files_globs_and_binary_files() {
        let (_dir, root) = root();
        let fs = LocalFileService::new();
        let l = lanes();
        std::fs::create_dir_all(root.join("src").as_path()).unwrap();
        std::fs::create_dir_all(root.join("skip").as_path()).unwrap();
        std::fs::create_dir_all(root.join(".git").as_path()).unwrap();
        std::fs::write(root.join(".gitignore").as_path(), "skip/\n").unwrap();
        std::fs::write(root.join("src/a.rs").as_path(), "let Needle = 1;\nneedle\r\n").unwrap();
        std::fs::write(root.join("src/b.txt").as_path(), "needle\n").unwrap();
        std::fs::write(root.join("skip/c.rs").as_path(), "needle\n").unwrap();
        std::fs::write(root.join("bin.rs").as_path(), b"needle\n\x00needle\n").unwrap();
        let run = |request: SearchRequest| {
            let mut s = fs.search_text(l.maintenance, request);
            async move {
                let mut out = Vec::new();
                while let Some(m) = s.next().await {
                    let m = m.unwrap();
                    out.push((m.path.as_path().file_name().unwrap().to_string_lossy().into_owned(), m.line, m.column, m.text));
                }
                out
            }
        };
        let base = SearchRequest {
            root: root.clone(),
            pattern: "needle".into(),
            regex: true,
            case_sensitive: false,
            include_globs: vec!["*.rs".into()],
            exclude_globs: Vec::new(),
            include_hidden: true,
            respect_ignore: true,
            limit: None,
            deadline: None,
        };
        let found = run(base.clone()).await;
        // ripgrep quits a file at its first NUL, so bin.rs reports nothing; skip/ is gitignored.
        assert_eq!(found, vec![("a.rs".into(), 1, 5, "let Needle = 1;".into()), ("a.rs".into(), 2, 1, "needle".into())]);
        let all = run(SearchRequest { respect_ignore: false, ..base }).await;
        assert!(all.iter().any(|m| m.0 == "c.rs") && all.iter().all(|m| m.0 != "bin.rs"));
    }

    fn needle_request(root: &AbsPath, deadline: Option<Instant>) -> SearchRequest {
        SearchRequest {
            root: root.clone(),
            pattern: "needle".into(),
            regex: false,
            case_sensitive: true,
            include_globs: Vec::new(),
            exclude_globs: Vec::new(),
            include_hidden: true,
            respect_ignore: false,
            limit: None,
            deadline,
        }
    }

    /// Waits until `f` holds, at most 10 s.
    async fn eventually(mut f: impl FnMut() -> bool) -> bool {
        let until = Instant::now() + Duration::from_secs(10);
        while Instant::now() < until {
            if f() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        f()
    }

    /// `lines` lines of `b'x'`, 1 KiB each, read through a counter: a file of any size with no match.
    struct Generated {
        left: u64,
        at: u64,
        read: Arc<AtomicU64>,
    }

    impl Read for Generated {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let n = buf.len().min(usize::try_from(self.left).unwrap_or(usize::MAX));
            for (i, b) in buf[..n].iter_mut().enumerate() {
                *b = if (self.at + i as u64) % 1024 == 1023 { b'\n' } else { b'x' };
            }
            self.at += n as u64;
            self.left -= n as u64;
            self.read.fetch_add(n as u64, Ordering::SeqCst);
            Ok(n)
        }
    }

    const GIB: u64 = 1 << 30;

    /// One file of 1 GiB with no match, through the search's file seam.
    fn one_gib_file(root: &AbsPath) -> (Listing, Opener, Arc<AtomicU64>) {
        let read = Arc::new(AtomicU64::new(0));
        let listing: Listing = Box::new(std::iter::once(Ok(Some(root.join("big.txt").as_path().to_path_buf()))));
        let counter = read.clone();
        let open: Opener = Box::new(move |_| Ok(Box::new(Generated { left: GIB, at: 0, read: counter.clone() }) as Box<dyn Read + Send>));
        (listing, open, read)
    }

    /// The memory a search holds ahead of its consumer is its queue: [`QUEUE`] matches, each at most `4 × MAX_COLUMNS`
    /// (2,000) bytes of text however long its line, so at most 256 × 2,000 bytes = 512,000 bytes of text plus one path per
    /// match. A consumer that stops reading without dropping the stream holds the producer there.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_consumer_that_stops_reading_holds_the_producer_at_its_queue() {
        let (_dir, root) = root();
        // 400 matching lines of 10,007 bytes each.
        let line = format!("needle {}\n", "\u{e9}".repeat(5_000));
        std::fs::write(root.join("a.txt").as_path(), line.repeat(400)).unwrap();
        let fs = LocalFileService::new();
        let mut stream = fs.search_text(lanes().maintenance, needle_request(&root, None));
        assert!(stream.next().await.unwrap().is_ok());
        let found = || probe::search(root.as_path()).found;
        assert!(eventually(|| found() == QUEUE as u64 + 1).await, "found {}", found());
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(found(), QUEUE as u64 + 1, "the producer waits while the queue is full");
        let mut queued_bytes = 0;
        for _ in 0..QUEUE {
            let item = stream.next().await.unwrap().unwrap();
            assert!(item.text.len() <= 4 * MAX_COLUMNS && item.text.chars().count() == MAX_COLUMNS, "{}", item.text.len());
            queued_bytes += item.text.len();
        }
        assert!(queued_bytes <= QUEUE * 4 * MAX_COLUMNS, "{queued_bytes}");
        let started = Instant::now();
        stream.close().await;
        assert!(started.elapsed() < CLOSE_GRACE, "{:?} found {}", started.elapsed(), found());
        assert_eq!(probe::search(root.as_path()).live, 0, "close returns once the producer has ended");
    }

    /// A file of 1 GiB with no match is read in checked chunks: a stop or a deadline that arrives mid-file ends the
    /// search at the next chunk.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_stop_or_a_deadline_mid_file_ends_the_search_of_a_huge_file() {
        let (_dir, root) = root();
        let (listing, open, read) = one_gib_file(&root);
        let mut stream = search_over(&PRODUCERS, &needle_request(&root, None), listing, open);
        assert!(eventually(|| read.load(Ordering::SeqCst) >= 16 << 20).await);
        let started = Instant::now();
        stream.close().await;
        assert!(started.elapsed() < CLOSE_GRACE, "the stop is seen at the next read");
        let at_close = read.load(Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(read.load(Ordering::SeqCst), at_close, "nothing is read after close returns");
        assert!(at_close < GIB);
        assert_eq!(probe::search(root.as_path()).live, 0);

        let (listing, open, read) = one_gib_file(&root);
        let mut stream = search_over(&PRODUCERS, &needle_request(&root, Some(Instant::now() + Duration::from_millis(100))), listing, open);
        let err = stream.next().await.unwrap().unwrap_err();
        assert!(matches!(err.kind, FsErrorKind::TimedOut), "{err:?}");
        assert_eq!(err.path.map(|p| p.as_path().to_path_buf()), Some(root.join("big.txt").as_path().to_path_buf()), "the cut file is named");
        assert!(stream.next().await.is_none());
        stream.close().await;
        assert!(read.load(Ordering::SeqCst) < GIB);
        assert_eq!(probe::search(root.as_path()).live, 0);

        // Dropping the stream stops the producer without waiting for it: it ends at its next read.
        let (listing, open, read) = one_gib_file(&root);
        let stream = search_over(&PRODUCERS, &needle_request(&root, None), listing, open);
        assert!(eventually(|| read.load(Ordering::SeqCst) >= 16 << 20).await);
        drop(stream);
        assert!(eventually(|| probe::search(root.as_path()).live == 0).await);
        assert!(read.load(Ordering::SeqCst) < GIB);
    }

    /// Waits until `test` holds of `producers`' counts, at most 10 s.
    async fn until(producers: &Producers, what: &str, test: impl Fn(ProducerCounts) -> bool) {
        let wait = async {
            loop {
                let changed = producers.changed.notified();
                let mut changed = std::pin::pin!(changed);
                changed.as_mut().enable();
                if test(producers.counts()) {
                    return;
                }
                changed.await;
            }
        };
        if tokio::time::timeout(Duration::from_secs(10), wait).await.is_err() {
            panic!("{what} within 10 s: {:?}", producers.counts());
        }
    }

    /// A walk whose directory read never returns until the sender is dropped; the receiver ends once the producer is
    /// in that read.
    fn hung_listing() -> (Listing, std::sync::mpsc::Sender<()>, oneshot::Receiver<()>) {
        let (release, hung) = std::sync::mpsc::channel::<()>();
        let (entered, in_read) = oneshot::channel::<()>();
        let state = Mutex::new((hung, Some(entered)));
        let listing: Listing = Box::new(std::iter::from_fn(move || {
            let mut state = state.lock().unwrap();
            state.1.take();
            let _ = state.0.recv();
            None
        }));
        (listing, release, in_read)
    }

    /// `wait`'s outcome, at most 10 s.
    async fn within<T>(what: &str, wait: impl Future<Output = T>) -> T {
        tokio::time::timeout(Duration::from_secs(10), wait).await.unwrap_or_else(|_| panic!("{what} within 10 s"))
    }

    fn no_files() -> Opener {
        Box::new(|_| unreachable!("no file is listed"))
    }

    /// A directory read that never returns: the deadline answers at once, and `close` waits its grace and abandons the
    /// thread (counted), which ends when the read returns.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_directory_read_that_never_returns_is_abandoned_after_the_grace() {
        let (_dir, root) = root();
        let producers = Arc::new(Producers::new(MAX_PRODUCERS));
        let (listing, release, _) = hung_listing();
        let started = Instant::now();
        let mut stream = search_over(&producers, &needle_request(&root, Some(started + Duration::from_millis(100))), listing, no_files());
        let err = stream.next().await.unwrap().unwrap_err();
        assert!(matches!(err.kind, FsErrorKind::TimedOut) && err.path.is_none(), "{err:?}");
        assert!(started.elapsed() < Duration::from_secs(1), "the deadline does not wait for the walk");
        let closing = Instant::now();
        stream.close().await;
        assert!(closing.elapsed() >= CLOSE_GRACE && closing.elapsed() < CLOSE_GRACE * 3, "{:?}", closing.elapsed());
        assert_eq!(producers.counts(), ProducerCounts { live: 1, abandoned: 1 }, "the abandoned thread is still in its read");
        drop(release);
        until(&producers, "the abandoned thread ends once its read returns", |c| c == ProducerCounts::default()).await;
    }

    /// A producer held in a read that never returns is counted as abandoned however its stream lets go of it: a `close`
    /// that waits out its grace, a `close` its caller drops before the grace (its deadline or cancellation), and a
    /// dropped stream. Each count ends with the read.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_producer_its_stream_lets_go_of_is_counted_until_it_ends() {
        let (_dir, root) = root();
        let producers = Arc::new(Producers::new(MAX_PRODUCERS));
        let mut released = Vec::new();
        let mut search = async || {
            let (listing, release, in_read) = hung_listing();
            released.push(release);
            let stream = search_over(&producers, &needle_request(&root, None), listing, no_files());
            let _ = within("the producer in its read", in_read).await;
            stream
        };
        let mut closed = search().await;
        closed.close().await;
        assert_eq!(producers.counts(), ProducerCounts { live: 1, abandoned: 1 }, "a close that waited out its grace");
        let mut cut = search().await;
        {
            let close = cut.close();
            let mut close = std::pin::pin!(close);
            let polled = close.as_mut().poll(&mut std::task::Context::from_waker(std::task::Waker::noop()));
            assert!(polled.is_pending(), "the close waits for its producer");
        }
        assert_eq!(producers.counts(), ProducerCounts { live: 2, abandoned: 2 }, "a close its caller dropped");
        drop(search().await);
        assert_eq!(producers.counts(), ProducerCounts { live: 3, abandoned: 3 }, "a dropped stream");
        drop(released);
        until(&producers, "every producer ends once its read returns", |c| c == ProducerCounts::default()).await;
        drop((closed, cut));
    }

    /// Repeated timeouts against reads that never return: each timed-out search's producer is abandoned in its read and
    /// keeps its slot, so the count stops at the cap and later searches wait, answering nothing (their deadline
    /// included, as a search queued in Node's server is not answered); once the reads return, the slots are free and
    /// the waiting searches run: one whose deadline passed while it waited answers timed out, the other its match.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn producers_stop_at_the_cap_and_waiting_searches_run_once_the_stuck_reads_return() {
        const CAP: usize = 3;
        let (_dir, root) = root();
        let file = root.join("a.txt").as_path().to_path_buf();
        std::fs::write(&file, "needle\n").unwrap();
        let producers = Arc::new(Producers::new(CAP));
        let mut released = Vec::new();
        for _ in 0..CAP {
            let (listing, release, in_read) = hung_listing();
            released.push(release);
            let deadline = Instant::now() + Duration::from_millis(50);
            let mut stream = search_over(&producers, &needle_request(&root, Some(deadline)), listing, no_files());
            let _ = within("the producer in its read", in_read).await;
            let err = within("the deadline's answer", stream.next()).await.unwrap().unwrap_err();
            assert!(matches!(err.kind, FsErrorKind::TimedOut), "{err:?}");
            stream.close().await;
        }
        assert_eq!(producers.counts(), ProducerCounts { live: CAP, abandoned: CAP });
        let one_file = || -> (Listing, Opener) {
            let listing: Listing = Box::new(std::iter::once(Ok(Some(file.clone()))));
            (listing, Box::new(|path| Ok(Box::new(File::open(path)?) as Box<dyn Read + Send>)))
        };
        let (listing, open) = one_file();
        let mut late = search_over(&producers, &needle_request(&root, Some(Instant::now())), listing, open);
        let (listing, open) = one_file();
        let mut found = search_over(&producers, &needle_request(&root, None), listing, open);
        assert_eq!(producers.counts(), ProducerCounts { live: CAP, abandoned: CAP }, "no thread past the cap");
        for stream in [&mut late, &mut found] {
            let next = stream.next();
            let mut next = std::pin::pin!(next);
            let polled = next.as_mut().poll(&mut std::task::Context::from_waker(std::task::Waker::noop()));
            assert!(polled.is_pending(), "a search waiting for a slot answers nothing, its passed deadline included");
        }
        drop(released);
        until(&producers, "the stuck producers end once their reads return", |c| c == ProducerCounts::default()).await;
        let err = within("the late search's answer", late.next()).await.unwrap().unwrap_err();
        assert!(matches!(err.kind, FsErrorKind::TimedOut), "{err:?}");
        let hit = within("the waiting search's match", found.next()).await.unwrap().unwrap();
        assert_eq!((hit.path.as_path(), hit.line, hit.text.as_str()), (file.as_path(), 1, "needle"));
        assert!(within("the waiting search's end", found.next()).await.is_none());
        late.close().await;
        found.close().await;
        assert_eq!(producers.counts(), ProducerCounts::default());
    }

    /// The native traversal over a real directory of 2,000 files: every file, in path order.
    #[tokio::test]
    async fn a_walk_lists_a_directory_of_two_thousand_files_in_path_order() {
        let (_dir, root) = root();
        let dir = root.join("many");
        std::fs::create_dir(dir.as_path()).unwrap();
        for i in 0..2_000 {
            std::fs::File::create(dir.as_path().join(format!("{i:04}.txt"))).unwrap();
        }
        let fs = LocalFileService::new();
        let request = WalkRequest { root: root.clone(), recursive: true, include_dirs: false, include_hidden: true, respect_ignore: false, prune: Vec::new() };
        let mut walk = fs.walk(lanes().maintenance, request);
        let mut names = Vec::new();
        while let Some(entry) = walk.next().await {
            names.push(entry.unwrap().path.as_path().file_name().unwrap().to_string_lossy().into_owned());
        }
        walk.close().await;
        let expected: Vec<String> = (0..2_000).map(|i| format!("{i:04}.txt")).collect();
        assert_eq!(names, expected);
    }
}
