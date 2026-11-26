//! The session's turn operations against Node's session actions (`session/turn_ops.rs`).

use std::sync::Arc;

use mixdog_core_api::CoreError;
use mixdog_core_api::Reply;
use mixdog_core_api::ThreadDirectory;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::OpId;
use mixdog_core_api::thread::Stop;
use mixdog_core_goal::goal::hooks::GoalViewHooks;
use mixdog_rt::CancellationToken;
use mixdog_tools::exec::TaskNotifier;
use serde_json::Value;
use serde_json::json;

use super::SessionDirectory;
use super::SessionHandle;
use super::seams::RunOutcome;
use super::testing::Rig;
use super::tests::idle;
use super::tests::start_routed_thread;
use super::tests::start_thread;
use super::tests::turn;
use crate::eventually_on;
use crate::eventually_on_until;

fn request(method: &'static str, params: Value, op: &str) -> CoreRequest {
    CoreRequest {
        method: Method(method),
        params,
        op: Some(OpId::from(op)),
        ctx: CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, CancellationToken::new()),
    }
}

async fn call(handle: &SessionHandle, method: &'static str, mut params: Value, op: &'static str) -> Result<Value, CoreError> {
    params["threadId"] = json!(handle.id);
    params["opId"] = json!(op);
    match handle.request(request(method, params, op)).await? {
        Reply::Value(value) => Ok(value),
        other => panic!("a value reply, got {other:?}"),
    }
}

/// A retry the session accepts once the failed turn has settled: Node's button only shows then,
/// so a refusal before that is polled past (each attempt its own op id).
async fn retry_when_settled(handle: &SessionHandle, key: &str, tag: &'static str) {
    use std::sync::atomic::Ordering::SeqCst;
    eventually_on!(&[&handle.cell.stepped], || (!handle.cell.busy.load(SeqCst) && !handle.cell.compacting.load(SeqCst)).then_some(())).await;
    assert_eq!(call(handle, "turn/retryFailed", json!({ "turnKey": key }), tag).await.expect("answered"), json!(true), "the settled turn takes its retry");
}

/// A run held open until the gate is notified.
fn held(rig: &Rig) -> Arc<tokio::sync::Notify> {
    let gate = Arc::new(tokio::sync::Notify::new());
    let open = gate.clone();
    rig.set_script(Arc::new(move |run| {
        let open = open.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            open.notified().await;
            RunOutcome::Completed(Default::default())
        })
    }));
    gate
}

/// A script whose first run waits for the gate; every run's prompt text and caller context are logged, in start order.
fn logged(rig: &Rig) -> (Arc<tokio::sync::Notify>, Arc<std::sync::Mutex<Vec<(String, Option<String>)>>>) {
    let gate = Arc::new(tokio::sync::Notify::new());
    let log: Arc<std::sync::Mutex<Vec<(String, Option<String>)>>> = Arc::default();
    let (open, seen) = (gate.clone(), log.clone());
    rig.set_script(Arc::new(move |run| {
        let (open, seen) = (open.clone(), seen.clone());
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let first = {
                let mut seen = super::testing::lock(&seen);
                let prompt = serde_json::to_value(&run.input.prompt).expect("prompt").as_str().unwrap_or_default().to_owned();
                seen.push((prompt, run.input.options.as_ref().and_then(|options| options.context.clone())));
                seen.len() == 1
            };
            if first {
                open.notified().await;
            }
            RunOutcome::Completed(Default::default())
        })
    }));
    (gate, log)
}

/// A queued follow-up's own `context` (an `agent send` to a busy session) reaches the turn the drain starts for it.
#[tokio::test(start_paused = true)]
async fn a_queued_follow_ups_context_reaches_the_turn_that_runs_it() {
    let rig = Rig::new();
    let (gate, log) = logged(&rig);
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "work", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (!idle(&handle)).then_some(())).await;
    let params = json!({ "threadId": handle.id, "opId": "op-2", "input": { "prompt": "follow up", "options": { "context": "the caller's context" } } });
    let host = CoreRequest { method: Method("turn/start"), params, op: Some(OpId::from("op-2")), ctx: CallContext::internal("test") };
    assert_eq!(handle.request(host).await.map(|_| ()).expect("queued"), ());
    gate.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (super::testing::lock(&log).len() == 2).then_some(())).await;
    assert_eq!(super::testing::lock(&log)[1], ("follow up".to_owned(), Some("the caller's context".to_owned())));
}

/// A queued slash command is the command dispatcher's: the drain never starts a model turn from it, a prompt queued after it
/// runs, and once nothing is left for the model the command goes back to the composer that runs commands, leaving the queue.
#[tokio::test(start_paused = true)]
async fn a_queued_slash_command_is_handed_back_to_the_composer_not_sent_to_the_model() {
    let rig = Rig::new();
    let (gate, log) = logged(&rig);
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "work", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (!idle(&handle)).then_some(())).await;
    turn(&handle, "/compact now", "op-2").await;
    turn(&handle, "plain", "op-3").await;
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.queued.load().len() == 2).then_some(())).await;
    gate.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (super::testing::lock(&log).len() == 2 && idle(&handle) && handle.cell.queued.load().is_empty()).then_some(()))
        .await;
    assert_eq!(super::testing::lock(&log)[1].0, "plain");
    assert!(super::testing::lock(&log).iter().all(|(prompt, _)| !prompt.starts_with('/')));
    let restored = handle.cell.view.load_full().state.prompt_restore.clone().expect("the command is handed back");
    assert_eq!(restored.text, "/compact now");
}

/// Two queued slash commands go back in the one hand-back the session state holds: a composer that renders it only once both
/// have left the queue (or mounts later) recovers both, each named by the submission it was sent with; nothing overwrote the first.
#[tokio::test(start_paused = true)]
async fn two_queued_slash_commands_are_handed_back_together() {
    let rig = Rig::new();
    let (gate, log) = logged(&rig);
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "work", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (!idle(&handle)).then_some(())).await;
    for (text, op, submission) in [("/compact now", "op-2", "sub-compact"), ("/usage", "op-3", "sub-usage")] {
        call(&handle, "turn/start", json!({ "input": { "prompt": text, "options": { "clientSubmissionId": submission } } }), op).await.expect("queued");
    }
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.queued.load().len() == 2).then_some(())).await;
    gate.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && handle.cell.queued.load().is_empty()).then_some(())).await;
    assert_eq!(super::testing::lock(&log).len(), 1, "no command reached the model");
    let restores: Vec<Value> =
        rig.feeds.frames(handle.id.as_str()).into_iter().filter(|(_, method, _)| method == "thread/promptRestore").map(|(_, _, value)| value).collect();
    assert_eq!(restores.len(), 1, "one hand-back, none overwritten: {restores:?}");
    let restored = handle.cell.view.load_full().state.prompt_restore.clone().expect("the commands are handed back");
    assert_eq!(restored.text, "/compact now\n/usage");
    assert_eq!(restored.ids, ["sub-compact", "sub-usage"]);
}

/// The between-turn drain takes the most urgent entry first, not the first queued: a `next` prompt queued after a `later` one runs
/// before it.
#[tokio::test(start_paused = true)]
async fn the_drain_takes_the_most_urgent_queued_prompt_first() {
    let rig = Rig::new();
    let (gate, log) = logged(&rig);
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "work", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (!idle(&handle)).then_some(())).await;
    call(&handle, "turn/start", json!({ "input": { "prompt": "later one", "options": { "priority": "later" } } }), "op-2").await.expect("queued");
    call(&handle, "turn/start", json!({ "input": { "prompt": "next one" } }), "op-3").await.expect("queued");
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.queued.load().len() == 2).then_some(())).await;
    gate.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (super::testing::lock(&log).len() == 3).then_some(())).await;
    let prompts: Vec<String> = super::testing::lock(&log).iter().map(|(prompt, _)| prompt.clone()).collect();
    assert_eq!(prompts, ["work", "next one", "later one"]);
}

/// A wake's batch is the selected priority's alone (`dequeueQueueBatch`): a `later` channel notice does not ride a `next`
/// completion's turn ahead of a `next` prompt queued after them both; it runs last.
#[tokio::test(start_paused = true)]
async fn a_later_notice_waits_for_a_next_prompt_instead_of_riding_a_completions_wake() {
    let rig = Rig::new();
    let (gate, log) = logged(&rig);
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "work", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (!idle(&handle)).then_some(())).await;
    for (task_id, text, origin) in [("task_agent_1", "the job is done", None), ("", "a channel notice", Some(super::completions::ORIGIN_CHANNEL))] {
        let note = super::actor::Inbox::TaskNotification {
            surface: "agent".into(),
            task_id: task_id.into(),
            status: "completed".into(),
            text: text.into(),
            origin,
            hop: 0,
            live: true,
            durable: None,
        };
        handle.inbox.send(note).await.expect("delivered");
    }
    turn(&handle, "next prompt", "op-2").await;
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.queued.load().len() == 3).then_some(())).await;
    gate.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (super::testing::lock(&log).len() == 4 && idle(&handle)).then_some(())).await;
    let prompts: Vec<String> = super::testing::lock(&log).iter().map(|(prompt, _)| prompt.clone()).collect();
    assert!(prompts[1].contains("the job is done") && !prompts[1].contains("a channel notice"), "{prompts:?}");
    assert_eq!(prompts[2], "next prompt", "{prompts:?}");
    assert!(prompts[3].contains("a channel notice"), "{prompts:?}");
}

/// Two prompts promoted before a turn boundary run latest promotion first (`prioritizeQueued` puts each at the front).
#[tokio::test(start_paused = true)]
async fn two_promotions_before_a_boundary_run_latest_first() {
    let rig = Rig::new();
    let (gate, log) = logged(&rig);
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "work", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (!idle(&handle)).then_some(())).await;
    for (text, op) in [("a", "op-2"), ("b", "op-3"), ("c", "op-4")] {
        turn(&handle, text, op).await;
    }
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.queued.load().len() == 3).then_some(())).await;
    let qids: Vec<String> = handle.cell.queue.load().iter().map(|queued| queued.qid.clone()).collect();
    // Promote "a" first, then "b": a steered boundary takes them in the queue's order, "b" ahead of "a".
    for qid in [&qids[0], &qids[1]] {
        handle.cell.steer(None, mixdog_core_api::ids::QueuedId::from(qid.as_str())).expect("promoted");
    }
    gate.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (super::testing::lock(&log).len() == 4 && idle(&handle)).then_some(())).await;
    let prompts: Vec<String> = super::testing::lock(&log).iter().map(|(prompt, _)| prompt.clone()).collect();
    assert_eq!(prompts[1..3], ["b", "a"], "{prompts:?}");
}

/// A `later` prompt promoted just before a `next` boundary, its promotion accepted but not yet saved, is injected there ahead of
/// one promoted earlier and saved: the boundary chooses and admits from the same (accepted) queue.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_promotion_still_being_saved_is_injected_ahead_of_an_earlier_one_at_a_boundary() {
    use super::run::DrainRequest;
    use super::run::DrainStage;
    use super::run::Priority;
    use mixdog_store::schema::record::QueueAction;
    use mixdog_store::schema::record::Record;
    use std::sync::atomic::Ordering::SeqCst;
    let rig = Rig::new();
    let at_boundary = Arc::new(tokio::sync::Notify::new());
    let taken: Arc<std::sync::Mutex<Vec<String>>> = Arc::default();
    let first = Arc::new(std::sync::atomic::AtomicBool::new(true));
    rig.set_script(Arc::new({
        let (at_boundary, taken) = (at_boundary.clone(), taken.clone());
        move |run| {
            let (at_boundary, taken, first) = (at_boundary.clone(), taken.clone(), first.swap(false, SeqCst));
            Box::pin(async move {
                run.port.input_durable().await.expect("input durable");
                if first {
                    at_boundary.notified().await;
                    let steers = run.port.take_steers(DrainRequest { stage: DrainStage::PreSend, max_priority: Priority::Next }).await.expect("take");
                    super::testing::lock(&taken).extend(steers.iter().map(|steer| steer.content.as_str().unwrap_or_default().to_owned()));
                }
                RunOutcome::Completed(Default::default())
            })
        }
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "work", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (!idle(&handle)).then_some(())).await;
    for (text, op) in [("a", "op-2"), ("b", "op-3")] {
        call(&handle, "turn/start", json!({ "input": { "prompt": text, "options": { "priority": "later" } } }), op).await.expect("queued");
    }
    let qids: Vec<String> = handle.cell.queue.load().iter().map(|queued| queued.qid.clone()).collect();
    assert_eq!(qids.len(), 2);
    let promoted = |qid: &str| {
        rig.store
            .records(&handle.id)
            .iter()
            .any(|(_, record)| matches!(record, Record::Queue(q) if q.action == QueueAction::Prioritize && q.qid.as_str() == qid))
    };
    handle.cell.steer(None, mixdog_core_api::ids::QueuedId::from(qids[0].as_str())).expect("a promoted");
    eventually_on!(&[&handle.cell.stepped, &*rig.store.committed], || promoted(qids[0].as_str()).then_some(())).await;
    let b = qids[1].clone();
    let (saving, save) = rig.store.hold_record(move |record| matches!(record, Record::Queue(q) if q.action == QueueAction::Prioritize && q.qid.as_str() == b));
    handle.cell.steer(None, mixdog_core_api::ids::QueuedId::from(qids[1].as_str())).expect("b promoted");
    saving.notified().await;
    at_boundary.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (!super::testing::lock(&taken).is_empty()).then_some(())).await;
    assert!(!promoted(qids[1].as_str()), "the boundary ran while b's promotion was still being saved");
    save.send(()).expect("the save waits");
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    assert_eq!(*super::testing::lock(&taken), ["b", "a"]);
}

/// A prompt sent while a manual `/compact` runs is queued, not started beside it, and runs once the compaction ends.
#[tokio::test(start_paused = true)]
async fn a_prompt_sent_during_a_manual_compaction_waits_for_it() {
    let rig = Rig::new();
    let (_gate, log) = logged(&rig);
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let hold = Arc::new(tokio::sync::Notify::new());
    *super::testing::lock(&rig.compaction.hold) = Some(hold.clone());
    let mut compacting = {
        let handle = handle.clone();
        tokio::spawn(async move { call(&handle, "thread/compact/start", json!({}), "c-1").await })
    };
    eventually_on_until!(&[&handle.cell.stepped], || handle.cell.compacting.load(std::sync::atomic::Ordering::SeqCst).then_some(()), &mut compacting).await;
    let answer = turn(&handle, "during", "op-2").await;
    assert_eq!(answer["kind"], "queued", "{answer}");
    assert!(super::testing::lock(&log).is_empty(), "no turn starts beside the compaction");
    hold.notify_one();
    compacting.await.expect("joined").expect("compacted");
    eventually_on!(&[&handle.cell.stepped], || (super::testing::lock(&log).len() == 1).then_some(())).await;
    assert_eq!(super::testing::lock(&log)[0].0, "during");
}

/// `pushNotice(text, tone)` of a hosted runtime: the polished text is a muted notice row of no
/// turn, shown live and published; the answer is the row id, `null` for a text with nothing left.
#[tokio::test(start_paused = true)]
async fn a_pushed_notice_shows_its_polished_text_as_a_row_of_no_turn() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;

    let id = call(&handle, "thread/pushNotice", json!({ "text": "✓ saved the file", "level": "warn" }), "n-1").await.expect("pushed");
    let id = id.as_str().expect("the row id").to_owned();
    let shown_of = |id: Value| {
        rig.feeds
            .frames(handle.id.as_str())
            .into_iter()
            .find(|(_, method, params)| method == "item/completed" && params["item"]["id"] == id)
            .map(|(_, _, params)| params)
    };
    let shown = eventually_on!(&[&rig.feeds.published], || shown_of(json!(id))).await;
    assert_eq!(shown["turnId"], "");
    // A notice is a status row of kind `notice`; its polished text and tone ride in the row's ext.
    assert_eq!((shown["item"]["type"].clone(), shown["item"]["kind"].clone()), (json!("statusRow"), json!("notice")));
    let row = shown["item"].to_string();
    assert!(row.contains("\"saved the file\"") && row.contains("\"warn\""), "{row}");
    // The notice is a record of the thread, which a reopen reads back where it stands.
    use mixdog_store::schema::record::Form;
    use mixdog_store::schema::record::Record;
    let stored = |record: &Record| matches!(record, Record::Item(row) if row.iid.as_str() == id && row.form == Form::Display && row.visible && !row.model);
    assert!(rig.store.records(&handle.id).iter().any(|(_, record)| stored(record)));

    // The tone defaults to `info`; a text that polishes to nothing shows no row.
    let second = call(&handle, "thread/pushNotice", json!({ "text": "plain" }), "n-2").await.expect("pushed");
    let last = eventually_on!(&[&rig.feeds.published], || shown_of(second.clone())).await;
    assert!(last["item"].to_string().contains("\"info\""), "{}", last["item"]);
    let before = rig.feeds.frames(handle.id.as_str()).len();
    assert_eq!(call(&handle, "thread/pushNotice", json!({ "text": "   " }), "n-3").await.expect("pushed"), Value::Null);
    assert_eq!(rig.feeds.frames(handle.id.as_str()).len(), before);
}

/// `clearSessionChangeHistory` (`integrations.mjs`): refused with Node's text while the session
/// runs a turn, else `{turns}` of the turn review.
#[tokio::test(start_paused = true)]
async fn the_change_history_is_cleared_only_while_the_session_runs_no_turn() {
    let rig = Rig::new();
    let gate = held(&rig);
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "work", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (!idle(&handle)).then_some(())).await;

    let refused = call(&handle, "thread/clearSessionChangeHistory", json!({}), "c-1").await.expect_err("a turn runs");
    let CoreError::DomainError { message, .. } = refused else { panic!("a plain error") };
    assert_eq!(message.as_deref(), Some("Change history cannot be deleted while this session is running a turn"));

    gate.notify_one();
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    assert_eq!(call(&handle, "thread/clearSessionChangeHistory", json!({}), "c-2").await.expect("cleared"), json!({ "turns": 0 }));
}

fn plain_error(error: CoreError) -> String {
    let CoreError::DomainError { message, .. } = error else { panic!("a plain error: {error:?}") };
    message.expect("a message").to_string()
}

fn reply(content: &str, tool_call: bool) -> Result<super::turn_ops::SideReply, super::turn_ops::SideFailure> {
    Ok(super::turn_ops::SideReply { content: content.into(), tool_call })
}

async fn preflight(directory: &SessionDirectory, params: Value) -> Value {
    match directory.request(request("thread/inheritancePreflight", params, "pf")).await.expect("preflight") {
        Reply::Value(value) => value,
        other => panic!("a value reply, got {other:?}"),
    }
}

/// With no source named the preflight falls back to the current session (`getSessionId()`); a thread with no session yet has
/// none, so Node names no source (`sourceSessionId: null`), and a thread that has its session names itself.
#[tokio::test(start_paused = true)]
async fn the_preflight_names_no_current_session_for_a_thread_without_one() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let header = |value: Value| value.as_object().cloned().expect("header");
    directory.create_with_id(mixdog_core_api::ids::ThreadId::from("sess_reserved"), header(json!({ "cwd": "/ws" })), json!({})).await.expect("create");
    directory
        .create_with_id(mixdog_core_api::ids::ThreadId::from("sess_seated"), header(json!({ "cwd": "/ws", "provider": "openai", "model": "gpt-5" })), json!({}))
        .await
        .expect("create");
    for (thread, source) in [("sess_reserved", Value::Null), ("sess_seated", json!("sess_seated"))] {
        let got = preflight(&directory, json!({ "threadId": thread })).await;
        assert_eq!(got["sourceSessionId"], source, "{thread}");
    }
}

fn user_rows(handle: &SessionHandle) -> usize {
    handle.cell.view.load_full().items.iter().filter(|item| matches!(item.as_ref(), mixdog_protocol::ThreadItem::UserMessage { .. })).count()
}

/// A context gauge that, once armed, holds each reading until it is let go.
#[derive(Default)]
struct HeldGauge {
    armed: std::sync::atomic::AtomicBool,
    asked: std::sync::atomic::AtomicUsize,
    called: tokio::sync::Notify,
    go: tokio::sync::Notify,
}

#[async_trait::async_trait]
impl super::thread_context::ContextStatusHost for HeldGauge {
    async fn context_status(&self, _: Option<mixdog_core_api::ids::ThreadId>, _: Option<Value>) -> Result<Value, CoreError> {
        if self.armed.load(std::sync::atomic::Ordering::SeqCst) {
            self.asked.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.called.notify_waiters();
            self.go.notified().await;
        }
        Ok(Value::Null)
    }
}

/// A compaction whose task panics still ends: its status cannot stay set.
#[tokio::test(start_paused = true)]
async fn a_compaction_that_panics_clears_its_command_status() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    rig.compaction.panics.store(true, std::sync::atomic::Ordering::SeqCst);
    let answered = call(&handle, "thread/compact/start", json!({}), "c-1").await;
    assert!(answered.is_err(), "the lost compaction answers no result: {answered:?}");
    let runtime = || handle.cell.view.load_full().state.runtime.clone();
    eventually_on!(&[&handle.cell.stepped], || runtime().filter(|runtime| !runtime.command_busy && runtime.command_status.is_none()).map(|_| ())).await;
    assert!(!handle.cell.compacting.load(std::sync::atomic::Ordering::SeqCst), "the compaction ended");
}

/// The failed `TurnEnd` of the newest `item/completed` frame of `thread` that carries one, as the feed sent it.
fn failed_end_frame(rig: &Rig, thread: &str) -> Option<mixdog_protocol::ThreadItem> {
    rig.feeds.frames(thread).into_iter().rev().find_map(|(_, method, params)| {
        (method == "item/completed" && params["item"]["type"] == "turnEnd").then(|| serde_json::from_value(params["item"].clone()).expect("a thread item"))
    })
}

/// A codec that refuses to encode an amend, as a store that cannot take the completion would.
struct RefusesAmends;

fn stop_now() -> Stop {
    Stop { turn: None, restore_prompt: None, submission_id: None, ctx: CallContext::internal("test") }
}

fn stop_ledger(handle: &SessionHandle) -> Vec<String> {
    handle.cell.stop_ledger.lock().unwrap().clone()
}

/// Stop before the dequeue: the drain is held by the core, nothing is under way, so the Stop is Node's idle reply and the queued
/// prompt is untouched and still runs once the hold opens ("a queued user prompt not part of the busy work still runs next").
#[tokio::test(start_paused = true)]
async fn a_stop_before_the_dequeue_leaves_the_queued_prompt_to_run() {
    use std::sync::atomic::Ordering::SeqCst;
    let rig = Rig::new();
    rig.set_script(super::tests::echo());
    let (hold, start_hold) = tokio::sync::watch::channel(super::StartHold::Held);
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.start_hold = start_hold;
    let directory = SessionDirectory::new(Arc::new(deps));
    let handle = start_thread(&directory).await;
    directory.finished(&handle.id, "shell", "job-1", "completed", "job-1 finished.".into()).await;
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.queued.load().len() == 1).then_some(())).await;
    let stopped = handle.stop(stop_now()).await.expect("stop");
    assert_eq!((&stopped["aborted"], &stopped["reason"]), (&json!(false), &Value::Null), "{stopped}");
    assert_eq!(handle.cell.queued.load().len(), 1, "nothing was cancelled");
    hold.send_replace(super::StartHold::Open);
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.queued.load().is_empty() && idle(&handle) && !handle.cell.busy.load(SeqCst)).then_some(())).await;
    assert_eq!(super::tests::runs_started(&rig, &handle.id), 1, "it ran after the hold opened");
}

/// The context's rows once one of them carries its turn's completion, woken by each store commit; the wait is registered
/// before the read so a commit between the read and the wait is not missed.
async fn rows_with_completion(rig: &Rig, context: &super::run::ModelContext) -> Vec<Value> {
    super::testing::awaiting(|| "a committed row carrying the turn's completion".to_owned(), async {
        loop {
            let committed = rig.store.committed.notified();
            tokio::pin!(committed);
            committed.as_mut().enable();
            let rows: Vec<Value> = context.read().await.expect("context").into_iter().map(|(_, message)| message).collect();
            if rows.iter().any(|message| message.pointer("/meta/transcript/completion").is_some()) {
                return rows;
            }
            committed.await;
        }
    })
    .await
}
/// `askSideQuestion` (`side-question.mjs`): Node's refusals, the `<side-question>` prompt, the
/// trimmed answer, and the tool-attempt and empty-answer texts.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_side_question_is_answered_from_the_saved_request_with_nodes_texts() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let ask = |q: &'static str, op: &'static str| call(&handle, "thread/askSide", json!({ "question": q }), op);

    assert_eq!(plain_error(ask("  \n", "a-1").await.expect_err("empty")), "Side question is empty.");
    assert_eq!(plain_error(ask("why?", "a-2").await.expect_err("no request")), "Send a message first, then try /btw.");
    assert_eq!(rig.side.begins.load(std::sync::atomic::Ordering::SeqCst), 0, "a missing request aborts nothing");

    rig.side.request.store(true, std::sync::atomic::Ordering::SeqCst);
    *super::testing::lock(&rig.side.reply) = Some(reply("  because.\n", false));
    assert_eq!(ask("  why?  ", "a-3").await.expect("answered"), json!({ "text": "because." }));
    let prompt = super::testing::lock(&rig.side.prompts)[0].clone();
    assert!(prompt.starts_with("<side-question>\nThe user is asking you a quick side question.") && prompt.ends_with("\n\nwhy?\n</side-question>"), "{prompt}");

    *super::testing::lock(&rig.side.reply) = Some(reply("x", true));
    assert_eq!(
        ask("q", "a-4").await.expect("answered")["text"],
        "The model tried to use a tool instead of answering. A side question cannot run tools; try asking it differently."
    );
    *super::testing::lock(&rig.side.reply) = Some(reply(" ", false));
    assert_eq!(ask("q", "a-5").await.expect("answered")["text"], "The model returned no answer.");
    *super::testing::lock(&rig.side.reply) = Some(Err(super::turn_ops::SideFailure::Failed("provider down".into())));
    assert_eq!(plain_error(ask("q", "a-6").await.expect_err("failed")), "provider down");
}
/// `cancelSide`: aborts the question in flight with `Side question canceled.`; a new question
/// aborts the previous one.
#[tokio::test(start_paused = true)]
async fn a_side_question_in_flight_is_canceled_by_cancel_side_or_a_newer_question() {
    let rig = Rig::new();
    rig.side.request.store(true, std::sync::atomic::Ordering::SeqCst);
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let begun = |n: usize| rig.side.begins.load(std::sync::atomic::Ordering::SeqCst) == n;

    let mut first = {
        let (handle, q) = (handle.clone(), json!({ "question": "one" }));
        tokio::spawn(async move { call(&handle, "thread/askSide", q, "s-1").await })
    };
    eventually_on_until!(&[&rig.side.began], || begun(1).then_some(()), &mut first).await;
    assert_eq!(call(&handle, "thread/cancelSide", json!({}), "s-2").await.expect("canceled"), Value::Null);
    assert_eq!(plain_error(first.await.expect("joined").expect_err("canceled")), "Side question canceled.");

    let mut second = {
        let (handle, q) = (handle.clone(), json!({ "question": "two" }));
        tokio::spawn(async move { call(&handle, "thread/askSide", q, "s-3").await })
    };
    eventually_on_until!(&[&rig.side.began], || (begun(2) && super::testing::lock(&rig.side.prompts).len() == 2).then_some(()), &mut second).await;
    *super::testing::lock(&rig.side.reply) = Some(reply("done", false));
    assert_eq!(call(&handle, "thread/askSide", json!({ "question": "three" }), "s-4").await.expect("answered"), json!({ "text": "done" }));
    assert_eq!(plain_error(second.await.expect("joined").expect_err("replaced")), "Side question canceled.");
}
#[tokio::test(start_paused = true)]
async fn a_manual_compaction_follows_the_session_ops_order() {
    let rig = Rig::new();
    let gate = held(&rig);
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "work", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (!idle(&handle)).then_some(())).await;
    let busy = call(&handle, "thread/compact/start", json!({ "options": { "requireReduction": true } }), "k-1").await.expect("answered");
    assert_eq!(busy, json!({ "changed": false, "reason": "compact skipped: turn in progress" }));
    let side = call(&handle, "thread/compact/start", json!({ "options": { "idleOnly": true } }), "k-1b").await.expect("answered");
    assert_eq!(side, json!({ "changed": false, "reason": "compact skipped: turn in progress" }));
    assert!(super::testing::lock(&rig.compaction.calls).is_empty(), "the engine is not reached");
    gate.notify_one();
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;

    *super::testing::lock(&rig.compaction.result) = Some(json!({ "skipped": true, "reason": "no reduction" }));
    let skipped = call(&handle, "thread/compact/start", json!({ "options": { "requireReduction": true } }), "k-2").await.expect("answered");
    assert_eq!(skipped, json!({ "skipped": true, "reason": "no reduction" }));
    assert_eq!(*super::testing::lock(&rig.compaction.calls), ["compact auto_clear true"]);
    assert!(!handle.cell.header.load().contains_key("pendingGoalReminder"), "a skip marks nothing");

    super::testing::lock(&rig.compaction.calls).clear();
    *super::testing::lock(&rig.compaction.result) = Some(json!({ "changed": true }));
    let done = call(&handle, "thread/compact/start", json!({ "options": { "recoverAgent": true } }), "k-3").await.expect("answered");
    assert_eq!(done, json!({ "changed": true }));
    assert_eq!(*super::testing::lock(&rig.compaction.calls), ["compact manual false", "post manual", "rearm", "recover", "invalidate"]);
    let pending = eventually_on!(&[&handle.cell.stepped], || handle.cell.header.load().get("pendingGoalReminder").cloned()).await;
    assert_eq!((pending["reason"].clone(), pending["revision"].clone()), (json!("compaction"), json!(1)));

    // No result at all is Node's `null`.
    *super::testing::lock(&rig.compaction.result) = None;
    assert_eq!(call(&handle, "thread/compact/start", json!({}), "k-4").await.expect("answered"), Value::Null);
}
/// A compaction a user asked for that changed nothing says so in the transcript; the idle auto-clear's does not.
#[tokio::test(start_paused = true)]
async fn a_requested_compaction_that_changed_nothing_tells_the_user() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let told = || {
        rig.feeds
            .frames(handle.id.as_str())
            .into_iter()
            .filter(|(_, method, params)| method == "item/completed" && params["item"].to_string().contains("Nothing to compact"))
            .count()
    };
    *super::testing::lock(&rig.compaction.result) = Some(json!({ "changed": false, "reason": "nothing to compact" }));
    call(&handle, "thread/compact/start", json!({ "options": { "requireReduction": true } }), "k-1").await.expect("answered");
    assert_eq!(told(), 0, "an auto-clear is silent");
    *super::testing::lock(&rig.compaction.result) = Some(json!({ "changed": false, "error": "the summary failed" }));
    call(&handle, "thread/compact/start", json!({}), "k-f").await.expect("answered");
    *super::testing::lock(&rig.compaction.result) = Some(json!({ "changed": false, "reason": "nothing to compact" }));
    call(&handle, "thread/compact/start", json!({}), "k-2").await.expect("answered");
    eventually_on!(&[&rig.feeds.published], || (told() >= 1).then_some(())).await;
    assert_eq!(told(), 1, "a compaction that failed is not told it had nothing to compact");
}
/// A user's `/compact` while a turn runs (`scheduleCompactForTurnEnd`): announced and answered `{changed: false, scheduled: true}`,
/// a repeat is told it already is; it runs once, as a manual compaction, after the turn and the follow-up queued behind it, not
/// between them.
#[tokio::test(start_paused = true)]
async fn a_users_compaction_asked_mid_turn_runs_once_after_the_turn_and_its_queued_follow_ups() {
    let rig = Rig::new();
    let gate = Arc::new(tokio::sync::Notify::new());
    // Each run's prompt, with the compaction calls made by the time it started.
    let started: Arc<std::sync::Mutex<Vec<(String, usize)>>> = Arc::default();
    rig.set_script(Arc::new({
        let (gate, started, compaction) = (gate.clone(), started.clone(), rig.compaction.clone());
        move |run| {
            let (gate, started, compaction) = (gate.clone(), started.clone(), compaction.clone());
            Box::pin(async move {
                run.port.input_durable().await.expect("input durable");
                let prompt = serde_json::to_value(&run.input.prompt).expect("prompt").as_str().unwrap_or_default().to_owned();
                let first = {
                    let mut started = super::testing::lock(&started);
                    started.push((prompt, super::testing::lock(&compaction.calls).len()));
                    started.len() == 1
                };
                if first {
                    gate.notified().await;
                }
                RunOutcome::Completed(Default::default())
            })
        }
    }));
    *super::testing::lock(&rig.compaction.result) = Some(json!({ "changed": true }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "work", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (!idle(&handle)).then_some(())).await;
    let scheduled = call(&handle, "thread/compact/start", json!({}), "c-1").await.expect("answered");
    assert_eq!(scheduled, json!({ "changed": false, "scheduled": true }));
    turn(&handle, "follow up", "op-2").await;
    let again = call(&handle, "thread/compact/start", json!({}), "c-2").await.expect("answered");
    assert_eq!(again, json!({ "changed": false, "scheduled": true }));
    let notices = |text: &str| {
        rig.feeds
            .frames(handle.id.as_str())
            .iter()
            .filter(|(_, method, params)| method == "item/completed" && params["item"].to_string().contains(text))
            .count()
    };
    assert_eq!(notices("Compact scheduled: runs when the current turn finishes"), 1);
    assert_eq!(notices("Compact already scheduled for turn end"), 1);
    assert!(super::testing::lock(&rig.compaction.calls).is_empty(), "nothing compacts while the turn runs");
    gate.notify_one();
    eventually_on!(&[&handle.cell.stepped], || {
        (super::testing::lock(&rig.compaction.calls).len() >= 4 && idle(&handle) && !handle.cell.compacting.load(std::sync::atomic::Ordering::SeqCst))
            .then_some(())
    })
    .await;
    assert_eq!(*super::testing::lock(&started), [("work".to_owned(), 0), ("follow up".to_owned(), 0)], "the follow-up ran before the compaction");
    // One manual compaction, with the agent recovery the command asks for (`compactCommand`: `{ recoverAgent: true }`).
    assert_eq!(
        *super::testing::lock(&rig.compaction.calls),
        ["compact manual false", "post manual", "rearm", "recover", "invalidate"],
        "one manual compaction"
    );
}

#[tokio::test(start_paused = true)]
async fn a_scheduled_compaction_runs_once_the_turn_settles_and_the_next_turn_waits_for_it() {
    let rig = Rig::new();
    let gate = held(&rig);
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "work", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (!idle(&handle)).then_some(())).await;
    call(&handle, "thread/compact/schedule", json!({}), "s-1").await.expect("scheduled");
    assert!(super::testing::lock(&rig.compaction.calls).is_empty(), "nothing compacts while the turn runs");

    let hold = Arc::new(tokio::sync::Notify::new());
    *super::testing::lock(&rig.compaction.hold) = Some(hold.clone());
    *super::testing::lock(&rig.compaction.result) = Some(json!({ "changed": true }));
    gate.notify_one();
    eventually_on!(&[&rig.compaction.called, &handle.cell.stepped], || (!super::testing::lock(&rig.compaction.calls).is_empty()).then_some(())).await;
    assert_eq!(*super::testing::lock(&rig.compaction.calls), ["compact manual false"]);

    // The turn is admitted at once (`submitToSession` answers while the compaction runs, as the
    // session-send-world recording shows) and queued behind the compaction's gate.
    let next = turn(&handle, "next", "op-2").await;
    assert_eq!(next["kind"], json!("queued"), "{next}");
    assert!(idle(&handle) && handle.cell.queued.load().len() == 1, "the next turn waits for the compaction");
    hold.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (!idle(&handle)).then_some(())).await;
    assert!(handle.cell.queued.load().is_empty(), "the next turn started once the compaction ended");
    assert_eq!(super::testing::lock(&rig.compaction.calls)[..2], ["compact manual false", "post manual"]);
    assert_eq!(super::testing::lock(&rig.compaction.calls).iter().filter(|call| call.starts_with("compact")).count(), 1, "it ran once");
    gate.notify_one();
}

#[tokio::test(start_paused = true)]
async fn a_held_desktop_model_change_compacts_between_turns() {
    use mixdog_core_ports::ports::route::PRE_SWITCH_COMPACTION;
    let rig = Rig::new();
    let gate = Arc::new(tokio::sync::Notify::new());
    let admitted = Arc::new(std::sync::Mutex::new(Vec::new()));
    let (open, seen) = (gate.clone(), admitted.clone());
    rig.set_script(Arc::new(move |run| {
        let (open, seen) = (open.clone(), seen.clone());
        super::testing::lock(&seen).push(run.header.get("pendingRoute").cloned());
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            open.notified().await;
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "first", "pre-switch-1").await;
    eventually_on!(&[&handle.cell.stepped], || (!idle(&handle)).then_some(())).await;
    handle
        .request(CoreRequest {
            method: Method("thread/header/patch"),
            params: json!({ "threadId": handle.id, "set": {
                "provider": "old-provider",
                "model": "old-model",
                "pendingRoute": { "provider": "new-provider", "model": "new-model", (PRE_SWITCH_COMPACTION): true },
            }}),
            op: None,
            ctx: CallContext::internal("test"),
        })
        .await
        .expect("the pick was held");
    assert!(super::testing::lock(&rig.compaction.calls).is_empty(), "the active turn was left alone");
    let compact = Arc::new(tokio::sync::Notify::new());
    *super::testing::lock(&rig.compaction.hold) = Some(compact.clone());
    *super::testing::lock(&rig.compaction.result) = Some(json!({ "skipped": true }));
    gate.notify_one();
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    let next = {
        let handle = handle.clone();
        tokio::spawn(async move { turn(&handle, "next", "pre-switch-2").await })
    };
    eventually_on!(&[&rig.compaction.called, &handle.cell.stepped], || (!super::testing::lock(&rig.compaction.calls).is_empty()).then_some(())).await;
    assert!(!next.is_finished(), "the next turn waits for the old-route compaction");
    assert_eq!(handle.header_snapshot()["model"], json!("old-model"));
    let later = json!({ "provider": "new-provider", "model": "later-model", (PRE_SWITCH_COMPACTION): true });
    handle
        .request(CoreRequest {
            method: Method("thread/header/patch"),
            params: json!({ "threadId": handle.id, "set": { "pendingRoute": later } }),
            op: None,
            ctx: CallContext::internal("test"),
        })
        .await
        .expect("a later pick is held while compaction runs");
    compact.notify_one();
    next.await.expect("the next turn proceeds even when no compaction was applied");
    assert_eq!(super::testing::lock(&admitted)[1].as_ref().unwrap()["model"], "new-model");
    assert_eq!(handle.header_snapshot()["pendingRoute"], later);
    gate.notify_one();
}
/// A prompt queued behind the turn and prioritised while the scheduled compaction runs
/// (`prioritizeQueued` kicks a drain) waits for the compaction like any ask (`afterCompaction`
/// wraps `runner.ask`); it starts once the compaction ended.
#[tokio::test(start_paused = true)]
async fn a_prioritised_queued_prompt_waits_for_the_scheduled_compaction() {
    let rig = Rig::new();
    let gate = held(&rig);
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "work", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (!idle(&handle)).then_some(())).await;
    call(&handle, "thread/compact/schedule", json!({}), "s-1").await.expect("scheduled");
    let answer = turn(&handle, "queued", "op-2").await;
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.queued.load().len() == 1).then_some(())).await;
    let qid = handle.cell.queue.load()[0].qid.clone();
    assert_eq!(answer["queuedId"].as_str(), Some(qid.as_str()), "the prompt is the queued entry");

    let hold = Arc::new(tokio::sync::Notify::new());
    *super::testing::lock(&rig.compaction.hold) = Some(hold.clone());
    *super::testing::lock(&rig.compaction.result) = Some(json!({ "changed": true }));
    gate.notify_one();
    eventually_on!(&[&rig.compaction.called, &handle.cell.stepped], || (!super::testing::lock(&rig.compaction.calls).is_empty()).then_some(())).await;

    let holds = handle.cell.gate_holds.load(std::sync::atomic::Ordering::SeqCst);
    handle.cell.steer(None, mixdog_core_api::ids::QueuedId::from(qid.as_str())).expect("prioritised");
    // The prioritising drain consulted the compaction's gate and was held.
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.gate_holds.load(std::sync::atomic::Ordering::SeqCst) > holds).then_some(())).await;
    assert!(idle(&handle) && handle.cell.queued.load().len() == 1, "the prioritised prompt waits for the compaction");
    hold.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (!idle(&handle)).then_some(())).await;
    assert!(handle.cell.queued.load().is_empty(), "it started once the compaction ended");
    gate.notify_one();
}
#[tokio::test(start_paused = true)]
async fn a_task_report_under_the_compactions_gate_waits_and_is_not_lost() {
    use mixdog_agent::agent_tool::flow::seams::OwnerNotify;
    use std::sync::atomic::Ordering::SeqCst;
    let rig = Rig::new();
    let gate = held(&rig);
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    let handle = start_thread(&directory).await;
    turn(&handle, "work", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (!idle(&handle)).then_some(())).await;
    call(&handle, "thread/compact/schedule", json!({}), "s-1").await.expect("scheduled");
    let hold = Arc::new(tokio::sync::Notify::new());
    *super::testing::lock(&rig.compaction.hold) = Some(hold.clone());
    *super::testing::lock(&rig.compaction.result) = Some(json!({ "changed": true }));
    gate.notify_one();
    eventually_on!(&[&rig.compaction.called, &handle.cell.stepped], || (!super::testing::lock(&rig.compaction.calls).is_empty() && idle(&handle))
        .then_some(()))
    .await;

    let holds = handle.cell.gate_holds.load(SeqCst);
    let report = "<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n<summary>Agent \"rev\" completed</summary>\n<result>\nall done\n</result>\n</task-notification>";
    let meta = json!({ "execution_surface": "agent", "execution_id": "t1", "status": "completed" });
    assert!(
        super::agent_registry::flow::SessionCompletions::new(directory.clone()).notify(handle.id.as_str(), report, &meta),
        "the live session takes the report"
    );
    // The report's wake consulted the compaction's gate and was held.
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.gate_holds.load(SeqCst) > holds).then_some(())).await;
    assert!(idle(&handle) && handle.cell.queued.load().len() == 1, "the report is queued and starts no turn");
    hold.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (!idle(&handle)).then_some(())).await;
    assert!(handle.cell.queued.load().is_empty(), "the report's turn took it once the compaction ended");
    gate.notify_one();
}
#[tokio::test(start_paused = true)]
async fn callers_held_by_a_running_compaction_are_answered_when_the_session_is_deleted() {
    use std::sync::atomic::Ordering::SeqCst;
    let rig = Rig::new();
    rig.store.listed.store(true, SeqCst);
    let gate = held(&rig);
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "work", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (!idle(&handle)).then_some(())).await;
    call(&handle, "thread/compact/schedule", json!({}), "s-1").await.expect("scheduled");
    let hold = Arc::new(tokio::sync::Notify::new());
    *super::testing::lock(&rig.compaction.hold) = Some(hold.clone());
    gate.notify_one();
    eventually_on!(&[&rig.compaction.called, &handle.cell.stepped], || (!super::testing::lock(&rig.compaction.calls).is_empty() && idle(&handle))
        .then_some(()))
    .await;

    let queued = call(&handle, "turn/start", json!({ "input": { "prompt": "next" } }), "h-1").await.expect("admitted");
    assert_eq!(queued["kind"], json!("queued"), "a turn is queued behind the gate, not held: {queued}");
    let mut held_calls = Vec::new();
    for (method, params, op) in [("thread/clear", json!({}), "h-2"), ("thread/compact/start", json!({}), "h-3")] {
        let holds = handle.cell.gate_holds.load(SeqCst);
        let caller = handle.clone();
        held_calls.push((method, tokio::spawn(async move { call(&caller, method, params, op).await })));
        eventually_on!(&[&handle.cell.stepped], || (handle.cell.gate_holds.load(SeqCst) > holds).then_some(())).await;
    }
    let deleted = handle.request(request("thread/delete", json!({ "threadId": handle.id, "opId": "op-del" }), "op-del")).await.expect("thread/delete");
    assert!(matches!(deleted, Reply::Value(Value::Bool(true))), "the delete is not held by the compaction: {deleted:?}");
    for (method, held) in held_calls {
        let answer = super::testing::awaiting(|| format!("the {method} the gate held to be answered after the delete"), held).await.expect("joined");
        assert!(matches!(&answer, Err(CoreError::ThreadClosing { .. })), "{method}: the deleted session is closed to it: {answer:?}");
    }
}
/// A person's clear sent while the scheduled compaction holds the thread waits for it (`clear: afterCompaction(session.clear)`), then
/// keeps the resumable copy of the conversation the compaction left (`forkOutgoingTranscript` reads the session after the wait) and
/// clears the thread: the copy is not lost to the wait.
#[tokio::test(start_paused = true)]
async fn a_clear_waiting_for_the_scheduled_compaction_keeps_the_copy_of_what_it_left() {
    use std::sync::atomic::Ordering::SeqCst;
    let rig = Rig::new();
    rig.store.listed.store(true, SeqCst);
    let gate = held(&rig);
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "work", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (!idle(&handle)).then_some(())).await;
    call(&handle, "thread/compact/schedule", json!({}), "s-1").await.expect("scheduled");
    let hold = Arc::new(tokio::sync::Notify::new());
    *super::testing::lock(&rig.compaction.hold) = Some(hold.clone());
    gate.notify_one();
    eventually_on!(&[&rig.compaction.called, &handle.cell.stepped], || (!super::testing::lock(&rig.compaction.calls).is_empty() && idle(&handle))
        .then_some(()))
    .await;
    eventually_on!(&[&handle.cell.stepped], || handle.cell.gated.load(SeqCst).then_some(())).await;
    let ids = || -> std::collections::BTreeSet<String> { rig.store.log_ids().iter().map(|id| id.as_str().to_owned()).collect() };
    let before = ids();

    let clearing = {
        let handle = handle.clone();
        tokio::spawn(async move { call(&handle, "thread/clear", json!({}), "c-1").await })
    };
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
    assert!(!clearing.is_finished(), "the clear waits for the compaction");
    assert_eq!(ids(), before, "no copy is made while the compaction runs");

    hold.notify_one();
    let answered = super::testing::awaiting(|| "the clear to be answered after the compaction".to_owned(), clearing).await.expect("joined");
    answered.expect("the clear runs once the compaction ended");
    eventually_on!(&[&handle.cell.stepped], || super::tests::rows(&handle).is_empty().then_some(())).await;
    let copies: Vec<String> = ids().difference(&before).cloned().collect();
    let [copy] = copies.as_slice() else { panic!("one copy of the conversation the compaction left: {copies:?}") };
    let read = CoreRequest {
        method: Method("thread/modelMessages/list"),
        params: json!({ "threadId": copy, "start": 0 }),
        op: None,
        ctx: CallContext::internal("test"),
    };
    let Reply::Value(listed) = directory.request(read).await.expect("the copy's conversation") else { panic!("a value") };
    let said: Vec<&str> =
        listed["messages"].as_array().expect("messages").iter().filter(|m| m["role"] == "user").filter_map(|m| m["content"].as_str()).collect();
    assert!(said.contains(&"work"), "the copy holds what was said: {listed}");
}
/// A thread whose scheduled compaction runs (held by the returned signal) after a first turn "work", with its runs logged
/// (`logged`): the point from which a person's clear waits at the gate.
async fn compacting_after_work(
    rig: &Rig,
    directory: &SessionDirectory,
) -> (Arc<SessionHandle>, Arc<tokio::sync::Notify>, Arc<std::sync::Mutex<Vec<(String, Option<String>)>>>) {
    use std::sync::atomic::Ordering::SeqCst;
    rig.store.listed.store(true, SeqCst);
    let (gate, log) = logged(rig);
    let handle = start_thread(directory).await;
    turn(&handle, "work", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (!idle(&handle)).then_some(())).await;
    call(&handle, "thread/compact/schedule", json!({}), "s-1").await.expect("scheduled");
    let hold = Arc::new(tokio::sync::Notify::new());
    *super::testing::lock(&rig.compaction.hold) = Some(hold.clone());
    gate.notify_one();
    eventually_on!(&[&rig.compaction.called, &handle.cell.stepped], || (!super::testing::lock(&rig.compaction.calls).is_empty() && idle(&handle))
        .then_some(()))
    .await;
    eventually_on!(&[&handle.cell.stepped], || handle.cell.gated.load(SeqCst).then_some(())).await;
    (handle, hold, log)
}

/// A clear a gate released, a prompt queued behind it: the clear completes first (its copy holds the conversation, the thread is
/// emptied) and only then the queued prompt's turn starts, on the emptied thread.
#[tokio::test(start_paused = true)]
async fn a_prompt_queued_behind_a_gated_clear_runs_after_the_clear_on_the_emptied_thread() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let (handle, hold, log) = compacting_after_work(&rig, &directory).await;
    let ids = || -> std::collections::BTreeSet<String> { rig.store.log_ids().iter().map(|id| id.as_str().to_owned()).collect() };
    let before = ids();

    let clearing = {
        let handle = handle.clone();
        tokio::spawn(async move { call(&handle, "thread/clear", json!({}), "c-1").await })
    };
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
    assert!(!clearing.is_finished(), "the clear waits for the compaction");
    let queued = turn(&handle, "after", "op-2").await;
    assert_eq!(queued["kind"], "queued", "{queued}");

    hold.notify_one();
    super::testing::awaiting(|| "the clear to be answered after the compaction".to_owned(), clearing).await.expect("joined").expect("the clear ran");
    eventually_on!(&[&handle.cell.stepped], || (super::testing::lock(&log).len() == 2 && idle(&handle) && handle.cell.queued.load().is_empty()).then_some(()))
        .await;
    assert_eq!(super::testing::lock(&log)[1].0, "after", "the queued prompt's turn started after the clear");

    // The copy holds the conversation the clear took, and not the prompt that ran after it.
    let copies: Vec<String> = ids().difference(&before).cloned().collect();
    let [copy] = copies.as_slice() else { panic!("one copy of the cleared conversation: {copies:?}") };
    let read = CoreRequest {
        method: Method("thread/modelMessages/list"),
        params: json!({ "threadId": copy, "start": 0 }),
        op: None,
        ctx: CallContext::internal("test"),
    };
    let Reply::Value(listed) = directory.request(read).await.expect("the copy's conversation") else { panic!("a value") };
    let said: Vec<&str> =
        listed["messages"].as_array().expect("messages").iter().filter(|m| m["role"] == "user").filter_map(|m| m["content"].as_str()).collect();
    assert_eq!(said, ["work"], "the copy holds what was said before the clear: {listed}");
    // The thread was emptied before that turn: only its prompt is on it.
    let users: Vec<String> = super::tests::rows(&handle).into_iter().filter(|(role, _)| *role == "user").map(|(_, text)| text).collect();
    assert_eq!(users, ["after"], "the turn ran on the emptied thread");
}

/// A clear the caller cancels after the gate released its plan leaves no hold on the thread's turns: the prompt queued behind
/// it still starts.
#[tokio::test(start_paused = true)]
async fn a_gated_clear_cancelled_after_its_plan_was_released_does_not_hold_the_threads_turns() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let (handle, hold, log) = compacting_after_work(&rig, &directory).await;
    let cancel = CancellationToken::new();
    let clearing = {
        let (handle, cancel) = (handle.clone(), cancel.clone());
        tokio::spawn(async move {
            let params = json!({ "threadId": handle.id, "opId": "c-1" });
            let ctx = CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, cancel);
            handle.request(CoreRequest { method: Method("thread/clear"), params, op: Some(OpId::from("c-1")), ctx }).await
        })
    };
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
    assert!(!clearing.is_finished(), "the clear waits for the compaction");
    let queued = turn(&handle, "after", "op-2").await;
    assert_eq!(queued["kind"], "queued", "{queued}");
    // Another submit holds the submit order, so the released clear stops there, after its plan and before any change.
    let order = handle.submits.enter(&CancellationToken::new()).await.expect("the submit order");
    hold.notify_one();
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
    assert!(!clearing.is_finished(), "the clear waits for the submit order");
    assert_eq!(super::testing::lock(&log).len(), 1, "the queued prompt waits behind the released clear");

    cancel.cancel();
    let answer = super::testing::awaiting(|| "the cancelled clear to be answered".to_owned(), clearing).await.expect("joined");
    assert!(answer.is_err(), "the cancelled clear is not applied: {answer:?}");
    drop(order);
    eventually_on!(&[&handle.cell.stepped], || (super::testing::lock(&log).len() == 2 && idle(&handle)).then_some(())).await;
    assert_eq!(super::testing::lock(&log)[1].0, "after", "the queued prompt started once the cancelled clear ended");
}
#[tokio::test(start_paused = true)]
async fn a_stop_while_the_compaction_holds_a_prompt_hands_it_back_and_it_never_runs() {
    use std::sync::atomic::Ordering::SeqCst;
    let rig = Rig::new();
    rig.store.listed.store(true, SeqCst);
    let gate = held(&rig);
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "work", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (!idle(&handle)).then_some(())).await;
    call(&handle, "thread/compact/schedule", json!({}), "s-1").await.expect("scheduled");
    let hold = Arc::new(tokio::sync::Notify::new());
    *super::testing::lock(&rig.compaction.hold) = Some(hold.clone());
    gate.notify_one();
    eventually_on!(&[&rig.compaction.called, &handle.cell.stepped], || (!super::testing::lock(&rig.compaction.calls).is_empty() && idle(&handle))
        .then_some(()))
    .await;

    let input = json!({ "input": { "prompt": "next", "options": { "clientSubmissionId": "window-7" } } });
    let queued = call(&handle, "turn/start", input, "h-1").await.expect("admitted");
    assert_eq!(queued["kind"], json!("queued"), "{queued}");
    eventually_on!(&[&handle.cell.stepped], || handle.cell.gated.load(SeqCst).then_some(())).await;
    let stopped = handle.stop(Stop { turn: None, restore_prompt: None, submission_id: None, ctx: CallContext::internal("test") }).await.expect("stop");
    assert_eq!(
        (&stopped["aborted"], &stopped["restoreText"], &stopped["restoredSubmissionIds"]),
        (&json!(false), &json!("next"), &json!(["window-7"])),
        "{stopped}"
    );
    // The reply came after the Stop's record was durable: the submission is terminal on disk, its queue copy gone.
    let header = rig.store.stored_header(&handle.id).expect("header");
    let sid = mixdog_store::work_stops::stopped(&header, &mixdog_store::work_stops::submission("window-7")).expect("the handed-back prompt is stopped on disk");
    assert!(handle.cell.queued.load().is_empty(), "the handed-back prompt left the queue");
    let ledger = || handle.cell.stop_ledger.lock().unwrap().clone();
    assert!(ledger().contains(&format!("stop:durable:{sid}")), "{:?}", ledger());
    let passes = handle.cell.drain_passes.load(SeqCst);
    hold.notify_one();
    // Fence: the compaction ended and the drain after it decided its next start (none).
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.drain_passes.load(SeqCst) > passes
        && !handle.cell.gated.load(SeqCst)
        && idle(&handle)
        && !handle.cell.busy.load(SeqCst))
    .then_some(()))
    .await;
    assert!(idle(&handle) && handle.cell.queued.load().is_empty(), "the handed-back prompt never runs");
    // The reply carried it to the canceller: nothing more is owed.
    eventually_on!(&[&handle.cell.stepped], || mixdog_store::work_stops::owed(&rig.store.stored_header(&handle.id)?).is_empty().then_some(())).await;
    gate.notify_one();
}
/// The session tool's `compact` (`workspace-tools.mjs:268`, `turn-settle.mjs:118`): the request only
/// marks the thread while its turn runs; the turn's completion runs one manual compaction.
#[tokio::test(start_paused = true)]
async fn a_scheduled_compaction_runs_once_the_turn_completes() {
    let rig = Rig::new();
    let gate = held(&rig);
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "work", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (!idle(&handle)).then_some(())).await;
    *super::testing::lock(&rig.compaction.result) = Some(json!({ "changed": true }));
    let scheduled = call(&handle, "thread/compact/start", json!({ "options": { "afterTurn": true } }), "k-1").await.expect("answered");
    assert_eq!(scheduled, Value::Null);
    assert!(super::testing::lock(&rig.compaction.calls).is_empty(), "nothing runs while the turn does");
    gate.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (super::testing::lock(&rig.compaction.calls).len() >= 4).then_some(())).await;
    assert_eq!(*super::testing::lock(&rig.compaction.calls), ["compact manual false", "post manual", "rearm", "invalidate"]);
}
#[tokio::test(start_paused = true)]
async fn a_failed_turn_is_retried_once_with_its_prompt_and_its_resume_entry_finished() {
    let rig = Rig::new();
    type Seen = Arc<std::sync::Mutex<Vec<(String, Option<bool>)>>>;
    let seen: Seen = Arc::default();
    let log = seen.clone();
    rig.set_script(Arc::new(move |run| {
        let log = log.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let retry = run.input.options.as_ref().and_then(|options| options.retry_failed_turn);
            let first = {
                let mut seen = super::testing::lock(&log);
                seen.push((format!("{:?}", run.input.prompt), retry));
                seen.len() == 1
            };
            if !first {
                return RunOutcome::Completed(Default::default());
            }
            RunOutcome::Failed(super::testing::quota_error(5000))
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_routed_thread(&directory).await;
    turn(&handle, "write the report", "op-1").await;
    let id = handle.id.as_str().to_owned();
    let entry = eventually_on!(&[&rig.quota_changed, &handle.cell.stepped], || rig.quota.entry(&id)).await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    let key = entry.turn_key.clone();

    assert_eq!(call(&handle, "turn/retryFailed", json!({ "turnKey": "attempt:other" }), "r-1").await.expect("answered"), json!(false));
    assert_eq!(call(&handle, "turn/retryFailed", json!({ "turnKey": "" }), "r-2").await.expect("answered"), json!(false));
    assert_eq!(super::testing::lock(&seen).len(), 1, "a refusal starts no turn");

    retry_when_settled(&handle, &key, "r-3").await;
    eventually_on!(&[&handle.cell.stepped], || (super::testing::lock(&seen).len() == 2).then_some(())).await;
    assert_eq!(super::testing::lock(&seen)[1].1, Some(true), "the retry turn carries retryFailedTurn");
    assert!(super::testing::lock(&seen)[1].0.contains("write the report"), "the failed prompt is replayed");
    eventually_on!(&[&rig.quota_changed, &handle.cell.stepped], || rig.quota.entry(&id).is_none().then_some(())).await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    assert_eq!(
        call(&handle, "turn/retryFailed", json!({ "turnKey": key }), "r-4").await.expect("answered"),
        json!(false),
        "the retry's own turn is now the latest"
    );
}
async fn quota_failed_thread(
    rig: &Rig,
    with_message: bool,
) -> (Arc<SessionHandle>, String, Arc<std::sync::Mutex<Vec<Option<mixdog_protocol::thread::SubmitOptions>>>>) {
    use super::ItemCommit;
    use mixdog_core_api::ids::ItemId;

    let seen: Arc<std::sync::Mutex<Vec<Option<mixdog_protocol::thread::SubmitOptions>>>> = Arc::default();
    let log = seen.clone();
    rig.set_script(Arc::new(move |run| {
        let log = log.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let first = {
                let mut seen = super::testing::lock(&log);
                seen.push(run.input.options.clone());
                seen.len() == 1
            };
            if !first {
                return RunOutcome::Completed(Default::default());
            }
            if with_message {
                let body = json!({ "role": "user", "content": "go on", "meta": { "transcript": { "messageId": "m1" } } });
                run.port
                    .commit_item(ItemCommit { iid: ItemId::from("m1-row"), role: Some("user".into()), model: true, visible: false, body, prompt: None })
                    .await
                    .expect("commit");
            }
            RunOutcome::Failed(super::testing::quota_error(5000))
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_routed_thread(&directory).await;
    turn(&handle, "write the report", "op-1").await;
    let id = handle.id.as_str().to_owned();
    let entry = eventually_on!(&[&rig.quota_changed, &handle.cell.stepped], || rig.quota.entry(&id)).await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    (handle, entry.turn_key, seen)
}
#[tokio::test(start_paused = true)]
async fn a_retained_failed_message_is_resent_hidden_with_its_id_and_attempt() {
    let rig = Rig::new();
    let (handle, key, seen) = quota_failed_thread(&rig, true).await;
    let shown = user_rows(&handle);
    let recorded = rig
        .store
        .records(&handle.id)
        .iter()
        .rev()
        .find_map(|(_, record)| match record {
            mixdog_store::schema::record::Record::Amend(amend) => match &amend.body {
                mixdog_store::schema::blob::Slot::Inline(body) => {
                    body.pointer("/meta/transcript/completion/attemptId").and_then(Value::as_str).map(str::to_owned)
                }
                _ => None,
            },
            _ => None,
        })
        .expect("the failed turn's completion is recorded on its last message");
    retry_when_settled(&handle, &key, "r-1a").await;
    eventually_on!(&[&handle.cell.stepped], || (super::testing::lock(&seen).len() == 2).then_some(())).await;
    let options = super::testing::lock(&seen)[1].clone().expect("retry options");
    assert_eq!((options.retry_failed_turn, options.retry_turn_id, options.retry_attempt_id), (Some(true), Some("m1".into()), Some(recorded)));
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    assert_eq!(user_rows(&handle), shown, "the resent message paints no second row");
    eventually_on!(&[&rig.quota_changed, &handle.cell.stepped], || rig.quota.entry(handle.id.as_str()).is_none().then_some(())).await;
}
/// A compaction, manual or the idle auto-clear, publishes `commandBusy` and a `commandStatus` whose `startedAt` is when it began
/// (`withCommandStatus`, `performAutoClear`), which the working indicator counts from; both end with the compaction.
#[tokio::test(start_paused = true)]
async fn a_running_compaction_publishes_its_command_status_from_its_start() {
    for (options, verb, mode) in [
        (json!({}), "Compacting conversation", "compacting"),
        (json!({ "options": { "requireReduction": true } }), "Auto-clearing idle conversation", "auto-clear"),
    ] {
        let rig = Rig::new();
        let directory = SessionDirectory::new(rig.deps());
        let handle = start_thread(&directory).await;
        let hold = Arc::new(tokio::sync::Notify::new());
        *super::testing::lock(&rig.compaction.hold) = Some(hold.clone());
        let mut compacting = {
            let handle = handle.clone();
            tokio::spawn(async move { call(&handle, "thread/compact/start", options, "c-1").await })
        };
        let runtime = || handle.cell.view.load_full().state.runtime.clone();
        let shown = eventually_on_until!(&[&handle.cell.stepped], || runtime().filter(|runtime| runtime.command_busy), &mut compacting).await;
        let status = shown.command_status.expect("a running compaction shows its status");
        assert_eq!((status["active"].clone(), status["verb"].clone(), status["mode"].clone()), (json!(true), json!(verb), json!(mode)));
        let started = status["startedAt"].as_i64().expect("the start, epoch ms");
        mixdog_rt::time::sleep(std::time::Duration::from_secs(5)).await;
        assert_eq!(runtime().and_then(|runtime| runtime.command_status).expect("still running")["startedAt"], json!(started), "the clock does not restart");
        hold.notify_one();
        compacting.await.expect("joined").expect("compacted");
        eventually_on!(&[&handle.cell.stepped], || runtime().filter(|runtime| !runtime.command_busy && runtime.command_status.is_none()).map(|_| ())).await;
    }
}
/// The idle auto-clear's status belongs to the wait that blocks the turn (`performAutoClear`'s `finally`): once the wait gives
/// up at its bound and the turn goes on, `commandBusy` and `commandStatus` are released while the slow compaction still runs.
#[tokio::test(start_paused = true)]
async fn an_auto_clear_that_outlasts_its_wait_releases_the_command_status_when_the_turn_goes_on() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    // The thread has history before the clear is armed: a zero window would clear the first turn's own start too.
    turn(&handle, "first", "op-0").await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    *super::testing::lock(&rig.compaction.route) = mixdog_app_protocol::v2::thread::ThreadRoute {
        auto_clear: Some(json!({ "enabled": true, "idleMs": 0, "minContextPercent": 0 })),
        ..Default::default()
    };
    let hold = Arc::new(tokio::sync::Notify::new());
    *super::testing::lock(&rig.compaction.hold) = Some(hold.clone());
    turn(&handle, "work", "op-1").await;
    // The paused clock runs on to the wait's bound whenever the session is idle, so the status is read from the feed, in order.
    let published = || -> Vec<Value> {
        let runtimes = rig.feeds.frames(handle.id.as_str()).into_iter().filter(|(_, method, _)| method == "thread/runtime/updated");
        runtimes.map(|(_, _, params)| params["value"].clone()).skip_while(|value| value["commandBusy"] != json!(true)).collect()
    };
    eventually_on!(&[&handle.cell.stepped], || (published().len() >= 2).then_some(())).await;
    let frames = published();
    let status = &frames[0]["commandStatus"];
    assert_eq!((status["mode"].clone(), status["verb"].clone()), (json!("auto-clear"), json!("Auto-clearing idle conversation")));
    assert!(status["startedAt"].as_i64().is_some_and(|at| at > 0));
    assert_eq!((frames[1]["commandBusy"].clone(), frames[1]["commandStatus"].clone()), (json!(false), Value::Null), "the wait gave up and released the status");
    assert!(handle.cell.compacting.load(std::sync::atomic::Ordering::SeqCst), "the compaction itself runs on");
    assert_eq!(*super::testing::lock(&rig.compaction.calls), ["compact auto_clear true"], "it is still parked in the engine");
    *super::testing::lock(&rig.compaction.hold) = None;
    hold.notify_one();
}
/// A manual compaction admitted while the idle clear's meter is read owns the status: the clear does not run beside it (its
/// compaction would be a second owner of the one status), and the manual one's status stays until its own end.
#[tokio::test(start_paused = true)]
async fn a_manual_compaction_admitted_during_the_idle_clears_meter_read_keeps_the_status_and_no_clear_runs() {
    use std::sync::atomic::Ordering::SeqCst;
    let rig = Rig::new();
    let gauge = Arc::new(HeldGauge::default());
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.context_status = gauge.clone();
    let directory = SessionDirectory::new(Arc::new(deps));
    let handle = start_thread(&directory).await;
    turn(&handle, "first", "op-0").await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    *super::testing::lock(&rig.compaction.route) = mixdog_app_protocol::v2::thread::ThreadRoute {
        auto_clear: Some(json!({ "enabled": true, "idleMs": 0, "minContextPercent": 0 })),
        ..Default::default()
    };
    gauge.armed.store(true, SeqCst);
    // The start waits on the meter, and so does its answer.
    let starting = {
        let handle = handle.clone();
        tokio::spawn(async move { turn(&handle, "work", "op-1").await })
    };
    eventually_on!(&[&gauge.called], || (gauge.asked.load(SeqCst) > 0).then_some(())).await;

    let hold = Arc::new(tokio::sync::Notify::new());
    *super::testing::lock(&rig.compaction.hold) = Some(hold.clone());
    let mut manual = {
        let handle = handle.clone();
        tokio::spawn(async move { call(&handle, "thread/compact/start", json!({}), "m-1").await })
    };
    eventually_on_until!(&[&rig.compaction.called], || (!super::testing::lock(&rig.compaction.calls).is_empty()).then_some(()), &mut manual).await;
    gauge.armed.store(false, SeqCst);
    gauge.go.notify_one();
    starting.await.expect("joined");
    let completed = || rig.feeds.frames(handle.id.as_str()).iter().filter(|(_, method, _)| method == "turn/completed").count();
    eventually_on!(&[&handle.cell.stepped], || (completed() == 2).then_some(())).await;

    assert_eq!(*super::testing::lock(&rig.compaction.calls), ["compact manual false"], "no clear ran beside the manual compaction");
    let runtime = handle.cell.view.load_full().state.runtime.clone().expect("a runtime");
    assert_eq!((runtime.command_busy, runtime.command_status.map(|status| status["mode"].clone())), (true, Some(json!("compacting"))), "its status stands");
    *super::testing::lock(&rig.compaction.hold) = None;
    hold.notify_one();
    manual.await.expect("joined").expect("compacted");
    let runtime = || handle.cell.view.load_full().state.runtime.clone();
    eventually_on!(&[&handle.cell.stepped], || runtime().filter(|runtime| !runtime.command_busy && runtime.command_status.is_none()).map(|_| ())).await;
}
/// `retryBlocked`: a compaction running owns the session first (`commandBusy` /
/// `autoClearRunning`); the retry is refused and runs once the compaction ended.
#[tokio::test(start_paused = true)]
async fn a_retry_waits_for_a_running_compaction() {
    let rig = Rig::new();
    let (handle, key, seen) = quota_failed_thread(&rig, false).await;
    let hold = Arc::new(tokio::sync::Notify::new());
    *super::testing::lock(&rig.compaction.hold) = Some(hold.clone());
    let mut compacting = {
        let handle = handle.clone();
        tokio::spawn(async move { call(&handle, "thread/compact/start", json!({}), "c-1").await })
    };
    eventually_on_until!(&[&rig.compaction.called], || (!super::testing::lock(&rig.compaction.calls).is_empty()).then_some(()), &mut compacting).await;
    assert_eq!(call(&handle, "turn/retryFailed", json!({ "turnKey": key }), "r-1").await.expect("answered"), json!(false));
    hold.notify_one();
    compacting.await.expect("joined").expect("compacted");
    assert_eq!(super::testing::lock(&seen).len(), 1, "the refused retry started nothing");
    retry_when_settled(&handle, &key, "r-2c").await;
    eventually_on!(&[&handle.cell.stepped], || (super::testing::lock(&seen).len() == 2).then_some(())).await;
}
#[tokio::test(start_paused = true)]
async fn a_retry_waits_on_the_scheduled_compactions_gate() {
    use std::sync::atomic::Ordering::SeqCst;
    let rig = Rig::new();
    let gate = Arc::new(tokio::sync::Notify::new());
    let seen: Arc<std::sync::Mutex<Vec<Option<bool>>>> = Arc::default();
    let (open, log) = (gate.clone(), seen.clone());
    rig.set_script(Arc::new(move |run| {
        let (open, log) = (open.clone(), log.clone());
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let first = {
                let mut seen = super::testing::lock(&log);
                seen.push(run.input.options.as_ref().and_then(|options| options.retry_failed_turn));
                seen.len() == 1
            };
            if !first {
                return RunOutcome::Completed(Default::default());
            }
            open.notified().await;
            RunOutcome::Failed(super::testing::quota_error(5000))
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_routed_thread(&directory).await;
    turn(&handle, "write the report", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (!idle(&handle)).then_some(())).await;
    call(&handle, "thread/compact/schedule", json!({}), "s-1").await.expect("scheduled");
    assert_eq!(
        call(&handle, "turn/retryFailed", json!({ "turnKey": "attempt:any" }), "r-1").await.expect("answered"),
        json!(false),
        "scheduled: the turn owns the session"
    );

    let hold = Arc::new(tokio::sync::Notify::new());
    *super::testing::lock(&rig.compaction.hold) = Some(hold.clone());
    *super::testing::lock(&rig.compaction.result) = Some(json!({ "changed": true }));
    gate.notify_one();
    let id = handle.id.as_str().to_owned();
    let key = eventually_on!(&[&rig.quota_changed, &handle.cell.stepped], || rig.quota.entry(&id).map(|entry| entry.turn_key)).await;
    eventually_on!(&[&rig.compaction.called, &handle.cell.stepped], || (!super::testing::lock(&rig.compaction.calls).is_empty()
        && !handle.cell.busy.load(SeqCst))
    .then_some(()))
    .await;

    let holds = handle.cell.gate_holds.load(SeqCst);
    assert_eq!(call(&handle, "turn/retryFailed", json!({ "turnKey": key }), "r-2").await.expect("answered"), json!(true), "running: the retry is admitted");
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.gate_holds.load(SeqCst) > holds).then_some(())).await;
    assert_eq!(super::testing::lock(&seen).len(), 1, "the admitted retry waits for the compaction");
    assert_eq!(call(&handle, "turn/retryFailed", json!({ "turnKey": key }), "r-3").await.expect("answered"), json!(false), "the held retry owns the session");
    hold.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (super::testing::lock(&seen).len() == 2).then_some(())).await;
    assert_eq!(super::testing::lock(&seen)[1], Some(true), "the retry turn ran once the compaction ended");
    assert_eq!(super::testing::lock(&rig.compaction.calls).iter().filter(|call| call.starts_with("compact")).count(), 1);
}
/// A manual compaction runs under the session's abort signal (`getSessionAbortSignal`): the runtime's shutdown aborts it with
/// Node's `runtime close` text, so a compaction in flight does not outlive the session.
#[tokio::test(start_paused = true)]
async fn a_shutdown_aborts_the_compaction_in_flight() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let hold = Arc::new(tokio::sync::Notify::new());
    *super::testing::lock(&rig.compaction.hold) = Some(hold);
    let mut compacting = {
        let handle = handle.clone();
        tokio::spawn(async move { call(&handle, "thread/compact/start", json!({}), "c-1").await })
    };
    eventually_on_until!(&[&rig.compaction.called], || (!super::testing::lock(&rig.compaction.calls).is_empty()).then_some(()), &mut compacting).await;
    let cancel = super::testing::lock(&rig.compaction.cancels)[0].clone();
    assert!(!cancel.is_aborted(), "a running compaction is not aborted");
    directory.shutdown().await;
    assert!(cancel.is_aborted(), "the shutdown aborted the compaction's signal");
    assert_eq!(cancel.reason(), format!("Session \"{}\" closed: runtime close (reason=cli-exit)", handle.id.as_str()));
}
/// `resumeGoal`: a quota failure that suspended the Goal is retried by reviving that Goal through
/// the lane's admission; the Goal then continues on its own, the queued resume and the note
/// of the suspended Goal end, and a second ask for the same turn is refused.
#[tokio::test(start_paused = true)]
async fn a_suspended_goal_is_revived_by_its_retry_and_continues() {
    let rig = Rig::new();
    let seen: Arc<std::sync::Mutex<usize>> = Arc::default();
    let count = seen.clone();
    rig.set_script(Arc::new(move |run| {
        let count = count.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let first = {
                let mut count = super::testing::lock(&count);
                *count += 1;
                *count == 1
            };
            if !first {
                return RunOutcome::Completed(Default::default());
            }
            RunOutcome::Failed(super::testing::quota_error(5000))
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_routed_thread(&directory).await;
    let id = handle.id.as_str().to_owned();
    rig.goals.goal_control(&handle.id, json!({ "action": "create", "objective": "Ship it" })).await.expect("create");
    let goal_id = rig.goals.goal_status(&handle.id).await.expect("status").expect("a goal")["id"].as_str().expect("goal id").to_owned();
    let key = eventually_on!(&[&rig.quota_changed, &handle.cell.stepped], || rig.quota.entry(&id).map(|entry| entry.turn_key)).await;
    eventually_on!(&[&rig.quota_changed, &handle.cell.stepped], || (rig.quota.suspended_goal(&id, &key) == goal_id).then_some(())).await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;

    retry_when_settled(&handle, &key, "r-1a").await;
    // The failed Goal turn's prompt carries its transcript metadata, so the failed message is retained and the revived Goal's
    // retry resends it (`resumeGoal`: `retryFailedTurn(key)` when `retainedRetryInput()` finds it), as Node does for every turn;
    // the Goal then continues after that turn, so a poll may see a later run than the second.
    eventually_on!(&[&handle.cell.stepped], || (*super::testing::lock(&seen) >= 2).then_some(())).await;
    let goal = rig.goals.goal_status(&handle.id).await.expect("status").expect("a goal");
    assert_eq!(goal["status"], "active", "the Goal was revived");
    eventually_on!(&[&rig.quota_changed, &handle.cell.stepped], || (rig.quota.entry(&id).is_none() && rig.quota.suspended_goal(&id, &key).is_empty())
        .then_some(()))
    .await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    assert_eq!(call(&handle, "turn/retryFailed", json!({ "turnKey": key }), "r-2").await.expect("answered"), json!(false));
}
/// `publishQuotaResume`: while a resume waits for the thread, its state shows it (`quotaResume`, `publicQuotaResume`'s
/// shape), and a change of the queue that removes the entry takes it away.
#[tokio::test(start_paused = true)]
async fn the_waiting_quota_resume_is_in_the_threads_state() {
    let rig = Rig::new();
    rig.set_script(Arc::new(|run| {
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            RunOutcome::Failed(super::testing::quota_error(5000))
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_routed_thread(&directory).await;
    turn(&handle, "write the report", "op-1").await;
    let id = handle.id.as_str().to_owned();
    let entry = eventually_on!(&[&rig.quota_changed, &handle.cell.stepped], || rig.quota.entry(&id)).await;
    let shown = eventually_on!(&[&handle.cell.stepped], || handle.cell.view.load_full().state.quota_resume.clone()).await;
    assert_eq!((shown.state.as_str(), shown.turn_key.as_str(), shown.provider.as_str()), ("waiting", entry.turn_key.as_str(), entry.provider.as_str()));
    assert!(rig.quota.cancel(&id, None).await.expect("the store writes"), "the entry is removed");
    eventually_on!(&[&handle.cell.stepped], || handle.cell.view.load_full().state.quota_resume.is_none().then_some(())).await;
}
#[tokio::test(start_paused = true)]
async fn a_new_internal_turn_cancels_the_pending_quota_resume_and_hides_it() {
    let rig = Rig::new();
    let gate = Arc::new(tokio::sync::Notify::new());
    let started = Arc::new(tokio::sync::Notify::new());
    let turns = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (open, entered, count) = (gate.clone(), started.clone(), turns.clone());
    rig.set_script(Arc::new(move |run| {
        let (open, entered, count) = (open.clone(), entered.clone(), count.clone());
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            if count.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                return RunOutcome::Failed(super::testing::quota_error(5000));
            }
            entered.notify_one();
            open.notified().await;
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_routed_thread(&directory).await;
    let id = handle.id.as_str().to_owned();
    turn(&handle, "first attempt", "op-1").await;
    let _entry = eventually_on!(&[&rig.quota_changed, &handle.cell.stepped], || rig.quota.entry(&id)).await;
    eventually_on!(&[&handle.cell.stepped], || handle.cell.view.load_full().state.quota_resume.clone()).await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;

    let params = json!({ "threadId": handle.id, "opId": "op-2", "input": { "prompt": "continue on new model" } });
    let internal = CoreRequest { method: Method("turn/start"), params, op: Some(OpId::from("op-2")), ctx: CallContext::internal("agent-turn") };
    handle.request(internal).await.expect("internal turn started");
    eventually_on!(&[&started, &handle.cell.stepped], || (turns.load(std::sync::atomic::Ordering::SeqCst) == 2).then_some(())).await;

    eventually_on!(&[&rig.quota_changed, &handle.cell.stepped], || rig.quota.entry(&id).is_none().then_some(())).await;
    eventually_on!(&[&handle.cell.stepped], || handle.cell.view.load_full().state.quota_resume.is_none().then_some(())).await;

    gate.notify_one();
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    assert!(rig.quota.entry(&id).is_none());
    assert!(handle.cell.view.load_full().state.quota_resume.is_none());
}
#[tokio::test(start_paused = true)]
async fn a_manually_resumed_goal_step_supersedes_the_pending_quota_resume_and_goal_note() {
    let rig = Rig::new();
    let gate = Arc::new(tokio::sync::Notify::new());
    let started = Arc::new(tokio::sync::Notify::new());
    let turns = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (open, entered, count) = (gate.clone(), started.clone(), turns.clone());
    rig.set_script(Arc::new(move |run| {
        let (open, entered, count) = (open.clone(), entered.clone(), count.clone());
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            if count.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                return RunOutcome::Failed(super::testing::quota_error(5000));
            }
            entered.notify_one();
            open.notified().await;
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_routed_thread(&directory).await;
    let id = handle.id.as_str().to_owned();
    rig.goals.goal_control(&handle.id, json!({ "action": "create", "objective": "Ship it" })).await.expect("create");
    let goal_id = rig.goals.goal_status(&handle.id).await.expect("status").expect("a goal")["id"].as_str().expect("goal id").to_owned();
    let key = eventually_on!(&[&rig.quota_changed, &handle.cell.stepped], || rig.quota.entry(&id).map(|entry| entry.turn_key)).await;
    eventually_on!(&[&rig.quota_changed, &handle.cell.stepped], || (rig.quota.suspended_goal(&id, &key) == goal_id).then_some(())).await;
    eventually_on!(&[&handle.cell.stepped], || handle.cell.view.load_full().state.quota_resume.clone()).await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;

    rig.goals.goal_control(&handle.id, json!({ "action": "resume" })).await.expect("manual resume");
    eventually_on!(&[&started, &handle.cell.stepped], || (turns.load(std::sync::atomic::Ordering::SeqCst) == 2).then_some(())).await;

    eventually_on!(&[&rig.quota_changed, &handle.cell.stepped], || (rig.quota.entry(&id).is_none() && rig.quota.suspended_goal(&id, &key).is_empty())
        .then_some(()))
    .await;
    eventually_on!(&[&handle.cell.stepped], || handle.cell.view.load_full().state.quota_resume.is_none().then_some(())).await;

    rig.goals.goal_control(&handle.id, json!({ "action": "stop" })).await.expect("stop");
    gate.notify_one();
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
}
#[tokio::test(start_paused = true)]
async fn a_completion_waits_while_the_last_turn_stopped_on_quota_and_wakes_after_the_retry() {
    use std::sync::atomic::Ordering::SeqCst;
    let rig = Rig::new();
    let inputs: Arc<std::sync::Mutex<Vec<Value>>> = Arc::default();
    let seen = inputs.clone();
    rig.set_script(Arc::new(move |run| {
        let first = {
            let mut seen = super::testing::lock(&seen);
            seen.push(run.input_body.clone());
            seen.len() == 1
        };
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            if first { RunOutcome::Failed(super::testing::quota_error(5000)) } else { RunOutcome::Completed(Default::default()) }
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_routed_thread(&directory).await;
    turn(&handle, "write the report", "op-1").await;
    let id = handle.id.as_str().to_owned();
    let entry = eventually_on!(&[&rig.quota_changed, &handle.cell.stepped], || rig.quota.entry(&id)).await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;

    let passes = handle.cell.drain_passes.load(SeqCst);
    directory.finished(&handle.id, "shell", "job-1", "completed", "job-1 finished.".into()).await;
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.drain_passes.load(SeqCst) > passes).then_some(())).await;
    assert_eq!(super::testing::lock(&inputs).len(), 1, "the completion starts no turn on the quota-stopped session");

    retry_when_settled(&handle, &entry.turn_key, "r-1").await;
    eventually_on!(&[&handle.cell.stepped], || (super::testing::lock(&inputs).len() == 3).then_some(())).await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    let inputs = super::testing::lock(&inputs);
    assert_eq!(inputs[2]["meta"]["source"], "task-notification", "the held completion wakes the session after the retry");
    assert_eq!(inputs.len(), 3);
}
/// `restoreTranscriptRange` runs `restoredFailedTurnItems` for every message: an automatic Goal turn a usage limit stops
/// before any output records its failed end on its prompt, which history pages list though it shows no row of its own, so
/// a reload restores that end under the key the queued resume waits on.
#[tokio::test(start_paused = true)]
async fn a_goal_turns_failed_end_on_its_prompt_is_restored_under_the_resumes_key() {
    use mixdog_store::schema::blob::Slot;
    use mixdog_store::schema::record::Record;

    let rig = Rig::new();
    rig.set_script(Arc::new(|run| {
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            RunOutcome::Failed(super::testing::quota_error(5000))
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_routed_thread(&directory).await;
    let id = handle.id.as_str().to_owned();
    rig.goals.goal_control(&handle.id, json!({ "action": "create", "objective": "Ship it" })).await.expect("create");
    let key = eventually_on!(&[&rig.quota_changed, &handle.cell.stepped], || rig.quota.entry(&id).map(|entry| entry.turn_key)).await;
    let attempt = key.strip_prefix("attempt:").expect("the failure is keyed by its attempt").to_owned();
    let (prompt, body) = eventually_on!(&[&handle.cell.stepped], || {
        let records = rig.store.records(&handle.id);
        let body = records.iter().find_map(|(_, record)| match record {
            Record::Amend(amend) => match &amend.body {
                Slot::Inline(body) if body.pointer("/meta/transcript/completion/attemptId").and_then(Value::as_str) == Some(attempt.as_str()) => {
                    Some((amend.iid.as_str().to_owned(), body.clone()))
                }
                _ => None,
            },
            _ => None,
        })?;
        let prompt = records.iter().find_map(|(_, record)| match record {
            Record::Item(item) if item.iid.as_str() == body.0 => Some(item.clone()),
            _ => None,
        })?;
        Some((prompt, body.1))
    })
    .await;
    assert!(super::goal_lane::is_goal_prompt(&body), "the end is recorded on the Goal turn's prompt: {body}");
    assert!(prompt.visible && prompt.prompt.is_none(), "history pages list the prompt, which shows no row of its own");
    let ends: Vec<Value> = super::transcript::restore(&prompt, &body)
        .into_iter()
        .filter_map(|restored| match restored {
            super::transcript::Restored::Row { row, .. } => Some(Value::Object(row)),
            _ => None,
        })
        .collect();
    assert_eq!(ends.len(), 1, "{ends:?}");
    assert_eq!((&ends[0]["kind"], &ends[0]["status"], &ends[0]["attemptId"]), (&json!("turndone"), &json!("failed"), &json!(attempt)), "{ends:?}");
    assert!(ends[0]["quota"].is_object(), "the restored end carries the quota stop the resume reads: {ends:?}");

    // A reload reads the history pages through the stored records (`RecordTranscript`, which shows nothing for a record history
    // pages do not list), over the same store: the latest failed turn they show is the one the queued resume waits on, which is
    // what `fireQuotaResume` checks after a restart before it fires rather than supersedes the resume.
    let mut restoring = rig.deps_parts(rig.store.clone());
    restoring.transcript = Arc::new(super::testing::RecordTranscript::new());
    let history = SessionDirectory::new(Arc::new(restoring)).history_items(&handle.id).await.expect("history");
    let rows = super::quota_lane::transcript_rows(history.iter());
    assert_eq!(super::quota_lane::latest_failed_turn_key(&rows), key, "the reloaded history ends on the failure the resume waits on: {rows:?}");
}
/// One message a provider refuses before any output (an invalid key) is stored as its user row with the failed end on it: a
/// reload reads the user row, then that one end, and the feed showed the end once.
#[tokio::test(start_paused = true)]
async fn a_message_the_provider_refuses_reloads_as_the_user_row_then_one_failed_end() {
    use mixdog_core_api::domain::provider::DeliveryState;
    use mixdog_core_api::domain::provider::ErrorKind;
    use mixdog_core_api::domain::provider::ProviderError;

    let rig = Rig::new();
    rig.set_script(Arc::new(|run| {
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let mut error = ProviderError::new(ErrorKind::Auth, DeliveryState::NotSent);
            error.status = Some(401);
            error.message = "invalid x-api-key".into();
            RunOutcome::Failed(super::failure_record::provider_turn_error(&error, "anthropic", Value::Null))
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_routed_thread(&directory).await;
    turn(&handle, "hello", "op-1").await;
    let thread = handle.id.as_str().to_owned();
    eventually_on!(&[&rig.feeds.published], || failed_end_frame(&rig, &thread)).await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    let live_ends =
        rig.feeds.frames(&thread).into_iter().filter(|(_, method, params)| method == "item/completed" && params["item"]["type"] == "turnEnd").count();
    assert_eq!(live_ends, 1, "the feed shows the end once");

    let mut restoring = rig.deps_parts(rig.store.clone());
    restoring.transcript = Arc::new(super::testing::RecordTranscript::new());
    let history = SessionDirectory::new(Arc::new(restoring)).history_items(&handle.id).await.expect("history");
    let kinds: Vec<Value> = history.iter().map(|item| serde_json::to_value(item).expect("item")["type"].clone()).collect();
    assert_eq!(kinds, [json!("userMessage"), json!("turnEnd")], "{history:?}");

    let shown: Vec<Value> = handle.cell.view.load_full().items.iter().map(|item| serde_json::to_value(item).expect("item")["type"].clone()).collect();
    assert_eq!(shown, kinds, "the live window reads as the stored history");
}
#[tokio::test(start_paused = true)]
async fn a_manual_compactions_result_is_committed_only_to_the_context_it_was_planned_on() {
    use super::run::Compaction;
    use super::turn_ops::CompactionCommit;
    use mixdog_core_api::ids::ItemId;

    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "first", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    let planned = directory.model_context(&handle.id).read().await.expect("context");
    assert!(!planned.is_empty());
    let snapshot: Vec<ItemId> = planned.iter().map(|(iid, _)| iid.clone()).collect();
    let summary = (ItemId::from("sum1".to_owned()), json!({ "role": "user", "content": "summary" }));
    let compaction = || Compaction { replacement: vec![summary.clone()], at: 5, dropped_count: 1, dropped: None };

    // A context that moved (the planned rows are not its start): nothing is applied.
    let moved = vec![ItemId::from("not-a-row".to_owned())];
    assert_eq!(directory.commit_compaction(&handle.id, moved, compaction(), None).await.expect("answered"), CompactionCommit::Moved);
    assert_eq!(directory.model_context(&handle.id).read().await.expect("context").len(), planned.len());

    // A turn that runs refuses it.
    let gate = held(&rig);
    turn(&handle, "second", "op-2").await;
    eventually_on!(&[&handle.cell.stepped], || (!idle(&handle)).then_some(())).await;
    assert_eq!(directory.commit_compaction(&handle.id, snapshot.clone(), compaction(), None).await.expect("answered"), CompactionCommit::Moved);
    gate.notify_one();
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;

    // The turn that finished meanwhile appended its rows: they follow the compacted ones.
    assert_eq!(directory.commit_compaction(&handle.id, snapshot, compaction(), None).await.expect("answered"), CompactionCommit::Applied);
    let after = directory.model_context(&handle.id).read().await.expect("context");
    assert_eq!(after.first().map(|(iid, _)| iid.as_str()), Some("sum1"));
    assert!(after.len() >= 2, "the second turn's rows follow the summary: {after:?}");
    assert!(after.iter().skip(1).all(|(iid, _)| iid.as_str() != "sum1"));
}
/// A commit that carries the header writes it with the compaction, in the record that counts it:
/// the caller's `compaction.compactCount` stands (it is not counted twice), and a commit that
/// carries none leaves the count to the pass's telemetry.
#[tokio::test(start_paused = true)]
async fn a_manual_compaction_commit_writes_the_header_it_carries_without_counting_twice() {
    use super::run::Compaction;
    use mixdog_core_api::ids::ItemId;
    use mixdog_store::schema::record::HeaderChange;

    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "first", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    let compaction = |id: &str| Compaction {
        replacement: vec![(ItemId::from(id.to_owned()), json!({ "role": "user", "content": "summary" }))],
        at: 5,
        dropped_count: 1,
        dropped: None,
    };
    let snapshot_of = |rows: Vec<(ItemId, Value)>| rows.into_iter().map(|(iid, _)| iid).collect::<Vec<_>>();

    let snapshot = snapshot_of(directory.model_context(&handle.id).read().await.expect("context"));
    let mut set = serde_json::Map::new();
    set.insert("compaction".into(), json!({ "compactCount": 7, "lastStage": "manual" }));
    set.insert("lastContextTokens".into(), json!(0));
    let carried = HeaderChange { set, unset: Vec::new(), patch: Default::default() };
    // The commit computes the header from the thread's header and the rows appended since the snapshot (none here).
    let header: super::turn_ops::CompactionHeader = Box::new(move |_, appended| {
        assert!(appended.is_empty());
        carried
    });
    let applied = directory.commit_compaction(&handle.id, snapshot, compaction("sum1"), Some(header)).await.expect("answered");
    assert_eq!(applied, super::turn_ops::CompactionCommit::Applied);
    eventually_on!(&[&handle.cell.stepped], || (handle.live_header().header().get("compaction")?.get("compactCount") == Some(&json!(7))).then_some(())).await;
    let header = handle.live_header().header();
    assert_eq!(header["compaction"]["lastStage"], json!("manual"));
    assert_eq!(header["lastContextTokens"], json!(0));

    // Nothing carried: the pre-send pass's own telemetry counts the compaction (`rememberCompactTelemetry`), not the commit.
    let snapshot = snapshot_of(directory.model_context(&handle.id).read().await.expect("context"));
    let applied = directory.commit_compaction(&handle.id, snapshot, compaction("sum2"), None).await.expect("answered");
    assert_eq!(applied, super::turn_ops::CompactionCommit::Applied);
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    assert_eq!(handle.live_header().header()["compaction"]["compactCount"], json!(7));
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_manual_compactions_header_follows_the_reset_and_the_replacement_and_is_durable_before_the_answer() {
    use super::run::Compaction;
    use mixdog_core_api::ids::ItemId;
    use mixdog_core_api::ids::ThreadId;
    use mixdog_store::schema::blob::Slot;
    use mixdog_store::schema::record::HeaderChange;
    use mixdog_store::schema::record::Record;

    let rig = Rig::new();
    let id = ThreadId::from("sess_order");
    let creator = SessionDirectory::new(rig.deps());
    creator.create_with_id(id.clone(), json!({ "cwd": "/ws" }).as_object().cloned().expect("object"), json!({})).await.expect("create");
    let seeded = rig.store.records(&id).len();
    rig.store.seed(
        &id,
        vec![
            serde_json::from_value(json!({ "k": "meta", "change": { "inline": { "set": { "providerState": { "id": "resp_1" } }, "unset": [] } } }))
                .expect("meta record"),
        ],
    );
    let directory = SessionDirectory::new(rig.deps());
    directory.open_handle(&id, &CallContext::internal("test")).await.expect("open");

    let seen: Arc<std::sync::Mutex<Vec<bool>>> = Arc::default();
    let log = seen.clone();
    let mut set = serde_json::Map::new();
    set.insert("compaction".into(), json!({ "compactCount": 1, "lastStage": "manual" }));
    let header: super::turn_ops::CompactionHeader = Box::new(move |current, _| {
        log.lock().expect("log").push(current.contains_key("providerState"));
        HeaderChange { set, unset: Vec::new(), patch: Default::default() }
    });
    let (release, go) = std::sync::mpsc::channel();
    let arrived = Arc::new(tokio::sync::Notify::new());
    *super::testing::lock(&rig.store.header_gate) = Some((arrived.clone(), go));

    let compaction = Compaction {
        replacement: vec![(ItemId::from("sum1".to_owned()), json!({ "role": "user", "content": "summary" }))],
        at: 5,
        dropped_count: 0,
        dropped: None,
    };
    let mut commit = Box::pin(directory.commit_compaction(&id, Vec::new(), compaction, Some(header)));
    tokio::select! {
        () = arrived.notified() => {}
        answered = &mut commit => panic!("answered before the header was durable: {answered:?}"),
    }
    // The header's batch is at the gate (`header_gate`'s arrival signal): one poll, no clock, and the commit is still pending.
    assert!(futures::poll!(&mut commit).is_pending(), "the commit answered while the header was held");
    release.send(()).expect("release");
    assert_eq!(commit.await.expect("answered"), super::turn_ops::CompactionCommit::Applied);

    assert_eq!(*seen.lock().expect("log"), vec![false], "the header is evaluated once, after the provider reset");
    let order: Vec<&str> = rig
        .store
        .records(&id)
        .into_iter()
        .skip(seeded + 1)
        .filter_map(|(_, record)| match record {
            Record::Meta(meta) => match meta.change {
                Slot::Inline(change) if change.unset.iter().any(|key| key == "providerState") => Some("reset"),
                Slot::Inline(change) if change.set.contains_key("compaction") => Some("header"),
                _ => None,
            },
            Record::Compacted(_) => Some("replacement"),
            _ => None,
        })
        .collect();
    assert_eq!(order, vec!["reset", "replacement", "header"]);
    let context = directory.model_context(&id).read().await.expect("context");
    assert_eq!(context.iter().map(|(iid, _)| iid.as_str()).collect::<Vec<_>>(), vec!["sum1"]);
}
/// A failed turn's run record holds its error with the message masked as the failure record's `errorDetails` is
/// (`safeErrorDetails`): neither the session log nor the `turn/completed` built from the record carries a credential
/// the provider's message echoed.
#[tokio::test(start_paused = true)]
async fn a_failed_turns_run_record_masks_the_credentials_its_error_names() {
    const RAW: &str = "400 Incorrect API key provided: sk-proj-ABCDEFGHIJKLMNOP1234. Authorization: Bearer tokABCDEF123456XYZ at https://bob:hunter2pass@api.example.com/v1?api_key=qsecretVAL77";
    let rig = Rig::new();
    rig.set_script(Arc::new(|run| {
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            RunOutcome::Failed(mixdog_protocol::TurnError { message: RAW.into(), data: json!({}), provider_error: None })
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "go", "op-1").await;
    let completed =
        eventually_on!(&[&rig.feeds.published], || { rig.feeds.frames(handle.id.as_str()).into_iter().find(|(_, method, _)| method == "turn/completed") })
            .await;
    assert_eq!(completed.2["turn"]["error"]["message"], mixdog_ai::service::error_text::safe_error_details(RAW).as_str());
    let (stored, sent) = (format!("{:?}", rig.store.records(&handle.id)), completed.2.to_string());
    for secret in ["sk-proj-ABCDEFGHIJKLMNOP1234", "tokABCDEF123456XYZ", "hunter2pass", "qsecretVAL77"] {
        assert!(!stored.contains(secret), "the session log holds {secret}: {stored}");
        assert!(!sent.contains(secret), "turn/completed carries {secret}: {sent}");
    }
}
impl super::seams::RecordCodec for RefusesAmends {
    fn encode(
        &self,
        lane: &mixdog_rt::InLane<mixdog_rt::CpuInteractive>,
        record: &mixdog_store::schema::record::Record,
    ) -> Result<super::seams::EncodedRecord, CoreError> {
        match record {
            mixdog_store::schema::record::Record::Amend(_) => Err(CoreError::Internal { incident_id: "amend-refused".into() }),
            _ => super::store::StoreCodec.encode(lane, record),
        }
    }
}
/// The settlements stand on the completion's amend (`attachFailedTurnCompletion` before `beginQuotaSettlement`,
/// `ask-turn-settle.mjs:94`, `turn.mjs:644`). When the amend cannot be recorded the end is not shown, the quota is not
/// settled (no resume is queued), and the Goal still settles: the next turn runs.
#[tokio::test(start_paused = true)]
async fn a_failed_turn_whose_completion_cannot_be_recorded_settles_no_quota_and_shows_no_end() {
    let rig = Rig::new();
    let turns = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counted = turns.clone();
    rig.set_script(Arc::new(move |run| {
        let counted = counted.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            if counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                RunOutcome::Failed(super::testing::quota_error(5000))
            } else {
                RunOutcome::Completed(Default::default())
            }
        })
    }));
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.codec = Arc::new(RefusesAmends);
    let directory = SessionDirectory::new(Arc::new(deps));
    let handle = start_thread(&directory).await;
    turn(&handle, "write the report", "op-1").await;
    // The next turn starts only once the failed one has settled its Goal: it is the signal that the settlement ended.
    turn(&handle, "again", "op-2").await;
    let thread = handle.id.as_str().to_owned();
    let completed = || rig.feeds.frames(&thread).iter().filter(|(_, method, _)| method == "turn/completed").count();
    eventually_on!(&[&rig.feeds.published], || (completed() == 2).then_some(())).await;
    assert_eq!(turns.load(std::sync::atomic::Ordering::SeqCst), 2, "the settled turn let the next one run");
    assert!(failed_end_frame(&rig, &thread).is_none(), "no end is shown for a turn whose completion was not recorded");
    assert!(rig.quota.entry(&thread).is_none(), "no resume is queued for it");
    let ends = handle.cell.view.load_full().items.iter().filter(|item| matches!(item.as_ref(), mixdog_protocol::ThreadItem::TurnEnd { .. })).count();
    assert_eq!(ends, 0);
}
/// The notices a session's own events raise (`failTurn` / `completeTurn`, `_recordSaveFailure`):
/// a turn that fails on a provider's auth refusal, one that completes, a cancelled one, and a
/// save whose barrier failed are each reported once to the composition.
#[tokio::test(start_paused = true)]
async fn turn_ends_and_failed_saves_are_reported_to_the_notices() {
    use mixdog_protocol::{ProviderErrorDetail, TurnError};

    let rig = Rig::new();
    let outcomes: Arc<std::sync::Mutex<Vec<RunOutcome>>> = Arc::new(std::sync::Mutex::new(vec![
        RunOutcome::Failed(TurnError {
            message: "401".into(),
            data: json!({}),
            provider_error: Some(ProviderErrorDetail { provider: "anthropic".into(), status: Some(401), kind: "auth".into(), delivery: None }),
        }),
        RunOutcome::Failed(TurnError { message: "disk".into(), data: json!({}), provider_error: None }),
        RunOutcome::Interrupted,
        RunOutcome::Completed(Default::default()),
    ]));
    let script = outcomes.clone();
    rig.set_script(Arc::new(move |run| {
        let script = script.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            super::testing::lock(&script).remove(0)
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    for (n, expected) in [(1, "failed::auth"), (2, "failed::-"), (3, ""), (4, "completed:")] {
        turn(&handle, "go", &format!("op-{n}")).await;
        eventually_on!(&[&handle.cell.stepped], || (super::testing::lock(&outcomes).len() == 4 - n).then_some(())).await;
        eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
        if !expected.is_empty() {
            eventually_on!(&[&rig.notices.1, &handle.cell.stepped], || (super::testing::lock(&rig.notices.0).last().map(String::as_str) == Some(expected))
                .then_some(()))
            .await;
        }
    }
    assert_eq!(super::testing::lock(&rig.notices.0).clone(), vec!["failed::auth", "failed::-", "completed:"], "a cancelled turn reports nothing");
    rig.store.fail_next.store(true, std::sync::atomic::Ordering::SeqCst);
    let _ = handle
        .request(request("thread/name/set", json!({ "threadId": handle.id, "opId": "op-save", "title": "renamed" }), "op-save"))
        .await
        .expect_err("barrier failed");
    assert_eq!(super::testing::lock(&rig.notices.0).last().map(String::as_str), Some("completed:"), "a refused rename leaves no conversation data unsaved");
}
#[tokio::test(start_paused = true)]
async fn a_route_change_during_a_turn_does_not_move_its_notice() {
    use mixdog_protocol::{ProviderErrorDetail, TurnError};

    let rig = Rig::new();
    let gate = Arc::new(tokio::sync::Notify::new());
    let open = gate.clone();
    rig.set_script(Arc::new(move |run| {
        let open = open.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            open.notified().await;
            RunOutcome::Failed(TurnError {
                message: "401".into(),
                data: json!({}),
                provider_error: Some(ProviderErrorDetail { provider: "ignored".into(), status: Some(401), kind: "auth".into(), delivery: None }),
            })
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let route = |set: Value| {
        let handle = handle.clone();
        let params = json!({ "threadId": handle.id, "set": set, "unset": [] });
        async move {
            handle.request(CoreRequest { method: Method("thread/header/patch"), params, op: None, ctx: CallContext::internal("test") }).await.expect("patch");
        }
    };
    route(json!({ "provider": "anthropic-oauth" })).await;
    turn(&handle, "go", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (!idle(&handle)).then_some(())).await;
    route(json!({ "provider": "openai", "routeFallbackIndex": 1, "routeFallbackFailures": [{ "provider": "anthropic-oauth", "kind": "auth" }] })).await;
    assert_eq!(handle.live_header().header().get("provider"), Some(&json!("openai")), "the route changed under the running turn");
    gate.notify_one();
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    eventually_on!(&[&rig.notices.1, &handle.cell.stepped], || (!super::testing::lock(&rig.notices.0).is_empty()).then_some(())).await;
    assert_eq!(super::testing::lock(&rig.notices.0).clone(), vec!["failed:anthropic-oauth:auth"]);
}
/// A Stop while a drained turn is starting (its input row's facts are being read, no run published yet) applies to that start: the
/// start never runs (its late read finishes the cancellation) and has a visible outcome (the prompt back at its composer). The prompt
/// is not lost, though its submit was already answered `queued`.
#[tokio::test(start_paused = true)]
async fn a_stop_while_a_turn_is_starting_stops_that_start_with_a_visible_outcome() {
    use std::sync::atomic::Ordering::SeqCst;
    let rig = Rig::new();
    let gate = Arc::new(tokio::sync::Notify::new());
    let begun: Arc<std::sync::Mutex<Vec<(String, bool)>>> = Arc::default();
    let (open, seen) = (gate.clone(), begun.clone());
    rig.set_script(Arc::new(move |run| {
        let (open, seen) = (open.clone(), seen.clone());
        Box::pin(async move {
            let prompt = match &run.input.prompt {
                mixdog_protocol::PromptContent::Text(text) => text.clone(),
                mixdog_protocol::PromptContent::Parts(_) => String::new(),
            };
            super::testing::lock(&seen).push((prompt.clone(), run.cancel.is_cancelled()));
            if prompt == "first" {
                open.notified().await;
                return RunOutcome::Completed(Default::default());
            }
            run.cancel.cancelled().await;
            RunOutcome::Interrupted
        })
    }));
    let (hold, start_hold) = tokio::sync::watch::channel(super::StartHold::Open);
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.start_hold = start_hold;
    let directory = SessionDirectory::new(Arc::new(deps));
    let handle = start_thread(&directory).await;
    assert_eq!(turn(&handle, "first", "op-1").await["kind"], "started");
    assert_eq!(turn(&handle, "second", "op-2").await["kind"], "queued");
    hold.send_replace(super::StartHold::Held);
    gate.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && !handle.cell.busy.load(SeqCst) && handle.cell.queued.load().len() == 1).then_some(())).await;
    let io = mixdog_rt::testing::hold_full(mixdog_rt::LaneKind::InteractiveIo);
    hold.send_replace(super::StartHold::Open);
    io.met_by_a_submit().await;
    super::tests::caught_up(&handle).await;
    assert!(idle(&handle) && handle.cell.ui_busy.load(SeqCst), "the start is reading its input, no run is published");
    let stopped = handle.stop(stop_now()).await.expect("stop");
    assert_eq!((&stopped["aborted"], &stopped["reason"]), (&json!(true), &Value::Null), "{stopped}");
    drop(io);
    eventually_on!(&[&handle.cell.stepped], || (stop_ledger(&handle).iter().any(|event| event.starts_with("start:stopped:"))
        && idle(&handle)
        && !handle.cell.busy.load(SeqCst))
    .then_some(()))
    .await;
    assert_eq!(super::testing::lock(&begun).len(), 1, "the stopped start never reached the provider: {:?}", super::testing::lock(&begun));
    let restored = rig.feeds.frames(handle.id.as_str()).iter().any(|(_, method, _)| method == "thread/promptRestore");
    assert!(
        restored || super::tests::rows(&handle).iter().any(|(role, text)| *role == "user" && text == "second"),
        "the prompt was neither lost nor left without an outcome"
    );
    assert!(handle.cell.queued.load().is_empty());
    let again = handle.stop(stop_now()).await.expect("stop");
    assert_eq!((&again["aborted"], &again["reason"]), (&json!(false), &Value::Null), "nothing under way is Node's idle reply: {again}");
}
/// A Stop while the scheduled compaction holds the session (nothing editable queued to hand back): the compaction is aborted
/// with the user's cancel, and the stop is not an idle one.
#[tokio::test(start_paused = true)]
async fn a_stop_while_a_compaction_holds_the_session_cancels_the_compaction() {
    use std::sync::atomic::Ordering::SeqCst;
    let rig = Rig::new();
    rig.store.listed.store(true, SeqCst);
    let gate = held(&rig);
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "work", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (!idle(&handle)).then_some(())).await;
    call(&handle, "thread/compact/schedule", json!({}), "s-1").await.expect("scheduled");
    let hold = Arc::new(tokio::sync::Notify::new());
    *super::testing::lock(&rig.compaction.hold) = Some(hold.clone());
    gate.notify_one();
    eventually_on!(&[&rig.compaction.called, &handle.cell.stepped], || (!super::testing::lock(&rig.compaction.calls).is_empty() && idle(&handle))
        .then_some(()))
    .await;
    eventually_on!(&[&handle.cell.stepped], || handle.cell.gated.load(SeqCst).then_some(())).await;
    let cancel = super::testing::lock(&rig.compaction.cancels)[0].clone();
    assert!(!cancel.is_aborted());
    let stopped = handle.stop(stop_now()).await.expect("stop");
    assert_eq!((&stopped["aborted"], &stopped["reason"]), (&json!(true), &Value::Null), "{stopped}");
    assert!(cancel.is_aborted(), "the compaction holding the session was cancelled through its owner");
    hold.notify_one();
}
/// Several finished sub-agents queued behind the core's hold are one batch: one turn takes every notice, one Stop ends it, and
/// the stopped notices are consumed (no further turn starts, none is requeued).
#[tokio::test(start_paused = true)]
async fn queued_completion_notices_are_one_turn_and_one_stop() {
    use mixdog_tools::exec::TaskNotifier;
    let rig = Rig::new();
    let bodies: Arc<std::sync::Mutex<Vec<Value>>> = Arc::default();
    let seen = bodies.clone();
    rig.set_script(Arc::new(move |run| {
        let seen = seen.clone();
        Box::pin(async move {
            super::testing::lock(&seen).push(run.input_body.clone());
            run.cancel.cancelled().await;
            RunOutcome::Interrupted
        })
    }));
    let (hold, start_hold) = tokio::sync::watch::channel(super::StartHold::Held);
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.start_hold = start_hold;
    let directory = SessionDirectory::new(Arc::new(deps));
    let handle = start_thread(&directory).await;
    for job in 1..=4 {
        directory.finished(&handle.id, "shell", &format!("job-{job}"), "completed", format!("job-{job} finished.")).await;
    }
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.queued.load().len() == 4).then_some(())).await;
    hold.send_replace(super::StartHold::Open);
    let run = eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load_full()).await;
    assert_eq!(super::testing::lock(&bodies)[0]["content"], json!("job-1 finished.\njob-2 finished.\njob-3 finished.\njob-4 finished."));
    assert_eq!(
        super::testing::lock(&bodies)[0].pointer("/meta/transcript/consumedExecutionIds"),
        Some(&json!(["job-1", "job-2", "job-3", "job-4"])),
        "the one turn accounts for every execution it delivers"
    );
    assert_eq!(
        super::testing::lock(&bodies)[0].pointer("/meta/transcript/completions/3"),
        Some(&json!({ "executionId": "job-4", "surface": "shell", "status": "completed", "start": 48, "end": 63 })),
        "the row locates each completion it delivers in its text"
    );
    let stopped = handle.stop(stop_now()).await.expect("stop");
    assert_eq!(stopped["aborted"], json!(true), "{stopped}");
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && handle.cell.run.load().as_ref().is_none_or(|next| next.turn != run.turn)).then_some(())).await;
    mixdog_rt::time::sleep(std::time::Duration::from_millis(200)).await;
    assert_eq!(super::tests::runs_started(&rig, &handle.id), 1, "the four notices cost one turn");
    assert!(idle(&handle) && handle.cell.queued.load().is_empty(), "the stopped notices are consumed, not requeued");
}
/// A Stop of the running turn applies to that turn only: a completion queued behind it is unrelated work and, though the drain that
/// follows the stopped turn waits at the core's hold, runs once the hold opens. (A Stop inside the settlement itself:
/// `stop_race_tests::a_stop_during_the_settlement_freezes_the_queued_completion_and_a_later_one_still_runs`.)
#[tokio::test(start_paused = true)]
async fn a_stop_of_the_running_turn_leaves_a_queued_completion_to_run_after_a_gated_drain() {
    use mixdog_tools::exec::TaskNotifier;
    use std::sync::atomic::Ordering::SeqCst;
    let rig = Rig::new();
    rig.set_script(Arc::new(move |run| {
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let text = match &run.input.prompt {
                mixdog_protocol::PromptContent::Text(text) => text.clone(),
                mixdog_protocol::PromptContent::Parts(_) => String::new(),
            };
            if text == "work" {
                run.cancel.cancelled().await;
                return RunOutcome::Interrupted;
            }
            RunOutcome::Completed(Default::default())
        })
    }));
    let (hold, start_hold) = tokio::sync::watch::channel(super::StartHold::Open);
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.start_hold = start_hold;
    let directory = SessionDirectory::new(Arc::new(deps));
    let handle = start_thread(&directory).await;
    turn(&handle, "work", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load_full()).await;
    hold.send_replace(super::StartHold::Held);
    directory.finished(&handle.id, "shell", "job-1", "completed", "job-1 finished.".into()).await;
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.queued.load().len() == 1).then_some(())).await;
    let stopped = handle.stop(stop_now()).await.expect("stop");
    assert_eq!(stopped["aborted"], json!(true), "{stopped}");
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && !handle.cell.busy.load(SeqCst) && handle.cell.unacked.load(SeqCst) == 0).then_some(())).await;
    assert_eq!(super::tests::runs_started(&rig, &handle.id), 1, "the gated drain started nothing");
    hold.send_replace(super::StartHold::Open);
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.queued.load().is_empty() && idle(&handle) && !handle.cell.busy.load(SeqCst)).then_some(())).await;
    assert_eq!(super::tests::runs_started(&rig, &handle.id), 2, "the unrelated completion ran once the hold opened");
}
/// A Stop of a start waiting for the previous turn's records to be saved applies to that start: it never reaches the provider, even
/// once the save that held it lands, and the prompt queued behind it still runs. The Stop answers only once its record is saved.
#[tokio::test(start_paused = true)]
async fn a_stop_of_a_start_waiting_for_the_save_strands_no_queued_prompt() {
    let rig = Rig::new();
    let failing = rig.store.failing.clone();
    let begun: Arc<std::sync::Mutex<Vec<(String, bool)>>> = Arc::default();
    let seen = begun.clone();
    rig.set_script(Arc::new(move |run| {
        let (failing, seen) = (failing.clone(), seen.clone());
        Box::pin(async move {
            if run.port.input_durable().await.is_err() {
                return RunOutcome::Interrupted;
            }
            let prompt = match &run.input.prompt {
                mixdog_protocol::PromptContent::Text(text) => text.clone(),
                mixdog_protocol::PromptContent::Parts(_) => String::new(),
            };
            super::testing::lock(&seen).push((prompt.clone(), run.cancel.is_cancelled()));
            if prompt == "second" {
                run.cancel.cancelled().await;
                return RunOutcome::Interrupted;
            }
            if prompt == "first" {
                *failing.lock().unwrap() = Some("EIO: injected".into());
            }
            let item = super::run::ItemCommit {
                iid: mixdog_core_api::ids::ItemId::from(format!("a-{}", run.turn)),
                role: Some("assistant".into()),
                model: true,
                visible: true,
                body: json!({ "text": format!("re: {prompt}") }),
                prompt: None,
            };
            run.port.commit_item(item).await.expect("the answer is kept");
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "first", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && !handle.cell.busy.load(std::sync::atomic::Ordering::SeqCst)).then_some(())).await;
    // The fresh save the waiting start asks for stays pending on the held durability lane (and the store keeps failing), so the start is still waiting when the Stop lands.
    let disk = mixdog_rt::testing::hold_full(mixdog_rt::LaneKind::DurabilityIo);
    let second = {
        let handle = handle.clone();
        tokio::spawn(async move { call(&handle, "turn/start", json!({ "input": { "prompt": "second" } }), "h-2").await })
    };
    super::tests::caught_up(&handle).await;
    // `turn_held` is Node's ask lock (a run, a start reading, a settlement); a start waiting for the previous turn's save is the
    // actor's `deferred_start`, which only `turn_busy` (the test cell's `busy`) counts.
    assert!(
        idle(&handle) && handle.cell.busy.load(std::sync::atomic::Ordering::SeqCst) && !handle.cell.turn_held.load(std::sync::atomic::Ordering::SeqCst),
        "the second start waits for the previous turn's save"
    );
    let third = {
        let handle = handle.clone();
        tokio::spawn(async move { call(&handle, "turn/start", json!({ "input": { "prompt": "third" } }), "h-3").await })
    };
    super::tests::caught_up(&handle).await;
    // The Stop's record waits behind the unsaved records on the held disk: no success before it is saved.
    let stopped = {
        let handle = handle.clone();
        tokio::spawn(async move { handle.stop(stop_now()).await })
    };
    eventually_on!(&[&handle.cell.stepped], || stop_ledger(&handle).iter().any(|event| event.starts_with("start:stopped:")).then_some(())).await;
    assert!(!stopped.is_finished(), "no success before the Stop's record is saved");
    *rig.store.failing.lock().unwrap() = None;
    drop(disk);
    let stopped = super::testing::awaiting(|| "the Stop's answer".to_owned(), stopped).await.expect("stop task").expect("the Stop is saved");
    assert_eq!(stopped["aborted"], json!(true), "{stopped}");
    let _ = super::testing::awaiting(|| "the second start's answer".to_owned(), second).await;
    let _ = super::testing::awaiting(|| "the third start's answer".to_owned(), third).await;
    eventually_on!(&[&handle.cell.stepped], || (super::testing::lock(&begun).iter().any(|(prompt, _)| prompt == "third") && idle(&handle)).then_some(())).await;
    assert!(!super::testing::lock(&begun).iter().any(|(prompt, _)| prompt == "second"), "the stopped start never reached the provider");
    assert!(handle.cell.queued.load().is_empty(), "the prompt queued behind the stopped start ran");
}
/// A Stop of a kickoff whose drained start is still reading its input row (the interactive io lane held): the start never runs, with
/// the same terminal disposition as a published run's Stop: cancelled, consumed, never put back in the queue.
#[tokio::test(start_paused = true)]
async fn a_stop_of_a_kickoff_still_reading_its_input_consumes_it() {
    use std::sync::atomic::Ordering::SeqCst;
    let rig = Rig::new();
    let gate = Arc::new(tokio::sync::Notify::new());
    let runs: Arc<std::sync::Mutex<Vec<(String, bool)>>> = Arc::default();
    let (open, seen) = (gate.clone(), runs.clone());
    rig.set_script(Arc::new(move |run| {
        let (open, seen) = (open.clone(), seen.clone());
        Box::pin(async move {
            let text = match &run.input.prompt {
                mixdog_protocol::PromptContent::Text(text) => text.clone(),
                mixdog_protocol::PromptContent::Parts(_) => String::new(),
            };
            super::testing::lock(&seen).push((text.clone(), run.cancel.is_cancelled()));
            if text == "first" {
                open.notified().await;
                return RunOutcome::Completed(Default::default());
            }
            run.cancel.cancelled().await;
            RunOutcome::Interrupted
        })
    }));
    let (hold, start_hold) = tokio::sync::watch::channel(super::StartHold::Open);
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.start_hold = start_hold;
    let directory = SessionDirectory::new(Arc::new(deps));
    let handle = start_thread(&directory).await;
    assert_eq!(turn(&handle, "first", "op-1").await["kind"], "started");
    let queued = call(&handle, "turn/start", json!({ "input": { "prompt": "greet", "options": { "kickoff": true } } }), "k-1").await.expect("admitted");
    assert_eq!(queued["kind"], "queued", "{queued}");
    hold.send_replace(super::StartHold::Held);
    gate.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && !handle.cell.busy.load(SeqCst) && handle.cell.queued.load().len() == 1).then_some(())).await;
    let io = mixdog_rt::testing::hold_full(mixdog_rt::LaneKind::InteractiveIo);
    hold.send_replace(super::StartHold::Open);
    io.met_by_a_submit().await;
    super::tests::caught_up(&handle).await;
    assert!(idle(&handle) && handle.cell.ui_busy.load(SeqCst), "the kickoff's start is reading its input");
    let stopped = handle.stop(stop_now()).await.expect("stop");
    assert_eq!(stopped["aborted"], json!(true), "{stopped}");
    drop(io);
    // The late read finished the cancellation, and the drain after it decided: nothing replaces the kickoff.
    eventually_on!(&[&handle.cell.stepped], || {
        let events = stop_ledger(&handle);
        let at = events.iter().position(|event| event.starts_with("start:stopped:"))?;
        (events[at..].iter().any(|event| event == "drain:decided") && idle(&handle) && !handle.cell.busy.load(SeqCst)).then_some(())
    })
    .await;
    assert_eq!(super::testing::lock(&runs).len(), 1, "the stopped kickoff never reached the provider: {:?}", super::testing::lock(&runs));
    assert!(handle.cell.queued.load().is_empty());
}
/// A batch's turn stopped, then more input arrives (a later notice and a user prompt): the stopped batch stays consumed (never
/// revived by the later drain) and the later input runs as its own work, the user's prompt first.
#[tokio::test(start_paused = true)]
async fn input_arriving_after_a_stopped_batch_runs_without_reviving_it() {
    use mixdog_tools::exec::TaskNotifier;
    use std::sync::atomic::Ordering::SeqCst;
    let rig = Rig::new();
    let bodies: Arc<std::sync::Mutex<Vec<String>>> = Arc::default();
    let seen = bodies.clone();
    rig.set_script(Arc::new(move |run| {
        let seen = seen.clone();
        Box::pin(async move {
            let text = match &run.input.prompt {
                mixdog_protocol::PromptContent::Text(text) => text.clone(),
                mixdog_protocol::PromptContent::Parts(_) => String::new(),
            };
            super::testing::lock(&seen).push(text.clone());
            if text.contains("job-1") {
                run.cancel.cancelled().await;
                return RunOutcome::Interrupted;
            }
            run.port.input_durable().await.expect("input durable");
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    directory.finished(&handle.id, "shell", "job-1", "completed", "job-1 finished.".into()).await;
    directory.finished(&handle.id, "shell", "job-2", "completed", "job-2 finished.".into()).await;
    eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load_full()).await;
    let stopped = handle.stop(stop_now()).await.expect("stop");
    assert_eq!(stopped["aborted"], json!(true));
    directory.finished(&handle.id, "shell", "job-3", "completed", "job-3 finished.".into()).await;
    eventually_on!(&[&handle.cell.stepped], || (super::testing::lock(&bodies).len() >= 2 && idle(&handle) && !handle.cell.busy.load(SeqCst)).then_some(()))
        .await;
    mixdog_rt::time::sleep(std::time::Duration::from_millis(300)).await;
    let bodies = super::testing::lock(&bodies).clone();
    // job-2 arrived after the first wake began, so the stopped turn held job-1 alone; job-2 (queued, no part of the busy work) and
    // job-3 (arrived after the Stop) run as one later batch, and job-1 is never revived.
    assert!(bodies[0].contains("job-1") && !bodies[0].contains("job-2"), "{bodies:?}");
    assert!(bodies[1..].iter().all(|body| !body.contains("job-1")), "the stopped notice was not revived: {bodies:?}");
    assert!(bodies[1..].iter().any(|body| body.contains("job-2")) && bodies[1..].iter().any(|body| body.contains("job-3")), "the later input ran: {bodies:?}");
}

#[tokio::test(start_paused = true)]
async fn a_retry_of_a_system_turn_and_the_retry_of_that_retry_are_noted_as_system() {
    use super::ItemCommit;
    use mixdog_ai::warmer::plan::TurnKind;
    use mixdog_ai::warmer::plan::turn_kind;
    use mixdog_core_api::ids::ItemId;

    let rig = Rig::new();
    let stamped: Arc<std::sync::Mutex<Vec<Value>>> = Arc::default();
    let log = stamped.clone();
    rig.set_script(Arc::new(move |run| {
        let log = log.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let n = {
                let mut seen = super::testing::lock(&log);
                seen.push(run.input_body.pointer("/meta/provenance").cloned().unwrap_or(Value::Null));
                seen.len()
            };
            if n >= 3 {
                return RunOutcome::Completed(Default::default());
            }
            // The first failed turn is a restored system-caused message; its completion, and the
            // retry row's, are written by the actor when the turn fails (`attachFailedTurnCompletion`).
            if n == 1 {
                let body = json!({ "role": "user", "content": "go on", "meta": { "source": "task-notification", "transcript": { "messageId": "m1" } } });
                run.port
                    .commit_item(ItemCommit { iid: ItemId::from("m1-row"), role: Some("user".into()), model: true, visible: false, body, prompt: None })
                    .await
                    .expect("commit");
            }
            RunOutcome::Failed(super::testing::quota_error(5000))
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_routed_thread(&directory).await;
    turn(&handle, "write the report", "op-1").await;
    let id = handle.id.as_str().to_owned();
    let first = eventually_on!(&[&rig.quota_changed, &handle.cell.stepped], || rig.quota.entry(&id)).await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;

    retry_when_settled(&handle, &first.turn_key, "r-1s").await;
    eventually_on!(&[&handle.cell.stepped], || (super::testing::lock(&stamped).len() == 2).then_some(())).await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    let second = eventually_on!(&[&rig.quota_changed, &handle.cell.stepped], || rig.quota.entry(&id).filter(|entry| entry.turn_key != first.turn_key)).await;
    retry_when_settled(&handle, &second.turn_key, "r-2s").await;
    eventually_on!(&[&handle.cell.stepped], || (super::testing::lock(&stamped).len() == 3).then_some(())).await;

    let provenance = json!({ "source": "task-notification" });
    assert_eq!(*super::testing::lock(&stamped), [Value::Null, provenance.clone(), provenance], "each retry row carries the failed turn's provenance");
    let begun = super::testing::lock(&rig.warms.begun).clone();
    let kinds: Vec<TurnKind> = begun.iter().map(|(_, input, messages)| turn_kind(input, messages.as_ref())).collect();
    assert_eq!(kinds, [TurnKind::Return, TurnKind::System, TurnKind::System], "the prompt is a return, both retries are system");

    // A retained retry keeps the failed message's id (`messageId: previousTranscript.messageId`) and carries every failure
    // it replaced, the earliest first (`previousCompletions`, `ask-turn-execute.mjs:38-61`): without the id the retry of
    // the retry finds no retained message and is not resumable.
    let rows: Vec<Value> = directory.model_context(&handle.id).read().await.expect("context").into_iter().map(|(_, message)| message).collect();
    let last = rows.last().expect("the last retry's row").pointer("/meta/transcript").cloned().expect("its transcript");
    assert_eq!(last["messageId"], "m1");
    let previous = last["previousCompletions"].as_array().expect("the failures it replaced");
    assert_eq!(previous.iter().map(|completion| completion["status"].clone()).collect::<Vec<_>>(), [json!("failed"), json!("failed")]);
}
#[tokio::test(start_paused = true)]
async fn a_route_change_during_a_quota_failed_turn_moves_the_durable_stop_and_not_the_live_end() {
    use mixdog_core_run::run_host::model_display::display_model_name;

    let rig = Rig::new();
    let gate = Arc::new(tokio::sync::Notify::new());
    let open = gate.clone();
    rig.set_script(Arc::new(move |run| {
        let open = open.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            open.notified().await;
            RunOutcome::Failed(super::testing::quota_error(5000))
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let route = |set: Value| {
        let handle = handle.clone();
        let params = json!({ "threadId": handle.id, "set": set, "unset": [] });
        async move {
            handle.request(CoreRequest { method: Method("thread/header/patch"), params, op: None, ctx: CallContext::internal("test") }).await.expect("patch");
        }
    };
    route(json!({ "provider": "anthropic-oauth", "model": "claude-opus-4-1" })).await;
    turn(&handle, "go", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (!idle(&handle)).then_some(())).await;
    route(json!({ "provider": "openai", "model": "gpt-5" })).await;
    gate.notify_one();
    let thread = handle.id.as_str().to_owned();
    let end = eventually_on!(&[&rig.feeds.published], || failed_end_frame(&rig, &thread)).await;
    let mixdog_protocol::ThreadItem::TurnEnd { quota: Some(live), .. } = end else { panic!("a failed end with a quota stop") };
    assert_eq!(live.get("provider"), Some(&json!("anthropic-oauth")), "the live end keeps the route the turn started with");
    assert_eq!(live.get("model"), Some(&json!(display_model_name("claude-opus-4-1", ""))));
    let durable = eventually_on!(&[&handle.cell.stepped], || {
        rig.store.records(&handle.id).iter().rev().find_map(|(_, record)| match record {
            mixdog_store::schema::record::Record::Amend(amend) => match &amend.body {
                mixdog_store::schema::blob::Slot::Inline(body) => body.pointer("/meta/transcript/completion/quota").cloned(),
                _ => None,
            },
            _ => None,
        })
    })
    .await;
    assert_eq!(
        (durable["provider"].clone(), durable["model"].clone()),
        (json!("openai"), json!("gpt-5")),
        "the completion names the session's route at the close"
    );
}

async fn failed_system_turn() -> (Rig, SessionDirectory, Arc<SessionHandle>, Arc<std::sync::Mutex<Vec<Value>>>) {
    use super::ItemCommit;
    use mixdog_core_api::ids::ItemId;

    let rig = Rig::new();
    let stamped: Arc<std::sync::Mutex<Vec<Value>>> = Arc::default();
    let log = stamped.clone();
    rig.set_script(Arc::new(move |run| {
        let log = log.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let n = {
                let mut seen = super::testing::lock(&log);
                seen.push(run.input_body.pointer("/meta/provenance").cloned().unwrap_or(Value::Null));
                seen.len()
            };
            if n > 1 {
                return RunOutcome::Completed(Default::default());
            }
            let body = json!({ "role": "user", "content": "go on", "meta": { "source": "task-notification", "transcript": { "messageId": "m1" } } });
            run.port
                .commit_item(ItemCommit { iid: ItemId::from("m1-row"), role: Some("user".into()), model: true, visible: false, body, prompt: None })
                .await
                .expect("commit");
            RunOutcome::Failed(super::testing::quota_error(5000))
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "write the report", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    eventually_on!(&[&handle.cell.stepped], || (super::testing::lock(&stamped).len() == 1).then_some(())).await;
    (rig, directory, handle, stamped)
}

#[tokio::test(start_paused = true)]
async fn a_failed_turn_records_its_completion() {
    let (rig, directory, handle, _) = failed_system_turn().await;
    let context = directory.model_context(&handle.id);
    let messages = rows_with_completion(&rig, &context).await;
    let completion = messages.last().expect("rows").pointer("/meta/transcript/completion").cloned().expect("completion");
    assert_eq!(completion["status"], "failed");
    assert_eq!(completion["detail"], "Provider usage limit reached.");
    assert_eq!(
        completion["errorKind"],
        json!({ "kind": "quota_exhausted", "code": "usage_limit_reached", "status": 429, "retryAfterMs": null, "resetAt": 5000 })
    );
    assert_eq!(completion["quota"]["resetAt"], 5000);
}

#[tokio::test(start_paused = true)]
async fn a_plain_retry_start_carries_the_failed_turns_provenance() {
    let (_rig, _directory, handle, stamped) = failed_system_turn().await;
    call(&handle, "turn/start", json!({ "input": { "prompt": "go on", "options": { "retryFailedTurn": true, "retryTurnId": "m1" } } }), "op-retry")
        .await
        .expect("started");
    eventually_on!(&[&handle.cell.stepped], || (super::testing::lock(&stamped).len() == 2).then_some(())).await;
    assert_eq!(super::testing::lock(&stamped)[1], json!({ "source": "task-notification" }), "the plain retry's row carries the failed turn's provenance");
}

/// `turn/takeover` of `turn` by the queued message `queued`, under the operation id `op`: its receipt.
async fn take_over(handle: &SessionHandle, turn: &str, queued: &str, op: &'static str) -> Value {
    call(handle, "turn/takeover", json!({ "turnId": turn, "queuedId": queued }), op).await.expect("a takeover answers its receipt")
}

/// The queue id a `turn/start` on a busy thread answered.
fn queued_id(reply: &Value) -> String {
    assert_eq!(reply["kind"], json!("queued"), "{reply}");
    reply["queuedId"].as_str().expect("the queued id").to_owned()
}

/// The refusal a takeover answers: nothing changed, and `message` is what became of the message it named.
fn refused(turn: &str, queued: &str, reason: &str, message: &str) -> Value {
    json!({ "kind": "refused", "turnId": turn, "queuedId": queued, "reason": reason, "message": message })
}

/// Every run notes its prompt as it starts, then ends when it is cancelled (interrupted) or when `finish` is notified (completed).
fn working(rig: &Rig) -> (Arc<std::sync::Mutex<Vec<String>>>, Arc<tokio::sync::Notify>) {
    use mixdog_protocol::PromptContent;
    let (seen, finish): (Arc<std::sync::Mutex<Vec<String>>>, Arc<tokio::sync::Notify>) = Default::default();
    let (noted, done) = (seen.clone(), finish.clone());
    rig.set_script(Arc::new(move |run| {
        let (noted, done) = (noted.clone(), done.clone());
        Box::pin(async move {
            if run.port.input_durable().await.is_err() {
                return RunOutcome::Interrupted;
            }
            let text = match &run.input.prompt {
                PromptContent::Text(text) => text.clone(),
                other => format!("{other:?}"),
            };
            super::testing::lock(&noted).push(text);
            tokio::select! {
                () = run.cancel.cancelled() => RunOutcome::Interrupted,
                () = done.notified() => RunOutcome::Completed(Default::default()),
            }
        })
    }));
    (seen, finish)
}

/// The `work_stop{stopped}` bodies the store holds for the thread.
fn stopped_bodies(rig: &Rig, handle: &SessionHandle) -> Vec<Value> {
    use mixdog_store::schema::blob::Slot;
    use mixdog_store::schema::record::Record;
    use mixdog_store::schema::record::WorkStopPhase;
    rig.store
        .records(&handle.id)
        .into_iter()
        .filter_map(|(_, record)| match record {
            Record::WorkStop(stop) if stop.phase == WorkStopPhase::Stopped => match stop.body {
                Some(Slot::Inline(body)) => Some(body),
                _ => None,
            },
            _ => None,
        })
        .collect()
}

/// The queue ids the store holds a promotion (`queue{prioritize}`) of.
fn promotions(rig: &Rig, handle: &SessionHandle) -> Vec<String> {
    use mixdog_store::schema::record::QueueAction;
    use mixdog_store::schema::record::Record;
    rig.store
        .records(&handle.id)
        .into_iter()
        .filter_map(|(_, record)| match record {
            Record::Queue(queue) if queue.action == QueueAction::Prioritize => Some(queue.qid.as_str().to_owned()),
            _ => None,
        })
        .collect()
}

/// A takeover ends the running turn taken over by the queued message it names, and that message starts the next turn: the
/// receipt says so, the turn's live end and the end a reload reads back carry the `message` cause, the stop's record names the
/// message, and a repeat of the operation is answered the same receipt and does nothing more. The user's own Stop while the
/// message waits ends the turn cancelled, with no cause, both ways.
#[tokio::test(start_paused = true)]
async fn a_turn_taken_over_by_a_message_ends_with_its_cause_live_and_after_a_reload() {
    use mixdog_protocol::ThreadItem;
    use std::sync::atomic::Ordering::SeqCst;

    for takeover in [true, false] {
        let rig = Rig::new();
        let (seen, finish) = working(&rig);
        let directory = SessionDirectory::new(rig.deps());
        let handle = start_thread(&directory).await;
        turn(&handle, "work", "op-1").await;
        let running = eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load_full()).await.turn.clone();
        let queued = queued_id(&turn(&handle, "next", "op-2").await);
        let accepted = json!({
            "kind": "accepted", "turnId": running, "queuedId": queued, "interruptRequested": true, "message": "successor",
        });
        if takeover {
            assert_eq!(take_over(&handle, running.as_str(), &queued, "send-now").await, accepted);
        } else {
            let stop = Stop { turn: None, restore_prompt: Some(false), submission_id: None, ctx: CallContext::internal("test") };
            handle.stop(stop).await.expect("stop");
        }
        let thread = handle.id.as_str().to_owned();
        let live = eventually_on!(&[&rig.feeds.published], || failed_end_frame(&rig, &thread)).await;
        let end_of = |item: &ThreadItem| match item {
            ThreadItem::TurnEnd { status, meta, .. } => Some((serde_json::to_value(status).expect("status"), meta.ext.get("cause").cloned())),
            _ => None,
        };
        let cause = takeover.then(|| json!("message"));
        assert_eq!(end_of(&live), Some((json!("cancelled"), cause.clone())), "the live end (takeover {takeover}): {live:?}");
        // The message is the next turn's input.
        eventually_on!(&[&handle.cell.stepped], || (*super::testing::lock(&seen) == ["work", "next"]).then_some(())).await;
        if takeover {
            let successor = handle.cell.run.load_full().expect("the message's turn runs").turn.clone();
            let record = handle.cell.stop_latches.takeover(&handle.id).expect("the takeover's record");
            assert_eq!((record.turn, record.message, record.successor), (running.clone(), queued.clone(), Some(successor)), "one record of the transition");
            let note = json!({ "op": "send-now", "message": queued });
            assert_eq!(stopped_bodies(&rig, &handle).iter().map(|body| body["takeover"].clone()).collect::<Vec<_>>(), [note]);
            assert_eq!(promotions(&rig, &handle), [queued.clone()]);
            // A repeat of the operation: the first receipt, and nothing of the turn that runs now is touched.
            assert_eq!(take_over(&handle, running.as_str(), &queued, "send-now").await, accepted);
            assert!(!handle.cell.run.load_full().expect("still running").cancel.is_aborted(), "the repeat stopped nothing");
            assert_eq!(stopped_bodies(&rig, &handle).len(), 1);
        }
        finish.notify_one();
        eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && !handle.cell.busy.load(SeqCst)).then_some(())).await;

        let mut restoring = rig.deps_parts(rig.store.clone());
        restoring.transcript = Arc::new(super::testing::RecordTranscript::new());
        let history = SessionDirectory::new(Arc::new(restoring)).history_items(&handle.id).await.expect("history");
        let ends: Vec<_> = history.iter().filter_map(end_of).filter(|(status, _)| *status == json!("cancelled")).collect();
        assert_eq!(ends, [(json!("cancelled"), cause)], "the reloaded end (takeover {takeover}): {history:?}");
        let elapsed = |item: &ThreadItem| match item {
            ThreadItem::TurnEnd { elapsed_ms, .. } => Some(*elapsed_ms),
            _ => None,
        };
        assert_eq!(history.iter().find_map(elapsed), elapsed(&live), "the reloaded end keeps the live end's duration: {history:?}");
    }
}

/// A run of `work` holds its end after its cancel until `gate` opens, so later stops reach it while it is still running; any
/// other run ends once its input is durable.
fn held_after_cancel(rig: &Rig) -> Arc<tokio::sync::Notify> {
    use mixdog_protocol::PromptContent;
    let gate = Arc::new(tokio::sync::Notify::new());
    let held = gate.clone();
    rig.set_script(Arc::new(move |run| {
        let held = held.clone();
        Box::pin(async move {
            if run.port.input_durable().await.is_err() {
                return RunOutcome::Interrupted;
            }
            if matches!(&run.input.prompt, PromptContent::Text(text) if text == "work") {
                run.cancel.cancelled().await;
                held.notified().await;
                return RunOutcome::Interrupted;
            }
            RunOutcome::Completed(Default::default())
        })
    }));
    gate
}

/// A stop the core accepted is published: the running turn's spinner reads `stopping` from the Stop on, and it goes with
/// the spinner at the turn's end. A refused Stop (it names a turn that does not run) and a takeover (a message sent now is
/// no stop) publish none.
#[tokio::test(start_paused = true)]
async fn an_accepted_stop_shows_the_turn_stopping_and_a_refused_stop_or_a_takeover_does_not() {
    use std::sync::atomic::Ordering::SeqCst;
    let rig = Rig::new();
    let gate = held_after_cancel(&rig);
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    // Each published runtime section's spinner, in order.
    let spinners = || -> Vec<Value> {
        let runtimes = rig.feeds.frames(handle.id.as_str()).into_iter().filter(|(_, method, _)| method == "thread/runtime/updated");
        runtimes.map(|(_, _, params)| params["value"]["spinner"].clone()).collect()
    };
    let stopping = |from: usize| spinners()[from..].iter().any(|spinner| spinner["stopping"] == json!(true));
    let settled = || idle(&handle) && !handle.cell.busy.load(SeqCst) && handle.cell.unacked.load(SeqCst) == 0;
    let stop = |turn: &str| Stop {
        turn: Some(mixdog_core_api::ids::TurnId::from(turn)),
        restore_prompt: Some(false),
        submission_id: None,
        ctx: CallContext::internal("test"),
    };

    turn(&handle, "work", "op-1").await;
    let running = eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load_full()).await.turn.clone();
    eventually_on!(&[&handle.cell.stepped], || spinners().last().is_some_and(|spinner| !spinner.is_null()).then_some(())).await;
    let refusal = handle.stop(stop("turn-before")).await;
    assert!(refusal.is_err(), "a stop naming a turn that does not run is refused: {refusal:?}");
    assert!(!stopping(0), "a refused stop shows nothing stopping: {:?}", spinners());
    handle.stop(stop(running.as_str())).await.expect("the user's stop");
    eventually_on!(&[&handle.cell.stepped], || stopping(0).then_some(())).await;
    assert_eq!(spinners().last().map(|spinner| spinner["stopping"].clone()), Some(json!(true)), "it stays while the turn closes");
    gate.notify_one();
    eventually_on!(&[&handle.cell.stepped], || settled().then_some(())).await;
    assert_eq!(spinners().last(), Some(&Value::Null), "it goes with the spinner at the turn's end");

    let before = spinners().len();
    turn(&handle, "work", "op-2").await;
    let running = eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load_full()).await.turn.clone();
    let queued = queued_id(&turn(&handle, "next", "op-3").await);
    let accepted = take_over(&handle, running.as_str(), &queued, "press-1").await;
    assert_eq!((accepted["kind"].clone(), accepted["interruptRequested"].clone()), (json!("accepted"), json!(true)));
    gate.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (settled() && handle.cell.queue.load().is_empty()).then_some(())).await;
    assert!(spinners().len() > before, "the turns published their spinner");
    assert!(!stopping(before), "a takeover is no stop: {:?}", &spinners()[before..]);
}

/// A Stop that reaches the running turn from outside the thread's task ([`super::control::ControlCell::interrupt`]) is
/// published as one the task decided is: the spinner reads `stopping` while the turn closes, and it goes with the spinner
/// at the turn's end.
#[tokio::test(start_paused = true)]
async fn a_stop_from_outside_the_task_shows_the_turn_stopping_until_its_end() {
    use std::sync::atomic::Ordering::SeqCst;
    let rig = Rig::new();
    let gate = held_after_cancel(&rig);
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let spinners = || -> Vec<Value> {
        let runtimes = rig.feeds.frames(handle.id.as_str()).into_iter().filter(|(_, method, _)| method == "thread/runtime/updated");
        runtimes.map(|(_, _, params)| params["value"]["spinner"].clone()).collect()
    };
    turn(&handle, "work", "op-1").await;
    let running = eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load_full()).await.turn.clone();
    eventually_on!(&[&handle.cell.stepped], || spinners().last().is_some_and(|spinner| !spinner.is_null()).then_some(())).await;
    assert!(spinners().iter().all(|spinner| spinner["stopping"] != json!(true)), "nothing is stopping before the stop");
    handle.cell.interrupt(&running, None).expect("the stop is accepted");
    eventually_on!(&[&handle.cell.stepped], || (spinners().last().map(|spinner| spinner["stopping"].clone()) == Some(json!(true))).then_some(())).await;
    gate.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && !handle.cell.busy.load(SeqCst) && handle.cell.unacked.load(SeqCst) == 0).then_some(())).await;
    assert_eq!(spinners().last(), Some(&Value::Null), "it goes with the spinner at the turn's end");
}

/// A takeover names the turn it takes over: one naming another turn (the turn before, already ended) is refused with its
/// message still queued, one naming none is no takeover, and neither touches the turn that runs or the queue.
#[tokio::test(start_paused = true)]
async fn a_takeover_leaves_a_turn_it_does_not_name_alone() {
    let rig = Rig::new();
    let _gate = held_after_cancel(&rig);
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "work", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load_full().map(|_| ())).await;
    let queued = queued_id(&turn(&handle, "next", "op-2").await);
    let stale = take_over(&handle, "turn-before", &queued, "send-now-1").await;
    assert_eq!(stale, refused("turn-before", &queued, "turnMismatch", "queued"));
    let unnamed = call(&handle, "turn/takeover", json!({ "queuedId": queued }), "send-now-2").await;
    assert!(matches!(unnamed, Err(CoreError::InvalidParams { .. })), "{unnamed:?}");
    let run = handle.cell.run.load_full().expect("the turn still runs");
    assert!(!run.cancel.is_aborted(), "the running turn was not stopped");
    assert!(stopped_bodies(&rig, &handle).is_empty() && promotions(&rig, &handle).is_empty(), "nothing was recorded");
    assert_eq!(handle.cell.queue.load().iter().map(|entry| entry.qid.clone()).collect::<Vec<_>>(), [queued], "the message waits as it did");
    assert_eq!(handle.cell.stop_latches.takeover(&handle.id), None);
}

/// A Stop that ended the run decides how its end reads: a takeover reaching the run while it closes is refused, with its
/// message still queued, and does not make the user's Stop read as a turn taken over.
#[tokio::test(start_paused = true)]
async fn a_takeover_behind_a_stop_leaves_the_end_cancelled() {
    use mixdog_protocol::ThreadItem;
    let rig = Rig::new();
    let gate = held_after_cancel(&rig);
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "work", "op-1").await;
    let running = eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load_full()).await.turn.clone();
    let stop = Stop { turn: Some(running.clone()), restore_prompt: Some(false), submission_id: None, ctx: CallContext::internal("test") };
    handle.stop(stop).await.expect("the user's stop");
    let queued = queued_id(&turn(&handle, "next", "op-2").await);
    let late = take_over(&handle, running.as_str(), &queued, "send-now").await;
    assert_eq!(late, refused(running.as_str(), &queued, "stopClaimed", "queued"));
    assert!(promotions(&rig, &handle).is_empty() && handle.cell.stop_latches.takeover(&handle.id).is_none(), "the Stop's transition is not relabelled");
    gate.notify_one();
    let thread = handle.id.as_str().to_owned();
    let live = eventually_on!(&[&rig.feeds.published], || failed_end_frame(&rig, &thread)).await;
    let ThreadItem::TurnEnd { meta, .. } = &live else { panic!("a turn end: {live:?}") };
    assert_eq!(meta.ext.get("cause"), None, "the Stop's end reads cancelled: {live:?}");
}

/// The other order: a Stop, or a second takeover, reaching the turn a takeover already won changes nothing of it. The end
/// reads taken over by the first message, which stays the next turn's input.
#[tokio::test(start_paused = true)]
async fn a_stop_or_another_takeover_behind_a_takeover_leaves_the_end_taken_over() {
    use mixdog_protocol::ThreadItem;
    let rig = Rig::new();
    let gate = held_after_cancel(&rig);
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "work", "op-1").await;
    let running = eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load_full()).await.turn.clone();
    let first = queued_id(&turn(&handle, "next", "op-2").await);
    let second = queued_id(&turn(&handle, "other", "op-3").await);
    assert_eq!(take_over(&handle, running.as_str(), &first, "send-now-1").await["kind"], json!("accepted"));
    assert_eq!(take_over(&handle, running.as_str(), &second, "send-now-2").await, refused(running.as_str(), &second, "takenOver", "queued"));
    let stop = Stop { turn: Some(running.clone()), restore_prompt: Some(false), submission_id: None, ctx: CallContext::internal("test") };
    handle.stop(stop).await.expect("the late stop");
    assert_eq!(handle.cell.stop_latches.takeover(&handle.id).map(|record| record.message), Some(first.clone()));
    assert_eq!(promotions(&rig, &handle), [first]);
    gate.notify_one();
    let thread = handle.id.as_str().to_owned();
    let live = eventually_on!(&[&rig.feeds.published], || failed_end_frame(&rig, &thread)).await;
    let ThreadItem::TurnEnd { meta, .. } = &live else { panic!("a turn end: {live:?}") };
    assert_eq!(meta.ext.get("cause"), Some(&json!("message")), "the takeover's end keeps its cause: {live:?}");
}

/// Review finding 1, one order: the running turn reached a model-call boundary and took the queued message in before the
/// takeover arrived. The message is that turn's input now, so the takeover is refused (`consumed`) and the turn that holds it
/// is not stopped.
#[tokio::test(start_paused = true)]
async fn a_message_a_boundary_already_took_is_not_taken_over() {
    use super::run::DrainRequest;
    use super::run::DrainStage;
    use super::run::Priority;
    use std::sync::atomic::Ordering::SeqCst;
    let rig = Rig::new();
    let (at_boundary, finish): (Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>) = Default::default();
    let taken: Arc<std::sync::Mutex<Vec<String>>> = Arc::default();
    let runs: Arc<std::sync::atomic::AtomicUsize> = Arc::default();
    rig.set_script(Arc::new({
        let (at_boundary, finish, taken, runs) = (at_boundary.clone(), finish.clone(), taken.clone(), runs.clone());
        move |run| {
            let (at_boundary, finish, taken, runs) = (at_boundary.clone(), finish.clone(), taken.clone(), runs.clone());
            Box::pin(async move {
                run.port.input_durable().await.expect("input durable");
                runs.fetch_add(1, SeqCst);
                at_boundary.notified().await;
                let steers = run.port.take_steers(DrainRequest { stage: DrainStage::PreSend, max_priority: Priority::Next }).await.expect("take");
                super::testing::lock(&taken).extend(steers.iter().map(|steer| steer.content.as_str().unwrap_or_default().to_owned()));
                tokio::select! {
                    () = run.cancel.cancelled() => RunOutcome::Interrupted,
                    () = finish.notified() => RunOutcome::Completed(Default::default()),
                }
            })
        }
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "work", "op-1").await;
    let run = eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load_full()).await;
    let queued = queued_id(&turn(&handle, "next", "op-2").await);
    at_boundary.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (*super::testing::lock(&taken) == ["next"]).then_some(())).await;
    let receipt = take_over(&handle, run.turn.as_str(), &queued, "send-now").await;
    assert_eq!(receipt, refused(run.turn.as_str(), &queued, "tooLate", "consumed"));
    assert!(!run.cancel.is_aborted(), "the turn that took the message in is not stopped");
    assert!(stopped_bodies(&rig, &handle).is_empty());
    finish.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && !handle.cell.busy.load(SeqCst)).then_some(())).await;
    assert_eq!(runs.load(SeqCst), 1, "the message ran in the turn that took it, and in no other");
}

/// Review finding 1, the other order: the takeover won, and the turn it ends reaches a boundary afterwards. The boundary takes
/// neither the message nor anything behind it: the message starts the next turn.
#[tokio::test(start_paused = true)]
async fn a_boundary_of_a_turn_being_taken_over_takes_nothing_and_the_message_starts_the_next_turn() {
    use super::run::DrainRequest;
    use super::run::DrainStage;
    use super::run::Priority;
    use mixdog_protocol::PromptContent;
    use std::sync::atomic::Ordering::SeqCst;
    let rig = Rig::new();
    let seen: Arc<std::sync::Mutex<Vec<String>>> = Arc::default();
    let taken: Arc<std::sync::Mutex<Option<Vec<String>>>> = Arc::default();
    rig.set_script(Arc::new({
        let (seen, taken) = (seen.clone(), taken.clone());
        move |run| {
            let (seen, taken) = (seen.clone(), taken.clone());
            Box::pin(async move {
                run.port.input_durable().await.expect("input durable");
                let PromptContent::Text(text) = &run.input.prompt else { panic!("a text prompt") };
                super::testing::lock(&seen).push(text.clone());
                if text != "work" {
                    return RunOutcome::Completed(Default::default());
                }
                run.cancel.cancelled().await;
                let steers = run.port.closing().take_steers(DrainRequest { stage: DrainStage::Terminal, max_priority: Priority::Later }).await.expect("take");
                *super::testing::lock(&taken) = Some(steers.iter().map(|steer| steer.content.as_str().unwrap_or_default().to_owned()).collect());
                RunOutcome::Interrupted
            })
        }
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "work", "op-1").await;
    let running = eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load_full()).await.turn.clone();
    let queued = queued_id(&turn(&handle, "next", "op-2").await);
    queued_id(&turn(&handle, "after", "op-3").await);
    assert_eq!(take_over(&handle, running.as_str(), &queued, "send-now").await["kind"], json!("accepted"));
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && !handle.cell.busy.load(SeqCst) && handle.cell.queue.load().is_empty()).then_some(())).await;
    assert_eq!(*super::testing::lock(&taken), Some(Vec::new()), "the ending turn's boundary took nothing");
    assert_eq!(*super::testing::lock(&seen), ["work", "next", "after"], "the message started the next turn, ahead of what was queued behind it");
}

/// Review finding 2: the turn the user saw ended on its own and the queued message started its own turn before the takeover
/// arrived. The takeover names the turn that is gone: it is refused, and the turn the message started is not cancelled.
#[tokio::test(start_paused = true)]
async fn the_turn_a_queued_message_started_is_not_cancelled_by_a_takeover_of_the_turn_before_it() {
    let rig = Rig::new();
    let (seen, finish) = working(&rig);
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "work", "op-1").await;
    let before = eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load_full()).await.turn.clone();
    let queued = queued_id(&turn(&handle, "next", "op-2").await);
    finish.notify_one();
    let successor = eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load_full().filter(|run| run.turn != before)).await;
    eventually_on!(&[&handle.cell.stepped], || (*super::testing::lock(&seen) == ["work", "next"]).then_some(())).await;
    let receipt = take_over(&handle, before.as_str(), &queued, "send-now").await;
    assert_eq!(receipt, refused(before.as_str(), &queued, "tooLate", "consumed"));
    assert!(!successor.cancel.is_aborted(), "the turn the message started is not cancelled");
    assert!(stopped_bodies(&rig, &handle).is_empty() && handle.cell.stop_latches.takeover(&handle.id).is_none());
}

/// Review finding 3: a room log runs no turn, so a takeover on it names no running turn. It is refused before anything of the
/// room is stopped.
#[tokio::test(start_paused = true)]
async fn a_takeover_on_a_room_log_is_refused_and_stops_no_member_work() {
    let rig = Rig::new();
    rig.room_members.hosted.lock().unwrap().insert("room01".into(), true);
    let id = mixdog_core_api::ids::ThreadId::from("sess_room_room01");
    let directory = SessionDirectory::new(rig.deps());
    directory.create_with_id(id.clone(), json!({ "cwd": "/ws" }).as_object().cloned().expect("object"), json!({})).await.expect("create");
    let handle = directory.open_handle(&id, &CallContext::internal("test")).await.expect("open");
    assert_eq!(take_over(&handle, "turn-gone", "q-1", "send-now-1").await, refused("turn-gone", "q-1", "noRunningTurn", "consumed"));
    let missing = call(&handle, "turn/takeover", json!({ "queuedId": "q-1" }), "send-now-2").await;
    assert!(matches!(missing, Err(CoreError::InvalidParams { .. })), "{missing:?}");
    assert!(rig.room_members.stopped.lock().unwrap().is_empty(), "no member work was stopped");
}

/// Review finding 5: the named turn finished on its own and its end is parked behind a row being read, with a task-completion
/// wake and the message next in line. The turn is not interrupted and reads as finished; the message is taken as the next
/// turn's input, and the receipt says so; the wake is not recorded as stopped and runs after it.
#[tokio::test(start_paused = true)]
async fn a_takeover_of_a_turn_at_its_end_interrupts_nothing_and_the_wake_behind_it_runs() {
    use super::run::ItemCommit;
    use mixdog_core_api::ids::ItemId;
    use mixdog_protocol::PromptContent;
    use std::sync::atomic::Ordering::SeqCst;
    let rig = Rig::new();
    let emit = Arc::new(tokio::sync::Notify::new());
    let seen: Arc<std::sync::Mutex<Vec<String>>> = Arc::default();
    rig.set_script(Arc::new({
        let (emit, seen) = (emit.clone(), seen.clone());
        move |run| {
            let (emit, seen) = (emit.clone(), seen.clone());
            Box::pin(async move {
                run.port.input_durable().await.expect("input durable");
                let PromptContent::Text(text) = &run.input.prompt else { panic!("a text prompt") };
                super::testing::lock(&seen).push(text.clone());
                if text == "work" {
                    emit.notified().await;
                    let body = json!({ "text": "done" });
                    let item = ItemCommit { iid: ItemId::from("a-1"), role: Some("assistant".into()), model: true, visible: true, body, prompt: None };
                    let _queued = run.port.queue_item(item).await.expect("queued");
                }
                RunOutcome::Completed(Default::default())
            })
        }
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "work", "op-1").await;
    let active = eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load_full()).await;
    let queued = queued_id(&turn(&handle, "next", "op-2").await);
    directory.queue_completion_durably(&handle.id, "shell", "job-b", "completed", "job-b finished.".into()).await.expect("the wake is queued");
    let io = mixdog_rt::testing::hold_full(mixdog_rt::LaneKind::InteractiveIo);
    emit.notify_one();
    io.met_by_a_submit().await;
    let parked = || stop_ledger(&handle).iter().any(|event| event.starts_with("run:end-parked:"));
    eventually_on!(&[&handle.cell.stepped], || parked().then_some(())).await;
    let receipt = take_over(&handle, active.turn.as_str(), &queued, "send-now").await;
    let next = json!({ "kind": "accepted", "turnId": active.turn, "queuedId": queued, "interruptRequested": false, "message": "successor" });
    assert_eq!(receipt, next);
    assert!(!active.cancel.is_aborted(), "the finished run's token was not aborted");
    assert!(!stop_ledger(&handle).iter().any(|event| event.starts_with("stop:frozen:")), "{:?}", stop_ledger(&handle));
    drop(io);
    eventually_on!(&[&handle.cell.stepped], || (super::testing::lock(&seen).len() == 3).then_some(())).await;
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && !handle.cell.busy.load(SeqCst)).then_some(())).await;
    let ran = super::testing::lock(&seen).clone();
    assert_eq!(ran[..2], ["work", "next"], "the message is the next turn: {ran:?}");
    assert!(ran[2].contains("job-b"), "the wake runs after it: {ran:?}");
    assert!(stopped_bodies(&rig, &handle).is_empty(), "nothing was recorded as stopped");
    let ended: Vec<_> = rig
        .store
        .records(&handle.id)
        .into_iter()
        .filter_map(|(_, record)| match record {
            mixdog_store::schema::record::Record::Run(run) if run.phase != mixdog_store::schema::record::RunPhase::Started => Some(run.phase),
            _ => None,
        })
        .collect();
    assert!(ended.iter().all(|phase| *phase == mixdog_store::schema::record::RunPhase::Completed), "every turn reads finished: {ended:?}");
}

/// Two presses on a turn already at its end, each naming another queued message under its own operation id: the first is
/// taken as the next turn, the second is refused as the turn is taken, and the first message is the next turn's input.
#[tokio::test(start_paused = true)]
async fn a_second_takeover_of_a_turn_at_its_end_is_refused_and_the_first_message_is_next() {
    use super::run::ItemCommit;
    use mixdog_core_api::ids::ItemId;
    use mixdog_protocol::PromptContent;
    use std::sync::atomic::Ordering::SeqCst;
    let rig = Rig::new();
    let emit = Arc::new(tokio::sync::Notify::new());
    let seen: Arc<std::sync::Mutex<Vec<String>>> = Arc::default();
    rig.set_script(Arc::new({
        let (emit, seen) = (emit.clone(), seen.clone());
        move |run| {
            let (emit, seen) = (emit.clone(), seen.clone());
            Box::pin(async move {
                run.port.input_durable().await.expect("input durable");
                let PromptContent::Text(text) = &run.input.prompt else { panic!("a text prompt") };
                super::testing::lock(&seen).push(text.clone());
                if text == "work" {
                    emit.notified().await;
                    let body = json!({ "text": "done" });
                    let item = ItemCommit { iid: ItemId::from("a-1"), role: Some("assistant".into()), model: true, visible: true, body, prompt: None };
                    let _queued = run.port.queue_item(item).await.expect("queued");
                }
                RunOutcome::Completed(Default::default())
            })
        }
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "work", "op-1").await;
    let active = eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load_full()).await;
    let first = queued_id(&turn(&handle, "one", "op-2").await);
    let second = queued_id(&turn(&handle, "two", "op-3").await);
    let io = mixdog_rt::testing::hold_full(mixdog_rt::LaneKind::InteractiveIo);
    emit.notify_one();
    io.met_by_a_submit().await;
    eventually_on!(&[&handle.cell.stepped], || stop_ledger(&handle).iter().any(|event| event.starts_with("run:end-parked:")).then_some(())).await;
    // The second message stands ahead of the first only if its press is taken: it is pressed last, on the same turn.
    let taken = take_over(&handle, active.turn.as_str(), &first, "press-1").await;
    assert_eq!(taken, json!({ "kind": "accepted", "turnId": active.turn, "queuedId": first, "interruptRequested": false, "message": "successor" }));
    let late = take_over(&handle, active.turn.as_str(), &second, "press-2").await;
    assert_eq!(late, refused(active.turn.as_str(), &second, "takenOver", "queued"));
    assert_eq!(handle.cell.stop_latches.takeover(&handle.id).map(|record| record.message), Some(first.clone()), "the first press holds the turn");
    assert_eq!(promotions(&rig, &handle), [first], "only the first message was put at the front");
    drop(io);
    eventually_on!(&[&handle.cell.stepped], || (super::testing::lock(&seen).len() == 3).then_some(())).await;
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && !handle.cell.busy.load(SeqCst)).then_some(())).await;
    assert_eq!(*super::testing::lock(&seen), ["work", "one", "two"], "the receipt's successor is the turn that ran next");
}

/// A press whose turn this thread's task does not run asks the op index alone for its receipt: the thread's log is not read
/// to learn that the operation is new.
#[tokio::test(start_paused = true)]
async fn a_press_naming_a_turn_that_is_not_running_reads_no_log_for_its_receipt() {
    let rig = Rig::new();
    let (_seen, _finish) = working(&rig);
    let counted = super::testing::CallCounted::new(rig.store.clone());
    let directory = SessionDirectory::new(Arc::new(rig.deps_parts(counted.clone())));
    let handle = start_thread(&directory).await;
    turn(&handle, "work", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load_full().map(|_| ())).await;
    let queued = queued_id(&turn(&handle, "next", "op-2").await);
    assert_eq!(take_over(&handle, "turn-before", &queued, "press-1").await, refused("turn-before", &queued, "turnMismatch", "queued"));
    let calls = counted.calls();
    assert!(calls.contains(&"thread_op"), "the index is asked: {calls:?}");
    assert!(!calls.contains(&"committed_op"), "the log is not scanned for it: {calls:?}");
}

/// Over the real store (log and op index): after the core restarts, a repeat of a press that was accepted, and of one that
/// was refused, is answered its first receipt from the index, with the thread reopened on the same store. Nothing is decided
/// again: no message is delivered a second time, and the turn then running is not stopped.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_repeat_of_a_takeover_after_a_restart_on_the_real_store_is_answered_its_first_receipt() {
    use std::sync::atomic::Ordering::SeqCst;
    let data = tempfile::tempdir().expect("data dir");
    let store = super::tests::real_store(data.path()).await;
    let rig = Rig::new();
    let (seen, finish) = working(&rig);
    let directory = SessionDirectory::new(rig.deps_on(store.clone()));
    let handle = start_thread(&directory).await;
    turn(&handle, "work", "op-1").await;
    let running = eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load_full()).await.turn.clone();
    let queued = queued_id(&turn(&handle, "next", "op-2").await);
    let refusal = take_over(&handle, "turn-before", &queued, "press-1").await;
    assert_eq!(refusal, refused("turn-before", &queued, "turnMismatch", "queued"));
    let accepted = take_over(&handle, running.as_str(), &queued, "press-2").await;
    assert_eq!(accepted["kind"], json!("accepted"));
    assert_eq!(accepted["message"], json!("successor"));
    eventually_on!(&[&handle.cell.stepped], || (*super::testing::lock(&seen) == ["work", "next"]).then_some(())).await;
    finish.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && !handle.cell.busy.load(SeqCst) && handle.cell.unacked.load(SeqCst) == 0).then_some(())).await;

    let restarted = SessionDirectory::new(rig.deps_on(store));
    let reopened = restarted.open_handle(&handle.id, &CallContext::internal("test")).await.expect("the thread reopens");
    turn(&reopened, "later", "op-3").await;
    let later = eventually_on!(&[&reopened.cell.stepped], || reopened.cell.run.load_full()).await;
    eventually_on!(&[&reopened.cell.stepped], || (*super::testing::lock(&seen) == ["work", "next", "later"]).then_some(())).await;
    assert_eq!(take_over(&reopened, running.as_str(), &queued, "press-2").await, accepted, "the accepted press reads accepted");
    assert_eq!(take_over(&reopened, "turn-before", &queued, "press-1").await, refusal, "the refused press reads refused");
    let other = call(&reopened, "turn/takeover", json!({ "turnId": running, "queuedId": "another" }), "press-2").await;
    assert!(matches!(other, Err(CoreError::OpIdConflict { .. })), "an operation id names one press: {other:?}");
    assert!(!later.cancel.is_aborted(), "the turn now running is not stopped");
    assert_eq!(reopened.cell.run.load_full().map(|run| run.turn.clone()), Some(later.turn.clone()), "and still runs");
    assert_eq!(*super::testing::lock(&seen), ["work", "next", "later"], "nothing is delivered a second time");
    finish.notify_one();
    eventually_on!(&[&reopened.cell.stepped], || idle(&reopened).then_some(())).await;
}

/// The index is known to lack rows of the thread (it refused a projection in this process): an operation it holds no row of
/// may still be in the log, so a press under such an id is answered an error and decides nothing, while a press whose row
/// the index holds is still answered its receipt.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_takeover_whose_receipt_the_index_may_lack_is_answered_an_error_and_decided_nothing() {
    use mixdog_core_api::domain::mock::MockOwnership;
    use mixdog_store::sqlite::SqliteStore;
    use std::sync::atomic::Ordering::SeqCst;
    let data = tempfile::tempdir().expect("data dir");
    let tokens = mixdog_rt::testing::tokens();
    let root = data.path().to_path_buf();
    let index = mixdog_rt::LaneToken::submit(tokens.maintenance_io, &CancellationToken::new(), move |lane| {
        SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &root)
    })
    .expect("lane")
    .await
    .expect("job ran")
    .expect("index");
    let ownership = Arc::new(MockOwnership::default());
    let store = Arc::new(super::StoreThreads::over_data_dir(data.path(), index, ownership, tokens.maintenance_io).await.expect("the thread store"));
    let rig = Rig::new();
    let (seen, finish) = working(&rig);
    let directory = SessionDirectory::new(rig.deps_on(store.clone()));
    let handle = start_thread(&directory).await;
    turn(&handle, "work", "op-1").await;
    let running = eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load_full()).await.turn.clone();
    let queued = queued_id(&turn(&handle, "next", "op-2").await);
    let accepted = take_over(&handle, running.as_str(), &queued, "press-1").await;
    assert_eq!(accepted["kind"], json!("accepted"));
    eventually_on!(&[&handle.cell.stepped], || (*super::testing::lock(&seen) == ["work", "next"]).then_some(())).await;
    finish.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && !handle.cell.busy.load(SeqCst) && handle.cell.unacked.load(SeqCst) == 0).then_some(())).await;

    // The thread is unloaded and loaded again in the same process: its task remembers no operation.
    directory.release(&handle.id).await;
    assert!(directory.handle(&handle.id).is_none(), "the thread is unloaded");
    let reopened = directory.open_handle(&handle.id, &CallContext::internal("test")).await.expect("the thread reopens");
    turn(&reopened, "later", "op-3").await;
    let later = eventually_on!(&[&reopened.cell.stepped], || reopened.cell.run.load_full()).await;
    let waiting = queued_id(&turn(&reopened, "waiting", "op-4").await);
    store.lose_rows(handle.id.as_str());
    assert_eq!(take_over(&reopened, running.as_str(), &queued, "press-1").await, accepted, "the row the index holds answers");
    let unknown = call(&reopened, "turn/takeover", json!({ "turnId": running, "queuedId": waiting }), "press-2").await;
    assert!(matches!(unknown, Err(CoreError::Internal { .. })), "no row is not no such operation: {unknown:?}");
    assert!(!later.cancel.is_aborted(), "nothing was decided: the running turn is not stopped");
    assert!(reopened.cell.stop_latches.takeover(&reopened.id).is_none_or(|record| record.op != "press-2"), "and no takeover was recorded for the press");
    assert_eq!(*super::testing::lock(&seen), ["work", "next", "later"], "nor anything delivered");
    finish.notify_one();
    eventually_on!(&[&reopened.cell.stepped], || (*super::testing::lock(&seen) == ["work", "next", "later", "waiting"]).then_some(())).await;
    finish.notify_one();
    eventually_on!(&[&reopened.cell.stepped], || idle(&reopened).then_some(())).await;
}

/// The receipt is durable and idempotent under the operation id: what a press stored (accepted or refused) answers a repeat
/// of that press its first outcome, and decides and delivers nothing a second time. It answers only that press, to the
/// audience it was stored for: another payload under the id, or another caller, is told the id is taken and nothing more.
#[tokio::test(start_paused = true)]
async fn a_stored_takeover_receipt_answers_only_its_own_press_and_audience() {
    use super::ThreadStore as _;
    use std::sync::atomic::Ordering::SeqCst;
    let rig = Rig::new();
    let (seen, finish) = working(&rig);
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "work", "op-1").await;
    let running = eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load_full()).await.turn.clone();
    let queued = queued_id(&turn(&handle, "next", "op-2").await);
    let refusal = take_over(&handle, "turn-before", &queued, "press-1").await;
    assert_eq!(refusal, refused("turn-before", &queued, "turnMismatch", "queued"));
    let accepted = take_over(&handle, running.as_str(), &queued, "press-2").await;
    assert_eq!(accepted["kind"], json!("accepted"));
    eventually_on!(&[&handle.cell.stepped], || (*super::testing::lock(&seen) == ["work", "next"]).then_some(())).await;
    finish.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && !handle.cell.busy.load(SeqCst) && handle.cell.unacked.load(SeqCst) == 0).then_some(())).await;
    // What the log holds of each operation, as the op index hands it to a repeat after a restart.
    let stored = |op: &'static str| {
        let (store, id) = (rig.store.clone(), handle.id.clone());
        let lane = handle.deps.lanes.io;
        async move {
            mixdog_core_base::support::on_lane(lane, &CancellationToken::new(), move |lane| store.committed_op(lane, &id, op))
                .await
                .expect("the lane")
                .expect("the log is read")
                .expect("the operation is stored")
        }
    };
    let press = |turn: &str, queued: &str, op: &'static str| {
        request("turn/takeover", json!({ "threadId": handle.id, "opId": op, "turnId": turn, "queuedId": queued }), op)
    };
    let answer = |stored, req: &CoreRequest, op: &str| super::handle::stored_receipt(stored, req, OpId::from(op));
    let again = answer(stored("press-2").await, &press(running.as_str(), &queued, "press-2"), "press-2");
    assert!(matches!(again, Ok(Reply::Value(receipt)) if receipt == accepted), "the accepted press reads accepted");
    let again = answer(stored("press-1").await, &press("turn-before", &queued, "press-1"), "press-1");
    assert!(matches!(again, Ok(Reply::Value(receipt)) if receipt == refusal), "the refused press reads refused");
    let other = answer(stored("press-2").await, &press(running.as_str(), "another", "press-2"), "press-2");
    assert!(matches!(other, Err(CoreError::OpIdConflict { .. })), "an operation id names one press: {other:?}");
    let mut stranger = press(running.as_str(), &queued, "press-2");
    stranger.ctx = CallContext::internal("another-caller");
    let other = answer(stored("press-2").await, &stranger, "press-2");
    assert!(matches!(other, Err(CoreError::OpIdConflict { .. })), "another audience is not answered the receipt: {other:?}");
    assert_eq!(*super::testing::lock(&seen), ["work", "next"], "nothing is delivered a second time");
}

/// The named turn's own completion was already on its way when the takeover was decided: the run does not see the abort and
/// ends completed. The receipt states nothing the stored end contradicts (no interruption, no cause, only that the stop was
/// asked for and the message is the successor); the end reads finished, with no cause, and the message starts the next turn.
#[tokio::test(start_paused = true)]
async fn a_takeover_of_a_turn_that_completes_anyway_states_nothing_its_end_contradicts() {
    use mixdog_protocol::PromptContent;
    use mixdog_store::schema::record::Record;
    use mixdog_store::schema::record::RunPhase;
    use std::sync::atomic::Ordering::SeqCst;
    let rig = Rig::new();
    let finish = Arc::new(tokio::sync::Notify::new());
    let seen: Arc<std::sync::Mutex<Vec<String>>> = Arc::default();
    rig.set_script(Arc::new({
        let (finish, seen) = (finish.clone(), seen.clone());
        move |run| {
            let (finish, seen) = (finish.clone(), seen.clone());
            Box::pin(async move {
                run.port.input_durable().await.expect("input durable");
                let PromptContent::Text(text) = &run.input.prompt else { panic!("a text prompt") };
                super::testing::lock(&seen).push(text.clone());
                if text == "work" {
                    // Its final output is already delivered: it completes whatever its signal says.
                    finish.notified().await;
                }
                RunOutcome::Completed(Default::default())
            })
        }
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "work", "op-1").await;
    let run = eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load_full()).await;
    let queued = queued_id(&turn(&handle, "next", "op-2").await);
    let receipt = take_over(&handle, run.turn.as_str(), &queued, "send-now").await;
    let stated = json!({ "kind": "accepted", "turnId": run.turn, "queuedId": queued, "interruptRequested": true, "message": "successor" });
    assert_eq!(receipt, stated, "the receipt says what was asked and what became of the message, nothing of the end");
    assert!(run.cancel.is_aborted(), "the stop was asked for");
    finish.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (super::testing::lock(&seen).len() == 2).then_some(())).await;
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && !handle.cell.busy.load(SeqCst)).then_some(())).await;
    assert_eq!(*super::testing::lock(&seen), ["work", "next"], "the message is the next turn");
    let ended: Vec<RunPhase> = rig
        .store
        .records(&handle.id)
        .into_iter()
        .filter_map(|(_, record)| match record {
            Record::Run(run) if run.phase != RunPhase::Started => Some(run.phase),
            _ => None,
        })
        .collect();
    assert_eq!(ended, [RunPhase::Completed, RunPhase::Completed], "the turn's stored end reads finished");
    let claimed: Vec<String> = rig
        .feeds
        .frames(handle.id.as_str())
        .into_iter()
        .filter(|(_, method, params)| method == "item/completed" && params["item"]["type"] == "turnEnd")
        .map(|(_, _, params)| params["item"].to_string())
        .filter(|end| end.contains("\"cause\"") || end.contains("cancelled"))
        .collect();
    assert!(claimed.is_empty(), "no end reads cancelled or taken over: {claimed:?}");
    assert!(stopped_bodies(&rig, &handle).iter().all(|body| body["takeover"].get("cause").is_none()), "nor does the stop's record");
}

/// A failed turn's retry that was already pending does not start ahead of the message a takeover reserved the next turn
/// for: the message the user sent now runs first, the retry after it.
#[tokio::test(start_paused = true)]
async fn a_pending_retry_does_not_start_ahead_of_the_message_sent_now() {
    use mixdog_app_protocol::v2::thread::TurnInput;
    use mixdog_protocol::PromptContent;
    use std::sync::atomic::Ordering::SeqCst;
    let rig = Rig::new();
    let seen: Arc<std::sync::Mutex<Vec<String>>> = Arc::default();
    rig.set_script(Arc::new({
        let seen = seen.clone();
        move |run| {
            let seen = seen.clone();
            Box::pin(async move {
                if run.port.input_durable().await.is_err() {
                    return RunOutcome::Interrupted;
                }
                let PromptContent::Text(text) = &run.input.prompt else { panic!("a text prompt") };
                super::testing::lock(&seen).push(text.clone());
                if text != "work" {
                    return RunOutcome::Completed(Default::default());
                }
                run.cancel.cancelled().await;
                RunOutcome::Interrupted
            })
        }
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "work", "op-1").await;
    let running = eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load_full()).await.turn.clone();
    let queued = queued_id(&turn(&handle, "next", "op-2").await);
    // The retry is pending when the taken-over turn's end drains the queue.
    let retry = super::quota_lane::RetryTurn {
        input: TurnInput { prompt: PromptContent::Text("again".into()), options: None },
        hidden: false,
        provenance: None,
        prior: None,
    };
    handle.cell.stop_latches.plant_retry(&handle.id, retry);
    assert_eq!(take_over(&handle, running.as_str(), &queued, "send-now").await["kind"], json!("accepted"));
    eventually_on!(&[&handle.cell.stepped], || (super::testing::lock(&seen).len() == 3).then_some(())).await;
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && !handle.cell.busy.load(SeqCst)).then_some(())).await;
    assert_eq!(*super::testing::lock(&seen), ["work", "next", "again"]);
}

/// A Stop claims the queued message it withdraws: a takeover arriving behind it finds nothing to take, is refused as claimed
/// by the Stop, and stops nothing.
#[tokio::test(start_paused = true)]
async fn a_takeover_behind_a_stop_that_withdrew_its_message_is_refused() {
    let rig = Rig::new();
    let (seen, _finish) = working(&rig);
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "work", "op-1").await;
    let run = eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load_full()).await;
    let next = json!({ "input": { "prompt": "next", "options": { "clientSubmissionId": "sub-n" } } });
    let queued = queued_id(&call(&handle, "turn/start", next, "op-2").await.expect("queued"));
    directory.stop_work(&handle.id, vec!["sub-n".into()]).await.expect("the Stop of the queued message is saved");
    for (named, op) in [(queued.as_str(), "send-now-1"), ("sub-n", "send-now-2")] {
        assert_eq!(take_over(&handle, run.turn.as_str(), named, op).await, refused(run.turn.as_str(), named, "stopClaimed", "consumed"));
    }
    assert!(!run.cancel.is_aborted(), "the running turn is not stopped");
    assert!(promotions(&rig, &handle).is_empty() && handle.cell.stop_latches.takeover(&handle.id).is_none());
    assert_eq!(*super::testing::lock(&seen), ["work"], "the withdrawn message never runs");
}

/// A tool call a takeover cuts short reads that the turn was ended to deliver the user's message, not a Stop's cancellation,
/// and no row but the turn's own end marks the takeover.
#[tokio::test(start_paused = true)]
async fn a_tool_call_cut_short_by_a_takeover_says_the_turn_was_ended_for_the_message() {
    use super::run::ItemCommit;
    use mixdog_core_api::domain::approval::ApprovalAsk;
    use mixdog_core_api::domain::approval::ApprovalGate as _;
    use mixdog_core_api::domain::approval::ApprovalKind;
    use mixdog_core_api::ids::ItemId;
    use mixdog_protocol::PromptContent;
    use mixdog_protocol::ThreadItem;
    use std::sync::atomic::Ordering::SeqCst;
    let rig = Rig::new();
    rig.set_script(Arc::new(move |run| {
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            if !matches!(&run.input.prompt, PromptContent::Text(text) if text == "work") {
                return RunOutcome::Completed(Default::default());
            }
            let call = json!({ "id": "c1", "name": "ask_user", "arguments": { "questions": [{ "question": "Add the file?" }] } });
            let commit = |iid: &str, role: &str, body: Value| ItemCommit {
                iid: ItemId::from(iid),
                role: Some(role.into()),
                model: true,
                visible: true,
                body,
                prompt: None,
            };
            run.port.commit_item(commit("a-1", "assistant", json!({ "text": "", "toolCalls": [call] }))).await.expect("call");
            let _ = run
                .port
                .request(ApprovalAsk {
                    kind: ApprovalKind::UserInput,
                    call_id: Some("c1".into()),
                    tool: Some("ask_user".into()),
                    action_kind: None,
                    reason: None,
                    payload: json!({ "questions": [{ "question": "Add the file?" }] }),
                    remember: Vec::new(),
                    expires_after: None,
                })
                .await;
            run.port.closing().commit_item(commit("t-1", "tool", json!({ "toolCallId": "c1", "text": "Cancelled", "isError": true }))).await.expect("stub");
            RunOutcome::Interrupted
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "work", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || directory.member_approval(&handle.id).map(drop)).await;
    let running = handle.cell.run.load_full().expect("the turn runs").turn.clone();
    let queued = queued_id(&turn(&handle, "next", "op-2").await);
    assert_eq!(take_over(&handle, running.as_str(), &queued, "send-now").await["kind"], json!("accepted"));
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && !handle.cell.busy.load(SeqCst) && handle.cell.queue.load().is_empty()).then_some(())).await;
    let view = handle.cell.view.load_full();
    let result = view.items.iter().find_map(|item| match item.as_ref() {
        ThreadItem::ToolCall { run, .. } => Some(run.result.clone()),
        _ => None,
    });
    let expected =
        format!("Error: Session \"{}\" closed: runtime abort (reason=interrupt): the turn was ended to deliver the user's message", handle.id.as_str());
    assert_eq!(result, Some(Some(mixdog_protocol::MaybeBlob::Inline(expected.into()))));
    let shown = serde_json::to_string(&view.items).expect("items").to_lowercase();
    assert!(!shown.contains("user-cancel") && !shown.contains("stopped by"), "no Stop marker is written for a takeover: {shown}");
}

/// Review finding 6: an Agent's refused takeover leaves the background jobs its session started alone; they follow only a
/// takeover that ended its turn, once.
#[tokio::test(start_paused = true)]
async fn a_refused_takeover_leaves_an_agents_background_jobs_alone() {
    use std::sync::atomic::Ordering::SeqCst;
    let rig = Rig::new();
    let (_seen, _finish) = working(&rig);
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "work", "op-1").await;
    let running = eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load_full()).await.turn.clone();
    let queued = queued_id(&turn(&handle, "next", "op-2").await);
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.unacked.load(SeqCst) == 0).then_some(())).await;
    let mut header = (**handle.cell.header.load()).clone();
    header.insert("visibility".into(), json!("agent-only"));
    handle.cell.header.store(Arc::new(header));
    let aborted = || rig.signals.0.lock().unwrap().iter().filter(|signal| signal.starts_with("agent-abort:")).count();
    assert_eq!(take_over(&handle, "turn-before", &queued, "send-now-1").await["kind"], json!("refused"));
    assert_eq!(take_over(&handle, running.as_str(), "not-queued", "send-now-2").await["kind"], json!("refused"));
    assert_eq!(aborted(), 0, "a refused takeover signals no abort of the agent's jobs");
    assert_eq!(take_over(&handle, running.as_str(), &queued, "send-now-3").await["kind"], json!("accepted"));
    assert_eq!(take_over(&handle, running.as_str(), &queued, "send-now-3").await["kind"], json!("accepted"));
    assert_eq!(aborted(), 1, "the takeover that ended the turn signals it once, a repeat of it not again");
}

/// Review finding 7: a room's Stop, from outside the thread's task, wins the turn's abort between the takeover's checks and
/// its own abort. The takeover lost: it is refused, records nothing, and the turn's end reads cancelled, not taken over.
#[tokio::test(start_paused = true)]
async fn a_stop_from_outside_that_wins_the_abort_is_not_recorded_as_a_takeover() {
    use mixdog_protocol::ThreadItem;
    use std::sync::atomic::Ordering::SeqCst;
    let rig = Rig::new();
    let gate = held_after_cancel(&rig);
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let work = json!({ "input": { "prompt": "work", "options": { "clientSubmissionId": "sub-w" } } });
    call(&handle, "turn/start", work, "op-1").await.expect("started");
    let run = eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load_full()).await;
    let queued = queued_id(&turn(&handle, "next", "op-2").await);
    // The room's Stop of the running work, landing at the takeover's fence: after its checks, before its abort.
    let (latches, thread, sealed) = (handle.cell.stop_latches.clone(), handle.id.clone(), Arc::new(std::sync::atomic::AtomicBool::new(false)));
    let fired = sealed.clone();
    *handle.cell.start_fences.lock().unwrap() = Some(Arc::new(move |fence| {
        if fence == "takeover" && !fired.swap(true, SeqCst) {
            let abort = mixdog_agent::cancel::Abort::runtime_abort(thread.as_str(), mixdog_agent::cancel::USER_CANCEL);
            latches.latch(&thread, [mixdog_store::work_stops::submission("sub-w")], &abort);
        }
    }));
    let receipt = take_over(&handle, run.turn.as_str(), &queued, "send-now").await;
    assert!(sealed.load(SeqCst), "the Stop landed inside the takeover");
    assert_eq!(receipt, refused(run.turn.as_str(), &queued, "stopClaimed", "queued"));
    assert!(run.cancel.reason().contains(mixdog_agent::cancel::USER_CANCEL), "the Stop's abort is the one that ended the run: {}", run.cancel.reason());
    assert!(promotions(&rig, &handle).is_empty() && handle.cell.stop_latches.takeover(&handle.id).is_none(), "the takeover recorded nothing");
    directory.stop_work(&handle.id, vec!["sub-w".into()]).await.expect("the room's stop is saved");
    assert!(stopped_bodies(&rig, &handle).iter().all(|body| body.get("takeover").is_none()), "the Stop's record names no takeover");
    gate.notify_one();
    let thread = handle.id.as_str().to_owned();
    let live = eventually_on!(&[&rig.feeds.published], || failed_end_frame(&rig, &thread)).await;
    let ThreadItem::TurnEnd { meta, .. } = &live else { panic!("a turn end: {live:?}") };
    assert_eq!(meta.ext.get("cause"), None, "the end reads cancelled, not taken over: {live:?}");
}

/// The successor is reserved: a submission that arrives after the taken-over turn ended and before its message started (the
/// drain waits for the ended turn's records to be saved) queues behind the message instead of starting ahead of it.
#[tokio::test(start_paused = true)]
async fn a_submission_arriving_before_the_message_started_does_not_become_the_next_turn() {
    use mixdog_protocol::PromptContent;
    use std::sync::atomic::Ordering::SeqCst;
    let rig = Rig::new();
    let gate = Arc::new(tokio::sync::Notify::new());
    let seen: Arc<std::sync::Mutex<Vec<String>>> = Arc::default();
    rig.set_script(Arc::new({
        let (gate, seen) = (gate.clone(), seen.clone());
        move |run| {
            let (gate, seen) = (gate.clone(), seen.clone());
            Box::pin(async move {
                if run.port.input_durable().await.is_err() {
                    return RunOutcome::Interrupted;
                }
                let PromptContent::Text(text) = &run.input.prompt else { panic!("a text prompt") };
                super::testing::lock(&seen).push(text.clone());
                if text != "work" {
                    return RunOutcome::Completed(Default::default());
                }
                run.cancel.cancelled().await;
                gate.notified().await;
                RunOutcome::Interrupted
            })
        }
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "work", "op-1").await;
    let running = eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load_full()).await.turn.clone();
    let queued = queued_id(&turn(&handle, "next", "op-2").await);
    assert_eq!(take_over(&handle, running.as_str(), &queued, "send-now").await["kind"], json!("accepted"));
    let disk = mixdog_rt::testing::hold_full(mixdog_rt::LaneKind::DurabilityIo);
    gate.notify_one();
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    let third = {
        let handle = handle.clone();
        tokio::spawn(async move { turn(&handle, "third", "op-3").await })
    };
    let waits = |text: &str| handle.cell.queue.load().iter().any(|entry| entry.entry["message"].to_string().contains(text));
    eventually_on!(&[&handle.cell.stepped], || waits("third").then_some(())).await;
    drop(disk);
    assert_eq!(third.await.expect("joined")["kind"], json!("queued"));
    eventually_on!(&[&handle.cell.stepped], || (super::testing::lock(&seen).len() == 3).then_some(())).await;
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && !handle.cell.busy.load(SeqCst)).then_some(())).await;
    assert_eq!(*super::testing::lock(&seen), ["work", "next", "third"]);
}

/// Cancelling while `consume_steers` or `take_steers` waits on an actor whose producer lane is paused
/// (full durability outbox) returns `RunError::Cancelled` promptly without waiting for durability, and
/// leaves queued steers uncommitted when the actor later drains the message with a closed reply channel.
#[tokio::test]
async fn cancelling_blocked_consume_or_take_steers_returns_cancelled_and_leaves_steers_queued() {
    use mixdog_core_api::ids::ItemId;
    use mixdog_core_api::ids::QueuedId;
    use mixdog_protocol::PromptContent;
    use std::sync::atomic::Ordering::SeqCst;
    use std::time::Duration;

    use super::run::DrainRequest;
    use super::run::DrainStage;
    use super::run::ItemCommit;
    use super::run::Priority;
    use super::run::RunError;

    for use_consume in [true, false] {
        let rig = Rig::new();
        let seen: Arc<std::sync::Mutex<Vec<String>>> = Arc::default();
        let steer_result: Arc<std::sync::Mutex<Option<Result<Vec<QueuedId>, RunError>>>> = Arc::default();
        let peek_ready = Arc::new(tokio::sync::Notify::new());
        let peek_done = Arc::new(tokio::sync::Notify::new());
        let fill_outbox = Arc::new(tokio::sync::Notify::new());
        let call_steer = Arc::new(tokio::sync::Notify::new());
        let entering_steer = Arc::new(tokio::sync::Notify::new());
        let steer_returned = Arc::new(tokio::sync::Notify::new());
        let release_turn1 = Arc::new(tokio::sync::Notify::new());

        rig.set_script(Arc::new({
            let (seen, steer_result, peek_ready, peek_done, fill_outbox, call_steer, entering_steer, steer_returned, release_turn1) = (
                seen.clone(),
                steer_result.clone(),
                peek_ready.clone(),
                peek_done.clone(),
                fill_outbox.clone(),
                call_steer.clone(),
                entering_steer.clone(),
                steer_returned.clone(),
                release_turn1.clone(),
            );
            move |run| {
                let (seen, steer_result, peek_ready, peek_done, fill_outbox, call_steer, entering_steer, steer_returned, release_turn1) = (
                    seen.clone(),
                    steer_result.clone(),
                    peek_ready.clone(),
                    peek_done.clone(),
                    fill_outbox.clone(),
                    call_steer.clone(),
                    entering_steer.clone(),
                    steer_returned.clone(),
                    release_turn1.clone(),
                );
                Box::pin(async move {
                    run.port.input_durable().await.expect("input durable");
                    let PromptContent::Text(text) = &run.input.prompt else { panic!("a text prompt") };
                    super::testing::lock(&seen).push(text.clone());
                    if text != "work" {
                        return RunOutcome::Completed(Default::default());
                    }

                    peek_ready.notified().await;
                    let req = DrainRequest { stage: DrainStage::PreSend, max_priority: Priority::Next };
                    let peeked = run.port.peek_steers(req).await.expect("peek steers");
                    let qids: Vec<QueuedId> = peeked.into_iter().flat_map(|s| s.queued_ids).collect();
                    assert_eq!(qids.len(), 1, "expected one peeked steer before outbox fill");
                    peek_done.notify_one();

                    fill_outbox.notified().await;
                    for i in 0..4 {
                        let item = ItemCommit {
                            iid: ItemId::from(format!("fill-{i}")),
                            role: Some("assistant".into()),
                            model: true,
                            visible: true,
                            body: json!({ "text": format!("fill-{i}") }),
                            prompt: None,
                        };
                        let _queued = run.port.queue_item(item).await.expect("queue fill item");
                    }

                    call_steer.notified().await;
                    entering_steer.notify_one();
                    let res = if use_consume { run.port.consume_steers(req, qids, 1_000).await } else { run.port.take_steers(req).await };
                    *super::testing::lock(&steer_result) = Some(res.map(|steers| steers.into_iter().flat_map(|s| s.queued_ids).collect()));
                    steer_returned.notify_one();

                    release_turn1.notified().await;
                    RunOutcome::Interrupted
                })
            }
        }));

        let mut parts = rig.deps_parts(rig.store.clone());
        parts.limits.window_records = 4;
        let directory = SessionDirectory::new(Arc::new(parts));
        let handle = start_thread(&directory).await;

        turn(&handle, "work", "op-1").await;
        eventually_on!(&[&handle.cell.stepped], || (super::testing::lock(&seen).len() == 1).then_some(())).await;

        assert_eq!(turn(&handle, "queued steer", "op-2").await["kind"], json!("queued"));
        eventually_on!(&[&handle.cell.stepped], || (handle.cell.queue.load().len() == 1 && handle.cell.unacked.load(SeqCst) == 0).then_some(())).await;

        peek_ready.notify_one();
        peek_done.notified().await;

        // Hold durability and fill the normal outbox window so the actor pauses reading `prod_rx`.
        let disk = mixdog_rt::testing::hold_full(mixdog_rt::LaneKind::DurabilityIo);
        fill_outbox.notify_one();
        eventually_on!(&[&handle.cell.stepped], || (handle.cell.unacked.load(SeqCst) >= 4).then_some(())).await;

        call_steer.notify_one();
        entering_steer.notified().await;
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(super::testing::lock(&steer_result).is_none(), "steer call must be parked waiting on blocked actor (use_consume={use_consume})");

        let stop_task = tokio::spawn({
            let handle = handle.clone();
            async move { handle.stop(stop_now()).await }
        });

        tokio::time::timeout(Duration::from_secs(5), steer_returned.notified())
            .await
            .expect("steer wait must return promptly on Stop without waiting for durability");
        assert_eq!(*super::testing::lock(&steer_result), Some(Err(RunError::Cancelled)), "expected RunError::Cancelled (use_consume={use_consume})");

        // Release durability while turn 1 is still active so the actor resumes reading `prod_rx`
        // and drains the cancelled request with a closed reply channel.
        drop(disk);
        eventually_on!(&[&handle.cell.stepped], || (handle.cell.unacked.load(SeqCst) == 0).then_some(())).await;
        super::tests::caught_up(&handle).await;

        assert_eq!(handle.cell.queue.load().len(), 1, "queued steer must stay uncommitted after draining closed reply (use_consume={use_consume})");
        let shown = serde_json::to_string(&handle.cell.view.load_full().items).expect("items");
        assert!(!shown.contains("queued steer"), "closed steer request must not commit a transcript row (use_consume={use_consume}): {shown}");

        release_turn1.notify_one();
        let stopped = stop_task.await.expect("stop task").expect("stop reply");
        assert_eq!(stopped["aborted"], json!(true), "{stopped}");

        eventually_on!(&[&handle.cell.stepped], || {
            (idle(&handle) && !handle.cell.busy.load(SeqCst) && super::testing::lock(&seen).len() == 2).then_some(())
        })
        .await;
        assert_eq!(*super::testing::lock(&seen), ["work", "queued steer"]);
        directory.shutdown().await;
    }
}

/// Defect 2: cancelling a turn while `consume_steers` is awaiting durability AFTER the session actor has
/// already dequeued the steer and queued its atomic outbox unit must NOT return `RunError::Cancelled`
/// (which would drop the already-dequeued steer); once durability finishes it returns the committed steers.
#[tokio::test]
async fn consume_steers_cancelled_during_durability_wait_returns_committed_steers() {
    use mixdog_core_api::ids::QueuedId;
    use mixdog_protocol::PromptContent;
    use std::sync::atomic::Ordering::SeqCst;
    use std::time::Duration;

    use super::run::DrainRequest;
    use super::run::DrainStage;
    use super::run::Priority;
    use super::run::RunError;

    let rig = Rig::new();
    let seen: Arc<std::sync::Mutex<Vec<String>>> = Arc::default();
    let consume_result: Arc<std::sync::Mutex<Option<Result<Vec<QueuedId>, RunError>>>> = Arc::default();
    let peek_ready = Arc::new(tokio::sync::Notify::new());
    let peek_done = Arc::new(tokio::sync::Notify::new());
    let call_consume = Arc::new(tokio::sync::Notify::new());
    let consume_returned = Arc::new(tokio::sync::Notify::new());
    let release_turn1 = Arc::new(tokio::sync::Notify::new());

    rig.set_script(Arc::new({
        let (seen, consume_result, peek_ready, peek_done, call_consume, consume_returned, release_turn1) = (
            seen.clone(),
            consume_result.clone(),
            peek_ready.clone(),
            peek_done.clone(),
            call_consume.clone(),
            consume_returned.clone(),
            release_turn1.clone(),
        );
        move |run| {
            let (seen, consume_result, peek_ready, peek_done, call_consume, consume_returned, release_turn1) = (
                seen.clone(),
                consume_result.clone(),
                peek_ready.clone(),
                peek_done.clone(),
                call_consume.clone(),
                consume_returned.clone(),
                release_turn1.clone(),
            );
            Box::pin(async move {
                run.port.input_durable().await.expect("input durable");
                let PromptContent::Text(text) = &run.input.prompt else { panic!("a text prompt") };
                super::testing::lock(&seen).push(text.clone());
                if text != "work" {
                    return RunOutcome::Completed(Default::default());
                }

                peek_ready.notified().await;
                let req = DrainRequest { stage: DrainStage::PreSend, max_priority: Priority::Next };
                let peeked = run.port.peek_steers(req).await.expect("peek steers");
                let qids: Vec<QueuedId> = peeked.into_iter().flat_map(|s| s.queued_ids).collect();
                assert_eq!(qids.len(), 1);
                peek_done.notify_one();

                call_consume.notified().await;
                let res = run.port.consume_steers(req, qids, 1_000).await;
                *super::testing::lock(&consume_result) = Some(res.map(|steers| steers.into_iter().flat_map(|s| s.queued_ids).collect()));
                consume_returned.notify_one();

                release_turn1.notified().await;
                RunOutcome::Interrupted
            })
        }
    }));

    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;

    turn(&handle, "work", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (super::testing::lock(&seen).len() == 1).then_some(())).await;

    assert_eq!(turn(&handle, "durable steer", "op-2").await["kind"], json!("queued"));
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.queue.load().len() == 1 && handle.cell.unacked.load(SeqCst) == 0).then_some(())).await;

    peek_ready.notify_one();
    peek_done.notified().await;

    // Hold durability WITHOUT filling the outbox window: the actor will process `ConsumeSteers`, mutate state
    // and dequeue the steer into the outbox, and then `consume_steers` will park awaiting durability.
    let disk = mixdog_rt::testing::hold_full(mixdog_rt::LaneKind::DurabilityIo);
    call_consume.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.queue.load().is_empty() && handle.cell.unacked.load(SeqCst) > 0).then_some(())).await;

    // Stop the turn while `consume_steers` is waiting on the durability ack of the already-dequeued steer.
    let stop_task = tokio::spawn({
        let handle = handle.clone();
        async move { handle.stop(stop_now()).await }
    });
    tokio::time::sleep(Duration::from_millis(20)).await;

    // Unblock durability: `consume_steers` must resolve with `Ok(committed)` instead of `Err(Cancelled)`.
    drop(disk);
    tokio::time::timeout(Duration::from_secs(5), consume_returned.notified()).await.expect("consume_steers resolved after durability");
    let claimed = super::testing::lock(&consume_result).clone().expect("consume result").expect("already-dequeued steer must not be reported as Cancelled");
    assert_eq!(claimed.len(), 1, "committed steer id must be returned to caller: {claimed:?}");

    release_turn1.notify_one();
    let stopped = stop_task.await.expect("stop task").expect("stop reply");
    assert_eq!(stopped["aborted"], json!(true), "{stopped}");
    directory.shutdown().await;
}

/// Defect 4: cancelling the caller token passed to `consume_steers_until` before the actor mutates state
/// returns `RunError::Cancelled` promptly without aborting the turn and leaves the steer queued.
#[tokio::test]
async fn consume_steers_until_caller_cancel_before_mutation_leaves_steer_queued() {
    use mixdog_core_api::ids::ItemId;
    use mixdog_core_api::ids::QueuedId;
    use mixdog_protocol::PromptContent;
    use std::sync::atomic::Ordering::SeqCst;
    use std::time::Duration;

    use super::run::DrainRequest;
    use super::run::DrainStage;
    use super::run::ItemCommit;
    use super::run::Priority;
    use super::run::RunError;

    let rig = Rig::new();
    let seen: Arc<std::sync::Mutex<Vec<String>>> = Arc::default();
    let consume_result: Arc<std::sync::Mutex<Option<Result<Vec<QueuedId>, RunError>>>> = Arc::default();
    let peek_ready = Arc::new(tokio::sync::Notify::new());
    let peek_done = Arc::new(tokio::sync::Notify::new());
    let fill_outbox = Arc::new(tokio::sync::Notify::new());
    let call_consume = Arc::new(tokio::sync::Notify::new());
    let consume_returned = Arc::new(tokio::sync::Notify::new());
    let release_turn1 = Arc::new(tokio::sync::Notify::new());
    let deadline_cancel = CancellationToken::new();

    rig.set_script(Arc::new({
        let (seen, consume_result, peek_ready, peek_done, fill_outbox, call_consume, consume_returned, release_turn1, deadline_cancel) = (
            seen.clone(),
            consume_result.clone(),
            peek_ready.clone(),
            peek_done.clone(),
            fill_outbox.clone(),
            call_consume.clone(),
            consume_returned.clone(),
            release_turn1.clone(),
            deadline_cancel.clone(),
        );
        move |run| {
            let (seen, consume_result, peek_ready, peek_done, fill_outbox, call_consume, consume_returned, release_turn1, deadline_cancel) = (
                seen.clone(),
                consume_result.clone(),
                peek_ready.clone(),
                peek_done.clone(),
                fill_outbox.clone(),
                call_consume.clone(),
                consume_returned.clone(),
                release_turn1.clone(),
                deadline_cancel.clone(),
            );
            Box::pin(async move {
                run.port.input_durable().await.expect("input durable");
                let PromptContent::Text(text) = &run.input.prompt else { panic!("a text prompt") };
                super::testing::lock(&seen).push(text.clone());
                if text != "work" {
                    return RunOutcome::Completed(Default::default());
                }

                peek_ready.notified().await;
                let req = DrainRequest { stage: DrainStage::PreSend, max_priority: Priority::Next };
                let peeked = run.port.peek_steers(req).await.expect("peek steers");
                let qids: Vec<QueuedId> = peeked.into_iter().flat_map(|s| s.queued_ids).collect();
                peek_done.notify_one();

                fill_outbox.notified().await;
                for i in 0..4 {
                    let item = ItemCommit {
                        iid: ItemId::from(format!("deadline-fill-{i}")),
                        role: Some("assistant".into()),
                        model: true,
                        visible: true,
                        body: json!({ "text": format!("deadline-fill-{i}") }),
                        prompt: None,
                    };
                    let _ = run.port.queue_item(item).await.expect("queue fill item");
                }

                call_consume.notified().await;
                let res = run.port.consume_steers_until(req, qids, 1_000, deadline_cancel).await;
                *super::testing::lock(&consume_result) = Some(res.map(|steers| steers.into_iter().flat_map(|s| s.queued_ids).collect()));
                consume_returned.notify_one();

                release_turn1.notified().await;
                RunOutcome::Completed(Default::default())
            })
        }
    }));

    let mut parts = rig.deps_parts(rig.store.clone());
    parts.limits.window_records = 4;
    let directory = SessionDirectory::new(Arc::new(parts));
    let handle = start_thread(&directory).await;

    turn(&handle, "work", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (super::testing::lock(&seen).len() == 1).then_some(())).await;
    assert_eq!(turn(&handle, "deadline steer", "op-2").await["kind"], json!("queued"));
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.queue.load().len() == 1 && handle.cell.unacked.load(SeqCst) == 0).then_some(())).await;

    peek_ready.notify_one();
    peek_done.notified().await;

    let disk = mixdog_rt::testing::hold_full(mixdog_rt::LaneKind::DurabilityIo);
    fill_outbox.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.unacked.load(SeqCst) >= 4).then_some(())).await;

    call_consume.notify_one();
    tokio::time::sleep(Duration::from_millis(20)).await;
    deadline_cancel.cancel();

    tokio::time::timeout(Duration::from_secs(5), consume_returned.notified()).await.expect("caller cancel must return promptly");
    assert_eq!(*super::testing::lock(&consume_result), Some(Err(RunError::Cancelled)));

    drop(disk);
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.unacked.load(SeqCst) == 0).then_some(())).await;
    super::tests::caught_up(&handle).await;
    assert_eq!(handle.cell.queue.load().len(), 1, "caller-cancelled consume_steers_until must leave steer queued");

    release_turn1.notify_one();
    eventually_on!(&[&handle.cell.stepped], || { (idle(&handle) && !handle.cell.busy.load(SeqCst) && super::testing::lock(&seen).len() == 2).then_some(()) })
        .await;
    assert_eq!(*super::testing::lock(&seen), ["work", "deadline steer"]);
    directory.shutdown().await;
}

/// r5 Defect 2: a recoverable journal write failure during `consume_steers` must return `RunError::NotApplied`
/// (never `Ok` for an undurable steer), keep the steer queued, and allow re-consuming once persistence recovers.
#[tokio::test]
async fn consume_steers_recoverable_write_failure_returns_not_applied_and_keeps_steer_queued() {
    use mixdog_core_api::ids::QueuedId;
    use mixdog_store::schema::record::QueueAction;
    use mixdog_store::schema::record::Record;
    use std::sync::atomic::Ordering::SeqCst;

    use super::run::DrainRequest;
    use super::run::DrainStage;
    use super::run::Priority;
    use super::run::RunError;

    let rig = Rig::new();
    let first_attempt = Arc::new(tokio::sync::Notify::new());
    let first_done = Arc::new(tokio::sync::Notify::new());
    let second_attempt = Arc::new(tokio::sync::Notify::new());
    let second_done = Arc::new(tokio::sync::Notify::new());
    let release_turn = Arc::new(tokio::sync::Notify::new());
    let first_res: Arc<std::sync::Mutex<Option<Result<Vec<QueuedId>, RunError>>>> = Arc::default();
    let second_res: Arc<std::sync::Mutex<Option<Result<Vec<QueuedId>, RunError>>>> = Arc::default();

    rig.set_script(Arc::new({
        let (first_attempt, first_done, second_attempt, second_done, release_turn, first_res, second_res) = (
            first_attempt.clone(),
            first_done.clone(),
            second_attempt.clone(),
            second_done.clone(),
            release_turn.clone(),
            first_res.clone(),
            second_res.clone(),
        );
        move |run| {
            let (first_attempt, first_done, second_attempt, second_done, release_turn, first_res, second_res) = (
                first_attempt.clone(),
                first_done.clone(),
                second_attempt.clone(),
                second_done.clone(),
                release_turn.clone(),
                first_res.clone(),
                second_res.clone(),
            );
            Box::pin(async move {
                run.port.input_durable().await.expect("input durable");
                first_attempt.notified().await;
                let req = DrainRequest { stage: DrainStage::PreSend, max_priority: Priority::Next };
                let peeked = run.port.peek_steers(req).await.expect("peek steers");
                let qids: Vec<QueuedId> = peeked.into_iter().flat_map(|s| s.queued_ids).collect();
                let res1 = run.port.consume_steers(req, qids.clone(), 1_000).await.map(|v| v.into_iter().flat_map(|s| s.queued_ids).collect());
                *super::testing::lock(&first_res) = Some(res1);
                first_done.notify_one();

                second_attempt.notified().await;
                let res2 = run.port.consume_steers(req, qids, 2_000).await.map(|v| v.into_iter().flat_map(|s| s.queued_ids).collect());
                *super::testing::lock(&second_res) = Some(res2);
                second_done.notify_one();

                release_turn.notified().await;
                RunOutcome::Completed(Default::default())
            })
        }
    }));

    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "base turn", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || handle.turn_busy().then_some(())).await;
    assert_eq!(turn(&handle, "durable steer", "op-2").await["kind"], json!("queued"));
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.queue.load().len() == 1 && handle.cell.unacked.load(SeqCst) == 0).then_some(())).await;

    // Inject recoverable write failure (`permanent = false`) on `Record::Item`.
    *super::testing::lock(&rig.store.fail_when) = Some((Box::new(|record| matches!(record, Record::Item(_))), false));
    first_attempt.notify_one();
    first_done.notified().await;
    assert_eq!(
        *super::testing::lock(&first_res),
        Some(Err(RunError::NotApplied)),
        "recoverable write failure must reject steer consumption instead of returning Ok(())"
    );
    let persisted = rig.store.records(&handle.id);
    assert!(!persisted.iter().any(|(_, r)| matches!(r, Record::Queue(q) if q.action == QueueAction::Dequeue)), "failed atomic unit must not persist dequeue");
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.queue.load().len() == 1).then_some(())).await;

    // Clear disk fault and retry consume_steers on the same turn: steer commits durably and leaves the queue.
    *super::testing::lock(&rig.store.fail_when) = None;
    second_attempt.notify_one();
    second_done.notified().await;
    let claimed = super::testing::lock(&second_res).clone().expect("second result").expect("retry after recovery must succeed");
    assert_eq!(claimed.len(), 1);
    assert!(handle.cell.queue.load().is_empty(), "steer must leave queue once durable commit succeeds");
    assert!(
        rig.store.records(&handle.id).iter().any(|(_, r)| matches!(r, Record::Queue(q) if q.action == QueueAction::Dequeue)),
        "recovered consume must persist dequeue durably"
    );

    release_turn.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (!handle.turn_busy()).then_some(())).await;
    directory.shutdown().await;
}

/// r5 Defect 5: if a cancellation token is already cancelled when `finish_consume_steers` crosses the commit point
/// while `SteerConsumeGate` is still `PENDING`, the actor must return `RunError::Cancelled` without mutating state
/// or dequeuing the steer.
#[tokio::test]
async fn finish_consume_steers_rejects_cancelled_token_even_while_gate_is_pending() {
    use mixdog_core_api::ids::QueuedId;
    use std::sync::atomic::Ordering::SeqCst;

    use super::run::DrainRequest;
    use super::run::DrainStage;
    use super::run::Priority;
    use super::run::RunError;
    use super::run::SteerConsumeGate;

    let rig = Rig::new();
    let turn_idx = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let ready = Arc::new(tokio::sync::Notify::new());
    let done = Arc::new(tokio::sync::Notify::new());
    let release_turn = Arc::new(tokio::sync::Notify::new());
    let result: Arc<std::sync::Mutex<Option<Result<Vec<QueuedId>, RunError>>>> = Arc::default();

    rig.set_script(Arc::new({
        let (turn_idx, ready, done, release_turn, result) = (turn_idx.clone(), ready.clone(), done.clone(), release_turn.clone(), result.clone());
        move |run| {
            let (turn_idx, ready, done, release_turn, result) = (turn_idx.clone(), ready.clone(), done.clone(), release_turn.clone(), result.clone());
            Box::pin(async move {
                run.port.input_durable().await.expect("input durable");
                if turn_idx.fetch_add(1, SeqCst) > 0 {
                    return RunOutcome::Completed(Default::default());
                }
                ready.notified().await;
                let req = DrainRequest { stage: DrainStage::PreSend, max_priority: Priority::Next };
                let peeked = run.port.peek_steers(req).await.expect("peek steers");
                let qids: Vec<QueuedId> = peeked.into_iter().flat_map(|s| s.queued_ids).collect();

                // Simulate Stop firing before `RunPort` runs `gate.try_cancel()`: token is cancelled while gate is PENDING.
                let cancelled = CancellationToken::new();
                cancelled.cancel();
                let gate = Arc::new(SteerConsumeGate::new());
                assert!(gate.is_pending());
                let res = run
                    .port
                    .finish_consume_steers_for_test(req, qids, 1_000, cancelled, gate.clone())
                    .await
                    .map(|v| v.into_iter().flat_map(|s| s.queued_ids).collect());
                assert!(gate.is_pending(), "cancelled token must abort before transitioning SteerConsumeGate to COMMITTED");
                *super::testing::lock(&result) = Some(res);
                done.notify_one();

                release_turn.notified().await;
                RunOutcome::Completed(Default::default())
            })
        }
    }));

    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "work", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || handle.turn_busy().then_some(())).await;
    assert_eq!(turn(&handle, "queued steer", "op-2").await["kind"], json!("queued"));
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.queue.load().len() == 1 && handle.cell.unacked.load(SeqCst) == 0).then_some(())).await;

    ready.notify_one();
    done.notified().await;
    assert_eq!(*super::testing::lock(&result), Some(Err(RunError::Cancelled)));
    assert_eq!(handle.cell.queue.load().len(), 1, "cancelled commit must leave steer queued");

    release_turn.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && handle.cell.queue.load().is_empty()).then_some(())).await;
    directory.shutdown().await;
}
