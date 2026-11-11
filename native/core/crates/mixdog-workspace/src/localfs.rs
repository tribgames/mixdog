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
        streamed(&PRODUCERS, walking, Deadline::default(), request.server, full)
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
        let listing: Listing = Box::new(builder.build().map(move |item| match item {
            Ok(entry) => Ok(entry.file_type().is_some_and(|t| t.is_file()).then(|| entry.into_path())),
            Err(error) => Err(walk_error(&error, &walk_root)),
        }));
        let open: Opener = Box::new(|path| Ok(Box::new(open_to_search(path)?) as Box<dyn Read + Send>));
        search_over(&PRODUCERS, &request, listing, open)
    }
}

/// A file opened for its search, as the search server opens it (`File::open`, serve_search/matching.rs:228), except that
/// on Unix an open a signal interrupts fails with `Interrupted` instead of starting again (std's `File::open` repeats
/// it), so that [`cancel_io`] can end an open that blocks: the producer opens again unless it was stopped.
fn open_to_search(path: &Path) -> io::Result<File> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt as _;
        use std::os::unix::io::FromRawFd as _;
        let name = std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(io::Error::other)?;
        // SAFETY: `name` is a NUL-terminated path; a descriptor the call returns is owned by the File alone.
        let fd = unsafe { libc::open(name.as_ptr(), libc::O_RDONLY | libc::O_CLOEXEC) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `fd` was just opened and nothing else owns it.
        Ok(unsafe { File::from_raw_fd(fd) })
    }
    #[cfg(not(unix))]
    File::open(path)
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
        #[cfg(feature = "count-jobs")]
        root: request.root.as_path().to_path_buf(),
        #[cfg(feature = "count-jobs")]
        _live: probe::Live::new(request.root.as_path()),
    };
    let server = Some(request.class);
    #[cfg(feature = "replay-controls")]
    let after_files = match deadline_script::for_root(request.root.as_path()) {
        Some(deadline_script::Script::Silent) => {
            return streamed(producers, Box::new(deadline_script::Silent { _search: Box::new(searching) }), Deadline::default(), server, false);
        }
        Some(deadline_script::Script::QueueFull) => return streamed(producers, Box::new(searching), Deadline::default(), server, true),
        Some(deadline_script::Script::AfterFiles(n)) => Some(n),
        None => None,
    };
    #[cfg(feature = "replay-controls")]
    let deadline = Deadline { at: request.deadline, after_files };
    #[cfg(not(feature = "replay-controls"))]
    let deadline = Deadline { at: request.deadline };
    streamed(producers, Box::new(searching), deadline, server, false)
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
}

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
        }
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
    /// Producer threads given up that have not ended: each held a call the cancel did not end within its grace, holds no
    /// slot, and ends by itself if its call ever returns.
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
}

impl Ticket {
    fn new(class: Option<SearchClass>) -> Arc<Self> {
        Arc::new(Self { state: AtomicU8::new(ENDED), class, queued_at: Instant::now(), started_at: OnceLock::new() })
    }
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

/// Moves waiting streams of one queue to running while the queue's own count stays under `limit` and the total under
/// `ceiling` (scheduler.rs `admit_class`, :360-377).
fn admit(
    queue: &mut VecDeque<Arc<Ticket>>,
    inflight: &mut usize,
    (limit, ceiling): (usize, usize),
    total: &mut usize,
    counts: &mut ProducerCounts,
) {
    while *inflight < limit && *total < ceiling {
        let Some(ticket) = queue.pop_front() else { break };
        *inflight += 1;
        *total += 1;
        counts.waiting -= 1;
        counts.live += 1;
        ticket.state.store(RUNNING, Ordering::SeqCst);
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
            }),
            changed: Notify::new(),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Sched> {
        self.sched.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn counts(&self) -> ProducerCounts {
        self.lock().counts
    }

    /// A new stream joins its queue and starts at once if [`Producers::dispatch`] gives it a slot (`Some(true)`), or else
    /// waits (`Some(false)`). One that stands for a search-server request and finds as many searches waiting as its class
    /// may join is refused (`None`, [`FsErrorKind::Saturated`]), as `SearchScheduler::enqueue` refuses it
    /// (scheduler.rs:234-247; the answer, server.rs:370-394). `full`: a replay's scripted full queue ([`deadline_script`]).
    fn enqueue(&self, ticket: &Arc<Ticket>, full: bool) -> Option<bool> {
        let mut s = self.lock();
        if let Some(class) = ticket.class {
            if full || s.queue_depth() >= self.config.admission(class) {
                return None;
            }
        }
        ticket.state.store(WAITING, Ordering::SeqCst);
        s.queue(ticket.class).push_back(ticket.clone());
        s.counts.waiting += 1;
        self.dispatch(&mut s);
        drop(s);
        self.changed.notify_waiters();
        Some(ticket.state.load(Ordering::SeqCst) == RUNNING)
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
        admit(&mut s.interactive, &mut s.inflight[0], (c.total + c.interactive_reserve, ceiling), &mut total, &mut s.counts);
        admit(&mut s.fuzzy, &mut s.inflight[1], (c.total, c.total), &mut total, &mut s.counts);
        let adaptive = c.bulk.min(s.bulk_window.max(1));
        let bulk = if s.inflight[0] > 0 || !s.interactive.is_empty() { adaptive.min(1) } else { adaptive };
        admit(&mut s.bulk, &mut s.inflight[2], (bulk, c.total), &mut total, &mut s.counts);
        let mut walks = s.local_live;
        admit(&mut s.local, &mut s.local_live, (c.local, c.local), &mut walks, &mut s.counts);
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
    /// cancelled through `thread` ([`cancel_io`]).
    fn release(self: &Arc<Self>, ticket: &Arc<Ticket>, thread: Option<std::thread::JoinHandle<()>>) {
        let mut s = self.lock();
        match (ticket.state.load(Ordering::SeqCst), thread) {
            (RUNNING, Some(thread)) => {
                ticket.state.store(RELEASED, Ordering::SeqCst);
                s.counts.abandoned += 1;
                drop(s);
                self.changed.notify_waiters();
                cancel_io::until_ended(thread, ticket.clone(), self.clone());
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
    /// starts a new server: the slot is free at once, and the bulk window starts again as a new server's does. The
    /// thread runs on and ends by itself if its call ever returns ([`Producers::end`]).
    fn give_up(&self, ticket: &Ticket) {
        let mut s = self.lock();
        if ticket.state.load(Ordering::SeqCst) != RELEASED {
            return;
        }
        ticket.state.store(STALLED, Ordering::SeqCst);
        s.counts.abandoned -= 1;
        s.counts.stalled += 1;
        Self::free(&mut s, ticket);
        s.bulk_window = self.config.bulk.max(1);
        s.healthy_completions = 0;
        self.dispatch(&mut s);
        drop(s);
        self.changed.notify_waiters();
    }

    /// `ticket`'s producer thread ends. One given up only leaves the count of stalled threads: its slot went back when it
    /// was given up, and nothing else is touched.
    fn end(&self, ticket: &Ticket) {
        let mut s = self.lock();
        match ticket.state.swap(ENDED, Ordering::SeqCst) {
            STALLED => s.counts.stalled -= 1,
            previous => {
                if previous == RELEASED {
                    s.counts.abandoned -= 1;
                }
                Self::free(&mut s, ticket);
                if ticket.class.is_some() {
                    self.observe(&mut s, ticket);
                }
                self.dispatch(&mut s);
            }
        }
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

/// A started producer's hold on its slot, given up when its thread ends, however it ends.
struct Started {
    producers: Arc<Producers>,
    ticket: Arc<Ticket>,
}

impl Drop for Started {
    fn drop(&mut self) {
        self.producers.end(&self.ticket);
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
        }
    }

    fn stopped(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }

    /// Stops the producer, waking it if it waits for room in the queue.
    fn halt(&self) {
        self.stop.store(true, Ordering::SeqCst);
        let _queued = self.queued.lock().unwrap_or_else(PoisonError::into_inner);
        self.room.notify_all();
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

impl<T: Weigh> Out<T> {
    /// Queues `item`, waiting while the queue is full, in items or in bytes; `false` once the stream is stopped or gone.
    fn send(&self, item: Result<T, FsError>) -> bool {
        self.ctl.reserve(item.weight()) && !self.ctl.stopped() && self.tx.blocking_send(item).is_ok()
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
        // A read [`cancel_io`] cancelled fails (Windows ERROR_OPERATION_ABORTED, Unix EINTR) once the stop is set.
        self.inner.read(&mut buf[..n]).map_err(|error| if self.ctl.stopped() { io::Error::other(Halt::Stopped) } else { error })
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
    /// [`SearchRequest::first_per_file`].
    first_per_file: bool,
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
        let Searching { matcher, searcher, listing, open, left, first_per_file, .. } = &mut *self;
        let (matcher, first_per_file) = (&*matcher, *first_per_file);
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
            // An open [`cancel_io`] interrupted is made again unless the producer was stopped.
            let opened = loop {
                match open(&file) {
                    Err(error) if error.kind() == io::ErrorKind::Interrupted && !ctl.stopped() => {}
                    opened => break opened,
                }
            };
            let mut sent = 0;
            let searched = opened.and_then(|inner| {
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
                let searched = searcher.search_reader(matcher, Checked { inner, ctl }, &mut sink);
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
    /// The producer's thread once started, through which [`cancel_io`] cancels its blocking call when it is let go of.
    thread: Option<std::thread::JoinHandle<()>>,
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
        ticket: Ticket::new(None),
        waiting: None,
        thread: None,
    })
}

/// A stream of `producer`'s items: its producer starts at once if a slot is free, waits for one otherwise, or, standing
/// for a search-server request of `server`'s class, is refused when the queue is full ([`Producers::enqueue`]).
fn streamed<T: Weigh + Send + 'static>(
    producers: &Arc<Producers>,
    producer: Box<dyn Produce<T>>,
    deadline: Deadline,
    server: Option<SearchClass>,
    full: bool,
) -> Box<dyn EventSource<Result<T, FsError>>> {
    let ticket = Ticket::new(server);
    let Some(start) = producers.enqueue(&ticket, full) else {
        return failed(FsError::new(FsErrorKind::Saturated, None));
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
        if self.ticket.state.load(Ordering::SeqCst) != RUNNING {
            return false;
        }
        self.spawn();
        true
    }

    /// Starts the producer's thread, its slot taken.
    fn spawn(&mut self) {
        let Some(Waiting { producer, out, done }) = self.waiting.take() else { return };
        let started = Started { producers: self.producers.clone(), ticket: self.ticket.clone() };
        let spawned = std::thread::Builder::new().name("mixdog-fs-stream".into()).spawn(move || {
            // Dropped when the thread ends, however it ends, in this order: the slot, then the end `close` waits for.
            let _done = done;
            let started = started;
            let _ = started.ticket.started_at.set(Instant::now());
            producer.run(&out);
        });
        match spawned {
            Ok(thread) => self.thread = Some(thread),
            // The closure, dropped unrun, gave up the slot and ended the queue.
            Err(error) => {
                self.rx = Some(one_item(Err(FsError::new(FsErrorKind::Io { os_code: error.raw_os_error() }, None))));
                self.finished = None;
            }
        }
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
        self.producers.release(&self.ticket, self.thread.take());
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
        self.producers.release(&self.ticket, self.thread.take());
    }
}

/// The blocking OS call of an abandoned producer thread, cancelled until the thread ends ([`Producers::release`]).
///
/// A producer checks its stop between entries, before each read and at each item it queues; what it cannot check is a
/// blocking OS call in progress: a directory read, an open or a read on a dead network share, a pipe. Node's client
/// ends such a search by ending its whole search server CANCEL_GRACE_MS after its cancel (native-search-client.mjs:501),
/// which ends the stuck threads with their process. A thread cannot be ended from outside its process, so its call is
/// cancelled with the OS's own cancellation of one thread's synchronous I/O: on Windows `CancelSynchronousIo` on the
/// thread's handle (the call fails with ERROR_OPERATION_ABORTED), on Unix a signal delivered to that thread alone,
/// whose handler was installed without `SA_RESTART` (the call fails with EINTR; [`open_to_search`] does not repeat an
/// interrupted open). The producer then finds its stop set and ends, which frees its slot.
///
/// A cancel that reaches the thread before it enters its call is lost (`CancelSynchronousIo` cancels only an operation
/// in progress; the signal's handler runs before the call), so it is repeated: at once, then after 1 ms and at doubling
/// intervals up to 1 s, until the thread ends or the cancel grace has passed. A thread still running then is given up
/// ([`Producers::give_up`]): its slot is free, nothing cancels it any more, and it ends by itself if its call ever
/// returns. That is what remains uncancellable: on Windows an operation whose driver does not support cancellation
/// (`CancelSynchronousIo` then returns ERROR_NOT_FOUND, or the operation completes normally), on Unix a call in
/// uninterruptible sleep (Linux `TASK_UNINTERRUPTIBLE`: a read from an NFS share mounted `hard` whose server is gone, a
/// hung disk), which no signal but SIGKILL ends, and any call when another code holds the signal (`take_over`). Node's client
/// ends its server's process (SIGTERM) and starts a new one; the stuck thread lingers with its process until that call
/// returns, as a given-up thread lingers here ([`ProducerCounts::stalled`]).
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

    struct Abandoned {
        /// Held, not detached, while it is cancelled: on Unix its id stays valid for `pthread_kill` until then.
        thread: JoinHandle<()>,
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
    pub(super) fn until_ended(thread: JoinHandle<()>, ticket: Arc<Ticket>, producers: Arc<Producers>) {
        cancel(&thread);
        let give_up_at = Instant::now() + producers.config.grace;
        let canceller = &*CANCELLER;
        canceller.abandoned.lock().unwrap_or_else(PoisonError::into_inner).push(Abandoned { thread, ticket, producers, give_up_at });
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
                    cancel(&a.thread);
                }
            }
        }
    }

    #[cfg(windows)]
    fn cancel(thread: &JoinHandle<()>) {
        use std::os::windows::io::AsRawHandle as _;
        // SAFETY: the handle stays open while `thread` is held. A thread with no synchronous I/O in progress makes the
        // call fail with ERROR_NOT_FOUND, which changes nothing.
        unsafe { windows_sys::Win32::System::IO::CancelSynchronousIo(thread.as_raw_handle()) };
    }

    /// The signal that interrupts a producer's call, sent to that thread alone (`pthread_kill`). Its default action is to
    /// ignore it, and nothing in this process uses it: tokio listens only to the signals it is asked for (none is this),
    /// std and tokio's child-process code wait on SIGCHLD or a pidfd, and the kernel sends it only to a process that
    /// claimed a socket's urgent data (`F_SETOWN`), which nothing here does.
    #[cfg(unix)]
    const INTERRUPT: libc::c_int = libc::SIGURG;

    #[cfg(unix)]
    extern "C" fn interrupted(_: libc::c_int) {}

    #[cfg(unix)]
    fn ours() -> libc::sighandler_t {
        interrupted as extern "C" fn(libc::c_int) as libc::sighandler_t
    }

    /// `signal`'s handler now.
    #[cfg(unix)]
    pub(super) fn handler(signal: libc::c_int) -> libc::sighandler_t {
        // SAFETY: with no new action the call only writes the current one into `current`, a valid zeroed sigaction.
        unsafe {
            let mut current: libc::sigaction = std::mem::zeroed();
            if libc::sigaction(signal, std::ptr::null(), &mut current) != 0 {
                return libc::SIG_ERR;
            }
            current.sa_sigaction
        }
    }

    /// Installs the interrupting handler for `signal` if, and only if, no other code holds the signal (its disposition
    /// is the default): a handler another library or the host application installed is never replaced, and one that
    /// appears between the check and the install is put back at once. Installed once per process ([`cancel`]); a
    /// handler is reset to the default in a child process at `exec`, so children are not affected.
    #[cfg(unix)]
    pub(super) fn take_over(signal: libc::c_int) -> bool {
        if handler(signal) != libc::SIG_DFL {
            return false;
        }
        // SAFETY: zeroed sigactions are valid; the handler does nothing, so it is async-signal-safe.
        unsafe {
            let mut action: libc::sigaction = std::mem::zeroed();
            action.sa_sigaction = ours();
            libc::sigemptyset(&mut action.sa_mask);
            // No SA_RESTART: the interrupted call fails with EINTR instead of starting again.
            action.sa_flags = 0;
            let mut previous: libc::sigaction = std::mem::zeroed();
            if libc::sigaction(signal, &action, &mut previous) != 0 {
                return false;
            }
            if previous.sa_sigaction != libc::SIG_DFL {
                libc::sigaction(signal, &previous, std::ptr::null_mut());
                return false;
            }
        }
        true
    }

    /// Interrupts `thread`'s call while the signal's handler is the one installed here: never when another code held the
    /// signal first, and no more once another code replaced the handler (its handler is never run on a producer).
    #[cfg(unix)]
    fn cancel(thread: &JoinHandle<()>) {
        use std::os::unix::thread::JoinHandleExt as _;
        static TAKEN: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        if *TAKEN.get_or_init(|| take_over(INTERRUPT)) && handler(INTERRUPT) == ours() {
            // SAFETY: the thread is joinable (held, not detached), so its id is valid even once it has ended.
            unsafe { libc::pthread_kill(thread.as_pthread_t(), INTERRUPT) };
        }
    }

    #[cfg(not(any(windows, unix)))]
    fn cancel(_: &JoinHandle<()>) {}
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
        /// Every slot is taken and the queue is full: a walk or search that stands for a search-server request is refused
        /// ([`super::Producers::enqueue`], [`super::FsErrorKind::Saturated`]).
        QueueFull,
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
        until(&producers, "the given-up thread ends once its read returns", |c| c == ProducerCounts::default()).await;
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
        until(&producers, "every producer ends once its read returns", |c| c == ProducerCounts::default()).await;
        drop((closed, cut));
    }

    /// Two hundred searches in a row, each held in a read that ignores its cancel: each is given up once the cancel
    /// grace has passed (none here), and its slot, the only one, serves the next; after them a search answers. The
    /// given-up threads hold no slot and end once their reads return.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn two_hundred_reads_that_ignore_the_cancel_leave_the_slot_to_the_next_search() {
        let (_dir, root) = root();
        let file = root.join("a.txt").as_path().to_path_buf();
        std::fs::write(&file, "needle\n").unwrap();
        let producers = Arc::new(Producers::new(scheduler(1, NODE_QUEUE, Duration::ZERO)));
        let mut released = Vec::new();
        for _ in 0..200 {
            let (listing, release, in_read) = hung_listing();
            released.push(release);
            let mut stream = search_over(&producers, &needle_request(&root, None), listing, no_files());
            let _ = within("a stuck search in its read", in_read).await;
            stream.close().await;
        }
        assert_eq!(producers.counts(), ProducerCounts { stalled: 200, ..Default::default() });
        let listing: Listing = Box::new(std::iter::once(Ok(Some(file.clone()))));
        let open: Opener = Box::new(|path| Ok(Box::new(File::open(path)?) as Box<dyn Read + Send>));
        let mut found = search_over(&producers, &needle_request(&root, None), listing, open);
        let hit = within("the next search's match", found.next()).await.unwrap().unwrap();
        assert_eq!((hit.path.as_path(), hit.line, hit.text.as_str()), (file.as_path(), 1, "needle"));
        assert!(within("the next search's end", found.next()).await.is_none());
        found.close().await;
        drop(released);
        until(&producers, "the given-up threads end once their reads return", |c| c == ProducerCounts::default()).await;
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
            until(&producers, "the burst's producers end", |c| c == ProducerCounts::default()).await;
        }
    }

    /// A pipe's reading end that reports its first read as it starts, past the search's last check of its stop.
    struct Reading {
        pipe: io::PipeReader,
        started: Option<oneshot::Sender<()>>,
    }

    impl Read for Reading {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            if let Some(started) = self.started.take() {
                let _ = started.send(());
            }
            self.pipe.read(buf)
        }
    }

    /// A producer held in a real blocking read (a pipe whose writer never writes; on Windows an anonymous pipe is a
    /// named pipe) is cancelled once its stream lets go of it: the read fails, the thread ends and frees its slot, and
    /// the next search, which had no slot, runs.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_producer_in_a_blocked_pipe_read_is_cancelled_and_its_slot_serves_the_next_search() {
        let (_dir, root) = root();
        let file = root.join("a.txt").as_path().to_path_buf();
        std::fs::write(&file, "needle\n").unwrap();
        let producers = Arc::new(Producers::new(scheduler(1, NODE_QUEUE, CLOSE_GRACE)));
        let (reader, writer) = io::pipe().unwrap();
        let (started, in_read) = oneshot::channel::<()>();
        let pipe = Mutex::new(Some(Reading { pipe: reader, started: Some(started) }));
        let listing: Listing = Box::new(std::iter::once(Ok(Some(root.join("pipe").as_path().to_path_buf()))));
        let open: Opener = Box::new(move |_| Ok(Box::new(pipe.lock().unwrap().take().unwrap()) as Box<dyn Read + Send>));
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
        let (reader, writer) = io::pipe().unwrap();
        let (started, in_read) = oneshot::channel::<()>();
        let pipe = Mutex::new(Some(Reading { pipe: reader, started: Some(started) }));
        let listing: Listing = Box::new(std::iter::once(Ok(Some(root.join("pipe").as_path().to_path_buf()))));
        let open: Opener = Box::new(move |_| Ok(Box::new(pipe.lock().unwrap().take().unwrap()) as Box<dyn Read + Send>));
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
        let mut walk = streamed(&producers, Box::new(walking), Deadline::default(), None, false);
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

    /// The interrupting signal is installed only where no other code holds the signal: a handler another code installed
    /// stays, and the default disposition is taken over (here on SIGWINCH, which nothing else in the tests uses).
    #[cfg(unix)]
    #[test]
    fn a_signal_another_handler_holds_is_left_to_it() {
        extern "C" fn other(_: libc::c_int) {}
        let signal = libc::SIGWINCH;
        let other_handler = other as extern "C" fn(libc::c_int) as libc::sighandler_t;
        // SAFETY: zeroed sigactions are valid; `other` does nothing.
        let set = |handler: libc::sighandler_t| unsafe {
            let mut action: libc::sigaction = std::mem::zeroed();
            action.sa_sigaction = handler;
            libc::sigemptyset(&mut action.sa_mask);
            action.sa_flags = libc::SA_RESTART;
            assert_eq!(libc::sigaction(signal, &action, std::ptr::null_mut()), 0);
        };
        set(other_handler);
        assert!(!cancel_io::take_over(signal));
        assert_eq!(cancel_io::handler(signal), other_handler, "another code's handler stays");
        set(libc::SIG_DFL);
        assert!(cancel_io::take_over(signal));
        assert_ne!(cancel_io::handler(signal), libc::SIG_DFL, "a signal nobody holds is taken over");
        set(libc::SIG_DFL);
    }
}
