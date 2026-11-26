//! The job and worker views: the roster's worker and job rows
//! and the single-job status card, read from the job board, the tag registry and the
//! worker sessions. Nothing here writes: a finished job is frozen history, and a live one
//! reports the worker's progress as [`progress`](super::progress) derives it.

use std::sync::Arc;
use std::sync::LazyLock;

use async_trait::async_trait;
use mixdog_js::JsRegex;
use mixdog_js::js_trim;
use mixdog_tools::orch::agent::JobRow;
use mixdog_tools::orch::agent::TaskResult;
use mixdog_tools::orch::agent::TaskView;
use mixdog_tools::orch::agent::WorkerRow;
use serde_json::Value;

use super::board::JobBoard;
use super::board::JobMeta;
use super::board::JobSnapshot;
use super::dispatch::first_truthy;
use super::flow::stages::TurnStage;
use super::host::Job;
use super::host::ListOptions;
use super::host::Registry;
use super::host::Views;
use super::progress::Progress;
use super::progress::ProgressInput;
use super::progress::RuntimeFacts;
use super::progress::Snapshot;
use super::progress::ToolSilence;
use super::progress::WatchdogPolicy;
use super::progress::WatchdogState;
use super::progress::frozen_progress;
use super::progress::progress_fields;
use super::scope::Scope;
use super::scope::clean;
use super::stamp::elapsed_from_stamps;
use super::stamp::iso_from_ms;
use crate::env::Clock;

/// A session clock as the record holds it. A session's own header carries epoch milliseconds (a
/// number); a worker-index row carries an ISO string. A number is shown as its digits, which
/// is not read as a time: no elapsed label.
#[derive(Clone, PartialEq, Debug)]
pub enum Stamp {
    Ms(i64),
    Text(String),
}

impl Stamp {
    /// `String(value)` when `value` is truthy (`0` and `''` are skipped by `||`).
    pub fn shown(&self) -> Option<String> {
        match self {
            Self::Ms(0) => None,
            Self::Ms(ms) => Some(ms.to_string()),
            Self::Text(text) if text.is_empty() => None,
            Self::Text(text) => Some(text.clone()),
        }
    }
}

/// What the host knows of a worker session (`mgr.getSession`).
#[derive(Clone, Default, PartialEq, Debug)]
pub struct WorkerFacts {
    pub id: String,
    pub agent: Option<String>,
    /// The tag the session itself carries.
    pub tag: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub preset: Option<String>,
    pub effort: Option<String>,
    pub fast: bool,
    pub auto_effort_off: bool,
    /// `session.status`.
    pub status: Option<String>,
    pub closed: bool,
    /// `session.stage`.
    pub stage: Option<String>,
    pub awaiting_user: bool,
    /// The session's clocks exactly as the record holds them (see [`Stamp`]).
    pub created_at: Option<Stamp>,
    pub updated_at: Option<Stamp>,
    pub last_used_at: Option<Stamp>,
    pub client_host_pid: Option<u64>,
    /// `workerResultText`: the last assistant message, else the last handoff, else a placeholder.
    pub result_text: String,
}

/// The runtime state a progress read is a function of.
#[derive(Clone, Default, PartialEq, Debug)]
pub struct WorkerLive {
    /// `runtime.stage`.
    pub runtime_stage: Option<String>,
    pub snapshot: Option<Snapshot>,
    pub runtime: Option<RuntimeFacts>,
    pub policy: Option<WatchdogPolicy>,
    pub watchdog_state: WatchdogState,
    pub queued_followups: Option<u64>,
    /// Set while the worker's turn waits on shell jobs.
    pub tool_silence: Option<ToolSilence>,
    /// The turn sits in `task wait` (`runtime.taskWaits > 0`).
    pub task_waiting: bool,
}

/// The worker sessions, from the session directory.
#[async_trait]
pub trait Workers: Send + Sync {
    /// Reads stored sessions too (workerResultText), so it waits on the store.
    async fn session(&self, session_id: &str) -> Option<WorkerFacts>;
    /// The session's record without its result: what a status lookup reads (`loadSessionStatus`), no transcript read.
    async fn session_status(&self, session_id: &str) -> Option<WorkerFacts> {
        self.session(session_id).await
    }
    fn live(&self, session_id: &str) -> WorkerLive;
    /// `agentSessionEntries`: the tag-bound sessions (and, when `scan_sessions`, stored ones)
    /// visible in `scope`, as `(tag, session)`.
    async fn entries(&self, scan_sessions: bool, scope: &Scope) -> Vec<(String, WorkerFacts)>;
}

pub struct JobViews {
    board: JobBoard,
    registry: Arc<dyn Registry>,
    workers: Arc<dyn Workers>,
    clock: Arc<dyn Clock>,
}

const ACTIVE_STAGES: [&str; 6] = ["connecting", "requesting", "streaming", "tool_running", "running", "cancelling"];

fn lowered(value: &str) -> String {
    js_trim(value).to_lowercase()
}

// Asked of every worker row on every status pass: compiled once.
static CANCELLED_STATE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(?:cancelled|canceled|killed|cancel[-_\s]?(?:unconfirmed|pending))$", ""));
static TERMINAL_WORKER_STATUS: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"^(idle|closed|complete|completed|done|success|fail|failed|error|cancelled|canceled|killed|timeout)$", "i"));

fn is_cancelled_state(value: &str) -> bool {
    CANCELLED_STATE.is_match(value)
}

fn is_terminal_worker_status(value: &str) -> bool {
    TERMINAL_WORKER_STATUS.is_match(js_trim(value))
}

/// `isActiveWorkerRow`: `status` decides; the stage stands in for a row with no status. A
/// cancel in either field is not work.
pub fn is_active_worker(status: &str, stage: &str) -> bool {
    let (stage, status) = (lowered(stage), lowered(status));
    if is_cancelled_state(&stage) || is_cancelled_state(&status) {
        return false;
    }
    let effective = if status.is_empty() { &stage } else { &status };
    if ACTIVE_STAGES.contains(&effective.as_str()) {
        return true;
    }
    if effective.is_empty() || effective == "unknown" {
        return false;
    }
    !is_terminal_worker_status(effective)
}

/// `isOpenIdleRow`: a finished worker that is still open: it takes follow-ups and can be closed.
pub fn is_open_idle(status: &str, stage: &str) -> bool {
    let (stage, status) = (lowered(stage), lowered(status));
    if is_cancelled_state(&stage) || is_cancelled_state(&status) {
        return false;
    }
    (if status.is_empty() { stage } else { status }) == "idle"
}

/// `rowState`.
fn row_state(facts: &WorkerFacts, runtime_stage: Option<&str>) -> (String, String) {
    let status = if facts.closed { "closed".to_owned() } else { facts.status.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| "idle".to_owned()) };
    let stage = facts.stage.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| {
        if matches!(status.as_str(), "idle" | "error" | "closed") {
            status.clone()
        } else {
            runtime_stage.filter(|s| !s.is_empty()).map(str::to_owned).unwrap_or_else(|| status.clone())
        }
    });
    (status, stage)
}

/// A job as the status card reads it: a board row, or the worker session standing in for
/// one that was pruned.
struct JobData {
    task_id: Option<String>,
    operation: String,
    status: String,
    started_at: Option<String>,
    finished_at: Option<String>,
    error: Option<String>,
    result: Option<TaskResult>,
    meta: JobMeta,
    turn_stage: Option<(TurnStage, i64)>,
}

impl From<JobSnapshot> for JobData {
    fn from(s: JobSnapshot) -> Self {
        Self {
            task_id: Some(s.task_id),
            operation: s.operation,
            status: s.status,
            started_at: Some(iso_from_ms(s.started_ms)),
            finished_at: s.finished_ms.map(iso_from_ms),
            error: s.error,
            result: s.result,
            meta: s.meta,
            turn_stage: s.turn_stage,
        }
    }
}

fn is_terminal_job(status: &str) -> bool {
    matches!(lowered(status).as_str(), "completed" | "failed" | "cancelled" | "canceled")
}

impl JobViews {
    pub fn new(board: JobBoard, registry: Arc<dyn Registry>, workers: Arc<dyn Workers>, clock: Arc<dyn Clock>) -> Self {
        Self { board, registry, workers, clock }
    }

    /// `sessionProgressExtras`.
    async fn progress_of(&self, session_id: &str, task_status: Option<&str>) -> Progress {
        let facts = self.workers.session_status(session_id).await;
        let live = self.workers.live(session_id);
        progress_fields(&ProgressInput {
            now: self.clock.now_ms(),
            session_status: facts.as_ref().and_then(|f| f.status.as_deref()),
            runtime_stage: live.runtime_stage.as_deref(),
            snapshot: live.snapshot.as_ref(),
            runtime: live.runtime.as_ref(),
            policy: live.policy,
            watchdog_state: Some(&live.watchdog_state),
            queued_followups: live.queued_followups,
            task_status,
            last_tool_call: None,
            tool_silence: live.tool_silence.as_ref(),
        })
    }

    async fn apply_job_progress(&self, view: &mut TaskView, job: &JobData) {
        let apply = |view: &mut TaskView, p: Progress| {
            view.worker_stage = Some(p.worker_stage);
            view.last_progress = Some(p.last_progress);
            view.diagnostic = Some(p.diagnostic);
            view.silent_for_secs = p.silent_for_secs;
            view.watchdog = p.watchdog;
            view.tool_silent_for = p.tool_silent_for;
            view.queued_followups = p.queued_followups;
        };
        if is_terminal_job(&job.status) {
            // Frozen history: tags are reused, so the session may now run a different job.
            let frozen = frozen_progress(&job.status);
            view.worker_status = Some(frozen.worker_stage.clone());
            view.stage = Some(frozen.worker_stage.clone());
            apply(view, frozen);
        } else if let Some(session_id) = job.meta.session_id.as_deref().filter(|s| !s.is_empty()) {
            if let Some(facts) = self.workers.session(session_id).await {
                if let Some(provider) = facts.provider.as_deref().filter(|p| !p.is_empty())
                    && let Some(model) = facts.model.as_deref().filter(|m| !m.is_empty())
                {
                    view.provider = Some(provider.to_owned());
                    view.model = Some(model.to_owned());
                    view.effort = facts.effort.as_deref().filter(|e| !e.is_empty()).map(str::to_owned);
                    view.fast = Some(facts.fast);
                }
                view.worker_status =
                    Some(if facts.closed { "closed".to_owned() } else { facts.status.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| "idle".to_owned()) });
                view.stage = Some(self.progress_of(session_id, None).await.worker_stage);
            }
            let mut live = self.progress_of(session_id, Some(&job.status)).await;
            // Until the session started the job's turn, what it reports is of an earlier turn: the card names the stage
            // the job's own turn waits in. Once started, the stage stands in only where the session reports none.
            if let Some((stage, at)) = job.turn_stage
                && (stage != TurnStage::Started || live.worker_stage == "unknown")
            {
                let waited = Some((self.clock.now_ms() - at).max(0) / 1000).filter(|secs| *secs >= 5 && stage != TurnStage::Started);
                live.worker_stage = stage.word().to_owned();
                live.last_progress = match waited {
                    Some(secs) => format!("{} ({secs}s)", stage.describe()),
                    None => stage.describe().to_owned(),
                };
                live.diagnostic = live.last_progress.clone();
                live.silent_for_secs = None;
                view.stage = Some(live.worker_stage.clone());
            }
            apply(view, live);
        } else {
            let spawning = job.status == "running";
            let status = if job.status.is_empty() { "unknown".to_owned() } else { job.status.clone() };
            apply(
                view,
                Progress {
                    worker_stage: if spawning { "spawning".to_owned() } else { status.clone() },
                    last_progress: if spawning { "spawning worker session".to_owned() } else { status.clone() },
                    diagnostic: if spawning { "worker session not started yet".to_owned() } else { status },
                    ..Progress::default()
                },
            );
        }
    }

    /// The job as a status card.
    async fn render(&self, job: JobData, include_result: bool) -> Job {
        let now = self.clock.now_ms();
        let meta = &job.meta;
        let mut view = TaskView {
            task_id: job.task_id.clone().unwrap_or_default(),
            status: Some(job.status.clone()),
            kind: Some(job.operation.clone()),
            tag: meta.tag.clone().filter(|t| !t.is_empty()),
            session_id: meta.session_id.clone().filter(|t| !t.is_empty()),
            agent: meta.agent.clone().filter(|t| !t.is_empty()),
            provider: meta.provider.clone().filter(|t| !t.is_empty()),
            model: meta.model.clone().filter(|t| !t.is_empty()),
            effort: meta.effort.clone().filter(|t| !t.is_empty()),
            fast: meta.fast,
            started_at: job.started_at.clone(),
            finished_at: job.finished_at.clone(),
            error: job.error.clone().filter(|t| !t.is_empty()),
            ..TaskView::default()
        };
        if meta.respawned {
            view.respawned = true;
            view.note = Some("previous session reaped — fresh session, no prior context; re-supply anchors if needed".to_owned());
        } else if meta.resumed {
            view.resumed = true;
            view.note = Some("previous session reaped — resumed from its saved transcript, prior context kept".to_owned());
        }
        self.apply_job_progress(&mut view, &job).await;
        view.elapsed = elapsed_from_stamps(job.started_at.as_deref().unwrap_or_default(), job.finished_at.as_deref().unwrap_or_default(), now);
        if include_result {
            view.result = job.result.clone();
        }
        Job { task_id: job.task_id, session_id: meta.session_id.clone().filter(|s| !s.is_empty()), view }
    }

    /// The job `task_id` as its status card (the answer to a spawn or send).
    pub async fn card(&self, task_id: &str, scope: &Scope, include_result: bool) -> Option<Job> {
        let snapshot = self.board.get(task_id, scope)?;
        Some(self.render(snapshot.into(), include_result).await)
    }

    /// `getJob`.
    fn find(&self, args: &Value, scope: &Scope) -> Result<JobSnapshot, String> {
        let task_id = clean(args.get("task_id"));
        if !task_id.is_empty() {
            return self.board.get(&task_id, scope).ok_or_else(|| format!("agent read/status: task \"{task_id}\" not found"));
        }
        let target = first_truthy(&[args.get("tag"), args.get("sessionId")]);
        if target.is_empty() {
            return Err("agent read/status: task_id, tag, or sessionId is required".to_owned());
        }
        let mut candidates: Vec<JobSnapshot> = self
            .board
            .list_jobs(scope)
            .into_iter()
            .filter(|t| t.meta.tag.as_deref() == Some(target.as_str()) || t.meta.session_id.as_deref() == Some(target.as_str()))
            .collect();
        if candidates.is_empty() {
            return Err(format!("agent read/status: no task found for tag/sessionId \"{target}\""));
        }
        // The newest when several match one tag.
        candidates.sort_by_key(|candidate| std::cmp::Reverse(candidate.started_ms));
        Ok(candidates.swap_remove(0))
    }

    /// `workerFallbackJob`: a worker session outlives its spawn task, which is pruned or lost
    /// with a restart.
    async fn worker_fallback(&self, target: &str, scope: &Scope) -> Result<Option<JobData>, String> {
        // "No such worker" is an answer only from the worker rows read whole.
        self.registry.refresh_tags_from_sessions(true, scope).await?;
        let bound = self.registry.tag_session(target);
        let session_id = match bound.clone() {
            Some(bound) => bound,
            None => match self.workers.session(target).await {
                Some(_) => target.to_owned(),
                None => return Ok(None),
            },
        };
        let Some(session) = self.workers.session(&session_id).await else { return Ok(None) };
        let status = if session.closed { "closed".to_owned() } else { session.status.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| "idle".to_owned()) };
        Ok(Some(JobData {
            task_id: None,
            operation: "worker".to_owned(),
            status,
            // session.createdAt || null: the number itself, which the card shows as its digits.
            started_at: session.created_at.as_ref().and_then(Stamp::shown),
            finished_at: None,
            error: None,
            result: Some(TaskResult::Content(session.result_text.clone())),
            meta: JobMeta {
                tag: if bound.is_some() { Some(target.to_owned()) } else { session.tag.clone() },
                session_id: Some(session_id),
                agent: session.agent.clone(),
                preset: session.preset.clone(),
                provider: session.provider.clone(),
                model: session.model.clone(),
                effort: session.effort.clone(),
                fast: Some(session.fast),
                ..JobMeta::default()
            },
            turn_stage: None,
        }))
    }
}

#[async_trait]
impl Views for JobViews {
    async fn get_job_or_worker(&self, args: &Value, scope: &Scope, include_result: bool) -> Result<Job, String> {
        let error = match self.find(args, scope) {
            Ok(snapshot) => return Ok(self.render(snapshot.into(), include_result).await),
            Err(error) => error,
        };
        let target = first_truthy(&[args.get("tag"), args.get("sessionId")]);
        if !target.is_empty()
            && let Some(job) = self.worker_fallback(&target, scope).await?
        {
            return Ok(self.render(job, include_result).await);
        }
        Err(error)
    }

    async fn list(&self, scope: &Scope, options: ListOptions) -> Result<Vec<WorkerRow>, String> {
        self.registry.refresh_tags_from_sessions(options.scan_sessions, scope).await?;
        let mut rows = Vec::new();
        for (tag, facts) in self.workers.entries(options.scan_sessions, scope).await {
            // An agent its owner closed (and no turn started on since) is not listed, as Node's list drops it once closed.
            if self.registry.is_released(&facts.id) {
                continue;
            }
            let live = self.workers.live(&facts.id);
            let (status, stage) = row_state(&facts, live.runtime_stage.as_deref());
            // Whether a row is listed depends on its status and stage alone, so a finished
            // worker is dropped before its progress is read.
            let listed = options.include_terminal
                || is_active_worker(&status, &stage)
                || (options.include_idle && is_open_idle(&status, &stage))
                || (options.include_closed && status == "closed");
            if !listed {
                continue;
            }
            let progress = self.progress_of(&facts.id, None).await;
            let hung = progress.diagnostic.starts_with("tool possibly hung").then(|| progress.diagnostic.clone());
            rows.push(WorkerRow {
                tag,
                active: facts.awaiting_user || is_active_worker(&status, &stage),
                status: Some(status),
                stage: Some(stage),
                last_progress: Some(progress.last_progress),
                tool_silent_for: progress.tool_silent_for,
                hung_diagnostic: hung,
                stamp: facts.updated_at.as_ref().and_then(Stamp::shown).or_else(|| facts.last_used_at.as_ref().and_then(Stamp::shown)).unwrap_or_default(),
            });
        }
        Ok(rows)
    }

    async fn list_jobs(&self, scope: &Scope) -> Vec<JobRow> {
        let mut rows = Vec::new();
        for task in self.board.list_jobs(scope) {
            // A running job whose worker belongs to another host process is not this one's.
            if let Some(wanted) = scope.host_pid
                && !task.is_terminal()
            {
                let pid = match task.meta.session_id.as_deref() {
                    Some(id) => self.workers.session(id).await.and_then(|s| s.client_host_pid).filter(|p| *p > 0),
                    None => None,
                };
                if pid.is_some_and(|pid| pid != wanted) {
                    continue;
                }
            }
            let finished = task.is_terminal();
            rows.push(JobRow {
                stamp: iso_from_ms(task.finished_ms.unwrap_or(task.started_ms)),
                task_id: task.task_id,
                kind: task.operation,
                status: task.status,
                tag: task.meta.tag,
                error: task.error,
                finished,
            });
        }
        rows
    }
}

#[cfg(test)]
mod route_sync_tests {
    use super::*;
    use crate::agent_tool::board::NewJob;
    use crate::agent_tool::host::{Released, ResolveOptions, Resumable, TurnMark};
    use crate::agent_tool::scope::{SessionFacts, TagRecord};
    use std::collections::HashMap;
    use std::sync::Mutex;

    struct FixedClock;
    impl Clock for FixedClock {
        fn now_ms(&self) -> i64 {
            1_700_000_000_000
        }
    }

    struct StubRegistry;
    #[async_trait]
    impl Registry for StubRegistry {
        async fn resolve_tombstone_owners(&self) {}
        async fn refresh_tags_from_sessions(&self, _: bool, _: &Scope) -> Result<(), String> {
            Ok(())
        }
        async fn resolve_tag(&self, _: &str, _: &Scope, _: ResolveOptions) -> Result<Option<String>, String> {
            Ok(None)
        }
        async fn live_session(&self, _: &str) -> Option<SessionFacts> {
            None
        }
        fn tag_session(&self, _: &str) -> Option<String> {
            None
        }
        fn has_tag_agent(&self, _: &str) -> bool {
            false
        }
        async fn tag_for_session(&self, _: &str) -> Option<String> {
            None
        }
        fn unbind_tag(&self, _: &str) {}
        async fn bind_tag(&self, _: &str, _: &SessionFacts, _: &str) {}
        fn forget_terminal_session(&self, _: Option<&str>, _: &str) {}
        fn remove_worker_row(&self, _: &str) {}
        fn release_closed_at(&self, _: &Scope, _: Option<&str>, _: &str, _: &[String], _: Option<&HashMap<String, Option<TurnMark>>>) -> Released {
            Released::default()
        }
        fn mark_released(&self, _: &[String]) {}
        fn read_worker_rows(&self, _: &Scope) -> Result<Vec<TagRecord>, String> {
            Ok(Vec::new())
        }
        fn bound_sessions(&self) -> Vec<String> {
            Vec::new()
        }
        fn read_all_tag_tombstones(&self) -> Vec<TagRecord> {
            Vec::new()
        }
        fn tag_tombstone_for_tag(&self, _: &str, _: &Scope) -> Option<TagRecord> {
            None
        }
        fn consume_tag_tombstone(&self, _: &TagRecord) {}
        async fn last_tag_session(&self, _: &str, _: &Scope) -> Option<TagRecord> {
            None
        }
        async fn resumable_tag_session(&self, _: &str, _: &str, _: &Scope) -> Result<Option<Resumable>, String> {
            Ok(None)
        }
    }

    struct StubWorkers(Mutex<WorkerFacts>);
    #[async_trait]
    impl Workers for StubWorkers {
        async fn session(&self, _: &str) -> Option<WorkerFacts> {
            Some(self.0.lock().unwrap().clone())
        }
        fn live(&self, _: &str) -> WorkerLive {
            WorkerLive::default()
        }
        async fn entries(&self, _: bool, _: &Scope) -> Vec<(String, WorkerFacts)> {
            Vec::new()
        }
    }

    #[tokio::test]
    async fn live_job_card_surfaces_committed_active_route_from_worker_session() {
        let clock: Arc<dyn Clock> = Arc::new(FixedClock);
        let board = JobBoard::new(clock.clone(), None, None);
        let task_id = board
            .register(NewJob {
                operation: "spawn".into(),
                meta: JobMeta {
                    tag: Some("scout".into()),
                    session_id: Some("sess_w1".into()),
                    agent: Some("worker".into()),
                    provider: Some("openai".into()),
                    model: Some("gpt-5".into()),
                    effort: Some("high".into()),
                    fast: Some(false),
                    ..JobMeta::default()
                },
                ..NewJob::default()
            })
            .unwrap();
        let workers = Arc::new(StubWorkers(Mutex::new(WorkerFacts {
            id: "sess_w1".into(),
            provider: Some("anthropic".into()),
            model: Some("sonnet-4".into()),
            effort: Some("low".into()),
            fast: true,
            status: Some("running".into()),
            ..WorkerFacts::default()
        })));
        let views = JobViews::new(board, Arc::new(StubRegistry), workers, clock);
        let card = views.card(&task_id, &Scope::default(), false).await.expect("card");
        assert_eq!(
            (card.view.provider.as_deref(), card.view.model.as_deref(), card.view.effort.as_deref(), card.view.fast),
            (Some("anthropic"), Some("sonnet-4"), Some("low"), Some(true))
        );
    }

    #[tokio::test]
    async fn live_job_card_clears_effort_and_flips_fast_even_on_same_provider_and_model() {
        let clock: Arc<dyn Clock> = Arc::new(FixedClock);
        let board = JobBoard::new(clock.clone(), None, None);
        let task_id = board
            .register(NewJob {
                operation: "spawn".into(),
                meta: JobMeta {
                    tag: Some("scout".into()),
                    session_id: Some("sess_w1".into()),
                    agent: Some("worker".into()),
                    provider: Some("openai".into()),
                    model: Some("gpt-5".into()),
                    effort: Some("high".into()),
                    fast: Some(true),
                    ..JobMeta::default()
                },
                ..NewJob::default()
            })
            .unwrap();
        let workers = Arc::new(StubWorkers(Mutex::new(WorkerFacts {
            id: "sess_w1".into(),
            provider: Some("openai".into()),
            model: Some("gpt-5".into()),
            effort: None,
            fast: false,
            status: Some("running".into()),
            ..WorkerFacts::default()
        })));
        let views = JobViews::new(board, Arc::new(StubRegistry), workers, clock);
        let card = views.card(&task_id, &Scope::default(), false).await.expect("card");
        assert_eq!(
            (card.view.provider.as_deref(), card.view.model.as_deref(), card.view.effort.as_deref(), card.view.fast),
            (Some("openai"), Some("gpt-5"), None, Some(false))
        );
    }
}
