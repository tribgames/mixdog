//! `goal-tool-exec.mjs`: the model-facing `goal` tool's runtime half (status, create and the
//! model's two settlements), as the [`GoalPort`] the tool front end calls.

use async_trait::async_trait;
use mixdog_protocol::ThreadId;
use mixdog_tools::orch::util::PortError;
use mixdog_tools::state::goal::{GoalPort, GoalSettlement, GoalSnapshot};
use serde_json::Value;

use super::error::{GoalError, GoalResult};
use super::js::{Goal, number, string};
use super::mutations::CreateArgs;
use super::runtime::GoalRuntime;
use super::state::assert_session_id;

fn port_error(error: GoalError) -> PortError {
    PortError::Failed { capability: "goal".into(), message: error.message }
}

/// `toolReply`'s input: the public Goal and `goal?.remainingMs ?? null`.
fn snapshot_of(goal: Option<Goal>) -> GoalSnapshot {
    let remaining_ms = goal
        .as_ref()
        .and_then(|g| g.get("remainingMs"))
        .and_then(Value::as_f64)
        .map(|ms| ms as u64);
    GoalSnapshot { goal: goal.map(Value::Object), remaining_ms }
}

impl GoalRuntime {
    pub async fn tool_status(&self, session_id: &str) -> GoalResult<Option<Goal>> {
        let id = assert_session_id(session_id)?;
        let slot = self.inner.slot(&id);
        // A real I/O error is an actionable error, not "no Goal".
        let record = self.inner.read_view(&slot, &id).await?;
        if let Some(record) = &record {
            let mut mem = slot.mem();
            if mem.turn_goal_id.as_deref() == Some(string(record, "id").as_str()) {
                mem.turn_objective_revision = Some(number(record, "objectiveRevision"));
            }
        }
        self.inner.visible_snapshot(&id).await
    }

    pub async fn tool_create(&self, session_id: &str, objective: String, time_limit_ms: Option<f64>) -> GoalResult<Option<Goal>> {
        self.inner
            .with_mutation(session_id, move |tx| {
                tx.create_goal(CreateArgs {
                    objective: Some(Value::String(objective)),
                    time_limit_ms: time_limit_ms.map(mixdog_js::json_number),
                    start_in_current_turn: true,
                    ..CreateArgs::default()
                })
            })
            .await
    }

    /// A settlement applies to the Goal this turn worked on: one replaced meanwhile is refused
    /// instead of settled by mistake.
    pub async fn tool_settle(&self, session_id: &str, action: &'static str, blocker: Option<String>) -> GoalResult<Option<Goal>> {
        let id = assert_session_id(session_id)?;
        let slot = self.inner.slot(&id);
        let turn_goal = slot.mem().turn_goal_id.clone().filter(|g| !g.is_empty());
        let expected = match turn_goal {
            Some(expected) => expected,
            None => {
                let record = self.inner.read_view(&slot, &id).await?;
                string(&record.ok_or_else(|| GoalError::new("no Goal exists for this session"))?, "id")
            }
        };
        self.inner
            .with_mutation(&id, move |tx| {
                let current = tx.require_goal()?;
                let seen = tx.slot.mem().turn_objective_revision;
                if string(&current, "id") == expected && seen.is_some_and(|seen| seen != number(&current, "objectiveRevision")) {
                    tx.slot.mem().turn_objective_revision = Some(number(&current, "objectiveRevision"));
                    return Err(GoalError::new(format!(
                        "The Goal objective changed since this turn began, so {action} was not recorded. Current objective: {}\nCheck the work against it, then call goal {action} again if it still holds.",
                        string(&current, "objective")
                    )));
                }
                let (status, blocker) = if action == "block" { ("blocked", blocker.map(Value::String)) } else { ("complete", None) };
                tx.update_goal(status, blocker.as_ref(), &expected)
            })
            .await
    }
}

#[async_trait]
impl GoalPort for GoalRuntime {
    async fn status(&self, thread: &ThreadId) -> Result<GoalSnapshot, PortError> {
        self.tool_status(thread.as_str()).await.map(snapshot_of).map_err(port_error)
    }

    async fn create(&self, thread: &ThreadId, objective: String, time_limit_ms: Option<u64>) -> Result<GoalSnapshot, PortError> {
        self.tool_create(thread.as_str(), objective, time_limit_ms.map(|ms| ms as f64)).await.map(snapshot_of).map_err(port_error)
    }

    async fn settle(&self, thread: &ThreadId, settlement: GoalSettlement) -> Result<GoalSnapshot, PortError> {
        let (action, blocker) = match settlement {
            GoalSettlement::Complete => ("complete", None),
            GoalSettlement::Block { blocker } => ("block", Some(blocker)),
        };
        self.tool_settle(thread.as_str(), action, blocker).await.map(snapshot_of).map_err(port_error)
    }
}
