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

use crate::access::Access;
use crate::access::create_new;
use crate::access::sync_dir;
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
            restore_backup: true,
            keep_without_backup: false,
        }
    }
}

impl Opts {
    fn access(&self) -> Access {
        if self.secret { Access::OwnerOnly } else { Access::Inherit }
    }

    /// What a restore or a backup copy is published with: the file's own access, no backup.
    pub(crate) fn plain(&self) -> Opts {
        Opts { secret: self.secret, mode: self.mode, fsync: self.fsync, ..Opts::default() }
    }
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

fn write_durable(tmp: &Path, data: &[u8], opts: &Opts) -> io::Result<()> {
    record("create", &[tmp]);
    let mut file = create_new(tmp, opts.access(), opts.mode)?;
    file.write_all(data)?;
    if opts.fsync {
        record("fsync", &[tmp]);
        if let Err(error) = file.sync_all()
            && !fsync_refused(&error, false)
        {
            return Err(error);
        }
    }
    Ok(())
}

fn fsync_dir(dir: &Path) -> io::Result<()> {
    record("open-dir", &[]);
    let synced = sync_dir(dir).inspect(|()| record("fsync-dir", &[]));
    match synced {
        Err(error) if !fsync_refused(&error, true) => Err(error),
        _ => Ok(()),
    }
}

/// Retried on the same codes Node retries (`RETRY_CODES`): permission, busy and exists.
fn rename_retryable(error: &io::Error) -> bool {
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
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

pub(crate) fn read_content(path: &Path) -> io::Result<Option<Vec<u8>>> {
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
fn keep_backup(path: &Path, opts: &Opts) -> io::Result<()> {
    let Some(previous) = read_or_null(path)? else { return Ok(()) };
    let keeps = match opts.backup_accepts {
        Some(accepts) => accepts(&previous),
        None => !holds_no_data(&previous),
    };
    if keeps {
        publish(&bak_path(path), &previous, &opts.plain())?;
    }
    Ok(())
}

/// `publishFileSync`.
pub(crate) fn publish(path: &Path, data: &[u8], opts: &Opts) -> io::Result<Published> {
    let dir = parent(path);
    fs::create_dir_all(dir)?;
    let tmp = temp_path(path);
    let result = (|| {
        write_durable(&tmp, data, opts)?;
        if opts.backup && !opts.create_only {
            keep_backup(path, opts)?;
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
                Err(error) => return Err(error),
            }
        } else {
            rename_with_retry(&tmp, path)?;
        }
        if opts.fsync_dir {
            fsync_dir(dir)?;
        }
        Ok(Published::Written)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}
