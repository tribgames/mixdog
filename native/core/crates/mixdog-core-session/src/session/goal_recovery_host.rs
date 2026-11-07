//! The production [`RecoverySource`] of Goal recovery after a daemon replacement
//! (`session-calls/goal-recovery.mjs` `createGoalRecovery`): the stored Goals are read as a reader
//! without a runtime sees them, and a session whose Goal is still active is materialized
//! (`materializeSession`) under daemon ownership, as an admitted turn start.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_goal::goal::error::GoalError;
use mixdog_core_goal::goal::error::GoalResult;
use mixdog_core_goal::goal::js::Goal;
use mixdog_core_goal::goal::recovery::RecoverySource;
use mixdog_core_goal::goal::recovery::StoredGoals;

use super::SessionDirectory;
use super::quota_lane::failure_text;

pub struct SessionGoalRecovery {
    directory: Arc<SessionDirectory>,
    stored: StoredGoals,
    log: Arc<dyn Fn(&str) + Send + Sync>,
}

impl SessionGoalRecovery {
    /// `log` is the daemon's line log (Node's `log`).
    pub fn new(directory: Arc<SessionDirectory>, stored: StoredGoals, log: Arc<dyn Fn(&str) + Send + Sync>) -> Self {
        Self { directory, stored, log }
    }
}

#[async_trait]
impl RecoverySource for SessionGoalRecovery {
    async fn list_active_session_ids(&self) -> GoalResult<Vec<String>> {
        self.stored.list_active_session_ids().await
    }

    async fn read_stored_goal(&self, session_id: &str) -> GoalResult<Option<Goal>> {
        self.stored.read_snapshot(session_id).await
    }

    /// `materializeSession(sessionId)`: a thread an idle delete holds is `threadClosing`, which
    /// Node's `SessionClosedError` is.
    async fn materialize_session(&self, session_id: &str) -> GoalResult<()> {
        let ctx = CallContext::internal("goal-recovery");
        self.directory
            .open_admitted(&ThreadId::from(session_id), &ctx)
            .await
            .map(drop)
            .map_err(|error| GoalError::new(failure_text(&error)))
    }

    fn log(&self, line: &str) {
        (self.log)(line);
    }
}