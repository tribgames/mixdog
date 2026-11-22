//! Delegated agents and jobs, stated as behaviours: what a job board counts and keeps, what a settled turn
//! does to the job and the worker's row, what the owner is told, how a spawn and a send behave, and the
//! watchdog's verdicts and texts. Inputs are written here; the expected values follow from each rule.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicI64;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use mixdog_agent::agent_tool::board::CancelAll;
use mixdog_agent::agent_tool::board::CancelNotice;
use mixdog_agent::agent_tool::board::Completion;
use mixdog_agent::agent_tool::board::JobBoard;
use mixdog_agent::agent_tool::board::JobMeta;
use mixdog_agent::agent_tool::board::JobOwner;
use mixdog_agent::agent_tool::board::JobSnapshot;
use mixdog_agent::agent_tool::board::NewJob;
use mixdog_agent::agent_tool::flow::reconcile::FinalStatus;
use mixdog_agent::agent_tool::flow::reconcile::JobHandle;
use mixdog_agent::agent_tool::flow::reconcile::reconcile_finally;
use mixdog_agent::agent_tool::flow::reconcile::reconcile_watchdog_partial;
use mixdog_agent::agent_tool::flow::result::WorkerResult;
use mixdog_agent::agent_tool::flow::seams::RowUpdate;
use mixdog_agent::agent_tool::flow::seams::SessionNames;
use mixdog_agent::agent_tool::flow::seams::TurnListener;
use mixdog_agent::agent_tool::flow::seams::TurnOutcome;
use mixdog_agent::agent_tool::flow::seams::TurnResult;
use mixdog_agent::agent_tool::flow::seams::TurnSource;
use mixdog_agent::agent_tool::flow::seams::TurnStart;
use mixdog_agent::agent_tool::flow::seams::Unobserve;
use mixdog_agent::agent_tool::flow::seams::WorkerRows;
use mixdog_agent::agent_tool::flow::worker_turns::PROCESS_RESTART_FAILURE;
use mixdog_agent::agent_tool::flow::worker_turns::WorkerTurns;
use mixdog_agent::agent_tool::flow::world::SpawnContext;
use mixdog_agent::agent_tool::host::DispatchOptions;
use mixdog_agent::agent_tool::host::Prepared;
use mixdog_agent::agent_tool::host::SpawnOptions;
use mixdog_agent::agent_tool::progress::Snapshot;
use mixdog_agent::agent_tool::progress::WatchdogPolicy;
use mixdog_agent::agent_tool::progress::stale_report;
use mixdog_agent::agent_tool::scope::Caller;
use mixdog_agent::agent_tool::scope::Scope;
use mixdog_agent::agent_tool::scope::SessionFacts;
use mixdog_agent::agent_tool::watchdog::AgentKind;
use mixdog_agent::agent_tool::watchdog::Overrides;
use mixdog_agent::agent_tool::watchdog::is_watchdog_abort;
use mixdog_agent::agent_tool::watchdog::resolve_policy;
use mixdog_agent::agent_tool::watchdog::stall_warn_ms;
use mixdog_agent::agent_tool::watchdog::stopped_handoff;
use mixdog_agent::compact::pressure::Header;
use mixdog_agent::compact::pressure::TerminalUsage;
use mixdog_agent::compact::pressure::terminal_usage;
use mixdog_agent::env::Clock;
use mixdog_agent::response::Termination;
use mixdog_agent::result_kind::ResultKind;
use mixdog_agent::result_kind::classify_result_kind;
use mixdog_protocol::ThreadId;
use mixdog_tools::exec::TaskNotifier;
use mixdog_tools::orch::agent::TaskResult;
use mixdog_tools::orch::agent::render;
use serde_json::Value;
use serde_json::json;

use crate::flow_scenarios::Rig;
use crate::flow_scenarios::asked;
use crate::flow_scenarios::backend;
use crate::flow_scenarios::execute_with_parts;
use crate::flow_scenarios::lock;
use crate::flow_scenarios::resolved_parts;
use crate::flow_scenarios::rig;
use crate::flow_scenarios::settle;

/// 2026-03-01T10:00:00.000Z
const START: i64 = 1_772_359_200_000;

struct TestClock(AtomicI64);
impl Clock for TestClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

fn register(board: &JobBoard, id: &str, caller: Option<&str>, pid: Option<u64>, session: Option<&str>) {
    board
        .register(NewJob {
            task_id: Some(id.into()),
            label: Some(id.into()),
            operation: "spawn".into(),
            owner: JobOwner { caller_session_id: caller.map(str::to_owned), owner_session_id: None, host_pid: pid },
            meta: JobMeta { tag: Some(id.into()), session_id: session.map(str::to_owned), ..JobMeta::default() },
            ..NewJob::default()
        })
        .unwrap();
}

fn done(board: &JobBoard, id: &str) {
    board.complete(id, Completion { notify: false, ..Completion::new("completed") });
}

// ---- the job board ---------------------------------------------------------------------------------

/// The busy count is what keeps the lead from being treated as idle: the running jobs of the asking scope,
/// where a running job whose worker session belongs to another client process of the shared daemon is not that
/// client's, and a finished job is never busy.
#[tokio::test(start_paused = true)]
async fn the_busy_count_is_the_running_jobs_of_the_scope_on_its_own_client_process() {
    backend();
    let board = JobBoard::new(Arc::new(TestClock(AtomicI64::new(START))), None, None);
    register(&board, "a", Some("s1"), Some(11), Some("w11"));
    register(&board, "b", Some("s1"), Some(11), Some("w12"));
    register(&board, "c", Some("s2"), Some(11), Some("w11"));
    register(&board, "d", Some("s1"), Some(11), Some("w11"));
    register(&board, "e", Some("s1"), Some(11), Some("unknown"));
    done(&board, "d");
    // The worker sessions' client processes: w11 runs under 11, w12 under 12, `unknown` has no record.
    let pid = |session: &str| match session {
        "w11" => Some(11),
        "w12" => Some(12),
        _ => None,
    };
    let s1_on_11 = Scope { caller_session_id: Some("s1".into()), host_pid: Some(11) };
    let ids = |scope: &Scope| board.list_jobs_for_client(scope, &pid).into_iter().map(|j| j.task_id).collect::<Vec<_>>();
    // b runs under another process and drops out; the finished d stays listed but is not busy; e has no record and stays.
    assert_eq!(ids(&s1_on_11), ["a", "d", "e"]);
    assert_eq!(board.busy_count(&s1_on_11, &pid), 2);
    let s1_on_12 = Scope { caller_session_id: Some("s1".into()), host_pid: Some(12) };
    assert_eq!(ids(&s1_on_12), ["b", "d", "e"]);
    assert_eq!(board.busy_count(&s1_on_12, &pid), 2);
    // Another session's jobs are not this scope's, and a scope with no process asks no worker.
    assert_eq!(board.running_count("s2"), 1);
    assert_eq!(board.running_count("s1"), 3);
    assert_eq!(board.running_count("nobody"), 0);
}

/// A finished job stays on the board for 30 minutes so it can be read, then leaves; a running job never expires.
#[tokio::test(start_paused = true)]
async fn a_finished_job_leaves_the_board_after_thirty_minutes_and_a_running_one_stays() {
    backend();
    let clock = Arc::new(TestClock(AtomicI64::new(START)));
    let board = JobBoard::new(clock.clone(), None, None);
    register(&board, "finished", Some("s1"), None, None);
    register(&board, "running", Some("s1"), None, None);
    done(&board, "finished");
    let scope = Scope { caller_session_id: Some("s1".into()), host_pid: None };
    clock.0.fetch_add(30 * 60_000, Ordering::SeqCst);
    assert_eq!(board.list_jobs(&scope).len(), 2, "exactly at the retention it is still there");
    clock.0.fetch_add(1, Ordering::SeqCst);
    let left: Vec<String> = board.list_jobs(&scope).into_iter().map(|j| j.task_id).collect();
    assert_eq!(left, ["running"]);
}

/// An owner that takes a completion only once it is let.
struct SlowOwner {
    arrived: tokio::sync::Notify,
    take: tokio::sync::Notify,
}
#[async_trait]
impl TaskNotifier for SlowOwner {
    async fn finished(&self, _owner: &ThreadId, _surface: &str, _task_id: &str, _status: &str, _notification: String) {
        self.arrived.notify_one();
        self.take.notified().await;
    }
}

/// A job's completion goes to its owner from a task of its own, so the job can be pruned first. Its owner keeps the
/// completion's receipt for as long as the board lists the job as held: a completion still on its way is listed, and it
/// is let go of once the owner has taken it. Not listed, the owner dropped the receipt and queued the same result again.
#[tokio::test(start_paused = true)]
async fn a_pruned_job_is_still_held_for_its_owner_while_its_completion_is_on_its_way() {
    backend();
    let owner = Arc::new(SlowOwner { arrived: tokio::sync::Notify::new(), take: tokio::sync::Notify::new() });
    let board = JobBoard::new(Arc::new(TestClock(AtomicI64::new(START))), Some(owner.clone()), None);
    register(&board, "job", Some("lead"), None, None);
    board.complete("job", Completion::new("completed"));
    owner.arrived.notified().await;
    assert_eq!(board.cleanup_jobs(&Scope::default(), true), 1, "the row is gone");
    assert_eq!(board.held_by("lead"), ["job"], "its completion has not reached the owner");
    assert!(board.held_by("other").is_empty());
    owner.take.notify_one();
    settle().await;
    assert!(board.held_by("lead").is_empty(), "taken by the owner, nothing of the job is left to deliver");
}

// ---- what a settled turn does to its job -----------------------------------------------------------

#[derive(Default)]
struct Owner(Mutex<Vec<String>>);
#[async_trait]
impl TaskNotifier for Owner {
    async fn finished(&self, _owner: &ThreadId, _surface: &str, _task_id: &str, _status: &str, notification: String) {
        lock(&self.0).push(notification);
    }
}

fn watched(board: &JobBoard, id: &str) -> Arc<JobHandle> {
    register(board, id, Some("lead"), None, None);
    Arc::new(JobHandle::new(board.clone(), id.into(), "spawn".into(), None))
}

fn result_json(row: &JobSnapshot) -> Value {
    match &row.result {
        Some(TaskResult::Json(v)) => v.clone(),
        other => panic!("{other:?}"),
    }
}

/// A turn the watchdog stopped that still left partial output is reported to the owner as a failure (never as a
/// completion) carrying that output, once, and a later net reconcile does not turn it back into a success.
#[tokio::test(start_paused = true)]
async fn a_watchdog_stop_with_partial_output_reaches_the_owner_once_as_a_failure() {
    backend();
    let owner = Arc::new(Owner::default());
    let board = JobBoard::new(Arc::new(TestClock(AtomicI64::new(START))), Some(owner.clone()), None);
    let job = watched(&board, "task_wd");
    let value = WorkerResult { value: json!({ "tag": "worker", "content": "partial findings", "stallAbort": true }), error: None };
    job.set_terminal_value(value.clone());
    reconcile_watchdog_partial(&job, &value);
    reconcile_finally(&job, FinalStatus::Idle);
    settle().await;
    let row = job.snapshot().unwrap();
    assert_eq!((row.status.as_str(), row.terminal_reason.as_deref()), ("failed", Some("agent-watchdog-partial")));
    assert_eq!(row.error.as_deref(), Some("stalled: the progress watchdog stopped the turn"));
    assert_eq!(result_json(&row)["content"], "partial findings");
    let told = lock(&owner.0).clone();
    assert_eq!(told.len(), 1);
    assert!(
        told[0].contains("<status>failed</status>")
            && told[0].contains("partial findings")
            && told[0].contains("<error>stalled: the progress watchdog stopped the turn</error>"),
        "{}",
        told[0]
    );
}

/// The finishing net settles a job whose terminal result was recorded but never reconciled: a normal end completes it
/// with the recorded value, an errored end fails it with the recorded error, and a turn with no recorded value
/// changes nothing.
#[tokio::test(start_paused = true)]
async fn the_finishing_net_settles_a_stranded_job_from_its_recorded_terminal_value() {
    backend();
    let board = JobBoard::new(Arc::new(TestClock(AtomicI64::new(START))), None, None);
    let ok = watched(&board, "t_ok");
    ok.set_terminal_value(WorkerResult { value: json!({ "content": "answer" }), error: None });
    reconcile_finally(&ok, FinalStatus::Idle);
    let row = ok.snapshot().unwrap();
    assert_eq!((row.status.as_str(), row.error.clone(), row.terminal_reason.as_deref()), ("completed", None, Some("agent-finally-reconcile")));
    assert_eq!(result_json(&row)["content"], "answer");

    let bad = watched(&board, "t_bad");
    bad.set_terminal_value(WorkerResult { value: json!({ "content": "" }), error: Some("agent finished without a final answer".into()) });
    reconcile_finally(&bad, FinalStatus::Error);
    let row = bad.snapshot().unwrap();
    assert_eq!((row.status.as_str(), row.error.as_deref()), ("failed", Some("agent finished without a final answer")));

    let none = watched(&board, "t_none");
    reconcile_finally(&none, FinalStatus::Idle);
    assert_eq!(none.status().as_deref(), Some("running"));
}

// ---- the worker's row ------------------------------------------------------------------------------

#[derive(Default)]
struct Probe {
    listener: Mutex<Option<Arc<dyn TurnListener>>>,
    rows: Mutex<Vec<RowUpdate>>,
}
struct Source(Arc<Probe>);
impl TurnSource for Source {
    fn observe_session_turns(&self, _: &str, listener: Arc<dyn TurnListener>) -> Option<Unobserve> {
        *lock(&self.0.listener) = Some(listener);
        Some(Box::new(|| {}))
    }
}
struct Rows(Arc<Probe>);
impl WorkerRows for Rows {
    fn upsert(&self, _: &str, _: Option<&str>, update: RowUpdate) {
        lock(&self.0.rows).push(update);
    }
}
struct Names;
impl SessionNames for Names {
    fn tag_for_session(&self, _: &str) -> Option<String> {
        Some("scout".into())
    }
    fn agent(&self, _: &str) -> Option<String> {
        Some("worker".into())
    }
}

struct Turns {
    probe: Arc<Probe>,
    board: JobBoard,
    turns: WorkerTurns,
}

fn turns() -> Turns {
    let probe = Arc::new(Probe::default());
    let clock: Arc<dyn Clock> = Arc::new(TestClock(AtomicI64::new(START)));
    let board = JobBoard::new(clock.clone(), None, None);
    let turns = WorkerTurns::new(Arc::new(Source(probe.clone())), Arc::new(Rows(probe.clone())), Arc::new(Names), clock, Arc::new(|| {}));
    Turns { probe, board, turns }
}

impl Turns {
    /// Runs one turn of the session for `job`: the turn starts, then settles as `outcome`.
    fn run(&self, job: Option<Arc<JobHandle>>, outcome: TurnOutcome) -> Vec<RowUpdate> {
        let claim = self.turns.claim("sess_w1", job);
        let listener = lock(&self.probe.listener).clone().expect("the session is observed");
        listener.turn_started(TurnStart { turn_id: "turn-1".into(), started_at_ms: START, submission_ids: vec![claim.submission_id.clone()] });
        listener.turn_settled(TurnOutcome { turn_id: "turn-1".into(), ..outcome });
        claim.release(FinalStatus::Idle);
        std::mem::take(&mut *lock(&self.probe.rows))
    }
}

fn ended(done: bool, stalled: bool, result: Option<TurnResult>) -> TurnOutcome {
    TurnOutcome { turn_id: String::new(), done, result, stalled }
}

/// A worker's row says `running` from the real start of a turn (carrying the job that runs it) and settles on how the
/// turn ended: a finished one idle, a stopped one an error, a watchdog stop a failure with the stall reason, an owner's
/// cancel cancelled, and an empty finish an error; a turn cut off by a process restart is failed with that reason.
#[tokio::test(start_paused = true)]
async fn a_workers_row_runs_while_its_turn_does_and_settles_on_how_the_turn_ended() {
    backend();
    let t = turns();
    let finished = Some(TurnResult { content: "ok".into(), iterations: 1, ..TurnResult::default() });
    let job = watched(&t.board, "task_a");
    let rows = t.run(Some(job.clone()), ended(true, false, finished.clone()));
    assert_eq!(rows.len(), 2);
    assert_eq!((rows[0].status.as_deref(), rows[0].task_id.clone()), (Some("running"), Some(Some("task_a".to_owned()))));
    assert_eq!(rows[0].turn_started_at.as_deref(), Some("2026-03-01T10:00:00.000Z"));
    assert_eq!((rows[1].status.as_deref(), rows[1].stage.as_deref()), (Some("idle"), Some("idle")));
    assert_eq!(rows[1].finished_at.as_deref(), Some("2026-03-01T10:00:00.000Z"));

    let settled = |rows: &[RowUpdate]| (rows[1].status.clone().unwrap(), rows[1].failure_reason.clone());
    assert_eq!(settled(&t.run(None, ended(false, false, None))), ("error".into(), None));
    assert_eq!(settled(&t.run(None, ended(false, true, None))), ("failed".into(), Some("stalled".into())));
    let empty = Some(TurnResult { termination: Some(Termination::Empty), ..TurnResult::default() });
    assert_eq!(settled(&t.run(None, ended(true, false, empty))), ("error".into(), None));

    let cancelled = watched(&t.board, "task_b");
    t.board.cancel("task_b", "user stop", CancelNotice::Never);
    assert_eq!(settled(&t.run(Some(cancelled), ended(false, false, None))), ("cancelled".into(), None));

    let cut = watched(&t.board, "task_c");
    t.board.cancel_all(&CancelAll {
        scope: Scope { caller_session_id: Some("lead".into()), host_pid: None },
        terminal_reason: Some(PROCESS_RESTART_FAILURE.into()),
        notice: CancelNotice::Never,
        ..CancelAll::default()
    });
    let rows = t.run(Some(cut), ended(false, false, None));
    assert_eq!(
        (rows[1].status.as_deref(), rows[1].failure_reason.as_deref(), rows[1].task_id.clone()),
        (Some("failed"), Some("process-restart"), Some(Some("task_c".to_owned())))
    );
}

/// A dispatch that opened no turn at all still settles the row itself, on the status it ends with.
#[tokio::test(start_paused = true)]
async fn a_dispatch_that_started_no_turn_settles_the_row_on_release() {
    backend();
    let t = turns();
    let claim = t.turns.claim("sess_w1", None);
    claim.release(FinalStatus::Error);
    let rows = std::mem::take(&mut *lock(&t.probe.rows));
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].status.as_deref(), Some("error"));
}

// ---- terminal totals -------------------------------------------------------------------------------

fn header(v: Value) -> Header {
    v.as_object().unwrap().clone()
}

fn finish(header: &mut Header, usage: &Value, tool_calls: f64, incremental: bool) {
    let ask = TerminalUsage {
        usage: Some(usage),
        last_turn: usage,
        tool_calls_total: tool_calls,
        incremental,
        input_excludes_cache: false,
        now: 1_800_000_000_000.0,
    };
    terminal_usage(header, &ask).apply(header);
}

/// A finished turn adds its tokens and its tool calls (the delegated agents' calls included, as the turn counted
/// them) to the session totals once, and the context gauge takes the turn's own last reading.
#[test]
fn a_finished_turn_adds_its_tokens_and_tool_calls_to_the_session_totals() {
    let mut h = header(json!({ "provider": "openai", "totalInputTokens": 0, "totalOutputTokens": 0 }));
    finish(&mut h, &json!({ "inputTokens": 10, "outputTokens": 2 }), 4.0, false);
    assert_eq!(
        (h["totalInputTokens"].clone(), h["totalOutputTokens"].clone(), h["totalToolCalls"].clone(), h["tokensCumulative"].clone()),
        (json!(10), json!(2), json!(4), json!(12))
    );
    assert_eq!((h["lastInputTokens"].clone(), h["lastOutputTokens"].clone(), h["lastContextTokens"].clone()), (json!(10), json!(2), json!(10)));
    finish(&mut h, &json!({ "inputTokens": 5, "outputTokens": 1 }), 2.0, false);
    assert_eq!(
        (h["totalInputTokens"].clone(), h["totalOutputTokens"].clone(), h["totalToolCalls"].clone(), h["tokensCumulative"].clone()),
        (json!(15), json!(3), json!(6), json!(18))
    );
}

/// When every response already counted its own usage, the turn end does not add them again, but still refreshes the gauge.
#[test]
fn a_turn_whose_responses_were_counted_one_by_one_is_not_counted_again_at_its_end() {
    let mut h = header(json!({ "provider": "openai", "totalInputTokens": 10, "totalOutputTokens": 2, "totalToolCalls": 4, "tokensCumulative": 12 }));
    finish(&mut h, &json!({ "inputTokens": 30, "outputTokens": 7 }), 4.0, true);
    assert_eq!(
        (h["totalInputTokens"].clone(), h["totalOutputTokens"].clone(), h["totalToolCalls"].clone(), h["tokensCumulative"].clone()),
        (json!(10), json!(2), json!(4), json!(12))
    );
    assert_eq!(h["lastInputTokens"], json!(30));
}

// ---- the watchdog ----------------------------------------------------------------------------------

fn no_env(_: &str) -> Option<String> {
    None
}

/// The deadlines a job's watchdog runs under: defaults of 2 minutes to the first transport and 10 to the first
/// visible output; the idle backstop is the role's stall budget (10 minutes, 5 for a worker, 7 for a heavy worker,
/// the hidden agent's own cap) held at least a tick above the provider's own recovery window; `STALL_TIMEOUT_S` moves it.
#[test]
fn the_watchdog_policy_follows_the_agent_role_the_environment_and_the_overrides() {
    let idle = |kind: AgentKind<'_>, env: &dyn Fn(&str) -> Option<String>| resolve_policy(kind, Overrides::default(), env).idle_stale_ms;
    let policy = resolve_policy(AgentKind::default(), Overrides::default(), &no_env);
    assert_eq!((policy.first_transport_ms, policy.first_semantic_ms, policy.idle_stale_ms), (120_000, 600_000, 600_000));
    assert_eq!(
        idle(AgentKind { name: Some("worker"), ..AgentKind::default() }, &no_env),
        315_000,
        "5 minutes, held above the provider's 300 s recovery window plus a tick"
    );
    assert_eq!(idle(AgentKind { name: Some("heavy-worker"), ..AgentKind::default() }, &no_env), 420_000);
    assert_eq!(idle(AgentKind { name: Some("x"), hidden: true, stall_cap_idle_seconds: Some(900) }, &no_env), 900_000);
    let env = |name: &str| (name == "STALL_TIMEOUT_S").then(|| "100".to_owned());
    assert_eq!(idle(AgentKind::default(), &env), 100_000);
    let own = Overrides { idle_timeout_ms: Some(4_000), first_transport_timeout_ms: Some(7_000), ..Overrides::default() };
    let policy = resolve_policy(AgentKind::default(), own, &no_env);
    // A deadline shorter than the provider's own first-byte budget (60 s) is held one tick (15 s) above it.
    assert_eq!((policy.idle_stale_ms, policy.first_transport_ms), (4_000, 75_000));
    let long = Overrides { first_transport_timeout_ms: Some(200_000), ..Overrides::default() };
    assert_eq!(resolve_policy(AgentKind::default(), long, &no_env).first_transport_ms, 200_000);
    assert_eq!(stall_warn_ms(AgentKind::default(), &no_env), 600_000);
    assert_eq!(stall_warn_ms(AgentKind { name: Some("worker"), ..AgentKind::default() }, &no_env), 300_000);
    assert_eq!(stall_warn_ms(AgentKind::default(), &env), 100_000);
}

/// Only the sentences the watchdog itself aborts with count as a stall; a user cancel or any other abort does not.
#[test]
fn only_the_watchdogs_own_abort_sentences_are_a_stall() {
    for stall in [
        "agent task stale (600000ms without stream/tool progress)",
        "agent first transport stale (120000ms)",
        "agent first semantic response stale (600000ms)",
        "agent first response stale (5ms)",
        "agent task stale  (1ms)",
    ] {
        assert!(is_watchdog_abort(stall), "{stall}");
    }
    for other in ["agent task stale", "task stale (1ms)", "agent something stale (1ms)", "Session closed: closeSession", "", "Agent task stale (1ms)"] {
        assert!(!is_watchdog_abort(other), "{other}");
    }
}

/// The owner reads the stop and its reason before the partial text, and which background shell jobs the stop ended or
/// is still ending.
#[test]
fn a_watchdog_handoff_names_the_stop_then_the_shell_jobs_then_the_partial_text() {
    let names = |l: &[&str]| l.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
    assert_eq!(
        stopped_handoff("agent task stale (1ms)", "half done", &[], &[]),
        "[Agent stopped by the progress watchdog: agent task stale (1ms). The output below is partial.]\n\nhalf done"
    );
    assert_eq!(
        stopped_handoff("m", "p", &names(&["a", "b"]), &names(&["c"])),
        "[Agent stopped by the progress watchdog: m. The output below is partial.]\n[Stopped its background shell jobs: a, b.] [Still stopping its background shell jobs: c.]\n\np"
    );
}

/// A run is stale when it made no progress for the idle budget, unless a keepalive newer than that progress still holds it;
/// a person's approval is never a stall; the wait for the first transport has its own deadline.
#[test]
fn a_run_is_stale_after_the_idle_budget_unless_a_keepalive_or_an_approval_holds_it() {
    let policy = WatchdogPolicy { first_transport_ms: 120_000, first_semantic_ms: 600_000, idle_stale_ms: 1_000 };
    let working = Snapshot { last_progress_at: 10_000, ..Snapshot::default() };
    assert_eq!(stale_report(&working, 10_900, &policy), None);
    assert_eq!(stale_report(&working, 11_001, &policy).as_deref(), Some("agent task stale (1000ms without stream/tool progress)"));
    let kept = Snapshot { last_keepalive_at: 11_000, ..working.clone() };
    assert_eq!(stale_report(&kept, 11_500, &policy), None, "a recent keepalive after the last progress holds it");
    assert!(stale_report(&kept, 13_001, &policy).is_some(), "but only up to three idle budgets past the last progress");
    let asking = Snapshot { awaiting_user: true, ..working };
    assert_eq!(stale_report(&asking, 999_999, &policy), None);
    let connecting = Snapshot { waiting_for_transport: true, model_request_started_at: 1_000, last_progress_at: 1_000, ..Snapshot::default() };
    assert_eq!(stale_report(&connecting, 121_001, &policy).as_deref(), Some("agent first transport stale (120000ms)"));
}

// ---- classification of the text a tool returned -----------------------------------------------------

#[test]
fn a_returned_text_is_an_error_a_zero_match_or_normal_by_its_start_and_tool() {
    use ResultKind::*;
    let kind = classify_result_kind;
    assert_eq!(kind("Error: agent: unknown type \"x\"", "agent"), Error);
    assert_eq!(kind("  error [code 7]: no", "agent"), Error);
    assert_eq!(kind("[ERROR something]", "agent"), Error);
    assert_eq!(kind("Errors happened", "agent"), Normal);
    assert_eq!(kind("(no matches)", "grep"), ZeroMatch);
    assert_eq!(kind("(no files found)", "glob"), ZeroMatch);
    assert_eq!(kind("agents: 0 · tasks: 0", "agent"), Normal);
    // A missing path is a miss, not a failure, for the read-only navigation tools only, and a permission refusal is still an error.
    assert_eq!(kind("Error: ENOENT: no such file", "read"), ZeroMatch);
    assert_eq!(kind("Error: ENOENT: no such file", "bash"), Error);
    assert_eq!(kind("Error: no such file: permission denied", "read"), Error);
}

// ---- the agent tool over a scripted world ------------------------------------------------------------

fn config() -> Value {
    json!({
        "default": "main-preset",
        "presets": [{ "id": "main-preset", "name": "MAIN", "provider": "anthropic", "model": "opus", "effort": "high" }],
        "agents": { "worker": { "provider": "openai", "model": "gpt-5", "effort": "medium" } },
    })
}

fn spawn_scenario(steps: Value) -> Value {
    json!({ "config": config(), "nextTag": "worker-1", "canonical": true, "owner": "lead", "lockOwner": "lead", "tags": {}, "steps": steps })
}

fn host() -> Value {
    json!({
        "agent": { "name": "worker", "defined": true, "disabled": false, "kind": null, "contact": false, "permission": null,
                   "candidates": [{ "provider": "openai", "model": "gpt-5", "effort": "medium" }] },
        "delegation": { "chain": ["lead"], "acting": "lead" },
    })
}

fn lead() -> SpawnContext {
    SpawnContext {
        caller_session_id: Some("lead".into()),
        session_id: None,
        owner_session_id: Some("lead".into()),
        client_host_pid: Some(4242),
        ..SpawnContext::default()
    }
}

fn args(tag: &str) -> Value {
    json!({ "agent": "worker", "prompt": "do it", "tag": tag })
}

/// Starts a spawn on a scripted world and lets it run out; answers the world and the job it made.
async fn spawned(scenario: Value, host: Value, args: Value, respawned: bool) -> (Rig, JobSnapshot) {
    backend();
    let rig = rig(&scenario, Some(&host));
    let context = lead();
    let job = rig.spawn.start_deferred_spawn_job(&args, "/work", &context, &context, SpawnOptions { respawned }).await.expect("the job starts");
    settle().await;
    settle().await;
    let row = rig.shared.board.get(job.task_id(), &Scope::default()).unwrap();
    (rig, row)
}

fn told(rig: &Rig) -> Vec<String> {
    lock(&rig.shared.notices).iter().filter(|n| n["session"] == "lead").map(|n| n["text"].as_str().unwrap().to_owned()).collect()
}

fn logged(rig: &Rig, head: &str) -> usize {
    lock(&rig.shared.log).iter().filter(|e| e == &&json!(head) || e[0] == head).count()
}

/// A spawn runs the worker's turn and the owner is told once that the agent completed, with the agent's identity;
/// the job carries the route it runs on and the status of the board is published at the start and at the end.
#[tokio::test(start_paused = true)]
async fn a_spawn_runs_to_completion_and_tells_its_owner_once() {
    let (rig, row) =
        spawned(spawn_scenario(json!([{ "terminal": { "content": "done" } }, { "return": { "content": "done" } }])), host(), args("scout"), false).await;
    assert_eq!((row.status.as_str(), row.error.clone()), ("completed", None));
    let meta = &row.meta;
    assert_eq!((meta.tag.as_deref(), meta.agent.as_deref(), meta.preset.as_deref()), (Some("scout"), Some("worker"), Some("agent-worker")));
    assert_eq!((meta.provider.as_deref(), meta.model.as_deref(), meta.effort.as_deref()), (Some("openai"), Some("gpt-5"), Some("medium")));
    assert_eq!(result_json(&row)["content"], "done");
    let notices = told(&rig);
    assert!(notices.iter().filter(|t| t.contains("status: completed") && t.contains("tag: scout")).count() >= 1, "{notices:?}");
    assert!(notices.iter().all(|t| !t.contains("failed")), "{notices:?}");
    assert_eq!(logged(&rig, "status"), 3, "published when the job starts, when the worker's row turns running, and once it settled");
    assert_eq!(lock(&rig.shared.log)[0], json!("status"), "the first publication is the job's start");
}

/// A spawn that cannot start fails its job with the reason and the owner is told of that failure.
#[tokio::test(start_paused = true)]
async fn a_spawn_that_cannot_start_fails_its_job_naming_why() {
    let no_agent = |args: &mut Value| {
        args.as_object_mut().unwrap().remove("agent");
    };
    let cases: Vec<(&str, Box<dyn Fn(&mut Value, &mut Value, &mut Value)>, &str)> = vec![
        ("no agent", Box::new(move |a, _, _| no_agent(a)), "agent spawn: agent is required"),
        ("unknown agent", Box::new(|_, h, _| h["agent"]["defined"] = json!(false)), "agent spawn: unknown agent \"worker\""),
        ("turned off", Box::new(|_, h, _| h["agent"]["disabled"] = json!(true)), "agent spawn: agent \"worker\" is turned off"),
        (
            "no prompt",
            Box::new(|a, _, _| {
                a.as_object_mut().unwrap().remove("prompt");
            }),
            "agent: prompt/message/file is required",
        ),
        ("taken tag", Box::new(|_, _, s| s["tags"] = json!({ "scout": "sess_other" })), "agent spawn: tag \"scout\" already exists"),
        ("session creation", Box::new(|_, _, s| s["createThrows"] = json!("provider unavailable")), "provider unavailable"),
    ];
    for (name, change, error) in cases {
        let (mut a, mut h, mut s) = (args("scout"), host(), spawn_scenario(json!([{ "return": { "content": "never" } }])));
        change(&mut a, &mut h, &mut s);
        let (rig, row) = spawned(s, h, a, false).await;
        assert_eq!((row.status.as_str(), row.error.as_deref()), ("failed", Some(error)), "{name}");
        assert_eq!(logged(&rig, "ask"), 0, "{name}: no turn ran");
        let notices = told(&rig);
        assert_eq!(notices.len(), 1, "{name}: {notices:?}");
        assert!(notices[0].contains("<status>failed</status>") && notices[0].contains(error), "{name}: {}", notices[0]);
    }
}

/// A respawn is marked on the job's card, and a host-set skill selection reaches the worker's turn while none is invented.
#[tokio::test(start_paused = true)]
async fn a_respawn_is_marked_and_a_skill_selection_reaches_the_turn_only_when_given() {
    let (_, row) = spawned(spawn_scenario(json!([])), host(), args("scout"), true).await;
    assert!(row.meta.respawned);
    let (rig, _) =
        spawned(spawn_scenario(json!([])), host(), json!({ "agent": "worker", "prompt": "p", "tag": "t", "skillSelection": "use $payload" }), false).await;
    assert_eq!(*lock(&rig.shared.selections), [json!({ "skillSelection": "use $payload" })]);
    let (rig, _) = spawned(spawn_scenario(json!([])), host(), args("t"), false).await;
    assert_eq!(*lock(&rig.shared.selections), [json!({})]);
}

/// A turn the watchdog stopped is a failure of the job: with partial output the owner gets it (marked as partial, with
/// the shell jobs the stop ended), with none (a row of only a dot is none) the owner gets the plain reason.
#[tokio::test(start_paused = true)]
async fn a_stalled_spawn_fails_with_its_partial_output_or_with_the_reason_when_it_has_none() {
    let stale = "agent task stale (600000ms without stream/tool progress)";
    let (rig, row) = spawned(spawn_scenario(json!([{ "say": "half done" }, { "stall": stale }])), host(), args("t"), false).await;
    assert_eq!((row.status.as_str(), row.terminal_reason.as_deref()), ("failed", Some("agent-watchdog-partial")));
    assert_eq!(row.error.as_deref(), Some("stalled: the progress watchdog stopped the turn"));
    let content = result_json(&row)["content"].as_str().unwrap().to_owned();
    assert!(
        content.starts_with(&format!("[Agent stopped by the progress watchdog: {stale}. The output below is partial.]")) && content.ends_with("half done"),
        "{content}"
    );
    assert_eq!(told(&rig).len(), 1);

    let (_, row) = spawned(spawn_scenario(json!([{ "say": "." }, { "stall": stale }])), host(), args("t"), false).await;
    assert_eq!((row.status.as_str(), row.terminal_reason.as_deref()), ("failed", Some("agent-stream-stalled")));
    assert_eq!(row.error.as_deref(), Some("The agent went stale after 10m without new stream/tool progress."));
    let (_, row) = spawned(spawn_scenario(json!([{ "stall": "agent first transport stale (120000ms)" }])), host(), args("t"), false).await;
    assert_eq!(row.error.as_deref(), Some("Agent watchdog stopped the run: no model response in 2m."));
}

/// The shell jobs a stall stopped are named in the partial output the owner reads.
#[tokio::test(start_paused = true)]
async fn a_stalled_spawn_names_the_shell_jobs_its_stop_ended() {
    let mut host = host();
    host["stoppedShellJobs"] = json!({ "stopped": ["mine-a"], "stopping": ["mine-b"] });
    let steps = json!([{ "say": "half" }, { "stall": "agent task stale (600000ms without stream/tool progress)" }]);
    let (_, row) = spawned(spawn_scenario(steps), host, args("t"), false).await;
    let content = result_json(&row)["content"].as_str().unwrap().to_owned();
    assert!(content.contains("[Stopped its background shell jobs: mine-a.] [Still stopping its background shell jobs: mine-b.]"), "{content}");
}

/// A turn that ends abnormally (an empty finish) or throws fails the job with a reason, and the owner is told once.
#[tokio::test(start_paused = true)]
async fn an_abnormal_or_throwing_turn_fails_the_job() {
    let (rig, row) = spawned(spawn_scenario(json!([{ "return": { "content": "", "termination": "empty" } }])), host(), args("t"), false).await;
    assert_eq!(row.status, "failed");
    assert_eq!(row.error.as_deref(), Some("agent 'worker' finished without a final answer (stopReason=none, 1 iterations, 0 tool calls)"));
    assert_eq!(told(&rig).len(), 1);
    let (rig, row) = spawned(spawn_scenario(json!([{ "throw": { "message": "boom" } }])), host(), args("t"), false).await;
    assert_eq!((row.status.as_str(), row.error.as_deref()), ("failed", Some("boom")));
    assert_eq!(told(&rig).len(), 1);
}

/// A job cancelled before its work starts runs nothing and the owner reads the cancellation once.
#[tokio::test(start_paused = true)]
async fn a_job_cancelled_before_it_starts_runs_nothing() {
    let mut scenario = spawn_scenario(json!([{ "return": { "content": "never" } }]));
    scenario["cancel"] = json!("before");
    let (rig, row) = spawned(scenario, host(), args("t"), false).await;
    assert_eq!((row.status.as_str(), row.error.as_deref()), ("cancelled", Some("cancelled early")));
    assert_eq!((logged(&rig, "createChild"), logged(&rig, "ask")), (0, 0));
    let notices = told(&rig);
    assert_eq!(notices.len(), 1);
    assert!(notices[0].contains("<status>cancelled</status>"), "{}", notices[0]);
}

/// A running turn cancelled by its owner reports once, as cancelled, with the output it had produced (header only when none).
#[tokio::test(start_paused = true)]
async fn a_cancelled_running_turn_tells_the_owner_once_with_its_partial_output() {
    let (rig, row) = spawned(
        spawn_scenario(json!([{ "say": "partial work" }, { "cancelTask": "user stop" }, { "return": { "content": "late" } }])),
        host(),
        args("t"),
        false,
    )
    .await;
    assert_eq!(row.status, "cancelled");
    let notices = told(&rig);
    assert_eq!(notices.len(), 1, "{notices:?}");
    assert!(notices[0].contains("<status>cancelled</status>") && notices[0].contains("partial work"), "{}", notices[0]);
    let (rig, _) = spawned(spawn_scenario(json!([{ "cancelTask": "user stop" }, { "return": { "content": "" } }])), host(), args("t"), false).await;
    let notices = told(&rig);
    assert_eq!(notices.len(), 1, "{notices:?}");
    assert!(notices[0].contains("<status>cancelled</status>") && !notices[0].contains("<result>"), "{}", notices[0]);
    // With no assistant text of its own, what the cancelled turn still returned stands in for its output.
    let (rig, _) = spawned(spawn_scenario(json!([{ "cancelTask": "user stop" }, { "return": { "content": "returned" } }])), host(), args("t"), false).await;
    let notices = told(&rig);
    assert_eq!(notices.len(), 1, "{notices:?}");
    assert!(notices[0].contains("<result>\nreturned\n</result>"), "{}", notices[0]);
}

fn send_scenario(surface: &str, busy: bool, steps: Value) -> Value {
    json!({
        "config": config(), "surface": surface, "busy": busy, "tags": { "scout": "sess_w1" }, "steps": steps,
        "session": { "id": "sess_w1", "agent": "worker", "provider": "openai", "model": "gpt-5", "cwd": "/work", "parentSessionId": "lead", "ownerSessionId": "lead", "clientHostPid": 4242 },
    })
}

fn caller() -> Caller {
    Caller { scope: Scope { caller_session_id: Some("lead".into()), host_pid: Some(4242) }, cwd: "/work".into(), ..Caller::default() }
}

/// A send to an idle agent runs a send job whose completion the owner gets; to a busy one it only queues the prompt
/// behind the running turn and says how deep the queue is; a busy agent with no queue to take it runs a job.
#[tokio::test(start_paused = true)]
async fn a_send_to_a_busy_agent_queues_and_to_an_idle_one_runs_a_job() {
    backend();
    let message = json!({ "type": "send", "tag": "scout", "prompt": "follow up" });
    let mut busy = send_scenario("process", true, json!([]));
    busy["pendingDepth"] = json!(2);
    let rig = rig(&busy, None);
    let reply = render(&rig.runtime.handle(&message, &caller()).await, "scout");
    assert_eq!(reply, "agent message queued\ntarget: scout sess_w1\nagent: worker\nqueueDepth: 2");
    assert!(rig.shared.board.list_jobs(&Scope::default()).is_empty());

    let mut full = send_scenario("process", true, json!([{ "return": { "content": "ran" } }]));
    full["noPending"] = json!(true);
    let rig = self::rig(&full, None);
    rig.runtime.handle(&message, &caller()).await;
    settle().await;
    settle().await;
    let jobs = rig.shared.board.list_jobs(&Scope::default());
    assert_eq!((jobs.len(), jobs[0].operation.as_str(), jobs[0].status.as_str()), (1, "send", "completed"));

    let rig = self::rig(&send_scenario("process", false, json!([{ "return": { "content": "followed" } }])), None);
    rig.runtime.handle(&message, &caller()).await;
    settle().await;
    settle().await;
    let jobs = rig.shared.board.list_jobs(&Scope::default());
    assert_eq!((jobs.len(), jobs[0].operation.as_str(), jobs[0].status.as_str()), (1, "send", "completed"));
    assert_eq!(result_json(&jobs[0])["content"], "followed");
    assert!(told(&rig).iter().any(|t| t.contains("followed")));
}

/// An idle agent is woken to take a completion that arrived for it; a busy one is not (the turn running will take it),
/// and a closed one is not.
#[tokio::test(start_paused = true)]
async fn only_an_idle_open_agent_is_woken() {
    backend();
    let woken = |scenario: Value| {
        let rig = rig(&scenario, None);
        let woke = rig.send.wake_idle_worker("sess_w1");
        (rig, woke)
    };
    let (rig, woke) = woken(send_scenario("process", false, json!([{ "return": { "content": "woken" } }])));
    assert!(woke);
    settle().await;
    settle().await;
    assert!(told(&rig).iter().any(|t| t.contains("woken")));
    assert!(!woken(send_scenario("process", true, json!([]))).1);
    let mut closed = send_scenario("process", false, json!([]));
    closed["session"]["closed"] = json!(true);
    assert!(!woken(closed).1);
}

/// The agent tool answers a bad request as text: an unknown type and a task that is not there.
#[tokio::test(start_paused = true)]
async fn the_agent_tool_answers_a_bad_request_as_an_error_text() {
    backend();
    let rig = rig(&spawn_scenario(json!([])), Some(&host()));
    let answer = |args: Value| {
        let (rig, caller) = (&rig, caller());
        async move { render(&rig.runtime.handle(&args, &caller).await, "") }
    };
    assert_eq!(answer(json!({ "type": "definitely_bad_type" })).await, "Error: agent: unknown type \"definitely_bad_type\"");
    assert_eq!(answer(json!({ "type": "read", "task_id": "task_missing" })).await, "Error: agent read/status: task \"task_missing\" not found");
}

/// The job list shows the running and the finished jobs of the scope, one row each (id, operation, status, tag).
#[tokio::test(start_paused = true)]
async fn the_job_list_shows_running_jobs_then_finished_ones() {
    backend();
    let rig = rig(&spawn_scenario(json!([])), Some(&host()));
    register(&rig.shared.board, "task_run", Some("lead"), None, None);
    register(&rig.shared.board, "task_done", Some("lead"), None, None);
    done(&rig.shared.board, "task_done");
    let reply = render(&rig.runtime.handle(&json!({ "type": "list" }), &caller()).await, "");
    assert!(reply.starts_with("agents: 0 · tasks: 2\n"), "{reply}");
    assert!(reply.contains("- task_run  spawn  running  task_run"), "{reply}");
    assert!(reply.contains("- finished tasks: 1"), "{reply}");
    assert!(reply.contains("- task_done  spawn  completed  task_done"), "{reply}");
    let card = render(&rig.runtime.handle(&json!({ "type": "status", "task_id": "task_run" }), &caller()).await, "");
    assert!(card.starts_with("agent task: task_run\nstatus: running\n"), "{card}");
}

// ---- job views ---------------------------------------------------------------------------------------

/// The roster lists running jobs first, then a counted section of the finished ones (a job with no tag reads `-`); a status
/// card shows a job that has no session yet as spawning, marks a respawned or resumed job with the note that says what
/// context it has, and a lookup that names nothing, or something unknown, answers why.
#[tokio::test(start_paused = true)]
async fn the_roster_and_the_status_cards_read_the_jobs_the_way_the_rules_say() {
    backend();
    let rig = rig(&spawn_scenario(json!([])), Some(&host()));
    let board = &rig.shared.board;
    let add = |id: &str, operation: &str, tag: Option<&str>, meta: JobMeta| {
        board
            .register(NewJob {
                task_id: Some(id.into()),
                label: tag.map(str::to_owned),
                operation: operation.into(),
                owner: JobOwner { caller_session_id: Some("lead".into()), ..JobOwner::default() },
                meta: JobMeta { tag: tag.map(str::to_owned), ..meta },
                ..NewJob::default()
            })
            .unwrap();
    };
    add("task_a", "spawn", Some("jv-done"), JobMeta::default());
    add("task_b", "spawn", None, JobMeta { respawned: true, ..JobMeta::default() });
    add("task_c", "send", None, JobMeta { resumed: true, ..JobMeta::default() });
    add("task_d", "spawn", Some("x"), JobMeta::default());
    for id in ["task_a", "task_b", "task_c"] {
        done(board, id);
    }
    let ask = |args: Value| {
        let (rig, caller) = (&rig, caller());
        async move { render(&rig.runtime.handle(&args, &caller).await, "") }
    };
    assert_eq!(
        ask(json!({ "type": "list" })).await,
        "agents: 0 · tasks: 4\n- task_d  spawn  running  x\n- finished tasks: 3 (latest 3; pass tag=<text> to find one)\n- task_a  spawn  completed  jv-done\n- task_b  spawn  completed  -\n- task_c  send  completed  -"
    );
    let spawning = ask(json!({ "type": "read", "task_id": "task_d" })).await;
    assert_eq!(
        spawning,
        "agent task: task_d\nstatus: running\ntype: spawn\ntarget: x\nworker_stage: spawning\nlast_progress: spawning worker session\ndiagnostic: worker session not started yet\nstarted: 2026-03-01 10:00:00Z\nelapsed: 0s (running)\nnotification: completion will be delivered; end the turn."
    );
    let respawned = ask(json!({ "type": "read", "task_id": "task_b" })).await;
    assert!(
        respawned.contains("respawned: true\nnote: previous session reaped — fresh session, no prior context; re-supply anchors if needed\n"),
        "{respawned}"
    );
    let resumed = ask(json!({ "type": "read", "task_id": "task_c" })).await;
    assert!(resumed.contains("resumed: true\nnote: previous session reaped — resumed from its saved transcript, prior context kept\n"), "{resumed}");
    assert_eq!(ask(json!({ "type": "read", "tag": "jv-missing" })).await, "Error: agent read/status: no task found for tag/sessionId \"jv-missing\"");
    assert_eq!(ask(json!({ "type": "read" })).await, "Error: agent read/status: task_id, tag, or sessionId is required");
}

// ---- following the agent's route on a send ------------------------------------------------------------

fn route_scenario(surface: &str, busy: bool, session: Value) -> Value {
    let mut scenario = send_scenario(surface, busy, json!([]));
    scenario["config"]["agents"]["worker"] = json!({ "provider": "xai", "model": "grok", "effort": "high", "fast": true });
    let mut base = json!({ "id": "sess_w1", "agent": "worker", "provider": "openai", "model": "gpt-5", "effort": "medium", "presetName": "AGENT WORKER", "cwd": "/work", "parentSessionId": "lead", "ownerSessionId": "lead" });
    base.as_object_mut().unwrap().extend(session.as_object().unwrap().clone());
    scenario["session"] = base;
    scenario
}

/// Sends `prompt` to the scenario's worker; answers the route calls the send made, in order.
async fn route_calls(scenario: Value, route: Option<Value>) -> Result<Vec<Value>, String> {
    backend();
    let rig = rig(&scenario, None);
    let prepared = Prepared {
        args: json!({ "tag": "scout", "prompt": "follow up" }),
        session: SessionFacts { id: "sess_w1".into(), agent: "worker".into(), cwd: "/work".into(), ..SessionFacts::default() },
        session_id: "sess_w1".into(),
        prompt: Some("follow up".into()),
        route,
    };
    let context = lead();
    rig.send.dispatch_to_existing_session(&prepared, &context, DispatchOptions::default()).await?;
    settle().await;
    Ok(lock(&rig.shared.log).iter().filter(|e| matches!(e[0].as_str(), Some("setRoute" | "updateSessionRoute" | "holdSessionRoute"))).cloned().collect())
}

/// A worker that runs on its agent's configured route follows that route when it is sent to: an idle in-process one takes it
/// in place (flagged when the provider changes), a busy one holds it for its next turn, a canonical one applies it through
/// the surface; a worker already on it, one whose held route already is it, or one started on a preset of its own is left alone.
#[tokio::test(start_paused = true)]
async fn a_send_makes_the_worker_follow_its_agents_configured_route() {
    let want = json!({ "provider": "xai", "model": "grok", "effort": "high", "fast": true });
    let calls = route_calls(route_scenario("process", false, json!({})), None).await.unwrap();
    assert_eq!(calls.len(), 1);
    let call = &calls[0];
    assert_eq!((call[0].clone(), call[1].clone(), call[3].clone()), (json!("updateSessionRoute"), json!("sess_w1"), json!(true)), "{call}");
    for key in ["provider", "model", "effort", "fast"] {
        assert_eq!(call[2][key], want[key], "{key}");
    }

    let calls = route_calls(route_scenario("process", true, json!({})), None).await.unwrap();
    assert_eq!((calls.len(), calls[0][0].clone(), calls[0][2]["model"].clone()), (1, json!("holdSessionRoute"), json!("grok")));

    let calls = route_calls(route_scenario("canonical", false, json!({})), None).await.unwrap();
    assert_eq!((calls.len(), calls[0][0].clone(), calls[0][1]["provider"].clone()), (1, json!("setRoute"), json!("xai")));

    let on_route = json!({ "provider": "xai", "model": "grok", "effort": "high", "fast": true });
    assert!(route_calls(route_scenario("process", false, on_route.clone()), None).await.unwrap().is_empty());
    let stale = route_scenario(
        "process",
        false,
        json!({ "provider": "xai", "model": "grok", "effort": "high", "fast": true, "heldRoute": { "provider": "openai", "model": "gpt-5" } }),
    );
    assert_eq!(route_calls(stale, None).await.unwrap(), [json!(["holdSessionRoute", "sess_w1", null])], "a hold that is obsolete is dropped");
    let held = route_scenario("process", false, json!({ "heldRoute": on_route }));
    assert!(route_calls(held, None).await.unwrap().is_empty(), "a held route that already is the agent's route is left");
    let own_preset = route_scenario("process", false, json!({ "presetName": "MY PRESET" }));
    assert!(route_calls(own_preset, None).await.unwrap().is_empty(), "a worker started on a preset of its own keeps it");
}

/// An explicit model on a send goes through the surface that can change a session's route, and fails where it cannot.
#[tokio::test(start_paused = true)]
async fn an_explicit_model_on_a_send_needs_a_surface_that_can_change_the_route() {
    let route = json!({ "provider": "xai", "model": "grok" });
    let calls = route_calls(route_scenario("canonical", false, json!({})), Some(route.clone())).await.unwrap();
    assert_eq!(calls, [json!(["setRoute", route.clone()])]);
    let error = route_calls(route_scenario("process", false, json!({})), Some(route)).await.unwrap_err();
    assert_eq!(error, "agent spawn: this surface cannot change the model of reused session \"sess_w1\"");
}

// ---- files and images ---------------------------------------------------------------------------------

/// The file and image parts a call carries go with the prompt as the worker's turn on a spawn and on a send, in order after
/// the text; a send with no part hands the plain prompt.
#[tokio::test(start_paused = true)]
async fn the_files_and_images_of_a_call_reach_the_workers_turn() {
    backend();
    let rig = rig(&spawn_scenario(json!([{ "return": { "content": "ok" } }])), Some(&host()));
    execute_with_parts(&rig, json!({ "type": "spawn", "agent": "worker", "prompt": "do it", "tag": "scout" })).await;
    let turn = asked(&rig);
    let parts = turn.as_array().expect("text and parts");
    assert_eq!(parts.len(), 3);
    assert!(parts[0].to_string().contains("do it"));
    assert_eq!(&parts[1..], &resolved_parts()[..]);

    let rig = self::rig(&send_scenario("process", false, json!([{ "return": { "content": "ok" } }])), None);
    execute_with_parts(&rig, json!({ "type": "send", "tag": "scout", "prompt": "follow up" })).await;
    let turn = asked(&rig);
    assert_eq!(turn.as_array().map(Vec::len), Some(3));
    assert_eq!(&turn.as_array().unwrap()[1..], &resolved_parts()[..]);

    let rig = self::rig(&send_scenario("process", false, json!([{ "return": { "content": "ok" } }])), None);
    rig.runtime.handle(&json!({ "type": "send", "tag": "scout", "prompt": "follow up" }), &caller()).await;
    settle().await;
    assert_eq!(asked(&rig), json!("follow up"));
}

// ---- cancelling an agent and the agents below it -----------------------------------------------------------

/// Cancels the worker's agent tree from inside its turn: the agents below it are `sess_c1` (with `sess_c2` below it) and
/// `sess_c3`. `fail` lists the sessions whose close does not land. Answers the world, and what the cancel returned or threw.
async fn tree_cancelled(fail: &[&str]) -> (Rig, Value) {
    backend();
    let steps = json!([{ "say": "partial review" }, { "cancelTree": "agent session cancelled" }, { "return": { "content": "late" } }]);
    let mut scenario = spawn_scenario(steps);
    scenario["tree"] = json!({
        "children": [{ "id": "sess_c1", "parent": "sess_w1" }, { "id": "sess_c2", "parent": "sess_c1" }, { "id": "sess_c3", "parent": "sess_w1" }],
        "failClose": fail,
    });
    let rig = rig(&scenario, Some(&host()));
    register(&rig.shared.board, "owned", Some("sess_c1"), None, None);
    register(&rig.shared.board, "bound", Some("sess_w1"), None, Some("sess_c1"));
    register(&rig.shared.board, "other", Some("sess_x"), None, None);
    let context = lead();
    rig.spawn.start_deferred_spawn_job(&args("t"), "/work", &context, &context, SpawnOptions::default()).await.unwrap();
    settle().await;
    settle().await;
    let outcome = lock(&rig.shared.tree_cancel).clone();
    (rig, outcome)
}

fn closes(rig: &Rig) -> Vec<String> {
    lock(&rig.shared.log).iter().filter_map(|e| e.as_str()).filter(|e| e.starts_with("close:")).map(str::to_owned).collect()
}

/// Cancelling an agent closes every agent below it, deepest first, after cancelling the jobs they own or run, and cancels
/// with the reason the jobs of strangers are spared; the cancelled job tells its owner once with what it had produced.
#[tokio::test(start_paused = true)]
async fn cancelling_an_agent_tree_closes_every_agent_below_and_spares_strangers_jobs() {
    let (rig, outcome) = tree_cancelled(&[]).await;
    assert_eq!(outcome["threw"], Value::Null);
    let all = closes(&rig);
    for id in ["sess_c1", "sess_c2", "sess_c3", "sess_w1"] {
        assert!(all.contains(&format!("close:{id}:agent session cancelled")), "{id}: {all:?}");
    }
    let position = |entry: &str| all.iter().position(|e| e == entry).unwrap();
    assert!(position("close:sess_c2:agent session cancelled") < position("close:sess_c1:agent session cancelled"), "{all:?}");
    let state = |id: &str| rig.shared.board.get(id, &Scope::default()).map(|j| (j.status, j.error));
    assert_eq!(state("owned"), Some(("cancelled".into(), Some("agent session cancelled".into()))));
    assert_eq!(state("bound"), Some(("cancelled".into(), Some("agent session cancelled".into()))));
    assert_eq!(state("other"), Some(("running".into(), None)));
    let notices = told(&rig);
    assert_eq!(notices.len(), 1, "{notices:?}");
    assert!(notices[0].contains("<status>cancelled</status>") && notices[0].contains("partial review"), "{}", notices[0]);
}

/// A close that does not land never stops the rest from closing; the cancel then fails naming the one session, or, when
/// several failed, once for all of them with the count.
#[tokio::test(start_paused = true)]
async fn a_close_that_fails_in_a_tree_cancel_still_closes_the_rest_and_is_reported_once() {
    let (rig, outcome) = tree_cancelled(&["sess_c2"]).await;
    assert_eq!(outcome["threw"], "agent session sess_c2 could not be durably closed");
    let all = closes(&rig);
    for id in ["sess_c1", "sess_c3", "sess_w1"] {
        assert!(all.contains(&format!("close:{id}:agent session cancelled")), "{id}: {all:?}");
    }
    let (_, outcome) = tree_cancelled(&["sess_c2", "sess_c3"]).await;
    assert_eq!(
        outcome["threw"],
        "agent tree cancel failed for 2 of 4 sessions: agent session sess_c2 could not be durably closed; agent session sess_c3 could not be durably closed"
    );
    let (rig, outcome) = tree_cancelled(&["sess_w1"]).await;
    assert_eq!(outcome["threw"], "agent session sess_w1 could not be durably closed");
    assert!(closes(&rig).contains(&"close:sess_c2:agent session cancelled".to_owned()), "the agents below closed first");
}

/// A stall with no output tells the owner which background shell jobs its stop ended or is still ending, after the
/// presented stall reason, in the owner's notification as well; when the stop ended none nothing is added.
#[tokio::test(start_paused = true)]
async fn a_stall_with_no_output_names_the_shell_jobs_on_the_error() {
    let stale = "agent task stale (600000ms without stream/tool progress)";
    let reason = "The agent went stale after 10m without new stream/tool progress.";
    let mut with_jobs = host();
    with_jobs["stoppedShellJobs"] = json!({ "stopped": ["mine-a"], "stopping": ["mine-b"] });
    let (rig, row) = spawned(spawn_scenario(json!([{ "stall": stale }])), with_jobs, args("t"), false).await;
    let named = format!("{reason} [Stopped its background shell jobs: mine-a.] [Still stopping its background shell jobs: mine-b.]");
    assert_eq!(row.error.as_deref(), Some(named.as_str()));
    let notices = told(&rig);
    assert!(notices.len() == 1 && notices[0].contains(&format!("<error>{named}</error>")), "{notices:?}");
    let mut none = host();
    none["stoppedShellJobs"] = json!({ "stopped": [], "stopping": [] });
    let (_, row) = spawned(spawn_scenario(json!([{ "stall": stale }])), none.clone(), args("t"), false).await;
    assert_eq!(row.error.as_deref(), Some(reason));
    let (_, row) = spawned(spawn_scenario(json!([{ "say": "half done" }, { "stall": stale }])), none, args("t"), false).await;
    let content = result_json(&row)["content"].as_str().unwrap().to_owned();
    assert!(!content.contains("shell jobs") && content.ends_with("\n\nhalf done"), "{content}");
}
