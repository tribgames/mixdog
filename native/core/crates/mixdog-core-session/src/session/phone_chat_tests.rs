//! The phone's Chat calls on the wire (PH-2): `turn/interrupt` handing the prompt back, the idle reclaim and the refused
//! `turn/start`, against what Node's session code did (`fixtures/phone-chat-core/phone-chat-core.json`).

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
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::thread::Stop;
use mixdog_rt::CancellationToken;
use mixdog_store::schema::record::Record;
use serde_json::Value;
use serde_json::json;

use super::SessionDirectory;
use super::handle::SessionHandle;
use super::seams::RunOutcome;
use super::testing::Rig;
use super::testing::awaiting_for;
use crate::eventually_on;
use super::tests::caught_up;
use super::tests::idle;
use super::tests::rows;
use super::tests::start_thread;

fn from(connection: u64) -> CallContext {
    CallContext::connection(ConnectionId(connection), mixdog_protocol::Origin::Local, CancellationToken::new())
}

async fn submit(handle: &SessionHandle, connection: u64, op: &str, prompt: &str, submission: &str) -> Result<Value, CoreError> {
    let options = if submission.is_empty() { json!({}) } else { json!({ "clientSubmissionId": submission }) };
    submit_with(handle, connection, op, json!(prompt), options).await
}

async fn submit_with(handle: &SessionHandle, connection: u64, op: &str, prompt: Value, options: Value) -> Result<Value, CoreError> {
    let reply = handle
        .request(CoreRequest {
            method: Method("turn/start"),
            params: json!({ "threadId": handle.id, "opId": op, "input": { "prompt": prompt, "options": options } }),
            op: Some(OpId::from(op)),
            ctx: from(connection),
        })
        .await?;
    let Reply::Value(value) = reply else { panic!("turn/start answers a value") };
    Ok(value)
}

async fn stop(handle: &SessionHandle, connection: u64, submission: Option<&str>) -> Value {
    handle.stop(Stop { turn: None, restore_prompt: None, submission_id: submission.map(str::to_owned), ctx: from(connection) }).await.expect("stop")
}

/// A thread whose run waits until it is stopped.
async fn running(rig: &Rig) -> (SessionDirectory, Arc<SessionHandle>) {
    rig.set_script(Arc::new(|run| {
        Box::pin(async move {
            run.cancel.cancelled().await;
            RunOutcome::Interrupted
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    (directory, handle)
}

fn prompt_restores(rig: &Rig, handle: &SessionHandle) -> Vec<Value> {
    rig.feeds.frames(handle.id.as_str()).into_iter().filter(|(_, method, _)| method == "thread/promptRestore").map(|(_, _, value)| value).collect()
}

/// The recorded `own device, prompt handed back`: the sender's stop returns the text and the row leaves the transcript.
#[tokio::test(start_paused = true)]
async fn the_sender_stopping_gets_the_prompt_back_and_the_row_leaves() {
    let rig = Rig::new();
    let (_directory, handle) = running(&rig).await;
    submit(&handle, 1, "op-1", "draft", "sub1").await.expect("started");
    eventually_on!(&[&handle.cell.stepped, &*rig.feeds.published], || (rows(&handle).len() == 1).then_some(())).await;
    let reply = stop(&handle, 1, None).await;
    assert_eq!(reply["aborted"], true);
    assert_eq!(reply["restoreText"], "draft");
    assert_eq!(reply["restoredSubmissionIds"], json!(["sub1"]));
    eventually_on!(&[&handle.cell.stepped, &*rig.feeds.published], || idle(&handle).then_some(())).await;
    assert_eq!(rows(&handle), vec![], "the handed-back prompt left the transcript");
    assert!(prompt_restores(&rig, &handle).is_empty(), "the sender is told in the reply, not through the state");
}

/// The recorded `nothing queued` / `no id names nothing`: an idle stop stops nothing.
#[tokio::test(start_paused = true)]
async fn stopping_an_idle_thread_answers_aborted_false() {
    let rig = Rig::new();
    let (_directory, handle) = running(&rig).await;
    let reply = stop(&handle, 1, None).await;
    assert_eq!(
        reply,
        json!({
            "cancelRequested": false, "aborted": false, "restoreText": "", "pastedImages": null, "pastedTexts": null,
            "discardPastedImages": null, "discardPastedTexts": null, "restoredSubmissionIds": [],
        })
    );
    assert_eq!(stop(&handle, 1, Some("zz")).await["aborted"], false, "an id that is not queued hands nothing back");
}

/// `abortSession` on a room log is the room's stop (`session-host.ts`): the reply is its outcome, and the thread runs no stop of
/// its own.
#[tokio::test(start_paused = true)]
async fn stopping_a_room_log_is_the_rooms_stop() {
    let rig = Rig::new();
    rig.room_members.hosted.lock().unwrap().insert("room01".into(), true);
    let id = ThreadId::from("sess_room_room01");
    let directory = SessionDirectory::new(rig.deps());
    directory.create_with_id(id.clone(), json!({ "cwd": "/ws" }).as_object().cloned().expect("object"), json!({})).await.expect("create");
    let handle = directory.open_handle(&id, &CallContext::internal("test")).await.expect("open");
    let reply = stop(&handle, 1, None).await;
    assert_eq!((reply["aborted"].clone(), reply["cancelRequested"].clone()), (json!(true), json!(true)));
    assert_eq!(*rig.room_members.stopped.lock().unwrap(), ["room01"]);
    rig.room_members.hosted.lock().unwrap().insert("room01".into(), false);
    assert_eq!(stop(&handle, 1, None).await["aborted"], false, "a room with nothing to stop answers its own outcome");
}

/// The room's stop is reached by the room's identity: a log thread nobody loaded still stops its room, and an id that is no
/// hosted room's log is left to the thread.
#[tokio::test(start_paused = true)]
async fn a_stop_for_an_unloaded_room_log_reaches_the_room() {
    let rig = Rig::new();
    rig.room_members.hosted.lock().unwrap().insert("room01".into(), true);
    let directory = SessionDirectory::new(rig.deps());
    let log = ThreadId::from("sess_room_room01");
    assert!(directory.get(&log).is_none(), "the log is not loaded");
    assert_eq!(directory.stop_room(&log).map(|stopped| stopped.stopped), Some(true));
    assert_eq!(*rig.room_members.stopped.lock().unwrap(), ["room01"]);
    assert!(directory.stop_room(&ThreadId::from("sess_room_other")).is_none());
    assert!(directory.stop_room(&ThreadId::from("sess_plain")).is_none());
}

/// The recorded `a queued submission is handed back by its id`: an idle thread still holding the prompt gives it back.
#[tokio::test(start_paused = true)]
async fn an_idle_stop_hands_back_the_queued_submission_it_names() {
    let rig = Rig::new();
    let id = ThreadId::from("sess_idle");
    let creator = SessionDirectory::new(rig.deps());
    creator.create_with_id(id.clone(), json!({ "cwd": "/ws" }).as_object().cloned().expect("object"), json!({})).await.expect("create");
    let entry = |qid: &str, text: &str| -> Record {
        serde_json::from_value(json!({
            "k": "queue", "qid": qid, "action": "enqueue",
            "entry": { "inline": { "message": text, "enqueuedAt": 1, "priority": "next", "options": { "clientSubmissionId": qid } } },
        }))
        .expect("queue record")
    };
    rig.store.seed(&id, vec![entry("sub1", "queued one"), entry("sub2", "queued two")]);
    let directory = SessionDirectory::new(rig.deps());
    let handle = directory.open_handle(&id, &CallContext::internal("test")).await.expect("open");
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.queue.load().len() == 2).then_some(())).await;
    let reply = stop(&handle, 1, Some("sub1")).await;
    assert_eq!(reply["aborted"], false);
    assert_eq!(reply["restoreText"], "queued one");
    assert_eq!(reply["restoredSubmissionIds"], json!(["sub1"]));
    let left: Vec<String> = handle.cell.queue.load().iter().map(|queued| queued.qid.clone()).collect();
    assert_eq!(left, ["sub2"]);
}

fn refused(result: Result<Value, CoreError>, text: &str) {
    match result {
        Err(CoreError::DomainError { code: Some(code), message, .. }) => {
            assert_eq!(code.as_ref(), super::actor::SUBMIT_REFUSED);
            assert_eq!(message.as_deref(), Some(text));
        }
        other => panic!("expected a refused submit, got {other:?}"),
    }
}

/// The recorded `a prompt of blank text parts is refused` and `a closed session takes nothing`'s sibling for a bot's home.
#[tokio::test(start_paused = true)]
async fn a_blank_prompt_and_a_deleted_bots_home_refuse_the_submit() {
    let rig = Rig::new();
    let (_directory, handle) = running(&rig).await;
    refused(submit(&handle, 1, "op-1", "   ", "sub1").await, "The message is empty.");
    assert!(idle(&handle) && rows(&handle).is_empty(), "nothing started");
    handle
        .request(CoreRequest {
            method: Method("thread/header/patch"),
            params: json!({ "threadId": handle.id, "set": { "retiredAt": 1 }, "unset": [] }),
            op: None,
            ctx: CallContext::internal("test"),
        })
        .await
        .expect("retire");
    refused(submit(&handle, 1, "op-2", "hello", "sub2").await, "This bot was deleted.");
}

/// The recorded `a repeated submission id is one prompt`: the repeat answers as the first did and queues nothing.
#[tokio::test(start_paused = true)]
async fn a_repeated_submission_id_is_one_prompt() {
    let rig = Rig::new();
    let (_directory, handle) = running(&rig).await;
    let first = submit(&handle, 1, "op-1", "hello", "sub1").await.expect("started");
    assert_eq!(first["kind"], "started");
    let queued = submit(&handle, 1, "op-2", "again", "sub2").await.expect("queued");
    assert_eq!(queued["kind"], "queued");
    let repeat = submit(&handle, 1, "op-3", "again", "sub2").await.expect("joins the first");
    assert_eq!(repeat, queued);
    assert_eq!(handle.cell.queue.load().len(), 1, "the prompt was queued once");
    assert_eq!(submit(&handle, 1, "op-4", "hello", "sub1").await.expect("joins"), first);
}

/// How many prompts the store holds for `submission`: queued entries and prompt rows naming it.
fn stored_prompts(rig: &Rig, id: &ThreadId, submission: &str) -> usize {
    use mixdog_store::schema::blob::Slot;
    use mixdog_store::schema::record::QueueAction;
    rig.store
        .records(id)
        .into_iter()
        .filter(|(_, record)| match record {
            Record::Queue(queue) if queue.action == QueueAction::Enqueue => {
                matches!(&queue.entry, Some(Slot::Inline(entry)) if entry.pointer("/options/clientSubmissionId").and_then(Value::as_str) == Some(submission))
            }
            // A prompt row names its submission as its own (`clientSubmissionId`) or among the queued ones it took in.
            Record::Item(item) => matches!(&item.body, Slot::Inline(body) if body.pointer("/meta/transcript/clientSubmissionId").and_then(Value::as_str) == Some(submission)
                || ["/meta/transcript/submissionIds", "/meta/submissionIds"].iter().any(|at| body.pointer(at).and_then(Value::as_array).is_some_and(|ids| ids.iter().any(|id| id == submission)))),
            _ => false,
        })
        .count()
}

/// How many queue entries the store holds for `submission`: each a queued send of it.
fn enqueued(rig: &Rig, id: &ThreadId, submission: &str) -> usize {
    use mixdog_store::schema::blob::Slot;
    use mixdog_store::schema::record::QueueAction;
    rig.store
        .records(id)
        .into_iter()
        .filter(|(_, record)| {
            matches!(record, Record::Queue(queue) if queue.action == QueueAction::Enqueue
                && matches!(&queue.entry, Some(Slot::Inline(entry)) if entry.pointer("/options/clientSubmissionId").and_then(Value::as_str) == Some(submission)))
        })
        .count()
}

fn settled(handle: &SessionHandle) -> bool {
    handle.cell.unacked.load(std::sync::atomic::Ordering::SeqCst) == 0
}

/// A first prompt the session refuses leaves no thread behind.
#[tokio::test(start_paused = true)]
async fn a_refused_first_prompt_leaves_no_thread() {
    let rig = Rig::new();
    // The catalog lists what was created, so the delete finds it.
    rig.store.listed.store(true, std::sync::atomic::Ordering::SeqCst);
    let directory = SessionDirectory::new(rig.deps());
    let started = directory
        .request(CoreRequest {
            method: Method("thread/start"),
            params: json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws", "initialInput": { "prompt": "  " } }),
            op: Some(OpId::from("op-start")),
            ctx: from(1),
        })
        .await;
    assert!(matches!(&started, Err(CoreError::DomainError { code: Some(code), .. }) if code.as_ref() == super::actor::SUBMIT_REFUSED), "{started:?}");
    assert_eq!(directory.loaded_ids(), Vec::<ThreadId>::new());
}





















/// A running thread whose rows are the stored records' own (`RecordTranscript`), as the daemon shows them: the rig's text-only
/// transcript would drop the body's `meta.transcript` (the device, the display text) that the replay compares.
async fn running_on_records(rig: &Rig) -> (SessionDirectory, Arc<SessionHandle>) {
    rig.set_script(Arc::new(|run| {
        Box::pin(async move {
            run.cancel.cancelled().await;
            RunOutcome::Interrupted
        })
    }));
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.transcript = Arc::new(super::testing::RecordTranscript::new());
    let directory = SessionDirectory::new(Arc::new(deps));
    let handle = start_thread(&directory).await;
    (directory, handle)
}
/// A wait whose condition is withheld fails at the real deadline with its message, and the paused clock has not moved: a pending
/// 16 ms timer (the actor's status settling) is not fired by the wait.
#[tokio::test(start_paused = true)]
async fn a_withheld_wait_fails_at_the_real_deadline_with_the_paused_clock_untouched() {
    let timer_fired = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flag = timer_fired.clone();
    tokio::spawn(async move {
        mixdog_rt::time::sleep(std::time::Duration::from_millis(16)).await;
        flag.store(true, std::sync::atomic::Ordering::SeqCst);
    });
    let wake = tokio::sync::Notify::new();
    let started = tokio::time::Instant::now();
    let failed = tokio::spawn(async move { awaiting_for(std::time::Duration::from_millis(200), || "the withheld thing".to_owned(), eventually_on!(&[&wake], || None::<()>)).await }).await.expect_err("the wait fails");
    let message = failed.into_panic().downcast::<String>().map(|text| *text).unwrap_or_default();
    assert!(message.contains("waiting for the withheld thing"), "{message}");
    assert_eq!(tokio::time::Instant::now(), started, "the paused clock did not move");
    assert!(!timer_fired.load(std::sync::atomic::Ordering::SeqCst), "the 16 ms timer was not fired by the wait");
}
/// `a repeated submission id is one prompt` across a reload: the thread's actor is gone (an unload, a restart) before the
/// client heard its answers, and the client's retries with the same ids answer as the first sends did, from what the thread
/// stored, not from a row that happens to be in view: one that started directly, one that was queued and then started (its
/// queue entry consumed), and one still queued. Each answers as an idempotent success and nothing is posted twice. The rows
/// are the stored records' own (`RecordTranscript`), as the daemon converts them.
#[tokio::test(start_paused = true)]
async fn a_repeated_submission_id_is_one_prompt_after_a_reload() {
    let rig = Rig::new();
    let (directory, handle) = running_on_records(&rig).await;
    let id = handle.id.clone();
    let first = submit(&handle, 1, "op-1", "hello", "sub1").await.expect("started");
    assert_eq!(first["kind"], "started");
    let second = submit(&handle, 1, "op-2", "again", "sub2").await.expect("queued");
    assert_eq!(second["kind"], "queued");
    // The first turn ends (stopped from another device, so its prompt is not handed back); the queued prompt starts, its
    // entry consumed.
    stop(&handle, 2, None).await;
    eventually_on!(&[&rig.store.committed], || (stored_prompts(&rig, &id, "sub2") == 2).then_some(())).await;
    let third = submit(&handle, 1, "op-3", "later", "sub3").await.expect("queued");
    assert_eq!(third["kind"], "queued");
    eventually_on!(&[&rig.store.committed], || (stored_prompts(&rig, &id, "sub1") == 1 && stored_prompts(&rig, &id, "sub3") == 1).then_some(())).await;
    directory.shutdown().await;

    let mut deps = rig.deps_parts(rig.store.clone());
    deps.transcript = Arc::new(super::testing::RecordTranscript::new());
    let reloaded = SessionDirectory::new(Arc::new(deps));
    let handle = reloaded.open_handle(&id, &CallContext::internal("test")).await.expect("reopen");
    eventually_on!(&[&handle.cell.stepped], || handle.recovered().then_some(())).await;
    let counts = || ["sub1", "sub2", "sub3"].map(|submission| stored_prompts(&rig, &id, submission));
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.unacked.load(std::sync::atomic::Ordering::SeqCst) == 0).then_some(())).await;
    let before = counts();
    assert_eq!(submit(&handle, 1, "op-4", "hello", "sub1").await.expect("the started prompt answers again"), first);
    assert_eq!(submit(&handle, 1, "op-5", "again", "sub2").await.expect("the consumed queued prompt answers again"), second);
    assert_eq!(submit(&handle, 1, "op-6", "later", "sub3").await.expect("the queued prompt answers again"), third);
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.unacked.load(std::sync::atomic::Ordering::SeqCst) == 0).then_some(())).await;
    assert_eq!(counts(), before, "nothing is posted twice");
    reloaded.shutdown().await;
}
/// The thread `id` opened again by a new directory over the same store (a restart), its recovery done.
async fn reopened(rig: &Rig, id: &ThreadId) -> (SessionDirectory, Arc<SessionHandle>) {
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.transcript = Arc::new(super::testing::RecordTranscript::new());
    let directory = SessionDirectory::new(Arc::new(deps));
    let handle = directory.open_handle(id, &CallContext::internal("test")).await.expect("reopen");
    eventually_on!(&[&handle.cell.stepped], || handle.recovered().then_some(())).await;
    (directory, handle)
}
/// A send whose save fails leaves no receipt, whatever was admitted while it was pending: send A waits at a held disk, send
/// B is admitted behind it, the write fails. A retry of B is a new attempt and commits; after a restart A's id is unknown
/// (a retry of it is a new prompt) and B's retry gets B's committed answer.
#[tokio::test(start_paused = true)]
async fn a_failed_send_leaves_no_receipt_and_a_committed_one_survives_a_restart() {
    let rig = Rig::new();
    let (directory, handle) = running_on_records(&rig).await;
    let id = handle.id.clone();
    submit(&handle, 1, "op-0", "busy", "sub0").await.expect("started");
    eventually_on!(&[&handle.cell.stepped], || settled(&handle).then_some(())).await;
    let full = mixdog_rt::testing::hold_full(mixdog_rt::LaneKind::DurabilityIo);
    let send = |op: &'static str, text: &'static str, submission: &'static str| {
        let handle = handle.clone();
        tokio::spawn(async move { submit(&handle, 1, op, text, submission).await })
    };
    let a = send("op-a", "a", "subA");
    full.met_by_a_submit().await;
    let b = send("op-b", "b", "subB");
    caught_up(&handle).await;
    *rig.store.failing.lock().unwrap() = Some("EIO: injected".into());
    drop(full);
    assert!(a.await.expect("A's task").is_err(), "A's sender hears its failed save");
    let b_first = b.await.expect("B's task");
    *rig.store.failing.lock().unwrap() = None;
    let b_answer = match b_first {
        Ok(answer) => answer,
        // B went with A's failed write: its retry is a new attempt.
        Err(_) => submit(&handle, 1, "op-b2", "b", "subB").await.expect("B again"),
    };
    assert_eq!(b_answer["kind"], "queued");
    eventually_on!(&[&handle.cell.stepped], || settled(&handle).then_some(())).await;
    assert_eq!(stored_prompts(&rig, &id, "subA"), 0, "A was never stored");
    directory.shutdown().await;

    let (reloaded, handle) = reopened(&rig, &id).await;
    assert_eq!(submit(&handle, 1, "op-b3", "b", "subB").await.expect("B's receipt"), b_answer);
    let a_again = submit(&handle, 1, "op-a2", "a", "subA").await.expect("A, a new prompt");
    assert!(matches!(a_again["kind"].as_str(), Some("queued" | "started")), "{a_again}");
    eventually_on!(&[&handle.cell.stepped], || settled(&handle).then_some(())).await;
    assert_eq!(enqueued(&rig, &id, "subB"), 1, "B queued once");
    assert!(stored_prompts(&rig, &id, "subA") >= 1, "A taken as new");
    reloaded.shutdown().await;
}
/// A retry that arrives while the first send's records are not yet saved joins it: it hears nothing before the save, then
/// what the first send hears, the same success or the same failure; never a success the save did not give.
async fn retry_before_the_save(fails: bool) {
    let rig = Rig::new();
    let (_directory, handle) = running(&rig).await;
    submit(&handle, 1, "op-0", "busy", "sub0").await.expect("started");
    eventually_on!(&[&handle.cell.stepped], || settled(&handle).then_some(())).await;
    let full = mixdog_rt::testing::hold_full(mixdog_rt::LaneKind::DurabilityIo);
    let send = |op: &'static str| {
        let handle = handle.clone();
        tokio::spawn(async move { submit(&handle, 1, op, "a", "subA").await })
    };
    let first = send("op-1");
    full.met_by_a_submit().await;
    let retry = send("op-2");
    caught_up(&handle).await;
    caught_up(&handle).await;
    assert!(!retry.is_finished(), "no answer before the save");
    if fails {
        *rig.store.failing.lock().unwrap() = Some("EIO: injected".into());
    }
    drop(full);
    let (first, retry) = (first.await.expect("the first send"), retry.await.expect("the retry"));
    if fails {
        assert!(first.is_err(), "the first send's save failed");
        assert_eq!(format!("{:?}", retry.err()), format!("{:?}", first.err()), "the retry hears the same failure");
    } else {
        assert_eq!(retry.expect("the retry"), first.expect("the first send"), "the retry hears the same answer");
    }
    eventually_on!(&[&handle.cell.stepped], || settled(&handle).then_some(())).await;
    assert_eq!(handle.cell.queue.load().len(), usize::from(!fails), "one prompt at most");
}
#[tokio::test(start_paused = true)]
async fn a_retry_before_the_save_shares_its_success() {
    retry_before_the_save(false).await;
}
#[tokio::test(start_paused = true)]
async fn a_retry_before_the_save_shares_its_failure() {
    retry_before_the_save(true).await;
}
/// A receipt outlives the actor's memory and the view: the answer of a send is lost, more than `SUBMISSION_MEMORY` sends
/// follow (their turns push its row out of the window), the core restarts, and the retry still gets the first answer.
#[tokio::test(start_paused = true)]
async fn a_receipt_outlives_the_memory_and_the_window() {
    let rig = Rig::new();
    rig.set_script(super::tests::echo());
    // The prompt rows as the daemon writes them (`RecordTranscript`): their `meta.transcript` names the submission; the rig's
    // text-only transcript writes a bare `{role, content}` body, which accepts nothing the index could keep.
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.transcript = Arc::new(super::testing::RecordTranscript::new());
    let directory = SessionDirectory::new(Arc::new(deps));
    let handle = start_thread(&directory).await;
    let id = handle.id.clone();
    let first = submit(&handle, 1, "op-old", "the old prompt", "sub-old").await.expect("started");
    for n in 0..300 {
        eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
        submit(&handle, 1, &format!("op-{n}"), "more", &format!("sub-{n}")).await.expect("each send");
    }
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && settled(&handle)).then_some(())).await;
    let view = handle.cell.view.load_full();
    assert!(
        !view.items.iter().any(|item| matches!(item.as_ref(), mixdog_protocol::ThreadItem::UserMessage { display_text, .. } if display_text == "the old prompt")),
        "the old prompt's row is out of the window"
    );
    directory.shutdown().await;
    let (reloaded, handle) = reopened(&rig, &id).await;
    assert_eq!(submit(&handle, 1, "op-retry", "the old prompt", "sub-old").await.expect("the old receipt"), first);
    eventually_on!(&[&handle.cell.stepped], || settled(&handle).then_some(())).await;
    assert_eq!(stored_prompts(&rig, &id, "sub-old"), 1, "posted once");
    reloaded.shutdown().await;
}
/// A queued prompt survives a restart: its retry gets its queued receipt, and it is queued once.
#[tokio::test(start_paused = true)]
async fn a_queued_prompts_receipt_survives_a_restart() {
    let rig = Rig::new();
    let (directory, handle) = running_on_records(&rig).await;
    let id = handle.id.clone();
    submit(&handle, 1, "op-0", "busy", "sub0").await.expect("started");
    let queued = submit(&handle, 1, "op-1", "later", "subQ").await.expect("queued");
    assert_eq!(queued["kind"], "queued");
    eventually_on!(&[&handle.cell.stepped], || settled(&handle).then_some(())).await;
    directory.shutdown().await;
    let (reloaded, handle) = reopened(&rig, &id).await;
    assert_eq!(submit(&handle, 1, "op-2", "later", "subQ").await.expect("the queued receipt"), queued);
    eventually_on!(&[&handle.cell.stepped], || settled(&handle).then_some(())).await;
    assert_eq!(enqueued(&rig, &id, "subQ"), 1, "queued once");
    reloaded.shutdown().await;
}


