//! The Goal half of a quota resume (`tui/session/quota-resume.mjs`): a quota failure suspends
//! the Goal that was running, the queue (`mixdog_core_base::quota_resume`) remembers which Goal, and the
//! resume revives exactly that one.

use std::sync::Arc;

use super::error::GoalResult;
use super::js::{Goal, string};
use super::runtime::{Admission, GoalRuntime};
use mixdog_core_base::quota_resume::QuotaError;
use mixdog_core_base::quota_resume::QuotaResumeStore;

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
    goals: Arc<GoalRuntime>,
}

impl GoalQuotaResume {
    pub fn new(store: Arc<QuotaResumeStore>, goals: Arc<GoalRuntime>) -> Self {
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
        self.note_goal(session_id, turn_key, &suspended_goal_id(before, settled)).await
    }

    /// `noteQuotaSuspendedGoal` for a Goal id already decided (empty records nothing).
    pub async fn note_goal(&self, session_id: &str, turn_key: &str, goal_id: &str) -> Result<bool, QuotaError> {
        if goal_id.is_empty() {
            return Ok(false);
        }
        self.store.note_suspended_goal(session_id, turn_key, goal_id).await
    }

    /// `cancelQuotaResume`'s store half: the pending resume goes, the Goal note stays.
    pub async fn cancel_entry(&self, session_id: &str) -> Result<bool, QuotaError> {
        self.store.cancel(session_id, None).await
    }

    /// `scheduleQuotaResumeEntry`.
    pub async fn schedule(&self, request: &serde_json::Value) -> Result<mixdog_core_base::quota_resume::Entry, QuotaError> {
        self.store.schedule(request).await
    }

    /// `quotaResumeEntry(sessionId)?.generation`: the queued resume's generation, if one waits.
    pub fn entry_generation(&self, session_id: &str) -> Option<u64> {
        self.store.entry(session_id).map(|entry| entry.generation)
    }

    /// `quotaSuspendedGoal`.
    pub fn suspended(&self, session_id: &str, turn_key: &str) -> String {
        self.store.suspended_goal(session_id, turn_key)
    }

    /// `resumeGoal`'s runtime half: revives the suspended Goal under the caller's admission.
    pub async fn resume(&self, session_id: &str, goal_id: &str, admission: Admission) -> GoalResult<Option<Goal>> {
        self.goals.reactivate_usage_limited(session_id, goal_id, admission).await
    }

    /// A superseding user cancel (`quota-resume.mjs:131`): the pending resume goes and so does
    /// the note of the Goal it would have revived.
    pub async fn cancel(&self, session_id: &str) -> Result<(), QuotaError> {
        self.store.cancel(session_id, None).await?;
        self.store.forget_suspended_goal(session_id).await?;
        Ok(())
    }

    /// `finishResume`: the entry the resume fired from (when there is one) is cancelled at its
    /// generation, then the note is dropped if it still names the same Goal.
    pub async fn finish_resume(
        &self,
        session_id: &str,
        turn_key: &str,
        goal_id: &str,
        entry_generation: Option<u64>,
    ) -> Result<bool, QuotaError> {
        if entry_generation.is_some() {
            self.store.cancel(session_id, entry_generation).await?;
        }
        if !goal_id.is_empty() && self.store.suspended_goal(session_id, turn_key) == goal_id {
            return self.store.forget_suspended_goal(session_id).await;
        }
        Ok(false)
    }
}
