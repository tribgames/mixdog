//! Running-work accounting for the idle-stop decision.
//!
//! Armed schedules, a listening webhook server, an active channel bridge and every
//! in-flight run or call hold a [`WorkGuard`]; the core stops when its last client has
//! left and [`RunningWork::count`] is zero. Counting is one atomic: holders never wait
//! on each other.

use std::sync::Arc;

use tokio::sync::watch;

/// The watch value is the counter itself, so a published value is never stale.
#[derive(Clone)]
pub struct RunningWork {
    changed: Arc<watch::Sender<usize>>,
}

impl Default for RunningWork {
    fn default() -> Self {
        Self::new()
    }
}

impl RunningWork {
    pub fn new() -> Self {
        Self {
            changed: Arc::new(watch::channel(0).0),
        }
    }

    /// Registers one unit of running work until the guard drops.
    pub fn begin(&self) -> WorkGuard {
        self.changed.send_modify(|n| *n += 1);
        WorkGuard { work: self.clone() }
    }

    pub fn count(&self) -> usize {
        *self.changed.borrow()
    }

    pub fn is_idle(&self) -> bool {
        self.count() == 0
    }

    /// Resolves once the count has reached zero.
    pub async fn idle(&self) {
        let mut rx = self.changed.subscribe();
        // `wait_for` checks the current value first, so a zero already reached is seen.
        let _ = rx.wait_for(|n| *n == 0).await;
    }
}

/// One unit of running work; releasing it is dropping it.
pub struct WorkGuard {
    work: RunningWork,
}

impl Drop for WorkGuard {
    fn drop(&mut self) {
        self.work.changed.send_modify(|n| *n -= 1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn counts_guards_and_signals_idle() {
        let work = RunningWork::new();
        assert!(work.is_idle());
        let a = work.begin();
        let b = work.begin();
        assert_eq!(work.count(), 2);
        drop(a);
        assert!(!work.is_idle());
        let waiter = tokio::spawn({
            let work = work.clone();
            async move { work.idle().await }
        });
        drop(b);
        waiter.await.unwrap();
        assert!(work.is_idle());
    }
}
