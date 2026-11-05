//! One run of an owned automation — a schedule or a webhook endpoint
//! (owned-automation-run.mjs). The run itself is a turn in the owner bot's home thread; the
//! bot's reply there is its result. A run whose owner bot does not exist never fires: it is
//! skipped as paused, never run elsewhere. A second run of the same automation while one is in
//! flight is skipped (and recorded). Unattended runs (timed fires, received webhooks; not the
//! app's "Run now") also back off after consecutive failures and skip a switched-off routine.
//! Runs have no concurrency cap and no deadline.

use std::future::Future;

use tokio_util::sync::CancellationToken;

use super::host::OwnerProblem;
use super::routine::RoutineKind;
use super::runtime::RoutineRuntime;
use crate::scheduler::model::backoff_remaining_ms;

/// A finished run: the home thread it ran in and the bot's reply.
#[derive(Debug, Clone, PartialEq)]
pub struct RoutineRun {
    pub session_id: String,
    pub result: String,
    /// A heartbeat turn cut off at its wall-clock cap: it ended with no reply.
    pub timed_out: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Skip {
    Owner(OwnerProblem),
    Overlap,
    Backoff,
    Paused,
}

impl Skip {
    pub fn reason(self) -> &'static str {
        match self {
            Self::Owner(_) => "owner",
            Self::Overlap => "overlap",
            Self::Backoff => "backoff",
            Self::Paused => "paused",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum OwnedOutcome {
    Ran(RoutineRun),
    /// The run did not happen; the skip is already recorded on the routine.
    Skipped(Skip),
}

#[derive(Clone, Default)]
pub struct RunOpts {
    /// A person asked for it: no failure backoff and no switched-off check.
    pub attended: bool,
    /// The caller already holds `kind:name` (`AutomationRuns::begin`) and releases it itself.
    pub reserved: bool,
    pub cancel: CancellationToken,
}

impl RoutineRuntime {
    /// `run` is the turn; it receives the caller's cancellation.
    pub(super) async fn run_owned<F, Fut>(
        &self,
        kind: RoutineKind,
        name: &str,
        owner_agent_id: &str,
        opts: &RunOpts,
        run: F,
    ) -> Result<OwnedOutcome, String>
    where
        F: FnOnce(CancellationToken) -> Fut,
        Fut: Future<Output = Result<RoutineRun, String>>,
    {
        if name.is_empty() {
            return Err(format!("{} run: a {} row is required", kind.word(), kind.word()));
        }
        let skip = move |reason: Skip| async move {
            if let Err(error) = self.records.record_skip(kind, name, self.clock.now()).await {
                tracing::warn!("{} \"{name}\": skip record failed: {error}", kind.word());
            }
            Ok::<_, String>(OwnedOutcome::Skipped(reason))
        };
        // The name is reserved before the owner check, so a rename can neither complete while
        // it waits nor leave this run to start under the old name.
        let (overlap, hold) = if opts.reserved {
            (false, None)
        } else {
            match self.runs.begin(kind, name) {
                Some(hold) => (false, Some(hold)),
                None => (true, None),
            }
        };
        // A routine runs only in its own bot's thread: without that bot it waits. A read fault
        // never pauses anything.
        let problem = self.host.owner_problem(owner_agent_id, true).await.ok().flatten();
        if let Some(problem) = problem {
            tracing::warn!("{} \"{name}\": paused, {}", kind.word(), problem.message());
            return skip(Skip::Owner(problem)).await;
        }
        if overlap {
            return skip(Skip::Overlap).await;
        }
        if !opts.attended {
            let state = self.records.state(kind, name).await.ok().flatten();
            // Switched off (by the user, or by the failure limit): the cron claim and the
            // webhook handler already refuse it, but a one-shot timer or a dispatch that raced
            // the pause must not run it either.
            if state.as_ref().is_some_and(|s| !s.enabled) {
                tracing::info!("{} \"{name}\": skipped, switched off", kind.word());
                return skip(Skip::Paused).await;
            }
            if let Some(state) = &state {
                let wait = backoff_remaining_ms(state.consecutive_failures, state.last_failed_at, self.clock.now());
                if wait > 0 {
                    tracing::info!(
                        "{} \"{name}\": skipped, backing off {}s after failures in a row",
                        kind.word(),
                        (wait + 999) / 1000
                    );
                    return skip(Skip::Backoff).await;
                }
            }
        }
        let outcome = run(opts.cancel.clone()).await.map(OwnedOutcome::Ran);
        drop(hold);
        outcome
    }
}
