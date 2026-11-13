//! `session-calls/goal-recovery.mjs`: resuming the sessions that carry an active Goal after
//! daemon replacement: discovering the stored session ids, re-checking that each Goal is still
//! active, and materializing the survivors under daemon ownership. Reported as a count summary;
//! a session that fails to resume never stops the others.

use async_trait::async_trait;
use mixdog_rt::{CancellationToken, DurabilityIo, LaneToken};

use super::error::{GoalError, GoalResult};
use super::js::{Goal, string};
use super::state::{DEFAULT_COMPLETED_GOAL_TTL_MS, is_session_id};
use super::storage;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct RecoverySummary {
    pub found: usize,
    pub resumed: usize,
    pub skipped: usize,
    pub failed: usize,
}

/// What recovery reads and does: the stored Goals, and the session layer's `materializeSession`.
#[async_trait]
pub trait RecoverySource: Send + Sync {
    async fn list_active_session_ids(&self) -> GoalResult<Vec<String>>;
    async fn read_stored_goal(&self, session_id: &str) -> GoalResult<Option<Goal>>;
    /// Loads the session under daemon ownership (WP-SESSION).
    async fn materialize_session(&self, session_id: &str) -> GoalResult<()>;
    fn log(&self, line: &str);
}

/// `recoverActiveGoals`.
pub async fn recover_active_goals(source: &dyn RecoverySource) -> RecoverySummary {
    let listed = match source.list_active_session_ids().await {
        Ok(listed) => listed,
        Err(error) => {
            source.log(&format!("active Goal discovery failed: {}", error.message));
            return RecoverySummary { failed: 1, ..RecoverySummary::default() };
        }
    };
    let mut ids: Vec<String> = Vec::new();
    for id in listed {
        if is_session_id(&id) && !ids.contains(&id) {
            ids.push(id);
        }
    }
    let mut summary = RecoverySummary { found: ids.len(), ..RecoverySummary::default() };
    for id in &ids {
        let outcome = async {
            let goal = source.read_stored_goal(id).await?;
            if goal.as_ref().map(|g| string(g, "status")).as_deref() != Some("active") {
                return Ok(false);
            }
            source.materialize_session(id).await?;
            Ok::<bool, GoalError>(true)
        }
        .await;
        match outcome {
            Ok(true) => summary.resumed += 1,
            Ok(false) => summary.skipped += 1,
            Err(error) => {
                summary.failed += 1;
                source.log(&format!("active Goal recovery failed session={id}: {}", error.message));
            }
        }
        // One session per turn of the scheduler: a restart with many active Goals resumes them in a
        // paced sequence, never as one uninterrupted run that holds the task's thread.
        tokio::task::yield_now().await;
    }
    summary
}

/// The stored Goals of a data dir, read the way a reader without a runtime sees them.
pub struct StoredGoals {
    pub data_dir: String,
    pub lane: DurabilityIo,
    pub completed_ttl_ms: f64,
    pub now: std::sync::Arc<dyn Fn() -> f64 + Send + Sync>,
}

impl StoredGoals {
    pub fn new(data_dir: impl Into<String>, lane: DurabilityIo) -> Self {
        Self { data_dir: data_dir.into(), lane, completed_ttl_ms: DEFAULT_COMPLETED_GOAL_TTL_MS, now: std::sync::Arc::new(super::js::now_wall_ms) }
    }

    /// `listStoredActiveGoalSessionIds`.
    pub async fn list_active_session_ids(&self) -> GoalResult<Vec<String>> {
        let (data_dir, ttl, at) = (self.data_dir.clone(), self.completed_ttl_ms, (self.now)());
        self.lane
            .submit(&CancellationToken::new(), move |lane| storage::list_active_session_ids(lane, &data_dir, at, ttl))
            .map_err(|_| GoalError::new("goal storage is busy"))?
            .await
            .map_err(|_| GoalError::new("goal storage stopped"))
    }

    /// `readStoredGoalSnapshot`.
    pub async fn read_snapshot(&self, session_id: &str) -> GoalResult<Option<Goal>> {
        let (data_dir, ttl, at, id) = (self.data_dir.clone(), self.completed_ttl_ms, (self.now)(), session_id.to_owned());
        self.lane
            .submit(&CancellationToken::new(), move |lane| storage::read_stored_goal_snapshot(lane, &data_dir, &id, at, ttl))
            .map_err(|_| GoalError::new("goal storage is busy"))?
            .await
            .map_err(|_| GoalError::new("goal storage stopped"))
    }
}
