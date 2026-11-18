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

use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_statefile::Access;
use mixdog_statefile::LockError;
use mixdog_statefile::LockOpts;
use mixdog_statefile::LockOwner;
use mixdog_statefile::lock_retry_delay;
use mixdog_statefile::lock_steps;

use super::pace::Pace;
use super::store::CredentialFile;

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

/// The refresh lease of every single-use refresh token (`grok-oauth-tokens.mjs:427-431`, `openai-oauth-tokens.mjs:45`):
/// a 120 s wait for the lease, a lease that names no owner taken over once 120 s old, the lease file the user's alone.
pub const REFRESH_LEASE: LeaseOpts = LeaseOpts { timeout: Duration::from_secs(120), stale: Duration::from_secs(120), secret: true };

/// `getRefreshLockPath`: `${getOwnTokenPath()}.refresh.lock`.
pub fn refresh_lock_path(file: &Path) -> PathBuf {
    let mut name = file.as_os_str().to_owned();
    name.push(".refresh.lock");
    PathBuf::from(name)
}

/// A lease that could not be taken, as `withFileLock` throws it (`ELOCKTIMEOUT`, `ELOCKCONTENDED`, or the file error).
pub fn lease_error(error: LockError) -> ProviderError {
    let mut failure = ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent);
    failure.code = error.code().map(str::to_owned);
    failure.message = error.to_string();
    failure
}

/// The lease and the turn on the process's line it was taken under: one owned unit, so whoever holds it drops the lease
/// first and the turn second on every path. The unit travels into the acquiring lane job and out as its result, so a
/// caller that went away after the lane took the lock drops it unclaimed with the same order, and no other local caller
/// is let in while this process still holds the lock.
#[allow(clippy::disallowed_types, reason = "see LockProcess")]
struct Unit {
    /// Declared first: fields drop in declaration order.
    lease: Option<lock_steps::Lease>,
    _turn: tokio::sync::OwnedMutexGuard<()>,
}

impl CredentialFile {
    /// One attempt on the write lane: the unit goes in, and comes back holding the lease when the lock was taken.
    async fn attempt_in(&self, unit: Unit, lock: &Path, opts: LockOpts, owner: &LockOwner, access: Access, now_ms: u64) -> Result<Unit, LockError> {
        let (target, owner) = (lock.to_path_buf(), owner.clone());
        self.io
            .write_job(move |lane| {
                let mut unit = unit;
                Ok(lock_steps::attempt_leased(lane, &target, &opts, &owner, access, now_ms).map(|lease| {
                    unit.lease = lease;
                    unit
                }))
            })
            .await
            .map_err(LockError::Io)?
    }

    /// Runs `body` holding the lease on `lock` for `process`, with `pace`'s clock and waits.
    pub async fn lease<T>(&self, lock: &Path, process: &LockProcess, pace: &dyn Pace, opts: LeaseOpts, body: impl Future<Output = T>) -> Result<T, LockError> {
        let mut unit = Unit { lease: None, _turn: process.line(lock).lock_owned().await };
        let started = pace.now_ms();
        let deadline = started + opts.timeout.as_millis() as u64;
        let target = lock.to_path_buf();
        self.io.write_job(move |lane| lock_steps::prepare(lane, &target, started)).await.map_err(LockError::Io)?;
        let access = if opts.secret { Access::OwnerOnly } else { Access::Inherit };
        let lock_opts = LockOpts { timeout: Some(opts.timeout), stale: Some(opts.stale), strict_owner: false };
        let mut attempt = 0;
        // The lease has one owner from the moment the lane takes the lock: the guard is built inside the acquiring job
        // and handed over, with the turn it was taken under, as the job's result, so a caller that went away meanwhile
        // drops the unit unclaimed and the lock goes first, the turn after.
        loop {
            let now = pace.now_ms();
            unit = self.attempt_in(unit, lock, lock_opts, &process.owner, access, now).await?;
            if unit.lease.is_some() {
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
        let out = body.await;
        drop(unit);
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::oauth::CredentialIo;

    /// A lease taken by the lane and never delivered (its caller went away) is dropped with its turn, lease first: a
    /// local caller waiting for the turn never finds the lock still held by this process.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_undelivered_lease_is_dropped_before_its_turn() {
        let dir = tempfile::tempdir().unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let file = CredentialFile::new(dir.path().join("c.json"), CredentialIo { read: tokens.interactive_io, write: tokens.durability_io });
        let lock = refresh_lock_path(file.path());
        let process = Arc::new(LockProcess::new(LockOwner::another_in_process()));
        let opts = LockOpts { timeout: Some(Duration::ZERO), stale: Some(Duration::from_secs(120)), strict_owner: false };
        for round in 0..200 {
            let unit = Unit { lease: None, _turn: process.line(&lock).lock_owned().await };
            // The acquiring job's result: the lock is taken and the unit holds both.
            let unit = file.attempt_in(unit, &lock, opts, &process.owner, Access::Inherit, 0).await.unwrap();
            assert!(lock.exists() && unit.lease.is_some(), "round {round}: the lane took the lock");
            let waiter = tokio::spawn({
                let (process, lock) = (process.clone(), lock.clone());
                async move {
                    let _turn = process.line(&lock).lock_owned().await;
                    lock.exists()
                }
            });
            tokio::task::yield_now().await;
            // The receiver is gone: the unit is dropped unclaimed.
            drop(unit);
            assert!(!waiter.await.unwrap(), "round {round}: the turn was given up while the lock was still held");
        }
    }
}
