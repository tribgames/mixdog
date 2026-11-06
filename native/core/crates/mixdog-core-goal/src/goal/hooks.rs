//! What the session layer calls on the Goal runtime (`goal-facade-api.mjs`): the turn start and
//! settle, the continuation decision, the user's controls and the status view. The runtime
//! implements all three; the session actor holds them as trait objects.

use async_trait::async_trait;
use mixdog_protocol::ThreadId;
use serde_json::Value;

use super::error::GoalResult;
use super::js::Goal;
use super::runtime::{Admission, GoalEvent, GoalRuntime, Subscription};
use super::turns::{Continuation, ContinuationInput};

/// `goalTurnStarted`, `goalTurnSettled`, `archiveCompletedGoalOnUserInput` and
/// `reactivateUsageLimitedGoal`.
#[async_trait]
pub trait GoalTurnHooks: Send + Sync {
    /// A turn starts on the thread: it takes the Goal's open clock segment.
    async fn turn_started(&self, thread: &ThreadId) -> GoalResult<Option<Goal>>;
    /// The turn settled; `detail` is `{ status, error?, usageLimited?, automatic?, toolCalls?,
    /// preserveGoalState? }` (a bare status string is accepted).
    async fn turn_settled(&self, thread: &ThreadId, detail: Value) -> GoalResult<Option<Goal>>;
    /// A genuine user prompt retires a finished Goal.
    async fn archive_completed_on_user_input(&self, thread: &ThreadId) -> GoalResult<Option<Goal>>;
    /// A quota resume revives the Goal its failure suspended.
    async fn reactivate_usage_limited(&self, thread: &ThreadId, goal_id: &str, admission: Admission) -> GoalResult<Option<Goal>>;
}

/// `goalContinuation` and the reset `markGoalReminder` makes.
#[async_trait]
pub trait GoalContinuationHooks: Send + Sync {
    /// Whether the idle thread continues its Goal now, and with which prompt (injected as a
    /// meta user message by the session).
    async fn continuation(&self, thread: &ThreadId, input: ContinuationInput) -> GoalResult<Continuation>;
    /// Compaction, an objective change or a paused-state notice: the next continuation carries
    /// the full rules again.
    fn reset_continuation_rules(&self, thread: &ThreadId) -> GoalResult<()>;
}

/// `goalStatus`, `goalControl` and `onGoalStatusChange`.
#[async_trait]
pub trait GoalViewHooks: Send + Sync {
    /// The visible Goal (arming its deadline).
    async fn goal_status(&self, thread: &ThreadId) -> GoalResult<Option<Goal>>;
    /// The user's control request (`/goal …` string or request object); the answer is Node's
    /// `{ ok, action, goal, message }`.
    async fn goal_control(&self, thread: &ThreadId, request: Value) -> GoalResult<Value>;
    fn on_goal_change(&self, listener: Box<dyn Fn(&GoalEvent) + Send + Sync>) -> Subscription;
}

#[async_trait]
impl GoalTurnHooks for GoalRuntime {
    async fn turn_started(&self, thread: &ThreadId) -> GoalResult<Option<Goal>> {
        self.start_turn(thread.as_str()).await
    }
    async fn turn_settled(&self, thread: &ThreadId, detail: Value) -> GoalResult<Option<Goal>> {
        self.settle_turn(thread.as_str(), detail).await
    }
    async fn archive_completed_on_user_input(&self, thread: &ThreadId) -> GoalResult<Option<Goal>> {
        GoalRuntime::archive_completed_on_user_input(self, thread.as_str()).await
    }
    async fn reactivate_usage_limited(&self, thread: &ThreadId, goal_id: &str, admission: Admission) -> GoalResult<Option<Goal>> {
        GoalRuntime::reactivate_usage_limited(self, thread.as_str(), goal_id, admission).await
    }
}

#[async_trait]
impl GoalContinuationHooks for GoalRuntime {
    async fn continuation(&self, thread: &ThreadId, input: ContinuationInput) -> GoalResult<Continuation> {
        GoalRuntime::continuation(self, thread.as_str(), input).await
    }
    fn reset_continuation_rules(&self, thread: &ThreadId) -> GoalResult<()> {
        GoalRuntime::reset_continuation_rules(self, thread.as_str())
    }
}

#[async_trait]
impl GoalViewHooks for GoalRuntime {
    async fn goal_status(&self, thread: &ThreadId) -> GoalResult<Option<Goal>> {
        self.snapshot(thread.as_str()).await
    }
    async fn goal_control(&self, thread: &ThreadId, request: Value) -> GoalResult<Value> {
        self.control(thread.as_str(), request).await
    }
    fn on_goal_change(&self, listener: Box<dyn Fn(&GoalEvent) + Send + Sync>) -> Subscription {
        self.subscribe(move |event| listener(event))
    }
}
