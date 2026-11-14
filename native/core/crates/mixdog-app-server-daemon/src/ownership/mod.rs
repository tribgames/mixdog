//! Data-dir ownership (LR §2.1, §2.3, §2.4).
//!
//! One OS lock on `<data>/daemon-owner.lock`, taken without waiting and held for
//! the core's lifetime, excludes every other 1.4.6+ core (and dev Node builds,
//! whose SQLite lock bytes fall inside the locked range). The lock file is
//! created once and never deleted, rewritten or renamed.
//!
//! [`CoreOwnership::revalidate`] is the identity check the store runs inside
//! every durability barrier before its fsync. It is synchronous, has no side
//! effect while ownership holds, and is sticky: the first failure is returned
//! by every later call.

mod dir;
#[cfg(unix)]
mod sys_unix;
#[cfg(windows)]
mod sys_windows;
#[cfg(test)]
mod node_cases;
#[cfg(test)]
mod tests;

use std::fmt;
use std::io;
use std::path::Path;
use std::sync::OnceLock;

pub use dir::DataDir;
pub use dir::EntryKind;
#[cfg(unix)]
pub(crate) use dir::cvt;
#[cfg(windows)]
pub(crate) use dir::wide as dir_wide;
use mixdog_core_api::domain::ownership::FenceReason;
use mixdog_core_api::domain::ownership::Ownership;
#[cfg(unix)]
use sys_unix as sys;
#[cfg(windows)]
use sys_windows as sys;

use crate::barrier::CLAIM_LOCK_FILE;

/// The OS lock file (LR §2.1). Never disposed.
pub const LOCK_FILE: &str = "daemon-owner.lock";

#[derive(Debug)]
pub enum AcquireError {
    /// Another core owns the data dir (`EWOULDBLOCK` / `ERROR_LOCK_VIOLATION`).
    /// The core yields: it exits 0 (`crash_record::yield_ownership`), and the launcher waits for the holder's discovery and attaches.
    AlreadyOwned,
    /// The typed boot failure `ownershipUnavailable{os_error}`. Mixdog never runs
    /// without the lock.
    Unavailable(io::Error),
}

impl fmt::Display for AcquireError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AlreadyOwned => f.write_str("another core owns the data dir"),
            Self::Unavailable(error) => write!(f, "ownership unavailable: {error}"),
        }
    }
}

impl std::error::Error for AcquireError {}

/// The lock held by this core, the directory it locked, and (once the claim
/// barrier exists) the barrier pin.
pub struct CoreOwnership {
    instance_id: String,
    dir: DataDir,
    lock: sys::LockFile,
    barrier: OnceLock<sys::BarrierPin>,
    fenced: OnceLock<FenceReason>,
}

/// LR §3 step 1: open the data directory (Unix: an `O_DIRECTORY` handle every
/// later data-dir access is relative to) and take the lock without waiting.
#[allow(
    clippy::disallowed_methods,
    reason = "runs once at core startup, before any async worker exists"
)]
pub fn acquire(data_dir: &Path) -> Result<CoreOwnership, AcquireError> {
    std::fs::create_dir_all(data_dir).map_err(AcquireError::Unavailable)?;
    let dir = DataDir::open(data_dir).map_err(AcquireError::Unavailable)?;
    let lock = sys::lock(&dir)?;
    Ok(CoreOwnership {
        instance_id: format!("{:032x}", rand::random::<u128>()),
        dir,
        lock,
        barrier: OnceLock::new(),
        fenced: OnceLock::new(),
    })
}

impl CoreOwnership {
    pub fn data_dir(&self) -> &DataDir {
        &self.dir
    }

    /// Pins the installed claim barrier for the core's lifetime: Windows holds
    /// it open without `FILE_SHARE_DELETE`; Unix records its identity, which
    /// every later revalidation compares. Idempotent.
    pub(crate) fn pin_barrier(&self) -> io::Result<()> {
        if self.barrier.get().is_none() {
            let pin = sys::pin(&self.dir, CLAIM_LOCK_FILE)?;
            let _ = self.barrier.set(pin);
        }
        Ok(())
    }
}

impl Ownership for CoreOwnership {
    fn instance_id(&self) -> &str {
        &self.instance_id
    }

    fn revalidate(&self) -> Result<(), FenceReason> {
        if let Some(reason) = self.fenced.get() {
            return Err(*reason);
        }
        sys::check(&self.dir, &self.lock, self.barrier.get())
            .map_err(|reason| *self.fenced.get_or_init(|| reason))
    }
}
