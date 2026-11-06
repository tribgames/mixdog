//! The pure reads of `agent-task-sessions.mjs` over a session's stored messages and its agent
//! work: where a submission's turn ended, the chain of turns an agent task started, and whether the
//! chain still waits on agent work (`runtime/shared/pending-agent-work.mjs`).

use std::collections::HashSet;

use mixdog_js::{JsRegex, js_trim, json_parse, value_to_string};
use serde_json::Value;

const STARTING_AGENT_CALLS: [&str; 2] = ["spawn", "send"];

fn interrupted(text: &str) -> bool {
    text.starts_with("[Request interrupted")
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn path<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().try_fold(value, |v, key| v.get(key))
}

fn string_at(message: &Value, keys: &[&str]) -> String {
    path(message, keys).and_then(Value::as_str).unwrap_or_default().to_owned()
}

fn part_text(part: &Value) -> String {
    match part {
        Value::String(s) => s.clone(),
        _ if part.get("type").and_then(Value::as_str) == Some("text") => part.get("text").filter(|t| truthy(Some(t))).map_or_else(String::new, value_to_string),
        _ => String::new(),
    }
}

/// `messageText`: a string, or the text parts of a content array.
pub fn message_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts.iter().map(part_text).collect(),
        _ => String::new(),
    }
}

fn content_text(message: &Value) -> String {
    message.get("content").map_or_else(String::new, message_text)
}

/// `turnStatus`.
fn turn_status(detail: &Value) -> &'static str {
    match detail.get("status").and_then(Value::as_str) {
        Some("done" | "completed") => "completed",
        Some("failed") => "failed",
        _ => "cancelled",
    }
}

/// `submissionIdsOf`: the submissions a stored user message delivered.
pub fn submission_ids_of(message: &Value) -> Vec<String> {
    if message.get("role").and_then(Value::as_str) != Some("user") {
        return Vec::new();
    }
    let strings = |keys: &[&str]| -> Vec<String> {
        path(message, keys).and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()).unwrap_or_default()
    };
    let checkpoint = path(message, &["meta", "transcript", "checkpointId"]).and_then(Value::as_str).map(str::to_owned);
    checkpoint.into_iter().chain(strings(&["meta", "transcript", "submissionIds"])).chain(strings(&["meta", "submissionIds"])).collect()
}

/// How a turn ended: its status and final text, or still open.
#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    Open,
    Ended { status: String, text: String },
}

impl Outcome {
    fn ended(status: &str, text: String) -> Self {
        Self::Ended { status: status.to_owned(), text }
    }
}

/// `outcomeFrom`: the end of the turn whose prompt is `list[start]`, read in place - its
/// completion, an interruption, or the next turn's prompt.
pub fn outcome_from(list: &[Value], start: usize) -> Outcome {
    for (index, message) in list.iter().enumerate().skip(start) {
        if let Some(completion) = path(message, &["meta", "transcript", "completion"]).filter(|c| truthy(Some(c))) {
            let status = turn_status(completion);
            let text = if status == "failed" {
                completion.get("detail").filter(|d| truthy(Some(d))).map_or_else(String::new, message_text)
            } else if message.get("role").and_then(Value::as_str) == Some("assistant") {
                content_text(message)
            } else {
                String::new()
            };
            return Outcome::ended(status, text);
        }
        if index == start || message.get("role").and_then(Value::as_str) != Some("user") {
            continue;
        }
        if interrupted(&content_text(message)) || truthy(path(message, &["meta", "transcript", "checkpointId"])) {
            return Outcome::ended("cancelled", String::new());
        }
    }
    Outcome::Open
}

/// `submissionOutcome`: the end of the turn that took submission `run_id`; `None` when no turn
/// took it.
pub fn submission_outcome(messages: &[Value], run_id: &str) -> Option<Outcome> {
    let start = messages.iter().position(|m| submission_ids_of(m).iter().any(|id| id == run_id))?;
    Some(outcome_from(messages, start))
}

/// `agentTaskIdOfExecution`: the agent task an execution id names; `None` for one keyed by
/// session because its row recorded no task id.
pub fn agent_task_id_of_execution(execution_id: &str) -> Option<String> {
    let id = js_trim(execution_id);
    let Some(rest) = id.strip_prefix("restart:") else { return (!id.is_empty()).then(|| id.to_owned()) };
    (!rest.is_empty() && !rest.contains(':')).then(|| rest.to_owned())
}

/// The agent tasks a woken turn's prompt delivered, `None` for an id that names no task.
fn consumed_task_ids(message: &Value) -> Vec<Option<String>> {
    let ids: Vec<Value> = match path(message, &["meta", "transcript", "consumedExecutionIds"]) {
        Some(Value::Array(recorded)) => recorded.clone(),
        _ => path(message, &["meta", "execution", "id"]).filter(|id| truthy(Some(id))).cloned().into_iter().collect(),
    };
    ids.iter().map(|id| if truthy(Some(id)) { agent_task_id_of_execution(&value_to_string(id)) } else { None }).collect()
}

/// `callArguments`.
fn call_arguments(call: &Value) -> Value {
    let raw = call.get("arguments").filter(|a| !a.is_null()).or_else(|| call.get("function").and_then(|f| f.get("arguments")));
    match raw {
        Some(object) if object.is_object() => object.clone(),
        raw => {
            let text = raw.filter(|r| truthy(Some(r))).map_or_else(|| "{}".to_owned(), value_to_string);
            json_parse(&text).ok().filter(|v| truthy(Some(v))).unwrap_or_else(|| Value::Object(Default::default()))
        }
    }
}

/// An answer of the chain: the submission of the turn that gave it and how it ended.
#[derive(Clone, Debug, PartialEq)]
pub struct Answer {
    pub id: String,
    pub status: String,
    pub text: String,
}

/// `turnChain`'s answer.
#[derive(Clone, Debug)]
pub struct Chain {
    /// The latest turn of the chain.
    pub id: String,
    /// The turn that took the submission.
    pub first: String,
    pub outcome: Option<Outcome>,
    pub at: f64,
    pub ambiguous: bool,
    /// Every turn of the chain that recorded its end, oldest first.
    pub answers: Vec<Answer>,
    /// The agent tasks the chain's turns started.
    pub task_ids: HashSet<String>,
    pub busy_is_others: bool,
}

/// `turnStartOf`: where the turn that took the submission stored at `list[at]` keeps its prompt.
fn turn_start_of(list: &[Value], at: usize) -> usize {
    if truthy(path(&list[at], &["meta", "transcript", "checkpointId"])) {
        return at;
    }
    for index in (0..at).rev() {
        let message = &list[index];
        if truthy(path(message, &["meta", "transcript", "completion"])) {
            return at;
        }
        if message.get("role").and_then(Value::as_str) != Some("user") {
            continue;
        }
        if truthy(path(message, &["meta", "transcript", "checkpointId"])) {
            return index;
        }
        if interrupted(&content_text(message)) {
            return at;
        }
    }
    at
}

fn checkpoint_of(message: &Value) -> String {
    path(message, &["meta", "transcript", "checkpointId"]).filter(|c| truthy(Some(c))).map_or_else(String::new, value_to_string)
}

/// `turnChain`: the latest turn of the chain that submission `run_id` started, from structured
/// provenance only. `ambiguous` is set when provenance a chain decision needs is missing.
pub fn turn_chain(messages: &[Value], run_id: &str) -> Option<Chain> {
    let list = messages;
    let asked = list.iter().position(|m| submission_ids_of(m).iter().any(|id| id == run_id))?;
    // The chain starts with the whole turn that took run_id, named by that turn.
    let start = turn_start_of(list, asked);
    let first = Some(checkpoint_of(&list[start])).filter(|c| !c.is_empty()).unwrap_or_else(|| run_id.to_owned());
    let (mut started, mut taken, mut starting_calls) = (HashSet::<String>::new(), HashSet::<String>::new(), HashSet::<String>::new());
    let (mut at, mut id, mut in_chain, mut ambiguous) = (start, first.clone(), true, false);
    let (mut turn_at, mut turn_id) = (start, first.clone());
    let mut turns: Vec<(usize, String)> = vec![(start, first.clone())];
    for (index, message) in list.iter().enumerate().skip(start) {
        let is_user = message.get("role").and_then(Value::as_str) == Some("user");
        let checkpoint = if index > start && is_user { checkpoint_of(message) } else { String::new() };
        if !checkpoint.is_empty() {
            turn_at = index;
            turn_id = checkpoint.clone();
            in_chain = false;
        }
        // A completion delivered as a turn's prompt (queue or bus wake), or steered into a running
        // turn: the turn that took the chain's result joins the chain, even one the user started.
        let delivered = (index > start && is_user && string_at(message, &["meta", "source"]) == "task-notification").then(|| consumed_task_ids(message));
        for task in delivered.iter().flatten().flatten() {
            taken.insert(task.clone());
        }
        if let (Some(delivered), false) = (&delivered, in_chain) {
            if delivered.iter().flatten().any(|task| started.contains(task)) {
                in_chain = true;
                at = turn_at;
                id = turn_id.clone();
                if turns.last().map(|t| &t.1) != Some(&turn_id) {
                    turns.push((turn_at, turn_id.clone()));
                }
            } else if delivered.is_empty() || delivered.iter().any(Option::is_none) {
                ambiguous = true;
            }
        }
        if !checkpoint.is_empty() || delivered.is_some() || !in_chain {
            continue;
        }
        match message.get("role").and_then(Value::as_str) {
            Some("assistant") => {
                for call in message.get("toolCalls").and_then(Value::as_array).into_iter().flatten() {
                    let name = call.get("name").filter(|n| !n.is_null()).or_else(|| call.get("function").and_then(|f| f.get("name"))).map_or_else(String::new, value_to_string);
                    let kind = call_arguments(call).get("type").filter(|t| truthy(Some(t))).map_or_else(|| "spawn".to_owned(), value_to_string);
                    if name == "agent"
                        && STARTING_AGENT_CALLS.contains(&js_trim(&kind))
                        && let Some(call_id) = call.get("id").filter(|i| truthy(Some(i)))
                    {
                        starting_calls.insert(value_to_string(call_id));
                    }
                }
            }
            Some("tool") if message.get("toolCallId").is_some_and(|c| starting_calls.contains(&value_to_string(c))) => {
                match message.get("agentTaskIds").and_then(Value::as_array) {
                    Some(ids) => started.extend(ids.iter().map(value_to_string)),
                    None if message.get("toolKind").and_then(Value::as_str) != Some("error") => ambiguous = true,
                    None => {}
                }
            }
            _ => {}
        }
    }
    // Read in place: each chain turn's outcome scan stops at that turn's end.
    let ended = list.iter().skip(at).find(|m| truthy(path(m, &["meta", "transcript", "completion"])));
    let last = (turn_id != id).then(|| outcome_from(list, turn_at));
    let (mut answers, mut outcome) = (Vec::new(), None);
    for (turn, turn_name) in &turns {
        let turn_outcome = outcome_from(list, *turn);
        if *turn == at {
            outcome = Some(turn_outcome.clone());
        }
        if let Outcome::Ended { status, text } = turn_outcome {
            answers.push(Answer { id: turn_name.clone(), status, text });
        }
    }
    let at_ms = ended.and_then(|m| path(m, &["meta", "transcript", "at"])).map_or(0.0, |v| {
        let n = mixdog_js::to_number(v);
        if n.is_nan() { 0.0 } else { n }
    });
    Some(Chain {
        id,
        first,
        outcome,
        at: at_ms,
        ambiguous,
        answers,
        busy_is_others: last == Some(Outcome::Open) && started.iter().all(|task| taken.contains(task)),
        task_ids: started,
    })
}

/// `latestTurnOutcome`: the chain's latest turn and when its end was recorded.
pub fn latest_turn_outcome(messages: &[Value], run_id: &str) -> Option<(String, Option<Outcome>, f64, bool)> {
    turn_chain(messages, run_id).map(|c| (c.id, c.outcome, c.at, c.ambiguous))
}

fn statuses(row: &Value) -> Vec<String> {
    let mut seen = Vec::new();
    for key in ["stage", "status"] {
        let text = row.get(key).filter(|v| truthy(Some(v))).map_or_else(String::new, |v| js_trim(&value_to_string(v)).to_owned());
        if !text.is_empty() && !seen.contains(&text) {
            seen.push(text);
        }
    }
    seen
}

fn is_active_row(row: &Value) -> bool {
    let all = statuses(row);
    let cancelled = JsRegex::new_static("cancel|killed|aborted|interrupted", "i");
    if all.is_empty() || all.iter().any(|s| cancelled.is_match(s)) {
        return false;
    }
    let status = row.get("status").filter(|v| truthy(Some(v))).map_or_else(String::new, |v| js_trim(&value_to_string(v)).to_owned());
    let lifecycle = if status.is_empty() { all[0].clone() } else { status };
    let terminal = JsRegex::new_static("idle|done|complete|success|closed|error|fail|cancel|killed|timeout", "i");
    let active = JsRegex::new_static(r"^(?:connecting|requesting|streaming|tool[-_\s]?running|running|queued|pending|starting|resource_wait)$", "i");
    !terminal.is_match(&lifecycle) && active.is_match(&lifecycle)
}

fn is_cancel_unconfirmed(row: &Value) -> bool {
    let regex = JsRegex::new_static(r"cancel[-_\s]?(?:unconfirmed|pending)|cancell?ing", "i");
    statuses(row).iter().any(|s| regex.is_match(s))
}

/// `hasPendingAgentWork`: agent work still in flight on one pool row.
pub fn has_pending_agent_work(row: &Value) -> bool {
    is_active_row(row) || is_cancel_unconfirmed(row)
}

fn text_of(row: &Value, key: &str) -> String {
    row.get(key).filter(|v| truthy(Some(v))).map_or_else(String::new, value_to_string)
}

/// `sessionsWithPendingWork`: the owner sessions with a child row still in flight.
pub fn sessions_with_pending_work(pool: &[Value]) -> HashSet<String> {
    let mut pending = HashSet::new();
    for row in pool {
        let session = text_of(row, "sessionId");
        let owner = Some(text_of(row, "ownerSessionId")).filter(|o| !o.is_empty()).unwrap_or_else(|| session.clone());
        if owner.is_empty() || session == owner {
            continue;
        }
        if has_pending_agent_work(row) {
            pending.insert(owner);
        }
    }
    pending
}

/// An agent task of this process as `pendingWorkOf` reads it.
#[derive(Clone, Debug)]
pub struct AgentTask {
    pub task_id: String,
    pub session_id: Option<String>,
    pub running: bool,
}

/// An agent result queued for a session that no turn has taken yet.
#[derive(Clone, Debug)]
pub struct Owed {
    pub text: String,
    pub meta: Value,
}

impl Owed {
    /// The agent task the result reports; `None` when it names none.
    pub fn task_id(&self) -> Option<String> {
        self.meta.get("execution_id").filter(|v| truthy(Some(v))).and_then(|v| agent_task_id_of_execution(&value_to_string(v)))
    }
}

/// `owedOf`: the results that may be the chain's of `task_ids` - its tasks' and those naming no
/// task; every one for `None` (the whole session).
pub fn owed_of<'a>(owed: &'a [Owed], task_ids: Option<&HashSet<String>>) -> Vec<&'a Owed> {
    owed.iter().filter(|r| task_ids.is_none_or(|ids| r.task_id().is_none_or(|t| ids.contains(&t)))).collect()
}

/// What `pendingWorkOf` reads of this process.
#[derive(Default)]
pub struct Pending {
    pub agent_working: HashSet<String>,
    pub owed: Vec<Owed>,
    pub pool: Vec<Value>,
    pub agent_task_owners: HashSet<String>,
    pub working: HashSet<String>,
    pub agent_tasks: Vec<AgentTask>,
}

/// `pendingWorkOf`: whether task session `session_id` still waits on agent work it handed off;
/// `task_ids` narrows it to one chain's agent tasks.
pub fn pending_work_of(session_id: &str, pending: &Pending, task_ids: Option<&HashSet<String>>) -> bool {
    if let Some(task_ids) = task_ids {
        return chain_pending_work(session_id, task_ids, pending);
    }
    if pending.agent_working.contains(session_id) || !pending.owed.is_empty() || pending.agent_task_owners.contains(session_id) {
        return true;
    }
    if sessions_with_pending_work(&pending.pool).contains(session_id) {
        return true;
    }
    pending.pool.iter().any(|row| text_of(row, "ownerSessionId") == session_id && pending.agent_task_owners.contains(&text_of(row, "sessionId")))
}

fn chain_pending_work(session_id: &str, task_ids: &HashSet<String>, pending: &Pending) -> bool {
    let sessions = closure_sessions(session_id, task_ids, pending);
    let mut session_of = std::collections::HashMap::new();
    for row in &pending.pool {
        if truthy(row.get("taskId")) {
            session_of.insert(text_of(row, "taskId"), text_of(row, "sessionId"));
        }
    }
    for task in &pending.agent_tasks {
        if let Some(session) = task.session_id.as_ref().filter(|s| !s.is_empty()) {
            session_of.insert(task.task_id.clone(), session.clone());
        }
    }
    let of_chain = |task: &str| task_ids.contains(task) || session_of.get(task).is_some_and(|s| sessions.contains(s));
    if pending.owed.iter().any(|r| r.task_id().is_none_or(|t| of_chain(&t))) {
        return true;
    }
    if pending.agent_tasks.iter().any(|t| t.running && of_chain(&t.task_id)) {
        return true;
    }
    if sessions.iter().any(|s| pending.working.contains(s) || pending.agent_task_owners.contains(s)) {
        return true;
    }
    pending.pool.iter().any(|row| sessions.contains(&text_of(row, "sessionId")) && has_pending_agent_work(row))
}

/// chainClosure: the chain's tasks, the Agent sessions they run in and every Agent session under
/// one. Never the Lead - work there may be another's.
pub(crate) fn closure_sessions(session_id: &str, task_ids: &HashSet<String>, pending: &Pending) -> HashSet<String> {
    let mut sessions = HashSet::new();
    let eligible = |id: &str| !id.is_empty() && id != session_id;
    for task in pending.agent_tasks.iter().filter(|t| task_ids.contains(&t.task_id)) {
        if let Some(id) = task.session_id.as_deref().filter(|id| eligible(id)) {
            sessions.insert(id.to_owned());
        }
    }
    for row in pending.pool.iter().filter(|r| task_ids.contains(&text_of(r, "taskId"))) {
        let id = text_of(row, "sessionId");
        if eligible(&id) {
            sessions.insert(id);
        }
    }
    let mut grown = true;
    while grown {
        grown = false;
        for row in &pending.pool {
            let (parent, id) = (text_of(row, "parentSessionId"), text_of(row, "sessionId"));
            if sessions.contains(&parent) && eligible(&id) && sessions.insert(id) {
                grown = true;
            }
        }
    }
    sessions
}
