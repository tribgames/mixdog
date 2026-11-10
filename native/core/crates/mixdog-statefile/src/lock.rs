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
use std::fs::Metadata;
use std::io;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use mixdog_fsio::ReadProof;
use mixdog_fsio::Unlaned;
use mixdog_fsio::WriteProof;

use crate::access::Access;
use crate::publish::rename_retryable;

/// `DEFAULT_LOCK_TIMEOUT_MS`, or `MIXDOG_LOCK_TIMEOUT_MS` when that is a number of at least 0.
pub fn default_timeout() -> Duration {
    static TIMEOUT: OnceLock<Duration> = OnceLock::new();
    *TIMEOUT.get_or_init(|| {
        let configured = std::env::var("MIXDOG_LOCK_TIMEOUT_MS")
            .ok()
            .and_then(|text| mixdog_js::string_to_number(&text).into())
            .filter(|ms: &f64| ms.is_finite() && *ms >= 0.0);
        ms_duration(configured.unwrap_or(2000.0))
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
                // `${timeoutMs}`: the milliseconds as the JavaScript number they are, a fraction kept.
                write!(f, "atomic lock timeout after {}ms: {} [{holder}]", mixdog_js::number_to_string(timeout.as_nanos() as f64 / 1e6), path.display())
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

/// The wait in milliseconds before attempt `attempt + 1` when the deadline is `remaining_ms` away
/// (`lockRetryDelayMs`): the backoff plus `floor(draw · min(75, backoff))`, never past the deadline (a fraction where
/// the remaining time is one) and at least 1 ms. `draw` is `Math.random()`.
pub fn lock_retry_delay(attempt: usize, remaining_ms: f64, draw: f64) -> f64 {
    let base = backoff_ms(attempt) as f64;
    let jitter = (draw * base.clamp(1.0, 75.0)).floor();
    remaining_ms.max(1.0).min(base + jitter)
}

/// A number of milliseconds, a fraction kept to the nanosecond.
pub fn ms_duration(ms: f64) -> Duration {
    Duration::from_nanos((ms * 1e6).round() as u64)
}

/// The clock [`locked`] reads and waits on: `Date.now()` (the wall clock), the waits between attempts, and
/// `Math.random()` for their jitter.
pub(crate) trait LockClock {
    fn now_ns(&self) -> i128;
    fn sleep(&self, proof: &impl ReadProof, duration: Duration);
    fn draw(&self) -> f64;
}

/// The process's own clock.
struct WallClock;

impl LockClock for WallClock {
    fn now_ns(&self) -> i128 {
        now_ns()
    }
    fn sleep(&self, proof: &impl ReadProof, duration: Duration) {
        mixdog_fsio::sleep(proof, duration);
    }
    fn draw(&self) -> f64 {
        rand::random::<f64>()
    }
}

/// The wall clock in nanoseconds since the Unix epoch: the instant a lock's staleness and its owner record are read at.
fn now_ns() -> i128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos() as i128)
}

fn hex16() -> String {
    format!("{:016x}", rand::random::<u64>())
}

/// This process's token: told apart from another holder that shares the pid.
fn owner_token() -> &'static str {
    static TOKEN: OnceLock<String> = OnceLock::new();
    TOKEN.get_or_init(|| format!("{:024x}", rand::random::<u128>() >> 32))
}

/// The owner a lock's record names (`${process.pid} ${Date.now()} ${OWNER_TOKEN}`): its process, and the token that
/// tells it apart from another holder sharing the pid.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LockOwner {
    pid: u32,
    token: String,
}

impl LockOwner {
    /// This process's owner: its pid and its one token.
    pub fn process() -> Self {
        Self { pid: std::process::id(), token: owner_token().to_owned() }
    }

    /// An owner of this process with a token of its own, as a second copy of Node's `file-lock.mjs` loaded into one
    /// process is (each copy mints its `OWNER_TOKEN`): it and this process's own owner exclude each other as two
    /// processes do, and neither releases the other's lock.
    pub fn another_in_process() -> Self {
        Self { pid: std::process::id(), token: format!("{:024x}", rand::random::<u128>() >> 32) }
    }
}

struct Owner {
    pid: Option<u32>,
    token: Option<String>,
}

/// `readLockOwner`: `<pid> <ms> <token>`, or the legacy `{"pid":N,...}`. Unreadable is no owner.
fn read_owner(proof: &impl ReadProof, path: &Path) -> Owner {
    let none = Owner { pid: None, token: None };
    let Ok(bytes) = mixdog_fsio::read(proof, path) else { return none };
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

/// Whether a process with this pid exists (`process.kill(pid, 0)`): only "no such process"
/// proves it gone, so a process this one may not signal exists.
#[cfg(unix)]
pub fn process_exists(pid: u32) -> bool {
    // SAFETY: signal 0 only checks that the process can be signalled.
    if unsafe { libc::kill(pid as libc::pid_t, 0) } == 0 {
        return true;
    }
    io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

/// Whether a process with this pid exists (`process.kill(pid, 0)`): only "no such process"
/// proves it gone, so a process this one may not signal exists.
#[cfg(windows)]
pub fn process_exists(pid: u32) -> bool {
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

fn owned_by(proof: &impl ReadProof, path: &Path, owner: &LockOwner) -> bool {
    let record = read_owner(proof, path);
    record.pid == Some(owner.pid) && record.token.as_deref() == Some(owner.token.as_str())
}

/// `Date.now() - stat.mtimeMs`, in nanoseconds, at `now_ns`.
fn age_ns(meta: &Metadata, now_ns: i128) -> i128 {
    let modified = meta.modified().ok().and_then(|m| m.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos() as i128);
    now_ns - modified
}

/// Whether the file is `limit` old or older at `now_ns`.
fn aged(meta: &Metadata, now_ns: i128, limit: Duration) -> bool {
    age_ns(meta, now_ns) >= limit.as_nanos() as i128
}

/// `describeLockHolder` at `now_ns`.
fn describe_holder(proof: &impl ReadProof, path: &Path, now_ns: i128) -> String {
    let Ok(meta) = mixdog_fsio::metadata(proof, path) else { return "holder unknown (lock file unreadable/absent)".into() };
    let owner = read_owner(proof, path);
    let live = match owner.pid {
        None => "unknown",
        Some(_) if owner_is_live(&owner) => "live",
        Some(_) => "dead",
    };
    let pid = owner.pid.map_or("?".to_owned(), |p| p.to_string());
    let token = owner.token.map_or("?".to_owned(), |t| t.chars().take(8).collect());
    // `Math.max(0, Math.round(Date.now() - stat.mtimeMs))`.
    let age = (age_ns(&meta, now_ns) as f64 / 1e6).round();
    let age = mixdog_js::number_to_string(if age > 0.0 { age } else { 0.0 });
    format!("holder pid={pid} token={token} age={age}ms {live}")
}

fn create_exclusive(proof: &impl WriteProof, path: &Path, data: &str, access: Access) -> io::Result<()> {
    crate::access::create_new_platform(proof, path, access, 0o600)?.write_all(data.as_bytes())
}

/// `publishLock`: `owner`'s record (stamped `now_ns`) is staged privately, hard-linked to the lock path, and the staged
/// name removed whether or not the link won. The link shares the staged file's access.
fn publish_lock(proof: &impl WriteProof, lock: &Path, owner: &LockOwner, now_ns: i128, access: Access) -> io::Result<()> {
    let staged = PathBuf::from(format!("{}.{}.{}.tmp", lock.display(), owner.pid, hex16()));
    let record = format!("{} {} {}\n", owner.pid, now_ns.div_euclid(1_000_000), owner.token);
    let linked = create_exclusive(proof, &staged, &record, access).and_then(|()| mixdog_fsio::hard_link(proof, &staged, lock));
    let _ = mixdog_fsio::remove_file(proof, &staged);
    linked
}

/// Identity of a file across renames: the volume and file index (device and inode on Unix).
fn file_id(proof: &impl ReadProof, path: &Path) -> io::Result<(u64, u64)> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let meta = mixdog_fsio::metadata(proof, path)?;
        Ok((meta.dev(), meta.ino()))
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::BY_HANDLE_FILE_INFORMATION;
        use windows_sys::Win32::Storage::FileSystem::GetFileInformationByHandle;
        let file = mixdog_fsio::File::open(proof, path)?;
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
fn revoke_dead_guard(proof: &impl WriteProof, guard: &Path, now_ns: i128) -> bool {
    let Ok(before_meta) = mixdog_fsio::metadata(proof, guard) else { return false };
    let Ok(before) = file_id(proof, guard) else { return false };
    if !aged(&before_meta, now_ns, RECLAIM_GUARD_STALE) {
        return false;
    }
    let owner = read_owner(proof, guard);
    if owner.pid.is_some() && owner_is_live(&owner) {
        return false;
    }
    let tomb = PathBuf::from(format!("{}.{}.{}.revoked", guard.display(), std::process::id(), hex16()));
    if mixdog_fsio::rename(proof, guard, &tomb).is_err() {
        return false;
    }
    let revoked = file_id(proof, &tomb).is_ok_and(|moved| moved == before);
    if !revoked {
        let _ = mixdog_fsio::hard_link(proof, &tomb, guard);
    }
    let _ = mixdog_fsio::remove_file(proof, &tomb);
    revoked
}

/// `tryAcquireReclaimGuard` at `now_ns`.
fn acquire_reclaim_guard(proof: &impl WriteProof, lock: &Path, now_ns: i128) -> Option<ReclaimGuard> {
    let guard = PathBuf::from(format!("{}.reclaim", lock.display()));
    let token = format!("{} {} {}\n", std::process::id(), now_ns.div_euclid(1_000_000), hex16());
    for attempt in 0..2 {
        let staged = PathBuf::from(format!("{}.{}.{}.tmp", guard.display(), std::process::id(), hex16()));
        let linked =
            create_exclusive(proof, &staged, &token, Access::Inherit).and_then(|()| mixdog_fsio::hard_link(proof, &staged, &guard));
        let _ = mixdog_fsio::remove_file(proof, &staged);
        match linked {
            Ok(()) => return Some(ReclaimGuard { path: guard, token }),
            Err(error) if !rename_retryable(&error) => return None,
            Err(_) if attempt > 0 || !revoke_dead_guard(proof, &guard, now_ns) => return None,
            Err(_) => {}
        }
    }
    None
}

fn release_reclaim_guard(proof: &impl WriteProof, guard: &ReclaimGuard) {
    if mixdog_fsio::read_to_string(proof, &guard.path).is_ok_and(|text| text == guard.token) {
        let _ = mixdog_fsio::remove_file(proof, &guard.path);
    }
}

/// `lockReclaimable` at `now_ns`: owner dead, or no owner and outlived the stale window.
fn reclaimable(owner: &Owner, meta: &Metadata, opts: &LockOpts, now_ns: i128) -> bool {
    if owner.pid.is_some() {
        return !owner_is_live(owner);
    }
    if opts.strict_owner {
        return false;
    }
    aged(meta, now_ns, opts.stale.unwrap_or(DEFAULT_STALE))
}

/// `tryReclaimStaleLock` at `now_ns`: true when the stale lock was removed and publishing should be retried.
fn try_reclaim(proof: &impl WriteProof, lock: &Path, opts: &LockOpts, now_ns: i128) -> bool {
    let Ok(initial) = mixdog_fsio::metadata(proof, lock) else { return false };
    let owner = read_owner(proof, lock);
    if !reclaimable(&owner, &initial, opts, now_ns) {
        return false;
    }
    let Some(guard) = acquire_reclaim_guard(proof, lock, now_ns) else { return false };
    let removed = (|| {
        let current = mixdog_fsio::metadata(proof, lock).ok()?;
        let now = read_owner(proof, lock);
        if now.pid != owner.pid || now.token != owner.token || !reclaimable(&now, &current, opts, now_ns) {
            return None;
        }
        mixdog_fsio::remove_file(proof, lock).ok()
    })()
    .is_some();
    release_reclaim_guard(proof, &guard);
    removed
}

/// A staged record left by a process killed between its create and unlink: swept once per lock
/// path, only when old and its pid is dead. Cleanup only; no lock decision depends on it.
fn sweep_staged(proof: &impl WriteProof, lock: &Path, now_ns: i128) {
    static SWEPT: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    let first = SWEPT.get_or_init(Mutex::default).lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(lock.to_owned());
    if !first {
        return;
    }
    let (Some(dir), Some(name)) = (lock.parent(), lock.file_name()) else { return };
    let prefix = format!("{}.", name.to_string_lossy());
    let Ok(entries) = mixdog_fsio::read_dir(proof, dir) else { return };
    for entry in entries.flatten() {
        let file = entry.file_name().to_string_lossy().into_owned();
        let Some(rest) = file.strip_prefix(&prefix).and_then(|r| r.strip_suffix(".tmp")) else { continue };
        let rest = rest.strip_prefix("reclaim.").unwrap_or(rest);
        let Some((pid, hex)) = rest.split_once('.') else { continue };
        let (Ok(pid), true) = (pid.parse::<u32>(), hex.len() == 16 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
        else {
            continue;
        };
        let old = entry.metadata(proof).is_ok_and(|m| aged(&m, now_ns, STAGED_STALE));
        if old && !owner_is_live(&Owner { pid: Some(pid), token: None }) {
            let _ = mixdog_fsio::remove_file(proof, entry.path());
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
/// polls. Like Node's queue, the line has no deadline: a request's wait budget is for the file
/// and starts at its turn, so a holder of this process never spends the budget of the requests
/// behind it.
#[derive(Default)]
struct Line {
    state: Mutex<LineState>,
    advanced: Condvar,
}

#[derive(Default)]
struct LineState {
    next: u64,
    serving: u64,
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
        guard.serving += 1;
        self.0.advanced.notify_all();
    }
}

/// Waits for this request's turn; `None` for a try-once request when somebody is ahead.
fn take_turn(line: &Arc<Line>, try_once: bool) -> Option<Turn> {
    let mut state = line.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if try_once && state.next != state.serving {
        return None;
    }
    let ticket = state.next;
    state.next += 1;
    crate::trace::queued();
    while state.serving != ticket {
        state = line.advanced.wait(state).unwrap_or_else(std::sync::PoisonError::into_inner);
    }
    Some(Turn(Arc::clone(line)))
}

/// Runs `body` holding the lock at `lock`.
pub(crate) fn locked<P: WriteProof, R>(
    proof: &P,
    lock: &Path,
    opts: &LockOpts,
    body: impl FnOnce() -> R,
) -> Result<R, LockError> {
    locked_on(&WallClock, proof, lock, opts, body)
}

/// [`locked`] on `clock`: `acquireLock` (file-lock.mjs:420-457) with its deadline (`Date.now() + timeoutMs`, a fraction
/// kept), its waits and the holder's age read on `clock`.
pub(crate) fn locked_on<P: WriteProof, R>(
    clock: &impl LockClock,
    proof: &P,
    lock: &Path,
    opts: &LockOpts,
    body: impl FnOnce() -> R,
) -> Result<R, LockError> {
    if HELD.with(|held| held.borrow().contains(lock)) {
        return Ok(body());
    }
    let timeout = opts.timeout.unwrap_or_else(default_timeout);
    if let Some(dir) = lock.parent() {
        mixdog_fsio::create_dir_all(proof, dir)?;
    }
    let Some(_turn) = take_turn(&line_of(lock), timeout.is_zero()) else {
        return Err(LockError::Contended { path: lock.to_owned(), holder: describe_holder(proof, lock, clock.now_ns()) });
    };
    // The budget is for the file: it starts at the front of the line (`acquireLock` runs after
    // `lockQueue` hands over), not when the request joins it.
    let deadline = clock.now_ns() + timeout.as_nanos() as i128;
    let owner = LockOwner::process();
    let mut attempt = 0;
    while try_take(proof, lock, opts, &owner, Access::Inherit, clock.now_ns())? == Attempt::Held {
        if timeout.is_zero() {
            return Err(LockError::Contended { path: lock.to_owned(), holder: describe_holder(proof, lock, clock.now_ns()) });
        }
        let now = clock.now_ns();
        if now >= deadline {
            return Err(LockError::Timeout { path: lock.to_owned(), timeout, holder: describe_holder(proof, lock, now) });
        }
        clock.sleep(proof, ms_duration(lock_retry_delay(attempt, (deadline - now) as f64 / 1e6, clock.draw())));
        attempt += 1;
    }
    HELD.with(|held| held.borrow_mut().insert(lock.to_owned()));
    let result = {
        let _release = Release(proof, lock);
        body()
    };
    sweep_staged(proof, lock, clock.now_ns());
    Ok(result)
}

/// Releases the lock when the body ends, by return or by panic (`releaseLock`).
struct Release<'a, P: WriteProof>(&'a P, &'a Path);

impl<P: WriteProof> Drop for Release<'_, P> {
    fn drop(&mut self) {
        HELD.with(|held| held.borrow_mut().remove(self.1));
        if owned_by(self.0, self.1, &LockOwner::process()) {
            let _ = mixdog_fsio::remove_file(self.0, self.1);
        }
    }
}

/// What one pass of `acquireLock`'s loop found.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Attempt {
    /// The lock is `owner`'s now.
    Taken,
    /// Another holds it, and it is not stale.
    Held,
}

/// `publishLock`, and while another holds the lock, `tryReclaimStaleLock` and publish again.
fn try_take(proof: &impl WriteProof, lock: &Path, opts: &LockOpts, owner: &LockOwner, access: Access, now_ns: i128) -> Result<Attempt, LockError> {
    loop {
        match publish_lock(proof, lock, owner, now_ns, access) {
            Ok(()) => return Ok(Attempt::Taken),
            Err(error) if !rename_retryable(&error) => return Err(LockError::Io(error)),
            Err(_) => {}
        }
        if !try_reclaim(proof, lock, opts, now_ns) {
            return Ok(Attempt::Held);
        }
    }
}

/// The steps of `withFileLock` for a caller that waits on a clock of its own (Node's async `acquireLock`, whose
/// clock is `Date.now()` and whose waits are timers): the caller keeps the in-process line, the deadline and the waits
/// ([`lock_retry_delay`]), and runs each step as a write-lane job. `now_ms` is that clock's reading.
pub mod steps {
    use std::path::Path;

    use mixdog_rt::InLane;

    use super::Access;
    use super::Attempt;
    use super::LockError;
    use super::LockOpts;
    use super::LockOwner;
    use crate::WriteLane;

    fn ns(now_ms: u64) -> i128 {
        i128::from(now_ms) * 1_000_000
    }

    /// Before the first attempt: the lock's directory is made, and staged records a dead process left beside the
    /// lock are swept (once per lock path in the process).
    pub fn prepare<L: WriteLane>(lane: &InLane<L>, lock: &Path, now_ms: u64) -> std::io::Result<()> {
        if let Some(dir) = lock.parent() {
            mixdog_fsio::create_dir_all(lane, dir)?;
        }
        super::sweep_staged(lane, lock, ns(now_ms));
        Ok(())
    }

    /// One attempt: `owner`'s record published at `lock`, a stale holder's lock reclaimed first. `access` is the lock
    /// file's (owner-only for a lock taken with `secret`).
    pub fn attempt<L: WriteLane>(
        lane: &InLane<L>,
        lock: &Path,
        opts: &LockOpts,
        owner: &LockOwner,
        access: Access,
        now_ms: u64,
    ) -> Result<Attempt, LockError> {
        super::try_take(lane, lock, opts, owner, access, ns(now_ms))
    }

    /// `describeLockHolder` for the timeout's message.
    pub fn holder<L: WriteLane>(lane: &InLane<L>, lock: &Path, now_ms: u64) -> String {
        super::describe_holder(lane, lock, ns(now_ms))
    }

    /// `releaseLock`: the lock file is removed while it still names `owner`.
    pub fn release<L: WriteLane>(lane: &InLane<L>, lock: &Path, owner: &LockOwner) {
        if super::owned_by(lane, lock, owner) {
            let _ = mixdog_fsio::remove_file(lane, lock);
        }
    }
}

/// A lock held by a dedicated thread until this value is dropped: for a body that is async and runs longer than a lane
/// job may (Node's `withFileLock(lockPath, fn)` around an `await`ed start). `lock_file` is the lock file itself, as Node's
/// `lockPath` (`pg-spawn.lock`), not a file the lock is named after. The thread takes the lock exactly as [`locked`] does
/// (the same queue, owner record, reclaim and timeout) and calls `acquired` once with the outcome; dropping the hold, or
/// a hold whose lock was never taken, releases it.
pub struct LockHold {
    release: Option<std::sync::mpsc::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
    taken: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl LockHold {
    /// Releases the lock and returns once its file is gone. Only for a hold whose `acquired` reported success: a hold still waiting for the lock would be waited for.
    pub fn release_and_wait(mut self) {
        drop(self.release.take());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for LockHold {
    fn drop(&mut self) {
        // The thread waits on the receiver: a closed channel is its release. A lock that was taken is waited for until its file is gone (Node's `finally` awaits
        // `releaseLock`); one still waiting for the lock is not.
        drop(self.release.take());
        if self.taken.load(std::sync::atomic::Ordering::SeqCst)
            && let Some(thread) = self.thread.take()
        {
            let _ = thread.join();
        }
    }
}

/// Starts [`LockHold`]'s thread for `lock_file`.
pub fn hold_lock(lock_file: &Path, opts: &LockOpts, acquired: impl FnOnce(Result<(), LockError>) + Send + 'static) -> LockHold {
    let (release, released) = std::sync::mpsc::channel::<()>();
    let (lock, opts) = (lock_file.to_owned(), *opts);
    let taken = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let taken_in = taken.clone();
    let thread = std::thread::Builder::new()
        .name("lock-hold".to_owned())
        .spawn(move || {
            let mut acquired = Some(acquired);
            // The hold's own thread, outside every lane: the case `Unlaned` exists for.
            let outcome = locked(&Unlaned, &lock, &opts, || {
                taken_in.store(true, std::sync::atomic::Ordering::SeqCst);
                if let Some(acquired) = acquired.take() {
                    acquired(Ok(()));
                }
                let _ = released.recv();
            });
            if let (Err(error), Some(acquired)) = (outcome, acquired.take()) {
                acquired(Err(error));
            }
        })
        .expect("spawn the lock-hold thread");
    LockHold { release: Some(release), thread: Some(thread), taken }
}

#[cfg(test)]
#[path = "lock_replay_tests.rs"]
mod replay_tests;
