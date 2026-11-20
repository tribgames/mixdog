//! The release supervisor: every step of the release procedure (LR §5.3) runs on a thread of its
//! own under a budget, so a step that wedges is named and the process still ends.
//!
//! The drain before the release is untimed and stays so (a stop waits for running work, and
//! nothing forces an exit while a durable write is in flight). The budgets here start only once
//! the release itself has begun, and each covers one step, not the whole procedure.

use std::sync::mpsc;
use std::sync::mpsc::RecvTimeoutError;
use std::time::Duration;

/// The ceiling of the whole release, from its start: Node's `SHUTDOWN_BUDGET_MS` (`daemon.mjs:258`, armed at `:292-296`), after which the process
/// exits with `<reason> (budget exceeded, forced exit)` whatever step still runs. The launcher's wait is shorter (`IN_TREE_DAEMON_STOP_GRACE_MS`, 5 s,
/// `daemon-stop-budget.mjs:9`), and what Node guaranteed inside it was the PostgreSQL stop, at its own fallback point (`PG_FORCED_STOP_AT`, 4.2 s).
pub const SHUTDOWN_BUDGET: Duration = Duration::from_millis(15_000);

/// What each release step may take. A step that is still running at its budget is abandoned:
/// the supervisor records its name, withdraws discovery and exits without it.
///
/// The values are chosen, not taken from the spec (lifecycle-remote.md §5.3 gives no limits) or
/// from Node (decisions.md, "Release budgets").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReleaseBudgets {
    /// The session actors' `Clean` barriers; the longest because they are durable writes.
    pub final_barriers: Duration,
    pub close_connections: Duration,
    pub close_ext_host: Duration,
    pub record_exit: Duration,
    pub withdraw_discovery: Duration,
    pub close_data_handles: Duration,
}

impl Default for ReleaseBudgets {
    fn default() -> Self {
        Self {
            final_barriers: Duration::from_secs(120),
            close_connections: Duration::from_secs(10),
            close_ext_host: Duration::from_secs(30),
            record_exit: Duration::from_secs(10),
            withdraw_discovery: Duration::from_secs(10),
            close_data_handles: Duration::from_secs(60),
        }
    }
}

/// How a supervised step ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepEnd {
    Finished,
    /// The step panicked; it is over, and the release goes on with the next one.
    Panicked,
    /// The step was still running at its budget and has been abandoned on its thread.
    OverBudget,
}

/// [`supervise`] for an async step, awaited from the runtime: the step runs to completion on a
/// `mixdog-release-<name>` thread of its own through the runtime handle, as a sync step does, and
/// the wait for it is an async timeout, so no runtime worker and no blocking-pool thread is held
/// for the length of the step.
pub async fn supervise_async(name: &'static str, budget: Duration, step: impl std::future::Future<Output = ()> + Send + 'static) -> StepEnd {
    let runtime = tokio::runtime::Handle::current();
    let (done, finished) = tokio::sync::oneshot::channel::<()>();
    let spawned = std::thread::Builder::new().name(format!("mixdog-release-{name}")).spawn(move || {
        runtime.block_on(step);
        let _ = done.send(());
    });
    if let Err(error) = spawned {
        tracing::error!(step = name, %error, "a release step thread did not start");
        return StepEnd::Panicked;
    }
    match mixdog_rt::time::timeout(budget, finished).await {
        Ok(Ok(())) => StepEnd::Finished,
        // The sender dropped without sending: the step unwound.
        Ok(Err(_)) => panicked(name),
        Err(_) => over_budget(name, budget),
    }
}

/// Runs `work` on a fresh `mixdog-release-<name>` thread and waits at most `budget` for it.
pub fn supervise(name: &'static str, budget: Duration, work: impl FnOnce() + Send + 'static) -> StepEnd {
    let (done, finished) = mpsc::channel::<()>();
    let spawned = std::thread::Builder::new().name(format!("mixdog-release-{name}")).spawn(move || {
        work();
        let _ = done.send(());
    });
    if let Err(error) = spawned {
        tracing::error!(step = name, %error, "a release step thread did not start");
        return StepEnd::Panicked;
    }
    match finished.recv_timeout(budget) {
        Ok(()) => StepEnd::Finished,
        Err(RecvTimeoutError::Disconnected) => panicked(name),
        Err(RecvTimeoutError::Timeout) => over_budget(name, budget),
    }
}

fn panicked(name: &'static str) -> StepEnd {
    tracing::error!(step = name, "a release step panicked");
    StepEnd::Panicked
}

fn over_budget(name: &'static str, budget: Duration) -> StepEnd {
    tracing::error!(step = name, budget_ms = u64::try_from(budget.as_millis()).unwrap_or(u64::MAX), "a release step is over its budget");
    StepEnd::OverBudget
}
