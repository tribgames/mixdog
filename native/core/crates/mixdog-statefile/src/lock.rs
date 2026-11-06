//! The lock of one state file, in `file-lock.mjs`'s protocol, so a Node process and this port
//! exclude each other on the same `<file>.lock`.
//!
//! The lock is published by hard-linking a staged file that already holds the owner record
//! (`<pid> <ms> <token>`) to the lock path: the link fails while the lock exists, and the lock
//! never exists without a readable owner. Release unlinks it while it still names this process
//! and token. A lock whose owner process is dead (or that names no owner and outlived the stale
//! window) is reclaimed under a `<lock>.reclaim` guard. Waiting polls with Node's timeout and
//! backoff schedule.

use std::cell::RefCell;
use std::collections::HashMap;
use std::collections::HashSet;
use std::fs;
use std::io;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::Duration;
use std::time::Instant;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use crate::publish::rename_retryable;

/// `DEFAULT_LOCK_TIMEOUT_MS`, or `MIXDOG_LOCK_TIMEOUT_MS` when that is a number of at least 0.
pub fn default_timeout() -> Duration {
    static TIMEOUT: OnceLock<Duration> = OnceLock::new();
    *TIMEOUT.get_or_init(|| {
        let configured = std::env::var("MIXDOG_LOCK_TIMEOUT_MS")
            .ok()
            .and_then(|text| mixdog_js::string_to_number(&text).into())
            .filter(|ms: &f64| ms.is_finite() && *ms >= 0.0);
        Duration::from_millis(configured.map_or(2000, |ms| ms as u64))
    })
}

/// A lock holder's guard against its own stale record: `lockStaleMs`.
const DEFAULT_STALE: Duration = Duration::from_secs(30);
/// A reclaim guard older than this whose owner is dead was stranded by a process that died
/// inside the reclaim.
const RECLAIM_GUARD_STALE: Duration = Duration::from_secs(30);
/// A staged owner record (one link call long) older than this whose pid is dead is swept.
const STAGED_STALE: Duration = Duration::from_secs(60);

/// Lock options: `timeoutMs`, `staleMs`, `strictOwner`.
#[derive(Clone, Copy, Debug, Default)]
pub struct LockOpts {
    /// Wait; `None` is [`default_timeout`]; zero tries once.
    pub timeout: Option<Duration>,
    /// How long a lock that names no owner lives before it is reclaimable (default 30 s).
    pub stale: Option<Duration>,
    /// A lock that names no owner is never reclaimed.
    pub strict_owner: bool,
}

/// Why a lock was not taken.
#[derive(Debug)]
pub enum LockError {
    /// Try-once (`timeout` 0) and another holder has it (`ELOCKCONTENDED`).
    Contended { path: PathBuf, holder: String },
    /// Held by another for the whole wait (`ELOCKTIMEOUT`).
    Timeout { path: PathBuf, timeout: Duration, holder: String },
    Io(io::Error),
}

impl LockError {
    /// Node's error code for the two busy cases.
    pub fn code(&self) -> Option<&'static str> {
        match self {
            LockError::Contended { .. } => Some("ELOCKCONTENDED"),
            LockError::Timeout { .. } => Some("ELOCKTIMEOUT"),
            LockError::Io(_) => None,
        }
    }

    /// The other holder kept the lock; nothing failed.
    pub fn is_busy(&self) -> bool {
        self.code().is_some()
    }
}

impl std::fmt::Display for LockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LockError::Contended { path, holder } => {
                write!(f, "atomic lock contended (try-once): {} [{holder}]", path.display())
            }
            LockError::Timeout { path, timeout, holder } => {
                write!(f, "atomic lock timeout after {}ms: {} [{holder}]", timeout.as_millis(), path.display())
            }
            LockError::Io(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for LockError {}

impl From<io::Error> for LockError {
    fn from(error: io::Error) -> Self {
        LockError::Io(error)
    }
}

/// `<file>.lock`.
pub fn lock_path(file: &Path) -> PathBuf {
    let mut name = file.as_os_str().to_owned();
    name.push(".lock");
    PathBuf::from(name)
}

/// `DEFAULT_BACKOFFS_MS`: 25, 50, 100, then 200 ms.
pub(crate) fn backoff_ms(attempt: usize) -> u64 {
    [25, 50, 100].get(attempt).copied().unwrap_or(200)
}

/// Jittered wait before the next attempt, never past the deadline (`lockRetryDelayMs`).
fn retry_delay(attempt: usize, deadline: Instant) -> Duration {
    let base = backoff_ms(attempt);
    let jitter = rand::random::<u64>() % base.clamp(1, 75);
    let left = deadline.saturating_duration_since(Instant::now()).max(Duration::from_millis(1));
    left.min(Duration::from_millis(base + jitter))
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis())
}

fn hex16() -> String {
    format!("{:016x}", rand::random::<u64>())
}

/// This process's token: told apart from another holder that shares the pid.
fn owner_token() -> &'static str {
    static TOKEN: OnceLock<String> = OnceLock::new();
    TOKEN.get_or_init(|| format!("{:024x}", rand::random::<u128>() >> 32))
}

struct Owner {
    pid: Option<u32>,
    token: Option<String>,
}

/// `readLockOwner`: `<pid> <ms> <token>`, or the legacy `{"pid":N,...}`. Unreadable is no owner.
fn read_owner(path: &Path) -> Owner {
    let none = Owner { pid: None, token: None };
    let Ok(bytes) = fs::read(path) else { return none };
    let text = String::from_utf8_lossy(&bytes);
    let text = text.trim();
    if text.starts_with('{') {
        let pid = mixdog_js::json_parse(text)
            .ok()
            .and_then(|doc| doc.get("pid").and_then(serde_json::Value::as_f64))
            .filter(|pid| pid.fract() == 0.0 && *pid > 0.0 && *pid < f64::from(u32::MAX))
            .map(|pid| pid as u32);
        return Owner { pid, token: None };
    }
    let parts: Vec<&str> = text.split_whitespace().collect();
    // `parseInt`: the leading digits.
    let digits: String = parts.first().map(|p| p.chars().take_while(char::is_ascii_digit).collect()).unwrap_or_default();
    Owner {
        pid: digits.parse::<u32>().ok().filter(|pid| *pid > 0),
        token: (parts.len() >= 3).then(|| parts[2].to_owned()),
    }
}

#[cfg(unix)]
fn process_exists(pid: u32) -> bool {
    // SAFETY: signal 0 only checks that the process can be signalled.
    if unsafe { libc::kill(pid as libc::pid_t, 0) } == 0 {
        return true;
    }
    io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

#[cfg(windows)]
fn process_exists(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::Foundation::ERROR_INVALID_PARAMETER;
    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::Foundation::STILL_ACTIVE;
    use windows_sys::Win32::System::Threading::GetExitCodeProcess;
    use windows_sys::Win32::System::Threading::OpenProcess;
    use windows_sys::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION;
    // SAFETY: plain handle query; the handle is closed below.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        // Only "no such process" proves death; a refusal means it exists.
        // SAFETY: reads the calling thread's last error.
        return unsafe { GetLastError() } != ERROR_INVALID_PARAMETER;
    }
    let mut code = 0u32;
    // SAFETY: `handle` is a valid process handle; `code` is an out-parameter.
    let ok = unsafe { GetExitCodeProcess(handle, &mut code) };
    // SAFETY: `handle` was opened above.
    unsafe { CloseHandle(handle) };
    ok == 0 || code == STILL_ACTIVE as u32
}

/// `ownerIsLive`: worker threads share a pid, so this process's own pid is always live; a
/// foreign or missing token is not proof of death.
fn owner_is_live(owner: &Owner) -> bool {
    match owner.pid {
        None => false,
        Some(pid) if pid == std::process::id() => true,
        Some(pid) => process_exists(pid),
    }
}

fn owned_by_self(path: &Path) -> bool {
    let owner = read_owner(path);
    owner.pid == Some(std::process::id()) && owner.token.as_deref() == Some(owner_token())
}

fn modified_ms_ago(meta: &fs::Metadata) -> u128 {
    meta.modified()
        .ok()
        .and_then(|m| SystemTime::now().duration_since(m).ok())
        .map_or(0, |d| d.as_millis())
}

/// `describeLockHolder`.
fn describe_holder(path: &Path) -> String {
    let Ok(meta) = fs::metadata(path) else { return "holder unknown (lock file unreadable/absent)".into() };
    let owner = read_owner(path);
    let live = match owner.pid {
        None => "unknown",
        Some(_) if owner_is_live(&owner) => "live",
        Some(_) => "dead",
    };
    let pid = owner.pid.map_or("?".to_owned(), |p| p.to_string());
    let token = owner.token.map_or("?".to_owned(), |t| t.chars().take(8).collect());
    format!("holder pid={pid} token={token} age={}ms {live}", modified_ms_ago(&meta))
}

fn create_exclusive(path: &Path, data: &str) -> io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(path)?.write_all(data.as_bytes())
}

/// `publishLock`: the owner record is staged privately, hard-linked to the lock path, and the
/// staged name removed whether or not the link won.
fn publish_lock(lock: &Path) -> io::Result<()> {
    let staged = PathBuf::from(format!("{}.{}.{}.tmp", lock.display(), std::process::id(), hex16()));
    let linked = create_exclusive(&staged, &format!("{} {} {}\n", std::process::id(), now_ms(), owner_token()))
        .and_then(|()| fs::hard_link(&staged, lock));
    let _ = fs::remove_file(&staged);
    linked
}

/// Identity of a file across renames: the volume and file index (device and inode on Unix).
fn file_id(path: &Path) -> io::Result<(u64, u64)> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let meta = fs::metadata(path)?;
        Ok((meta.dev(), meta.ino()))
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::BY_HANDLE_FILE_INFORMATION;
        use windows_sys::Win32::Storage::FileSystem::GetFileInformationByHandle;
        let file = fs::File::open(path)?;
        // SAFETY: zeroed is a valid initial state for this plain-data struct.
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: `file` is an open handle; `info` is an out-parameter.
        if unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), &mut info) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok((
            u64::from(info.dwVolumeSerialNumber),
            (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
        ))
    }
}

struct ReclaimGuard {
    path: PathBuf,
    token: String,
}

/// `revokeDeadReclaimGuard`: only a guard whose owner is proven dead and which is older than any
/// live reclaim, moved aside first; if the moved file is not the one inspected, a newer guard was
/// displaced and is linked back.
fn revoke_dead_guard(guard: &Path) -> bool {
    let Ok(before_meta) = fs::metadata(guard) else { return false };
    let Ok(before) = file_id(guard) else { return false };
    if modified_ms_ago(&before_meta) < RECLAIM_GUARD_STALE.as_millis() {
        return false;
    }
    let owner = read_owner(guard);
    if owner.pid.is_some() && owner_is_live(&owner) {
        return false;
    }
    let tomb = PathBuf::from(format!("{}.{}.{}.revoked", guard.display(), std::process::id(), hex16()));
    if fs::rename(guard, &tomb).is_err() {
        return false;
    }
    let revoked = file_id(&tomb).is_ok_and(|moved| moved == before);
    if !revoked {
        let _ = fs::hard_link(&tomb, guard);
    }
    let _ = fs::remove_file(&tomb);
    revoked
}

/// `tryAcquireReclaimGuard`.
fn acquire_reclaim_guard(lock: &Path) -> Option<ReclaimGuard> {
    let guard = PathBuf::from(format!("{}.reclaim", lock.display()));
    let token = format!("{} {} {}\n", std::process::id(), now_ms(), hex16());
    for attempt in 0..2 {
        let staged = PathBuf::from(format!("{}.{}.{}.tmp", guard.display(), std::process::id(), hex16()));
        let linked = create_exclusive(&staged, &token).and_then(|()| fs::hard_link(&staged, &guard));
        let _ = fs::remove_file(&staged);
        match linked {
            Ok(()) => return Some(ReclaimGuard { path: guard, token }),
            Err(error) if !rename_retryable(&error) => return None,
            Err(_) if attempt > 0 || !revoke_dead_guard(&guard) => return None,
            Err(_) => {}
        }
    }
    None
}

fn release_reclaim_guard(guard: &ReclaimGuard) {
    if fs::read_to_string(&guard.path).is_ok_and(|text| text == guard.token) {
        let _ = fs::remove_file(&guard.path);
    }
}

/// `lockReclaimable`: owner dead, or no owner and outlived the stale window.
fn reclaimable(owner: &Owner, meta: &fs::Metadata, opts: &LockOpts) -> bool {
    if owner.pid.is_some() {
        return !owner_is_live(owner);
    }
    if opts.strict_owner {
        return false;
    }
    modified_ms_ago(meta) >= opts.stale.unwrap_or(DEFAULT_STALE).as_millis()
}

/// `tryReclaimStaleLock`: true when the stale lock was removed and publishing should be retried.
fn try_reclaim(lock: &Path, opts: &LockOpts) -> bool {
    let Ok(initial) = fs::metadata(lock) else { return false };
    let owner = read_owner(lock);
    if !reclaimable(&owner, &initial, opts) {
        return false;
    }
    let Some(guard) = acquire_reclaim_guard(lock) else { return false };
    let removed = (|| {
        let current = fs::metadata(lock).ok()?;
        let now = read_owner(lock);
        if now.pid != owner.pid || now.token != owner.token || !reclaimable(&now, &current, opts) {
            return None;
        }
        fs::remove_file(lock).ok()
    })()
    .is_some();
    release_reclaim_guard(&guard);
    removed
}

/// A staged record left by a process killed between its create and unlink: swept once per lock
/// path, only when old and its pid is dead. Cleanup only; no lock decision depends on it.
fn sweep_staged(lock: &Path) {
    static SWEPT: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    let first = SWEPT.get_or_init(Mutex::default).lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(lock.to_owned());
    if !first {
        return;
    }
    let (Some(dir), Some(name)) = (lock.parent(), lock.file_name()) else { return };
    let prefix = format!("{}.", name.to_string_lossy());
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let file = entry.file_name().to_string_lossy().into_owned();
        let Some(rest) = file.strip_prefix(&prefix).and_then(|r| r.strip_suffix(".tmp")) else { continue };
        let rest = rest.strip_prefix("reclaim.").unwrap_or(rest);
        let Some((pid, hex)) = rest.split_once('.') else { continue };
        let (Ok(pid), true) = (pid.parse::<u32>(), hex.len() == 16 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
        else {
            continue;
        };
        let old = entry.metadata().is_ok_and(|m| modified_ms_ago(&m) >= STAGED_STALE.as_millis());
        if old && !owner_is_live(&Owner { pid: Some(pid), token: None }) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

thread_local! {
    /// Lock paths this thread holds: a nested request for one runs without locking again.
    static HELD: RefCell<HashSet<PathBuf>> = RefCell::new(HashSet::new());
}

/// The in-process line for one lock path (`lockQueue` of `file-lock.mjs`): requests of this
/// process take their turn first-come first-served and only the one at the front polls the
/// file, so a thread that releases and asks again cannot starve the others between their
/// polls.
#[derive(Default)]
struct Line {
    state: Mutex<LineState>,
    advanced: Condvar,
}

#[derive(Default)]
struct LineState {
    next: u64,
    serving: u64,
    /// Tickets whose holder gave up waiting.
    abandoned: HashSet<u64>,
}

fn line_of(lock: &Path) -> Arc<Line> {
    static LINES: OnceLock<Mutex<HashMap<PathBuf, Arc<Line>>>> = OnceLock::new();
    let mut lines = LINES.get_or_init(Mutex::default).lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    Arc::clone(lines.entry(lock.to_owned()).or_default())
}

/// A turn at the front of the line; dropping it passes the line on.
struct Turn(Arc<Line>);

impl Drop for Turn {
    fn drop(&mut self) {
        let mut guard = self.0.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let state = &mut *guard;
        state.serving += 1;
        while state.abandoned.remove(&state.serving) {
            state.serving += 1;
        }
        self.0.advanced.notify_all();
    }
}

/// Waits for this request's turn until `deadline`; `None` when it did not come (a try-once
/// request, `deadline` already due, gives up unless nobody is ahead).
fn take_turn(line: &Arc<Line>, deadline: Instant, try_once: bool) -> Option<Turn> {
    let mut state = line.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if try_once && state.next != state.serving {
        return None;
    }
    let ticket = state.next;
    state.next += 1;
    while state.serving != ticket {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            state.abandoned.insert(ticket);
            return None;
        }
        state = line.advanced.wait_timeout(state, left).unwrap_or_else(std::sync::PoisonError::into_inner).0;
    }
    Some(Turn(Arc::clone(line)))
}

/// Runs `body` holding the lock at `lock`.
pub(crate) fn locked<R>(lock: &Path, opts: &LockOpts, body: impl FnOnce() -> R) -> Result<R, LockError> {
    if HELD.with(|held| held.borrow().contains(lock)) {
        return Ok(body());
    }
    let timeout = opts.timeout.unwrap_or_else(default_timeout);
    if let Some(dir) = lock.parent() {
        fs::create_dir_all(dir)?;
    }
    let deadline = Instant::now() + timeout;
    let Some(_turn) = take_turn(&line_of(lock), deadline, timeout.is_zero()) else {
        let holder = describe_holder(lock);
        return Err(if timeout.is_zero() {
            LockError::Contended { path: lock.to_owned(), holder }
        } else {
            LockError::Timeout { path: lock.to_owned(), timeout, holder }
        });
    };
    let mut attempt = 0;
    loop {
        let error = match publish_lock(lock) {
            Ok(()) => break,
            Err(error) if !rename_retryable(&error) => return Err(LockError::Io(error)),
            Err(error) => error,
        };
        drop(error);
        if try_reclaim(lock, opts) {
            continue;
        }
        if timeout.is_zero() {
            return Err(LockError::Contended { path: lock.to_owned(), holder: describe_holder(lock) });
        }
        if Instant::now() >= deadline {
            return Err(LockError::Timeout { path: lock.to_owned(), timeout, holder: describe_holder(lock) });
        }
        std::thread::sleep(retry_delay(attempt, deadline));
        attempt += 1;
    }
    HELD.with(|held| held.borrow_mut().insert(lock.to_owned()));
    let result = {
        let _release = Release(lock);
        body()
    };
    sweep_staged(lock);
    Ok(result)
}

/// Releases the lock when the body ends, by return or by panic (`releaseLock`).
struct Release<'a>(&'a Path);

impl Drop for Release<'_> {
    fn drop(&mut self) {
        HELD.with(|held| held.borrow_mut().remove(self.0));
        if owned_by_self(self.0) {
            let _ = fs::remove_file(self.0);
        }
    }
}
