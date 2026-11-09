//! [`TurnReviewApi`] over the component.

use async_trait::async_trait;
use mixdog_core_api::turn_review::AgentReview;
use mixdog_core_api::turn_review::CallChange;
use mixdog_core_api::turn_review::ChangesRead;
use mixdog_core_api::turn_review::Reply;
use mixdog_core_api::turn_review::ReviewError;
use mixdog_core_api::turn_review::ReviewRead;
use mixdog_core_api::turn_review::TurnOpen;
use mixdog_core_api::turn_review::TurnReviewApi;
use mixdog_core_api::turn_review::TurnToken;

use super::service::OwnedAgentReview;
use super::service::TurnReview;

#[async_trait]
impl TurnReviewApi for TurnReview {
    async fn record_call(&self, call_id: &str, session_id: &str, base_path: &str, changes: Vec<CallChange>) {
        if call_id.is_empty() || session_id.is_empty() {
            return;
        }
        let inner = self.inner.clone();
        let (call_id, session_id, base_path) = (call_id.to_owned(), session_id.to_owned(), base_path.to_owned());
        // Best-effort display channel: a failure never reaches the call.
        let _ = self.inner.on_cpu(move || inner.record_call_changes(&call_id, &session_id, &base_path, changes)).await;
    }

    async fn record_tool_changes(&self, session_id: &str, base_path: &str, changes: Vec<CallChange>) {
        if session_id.is_empty() || changes.is_empty() {
            return;
        }
        let inner = self.inner.clone();
        let (session_id, base_path) = (session_id.to_owned(), base_path.to_owned());
        // Best-effort review channel.
        let _ = self.inner.on_cpu(move || inner.record_tool_file_changes(&session_id, &base_path, changes)).await;
    }

    fn take_call_diff(&self, call_id: &str) -> Option<String> {
        self.inner.cards.take(call_id)
    }

    fn note_change(&self, paths: Option<&[String]>) {
        self.inner.worktrees.note_change(paths);
    }

    async fn begin_turn(&self, worktree: &str, session_id: &str, open: TurnOpen) -> Option<TurnToken> {
        self.inner.begin_turn(worktree, session_id, open).await
    }

    async fn complete_turn(&self, session_id: &str, expected: Option<&TurnToken>) -> bool {
        self.inner.complete_turn(session_id, expected).await
    }

    fn begin_agent_review(&self, owner_session_id: &str, child_session_id: &str, agent: &str, tag: &str) -> Option<Box<dyn AgentReview>> {
        let handle = self.inner.begin_agent_review(owner_session_id, child_session_id, agent, tag)?;
        Some(Box::new(OwnedAgentReview { inner: self.inner.clone(), handle }))
    }

    fn forget_session(&self, session_id: &str) {
        self.inner.forget_session(session_id);
        // Where its reviews started goes with the thread.
        self.inner.bases.forget(&mixdog_protocol::ThreadId::from(session_id));
        // The session's own deletion takes the marker, and its stored first-seen file contents,
        // with it.
        let (inner, id) = (self.inner.clone(), session_id.to_owned());
        let removal = mixdog_rt::spawn("turn_review.forget_session", mixdog_rt::TaskClass::Work, async move {
            inner.store.forget_session_change_history_marker(&id).await;
            inner.baselines.forget(&id).await;
        });
        let mut forgets = self.inner.forgets.lock().unwrap_or_else(|e| e.into_inner());
        forgets.retain(|task| !task.is_finished());
        forgets.push(removal);
    }

    async fn turn_review_diff(&self, _worktree: &str, session_id: &str, read: ReviewRead) -> Reply {
        self.inner.turn_review_reply(session_id, &read).await
    }

    async fn session_review_diff(&self, worktree: &str, session_id: &str) -> Reply {
        self.inner.session_review_diff(worktree, session_id).await
    }

    async fn session_review_file_patch(&self, worktree: &str, session_id: &str, file: &str, old_path: &str) -> Reply {
        self.inner.session_review_file_patch(worktree, session_id, file, old_path).await
    }

    async fn turn_review_file_patch(&self, _worktree: &str, session_id: &str, file: &str) -> Reply {
        self.inner.turn_review_file_patch(session_id, file).await
    }

    async fn revert_turn_review(&self, worktree: &str, session_id: &str, checkpoint_id: &str) -> Result<Reply, ReviewError> {
        self.inner.revert_latest_turn(worktree, session_id, None, checkpoint_id).await
    }

    async fn revert_turn_review_file(&self, worktree: &str, session_id: &str, file: &str, checkpoint_id: &str) -> Result<Reply, ReviewError> {
        if super::patch::clean(file).is_empty() {
            return Err(ReviewError::type_error("turn review file path is required"));
        }
        self.inner.revert_latest_turn(worktree, session_id, Some(file), checkpoint_id).await
    }

    async fn turn_changes(&self, session_id: &str, read: ChangesRead) -> Result<Reply, ReviewError> {
        self.inner.turn_changes(session_id, &read).await
    }

    async fn revert_turn_changes(&self, session_id: &str, checkpoint_id: &str, file: Option<&str>, revision: f64) -> Result<Reply, ReviewError> {
        self.inner.mutate_turn_changes(session_id, checkpoint_id, file, revision, true).await
    }

    async fn reapply_turn_changes(&self, session_id: &str, checkpoint_id: &str, file: Option<&str>, revision: f64) -> Result<Reply, ReviewError> {
        self.inner.mutate_turn_changes(session_id, checkpoint_id, file, revision, false).await
    }

    async fn clear_change_history(&self, session_id: &str) -> Result<Reply, ReviewError> {
        self.inner.clear_session_change_history(session_id).await
    }
}
