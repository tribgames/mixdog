//! What the lifecycle needs from the rest of the process. The composition root implements
//! these over the real core, discovery file and process; tests use recorders.
//!
//! All methods are synchronous and may block: they run on the thread that caused the
//! transition or on the release thread, never inside the state lock.

use std::sync::Arc;

use super::model::DiscoveryState;
use super::model::DrainNotice;
use super::model::Running;

/// The running core: feed publication, work cancellation and the ordered release steps
/// (LR §5.3 steps 1–3 and 6).
pub trait CorePort: Send + Sync {
    /// Publish `core/drain` on the app feed.
    fn drain_notice(&self, notice: &DrainNotice);
    /// The core serves (the boot's `set_serving` or a `cancelDrain`): publish the `core` section as `serving`, replacing a
    /// `draining` a client's attach snapshot would otherwise keep. Default: nothing to publish.
    fn serving(&self) {}
    /// Publish `core/health{stalledMs}`; `0` means the runtime is answering again.
    fn health(&self, stalled_ms: u64);
    /// Publish `lane.health{lane, wedged}` when a lane's count of workers stuck past their
    /// lease changes (F1); `wedged == 0` means the lane is healthy again. Default: not
    /// published (the compose-seams row for wp-run-host names the real publisher).
    fn lane_health(&self, _lane: &str, _wedged: usize) {}
    /// Cancel these units of work through their tokens; the tool runtime kills job objects and
    /// process groups. Each registrant drops its guard as it finishes.
    fn cancel_running(&self, running: &[Running]);
    /// A stop was requested (any mode; not the self-shutdown): the new-task attempts in flight end now, each as Node's attempt
    /// ends when its host is disposed at the call it was awaiting (`SessionDirectory::cut_new_tasks`), before the drain waits for the rest.
    fn cut_new_tasks(&self);
    /// The user's `release{pid}` decision on an undecidable prior owner.
    fn release_decision(&self, pid: u32);
    /// The release begins, before its first step: `reason` is the text Node's `shutdown(reason)` carries for this stop (`daemon.mjs:272`), which the stop steps
    /// hand to the agent dispatch's abort (`agent-dispatch.mjs:60`). Default: nothing to tell.
    fn release_started(&self, _reason: &str) {}
    /// Every session actor `Clean` or reported `storage_indeterminate`.
    fn final_barriers(&self);
    fn close_connections(&self);
    /// `bye`, then wait for the extension host to exit.
    fn close_ext_host(&self);
    fn close_data_handles(&self);
    /// Writes out the log lines still queued. Runs once, right before the process ends, on every release path (a stuck step included),
    /// as Node's `process.on('exit', flushDaemonLogsSync)` does. Default: nothing to write.
    fn flush_log(&self) {}
}

/// The discovery file (LR §4). Owned by the ownership package; the lifecycle supplies only the
/// state it contributes.
pub trait Publication: Send + Sync {
    fn publish(&self, state: &DiscoveryState);
    /// Remove discovery if it names this instance (LR §5.3 step 5).
    fn withdraw(&self);
}

/// Process exit with `code` (0, or 2 for Node's fatal boot error). The real implementation never returns.
pub trait Exiter: Send + Sync {
    fn exit(&self, code: i32);
}

#[derive(Clone)]
pub struct Ports {
    pub core: Arc<dyn CorePort>,
    pub discovery: Arc<dyn Publication>,
    pub exiter: Arc<dyn Exiter>,
}
