//! A Stop racing the turn's first output, through the actor: Node decides, hydrates, cancels and reclaims with no await between
//! (`abort.mjs:131-205`), so an output that commits while the Stop is still reading lands before its decision (nothing is handed
//! back) and one that commits after it does not take the hand-back away. Node's own runs of both orders are the oracle
//! (`fixtures/phone-chat-core/phone-chat-core.json`: "output already produced: nothing to hand back" and "own device named, prompt handed
//! back").

use std::sync::Arc;

use mixdog_core_api::ThreadHandle as _;
use mixdog_core_api::ids::ItemId;
use serde_json::Value;
use serde_json::json;
use tokio::sync::Notify;

use super::SessionDirectory;
use super::handle::SessionHandle;
use super::seams::RunOutcome;
use super::testing::Rig;
use super::testing::awaiting;
use super::tests::idle;
use super::tests::rows;
use super::tests::start_thread;
use crate::eventually_on;

fn node_case(name: &str) -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/phone-chat-core/phone-chat-core.json");
    let recorded: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    recorded["cases"].as_array().unwrap().iter().find(|case| case["name"] == name).cloned().unwrap_or_else(|| panic!("Node recorded no case {name:?}"))
}

/// A run that streams `partial answer` when `emit` is signalled, then waits to be stopped.
async fn running(rig: &Rig, emit: &Arc<Notify>) -> (SessionDirectory, Arc<SessionHandle>) {
    let emit = emit.clone();
    rig.set_script(Arc::new(move |run| {
        let emit = emit.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            awaiting(|| "the test to let the output through".to_owned(), emit.notified()).await;
            let _ = run.port.delta(ItemId::from("a1".to_owned()), "partial answer".into()).await;
            run.cancel.cancelled().await;
            RunOutcome::Interrupted
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    (directory, handle)
}

async fn start(handle: &SessionHandle) {
    handle
        .request(super::tests::request(
            "turn/start",
            json!({ "threadId": handle.id, "opId": "op-1", "input": { "prompt": "draft", "options": { "clientSubmissionId": "sub1" } } }),
            "op-1",
        ))
        .await
        .expect("started");
}

fn stop(handle: &Arc<SessionHandle>) -> tokio::task::JoinHandle<Value> {
    let handle = handle.clone();
    tokio::spawn(async move {
        let ctx = mixdog_core_api::call::CallContext::connection(mixdog_core_api::ids::ConnectionId(1), mixdog_protocol::Origin::Local, mixdog_rt::CancellationToken::new());
        handle.stop(mixdog_core_api::thread::Stop { turn: None, restore_prompt: None, submission_id: None, ctx }).await.expect("stop")
    })
}

fn node_says(reply: &Value, node: &Value) {
    for key in ["aborted", "restoreText", "restoredSubmissionIds"] {
        assert_eq!(reply[key], node["result"][key], "{key}");
    }
}

/// The output commits while the Stop stands between its reads and its decision: the decision sees it (Node's "output already
/// produced"), the prompt stays in the transcript.
#[tokio::test]
async fn an_output_that_commits_while_the_stop_is_reading_hands_nothing_back() {
    let rig = Rig::new();
    let emit = Arc::new(Notify::new());
    let (_directory, handle) = running(&rig, &emit).await;
    start(&handle).await;
    let prompt = handle.cell.run.load_full().expect("the run").prompt.clone();
    let (reached, go) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    *prompt.pause.lock().unwrap() = Some((reached.clone(), go.clone()));
    let stopped = stop(&handle);
    awaiting(|| "the Stop to stand between its reads and its decision".to_owned(), reached.notified()).await;
    emit.notify_one();
    eventually_on!(&[&handle.cell.stepped], || prompt.snapshot().committed.then_some(())).await;
    go.notify_one();
    let reply = awaiting(|| "the Stop's reply".to_owned(), stopped).await.expect("stop task");
    node_says(&reply, &node_case("output already produced: nothing to hand back"));
    assert_eq!(*prompt.between.lock().unwrap(), Some(false), "no output commit could land between the Stop's decision and its record");
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    assert!(rows(&handle).contains(&("user", "draft".to_owned())), "the prompt stays: {:?}", rows(&handle));
}

/// A runtime's own prompt (a kickoff) that a Stop finds uncommitted goes back to the front of the queue and runs again (Node's drain
/// gives the turn its entries as `requeueOnAbort`, drain.mjs:140; the Stop puts them back, abort.mjs:160-199, queue.mjs:50-76): the
/// stopped turn shows no end, nothing is handed to a composer, and the next turn runs the same prompt under the same submission.
#[tokio::test]
async fn a_stopped_runtime_prompt_runs_again() {
    let rig = Rig::new();
    let (count, mut counted) = tokio::sync::watch::channel(0usize);
    let inputs: Arc<std::sync::Mutex<Vec<Value>>> = Arc::default();
    let seen = inputs.clone();
    let rewinds: Arc<std::sync::Mutex<Vec<String>>> = Arc::default();
    let rewound = rewinds.clone();
    rig.set_script(Arc::new(move |run| {
        let (seen, count, rewound) = (seen.clone(), count.clone(), rewound.clone());
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            seen.lock().unwrap().push(serde_json::to_value(&run.input).expect("input serializes"));
            count.send_modify(|n| *n += 1);
            run.cancel.cancelled().await;
            // The run host's end of a cancelled turn that produced nothing (run_host/factory.rs): its prompt's row is rewound.
            let outcome = format!("{:?}", run.port.closing().prompt_rewound(run.input_item.clone()).await);
            rewound.lock().unwrap().push(outcome);
            RunOutcome::Interrupted
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    handle
        .request(super::tests::request(
            "turn/start",
            json!({ "threadId": handle.id, "opId": "op-1", "input": { "prompt": "greet the user", "options": { "clientSubmissionId": "sub-k", "kickoff": true } } }),
            "op-1",
        ))
        .await
        .expect("started");
    awaiting(|| "the runtime's turn to start".to_owned(), counted.wait_for(|n| *n == 1)).await.expect("count");
    let reply = awaiting(|| "the Stop's reply".to_owned(), stop(&handle)).await.expect("stop task");
    assert_eq!((reply["restoreText"].clone(), reply["restoredSubmissionIds"].clone()), (json!(""), json!([])), "nothing goes to a composer");
    awaiting(|| "the requeued prompt to run as the next turn".to_owned(), counted.wait_for(|n| *n == 2)).await.expect("count");
    let inputs = inputs.lock().unwrap().clone();
    assert_eq!(inputs[1], inputs[0], "the same prompt and submission run again");
    // The stopped turn's kickoff row shows nothing, and its rewind still takes it (recorded: `running-runtime-turn`'s list row counts
    // one message while the requeued turn runs).
    assert_eq!(*rewinds.lock().unwrap(), vec!["Ok(())".to_owned()], "the stopped kickoff's row is rewound");
    let view = handle.cell.view.load_full();
    assert!(!view.items.iter().any(|item| matches!(item.as_ref(), mixdog_protocol::ThreadItem::TurnEnd { .. })), "the stopped turn shows no end: {:?}", view.items);
    // A kickoff reaches the model only (`submission.mjs:17-20`): neither turn shows a user bubble (recorded: `running-runtime-turn`'s
    // transcript is empty while the requeued turn runs).
    assert!(!view.items.iter().any(|item| matches!(item.as_ref(), mixdog_protocol::ThreadItem::UserMessage { .. })), "no user bubble: {:?}", view.items);
}

/// An inline pasted text is stored at intake (`materializePastedTexts`, attachments/store.mjs:466-499): the turn reads it by its
/// content reference, so its stored prompt row lists the attachment even when another device's Stop keeps the prompt
/// (remote-protocol-chat-abort.recorded.json `other-device-with-attachment`).
#[tokio::test]
async fn an_inline_pasted_text_is_stored_when_the_prompt_is_taken_in() {
    let rig = Rig::new();
    let (seen, mut got) = tokio::sync::watch::channel(None::<Value>);
    rig.set_script(Arc::new(move |run| {
        let seen = seen.clone();
        Box::pin(async move {
            seen.send_replace(Some(serde_json::to_value(&run.input).expect("input serializes")));
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    handle
        .request(super::tests::request(
            "turn/start",
            json!({ "threadId": handle.id, "opId": "op-1", "input": { "prompt": "with a paste", "options": { "pastedTexts": { "1": { "id": 1, "text": "a pasted block" } } } } }),
            "op-1",
        ))
        .await
        .expect("started");
    let input = awaiting(|| "the turn to run".to_owned(), got.wait_for(Option::is_some)).await.expect("input").clone().expect("input");
    let entry = &input["options"]["pastedTexts"]["1"];
    let reference = entry["attachmentRef"].as_str().expect("a stored reference").trim_start_matches("sha256:").to_owned();
    assert_eq!(reference, "fd434aeafe30cd343fc401e47a64f1fa60741e1fc8ae9e2e83063caf2cba2ea3", "Node's reference of the same text");
    // Node's `materializePastedTexts` keeps the reference in place of the text.
    assert_eq!((entry["sizeBytes"].clone(), entry["chars"].clone(), entry.get("text")), (json!(14), json!(14), None));
}

/// A stopped turn's activity stamp (`prepareCloseSnapshot`, ask-turn-state.mjs:256-257) is written before the record that reports the
/// turn finished (`turn/completed`), so a list read after that notification shows `activityAt` = `updatedAt` as Node's row does
/// (remote-protocol-chat-abort.recorded.json `running-keep-prompt`).
#[tokio::test]
async fn a_stopped_turns_activity_is_stamped_before_it_reports_finished() {
    use mixdog_store::schema::record::{Record, RunPhase};
    let rig = Rig::new();
    rig.set_script(Arc::new(move |run| {
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            run.cancel.cancelled().await;
            RunOutcome::Interrupted
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    start(&handle).await;
    awaiting(|| "the Stop's reply".to_owned(), stop(&handle)).await.expect("stop task");
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    let records = rig.store.records(&handle.id);
    let ended = records.iter().position(|(_, r)| matches!(r, Record::Run(run) if run.phase == RunPhase::Interrupted)).expect("run{interrupted}");
    let stamped = records.iter().position(|(_, r)| matches!(r, Record::Meta(m) if matches!(&m.change, mixdog_store::schema::blob::Slot::Inline(c) if c.set.contains_key("lastUsedAt")))).expect("the activity stamp");
    assert!(stamped < ended, "the stamp at {stamped} precedes the turn's end at {ended}");
}

/// A Stop while the person is asked (ask_user's question pending): the question's wait ends with the abort, so the call's card
/// reads the abort's `Error: <reason>` with the Stop's reason `user-cancel` (Node: `runAbortable` rejects with the signal's
/// `SessionClosedError`, ask-user-tool.mjs:249; the eager entry notices `Error: <message>` to the card, eager-dispatch/entry.mjs:39-44;
/// `abortRuntime(reason)`, session-close.mjs:98-102, with `user-cancel` from abort.mjs:118), while the stored result is the
/// interruption's `Cancelled`. Recorded from Node: remote-protocol-chat-abort.recorded.json `running-approval-pending`.
#[tokio::test]
async fn a_question_the_stop_ended_reads_the_aborts_error_on_its_card() {
    use mixdog_core_api::domain::approval::{ApprovalAsk, ApprovalGate as _, ApprovalKind};
    let rig = Rig::new();
    rig.set_script(Arc::new(move |run| {
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let call = json!({ "id": "c1", "name": "ask_user", "arguments": { "questions": [{ "question": "Add the file?" }] } });
            let commit = |iid: &str, role: &str, body: Value| super::run::ItemCommit { iid: ItemId::from(iid.to_owned()), role: Some(role.into()), model: true, visible: true, body, prompt: None };
            run.port.commit_item(commit("a-1", "assistant", json!({ "text": "", "toolCalls": [call] }))).await.expect("call");
            let _ = run.port.request(ApprovalAsk {
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
            // The interruption closes the unanswered call as Node's finalizer does.
            run.port.closing().commit_item(commit("t-1", "tool", json!({ "toolCallId": "c1", "text": "Cancelled", "isError": true }))).await.expect("stub");
            RunOutcome::Interrupted
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    start(&handle).await;
    eventually_on!(&[&handle.cell.stepped], || directory.member_approval(&handle.id).map(drop)).await;
    awaiting(|| "the Stop's reply".to_owned(), stop(&handle)).await.expect("stop task");
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    let view = handle.cell.view.load_full();
    let result = view.items.iter().find_map(|item| match item.as_ref() {
        mixdog_protocol::ThreadItem::ToolCall { run, meta, .. } => Some((run.result.clone(), run.is_error, meta.status)),
        _ => None,
    });
    let expected = format!("Error: Session \"{}\" closed: runtime abort (reason=user-cancel)", handle.id.as_str());
    // The card is ended by the Stop: `interrupted`, which the client finalizes as a cancelled card.
    assert_eq!(result, Some((Some(mixdog_protocol::MaybeBlob::Inline(expected)), Some(true), Some(mixdog_protocol::ItemStatus::Interrupted))));
}

/// The Stop decides first and the output commits after: the hand-back stands (Node's "prompt handed back"), and the prompt leaves.
#[tokio::test]
async fn an_output_that_commits_after_the_stop_decided_does_not_take_the_hand_back_away() {
    let rig = Rig::new();
    let emit = Arc::new(Notify::new());
    let (_directory, handle) = running(&rig, &emit).await;
    start(&handle).await;
    let prompt = handle.cell.run.load_full().expect("the run").prompt.clone();
    let (reached, go) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    *prompt.pause.lock().unwrap() = Some((reached.clone(), go.clone()));
    let stopped = stop(&handle);
    awaiting(|| "the Stop to stand between its reads and its decision".to_owned(), reached.notified()).await;
    go.notify_one();
    let reply = awaiting(|| "the Stop's reply".to_owned(), stopped).await.expect("stop task");
    node_says(&reply, &node_case("own device named, prompt handed back"));
    assert_eq!(*prompt.between.lock().unwrap(), Some(false), "no output commit could land between the Stop's decision and its record");
    emit.notify_one();
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    assert!(rows(&handle).is_empty(), "the prompt left: {:?}", rows(&handle));
}
