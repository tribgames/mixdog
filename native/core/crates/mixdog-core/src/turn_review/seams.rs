//! The other owners' seam traits, implemented over the one component: office and tidy writes
//! (`mixdog-tools` [`ReviewRecorder`]) and worker turns (`mixdog-agent` [`TurnReviews`]).

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::agent_tool::flow::seams::ReviewHandle;
use mixdog_agent::agent_tool::flow::seams::TurnReviews;
use mixdog_core_api::turn_review::AgentReview;
use mixdog_core_api::turn_review::CallChange;
use mixdog_core_api::turn_review::ReviewContent;
use mixdog_core_api::turn_review::TurnReviewApi;
use mixdog_protocol::ThreadId;
use mixdog_protocol::ToolCallId;
use mixdog_tools::orch::office_writes::ReviewChange;
use mixdog_tools::orch::office_writes::ReviewRecorder;
use mixdog_tools::orch::office_writes::ReviewSide;

/// The `basePath` Node passes a recording tool: the session's cwd (`context.cwd`).
pub trait ThreadCwd: Send + Sync {
    fn cwd(&self, thread: &ThreadId) -> String;
}

fn content(side: ReviewSide) -> ReviewContent {
    match side {
        ReviewSide::Absent => ReviewContent::Absent,
        ReviewSide::Bytes(bytes) => ReviewContent::bytes(bytes),
        ReviewSide::Omitted { size, reason } => ReviewContent::Omitted { size, reason },
    }
}

/// `recordToolFileChanges({ sessionId, basePath: cwd, changes })` for office and tidy writes.
pub struct ToolReviewRecorder {
    review: Arc<dyn TurnReviewApi>,
    cwd: Arc<dyn ThreadCwd>,
}

impl ToolReviewRecorder {
    pub fn new(review: Arc<dyn TurnReviewApi>, cwd: Arc<dyn ThreadCwd>) -> Self {
        Self { review, cwd }
    }
}

#[async_trait]
impl ReviewRecorder for ToolReviewRecorder {
    async fn record(&self, thread: &ThreadId, _call: &ToolCallId, changes: Vec<ReviewChange>) {
        let changes = changes
            .into_iter()
            .map(|c| CallChange { path: c.path, new_path: None, before: content(c.before), after: content(c.after) })
            .collect();
        self.review.record_tool_changes(thread.as_str(), &self.cwd.cwd(thread), changes).await;
    }
}

/// `beginAgentTurnReview(owner, child, { agent, tag })` for a spawn or send turn.
pub struct AgentTurnReviews {
    review: Arc<dyn TurnReviewApi>,
}

impl AgentTurnReviews {
    pub fn new(review: Arc<dyn TurnReviewApi>) -> Self {
        Self { review }
    }
}

struct Handle(Option<Box<dyn AgentReview>>);

impl ReviewHandle for Handle {
    fn complete(&self, patches: Vec<String>) {
        if let Some(review) = &self.0 {
            review.complete(patches);
        }
    }
}

impl TurnReviews for AgentTurnReviews {
    fn begin(&self, owner_session_id: &str, session_id: &str, tag: &str, agent: &str) -> Box<dyn ReviewHandle> {
        Box::new(Handle(self.review.begin_agent_review(owner_session_id, session_id, agent, tag)))
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::turn_review::ReviewRead;
    use mixdog_core_api::turn_review::TurnOpen;

    use super::*;

    struct Cwd(String);

    impl ThreadCwd for Cwd {
        fn cwd(&self, _thread: &ThreadId) -> String {
            self.0.clone()
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    #[allow(clippy::disallowed_methods, reason = "test setup")]
    async fn office_writes_and_worker_turns_land_in_the_threads_review() {
        let dir = tempfile::tempdir().unwrap();
        let ws = super::super::tests::plain(&dir.path().canonicalize().unwrap());
        let review: Arc<dyn TurnReviewApi> = Arc::new(super::super::tests::review_at(&dir.path().join("data")));
        let owner_turn = review.begin_turn(&ws, "lead", TurnOpen { checkpoint_id: "cp1".into(), continue_turn: false }).await;
        assert!(owner_turn.is_some());

        let recorder = ToolReviewRecorder::new(review.clone(), Arc::new(Cwd(ws.clone())));
        let path = format!("{ws}/a.docx");
        let change = ReviewChange { path: path.clone(), before: ReviewSide::Absent, after: ReviewSide::Bytes(b"new\n".to_vec()) };
        recorder.record(&ThreadId::from("lead"), &ToolCallId::from("c1"), vec![change]).await;
        let reply = review.turn_review_diff(&ws, "lead", ReviewRead::default()).await;
        let files = reply["files"].as_array().unwrap();
        assert_eq!((files[0]["path"].as_str(), files[0]["status"].as_str()), (Some("a.docx"), Some("A")));

        let handle = AgentTurnReviews::new(review.clone()).begin("lead", "worker-1", "task", "worker");
        let worker_change = ReviewChange { path: format!("{ws}/w.docx"), before: ReviewSide::Absent, after: ReviewSide::Bytes(b"w\n".to_vec()) };
        recorder.record(&ThreadId::from("worker-1"), &ToolCallId::from("c2"), vec![worker_change]).await;
        handle.complete(Vec::new());
        let reply = review.turn_review_diff(&ws, "lead", ReviewRead::default()).await;
        assert_eq!(reply["agents"].as_array().unwrap().len(), 1);
    }
}