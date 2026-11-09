//! The routine runtime against a scripted session host: what each fire hands the owner's home
//! thread, when a fire is skipped instead, and where its result goes.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use chrono_tz::Tz;
use mixdog_rt::CancelSource;
use mixdog_rt::testing::tokens;
use mixdog_store::state::CoreState;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::owned::never_cancelled;
use super::*;
use crate::channels::running::RunningWork;
use crate::scheduler::{
    MemoryScheduleStore, RunOutcome, Schedule, ScheduleRecords, ScheduleRunner, ScheduleStore, SystemClock,
};
use crate::webhooks::signature::Headers;
use crate::webhooks::{Claim, EndpointRecord, EndpointRecords, StateWebhookStore, WebhookDispatch, WebhookStore};

#[derive(Default)]
pub(crate) struct FakeHost {
    pub owner_problem: Mutex<Option<OwnerProblem>>,
    pub home_closed: Mutex<bool>,
    pub facts: Mutex<HashMap<String, ExecutorFacts>>,
    pub turns: Mutex<Vec<RoutineTurn>>,
    pub settles: Mutex<VecDeque<TurnSettle>>,
    /// Turns wait for their cancellation instead of settling.
    pub hold: Mutex<bool>,
    /// Executor runs wait for their cancellation, then fail.
    pub hold_executor: Mutex<bool>,
    /// A stored routine's owner check (the listing of schedules and webhooks) waits for a permit
    /// of this semaphore: a read stuck behind it until a test releases it.
    pub listing_gate: Mutex<Option<Arc<tokio::sync::Semaphore>>>,
    pub executor_runs: Mutex<Vec<ExecutorRun>>,
    pub executor_reply: Mutex<Option<Result<String, String>>>,
    pub delivered: Mutex<Vec<DeliveryItem>>,
    pub deliver_error: Mutex<Option<String>>,
    pub announced: Mutex<Vec<AnnouncedRun>>,
    pub heartbeats: Mutex<HashSet<String>>,
    /// The process's heartbeat marks, when a test wires them: a turn records whether its session is marked.
    pub marks: Mutex<Option<Arc<HeartbeatSessions>>>,
    pub seen_marked: Mutex<Vec<bool>>,
}

#[async_trait]
impl RoutineHost for FakeHost {
    async fn owner_problem(&self, _owner: &str, stored: bool) -> Result<Option<OwnerProblem>, String> {
        let gate = self.listing_gate.lock().unwrap().clone();
        if let (true, Some(gate)) = (stored, gate) {
            gate.acquire().await.expect("the gate stays open").forget();
        }
        Ok(*self.owner_problem.lock().unwrap())
    }

    async fn executor_facts(&self, agent_id: &str) -> Result<ExecutorFacts, String> {
        Ok(self.facts.lock().unwrap().get(agent_id).copied().unwrap_or_default())
    }

    async fn home_thread_open(&self, _session_id: &str) -> Result<bool, String> {
        Ok(!*self.home_closed.lock().unwrap())
    }

    fn is_heartbeat_session(&self, session_id: &str) -> bool {
        self.heartbeats.lock().unwrap().contains(session_id) || self.marks.lock().unwrap().as_ref().is_some_and(|marks| marks.is_marked(session_id))
    }

    async fn run_turn(&self, turn: RoutineTurn, cancel: CancellationToken) -> TurnSettle {
        if let Some(marks) = self.marks.lock().unwrap().as_ref() {
            self.seen_marked.lock().unwrap().push(marks.is_marked(&turn.session_id));
        }
        self.turns.lock().unwrap().push(turn);
        if *self.hold.lock().unwrap() {
            cancel.cancelled().await;
            return TurnSettle::Cancelled;
        }
        self.settles.lock().unwrap().pop_front().unwrap_or(TurnSettle::Done { result: "ok".into() })
    }

    async fn run_executor(&self, run: ExecutorRun, cancel: CancellationToken) -> Result<String, String> {
        self.executor_runs.lock().unwrap().push(run);
        if *self.hold_executor.lock().unwrap() {
            cancel.cancelled().await;
            return Err("executor stopped".into());
        }
        self.executor_reply.lock().unwrap().clone().unwrap_or_else(|| Ok("report".into()))
    }

    async fn deliver_result(&self, _owner: &str, _name: &str, item: &DeliveryItem) -> Result<(), String> {
        if let Some(error) = self.deliver_error.lock().unwrap().clone() {
            return Err(error);
        }
        self.delivered.lock().unwrap().push(item.clone());
        Ok(())
    }

    async fn announce_run(&self, _owner: &str, _name: &str, run: &AnnouncedRun) -> Result<(), String> {
        self.announced.lock().unwrap().push(run.clone());
        Ok(())
    }
}

impl FakeHost {
    pub fn turns(&self) -> Vec<RoutineTurn> {
        self.turns.lock().unwrap().clone()
    }

    pub fn with_executor(&self, id: &str) {
        self.facts.lock().unwrap().insert(id.into(), ExecutorFacts { listed: true, contact: false, disabled: false });
    }
}

pub(crate) struct Fixture {
    pub host: Arc<FakeHost>,
    pub rt: Arc<RoutineRuntime>,
    pub schedules: Arc<MemoryScheduleStore>,
    pub webhooks: Arc<StateWebhookStore>,
    pub _dir: tempfile::TempDir,
}

pub(crate) async fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let (state, _) = CoreState::open(tokens().sqlite_writer_thread, tokens().interactive_io, &dir.path().join("core.sqlite")).unwrap();
    let webhooks = Arc::new(StateWebhookStore::new(state, Arc::new(SystemClock)));
    let schedules = Arc::new(MemoryScheduleStore::default());
    let host = Arc::new(FakeHost::default());
    let records = Arc::new(StoreRoutineRecords::new(schedules.clone(), webhooks.clone()));
    let rt = RoutineRuntime::new(host.clone(), records, Arc::new(SystemClock), Tz::UTC);
    Fixture { host, rt, schedules, webhooks, _dir: dir }
}

pub(crate) fn sched(name: &str) -> Schedule {
    Schedule {
        name: name.into(),
        prompt: "Check the build".into(),
        when_cron: Some("0 9 * * *".into()),
        owner_agent_id: "gh-bot".into(),
        ..Default::default()
    }
}

async fn fire(f: &Fixture, schedule: &Schedule) -> RunOutcome {
    HomeScheduleRunner::new(f.rt.clone()).run(schedule, &schedule.prompt).await.unwrap()
}

fn content_of(turn: &RoutineTurn) -> &str {
    turn.content.as_str().expect("a plain-text turn")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_schedule_fire_is_one_routine_turn_in_the_owners_home() {
    let f = fixture().await;
    f.schedules.upsert(&sched("daily")).await.unwrap();
    assert!(matches!(fire(&f, &sched("daily")).await, RunOutcome::Done));
    let turns = f.host.turns();
    assert_eq!(turns.len(), 1);
    let turn = &turns[0];
    assert_eq!((turn.session_id.as_str(), turn.agent_id.as_str()), ("sess_home_gh-bot", "gh-bot"));
    assert_eq!((turn.kind, turn.name.as_str(), turn.skill_selection.as_str()), (RoutineKind::Schedule, "daily", "Check the build"));
    assert_eq!((turn.trigger.name.as_str(), turn.trigger.event.as_deref()), ("daily", None));
    assert!(turn.id.starts_with("routine_"));
    assert!(content_of(turn).starts_with("[Routine trigger] Your schedule \"daily\" fired."));
    assert!(content_of(turn).ends_with("\n\nCheck the build"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_missing_owner_skips_the_fire_and_records_it() {
    let f = fixture().await;
    f.schedules.upsert(&sched("daily")).await.unwrap();
    *f.host.owner_problem.lock().unwrap() = Some(OwnerProblem::OwnerDeleted);
    match fire(&f, &sched("daily")).await {
        RunOutcome::Skipped(reason) => assert_eq!(reason.text(), format!("paused: {}", OwnerProblem::OwnerDeleted.message())),
        RunOutcome::Done => panic!("ran without an owner"),
    }
    assert!(f.host.turns().is_empty());
    assert!(f.schedules.get("daily").await.unwrap().unwrap().last_skipped_at.is_some());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_overlapping_switched_off_or_backing_off_fire_is_skipped_unless_a_person_asked() {
    let f = fixture().await;
    f.schedules.upsert(&sched("daily")).await.unwrap();
    let skipped = |outcome: RunOutcome| match outcome {
        RunOutcome::Skipped(reason) => reason.text(),
        RunOutcome::Done => "ran".to_string(),
    };

    let held = f.rt.runs().begin(RoutineKind::Schedule, "daily").unwrap();
    assert_eq!(skipped(fire(&f, &sched("daily")).await), "previous run still in progress");
    drop(held);

    f.schedules.mark_failure("daily", chrono::Utc::now()).await.unwrap();
    assert_eq!(skipped(fire(&f, &sched("daily")).await), "backing off after failures");
    let attended = ScheduleRunOpts { attended: true, ..Default::default() };
    assert!(matches!(f.rt.run_schedule(&sched("daily"), attended.clone()).await, Ok(OwnedOutcome::Ran(_))));

    f.schedules.set_enabled("daily", false).await.unwrap();
    assert_eq!(skipped(fire(&f, &sched("daily")).await), "switched off");
    assert!(matches!(f.rt.run_schedule(&sched("daily"), attended).await, Ok(OwnedOutcome::Ran(_))));
    assert_eq!(f.host.turns().len(), 2, "only the two attended runs reached the thread");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelling_a_run_aborts_its_turn() {
    let f = fixture().await;
    *f.host.hold.lock().unwrap() = true;
    // A cancel that carries no reason reads Node's own fallback text.
    let source = CancelSource::new();
    let opts = ScheduleRunOpts { attended: true, cancel: source.view(), ..Default::default() };
    let rt = f.rt.clone();
    let run = tokio::spawn(async move { rt.run_schedule(&sched("daily"), opts).await });
    while f.host.turns().is_empty() {
        tokio::task::yield_now().await;
    }
    source.token().cancel();
    assert_eq!(run.await.unwrap(), Err("routine run aborted".to_string()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stopped_run_now_and_a_timed_out_dispatch_keep_their_reasons() {
    let f = fixture().await;
    *f.host.hold.lock().unwrap() = true;
    for reason in ["Run now was stopped", "webhook dispatch timed out"] {
        let before = f.host.turns().len();
        let scope = CancelSource::new();
        let (rt, view) = (f.rt.clone(), scope.view());
        let run = tokio::spawn(async move { rt.run_webhook(webhook_run(None), true, view).await });
        until_started(&f, |f| f.host.turns().len() > before).await;
        assert!(scope.cancel(reason));
        assert_eq!(run.await.unwrap().unwrap_err(), reason);
        // The host's own turn was cancelled with it, and the first reason is the one kept.
        assert!(!scope.cancel("later"));
    }
}

fn webhook_run(executor: Option<&str>) -> WebhookRun {
    WebhookRun {
        name: "gh".into(),
        owner_agent_id: Some("gh-bot".into()),
        executor_agent_id: executor.map(String::from),
        cwd: None,
        attachments: None,
        event: "push".into(),
        prompt: "Summarise.".into(),
        skill_selection: "Summarise.".into(),
    }
}

async fn until_started(f: &Fixture, started: impl Fn(&Fixture) -> bool) {
    while !started(f) {
        tokio::task::yield_now().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelling_a_webhook_run_stops_its_turn_and_frees_its_name_and_queue_slot() {
    let f = fixture().await;
    *f.host.hold.lock().unwrap() = true;
    let cancel = CancelSource::new();
    let rt = f.rt.clone();
    let token = cancel.view();
    let run = tokio::spawn(async move { rt.run_webhook(webhook_run(None), true, token).await });
    until_started(&f, |f| !f.host.turns().is_empty()).await;
    assert_eq!(f.rt.waiting.lock().unwrap()["sess_home_gh-bot"], 1);
    assert!(f.rt.runs().begin(RoutineKind::Webhook, "gh").is_none(), "the name is held while it runs");

    cancel.token().cancel();
    assert_eq!(run.await.unwrap().unwrap_err(), "routine run aborted");
    assert!(f.rt.waiting.lock().unwrap().is_empty(), "the queue slot is released");
    assert!(f.rt.runs().begin(RoutineKind::Webhook, "gh").is_some(), "the name is free again");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelling_an_executor_run_never_wakes_the_bot() {
    let f = fixture().await;
    f.host.with_executor("worker");
    *f.host.hold_executor.lock().unwrap() = true;
    let cancel = CancelSource::new();
    let rt = f.rt.clone();
    let token = cancel.view();
    let run = tokio::spawn(async move { rt.run_webhook(webhook_run(Some("worker")), true, token).await });
    until_started(&f, |f| !f.host.executor_runs.lock().unwrap().is_empty()).await;

    cancel.cancel("Run now was stopped");
    // The caller's own cancellation keeps the executor's error as it is.
    assert_eq!(run.await.unwrap().unwrap_err(), "executor stopped");
    assert!(f.host.turns().is_empty(), "the bot was never woken");
    assert!(f.rt.runs().begin(RoutineKind::Webhook, "gh").is_some());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_run_cancelled_before_it_starts_submits_nothing() {
    let f = fixture().await;
    f.host.with_executor("worker");
    let cancel = CancelSource::new();
    cancel.cancel("gone");
    assert_eq!(f.rt.run_webhook(webhook_run(None), true, cancel.view()).await.unwrap_err(), "gone");
    assert_eq!(f.rt.run_webhook(webhook_run(Some("worker")), true, cancel.view()).await.unwrap_err(), "gone");
    assert!(f.host.turns().is_empty() && f.host.executor_runs.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_turn_that_does_not_finish_rejects_with_its_reason() {
    let f = fixture().await;
    let attended = ScheduleRunOpts { attended: true, ..Default::default() };
    let run = |settle: TurnSettle| {
        f.host.settles.lock().unwrap().push_back(settle);
        let (rt, opts) = (f.rt.clone(), attended.clone());
        async move { rt.run_schedule(&sched("daily"), opts).await.unwrap_err() }
    };
    assert_eq!(run(TurnSettle::Rejected).await, "the bot's chat closed before the routine ran");
    assert_eq!(run(TurnSettle::Cancelled).await, "the routine turn was cancelled");
    assert_eq!(run(TurnSettle::Failed("provider down".into())).await, "provider down");
    assert_eq!(run(TurnSettle::Failed(String::new())).await, "the routine turn failed");
    assert_eq!(run(TurnSettle::HumanNeeded("Sign in to example.com first".into())).await, "Sign in to example.com first");
    assert_eq!(run(TurnSettle::NotAccepted).await, "the bot's chat did not accept the schedule \"daily\"");
    *f.host.home_closed.lock().unwrap() = true;
    assert_eq!(
        f.rt.run_schedule(&sched("daily"), ScheduleRunOpts { attended: true, ..Default::default() }).await.unwrap_err(),
        "the bot \"gh-bot\" has no chat yet: open it once in the app"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_full_home_queue_refuses_another_routine_turn() {
    let f = fixture().await;
    f.rt.waiting.lock().unwrap().insert("sess_home_gh-bot".into(), 200);
    let opts = ScheduleRunOpts { attended: true, ..Default::default() };
    assert_eq!(f.rt.run_schedule(&sched("daily"), opts).await.unwrap_err(), "200 routine runs already wait in this bot's chat");
    assert_eq!(f.rt.waiting.lock().unwrap()["sess_home_gh-bot"], 200, "a refused turn takes no slot");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_executor_carries_the_fire_out_and_the_bot_relays_its_report() {
    let f = fixture().await;
    f.host.with_executor("worker");
    *f.host.executor_reply.lock().unwrap() = Some(Ok("  All green \n".into()));
    let mut s = sched("daily");
    s.executor_agent_id = Some("worker".into());
    s.cwd = Some("C:\\proj".into());
    s.attachments = Some(json!([
        {"kind": "text", "name": "notes.txt", "mimeType": "text/plain", "data": "remember"},
        {"kind": "image", "name": "a.png", "mimeType": "image/png", "data": "QUJD"}
    ]));
    let opts = ScheduleRunOpts { attended: true, ..Default::default() };
    assert!(matches!(f.rt.run_schedule(&s, opts).await, Ok(OwnedOutcome::Ran(_))));

    let runs = f.host.executor_runs.lock().unwrap().clone();
    assert_eq!(runs.len(), 1);
    assert!(runs[0].prompt.starts_with("[Routine task] The schedule \"daily\" fired"));
    assert!(runs[0].prompt.contains("Project folder: C:\\proj"));
    assert!(runs[0].prompt.ends_with("--- Attached file: notes.txt ---\nremember"));
    assert_eq!((runs[0].skill_selection.as_str(), runs[0].owner_agent_id.as_str()), ("Check the build", "gh-bot"));
    assert_eq!(runs[0].attachment_parts, vec![json!({"type": "image", "data": "QUJD", "mimeType": "image/png"})]);

    let turn = &f.host.turns()[0];
    assert!(content_of(turn).starts_with("[Routine trigger] Your schedule \"daily\" fired and its sub-agent \"worker\" already carried it out;"));
    assert!(content_of(turn).ends_with("\n\nAll green"));
    assert_eq!(turn.skill_selection, "", "a relay selects no skill");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_quiet_executor_report_wakes_nobody_and_a_bad_executor_fails_the_fire() {
    let f = fixture().await;
    let mut s = sched("daily");
    s.executor_agent_id = Some("worker".into());
    let opts = ScheduleRunOpts { attended: true, ..Default::default() };

    // Unknown, then a bot, then turned off: nothing falls back to the bot doing the work.
    let err = f.rt.run_schedule(&s, opts.clone()).await.unwrap_err();
    assert_eq!(err, "schedule \"daily\" cannot run: executor agent \"worker\" is not an available sub-agent: pick one from the workflow agents");
    f.host.facts.lock().unwrap().insert("worker".into(), ExecutorFacts { listed: true, contact: true, disabled: false });
    assert!(f.rt.run_schedule(&s, opts.clone()).await.unwrap_err().contains("is a bot, not a workflow sub-agent"));
    f.host.facts.lock().unwrap().insert("worker".into(), ExecutorFacts { listed: true, contact: false, disabled: true });
    assert!(f.rt.run_schedule(&s, opts.clone()).await.unwrap_err().contains("is turned off"));
    f.host.with_executor("worker");

    *f.host.executor_reply.lock().unwrap() = Some(Err("boom".into()));
    assert_eq!(f.rt.run_schedule(&s, opts.clone()).await.unwrap_err(), "schedule \"daily\": executor agent \"worker\" failed: boom");
    *f.host.executor_reply.lock().unwrap() = Some(Ok("   ".into()));
    assert_eq!(f.rt.run_schedule(&s, opts.clone()).await.unwrap_err(), "schedule \"daily\": executor agent \"worker\" returned no report");
    *f.host.executor_reply.lock().unwrap() = Some(Ok(" ROUTINE_QUIET ".into()));
    match f.rt.run_schedule(&s, opts).await {
        Ok(OwnedOutcome::Ran(run)) => assert_eq!(run.result, "ROUTINE_QUIET"),
        other => panic!("{other:?}"),
    }
    assert!(f.host.turns().is_empty(), "the bot was never woken");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn executor_ids_are_checked_when_a_routine_is_saved() {
    let f = fixture().await;
    f.host.with_executor("code-reviewer");
    assert_eq!(f.rt.assert_routine_executor(&Value::Null).await, Ok(None));
    assert_eq!(f.rt.assert_routine_executor(&json!("  ")).await, Ok(None));
    assert_eq!(f.rt.assert_routine_executor(&json!(" Code_Reviewer ")).await, Ok(Some("code-reviewer".into())));
    assert_eq!(f.rt.assert_routine_executor(&json!(7)).await, Err("executorAgentId must be a sub-agent id (a string) or null".into()));
    assert!(f.rt.assert_routine_executor(&json!("lead")).await.unwrap_err().contains("is a bot"));
    assert!(f.rt.assert_routine_executor(&json!("ghost")).await.unwrap_err().contains("is not an available sub-agent"));
}

#[tokio::test(start_paused = true)]
async fn a_heartbeat_turn_is_cut_off_at_its_wall_clock_cap() {
    let f = fixture().await;
    *f.host.hold.lock().unwrap() = true;
    f.host.heartbeats.lock().unwrap().insert("sess_hidden_beat".into());
    let args = TurnArgs {
        kind: RoutineKind::Schedule,
        name: "heartbeat".into(),
        owner_agent_id: None,
        prompt: "check in".into(),
        skill_selection: None,
        attachments: None,
        cwd: None,
        event: String::new(),
        session_id: Some("sess_hidden_beat".into()),
        header: Some("[Routine trigger] Heartbeat".into()),
        executor_agent_id: None,
    };
    let rt = f.rt.clone();
    let run = tokio::spawn(async move { rt.run_routine_turn(args, &never_cancelled()).await });
    while f.host.turns().is_empty() {
        tokio::task::yield_now().await;
    }
    tokio::time::advance(Duration::from_millis(routine::HEARTBEAT_WALL_CLOCK_MS + 1)).await;
    let outcome = run.await.unwrap().unwrap();
    assert_eq!((outcome.result.as_str(), outcome.timed_out), ("", true));
    assert!(content_of(&f.host.turns()[0]).starts_with("[Routine trigger] Heartbeat\n\ncheck in"));
    assert_eq!(f.host.turns()[0].session_id, "sess_hidden_beat");
}

async fn seeded_with_result(f: &Fixture) {
    f.schedules.upsert(&sched("daily")).await.unwrap();
    let entry = json!({"state": "pending", "at": "2025-01-01T00:00:00Z", "result": {"ok": true, "text": "done", "runSessionId": "s9"}});
    f.schedules.record_delivery("daily", "r1", Some(entry)).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refused_result_is_marked_and_announced_then_a_retry_delivers_it() {
    let f = fixture().await;
    seeded_with_result(&f).await;
    *f.host.deliver_error.lock().unwrap() = Some("queue full".into());
    let err = f.rt.retry_routine_delivery("schedule", "daily").await.unwrap_err();
    assert_eq!(err, "\"daily\": the result still could not be delivered (queue full)");
    let kept = f.schedules.get("daily").await.unwrap().unwrap().result_delivery.unwrap();
    assert_eq!((kept["r1"]["state"].as_str(), kept["r1"]["error"].as_str()), (Some("failed"), Some("queue full")));
    assert_eq!(f.host.announced.lock().unwrap()[0].state, "undelivered");

    *f.host.deliver_error.lock().unwrap() = None;
    assert_eq!(f.rt.retry_routine_delivery("schedule", "daily").await.unwrap(), json!({"name": "daily", "delivered": 1}));
    let delivered = f.host.delivered.lock().unwrap().clone();
    assert_eq!(
        delivered,
        vec![DeliveryItem {
            run_id: "r1".into(),
            kind: RoutineKind::Schedule,
            ok: true,
            text: "done".into(),
            run_session_id: Some("s9".into()),
            reason: None,
            paused: None,
        }]
    );
    assert_eq!(f.schedules.get("daily").await.unwrap().unwrap().result_delivery, None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recovery_requeues_every_routines_results_and_retry_validates_its_target() {
    let f = fixture().await;
    seeded_with_result(&f).await;
    f.webhooks.upsert(&EndpointRecord { name: "gh".into(), instructions: "x".into(), ..Default::default() }).await.unwrap();
    f.webhooks.record_delivery("gh", "r2", Some(json!({"state": "pending", "at": "2025-01-02T00:00:00Z", "result": {"ok": false, "text": "x"}}))).await.unwrap();
    assert_eq!(f.rt.recover_routine_deliveries().await, Ok(0));
    let ids: Vec<_> = f.host.delivered.lock().unwrap().iter().map(|i| (i.run_id.clone(), i.kind)).collect();
    assert_eq!(ids, vec![("r1".to_string(), RoutineKind::Schedule), ("r2".to_string(), RoutineKind::Webhook)]);
    assert_eq!(f.rt.retry_routine_delivery("cron", "daily").await, Err("unknown routine kind \"cron\"".into()));
    assert_eq!(f.rt.retry_routine_delivery("schedule", "nope").await, Err("schedule \"nope\" does not exist".into()));
}

fn headers(pairs: &[(&str, &str)]) -> Headers {
    pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

async fn received(f: &Fixture, name: &str, id: &str) {
    let claim = Claim { status: "received", event: None, headers_summary: json!({}), payload_preview: "{}".into() };
    assert!(f.webhooks.claim_delivery(name, id, claim).await.unwrap());
}

async fn endpoint(f: &Fixture) -> HomeWebhookDispatch {
    f.webhooks
        .upsert(&EndpointRecord {
            name: "gh".into(),
            instructions: "Summarise the event.".into(),
            owner_agent_id: "gh-bot".into(),
            secret: Some("s".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    HomeWebhookDispatch::new(f.rt.clone(), f.webhooks.clone(), None, RunningWork::new())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_webhook_is_answered_202_and_its_run_settles_the_delivery() {
    let f = fixture().await;
    let dispatch = endpoint(&f).await;
    received(&f, "gh", "d1").await;
    let sent = headers(&[("x-github-event", "push"), ("authorization", "Bearer secret")]);
    let reply = dispatch.handle("gh", json!({"action": "created"}), &sent, "d1", true).await.unwrap();
    assert_eq!((reply.status, reply.body), (202, json!({"status": "accepted", "handler": "session", "id": "d1"})));

    // The run is its own task: wait for the delivery to leave `processing`.
    let status = loop {
        let (status, error) = f.webhooks.delivery_row("gh", "d1").await.unwrap();
        if status != "processing" {
            break (status, error);
        }
        tokio::task::yield_now().await;
    };
    assert_eq!(status, ("done".to_string(), None));
    let turn = &f.host.turns()[0];
    assert_eq!((turn.session_id.as_str(), turn.skill_selection.as_str()), ("sess_home_gh-bot", "Summarise the event."));
    assert_eq!(turn.trigger.event.as_deref(), Some("push · created"));
    let text = content_of(turn);
    assert!(text.contains("UNTRUSTED input from an external webhook sender"));
    assert!(text.contains("x-github-event: push") && !text.contains("authorization") && !text.contains("Bearer secret"));
    let stored = f.webhooks.load("gh").await.unwrap().unwrap();
    assert!(stored.last_success_at.is_some());
    assert_eq!(stored.last_payload, Some(json!({"body": {"action": "created"}, "headers": {"x-github-event": "push"}})));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_or_overlapping_webhook_run_marks_its_delivery_and_endpoint() {
    let f = fixture().await;
    let dispatch = endpoint(&f).await;
    f.host.settles.lock().unwrap().push_back(TurnSettle::Failed("provider down".into()));
    received(&f, "gh", "d1").await;
    dispatch.handle("gh", json!({}), &headers(&[]), "d1", true).await.unwrap();
    let outcome = loop {
        let row = f.webhooks.delivery_row("gh", "d1").await.unwrap();
        if row.0 != "processing" {
            break row;
        }
        tokio::task::yield_now().await;
    };
    assert_eq!(outcome, ("failed".to_string(), Some("provider down".to_string())));
    let stored = f.webhooks.load("gh").await.unwrap().unwrap();
    assert_eq!((stored.consecutive_failures, stored.last_failed_at.is_some()), (1, true));

    let held = f.rt.runs().begin(RoutineKind::Webhook, "gh").unwrap();
    received(&f, "gh", "d2").await;
    dispatch.handle("gh", json!({}), &headers(&[]), "d2", true).await.unwrap();
    let outcome = loop {
        let row = f.webhooks.delivery_row("gh", "d2").await.unwrap();
        if row.0 != "processing" {
            break row;
        }
        tokio::task::yield_now().await;
    };
    drop(held);
    assert_eq!(outcome.0, "skipped");
    assert!(f.webhooks.load("gh").await.unwrap().unwrap().last_skipped_at.is_some());
}

struct Pipeline(bool);

impl WebhookEvents for Pipeline {
    fn handle_webhook(&self, _name: &str, _body: &Value, _headers: &Headers) -> bool {
        self.0
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_parser_only_endpoint_goes_to_the_event_pipeline_or_is_unknown() {
    let f = fixture().await;
    let taken = HomeWebhookDispatch::new(f.rt.clone(), f.webhooks.clone(), Some(Arc::new(Pipeline(true))), RunningWork::new());
    received(&f, "parser", "d1").await;
    let reply = taken.handle("parser", json!({}), &headers(&[]), "d1", false).await.unwrap();
    assert_eq!((reply.status, reply.body), (200, json!({"status": "accepted", "id": "d1"})));
    assert_eq!(f.webhooks.delivery_row("parser", "d1").await.unwrap().0, "done");

    let refused = HomeWebhookDispatch::new(f.rt.clone(), f.webhooks.clone(), Some(Arc::new(Pipeline(false))), RunningWork::new());
    received(&f, "parser", "d2").await;
    let reply = refused.handle("parser", json!({}), &headers(&[]), "d2", false).await.unwrap();
    assert_eq!((reply.status, reply.body), (404, json!({"error": "unknown endpoint"})));
    assert_eq!(f.webhooks.delivery_row("parser", "d2").await.unwrap(), ("failed".to_string(), Some("unknown endpoint".to_string())));
    assert!(f.host.turns().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_table_endpoint_that_vanished_falls_through_as_a_failed_delivery() {
    let f = fixture().await;
    let dispatch = HomeWebhookDispatch::new(f.rt.clone(), f.webhooks.clone(), None, RunningWork::new());
    received(&f, "gone", "d1").await;
    let reply = dispatch.handle("gone", json!({}), &headers(&[]), "d1", true).await.unwrap();
    assert_eq!(reply.status, 404);
    assert_eq!(f.webhooks.delivery_row("gone", "d1").await.unwrap().1.as_deref(), Some("unknown endpoint"));
}
