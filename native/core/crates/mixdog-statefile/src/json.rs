//! JSON state files with `atomic-file.mjs`'s damage handling. A file whose text does not
//! parse, or that the caller's `validate` rejects, is damaged: empty or NUL-filled after a
//! crash, truncated, or broken by hand. Its feature must keep working, so the damaged file is
//! moved aside to `<file>.corrupt-<ms>` (its bytes kept, never overwritten) and the last good
//! copy `<file>.bak` is restored when there is one. A file that cannot be READ is not damaged
//! and is an error. A file a newer build wrote is intact, not damaged: it stays untouched and
//! the read answers the caller's fallback.

use std::convert::Infallible;
use std::io;
use std::path::Path;
use std::path::PathBuf;

use mixdog_rt::InLane;
use serde_json::Value;

use crate::IoLane;
use crate::WriteLane;
use crate::lock::LockError;
use crate::lock::lock_path;
use crate::lock::locked;
use crate::publish::Opts;
use crate::publish::Published;
use crate::publish::backup_path;
use crate::publish::publish;
use crate::publish::read_content;

/// Why `validate` rejects a parsed value.
#[derive(Clone, Debug)]
pub enum Invalid {
    /// Damage: the file is set aside.
    Damaged(String),
    /// Intact, but in a format a newer build wrote (`unsupportedState`).
    Unsupported(String),
}

/// The caller's check of a parsed value.
pub type Validate<'a> = &'a dyn Fn(&Value) -> Result<(), Invalid>;

/// Why a state operation failed.
#[derive(Debug)]
pub enum StateError<E = Infallible> {
    Io(io::Error),
    Lock(LockError),
    /// The caller's mutator refused.
    Mutator(E),
}

impl<E: std::fmt::Display> std::fmt::Display for StateError<E> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StateError::Io(error) => error.fmt(f),
            StateError::Lock(error) => error.fmt(f),
            StateError::Mutator(error) => error.fmt(f),
        }
    }
}

impl<E: std::fmt::Debug + std::fmt::Display> std::error::Error for StateError<E> {}

impl<E> From<io::Error> for StateError<E> {
    fn from(error: io::Error) -> Self {
        StateError::Io(error)
    }
}

impl<E> From<LockError> for StateError<E> {
    fn from(error: LockError) -> Self {
        StateError::Lock(error)
    }
}

/// What a state file holds.
#[derive(Debug)]
pub enum Peek {
    Absent,
    Value(Value),
    /// Intact, written by a newer build.
    Unsupported,
    Damaged(String),
}

enum Parsed {
    Absent,
    Ok { value: Value, content: Vec<u8> },
    Unsupported,
    Damaged(String),
}

/// The JSON of `content`: invalid UTF-8 decodes lossily and a leading byte order mark (what
/// Windows editors and PowerShell 5 write) is skipped.
pub fn parse_json_text(content: &[u8]) -> Result<Value, serde_json::Error> {
    let text = String::from_utf8_lossy(content);
    serde_json::from_str(text.strip_prefix('\u{feff}').unwrap_or(&text))
}

/// Whether `content` parses (a JSON write's backup takes only such a version).
pub fn is_json_content(content: &[u8]) -> bool {
    parse_json_text(content).is_ok()
}

fn parse(content: Option<Vec<u8>>, validate: Option<Validate>) -> Parsed {
    let Some(content) = content else { return Parsed::Absent };
    let value = match parse_json_text(&content) {
        Ok(value) => value,
        Err(error) => return Parsed::Damaged(error.to_string()),
    };
    match validate.map_or(Ok(()), |validate| validate(&value)) {
        Ok(()) => Parsed::Ok { value, content },
        Err(Invalid::Unsupported(_)) => Parsed::Unsupported,
        Err(Invalid::Damaged(reason)) => Parsed::Damaged(reason),
    }
}

/// `<file>.corrupt-<ms>`: the first stamp from `stamp` on whose name does not exist yet, so two
/// recoveries in one millisecond (or after a clock rollback) never overwrite a kept copy.
/// Recovery runs under the file's lock, so nothing else takes a name between check and rename.
pub(crate) fn quarantine_path_from(path: &Path, mut stamp: u128) -> PathBuf {
    loop {
        let mut name = path.as_os_str().to_owned();
        name.push(format!(".corrupt-{stamp}"));
        let candidate = PathBuf::from(name);
        if !candidate.exists() {
            return candidate;
        }
        stamp += 1;
    }
}

fn quarantine_path(path: &Path) -> PathBuf {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
    quarantine_path_from(path, now)
}

fn report_damaged(path: &Path, reason: &str, outcome: &str) {
    tracing::warn!("[state] {} is damaged ({reason}); {outcome}", path.display());
}

/// Caller holds the file's lock. The file is read again, so one another process has repaired
/// meanwhile is kept. `keep_without_backup` leaves a damaged file in place when there is no
/// good copy: for a file other readers treat "missing" as permissive (a deny list), moving it
/// would fail open. `restore_backup` false never restores `.bak`.
fn recover(path: &Path, validate: Option<Validate>, opts: &Opts) -> io::Result<Option<Value>> {
    let reason = match parse(read_content(path)?, validate) {
        Parsed::Ok { value, .. } => return Ok(Some(value)),
        Parsed::Absent | Parsed::Unsupported => return Ok(None),
        Parsed::Damaged(reason) => reason,
    };
    let backup = if opts.restore_backup { parse(read_content(&backup_path(path))?, validate) } else { Parsed::Absent };
    if !matches!(backup, Parsed::Ok { .. }) && opts.keep_without_backup {
        report_damaged(path, &reason, "left in place: no good copy to restore");
        return Ok(None);
    }
    let aside = quarantine_path(path);
    crate::publish::rename_with_retry(path, &aside)?;
    match backup {
        Parsed::Ok { value, content } => {
            publish(path, &content, &opts.plain())?;
            report_damaged(path, &reason, &format!("kept as {}; restored the last good copy", aside.display()));
            Ok(Some(value))
        }
        _ => {
            report_damaged(path, &reason, &format!("kept as {}; starting empty", aside.display()));
            Ok(None)
        }
    }
}

/// What the file holds, touching nothing: the first read of a state file, on a read lane.
pub fn peek<L: IoLane>(_lane: &InLane<L>, path: &Path, validate: Option<Validate>) -> io::Result<Peek> {
    Ok(match parse(read_content(path)?, validate) {
        Parsed::Absent => Peek::Absent,
        Parsed::Ok { value, .. } => Peek::Value(value),
        Parsed::Unsupported => Peek::Unsupported,
        Parsed::Damaged(reason) => Peek::Damaged(reason),
    })
}

/// `readJsonStateSync`: the validated value, or `None` (the caller's fallback) when the file is
/// missing, a newer build's, or damaged with no good backup. A damaged file is recovered under
/// its lock; while another holder keeps the lock for the whole wait the file is left in place.
/// Other failures, an unreadable file among them, are errors.
pub fn read_json<L: WriteLane>(
    _lane: &InLane<L>,
    path: &Path,
    validate: Option<Validate>,
    opts: &Opts,
) -> io::Result<Option<Value>> {
    let reason = match parse(read_content(path)?, validate) {
        Parsed::Ok { value, .. } => return Ok(Some(value)),
        Parsed::Absent | Parsed::Unsupported => return Ok(None),
        Parsed::Damaged(reason) => reason,
    };
    match locked(&lock_path(path), opts.lock_timeout, || recover(path, validate, opts)) {
        Ok(recovered) => recovered,
        Err(LockError::Io(error)) => Err(error),
        Err(_busy) => {
            report_damaged(path, &reason, "left in place while another writer holds its lock");
            Ok(None)
        }
    }
}

/// `writeFileAtomicSync`. Create-only answers [`Published::Exists`] when the target exists.
pub fn write_file<L: WriteLane>(
    _lane: &InLane<L>,
    path: &Path,
    data: &[u8],
    opts: &Opts,
) -> Result<Published, StateError> {
    if opts.lock {
        return Ok(locked(&lock_path(path), opts.lock_timeout, || publish(path, data, opts))??);
    }
    Ok(publish(path, data, opts)?)
}

fn json_bytes(value: &Value, opts: &Opts) -> Vec<u8> {
    let mut text = mixdog_js::json_stringify_indent(value, if opts.compact { 0 } else { 2 });
    text.push('\n');
    text.into_bytes()
}

fn publish_json(path: &Path, value: &Value, opts: &Opts) -> io::Result<Published> {
    // A JSON write's backup takes only a replaced version that still parses.
    let mut opts = opts.clone();
    if opts.backup && opts.backup_accepts.is_none() {
        opts.backup_accepts = Some(is_json_content);
    }
    publish(path, &json_bytes(value, &opts), &opts)
}

/// `writeJsonAtomicSync`: `JSON.stringify(value, null, 2)` and a newline.
pub fn write_json<L: WriteLane>(
    _lane: &InLane<L>,
    path: &Path,
    value: &Value,
    opts: &Opts,
) -> Result<Published, StateError> {
    if opts.lock {
        return Ok(locked(&lock_path(path), opts.lock_timeout, || publish_json(path, value, opts))??);
    }
    Ok(publish_json(path, value, opts)?)
}

/// `updateJsonAtomicSync`: under the file's lock, read (a damaged file is kept aside, never
/// silently overwritten, and its last good copy is the mutator's input; a missing one is
/// `None`), run `mutator`, and write what it returns. `Ok(None)` from the mutator writes
/// nothing. The answer is the new value, or the value read when nothing was written.
pub fn update_json<L: WriteLane, E>(
    _lane: &InLane<L>,
    path: &Path,
    mutator: impl FnOnce(Option<Value>) -> Result<Option<Value>, E>,
    opts: &Opts,
) -> Result<Option<Value>, StateError<E>> {
    locked(&lock_path(path), opts.lock_timeout, || {
        let current = match parse(read_content(path)?, None) {
            Parsed::Ok { value, .. } => Some(value),
            Parsed::Absent | Parsed::Unsupported => None,
            Parsed::Damaged(_) => recover(path, None, opts)?,
        };
        match mutator(current.clone()).map_err(StateError::Mutator)? {
            None => Ok(current),
            Some(next) => {
                publish_json(path, &next, opts)?;
                Ok(Some(next))
            }
        }
    })?
}

/// `renameWithRetrySync`: `fs::rename(src, dst)` retried on EPERM / EACCES / EBUSY / EEXIST
/// (Windows: access denied, sharing and lock violations, exists) on Node's schedule, 25, 50,
/// 100 ms, then 200 ms, with jitter, at most 24 attempts; a refusal over a read-only target
/// ends it at once. Sleeps on the lane thread.
pub fn rename_with_retry<L: WriteLane>(_lane: &InLane<L>, src: &Path, dst: &Path) -> io::Result<()> {
    crate::publish::rename_with_retry(src, dst)
}

/// `withFileLockSync` over `<file>.lock`.
pub fn with_lock<L: WriteLane, R>(
    _lane: &InLane<L>,
    path: &Path,
    timeout: Option<std::time::Duration>,
    body: impl FnOnce() -> R,
) -> Result<R, LockError> {
    locked(&lock_path(path), timeout, body)
}
