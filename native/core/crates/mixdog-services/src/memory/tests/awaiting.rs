//! One deadline for a thing a test waits for, measured on the machine's clock.
//!
//! A paused runtime clock moves only when the test advances it (or by itself when the runtime is idle, which is not time passing for the awaited work), so a deadline
//! on it would say nothing about a signal that never comes. A wait ends on its signal; this is only the failure path, so it is never what makes a test pass.

#![allow(clippy::disallowed_methods, reason = "test setup")]

use std::future::Future;
use std::time::Duration;

const DEADLINE: Duration = Duration::from_secs(30);

/// Awaits `wait`, failing by panic naming `what` if it has not ended by the deadline.
pub async fn awaiting<T>(what: &str, wait: impl Future<Output = T>) -> T {
    awaiting_for(DEADLINE, what, wait).await
}

/// [`awaiting`] with the deadline's length given.
pub async fn awaiting_for<T>(limit: Duration, what: &str, wait: impl Future<Output = T>) -> T {
    let (over, ended) = std::sync::mpsc::channel::<()>();
    let (fire, mut fired) = tokio::sync::oneshot::channel::<()>();
    // A blocking task, not a timer: while one runs, a paused runtime does not advance its clock by itself, so the wait cannot be made true by a timer nobody advanced to.
    tokio::task::spawn_blocking(move || {
        if ended.recv_timeout(limit) == Err(std::sync::mpsc::RecvTimeoutError::Timeout) {
            let _ = fire.send(());
        }
    });
    let _over = over;
    tokio::select! {
        biased;
        value = wait => value,
        Ok(()) = &mut fired => panic!("timed out after {limit:?} waiting for {what}"),
    }
}
