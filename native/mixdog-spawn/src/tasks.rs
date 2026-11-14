//! The background-task registry (DS §6.2), generic over `surface/op` (shell, agent, media). Every
//! transition publishes the shell-job strip states: one per thread (`thread/shellJobs/updated`)
//! and one for the host (`hostShellJobs`). Nothing polls.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;

use mixdog_core_api::domain::process::ExitStatus;
use mixdog_core_api::domain::process::KillReason;
use mixdog_core_api::domain::process::ProcessError;
use mixdog_core_api::domain::process::ProcessExit;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_protocol::ProcessHandle;

/// How long a finished background shell stays in its thread's strip (the 30 minutes the runtime
/// applies today). It is applied when a state is built, so expiry needs no timer.
pub const FINISHED_RETENTION_MS: u64 = 30 * 60 * 1000;

/// The exit code a task reports when its run limit ended it.
pub const TIME_LIMIT_EXIT_CODE: i32 = 124;
/// The exit code a task reports when it was stopped.
pub const KILLED_EXIT_CODE: i32 = 137;
/// Rows one strip holds: running shells, and recently finished ones.
const MAX_RUNNING_ROWS: usize = 60;
const MAX_FINISHED_ROWS: usize = 30;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TaskStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl TaskStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

/// How a task ended.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct TaskOutcome {
    pub status: TaskStatus,
    pub exit_code: Option<i32>,
}

impl TaskOutcome {
    /// The task outcome a process exit means: a stop is `Cancelled` (137), a run limit `Failed`
    /// (124), otherwise the exit code decides.
    pub fn of_exit(exit: &ProcessExit) -> Self {
        match (exit.killed, exit.status) {
            (Some(KillReason::TimeLimit), _) => Self {
                status: TaskStatus::Failed,
                exit_code: Some(TIME_LIMIT_EXIT_CODE),
            },
            (Some(_), _) => Self {
                status: TaskStatus::Cancelled,
                exit_code: Some(KILLED_EXIT_CODE),
            },
            (None, ExitStatus::Code(0)) => Self {
                status: TaskStatus::Completed,
                exit_code: Some(0),
            },
            (None, ExitStatus::Code(code)) => Self {
                status: TaskStatus::Failed,
                exit_code: Some(code),
            },
            (None, ExitStatus::Signal(_)) => Self {
                status: TaskStatus::Failed,
                exit_code: None,
            },
        }
    }
}

/// What a caller registers.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct TaskSpec {
    pub task_id: String,
    pub surface: String,
    pub op: String,
    pub command: String,
    pub cwd: String,
    /// The thread that owns the task; `None` for work no thread owns.
    pub owner: Option<String>,
    /// A foreground command is awaited in its own tool card and is not part of the strip until
    /// it is promoted to the background.
    pub foreground: bool,
    /// The process that runs the task, when there is one (what `terminate` kills).
    pub process: Option<ProcessHandle>,
    pub started_at_ms: u64,
}

impl TaskRow {
    /// Whether the row keeps its folder reserved against a worktree operation: a running background shell, or any shell held with
    /// its termination unconfirmed (a foreground command whose kill was not confirmed keeps its workspace admission until the
    /// command has exited or the hold is released, `shell-run-settle.mjs:46-104`).
    pub fn reserves_folder(&self) -> bool {
        self.surface == "shell" && ((self.status == TaskStatus::Running && !self.foreground) || self.termination_unconfirmed)
    }
}

/// One registered task as `list` shows it.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct TaskRow {
    pub task_id: String,
    pub surface: String,
    pub op: String,
    pub command: String,
    pub cwd: String,
    pub owner: Option<String>,
    pub foreground: bool,
    pub status: TaskStatus,
    pub exit_code: Option<i32>,
    pub started_at_ms: u64,
    pub finished_at_ms: Option<u64>,
    /// The result is reported but its processes are not confirmed gone: the workspace stays
    /// held until they are or the user releases it.
    pub termination_unconfirmed: bool,
    /// The owner thread was closed while the task was still held.
    pub owner_closed: bool,
}

/// A row of the shell-job strip (`DesktopShellJobRow`).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ShellJobRow {
    pub task_id: String,
    pub command: String,
    pub cwd: String,
    pub owner: Option<String>,
    pub started_at_ms: u64,
    pub termination_unconfirmed: bool,
    /// Set on finished rows only.
    pub status: Option<TaskStatus>,
    pub exit_code: Option<i32>,
    pub finished_at_ms: Option<u64>,
}

/// One thread's strip: running shells and recently finished background shells.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct ShellJobsState {
    pub count: usize,
    pub jobs: Vec<ShellJobRow>,
    pub finished: Vec<ShellJobRow>,
}

/// The host's strip: every running background shell of every thread, and the held shells whose
/// owner thread closed (every thread that sees their folder lists them).
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct HostShellJobs {
    pub count: usize,
    pub jobs: Vec<ShellJobRow>,
    pub orphaned: Vec<ShellJobRow>,
}

/// Receives the strip states on change. Called under the registry's lock so states arrive in
/// transition order: an implementation only enqueues.
pub trait TaskPublisher: Send + Sync {
    fn thread_updated(&self, thread: &str, state: &ShellJobsState);
    fn host_updated(&self, state: &HostShellJobs);
    /// Wake the registry with [`TaskRegistry::expire_finished`] at `at_ms` (wall clock): the
    /// first moment a finished row in a strip ages out. A later call replaces the earlier one;
    /// the host arms it on the core ticker, there is no polling.
    fn schedule_expiry(&self, at_ms: u64);
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum TaskError {
    /// A task with this id is registered.
    Exists,
    UnknownTask,
    /// The task has no process to stop.
    NoProcess,
    Process(ProcessError),
}

struct Inner {
    tasks: HashMap<String, TaskRow>,
    processes: HashMap<String, ProcessHandle>,
    /// Task ids in start order.
    order: Vec<String>,
    /// The expiry wake-up currently requested from the publisher.
    scheduled: Option<u64>,
    published_threads: HashMap<String, ShellJobsState>,
    published_host: HostShellJobs,
}

pub struct TaskRegistry {
    inner: Mutex<Inner>,
    publisher: Arc<dyn TaskPublisher>,
    now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
}

impl TaskRegistry {
    pub fn new(
        publisher: Arc<dyn TaskPublisher>,
        now_ms: impl Fn() -> u64 + Send + Sync + 'static,
    ) -> Self {
        Self {
            inner: Mutex::new(Inner {
                tasks: HashMap::new(),
                processes: HashMap::new(),
                order: Vec::new(),
                scheduled: None,
                published_threads: HashMap::new(),
                published_host: HostShellJobs::default(),
            }),
            publisher,
            now_ms: Arc::new(now_ms),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn start(&self, spec: TaskSpec) -> Result<(), TaskError> {
        let mut inner = self.lock();
        if inner.tasks.contains_key(&spec.task_id) {
            return Err(TaskError::Exists);
        }
        if let Some(process) = spec.process {
            inner.processes.insert(spec.task_id.clone(), process);
        }
        inner.order.push(spec.task_id.clone());
        inner.tasks.insert(
            spec.task_id.clone(),
            TaskRow {
                task_id: spec.task_id,
                surface: spec.surface,
                op: spec.op,
                command: spec.command,
                cwd: spec.cwd,
                owner: spec.owner.clone(),
                foreground: spec.foreground,
                status: TaskStatus::Running,
                exit_code: None,
                started_at_ms: spec.started_at_ms,
                finished_at_ms: None,
                termination_unconfirmed: false,
                owner_closed: false,
            },
        );
        self.publish(&mut inner, spec.owner.as_deref());
        Ok(())
    }

    /// A foreground command was handed to the background.
    pub fn promote(&self, task_id: &str) -> Result<(), TaskError> {
        self.change(task_id, |row| row.foreground = false)
    }

    /// The task ended. A finished task keeps its row until `clean` or `release`.
    pub fn finish(&self, task_id: &str, outcome: TaskOutcome) -> Result<(), TaskError> {
        let now = (self.now_ms)();
        let mut inner = self.lock();
        let row = inner.tasks.get_mut(task_id).ok_or(TaskError::UnknownTask)?;
        if row.status == TaskStatus::Running {
            row.status = outcome.status;
            row.exit_code = outcome.exit_code;
            row.finished_at_ms = Some(now);
        }
        let owner = row.owner.clone();
        self.publish(&mut inner, owner.as_deref());
        Ok(())
    }

    /// Marks a finished task whose processes are not confirmed gone (or confirms them).
    pub fn set_termination_unconfirmed(
        &self,
        task_id: &str,
        unconfirmed: bool,
    ) -> Result<(), TaskError> {
        self.change(task_id, |row| row.termination_unconfirmed = unconfirmed)
    }

    /// The owner thread closed: its held shells become orphaned.
    pub fn owner_closed(&self, thread: &str) {
        let mut inner = self.lock();
        for row in inner.tasks.values_mut() {
            if row.owner.as_deref() == Some(thread) {
                row.owner_closed = true;
            }
        }
        self.publish(&mut inner, Some(thread));
    }

    /// `thread/backgroundTerminals/terminate`: kills the task's process tree. The task finishes
    /// when the process exit arrives (see [`TaskOutcome::of_exit`]).
    pub fn terminate(&self, task_id: &str, processes: &dyn ProcessManager) -> Result<(), TaskError> {
        let handle = {
            let inner = self.lock();
            if !inner.tasks.contains_key(task_id) {
                return Err(TaskError::UnknownTask);
            }
            inner.processes.get(task_id).cloned().ok_or(TaskError::NoProcess)?
        };
        processes.kill(&handle).map_err(TaskError::Process)
    }

    /// `thread/backgroundTerminals/release`: lets go of a held task (its processes stay as they
    /// are) and drops its row.
    pub fn release(&self, task_id: &str) -> Result<(), TaskError> {
        let mut inner = self.lock();
        let owner = inner
            .tasks
            .remove(task_id)
            .ok_or(TaskError::UnknownTask)?
            .owner;
        inner.processes.remove(task_id);
        inner.order.retain(|id| id != task_id);
        self.publish(&mut inner, owner.as_deref());
        Ok(())
    }

    /// `thread/backgroundTerminals/clean`: drops the finished rows of `thread`.
    pub fn clean(&self, thread: &str) {
        let mut inner = self.lock();
        let gone: Vec<String> = inner
            .tasks
            .values()
            .filter(|r| {
                r.owner.as_deref() == Some(thread)
                    && r.status != TaskStatus::Running
                    && !r.termination_unconfirmed
            })
            .map(|r| r.task_id.clone())
            .collect();
        for id in &gone {
            inner.tasks.remove(id);
            inner.processes.remove(id);
        }
        inner.order.retain(|id| !gone.contains(id));
        self.publish(&mut inner, Some(thread));
    }

    /// Every registered task, in start order.
    pub fn list(&self) -> Vec<TaskRow> {
        let inner = self.lock();
        inner
            .order
            .iter()
            .filter_map(|id| inner.tasks.get(id).cloned())
            .collect()
    }

    pub fn get(&self, task_id: &str) -> Option<TaskRow> {
        self.lock().tasks.get(task_id).cloned()
    }

    /// The strip of one thread as of now.
    pub fn thread_state(&self, thread: &str) -> ShellJobsState {
        let inner = self.lock();
        self.build_thread(&inner, thread)
    }

    /// The host strip as of now.
    pub fn host_state(&self) -> HostShellJobs {
        let inner = self.lock();
        self.build_host(&inner)
    }

    fn change(&self, task_id: &str, edit: impl FnOnce(&mut TaskRow)) -> Result<(), TaskError> {
        let mut inner = self.lock();
        let row = inner.tasks.get_mut(task_id).ok_or(TaskError::UnknownTask)?;
        edit(row);
        let owner = row.owner.clone();
        self.publish(&mut inner, owner.as_deref());
        Ok(())
    }

    fn strip_row(row: &TaskRow, finished: bool) -> ShellJobRow {
        ShellJobRow {
            task_id: row.task_id.clone(),
            command: row.command.clone(),
            cwd: row.cwd.clone(),
            owner: row.owner.clone(),
            started_at_ms: row.started_at_ms,
            termination_unconfirmed: row.termination_unconfirmed,
            status: finished.then_some(row.status),
            exit_code: if finished { row.exit_code } else { None },
            finished_at_ms: if finished { row.finished_at_ms } else { None },
        }
    }

    /// A shell that is listed: background, or held with unconfirmed termination.
    fn in_strip(row: &TaskRow) -> bool {
        row.surface == "shell" && (!row.foreground || row.termination_unconfirmed)
    }

    /// Shell rows matching `keep`, newest start first (ties by id), as the poller's job-id sort
    /// ordered them.
    fn by_start(inner: &Inner, keep: impl Fn(&TaskRow) -> bool) -> Vec<&TaskRow> {
        let mut rows: Vec<&TaskRow> = inner
            .tasks
            .values()
            .filter(|r| r.surface == "shell" && keep(r))
            .collect();
        rows.sort_by(|a, b| {
            b.started_at_ms
                .cmp(&a.started_at_ms)
                .then_with(|| a.task_id.cmp(&b.task_id))
        });
        rows
    }

    /// Records without a done marker: running, or finished with termination unconfirmed. The
    /// poller took the newest 60 of them before it dropped foreground ones.
    fn running_rows(inner: &Inner) -> Vec<&TaskRow> {
        Self::by_start(inner, |r| r.status == TaskStatus::Running || r.termination_unconfirmed)
            .into_iter()
            .take(MAX_RUNNING_ROWS)
            .filter(|r| Self::in_strip(r))
            .collect()
    }

    /// The newest 30 finished records (by start), before the foreground, owner and age filters.
    fn done_rows(inner: &Inner) -> Vec<&TaskRow> {
        Self::by_start(inner, |r| r.status != TaskStatus::Running && !r.termination_unconfirmed)
            .into_iter()
            .take(MAX_FINISHED_ROWS)
            .collect()
    }

    fn expires_at(row: &TaskRow) -> Option<u64> {
        row.finished_at_ms.map(|at| at + FINISHED_RETENTION_MS + 1)
    }

    fn visible_done<'a>(&self, inner: &'a Inner) -> Vec<&'a TaskRow> {
        let now = (self.now_ms)();
        Self::done_rows(inner)
            .into_iter()
            .filter(|r| !r.foreground && Self::expires_at(r).is_some_and(|at| now < at))
            .collect()
    }

    fn build_thread(&self, inner: &Inner, thread: &str) -> ShellJobsState {
        let jobs: Vec<ShellJobRow> = Self::running_rows(inner)
            .into_iter()
            .filter(|r| r.owner.as_deref() == Some(thread))
            .map(|r| Self::strip_row(r, false))
            .collect();
        let finished = self
            .visible_done(inner)
            .into_iter()
            .filter(|r| r.owner.as_deref() == Some(thread))
            .map(|r| Self::strip_row(r, true))
            .collect();
        ShellJobsState {
            count: jobs.len(),
            jobs,
            finished,
        }
    }

    fn build_host(&self, inner: &Inner) -> HostShellJobs {
        let jobs: Vec<ShellJobRow> = Self::running_rows(inner)
            .into_iter()
            .map(|r| Self::strip_row(r, false))
            .collect();
        let orphaned = Self::running_rows(inner)
            .into_iter()
            .filter(|r| r.termination_unconfirmed && r.owner_closed)
            .map(|r| Self::strip_row(r, false))
            .collect();
        HostShellJobs {
            count: jobs.len(),
            jobs,
            orphaned,
        }
    }

    /// Publishes the states that changed: `thread`'s strip and the host's.
    fn publish(&self, inner: &mut Inner, thread: Option<&str>) {
        // The strips share their 60 and 30 row caps, so one transition can change another
        // thread's strip: every thread that has one is recomputed.
        let mut threads: Vec<String> = inner.published_threads.keys().cloned().collect();
        threads.extend(inner.tasks.values().filter_map(|r| r.owner.clone()));
        threads.extend(thread.map(str::to_owned));
        threads.sort();
        threads.dedup();
        for thread in threads {
            self.publish_thread(inner, &thread);
        }
        self.publish_host(inner);
        self.reschedule(inner);
    }

    fn publish_thread(&self, inner: &mut Inner, thread: &str) {
        let state = self.build_thread(inner, thread);
        let before = inner.published_threads.get(thread);
        let empty = ShellJobsState::default();
        if before.unwrap_or(&empty) != &state {
            self.publisher.thread_updated(thread, &state);
            if state == empty {
                inner.published_threads.remove(thread);
            } else {
                inner.published_threads.insert(thread.to_owned(), state);
            }
        }
    }

    fn publish_host(&self, inner: &mut Inner) {
        let host = self.build_host(inner);
        if host != inner.published_host {
            self.publisher.host_updated(&host);
            inner.published_host = host;
        }
    }

    /// Asks the publisher for one wake-up at the earliest moment a shown finished row ages out.
    fn reschedule(&self, inner: &mut Inner) {
        let next = self
            .visible_done(inner)
            .into_iter()
            .filter_map(|r| Self::expires_at(r))
            .min();
        if next != inner.scheduled {
            inner.scheduled = next;
            if let Some(at) = next {
                self.publisher.schedule_expiry(at);
            }
        }
    }

    /// Called by the host's ticker at the time given to [`TaskPublisher::schedule_expiry`]: the
    /// finished rows that have aged out leave their strips, as they did at the poller's next
    /// sample.
    pub fn expire_finished(&self) {
        let mut inner = self.lock();
        inner.scheduled = None;
        let mut threads: Vec<String> = inner.published_threads.keys().cloned().collect();
        threads.sort();
        for thread in threads {
            self.publish_thread(&mut inner, &thread);
        }
        self.publish_host(&mut inner);
        self.reschedule(&mut inner);
    }
}
