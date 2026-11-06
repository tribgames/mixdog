//! Node's `downloadToFileWithRetry` schedule (`src/runtime/shared/bounded-download.mjs`):
//! every attempt has 180 s in all (`AbortSignal.timeout(timeoutMs)` covers the request and the
//! body); a failure other than a 4xx answer waits 1 s, 3 s, then 9 s and tries again, so at
//! most four attempts; a cancel ends an attempt and any wait at once.

use std::future::Future;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use crate::model_install::DownloadError;

/// `timeoutMs` of one attempt.
pub const ATTEMPT_TIMEOUT: Duration = Duration::from_secs(180);
/// `DEFAULT_RETRY_DELAYS_MS`: the waits before attempts two, three and four.
pub const RETRY_DELAYS: [Duration; 3] = [Duration::from_secs(1), Duration::from_secs(3), Duration::from_secs(9)];
/// What an attempt that outlives its deadline fails with (`AbortSignal.timeout`'s reason).
const TIMED_OUT: &str = "The operation was aborted due to timeout";

/// Why a bounded unit of work ended without an answer.
enum Ended {
    Cancelled,
    Expired,
}

/// Stand-in for `mixdog_rt::Liveness::unary(total)` of the hang-http work: a total deadline on
/// one unary call, `select!{ biased; cancel, deadline, work }`. When `mixdog_rt::Liveness` lands
/// this becomes `Liveness::unary(ATTEMPT_TIMEOUT)` and the type here is deleted.
struct Unary {
    total: Duration,
}

impl Unary {
    async fn bound<T>(&self, cancel: &CancellationToken, work: impl Future<Output = T>) -> Result<T, Ended> {
        tokio::select! {
            biased;
            () = cancel.cancelled() => Err(Ended::Cancelled),
            () = tokio::time::sleep(self.total) => Err(Ended::Expired),
            done = work => Ok(done),
        }
    }
}

/// Runs `attempt` on Node's schedule and answers the first success, a terminal failure, or the
/// failure of the last attempt. `discard` removes what an attempt that timed out left behind
/// (a failed attempt cleans up after itself). `on_retry(n, wait, error)` is called before each wait.
pub async fn with_retry<A, AF, D, DF>(
    mut attempt: A,
    mut discard: D,
    cancel: &CancellationToken,
    on_retry: impl Fn(usize, Duration, &DownloadError),
) -> Result<u64, DownloadError>
where
    A: FnMut() -> AF,
    AF: Future<Output = Result<u64, DownloadError>>,
    D: FnMut() -> DF,
    DF: Future<Output = ()>,
{
    let liveness = Unary { total: ATTEMPT_TIMEOUT };
    for n in 0..=RETRY_DELAYS.len() {
        if cancel.is_cancelled() {
            return Err(DownloadError::Cancelled);
        }
        let outcome = match liveness.bound(cancel, attempt()).await {
            Ok(outcome) => outcome,
            Err(Ended::Cancelled) => Err(DownloadError::Cancelled),
            Err(Ended::Expired) => {
                discard().await;
                Err(DownloadError::Network(TIMED_OUT.to_owned()))
            }
        };
        let error = match outcome {
            Ok(bytes) => return Ok(bytes),
            Err(error) => error,
        };
        if cancel.is_cancelled() {
            return Err(DownloadError::Cancelled);
        }
        let Some(wait) = RETRY_DELAYS.get(n).copied().filter(|_| !error.is_terminal()) else {
            return Err(error);
        };
        on_retry(n + 1, wait, &error);
        tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(DownloadError::Cancelled),
            () = tokio::time::sleep(wait) => {}
        }
    }
    Err(DownloadError::Cancelled)
}
