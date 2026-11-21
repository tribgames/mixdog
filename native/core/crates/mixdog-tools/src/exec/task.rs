//! Texts follow `task-tool.mjs` and `background-tasks.mjs` byte for byte.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::domain::process::ProcessError;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::tool::SurfaceKind;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_core_api::domain::tool::ToolErrorCode;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolOutput;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_protocol::JsonValue;
use mixdog_spawn::tasks::TaskError;

use super::jobs::ExecRuntime;
use super::jobs::Job;
use super::jobs::JobStatus;
use super::jobs::ReadOptions;
use super::jobs::label_of;
use super::wake::WaitRefusal;
use super::wake::WakeReason;
use crate::orch::util::spec_from_def;

const WAIT_DEFAULT_MS: u64 = 300_000;
const WAIT_DEFAULT_AGENT_MS: u64 = 240_000;
const WAIT_MIN_MS: u64 = 10_000;
const WAIT_MAX_MS: u64 = 3_600_000;

/// One agent task of the caller as `task list` shows it (`renderBackgroundTaskList`).
#[derive(Clone, PartialEq, Debug)]
pub struct AgentTaskRow {
    pub task_id: String,
    pub operation: String,
    pub label: Option<String>,
    pub status: String,
    pub error: Option<String>,
}

/// One agent task of the caller as `task read` and `task wait` show it (`renderBackgroundTask`).
#[derive(Clone, PartialEq, Debug)]
pub struct AgentTaskView {
    pub operation: String,
    /// `running`, or how it ended.
    pub status: String,
    pub text: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum AgentTaskCancellation {
    Cancelled { operation: String },
    AlreadySettled { status: String },
}

/// The agent tool's background tasks (Node's `surface: 'agent'` rows of `background-tasks.mjs`), which the `task` tool lists,
/// reads, waits for and cancels beside the shell jobs. The agent runtime owns them; `task` only asks.
#[async_trait]
pub trait AgentTasks: Send + Sync {
    /// The tasks `owner` started, oldest first.
    fn list(&self, owner: &mixdog_protocol::ThreadId) -> Vec<AgentTaskRow>;
    /// `None`: no such task of `owner`.
    fn view(&self, owner: &mixdog_protocol::ThreadId, task_id: &str) -> Option<AgentTaskView>;
    /// Resolves once the task is over (at once for one already over or gone).
    async fn settled(&self, task_id: &str);
    /// The actual cancellation transition, or `None` when `owner` has no such task.
    fn cancel(&self, owner: &mixdog_protocol::ThreadId, task_id: &str, reason: &str) -> Option<AgentTaskCancellation>;
    /// A terminal read is the consumer's ACK.
    fn acknowledge(&self, task_id: &str);
}

pub struct TaskTool {
    spec: ToolSpec,
    /// What a delegated agent's session is sent: the same tool with the agent's wait default.
    agent_spec: ToolSpec,
    runtime: Arc<ExecRuntime>,
    agent_tasks: Option<Arc<dyn AgentTasks>>,
}

impl TaskTool {
    pub fn new(runtime: Arc<ExecRuntime>) -> Self {
        Self {
            spec: spec_from_def(include_str!("specs/task.json"), true, &[]),
            agent_spec: spec_from_def(include_str!("specs/task.agent.json"), true, &[]),
            runtime,
            agent_tasks: None,
        }
    }

    /// The agent tasks `task` lists, reads, waits for and cancels beside the shell jobs.
    pub fn with_agent_tasks(mut self, tasks: Arc<dyn AgentTasks>) -> Self {
        self.agent_tasks = Some(tasks);
        self
    }
}

#[allow(clippy::result_large_err, reason = "Preserve the canonical structured ToolError and ToolOutcome contract without per-error boxing.")]
fn ok(text: String) -> ToolOutcome {
    Ok(ToolOutput { parts: vec![ToolPart::Text(text)], ..ToolOutput::default() })
}

#[allow(clippy::result_large_err, reason = "Preserve the canonical structured ToolError and ToolOutcome contract without per-error boxing.")]
fn refused(code: ToolErrorCode, text: String) -> ToolOutcome {
    Err(ToolError::new(code, text))
}

#[allow(clippy::result_large_err, reason = "Preserve the canonical structured ToolError and ToolOutcome contract without per-error boxing.")]
fn invalid(field: &str, text: String) -> ToolOutcome {
    refused(ToolErrorCode::InvalidArgs { field: field.into(), reason: text.clone() }, text)
}

#[allow(clippy::result_large_err, reason = "Preserve the canonical structured ToolError and ToolOutcome contract without per-error boxing.")]
fn not_found(id: &str) -> ToolOutcome {
    refused(ToolErrorCode::NotFound { target: id.into() }, format!("Error: task not found: {id}"))
}

#[allow(clippy::result_large_err, reason = "Preserve the canonical structured ToolError and ToolOutcome contract without per-error boxing.")]
fn unavailable(text: String) -> ToolOutcome {
    refused(ToolErrorCode::Unavailable { capability: "task".into(), reason: text.clone() }, text)
}

#[allow(clippy::result_large_err, reason = "Preserve the canonical structured ToolError and ToolOutcome contract without per-error boxing.")]
async fn list(runtime: &ExecRuntime, agents: Option<&dyn AgentTasks>, ctx: &ToolContext) -> ToolOutcome {
    let jobs = runtime.list(&ctx.thread_id);
    let agent_rows = agents.map(|tasks| tasks.list(&ctx.thread_id)).unwrap_or_default();
    let mut out = vec![format!("background tasks: {}", jobs.len() + agent_rows.len())];
    let quiet: Vec<String> = jobs
        .iter()
        .filter(|j| j.status() == JobStatus::Running)
        .filter_map(|j| j.silence_note(runtime.now_ms()).map(|note| format!("- {} {note}", j.id)))
        .collect();
    for job in jobs {
        let label = label_of(&job.command);
        let label = if label.is_empty() { String::new() } else { format!(" label={label}") };
        let error = job.failure_error().map_or(String::new(), |e| format!(" error={e}"));
        out.push(format!("- {} shell/shell {}{label}{error}", job.id, job.status().as_str()));
    }
    for row in agent_rows {
        let label = row.label.filter(|l| !l.is_empty()).map_or(String::new(), |l| format!(" label={l}"));
        let error = row.error.filter(|e| !e.is_empty()).map_or(String::new(), |e| format!(" error={e}"));
        out.push(format!("- {} agent/{} {}{label}{error}", row.task_id, row.operation, row.status));
    }
    if !quiet.is_empty() {
        out.push(format!("[output silence]\n{}", quiet.join("\n")));
    }
    // `listTasks`: the jobs of this thread the runtime does not hold, as their kept records say.
    let recovered: Vec<String> = runtime
        .kept_jobs(&ctx.thread_id, &ctx.cancel)
        .await
        .iter()
        .map(|kept| {
            let status = kept.end().map_or("state-unavailable", |end| end.status.as_str());
            format!("- {} shell {status} recovered=true command={}", kept.id, serde_json::to_string(&kept.command()).unwrap_or_default())
        })
        .collect();
    if !recovered.is_empty() {
        out.push(format!("[recovered shell tasks]\n{}", recovered.join("\n")));
    }
    // `otherSessionShellHolders`: counts of the shell work other sessions of this runtime hold, which only they can cancel.
    let (foreground, background) = runtime.other_owner_shell_work(&ctx.thread_id);
    if foreground + background > 0 {
        out.push(format!(
            "[other sessions in this runtime] {foreground} foreground shell lease(s), {background} background shell job(s) — read-only; only their owner sessions can cancel them."
        ));
    }
    ok(out.join("\n"))
}

/// `executeTaskTool` for a task this runtime does not hold (task-tool.mjs:411-444): the record the runtime that ran it kept
/// answers for it. Nothing can wait on or control a process after a restart, so a wait reads what is kept.
#[allow(clippy::result_large_err, reason = "Preserve the canonical structured ToolError and ToolOutcome contract without per-error boxing.")]
async fn kept_task(runtime: &ExecRuntime, ctx: &ToolContext, id: &str, cancelling: bool, tail: bool) -> ToolOutcome {
    let Some(kept) = runtime.kept(&ctx.thread_id, id, &ctx.cancel).await else {
        return not_found(id);
    };
    match (kept.end(), cancelling) {
        (Some(end), true) => unavailable(format!("Error: task already {}: {id}", end.status.as_str())),
        (None, true) => unavailable(format!("Error: task process control is unavailable after restart: {id}")),
        (None, false) => unavailable(format!("Error: task state is unavailable after restart: {id}")),
        (Some(end), false) => {
            let job = runtime.recovered_job(&kept, end, &ctx.cancel).await;
            read_or_wait(runtime, ctx, Arc::new(job), false, None, tail).await
        }
    }
}

/// `resolveTaskWaitTimeoutMs`.
fn wait_ceiling_ms(timeout: Option<f64>, default: u64) -> u64 {
    match timeout {
        Some(raw) if raw.is_finite() && raw > 0.0 => (raw.floor() as u64).clamp(WAIT_MIN_MS, WAIT_MAX_MS),
        _ => default,
    }
}

#[derive(Default)]
struct WaitEnd {
    interrupted: bool,
    notified: Option<Option<String>>,
}

impl WaitEnd {
    fn note(self, id: &str) -> Option<String> {
        if self.interrupted {
            Some("\n\nWait ended by new user input; task still running in the background. Handle the new message first.".to_owned())
        } else {
            self.notified.map(|detail| {
                let from = detail.filter(|d| d != id).map_or(String::new(), |d| format!(" (task_id: {d})"));
                format!("\n\nWait ended because a notification arrived{from}; it is delivered to you now. This task ({id}) is still running in the background.")
            })
        }
    }
}

#[allow(clippy::result_large_err, reason = "Preserve the canonical structured ToolError and ToolOutcome contract without per-error boxing.")]
async fn hold_wait(runtime: &ExecRuntime, ctx: &ToolContext, settled: impl std::future::Future, timeout: Option<f64>) -> Result<WaitEnd, ToolOutcome> {
    let default = if ctx.surface == SurfaceKind::Agent { WAIT_DEFAULT_AGENT_MS } else { WAIT_DEFAULT_MS };
    let ceiling = wait_ceiling_ms(timeout, default);
    let wait = runtime.config.wake.begin(&ctx.thread_id);
    tokio::select! {
        _ = settled => {}
        () = mixdog_rt::time::sleep(Duration::from_millis(ceiling)) => {}
        () = wait.released() => {}
        () = ctx.cancel.cancelled() => {
            return Err(refused(ToolErrorCode::Cancelled, "Error: wait cancelled".into()));
        }
    }
    let mut end = WaitEnd::default();
    if let Some(wake) = wait.wake() {
        match wake.reason {
            WakeReason::UserMessage => end.interrupted = true,
            WakeReason::Notification => {
                runtime.config.wake.cut_by_notification(&ctx.thread_id);
                end.notified = Some(wake.detail);
            }
        }
    }
    Ok(end)
}

#[allow(clippy::result_large_err, reason = "Preserve the canonical structured ToolError and ToolOutcome contract without per-error boxing.")]
fn task_completion(text: String, id: &str, status: &str) -> ToolOutcome {
    Ok(ToolOutput {
        parts: vec![ToolPart::Text(text)],
        meta: Some(serde_json::json!({ "code": "task-completion", "executionId": id, "status": status })),
        ..ToolOutput::default()
    })
}

#[allow(clippy::result_large_err, reason = "Preserve the canonical structured ToolError and ToolOutcome contract without per-error boxing.")]
async fn read_or_wait(runtime: &ExecRuntime, ctx: &ToolContext, job: Arc<Job>, waiting: bool, timeout: Option<f64>, tail: bool) -> ToolOutcome {
    let end = if waiting {
        match hold_wait(runtime, ctx, job.settled(), timeout).await {
            Ok(end) => end,
            Err(outcome) => return outcome,
        }
    } else {
        WaitEnd::default()
    };
    let status = job.status();
    let running = status == JobStatus::Running;
    let pending = if !running && !tail { job.pending_completion_output() } else { None };
    let body = if job.survivors { Some(job.survivor_body(tail)) } else { pending }.unwrap_or_else(|| {
        job.read_output(ReadOptions {
            tail,
            terminal: !running,
            digest: waiting && running,
            hung: if waiting && running { job.silence_note(runtime.now_ms()) } else { None },
        })
    });
    let silence = if running { job.silence_note(runtime.now_ms()) } else { None };
    let mut rendered = job.render_with(false, Some(&body), silence.as_deref());
    if waiting && running {
        if let Some(note) = end.note(&job.id) {
            rendered.push_str(&note);
        } else {
            let hits = job.wait_hits.fetch_add(1, Ordering::Relaxed) + 1;
            rendered.push_str(&if hits > 1 {
                format!("\n\nWait ceiling reached again ({hits} times); task still running. Check whether it is progressing (task read output:tail, or the log file) and cancel it if it is stuck; otherwise continue other work — its result is delivered automatically.")
            } else {
                "\n\nWait ceiling reached; task still running and its result is delivered automatically. If periodic reports were requested, write the user-facing report now; otherwise continue independent work or end the turn.".to_owned()
            });
        }
    }
    if !running {
        job.acknowledge();
        return task_completion(rendered, &job.id, status.as_str());
    }
    ok(rendered)
}

/// `executeTaskTool` for a task of the agent tool (`task-tool.mjs:466-514`, the non-shell branches): a read shows it, a wait ends
/// as a shell wait does (the task is over, the ceiling, the turn cancelled, new input or a notification), a cancel stops it.
#[allow(clippy::result_large_err, reason = "Preserve the canonical structured ToolError and ToolOutcome contract without per-error boxing.")]
async fn agent_task(
    runtime: &ExecRuntime,
    tasks: &dyn AgentTasks,
    ctx: &ToolContext,
    id: &str,
    view: AgentTaskView,
    action: &str,
    timeout: Option<f64>,
) -> ToolOutcome {
    if action == "cancel" {
        return match tasks.cancel(&ctx.thread_id, id, "cancelled by task control") {
            Some(AgentTaskCancellation::Cancelled { operation }) => ok(format!("status: completed\ntask_id: {id}\ncancelled: agent/{operation}")),
            Some(AgentTaskCancellation::AlreadySettled { status }) => unavailable(format!("Error: task already {status}: {id}")),
            None => not_found(id),
        };
    }
    let waiting = action == "wait";
    let end = if waiting && view.status == "running" {
        match hold_wait(runtime, ctx, tasks.settled(id), timeout).await {
            Ok(end) => end,
            Err(outcome) => return outcome,
        }
    } else {
        WaitEnd::default()
    };
    let Some(latest) = tasks.view(&ctx.thread_id, id) else { return not_found(id) };
    let running = latest.status == "running";
    let mut rendered = latest.text;
    if waiting && running {
        rendered.push_str(&end.note(id).unwrap_or_else(|| "\n\nWait ceiling reached; task still running and its result is delivered automatically. If periodic reports were requested, write the user-facing report now; otherwise continue independent work or end the turn.".to_owned()));
    }
    if !running {
        tasks.acknowledge(id);
        return task_completion(rendered, id, &latest.status);
    }
    ok(rendered)
}

/// How a cancel of one task ended (`cancelShellTaskOutcome`'s `cancelled` and `unconfirmed`;
/// the `task` tool and the structured stop answer both read it).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum CancelOutcome {
    Cancelled,
    /// The kill was delivered but the exit could not be confirmed.
    Unconfirmed,
    /// The command exited but processes it started are still alive.
    Pending,
    /// A survivors task that already ended (naturally, or by an earlier confirmed cancel): Node answers `task not found`, since
    /// neither a shell job nor a running task is left to cancel.
    NotFound,
}

pub(super) async fn cancel_job(runtime: &ExecRuntime, processes: &dyn ProcessManager, job: &Job) -> CancelOutcome {
    let outcome = cancel_outcome(runtime, processes, job).await;
    if matches!(outcome, CancelOutcome::Unconfirmed | CancelOutcome::Pending) {
        runtime.hold_unconfirmed(job);
    }
    outcome
}

/// Sends the kill of a running task's process; `false` when it could not be sent (a process that
/// just exited is not an error).
pub(super) fn send_kill(runtime: &ExecRuntime, processes: &dyn ProcessManager, job: &Job) -> bool {
    matches!(runtime.config.tasks.terminate(&job.id, processes), Ok(()) | Err(TaskError::Process(ProcessError::AlreadyExited)))
}

async fn cancel_outcome(runtime: &ExecRuntime, processes: &dyn ProcessManager, job: &Job) -> CancelOutcome {
    if job.survivors {
        if !runtime.cancel_survivors_intent(job) && !job.termination_pending() {
            return CancelOutcome::NotFound;
        }
        let terminated = match &runtime.config.survivors {
            Some(watch) => watch.kill(&job.handle).await,
            None => false,
        };
        if !terminated {
            return CancelOutcome::Pending;
        }
        runtime.finish_survivors(job).await;
        return CancelOutcome::Cancelled;
    }
    // Node answers a cancel of a task it still retains with the success text.
    if !job.is_running() {
        return CancelOutcome::Cancelled;
    }
    if !send_kill(runtime, processes, job) {
        return CancelOutcome::Unconfirmed;
    }
    if mixdog_rt::time::timeout(super::KILL_VERIFY, job.settled()).await.is_err() {
        return CancelOutcome::Unconfirmed;
    }
    CancelOutcome::Cancelled
}

#[allow(clippy::result_large_err, reason = "Preserve the canonical structured ToolError and ToolOutcome contract without per-error boxing.")]
async fn cancel(runtime: &ExecRuntime, ctx: &ToolContext, job: Arc<Job>) -> ToolOutcome {
    let id = job.id.clone();
    match cancel_job(runtime, &*ctx.processes, &job).await {
        CancelOutcome::Cancelled => ok(format!("status: completed\ntask_id: {id}\ncancelled: shell/shell")),
        CancelOutcome::Unconfirmed => ok(cancel_unconfirmed(&id)),
        CancelOutcome::Pending => ok(cancel_pending(&id)),
        CancelOutcome::NotFound => not_found(&id),
    }
}

fn cancel_pending(id: &str) -> String {
    [
        "status: cancel-pending".to_owned(),
        format!("task_id: {id}"),
        "the kill was sent and the command itself exited, but processes it started are still alive. They keep being terminated and stay tracked (the folder stays held) until they are gone; re-run task cancel or task read to check again.".to_owned(),
    ]
    .join("\n")
}

fn cancel_unconfirmed(id: &str) -> String {
    [
        "status: cancel-unconfirmed".to_owned(),
        format!("task_id: {id}"),
        "the cancellation was delivered but the process has not exited yet. It stays tracked and its completion is still delivered; re-run task cancel or task read to check again.".to_owned(),
    ]
    .join("\n")
}

#[async_trait]
impl Tool for TaskTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    fn agent_spec(&self) -> Option<&ToolSpec> {
        Some(&self.agent_spec)
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        match guard_task_args(args) {
            Ok(args) => self.execute(ctx, args).await,
            Err(text) => invalid("args", text),
        }
    }
}

/// `describeType` (`arg-guard.mjs`): how a refusal names the type it got.
pub(crate) fn describe_type(value: &JsonValue) -> &'static str {
    match value {
        JsonValue::Null => "null",
        JsonValue::Array(_) => "array",
        JsonValue::String(_) => "string",
        JsonValue::Number(_) => "number",
        JsonValue::Bool(_) => "boolean",
        JsonValue::Object(_) => "object",
    }
}

/// Keys whose array values `normalizeStringListArgs` flattens one level and strips of blanks.
const STRING_LIST_ARG_KEYS: [&str; 15] =
    ["path", "paths", "root", "file", "files", "pattern", "patterns", "query", "regex", "needle", "glob", "file_pattern", "include", "type", "symbols"];

/// `normalizeStringListArgs` (`arg-guard.mjs`): a string-or-list argument that arrives nested, padded with blanks
/// or empty is flattened one level, stripped of its blanks and removed when nothing is left.
pub(crate) fn normalize_string_list_args(a: &mut serde_json::Map<String, JsonValue>) {
    for key in STRING_LIST_ARG_KEYS {
        let Some(JsonValue::Array(source)) = a.get(key) else { continue };
        let mut flat: Vec<JsonValue> = Vec::new();
        for entry in source {
            let items: Vec<&JsonValue> = match entry {
                JsonValue::Array(inner) => inner.iter().collect(),
                other => vec![other],
            };
            flat.extend(items.into_iter().filter(|e| !e.is_null() && !e.as_str().is_some_and(|s| mixdog_js::js_trim(s).is_empty())).cloned());
        }
        if flat == *source {
            continue;
        }
        if flat.is_empty() {
            a.shift_remove(key);
        } else {
            a.insert(key.to_owned(), JsonValue::Array(flat));
        }
    }
}

fn task_action(value: Option<&JsonValue>) -> String {
    value.and_then(JsonValue::as_str).map(|s| mixdog_js::js_trim(s).to_ascii_lowercase()).unwrap_or_default()
}

/// `validateBuiltinArgs('task', args)` (`arg-guard.mjs`): the null drops and normalisations that come first, then
/// `guardTask`. The arguments the tool then runs with, or the refusal text.
fn guard_task_args(args: JsonValue) -> Result<JsonValue, String> {
    let JsonValue::Object(mut a) = args else {
        return Err(if args.is_null() {
            "Error: task requires arguments object (got null)".to_owned()
        } else {
            format!("Error: task arguments must be an object (got {})", describe_type(&args))
        });
    };
    a.retain(|_, v| !v.is_null());
    let action = task_action(a.get("action"));
    if matches!(action.as_str(), "list" | "read" | "cancel") {
        a.shift_remove("timeout_ms");
    }
    if action == "list" && a.get("task_id").and_then(JsonValue::as_str).is_some_and(|s| mixdog_js::js_trim(s).is_empty()) {
        a.shift_remove("task_id");
    }
    normalize_string_list_args(&mut a);
    let Some(raw_action) = a.get("action") else {
        return Err("Error: task requires explicit \"action\"".to_owned());
    };
    if !matches!(action.as_str(), "list" | "read" | "wait" | "cancel") {
        return Err(format!("Error: task arg \"action\" must be one of list|read|wait|cancel (got {})", serde_json::to_string(raw_action).unwrap_or_default()));
    }
    if let Some(key) = a.keys().find(|k| !matches!(k.as_str(), "action" | "task_id" | "timeout_ms" | "output")) {
        return Err(format!("Error: task arg \"{key}\" is unsupported; use only action, task_id, timeout_ms, and output"));
    }
    if let Some(output) = a.get("output") {
        if action != "read" && action != "wait" {
            return Err("Error: task arg \"output\" is only valid for action=read or wait".to_owned());
        }
        if !matches!(output.as_str(), Some("new" | "tail")) {
            return Err("Error: task arg \"output\" must be new or tail".to_owned());
        }
    }
    if action == "list" {
        return Ok(JsonValue::Object(a));
    }
    let Some(id) = a.get("task_id") else {
        return Err("Error: task requires \"task_id\"".to_owned());
    };
    if !id.as_str().is_some_and(|s| !mixdog_js::js_trim(s).is_empty()) {
        return Err(format!("Error: task arg \"task_id\" must be a non-empty string (got {})", describe_type(id)));
    }
    if let Some(timeout) = a.get("timeout_ms") {
        let whole = timeout.as_f64().is_some_and(|n| n.is_finite() && n.fract() == 0.0 && n >= 0.0);
        if !whole {
            return Err(format!("Error: task arg \"timeout_ms\" must be a non-negative integer (got {})", describe_type(timeout)));
        }
    }
    Ok(JsonValue::Object(a))
}

impl TaskTool {
    /// `executeTaskTool`: the handler behind the argument guard.
    #[allow(clippy::result_large_err, reason = "Preserve the canonical structured ToolError and ToolOutcome contract without per-error boxing.")]
    pub async fn execute(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        // `executeTaskTool` lowercases the action but, unlike the guard, does not trim it.
        let action = args.get("action").and_then(JsonValue::as_str).map(str::to_lowercase).unwrap_or_default();
        if action.is_empty() {
            return invalid("action", "Error: task action is required".into());
        }
        if action == "list" {
            return list(&self.runtime, self.agent_tasks.as_deref(), ctx).await;
        }
        let id = args.get("task_id").and_then(JsonValue::as_str).map(mixdog_js::js_trim).unwrap_or("");
        if id.is_empty() {
            return invalid("task_id", "Error: task_id is required".into());
        }
        if id.starts_with("sess_") {
            return invalid(
                "task_id",
                format!(
                    "Error: \"{id}\" is an agent/session id, not a background task_id. Agent tasks deliver completion notifications; use agent list/read only for manual recovery."
                ),
            );
        }
        // The guard trims for its check only: a padded action is refused here for every id, before the task is looked up.
        if !matches!(action.as_str(), "read" | "wait" | "cancel") {
            let got = serde_json::to_string(&args["action"]).unwrap_or_default();
            return invalid("action", format!("Error: task action must be one of list|read|wait|cancel (got {got})"));
        }
        if action == "wait"
            && let Some(refusal) = self.runtime.config.wake.refuse_wait(&ctx.thread_id)
        {
            return ok(match refusal {
                WaitRefusal::UserMessage => "Not waiting: a user message is waiting and must be answered first. It is delivered to you right after this result; reply to it, then wait only if nothing else is left.".to_owned(),
                WaitRefusal::Notification => "Not waiting: the last wait ended because a notification arrived and it is still unhandled. Handle it first (it was delivered to you after that wait); call wait again only after another tool call or a reply. If nothing else is left, end your turn: results and messages start your next one.".to_owned(),
            });
        }
        let tail = args.get("output").and_then(JsonValue::as_str) == Some("tail");
        let Some(job) = self.runtime.get(&ctx.thread_id, id) else {
            if let Some(tasks) = self.agent_tasks.as_deref()
                && let Some(view) = tasks.view(&ctx.thread_id, id)
            {
                let timeout = args.get("timeout_ms").and_then(JsonValue::as_f64);
                return agent_task(&self.runtime, tasks, ctx, id, view, &action, timeout).await;
            }
            return kept_task(&self.runtime, ctx, id, action == "cancel", tail).await;
        };
        if action == "cancel" {
            return cancel(&self.runtime, ctx, job).await;
        }
        let timeout = args.get("timeout_ms").and_then(JsonValue::as_f64);
        read_or_wait(&self.runtime, ctx, job, action == "wait", timeout, tail).await
    }
}
