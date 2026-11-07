//! What the workspace transitions need from the session runtime (Node's hooks of
//! `createWorkspaceTransitions`). The composition implements [`WorkspaceHost`] over the session
//! directory, the agent registry and the shell-job registry; the transitions stay independent
//! of the actor.

use std::future::Future;
use std::pin::Pin;

use async_trait::async_trait;
use mixdog_rt::CancellationToken;
use mixdog_scm::error::ScmFailure;
use serde_json::Value;

/// The exact undo of one change; run newest first when a transition fails.
pub type Undo = Box<dyn FnOnce() -> Pin<Box<dyn Future<Output = Result<(), ScmFailure>> + Send>> + Send>;

/// What a session record carries now.
#[derive(Clone, Debug, Default)]
pub struct SessionView {
    /// `session.cwd`.
    pub cwd: Option<String>,
    /// The runtime cwd the session's tools run in.
    pub runtime_cwd: String,
    /// The durable `workspace` record, unnormalized.
    pub workspace: Option<Value>,
    /// The desktop metadata's Project path when its classification is `project`.
    pub desktop_project: Option<String>,
    /// The session (or its live turn) has conversation messages.
    pub has_messages: bool,
}

/// What `assertLeadIdle` reads: the Lead's turn, its workers and jobs, and the background
/// shells owned by the Lead and its workers.
#[derive(Clone, Copy, Debug, Default)]
pub struct LeadActivity {
    pub turn_running: bool,
    pub busy_workers: u64,
    pub busy_jobs: u64,
    pub shell_jobs: u64,
}

/// A session as the folder checks see it.
#[derive(Clone, Debug, Default)]
pub struct LiveSession {
    pub id: String,
    pub cwd: Option<String>,
    /// A turn, stage or controller is running.
    pub active: bool,
    pub closed: bool,
    pub owner_session_id: Option<String>,
    pub parent_session_id: Option<String>,
}

/// A background command's folder.
#[derive(Clone, Debug)]
pub struct JobCwd {
    pub cwd: String,
    pub terminal: bool,
}

/// A move out of the project folder into a worktree: the prompt's working-folder notice.
#[derive(Clone, Debug)]
pub struct Move {
    pub from: String,
    /// `carried`, `left` or `None`.
    pub changes: Option<String>,
}

/// The new workspace of a Lead.
#[derive(Clone, Debug)]
pub struct WorkspaceChange {
    pub cwd: String,
    /// The record to store; `null` on a Project switch of a session that has none.
    pub workspace: Value,
    pub moved: Option<Move>,
    /// A Project switch's desktop classification (`persistProjectSelection`): the
    /// `desktopSession` to store, `None` to leave the session's as it is.
    pub desktop_session: Option<Value>,
}

#[async_trait]
pub trait WorkspaceHost: Send + Sync + 'static {
    /// Whether `session_id` is a Lead session this runtime hosts.
    async fn is_lead(&self, session_id: &str) -> bool;

    /// A conversation session (a Lead or a bot chat); schedule, webhook, routine and room runs
    /// are not and may only list worktrees.
    async fn attended(&self, session_id: &str) -> bool;

    /// The hosted session, or `None`.
    fn session(&self, session_id: &str) -> Option<SessionView>;

    /// Publish `workspace` as the session's in-memory record only (the in-flight marker, then
    /// the stored record again); nothing is saved.
    fn set_workspace(&self, session_id: &str, workspace: Option<Value>);

    async fn activity(&self, session_id: &str) -> LeadActivity;

    /// Live sessions of this runtime.
    fn live_sessions(&self) -> Vec<LiveSession>;

    /// Stored sessions that may still use a folder.
    async fn stored_consumers(&self) -> Vec<LiveSession>;

    async fn running_jobs(&self) -> Vec<JobCwd>;

    /// Running background shell jobs owned by any of `session_ids`.
    async fn shell_job_count(&self, session_ids: &[String]) -> u64;

    /// Apply a committed workspace: the runtime cwd, `session.cwd`, the stored record, the Lead
    /// pool row, the prompt context of the Lead and its idle workers (a conversation keeps its
    /// system prompt and gets a tail notice), awaiting a durable save. A Project switch to the
    /// folder the session already runs in stores only the record and the classification. On
    /// error the host has left the session as it was; on success the undo restores everything
    /// it changed.
    async fn apply(&self, session_id: &str, change: WorkspaceChange) -> Result<Undo, ScmFailure>;

    /// Carry the Project's memory identity into a worktree outside the Project tree.
    async fn copy_project_identity(&self, project_path: &str, worktree_path: &str) -> Result<bool, ScmFailure>;

    /// Prepare a new checkout's dependencies at the first turn there.
    async fn run_pending_setup(&self, session_id: &str, cancel: &CancellationToken) -> Result<(), ScmFailure>;
}
