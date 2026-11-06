//! The session's Goal lane (`tui/session/goal-continuation.mjs` and its parts): the visible Goal
//! with the archive-in-flight mask (`goal-visibility.mjs`), the queued Goal continuation
//! (`continuation-queue.mjs`), and the turn outcome the Goal runtime settles on.

use serde_json::Value;
use serde_json::json;

use crate::goal::js::Goal;
use crate::goal::state::goal_state_snapshot;

/// What the session calls on the Goal runtime (`goal-facade-api.mjs`).
pub trait SessionGoals:
    crate::goal::hooks::GoalTurnHooks + crate::goal::hooks::GoalContinuationHooks + crate::goal::hooks::GoalViewHooks
{
}

impl<T> SessionGoals for T where
    T: crate::goal::hooks::GoalTurnHooks + crate::goal::hooks::GoalContinuationHooks + crate::goal::hooks::GoalViewHooks
{
}

/// The queue mode of an automatic Goal turn.
pub const CONTINUATION_MODE: &str = "goal-continuation";
const CLOSEOUT_MODE: &str = "goal-closeout";

/// `isGoalQueuedEntry`.
pub fn is_goal_entry(entry: &Value) -> bool {
    matches!(entry.get("mode").and_then(Value::as_str), Some(CONTINUATION_MODE | CLOSEOUT_MODE))
}

/// The statuses a user prompt retires (`ARCHIVED_STATUSES`).
fn archived(goal: &Goal) -> bool {
    matches!(goal.get("status").and_then(Value::as_str), Some("complete" | "stopped"))
}

fn id_of(goal: &Goal) -> String {
    crate::goal::js::clean(goal.get("id"))
}

/// `visibleGoal(goal)`: the lane's Goal, none while a retiring Goal's archive is in flight.
pub fn visible_goal(goal: Option<&Goal>, suppressed: &str) -> Option<Goal> {
    let goal = goal?;
    if archived(goal) && !suppressed.is_empty() && id_of(goal) == suppressed {
        return None;
    }
    Some(goal_state_snapshot(goal))
}

/// `archivedGoalId(goal)`: the id of a finished Goal a user prompt retires, or "".
pub fn archived_goal_id(goal: Option<&Value>) -> String {
    match goal.and_then(Value::as_object) {
        Some(goal) if archived(goal) => id_of(goal),
        _ => String::new(),
    }
}

/// The queued entry of the next continuation (`scheduleGoalContinuation`'s `enqueue`).
pub fn continuation_entry(prompt: &str, goal: Option<&Goal>, now: i64) -> Value {
    json!({
        "message": prompt,
        "mode": CONTINUATION_MODE,
        "priority": "later",
        "isMeta": true,
        "suppressDisplay": true,
        "skipSlashCommands": true,
        "restorable": false,
        "goalId": goal.map(id_of).unwrap_or_default(),
        "displayText": "",
        "enqueuedAt": now,
    })
}

/// The input row of an automatic Goal turn: runtime-synthetic, never the user speaking
/// (`ask-queue.mjs` `initialPromptSourceFor`).
pub fn input_row(entry: &Value) -> Value {
    let mode = entry.get("mode").and_then(Value::as_str).unwrap_or(CONTINUATION_MODE);
    json!({
        "role": "user",
        "content": entry.get("message").and_then(Value::as_str).unwrap_or_default(),
        "meta": { "source": mode, "synthetic": true },
    })
}

/// Whether a turn's input row is an automatic Goal turn (`promptSource === 'goal-continuation'`).
pub fn automatic(input_row: &Value) -> bool {
    input_row.pointer("/meta/source").and_then(Value::as_str) == Some(CONTINUATION_MODE)
}

/// `isUsageLimitError`: a spent quota, a plan-gated feature or a billing refusal, never a bare
/// 429 refusal.
pub fn usage_limited(error: &mixdog_protocol::TurnError) -> bool {
    if error.message.contains("API 429 request rejected") {
        return false;
    }
    error.provider_error.as_ref().is_some_and(|p| matches!(p.kind.as_str(), "quota_exhausted" | "entitlement" | "billing"))
}

/// `onGoalTurnSettled`'s detail. A daemon turn is never stale, reset, disposed or interrupted
/// for steering, so `preserveGoalState` is false.
pub fn settle_detail(status: &str, error: Option<&mixdog_protocol::TurnError>, automatic: bool, tool_calls: u64) -> Value {
    json!({
        "status": status,
        "error": error.map(|e| Value::String(e.message.clone())).unwrap_or(Value::Null),
        "usageLimited": error.is_some_and(usage_limited),
        "automatic": automatic,
        "toolCalls": tool_calls,
        "preserveGoalState": false,
    })
}
