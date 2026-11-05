//! Data-dir ownership revalidation (LR §2.4). Called in exactly one place:
//! the store's durability barrier, before its fsync, on io-durability. No
//! watcher and no timer.

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum FenceReason {
    DataDirReplaced,
    LockFileReplaced,
    BarrierRemoved,
    LockLost,
}

pub trait Ownership: Send + Sync {
    /// The core instance that holds the lock.
    fn instance_id(&self) -> &str;
    /// Identity checks (Unix: data dir, lock file, barrier, one `flock`
    /// re-assertion; Windows: none, every object is pinned). A failure is
    /// sticky: every later call returns the first reason. The caller turns
    /// it into `storage_indeterminate` and moves the core to `Fenced`.
    fn revalidate(&self) -> Result<(), FenceReason>;
}
