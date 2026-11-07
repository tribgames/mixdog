//! The owner-lock loss, as the spec has it (LR §2.4): the check happens where the store makes a write durable, never on a watcher or a
//! timer, and a failed check moves the core to `Fenced`. Node watched the lock file and fenced on its deletion (`daemon.mjs:646-657`
//! `watchOwnedFiles`, the call at `:655`); the spec replaces that with [`Ownership::revalidate`] in the store's durability barrier
//! (`mixdog-core-api/src/domain/ownership.rs`: "no watcher and no timer"). That barrier turns a failure into `storage_indeterminate`
//! and nothing moved the core to `Fenced`; this decorator is the other half: the ownership the store is given.
//!
//! A lock file that is no longer ours is worded as Node worded it (`owner lock file <path> was deleted or replaced`); the other
//! reasons (`DataDirReplaced`, `BarrierRemoved`, `LockLost`) are the spec's, with no Node counterpart.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use mixdog_core_api::domain::ownership::FenceReason;
use mixdog_core_api::domain::ownership::Ownership;

use crate::late_lifecycle::LateLifecycle;
use crate::lifecycle::FenceReason as Fenced;

/// The lifecycle's reason (`mixdog_app_protocol::mgmt::FenceReason`, the wire type of the `Fenced` state) for the ownership's own: the same four causes, two types.
fn lifecycle_reason(reason: FenceReason) -> Fenced {
    match reason {
        FenceReason::DataDirReplaced => Fenced::DataDirReplaced,
        FenceReason::LockFileReplaced => Fenced::LockFileReplaced,
        FenceReason::BarrierRemoved => Fenced::BarrierRemoved,
        FenceReason::LockLost => Fenced::LockLost,
    }
}

pub struct FencingOwnership {
    inner: Arc<dyn Ownership>,
    lifecycle: Arc<LateLifecycle>,
    /// `<data>/daemon-owner.lock`: the path Node's text names.
    lock_file: PathBuf,
    log: Arc<dyn Fn(&str) + Send + Sync>,
    fenced: AtomicBool,
}

impl FencingOwnership {
    pub fn new(inner: Arc<dyn Ownership>, lifecycle: Arc<LateLifecycle>, lock_file: PathBuf, log: Arc<dyn Fn(&str) + Send + Sync>) -> Self {
        Self { inner, lifecycle, lock_file, log, fenced: AtomicBool::new(false) }
    }

    fn fence(&self, reason: FenceReason) {
        let Some(lifecycle) = self.lifecycle.get() else {
            // Before the lifecycle exists nothing serves; the failure is sticky, so the next check fences.
            (self.log)(&format!("ownership lost ({reason:?}) before the lifecycle was bound; the core fences at the next check"));
            return;
        };
        if self.fenced.swap(true, Ordering::AcqRel) {
            return;
        }
        match reason {
            FenceReason::LockFileReplaced => lifecycle.fence_lock_file(&self.lock_file),
            other => lifecycle.fence(lifecycle_reason(other)),
        }
    }
}

impl Ownership for FencingOwnership {
    fn instance_id(&self) -> &str {
        self.inner.instance_id()
    }

    fn revalidate(&self) -> Result<(), FenceReason> {
        self.inner.revalidate().inspect_err(|reason| self.fence(*reason))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::lifecycle::testing::fixture;

    /// An ownership that holds until the test takes it away (sticky, as the real one is).
    struct Taken(Mutex<Option<FenceReason>>);

    impl Ownership for Taken {
        fn instance_id(&self) -> &str {
            "instance-1"
        }

        fn revalidate(&self) -> Result<(), FenceReason> {
            self.0.lock().unwrap().map_or(Ok(()), Err)
        }
    }

    #[test]
    fn a_lost_lock_file_found_at_the_barrier_fences_the_core_with_nodes_text_once() {
        let fx = fixture();
        fx.lifecycle.set_serving().unwrap();
        let late = Arc::new(LateLifecycle::default());
        late.bind(fx.lifecycle.clone()).unwrap();
        let lost = Arc::new(Taken(Mutex::new(None)));
        let logged = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = logged.clone();
        let fencing = FencingOwnership::new(lost.clone(), late, PathBuf::from("/data/daemon-owner.lock"), Arc::new(move |line| sink.lock().unwrap().push(line.to_owned())));
        assert_eq!(fencing.revalidate(), Ok(()));
        assert!(!fx.recorder.has_exited(), "a held lock fences nothing");
        *lost.0.lock().unwrap() = Some(FenceReason::LockFileReplaced);
        assert_eq!(fencing.revalidate(), Err(FenceReason::LockFileReplaced), "the barrier still gets the failure");
        assert_eq!(fencing.revalidate(), Err(FenceReason::LockFileReplaced));
        fx.recorder.wait_exit();
        let reasons: Vec<String> = fx.recorder.events().into_iter().filter_map(|e| e.strip_prefix("release_started:").map(str::to_owned)).collect();
        assert_eq!(reasons, ["owner lock file /data/daemon-owner.lock was deleted or replaced"]);
        assert!(logged.lock().unwrap().is_empty());
    }

    #[test]
    fn a_failure_before_the_lifecycle_is_bound_is_said_and_fences_at_the_next_check() {
        let fx = fixture();
        fx.lifecycle.set_serving().unwrap();
        let late = Arc::new(LateLifecycle::default());
        let logged = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = logged.clone();
        let fencing = FencingOwnership::new(
            Arc::new(Taken(Mutex::new(Some(FenceReason::LockLost)))),
            late.clone(),
            PathBuf::from("/data/daemon-owner.lock"),
            Arc::new(move |line| sink.lock().unwrap().push(line.to_owned())),
        );
        assert_eq!(fencing.revalidate(), Err(FenceReason::LockLost));
        assert_eq!(logged.lock().unwrap().len(), 1);
        assert!(!fx.recorder.has_exited());
        late.bind(fx.lifecycle.clone()).unwrap();
        assert_eq!(fencing.revalidate(), Err(FenceReason::LockLost));
        fx.recorder.wait_exit();
    }
}