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

use std::cell::RefCell;
use std::collections::VecDeque;
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
use std::rc::Rc;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::LazyLock;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::OnceLock;
use std::sync::PoisonError;
use std::time::Duration;

use async_trait::async_trait;
use grep::matcher::Matcher;
use grep::printer::StandardBuilder;
use grep::regex::RegexMatcherBuilder;
use grep::searcher::BinaryDetection;
use grep::searcher::Searcher;
use grep::searcher::SearcherBuilder;
use grep::searcher::Sink;
use grep::searcher::SinkFinish;
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
use mixdog_core_api::domain::fs::SearchClass;
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

    /// The walker runs on its own thread, at most [`QUEUE`] entries and [`QUEUE_BYTES`] ahead of the consumer (see
    /// [`Streamed`]).
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
        let walking = Box::new(Walking { walk: builder.build(), root: root.to_path_buf(), include_dirs: request.include_dirs });
        #[cfg(feature = "replay-controls")]
        let full = request.server.is_some() && deadline_script::queue_full(root);
        #[cfg(not(feature = "replay-controls"))]
        let full = false;
        // A find's inventory is Node's fuzzy request, a glob's (and a walk Node makes itself) a file inventory.
        let search = if request.server == Some(SearchClass::Fuzzy) { "fuzzy" } else { "file inventory" };
        streamed(&PRODUCERS, walking, Deadline::default(), Origin::new(request.server, root, search), full)
    }

    /// The search runs on its own thread, at most [`QUEUE`] matches and [`QUEUE_BYTES`] ahead of the consumer (see
    /// [`Streamed`]).
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
        let place = Place::default();
        let walked = place.clone();
        let listing: Listing = Box::new(builder.build().map(move |item| match item {
            Ok(entry) => {
                let kind = entry.file_type();
                *locked(&walked) = Some((entry.path().to_path_buf(), kind.is_some_and(|t| t.is_dir())));
                Ok(kind.is_some_and(|t| t.is_file()).then(|| entry.into_path()))
            }
            Err(error) => Err(walk_error(&error, &walk_root)),
        }));
        search_with(&PRODUCERS, &request, listing, Box::new(open_to_search), place)
    }
}

/// A file opened for its search, as the search server opens it (`File::open`, serve_search/matching.rs:228). On Unix a
/// FIFO, a socket or a terminal is opened non-blocking and each of its reads waits with `poll` beside the reading
/// thread's cancel ([`unix_io`], [`cancel_io::current`]), so a cancel ends a read no writer would ever answer; any other
/// file reads as `std` reads it.
fn open_to_search(path: &Path) -> io::Result<Box<dyn Read + Send>> {
    #[cfg(unix)]
    return Ok(Box::new(unix_io::open(path, cancel_io::current())?));
    #[cfg(not(unix))]
    Ok(Box::new(File::open(path)?))
}

/// Node's name for a content search's request (`requestKind`, native-search-client.mjs:57-62), which a refusal for a
/// volume of given-up reads names ([`FsErrorKind::CancelStalled`]).
const CONTENT: &str = "content";

/// The volume a path lies on as far as its text tells, never waiting on the volume: on Windows its drive, UNC share or
/// device namespace (the path's prefix), on Unix the device of the mount it lies under in the mount table
/// ([`unix_io::volume_of`], the path taken as it is written). A search is admitted by this until its producer has told
/// its root's volume by the filesystem's identity ([`known_volume`], [`Volumes::start`]).
fn volume_of(path: &Path) -> String {
    #[cfg(windows)]
    {
        use std::path::Component;
        use std::path::Prefix;
        let Some(Component::Prefix(prefix)) = path.components().next() else { return String::new() };
        match prefix.kind() {
            Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) => format!("{}:", char::from(drive).to_ascii_uppercase()),
            Prefix::UNC(server, share) | Prefix::VerbatimUNC(server, share) => {
                format!(r"\\{}\{}", server.to_string_lossy(), share.to_string_lossy()).to_lowercase()
            }
            Prefix::DeviceNS(device) => format!(r"\\.\{}", device.to_string_lossy()).to_lowercase(),
            Prefix::Verbatim(name) => format!(r"\\?\{}", name.to_string_lossy()).to_lowercase(),
        }
    }
    #[cfg(unix)]
    return unix_io::volume_of(path);
    #[cfg(not(any(windows, unix)))]
    {
        let _ = path;
        String::new()
    }
}

/// The volume each searched root was found on by the filesystem's identity, and when ([`Volumes::start`]): a later
/// search of the root is admitted by it before its producer reads ([`Producers::enqueue`], [`admit`]), and one within
/// [`KNOWN_FRESH`] of the finding takes it as its own without asking the filesystem again (about a millisecond each, which
/// a burst of thousands of searches of one root would spend over and over). At most [`KNOWN_ROOTS`] roots; past that it
/// starts again.
static KNOWN: LazyLock<Mutex<std::collections::HashMap<PathBuf, (String, Instant)>>> = LazyLock::new(Default::default);
const KNOWN_ROOTS: usize = 4_096;
const KNOWN_FRESH: Duration = Duration::from_secs(5);

/// The volume `root` is admitted by: the one its last search found it on, else the one its text tells ([`volume_of`]).
fn known_volume(root: &Path) -> String {
    locked(&KNOWN).get(root).map(|(volume, _)| volume.clone()).unwrap_or_else(|| volume_of(root))
}

/// The volume a search of `root` found within [`KNOWN_FRESH`].
#[cfg_attr(not(windows), allow(dead_code))]
fn fresh_volume(root: &Path) -> Option<String> {
    locked(&KNOWN).get(root).filter(|(_, at)| at.elapsed() < KNOWN_FRESH).map(|(volume, _)| volume.clone())
}

fn remember_volume(root: &Path, volume: &str) {
    let mut known = locked(&KNOWN);
    if known.len() >= KNOWN_ROOTS && !known.contains_key(root) {
        known.clear();
    }
    known.insert(root.to_path_buf(), (volume.to_owned(), Instant::now()));
}

/// `root`'s volume by the filesystem's identity: [`volume_id`] on Windows; on Unix the device of the mount its canonical
/// path lies under ([`unix_io::Crossings`]).
#[cfg_attr(not(feature = "replay-controls"), allow(dead_code))]
fn root_volume_id(root: &Path) -> Option<String> {
    #[cfg(windows)]
    return volume_id(root);
    #[cfg(unix)]
    return unix_io::Crossings::new(root).ok().map(|c| c.root_volume()).filter(|v| !v.is_empty());
    #[cfg(not(any(windows, unix)))]
    {
        let _ = root;
        None
    }
}

/// The volume `path` lies on by the filesystem's own identity, on Windows: the volume GUID of the volume mount point
/// `GetVolumePathNameW` finds for it, which follows junctions and mounted folders (`C:\x\j\a`, `j` a junction to a
/// folder of D:, is on D:'s volume); a network share by its `\\server\share` (a mapped drive by the share it maps, a
/// `subst` drive by the folder it stands for). `None` when it cannot be told (a path no volume answers for). It reads
/// on the volumes the path passes through, so only a producer calls it, as its first call ([`Volumes::start`]).
#[cfg(windows)]
fn volume_id(path: &Path) -> Option<String> {
    use std::os::windows::ffi::OsStrExt as _;
    use windows_sys::Win32::Storage::FileSystem::GetVolumeNameForVolumeMountPointW;
    use windows_sys::Win32::Storage::FileSystem::GetVolumePathNameW;
    use windows_sys::Win32::Storage::FileSystem::QueryDosDeviceW;
    let wide = |s: &std::ffi::OsStr| s.encode_wide().chain(Some(0)).collect::<Vec<u16>>();
    let text = |buf: &[u16]| String::from_utf16_lossy(&buf[..buf.iter().position(|&c| c == 0).unwrap_or(buf.len())]);
    let mut resolved = path.to_path_buf();
    // A `subst` drive stands for a folder, which may be on another such drive: a few steps at most.
    for _ in 0..4 {
        let name = wide(resolved.as_os_str());
        let mut point = vec![0u16; 32_768];
        // SAFETY: `name` is NUL-terminated and `point` holds the length given.
        if unsafe { GetVolumePathNameW(name.as_ptr(), point.as_mut_ptr(), point.len() as u32) } == 0 {
            return None;
        }
        let point = text(&point);
        let mut guid = [0u16; 64];
        // SAFETY: the mount point is NUL-terminated and `guid` holds the length given.
        if unsafe { GetVolumeNameForVolumeMountPointW(wide(point.as_ref()).as_ptr(), guid.as_mut_ptr(), guid.len() as u32) } != 0 {
            return Some(text(&guid).to_ascii_lowercase());
        }
        let bare = point.strip_prefix(r"\\?\").unwrap_or(&point);
        let Some(drive) = bare.get(..2).filter(|d| d.ends_with(':') && d.as_bytes()[0].is_ascii_alphabetic()) else {
            return Some(share_key(&point));
        };
        let mut target = vec![0u16; 32_768];
        // SAFETY: the drive name is NUL-terminated and `target` holds the length given.
        if unsafe { QueryDosDeviceW(wide(drive.as_ref()).as_ptr(), target.as_mut_ptr(), target.len() as u32) } == 0 {
            return Some(drive.to_ascii_lowercase());
        }
        let target = text(&target);
        if let Some(share) = redirected_share(&target) {
            return Some(share);
        }
        let Some(folder) = target.strip_prefix(r"\??\") else { return Some(target.to_ascii_lowercase()) };
        let rest: PathBuf = resolved.components().filter(|c| matches!(c, std::path::Component::Normal(_))).collect();
        resolved = PathBuf::from(folder).join(rest);
    }
    None
}

/// A network volume mount point as a key: `\\?\UNC\server\share\` and `\\server\share\` as `\\server\share\`,
/// lowercased.
#[cfg_attr(not(windows), allow(dead_code))]
fn share_key(point: &str) -> String {
    let point = point.strip_prefix(r"\\?\UNC\").map_or_else(|| point.to_owned(), |rest| format!(r"\\{rest}"));
    let mut key = point.to_lowercase();
    if !key.ends_with('\\') {
        key.push('\\');
    }
    key
}

/// The share a mapped drive's device target names (`QueryDosDeviceW`): `\Device\LanmanRedirector\;Z:0000…\srv\share`
/// or `\Device\Mup\;LanmanRedirector\;Z:0000…\srv\share\sub` is `\\srv\share\` ([`share_key`]); `None` for a target
/// that is not a redirected drive.
#[cfg_attr(not(windows), allow(dead_code))]
fn redirected_share(target: &str) -> Option<String> {
    let parts: Vec<&str> = target.split('\\').collect();
    let drive = parts.iter().rposition(|part| part.starts_with(';') && part.contains(':'))?;
    let (server, share) = (parts.get(drive + 1)?, parts.get(drive + 2)?);
    (!server.is_empty() && !share.is_empty()).then(|| share_key(&format!(r"\\{server}\{share}")))
}

/// `request`'s search of the files `listing` names, each read through `open`, its producer counted in `producers`.
#[cfg_attr(not(test), allow(dead_code))]
fn search_over(
    producers: &Arc<Producers>,
    request: &SearchRequest,
    listing: Listing,
    open: Opener,
) -> Box<dyn EventSource<Result<SearchMatch, FsError>>> {
    search_with(producers, request, listing, open, Place::default())
}

/// [`search_over`], the walk's place kept in `place` ([`Volumes`]).
fn search_with(
    producers: &Arc<Producers>,
    request: &SearchRequest,
    listing: Listing,
    open: Opener,
    place: Place,
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
        // The server's searcher (serve_search/matching.rs:164-176), its heap limit included: a line its buffer cannot hold
        // within `search_heap_bytes()` fails the file's search.
        searcher: SearcherBuilder::new()
            .line_number(true)
            .heap_limit(Some(search_heap_bytes()))
            .binary_detection(BinaryDetection::quit(b'\x00'))
            .build(),
        listing,
        open,
        left: request.limit,
        first_per_file: request.first_per_file,
        scope: request.root.as_path().to_path_buf(),
        place,
        #[cfg(feature = "count-jobs")]
        root: request.root.as_path().to_path_buf(),
        #[cfg(feature = "count-jobs")]
        _live: probe::Live::new(request.root.as_path()),
    };
    let origin = || Origin::new(Some(request.class), request.root.as_path(), CONTENT);
    #[cfg(feature = "replay-controls")]
    let after_files = match deadline_script::for_root(request.root.as_path()) {
        Some(deadline_script::Script::Silent) => {
            return streamed(producers, Box::new(deadline_script::Silent { _search: Box::new(searching) }), Deadline::default(), origin(), false);
        }
        Some(deadline_script::Script::Stuck) => {
            // Told now, so the held search is admitted, and given up, on its root's volume however soon its caller lets
            // go of it (a replay's timers pass at once).
            if let Some(volume) = root_volume_id(request.root.as_path()) {
                remember_volume(request.root.as_path(), &volume);
            }
            let held = deadline_script::Held { root: request.root.as_path().to_path_buf() };
            return streamed(producers, Box::new(held), Deadline::default(), origin(), false);
        }
        Some(deadline_script::Script::QueueFull) => return streamed(producers, Box::new(searching), Deadline::default(), origin(), true),
        Some(deadline_script::Script::AfterFiles(n)) => Some(n),
        None => None,
    };
    #[cfg(feature = "replay-controls")]
    let deadline = Deadline { at: request.deadline, after_files };
    #[cfg(not(feature = "replay-controls"))]
    let deadline = Deadline { at: request.deadline };
    streamed(producers, Box::new(searching), deadline, origin(), false)
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

/// The search server's `max_columns` (serve_search/matching.rs:276-277, `.max_columns(500)` with
/// `.max_columns_preview(true)`).
const MAX_COLUMNS: u64 = 500;

/// serve_search/config.rs `search_heap_bytes()` (:82-89, `MIXDOG_SEARCH_HEAP_BYTES`, default 32 MiB, within
/// 1 MiB..=128 MiB): the heap a file's search may take for its line buffer (matching.rs:171). A line the buffer cannot
/// hold within it fails the file's search, so it also bounds what one line of a search holds in memory.
fn search_heap_bytes() -> usize {
    bounded_env("MIXDOG_SEARCH_HEAP_BYTES", 32 << 20, 1 << 20, 128 << 20)
}

/// What the printer writes, shared with the sink that reads each match's line back.
#[derive(Clone, Default)]
struct Printed(Rc<RefCell<Vec<u8>>>);

impl Write for Printed {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.borrow_mut().extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// The text of the one match the printer wrote (`N:` and the line), read as Node's server reads its printer's output
/// (`output_lines`, matching.rs:180-186: decoded lossily, split with `str::lines`) and its client reads the line (the
/// text after the line number's `:`).
fn printed_text(bytes: &[u8]) -> String {
    let output = String::from_utf8_lossy(bytes);
    let line = output.lines().next().unwrap_or("");
    line.split_once(':').map_or(line, |(_, text)| text).to_owned()
}

/// One line per match, printed by the printer Node's search server prints with: grep-printer's standard printer built
/// as serve_search builds it (matching.rs:271-278: no heading, no path, `max_columns(500)` with preview, no colour), fed
/// by the same searcher, so a long line's trigger and preview are the crate's own. The column is the first match's byte
/// start. Stops the file when the request's match budget is spent or the stream is closed.
struct Collect<'a, P> {
    /// The printer's sink, and what it writes.
    printer: P,
    printed: Printed,
    matcher: &'a grep::regex::RegexMatcher,
    path: &'a AbsPath,
    out: &'a Out<SearchMatch>,
    left: &'a mut Option<usize>,
    /// [`SearchRequest::first_per_file`].
    first_per_file: bool,
    /// Matches queued from this file.
    sent: usize,
    /// The stream was closed under the sink.
    closed: bool,
    #[cfg(feature = "count-jobs")]
    root: &'a Path,
}

impl<P: Sink<Error = io::Error>> Sink for Collect<'_, P> {
    type Error = io::Error;

    fn begin(&mut self, searcher: &Searcher) -> Result<bool, io::Error> {
        self.printer.begin(searcher)
    }

    fn binary_data(&mut self, searcher: &Searcher, binary_byte_offset: u64) -> Result<bool, io::Error> {
        self.printer.binary_data(searcher, binary_byte_offset)
    }

    fn finish(&mut self, searcher: &Searcher, finish: &SinkFinish) -> Result<(), io::Error> {
        self.printer.finish(searcher, finish)
    }

    fn matched(&mut self, searcher: &Searcher, found: &SinkMatch<'_>) -> Result<bool, io::Error> {
        if *self.left == Some(0) {
            return Ok(false);
        }
        self.printer.matched(searcher, found)?;
        let text = printed_text(&self.printed.0.take());
        let column = self.matcher.find(found.bytes()).ok().flatten().map_or(0, |m| m.start()) as u64 + 1;
        let line = found.line_number().unwrap_or(0);
        if !self.out.send(Ok(SearchMatch { path: self.path.clone(), line, column, text })) {
            self.closed = true;
            return Ok(false);
        }
        self.sent += 1;
        #[cfg(feature = "count-jobs")]
        probe::found(self.root);
        if let Some(left) = self.left.as_mut() {
            *left -= 1;
        }
        Ok(*self.left != Some(0) && !self.first_per_file)
    }
}

/// Items a stream holds ahead of its consumer, the capacity of its queue; the producer waits while it is full.
pub const QUEUE: usize = 256;

/// The bytes of items a stream holds ahead of its consumer ([`Weigh`]: a match's text and path, an entry's path): the
/// producer waits to queue an item that would take the queue past this. An item larger than this alone waits for an
/// empty queue, so the queue holds at most `QUEUE_BYTES`, or one item when one is larger; a long line's preview (its
/// first 500 grapheme clusters, as the printer writes it) is kept whole, as Node's server prints it.
///
/// What one search holds is bounded by the searcher's heap limit ([`search_heap_bytes`], 32 MiB): a line longer than
/// its buffer can take fails the file's search, as in Node's server (a 100 MB line is such a line: the file answers a
/// read failure, and its buffer stopped growing at the limit). A match's preview is part of its line, so it is at most
/// that too; the producer holds the buffer, the printer's copy of the line it prints and the item it builds from it,
/// beside a queue of `QUEUE_BYTES` or that one item.
pub const QUEUE_BYTES: usize = 1 << 20;

/// What a queued item weighs against [`QUEUE_BYTES`].
trait Weigh {
    fn weight(&self) -> usize;
}

impl Weigh for SearchMatch {
    fn weight(&self) -> usize {
        self.text.len() + self.path.as_path().as_os_str().len()
    }
}

impl Weigh for DirEntry {
    fn weight(&self) -> usize {
        self.path.as_path().as_os_str().len()
    }
}

impl<T: Weigh> Weigh for Result<T, FsError> {
    fn weight(&self) -> usize {
        match self {
            Ok(item) => item.weight(),
            Err(error) => error.path.as_ref().map_or(0, |p| p.as_path().as_os_str().len()),
        }
    }
}

/// How long a producer its stream let go of may take to end before it is given up ([`Producers::give_up`]): Node's
/// `CANCEL_GRACE_MS` (native-search-client.mjs:28), after which its client ends the search server whose search did not
/// stop (`armNativeCancellationWatchdog`, :501-520); `MIXDOG_SEARCH_CANCEL_GRACE_MS` replaces it as there
/// ([`cancel_grace`]).
const CLOSE_GRACE: Duration = Duration::from_secs(1);

/// The bytes one read of a searched file asks for: the stop and the deadline are checked before each, as Node's search
/// server checks them before each read of its 64 KiB chunks (`serve_search/matching.rs`, `CancellableReader`).
const READ_CHUNK: usize = 64 * 1024;

/// The walks Node does not send to its search server (`WalkRequest::server` `None`: the listing, read's same-name scan)
/// that run at once, process-wide; the rest wait for one to end. Node runs those in its own process, unbounded; this
/// bounds the threads they take.
pub const MAX_LOCAL_PRODUCERS: usize = 64;

/// Node's search server's scheduler (b6f10295a `native/mixdog-graph/src/serve_search/scheduler.rs:197-232`), each limit
/// read from the environment variable it reads there, with its default and bounds (`config.rs`), and its client's
/// cancel grace. The streams that stand for a search-server request ([`SearchClass`]) are admitted by these, as the
/// server admits its requests; the other walks by [`MAX_LOCAL_PRODUCERS`].
#[derive(Clone, Copy, Debug)]
pub struct SchedulerConfig {
    /// `server_parallelism()` (config.rs:139-146): `MIXDOG_SEARCH_SERVER_MAX_INFLIGHT` above 0, else the available
    /// parallelism within 2..=8; then within 1..=16. The searches running at once across the three classes.
    pub total: usize,
    /// `interactive_reserve(total)` (config.rs:154-160, `MIXDOG_SEARCH_INTERACTIVE_RESERVE`, 1, at most `total`): the
    /// interactive searches that may run past `total` while one waits (scheduler.rs:292-298).
    pub interactive_reserve: usize,
    /// `bulk_parallelism()` (config.rs:148-152, `MIXDOG_SEARCH_SERVER_MAX_BULK_INFLIGHT` above 0, else 2, at most
    /// `total`).
    pub bulk: usize,
    /// `queue_capacity()` (config.rs:162-169, `MIXDOG_SEARCH_SERVER_QUEUE_CAPACITY`, 2,048, within 1..=8,192): the
    /// searches that may wait.
    pub queue: usize,
    /// `priority_queue_reserve(queue)` (config.rs:171-181): the waiting places a bulk search may not take.
    pub priority_reserve: usize,
    /// `aimd_target()` and `aimd_increase_every()` (config.rs:109-125), which move the bulk window.
    pub aimd_target: Duration,
    pub aimd_increase_every: usize,
    /// The client's cancel grace ([`cancel_grace`]).
    pub grace: Duration,
    /// [`MAX_LOCAL_PRODUCERS`].
    pub local: usize,
    /// [`MAX_STUCK_PER_VOLUME`].
    pub stuck_per_volume: usize,
}

/// The given-up producer threads one volume may hold ([`Producers::give_up`]). Once a volume holds this many, a stream
/// that would read on it is answered with Node's answer to a request whose server was ended for a cancel that did not
/// take ([`FsErrorKind::CancelStalled`]): at once when made or admitted, starting no thread, or by its producer before
/// a call that would read on it. Node gives that answer too, after its client ended the stuck server
/// (native-search-client.mjs:501-520); here it comes sooner, without the wait. The count falls as the stuck reads
/// return. The searches already reading on the volume when it reached this many may still be given up: the threads one
/// volume holds never pass [`SchedulerConfig::max_stranded_per_volume`].
pub const MAX_STUCK_PER_VOLUME: usize = 8;

impl SchedulerConfig {
    fn from_env() -> Self {
        let available = std::thread::available_parallelism().map_or(2, |n| n.get());
        let total = positive_env("MIXDOG_SEARCH_SERVER_MAX_INFLIGHT").unwrap_or_else(|| available.clamp(2, 8)).clamp(1, 16);
        let queue = bounded_env("MIXDOG_SEARCH_SERVER_QUEUE_CAPACITY", 2_048, 1, 8_192);
        let priority_reserve =
            if queue <= 1 { 0 } else { bounded_env("MIXDOG_SEARCH_PRIORITY_QUEUE_RESERVE", queue.div_ceil(8).clamp(1, 64), 1, queue - 1) };
        Self {
            total,
            interactive_reserve: env_usize("MIXDOG_SEARCH_INTERACTIVE_RESERVE").unwrap_or(1).min(total),
            bulk: positive_env("MIXDOG_SEARCH_SERVER_MAX_BULK_INFLIGHT").unwrap_or(2).min(total),
            queue,
            priority_reserve,
            aimd_target: Duration::from_millis(bounded_env("MIXDOG_SEARCH_AIMD_TARGET_MS", 250, 10, 10_000) as u64),
            aimd_increase_every: bounded_env("MIXDOG_SEARCH_AIMD_INCREASE_EVERY", 8, 1, 1_024),
            grace: cancel_grace(),
            local: MAX_LOCAL_PRODUCERS,
            stuck_per_volume: MAX_STUCK_PER_VOLUME,
        }
    }

    /// The given-up threads one volume can ever hold: `stuck_per_volume - 1` plus the producers that can run at once
    /// (`total + interactive_reserve + local`): 8 - 1 + 8 + 1 + 64 = 80 with the defaults on 8 or more cores. A producer
    /// names a volume as the one it reads on ([`Ticket::reading`], at its admission and before a call that reads on
    /// another, [`Producers::reading`]) only while that volume holds fewer than `stuck_per_volume`, under the lock its
    /// give-up is counted under; so given-up threads plus producers reading on the volume grow only by such a naming, to
    /// at most `stuck_per_volume - 1` plus every producer, and a give-up moves one from the second to the first.
    pub fn max_stranded_per_volume(&self) -> usize {
        self.stuck_per_volume - 1 + self.total + self.interactive_reserve + self.local
    }

    /// `queue_admission_capacity` (config.rs:183-193): a bulk search is queued while fewer than the capacity less the
    /// priority reserve wait, any other while fewer than the capacity wait (scheduler.rs:234-247).
    fn admission(&self, class: SearchClass) -> usize {
        if class == SearchClass::Bulk { self.queue.saturating_sub(self.priority_reserve).max(1) } else { self.queue }
    }
}

/// serve_search/config.rs `bounded_env_usize` (:39-45) and `positive_env_usize` (:49-54).
fn env_usize(name: &str) -> Option<usize> {
    std::env::var(name).ok().and_then(|raw| raw.parse::<usize>().ok())
}

fn bounded_env(name: &str, default: usize, min: usize, max: usize) -> usize {
    env_usize(name).unwrap_or(default).clamp(min, max)
}

fn positive_env(name: &str) -> Option<usize> {
    env_usize(name).filter(|n| *n > 0)
}

/// `cancelGraceMs()` (native-search-client.mjs:489-493): `MIXDOG_SEARCH_CANCEL_GRACE_MS` when it is a number above 0
/// (whole milliseconds, at least 1), else [`CLOSE_GRACE`].
fn cancel_grace() -> Duration {
    std::env::var("MIXDOG_SEARCH_CANCEL_GRACE_MS")
        .ok()
        .and_then(|raw| raw.trim().parse::<f64>().ok())
        .filter(|ms| ms.is_finite() && *ms > 0.0)
        .map_or(CLOSE_GRACE, |ms| Duration::from_millis(ms.floor().max(1.0) as u64))
}

/// Every stream's producer threads, process-wide, as one Node process has one search server.
static PRODUCERS: LazyLock<Arc<Producers>> = LazyLock::new(|| Arc::new(Producers::new(SchedulerConfig::from_env())));

/// The stream producer threads alive now, process-wide ([`Producers`]).
pub fn producer_counts() -> ProducerCounts {
    PRODUCERS.counts()
}

/// What [`Producers`] counts.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ProducerCounts {
    /// Producers holding a slot: started, or admitted and about to start, and neither ended nor given up.
    pub live: usize,
    /// Of those, the ones their stream has let go of (closed, or dropped, a `close` cut short included) that are still
    /// running: a thread held in a blocking OS call (a directory read, an open or a read on a dead network share, a
    /// pipe) whose call is being cancelled ([`cancel_io`]). Each ends when its call returns, or is given up once the
    /// cancel grace has passed ([`Producers::give_up`]); nothing waits for it.
    pub abandoned: usize,
    /// Streams waiting for a slot, no thread yet.
    pub waiting: usize,
    /// Producer threads given up that have not ended, over every volume: each held a call the cancel did not end within
    /// its grace, holds no slot, and ends by itself if its call ever returns. Not a counter: each such thread holds a
    /// mark of its volume ([`Ticket::stuck`]) until it ends, and these are the marks alive.
    pub stalled: usize,
}

/// A producer's state, changed only under [`Producers`]' lock, so each start, release, give-up and end is counted once.
const WAITING: u8 = 0;
const RUNNING: u8 = 1;
const RELEASED: u8 = 2;
const ENDED: u8 = 3;
const STALLED: u8 = 4;

/// A stream's place in its [`Producers`]: its state ([`WAITING`] to [`ENDED`]), the server class whose slot it takes
/// (`None`: a walk Node does not send to its server), and when it was queued and started, the samples the bulk window
/// moves by (scheduler.rs `execute_scheduled_search`, :447-489).
struct Ticket {
    state: AtomicU8,
    class: Option<SearchClass>,
    queued_at: Instant,
    started_at: OnceLock<Instant>,
    /// The stream's root, the volume it was admitted by when made, and Node's name for its request ([`Origin`]).
    root: PathBuf,
    volume: String,
    search: &'static str,
    /// The volume its producer reads on now ([`Producers::reading`]), changed under the scheduler's lock: set at its
    /// admission, then named by the producer before a call that reads on another; a give-up charges it.
    reading: Mutex<Option<String>>,
    /// Its refusal at admission ([`admit`]): it never started.
    refused: OnceLock<FsErrorKind>,
    /// The scheduler the producer's end is reported to, taken by whichever comes first: the end of the producer's
    /// threads ([`Started`]), which reports it, or its give-up ([`Producers::give_up`]), which settles everything at
    /// once. A given-up thread so holds no reference to the scheduler, and its end touches nothing of it.
    owner: Mutex<Option<Arc<Producers>>>,
    /// Set when the producer is given up: its volume's mark ([`Volume`]), dropped when its thread ends, which is how the
    /// volume's count of given-up threads falls.
    stuck: Mutex<Option<Arc<()>>>,
    /// Notified when the scheduler admits this stream ([`admit`]): only the stream given the slot wakes, however many
    /// wait.
    admitted: Notify,
    /// Its place in the streams made, in order ([`probe::answer_order`]).
    #[cfg(feature = "count-jobs")]
    seq: u64,
}

impl Ticket {
    /// The ticket of a stream with a producer, reported to `owner`.
    fn new(origin: Origin, owner: &Arc<Producers>) -> Arc<Self> {
        let Origin { server, root, volume, search } = origin;
        Arc::new(Self {
            state: AtomicU8::new(ENDED),
            class: server,
            queued_at: Instant::now(),
            started_at: OnceLock::new(),
            root,
            volume,
            search,
            reading: Mutex::new(None),
            refused: OnceLock::new(),
            owner: Mutex::new(Some(owner.clone())),
            stuck: Mutex::new(None),
            admitted: Notify::new(),
            #[cfg(feature = "count-jobs")]
            seq: probe::stream_made(),
        })
    }

    /// Its producer is about to make a call that reads on `volume` ([`Producers::reading`]); `Err(None)` once it was given
    /// up (its scheduler is no longer its own): it stops.
    fn read_on(&self, volume: &str) -> Result<(), Option<FsErrorKind>> {
        let owner = locked(&self.owner).clone();
        owner.map_or(Err(None), |producers| producers.reading(self, volume))
    }

    /// The ticket of a stream that is one item, no producer.
    fn detached() -> Arc<Self> {
        Arc::new(Self {
            state: AtomicU8::new(ENDED),
            class: None,
            queued_at: Instant::now(),
            started_at: OnceLock::new(),
            root: PathBuf::new(),
            volume: String::new(),
            search: CONTENT,
            reading: Mutex::new(None),
            refused: OnceLock::new(),
            owner: Mutex::new(None),
            stuck: Mutex::new(None),
            admitted: Notify::new(),
            #[cfg(feature = "count-jobs")]
            seq: u64::MAX,
        })
    }
}

/// What a stream stands for: the search-server request class it is admitted as (`None`: a walk Node does not send to
/// its server, [`SchedulerConfig::local`]), its root and the volume it is admitted by ([`known_volume`]), and Node's
/// name for its request's kind (`requestKind`, native-search-client.mjs:57-62: `content`, `file inventory`, `fuzzy`).
struct Origin {
    server: Option<SearchClass>,
    root: PathBuf,
    volume: String,
    search: &'static str,
}

impl Origin {
    fn new(server: Option<SearchClass>, root: &Path, search: &'static str) -> Self {
        Self { server, root: root.to_path_buf(), volume: known_volume(root), search }
    }
}

/// One volume's given-up producer threads: each holds a clone of `marks` until it ends ([`Ticket::stuck`]), so their
/// number is the clones alive besides this one. `last`: Node's name for the request of the latest one given up, which
/// the volume's refusals name, as Node's names the request whose cancel stalled.
struct Volume {
    marks: Arc<()>,
    last: &'static str,
}

impl Volume {
    fn stuck(&self) -> usize {
        Arc::strong_count(&self.marks) - 1
    }
}

/// `mutex`'s value, a poisoned lock taken as it is.
fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The scheduler's state (scheduler.rs `SchedulerState`, :58-74): the waiting streams of each class in arrival order,
/// the running ones of each class (interactive, fuzzy, bulk) and the bulk window, beside the walks Node does not queue.
struct Sched {
    counts: ProducerCounts,
    interactive: VecDeque<Arc<Ticket>>,
    fuzzy: VecDeque<Arc<Ticket>>,
    bulk: VecDeque<Arc<Ticket>>,
    local: VecDeque<Arc<Ticket>>,
    inflight: [usize; 3],
    local_live: usize,
    bulk_window: usize,
    healthy_completions: usize,
    /// The given-up threads of each volume a producer was given up on.
    volumes: std::collections::HashMap<String, Volume>,
}

impl Sched {
    /// `queue_depth()` (scheduler.rs:93-100): the searches waiting across the three classes.
    fn queue_depth(&self) -> usize {
        self.interactive.len() + self.fuzzy.len() + self.bulk.len()
    }

    fn queue(&mut self, class: Option<SearchClass>) -> &mut VecDeque<Arc<Ticket>> {
        match class {
            Some(SearchClass::Interactive) => &mut self.interactive,
            Some(SearchClass::Fuzzy) => &mut self.fuzzy,
            Some(SearchClass::Bulk) => &mut self.bulk,
            None => &mut self.local,
        }
    }
}

fn class_index(class: SearchClass) -> usize {
    match class {
        SearchClass::Interactive => 0,
        SearchClass::Fuzzy => 1,
        SearchClass::Bulk => 2,
    }
}

/// The refusal of a stream that would read on `volume`, once it holds [`SchedulerConfig::stuck_per_volume`] given-up
/// threads: Node's answer naming the latest one's request and the cancel grace.
fn stalled_on(config: &SchedulerConfig, volumes: &std::collections::HashMap<String, Volume>, volume: &str) -> Option<FsErrorKind> {
    let volume = volumes.get(volume).filter(|v| v.stuck() >= config.stuck_per_volume)?;
    let grace_ms = u64::try_from(config.grace.as_millis()).unwrap_or(u64::MAX);
    Some(FsErrorKind::CancelStalled { search: volume.last.to_owned(), grace_ms })
}

/// The volume a stream is admitted by: the one its root was last found on, else the one it was made with.
fn admission_volume(ticket: &Ticket) -> String {
    locked(&KNOWN).get(&ticket.root).map_or_else(|| ticket.volume.clone(), |(volume, _)| volume.clone())
}

/// Moves waiting streams of one queue to running while the queue's own count stays under `limit` and the total under
/// `ceiling` (scheduler.rs `admit_class`, :360-377). One whose volume holds as many given-up threads as one may is
/// answered instead, its refusal its one item, and takes no slot ([`stalled_on`]); one admitted reads on its volume
/// ([`Ticket::reading`]).
fn admit(
    queue: &mut VecDeque<Arc<Ticket>>,
    inflight: &mut usize,
    (limit, ceiling): (usize, usize),
    total: &mut usize,
    counts: &mut ProducerCounts,
    (config, volumes): (&SchedulerConfig, &std::collections::HashMap<String, Volume>),
) {
    while *inflight < limit && *total < ceiling {
        let Some(ticket) = queue.pop_front() else { break };
        counts.waiting -= 1;
        let volume = admission_volume(&ticket);
        if let Some(refusal) = stalled_on(config, volumes, &volume) {
            ticket.state.store(ENDED, Ordering::SeqCst);
            let _ = ticket.refused.set(refusal);
            #[cfg(feature = "count-jobs")]
            probe::answered(ticket.seq);
            ticket.admitted.notify_one();
            continue;
        }
        *inflight += 1;
        *total += 1;
        counts.live += 1;
        *locked(&ticket.reading) = Some(volume);
        ticket.state.store(RUNNING, Ordering::SeqCst);
        ticket.admitted.notify_one();
    }
}

/// The producer threads of a set of streams, admitted as Node's search server admits its searches ([`SchedulerConfig`]).
/// A stream's state moves through [`WAITING`] (queued), [`RUNNING`] (a slot is its), [`RELEASED`] (its stream let go of
/// it while it ran: abandoned until it ends), [`STALLED`] (given up: its slot back, its thread running on) and [`ENDED`];
/// the counts change with it, under one lock, whichever of the stream (close, drop), the canceller (the grace) and the
/// thread (its end) gets there first.
pub struct Producers {
    config: SchedulerConfig,
    sched: Mutex<Sched>,
    /// Notified on every change of the counts.
    changed: Notify,
}

impl Producers {
    fn new(config: SchedulerConfig) -> Self {
        Self {
            config,
            sched: Mutex::new(Sched {
                counts: ProducerCounts::default(),
                interactive: VecDeque::new(),
                fuzzy: VecDeque::new(),
                bulk: VecDeque::new(),
                local: VecDeque::new(),
                inflight: [0; 3],
                local_live: 0,
                bulk_window: config.bulk.max(1),
                healthy_completions: 0,
                volumes: std::collections::HashMap::new(),
            }),
            changed: Notify::new(),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Sched> {
        locked(&self.sched)
    }

    fn counts(&self) -> ProducerCounts {
        let s = self.lock();
        ProducerCounts { stalled: s.volumes.values().map(Volume::stuck).sum(), ..s.counts }
    }

    /// A new stream joins its queue and starts at once if [`Producers::dispatch`] gives it a slot (`Ok(true)`), or else
    /// waits (`Ok(false)`). Refused (its one item):
    /// - one that would read on a volume holding [`SchedulerConfig::stuck_per_volume`] given-up threads
    ///   ([`FsErrorKind::CancelStalled`], naming the latest one's request and the cancel grace);
    /// - one that stands for a search-server request and finds as many searches waiting as its class may join
    ///   ([`FsErrorKind::Saturated`]), as `SearchScheduler::enqueue` refuses it (scheduler.rs:234-247; the answer,
    ///   server.rs:370-394). `full`: a replay's scripted full queue ([`deadline_script`]).
    fn enqueue(&self, ticket: &Arc<Ticket>, full: bool) -> Result<bool, FsErrorKind> {
        let mut s = self.lock();
        if let Some(refusal) = stalled_on(&self.config, &s.volumes, &admission_volume(ticket)) {
            #[cfg(feature = "count-jobs")]
            probe::answered(ticket.seq);
            return Err(refusal);
        }
        if let Some(class) = ticket.class {
            if full || s.queue_depth() >= self.config.admission(class) {
                #[cfg(feature = "count-jobs")]
                probe::answered(ticket.seq);
                return Err(FsErrorKind::Saturated);
            }
        }
        ticket.state.store(WAITING, Ordering::SeqCst);
        s.queue(ticket.class).push_back(ticket.clone());
        s.counts.waiting += 1;
        self.dispatch(&mut s);
        drop(s);
        self.changed.notify_waiters();
        Ok(ticket.state.load(Ordering::SeqCst) == RUNNING)
    }

    /// Gives free slots to waiting streams as the server's dispatcher does, one pass per change (scheduler.rs
    /// `dispatch_searches`, :379-421): interactive ones first, up to `total` and the interactive reserve while one waits
    /// (`interactive_dispatch_ceiling`, :292-298), then fuzzy ones up to `total`, then bulk ones up to `total` within the
    /// adaptive bulk limit (`adaptive_bulk_limit`, :300-307: the window, one while an interactive search runs or waits);
    /// then the walks Node does not queue, up to [`SchedulerConfig::local`].
    ///
    /// The server's dispatcher is a thread of its own, so a burst can queue several searches before it runs: here each is
    /// dispatched as it arrives, which is the server's admission when its dispatcher keeps up.
    fn dispatch(&self, s: &mut Sched) {
        let c = &self.config;
        let mut total = s.inflight.iter().sum::<usize>();
        let ceiling = c.total + if s.interactive.is_empty() { 0 } else { c.interactive_reserve };
        let stuck = (c, &s.volumes);
        admit(&mut s.interactive, &mut s.inflight[0], (c.total + c.interactive_reserve, ceiling), &mut total, &mut s.counts, stuck);
        admit(&mut s.fuzzy, &mut s.inflight[1], (c.total, c.total), &mut total, &mut s.counts, stuck);
        let adaptive = c.bulk.min(s.bulk_window.max(1));
        let bulk = if s.inflight[0] > 0 || !s.interactive.is_empty() { adaptive.min(1) } else { adaptive };
        admit(&mut s.bulk, &mut s.inflight[2], (bulk, c.total), &mut total, &mut s.counts, stuck);
        let mut walks = s.local_live;
        admit(&mut s.local, &mut s.local_live, (c.local, c.local), &mut walks, &mut s.counts, stuck);
    }

    /// `ticket`'s producer is about to make a call that reads on `volume`: it reads on it from now on, unless the volume
    /// holds as many given-up threads as one may (its refusal, `Err(Some)`), or the producer was given up or ended
    /// (`Err(None)`: it stops; one let go of and not yet given up still names its calls, which a give-up charges). Under
    /// the lock a give-up is counted under, so a volume at its bound gains no producer reading on it
    /// ([`SchedulerConfig::max_stranded_per_volume`]).
    fn reading(&self, ticket: &Ticket, volume: &str) -> Result<(), Option<FsErrorKind>> {
        let s = self.lock();
        if !matches!(ticket.state.load(Ordering::SeqCst), RUNNING | RELEASED) {
            return Err(None);
        }
        let mut reading = locked(&ticket.reading);
        if volume.is_empty() || reading.as_deref() == Some(volume) {
            return Ok(());
        }
        if let Some(refusal) = stalled_on(&self.config, &s.volumes, volume) {
            return Err(Some(refusal));
        }
        *reading = Some(volume.to_owned());
        Ok(())
    }

    /// `ticket`'s slot is free.
    fn free(s: &mut Sched, ticket: &Ticket) {
        s.counts.live -= 1;
        match ticket.class {
            Some(class) => s.inflight[class_index(class)] -= 1,
            None => s.local_live -= 1,
        }
    }

    /// `ticket`'s stream lets go of its producer: one waiting leaves its queue, one admitted that never started gives its
    /// slot back, and one running is abandoned until it ends or is given up, its blocking OS call, if it is in one,
    /// cancelled through `thread` and its `interrupt` ([`cancel_io`]).
    fn release(self: &Arc<Self>, ticket: &Arc<Ticket>, thread: Option<std::thread::JoinHandle<()>>, interrupt: Option<Arc<cancel_io::Interrupt>>) {
        let mut s = self.lock();
        match (ticket.state.load(Ordering::SeqCst), thread) {
            (RUNNING, Some(thread)) => {
                ticket.state.store(RELEASED, Ordering::SeqCst);
                s.counts.abandoned += 1;
                drop(s);
                self.changed.notify_waiters();
                cancel_io::until_ended(thread, interrupt, ticket.clone(), self.clone());
                return;
            }
            (RUNNING, None) => {
                ticket.state.store(ENDED, Ordering::SeqCst);
                Self::free(&mut s, ticket);
            }
            (WAITING, _) => {
                ticket.state.store(ENDED, Ordering::SeqCst);
                s.queue(ticket.class).retain(|t| !Arc::ptr_eq(t, ticket));
                s.counts.waiting -= 1;
            }
            _ => return,
        }
        self.dispatch(&mut s);
        drop(s);
        self.changed.notify_waiters();
    }

    /// `ticket`'s producer, let go of and still running when the cancel grace has passed, is given up, as Node's client
    /// ends a search server whose search did not stop within it (native-search-client.mjs:501-520) and its next search
    /// starts a new server. Everything is settled now: the slot is free, the counts and the bulk window (started again,
    /// as a new server's) are the scheduler's, and the scheduler is taken from the ticket, so the thread, which runs on
    /// until its call returns, reports nothing and holds no reference to it ([`Started`]). It holds its volume's mark
    /// instead ([`Volume`]) until it ends: the mark of the volume it was reading on ([`Ticket::reading`]), counted under
    /// the lock admission and [`Producers::reading`] check it under. A thread that took the scheduler first is ending,
    /// and its end settles it.
    fn give_up(&self, ticket: &Ticket) {
        let mut s = self.lock();
        if ticket.state.load(Ordering::SeqCst) != RELEASED {
            return;
        }
        let charged = locked(&ticket.reading).clone().unwrap_or_else(|| ticket.volume.clone());
        let volume = s.volumes.entry(charged).or_insert_with(|| Volume { marks: Arc::new(()), last: ticket.search });
        // The mark is the ticket's before the scheduler is taken: an end that comes between takes it back ([`Started`]).
        *locked(&ticket.stuck) = Some(volume.marks.clone());
        if locked(&ticket.owner).take().is_none() {
            locked(&ticket.stuck).take();
            return;
        }
        volume.last = ticket.search;
        ticket.state.store(STALLED, Ordering::SeqCst);
        s.counts.abandoned -= 1;
        Self::free(&mut s, ticket);
        s.bulk_window = self.config.bulk.max(1);
        s.healthy_completions = 0;
        self.dispatch(&mut s);
        drop(s);
        self.changed.notify_waiters();
    }

    /// `ticket`'s producer threads ended while the scheduler was theirs (it was not given up): its slot is free.
    fn end(&self, ticket: &Ticket) {
        let mut s = self.lock();
        if ticket.state.swap(ENDED, Ordering::SeqCst) == RELEASED {
            s.counts.abandoned -= 1;
        }
        Self::free(&mut s, ticket);
        #[cfg(feature = "count-jobs")]
        probe::answered(ticket.seq);
        if ticket.class.is_some() {
            self.observe(&mut s, ticket);
        }
        self.dispatch(&mut s);
        drop(s);
        self.changed.notify_waiters();
    }

    /// The bulk window after a search ends (scheduler.rs `observe_scheduler_latency`, :324-357): halved after a search
    /// that waited or ran past the AIMD target, widened by one after `aimd_increase_every` quick ones in a row while no
    /// interactive search waits.
    fn observe(&self, s: &mut Sched, ticket: &Ticket) {
        let started = ticket.started_at.get().copied().unwrap_or(ticket.queued_at);
        let queued = started.saturating_duration_since(ticket.queued_at);
        let ran = started.elapsed();
        let (target, bulk) = (self.config.aimd_target, self.config.bulk);
        if queued > target || ran > target {
            s.bulk_window = s.bulk_window.max(1).div_ceil(2);
            s.healthy_completions = 0;
        } else if queued <= target / 4 && ran <= target && s.interactive.is_empty() && s.bulk_window < bulk {
            s.healthy_completions += 1;
            if s.healthy_completions >= self.config.aimd_increase_every {
                s.bulk_window = (s.bulk_window + 1).min(bulk);
                s.healthy_completions = 0;
            }
        } else {
            s.healthy_completions = 0;
        }
    }
}

/// A started producer's hold on its slot, shared by its threads ([`Hold`]) and let go of when the last of them ends,
/// however it ends: then, in this order, the end is reported to the scheduler unless the producer was given up (the
/// scheduler is the ticket's until then, [`Producers::give_up`]), a given-up thread's volume mark is dropped, and the end
/// `close` waits for is sent.
struct Started {
    ticket: Arc<Ticket>,
    _done: oneshot::Sender<()>,
}

/// A producer thread's share of its [`Started`].
type Hold = Arc<Started>;

impl Drop for Started {
    fn drop(&mut self) {
        // A given-up thread that returns late comes here and to [`IoLink::answer`], taking the ticket's and the link's
        // locks and nothing of the scheduler's. Those cannot hold it or be left half-changed: the others that take them
        // (the give-up and [`Ticket::read_on`] the owner and the mark, the scan and `Control::halt` the link's state) hold
        // them only for a few assignments, never across a call that can block, and each lock guards only its own value,
        // read whole after a poisoning ([`locked`]).
        let owner = locked(&self.ticket.owner).take();
        if let Some(producers) = owner {
            producers.end(&self.ticket);
        }
        drop(locked(&self.ticket.stuck).take());
        #[cfg(feature = "count-jobs")]
        probe::ended();
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
    /// Set by `close` and by dropping the stream ([`Control::halt`]): the producer ends at its next check.
    stop: AtomicBool,
    /// The bytes of the items in the queue ([`QUEUE_BYTES`]).
    queued: Mutex<usize>,
    /// Notified when the queue's bytes go down and when the stream stops.
    room: Condvar,
    deadline: Deadline,
    /// Files searched that had matches (for [`Deadline::after_files`]).
    #[cfg(feature = "replay-controls")]
    files_with_lines: AtomicUsize,
    /// The producer is inside one file's search. A deadline that passes now is reported by the file's next read; a read
    /// that never returns leaves the stream unanswered, as Node's server, stuck in a file, never answers.
    in_file: AtomicBool,
    /// A text search's link to the thread making its blocking calls ([`IoLink`]), woken by [`Control::halt`].
    link: OnceLock<Arc<IoLink>>,
}

impl Control {
    fn new(deadline: Deadline) -> Self {
        Self {
            stop: AtomicBool::new(false),
            queued: Mutex::new(0),
            room: Condvar::new(),
            deadline,
            #[cfg(feature = "replay-controls")]
            files_with_lines: AtomicUsize::new(0),
            in_file: AtomicBool::new(false),
            link: OnceLock::new(),
        }
    }

    fn stopped(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }

    /// Stops the producer, waking it if it waits for room in the queue or for a blocking call's answer.
    fn halt(&self) {
        self.stop.store(true, Ordering::SeqCst);
        {
            let _queued = locked(&self.queued);
            self.room.notify_all();
        }
        if let Some(link) = self.link.get() {
            link.wake();
        }
    }

    /// Takes `weight` bytes of the queue, waiting while they would take it past [`QUEUE_BYTES`] (an item larger than
    /// that waits for an empty queue); `false` once the stream is stopped.
    fn reserve(&self, weight: usize) -> bool {
        let mut queued = self.queued.lock().unwrap_or_else(PoisonError::into_inner);
        loop {
            if self.stopped() {
                return false;
            }
            if *queued == 0 || *queued + weight <= QUEUE_BYTES {
                *queued += weight;
                return true;
            }
            queued = self.room.wait(queued).unwrap_or_else(PoisonError::into_inner);
        }
    }

    /// The consumer took an item of `weight` bytes off the queue.
    fn taken(&self, weight: usize) {
        let mut queued = self.queued.lock().unwrap_or_else(PoisonError::into_inner);
        // A stream that is one error ([`one_item`]) queued it without reserving it.
        *queued = queued.saturating_sub(weight);
        self.room.notify_all();
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

impl<T> Clone for Out<T> {
    fn clone(&self) -> Self {
        Self { tx: self.tx.clone(), ctl: self.ctl.clone() }
    }
}

impl<T: Weigh> Out<T> {
    /// Queues `item`, waiting while the queue is full, in items or in bytes; `false` once the stream is stopped or gone.
    fn send(&self, item: Result<T, FsError>) -> bool {
        self.ctl.reserve(item.weight()) && !self.ctl.stopped() && self.tx.blocking_send(item).is_ok()
    }
}

fn timed_out(path: Option<AbsPath>) -> FsError {
    FsError::new(FsErrorKind::TimedOut, path)
}

/// A stream's producer: runs on a thread of its own, the stream's thread, until it is done or stopped.
trait Produce<T>: Send {
    /// Sends every item through `out`; returns once done, once `out` refuses an item, or at a check that finds the
    /// stream stopped. `hold` is the producer's slot: a thread the producer starts holds a clone of it.
    fn run(self: Box<Self>, out: Out<T>, hold: Hold);
}

struct Walking {
    walk: ignore::Walk,
    root: PathBuf,
    include_dirs: bool,
}

impl Produce<DirEntry> for Walking {
    fn run(self: Box<Self>, out: Out<DirEntry>, hold: Hold) {
        let out = &out;
        let refused = |refusal: Option<FsErrorKind>| {
            if let Some(refusal) = refusal {
                out.send(Err(FsError::new(refusal, None)));
            }
        };
        let mut volumes = Volumes::new(hold.ticket.clone(), &self.root);
        if let Err(refusal) = volumes.start() {
            return refused(refusal);
        }
        let mut walk = self.walk;
        let mut last: Option<(PathBuf, bool)> = None;
        loop {
            if out.ctl.stopped() {
                return;
            }
            if let Err(refusal) = volumes.step(last.as_ref().map(|(path, dir)| (path.as_path(), *dir))) {
                return refused(refusal);
            }
            let Some(item) = walk.next() else { return };
            if let Ok(entry) = &item {
                last = Some((entry.path().to_path_buf(), entry.file_type().is_some_and(|t| t.is_dir())));
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
    /// The file lies on a volume holding as many given-up threads as one may ([`Volumes`]): the search's answer.
    Refused(FsErrorKind),
}

impl std::fmt::Display for Halt {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Halt::Stopped => "search stopped",
            Halt::Deadline => "search deadline passed",
            Halt::Refused(_) => "the file's volume holds as many given-up reads as one may",
        })
    }
}

impl std::error::Error for Halt {}

fn halt_of(error: &io::Error) -> Option<&Halt> {
    error.get_ref()?.downcast_ref::<Halt>()
}

/// What a text search asks of the thread making its blocking calls ([`serve`]).
enum Ask {
    /// The walk's next entry.
    Next,
    /// Open this file (the previous one is closed).
    Open(PathBuf),
    /// Read at most this many bytes of the open file.
    Read(usize),
}

/// That thread's answer; a read's bytes are in [`IoState::bytes`].
enum Answer {
    Next(Option<Result<Option<PathBuf>, FsError>>),
    Open(io::Result<()>),
    Read(io::Result<usize>),
}

#[derive(Default)]
struct IoState {
    asked: Option<Ask>,
    answer: Option<Answer>,
    /// The bytes of the last read, handed over.
    bytes: Vec<u8>,
    /// The scan has ended: the serving thread ends at its next turn, and drops a late answer.
    done: bool,
}

/// The link between a text search's scan and the thread making its blocking calls: the walk's directory reads, the
/// opens and the reads of the files. The scan holds the matcher, the searcher with its buffers (up to the heap limit),
/// the printer and the queue; it never makes a call that can block, so a stopped stream's scan ends at once and frees
/// all of that. The serving thread is the one a cancel reaches ([`cancel_io`]) and the one given up when its call does
/// not return ([`Producers::give_up`]); what it holds then is fixed: the walk's position (its open directories and the
/// ignore rules of the folders it is in), the open file, one buffer of [`READ_CHUNK`] bytes, its own [`Hold`] and this
/// link, whose buffer the scan's end frees.
#[derive(Default)]
struct IoLink {
    state: Mutex<IoState>,
    changed: Condvar,
}

impl IoLink {
    /// Asks the serving thread and waits for its answer, with the state still locked so a read's bytes can be taken;
    /// `None` once the stream is stopped (the serving thread may still be in its call).
    fn ask(&self, ctl: &Control, ask: Ask) -> Option<(Answer, MutexGuard<'_, IoState>)> {
        let mut state = locked(&self.state);
        state.asked = Some(ask);
        self.changed.notify_all();
        loop {
            if let Some(answer) = state.answer.take() {
                return Some((answer, state));
            }
            if ctl.stopped() {
                return None;
            }
            state = self.changed.wait(state).unwrap_or_else(PoisonError::into_inner);
        }
    }

    /// The serving thread's next ask; `None` once the scan has ended.
    fn next_ask(&self) -> Option<Ask> {
        let mut state = locked(&self.state);
        loop {
            if state.done {
                return None;
            }
            if let Some(ask) = state.asked.take() {
                return Some(ask);
            }
            state = self.changed.wait(state).unwrap_or_else(PoisonError::into_inner);
        }
    }

    /// Hands `answer`, and a read's `bytes`, to the scan; `false` once the scan has ended.
    fn answer(&self, answer: Answer, bytes: &[u8]) -> bool {
        let mut state = locked(&self.state);
        if state.done {
            return false;
        }
        state.bytes.clear();
        state.bytes.extend_from_slice(bytes);
        state.answer = Some(answer);
        self.changed.notify_all();
        true
    }

    /// The scan has ended, done or stopped: its buffer is freed, and the serving thread ends at its next turn.
    fn finish(&self) {
        let mut state = locked(&self.state);
        state.done = true;
        state.bytes = Vec::new();
        state.asked = None;
        state.answer = None;
        self.changed.notify_all();
    }

    /// Wakes a scan waiting for an answer: its stream stopped.
    fn wake(&self) {
        let _state = locked(&self.state);
        self.changed.notify_all();
    }
}

/// The entry a walk gave last, and whether it is a folder: where the walk is ([`Volumes::step`]).
type Place = Arc<Mutex<Option<(PathBuf, bool)>>>;

/// The volumes a producer reads on, for [`SchedulerConfig::stuck_per_volume`]: a give-up charges the volume of the
/// call it was in, told by the filesystem's identity ([`Producers::give_up`], [`Ticket::reading`]). Before a call
/// that reads on another volume than the last one it named, the producer names that one ([`Ticket::read_on`]); one
/// holding as many given-up threads as one may refuses it, and the producer answers its search with Node's answer to a
/// request whose server was ended for a stalled cancel. Node has no answer for one part of a search: a subtree whose
/// read stalls stalls its whole request (its server's walk never finishes), which its client answers with that text
/// once it ended the server; so the search is answered so in full, as the tools answer it ([`FsErrorKind::CancelStalled`]).
///
/// On Windows a walk never leaves its root's volume (it follows no junction, mounted folder or link, as Node's walk
/// does not), so the volume is its root's, told at the start ([`volume_id`]). On Unix a mount point below the root is a
/// folder the walk enters: the volume is the device of the mount the walk reads in ([`unix_io::Crossings`]), and before
/// the step that may enter a mount point the producer reads that mount point once, named to its volume, so a dead
/// mount holds that read and not the walk's next step, which is named to the volume it is in. What stays charged to
/// the volume the walk is in: a step that leaves a mount below the root for a folder of the volume above it.
struct Volumes {
    ticket: Arc<Ticket>,
    root: PathBuf,
    #[cfg(unix)]
    crossings: Option<unix_io::Crossings>,
}

impl Volumes {
    fn new(ticket: Arc<Ticket>, root: &Path) -> Self {
        Self {
            ticket,
            root: root.to_path_buf(),
            #[cfg(unix)]
            crossings: None,
        }
    }

    /// The producer's first call: tells its root's volume by the filesystem's identity, remembered for the root's next
    /// search ([`known_volume`]), and names it. This reads on the volumes the root's path passes through, named by the
    /// volume the search was admitted by.
    fn start(&mut self) -> Result<(), Option<FsErrorKind>> {
        #[cfg(unix)]
        let id = {
            self.crossings = unix_io::Crossings::new(&self.root).ok();
            self.crossings.as_ref().map(unix_io::Crossings::root_volume).filter(|v| !v.is_empty())
        };
        #[cfg(windows)]
        let id = fresh_volume(&self.root).or_else(|| volume_id(&self.root));
        #[cfg(not(any(unix, windows)))]
        let id: Option<String> = None;
        let Some(id) = id else { return Ok(()) };
        remember_volume(&self.root, &id);
        self.ticket.read_on(&id)
    }

    /// Before the walk's next step from `last`, the entry it gave last and whether it is a folder.
    fn step(&mut self, last: Option<(&Path, bool)>) -> Result<(), Option<FsErrorKind>> {
        #[cfg(unix)]
        if let (Some(crossings), Some((last, last_is_dir))) = (self.crossings.as_mut(), last) {
            let (crossing, here) = crossings.step(last, last_is_dir);
            if let Some((point, volume)) = crossing {
                self.ticket.read_on(&volume)?;
                let _ = std::fs::metadata(&point);
            }
            return self.ticket.read_on(&here);
        }
        let _ = last;
        Ok(())
    }

    /// Before `file` is opened.
    fn open(&mut self, file: &Path) -> Result<(), Option<FsErrorKind>> {
        #[cfg(unix)]
        if let Some(crossings) = &self.crossings {
            return self.ticket.read_on(&crossings.volume_of(file));
        }
        let _ = file;
        Ok(())
    }
}

/// The serving thread of a text search ([`IoLink`]): makes the calls its scan asks for until the scan ends, reading at
/// most [`READ_CHUNK`] bytes at a time into a buffer of its own, each call after naming the volume it reads on
/// ([`Volumes`]). It lets go of its [`Hold`] before the rest of what it holds.
fn serve(link: &IoLink, mut listing: Listing, open: Opener, hold: Hold, (mut volumes, place): (Volumes, Place)) {
    let mut file: Option<Box<dyn Read + Send>> = None;
    let mut chunk = vec![0; READ_CHUNK];
    let mut refused = volumes.start().err();
    while let Some(ask) = link.next_ask() {
        let (answer, read) = match ask {
            Ask::Next => {
                file = None;
                if refused.is_none() {
                    let last = locked(&place).clone();
                    refused = volumes.step(last.as_ref().map(|(path, dir)| (path.as_path(), *dir))).err();
                }
                match &refused {
                    None => (Answer::Next(listing.next()), 0),
                    Some(Some(refusal)) => (Answer::Next(Some(Err(FsError::new(refusal.clone(), None)))), 0),
                    Some(None) => break,
                }
            }
            Ask::Open(path) => {
                file = None;
                match volumes.open(&path) {
                    Err(Some(refusal)) => (Answer::Open(Err(io::Error::other(Halt::Refused(refusal)))), 0),
                    Err(None) => break,
                    Ok(()) => match open(&path) {
                        Ok(opened) => {
                            file = Some(opened);
                            (Answer::Open(Ok(())), 0)
                        }
                        Err(error) => (Answer::Open(Err(error)), 0),
                    },
                }
            }
            Ask::Read(n) => match file.as_mut().map_or(Ok(0), |f| f.read(&mut chunk[..n.min(READ_CHUNK)])) {
                Ok(read) => (Answer::Read(Ok(read)), read),
                Err(error) => (Answer::Read(Err(error)), 0),
            },
        };
        if !link.answer(answer, &chunk[..read]) {
            break;
        }
    }
    drop(hold);
    drop(file);
    drop(open);
    drop(listing);
}

/// A searched file as the scan reads it: through the serving thread, at most [`READ_CHUNK`] bytes at a time, each read
/// after a check of the stop and the deadline.
struct Linked<'a> {
    link: &'a IoLink,
    ctl: &'a Control,
}

impl Read for Linked<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.ctl.stopped() {
            return Err(io::Error::other(Halt::Stopped));
        }
        if self.ctl.expired() {
            return Err(io::Error::other(Halt::Deadline));
        }
        let n = buf.len().min(READ_CHUNK);
        let Some((Answer::Read(read), state)) = self.link.ask(self.ctl, Ask::Read(n)) else {
            return Err(io::Error::other(Halt::Stopped));
        };
        // A read [`cancel_io`] cancelled fails once the stop is set.
        let read = read.map_err(|error| if self.ctl.stopped() { io::Error::other(Halt::Stopped) } else { error })?;
        buf[..read].copy_from_slice(&state.bytes[..read]);
        Ok(read)
    }
}

/// The text search, each file searched as the walk reaches it, in `PathBuf` order (the walk sorts siblings): Node's
/// server answers in that order (`serve_search/search.rs`, `scan_operand`). Nothing of the tree is held beyond the
/// walker's own state and one file's search; Node's server, which scans while its walk publishes, also holds the whole
/// inventory, so this holds less. It stops once the request's `limit` matches are found, and checks the stop and the
/// deadline before each entry of the walk and before every read of a file. Its scan runs on a thread of its own, its
/// blocking calls on the stream's thread ([`IoLink`]).
struct Searching {
    matcher: grep::regex::RegexMatcher,
    searcher: Searcher,
    listing: Listing,
    open: Opener,
    left: Option<usize>,
    /// [`SearchRequest::first_per_file`].
    first_per_file: bool,
    /// The search's root, and where its walk is ([`Volumes`]).
    scope: PathBuf,
    place: Place,
    #[cfg(feature = "count-jobs")]
    root: PathBuf,
    #[cfg(feature = "count-jobs")]
    _live: probe::Live,
}

impl Produce<SearchMatch> for Searching {
    fn run(self: Box<Self>, out: Out<SearchMatch>, hold: Hold) {
        let Searching {
            matcher,
            searcher,
            listing,
            open,
            left,
            first_per_file,
            scope,
            place,
            #[cfg(feature = "count-jobs")]
            root,
            #[cfg(feature = "count-jobs")]
            _live,
        } = *self;
        let volumes = Volumes::new(hold.ticket.clone(), &scope);
        let link = Arc::new(IoLink::default());
        let _ = out.ctl.link.set(link.clone());
        let failure = out.clone();
        let scan = Scan {
            matcher,
            searcher,
            left,
            first_per_file,
            link: link.clone(),
            #[cfg(feature = "count-jobs")]
            root,
            #[cfg(feature = "count-jobs")]
            _live,
        };
        let scan_hold = hold.clone();
        let spawned = std::thread::Builder::new().name("mixdog-fs-scan".into()).spawn(move || {
            let _hold = scan_hold;
            let mut scan = scan;
            scan.run(&out);
        });
        match spawned {
            Ok(_) => {
                drop(failure);
                serve(&link, listing, open, hold, (volumes, place));
            }
            // The closure, dropped unrun, let go of its share of the slot.
            Err(error) => {
                failure.send(Err(FsError::new(FsErrorKind::Io { os_code: error.raw_os_error() }, None)));
            }
        }
    }
}

/// A text search's scan ([`Searching`]), on a thread of its own. Its end, however it ends, ends the serving thread's
/// wait ([`IoLink::finish`]).
struct Scan {
    matcher: grep::regex::RegexMatcher,
    searcher: Searcher,
    left: Option<usize>,
    first_per_file: bool,
    link: Arc<IoLink>,
    #[cfg(feature = "count-jobs")]
    root: PathBuf,
    #[cfg(feature = "count-jobs")]
    _live: probe::Live,
}

impl Drop for Scan {
    fn drop(&mut self) {
        self.link.finish();
    }
}

impl Scan {
    fn run(&mut self, out: &Out<SearchMatch>) {
        let ctl = &*out.ctl;
        #[cfg(feature = "count-jobs")]
        let root = self.root.clone();
        let Scan { matcher, searcher, left, first_per_file, link, .. } = self;
        let (matcher, first_per_file, link) = (&*matcher, *first_per_file, &**link);
        while *left != Some(0) {
            if ctl.stopped() {
                return;
            }
            if ctl.expired() {
                out.send(Err(timed_out(None)));
                return;
            }
            let Some((Answer::Next(next), state)) = link.ask(ctl, Ask::Next) else { return };
            drop(state);
            let file = match next {
                None => break,
                Some(Ok(Some(file))) => file,
                Some(Ok(None)) => continue,
                // Its volume's refusal answers the search ([`Volumes`]).
                Some(Err(error)) if matches!(error.kind, FsErrorKind::CancelStalled { .. }) => {
                    out.send(Err(error));
                    return;
                }
                Some(Err(error)) => {
                    if !out.send(Err(error)) {
                        return;
                    }
                    continue;
                }
            };
            let Some(path) = AbsPath::new(&file) else { continue };
            ctl.in_file.store(true, Ordering::SeqCst);
            let opened = match link.ask(ctl, Ask::Open(file.clone())) {
                Some((Answer::Open(opened), state)) => {
                    drop(state);
                    opened
                }
                _ => Err(io::Error::other(Halt::Stopped)),
            };
            let mut sent = 0;
            let searched = opened.and_then(|()| {
                let inner = Linked { link, ctl };
                let printed = Printed::default();
                let mut printer = StandardBuilder::new()
                    .heading(false)
                    .path(false)
                    .max_columns(Some(MAX_COLUMNS))
                    .max_columns_preview(true)
                    .build_no_color(printed.clone());
                let mut sink = Collect {
                    printer: printer.sink(matcher),
                    printed,
                    matcher,
                    path: &path,
                    out,
                    left,
                    first_per_file,
                    sent: 0,
                    closed: false,
                    #[cfg(feature = "count-jobs")]
                    root: &root,
                };
                let searched = searcher.search_reader(matcher, inner, &mut sink);
                sent = sink.sent;
                searched.map(|()| sink.closed)
            });
            ctl.in_file.store(false, Ordering::SeqCst);
            match searched {
                Ok(true) => return,
                Ok(false) => {
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
                    Some(Halt::Refused(refusal)) => {
                        out.send(Err(FsError::new(refusal.clone(), None)));
                        return;
                    }
                    None => {
                        // Node's server answers nothing of a file whose search failed (matching.rs:213-250,
                        // `scan_with_printer`): the error that names the file withdraws its lines already queued
                        // (the consumer drops them), and they count no more against the request's limit.
                        if let Some(left) = left.as_mut() {
                            *left += sent;
                        }
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

/// A stream fed by a producer thread through a queue of [`QUEUE`] items and [`QUEUE_BYTES`]: the producer runs ahead of
/// the consumer by at most that much and waits while the queue is full.
///
/// [`EventSource::close`] stops the producer and waits for its thread to end, at most the cancel grace ([`CLOSE_GRACE`]):
/// a producer checks the stop between entries, before every read of a file and at every item it queues, so it ends at
/// once unless a blocking OS call holds it (a directory read, an open or a read on a dead network share, a pipe). That
/// call is cancelled ([`cancel_io`]); the thread is counted ([`ProducerCounts::abandoned`]) from the moment its stream
/// lets go of it until it ends, never awaited past the grace, and one still running once the grace has passed is given
/// up ([`Producers::give_up`]): its slot is free, and the thread ends by itself if its call ever returns. Dropping the
/// stream, or a `close` cut short by its caller's deadline or cancellation, stops the producer, cancels its call and
/// counts it the same way without waiting for it; the canceller gives it up when the grace has passed.
///
/// A producer starts once its [`Producers`] give it a slot ([`Producers::dispatch`]); until then the stream answers
/// nothing, its deadline included, as a search waiting in Node's server queue gets no answer until a worker takes it. One that
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
    /// The producer's place in `producers`.
    ticket: Arc<Ticket>,
    /// The producer, while it waits for a slot.
    waiting: Option<Waiting<T>>,
    /// The producer's thread once started (the one making its blocking calls), and its interrupt, through which
    /// [`cancel_io`] cancels its blocking call when it is let go of.
    thread: Option<std::thread::JoinHandle<()>>,
    interrupt: Option<Arc<cancel_io::Interrupt>>,
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
fn failed<T: Weigh + Send + 'static>(error: FsError) -> Box<dyn EventSource<Result<T, FsError>>> {
    Box::new(Streamed {
        rx: Some(one_item(Err(error))),
        ctl: Arc::new(Control::new(Deadline::default())),
        finished: None,
        late: false,
        producers: PRODUCERS.clone(),
        ticket: Ticket::detached(),
        waiting: None,
        thread: None,
        interrupt: None,
    })
}

/// A stream of `producer`'s items: its producer starts at once if a slot is free, waits for one otherwise, or is refused
/// ([`Producers::enqueue`]): standing for a search-server request when the queue is full, or on a volume holding as
/// many given-up threads as one may.
fn streamed<T: Weigh + Send + 'static>(
    producers: &Arc<Producers>,
    producer: Box<dyn Produce<T>>,
    deadline: Deadline,
    origin: Origin,
    full: bool,
) -> Box<dyn EventSource<Result<T, FsError>>> {
    let ticket = Ticket::new(origin, producers);
    let start = match producers.enqueue(&ticket, full) {
        Ok(start) => start,
        Err(refusal) => return failed(FsError::new(refusal, None)),
    };
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
        ticket,
        waiting: Some(Waiting { producer, out, done }),
        thread: None,
        interrupt: None,
    };
    if start {
        stream.spawn();
    }
    Box::new(stream)
}

impl<T: Weigh + Send + 'static> Streamed<T> {
    /// Starts the waiting producer once its [`Producers`] gave it a slot; `false` while it still waits.
    fn try_start(&mut self) -> bool {
        if self.waiting.is_none() {
            return true;
        }
        if let Some(refusal) = self.ticket.refused.get() {
            self.waiting = None;
            self.finished = None;
            self.rx = Some(one_item(Err(FsError::new(refusal.clone(), None))));
            return true;
        }
        if self.ticket.state.load(Ordering::SeqCst) != RUNNING {
            return false;
        }
        self.spawn();
        true
    }

    /// Starts the producer's thread, its slot taken.
    fn spawn(&mut self) {
        let Some(Waiting { producer, out, done }) = self.waiting.take() else { return };
        let hold: Hold = Arc::new(Started { ticket: self.ticket.clone(), _done: done });
        // Without an interrupt (no descriptor for it) a call nothing else cancels is given up after the grace.
        let interrupt = cancel_io::Interrupt::new().ok().map(Arc::new);
        let entered = interrupt.clone();
        let spawned = std::thread::Builder::new().name("mixdog-fs-stream".into()).spawn(move || {
            cancel_io::enter(entered);
            let _ = hold.ticket.started_at.set(Instant::now());
            producer.run(out, hold);
        });
        match spawned {
            Ok(thread) => {
                self.thread = Some(thread);
                self.interrupt = interrupt;
            }
            // The closure, dropped unrun, gave up the slot and ended the queue.
            Err(error) => {
                self.rx = Some(one_item(Err(FsError::new(FsErrorKind::Io { os_code: error.raw_os_error() }, None))));
                self.finished = None;
            }
        }
    }

    /// Waits for a slot and starts the producer. Dropping this wait keeps the producer waiting in the stream. Woken only
    /// when this stream is admitted ([`Ticket::admitted`]): a change of the counts wakes no waiting stream, so a queue of
    /// thousands is not polled whole at each change.
    async fn started(&mut self) {
        let ticket = self.ticket.clone();
        loop {
            let admitted = ticket.admitted.notified();
            let mut admitted = std::pin::pin!(admitted);
            admitted.as_mut().enable();
            if self.try_start() {
                return;
            }
            admitted.await;
        }
    }
}

#[async_trait]
impl<T: Weigh + Send + 'static> EventSource<Result<T, FsError>> for Streamed<T> {
    async fn next(&mut self) -> Option<Result<T, FsError>> {
        self.rx.as_ref()?;
        self.started().await;
        let rx = self.rx.as_mut()?;
        let ctl = &self.ctl;
        let taken = |item: Option<Result<T, FsError>>| {
            if let Some(item) = &item {
                ctl.taken(item.weight());
            }
            item
        };
        let item = match self.ctl.deadline.at.filter(|_| !self.late) {
            Some(at) => tokio::select! {
                biased;
                item = rx.recv() => taken(item),
                () = tokio::time::sleep_until(at.into()) => {
                    if self.ctl.in_file.load(Ordering::SeqCst) {
                        self.late = true;
                        taken(rx.recv().await)
                    } else {
                        self.ctl.halt();
                        Some(Err(timed_out(None)))
                    }
                }
            },
            None => taken(rx.recv().await),
        };
        if matches!(item, None | Some(Err(FsError { kind: FsErrorKind::TimedOut, .. }))) {
            self.rx = None;
        }
        item
    }

    async fn close(&mut self) {
        self.ctl.halt();
        // A producer waiting on a full queue is released; one waiting for a slot never starts.
        self.rx = None;
        self.waiting = None;
        // Counted before the wait, so a caller that drops this `close` leaves the count right.
        self.producers.release(&self.ticket, self.thread.take(), self.interrupt.take());
        if let Some(finished) = self.finished.take() {
            if tokio::time::timeout(self.producers.config.grace, finished).await.is_err() {
                self.producers.give_up(&self.ticket);
            }
        }
    }
}

impl<T> Drop for Streamed<T> {
    fn drop(&mut self) {
        self.ctl.halt();
        self.producers.release(&self.ticket, self.thread.take(), self.interrupt.take());
    }
}

/// The blocking OS call of an abandoned producer thread, cancelled until the thread ends ([`Producers::release`]).
///
/// A producer checks its stop between entries, before each read and at each item it queues; what it cannot check is a
/// blocking OS call in progress: a directory read, an open or a read on a dead network share, a pipe (for a text search
/// these are all on the stream's thread, [`IoLink`]). Node's client ends such a search by ending its whole search server
/// CANCEL_GRACE_MS after its cancel (native-search-client.mjs:501), which ends the stuck threads with their process. A
/// thread cannot be ended from outside its process, so its call is cancelled where the OS can cancel one thread's call:
/// on Windows `CancelSynchronousIo` on the thread's handle (the call fails with ERROR_OPERATION_ABORTED); on Unix, with
/// no signal, a read of a FIFO, a socket or a terminal, which waits with `poll` beside the thread's [`Interrupt`] (a pipe
/// this writes to: [`unix_io`]). The producer then finds its stop set and ends, which frees its slot.
///
/// A cancel that reaches a Windows thread before it enters its call is lost (`CancelSynchronousIo` cancels only an
/// operation in progress), so it is repeated: at once, then after 1 ms and at doubling intervals up to 1 s, until the
/// thread ends or the cancel grace has passed (on Unix the interrupt stays fired, so a repeat changes nothing). A thread
/// still running then is given up ([`Producers::give_up`]): its slot is free, nothing cancels it any more, and it ends by
/// itself if its call ever returns. That is what remains uncancellable: on Windows an operation whose driver does not
/// support cancellation (`CancelSynchronousIo` then returns ERROR_NOT_FOUND, or the operation completes normally), on
/// Unix a directory read and any read of a regular file or block device (a file on an NFS share mounted `hard` whose
/// server is gone, a hung disk: Linux `TASK_UNINTERRUPTIBLE`). Node's client ends its server's process (SIGTERM) and
/// starts a new one; the stuck thread lingers with its process until that call returns, as a given-up thread lingers here
/// ([`ProducerCounts::stalled`]), at most [`SchedulerConfig::stuck_per_volume`] per volume.
mod cancel_io {
    use std::sync::Arc;
    use std::sync::Condvar;
    use std::sync::LazyLock;
    use std::sync::Mutex;
    use std::sync::PoisonError;
    use std::sync::atomic::Ordering;
    use std::thread::JoinHandle;
    use std::time::Duration;
    use std::time::Instant;

    use super::Producers;
    use super::RELEASED;
    use super::Ticket;

    const FIRST_RETRY: Duration = Duration::from_millis(1);
    const LAST_RETRY: Duration = Duration::from_secs(1);

    /// A stream thread's interrupt: on Unix the pipe its pollable reads wait on beside their descriptor, entered as the
    /// thread's own ([`enter`], [`current`]); on Windows nothing (the thread's handle is cancelled).
    #[cfg(unix)]
    pub(super) use super::unix_io::Cancel as Interrupt;

    #[cfg(not(unix))]
    pub(super) struct Interrupt;

    #[cfg(not(unix))]
    impl Interrupt {
        pub(super) fn new() -> std::io::Result<Self> {
            Ok(Self)
        }
    }

    #[cfg(unix)]
    thread_local! {
        static CURRENT: std::cell::RefCell<Option<Arc<Interrupt>>> = const { std::cell::RefCell::new(None) };
    }

    /// Makes `interrupt` the current thread's, for the files it opens to search ([`super::open_to_search`]).
    pub(super) fn enter(interrupt: Option<Arc<Interrupt>>) {
        #[cfg(unix)]
        CURRENT.with(|current| *current.borrow_mut() = interrupt);
        #[cfg(not(unix))]
        drop(interrupt);
    }

    /// The current thread's interrupt.
    #[cfg(unix)]
    pub(super) fn current() -> Option<Arc<Interrupt>> {
        CURRENT.with(|current| current.borrow().clone())
    }

    struct Abandoned {
        /// Held, not detached, while it is cancelled: its handle stays valid for `CancelSynchronousIo` until then.
        thread: JoinHandle<()>,
        interrupt: Option<Arc<Interrupt>>,
        ticket: Arc<Ticket>,
        producers: Arc<Producers>,
        /// When the cancel grace has passed.
        give_up_at: Instant,
    }

    impl Abandoned {
        fn running(&self) -> bool {
            self.ticket.state.load(Ordering::SeqCst) == RELEASED
        }
    }

    struct Canceller {
        abandoned: Mutex<Vec<Abandoned>>,
        added: Condvar,
    }

    static CANCELLER: LazyLock<Arc<Canceller>> = LazyLock::new(|| {
        let canceller = Arc::new(Canceller { abandoned: Mutex::new(Vec::new()), added: Condvar::new() });
        let running = canceller.clone();
        // Without this thread nothing is cancelled or given up but by `close`: the others end when their calls return.
        let _ = std::thread::Builder::new().name("mixdog-fs-cancel".into()).spawn(move || running.run());
        canceller
    });

    /// Cancels `thread`'s blocking call now and again until its producer ends, or gives it up once `producers`' cancel
    /// grace has passed.
    pub(super) fn until_ended(thread: JoinHandle<()>, interrupt: Option<Arc<Interrupt>>, ticket: Arc<Ticket>, producers: Arc<Producers>) {
        cancel(&thread, interrupt.as_deref());
        let give_up_at = Instant::now() + producers.config.grace;
        let canceller = &*CANCELLER;
        canceller.abandoned.lock().unwrap_or_else(PoisonError::into_inner).push(Abandoned { thread, interrupt, ticket, producers, give_up_at });
        canceller.added.notify_one();
    }

    impl Canceller {
        fn run(&self) {
            let mut abandoned = self.abandoned.lock().unwrap_or_else(PoisonError::into_inner);
            let mut retry = FIRST_RETRY;
            loop {
                let now = Instant::now();
                for a in abandoned.iter().filter(|a| a.running() && a.give_up_at <= now) {
                    a.producers.give_up(&a.ticket);
                }
                // An ended or given-up thread is let go of: a given-up one is detached and runs on alone.
                abandoned.retain(Abandoned::running);
                let Some(next) = abandoned.iter().map(|a| a.give_up_at).min() else {
                    abandoned = self.added.wait(abandoned).unwrap_or_else(PoisonError::into_inner);
                    retry = FIRST_RETRY;
                    continue;
                };
                let before = abandoned.len();
                let wait = retry.min(next.saturating_duration_since(now));
                abandoned = self.added.wait_timeout(abandoned, wait).unwrap_or_else(PoisonError::into_inner).0;
                retry = if abandoned.len() > before { FIRST_RETRY } else { (retry * 2).min(LAST_RETRY) };
                for a in abandoned.iter().filter(|a| a.running()) {
                    cancel(&a.thread, a.interrupt.as_deref());
                }
            }
        }
    }

    #[cfg(windows)]
    fn cancel(thread: &JoinHandle<()>, _: Option<&Interrupt>) {
        use std::os::windows::io::AsRawHandle as _;
        // SAFETY: the handle stays open while `thread` is held. A thread with no synchronous I/O in progress makes the
        // call fail with ERROR_NOT_FOUND, which changes nothing.
        unsafe { windows_sys::Win32::System::IO::CancelSynchronousIo(thread.as_raw_handle()) };
    }

    /// Fires the thread's interrupt: a read waiting with `poll` ends.
    #[cfg(unix)]
    fn cancel(_: &JoinHandle<()>, interrupt: Option<&Interrupt>) {
        if let Some(interrupt) = interrupt {
            interrupt.fire();
        }
    }

    #[cfg(not(any(windows, unix)))]
    fn cancel(_: &JoinHandle<()>, _: Option<&Interrupt>) {}
}

#[cfg(unix)]
mod unix_io;

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
            ENDED.notify_waiters();
        }
    }

    /// Notified each time a search's scan ends and each time a producer's threads have all ended (a test hook: the
    /// scheduler is told nothing of a given-up producer's end).
    static ENDED: std::sync::LazyLock<tokio::sync::Notify> = std::sync::LazyLock::new(tokio::sync::Notify::new);

    /// Notified each time a search's scan ends and each time a producer's threads have all ended.
    pub fn changed() -> &'static tokio::sync::Notify {
        &ENDED
    }

    pub(super) fn ended() {
        ENDED.notify_waiters();
    }

    /// The streams with a producer made so far (refused ones included), and the order they answered in, each by its
    /// number (its place among those made): at its refusal, or when its producer's threads ended, under the scheduler's
    /// lock, which is when Node's server writes a search's answer (before the next one it dispatches can end).
    static STREAMS: Mutex<(u64, Vec<u64>)> = Mutex::new((0, Vec::new()));

    /// Notified each time a stream is made.
    static MADE: std::sync::LazyLock<tokio::sync::Notify> = std::sync::LazyLock::new(tokio::sync::Notify::new);

    /// The streams made so far: the next one made is this number.
    pub fn streams_made() -> u64 {
        STREAMS.lock().unwrap_or_else(PoisonError::into_inner).0
    }

    /// The streams, by number, in the order they answered.
    pub fn answer_order() -> Vec<u64> {
        STREAMS.lock().unwrap_or_else(PoisonError::into_inner).1.clone()
    }

    /// Notified each time a stream is made.
    pub fn made() -> &'static tokio::sync::Notify {
        &MADE
    }

    pub(super) fn stream_made() -> u64 {
        let number = {
            let mut streams = STREAMS.lock().unwrap_or_else(PoisonError::into_inner);
            streams.0 += 1;
            streams.0 - 1
        };
        MADE.notify_waiters();
        number
    }

    pub(super) fn answered(number: u64) {
        STREAMS.lock().unwrap_or_else(PoisonError::into_inner).1.push(number);
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
        /// Every slot is taken and the queue is full: a walk or search that stands for a search-server request is refused
        /// ([`super::Producers::enqueue`], [`super::FsErrorKind::Saturated`]).
        QueueFull,
        /// The search is held in a call that ignores its cancel (a read on a dead mount) until [`unstick`] releases the
        /// searches under its scope: it is given up once its stream let go of it and the grace has passed.
        Stuck,
    }

    /// The scopes [`unstick`] released, and its signal.
    static UNSTUCK: (Mutex<Vec<PathBuf>>, std::sync::Condvar) = (Mutex::new(Vec::new()), std::sync::Condvar::new());

    /// Ends the held calls of the searches under `scope` ([`Script::Stuck`]), and of every later one under it.
    pub fn unstick(scope: &Path) {
        UNSTUCK.0.lock().unwrap_or_else(PoisonError::into_inner).push(scope.to_path_buf());
        UNSTUCK.1.notify_all();
    }

    /// A batch oplock held on a file, as a recorder's `lib/oplock-holder.ps1` holds it: another handle's open of the
    /// file for its data breaks the oplock and waits, as the break is never acknowledged, until this is dropped.
    #[cfg(windows)]
    pub struct OplockHold {
        file: windows_sys::Win32::Foundation::HANDLE,
        event: windows_sys::Win32::Foundation::HANDLE,
        /// The request's OVERLAPPED, written by the system until the request completes.
        overlapped: Box<windows_sys::Win32::System::IO::OVERLAPPED>,
    }

    #[cfg(windows)]
    impl OplockHold {
        pub fn new(path: &Path) -> std::io::Result<Self> {
            use std::os::windows::ffi::OsStrExt as _;
            use windows_sys::Win32::Foundation::CloseHandle;
            use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
            use windows_sys::Win32::Storage::FileSystem::CreateFileW;
            use windows_sys::Win32::System::IO::DeviceIoControl;
            use windows_sys::Win32::System::Threading::CreateEventW;
            const GENERIC_READ: u32 = 0x8000_0000;
            const SHARE_ALL: u32 = 7;
            const OPEN_EXISTING: u32 = 3;
            const FILE_FLAG_OVERLAPPED: u32 = 0x4000_0000;
            const FSCTL_REQUEST_BATCH_OPLOCK: u32 = 0x0009_0008;
            const ERROR_IO_PENDING: i32 = 997;
            let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            // SAFETY: `wide` is a NUL-terminated path; the handle returned is owned here.
            let file = unsafe {
                CreateFileW(wide.as_ptr(), GENERIC_READ, SHARE_ALL, std::ptr::null(), OPEN_EXISTING, FILE_FLAG_OVERLAPPED, std::ptr::null_mut())
            };
            if file == INVALID_HANDLE_VALUE {
                return Err(std::io::Error::last_os_error());
            }
            // SAFETY: a manual-reset event, unnamed; the handle is owned here.
            let event = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
            // SAFETY: OVERLAPPED is plain data; zeroed is its initial state.
            let mut overlapped: Box<windows_sys::Win32::System::IO::OVERLAPPED> = Box::new(unsafe { std::mem::zeroed() });
            overlapped.hEvent = event;
            // SAFETY: `file` is open for overlapped I/O; the OVERLAPPED lives in a box this keeps until the request ends.
            let done = unsafe {
                DeviceIoControl(file, FSCTL_REQUEST_BATCH_OPLOCK, std::ptr::null(), 0, std::ptr::null_mut(), 0, std::ptr::null_mut(), &mut *overlapped)
            };
            let error = std::io::Error::last_os_error();
            if done != 0 || error.raw_os_error() != Some(ERROR_IO_PENDING) {
                // SAFETY: both handles are owned here; a request that is not pending holds no reference to the OVERLAPPED.
                unsafe {
                    CloseHandle(file);
                    CloseHandle(event);
                }
                return Err(std::io::Error::other(format!("no batch oplock on {}: {error}", path.display())));
            }
            Ok(Self { file, event, overlapped })
        }

        /// Waits at most `limit` for the oplock's break: another handle's open of the file, now waiting.
        pub fn wait_broken(&self, limit: std::time::Duration) -> bool {
            let ms = u32::try_from(limit.as_millis()).unwrap_or(u32::MAX - 1);
            // SAFETY: `event` is open.
            unsafe { windows_sys::Win32::System::Threading::WaitForSingleObject(self.event, ms) == 0 }
        }
    }

    #[cfg(windows)]
    impl Drop for OplockHold {
        fn drop(&mut self) {
            use windows_sys::Win32::Foundation::CloseHandle;
            // SAFETY: the handles are owned here. Closing the file ends the request (it completes, setting the event), so
            // the OVERLAPPED is freed only once the system is done with it; one not done within 10 s is leaked instead.
            unsafe {
                CloseHandle(self.file);
                let ended = windows_sys::Win32::System::Threading::WaitForSingleObject(self.event, 10_000) == 0;
                CloseHandle(self.event);
                if !ended {
                    std::mem::forget(std::mem::replace(&mut self.overlapped, Box::new(std::mem::zeroed())));
                }
            }
        }
    }

    /// A search held in a call that ignores its cancel ([`Script::Stuck`]).
    pub(super) struct Held {
        pub(super) root: PathBuf,
    }

    impl super::Produce<mixdog_core_api::domain::fs::SearchMatch> for Held {
        fn run(self: Box<Self>, _out: super::Out<mixdog_core_api::domain::fs::SearchMatch>, hold: super::Hold) {
            // Its root's volume told as a search tells it, so its give-up charges that volume.
            let _ = super::Volumes::new(hold.ticket.clone(), &self.root).start();
            let mut unstuck = UNSTUCK.0.lock().unwrap_or_else(PoisonError::into_inner);
            while !unstuck.iter().any(|scope| self.root.starts_with(scope)) {
                unstuck = UNSTUCK.1.wait(unstuck).unwrap_or_else(PoisonError::into_inner);
            }
        }
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

    pub(super) fn queue_full(root: &Path) -> bool {
        matches!(for_root(root), Some(Script::QueueFull))
    }

    /// A search that queues nothing and ends when stopped, holding the search it stands for until then.
    pub(super) struct Silent {
        pub(super) _search: Box<dyn Send>,
    }

    impl super::Produce<mixdog_core_api::domain::fs::SearchMatch> for Silent {
        fn run(self: Box<Self>, out: super::Out<mixdog_core_api::domain::fs::SearchMatch>, _hold: super::Hold) {
            while !out.ctl.stopped() {
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
            // The search it stands for ends before the hold `close` waits for (parameters drop in reverse order, the
            // hold first).
            drop(self);
        }
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::domain::conformance::FsLanes;
    use mixdog_core_api::domain::conformance::check_file_service;

    use super::*;

    /// grep-printer 0.2.2's mark after a long line's preview when no match is coloured (standard.rs:1373-1374).
    const LONG_LINE_MARK: &str = " [... omitted end of long line]";

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
            first_per_file: false,
            deadline: None,
            class: SearchClass::Interactive,
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
                first_per_file: false,
                deadline: None,
                class: SearchClass::Interactive,
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
        let mut walk = fs.walk(l.maintenance, WalkRequest { root: root.clone(), recursive: true, include_dirs: true, include_hidden: true, respect_ignore: false, prune: Vec::new(), server: None });
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
            first_per_file: false,
            deadline: None,
            class: SearchClass::Interactive,
        };
        let mut s = fs.search_text(lanes().maintenance, request);
        let mut texts = Vec::new();
        while let Some(m) = s.next().await {
            texts.push(m.unwrap().text);
        }
        // The last line has no terminator: the printer adds one, and `str::lines` drops the `\r` before it.
        assert_eq!(texts, vec!["needle\r", "needle", "needle"]);
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
            first_per_file: false,
            deadline: None,
            class: SearchClass::Interactive,
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
            first_per_file: false,
            deadline,
            class: SearchClass::Interactive,
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

    /// The memory a search holds ahead of its consumer is its queue: at most [`QUEUE_BYTES`] (1,048,576) bytes of
    /// matches' text and paths, or one match when one is larger, however long its line: a long line's preview is kept
    /// whole. A consumer that stops reading without dropping the stream holds the producer there.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_consumer_that_stops_reading_holds_the_producer_at_its_queue_bytes() {
        let (_dir, root) = root();
        // 300 matching lines of 80,208 bytes each: 207 grapheme clusters (200 of a letter and 200 combining marks), so
        // the whole line is its preview.
        let line = format!("needle {}\n", format!("e{}", "\u{301}".repeat(200)).repeat(200));
        std::fs::write(root.join("a.txt").as_path(), line.repeat(300)).unwrap();
        let fs = LocalFileService::new();
        let mut stream = fs.search_text(lanes().maintenance, needle_request(&root, None));
        let first = stream.next().await.unwrap().unwrap();
        assert_eq!(first.text, format!("{}{LONG_LINE_MARK}", &line[..line.len() - 1]), "the preview is not cut short");
        let fits = QUEUE_BYTES / first.weight();
        let found = || probe::search(root.as_path()).found;
        assert!(eventually(|| found() == fits as u64 + 1).await, "found {}", found());
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(found(), fits as u64 + 1, "the producer waits while the queue's bytes are taken");
        let mut queued_bytes = 0;
        for _ in 0..fits {
            let item = stream.next().await.unwrap().unwrap();
            assert_eq!(item.text, first.text);
            queued_bytes += item.weight();
        }
        assert!(queued_bytes <= QUEUE_BYTES, "{queued_bytes}");
        let started = Instant::now();
        stream.close().await;
        assert!(started.elapsed() < CLOSE_GRACE, "{:?} found {}", started.elapsed(), found());
        assert_eq!(probe::search(root.as_path()).live, 0, "close returns once the producer has ended");

        // A preview larger than the whole queue's bytes (1,200,008 bytes in 8 clusters) is queued whole, alone.
        let (_other, root) = self::root();
        let line = format!("needle {}", format!("e{}", "\u{301}".repeat(600_000)));
        assert!(line.len() > QUEUE_BYTES);
        std::fs::write(root.join("b.txt").as_path(), format!("{line}\n{line}\n")).unwrap();
        let mut stream = fs.search_text(lanes().maintenance, needle_request(&root, None));
        for _ in 0..2 {
            let item = within("a match larger than the queue", stream.next()).await.unwrap().unwrap();
            assert_eq!(item.text, format!("{line}{LONG_LINE_MARK}"));
        }
        assert!(within("the search's end", stream.next()).await.is_none());
        stream.close().await;
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
        let (listing, release, in_read, _) = hung_listing_gone();
        (listing, release, in_read)
    }

    /// [`hung_listing`], and a receiver that ends once the listing is dropped: the thread that held it has ended (its
    /// share of the slot, which it lets go of first, included).
    fn hung_listing_gone() -> (Listing, std::sync::mpsc::Sender<()>, oneshot::Receiver<()>, oneshot::Receiver<()>) {
        let (release, hung) = std::sync::mpsc::channel::<()>();
        let (entered, in_read) = oneshot::channel::<()>();
        let (ended, gone) = oneshot::channel::<()>();
        let state = Mutex::new((hung, Some(entered), ended));
        let listing: Listing = Box::new(std::iter::from_fn(move || {
            let mut state = state.lock().unwrap();
            state.1.take();
            let _ = state.0.recv();
            None
        }));
        (listing, release, in_read, gone)
    }

    /// A root on another volume than the temp folder's: only its volume is read ([`volume_of`]); the listings given name
    /// the files.
    fn other_volume() -> AbsPath {
        #[cfg(windows)]
        return AbsPath::new(r"\\mixdog-other-volume\share\x").unwrap();
        #[cfg(target_os = "linux")]
        return AbsPath::new("/proc/self").unwrap();
        #[cfg(target_os = "macos")]
        return AbsPath::new("/dev").unwrap();
        #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
        AbsPath::new("/").unwrap()
    }

    /// A listing of `file` alone, read with `File::open`.
    fn one_file(file: &Path) -> (Listing, Opener) {
        let listing: Listing = Box::new(std::iter::once(Ok(Some(file.to_path_buf()))));
        let open: Opener = Box::new(|path| Ok(Box::new(File::open(path)?) as Box<dyn Read + Send>));
        (listing, open)
    }

    /// `wait`'s outcome, at most 10 s.
    async fn within<T>(what: &str, wait: impl Future<Output = T>) -> T {
        tokio::time::timeout(Duration::from_secs(10), wait).await.unwrap_or_else(|_| panic!("{what} within 10 s"))
    }

    fn no_files() -> Opener {
        Box::new(|_| unreachable!("no file is listed"))
    }

    /// Node's scheduler with `total` searches at once and no interactive reserve, `queue` waiting places, its other
    /// defaults (the bulk limit 2 within `total`, the priority reserve of `queue`, the AIMD target and step), and a
    /// cancel grace of `grace`.
    fn scheduler(total: usize, queue: usize, grace: Duration) -> SchedulerConfig {
        SchedulerConfig {
            total,
            interactive_reserve: 0,
            bulk: 2.min(total),
            queue,
            priority_reserve: if queue <= 1 { 0 } else { queue.div_ceil(8).clamp(1, 64).min(queue - 1) },
            aimd_target: Duration::from_millis(250),
            aimd_increase_every: 8,
            grace,
            local: MAX_LOCAL_PRODUCERS,
            stuck_per_volume: MAX_STUCK_PER_VOLUME,
        }
    }

    const NODE_QUEUE: usize = 2_048;

    /// A directory read that never returns: the deadline answers at once, and `close` waits its grace, then gives the
    /// thread up: its slot is free, and it is counted as stalled until its read returns.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_directory_read_that_never_returns_is_given_up_after_the_grace() {
        let (_dir, root) = root();
        let producers = Arc::new(Producers::new(scheduler(16, NODE_QUEUE, CLOSE_GRACE)));
        let (listing, release, _) = hung_listing();
        let started = Instant::now();
        let mut stream = search_over(&producers, &needle_request(&root, Some(started + Duration::from_millis(100))), listing, no_files());
        let err = stream.next().await.unwrap().unwrap_err();
        assert!(matches!(err.kind, FsErrorKind::TimedOut) && err.path.is_none(), "{err:?}");
        assert!(started.elapsed() < Duration::from_secs(1), "the deadline does not wait for the walk");
        let closing = Instant::now();
        stream.close().await;
        assert!(closing.elapsed() >= CLOSE_GRACE && closing.elapsed() < CLOSE_GRACE * 3, "{:?}", closing.elapsed());
        assert_eq!(producers.counts(), ProducerCounts { stalled: 1, ..Default::default() }, "given up, still in its read, no slot");
        drop(release);
        settled(&producers, "the given-up thread ends once its read returns", ProducerCounts::default()).await;
    }

    /// A producer held in a read that never returns is counted as abandoned however its stream lets go of it: a `close`
    /// that waits out its grace (given up then), a `close` its caller drops before the grace (its deadline or
    /// cancellation), and a dropped stream; the canceller gives these two up once the grace has passed. Each given-up
    /// thread is counted as stalled until its read returns.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_producer_its_stream_lets_go_of_is_counted_until_it_ends_or_is_given_up() {
        let (_dir, root) = root();
        let producers = Arc::new(Producers::new(scheduler(16, NODE_QUEUE, CLOSE_GRACE)));
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
        assert_eq!(producers.counts(), ProducerCounts { stalled: 1, ..Default::default() }, "a close that waited out its grace");
        let mut cut = search().await;
        {
            let close = cut.close();
            let mut close = std::pin::pin!(close);
            let polled = close.as_mut().poll(&mut std::task::Context::from_waker(std::task::Waker::noop()));
            assert!(polled.is_pending(), "the close waits for its producer");
        }
        assert_eq!(producers.counts(), ProducerCounts { live: 1, abandoned: 1, waiting: 0, stalled: 1 }, "a close its caller dropped");
        drop(search().await);
        assert_eq!(producers.counts(), ProducerCounts { live: 2, abandoned: 2, waiting: 0, stalled: 1 }, "a dropped stream");
        until(&producers, "the canceller gives both up after the grace", |c| c == ProducerCounts { stalled: 3, ..Default::default() }).await;
        drop(released);
        settled(&producers, "every producer ends once its read returns", ProducerCounts::default()).await;
        drop((closed, cut));
    }

    /// Waits until `producers`' counts are `want`, at most 10 s, woken at each change of the counts and at each end a
    /// test can see ([`probe::changed`]): a given-up producer's end changes no count the scheduler keeps and is reported
    /// to no one, so it is seen there.
    async fn settled(producers: &Producers, what: &str, want: ProducerCounts) {
        let wait = async {
            loop {
                let ended = probe::changed().notified();
                let mut ended = std::pin::pin!(ended);
                ended.as_mut().enable();
                let changed = producers.changed.notified();
                let mut changed = std::pin::pin!(changed);
                changed.as_mut().enable();
                if producers.counts() == want {
                    return;
                }
                tokio::select! {
                    () = ended => {}
                    () = changed => {}
                }
            }
        };
        if tokio::time::timeout(Duration::from_secs(10), wait).await.is_err() {
            panic!("{what} within 10 s: {:?}", producers.counts());
        }
    }

    /// Waits until the searches of `root` whose scan is alive are `live`, at most 10 s.
    async fn until_live(root: &AbsPath, live: u64) {
        let wait = async {
            loop {
                let changed = probe::changed().notified();
                let mut changed = std::pin::pin!(changed);
                changed.as_mut().enable();
                if probe::search(root.as_path()).live == live {
                    return;
                }
                changed.await;
            }
        };
        within("the scans' end", wait).await;
    }

    /// Ten thousand searches in a row on one volume, each held in a read that ignores its cancel. The first 8 are given
    /// up once the grace has passed (none here) and stay; every later one is refused at once, starting no thread, with
    /// Node's answer to a request whose server was ended for a stalled cancel: the process holds 8 given-up threads, and
    /// of each only the thread in the read, which holds a fixed set of bytes (the walk's position, the open file, one
    /// buffer of READ_CHUNK and its slot's hold), as their scans ended and with them the matcher, the searcher's buffers
    /// and the queue. A search on another volume answers meanwhile. When one read returns, its thread ends touching no
    /// counter of the scheduler and notifying no one, its volume's mark goes, and the volume takes a search again.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ten_thousand_reads_that_ignore_the_cancel_hold_eight_threads_and_spare_other_volumes() {
        let (_dir, root) = root();
        let file = root.join("a.txt").as_path().to_path_buf();
        std::fs::write(&file, "needle\n").unwrap();
        let producers = Arc::new(Producers::new(scheduler(1, NODE_QUEUE, Duration::ZERO)));
        let mut held = Vec::new();
        let mut refusals = 0;
        for n in 0..10_000 {
            let (listing, release, in_read, gone) = hung_listing_gone();
            let mut stream = search_over(&producers, &needle_request(&root, None), listing, no_files());
            if n < MAX_STUCK_PER_VOLUME {
                let _ = within("a stuck search in its read", in_read).await;
                stream.close().await;
                held.push((release, gone));
            } else {
                let refusal = within("a refusal", stream.next()).await;
                let stalled = FsErrorKind::CancelStalled { search: CONTENT.to_owned(), grace_ms: 0 };
                assert!(matches!(&refusal, Some(Err(FsError { kind, path: None, .. })) if *kind == stalled), "{refusal:?}");
                assert!(within("the refused stream's end", stream.next()).await.is_none());
                refusals += 1;
            }
            assert!(producers.counts().stalled <= MAX_STUCK_PER_VOLUME);
        }
        assert_eq!(refusals, 10_000 - MAX_STUCK_PER_VOLUME);
        assert_eq!(producers.counts(), ProducerCounts { stalled: MAX_STUCK_PER_VOLUME, ..Default::default() });
        until_live(&root, 0).await;
        // Another volume answers.
        let (listing, open) = one_file(&file);
        let mut other = search_over(&producers, &needle_request(&other_volume(), None), listing, open);
        let hit = within("the other volume's match", other.next()).await.unwrap().unwrap();
        assert_eq!((hit.path.as_path(), hit.line), (file.as_path(), 1));
        assert!(within("the other volume's end", other.next()).await.is_none());
        other.close().await;
        // A late return.
        let before = producers.counts();
        let changed = producers.changed.notified();
        let mut changed = std::pin::pin!(changed);
        changed.as_mut().enable();
        let (release, gone) = held.pop().unwrap();
        drop(release);
        let _ = within("the released thread's end", gone).await;
        // Its volume's mark went with it, and no count the scheduler keeps moved.
        settled(&producers, "the released thread's mark", ProducerCounts { stalled: MAX_STUCK_PER_VOLUME - 1, ..before }).await;
        let polled = changed.as_mut().poll(&mut std::task::Context::from_waker(std::task::Waker::noop()));
        assert!(polled.is_pending(), "a given-up thread's end notifies the scheduler's waiters of nothing");
        let (listing, open) = one_file(&file);
        let mut again = search_over(&producers, &needle_request(&root, None), listing, open);
        assert!(within("the volume's search again", again.next()).await.unwrap().is_ok());
        again.close().await;
        drop(held);
        settled(&producers, "every given-up thread's end", ProducerCounts::default()).await;
    }

    /// What the stuck listings of a test count: the reads entered and not returned, and the producers that started (a
    /// listing dropped on a stream's thread: a search refused before it started drops its listing with its stream).
    #[derive(Default)]
    struct StuckReads {
        in_read: std::sync::atomic::AtomicUsize,
        started: std::sync::atomic::AtomicUsize,
    }

    /// A walk whose first step never returns until the sender is dropped, counted in `reads`; the receiver ends once the
    /// producer is in that step.
    fn stuck_listing(reads: &Arc<StuckReads>) -> (Listing, std::sync::mpsc::Sender<()>, oneshot::Receiver<()>) {
        struct Stuck {
            reads: Arc<StuckReads>,
            hung: Mutex<(std::sync::mpsc::Receiver<()>, Option<oneshot::Sender<()>>)>,
        }
        impl Iterator for Stuck {
            type Item = Result<Option<PathBuf>, FsError>;
            fn next(&mut self) -> Option<Self::Item> {
                let hung = self.hung.get_mut().unwrap();
                self.reads.in_read.fetch_add(1, Ordering::SeqCst);
                hung.1.take();
                let _ = hung.0.recv();
                self.reads.in_read.fetch_sub(1, Ordering::SeqCst);
                None
            }
        }
        impl Drop for Stuck {
            fn drop(&mut self) {
                if std::thread::current().name() == Some("mixdog-fs-stream") {
                    self.reads.started.fetch_add(1, Ordering::SeqCst);
                }
            }
        }
        let (release, hung) = std::sync::mpsc::channel::<()>();
        let (entered, in_read) = oneshot::channel::<()>();
        (Box::new(Stuck { reads: reads.clone(), hung: Mutex::new((hung, Some(entered))) }), release, in_read)
    }

    /// Answers each of `streams` as a caller with a deadline does: its first item, or, once its producer is stuck in its
    /// read, nothing; then closes it (a stuck one is given up after the grace). How many were refused with Node's stalled
    /// answer, the others having been stuck.
    async fn answer_or_give_up(streams: Vec<(Box<dyn EventSource<Result<SearchMatch, FsError>>>, oneshot::Receiver<()>)>) -> usize {
        let mut searches = tokio::task::JoinSet::new();
        for (mut stream, mut in_read) in streams {
            searches.spawn(async move {
                let first = tokio::select! {
                    item = stream.next() => Some(item),
                    _ = &mut in_read => None,
                };
                stream.close().await;
                match first {
                    None => false,
                    Some(Some(Err(FsError { kind: FsErrorKind::CancelStalled { .. }, path: None, .. }))) => true,
                    other => panic!("{other:?}"),
                }
            });
        }
        let all = async {
            let mut refused = 0;
            while let Some(answered) = searches.join_next().await {
                refused += usize::from(answered.unwrap());
            }
            refused
        };
        tokio::time::timeout(Duration::from_secs(60), all).await.expect("every search answered or given up within 60 s")
    }

    /// Ten thousand searches queued at once on one volume, each held, once it runs, in a read that never returns, and
    /// given up once its caller lets go of it. As each running one is given up the next queued one is admitted, until
    /// the volume holds MAX_STUCK_PER_VOLUME given-up threads; from then each queued one is answered at its admission with
    /// Node's stalled answer and starts no thread. The threads left stranded, counted as the scheduler counts them and as
    /// reads entered and not returned: those that were reading on the volume when it reached its bound, at most
    /// MAX_STUCK_PER_VOLUME - 1 + the 2 that run at once, within `max_stranded_per_volume`; no other producer started.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn ten_thousand_searches_queued_on_a_volume_whose_reads_never_return_strand_at_most_the_stated_bound() {
        const SEARCHES: usize = 10_000;
        const AT_ONCE: usize = 2;
        let (_dir, root) = root();
        let config = scheduler(AT_ONCE, SEARCHES, Duration::from_millis(10));
        let producers = Arc::new(Producers::new(config));
        let reads = Arc::new(StuckReads::default());
        let mut releases = Vec::new();
        let streams: Vec<_> = (0..SEARCHES)
            .map(|_| {
                let (listing, release, in_read) = stuck_listing(&reads);
                releases.push(release);
                (search_over(&producers, &needle_request(&root, None), listing, no_files()), in_read)
            })
            .collect();
        assert_eq!(producers.counts(), ProducerCounts { live: AT_ONCE, waiting: SEARCHES - AT_ONCE, ..Default::default() }, "all queued");
        let refused = answer_or_give_up(streams).await;
        let stranded = producers.counts().stalled;
        assert_eq!(producers.counts(), ProducerCounts { stalled: stranded, ..Default::default() });
        assert_eq!(reads.in_read.load(Ordering::SeqCst), stranded, "each given-up thread is in its read");
        assert!((MAX_STUCK_PER_VOLUME..=MAX_STUCK_PER_VOLUME - 1 + AT_ONCE).contains(&stranded), "{stranded} stranded");
        assert!(stranded <= config.max_stranded_per_volume());
        assert_eq!(refused, SEARCHES - stranded);
        drop(releases);
        settled(&producers, "every stranded thread ends once its read returns", ProducerCounts::default()).await;
        assert!(eventually(|| reads.started.load(Ordering::SeqCst) >= stranded).await);
        assert_eq!(reads.started.load(Ordering::SeqCst), stranded, "no refused search started a thread");
    }

    /// Nine searches running on one volume whose reads all stall at once (a volume that dies under them), a thousand
    /// queued behind them: the nine are all given up, past the 8 a volume may otherwise gain, as they were reading on it
    /// before it reached its bound; each queued one admitted before it reached the bound runs, stalls and is given up
    /// too, and every later one is answered at its admission and starts no thread. The total stays within
    /// MAX_STUCK_PER_VOLUME - 1 + 9 (the searches that run at once), within `max_stranded_per_volume`, and a search made
    /// after is refused at once.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn nine_running_searches_that_stall_at_once_strand_at_most_the_stated_bound() {
        const AT_ONCE: usize = 9;
        const QUEUED: usize = 1_000;
        let (_dir, root) = root();
        let config = scheduler(AT_ONCE, NODE_QUEUE, Duration::ZERO);
        let producers = Arc::new(Producers::new(config));
        let reads = Arc::new(StuckReads::default());
        let mut releases = Vec::new();
        let mut search = || {
            let (listing, release, in_read) = stuck_listing(&reads);
            releases.push(release);
            (search_over(&producers, &needle_request(&root, None), listing, no_files()), in_read)
        };
        let mut running = Vec::new();
        for _ in 0..AT_ONCE {
            let (stream, in_read) = search();
            within("a running search in its read", in_read).await.unwrap_err();
            running.push(stream);
        }
        let queued: Vec<_> = (0..QUEUED).map(|_| search()).collect();
        assert_eq!(producers.counts(), ProducerCounts { live: AT_ONCE, waiting: QUEUED, ..Default::default() });
        // Their callers let go of all nine at once; the canceller gives them up together.
        drop(running);
        let refused = answer_or_give_up(queued).await;
        until(&producers, "the nine given up", |c| c.live == 0).await;
        let stranded = producers.counts().stalled;
        assert_eq!(producers.counts(), ProducerCounts { stalled: stranded, ..Default::default() });
        assert_eq!(reads.in_read.load(Ordering::SeqCst), stranded, "each given-up thread is in its read");
        assert!((AT_ONCE..=MAX_STUCK_PER_VOLUME - 1 + AT_ONCE).contains(&stranded), "{stranded} stranded");
        assert!(stranded <= config.max_stranded_per_volume());
        assert_eq!(refused, QUEUED - (stranded - AT_ONCE));
        let (listing, release, _) = stuck_listing(&reads);
        let mut after = search_over(&producers, &needle_request(&root, None), listing, no_files());
        assert!(matches!(within("a search made after", after.next()).await, Some(Err(FsError { kind: FsErrorKind::CancelStalled { .. }, .. }))));
        drop((after, release, releases));
        settled(&producers, "every stranded thread ends once its read returns", ProducerCounts::default()).await;
        assert!(eventually(|| reads.started.load(Ordering::SeqCst) >= stranded).await);
        assert_eq!(reads.started.load(Ordering::SeqCst), stranded, "no refused search started a thread");
    }

    /// A second fixed volume besides the temp folder's, where a folder can be made: its new folder, removed when dropped.
    #[cfg(windows)]
    fn folder_on_another_volume(than: &Path) -> Option<tempfile::TempDir> {
        use std::os::windows::ffi::OsStrExt as _;
        const DRIVE_FIXED: u32 = 3;
        let ours = volume_id(than)?;
        (b'A'..=b'Z').map(|letter| PathBuf::from(format!("{}:\\", char::from(letter)))).find_map(|drive| {
            let wide: Vec<u16> = drive.as_os_str().encode_wide().chain(Some(0)).collect();
            // SAFETY: a NUL-terminated drive root.
            let fixed = unsafe { windows_sys::Win32::Storage::FileSystem::GetDriveTypeW(wide.as_ptr()) } == DRIVE_FIXED;
            (fixed && volume_id(&drive).is_some_and(|id| id != ours)).then(|| tempfile::tempdir_in(&drive).ok()).flatten()
        })
    }

    /// Reads that stall under a junction to a folder of another volume are that volume's: once it holds
    /// MAX_STUCK_PER_VOLUME given-up threads, a search rooted at the junction's target folder (on that volume) and a search
    /// through the junction are refused with Node's stalled answer, while a search of the folder holding the junction,
    /// on the temp folder's volume, answers. Skipped (it says so) on a machine with one fixed volume.
    #[cfg(windows)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reads_stalled_under_a_junction_are_charged_to_the_volume_it_leads_to() {
        let (_dir, root) = root();
        let Some(other) = folder_on_another_volume(root.as_path()) else {
            eprintln!("skipped: no second fixed volume");
            return;
        };
        let target = AbsPath::new(crate::pathguard::canonical(other.path()).unwrap()).unwrap();
        let junction = root.join("j");
        let made = std::process::Command::new("cmd").args(["/c", "mklink", "/J"]).arg(junction.as_path()).arg(target.as_path()).output().unwrap();
        assert!(made.status.success(), "{made:?}");
        let parent_file = root.join("a.txt").as_path().to_path_buf();
        let target_file = target.join("b.txt").as_path().to_path_buf();
        std::fs::write(&parent_file, "needle\n").unwrap();
        std::fs::write(&target_file, "needle\n").unwrap();
        let producers = Arc::new(Producers::new(scheduler(16, NODE_QUEUE, Duration::ZERO)));
        let reads = Arc::new(StuckReads::default());
        let mut releases = Vec::new();
        for _ in 0..MAX_STUCK_PER_VOLUME {
            let (listing, release, in_read) = stuck_listing(&reads);
            releases.push(release);
            let mut stream = search_over(&producers, &needle_request(&junction, None), listing, no_files());
            within("a search through the junction in its read", in_read).await.unwrap_err();
            stream.close().await;
        }
        assert_eq!(producers.counts(), ProducerCounts { stalled: MAX_STUCK_PER_VOLUME, ..Default::default() });
        let first = |root: &AbsPath, file: &Path| {
            let (listing, open) = one_file(file);
            search_over(&producers, &needle_request(root, None), listing, open)
        };
        let mut parent = first(&root, parent_file.as_path());
        let hit = within("the parent's match", parent.next()).await.unwrap().unwrap();
        assert_eq!(hit.path.as_path(), parent_file.as_path());
        parent.close().await;
        for (root, file) in [(&target, &target_file), (&junction, &target_file)] {
            let mut refused = first(root, file.as_path());
            let answer = within("a search on the junction's volume", refused.next()).await;
            assert!(matches!(&answer, Some(Err(FsError { kind: FsErrorKind::CancelStalled { .. }, path: None, .. }))), "{root:?}: {answer:?}");
            refused.close().await;
        }
        drop(releases);
        settled(&producers, "every given-up thread ends", ProducerCounts::default()).await;
        std::fs::remove_dir(junction.as_path()).unwrap();
    }

    /// A mapped drive's device target names its share; a network mount point is keyed as `\\server\share\`.
    #[test]
    fn a_mapped_drive_is_keyed_by_the_share_it_maps() {
        assert_eq!(redirected_share(r"\Device\LanmanRedirector\;Z:0000000000012345\Srv\Share").as_deref(), Some(r"\\srv\share\"));
        assert_eq!(redirected_share(r"\Device\Mup\;LanmanRedirector\;Z:00000000000a1b2c\srv\share\sub").as_deref(), Some(r"\\srv\share\"));
        assert_eq!(redirected_share(r"\Device\HarddiskVolume3"), None);
        assert_eq!(share_key(r"\\?\UNC\Srv\Share\"), r"\\srv\share\");
        assert_eq!(share_key(r"\\srv\share"), r"\\srv\share\");
    }

    /// A stream that never polls next, for the burst below: whether it was refused (its one item, at once) or holds or
    /// waits for a slot (nothing yet).
    fn refused(stream: &mut Box<dyn EventSource<Result<SearchMatch, FsError>>>) -> bool {
        let next = stream.next();
        let mut next = std::pin::pin!(next);
        match next.as_mut().poll(&mut std::task::Context::from_waker(std::task::Waker::noop())) {
            std::task::Poll::Ready(Some(Err(FsError { kind: FsErrorKind::Saturated, .. }))) => true,
            std::task::Poll::Pending => false,
            other => panic!("unexpected {other:?}"),
        }
    }

    /// A burst of searches that never end, each class alone, against Node's scheduler with 2 searches at once, an
    /// interactive reserve of 1, a bulk limit of 2, and 4 waiting places (a priority reserve of 1): as the server's
    /// dispatcher admits them when it keeps up, 3 interactive ones run (2 and the reserve), 4 wait and the 8th is
    /// refused; 2 fuzzy ones run, 4 wait, the 7th is refused; 2 bulk ones run, 3 wait (4 less the reserve), the 6th is
    /// refused.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_burst_is_refused_at_the_search_nodes_scheduler_refuses() {
        let (_dir, root) = root();
        let config = SchedulerConfig { interactive_reserve: 1, ..scheduler(2, 4, Duration::ZERO) };
        assert_eq!((config.bulk, config.priority_reserve), (2, 1));
        for (class, running, refused_at) in [(SearchClass::Interactive, 3, 8), (SearchClass::Fuzzy, 2, 7), (SearchClass::Bulk, 2, 6)] {
            let producers = Arc::new(Producers::new(config));
            let mut held = Vec::new();
            let mut first_refused = None;
            for n in 1..=10 {
                let (listing, release, _) = hung_listing();
                let mut stream = search_over(&producers, &SearchRequest { class, ..needle_request(&root, None) }, listing, no_files());
                if refused(&mut stream) && first_refused.is_none() {
                    first_refused = Some(n);
                    assert_eq!(producers.counts(), ProducerCounts { live: running, waiting: refused_at - 1 - running, ..Default::default() }, "{class:?}");
                }
                held.push((stream, release));
            }
            assert_eq!(first_refused, Some(refused_at), "{class:?}");
            drop(held);
            settled(&producers, "the burst's producers end", ProducerCounts::default()).await;
        }
    }

    /// A pipe's reading end that reports its first read as it starts, past the search's last check of its stop.
    #[cfg(windows)]
    struct Reading {
        pipe: io::PipeReader,
        started: Option<oneshot::Sender<()>>,
    }

    #[cfg(windows)]
    impl Read for Reading {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            if let Some(started) = self.started.take() {
                let _ = started.send(());
            }
            self.pipe.read(buf)
        }
    }

    /// A file whose read blocks until its cancel, listed alone, the receiver ending once its producer is at its read; and
    /// what keeps it blocked (dropped last). On Windows a pipe whose writer never writes (an anonymous pipe is a named
    /// pipe; `CancelSynchronousIo` ends its read); on Unix a FIFO no one opens to write, opened as a search opens it
    /// ([`open_to_search`]: its read waits with `poll` beside the thread's interrupt, which the cancel fires).
    fn blocked_read(root: &AbsPath) -> (Listing, Opener, oneshot::Receiver<()>, Box<dyn Send>) {
        let (started, in_read) = oneshot::channel::<()>();
        #[cfg(windows)]
        {
            let (reader, writer) = io::pipe().unwrap();
            let pipe = Mutex::new(Some(Reading { pipe: reader, started: Some(started) }));
            let listing: Listing = Box::new(std::iter::once(Ok(Some(root.join("pipe").as_path().to_path_buf()))));
            let open: Opener = Box::new(move |_| Ok(Box::new(pipe.lock().unwrap().take().unwrap()) as Box<dyn Read + Send>));
            (listing, open, in_read, Box::new(writer))
        }
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStrExt as _;
            let fifo = root.join("fifo").as_path().to_path_buf();
            let name = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
            // SAFETY: a NUL-terminated path.
            assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0, "{}", io::Error::last_os_error());
            let started = Mutex::new(Some(started));
            let listing: Listing = Box::new(std::iter::once(Ok(Some(fifo))));
            let open: Opener = Box::new(move |path| {
                let opened = open_to_search(path);
                if let Some(started) = started.lock().unwrap().take() {
                    let _ = started.send(());
                }
                opened
            });
            (listing, open, in_read, Box::new(()))
        }
    }

    /// A producer held in a real blocking read (a pipe whose writer never writes, [`blocked_read`]) is cancelled once its
    /// stream lets go of it: the read fails, the thread ends and frees its slot, and the next search, which had no slot,
    /// runs. On Unix this is the FIFO's `poll` ended by the thread's interrupt, no signal.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_producer_in_a_blocked_pipe_read_is_cancelled_and_its_slot_serves_the_next_search() {
        let (_dir, root) = root();
        let file = root.join("a.txt").as_path().to_path_buf();
        std::fs::write(&file, "needle\n").unwrap();
        let producers = Arc::new(Producers::new(scheduler(1, NODE_QUEUE, CLOSE_GRACE)));
        let (listing, open, in_read, writer) = blocked_read(&root);
        let mut blocked = search_over(&producers, &needle_request(&root, None), listing, open);
        within("the producer in its pipe read", in_read).await.unwrap();
        let listing: Listing = Box::new(std::iter::once(Ok(Some(file.clone()))));
        let open: Opener = Box::new(|path| Ok(Box::new(File::open(path)?) as Box<dyn Read + Send>));
        let mut next = search_over(&producers, &needle_request(&root, None), listing, open);
        assert_eq!(producers.counts(), ProducerCounts { live: 1, waiting: 1, ..Default::default() }, "the next search has no slot");
        blocked.close().await;
        // Cancelled within the grace: it ended, nothing was given up, and its slot went to the waiting search.
        until(&producers, "the producer in its pipe read is cancelled and ends", |c| c == ProducerCounts { live: 1, ..Default::default() }).await;
        let hit = within("the next search's match", next.next()).await.unwrap().unwrap();
        assert_eq!((hit.path.as_path(), hit.line), (file.as_path(), 1));
        assert!(within("the next search's end", next.next()).await.is_none());
        next.close().await;
        drop(writer);
    }

    /// Past the slots, searches wait while fewer than the queue's capacity wait; the next is refused as Node's server
    /// refuses it, a bulk one already at the capacity less its reserve (9 less 2), and a walk Node does not queue runs on
    /// its own slots. Once the slot frees, the waiting searches run and the queue takes searches again.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_search_past_the_queue_capacity_is_refused_as_saturated_and_the_queue_recovers() {
        const QUEUE: usize = 9;
        let (_dir, root) = root();
        let file = root.join("a.txt").as_path().to_path_buf();
        std::fs::write(&file, "needle\n").unwrap();
        let producers = Arc::new(Producers::new(scheduler(1, QUEUE, CLOSE_GRACE)));
        let (listing, open, in_read, writer) = blocked_read(&root);
        let mut blocked = search_over(&producers, &needle_request(&root, None), listing, open);
        within("the producer in its pipe read", in_read).await.unwrap();
        let one_file = |class| {
            let listing: Listing = Box::new(std::iter::once(Ok(Some(file.clone()))));
            let open: Opener = Box::new(|path| Ok(Box::new(File::open(path)?) as Box<dyn Read + Send>));
            search_over(&producers, &SearchRequest { class, ..needle_request(&root, None) }, listing, open)
        };
        let saturated = |item: Option<Result<SearchMatch, FsError>>| matches!(item, Some(Err(FsError { kind: FsErrorKind::Saturated, .. })));
        let mut waiting: Vec<_> = (0..7).map(|_| one_file(SearchClass::Interactive)).collect();
        assert!(saturated(within("a bulk search past 7 waiting", one_file(SearchClass::Bulk).next()).await));
        waiting.extend((0..2).map(|_| one_file(SearchClass::Fuzzy)));
        assert_eq!(producers.counts(), ProducerCounts { live: 1, waiting: QUEUE, ..Default::default() });
        assert!(saturated(within("a search past 9 waiting", one_file(SearchClass::Interactive).next()).await));
        assert!(saturated(within("a fuzzy search past 9 waiting", one_file(SearchClass::Fuzzy).next()).await));
        let walking = Walking { walk: WalkBuilder::new(root.as_path()).build(), root: root.as_path().to_path_buf(), include_dirs: false };
        let origin = Origin::new(None, root.as_path(), "file inventory");
        let mut walk = streamed(&producers, Box::new(walking), Deadline::default(), origin, false);
        assert_eq!(producers.counts().waiting, QUEUE, "a walk Node does not queue runs at once");
        let mut walked = Vec::new();
        while let Some(entry) = within("the walk's entries", walk.next()).await {
            walked.push(entry.unwrap().path);
        }
        assert!(walked.iter().any(|p| p.as_path() == file.as_path()), "{walked:?}");
        walk.close().await;
        blocked.close().await;
        until(&producers, "the slot goes to the first waiting search", |c| c == ProducerCounts { live: 1, waiting: QUEUE - 1, ..Default::default() }).await;
        for stream in &mut waiting {
            let hit = within("a waiting search's match", stream.next()).await.unwrap().unwrap();
            assert_eq!((hit.path.as_path(), hit.line), (file.as_path(), 1));
            assert!(within("a waiting search's end", stream.next()).await.is_none());
            stream.close().await;
        }
        let mut again = one_file(SearchClass::Bulk);
        assert!(within("the queue takes searches again", again.next()).await.unwrap().is_ok());
        again.close().await;
        until(&producers, "every producer ends", |c| c == ProducerCounts::default()).await;
        drop(writer);
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
        let request = WalkRequest { root: root.clone(), recursive: true, include_dirs: false, include_hidden: true, respect_ignore: false, prune: Vec::new(), server: None };
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
