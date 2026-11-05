//! Lane routing: blocking file work runs as a job on the lane its token names
//! (RL §13); the async caller only awaits the handle.

use mixdog_rt::CpuBulk;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InteractiveIo;
use mixdog_rt::LaneToken;
use mixdog_rt::MaintenanceIo;
use tokio_util::sync::CancellationToken;

use crate::error::Reason;
use crate::error::WsError;
use crate::error::WsResult;

/// The tokens the workspace domain owns.
#[derive(Clone, Copy, Debug)]
pub struct Lanes {
    pub interactive: InteractiveIo,
    pub durability: DurabilityIo,
    pub maintenance: MaintenanceIo,
    pub cpu_bulk: CpuBulk,
}

/// Lane jobs this crate has started, and how many are running now; compiled only for the DS-WS-5
/// gate. The clippy ban on `std::fs` sends this crate's blocking file work to lane jobs and each
/// job is submitted through [`counted`], so with nothing running at the start of a window and nothing
/// started during it, this crate made no file-system call in that window, including none from a job
/// that was already running.
///
/// Both numbers live in one word (started in the high half, running in the low half) so a reader
/// gets them from a single load: a job cannot start between the two reads of a snapshot.
#[cfg(feature = "count-jobs")]
static JOB_WORD: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
#[cfg(feature = "count-jobs")]
const STARTED_ONE: u64 = 1 << 32;
#[cfg(feature = "count-jobs")]
const RUNNING_MASK: u64 = STARTED_ONE - 1;

/// One atomic reading of the job counters.
#[cfg(feature = "count-jobs")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct JobSnapshot {
    pub started: u64,
    pub running: u64,
}

#[cfg(feature = "count-jobs")]
pub fn job_snapshot() -> JobSnapshot {
    let word = JOB_WORD.load(std::sync::atomic::Ordering::SeqCst);
    JobSnapshot { started: word >> 32, running: word & RUNNING_MASK }
}

/// The idle verdict for a window between two snapshots: nothing running when it opened, nothing
/// started in it (a job that started and finished inside it still counts), nothing running when it
/// closed.
#[cfg(feature = "count-jobs")]
pub fn idle_window_violation(open: JobSnapshot, close: JobSnapshot) -> Option<String> {
    if open.running != 0 {
        return Some(format!("{} lane job(s) already running when the window opened", open.running));
    }
    if close.started != open.started {
        return Some(format!("{} lane job(s) started inside the window", close.started - open.started));
    }
    if close.running != 0 {
        return Some(format!("{} lane job(s) running when the window closed", close.running));
    }
    None
}

#[cfg(feature = "count-jobs")]
struct Running;

#[cfg(feature = "count-jobs")]
impl Drop for Running {
    fn drop(&mut self) {
        JOB_WORD.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Wraps a lane job body: the single place a job's start and end are observed.
pub(crate) fn counted<R>(job: impl FnOnce() -> R) -> impl FnOnce() -> R {
    move || {
        #[cfg(feature = "count-jobs")]
        let _running = {
            JOB_WORD.fetch_add(STARTED_ONE + 1, std::sync::atomic::Ordering::SeqCst);
            Running
        };
        job()
    }
}

/// Runs `job` on `lane`. A cancelled token drops a job that has not started.
pub async fn run<L, R, F>(lane: L, cancel: &CancellationToken, job: F) -> WsResult<R>
where
    L: LaneToken,
    R: Send + 'static,
    F: FnOnce() -> R + Send + 'static,
{
    let job = counted(job);
    let handle = lane.submit(cancel, move |_| job())?;
    handle.await.map_err(|_| WsError::new(Reason::Cancelled, "The request was cancelled."))
}

/// [`run`] for jobs that fail themselves.
pub async fn run_fallible<L, R, F>(lane: L, cancel: &CancellationToken, job: F) -> WsResult<R>
where
    L: LaneToken,
    R: Send + 'static,
    F: FnOnce() -> WsResult<R> + Send + 'static,
{
    run(lane, cancel, job).await?
}
