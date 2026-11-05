//! The lock of one state file: an OS advisory lock on `<file>.lock`, taken with Node's timeout
//! and backoff (`file-lock.mjs`). The OS drops it when the holder dies, so there is no owner
//! record, no staleness window and no reclaim. The lock file stays in place after release.

use std::fs::OpenOptions;
use std::fs::TryLockError;
use std::io;
use std::path::Path;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;
use std::time::Instant;

/// `DEFAULT_LOCK_TIMEOUT_MS`, or `MIXDOG_LOCK_TIMEOUT_MS` when that is a number of at least 0.
pub fn default_timeout() -> Duration {
    static TIMEOUT: OnceLock<Duration> = OnceLock::new();
    *TIMEOUT.get_or_init(|| {
        let configured = std::env::var("MIXDOG_LOCK_TIMEOUT_MS")
            .ok()
            .and_then(|text| text.trim().parse::<f64>().ok())
            .filter(|ms| ms.is_finite() && *ms >= 0.0);
        Duration::from_millis(configured.map_or(2000, |ms| ms as u64))
    })
}

/// Why a lock was not taken.
#[derive(Debug)]
pub enum LockError {
    /// Try-once (`timeout` 0) and another holder has it (`ELOCKCONTENDED`).
    Contended { path: PathBuf },
    /// Held by another for the whole wait (`ELOCKTIMEOUT`).
    Timeout { path: PathBuf, timeout: Duration },
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
            LockError::Contended { path } => write!(f, "atomic lock contended (try-once): {}", path.display()),
            LockError::Timeout { path, timeout } => {
                write!(f, "atomic lock timeout after {}ms: {}", timeout.as_millis(), path.display())
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

/// Runs `body` holding the lock at `lock`. `timeout` `None` is [`default_timeout`]; zero tries
/// once.
pub(crate) fn locked<R>(lock: &Path, timeout: Option<Duration>, body: impl FnOnce() -> R) -> Result<R, LockError> {
    let timeout = timeout.unwrap_or_else(default_timeout);
    if let Some(dir) = lock.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let file = OpenOptions::new().create(true).truncate(false).write(true).open(lock)?;
    let deadline = Instant::now() + timeout;
    let mut attempt = 0;
    loop {
        match file.try_lock() {
            Ok(()) => break,
            Err(TryLockError::WouldBlock) => {}
            Err(TryLockError::Error(error)) => return Err(LockError::Io(error)),
        }
        if timeout.is_zero() {
            return Err(LockError::Contended { path: lock.to_owned() });
        }
        if Instant::now() >= deadline {
            return Err(LockError::Timeout { path: lock.to_owned(), timeout });
        }
        std::thread::sleep(retry_delay(attempt, deadline));
        attempt += 1;
    }
    let result = body();
    let _ = file.unlock();
    Ok(result)
}
