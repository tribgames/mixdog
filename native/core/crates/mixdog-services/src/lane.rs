use std::io;

use mixdog_rt::{CancellationToken, LaneToken};

/// Runs `work` as a job on `lane` and returns what it returned.
pub async fn on_lane<L: LaneToken, T: Send + 'static>(lane: L, work: impl FnOnce() -> T + Send + 'static) -> io::Result<T> {
    let job = lane.submit_wait(&CancellationToken::new(), move |_| work()).await.map_err(|e| io::Error::other(format!("lane job was not queued: {e:?}")))?;
    job.await.map_err(|_| io::Error::other("lane job was dropped"))
}

/// [`io_on_lane`] for a body that needs the lane proof for its file calls.
pub async fn io_in_lane<L: LaneToken, T: Send + 'static>(lane: L, work: impl FnOnce(&mixdog_rt::InLane<L>) -> io::Result<T> + Send + 'static) -> io::Result<T> {
    let job = lane.submit_wait(&CancellationToken::new(), work).await.map_err(|e| io::Error::other(format!("lane job was not queued: {e:?}")))?;
    job.await.map_err(|_| io::Error::other("lane job was dropped"))?
}

/// [`on_lane`] for work that itself returns an I/O result.
pub async fn io_on_lane<L: LaneToken, T: Send + 'static>(lane: L, work: impl FnOnce() -> io::Result<T> + Send + 'static) -> io::Result<T> {
    on_lane(lane, work).await?
}
