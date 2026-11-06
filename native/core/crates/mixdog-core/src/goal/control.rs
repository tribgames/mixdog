//! `goal-control.mjs`: the user-facing Goal control surface (slash command / desktop chrome):
//! parses the request, applies the shared freshness checks and dispatches to one handler per
//! action.

use serde_json::{Map, Value, json};

use super::error::{GoalError, GoalResult};
use super::js::{Goal, clean, number, put, put_num, string, truthy};
use super::mutations::{CreateArgs, assert_expected_goal, goal_finished, goal_stalled};
use super::runtime::{GoalRuntime, Tx};
use super::session_title::compact_session_title;
use super::state::{
    NO_DEADLINE_WARNING_MS, activate_goal, assert_session_id, clear_turn_failures, parse_goal_duration, parse_user_command,
    public_goal, resume_goal_state, set_goal_time_limit, stop_active_clock, validate_objective,
};
use super::text::duration_label;

/// `code` of the create answer that asks the user to confirm replacing a stalled Goal.
pub const GOAL_REPLACE_REQUIRED: &str = "goal-replace-required";

fn goal_value(goal: Option<Goal>) -> Value {
    goal.map_or(Value::Null, Value::Object)
}

fn reply(action: &str, goal: Option<Goal>, message: String) -> Value {
    json!({ "ok": true, "action": action, "goal": goal_value(goal), "message": message })
}

/// "12m remaining" for a budgeted Goal, "3m elapsed" for an open-ended one.
fn timing_label(goal: &Goal) -> String {
    if number(goal, "timeLimitMs") > 0.0 {
        format!("{} remaining", duration_label(number(goal, "remainingMs")))
    } else {
        format!("{} elapsed", duration_label(number(goal, "timeUsedMs")))
    }
}

fn objective_of(goal: &Goal) -> String {
    string(goal, "objective")
}

fn arg<'a>(args: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    args.get(key)
}

/// The request as a map: a string is a `/goal` command; an object may carry a `command` whose
/// parse overrides its own fields.
fn request(raw: &Value) -> Map<String, Value> {
    match raw {
        Value::String(command) => parse_user_command(command),
        Value::Object(map) => {
            let mut args = map.clone();
            if let Some(command) = map.get("command").filter(|c| !c.is_null()) {
                for (key, value) in parse_user_command(&clean(Some(command))) {
                    args.insert(key, value);
                }
            }
            args
        }
        _ => Map::new(),
    }
}

impl Tx<'_> {
    /// `runGoalControl`.
    pub fn control(&mut self, raw: &Value) -> GoalResult<Value> {
        let id = assert_session_id(self.id)?;
        let args = request(raw);
        let action = {
            let given = arg(&args, "action").filter(|v| truthy(Some(v)));
            clean(Some(given.unwrap_or(&json!("get")))).to_lowercase()
        };
        if action == "create" {
            return self.control_create(&args, &id, &action);
        }
        if action == "get" || action == "status" {
            let goal = self.visible_snapshot();
            let message = match &goal {
                None => "No visible Goal for this session".to_owned(),
                Some(goal) => {
                    let timing = if string(goal, "status") == "active" { format!(" · {}", timing_label(goal)) } else { String::new() };
                    format!("Goal {} · {}{timing}", string(goal, "status"), objective_of(goal))
                }
            };
            return Ok(reply("get", goal, message));
        }
        if action == "clear" {
            self.commit(None, None)?;
            return Ok(reply(&action, None, "Goal cleared".into()));
        }
        let goal = self.require_goal()?;
        let expected = clean(arg(&args, "expectedGoalId"));
        assert_expected_goal(&goal, &expected, "update")?;
        let at = self.now();
        if string(&goal, "status") == "stopped" && action != "dismiss" {
            return Err(GoalError::new("a stopped Goal cannot be changed; create a new Goal"));
        }
        match action.as_str() {
            "stop" => {
                let goal = self.abandon_goal(&expected, true)?;
                let objective = goal.as_ref().map(objective_of).unwrap_or_default();
                Ok(reply(&action, goal, format!("Goal stopped · {objective}")))
            }
            "pause" => self.control_pause(goal, at, &action),
            "resume" => self.control_resume(goal, &args, at, &action),
            "edit" => self.control_edit(goal, &args, at, &action),
            "time" => self.control_time(goal, &args, at, &action),
            "complete" => {
                let goal = self.update_goal("complete", None, "")?;
                let goal = goal.unwrap_or_default();
                let message = format!("Goal complete · {} · {} elapsed", objective_of(&goal), duration_label(number(&goal, "timeUsedMs")));
                Ok(reply(&action, Some(goal), message))
            }
            "dismiss" => self.control_dismiss(goal, at, &action, &expected),
            other => Err(GoalError::new(format!("unknown Goal action: {other}"))),
        }
    }

    fn control_create(&mut self, args: &Map<String, Value>, id: &str, action: &str) -> GoalResult<Value> {
        let _ = id;
        let existing = self.read_record()?;
        let replace = arg(args, "replace") == Some(&json!(true));
        if goal_stalled(existing.as_ref()) && !replace {
            let existing = existing.expect("a stalled Goal exists");
            return Ok(json!({
                "ok": false,
                "action": action,
                "code": GOAL_REPLACE_REQUIRED,
                "goal": goal_value(public_goal(Some(&existing), self.now())),
                "message": format!(
                    "A {} Goal already exists · {}. Run /goal --replace={} followed by the new objective to replace it.",
                    string(&existing, "status"), objective_of(&existing), string(&existing, "id")
                ),
            }));
        }
        if replace {
            if let Some(existing) = &existing {
                let expected = clean(arg(args, "expectedGoalId"));
                if goal_stalled(Some(existing)) && expected.is_empty() {
                    return Err(GoalError::new(format!(
                        "a replace must name the stalled Goal to retire (--replace={})",
                        string(existing, "id")
                    )));
                }
                if !expected.is_empty() {
                    assert_expected_goal(existing, &expected, "replace")?;
                }
            }
        }
        let goal = self.create_goal(CreateArgs {
            objective: arg(args, "objective").cloned(),
            duration: arg(args, "duration").cloned(),
            time_limit_ms: arg(args, "timeLimitMs").cloned(),
            replace,
            start_in_current_turn: false,
        })?;
        let goal = goal.unwrap_or_default();
        let message = format!("Goal active · {} · {}", objective_of(&goal), timing_label(&goal));
        Ok(reply(action, Some(goal), message))
    }

    fn control_pause(&mut self, mut goal: Goal, at: f64, action: &str) -> GoalResult<Value> {
        if string(&goal, "status") == "complete" {
            return Err(GoalError::new("a completed Goal cannot be paused; edit it or create a new Goal"));
        }
        if string(&goal, "status") == "active" {
            stop_active_clock(&mut goal, at);
        }
        put(&mut goal, "status", "paused");
        put(&mut goal, "pauseReason", "user");
        put(&mut goal, "blocker", "");
        clear_turn_failures(&mut goal);
        put_num(&mut goal, "updatedAt", at);
        let paused = self.commit(Some(goal), None)?.unwrap_or_default();
        let message = format!("Goal paused · {}", objective_of(&paused));
        Ok(reply(action, Some(paused), message))
    }

    fn control_resume(&mut self, mut goal: Goal, args: &Map<String, Value>, at: f64, action: &str) -> GoalResult<Value> {
        if string(&goal, "status") == "complete" {
            return Err(GoalError::new("a completed Goal cannot be resumed; edit it or create a new Goal"));
        }
        let added = match arg(args, "duration").filter(|v| truthy(Some(v))) {
            Some(duration) => Some(parse_goal_duration(duration)?),
            None => None,
        };
        resume_goal_state(&mut goal, at, added)?;
        let resumed = self.commit(Some(goal), None)?.unwrap_or_default();
        let message = format!("Goal resumed · {} · {}", objective_of(&resumed), timing_label(&resumed));
        Ok(reply(action, Some(resumed), message))
    }

    fn control_edit(&mut self, mut goal: Goal, args: &Map<String, Value>, at: f64, action: &str) -> GoalResult<Value> {
        let objective = validate_objective(arg(args, "objective"))?;
        let mut limit = number(&goal, "timeLimitMs");
        let minutes_arg = arg(args, "time_limit_minutes").filter(|v| !v.is_null() && v.as_str() != Some(""));
        if let Some(minutes) = minutes_arg {
            let minutes = mixdog_js::to_number(minutes);
            if !minutes.is_finite() || minutes < 0.0 {
                return Err(GoalError::new("goal time_limit_minutes must be 0 or more"));
            }
            limit = if minutes == 0.0 { 0.0 } else { parse_goal_duration(&mixdog_js::json_number(minutes * 60_000.0))? };
        } else if let Some(ms) = arg(args, "timeLimitMs").filter(|v| !v.is_null()) {
            limit = if ms.is_number() && mixdog_js::to_number(ms) == 0.0 { 0.0 } else { parse_goal_duration(ms)? };
        } else if let Some(duration) = arg(args, "duration").filter(|v| !v.is_null()) {
            limit = parse_goal_duration(duration)?;
        }
        if objective != string(&goal, "objective") {
            let revision = number(&goal, "objectiveRevision");
            put_num(&mut goal, "objectiveRevision", super::js::or(revision, 0.0) + 1.0);
        }
        put(&mut goal, "objective", objective);
        let title = compact_session_title(&string(&goal, "objective"));
        put(&mut goal, "title", title);
        if limit != number(&goal, "timeLimitMs") {
            put_num(&mut goal, "deadlineWarnedMs", NO_DEADLINE_WARNING_MS);
        }
        put_num(&mut goal, "timeLimitMs", limit);
        if string(&goal, "status") == "complete" {
            activate_goal(&mut goal, at);
        } else {
            clear_turn_failures(&mut goal);
        }
        put_num(&mut goal, "updatedAt", at);
        let updated = self.commit(Some(goal), None)?.unwrap_or_default();
        self.schedule_title(&updated);
        let message = format!("Goal updated · {}", objective_of(&updated));
        Ok(reply(action, Some(updated), message))
    }

    fn control_time(&mut self, mut goal: Goal, args: &Map<String, Value>, at: f64, action: &str) -> GoalResult<Value> {
        let limit = parse_goal_duration(arg(args, "duration").unwrap_or(&Value::Null))?;
        set_goal_time_limit(&mut goal, limit, at);
        let timed = self.commit(Some(goal), None)?;
        Ok(reply(action, timed, format!("Goal duration · {}", duration_label(limit))))
    }

    fn control_dismiss(&mut self, mut goal: Goal, at: f64, action: &str, expected: &str) -> GoalResult<Value> {
        let objective = objective_of(&goal);
        if goal_stalled(Some(&goal)) {
            self.abandon_goal(expected, true)?;
            return Ok(reply(action, None, format!("Goal dismissed · {objective}")));
        }
        if !goal_finished(&goal) {
            return Err(GoalError::new("only a finished or stalled Goal can be dismissed; stop it first"));
        }
        if !truthy(goal.get("archivedAt")) {
            put_num(&mut goal, "archivedAt", at);
            put_num(&mut goal, "updatedAt", at);
            self.commit(Some(goal), None)?;
        }
        Ok(reply(action, None, format!("Goal dismissed · {objective}")))
    }
}

impl GoalRuntime {
    /// The user-facing control (`/goal …`, the desktop chrome): `raw` is a command string or a
    /// request object.
    pub async fn control(&self, session_id: &str, raw: Value) -> GoalResult<Value> {
        self.inner.with_mutation(session_id, move |tx| tx.control(&raw)).await
    }
}
