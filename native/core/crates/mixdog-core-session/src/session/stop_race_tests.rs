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
            emit.notified().await;
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
#[tokio::test(start_paused = true)]
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
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    assert!(rows(&handle).contains(&("user", "draft".to_owned())), "the prompt stays: {:?}", rows(&handle));
}

/// The Stop decides first and the output commits after: the hand-back stands (Node's "prompt handed back"), and the prompt leaves.
#[tokio::test(start_paused = true)]
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
    emit.notify_one();
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    assert!(rows(&handle).is_empty(), "the prompt left: {:?}", rows(&handle));
}
