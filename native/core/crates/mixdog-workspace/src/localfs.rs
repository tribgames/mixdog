#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "blocking file bodies run only as lane jobs (`on`, `stream`); the service never calls them on an async thread")]
//! The real [`FileService`] (DS §4.2) for the agent tools and the tidy write host, over absolute
//! paths on the local disk.
//!
//! Writes are Node's `atomicWrite` (`atomic-write.mjs`): a `wx` temp file beside the target, fsync,
//! rename into place with the Windows retry ladder, directory fsync, write *through* a leaf symlink,
//! the target's mode kept. Batches are `apply_patch`'s rollback (`rollback-state.mjs`): a pre-image
//! of every path, an in-place restore on failure. Walks and text search are ripgrep's own
//! `ignore`/`grep` crates, which is what Node's resident search server runs.
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
use std::sync::Mutex;
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
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tokio_util::sync::DropGuard;

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

    fn walk(&self, lane: MaintenanceIo, request: WalkRequest) -> Box<dyn EventSource<Result<DirEntry, FsError>>> {
        stream(lane, move |tx, stop| {
            let root = request.root.as_path();
            let mut builder = WalkBuilder::new(root);
            builder.hidden(!request.include_hidden).sort_by_file_path(|a, b| a.cmp(b));
            if !request.recursive {
                builder.max_depth(Some(1));
            }
            match overrides_for(root, Vec::new()) {
                Ok(overrides) => builder.overrides(overrides),
                Err(error) => {
                    let _ = tx.send(Err(invalid_pattern(&error, root)));
                    return;
                }
            };
            ignore_rules(&mut builder, request.respect_ignore);
            for item in builder.build() {
                if stop() {
                    return;
                }
                let sent = match item {
                    Ok(entry) if entry.depth() == 0 => continue,
                    Ok(entry) => {
                        let Some(kind) = entry.file_type().map(entry_kind) else { continue };
                        if kind == EntryKind::Dir && !request.include_dirs {
                            continue;
                        }
                        let Some(path) = AbsPath::new(entry.into_path()) else { continue };
                        tx.send(Ok(DirEntry { path, kind }))
                    }
                    Err(error) => tx.send(Err(walk_error(&error, root))),
                };
                if sent.is_err() {
                    return;
                }
            }
        })
    }

    fn search_text(&self, lane: MaintenanceIo, request: SearchRequest) -> Box<dyn EventSource<Result<SearchMatch, FsError>>> {
        stream(lane, move |tx, stop| {
            let root = request.root.as_path();
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
                    let _ = tx.send(Err(FsError::new(FsErrorKind::InvalidPattern { message: error.to_string() }, Some(request.root.clone()))));
                    return;
                }
            };
            // ripgrep's rule: later globs win, so the excludes follow the includes.
            let globs = request.include_globs.iter().cloned().chain(request.exclude_globs.iter().map(|g| format!("!{g}"))).collect();
            let overrides = match overrides_for(root, globs) {
                Ok(overrides) => overrides,
                Err(error) => {
                    let _ = tx.send(Err(invalid_pattern(&error, root)));
                    return;
                }
            };
            let mut builder = WalkBuilder::new(root);
            builder.hidden(!request.include_hidden).overrides(overrides);
            ignore_rules(&mut builder, request.respect_ignore);
            let mut files = Vec::new();
            for item in builder.build() {
                if stop() {
                    return;
                }
                match item {
                    Ok(entry) if entry.file_type().is_some_and(|t| t.is_file()) => files.push(entry.into_path()),
                    Ok(_) => {}
                    Err(error) => {
                        if tx.send(Err(walk_error(&error, root))).is_err() {
                            return;
                        }
                    }
                }
            }
            // Node sorts content results by path.
            files.sort();
            let mut searcher = SearcherBuilder::new().line_number(true).binary_detection(BinaryDetection::quit(b'\x00')).build();
            for file in files {
                if stop() {
                    return;
                }
                let Some(path) = AbsPath::new(&file) else { continue };
                let mut sink = Collect { matcher: &matcher, path: &path, tx: &tx };
                match searcher.search_path(&matcher, &file, &mut sink) {
                    Ok(()) => {}
                    Err(e) if e.kind() == io::ErrorKind::BrokenPipe => return,
                    Err(e) => {
                        if tx.send(Err(io_error(&e, &file))).is_err() {
                            return;
                        }
                    }
                }
            }
        })
    }
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

/// One line per match, like ripgrep's standard printer; the column is the first match's byte start.
struct Collect<'a> {
    matcher: &'a grep::regex::RegexMatcher,
    path: &'a AbsPath,
    tx: &'a mpsc::UnboundedSender<Result<SearchMatch, FsError>>,
}

impl Sink for Collect<'_> {
    type Error = io::Error;

    fn matched(&mut self, _: &Searcher, found: &SinkMatch<'_>) -> Result<bool, io::Error> {
        let bytes = found.bytes();
        let column = self.matcher.find(bytes).ok().flatten().map_or(0, |m| m.start()) as u64 + 1;
        // `str::lines`, as the resident server does: only the terminator (`\n` or `\r\n`) goes.
        let text = String::from_utf8_lossy(bytes).lines().next().unwrap_or_default().to_owned();
        let line = found.line_number().unwrap_or(0);
        Ok(self.tx.send(Ok(SearchMatch { path: self.path.clone(), line, column, text })).is_ok())
    }
}

struct Channel<T> {
    rx: mpsc::UnboundedReceiver<T>,
    _cancel: DropGuard,
}

#[async_trait]
impl<T: Send> EventSource<T> for Channel<T> {
    async fn next(&mut self) -> Option<T> {
        self.rx.recv().await
    }
}

/// Runs `body` on the maintenance lane and streams what it sends. Dropping the stream cancels a
/// job that has not started and stops one that has at its next item.
fn stream<T, F>(lane: MaintenanceIo, body: F) -> Box<dyn EventSource<Result<T, FsError>>>
where
    T: Send + 'static,
    F: FnOnce(mpsc::UnboundedSender<Result<T, FsError>>, &dyn Fn() -> bool) + Send + 'static,
{
    let (tx, rx) = mpsc::unbounded_channel();
    let cancel = CancellationToken::new();
    let job_cancel = cancel.clone();
    let failed = tx.clone();
    let job = counted(move || {
        let probe = tx.clone();
        body(tx, &|| job_cancel.is_cancelled() || probe.is_closed());
    });
    let submitted = lane.submit(&cancel, move |_| job());
    if submitted.is_err() {
        let _ = failed.send(Err(FsError::new(FsErrorKind::Io { os_code: None }, None)));
    }
    Box::new(Channel { rx, _cancel: cancel.drop_guard() })
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
            mixdog_rt::time::timeout(Duration::from_secs(5), fs.write(l.durability, put(&file, b"x", WritePrecondition::Unconditional)))
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
        mixdog_rt::time::sleep(Duration::from_millis(150)).await;
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
        let mut walk = fs.walk(l.maintenance, WalkRequest { root: root.clone(), recursive: true, include_dirs: true, include_hidden: true, respect_ignore: false });
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
        };
        let found = run(base.clone()).await;
        // ripgrep quits a file at its first NUL, so bin.rs reports nothing; skip/ is gitignored.
        assert_eq!(found, vec![("a.rs".into(), 1, 5, "let Needle = 1;".into()), ("a.rs".into(), 2, 1, "needle".into())]);
        let all = run(SearchRequest { respect_ignore: false, ..base }).await;
        assert!(all.iter().any(|m| m.0 == "c.rs") && all.iter().all(|m| m.0 != "bin.rs"));
    }
}
