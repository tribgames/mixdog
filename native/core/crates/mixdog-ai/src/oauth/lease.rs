//! `withFileLock(lockPath, fn, { timeoutMs, staleMs, secret })` (`shared/file-lock.mjs`) around a body that awaits: a
//! lease on a lock file beside a credential, taken in the file-lock protocol (`mixdog_statefile::lock_steps`, the same
//! owner records, reclaim and release as Node's), so a Node process and this one exclude each other on the same file.
//!
//! The steps are Node's async `withFileLock`: a caller first waits its turn on the process's line for the lock path
//! (`lockQueue`, first come first served), then its budget starts (`deadline = Date.now() + timeoutMs`) and it attempts
//! the lock; while another live holder keeps it, it waits `lockRetryDelayMs(attempt, deadline)` and attempts again,
//! until the deadline passes (`ELOCKTIMEOUT`). A holder whose process is dead is taken over at once; one whose record
//! names no owner once it is `staleMs` old. The body runs holding the lease, which is released (only while it still
//! names this owner) however the body ends. The clock, the waits and the jitter draw are a [`Pace`].

use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::LazyLock;
use std::sync::Mutex;
use std::time::Duration;

use mixdog_rt::CancellationToken;
use mixdog_rt::LaneToken;
use mixdog_statefile::Access;
use mixdog_statefile::Attempt;
use mixdog_statefile::LockError;
use mixdog_statefile::LockOpts;
use mixdog_statefile::LockOwner;
use mixdog_statefile::lock_retry_delay;
use mixdog_statefile::lock_steps;

use super::pace::Pace;
use super::store::CredentialFile;
use super::store::CredentialIo;

/// What a process is to the lock protocol: the owner its records name, and its line per lock path, where its callers
/// wait their turn before contending for the file (`lockQueue`).
#[allow(clippy::disallowed_types, reason = "the line is the queue: a caller holds its turn across the whole contended attempt, first come first served, as Node's lockQueue")]
pub struct LockProcess {
    owner: LockOwner,
    lines: Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>,
}

impl LockProcess {
    /// This process.
    pub fn this_process() -> Arc<Self> {
        static THIS: LazyLock<Arc<LockProcess>> = LazyLock::new(|| Arc::new(LockProcess::new(LockOwner::process())));
        THIS.clone()
    }

    /// A process whose records name `owner`.
    pub fn new(owner: LockOwner) -> Self {
        Self { owner, lines: Mutex::new(HashMap::new()) }
    }

    #[allow(clippy::disallowed_types, reason = "see LockProcess")]
    fn line(&self, lock: &Path) -> Arc<tokio::sync::Mutex<()>> {
        let mut lines = self.lines.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        lines.entry(lock.to_path_buf()).or_default().clone()
    }
}

/// `{ timeoutMs, staleMs, secret }`.
#[derive(Clone, Copy, Debug)]
pub struct LeaseOpts {
    /// How long a caller contends for the file once its turn came; zero tries once.
    pub timeout: Duration,
    /// How old a lock that names no owner must be to be taken over.
    pub stale: Duration,
    /// The lock file is the current user's alone.
    pub secret: bool,
}

/// A held lease; released when it is dropped without [`Held::release`] (a body that panicked or was cancelled), as
/// Node's `finally` releases it.
struct Held {
    io: CredentialIo,
    lock: PathBuf,
    owner: LockOwner,
    released: bool,
}

impl Held {
    async fn release(mut self) {
        self.released = true;
        let (lock, owner) = (self.lock.clone(), self.owner.clone());
        let _ = self
            .io
            .write_job(move |lane| {
                lock_steps::release(lane, &lock, &owner);
                Ok(())
            })
            .await;
    }
}

impl Drop for Held {
    fn drop(&mut self) {
        if self.released {
            return;
        }
        let (lock, owner) = (self.lock.clone(), self.owner.clone());
        // Nothing awaits here: the job is queued on the write lane and runs there.
        drop(self.io.write.submit(&CancellationToken::new(), move |lane| lock_steps::release(lane, &lock, &owner)));
    }
}

impl CredentialFile {
    /// Runs `body` holding the lease on `lock` for `process`, with `pace`'s clock and waits.
    pub async fn lease<T>(&self, lock: &Path, process: &LockProcess, pace: &dyn Pace, opts: LeaseOpts, body: impl Future<Output = T>) -> Result<T, LockError> {
        let line = process.line(lock);
        let _turn = line.lock().await;
        let started = pace.now_ms();
        let deadline = started + opts.timeout.as_millis() as u64;
        let target = lock.to_path_buf();
        self.io.write_job(move |lane| lock_steps::prepare(lane, &target, started)).await.map_err(LockError::Io)?;
        let access = if opts.secret { Access::OwnerOnly } else { Access::Inherit };
        let lock_opts = LockOpts { timeout: Some(opts.timeout), stale: Some(opts.stale), strict_owner: false };
        let mut attempt = 0;
        loop {
            let now = pace.now_ms();
            let (target, owner) = (lock.to_path_buf(), process.owner.clone());
            let found = self.io.write_job(move |lane| Ok(lock_steps::attempt(lane, &target, &lock_opts, &owner, access, now))).await.map_err(LockError::Io)??;
            if found == Attempt::Taken {
                break;
            }
            let now = pace.now_ms();
            if opts.timeout.is_zero() || now >= deadline {
                let target = lock.to_path_buf();
                let holder = self.io.write_job(move |lane| Ok(lock_steps::holder(lane, &target, now))).await.map_err(LockError::Io)?;
                return Err(if opts.timeout.is_zero() {
                    LockError::Contended { path: lock.to_path_buf(), holder }
                } else {
                    LockError::Timeout { path: lock.to_path_buf(), timeout: opts.timeout, holder }
                });
            }
            pace.wait(mixdog_statefile::ms_duration(lock_retry_delay(attempt, (deadline - now) as f64, pace.draw()))).await;
            attempt += 1;
        }
        let held = Held { io: self.io, lock: lock.to_path_buf(), owner: process.owner.clone(), released: false };
        let out = body.await;
        held.release().await;
        Ok(out)
    }
}
