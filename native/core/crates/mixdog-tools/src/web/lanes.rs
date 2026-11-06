//! The lane jobs the web tools run: page extraction is CPU work and the name lookup blocks, so
//! neither goes to tokio's unbounded blocking pool.

use mixdog_rt::CancellationToken;
use mixdog_rt::CpuInteractive;
use mixdog_rt::InLane;
use mixdog_rt::InteractiveIo;
use mixdog_rt::LaneToken;

/// The lane tokens the composition hands to the web tools.
#[derive(Clone, Copy, Debug)]
pub struct WebLanes {
    /// Content extraction of a fetched or rendered page.
    pub extract: CpuInteractive,
    /// The blocking `getaddrinfo` call.
    pub dns: InteractiveIo,
}

/// Runs `work` as a job of `lane` and waits for its result; `Err` when the job was not queued or
/// was dropped.
pub(super) async fn run<L: LaneToken, T: Send + 'static>(
    lane: L,
    work: impl FnOnce(&InLane<L>) -> T + Send + 'static,
) -> Result<T, String> {
    let handle = lane
        .submit_wait(&CancellationToken::new(), work)
        .await
        .map_err(|error| format!("lane job was not queued: {error:?}"))?;
    handle.await.map_err(|_| "lane job was dropped".to_string())
}
