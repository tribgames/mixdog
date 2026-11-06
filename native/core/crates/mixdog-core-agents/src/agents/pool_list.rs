//! `agent/pool/list`: the Agents pool the desktop host publishes, as Node builds it.
//!
//! Node reads the durable worker indexes (`store-agent-worker-rows.mjs` `listStoredAgentWorkersAsync`),
//! assembles the child and Lead rows (`store-agent-worker-pool.mjs`) and then lays the live state of
//! the daemon over them (`agent-pool-progress.mjs`, chained by `daemon-desktop-runtime.mjs`). The
//! durable side is [`PoolStore`] and the live side [`PoolLive`]; this module is the projection
//! between them, with every status word, stamp rule and row key Node's.
//!
//! The only state kept between listings is Node's `stickyIdleSince`: the first idle stamp seen for
//! a session, frozen until the session is seen working again.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::LazyLock;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_config::workflow::ids::truthy;
use mixdog_js::JsRegex;
use mixdog_js::time::date_parse;
use mixdog_js::js_trim;
use mixdog_js::json_number;
use mixdog_js::number_to_string;
use mixdog_js::string_to_number;
use mixdog_js::to_number_of;
use mixdog_js::value_to_string;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

type Row = Map<String, Value>;

const TAG_TOMBSTONE_TTL_MS: f64 = 7.0 * 24.0 * 60.0 * 60.0 * 1000.0;
const AGENT_PANE_VISIBLE_MS: f64 = 60.0 * 60.0 * 1000.0;
const STICKY_IDLE_CAP: usize = 512;
const TODO_STATUSES: [&str; 4] = ["pending", "in_progress", "completed", "abandoned"];
const IN_FLIGHT_STAGES: [&str; 5] = ["connecting", "requesting", "streaming", "tool_running", "cancelling"];
const SESSION_CANCEL_FIELDS: [&str; 7] = ["cancelStatus", "status", "state", "lastStatus", "stage", "outcome", "terminationReason"];

static WORKING: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new_static(r"^(?:connecting|requesting|streaming|tool[-_\s]?running|running|queued|pending|starting|cancelling)$", "i")
});
static CANCELLED: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(?:cancelled|canceled|killed)$", "i"));
static CANCEL_UNCONFIRMED: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(?:cancel[-_\s]?(?:unconfirmed|pending))$", "i"));
static FAILED: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(?:error|fail|failed|timeout)$", "i"));
static COMPLETED: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(?:idle|done|complete|completed|success)$", "i"));
static CANCEL_PREFIX: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^cancel", "i"));
static YEAR_PREFIX: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^\d{4}-", ""));
static STORED_ID: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^[A-Za-z0-9_-]+$", ""));

/// The header fields the pool reads of a worker session record (`WORKER_HEADER_FIELDS`).
pub const HEADER_FIELDS: [&str; 33] = [
    "owner",
    "agent",
    "sourceType",
    "ownerSessionId",
    "parentSessionId",
    "title",
    "provider",
    "model",
    "effort",
    "fast",
    "autoEffort",
    "createdAt",
    "updatedAt",
    "cwd",
    "clientHostPid",
    "agentTag",
    "task_id",
    "taskId",
    "turnStartedAt",
    "startedAt",
    "cancelledAt",
    "finishedAt",
    "totalInputTokens",
    "totalOutputTokens",
    "totalToolCalls",
    "todo",
    "cancelStatus",
    "status",
    "state",
    "lastStatus",
    "stage",
    "outcome",
    "terminationReason",
];

/// A listing Node's code throws on: its message.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct PoolError(pub String);

/// The durable side: both worker indexes (parsed JSON, `None` when absent or malformed) and the
/// session record headers (the [`HEADER_FIELDS`] of each record; `None` without a readable record).
#[async_trait]
pub trait PoolStore: Send + Sync {
    async fn agent_index(&self) -> Option<Value>;
    async fn lead_index(&self) -> Option<Value>;
    /// One answer per id, in order.
    async fn headers(&self, session_ids: &[String]) -> Vec<Option<Row>>;
}

/// A runtime entry of a session this daemon runs (`runtimeState`): its liveness record and whether
/// its turn holds a controller that has not been aborted.
#[derive(Debug, Clone, Default)]
pub struct RuntimeEntry {
    pub liveness: Row,
    pub controller_live: bool,
}

impl RuntimeEntry {
    /// `isTurnInFlight(entry)`.
    fn in_flight(&self) -> bool {
        if self.liveness.get("closed") == Some(&Value::Bool(true)) {
            return false;
        }
        self.controller_live || self.liveness.get("stage").and_then(Value::as_str).is_some_and(|stage| IN_FLIGHT_STAGES.contains(&stage))
    }
}

/// The live side: this daemon's own turn activity, sessions and ledger.
pub trait PoolLive: Send + Sync {
    /// `Date.now()`.
    fn now(&self) -> f64;
    /// `inFlightSessionActivity().working`.
    fn running(&self) -> HashSet<String>;
    /// `activeBackgroundTaskSessionIds({ surface: 'shell', awaitedOnly: true })`.
    fn awaiting_shell(&self) -> HashSet<String>;
    /// The live session record of `session_id` (`_liveSessions.get`), when this process holds one.
    fn live_session(&self, session_id: &str) -> Option<Value>;
    fn runtime_entry(&self, session_id: &str) -> Option<RuntimeEntry>;
    /// `groupUsageTokens(groups)`: owner to the ledger token known for its group.
    fn ledger_tokens(&self, groups: &[(String, Vec<String>)]) -> HashMap<String, String>;
    /// `resolveAgentStallThresholds(agent).warn * 1000`.
    fn stall_warn_ms(&self, agent: Option<&str>) -> f64;
}

pub struct AgentPool {
    store: Arc<dyn PoolStore>,
    live: Arc<dyn PoolLive>,
    idle_since: Mutex<Row>,
}

// ---- Node's small coercions -----------------------------------------------------------------

/// `cleanValue(value)`: `String(value || '').trim()`.
fn clean_value(value: Option<&Value>) -> String {
    if !truthy(value) {
        return String::new();
    }
    value.map_or_else(String::new, |value| js_trim(&value_to_string(value)).to_owned())
}

/// `clean(value)`: `String(value ?? '').trim()`.
fn clean_nullish(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => js_trim(&value_to_string(value)).to_owned(),
    }
}

/// `a || b || …`: the first truthy operand, the last one otherwise.
fn first_truthy<'a>(values: &[Option<&'a Value>]) -> Option<&'a Value> {
    values.iter().copied().find(|value| truthy(*value)).flatten().or_else(|| values.last().copied().flatten())
}

/// `a || b || … || null` as a JSON value.
fn or_null(values: &[Option<&Value>]) -> Value {
    values.iter().copied().find(|value| truthy(*value)).and_then(|value| value).cloned().unwrap_or(Value::Null)
}

fn text_or_null(text: String) -> Value {
    if text.is_empty() { Value::Null } else { Value::String(text) }
}

fn get<'a>(row: &'a Value, key: &str) -> Option<&'a Value> {
    row.as_object().and_then(|row| row.get(key))
}

fn is_stored_id(id: &str) -> bool {
    STORED_ID.is_match(id)
}

/// `positiveNumber(value, 0)`.
fn positive_number(value: Option<&Value>) -> f64 {
    let number = to_number_of(value);
    if number.is_finite() && number > 0.0 { number } else { 0.0 }
}

/// `positiveInt(value) || 0`.
fn positive_int(value: Option<&Value>) -> f64 {
    let floored = to_number_of(value).floor();
    if floored.is_finite() && floored >= 1.0 { floored } else { 0.0 }
}

fn stamp_ms(value: Option<&Value>) -> f64 {
    let positive = |n: f64| if n.is_finite() && n > 0.0 { n } else { 0.0 };
    if let Some(Value::Number(number)) = value {
        return positive(number.as_f64().unwrap_or(f64::NAN));
    }
    let text = clean_value(value);
    if text.is_empty() {
        return 0.0;
    }
    let numeric = string_to_number(&text);
    if numeric.is_finite() && numeric > 0.0 && !YEAR_PREFIX.is_match(&text) {
        return numeric;
    }
    positive(date_parse(&text))
}

/// `oneLine(value)`: whitespace runs folded to one space.
fn one_line(value: Option<&Value>) -> String {
    let text = match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => value_to_string(value),
    };
    mixdog_js::js_words(&text).collect::<Vec<_>>().join(" ")
}

/// `Object.values(workers)` / the list: a worker index stores its rows either way.
fn worker_rows(index: Option<&Value>) -> Vec<Value> {
    let Some(workers) = index.and_then(|index| get(index, "workers")) else {
        return Vec::new();
    };
    match workers {
        Value::Array(rows) => rows.clone(),
        Value::Object(map) => mixdog_js::js_object_keys(map).into_iter().map(|key| map[key].clone()).collect(),
        _ => Vec::new(),
    }
}

fn status_is(pattern: &JsRegex, text: &str) -> bool {
    pattern.is_match(text)
}

/// `workerLifecycle(row)`: `status` decides, a row without one falls back to its stage.
fn lifecycle(row: &Row) -> String {
    let status = clean_value(row.get("status"));
    if status.is_empty() { clean_value(row.get("stage")) } else { status }
}

// ---- todo and usage -------------------------------------------------------------------------

/// `todoProgress(session)` over the session's `todo` record: `{ completed, total, current? }`.
/// The stored record is untrusted: a task needs an object with wording, a phase at least one task.
fn todo_progress(todo: Option<&Value>) -> Option<Value> {
    let record = todo.filter(|record| record.is_object() || record.is_array())?;
    let phases: Vec<Vec<(String, &str)>> = get(record, "phases")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|phase| {
            get(phase, "tasks")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|raw| raw.is_object())
                .filter_map(|raw| {
                    let content = one_line(get(raw, "content"));
                    let status = get(raw, "status").and_then(Value::as_str).filter(|status| TODO_STATUSES.contains(status)).unwrap_or("pending");
                    (!content.is_empty()).then_some((content, status))
                })
                .collect::<Vec<_>>()
        })
        .filter(|tasks| !tasks.is_empty())
        .collect();
    let tasks: Vec<&(String, &str)> = phases.iter().flatten().collect();
    if tasks.is_empty() {
        return None;
    }
    let count = |wanted: &str| tasks.iter().filter(|task| task.1 == wanted).count();
    let mut out = Row::new();
    out.insert("completed".into(), json!(count("completed")));
    out.insert("total".into(), json!(tasks.len() - count("abandoned")));
    if let Some(task) = tasks.iter().find(|task| task.1 == "in_progress") {
        out.insert("current".into(), Value::String(task.0.clone()));
    }
    Some(Value::Object(out))
}
/// `sessionUsageTotals(session)`: the counters the session persists; one it never recorded is unknown.
fn usage_totals(session: Option<&Row>) -> (Option<Value>, Option<Value>) {
    let counter = |key: &str| -> Option<f64> {
        match session?.get(key)? {
            Value::Number(number) => number.as_f64().filter(|n| n.is_finite() && *n >= 0.0),
            _ => None,
        }
    };
    let (input, output) = (counter("totalInputTokens"), counter("totalOutputTokens"));
    let usage = (input.is_some() || output.is_some()).then(|| {
        let (input, output) = (input.unwrap_or(0.0), output.unwrap_or(0.0));
        json!({ "inputTokens": json_number(input), "outputTokens": json_number(output), "totalTokens": json_number(input + output) })
    });
    (usage, counter("totalToolCalls").map(json_number))
}

// ---- cancel and stamps ----------------------------------------------------------------------

fn work_stamp(source: Option<&Row>) -> f64 {
    source.map_or(0.0, |source| stamp_ms(source.get("turnStartedAt")).max(stamp_ms(source.get("startedAt"))))
}

fn cancel_stamp(source: Option<&Row>) -> f64 {
    source.map_or(0.0, |source| stamp_ms(source.get("cancelledAt")).max(stamp_ms(source.get("finishedAt"))))
}

/// `finishedAtMs(row, session)`.
fn finished_at(row: &Row, session: Option<&Row>) -> f64 {
    [cancel_stamp(Some(row)), stamp_ms(row.get("updatedAt")), cancel_stamp(session), session.map_or(0.0, |s| stamp_ms(s.get("updatedAt")))]
        .into_iter()
        .find(|stamp| *stamp != 0.0)
        .unwrap_or(0.0)
}

struct Cancel {
    status: String,
    at: f64,
}

fn cancel_state(source: Option<&Row>) -> Option<Cancel> {
    let source = source?;
    let statuses: Vec<String> = SESSION_CANCEL_FIELDS.iter().map(|key| clean_value(source.get(*key))).filter(|status| !status.is_empty()).collect();
    let status = statuses
        .iter()
        .find(|status| status_is(&CANCEL_UNCONFIRMED, status))
        .or_else(|| statuses.iter().find(|status| status_is(&CANCELLED, status)))?;
    Some(Cancel { status: status.clone(), at: cancel_stamp(Some(source)) })
}

/// `effectiveCancel(row, session)`: the cancel that still holds across the index row and the header.
fn effective_cancel(row: &Row, session: Option<&Row>) -> Option<Cancel> {
    let row_cancel = cancel_state(Some(row));
    let session_cancel = cancel_state(session);
    let cancel = match (row_cancel, session_cancel) {
        (Some(row_cancel), Some(session_cancel)) if status_is(&CANCEL_UNCONFIRMED, &session_cancel.status) => {
            if status_is(&CANCEL_UNCONFIRMED, &row_cancel.status) { row_cancel } else { session_cancel }
        }
        (row_cancel, session_cancel) => row_cancel.or(session_cancel)?,
    };
    let newer_work = cancel.at > 0.0 && work_stamp(Some(row)).max(work_stamp(session)) > cancel.at;
    (!newer_work).then_some(cancel)
}

fn cancel_stage(cancel: &Cancel, declared_stage: &str) -> String {
    if status_is(&CANCEL_PREFIX, declared_stage) || status_is(&CANCELLED, declared_stage) {
        declared_stage.to_owned()
    } else {
        cancel.status.clone()
    }
}

fn pane_visible(finished_at: f64, now: f64) -> bool {
    finished_at.is_nan() || finished_at <= 0.0 || now - finished_at < AGENT_PANE_VISIBLE_MS
}

// ---- owner links ----------------------------------------------------------------------------

fn owner_session_id(row: &Row, session: Option<&Row>) -> Value {
    let session_get = |key: &str| session.and_then(|session| session.get(key));
    text_or_null(clean_value(first_truthy(&[row.get("ownerSessionId"), session_get("ownerSessionId"), row.get("parentSessionId"), session_get("parentSessionId")])))
}

fn parent_session_id(row: &Row, session: Option<&Row>) -> Value {
    let session_get = |key: &str| session.and_then(|session| session.get(key));
    text_or_null(clean_value(first_truthy(&[row.get("parentSessionId"), session_get("parentSessionId"), row.get("ownerSessionId"), session_get("ownerSessionId")])))
}

fn lower(value: Option<&Value>) -> String {
    clean_value(value).to_lowercase()
}

// ---- tombstones -----------------------------------------------------------------------------

fn tombstone_key(row: &Row) -> String {
    let parent = clean_nullish(first_truthy(&[row.get("parentSessionId"), row.get("ownerSessionId")]));
    let tag = clean_nullish(row.get("tag"));
    if parent.is_empty() {
        format!("{}\0{tag}", number_to_string(positive_int(row.get("clientHostPid"))))
    } else {
        format!("session:{parent}\0{tag}")
    }
}

fn find_tombstone<'a>(work: &Row, tombstones: &'a HashMap<String, Row>) -> Option<&'a Row> {
    let tag = clean_nullish(first_truthy(&[work.get("tag"), work.get("agentTag")]));
    let parent = clean_nullish(first_truthy(&[work.get("parentSessionId"), work.get("ownerSessionId")]));
    (!parent.is_empty())
        .then(|| tombstones.get(&format!("session:{parent}\0{tag}")))
        .flatten()
        .or_else(|| tombstones.get(&format!("{}\0{tag}", number_to_string(positive_int(work.get("clientHostPid"))))))
}

fn tombstone_blocks(work: &Row, tombstone: Option<&Row>) -> bool {
    let reaped_at = stamp_ms(tombstone.and_then(|tombstone| tombstone.get("reapedAt")));
    reaped_at != 0.0 && stamp_ms(work.get("createdAt")).max(stamp_ms(work.get("turnStartedAt"))) <= reaped_at
}

// ---- the assembly ---------------------------------------------------------------------------

type Headers = HashMap<String, Option<Row>>;

struct Assembly<'a> {
    now: f64,
    running: &'a HashSet<String>,
    headers: &'a Headers,
    idle_since: &'a mut Row,
}

impl Assembly<'_> {
    fn header(&self, session_id: &str) -> Option<&Row> {
        self.headers.get(session_id).and_then(Option::as_ref)
    }

    /// `frozenIdleSince`: the first observation freezes the fallback; a row seen working clears it.
    fn frozen_idle_since(&mut self, session_id: &str, working: bool, fallback: Value) -> Value {
        if working {
            self.idle_since.shift_remove(session_id);
            return Value::Null;
        }
        if let Some(kept) = self.idle_since.get(session_id) {
            return kept.clone();
        }
        self.idle_since.insert(session_id.to_owned(), fallback.clone());
        if self.idle_since.len() > STICKY_IDLE_CAP
            && let Some(oldest) = self.idle_since.keys().next().cloned()
        {
            self.idle_since.shift_remove(&oldest);
        }
        fallback
    }

    fn project_child(&mut self, row: &Value) -> Option<Row> {
        let row = row.as_object()?;
        if lower(row.get("agent")) == "lead" {
            return None;
        }
        let session_id = clean_value(row.get("sessionId"));
        let tag = clean_value(row.get("tag"));
        if session_id.is_empty() || tag.is_empty() || !is_stored_id(&session_id) {
            return None;
        }
        let session = self.header(&session_id).cloned();
        let session = session.as_ref();
        let session_get = |key: &str| session.and_then(|session| session.get(key));
        let todo = todo_progress(session_get("todo"));
        let declared_status = Some(clean_value(row.get("status"))).filter(|s| !s.is_empty()).unwrap_or_else(|| "running".into());
        let declared_stage = Some(clean_value(first_truthy(&[row.get("stage"), row.get("status")]))).filter(|s| !s.is_empty()).unwrap_or_else(|| "running".into());
        let life = lifecycle(row);
        let declared_working = status_is(&WORKING, if life.is_empty() { "running" } else { &life });
        let cancel = effective_cancel(row, session);
        let working = cancel.is_none() && self.running.contains(&session_id);
        let completed = status_is(&COMPLETED, &life);
        let unconfirmed_cancel = cancel.as_ref().is_some_and(|cancel| status_is(&CANCEL_UNCONFIRMED, &cancel.status));
        if !working && !unconfirmed_cancel && (cancel.is_some() || !declared_working) {
            if cancel.is_none() && !completed && !status_is(&FAILED, &life) {
                return None;
            }
            if !pane_visible(finished_at(row, session), self.now) {
                return None;
            }
        }
        let mut shown_status = declared_status.clone();
        let mut shown_stage = declared_stage.clone();
        if let Some(cancel) = &cancel {
            shown_status = cancel.status.clone();
            shown_stage = cancel_stage(cancel, &declared_stage);
        } else if working {
            if !declared_working {
                shown_status = "running".into();
                shown_stage = "running".into();
            }
        } else if declared_working {
            shown_status = "unknown".into();
            shown_stage = "unknown".into();
        } else if completed {
            shown_status = "completed".into();
            shown_stage = "completed".into();
        }
        let failed = status_is(&FAILED, &life);
        let mut out = Row::new();
        out.insert("tag".into(), json!(tag));
        out.insert("sessionId".into(), json!(session_id));
        out.insert("ownerSessionId".into(), owner_session_id(row, session));
        out.insert("parentSessionId".into(), parent_session_id(row, session));
        out.insert("title".into(), text_or_null(clean_value(first_truthy(&[row.get("title"), session_get("title")]))));
        out.insert("agent".into(), text_or_null(clean_value(first_truthy(&[row.get("agent"), session_get("agent")]))));
        out.insert("provider".into(), text_or_null(clean_value(first_truthy(&[row.get("provider"), session_get("provider")]))));
        out.insert("model".into(), text_or_null(clean_value(first_truthy(&[row.get("model"), session_get("model")]))));
        out.insert("effort".into(), text_or_null(clean_value(first_truthy(&[row.get("effort"), session_get("effort")]))));
        out.insert("fast".into(), Value::Bool(row.get("fast") == Some(&Value::Bool(true)) || session_get("fast") == Some(&Value::Bool(true))));
        if row.get("autoEffort") == Some(&Value::Bool(false)) || session_get("autoEffort") == Some(&Value::Bool(false)) {
            out.insert("autoEffort".into(), Value::Bool(false));
        }
        out.insert("status".into(), json!(shown_status));
        out.insert("stage".into(), json!(shown_stage));
        if working && row.get("awaitingUser").and_then(Value::as_str) == Some("approval") {
            out.insert("awaitingUser".into(), json!("approval"));
        }
        if !working && row.get("released") == Some(&Value::Bool(true)) {
            out.insert("released".into(), Value::Bool(true));
        }
        if !working && failed {
            let reason = clean_value(row.get("failureReason"));
            if !reason.is_empty() {
                out.insert("failureReason".into(), Value::String(reason));
            }
        }
        out.insert("startedAt".into(), or_null(&[row.get("startedAt"), row.get("createdAt"), session_get("createdAt")]));
        out.insert("turnStartedAt".into(), if working { or_null(&[row.get("turnStartedAt")]) } else { Value::Null });
        out.insert("createdAt".into(), or_null(&[row.get("createdAt"), session_get("createdAt")]));
        out.insert("updatedAt".into(), or_null(&[row.get("updatedAt"), session_get("updatedAt")]));
        let idle = self.frozen_idle_since(&session_id, working, or_null(&[row.get("finishedAt"), row.get("updatedAt"), session_get("updatedAt")]));
        out.insert("idleSince".into(), idle);
        out.insert("reapAt".into(), or_null(&[row.get("reapAt")]));
        out.insert("cwd".into(), text_or_null(clean_value(first_truthy(&[row.get("cwd"), session_get("cwd")]))));
        out.insert("clientHostPid".into(), pid(first_truthy(&[row.get("clientHostPid"), session_get("clientHostPid")])));
        out.insert("taskId".into(), text_or_null(clean_value(first_truthy(&[row.get("task_id"), row.get("taskId")]))));
        let (usage, tool_calls) = usage_totals(session);
        out.insert("usage".into(), usage.unwrap_or(Value::Null));
        out.insert("toolCalls".into(), tool_calls.unwrap_or(Value::Null));
        if let Some(todo) = todo {
            out.insert("todo".into(), todo);
        }
        Some(out)
    }

    fn project_lead(&mut self, row: &Value) -> Option<Row> {
        let row = row.as_object()?;
        let session_id = clean_value(row.get("sessionId"));
        if session_id.is_empty() || !is_stored_id(&session_id) {
            return None;
        }
        let header = self.header(&session_id).cloned();
        let owner = lower(header.as_ref().and_then(|header| header.get("owner")));
        let agent = lower(header.as_ref().and_then(|header| header.get("agent")));
        if owner == "agent" || (!agent.is_empty() && agent != "lead") {
            return None;
        }
        let life = lifecycle(row);
        let declared_status = if life.is_empty() { "idle".to_owned() } else { life };
        let declared_working = status_is(&WORKING, &declared_status);
        let cancel = effective_cancel(row, None);
        let working = cancel.is_none() && self.running.contains(&session_id);
        if !working && !pane_visible(finished_at(row, None), self.now) {
            return None;
        }
        let shown = if let Some(cancel) = &cancel {
            cancel.status.clone()
        } else if working {
            if declared_working { declared_status } else { "running".into() }
        } else if declared_working {
            "unknown".into()
        } else {
            declared_status
        };
        let mut out = Row::new();
        out.insert("tag".into(), json!(format!("lead:{session_id}")));
        out.insert("sessionId".into(), json!(session_id));
        out.insert("ownerSessionId".into(), json!(session_id));
        out.insert("parentSessionId".into(), Value::Null);
        out.insert("agent".into(), json!("lead"));
        for key in ["provider", "model", "effort"] {
            out.insert(key.into(), text_or_null(clean_value(row.get(key))));
        }
        out.insert("fast".into(), Value::Bool(row.get("fast") == Some(&Value::Bool(true))));
        if row.get("autoEffort") == Some(&Value::Bool(false)) {
            out.insert("autoEffort".into(), Value::Bool(false));
        }
        out.insert("status".into(), json!(shown));
        out.insert("stage".into(), json!(shown));
        out.insert("startedAt".into(), or_null(&[row.get("startedAt"), row.get("createdAt")]));
        out.insert("turnStartedAt".into(), if working { or_null(&[row.get("turnStartedAt")]) } else { Value::Null });
        out.insert("createdAt".into(), or_null(&[row.get("createdAt")]));
        out.insert("updatedAt".into(), or_null(&[row.get("updatedAt")]));
        let idle = self.frozen_idle_since(&session_id, working, or_null(&[row.get("finishedAt"), row.get("updatedAt")]));
        out.insert("idleSince".into(), idle);
        out.insert("cwd".into(), text_or_null(clean_value(row.get("cwd"))));
        out.insert("clientHostPid".into(), pid(row.get("clientHostPid")));
        out.insert("taskId".into(), text_or_null(clean_value(first_truthy(&[row.get("task_id"), row.get("taskId")]))));
        let (usage, tool_calls) = usage_totals(header.as_ref());
        out.insert("usage".into(), usage.unwrap_or(Value::Null));
        out.insert("toolCalls".into(), tool_calls.unwrap_or(Value::Null));
        Some(out)
    }

    /// A child row is a projection of its Lead: once the Lead's row is gone it is dropped, unless
    /// it is still working or its owner is not a Lead conversation.
    fn prune_orphans(&self, by_session: &mut Row, live_leads: &HashSet<String>) {
        let snapshot: Vec<(String, Row)> =
            by_session.iter().filter_map(|(id, row)| row.as_object().map(|row| (id.clone(), row.clone()))).collect();
        for (session_id, row) in snapshot {
            if lower(row.get("agent")) == "lead" {
                continue;
            }
            let owner = clean_value(row.get("ownerSessionId"));
            if owner.is_empty() || live_leads.contains(&owner) {
                continue;
            }
            let header = self.header(&owner);
            let lead_conversation = header.is_some_and(|header| {
                lower(header.get("owner")) != "agent" && (lower(header.get("agent")) == "lead" || lower(header.get("sourceType")) == "lead")
            });
            if !lead_conversation || status_is(&WORKING, &lifecycle(&row)) {
                continue;
            }
            by_session.shift_remove(&session_id);
        }
    }
}

/// `positiveNumber(value, 0) || null`.
fn pid(value: Option<&Value>) -> Value {
    let number = positive_number(value);
    if number == 0.0 { Value::Null } else { json_number(number) }
}

impl AgentPool {
    pub fn new(store: Arc<dyn PoolStore>, live: Arc<dyn PoolLive>) -> Self {
        Self { store, live, idle_since: Mutex::new(Row::new()) }
    }

    /// `listStoredAgentWorkersAsync` laid over by the daemon's live state, rows in Node's order.
    pub async fn list(&self) -> Result<Vec<Value>, PoolError> {
        let (agent_index, lead_index) = (self.store.agent_index().await, self.store.lead_index().await);
        let child_rows = worker_rows(agent_index.as_ref());
        let mut ids: Vec<String> = Vec::new();
        let want = |ids: &mut Vec<String>, id: String| {
            if !id.is_empty() && !ids.contains(&id) {
                ids.push(id);
            }
        };
        for row in &child_rows {
            want(&mut ids, clean_value(get(row, "sessionId")));
        }
        for row in worker_rows(lead_index.as_ref()) {
            let id = clean_value(get(&row, "sessionId"));
            if is_stored_id(&id) {
                want(&mut ids, id);
            }
        }
        let mut headers = Headers::new();
        for (id, header) in ids.iter().zip(self.store.headers(&ids).await) {
            headers.insert(id.clone(), header);
        }
        let mut owners: Vec<String> = Vec::new();
        for row in &child_rows {
            let Some(object) = row.as_object() else { continue };
            let header = headers.get(&clean_value(object.get("sessionId"))).and_then(Option::as_ref);
            if let Value::String(owner) = owner_session_id(object, header) {
                want(&mut owners, owner);
            }
        }
        owners.retain(|owner| !headers.contains_key(owner));
        for (id, header) in owners.iter().zip(self.store.headers(&owners).await) {
            headers.insert(id.clone(), header);
        }
        let running = self.live.running();
        let rows = self.assemble(&child_rows, agent_index.as_ref(), lead_index.as_ref(), &running, &headers)?;
        Ok(self.lay_live(rows))
    }

    fn assemble(&self, child_rows: &[Value], agent_index: Option<&Value>, lead_index: Option<&Value>, running: &HashSet<String>, headers: &Headers) -> Result<Vec<Value>, PoolError> {
        let now = self.live.now();
        let mut by_id: HashMap<String, &Value> = HashMap::new();
        for row in child_rows {
            if row.is_null() {
                return Err(PoolError("Cannot read properties of null (reading 'sessionId')".into()));
            }
            by_id.insert(clean_value(get(row, "sessionId")), row);
        }
        let tombstones = agent_index.and_then(|index| get(index, "tombstones")).map(tombstone_rows).unwrap_or_default();
        let tombstones: HashMap<String, Row> = tombstones
            .into_iter()
            .filter(|row| stamp_ms(row.get("reapedAt")) >= now - TAG_TOMBSTONE_TTL_MS)
            .map(|row| (tombstone_key(&row), row))
            .collect();
        let header_of = |id: &str| headers.get(id).and_then(Option::as_ref);
        let is_reaped = |session_id: &str| {
            let header = header_of(session_id);
            let row = by_id.get(session_id).and_then(|row| row.as_object());
            let mut work = header.cloned().unwrap_or_default();
            if let Some(row) = row {
                for (key, value) in row {
                    work.insert(key.clone(), value.clone());
                }
            }
            let empty = Row::new();
            let (row_ref, header_ref) = (row.unwrap_or(&empty), header);
            work.insert("parentSessionId".into(), parent_session_id(row_ref, header_ref));
            work.insert("ownerSessionId".into(), owner_session_id(row_ref, header_ref));
            let header_get = |key: &str| header.and_then(|header| header.get(key));
            for key in ["clientHostPid", "createdAt", "turnStartedAt"] {
                match first_truthy(&[row_ref.get(key), header_get(key)]) {
                    Some(value) => work.insert(key.into(), value.clone()),
                    None => work.shift_remove(key),
                };
            }
            tombstone_blocks(&work, find_tombstone(&work, &tombstones))
        };
        let mut idle_since = self.idle_since.lock().unwrap_or_else(|e| e.into_inner());
        let mut pass = Assembly { now, running, headers, idle_since: &mut idle_since };
        let mut by_session = Row::new();
        for row in child_rows.iter().filter(|row| !is_reaped(&clean_value(get(row, "sessionId")))) {
            if let Some(projected) = pass.project_child(row) {
                let id = clean_value(projected.get("sessionId"));
                by_session.insert(id, Value::Object(projected));
            }
        }
        let mut live_leads = HashSet::new();
        for row in worker_rows(lead_index) {
            let Some(projected) = pass.project_lead(&row) else { continue };
            let id = clean_value(projected.get("sessionId"));
            live_leads.insert(id.clone());
            by_session.insert(id, Value::Object(projected));
        }
        pass.prune_orphans(&mut by_session, &live_leads);
        let mut rows: Vec<Value> = by_session.into_iter().map(|(_, row)| row).collect();
        let start = |row: &Value| {
            let parsed = date_parse(&if truthy(get(row, "startedAt")) { string_of(get(row, "startedAt")) } else { String::new() });
            if parsed.is_nan() { 0.0 } else { parsed }
        };
        mixdog_js::js_sort_by(&mut rows, |left, right| {
            let by_time = start(left) - start(right);
            if by_time != 0.0 {
                return by_time;
            }
            match mixdog_js::locale_compare(&clean_nullish(get(left, "tag")), &clean_nullish(get(right, "tag"))) {
                std::cmp::Ordering::Less => -1.0,
                std::cmp::Ordering::Equal => 0.0,
                std::cmp::Ordering::Greater => 1.0,
            }
        });
        Ok(rows)
    }

    /// `withLiveTodo`, `withLiveUsage`, `withLedgerToken` and `withTurnProgress`, in Node's order.
    fn lay_live(&self, rows: Vec<Value>) -> Vec<Value> {
        let mut rows: Vec<Row> = rows.into_iter().filter_map(|row| if let Value::Object(row) = row { Some(row) } else { None }).collect();
        let sessions: Vec<Option<Value>> = rows.iter().map(|row| self.live_of(row)).collect();
        for (row, live) in rows.iter_mut().zip(&sessions) {
            let Some(live) = live else { continue };
            row.shift_remove("todo");
            if let Some(todo) = todo_progress(live.get("todo")) {
                row.insert("todo".into(), todo);
            }
        }
        for (row, live) in rows.iter_mut().zip(&sessions) {
            let Some(live) = live else { continue };
            let (usage, tool_calls) = usage_totals(live.as_object());
            if let Some(usage) = usage {
                row.insert("usage".into(), usage);
            }
            if let Some(tool_calls) = tool_calls {
                row.insert("toolCalls".into(), tool_calls);
            }
        }
        let mut groups: Vec<(String, Vec<String>)> = Vec::new();
        for row in &rows {
            let (owner, id) = (clean_member(row.get("ownerSessionId")), clean_member(row.get("sessionId")));
            let (Some(owner), Some(id)) = (owner, id) else { continue };
            let at = groups.iter().position(|(name, _)| *name == owner).unwrap_or_else(|| {
                groups.push((owner.clone(), vec![owner.clone()]));
                groups.len() - 1
            });
            if !groups[at].1.contains(&id) {
                groups[at].1.push(id);
            }
        }
        let tokens = self.live.ledger_tokens(&groups);
        for row in &mut rows {
            let token = row.get("ownerSessionId").and_then(Value::as_str).and_then(|owner| tokens.get(owner));
            if let Some(token) = token {
                row.insert("ledgerToken".into(), Value::String(token.clone()));
            }
        }
        let awaiting = self.live.awaiting_shell();
        rows.into_iter().map(|row| Value::Object(self.with_progress(row, &awaiting))).collect()
    }

    fn live_of(&self, row: &Row) -> Option<Value> {
        row.get("sessionId").and_then(Value::as_str).filter(|id| !id.is_empty()).and_then(|id| self.live.live_session(id))
    }

    fn with_progress(&self, mut row: Row, awaiting: &HashSet<String>) -> Row {
        let session_id = row.get("sessionId").and_then(Value::as_str).unwrap_or("").to_owned();
        let entry = self.live.runtime_entry(&session_id).filter(RuntimeEntry::in_flight);
        let Some(entry) = entry else {
            if !session_id.is_empty() && awaiting.contains(&session_id) {
                row.insert("awaitingTask".into(), json!("background"));
            }
            return row;
        };
        let liveness = &entry.liveness;
        let number = |key: &str| {
            let value = to_number_of(liveness.get(key));
            if value.is_nan() || value == 0.0 { 0.0 } else { value }
        };
        let stage = liveness.get("stage").and_then(Value::as_str);
        let ask_started = number("askStartedAt");
        let row_start = {
            let direct = to_number_of(row.get("turnStartedAt"));
            if direct.is_nan() || direct == 0.0 {
                let parsed = date_parse(&string_of(row.get("turnStartedAt")));
                if parsed.is_nan() { 0.0 } else { parsed }
            } else {
                direct
            }
        };
        if ask_started > row_start && let Some(started) = iso(ask_started) {
            row.insert("turnStartedAt".into(), Value::String(started));
        }
        if to_number_of(liveness.get("taskWaits")) > 0.0 {
            row.insert("awaitingTask".into(), json!("wait"));
        }
        let progress_at = number("lastProgressAt").max(number("lastStreamDeltaAt")).max(number("toolStartedAt")).max(ask_started);
        row.insert("progressAt".into(), if progress_at == 0.0 { Value::Null } else { json_number(progress_at) });
        let sent_at = number("requestSentAt");
        let awaiting_model = stage == Some("requesting") && sent_at > 0.0 && (number("lastTransportAt").is_nan() || number("lastTransportAt") < sent_at);
        row.insert("progressStage".into(), if awaiting_model { json!("model_thinking") } else { stage.map_or(Value::Null, |stage| json!(stage)) });
        let tool = if stage == Some("tool_running") { or_null(&[liveness.get("lastToolCall")]) } else { Value::Null };
        row.insert("progressTool".into(), tool);
        row.insert("stallWarnMs".into(), json_number(self.live.stall_warn_ms(row.get("agent").and_then(Value::as_str))));
        row
    }
}

/// `String(value)` of a possibly absent value (`undefined` reads as the text `undefined`).
fn string_of(value: Option<&Value>) -> String {
    value.map_or_else(|| "undefined".into(), value_to_string)
}

/// A truthy string member of a row (`row?.ownerSessionId`, `row.sessionId`).
fn clean_member(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).filter(|text| !text.is_empty()).map(str::to_owned)
}

fn tombstone_rows(tombstones: &Value) -> Vec<Row> {
    match tombstones {
        Value::Object(map) => mixdog_js::js_object_keys(map).into_iter().filter_map(|key| map[key].as_object().cloned()).collect(),
        Value::Array(items) => items.iter().filter_map(|item| item.as_object().cloned()).collect(),
        _ => Vec::new(),
    }
}

/// `new Date(ms).toISOString()`; `None` where Node's throws (not a time).
fn iso(ms: f64) -> Option<String> {
    let fields = mixdog_js::time::local_fields_in(mixdog_js::time::Tz::UTC, ms)?;
    Some(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        fields.year, fields.month, fields.day, fields.hour, fields.minute, fields.second, fields.millisecond
    ))
}