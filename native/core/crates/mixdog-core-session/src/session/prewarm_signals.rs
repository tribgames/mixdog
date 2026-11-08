//! The session events that start or wake the code-graph prewarm (Node
//! `session-runtime/prewarm/code-graph-prewarm.mjs` and its callers). The timer itself is the run
//! host's (`mixdog-core` `run_host::code_graph_prewarm::CodeGraphPrewarm`); a thread only says
//! when:
//! - **Busy state changes** (`rt.wakeDeferredWarmups`, `boot/config.mjs:101`): a turn starts or
//!   ends (`setActiveTurnCount`) and a session create settles. A warm parked on a busy runtime
//!   re-checks then.
//! - **The first visible output of the runtime's first turn** (`turn-open.mjs:22-33`
//!   `heavyRuntimeWarmupArm`, armed by `ask-callbacks.mjs:56` on text, reasoning or tool
//!   progress, `stream-progress.mjs:4`): `schedule(0, 'first-visible')`, once per runtime.
//! - **A cwd applied** (`cwd-apply.mjs:85-90` `applyResolvedCwd`, called on resume
//!   `resume.mjs:158` and on every workspace move): `schedule(changed ? 0 : delay, changed ?
//!   'cwd-change' : 'cwd')`, except in lazy mode before the runtime's first turn armed its warm.

use std::sync::Arc;
use std::time::Duration;

/// Wakes the prewarm when dropped: held for the life of a session create.
pub(crate) struct WakeOnDrop(pub(crate) Arc<dyn CodeGraphPrewarmSignals>);

impl Drop for WakeOnDrop {
    fn drop(&mut self) {
        self.0.wake();
    }
}

/// The code-graph prewarm a thread's events drive.
pub trait CodeGraphPrewarmSignals: Send + Sync {
    /// `scheduleCodeGraphPrewarm(delay, reason)`; `None` is the configured delay
    /// (`codeGraphPrewarmDelayMs`).
    fn schedule(&self, delay: Option<Duration>, reason: &'static str);
    /// `rt.wakeDeferredWarmups()`: the runtime's busy state changed.
    fn wake(&self);
    /// `settleTurn` (`turn-settle.mjs`): a turn settled. The first one of the process reschedules the provider model warm.
    fn turn_settled(&self) {}
    /// `isCodeGraphPrewarmLazy()` (`runtime-tunables.mjs`): a cwd applied before the first turn
    /// does not warm.
    fn lazy(&self) -> bool;
}
