//! The agent tool's background-task table (Node `runtime/shared/background-tasks.mjs`, the
//! `surface: 'agent'` rows): one row per spawn/send job, kept for 30 minutes after it
//! finishes, scoped to the session or host process that started it. The shell's job table
//! (`mixdog_tools::exec`) is a different table: its rows own a process; these own a run.
//!
//! A row's completion is delivered once, as a `<task-notification>`, through
//! [`TaskNotifier`] to the session that started the job. A `notifyOnCancel` row reports its
//! cancellation after its run settles so the report can carry what the run produced; a run
//! that never settles reports header-only after [`CANCEL_NOTIFY_GRACE`], armed on the core
//! ticker.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::time::Duration;
use std::time::Instant;

use mixdog_js::js_trim;
use mixdog_protocol::ThreadId;
use mixdog_rt::TaskClass;
use mixdog_rt::ticker::TimerHandle;
use mixdog_tools::exec::TaskNotifier;
use mixdog_tools::orch::agent::TaskResult;

use super::host::Cleaned;
use super::host::TaskFacts;
use super::host::Tasks;
use super::scope::Scope;
use crate::env::Clock;

const TASK_TTL_MS: i64 = 30 * 60_000;
const MAX_TASKS: usize = 300;
const CANCEL_NOTIFY_GRACE: Duration = Duration::from_secs(10);

/// The identity fields a job shows (the task's sanitized `meta`).
#[derive(Clone, Default, PartialEq, Debug)]
pub struct JobMeta {
    pub tag: Option<String>,
    pub session_id: Option<String>,
    pub agent: Option<String>,
    pub preset: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub fast: Option<bool>,
    pub respawned: bool,
    pub resumed: bool,
}

/// Who started a job.
#[derive(Clone, Default, PartialEq, Debug)]
pub struct JobOwner {
    pub caller_session_id: Option<String>,
    /// Receives the completion when there is no caller session.
    pub owner_session_id: Option<String>,
    pub host_pid: Option<u64>,
}

#[derive(Clone, Default)]
pub struct NewJob {
    /// Taken from the board's sequence when absent.
    pub task_id: Option<String>,
    pub operation: String,
    pub label: Option<String>,
    pub owner: JobOwner,
    pub meta: JobMeta,
    pub notify_on_cancel: bool,
    /// Stops the run; called once when the job is cancelled.
    pub cancel: Option<Arc<dyn Fn() + Send + Sync>>,
    pub started_at_ms: Option<i64>,
}

pub struct Completion {
    /// Normalised like Node: `done`/`success` → `completed`, `error` → `failed`,
    /// `canceled`/`killed` → `cancelled`.
    pub status: String,
    pub result: Option<TaskResult>,
    /// The rendered body, when the result alone does not read as one.
    pub result_text: Option<String>,
    pub error: Option<String>,
    pub notify: bool,
    pub terminal_reason: Option<String>,
}

impl Completion {
    pub fn new(status: &str) -> Self {
        Self { status: status.to_owned(), result: None, result_text: None, error: None, notify: true, terminal_reason: None }
    }
}

/// How the owner is told of a cancellation.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CancelNotice {
    /// A `notifyOnCancel` job reports once its run settles; any other stays silent.
    Default,
    Now,
    /// Owner teardown.
    Never,
}

#[derive(Clone, PartialEq, Debug)]
pub struct JobSnapshot {
    pub task_id: String,
    pub operation: String,
    pub label: Option<String>,
    pub status: String,
    pub started_ms: i64,
    pub finished_ms: Option<i64>,
    pub error: Option<String>,
    pub result: Option<TaskResult>,
    pub meta: JobMeta,
    pub notified: bool,
}

impl JobSnapshot {
    pub fn is_terminal(&self) -> bool {
        is_terminal(&self.status)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CancelState {
    Pending,
    Silent,
    Delivered,
}

struct Record {
    task_id: String,
    operation: String,
    label: Option<String>,
    status: String,
    started_ms: i64,
    finished_ms: Option<i64>,
    result: Option<TaskResult>,
    result_text: Option<String>,
    error: Option<String>,
    notified: bool,
    notified_with_body: bool,
    acknowledged: bool,
    /// `callerSessionId || routingSessionId`: the scope key.
    session_id: Option<String>,
    host_pid: Option<u64>,
    /// Receives the completion.
    notify_session: Option<String>,
    meta: JobMeta,
    notify_on_cancel: bool,
    cancel: Option<Arc<dyn Fn() + Send + Sync>>,
    cancel_state: Option<CancelState>,
    cancel_timer: Option<TimerHandle>,
    appendix: Option<Arc<dyn Fn() -> String + Send + Sync>>,
}

fn is_terminal(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "cancelled")
}

fn normalize_status(status: &str) -> String {
    let value = js_trim(status).to_lowercase();
    match value.as_str() {
        "done" | "success" => "completed".to_owned(),
        "error" => "failed".to_owned(),
        "cancelled" | "canceled" | "killed" => "cancelled".to_owned(),
        "" => "running".to_owned(),
        _ => value,
    }
}

fn base36(mut n: u64) -> String {
    if n == 0 {
        return "0".to_owned();
    }
    let mut digits = Vec::new();
    while n > 0 {
        digits.push(char::from_digit((n % 36) as u32, 36).unwrap_or('0'));
        n /= 36;
    }
    digits.iter().rev().collect()
}

/// `taskMatchesScope`: session identity dominates (one host process runs many sessions); the
/// process matches only a task with no session.
fn matches_scope(task: &Record, scope: &Scope, include_unattributed: bool) -> bool {
    if scope.caller_session_id.is_none() && scope.host_pid.is_none() {
        return true;
    }
    if task.session_id.is_none() && task.host_pid.is_none() {
        return include_unattributed;
    }
    if let (Some(wanted), Some(owner)) = (&scope.caller_session_id, &task.session_id) {
        return wanted == owner;
    }
    scope.host_pid.is_some() && task.host_pid == scope.host_pid
}

fn escape_field(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn field(name: &str, value: &str) -> String {
    format!("<{name}>{}</{name}>", escape_field(value))
}

/// `renderAgentCompletionEnvelope`.
pub fn render_agent_completion(task_id: &str, tag: &str, status: &str, result: &str, error: &str, detail: &str) -> String {
    let who = if tag.is_empty() { task_id } else { tag };
    let outcome = if matches!(status, "cancelled" | "canceled") { "was cancelled" } else if status.is_empty() { "completed" } else { status };
    let detail = if detail.is_empty() { String::new() } else { format!(" ({detail})") };
    let mut lines = vec!["<task-notification>".to_owned(), field("task-id", task_id)];
    if !tag.is_empty() {
        lines.push(field("tag", tag));
    }
    lines.push(field("status", status));
    lines.push(field("summary", &format!("Agent \"{who}\" {outcome}{detail}")));
    if !result.is_empty() {
        lines.push(format!("<result>\n{result}\n</result>"));
    }
    if status == "failed" && !error.is_empty() {
        lines.push(field("error", error));
    }
    lines.push("</task-notification>".to_owned());
    lines.join("\n")
}

/// `resultTextForTask`.
fn body_of(task: &Record) -> String {
    if let Some(text) = task.result_text.as_deref().filter(|t| !t.is_empty()) {
        return text.to_owned();
    }
    match &task.result {
        Some(TaskResult::Content(content)) => content.clone(),
        Some(TaskResult::Json(value)) => serde_json::to_string_pretty(value).unwrap_or_default(),
        None => String::new(),
    }
}

/// `renderBackgroundTaskNotification` for the agent surface.
fn notification_of(task: &Record) -> String {
    let body = body_of(task);
    let appendix = task.appendix.as_ref().map(|f| f()).unwrap_or_default();
    let result = if appendix.is_empty() { body } else { [body, appendix].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n\n") };
    let tag = task.meta.tag.clone().filter(|t| !t.is_empty()).or_else(|| task.label.clone()).unwrap_or_default();
    let error = task.error.as_deref().unwrap_or_default();
    let detail = if task.status == "cancelled" { error } else { "" };
    render_agent_completion(&task.task_id, &tag, &task.status, &result, error, detail)
}

struct Outgoing {
    session: String,
    task_id: String,
    status: String,
    text: String,
}

#[derive(Default)]
struct State {
    tasks: Vec<Record>,
    seq: u64,
}

struct Inner {
    clock: Arc<dyn Clock>,
    notifier: Option<Arc<dyn TaskNotifier>>,
    on_change: Option<Arc<dyn Fn(&str) + Send + Sync>>,
    state: Mutex<State>,
}

/// Effects of an operation, run after the lock is released.
#[derive(Default)]
struct Effects {
    send: Vec<Outgoing>,
    changed: Vec<String>,
}

#[derive(Clone)]
pub struct JobBoard {
    inner: Arc<Inner>,
}

impl JobBoard {
    /// `on_change(owner_session_id)` runs when a row is added or finishes (the session
    /// activity signal).
    pub fn new(clock: Arc<dyn Clock>, notifier: Option<Arc<dyn TaskNotifier>>, on_change: Option<Arc<dyn Fn(&str) + Send + Sync>>) -> Self {
        Self { inner: Arc::new(Inner { clock, notifier, on_change, state: Mutex::new(State::default()) }) }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.inner.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn now(&self) -> i64 {
        self.inner.clock.now_ms()
    }

    fn run(&self, effects: Effects) {
        if let Some(on_change) = &self.inner.on_change {
            for owner in &effects.changed {
                on_change(owner);
            }
        }
        for out in effects.send {
            let Some(notifier) = self.inner.notifier.clone() else { continue };
            drop(mixdog_rt::spawn("agent-job-notify", TaskClass::Work, async move {
                notifier.finished(&ThreadId::from(out.session.as_str()), &out.task_id, &out.status, out.text).await;
            }));
        }
    }

    /// `pruneTasks`: rows finished more than the TTL ago (all rows when `force`) inside `scope`,
    /// then the oldest finished rows beyond the cap.
    fn prune(&self, state: &mut State, scope: &Scope, force: bool) {
        let now = self.now();
        state.tasks.retain(|t| {
            let expired = force || t.finished_ms.is_some_and(|f| f > 0 && now - f > TASK_TTL_MS);
            !(expired && matches_scope(t, scope, true))
        });
        if state.tasks.len() <= MAX_TASKS {
            return;
        }
        let mut removable: Vec<(i64, String)> =
            state.tasks.iter().filter(|t| is_terminal(&t.status)).map(|t| (t.finished_ms.unwrap_or(t.started_ms), t.task_id.clone())).collect();
        removable.sort_by_key(|(at, _)| *at);
        for (_, id) in removable {
            if state.tasks.len() <= MAX_TASKS {
                break;
            }
            state.tasks.retain(|t| t.task_id != id);
        }
    }

    pub fn register(&self, job: NewJob) -> Result<String, String> {
        let mut state = self.lock();
        self.prune(&mut state, &Scope::default(), false);
        let explicit = job.task_id.as_deref().map(js_trim).filter(|s| !s.is_empty()).map(str::to_owned);
        let exists = |state: &State, id: &str| state.tasks.iter().any(|t| t.task_id == id);
        let id = match explicit {
            Some(id) if exists(&state, &id) => return Err(format!("background task already exists: {id}")),
            Some(id) => id,
            None => loop {
                state.seq += 1;
                let id = format!("task_agent_{}_{}", base36(self.now().max(0) as u64), base36(state.seq));
                if !exists(&state, &id) {
                    break id;
                }
            },
        };
        let registered = self.now();
        let started = match job.started_at_ms {
            Some(requested) if requested > 0 => requested.min(registered),
            _ => registered,
        };
        let session_id = job.owner.caller_session_id.clone().filter(|s| !s.is_empty());
        let notify_session = session_id.clone().or_else(|| job.owner.owner_session_id.clone().filter(|s| !s.is_empty()));
        state.tasks.push(Record {
            task_id: id.clone(),
            operation: if job.operation.is_empty() { "run".to_owned() } else { job.operation },
            label: job.label.filter(|l| !l.is_empty()),
            status: "running".to_owned(),
            started_ms: started,
            finished_ms: None,
            result: None,
            result_text: None,
            error: None,
            notified: false,
            notified_with_body: false,
            acknowledged: false,
            session_id: session_id.clone(),
            host_pid: job.owner.host_pid.filter(|p| *p > 0),
            notify_session,
            meta: job.meta,
            notify_on_cancel: job.notify_on_cancel,
            cancel: job.cancel,
            cancel_state: None,
            cancel_timer: None,
            appendix: None,
        });
        drop(state);
        self.run(Effects { changed: vec![session_id.unwrap_or_default()], ..Effects::default() });
        Ok(id)
    }

    fn snapshot(task: &Record) -> JobSnapshot {
        JobSnapshot {
            task_id: task.task_id.clone(),
            operation: task.operation.clone(),
            label: task.label.clone(),
            status: task.status.clone(),
            started_ms: task.started_ms,
            finished_ms: task.finished_ms,
            error: task.error.clone(),
            result: task.result.clone(),
            meta: task.meta.clone(),
            notified: task.notified,
        }
    }

    /// `getBackgroundTask(id, { surface: 'agent', context })`.
    pub fn get(&self, task_id: &str, scope: &Scope) -> Option<JobSnapshot> {
        let mut state = self.lock();
        self.prune(&mut state, &Scope::default(), false);
        state.tasks.iter().find(|t| t.task_id == js_trim(task_id)).filter(|t| matches_scope(t, scope, true)).map(Self::snapshot)
    }

    /// `listBackgroundTasks({ surface: 'agent', context })`, oldest first.
    pub fn list_jobs(&self, scope: &Scope) -> Vec<JobSnapshot> {
        let mut state = self.lock();
        self.prune(&mut state, scope, false);
        state.tasks.iter().filter(|t| matches_scope(t, scope, true)).map(Self::snapshot).collect()
    }

    pub fn cleanup_jobs(&self, scope: &Scope, force: bool) -> u64 {
        let mut state = self.lock();
        let count = |state: &State| state.tasks.iter().filter(|t| matches_scope(t, scope, true)).count();
        let before = count(&state);
        self.prune(&mut state, scope, force);
        (before - count(&state)) as u64
    }

    pub fn set_report_appendix(&self, task_id: &str, appendix: Arc<dyn Fn() -> String + Send + Sync>) {
        if let Some(task) = self.lock().tasks.iter_mut().find(|t| t.task_id == task_id) {
            task.appendix = Some(appendix);
        }
    }

    /// `mergeJobMeta`: a later update to a job's identity fields.
    pub fn update_meta(&self, task_id: &str, update: impl FnOnce(&mut JobMeta)) {
        let mut state = self.lock();
        if let Some(task) = state.tasks.iter_mut().find(|t| t.task_id == task_id) {
            update(&mut task.meta);
            if let Some(label) = task.meta.tag.clone().filter(|t| !t.is_empty()).or_else(|| task.meta.session_id.clone().filter(|s| !s.is_empty())) {
                task.label = Some(label);
            }
        }
    }

    /// `notifyTaskCompletion`: exactly once with a body (a header-only preview may precede).
    fn notify_locked(&self, task: &mut Record, effects: &mut Effects) -> bool {
        if !is_terminal(&task.status) || task.acknowledged {
            return false;
        }
        if matches!(task.cancel_state, Some(CancelState::Pending | CancelState::Silent)) {
            return false;
        }
        let has_body = !body_of(task).is_empty();
        if task.notified_with_body || (task.notified && !has_body) {
            return false;
        }
        let (Some(session), Some(_)) = (task.notify_session.clone(), &self.inner.notifier) else { return false };
        effects.send.push(Outgoing { session, task_id: task.task_id.clone(), status: task.status.clone(), text: notification_of(task) });
        task.notified = true;
        task.notified_with_body |= has_body;
        true
    }

    fn complete_locked(&self, task: &mut Record, completion: Completion, effects: &mut Effects) -> bool {
        if is_terminal(&task.status) {
            return false;
        }
        task.status = normalize_status(&completion.status);
        task.finished_ms = Some(self.now());
        task.result = completion.result.or(task.result.take());
        if let Some(text) = completion.result_text {
            task.result_text = Some(text);
        }
        if completion.error.is_some() {
            task.error = completion.error;
        }
        effects.changed.push(task.session_id.clone().unwrap_or_default());
        if completion.notify {
            self.notify_locked(task, effects);
        }
        true
    }

    /// `completeBackgroundTask`: a no-op once the row is terminal.
    pub fn complete(&self, task_id: &str, completion: Completion) -> bool {
        let mut effects = Effects::default();
        let done = {
            let mut state = self.lock();
            match state.tasks.iter_mut().find(|t| t.task_id == task_id) {
                Some(task) => self.complete_locked(task, completion, &mut effects),
                None => false,
            }
        };
        self.run(effects);
        done
    }

    /// `reconcileBackgroundTask`: a terminal state the run's own path missed; a terminal row
    /// whose body never went out is re-announced.
    pub fn reconcile(&self, task_id: &str, completion: Completion) {
        let mut effects = Effects::default();
        {
            let mut state = self.lock();
            let Some(task) = state.tasks.iter_mut().find(|t| t.task_id == task_id) else { return };
            if is_terminal(&task.status) {
                if !task.notified_with_body {
                    self.notify_locked(task, &mut effects);
                }
            } else {
                self.complete_locked(task, Completion { terminal_reason: Some("reconciled".to_owned()), ..completion }, &mut effects);
            }
        }
        self.run(effects);
    }

    /// A terminal read is the consumer's ACK: the completion is not announced again.
    pub fn acknowledge(&self, task_id: &str) {
        if let Some(task) = self.lock().tasks.iter_mut().find(|t| t.task_id == task_id).filter(|t| is_terminal(&t.status)) {
            task.acknowledged = true;
            task.notified = true;
            task.notified_with_body = true;
        }
    }

    fn resolve_pending(task: &mut Record, next: CancelState) -> bool {
        if task.cancel_state != Some(CancelState::Pending) {
            return false;
        }
        if let Some(timer) = task.cancel_timer.take() {
            let _ = timer.cancel();
        }
        task.cancel_state = Some(next);
        true
    }

    fn deliver_cancelled(&self, task_id: &str) -> bool {
        let mut effects = Effects::default();
        let sent = {
            let mut state = self.lock();
            let Some(task) = state.tasks.iter_mut().find(|t| t.task_id == task_id) else { return false };
            Self::resolve_pending(task, CancelState::Delivered) && self.notify_locked(task, &mut effects)
        };
        self.run(effects);
        sent
    }

    /// `cancelBackgroundTask`: stops the run, marks the row `cancelled` with `reason`.
    pub fn cancel(&self, task_id: &str, reason: &str, notice: CancelNotice) {
        let hook = {
            let mut state = self.lock();
            let Some(task) = state.tasks.iter_mut().find(|t| t.task_id == task_id) else { return };
            if is_terminal(&task.status) {
                if notice == CancelNotice::Never {
                    Self::resolve_pending(task, CancelState::Silent);
                }
                return;
            }
            task.cancel.clone()
        };
        // A failing hook must not keep the row from being marked cancelled.
        if let Some(hook) = hook {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| hook()));
        }
        let mut effects = Effects::default();
        {
            let mut state = self.lock();
            let Some(task) = state.tasks.iter_mut().find(|t| t.task_id == task_id) else { return };
            let completion = Completion { error: Some(reason.to_owned()), notify: notice == CancelNotice::Now, ..Completion::new("cancelled") };
            self.complete_locked(task, completion, &mut effects);
            if task.notify_on_cancel && notice != CancelNotice::Now && task.status == "cancelled" && task.cancel_state.is_none() {
                if notice == CancelNotice::Never {
                    task.cancel_state = Some(CancelState::Silent);
                } else {
                    task.cancel_state = Some(CancelState::Pending);
                    let board = self.clone();
                    let id = task.task_id.clone();
                    task.cancel_timer = Some(mixdog_rt::ticker().register(Instant::now() + CANCEL_NOTIFY_GRACE, move || {
                        board.deliver_cancelled(&id);
                    }));
                }
            }
        }
        self.run(effects);
    }

    /// `settleCancelledBackgroundTask`: the cancelled run stopped; its deferred report goes out
    /// carrying what it produced.
    pub fn settle_cancelled(&self, task_id: &str, result: Option<TaskResult>) {
        {
            let mut state = self.lock();
            let Some(task) = state.tasks.iter_mut().find(|t| t.task_id == task_id) else { return };
            if task.status != "cancelled" || task.cancel_state != Some(CancelState::Pending) {
                return;
            }
            if result.is_some() {
                task.result = result;
            }
        }
        self.deliver_cancelled(task_id);
    }
}

impl Tasks for JobBoard {
    fn list(&self, scope: &Scope) -> Vec<TaskFacts> {
        self.list_jobs(scope)
            .into_iter()
            .map(|t| TaskFacts { task_id: t.task_id, session_id: t.meta.session_id, tag: t.meta.tag })
            .collect()
    }
    fn get(&self, task_id: &str, scope: &Scope) -> Option<TaskFacts> {
        JobBoard::get(self, task_id, scope).map(|t| TaskFacts { task_id: t.task_id, session_id: t.meta.session_id, tag: t.meta.tag })
    }
    fn cancel(&self, task_id: &str, reason: &str) {
        JobBoard::cancel(self, task_id, reason, CancelNotice::Default);
    }
    fn cleanup(&self, scope: &Scope, force: bool) -> Cleaned {
        Cleaned { removed: self.cleanup_jobs(scope, force) }
    }
}
