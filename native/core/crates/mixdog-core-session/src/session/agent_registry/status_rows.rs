//! The agents section of a thread's state (`thread/agents/updated`): what the agent tool's
//! `getStatus` answers (`agent-tool.mjs statusFor`), the worker rows of `createAgentList(..)`
//! (`agent-list.mjs agentRow`) and the job rows of `createJobRender(..).listJobs`
//! (`job-render.mjs jobHead`, `session-progress.mjs jobWorkerSnapshot`), each through
//! `liveAgentStatusRow`, which drops what changes on every read (`silent_for`, `tool_silent_for`,
//! `staleSeconds`, `lastStreamDeltaAt`, `last_progress`, `diagnostic`) so a row is published only
//! when something a surface shows changed.
//!
//! The recorded Node run is `fixtures/agent/status/golden.json` (`record-agent-status.mjs`).

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::agent_tool::board::JobBoard;
use mixdog_agent::agent_tool::board::JobSnapshot;
use mixdog_agent::agent_tool::host::Registry;
use mixdog_agent::agent_tool::progress::Progress;
use mixdog_agent::agent_tool::progress::ProgressInput;
use mixdog_agent::agent_tool::progress::frozen_progress;
use mixdog_agent::agent_tool::progress::WatchdogPolicy;
use mixdog_agent::agent_tool::progress::progress_fields;
use mixdog_agent::agent_tool::watchdog::AgentKind;
use mixdog_agent::agent_tool::watchdog::Overrides;
use mixdog_agent::agent_tool::watchdog::resolve_policy;
use mixdog_core_config::config::hidden_agents::hidden_agent_stall_cap_idle_seconds;
use mixdog_core_config::config::hidden_agents::hidden_agent_traits;
use mixdog_agent::agent_tool::scope::Scope;
use mixdog_agent::agent_tool::scope::positive_int;
use mixdog_agent::agent_tool::stamp::iso_from_ms;
use mixdog_core_run::run_host::progress::WaitedJobs;
use mixdog_agent::agent_tool::views::WorkerLive;
use mixdog_agent::agent_tool::views::is_active_worker;
use mixdog_app_protocol::v2::thread::ThreadAgents;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_agents::agents::todo_progress;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::AgentRegistry;
use super::Row;
use crate::session::Clock;
use crate::session::SessionDirectory;
use crate::session::agent_activity::AgentStatus;

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(_) => true,
    }
}

/// `session.field || null`.
fn or_null(session: &Row, key: &str) -> Value {
    session.get(key).filter(|v| truthy(Some(v))).cloned().unwrap_or(Value::Null)
}

/// `counter(value)` of `sessionUsageTotals`: a finite number of at least zero, else unknown.
fn counter(session: &Row, key: &str) -> Option<f64> {
    session.get(key).and_then(Value::as_f64).filter(|n| n.is_finite() && *n >= 0.0)
}

fn number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9.0e15 { Value::from(n as i64) } else { Value::from(n) }
}

fn text(session: &Row, key: &str) -> Option<String> {
    session.get(key).filter(|v| truthy(Some(v))).map(mixdog_js::value_to_string)
}

/// `rowState`: a closed session reads `closed`; a stage of its own wins; an idle, errored or closed
/// status is its own stage; otherwise the runtime's.
pub(super) fn row_state(session: &Row, runtime_stage: Option<&str>) -> (String, String) {
    let status = if session.get("closed") == Some(&Value::Bool(true)) { "closed".to_owned() } else { text(session, "status").unwrap_or_else(|| "idle".to_owned()) };
    let stage = text(session, "stage").unwrap_or_else(|| {
        if matches!(status.as_str(), "idle" | "error" | "closed") {
            status.clone()
        } else {
            runtime_stage.filter(|s| !s.is_empty()).map_or_else(|| status.clone(), str::to_owned)
        }
    });
    (status, stage)
}

/// `resolveAgentWatchdogPolicy(role)` with no overrides, the internal role's own idle cap included.
fn resolve_role_policy(role: &str) -> WatchdogPolicy {
    let kind = AgentKind {
        name: Some(role),
        hidden: hidden_agent_traits(role).is_some(),
        stall_cap_idle_seconds: hidden_agent_stall_cap_idle_seconds(role),
    };
    resolve_policy(kind, Overrides::default(), &|name: &str| std::env::var(name).ok())
}

/// The role policies a status read uses (`session-progress.mjs rolePolicies`): a read never
/// resolves one itself. A role's first read finds none and has it resolved once the read is over
/// (Node's `setImmediate`); later reads use the resolved one.
#[derive(Default)]
pub struct RolePolicies {
    held: std::sync::Mutex<std::collections::HashMap<String, Option<WatchdogPolicy>>>,
}

impl RolePolicies {
    /// `rolePolicy(role, true)`; a role first seen is queued in `pending`.
    pub fn get(&self, role: &str, pending: &mut Vec<String>) -> Option<WatchdogPolicy> {
        let mut held = self.held.lock().unwrap();
        if let Some(policy) = held.get(role) {
            return *policy;
        }
        held.insert(role.to_owned(), None);
        pending.push(role.to_owned());
        None
    }

    /// `resolveRolePolicy(role)` for each role a read queued.
    pub fn resolve(&self, pending: Vec<String>) {
        for role in pending {
            let policy = resolve_role_policy(&role);
            self.held.lock().unwrap().insert(role, Some(policy));
        }
    }
}

/// `sessionProgressExtras(.., { loaded })`, the fields a status row keeps.
fn progress_of(session_status: Option<&str>, live: &WorkerLive, task_status: Option<&str>, now: i64) -> Progress {
    progress_fields(&ProgressInput {
        now,
        session_status,
        runtime_stage: live.runtime_stage.as_deref(),
        snapshot: live.snapshot.as_ref(),
        runtime: live.runtime.as_ref(),
        policy: live.policy,
        watchdog_state: Some(&live.watchdog_state),
        queued_followups: live.queued_followups,
        task_status,
        last_tool_call: live.runtime.as_ref().and_then(|r| r.last_tool_call.as_deref()),
        tool_silence: live.tool_silence.as_ref(),
    })
}

/// The progress fields `liveAgentStatusRow` leaves: `worker_stage`, `watchdog`, `queued_followups`.
fn put_progress(row: &mut Map<String, Value>, progress: &Progress) {
    row.insert("worker_stage".into(), json!(progress.worker_stage));
    if let Some(watchdog) = &progress.watchdog {
        row.insert("watchdog".into(), json!(watchdog));
    }
    if let Some(queued) = progress.queued_followups {
        row.insert("queued_followups".into(), json!(queued));
    }
}

/// What `agentRow` reads besides the session record.
pub struct WorkerStatus<'a> {
    pub tag: &'a str,
    pub session: &'a Row,
    pub live: &'a WorkerLive,
    /// `runtime.awaitingUser`, as the runtime holds it.
    pub awaiting_user: Option<Value>,
    /// `Array.isArray(session.messages) ? length : max(0, Number(messageCount || 0))`.
    pub messages: u64,
    /// The same for `tools` / `toolCount`.
    pub tools: u64,
    /// The worker index row's `turnStartedAt`.
    pub index_turn_started_at: Option<&'a str>,
    /// `todoProgress(liveSession)`, for a session this process holds.
    pub todo: Option<Value>,
    pub now: i64,
}

/// `liveAgentStatusRow(agentRow(..))`.
pub fn worker_status_row(input: &WorkerStatus<'_>) -> Map<String, Value> {
    let session = input.session;
    let (status, stage) = row_state(session, input.live.runtime_stage.as_deref());
    let mut row = Map::new();
    row.insert("tag".into(), json!(input.tag));
    row.insert("sessionId".into(), or_null(session, "id"));
    row.insert("agent".into(), or_null(session, "agent"));
    // `provider: session.provider`: a session without one leaves the key out of the published JSON.
    for key in ["provider", "model"] {
        if let Some(value) = session.get(key) {
            row.insert(key.into(), value.clone());
        }
    }
    row.insert("preset".into(), or_null(session, "presetName"));
    row.insert("effort".into(), or_null(session, "effort"));
    row.insert("fast".into(), json!(session.get("fast") == Some(&Value::Bool(true))));
    if session.get("autoEffort") == Some(&Value::Bool(false)) {
        row.insert("autoEffort".into(), json!(false));
    }
    if let Some(parameters) = session.get("modelParameters").and_then(Value::as_object).filter(|p| !p.is_empty()) {
        row.insert("modelParameters".into(), Value::Object(parameters.clone()));
    }
    row.insert("status".into(), json!(status));
    row.insert("stage".into(), json!(stage));
    if let Some(awaiting) = input.awaiting_user.as_ref().filter(|a| truthy(Some(a))) {
        row.insert("awaitingUser".into(), awaiting.clone());
    }
    let progress = progress_of(text(session, "status").as_deref(), input.live, None, input.now);
    put_progress(&mut row, &progress);
    for key in ["createdAt", "updatedAt", "lastUsedAt", "clientHostPid"] {
        row.insert(key.into(), or_null(session, key));
    }
    // `sessionUsageTotals`: a counter the session never recorded stays unknown, not zero.
    let (input_tokens, output_tokens) = (counter(session, "totalInputTokens"), counter(session, "totalOutputTokens"));
    row.insert(
        "usage".into(),
        if input_tokens.is_none() && output_tokens.is_none() {
            Value::Null
        } else {
            let (i, o) = (input_tokens.unwrap_or(0.0), output_tokens.unwrap_or(0.0));
            json!({ "inputTokens": number(i), "outputTokens": number(o), "totalTokens": number(i + o) })
        },
    );
    row.insert("toolCalls".into(), counter(session, "totalToolCalls").map_or(Value::Null, number));
    // `Number(lastContextTokens ?? lastInputTokens) || 0`.
    let window_tokens = session
        .get("lastContextTokens")
        .filter(|v| !v.is_null())
        .or_else(|| session.get("lastInputTokens"))
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n != 0.0)
        .unwrap_or(0.0);
    row.insert("windowTokens".into(), number(window_tokens));
    row.insert("windowCap".into(), session.get("contextWindow").and_then(Value::as_f64).filter(|n| n.is_finite() && *n != 0.0).map_or(Value::Null, number));
    row.insert("permission".into(), or_null(session, "permission"));
    row.insert("toolPermission".into(), or_null(session, "toolPermission"));
    row.insert("messages".into(), json!(input.messages));
    row.insert("tools".into(), json!(input.tools));
    let turn_started_at = input.index_turn_started_at.filter(|t| !t.is_empty()).map(str::to_owned).or_else(|| text(session, "turnStartedAt"));
    if let Some(turn) = turn_started_at.filter(|_| is_active_worker(&status, &stage)) {
        row.insert("turnStartedAt".into(), json!(turn));
    }
    if let Some(todo) = input.todo.clone() {
        row.insert("todo".into(), todo);
    }
    row
}

/// What `listJobs` reads of a task besides the board row.
pub struct JobStatus<'a> {
    pub job: &'a JobSnapshot,
    /// The worker session in memory (`memorySession`).
    pub session: Option<&'a Row>,
    pub live: &'a WorkerLive,
    pub awaiting_user: Option<Value>,
    pub now: i64,
}

fn is_terminal(status: &str) -> bool {
    matches!(mixdog_js::js_trim(status).to_lowercase().as_str(), "completed" | "failed" | "cancelled" | "canceled")
}

/// `liveAgentStatusRow(listJobs(..)[n])`.
pub fn job_status_row(input: &JobStatus<'_>) -> Map<String, Value> {
    let job = input.job;
    let meta = &job.meta;
    let present = |value: &Option<String>| value.as_deref().filter(|v| !v.is_empty()).map_or(Value::Null, |v| json!(v));
    let mut row = Map::new();
    row.insert("task_id".into(), json!(job.task_id));
    row.insert("type".into(), json!(job.operation));
    row.insert("status".into(), json!(job.status));
    row.insert("tag".into(), present(&meta.tag));
    row.insert("sessionId".into(), present(&meta.session_id));
    row.insert("agent".into(), present(&meta.agent));
    row.insert("preset".into(), present(&meta.preset));
    row.insert("provider".into(), present(&meta.provider));
    row.insert("model".into(), present(&meta.model));
    row.insert("effort".into(), present(&meta.effort));
    row.insert("fast".into(), meta.fast.map_or(Value::Null, Value::Bool));
    row.insert("startedAt".into(), json!(iso_from_ms(job.started_ms)));
    row.insert("finishedAt".into(), job.finished_ms.map_or(Value::Null, |ms| json!(iso_from_ms(ms))));
    row.insert("error".into(), present(&job.error));
    // A finished job is frozen history: its own status, never the live session's.
    if is_terminal(&job.status) {
        let progress = frozen_progress(&job.status);
        row.insert("workerStatus".into(), json!(progress.worker_stage));
        row.insert("stage".into(), json!(progress.worker_stage));
        row.insert("clientHostPid".into(), Value::Null);
        put_progress(&mut row, &progress);
        return row;
    }
    let Some(session_id) = meta.session_id.as_deref().filter(|id| !id.is_empty()) else { return row };
    let _ = session_id;
    let session_status = input.session.and_then(|s| text(s, "status"));
    if let Some(session) = input.session {
        let status = if session.get("closed") == Some(&Value::Bool(true)) { "closed".to_owned() } else { session_status.clone().unwrap_or_else(|| "idle".to_owned()) };
        let progress = progress_of(session_status.as_deref(), input.live, None, input.now);
        row.insert("workerStatus".into(), json!(status));
        row.insert("stage".into(), json!(if progress.worker_stage.is_empty() { input.live.runtime_stage.clone().unwrap_or(status) } else { progress.worker_stage.clone() }));
        if let Some(awaiting) = input.awaiting_user.as_ref().filter(|a| truthy(Some(a))) {
            row.insert("awaitingUser".into(), awaiting.clone());
        }
        if input.live.task_waiting {
            row.insert("awaitingTask".into(), json!("wait"));
        }
        row.insert("clientHostPid".into(), or_null(session, "clientHostPid"));
    }
    let progress = progress_of(session_status.as_deref(), input.live, Some(&job.status), input.now);
    put_progress(&mut row, &progress);
    row
}

/// `array.length` of a header list, else `max(0, Number(count || 0))`.
fn count_of(session: &Row, list: &str, count: &str) -> u64 {
    match session.get(list) {
        Some(Value::Array(items)) => items.len() as u64,
        _ => session.get(count).and_then(Value::as_f64).filter(|n| n.is_finite() && *n > 0.0).map_or(0, |n| n as u64),
    }
}

/// `agentStatusState()` for a caller: the agent tool's workers and jobs, from memory (the worker
/// index and the loaded sessions; no record is read), empty lists for a thread that is not hosted.
pub struct AgentToolStatus {
    registry: Arc<AgentRegistry>,
    board: JobBoard,
    directory: Arc<SessionDirectory>,
    jobs: Arc<dyn WaitedJobs>,
    clock: Arc<dyn Clock>,
    role_policies: RolePolicies,
}

impl AgentToolStatus {
    pub fn new(registry: Arc<AgentRegistry>, board: JobBoard, directory: Arc<SessionDirectory>, jobs: Arc<dyn WaitedJobs>, clock: Arc<dyn Clock>) -> Self {
        Self { registry, board, directory, jobs, clock, role_policies: RolePolicies::default() }
    }

    /// The worker's progress state, its policy the armed watchdog's own, else the role's
    /// (`watchdogState.policy || rolePolicy(role, true)`).
    fn live(&self, id: &str, role: Option<&str>, now: i64, pending: &mut Vec<String>) -> WorkerLive {
        let mut live = self.directory.worker_live(&ThreadId::from(id), now, &*self.jobs);
        if live.policy.is_none()
            && let Some(role) = role.filter(|r| !r.is_empty())
        {
            live.policy = self.role_policies.get(role, pending);
        }
        live
    }

    /// `session.messages.length` of the session in memory: the conversation the model context holds
    /// (the same count `DispatchSessions::message_count` gives); a session this process does not
    /// host has only the record's `messageCount`.
    async fn message_count(&self, id: &str, session: &Row) -> u64 {
        if self.directory.handle(&ThreadId::from(id)).is_some()
            && let Ok(rows) = self.directory.model_context(&ThreadId::from(id)).read().await
        {
            return rows.len() as u64;
        }
        count_of(session, "messages", "messageCount")
    }

    /// `todoProgress(liveSession)`: only a session this process holds has a live list (an evicted
    /// idle worker is not re-read on every pulse).
    fn todo_of(&self, id: &str) -> Option<Value> {
        let handle = self.directory.handle(&ThreadId::from(id))?;
        todo_progress(handle.cell.header.load().get("todo"))
    }

    /// `runtime.awaitingUser`: `'approval'` while the worker's turn waits on a tool approval.
    fn awaiting_user(&self, id: &str) -> Option<Value> {
        self.directory.handle(&ThreadId::from(id)).filter(|handle| !handle.cell.approvals.load().is_empty()).map(|_| json!("approval"))
    }
}

#[async_trait]
impl AgentStatus for AgentToolStatus {
    async fn status(&self, thread: &ThreadId) -> ThreadAgents {
        let Some(handle) = self.directory.handle(thread) else { return ThreadAgents { agent_workers: Vec::new(), agent_jobs: Vec::new(), agent_scope: None } };
        // `clientHostPid: rt.session?.clientHostPid || process.pid`.
        let pid = positive_int(handle.cell.header.load().get("clientHostPid")).unwrap_or_else(|| u64::from(std::process::id()));
        // `callerSessionId: rt.session?.id || null`: a thread with no session yet (no model on its header) reads the terminal's scope.
        let session = mixdog_core_ports::ports::route::header_names_session(&handle.cell.header.load()).then(|| thread.as_str().to_owned());
        let scope = Scope { caller_session_id: session.clone(), host_pid: Some(pid) };
        let now = self.clock.now_ms();
        // The status pulse reads the index only (`memoryOnly`): a row past its deadline leaves it at the maintenance pass.
        self.registry.refresh_tags_from_index(&scope).await;
        let mut workers = Vec::new();
        let mut pending = Vec::new();
        // Only the entries a status can list: the rows whose own state is inactive are left out.
        for (tag, session) in self.registry.status_entries(&scope) {
            let id = mixdog_js::js_trim(session.get("id").and_then(Value::as_str).unwrap_or_default()).to_owned();
            let live = self.live(&id, text(&session, "agent").as_deref(), now, &mut pending);
            let (status, stage) = row_state(&session, live.runtime_stage.as_deref());
            // Listed by status and stage alone, as `createAgentList` lists.
            if !is_active_worker(&status, &stage) {
                continue;
            }
            workers.push(Value::Object(worker_status_row(&WorkerStatus {
                tag: &tag,
                session: &session,
                live: &live,
                awaiting_user: self.awaiting_user(&id),
                messages: self.message_count(&id, &session).await,
                tools: count_of(&session, "tools", "toolCount"),
                index_turn_started_at: session.get("turnStartedAt").and_then(Value::as_str),
                todo: self.todo_of(&id),
                now,
            })));
        }
        let worker_pid = |id: &str| self.directory.handle(&ThreadId::from(id)).and_then(|h| positive_int(h.cell.header.load().get("clientHostPid")));
        let mut jobs = Vec::new();
        for job in self.board.list_jobs_for_client(&scope, &worker_pid) {
            let id = job.meta.session_id.clone().filter(|id| !id.is_empty());
            let session = id.as_deref().and_then(|id| self.directory.handle(&ThreadId::from(id))).map(|h| h.cell.header.load_full());
            // A finished job's row is frozen: no progress is read, so no role policy is asked for.
            let live = id.as_deref().filter(|_| !is_terminal(&job.status)).map(|id| self.live(id, job.meta.agent.as_deref(), now, &mut pending)).unwrap_or_default();
            jobs.push(Value::Object(job_status_row(&JobStatus {
                job: &job,
                session: session.as_deref(),
                awaiting_user: id.as_deref().and_then(|id| self.awaiting_user(id)),
                live: &live,
                now,
            })));
        }
        self.role_policies.resolve(pending);
        // statusFor: a session's agents are scoped to that owner session, else to the hosting process.
        ThreadAgents { agent_workers: workers, agent_jobs: jobs, agent_scope: Some(agent_scope(thread, &handle.cell.header.load())) }
    }
}

/// statusFor's scope: a session's agents are scoped to that owner session, else to the hosting process
/// (`clientHostPid: rt.session?.clientHostPid || process.pid`). It needs only the header, so a thread shows it
/// in the step that seats its header, before the status read fills the rows.
pub(crate) fn agent_scope(thread: &ThreadId, header: &Map<String, Value>) -> Value {
    if mixdog_core_ports::ports::route::header_names_session(header) {
        return json!({ "sessionId": thread.as_str() });
    }
    json!({ "clientHostPid": positive_int(header.get("clientHostPid")).unwrap_or_else(|| u64::from(std::process::id())) })
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod live_rows_usage_tests;
