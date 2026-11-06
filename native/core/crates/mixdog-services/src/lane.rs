//! Blocking work of the service modules as jobs on a lane.
//!
//! An async path never touches the file system itself: it hands the blocking body to the lane
//! that owns that kind of work and awaits the answer. Cancelling the awaiting future leaves a
//! job already queued to finish; a job that cannot be queued or is dropped is reported as an
//! I/O error, so a caller treats it like any other failed read.

use std::io;

use mixdog_rt::{CancellationToken, LaneToken};

/// Runs `work` as a job on `lane` and returns what it returned.
pub async fn on_lane<L: LaneToken, T: Send + 'static>(lane: L, work: impl FnOnce() -> T + Send + 'static) -> io::Result<T> {
    let job = lane.submit_wait(&CancellationToken::new(), move |_| work()).await.map_err(|e| io::Error::other(format!("lane job was not queued: {e:?}")))?;
    job.await.map_err(|_| io::Error::other("lane job was dropped"))
}

/// [`on_lane`] for work that itself returns an I/O result.
pub async fn io_on_lane<L: LaneToken, T: Send + 'static>(lane: L, work: impl FnOnce() -> io::Result<T> + Send + 'static) -> io::Result<T> {
    on_lane(lane, work).await?
}
