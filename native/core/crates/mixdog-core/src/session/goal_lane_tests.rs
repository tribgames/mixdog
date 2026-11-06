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
use crate::goal::Admission;
use crate::goal::Continuation;
use crate::goal::ContinuationInput;
use crate::goal::GoalEvent;
use crate::goal::GoalResult;
use crate::goal::GoalRuntime;
use crate::goal::Subscription;
use crate::goal::hooks::GoalContinuationHooks;
use crate::goal::hooks::GoalTurnHooks;
use crate::goal::hooks::GoalViewHooks;
use crate::goal::js::Goal;

/// The Goal runtime, counting the reminder resets and keeping the continuation inputs it saw.
struct Spy {
    inner: GoalRuntime,
    resets: Mutex<usize>,
    inputs: Mutex<Vec<ContinuationInput>>,
    /// The Goal the test injected; the runtime has none, and its own answers would clear the lane.
    pinned: Mutex<Option<Goal>>,
}

impl Spy {
    fn new(rig: &Rig) -> Arc<Self> {
        Arc::new(Self { inner: rig.goals.clone(), resets: Mutex::new(0), inputs: Mutex::new(Vec::new()), pinned: Mutex::new(None) })
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
        GoalContinuationHooks::continuation(&self.inner, thread, input).await
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
                use crate::goal::hooks::GoalViewHooks;
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
    let gate = holding(&rig);
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
    eventually(|| idle(&handle).then_some(())).await;
    changed(&spy, &handle, goal("g1", "active", 2, 120_000)).await;
    eventually(|| (spy.resets() == 1).then_some(())).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
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

/// `markGoalReminder(reason)` marks the session's pending Goal reminder
/// (`markPendingGoalReminder`): one more revision each time, with the reason and `updatedAt`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_goal_reminder_marks_the_sessions_pending_reminder() {
    let rig = Rig::new();
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
