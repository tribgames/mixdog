//! The session activity signal of a job board row, and what the owner's session does on it.
//!
//! Node's task table emits `emitSessionActivityChange(task.ownerSessionId)` when a task is added
//! and when it finishes (`runtime/shared/background-tasks.mjs`). The Rust agent jobs live on the
//! `JobBoard`, whose `on_change(owner)` is that signal, and it lands in
//! [`SessionDirectory::agent_activity`]. Node's subscribers that act for the owner's session are
//! ported on the thread's actor:
//! - **Agent status state.** The agent tool re-reads its status (`agent-tool.mjs`
//!   `statusMayHaveChanged`). The session runtime's listener (`local-session-runtime.mjs`
//!   `onAgentStatusChange`) then sets `agentWorkers` / `agentJobs` from `agentStatusState()`,
//!   which reaches clients as `thread/agents/updated` and is published only when it changed.
//!   The read is [`AgentStatus`]. A thread also publishes it once at load, one settle beat
//!   (16 ms, `session-status-scheduler.mjs:14`) after it starts: the runtime's status pass is
//!   registered dirty. Node has no periodic pass since it replaced the 2 s pulse with change
//!   marks (858b0b2d2), so neither is there one here.
//! - **Goal continuation.** The same listener calls `scheduleGoalContinuation()`: a Goal that
//!   waited on the job's background work may go on.
//! - **Idle clock.** `idle-clock.mjs` `refresh(id)` restarts the clock. A deadline that finds
//!   the session's background work still running (`working`: `hasActiveBackgroundTasks`) waits
//!   its whole delay again.
//!
//! Node's other subscribers are not the session's:
//! - The stored-session catalog's `agent-activity` notice has no production subscriber.
//! - `heldRowMayBeFree` asks the agent registry's maintenance pass.

use async_trait::async_trait;
use mixdog_app_protocol::v2::thread::ThreadAgents;
use mixdog_core_api::ids::ThreadId;

use super::SessionDirectory;
use super::actor::Inbox;

/// `agentStatusState()` of a session: the agent tool's status with the session as the caller.
/// Node reads it inside a `try` and answers both lists empty on any failure; so does an impl.
#[async_trait]
pub trait AgentStatus: Send + Sync {
    async fn status(&self, thread: &ThreadId) -> ThreadAgents;
}

impl SessionDirectory {
    /// `JobBoard`'s `on_change(owner)`: a job of `owner` was added or finished. Only a loaded
    /// thread has a runtime to tell, as in Node; the signal never waits.
    pub fn agent_activity(&self, owner: &str) {
        let Some(handle) = self.handle(&ThreadId::from(owner)) else { return };
        let _ = handle.inbox.try_send(Inbox::AgentActivity);
    }
}
