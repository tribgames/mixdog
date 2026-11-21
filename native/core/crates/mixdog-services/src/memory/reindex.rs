use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use crate::memory::ingest::embed_flush::{FlushFailure, ROOT_SWEEP_BATCH, RawEmbedFlush, RootFlush, SweepStep};
use crate::memory::lifecycle::Owned;

/// `DEFAULT_PASS_PAUSE_MS`: the rest between flush passes.
pub const PASS_PAUSE: Duration = Duration::from_secs(1);
/// `ROOT_SWEEP_PAUSE_MS`: the root-text sweep replaces vectors that still work, so it has no
/// urgency; small steps with long rests.
pub const ROOT_SWEEP_PAUSE: Duration = Duration::from_secs(4);

/// What the flush passes did in all (`drainEmbeddingReindex`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReindexSummary {
    pub passes: usize,
    pub attempted: usize,
    pub succeeded: usize,
    pub failed: usize,
}

/// What the sweep did in all (`runRootEmbedSweep`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SweepSummary {
    pub steps: usize,
    pub replaced: usize,
}

fn check(cancel: &CancellationToken) -> Result<(), FlushFailure> {
    if cancel.is_cancelled() { Err(FlushFailure::Cancelled) } else { Ok(()) }
}

/// `waitForNextPass`: the rest, ended at once by a cancel.
async fn rest(pause: Duration, cancel: &CancellationToken) -> Result<(), FlushFailure> {
    check(cancel)?;
    tokio::select! {
        biased;
        () = cancel.cancelled() => Err(FlushFailure::Cancelled),
        () = mixdog_rt::time::sleep(pause) => Ok(()),
    }
}

/// `drainEmbeddingReindex`: flush passes until one ends before its deadline or makes no progress.
pub async fn drain_embedding_reindex<F, Fut>(mut flush: F, cancel: &CancellationToken, pause: Duration) -> Result<ReindexSummary, FlushFailure>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<RootFlush, FlushFailure>>,
{
    let mut summary = ReindexSummary::default();
    loop {
        check(cancel)?;
        let pass = flush().await?;
        check(cancel)?;
        summary.passes += 1;
        summary.attempted += pass.attempted;
        summary.succeeded += pass.succeeded;
        summary.failed += pass.failed.len();
        if !pass.timed_out || pass.succeeded == 0 {
            return Ok(summary);
        }
        rest(pause, cancel).await?;
    }
}

/// `runRootEmbedSweep`: steps until one reports the sweep done.
pub async fn run_root_embed_sweep<F, Fut>(mut step: F, cancel: &CancellationToken, pause: Duration) -> Result<SweepSummary, FlushFailure>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<SweepStep, FlushFailure>>,
{
    let mut summary = SweepSummary::default();
    loop {
        check(cancel)?;
        let done = step().await?;
        summary.steps += 1;
        summary.replaced += done.replaced;
        if done.done {
            return Ok(summary);
        }
        rest(pause, cancel).await?;
    }
}

struct Running {
    generation: u64,
    cancel: CancellationToken,
    /// The run, work of the database's scope.
    task: Owned<()>,
}

#[derive(Default)]
struct State {
    generation: u64,
    running: Option<Running>,
}

/// The one reindex of a memory runtime.
#[derive(Default)]
pub struct Reindex {
    state: Mutex<State>,
}

impl Reindex {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// `_startEmbeddingReindex`: does nothing in secondary mode (another process owns the model)
    /// or while one is running.
    pub fn start(self: &Arc<Self>, flush: Arc<RawEmbedFlush>, secondary: bool) {
        if secondary {
            return;
        }
        let mut state = self.state.lock().expect("reindex state");
        if state.running.is_some() {
            return;
        }
        state.generation += 1;
        let generation = state.generation;
        let cancel = CancellationToken::new();
        let (this, token, scope) = (self.clone(), cancel.clone(), flush.scope().clone());
        let task = scope.spawn("services.memory.reindex", async move {
            let ended = async {
                let flushed = drain_embedding_reindex(|| flush.flush_roots(&token), &token, PASS_PAUSE).await?;
                if flushed.attempted > 0 {
                    mixdog_rt::memory_stderr!(
                        "[memory-service] embedding reindex passes={} attempted={} ok={} failed={}",
                        flushed.passes,
                        flushed.attempted,
                        flushed.succeeded,
                        flushed.failed
                    );
                }
                let swept = run_root_embed_sweep(|| flush.sweep_root_text(ROOT_SWEEP_BATCH, &token), &token, ROOT_SWEEP_PAUSE).await?;
                if swept.replaced > 0 {
                    mixdog_rt::memory_stderr!("[memory-service] root text sweep steps={} replaced={}", swept.steps, swept.replaced);
                }
                Ok::<(), FlushFailure>(())
            }
            .await;
            if let Err(error) = ended
                && !token.is_cancelled()
            {
                mixdog_rt::memory_stderr!("[memory-service] embedding reindex stopped: {error}");
            }
            // `finally`: this run leaves the slot unless a later one already took it.
            let mut state = this.state.lock().expect("reindex state");
            if state.running.as_ref().is_some_and(|running| running.generation == generation) {
                state.running = None;
            }
        });
        // Refused by a stopping scope: nothing runs and the slot stays free.
        if let Some(task) = task {
            state.running = Some(Running { generation, cancel, task });
        }
    }

    /// `_stopBackgroundWork`'s reindex part: cancels the run and waits until it has ended. A stop abandoned while it waits leaves the run owned by
    /// the database's scope, whose revocation ends it.
    pub async fn stop(&self) {
        let running = self.state.lock().expect("reindex state").running.take();
        if let Some(Running { cancel, task, .. }) = running {
            cancel.cancel();
            task.await;
        }
    }

    pub fn is_running(&self) -> bool {
        self.state.lock().expect("reindex state").running.is_some()
    }
}
