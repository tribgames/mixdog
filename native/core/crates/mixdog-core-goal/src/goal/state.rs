//! `goal-state.mjs`: the Goal record, its validation, durations, clocks and the public view.

use mixdog_js::{JsRegex, is_js_space, js_trim, number_to_string};
use serde_json::{Map, Value, json};

use super::error::{GoalError, GoalResult};
use super::js::{Goal, clean, count, display, now_wall_ms, number, or, put, put_num, round, string, truthy};
use super::session_title::compact_session_title;

pub const MAX_GOAL_TIME_LIMIT_MS: f64 = 7.0 * 24.0 * 60.0 * 60.0 * 1000.0;
pub const DEFAULT_GOAL_TIME_LIMIT_MS: f64 = 0.0;
pub const DEFAULT_COMPLETED_GOAL_TTL_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;
pub const DEFAULT_GOAL_DEADLINE_WARNING_MS: [f64; 2] = [10.0 * 60_000.0, 5.0 * 60_000.0];
pub const NO_DEADLINE_WARNING_MS: f64 = 9_007_199_254_740_991.0;
pub const GOAL_FILE_VERSION: i64 = 1;
pub const GOAL_LIVE_HEARTBEAT_MS: f64 = 60_000.0;
pub const GOAL_STATUS_VALUES: [&str; 7] =
    ["active", "paused", "blocked", "usage_limited", "duration_reached", "complete", "stopped"];

const MAX_OBJECTIVE_LENGTH: usize = 4_000;
const MAX_GOAL_BLOCKER_LENGTH: usize = 1_000;

/// `SESSION_ID_PATTERN`: `^[A-Za-z0-9_-]+$`.
pub fn is_session_id(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub fn assert_session_id(value: &str) -> GoalResult<String> {
    let id = js_trim(value);
    if is_session_id(id) {
        Ok(id.to_owned())
    } else {
        let mut quoted = String::new();
        mixdog_js::json_quote(value, &mut quoted);
        Err(GoalError::new(format!("goal: invalid session id {quoted}")))
    }
}

pub fn validate_objective(value: Option<&Value>) -> GoalResult<String> {
    let objective = clean(value);
    if objective.is_empty() {
        return Err(GoalError::new("goal objective is required"));
    }
    if objective.chars().count() > MAX_OBJECTIVE_LENGTH {
        return Err(GoalError::new(format!("goal objective exceeds {MAX_OBJECTIVE_LENGTH} characters")));
    }
    Ok(objective)
}

pub fn validate_goal_blocker(value: Option<&Value>) -> GoalResult<String> {
    let blocker = clean(value);
    if blocker.is_empty() {
        return Err(GoalError::new("goal block: blocker is required"));
    }
    if blocker.chars().count() > MAX_GOAL_BLOCKER_LENGTH {
        return Err(GoalError::new(format!("goal blocker exceeds {MAX_GOAL_BLOCKER_LENGTH} characters")));
    }
    Ok(blocker)
}

/// `parseGoalDuration`: a number of milliseconds, or text such as `30m`, `2h`, `1h30m`.
pub fn parse_goal_duration(value: &Value) -> GoalResult<f64> {
    if let Value::Number(n) = value {
        let n = n.as_f64().unwrap_or(f64::NAN);
        if !n.is_finite() || n <= 0.0 {
            return Err(GoalError::new("goal duration must be positive"));
        }
        let milliseconds = round(n);
        if milliseconds > MAX_GOAL_TIME_LIMIT_MS {
            return Err(GoalError::new("goal duration exceeds 7 days"));
        }
        return Ok(milliseconds);
    }
    let lowered = clean(Some(value)).to_lowercase();
    let text: String = lowered.chars().filter(|c| !is_js_space(*c)).collect();
    if text.is_empty() {
        return Err(GoalError::new("goal duration is required"));
    }
    static UNIT: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let unit = UNIT.get_or_init(|| regex::Regex::new(r"([0-9]+(?:\.[0-9]+)?)([smhd])").expect("duration pattern"));
    let mut total = 0.0;
    let mut matched = 0;
    for found in unit.captures_iter(&text) {
        let whole = found.get(0).expect("whole match");
        if whole.start() != matched {
            return Err(GoalError::new(format!("invalid goal duration: {}", display(Some(value)))));
        }
        let amount = mixdog_js::string_to_number(&found[1]);
        let ms = match &found[2] {
            "s" => 1000.0,
            "m" => 60_000.0,
            "h" => 3_600_000.0,
            _ => 86_400_000.0,
        };
        total += amount * ms;
        matched += whole.len();
    }
    if matched != text.len() || !total.is_finite() || total < 60_000.0 {
        return Err(GoalError::new("goal duration must be at least 1 minute (for example 30m, 2h, or 1h30m)"));
    }
    if total > MAX_GOAL_TIME_LIMIT_MS {
        return Err(GoalError::new("goal duration exceeds 7 days"));
    }
    Ok(round(total))
}

/// One parsed `/goal` command (`parseUserCommand`): the fields it sets, in Node's order.
pub fn parse_user_command(command: &str) -> Map<String, Value> {
    let mut out = Map::new();
    let value = js_trim(command);
    if value.is_empty() {
        out.insert("action".into(), json!("get"));
        return out;
    }
    let token_end = value.find(is_js_space).unwrap_or(value.len());
    let token = value[..token_end].to_lowercase();
    let rest = js_trim(&value[token_end..]);
    if ["status", "show", "current"].contains(&token.as_str()) {
        out.insert("action".into(), json!("get"));
        return out;
    }
    if ["pause", "stop", "clear", "complete"].contains(&token.as_str()) {
        out.insert("action".into(), json!(token));
        return out;
    }
    if token == "resume" {
        out.insert("action".into(), json!("resume"));
        out.insert("duration".into(), if rest.is_empty() { Value::Null } else { json!(rest) });
        return out;
    }
    if token == "edit" {
        out.insert("action".into(), json!("edit"));
        out.insert("objective".into(), json!(rest));
        return out;
    }
    if token == "time" {
        out.insert("action".into(), json!("time"));
        out.insert("duration".into(), json!(rest));
        return out;
    }
    static REPLACE: std::sync::OnceLock<JsRegex> = std::sync::OnceLock::new();
    static EQUALS: std::sync::OnceLock<JsRegex> = std::sync::OnceLock::new();
    static SPACED: std::sync::OnceLock<JsRegex> = std::sync::OnceLock::new();
    let replace = REPLACE.get_or_init(|| JsRegex::new_static(r"(?:^|\s)--replace(?:=(\S+))?(?=\s|$)", "i"));
    let equals = EQUALS.get_or_init(|| JsRegex::new_static(r"(?:^|\s)--time=([^\s]+)", "i"));
    let spaced = SPACED.get_or_init(|| JsRegex::new_static(r"(?:^|\s)--time\s+([^\s]+)", "i"));
    let mut objective = value.to_owned();
    let mut duration: Option<String> = None;
    let replace_match = replace.captures(&objective).map(|c| (c.range(), c.get(1).map(str::to_owned)));
    let replace_text = replace_match.as_ref().map(|(range, _)| objective[range.clone()].to_owned());
    if let Some(text) = &replace_text {
        objective = js_trim(&objective.replacen(text.as_str(), " ", 1)).to_owned();
    }
    let strip = |objective: &mut String, re: &JsRegex| -> Option<String> {
        let caps = re.captures(objective)?;
        let found = (objective[caps.range()].to_owned(), caps.get(1).map(str::to_owned));
        *objective = js_trim(&objective.replacen(found.0.as_str(), " ", 1)).to_owned();
        found.1
    };
    if let Some(found) = strip(&mut objective, equals) {
        duration = Some(found);
    } else if let Some(found) = strip(&mut objective, spaced) {
        duration = Some(found);
    }
    out.insert("action".into(), json!("create"));
    out.insert("objective".into(), json!(objective));
    out.insert("duration".into(), duration.map_or(Value::Null, Value::from));
    if let Some((_, id)) = replace_match {
        out.insert("replace".into(), json!(true));
        if let Some(id) = id {
            out.insert("expectedGoalId".into(), json!(id));
        }
    }
    out
}

fn stored_time_limit_ms(value: &Goal) -> f64 {
    let stored = number(value, "timeLimitMs");
    if stored.is_finite() && stored > 0.0 { MAX_GOAL_TIME_LIMIT_MS.min(60_000f64.max(stored)) } else { 0.0 }
}

fn stored_legacy_tasks(value: &Goal) -> Vec<Value> {
    let nullish = |key: &str| value.get(key).filter(|v| !v.is_null());
    let Some(Value::Array(tasks)) = nullish("legacyTasks").or_else(|| nullish("tasks")).or_else(|| nullish("criteria")) else {
        return Vec::new();
    };
    tasks
        .iter()
        .filter_map(|task| {
            let task = task.as_object()?;
            let text = clean(task.get("text").filter(|v| !v.is_null()).or_else(|| task.get("content")));
            if text.is_empty() {
                return None;
            }
            let status = clean(task.get("status"));
            let status = if status.is_empty() {
                if task.get("satisfied") == Some(&Value::Bool(true)) { "completed".to_owned() } else { "pending".to_owned() }
            } else {
                status
            };
            Some(json!({ "text": text, "status": status }))
        })
        .collect()
}

pub fn normalize_deadline_warned_ms(value: Option<&Value>) -> f64 {
    let warned = mixdog_js::to_number_of(value);
    if warned.is_finite() && warned >= 0.0 { warned } else { NO_DEADLINE_WARNING_MS }
}

fn capped_time_used_ms(limit: f64, used: f64) -> f64 {
    if limit > 0.0 { limit.min(used) } else { used }
}

fn positive_or_null(goal: &Goal, key: &str) -> Value {
    let n = number(goal, key);
    if n > 0.0 { mixdog_js::json_number(n) } else { Value::Null }
}

/// `normalizeStoredGoal`.
pub fn normalize_stored_goal(value: &Value, session_id: &str, resumed_at: f64) -> GoalResult<Option<Goal>> {
    let Some(value) = value.as_object() else { return Ok(None) };
    let raw_status = value.get("status");
    let status = if raw_status == Some(&json!("budget_limited")) { json!("duration_reached") } else { raw_status.cloned().unwrap_or(Value::Null) };
    let status_text = status.as_str().filter(|s| GOAL_STATUS_VALUES.contains(s));
    let Some(status_text) = status_text else {
        return Err(GoalError::new(format!("invalid stored Goal status: {}", display(raw_status.map(|_| &status)))));
    };
    let status_text = status_text.to_owned();
    let now = now_wall_ms();
    let mut goal = Goal::new();
    let id = clean(value.get("id"));
    put(&mut goal, "id", if id.is_empty() { uuid::Uuid::new_v4().to_string() } else { id });
    put(&mut goal, "sessionId", session_id);
    put(&mut goal, "objective", validate_objective(value.get("objective"))?);
    let title_source = if truthy(value.get("title")) { value.get("title") } else { value.get("objective") };
    put(&mut goal, "title", compact_session_title(&clean_for_string(title_source)));
    put_num(&mut goal, "objectiveRevision", count(value, "objectiveRevision"));
    put(&mut goal, "status", status_text.clone());
    put(&mut goal, "legacyTasks", stored_legacy_tasks(value));
    put(&mut goal, "blocker", clean(value.get("blocker")));
    let pause = value.get("pauseReason").and_then(Value::as_str).filter(|p| ["waiting", "cancelled"].contains(p)).unwrap_or("user");
    put(&mut goal, "pauseReason", pause);
    put(&mut goal, "failureReason", clean(value.get("failureReason")));
    put_num(&mut goal, "failureCount", count(value, "failureCount"));
    put_num(&mut goal, "turnCount", count(value, "turnCount"));
    let limit = stored_time_limit_ms(value);
    put_num(&mut goal, "timeLimitMs", limit);
    let used = or(number(value, "timeUsedMs"), 0.0).max(0.0);
    let cap = if status_text == "duration_reached" { limit } else { 0.0 };
    put_num(&mut goal, "timeUsedMs", capped_time_used_ms(cap, used));
    put_num(&mut goal, "createdAt", or(number(value, "createdAt"), now).max(0.0));
    put_num(&mut goal, "updatedAt", or(number(value, "updatedAt"), now).max(0.0));
    if status_text == "active" {
        let started = or(number(value, "lastStartedAt"), or(resumed_at, now)).max(0.0);
        put_num(&mut goal, "lastStartedAt", started);
    } else {
        put(&mut goal, "lastStartedAt", Value::Null);
    }
    put_num(&mut goal, "liveAt", or(number(value, "liveAt"), 0.0).max(0.0));
    goal.insert("completedAt".into(), positive_or_null(value, "completedAt"));
    goal.insert("stoppedAt".into(), positive_or_null(value, "stoppedAt"));
    goal.insert("archivedAt".into(), positive_or_null(value, "archivedAt"));
    put_num(&mut goal, "deadlineWarnedMs", normalize_deadline_warned_ms(value.get("deadlineWarnedMs")));
    put_num(&mut goal, "warningRevision", count(value, "warningRevision"));
    Ok(Some(goal))
}

/// `String(value || '')` for the title source.
pub(crate) fn clean_for_string(value: Option<&Value>) -> String {
    if truthy(value) { value.map(mixdog_js::value_to_string).unwrap_or_default() } else { String::new() }
}

/// `discardUnobservedTime`: the part of an active Goal's open segment no live runtime ran.
pub fn discard_unobserved_time(goal: &mut Goal, at: f64, tolerance_ms: f64) -> bool {
    if string(goal, "status") != "active" || !(number(goal, "lastStartedAt") > 0.0) {
        return false;
    }
    let seen_at = number(goal, "lastStartedAt").max(or(number(goal, "liveAt"), 0.0));
    let gap = at - seen_at;
    if gap <= tolerance_ms {
        return false;
    }
    put_num(goal, "lastStartedAt", number(goal, "lastStartedAt") + gap);
    put_num(goal, "liveAt", at);
    true
}

/// `discardSuspendedTime`: time a live runtime provably did not run (the OS was suspended).
pub fn discard_suspended_time(goal: &mut Goal, at: f64, suspended_ms: f64) -> bool {
    if string(goal, "status") != "active" || !(number(goal, "lastStartedAt") > 0.0) {
        return false;
    }
    let seen_at = number(goal, "lastStartedAt").max(or(number(goal, "liveAt"), 0.0));
    let dropped = or(suspended_ms, 0.0).floor().min((at - seen_at).max(0.0));
    if !(dropped > 0.0) {
        return false;
    }
    put_num(goal, "lastStartedAt", number(goal, "lastStartedAt") + dropped);
    put_num(goal, "liveAt", at);
    true
}

/// `freezeUnobservedSegment`: the Goal as a reader without a runtime sees it.
pub fn freeze_unobserved_segment(goal: &mut Goal) {
    if string(goal, "status") != "active" || !(number(goal, "lastStartedAt") > 0.0) {
        return;
    }
    let observed = (or(number(goal, "liveAt"), 0.0) - number(goal, "lastStartedAt")).max(0.0);
    let used = or(number(goal, "timeUsedMs"), 0.0).max(0.0) + observed;
    put_num(goal, "timeUsedMs", used);
    put(goal, "lastStartedAt", Value::Null);
}

pub fn active_elapsed_ms(goal: &Goal, now: f64) -> f64 {
    let committed = or(number(goal, "timeUsedMs"), 0.0).max(0.0);
    if string(goal, "status") != "active" || !(number(goal, "lastStartedAt") > 0.0) {
        return committed;
    }
    committed + (now - number(goal, "lastStartedAt")).max(0.0)
}

fn copy(out: &mut Map<String, Value>, goal: &Goal, key: &str) {
    if let Some(value) = goal.get(key) {
        out.insert(key.to_owned(), value.clone());
    }
}

/// `publicGoal`: the Goal as a reader sees it at `now`.
pub fn public_goal(goal: Option<&Goal>, now: f64) -> Option<Goal> {
    let goal = goal?;
    let limit = number(goal, "timeLimitMs");
    let has_limit = limit > 0.0;
    let used = capped_time_used_ms(or(limit, 0.0), active_elapsed_ms(goal, now));
    let remaining = if has_limit { Some((limit - used).max(0.0)) } else { None };
    let mut out = Map::new();
    copy(&mut out, goal, "id");
    put_num(&mut out, "warningRevision", count(goal, "warningRevision"));
    copy(&mut out, goal, "sessionId");
    copy(&mut out, goal, "objective");
    let title = if truthy(goal.get("title")) { goal.get("title").cloned() } else { Some(json!(compact_session_title(&clean_for_string(goal.get("objective"))))) };
    out.insert("title".into(), title.unwrap_or(Value::Null));
    copy(&mut out, goal, "status");
    put_num(&mut out, "turnCount", count(goal, "turnCount"));
    out.insert("blocker".into(), if truthy(goal.get("blocker")) { goal["blocker"].clone() } else { json!("") });
    out.insert("pauseReason".into(), if truthy(goal.get("pauseReason")) { goal["pauseReason"].clone() } else { json!("user") });
    copy(&mut out, goal, "timeLimitMs");
    put_num(&mut out, "timeUsedMs", used);
    out.insert("remainingMs".into(), remaining.map_or(Value::Null, mixdog_js::json_number));
    let live = has_limit && string(goal, "status") == "active" && truthy(goal.get("lastStartedAt"));
    out.insert("deadlineAt".into(), if live { mixdog_js::json_number(now + remaining.unwrap_or(0.0)) } else { Value::Null });
    put_num(&mut out, "snapshotAt", now);
    for key in ["createdAt", "updatedAt", "lastStartedAt", "completedAt", "stoppedAt", "archivedAt"] {
        copy(&mut out, goal, key);
    }
    Some(out)
}

/// `goalStateSnapshot`: the Goal as a published state lane, anchored at the open segment's start
/// so every read of an unchanged Goal is equal.
pub fn goal_state_snapshot(goal: &Goal) -> Goal {
    let started = or(number(goal, "lastStartedAt"), 0.0);
    let snapshot_at = or(number(goal, "snapshotAt"), 0.0);
    if string(goal, "status") != "active" || started <= 0.0 {
        let mut stopped = goal.clone();
        stopped.shift_remove("snapshotAt");
        return stopped;
    }
    if snapshot_at <= 0.0 || snapshot_at == started {
        return goal.clone();
    }
    let committed = (or(number(goal, "timeUsedMs"), 0.0) - (snapshot_at - started).max(0.0)).max(0.0);
    let limit = or(number(goal, "timeLimitMs"), 0.0);
    let remaining = if limit > 0.0 { Some((limit - committed).max(0.0)) } else { None };
    let mut out = goal.clone();
    put_num(&mut out, "timeUsedMs", committed);
    out.insert("remainingMs".into(), remaining.map_or(Value::Null, mixdog_js::json_number));
    out.insert("deadlineAt".into(), remaining.map_or(Value::Null, |r| mixdog_js::json_number(started + r)));
    put_num(&mut out, "snapshotAt", started);
    out
}

pub fn normalized_completed_goal_ttl_ms(value: f64) -> f64 {
    if value.is_finite() && value >= 0.0 { value } else { DEFAULT_COMPLETED_GOAL_TTL_MS }
}

pub fn completed_goal_expired(goal: Option<&Goal>, at: f64, ttl_ms: f64) -> bool {
    let Some(goal) = goal else { return false };
    if string(goal, "status") != "complete" {
        return false;
    }
    let completed = [number(goal, "completedAt"), number(goal, "updatedAt"), number(goal, "createdAt")]
        .into_iter()
        .map(|n| or(n, 0.0))
        .find(|n| *n != 0.0)
        .unwrap_or(0.0);
    completed > 0.0 && at - completed >= normalized_completed_goal_ttl_ms(ttl_ms)
}

pub fn checkpoint_active_clock(goal: &mut Goal, now: f64) {
    if !truthy(goal.get("lastStartedAt")) {
        return;
    }
    let used = or(number(goal, "timeUsedMs"), 0.0).max(0.0) + (now - number(goal, "lastStartedAt")).max(0.0);
    put_num(goal, "timeUsedMs", used);
    put_num(goal, "lastStartedAt", now);
}

pub fn stop_active_clock(goal: &mut Goal, now: f64) {
    checkpoint_active_clock(goal, now);
    put(goal, "lastStartedAt", Value::Null);
}

pub fn clear_turn_failures(goal: &mut Goal) {
    put(goal, "failureReason", "");
    put_num(goal, "failureCount", 0.0);
}

pub fn activate_goal(goal: &mut Goal, now: f64) {
    put(goal, "status", "active");
    put_num(goal, "lastStartedAt", now);
    put(goal, "completedAt", Value::Null);
    put(goal, "archivedAt", Value::Null);
    put(goal, "blocker", "");
    put(goal, "pauseReason", "user");
    clear_turn_failures(goal);
}

/// `resumeGoalState`: `added` extends the cap by that many more milliseconds of budget.
pub fn resume_goal_state(goal: &mut Goal, at: f64, added: Option<f64>) -> GoalResult<()> {
    stop_active_clock(goal, at);
    if let Some(added) = added {
        let limit = parse_goal_duration(&mixdog_js::json_number(number(goal, "timeUsedMs") + added))?;
        put_num(goal, "timeLimitMs", limit);
        put_num(goal, "deadlineWarnedMs", NO_DEADLINE_WARNING_MS);
    }
    if number(goal, "timeLimitMs") > 0.0 && number(goal, "timeLimitMs") <= number(goal, "timeUsedMs") {
        return Err(GoalError::new(
            "Goal time budget is exhausted; extend the time budget before resuming with user-approved time_limit_minutes",
        ));
    }
    activate_goal(goal, at);
    put_num(goal, "updatedAt", at);
    Ok(())
}

/// `setGoalTimeLimit`: re-cap a live or paused Goal at `limit_ms` (already validated).
pub fn set_goal_time_limit(goal: &mut Goal, limit_ms: f64, at: f64) {
    let used = active_elapsed_ms(goal, at);
    put_num(goal, "timeLimitMs", limit_ms);
    put_num(goal, "deadlineWarnedMs", NO_DEADLINE_WARNING_MS);
    if string(goal, "status") == "active" {
        put_num(goal, "timeUsedMs", used);
        put_num(goal, "lastStartedAt", at);
        if used >= limit_ms {
            stop_active_clock(goal, at);
            put(goal, "status", "duration_reached");
        }
    }
    put_num(goal, "updatedAt", at);
}

pub fn start_active_clock(goal: &mut Goal, now: f64) {
    if string(goal, "status") == "active" && !truthy(goal.get("lastStartedAt")) {
        put_num(goal, "lastStartedAt", now);
    }
}

/// `String(n)` of a millisecond count as Node prints it in text.
pub fn ms_text(n: f64) -> String {
    number_to_string(n)
}
