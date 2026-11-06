//! `goal-mutations.mjs`: the durable Goal transitions: create, the model/user status update
//! (complete / blocked) and abandon. Each runs inside a mutation and commits through it.

use serde_json::Value;

use super::error::{GoalError, GoalResult};
use super::js::{Goal, clean, put, put_num, string, truthy};
use super::runtime::Tx;
use super::state::{
    NO_DEADLINE_WARNING_MS, assert_session_id, checkpoint_active_clock, clean_for_string, clear_turn_failures, parse_goal_duration,
    public_goal, stop_active_clock, validate_goal_blocker, validate_objective,
};
use super::session_title::compact_session_title;
use super::storage::{history_path, write_history};

/// A complete or stopped Goal: retired work a successor may replace.
pub fn goal_finished(goal: &Goal) -> bool {
    ["complete", "stopped"].contains(&string(goal, "status").as_str())
}

/// Neither running nor finished (paused, blocked, usage limited, time budget reached): it waits
/// for the user, who may clear or replace it.
pub fn goal_stalled(goal: Option<&Goal>) -> bool {
    goal.is_some_and(|g| string(g, "status") != "active" && !goal_finished(g))
}

/// Rejects a write aimed at a Goal the caller no longer holds.
pub fn assert_expected_goal(goal: &Goal, expected: &str, what: &str) -> GoalResult<()> {
    let expected = clean(Some(&Value::String(expected.to_owned())));
    if !expected.is_empty() && expected != clean(goal.get("id")) {
        return Err(GoalError::new(format!("stale Goal {what} rejected because the active Goal changed")));
    }
    Ok(())
}

/// What a create asks for (`createGoal(id, args)`).
#[derive(Default)]
pub struct CreateArgs {
    pub objective: Option<Value>,
    pub duration: Option<Value>,
    pub time_limit_ms: Option<Value>,
    pub replace: bool,
    pub start_in_current_turn: bool,
}

impl Tx<'_> {
    fn initial_time_limit_ms(&self, args: &CreateArgs) -> GoalResult<f64> {
        if let Some(limit) = args.time_limit_ms.as_ref().filter(|v| !v.is_null()) {
            return parse_goal_duration(limit);
        }
        if let Some(duration) = args.duration.as_ref().filter(|v| truthy(Some(v))) {
            return parse_goal_duration(duration);
        }
        let configured = self.inner.default_time_limit_ms;
        if configured.is_finite() && configured > 0.0 {
            parse_goal_duration(&mixdog_js::json_number(configured))
        } else {
            Ok(0.0)
        }
    }

    fn new_goal_record(&self, args: &CreateArgs, at: f64) -> GoalResult<Goal> {
        let start_turn = if args.start_in_current_turn { 1.0 } else { 0.0 };
        let time_limit = self.initial_time_limit_ms(args)?;
        let mut goal = Goal::new();
        put(&mut goal, "id", uuid::Uuid::new_v4().to_string());
        put(&mut goal, "sessionId", self.id);
        put(&mut goal, "objective", validate_objective(args.objective.as_ref())?);
        put(&mut goal, "title", compact_session_title(&clean_for_string(args.objective.as_ref())));
        put_num(&mut goal, "objectiveRevision", 0.0);
        put(&mut goal, "status", "active");
        put(&mut goal, "blocker", "");
        put(&mut goal, "failureReason", "");
        put_num(&mut goal, "failureCount", 0.0);
        put_num(&mut goal, "turnCount", start_turn);
        put_num(&mut goal, "timeLimitMs", time_limit);
        put_num(&mut goal, "timeUsedMs", 0.0);
        put_num(&mut goal, "deadlineWarnedMs", NO_DEADLINE_WARNING_MS);
        put_num(&mut goal, "warningRevision", 0.0);
        put_num(&mut goal, "createdAt", at);
        put_num(&mut goal, "updatedAt", at);
        put_num(&mut goal, "lastStartedAt", at);
        put(&mut goal, "completedAt", Value::Null);
        put(&mut goal, "archivedAt", Value::Null);
        Ok(goal)
    }

    /// The Goal owning the current turn keeps its open segment; any other stops.
    fn settle_active_clock(&self, goal: &mut Goal, at: f64) {
        let owns = self.slot.mem().turn_goal_id.as_deref() == Some(clean(goal.get("id")).as_str());
        if owns { checkpoint_active_clock(goal, at) } else { stop_active_clock(goal, at) }
    }

    /// A finished Goal moves to the session's history before its successor takes the live slot.
    fn archive_finished_goal(&self, goal: &Goal) -> GoalResult<()> {
        let path = history_path(&self.inner.root, self.id, &clean(goal.get("id")))?;
        write_history(self.lane, &path, goal)
    }

    pub fn create_goal(&mut self, args: CreateArgs) -> GoalResult<Option<Goal>> {
        let id = assert_session_id(self.id)?;
        let mut record = self.read_record()?;
        let replaced = goal_stalled(record.as_ref()) && args.replace;
        if let Some(existing) = record.as_ref().filter(|g| !goal_finished(g) && !replaced) {
            return Err(GoalError::new(format!(
                "cannot create a new Goal while an unfinished Goal exists (status {}); finish it, or ask the user to stop it from the Goal controls",
                string(existing, "status")
            )));
        }
        let at = self.now();
        let mut goal = self.new_goal_record(&args, at)?;
        if args.start_in_current_turn {
            let started = if record.is_some() { at } else { self.slot.mem().turn_started_at.filter(|t| *t != 0.0).unwrap_or(at) };
            put_num(&mut goal, "lastStartedAt", started);
        }
        if replaced {
            if let Some(old) = record.as_mut() {
                put(old, "status", "stopped");
                put_num(old, "stoppedAt", at);
                put_num(old, "archivedAt", at);
                put_num(old, "updatedAt", at);
            }
        }
        if let Some(old) = &record {
            self.archive_finished_goal(old)?;
        }
        let created = self.commit(Some(goal.clone()), None)?;
        if args.start_in_current_turn {
            let mut mem = self.slot.mem();
            mem.turn_goal_id = Some(clean(goal.get("id")));
            mem.turn_started_at = Some(super::js::number(&goal, "lastStartedAt"));
            mem.turn_objective_revision = Some(super::js::number(&goal, "objectiveRevision"));
        }
        self.schedule_title(&goal);
        let _ = id;
        Ok(created)
    }

    /// The model's / user's status update: `complete`, or `blocked` with its blocker.
    pub fn update_goal(&mut self, status: &str, blocker: Option<&Value>, expected_goal_id: &str) -> GoalResult<Option<Goal>> {
        let mut goal = self.require_goal()?;
        assert_expected_goal(&goal, expected_goal_id, "update")?;
        let at = self.now();
        let status = clean(Some(&Value::String(status.to_owned()))).to_lowercase();
        if string(&goal, "status") == "stopped" {
            return Err(GoalError::new("a stopped Goal cannot resume or complete; create a new Goal"));
        }
        if status.is_empty() {
            return Err(GoalError::new("goal status is required"));
        }
        if !["complete", "blocked"].contains(&status.as_str()) {
            return Err(GoalError::new("goal can only set status complete or blocked"));
        }
        if string(&goal, "status") == "complete" {
            if status == "complete" {
                return Ok(public_goal(Some(&goal), at));
            }
            return Err(GoalError::new("a completed Goal cannot change status; edit it or create a new Goal"));
        }
        if status == "complete" {
            self.settle_active_clock(&mut goal, at);
            put(&mut goal, "status", "complete");
            put_num(&mut goal, "completedAt", at);
            put(&mut goal, "blocker", "");
            clear_turn_failures(&mut goal);
        } else {
            let blocker = validate_goal_blocker(blocker)?;
            self.settle_active_clock(&mut goal, at);
            put(&mut goal, "status", "blocked");
            put(&mut goal, "blocker", blocker);
            clear_turn_failures(&mut goal);
        }
        put_num(&mut goal, "updatedAt", at);
        self.commit(Some(goal), None)
    }

    /// Explicit retirement of a superseded Goal.
    pub fn abandon_goal(&mut self, expected_goal_id: &str, archive: bool) -> GoalResult<Option<Goal>> {
        let mut goal = self.require_goal()?;
        assert_expected_goal(&goal, expected_goal_id, "abandon")?;
        let at = self.now();
        stop_active_clock(&mut goal, at);
        put(&mut goal, "status", "stopped");
        put_num(&mut goal, "stoppedAt", at);
        put_num(&mut goal, "updatedAt", at);
        put(&mut goal, "blocker", "");
        if archive {
            put_num(&mut goal, "archivedAt", at);
        }
        self.commit(Some(goal.clone()), None)?;
        {
            let mut mem = self.slot.mem();
            mem.turn_goal_id = None;
            mem.turn_objective_revision = None;
        }
        Ok(public_goal(Some(&goal), self.now()))
    }
}
