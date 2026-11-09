//! The turn review: the files a turn's tools write, folded into one review per turn (Node
//! `turn-snapshot.mjs`, `patch/ui-diff.mjs`). One component owns it (`mixdog-core::turn_review`);
//! the edit and `apply_patch` tools, the office and tidy writers, the worker turns, the source
//! control review bases and the client methods all feed and read it through [`TurnReviewApi`].

use async_trait::async_trait;
use bytes::Bytes;
use serde_json::Map;
use serde_json::Value;

/// One side of a changed file as the review keeps it.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum ReviewContent {
    /// The file does not exist on this side.
    Absent,
    Bytes(Bytes),
    /// The bytes were not captured (binary or oversized): the review lists the path as changed and
    /// offers no diff or undo for it. `reason` is the capture's own word (`oversized`, …).
    Omitted { size: u64, reason: Option<String> },
}

impl ReviewContent {
    pub fn bytes(value: impl Into<Bytes>) -> Self {
        Self::Bytes(value.into())
    }
}

/// A file a tool call changed. A rename carries `new_path` (the destination); `before` is the
/// source's state and `after` the destination's.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct CallChange {
    pub path: String,
    pub new_path: Option<String>,
    pub before: ReviewContent,
    pub after: ReviewContent,
}

/// The identity of a running turn's review: completing with it can only ever seal that turn.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct TurnToken {
    pub generation: u64,
    pub checkpoint_id: String,
}

/// How a turn opens its review.
#[derive(Clone, Default, PartialEq, Eq, Debug)]
pub struct TurnOpen {
    /// The first submitted row's id: the turn's checkpoint.
    pub checkpoint_id: String,
    /// A completion wake reopens the current turn instead of starting one.
    pub continue_turn: bool,
}

/// What a worker's review hands its owner when it completes: the patches its tool results carried
/// (used when the worker tracked nothing of its own).
pub type WorkerPatches = Vec<String>;

/// A worker execution bound to its owner's review (`beginAgentTurnReview`).
pub trait AgentReview: Send + Sync {
    /// Idempotent: the first call hands the worker's edits to its owner.
    fn complete(&self, patches: WorkerPatches) -> bool;
}

/// A reply object in Node's key order.
pub type Reply = Map<String, Value>;

/// Why a review operation failed: the message Node's error carried.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ReviewError {
    pub message: String,
    /// `TypeError` in Node (a missing argument), else `Error`.
    pub type_error: bool,
}

impl ReviewError {
    pub fn new(message: impl Into<String>) -> Self {
        Self { message: message.into(), type_error: false }
    }

    pub fn type_error(message: impl Into<String>) -> Self {
        Self { message: message.into(), type_error: true }
    }
}

impl std::fmt::Display for ReviewError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ReviewError {}

/// Options of a turn-review read (`getTurnReviewDiff`).
#[derive(Clone, Default, PartialEq, Eq, Debug)]
pub struct ReviewRead {
    /// The client's tag of the review it holds: an unchanged review answers with the tag alone.
    pub known: Option<String>,
    /// Leave the patch text out (a collapsed review bar).
    pub summary: bool,
}

/// Options of a historical per-turn read (`getTurnChanges`).
#[derive(Clone, Default, PartialEq, Eq, Debug)]
pub struct ChangesRead {
    pub checkpoint_id: String,
    pub patch: bool,
    pub file: Option<String>,
}

/// Told when open reviews must read again (`noteTurnReviewChanged`, which `onTurnReviewChanged`
/// listeners receive once per task): the sessions that have a review. Node's signal names none; its
/// one consumer (the desktop's `turn-review-changed` event) rereads whichever session is open, so
/// every session with a review is told.
pub type ReviewChanged = std::sync::Arc<dyn Fn(&[String]) + Send + Sync>;

/// The turn review as the rest of the core sees it.
#[async_trait]
pub trait TurnReviewApi: Send + Sync {
    // ── per-call recording (tools) ─────────────────────────────────────────

    /// A committed edit or `apply_patch` call: folds its changes into the session's turn review and
    /// keeps the call's own card diff for [`take_call_diff`](Self::take_call_diff). `base_path` is
    /// the directory the call resolved its paths against. Best effort: it never fails the call.
    /// The diff work runs off the caller's poll.
    async fn record_call(&self, call_id: &str, session_id: &str, base_path: &str, changes: Vec<CallChange>);

    /// A tool without a per-call card (tidy, office): its writes join the turn review with their
    /// own line counts. Best effort.
    async fn record_tool_changes(&self, session_id: &str, base_path: &str, changes: Vec<CallChange>);

    /// The card diff of a finished call, once (`takeApplyPatchUiDiff`): the tool result carries it
    /// as `uiDiff`.
    fn take_call_diff(&self, call_id: &str) -> Option<String>;

    /// A boundary the review follows (`noteTurnWorktreeChange`): files a tool wrote, or `None`
    /// when anything may have changed (a shell, terminal or git command finished).
    fn note_change(&self, paths: Option<&[String]>);

    /// `onTurnReviewChanged(listener)`: runs whenever a boundary stamped a worktree or a capture changed
    /// what a review shows. A review that is not wired tells no one.
    fn on_review_changed(&self, _listener: ReviewChanged) {}

    // ── turn lifecycle ─────────────────────────────────────────────────────

    async fn begin_turn(&self, worktree: &str, session_id: &str, open: TurnOpen) -> Option<TurnToken>;

    /// Seals the turn (`completeTurnSnapshot`); `expected` makes a delayed call a no-op once a
    /// newer turn began.
    async fn complete_turn(&self, session_id: &str, expected: Option<&TurnToken>) -> bool;

    /// A worker execution joins its owner's review.
    fn begin_agent_review(&self, owner_session_id: &str, child_session_id: &str, agent: &str, tag: &str) -> Option<Box<dyn AgentReview>>;

    /// The session was deleted: its turn, parked worker reviews and bound trackers go.
    fn forget_session(&self, session_id: &str);

    // ── reads and undo ─────────────────────────────────────────────────────

    async fn turn_review_diff(&self, worktree: &str, session_id: &str, read: ReviewRead) -> Reply;
    async fn turn_review_file_patch(&self, worktree: &str, session_id: &str, file: &str) -> Reply;
    /// `getSessionReviewDiff`: the session's net change, which survives turn boundaries and has no
    /// revert contract.
    async fn session_review_diff(&self, worktree: &str, session_id: &str) -> Reply;
    /// `getSessionReviewFilePatch`: one file of the session review with its whole patch; `old_path`
    /// is a rename's source.
    async fn session_review_file_patch(&self, worktree: &str, session_id: &str, file: &str, old_path: &str) -> Reply;
    async fn revert_turn_review(&self, worktree: &str, session_id: &str, checkpoint_id: &str) -> Result<Reply, ReviewError>;
    async fn revert_turn_review_file(&self, worktree: &str, session_id: &str, file: &str, checkpoint_id: &str) -> Result<Reply, ReviewError>;
    async fn turn_changes(&self, session_id: &str, read: ChangesRead) -> Result<Reply, ReviewError>;
    /// `revision` is the record revision the caller read; anything but an integer is a
    /// `TypeError`, a stale one `turn changes changed; refresh`.
    async fn revert_turn_changes(&self, session_id: &str, checkpoint_id: &str, file: Option<&str>, revision: f64) -> Result<Reply, ReviewError>;
    async fn reapply_turn_changes(&self, session_id: &str, checkpoint_id: &str, file: Option<&str>, revision: f64) -> Result<Reply, ReviewError>;
    async fn clear_change_history(&self, session_id: &str) -> Result<Reply, ReviewError>;
}
