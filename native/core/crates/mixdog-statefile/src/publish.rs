//! Atomic publication of one file, in `atomic-file.mjs`'s order: a uniquely named temp file is
//! written and flushed through the handle that wrote it, the replaced version is kept as
//! `<file>.bak` when asked, then the temp is renamed over the target (or linked, for
//! create-only) and the directory is flushed when asked.

use std::fs;
use std::io;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;

use mixdog_rt::InLane;

use crate::WriteLane;
use crate::access::Access;
use crate::access::create_new;
use crate::access::sync_dir;
use crate::lock::LockOpts;
use crate::lock::backoff_ms;
use crate::trace::record;

/// `atomic-file.mjs`'s option bag.
#[derive(Clone, Debug)]
pub struct Opts {
    /// Owner-only access, fixed when the file is created.
    pub secret: bool,
    /// Unix mode of a new file (default 0600).
    pub mode: u32,
    /// Keep the replaced version as `<file>.bak`.
    pub backup: bool,
    /// Which replaced content a backup takes; default: anything that is not NUL and blanks
    /// only (JSON writes: anything that parses).
    pub backup_accepts: Option<fn(&[u8]) -> bool>,
    /// Flush the file before publishing it (default true).
    pub fsync: bool,
    /// Flush the directory after publishing (default false).
    pub fsync_dir: bool,
    /// Publish only if the target does not exist.
    pub create_only: bool,
    /// `JSON.stringify(value, null, 0)` instead of two-space indentation.
    pub compact: bool,
    /// Hold the file's lock around the write.
    pub lock: bool,
    /// Lock wait; `None` is [`crate::default_timeout`].
    pub lock_timeout: Option<Duration>,
    /// How long a lock naming no owner lives before it is reclaimable (default 30 s).
    pub lock_stale: Option<Duration>,
    /// A lock naming no owner is never reclaimed.
    pub lock_strict_owner: bool,
    /// Restore `<file>.bak` over a damaged file (default true).
    pub restore_backup: bool,
    /// Leave a damaged file in place when there is no good backup.
    pub keep_without_backup: bool,
}

impl Default for Opts {
    fn default() -> Self {
        Self {
            secret: false,
            mode: 0o600,
            backup: false,
            backup_accepts: None,
            fsync: true,
            fsync_dir: false,
            create_only: false,
            compact: false,
            lock: false,
            lock_timeout: None,
            lock_stale: None,
            lock_strict_owner: false,
            restore_backup: true,
            keep_without_backup: false,
        }
    }
}

impl Opts {
    fn access(&self) -> Access {
        if self.secret { Access::OwnerOnly } else { Access::Inherit }
    }

    pub(crate) fn lock_opts(&self) -> LockOpts {
        LockOpts { timeout: self.lock_timeout, stale: self.lock_stale, strict_owner: self.lock_strict_owner }
    }

    /// `backupWriteOpts`: a backup copy keeps the file's mode, access and fsync choice.
    pub(crate) fn backup_opts(&self) -> Opts {
        Opts { secret: self.secret, mode: self.mode, fsync: self.fsync, ..Opts::default() }
    }

    /// `restoreOpts`: a restored copy keeps the file's mode and access, and is always flushed:
    /// the caller's `fsync: false` does not reach it.
    pub(crate) fn restore_opts(&self) -> Opts {
        Opts { secret: self.secret, mode: self.mode, ..Opts::default() }
    }
}

/// The call of a publication that failed, named as `atomic-file.mjs`'s own `fs` call so a caller
/// can word the error as Node does.
#[derive(Debug)]
pub enum Step {
    /// `mkdirSync(dir, { recursive: true })`.
    Mkdir(PathBuf),
    /// `openSync(path, 'wx')` of the temp file, or `readFileSync` of the file being replaced.
    Open(PathBuf),
    /// `readFileSync` of a directory: the failing call is the `read` after the open.
    Read,
    /// `writeFileSync(fd, ..)`.
    Write,
    /// `fsyncSync(fd)`.
    Fsync,
    /// `renameSync(from, to)`.
    Rename(PathBuf, PathBuf),
    /// Linking a create-only file, or flushing the directory.
    Other,
}

/// A failed publication and the step it failed at.
#[derive(Debug)]
pub struct PublishFailure {
    pub step: Step,
    pub error: io::Error,
}

impl From<PublishFailure> for io::Error {
    fn from(failure: PublishFailure) -> Self {
        failure.error
    }
}

fn at(step: Step) -> impl FnOnce(io::Error) -> PublishFailure {
    move |error| PublishFailure { step, error }
}

/// What a publication did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Published {
    Written,
    /// Create-only, and the target already exists: left as it is.
    Exists,
}

/// `holdsNoData`: nothing but NUL and blanks, what a crash leaves of a file whose data never
/// reached disk.
pub fn holds_no_data(content: &[u8]) -> bool {
    content.iter().all(|b| matches!(b, 0 | b' ' | b'\t' | b'\n' | b'\r'))
}

/// `<name>.mixdog-tmp-<16 hex>` beside `path`; no leading dot, which cloud-sync drives refuse.
fn temp_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_owned();
    name.push(format!(".mixdog-tmp-{:016x}", rand::random::<u64>()));
    path.with_file_name(name)
}

fn parent(path: &Path) -> &Path {
    match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    }
}

/// A filesystem refusing fsync (network and cloud-sync drives) answers with one of these;
/// durability is best-effort there.
fn fsync_refused(error: &io::Error, directory: bool) -> bool {
    #[cfg(unix)]
    {
        error.raw_os_error().is_some_and(|code| {
            code == libc::EPERM || code == libc::ENOTSUP || code == libc::EINVAL || (directory && code == libc::EACCES)
        })
    }
    #[cfg(windows)]
    {
        let _ = directory;
        matches!(
            error.kind(),
            io::ErrorKind::PermissionDenied | io::ErrorKind::Unsupported | io::ErrorKind::InvalidInput
        )
    }
}

fn write_durable<L: WriteLane>(
    lane: &InLane<L>,
    tmp: &Path,
    data: &[u8],
    opts: &Opts,
) -> Result<(), PublishFailure> {
    record("create", &[tmp]);
    let mut file = create_new(lane, tmp, opts.access(), opts.mode).map_err(at(Step::Open(tmp.to_owned())))?;
    file.write_all(data).map_err(at(Step::Write))?;
    if opts.fsync {
        record("fsync", &[tmp]);
        if let Err(error) = file.sync_all()
            && !fsync_refused(&error, false)
        {
            return Err(PublishFailure { step: Step::Fsync, error });
        }
    }
    Ok(())
}

fn fsync_dir<L: WriteLane>(lane: &InLane<L>, dir: &Path) -> io::Result<()> {
    record("open-dir", &[]);
    let synced = sync_dir(lane, dir).inspect(|()| record("fsync-dir", &[]));
    match synced {
        Err(error) if !fsync_refused(&error, true) => Err(error),
        _ => Ok(()),
    }
}

/// Retried on the same codes Node retries (`RETRY_CODES`): permission, busy and exists.
pub(crate) fn rename_retryable(error: &io::Error) -> bool {
    #[cfg(unix)]
    {
        error
            .raw_os_error()
            .is_some_and(|c| c == libc::EPERM || c == libc::EACCES || c == libc::EBUSY || c == libc::EEXIST)
    }
    #[cfg(windows)]
    {
        // ACCESS_DENIED, SHARING_VIOLATION, LOCK_VIOLATION, FILE_EXISTS, ALREADY_EXISTS.
        error.raw_os_error().is_some_and(|c| matches!(c, 5 | 32 | 33 | 80 | 183))
    }
}

fn permission_refused(error: &io::Error) -> bool {
    #[cfg(unix)]
    {
        error.raw_os_error().is_some_and(|c| c == libc::EPERM || c == libc::EACCES)
    }
    #[cfg(windows)]
    {
        error.raw_os_error() == Some(5)
    }
}

/// Windows answers a refusal both for a sharing violation (clears in moments) and for renaming
/// over a read-only file (never clears); only the first is worth waiting for.
fn is_read_only_file(path: &Path) -> bool {
    let Ok(meta) = fs::metadata(path) else { return false };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o200 == 0
    }
    #[cfg(windows)]
    {
        meta.permissions().readonly()
    }
}

/// The wait before attempt `attempt + 1`, or `None` when this error or attempt count ends the
/// loop (`nextRenameDelayMs`).
pub(crate) fn next_rename_delay(error: &io::Error, attempt: usize, dst: &Path) -> Option<Duration> {
    if !rename_retryable(error) || attempt >= 23 {
        return None;
    }
    if permission_refused(error) && is_read_only_file(dst) {
        return None;
    }
    let base = backoff_ms(attempt);
    Some(Duration::from_millis(base + rand::random::<u64>() % base.clamp(1, 50)))
}

/// `renameWithRetrySync`.
pub(crate) fn rename_with_retry(src: &Path, dst: &Path) -> io::Result<()> {
    let mut attempt = 0;
    loop {
        record("rename", &[src, dst]);
        match fs::rename(src, dst) {
            Ok(()) => return Ok(()),
            Err(error) => match next_rename_delay(&error, attempt, dst) {
                Some(delay) => std::thread::sleep(delay),
                None => return Err(error),
            },
        }
        attempt += 1;
    }
}

fn read_or_null(path: &Path) -> io::Result<Option<Vec<u8>>> {
    // On Windows a read racing another writer's rename-over fails with a sharing violation
    // (PermissionDenied) for a few milliseconds; Node's reader has the same window and no retry,
    // which an unlocked concurrent writer then loses at random.
    let mut attempt = 0;
    loop {
        match fs::read(path) {
            Ok(bytes) => return Ok(Some(bytes)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied && attempt < 20 && !path.is_dir() => {
                attempt += 1;
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            Err(error) => return Err(error),
        }
    }
}

/// The file's bytes, `None` when it is missing.
pub fn read_content(path: &Path) -> io::Result<Option<Vec<u8>>> {
    read_or_null(path)
}

fn bak_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".bak");
    PathBuf::from(name)
}

pub(crate) fn backup_path(path: &Path) -> PathBuf {
    bak_path(path)
}

/// `keepBackupSync`: the version being replaced, if it is worth keeping.
fn keep_backup<L: WriteLane>(lane: &InLane<L>, path: &Path, opts: &Opts) -> Result<(), PublishFailure> {
    let previous = match read_or_null(path) {
        Ok(Some(previous)) => previous,
        Ok(None) => return Ok(()),
        // Node reads a directory as `open` then a failing `read`.
        Err(_) if path.is_dir() => {
            return Err(PublishFailure { step: Step::Read, error: io::ErrorKind::IsADirectory.into() });
        }
        Err(error) => return Err(PublishFailure { step: Step::Open(path.to_owned()), error }),
    };
    let keeps = match opts.backup_accepts {
        Some(accepts) => accepts(&previous),
        None => !holds_no_data(&previous),
    };
    if keeps {
        publish(lane, &bak_path(path), &previous, &opts.backup_opts())?;
    }
    Ok(())
}

/// `publishFileSync`.
pub(crate) fn publish<L: WriteLane>(
    lane: &InLane<L>,
    path: &Path,
    data: &[u8],
    opts: &Opts,
) -> Result<Published, PublishFailure> {
    let dir = parent(path);
    fs::create_dir_all(dir).map_err(at(Step::Mkdir(dir.to_owned())))?;
    let tmp = temp_path(path);
    let result = (|| {
        write_durable(lane, &tmp, data, opts)?;
        if opts.backup && !opts.create_only {
            keep_backup(lane, path, opts)?;
        }
        if opts.create_only {
            // Atomic create-if-absent: the link fails when the target exists at link time, so
            // a concurrent writer that created it first wins.
            record("link", &[&tmp, path]);
            let linked = fs::hard_link(&tmp, path);
            record("unlink", &[&tmp]);
            let _ = fs::remove_file(&tmp);
            match linked {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => return Ok(Published::Exists),
                Err(error) => return Err(PublishFailure { step: Step::Other, error }),
            }
        } else {
            rename_with_retry(&tmp, path).map_err(at(Step::Rename(tmp.clone(), path.to_owned())))?;
        }
        if opts.fsync_dir {
            fsync_dir(lane, dir).map_err(at(Step::Other))?;
        }
        Ok(Published::Written)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}
