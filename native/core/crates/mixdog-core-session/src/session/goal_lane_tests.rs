//! The session's Goal lane against the Goal runtime: the continuation's inputs, the deadline
//! notices, the reminder reset and the `/goal` route (`tui/session/goal-continuation.mjs`,
//! `deadline-delivery.mjs`, `goal-facade-api.mjs`).

use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::Reply;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::OpId;
use mixdog_protocol::ThreadId;
use mixdog_rt::CancellationToken;
use mixdog_store::schema::blob::Slot;
use mixdog_store::schema::record::QueueAction;
use mixdog_store::schema::record::Record;
use serde_json::Value;
use serde_json::json;

use super::SessionDirectory;
use super::SessionHandle;
use super::actor::Inbox;
use super::seams::RunOutcome;
use super::testing::Rig;
use super::testing::lock;
use super::tests::eventually;
use super::tests::idle;
use super::tests::start_thread;
use super::tests::turn;
use mixdog_core_goal::goal::Admission;
use mixdog_core_goal::goal::Continuation;
use mixdog_core_goal::goal::ContinuationInput;
use mixdog_core_goal::goal::GoalEvent;
use mixdog_core_goal::goal::GoalResult;
use mixdog_core_goal::goal::GoalRuntime;
use mixdog_core_goal::goal::Subscription;
use mixdog_core_goal::goal::hooks::GoalContinuationHooks;
use mixdog_core_goal::goal::hooks::GoalTurnHooks;
use mixdog_core_goal::goal::hooks::GoalViewHooks;
use mixdog_core_goal::goal::js::Goal;

/// The Goal runtime, counting the reminder resets and keeping the continuation inputs it saw.
struct Spy {
    inner: GoalRuntime,
    resets: Mutex<usize>,
    inputs: Mutex<Vec<ContinuationInput>>,
    /// The Goal the test injected; the runtime has none, and its own answers would clear the lane.
    pinned: Mutex<Option<Goal>>,
    /// While set, `turn_settled` waits for it.
    hold: Mutex<Option<Arc<tokio::sync::Notify>>>,
    /// Per continuation call in order: `Some(run)` replaces the runtime's `run`.
    runs: Mutex<std::collections::VecDeque<Option<bool>>>,
}

impl Spy {
    fn new(rig: &Rig) -> Arc<Self> {
        Arc::new(Self {
            inner: rig.goals.clone(),
            resets: Mutex::new(0),
            inputs: Mutex::new(Vec::new()),
            pinned: Mutex::new(None),
            hold: Mutex::new(None),
            runs: Mutex::default(),
        })
    }
    fn resets(&self) -> usize {
        *lock(&self.resets)
    }
    fn pin_or(&self, answer: GoalResult<Option<Goal>>) -> GoalResult<Option<Goal>> {
        match lock(&self.pinned).clone() {
            Some(goal) => Ok(Some(goal)),
            None => answer,
        }
    }
}

#[async_trait]
impl GoalTurnHooks for Spy {
    async fn turn_started(&self, thread: &ThreadId) -> GoalResult<Option<Goal>> {
        self.pin_or(self.inner.turn_started(thread).await)
    }
    async fn turn_settled(&self, thread: &ThreadId, detail: Value) -> GoalResult<Option<Goal>> {
        let hold = lock(&self.hold).clone();
        if let Some(hold) = hold {
            hold.notified().await;
        }
        self.pin_or(self.inner.turn_settled(thread, detail).await)
    }
    async fn archive_completed_on_user_input(&self, thread: &ThreadId) -> GoalResult<Option<Goal>> {
        GoalTurnHooks::archive_completed_on_user_input(&self.inner, thread).await
    }
    async fn reactivate_usage_limited(&self, thread: &ThreadId, goal_id: &str, admission: Admission) -> GoalResult<Option<Goal>> {
        GoalTurnHooks::reactivate_usage_limited(&self.inner, thread, goal_id, admission).await
    }
}

#[async_trait]
impl GoalContinuationHooks for Spy {
    async fn continuation(&self, thread: &ThreadId, input: ContinuationInput) -> GoalResult<Continuation> {
        lock(&self.inputs).push(input.clone());
        let mut decision = GoalContinuationHooks::continuation(&self.inner, thread, input).await?;
        if let Some(Some(run)) = lock(&self.runs).pop_front() {
            decision.run = run;
        }
        Ok(decision)
    }
    fn reset_continuation_rules(&self, thread: &ThreadId) -> GoalResult<()> {
        *lock(&self.resets) += 1;
        GoalContinuationHooks::reset_continuation_rules(&self.inner, thread)
    }
}

#[async_trait]
impl GoalViewHooks for Spy {
    async fn goal_status(&self, thread: &ThreadId) -> GoalResult<Option<Goal>> {
        self.pin_or(self.inner.goal_status(thread).await)
    }
    async fn goal_control(&self, thread: &ThreadId, request: Value) -> GoalResult<Value> {
        self.inner.goal_control(thread, request).await
    }
    fn on_goal_change(&self, listener: Box<dyn Fn(&GoalEvent) + Send + Sync>) -> Subscription {
        self.inner.on_goal_change(listener)
    }
}

fn directory(rig: &Rig, spy: &Arc<Spy>) -> SessionDirectory {
    let mut parts = rig.deps_parts(rig.store.clone());
    parts.goals = spy.clone();
    SessionDirectory::new(Arc::new(parts))
}

fn request(method: &'static str, params: Value, op: &str) -> CoreRequest {
    CoreRequest {
        method: Method(method),
        params,
        op: Some(OpId::from(op)),
        ctx: CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, CancellationToken::new()),
    }
}

/// A Goal as the runtime publishes it, for the lane to react to.
fn goal(id: &str, status: &str, warning_revision: u64, remaining_ms: u64) -> Goal {
    let Value::Object(goal) = json!({
        "id": id, "sessionId": "s", "objective": "Ship it", "title": "Ship it", "status": status,
        "warningRevision": warning_revision, "remainingMs": remaining_ms, "timeLimitMs": 600_000,
        "timeUsedMs": 1, "turnCount": 1,
    }) else {
        unreachable!()
    };
    goal
}

async fn changed(spy: &Spy, handle: &SessionHandle, goal: Goal) {
    *lock(&spy.pinned) = Some(goal.clone());
    handle.inbox.send(Inbox::GoalChanged(Some(goal))).await.expect("the actor is running");
}

/// The Goal entries the thread enqueued so far, in order.
fn queued_entries(rig: &Rig, handle: &SessionHandle) -> Vec<Value> {
    rig.store
        .records(&handle.id)
        .into_iter()
        .filter_map(|(_, record)| match record {
            Record::Queue(queue) if queue.action == QueueAction::Enqueue => match queue.entry {
                Some(Slot::Inline(entry)) => Some(entry),
                _ => None,
            },
            _ => None,
        })
        .collect()
}

/// Holds the next run open until released, so the thread is busy while the lane is told things;
/// later runs (what the released queue starts) complete at once.
fn holding(rig: &Rig) -> Arc<tokio::sync::Notify> {
    let gate = Arc::new(tokio::sync::Notify::new());
    let (open, first) = (gate.clone(), Arc::new(std::sync::atomic::AtomicBool::new(true)));
    rig.set_script(Arc::new(move |run| {
        let (open, first) = (open.clone(), first.clone());
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            if first.swap(false, std::sync::atomic::Ordering::SeqCst) {
                open.notified().await;
            }
            RunOutcome::Completed(Default::default())
        })
    }));
    gate
}

/// `holding`, also counting the runs that finished, so a test waits for a turn by its end and
/// never by a poll of the thread's state.
fn holding_counted(rig: &Rig) -> (Arc<tokio::sync::Notify>, tokio::sync::watch::Receiver<usize>) {
    let gate = Arc::new(tokio::sync::Notify::new());
    let (done, finished) = tokio::sync::watch::channel(0usize);
    let done = Arc::new(done);
    let (open, first) = (gate.clone(), Arc::new(std::sync::atomic::AtomicBool::new(true)));
    rig.set_script(Arc::new(move |run| {
        let (open, first, done) = (open.clone(), first.clone(), done.clone());
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            if first.swap(false, std::sync::atomic::Ordering::SeqCst) {
                open.notified().await;
            }
            done.send_modify(|count| *count += 1);
            RunOutcome::Completed(Default::default())
        })
    }));
    (gate, finished)
}

/// `goal-facade-api.mjs` `goalContinuation`: the continuation carries the session's todo list,
/// and it waits while the session waits on an agent or an awaited background job.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_continuation_carries_the_todo_list_and_waits_on_background_work() {
    use mixdog_tools::state::todo::{TodoList, TodoPhase, TodoStatus, TodoTask};
    let rig = Rig::new();
    *lock(&rig.todos.0) = TodoList {
        phases: vec![TodoPhase {
            name: "Tasks".into(),
            tasks: vec![TodoTask { content: "Write the parser".into(), status: TodoStatus::InProgress, note: None }],
        }],
        updated_at_ms: 1,
    };
    rig.work.0.store(true, std::sync::atomic::Ordering::SeqCst);
    let (seen, goals) = (Arc::new(Mutex::new(Vec::<Value>::new())), rig.goals.clone());
    let seen_in = seen.clone();
    rig.set_script(Arc::new(move |run| {
        let (seen, goals) = (seen_in.clone(), goals.clone());
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            lock(&seen).push(run.input_body.clone());
            if lock(&seen).len() == 1 {
                use mixdog_core_goal::goal::hooks::GoalViewHooks;
                goals.goal_control(&run.thread, json!({ "action": "create", "objective": "Ship the feature" })).await.expect("create");
            }
            RunOutcome::Completed(Default::default())
        })
    }));
    let spy = Spy::new(&rig);
    let directory = directory(&rig, &spy);
    let handle = start_thread(&directory).await;
    turn(&handle, "start", "op-1").await;
    eventually(|| (lock(&spy.inputs).len() >= 1 && idle(&handle)).then_some(())).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(lock(&seen).len(), 1, "the session waits on background work: no continuation turn");
    let first = lock(&spy.inputs)[0].clone();
    assert!(first.awaiting_work, "an agent still runs");
    assert!(first.todo.starts_with("<todo_state>\nTodo list for this Goal (exact wordings):\n"), "{}", first.todo);
    assert!(first.todo.contains("Write the parser"), "{}", first.todo);

    rig.work.0.store(false, std::sync::atomic::Ordering::SeqCst);
    turn(&handle, "again", "op-2").await;
    eventually(|| (lock(&seen).len() >= 3).then_some(())).await;
    let inputs = lock(&seen).clone();
    let prompt = inputs[2]["content"].as_str().unwrap_or_default().to_owned();
    assert_eq!(inputs[2]["meta"]["source"], "goal-continuation");
    assert!(prompt.contains("Write the parser"), "the continuation prompt carries the todo list: {prompt}");
    assert!(!lock(&spy.inputs).last().unwrap().awaiting_work);
}

/// `deliverGoalDeadlineWarning`: the first sighting of a Goal only sets the watermark; a later
/// revision rides the queue as a hidden prompt behind a running turn, and marks the reminder
/// (which resets the continuation rules) when the thread is idle. A delivered revision is not
/// delivered twice.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_deadline_warning_is_queued_behind_a_turn_and_marks_the_reminder_when_idle() {
    let rig = Rig::new();
    let (gate, mut finished) = holding_counted(&rig);
    let spy = Spy::new(&rig);
    let directory = directory(&rig, &spy);
    let handle = start_thread(&directory).await;
    changed(&spy, &handle, goal("g1", "active", 0, 600_000)).await;
    turn(&handle, "work", "op-1").await;
    eventually(|| (!idle(&handle)).then_some(())).await;

    changed(&spy, &handle, goal("g1", "active", 1, 300_000)).await;
    let entries = eventually(|| Some(queued_entries(&rig, &handle)).filter(|entries| !entries.is_empty())).await;
    assert_eq!(entries.len(), 1);
    let warning = &entries[0];
    assert_eq!((warning["mode"].clone(), warning["priority"].clone(), warning["goalId"].clone()), (json!("prompt"), json!("next"), json!("g1")));
    assert_eq!((warning["isMeta"].clone(), warning["suppressDisplay"].clone(), warning["restorable"].clone()), (json!(true), json!(true), json!(false)));
    assert!(warning["message"].as_str().unwrap().contains("<goal_deadline>"), "{warning}");
    assert_eq!(spy.resets(), 0, "a busy thread takes the entry, not the reminder");

    changed(&spy, &handle, goal("g1", "active", 1, 290_000)).await;
    gate.notify_one();
    // The script never drains steers, so the warning queued behind the turn runs as a turn of its
    // own: both turns have ended once two runs finished, and the thread is idle for good after.
    tokio::time::timeout(Duration::from_secs(60), finished.wait_for(|count| *count == 2)).await.expect("both turns end").expect("the script is alive");
    eventually(|| (idle(&handle) && handle.cell.view.load_full().state.queued.as_ref().is_none_or(Vec::is_empty)).then_some(())).await;
    changed(&spy, &handle, goal("g1", "active", 2, 120_000)).await;
    eventually(|| (spy.resets() == 1).then_some(())).await;
    assert_eq!(*finished.borrow(), 2, "no further turn ran");
    assert_eq!(queued_entries(&rig, &handle).iter().filter(|e| e["mode"] == "prompt").count(), 1, "revision 1 was delivered once");
    assert_eq!(spy.resets(), 1, "an idle thread marks the reminder once");
}

/// `deliverGoalCloseout`: the Goal that reaches its duration while a turn runs queues one
/// `goal-closeout` entry for it (`next`, hidden, discarded on abort); an idle thread with queued
/// user work marks the reminder instead; a closeout already queued is kept, not duplicated.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_deadline_closeout_is_queued_when_the_goal_reaches_its_duration() {
    let rig = Rig::new();
    let gate = holding(&rig);
    let spy = Spy::new(&rig);
    let directory = directory(&rig, &spy);
    let handle = start_thread(&directory).await;
    changed(&spy, &handle, goal("g1", "active", 0, 60_000)).await;
    turn(&handle, "work", "op-1").await;
    eventually(|| (!idle(&handle)).then_some(())).await;

    changed(&spy, &handle, goal("g1", "duration_reached", 0, 0)).await;
    let entries = eventually(|| Some(queued_entries(&rig, &handle)).filter(|entries| !entries.is_empty())).await;
    let closeout = &entries[0];
    assert_eq!((closeout["mode"].clone(), closeout["priority"].clone(), closeout["goalId"].clone()), (json!("goal-closeout"), json!("next"), json!("g1")));
    assert_eq!(closeout["abortDiscardOnAbort"], json!(true));
    assert!(closeout["message"].as_str().unwrap().contains("<goal_deadline_reached>"), "{closeout}");

    changed(&spy, &handle, goal("g1", "duration_reached", 0, 0)).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(queued_entries(&rig, &handle).len(), 1, "the closeout is queued once");
    gate.notify_one();
    eventually(|| idle(&handle).then_some(())).await;
}

/// A user prompt that removes a queued closeout of a Goal at its duration marks the reminder
/// (`archiveCompletedGoalOnUserInput`).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_user_prompt_dropping_the_closeout_marks_the_reminder() {
    let rig = Rig::new();
    let gate = holding(&rig);
    let spy = Spy::new(&rig);
    let directory = directory(&rig, &spy);
    let handle = start_thread(&directory).await;
    changed(&spy, &handle, goal("g1", "active", 0, 60_000)).await;
    turn(&handle, "work", "op-1").await;
    eventually(|| (!idle(&handle)).then_some(())).await;
    changed(&spy, &handle, goal("g1", "duration_reached", 0, 0)).await;
    // Acked, not just recorded: the actor's projection is what a user prompt reads.
    eventually(|| handle.cell.view.load_full().state.queued.as_ref().filter(|queued| !queued.is_empty()).map(|_| ())).await;
    assert_eq!(spy.resets(), 0);

    turn(&handle, "more", "op-2").await;
    eventually(|| (spy.resets() == 1).then_some(())).await;
    gate.notify_one();
    gate.notify_one();
    eventually(|| idle(&handle).then_some(())).await;
}

/// Holds the first run open until released and keeps every run's input row.
fn recording(rig: &Rig) -> (Arc<tokio::sync::Notify>, Arc<Mutex<Vec<Value>>>) {
    let gate = Arc::new(tokio::sync::Notify::new());
    let seen: Arc<Mutex<Vec<Value>>> = Arc::default();
    let (open, inputs) = (gate.clone(), seen.clone());
    rig.set_script(Arc::new(move |run| {
        let (open, inputs) = (open.clone(), inputs.clone());
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let first = {
                let mut inputs = lock(&inputs);
                inputs.push(run.input_body.clone());
                inputs.len() == 1
            };
            if first {
                open.notified().await;
            }
            RunOutcome::Completed(Default::default())
        })
    }));
    (gate, seen)
}

fn sources(seen: &Mutex<Vec<Value>>) -> Vec<String> {
    lock(seen).iter().map(|body| body.pointer("/meta/source").and_then(Value::as_str).unwrap_or("user").to_owned()).collect()
}

/// `shouldRunGoalContinuation` for a queued closeout (`drain.mjs`): it runs while the lane's
/// Goal is still the one at its duration, and is dropped once that Goal is no longer there.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_queued_closeout_runs_only_while_its_goal_is_at_its_duration() {
    for still_due in [true, false] {
        let rig = Rig::new();
        let (gate, seen) = recording(&rig);
        let spy = Spy::new(&rig);
        let directory = directory(&rig, &spy);
        let handle = start_thread(&directory).await;
        changed(&spy, &handle, goal("g1", "active", 0, 60_000)).await;
        turn(&handle, "work", "op-1").await;
        eventually(|| (!idle(&handle)).then_some(())).await;
        changed(&spy, &handle, goal("g1", "duration_reached", 0, 0)).await;
        eventually(|| handle.cell.view.load_full().state.queued.as_ref().filter(|queued| !queued.is_empty()).map(|_| ())).await;
        if !still_due {
            // The runtime's Goal moved on without the lane hearing it yet.
            *lock(&spy.pinned) = Some(goal("g1", "active", 0, 60_000));
        }
        gate.notify_one();
        if still_due {
            eventually(|| (sources(&seen) == ["user", "goal-closeout"]).then_some(())).await;
        }
        eventually(|| (idle(&handle) && handle.cell.view.load_full().state.queued.as_ref().is_none_or(|queued| queued.is_empty())).then_some(())).await;
        tokio::time::sleep(Duration::from_millis(150)).await;
        let expected: &[&str] = if still_due { &["user", "goal-closeout"] } else { &["user"] };
        assert_eq!(sources(&seen), expected, "still due: {still_due}");
    }
}

/// `shouldRunGoalContinuation` for a queued continuation: the runtime decides again when the
/// entry comes up, and a `run: false` drops it without rescheduling.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_queued_continuation_runs_only_if_the_runtime_still_decides_to_run() {
    let rig = Rig::new();
    let (gate, seen) = recording(&rig);
    gate.notify_one();
    let spy = Spy::new(&rig);
    // The scheduling decision as the runtime makes it, then the check refuses.
    lock(&spy.runs).extend([None, Some(false)]);
    let directory = directory(&rig, &spy);
    let handle = start_thread(&directory).await;
    spy.inner.goal_control(&handle.id, json!({ "action": "create", "objective": "Ship the feature" })).await.expect("create");
    eventually(|| (lock(&spy.inputs).len() >= 2).then_some(())).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(lock(&seen).is_empty(), "the refused continuation never ran: {:?}", sources(&seen));
    assert_eq!(lock(&spy.inputs).len(), 2, "the dropped entry is not rescheduled");
    assert!(idle(&handle));
    assert!(handle.cell.view.load_full().state.queued.as_ref().is_none_or(|queued| queued.is_empty()));
}

/// Node's `state.busy` is cleared when the turn closes, before its Goal settlement: a deadline
/// warning that lands while the turn settles marks the reminder, as on an idle thread.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_deadline_warning_during_the_settlement_marks_the_reminder() {
    let rig = Rig::new();
    let (gate, seen) = recording(&rig);
    gate.notify_one();
    let spy = Spy::new(&rig);
    let directory = directory(&rig, &spy);
    let handle = start_thread(&directory).await;
    changed(&spy, &handle, goal("g1", "active", 0, 600_000)).await;
    let hold = Arc::new(tokio::sync::Notify::new());
    *lock(&spy.hold) = Some(hold.clone());
    turn(&handle, "work", "op-1").await;
    eventually(|| (lock(&seen).len() == 1 && idle(&handle)).then_some(())).await;

    changed(&spy, &handle, goal("g1", "active", 1, 300_000)).await;
    let pending = eventually(|| handle.cell.header.load().get("pendingGoalReminder").cloned()).await;
    assert_eq!(pending["reason"], "deadline-soon");
    assert_eq!(spy.resets(), 1);
    assert!(queued_entries(&rig, &handle).is_empty(), "a settling turn takes no queued warning");
    *lock(&spy.hold) = None;
    hold.notify_one();
}

/// `markGoalReminder(reason)` marks the session's pending Goal reminder
/// (`markPendingGoalReminder`): one more revision each time, with the reason and `updatedAt`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_goal_reminder_marks_the_sessions_pending_reminder() {
    let rig = Rig::new();
    // The active Goal continues as a turn, and a turn that completes carries the pending
    // reminder and clears it (`acknowledgePendingGoalReminder`): the first run stays open, so the
    // marks are what the header holds.
    let gate = holding(&rig);
    let spy = Spy::new(&rig);
    let directory = directory(&rig, &spy);
    let handle = start_thread(&directory).await;
    let control = |params: Value, op: &'static str| {
        let handle = handle.clone();
        async move { handle.request(request("thread/goal/control", params, op)).await.expect("answered") }
    };
    handle.request(request("thread/goal/set", json!({ "threadId": handle.id, "opId": "g-1", "goal": "Ship the feature" }), "g-1")).await.expect("set");
    let pending = |handle: &SessionHandle| handle.cell.header.load().get("pendingGoalReminder").cloned();
    control(json!({ "threadId": handle.id, "opId": "g-2", "action": "edit", "args": { "objective": "Ship it" } }), "g-2").await;
    let first = eventually(|| pending(&handle)).await;
    assert_eq!(first, json!({ "version": 1, "type": "goal_state", "revision": 1, "reason": "objective-updated" }));
    control(json!({ "threadId": handle.id, "opId": "g-3", "action": "edit", "args": { "objective": "Ship it now" } }), "g-3").await;
    eventually(|| pending(&handle).filter(|p| p["revision"] == 2)).await;
    let header = handle.cell.header.load();
    assert_eq!(header.get("goalReminderRevision"), Some(&json!(2)));
    assert!(header.get("updatedAt").and_then(Value::as_i64).is_some());
    assert_eq!(spy.resets(), 2, "each mark resets the continuation rules");
    gate.notify_one();
}

/// A turn takes the pending Goal reminder into its tail (`snapshotPendingGoalReminder`) and the
/// marker goes once that turn completed (`acknowledgePendingGoalReminder`); a mark made while a
/// turn runs is not that turn's, so it survives the turn's end.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_completed_turn_carries_the_pending_reminder_and_clears_it() {
    let rig = Rig::new();
    let gate = Arc::new(tokio::sync::Notify::new());
    let seen: Arc<Mutex<Vec<Option<(u64, String)>>>> = Arc::default();
    let (open, first, reminders) = (gate.clone(), Arc::new(std::sync::atomic::AtomicBool::new(true)), seen.clone());
    rig.set_script(Arc::new(move |run| {
        let (open, first, reminders) = (open.clone(), first.clone(), reminders.clone());
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            lock(&reminders).push(run.goal_reminder.as_ref().map(|reminder| (reminder.revision, reminder.content.clone())));
            if first.swap(false, std::sync::atomic::Ordering::SeqCst) {
                open.notified().await;
            }
            RunOutcome::Completed(Default::default())
        })
    }));
    let spy = Spy::new(&rig);
    let directory = directory(&rig, &spy);
    let handle = start_thread(&directory).await;
    handle.request(request("thread/goal/set", json!({ "threadId": handle.id, "opId": "g-1", "goal": "Ship the feature" }), "g-1")).await.expect("set");
    let edit = request("thread/goal/control", json!({ "threadId": handle.id, "opId": "g-2", "action": "edit", "args": { "objective": "Ship it" } }), "g-2");
    handle.request(edit).await.expect("edit");
    // The edit marks the reminder and the active Goal's continuation turn takes it; the turn is
    // held open, so the marker stays until the turn is accepted.
    let carried = eventually(|| lock(&seen).iter().flatten().next().cloned()).await;
    assert_eq!(carried.0, 1);
    assert!(carried.1.contains("The user changed this Goal's objective."), "{}", carried.1);
    let pending = |handle: &SessionHandle| handle.cell.header.load().get("pendingGoalReminder").cloned();
    assert_eq!(pending(&handle).map(|pending| pending["revision"].clone()), Some(json!(1)));
    gate.notify_one();
    eventually(|| pending(&handle).is_none().then_some(())).await;
}

/// `canDeliverSteeringEntry`: the terminal boundary of a running turn steers the queued closeout
/// of the Goal at its duration; once the runtime's Goal is no longer at it, the entry leaves the
/// queue without reaching the model.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_queued_closeout_is_steered_only_while_its_goal_is_at_its_duration() {
    use super::run::{DrainRequest, DrainStage, Priority};
    for still_due in [true, false] {
        let rig = Rig::new();
        let gate = Arc::new(tokio::sync::Notify::new());
        let taken = Arc::new(Mutex::new(Vec::new()));
        let (open, out) = (gate.clone(), taken.clone());
        rig.set_script(Arc::new(move |run| {
            let (open, out) = (open.clone(), out.clone());
            Box::pin(async move {
                run.port.input_durable().await.expect("input durable");
                open.notified().await;
                let steers = run.port.take_steers(DrainRequest { stage: DrainStage::Terminal, max_priority: Priority::Next }).await.expect("take");
                lock(&out).extend(steers);
                RunOutcome::Completed(Default::default())
            })
        }));
        let spy = Spy::new(&rig);
        let directory = directory(&rig, &spy);
        let handle = start_thread(&directory).await;
        changed(&spy, &handle, goal("g1", "active", 0, 60_000)).await;
        turn(&handle, "work", "op-1").await;
        eventually(|| (!idle(&handle)).then_some(())).await;
        changed(&spy, &handle, goal("g1", "duration_reached", 0, 0)).await;
        eventually(|| handle.cell.view.load_full().state.queued.as_ref().filter(|queued| !queued.is_empty()).map(|_| ())).await;
        if !still_due {
            // The runtime's Goal moved on without the lane hearing it yet.
            *lock(&spy.pinned) = Some(goal("g1", "active", 0, 60_000));
        }
        gate.notify_one();
        eventually(|| idle(&handle).then_some(())).await;
        let taken = lock(&taken).clone();
        if still_due {
            assert_eq!(taken.len(), 1, "{taken:?}");
            assert!(taken[0].content.as_str().unwrap().contains("<goal_deadline_reached>"), "{:?}", taken[0].content);
        } else {
            assert!(taken.is_empty(), "a closeout its Goal no longer wants is never steered: {taken:?}");
        }
        // The dequeue is acked (durable) a moment after the turn ends.
        eventually(|| handle.cell.view.load_full().state.queued.as_ref().is_none_or(Vec::is_empty).then_some(())).await;
    }
}

/// `cancelQueuedGoalContinuations({ keepCloseoutFor })`: the kept closeout takes the text of
/// the Goal now (`entry.content = goalDeadlineReached(..)`) in place: one `update` record of
/// the same queue entry, no second entry.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_kept_closeout_takes_the_goals_text_in_place() {
    let rig = Rig::new();
    let gate = holding(&rig);
    let spy = Spy::new(&rig);
    let directory = directory(&rig, &spy);
    let handle = start_thread(&directory).await;
    changed(&spy, &handle, goal("g1", "active", 0, 60_000)).await;
    turn(&handle, "work", "op-1").await;
    eventually(|| (!idle(&handle)).then_some(())).await;
    changed(&spy, &handle, goal("g1", "duration_reached", 0, 0)).await;
    let first = eventually(|| Some(queued_entries(&rig, &handle)).filter(|entries| !entries.is_empty())).await;

    let mut edited = goal("g1", "duration_reached", 0, 0);
    edited.insert("objective".into(), json!("Ship it faster"));
    changed(&spy, &handle, edited).await;
    let updates = || {
        rig.store
            .records(&handle.id)
            .into_iter()
            .filter_map(|(_, record)| match record {
                Record::Queue(queue) if queue.action == QueueAction::Update => Some(queue),
                _ => None,
            })
            .collect::<Vec<_>>()
    };
    let updates = eventually(|| Some(updates()).filter(|updates| !updates.is_empty())).await;
    assert_eq!(updates.len(), 1);
    let Some(Slot::Inline(entry)) = &updates[0].entry else { panic!("{:?}", updates[0]) };
    assert!(entry["message"].as_str().unwrap().contains("Ship it faster"), "{entry}");
    assert_eq!(entry["mode"], "goal-closeout");
    assert_eq!(queued_entries(&rig, &handle).len(), first.len(), "the entry was edited, not queued again");
    let dequeued = rig.store.records(&handle.id).into_iter().filter(|(_, r)| matches!(r, Record::Queue(q) if q.action == QueueAction::Dequeue)).count();
    assert_eq!(dequeued, 0);
    gate.notify_one();
    eventually(|| idle(&handle).then_some(())).await;
}

/// `suppressDisplay`: a hidden Goal notice a turn takes in paints no row, where a user prompt
/// taken in the same way does.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_suppressed_entry_a_turn_takes_in_paints_no_row() {
    use super::ItemCommit;
    use super::run::{DrainRequest, DrainStage, Priority};
    async fn items_after(hidden: bool) -> usize {
        let rig = Rig::new();
        let gate = Arc::new(tokio::sync::Notify::new());
        let open = gate.clone();
        let steered = Arc::new(Mutex::new(0usize));
        let counted = steered.clone();
        rig.set_script(Arc::new(move |run| {
            let (open, counted) = (open.clone(), counted.clone());
            Box::pin(async move {
                run.port.input_durable().await.expect("input durable");
                open.notified().await;
                let steers = run.port.take_steers(DrainRequest { stage: DrainStage::Terminal, max_priority: Priority::Next }).await.expect("take");
                *lock(&counted) += steers.len();
                for (n, steer) in steers.into_iter().enumerate() {
                    let ids: Vec<&str> = steer.queued_ids.iter().map(|id| id.as_str()).collect();
                    run.port
                        .commit_item(ItemCommit {
                            iid: mixdog_core_api::ids::ItemId::from(format!("s-{n}")),
                            role: Some("user".into()),
                            model: true,
                            visible: true,
                            body: json!({ "role": "user", "content": steer.content, "meta": { "steered": true, "submissionIds": ids } }),
                            prompt: None,
                        })
                        .await
                        .expect("commit");
                }
                RunOutcome::Completed(Default::default())
            })
        }));
        let spy = Spy::new(&rig);
        let directory = directory(&rig, &spy);
        let handle = start_thread(&directory).await;
        changed(&spy, &handle, goal("g1", "active", 0, 600_000)).await;
        turn(&handle, "work", "op-1").await;
        eventually(|| (!idle(&handle)).then_some(())).await;
        if hidden {
            changed(&spy, &handle, goal("g1", "active", 1, 300_000)).await;
        } else {
            turn(&handle, "steer me", "op-2").await;
        }
        eventually(|| handle.cell.view.load_full().state.queued.as_ref().filter(|queued| !queued.is_empty()).map(|_| ())).await;
        gate.notify_one();
        eventually(|| idle(&handle).then_some(())).await;
        assert_eq!(*lock(&steered), 1, "the turn took the entry in");
        handle.cell.view.load_full().items.len()
    }
    let shown = items_after(false).await;
    assert_eq!(items_after(true).await + 1, shown, "only the user prompt paints a row");
}

/// The `/goal` route: `thread/goal/set` carries the request, `clear` and `control` map to
/// `goalControl`'s actions; the answer is the runtime's, a refusal is its message, an `edit`
/// marks the reminder and a `pause` cancels the running turn.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_goal_route_serves_goal_control() {
    let rig = Rig::new();
    let spy = Spy::new(&rig);
    let directory = directory(&rig, &spy);
    let handle = start_thread(&directory).await;
    let ask =|method: &'static str, params: Value, op: &str| {
        let (handle, op) = (&handle, op.to_owned());
        async move { handle.request(request(method, params, &op)).await }
    };
    let value = |reply: Result<Reply, CoreError>| match reply.expect("answered") {
        Reply::Value(value) => value,
        other => panic!("{other:?}"),
    };

    let created = value(ask("thread/goal/set", json!({ "threadId": handle.id, "opId": "g-1", "goal": "Ship the feature --time 30m" }), "g-1").await);
    assert_eq!((created["ok"].clone(), created["action"].clone()), (json!(true), json!("create")), "{created}");
    assert!(created["message"].as_str().unwrap().starts_with("Goal active · Ship the feature"), "{created}");

    let edited = value(ask("thread/goal/control", json!({ "threadId": handle.id, "opId": "g-2", "action": "edit", "args": { "objective": "Ship it faster" } }), "g-2").await);
    assert_eq!(edited["action"], "edit", "{edited}");
    assert_eq!(spy.resets(), 1, "an edit marks the reminder");

    let refused = ask("thread/goal/control", json!({ "threadId": handle.id, "opId": "g-3", "action": "time", "args": { "duration": "soon" } }), "g-3").await;
    let Err(CoreError::DomainError { message: Some(message), .. }) = refused else { panic!("a refusal: {refused:?}") };
    assert!(!message.is_empty());

    eventually(|| idle(&handle).then_some(())).await;
    let gate = holding(&rig);
    turn(&handle, "work", "op-1").await;
    eventually(|| (!idle(&handle)).then_some(())).await;
    let paused = value(ask("thread/goal/control", json!({ "threadId": handle.id, "opId": "g-4", "action": "pause" }), "g-4").await);
    assert_eq!(paused["action"], "pause", "{paused}");
    gate.notify_one();
    eventually(|| idle(&handle).then_some(())).await;
    let cleared = value(ask("thread/goal/clear", json!({ "threadId": handle.id, "opId": "g-5" }), "g-5").await);
    assert_eq!((cleared["action"].clone(), cleared["message"].clone()), (json!("clear"), json!("Goal cleared")), "{cleared}");
}
