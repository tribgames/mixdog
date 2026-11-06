//! The session's Goal lane (`tui/session/goal-continuation.mjs` and its parts): the visible Goal
//! with the archive-in-flight mask (`goal-visibility.mjs`), the queued Goal continuation
//! (`continuation-queue.mjs`), and the turn outcome the Goal runtime settles on.

use serde_json::Value;
use serde_json::json;

use mixdog_core_goal::goal::js::Goal;
use mixdog_core_goal::goal::state::goal_state_snapshot;

/// What the session calls on the Goal runtime (`goal-facade-api.mjs`).
pub trait SessionGoals:
    mixdog_core_goal::goal::hooks::GoalTurnHooks + mixdog_core_goal::goal::hooks::GoalContinuationHooks + mixdog_core_goal::goal::hooks::GoalViewHooks
{
}

impl<T> SessionGoals for T where
    T: mixdog_core_goal::goal::hooks::GoalTurnHooks + mixdog_core_goal::goal::hooks::GoalContinuationHooks + mixdog_core_goal::goal::hooks::GoalViewHooks
{
}

/// The queue mode of an automatic Goal turn.
pub const CONTINUATION_MODE: &str = "goal-continuation";
const CLOSEOUT_MODE: &str = "goal-closeout";

/// The `goalContinuation` inputs of the facade (`goal-facade-api.mjs`): the session's todo list
/// as the Goal's block, and whether the session waits on an agent or an awaited background
/// shell job (`awaitingBackgroundWork`).
pub async fn continuation_input(
    todos: &dyn mixdog_tools::state::todo::TodoStore,
    work: &dyn mixdog_core_run::run_host::guards::RunningWork,
    cycles: &mixdog_core_run::run_host::guards::UserCycles,
    thread: &mixdog_protocol::ThreadId,
) -> mixdog_core_goal::goal::ContinuationInput {
    let todo = todos.read(thread).await.context_block("Todo list for this Goal (exact wordings):", true);
    let awaiting_work = mixdog_core_run::run_host::guards::awaiting_background_work(work, cycles, thread.as_str()).await;
    mixdog_core_goal::goal::ContinuationInput { awaiting_work, todo }
}

/// `markGoalReminder`'s reach into the Goal runtime: the next continuation carries the full
/// rules again. A failure never breaks the session.
pub fn mark_goal_reminder(goals: &dyn SessionGoals, thread: &mixdog_protocol::ThreadId) {
    let _ = goals.reset_continuation_rules(thread);
}

/// A Goal refusal as the wire carries it: Node's plain `Error`, its message the whole answer.
pub fn failure(error: &mixdog_core_goal::goal::GoalError) -> mixdog_core_api::error::CoreError {
    mixdog_core_api::error::CoreError::DomainError {
        domain: "goal".into(),
        code: error.code.map(Into::into),
        message: Some(error.message.as_str().into()),
        detail: None,
    }
}

/// `goalControl(args)` for the three `thread/goal/*` methods: `set` carries the request (a
/// `/goal` command string or a request object), `clear` is the `clear` action, `control` is its
/// action over its args.
pub fn control_request(method: &str, params: &Value) -> Result<Value, mixdog_core_api::error::CoreError> {
    use mixdog_app_protocol::v2::thread::{ThreadGoalControlParams, ThreadGoalSetParams};
    let bad = |expected: &str| mixdog_core_api::error::CoreError::InvalidParams { path: "params".into(), expected: expected.into() };
    match method {
        "thread/goal/set" => {
            let set: ThreadGoalSetParams = serde_json::from_value(params.clone()).map_err(|_| bad("ThreadGoalSetParams"))?;
            Ok(set.goal)
        }
        "thread/goal/clear" => Ok(json!({ "action": "clear" })),
        _ => {
            let control: ThreadGoalControlParams = serde_json::from_value(params.clone()).map_err(|_| bad("ThreadGoalControlParams"))?;
            let mut request = match control.args {
                Some(Value::Object(args)) => args,
                _ => serde_json::Map::new(),
            };
            request.insert("action".into(), Value::String(control.action));
            Ok(Value::Object(request))
        }
    }
}

/// What the lane watches of the Goal between changes (`goal-continuation.mjs`'s observed
/// Goal and `deadline-delivery.mjs`'s watermark).
#[derive(Default)]
pub struct GoalWatch {
    observed_id: String,
    observed_status: String,
    watched_id: String,
    delivered_warning: f64,
}

impl GoalWatch {
    /// The lane starts on the Goal the session already shows.
    pub fn new(goal: Option<&Value>) -> Self {
        let read = |key: &str| mixdog_core_goal::goal::js::clean(goal.and_then(|g| g.get(key)));
        Self { observed_id: read("id"), observed_status: read("status"), ..Self::default() }
    }

    /// `onGoalChanged`'s bookkeeping: whether the visible Goal has just reached its duration.
    pub fn observe(&mut self, visible: Option<&Goal>) -> bool {
        let id = visible.map(id_of).unwrap_or_default();
        let status = visible.map(|g| mixdog_core_goal::goal::js::string(g, "status")).unwrap_or_default();
        let reached = status == "duration_reached" && id == self.observed_id && self.observed_status == "active";
        self.observed_id = id;
        self.observed_status = status;
        reached
    }

    /// `deliverGoalDeadlineWarning`'s decision: the advance notice's text when one is due.
    pub fn warning(&mut self, timed: Option<&Goal>) -> Option<String> {
        let goal = timed;
        let revision = goal.map_or(f64::NAN, |g| mixdog_core_goal::goal::js::number(g, "warningRevision"));
        let revision = if revision.is_nan() { 0.0 } else { revision.max(0.0) };
        let id = goal.map(id_of).unwrap_or_default();
        // Warnings this Goal earned before the lane watched it were delivered by whoever ran the
        // session then, so the first sighting only sets the watermark.
        if !id.is_empty() && id != self.watched_id {
            self.watched_id = id;
            self.delivered_warning = revision;
            return None;
        }
        if revision == 0.0 || revision <= self.delivered_warning {
            return None;
        }
        self.delivered_warning = revision;
        let goal = goal?;
        let remaining = mixdog_core_goal::goal::js::number(goal, "remainingMs");
        if mixdog_core_goal::goal::js::string(goal, "status") != "active" || remaining.is_nan() || remaining <= 0.0 {
            return None;
        }
        let text = mixdog_core_goal::goal::text::goal_deadline_warning(goal);
        (!mixdog_js::js_trim(&text).is_empty()).then_some(text)
    }
}

/// A meta entry the model reads and the user never sees (`isMeta`, `suppressDisplay`).
fn meta_entry(message: &str, mode: &str, priority: &str, goal: &Goal, now: i64) -> Value {
    json!({
        "message": message,
        "mode": mode,
        "priority": priority,
        "isMeta": true,
        "suppressDisplay": true,
        "skipSlashCommands": true,
        "restorable": false,
        "goalId": id_of(goal),
        "displayText": "",
        "enqueuedAt": now,
    })
}

/// The advance notice queued behind a running turn: a prompt the loop attaches at its next
/// boundary.
pub fn warning_entry(text: &str, goal: &Goal, now: i64) -> Value {
    meta_entry(text, "prompt", "next", goal, now)
}

/// What the deadline closeout does (`deliverGoalCloseout`).
pub enum Closeout {
    /// Queued user work runs first and carries the reminder instead.
    Remind,
    Enqueue(Value),
}

pub fn closeout(goal: &Goal, busy: bool, queue: &[&Value], now: i64) -> Closeout {
    if !busy && queue.iter().any(|entry| !is_goal_entry(entry)) {
        return Closeout::Remind;
    }
    let mut entry = meta_entry(&mixdog_core_goal::goal::text::goal_deadline_reached(goal), CLOSEOUT_MODE, if busy { "next" } else { "later" }, goal, now);
    entry["abortDiscardOnAbort"] = Value::Bool(true);
    Closeout::Enqueue(entry)
}

/// `cancelQueuedGoalContinuations({ keepCloseoutFor })`: the closeout of the Goal that reached
/// its duration stays queued with the text of that Goal now. The text to carry, when `entry` is
/// such a closeout.
pub fn kept_closeout_text(entry: &Value, keep: Option<&Goal>) -> Option<String> {
    let keep = keep.filter(|g| mixdog_core_goal::goal::js::string(g, "status") == "duration_reached")?;
    let is_closeout = entry.get("mode").and_then(Value::as_str) == Some(CLOSEOUT_MODE);
    (is_closeout && mixdog_core_goal::goal::js::clean(entry.get("goalId")) == id_of(keep)).then(|| mixdog_core_goal::goal::text::goal_deadline_reached(keep))
}

/// A queued deadline closeout (`entry.mode === 'goal-closeout'`).
pub fn is_closeout(entry: &Value) -> bool {
    entry.get("mode").and_then(Value::as_str) == Some(CLOSEOUT_MODE)
}

/// `shouldRunGoalContinuation`'s closeout half: the closeout runs only while the lane's Goal
/// (`refreshGoalState()`) is still at its duration and is the entry's.
pub fn closeout_still_due(entry: &Value, goal: Option<&Goal>) -> bool {
    goal.is_some_and(|goal| mixdog_core_goal::goal::js::string(goal, "status") == "duration_reached" && mixdog_core_goal::goal::js::clean(entry.get("goalId")) == id_of(goal))
}

/// `shouldRunGoalContinuation`'s continuation half: the runtime still decides to run, for the
/// entry's Goal when the entry names one.
pub fn continuation_still_due(entry: &Value, decision: &mixdog_core_goal::goal::Continuation) -> bool {
    let queued = mixdog_core_goal::goal::js::clean(entry.get("goalId"));
    decision.run && (queued.is_empty() || decision.goal.as_ref().is_some_and(|goal| id_of(goal) == queued))
}

/// `isGoalQueuedEntry`.
pub fn is_goal_entry(entry: &Value) -> bool {
    matches!(entry.get("mode").and_then(Value::as_str), Some(CONTINUATION_MODE | CLOSEOUT_MODE))
}

/// The statuses a user prompt retires (`ARCHIVED_STATUSES`).
fn archived(goal: &Goal) -> bool {
    matches!(goal.get("status").and_then(Value::as_str), Some("complete" | "stopped"))
}

fn id_of(goal: &Goal) -> String {
    mixdog_core_goal::goal::js::clean(goal.get("id"))
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
