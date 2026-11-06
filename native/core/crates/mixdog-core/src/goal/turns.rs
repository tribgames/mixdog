//! `goal-turns.mjs`: the Goal's turn lifecycle: opening a turn on the active clock, settling it
//! from the turn outcome, deciding whether an idle session should continue, and retiring
//! finished work on the next user prompt.

use serde_json::{Value, json};

use super::error::GoalResult;
use super::js::{Goal, clean, count, number, put, put_num, string, truthy};
use super::mutations::goal_finished;
use super::runtime::{Admission, GoalRuntime, Tx};
use super::state::{
    assert_session_id, checkpoint_active_clock, clear_turn_failures, resume_goal_state, start_active_clock, stop_active_clock,
};
use super::text::continuation_prompt;

/// The no-progress wait is spent per Goal and turn.
fn idle_review_key(goal: &Goal) -> String {
    format!("{}:{}", string(goal, "id"), mixdog_js::number_to_string(number(goal, "turnCount")))
}

/// Folds a settled turn's outcome (usage limit, cancel, failure, or a clean finish) into the
/// Goal status and clocks.
fn apply_turn_outcome(goal: &mut Goal, detail: &Value, at: f64) {
    let status_source = match detail {
        Value::String(_) => Some(detail),
        other => other.get("status"),
    };
    let status = clean(status_source).to_lowercase();
    let usage_limited = detail.get("usageLimited") == Some(&json!(true)) || detail.get("usage_limited") == Some(&json!(true));
    let current = string(goal, "status");
    if usage_limited && (current == "active" || current == "duration_reached") {
        stop_active_clock(goal, at);
        clear_turn_failures(goal);
        put(goal, "status", "usage_limited");
        let error = clean(detail.get("error"));
        put(goal, "blocker", if error.is_empty() { "Provider usage limit reached".to_owned() } else { error });
        return;
    }
    if status == "cancelled" && current == "active" {
        // Cancelling a turn stops that turn, not the objective.
        stop_active_clock(goal, at);
        clear_turn_failures(goal);
        put(goal, "status", "paused");
        put(goal, "pauseReason", "cancelled");
        put(goal, "blocker", "");
        return;
    }
    if status == "failed" && current == "active" {
        stop_active_clock(goal, at);
        put(goal, "status", "blocked");
        let error = clean(detail.get("error"));
        let reason = if error.is_empty() { "Goal turn failed".to_owned() } else { error };
        put(goal, "failureReason", reason.clone());
        put_num(goal, "failureCount", 1.0);
        put(goal, "blocker", reason);
        return;
    }
    clear_turn_failures(goal);
    if current != "active" {
        return;
    }
    checkpoint_active_clock(goal, at);
    if number(goal, "timeLimitMs") > 0.0 && number(goal, "timeUsedMs") >= number(goal, "timeLimitMs") {
        stop_active_clock(goal, at);
        put(goal, "status", "duration_reached");
        let limit = number(goal, "timeLimitMs");
        put_num(goal, "timeUsedMs", limit);
    }
}

fn automatic_without_activity(detail: &Value, goal: Option<&Goal>) -> bool {
    detail.get("automatic") == Some(&json!(true))
        && detail.get("preserveGoalState") != Some(&json!(true))
        && mixdog_js::to_number_of(detail.get("toolCalls")) == 0.0
        && goal.is_some_and(|g| string(g, "status") == "active")
}

/// What the session tells the continuation decision: `awaiting_work` is whether the session waits
/// on a running agent or an awaited background shell job (it wakes the session when it ends);
/// `todo` is the session's open step list as text.
#[derive(Default, Clone)]
pub struct ContinuationInput {
    pub awaiting_work: bool,
    pub todo: String,
}

/// The answer of `continuation`: whether an idle session should start a Goal turn.
#[derive(Clone, PartialEq, Debug)]
pub struct Continuation {
    pub run: bool,
    pub reason: String,
    pub goal: Option<Goal>,
    pub prompt: Option<String>,
}

impl Continuation {
    pub fn to_value(&self) -> Value {
        let mut out = serde_json::Map::new();
        out.insert("run".into(), json!(self.run));
        out.insert("reason".into(), json!(self.reason));
        out.insert("goal".into(), self.goal.clone().map_or(Value::Null, Value::Object));
        if let Some(prompt) = &self.prompt {
            out.insert("prompt".into(), json!(prompt));
        }
        Value::Object(out)
    }
}

impl Tx<'_> {
    fn start_turn(&mut self) -> GoalResult<Option<Goal>> {
        let goal = self.read_record()?;
        let Some(mut goal) = goal.filter(|g| !truthy(g.get("archivedAt"))) else {
            let mut mem = self.slot.mem();
            mem.turn_goal_id = None;
            mem.turn_started_at = None;
            mem.turn_objective_revision = None;
            return Ok(None);
        };
        let at = self.now();
        {
            let mut mem = self.slot.mem();
            mem.turn_goal_id = Some(string(&goal, "id"));
            mem.turn_started_at = Some(at);
            mem.turn_objective_revision = Some(number(&goal, "objectiveRevision"));
        }
        if string(&goal, "status") != "active" {
            return Ok(self.visible_snapshot());
        }
        let turns = count(&goal, "turnCount") + 1.0;
        put_num(&mut goal, "turnCount", turns);
        start_active_clock(&mut goal, at);
        put_num(&mut goal, "updatedAt", at);
        self.slot.mem().idle_review = None;
        self.commit(Some(goal), None)
    }

    fn settle_turn(&mut self, detail: &Value) -> GoalResult<Option<Goal>> {
        let expected = {
            let mut mem = self.slot.mem();
            let expected = mem.turn_goal_id.take().unwrap_or_default();
            mem.turn_started_at = None;
            mem.turn_objective_revision = None;
            expected
        };
        let goal = self.read_record()?;
        let Some(mut goal) = goal.filter(|g| !truthy(g.get("archivedAt")) && (expected.is_empty() || string(g, "id") == expected)) else {
            return Ok(self.visible_snapshot());
        };
        let at = self.now();
        if detail.get("preserveGoalState") == Some(&json!(true)) {
            if string(&goal, "status") == "active" {
                checkpoint_active_clock(&mut goal, at);
            }
        } else {
            apply_turn_outcome(&mut goal, detail, at);
        }
        put_num(&mut goal, "updatedAt", at);
        let stopped_id = (string(&goal, "status") != "active").then(|| string(&goal, "id"));
        let published = match self.commit(Some(goal), None) {
            Ok(published) => published,
            Err(error) => {
                if let Some(id) = stopped_id {
                    self.slot.mem().unsaved_stop = Some(id);
                }
                return Err(error);
            }
        };
        self.slot.mem().unsaved_stop = None;
        if automatic_without_activity(detail, published.as_ref()) {
            if let Some(published) = &published {
                self.slot.mem().idle_review = Some(idle_review_key(published));
            }
        }
        Ok(published)
    }
}

impl GoalRuntime {
    pub async fn start_turn(&self, session_id: &str) -> GoalResult<Option<Goal>> {
        self.inner.with_mutation(session_id, |tx| tx.start_turn()).await
    }

    pub async fn settle_turn(&self, session_id: &str, detail: Value) -> GoalResult<Option<Goal>> {
        self.inner.with_mutation(session_id, move |tx| tx.settle_turn(&detail)).await
    }

    /// A quota resume revives exactly the Goal its failure suspended, and only while that Goal
    /// is still waiting on the limit.
    pub async fn reactivate_usage_limited(&self, session_id: &str, goal_id: &str, admission: Admission) -> GoalResult<Option<Goal>> {
        let goal_id = clean(Some(&Value::String(goal_id.to_owned())));
        self.inner
            .with_mutation(session_id, move |tx| {
                if let Some(is_current) = &admission.is_current {
                    if !is_current()? {
                        return Ok(None);
                    }
                }
                let Some(mut goal) = tx.read_record()? else { return Ok(None) };
                if truthy(goal.get("archivedAt")) || string(&goal, "id") != goal_id || string(&goal, "status") != "usage_limited" {
                    return Ok(None);
                }
                let at = tx.now();
                if resume_goal_state(&mut goal, at, None).is_err() {
                    return Ok(None);
                }
                tx.commit(Some(goal), Some(&admission))
            })
            .await
    }

    /// Whether an idle session should start a Goal turn, and the prompt to start it with.
    pub async fn continuation(&self, session_id: &str, input: ContinuationInput) -> GoalResult<Continuation> {
        let goal = self.inner.visible_snapshot(session_id).await?;
        let Some(active) = goal.as_ref().filter(|g| string(g, "status") == "active") else {
            let reason = goal.as_ref().map(|g| string(g, "status")).filter(|s| !s.is_empty()).unwrap_or_else(|| "missing".into());
            return Ok(Continuation { run: false, reason, goal, prompt: None });
        };
        let id = assert_session_id(session_id)?;
        let slot = self.inner.slot(&id);
        let stop = |reason: &str, goal: Option<Goal>| Continuation { run: false, reason: reason.into(), goal, prompt: None };
        if input.awaiting_work {
            return Ok(stop("awaiting-work", goal));
        }
        let goal_id = string(active, "id");
        let mut mem = slot.mem();
        if mem.unsaved_stop.as_deref() == Some(goal_id.as_str()) {
            return Ok(stop("unsaved-stop", goal));
        }
        if mem.idle_review.as_deref() == Some(idle_review_key(active).as_str()) {
            return Ok(stop("no-progress-wait", goal));
        }
        let include_rules = mem.continuation_tier.as_deref() != Some(goal_id.as_str());
        mem.continuation_tier = Some(goal_id);
        let prompt = continuation_prompt(active, include_rules, &input.todo);
        drop(mem);
        Ok(Continuation { run: true, reason: "idle".into(), goal, prompt: Some(prompt) })
    }

    /// Compaction, an objective edit or a paused-state notice drops the delivered rules: the
    /// next continuation carries them in full again.
    pub fn reset_continuation_rules(&self, session_id: &str) -> GoalResult<()> {
        let id = assert_session_id(session_id)?;
        self.inner.slot(&id).mem().continuation_tier = None;
        Ok(())
    }

    /// The user's next prompt retires finished work.
    pub async fn archive_completed_on_user_input(&self, session_id: &str) -> GoalResult<Option<Goal>> {
        if session_id.is_empty() {
            return Ok(None);
        }
        self.inner
            .with_mutation(session_id, |tx| {
                let Some(mut goal) = tx.read_record()? else { return Ok(tx.visible_snapshot()) };
                if !goal_finished(&goal) || truthy(goal.get("archivedAt")) {
                    return Ok(tx.visible_snapshot());
                }
                let at = tx.now();
                put_num(&mut goal, "archivedAt", at);
                put_num(&mut goal, "updatedAt", at);
                tx.commit(Some(goal), None)?;
                Ok(None)
            })
            .await
    }
}
