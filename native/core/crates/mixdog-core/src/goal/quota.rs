//! The Goal half of a quota resume (`tui/session/quota-resume.mjs`): a quota failure suspends
//! the Goal that was running, the queue (`crate::quota_resume`) remembers which Goal, and the
//! resume revives exactly that one.

use std::sync::Arc;

use super::error::GoalResult;
use super::js::{Goal, string};
use super::runtime::{Admission, GoalRuntime};
use crate::quota_resume::{QuotaError, QuotaResumeStore};

/// The id of the Goal a quota failure moved from active to usage_limited, or empty: it must
/// have been active before the turn, usage_limited after it, and the same Goal.
pub fn suspended_goal_id(before: Option<&Goal>, settled: Option<&Goal>) -> String {
    match (before, settled) {
        (Some(before), Some(settled))
            if string(before, "status") == "active"
                && string(settled, "status") == "usage_limited"
                && string(settled, "id") == string(before, "id") =>
        {
            string(settled, "id")
        }
        _ => String::new(),
    }
}

#[derive(Clone)]
pub struct GoalQuotaResume {
    store: Arc<QuotaResumeStore>,
    goals: GoalRuntime,
}

impl GoalQuotaResume {
    pub fn new(store: Arc<QuotaResumeStore>, goals: GoalRuntime) -> Self {
        Self { store, goals }
    }

    /// `finishQuotaSettlement`: records the Goal the failure `turn_key` suspended (nothing when
    /// none was).
    pub async fn note_suspension(
        &self,
        session_id: &str,
        turn_key: &str,
        before: Option<&Goal>,
        settled: Option<&Goal>,
    ) -> Result<bool, QuotaError> {
        let goal_id = suspended_goal_id(before, settled);
        if goal_id.is_empty() {
            return Ok(false);
        }
        self.store.note_suspended_goal(session_id, turn_key, &goal_id).await
    }

    /// `quotaSuspendedGoal`.
    pub fn suspended(&self, session_id: &str, turn_key: &str) -> String {
        self.store.suspended_goal(session_id, turn_key)
    }

    /// `resumeGoal`'s runtime half: revives the suspended Goal under the caller's admission.
    pub async fn resume(&self, session_id: &str, goal_id: &str, admission: Admission) -> GoalResult<Option<Goal>> {
        self.goals.reactivate_usage_limited(session_id, goal_id, admission).await
    }

    /// `finishResume`: the note is dropped once the resume is accepted, if it still names the
    /// same Goal.
    pub async fn finish_resume(&self, session_id: &str, turn_key: &str, goal_id: &str) -> Result<bool, QuotaError> {
        if !goal_id.is_empty() && self.store.suspended_goal(session_id, turn_key) == goal_id {
            return self.store.forget_suspended_goal(session_id).await;
        }
        Ok(false)
    }
}
