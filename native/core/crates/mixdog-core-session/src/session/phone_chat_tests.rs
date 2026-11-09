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
use super::tests::eventually;
use super::tests::eventually_on;
use super::tests::idle;
use super::tests::rows;
use super::tests::start_thread;

fn from(connection: u64) -> CallContext {
    CallContext::connection(ConnectionId(connection), mixdog_protocol::Origin::Local, CancellationToken::new())
}

async fn submit(handle: &SessionHandle, connection: u64, op: &str, prompt: &str, submission: &str) -> Result<Value, CoreError> {
    let options = if submission.is_empty() { json!({}) } else { json!({ "clientSubmissionId": submission }) };
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
    eventually(|| (rows(&handle).len() == 1).then_some(())).await;
    let reply = stop(&handle, 1, None).await;
    assert_eq!(reply["aborted"], true);
    assert_eq!(reply["restoreText"], "draft");
    assert_eq!(reply["restoredSubmissionIds"], json!(["sub1"]));
    eventually(|| idle(&handle).then_some(())).await;
    assert_eq!(rows(&handle), vec![], "the handed-back prompt left the transcript");
    assert!(prompt_restores(&rig, &handle).is_empty(), "the sender is told in the reply, not through the state");
}

/// The recorded `another device cancels: the prompt travels through the state`.
#[tokio::test(start_paused = true)]
async fn another_device_stopping_sends_the_prompt_to_the_sender_through_prompt_restore() {
    let rig = Rig::new();
    let (_directory, handle) = running(&rig).await;
    submit(&handle, 1, "op-1", "draft", "sub1").await.expect("started");
    eventually(|| (rows(&handle).len() == 1).then_some(())).await;
    let reply = stop(&handle, 2, None).await;
    assert_eq!((reply["aborted"].clone(), reply["restoreText"].clone(), reply["restoredSubmissionIds"].clone()), (json!(true), json!(""), json!([])));
    eventually(|| idle(&handle).then_some(())).await;
    let restores = eventually(|| Some(prompt_restores(&rig, &handle)).filter(|frames| !frames.is_empty())).await;
    let restore = &restores.last().unwrap()["value"];
    assert_eq!((restore["text"].clone(), restore["device"].clone(), restore["ids"].clone()), (json!("draft"), json!("desktop-1"), json!(["sub1"])));
    assert!(restore["id"].as_str().unwrap().starts_with("restore-"));
    assert!(restore["at"].is_number());
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
    eventually_on(&[&handle.cell.stepped], || (handle.cell.queue.load().len() == 2).then_some(())).await;
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
            params: json!({ "threadId": handle.id, "set": { "retired": true }, "unset": [] }),
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
