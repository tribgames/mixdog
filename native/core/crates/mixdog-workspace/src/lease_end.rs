//! The end of a lease as a persistent terminal event, and the scheduler that publishes an expiry at its deadline.
//!
//! The owner of an authority (the project-lease table, the transfer table) publishes its end; every wait made under that authority
//! (a stream parked for room, a delivery queued in a session) selects on it, so none outlives it with its source and its buffers.
//! The event is a [`CancellationToken`]: once ended it stays ended, so a waiter that subscribes after the end, or between its
//! subscription and its check, is released at once. The enforcement stays the owner's guarded commit; the event is termination and
//! release.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

/// A lease's terminal event, published when the table entry that owns this value leaves the table by any way (expiry, eviction, an
/// unpair's removal, a finish), or when its owner ends it in place ([`end`](Self::end)).
pub struct EndOnDrop(CancellationToken);

impl EndOnDrop {
    pub fn new() -> Self {
        Self(CancellationToken::new())
    }

    /// The event, for the media lane to wait on.
    pub fn token(&self) -> CancellationToken {
        self.0.clone()
    }

    pub fn end(&self) {
        self.0.cancel();
    }

    pub fn is_ended(&self) -> bool {
        self.0.is_cancelled()
    }
}

impl Default for EndOnDrop {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for EndOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

/// Sleeps a number of milliseconds on its owner's clock; tests substitute one that moves with their clock.
pub trait Sleeper: Send + Sync {
    fn sleep(&self, ms: u64) -> Pin<Box<dyn Future<Output = ()> + Send>>;
}

/// The daemon's sleep.
pub struct TokioSleeper;

impl Sleeper for TokioSleeper {
    fn sleep(&self, ms: u64) -> Pin<Box<dyn Future<Output = ()> + Send>> {
        Box::pin(mixdog_rt::time::sleep(Duration::from_millis(ms)))
    }
}

/// An earliest-deadline scheduler for one owner, with no timer per stream: `end_due` ends what is due under the owner's lock (and
/// samples the time after taking it) and answers the delay in milliseconds to the earliest deadline left, `None` when nothing is
/// scheduled. The loop sleeps that long, or until `changed` says a deadline was added or moved earlier, and asks again: a timer that
/// fires for a deadline that has since moved (a download's idle renewal) finds nothing due and sleeps to the new one. The wake is
/// subscribed before `end_due` looks, so an addition made meanwhile is not lost.
pub async fn run_deadlines<F: Future<Output = ()>>(changed: &Notify, sleep: impl Fn(u64) -> F, mut end_due: impl FnMut() -> Option<u64>) {
    loop {
        let woken = changed.notified();
        tokio::pin!(woken);
        woken.as_mut().enable();
        match end_due() {
            Some(after) => {
                tokio::select! {
                    () = sleep(after) => {}
                    () = &mut woken => {}
                }
            }
            None => woken.await,
        }
    }
}
