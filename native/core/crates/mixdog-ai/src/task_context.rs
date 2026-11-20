//! What a model send reads from the task it runs on, carried to a task its caller spawns to run the send ([`carry`]).

use std::future::Future;

use tracing::Instrument;

/// Held by the caller while it waits for the task it spawned, and dropped when it stops waiting: with it goes whatever of the
/// task still counts for the caller's own turn (its parked waits on a replay's settled signal, feature `replay-bytes`), at
/// once, not when the runtime gets to the task's abort.
pub struct Caller {
    #[cfg(feature = "replay-bytes")]
    _run: crate::transport::replay_bytes::Delegate,
}

/// `work`, which the caller spawns to do part of its own work (a compaction's summary call), under everything the send path
/// reads from its task as the caller's task has it now: every task-local of this crate and of mixdog-rt, and the current
/// tracing span. The caller holds the [`Caller`] while it waits for the task.
pub fn carry<F: Future>(work: F) -> (impl Future<Output = F::Output>, Caller) {
    // Each layer below holds the future it wraps by value, and an unoptimised build gives every layer's construction and
    // poll frame room for all of it: around a whole send, a dozen layers overflowed a 2 MiB stack. Boxed, each wraps a pointer.
    let work = Box::pin(work);
    let work = crate::accounts::carry(work);
    let work = crate::registry::accounted::carry(work);
    let work = crate::registry::gateway::carry(work);
    let work = crate::providers::compat::login::opencode_go::carry(work);
    let work = crate::transport::model_driver::carry(work);
    #[cfg(feature = "replay-bytes")]
    let (work, run) = crate::transport::replay_bytes::delegate(work);
    let work = mixdog_rt::carry_task_locals(work).instrument(tracing::Span::current());
    (
        work,
        Caller {
            #[cfg(feature = "replay-bytes")]
            _run: run,
        },
    )
}
