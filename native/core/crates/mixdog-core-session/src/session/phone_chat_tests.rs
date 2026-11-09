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
use super::tests::eventually_on;
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

fn prompt_restores(rig: &Rig, handle: &SessionHandle) -> Vec<Value> {
    rig.feeds.frames(handle.id.as_str()).into_iter().filter(|(_, method, _)| method == "thread/promptRestore").map(|(_, _, value)| value).collect()
}

/// The recorded `own device, prompt handed back`: the sender's stop returns the text and the row leaves the transcript.
#[tokio::test(start_paused = true)]
async fn the_sender_stopping_gets_the_prompt_back_and_the_row_leaves() {
    let rig = Rig::new();
    let (_directory, handle) = running(&rig).await;
    submit(&handle, 1, "op-1", "draft", "sub1").await.expect("started");
    eventually_on(&[&handle.cell.stepped, &*rig.feeds.published], || (rows(&handle).len() == 1).then_some(())).await;
    let reply = stop(&handle, 1, None).await;
    assert_eq!(reply["aborted"], true);
    assert_eq!(reply["restoreText"], "draft");
    assert_eq!(reply["restoredSubmissionIds"], json!(["sub1"]));
    eventually_on(&[&handle.cell.stepped, &*rig.feeds.published], || idle(&handle).then_some(())).await;
    assert_eq!(rows(&handle), vec![], "the handed-back prompt left the transcript");
    assert!(prompt_restores(&rig, &handle).is_empty(), "the sender is told in the reply, not through the state");
}

/// The recorded `another device cancels: the prompt travels through the state`.
#[tokio::test(start_paused = true)]
async fn another_device_stopping_sends_the_prompt_to_the_sender_through_prompt_restore() {
    let rig = Rig::new();
    let (_directory, handle) = running(&rig).await;
    submit(&handle, 1, "op-1", "draft", "sub1").await.expect("started");
    eventually_on(&[&handle.cell.stepped, &*rig.feeds.published], || (rows(&handle).len() == 1).then_some(())).await;
    let reply = stop(&handle, 2, None).await;
    assert_eq!((reply["aborted"].clone(), reply["restoreText"].clone(), reply["restoredSubmissionIds"].clone()), (json!(true), json!(""), json!([])));
    eventually_on(&[&handle.cell.stepped, &*rig.feeds.published], || idle(&handle).then_some(())).await;
    let restores = eventually_on(&[&handle.cell.stepped, &*rig.feeds.published], || Some(prompt_restores(&rig, &handle)).filter(|frames| !frames.is_empty())).await;
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

/// `Date.now().toString(36)`, the time part of the steering mirror's id (`newSteeringPersistId`, tui-steering-persist.mjs).
fn base36(mut n: u64) -> String {
    let mut digits = Vec::new();
    while n > 0 {
        digits.push(char::from_digit((n % 36) as u32, 36).unwrap());
        n /= 36;
    }
    digits.iter().rev().collect()
}

/// A queued entry as Node holds it (`makeQueueEntry`, entry-shape.mjs), written from Rust's queued entry and its store
/// record: every key of Node's entry is here, so a key Node adds or a value that differs fails the comparison whole.
/// What Rust keeps under another name or form is mapped; what Node derives from options a prompt did not carry is the
/// default its `makeQueueEntry` gives, which holds because the entry's options are exactly the submission id.
fn node_entry(rust: &Value, clock: u64, node_at: i64, store: &[Value]) -> Value {
    assert_eq!(rust["options"], json!({ "clientSubmissionId": rust["options"]["clientSubmissionId"] }), "no option beyond the submission id");
    assert_eq!(rust["enqueuedAt"], json!(clock), "Rust stamps its clock");
    // `isQueuedEntryEditable`: a prompt that is neither meta nor display-suppressed (queue-helpers.mjs).
    assert_eq!(rust["restorable"], json!(true));
    let message = rust["message"].clone();
    assert!(message.is_string(), "a text prompt: Node's `content` is that text");
    // Node mirrors a busy-input prompt to disk (`appendTuiSteeringPersist`, drain-enqueue.mjs); Rust's mirror is the queue record.
    assert!(store.iter().any(|record| record["k"] == "queue" && record["action"] == "enqueue" && record["entry"]["inline"] == *rust), "the durable mirror");
    json!({
        "id": rust["options"]["clientSubmissionId"],
        "submittedAt": node_at,
        "text": message,
        "content": message,
        "pastedImages": null,
        "pastedTexts": null,
        "images": null,
        "onCommitted": null,
        "onSettled": null,
        "onToolResult": null,
        "transcriptMeta": rust["transcriptMeta"],
        "context": null,
        "mode": "prompt",
        "priority": "next",
        "key": null,
        "origin": null,
        "skipSlashCommands": false,
        "displayText": message,
        "suppressDisplay": false,
        "abortDiscardOnAbort": false,
        "resumeCompletionKeys": [],
        "steeringPersistId": format!("ts_{}_<random>", base36(node_at as u64)),
        "isMeta": false,
        "skillSelection": null,
        "goalId": null,
        "retryFailedTurn": false,
        "retryTurnId": null,
        "retryAttemptId": null,
    })
}

/// What Node's session handed its surfaces (`events`), as the frames Rust publishes for the same thing, `(method, payload)`.
/// A state patch that carries the queue is a `thread/queue/changed`; a row pushed is an `item/completed` and the prompt
/// history's `added`; the busy patch is `turn/started`. An entry that is queued and leaves the queue again within the
/// case went straight to a turn (drain.mjs takes it at once), which Rust starts without ever queuing.
fn node_frames(events: &[Value]) -> Vec<(String, Value)> {
    let last_queue = events.iter().rev().find_map(|event| event["patch"].get("queued"));
    let transit = last_queue.is_some_and(|queue| queue == &json!([]));
    let mut out = Vec::new();
    for event in events {
        match event["call"].as_str().unwrap() {
            "set" => {
                if let Some(queue) = event["patch"].get("queued").filter(|_| !transit) {
                    out.push(("thread/queue/changed".to_owned(), json!({ "queued": queue.as_array().unwrap().iter().map(|entry| entry["displayText"].clone()).collect::<Vec<_>>() })));
                }
                if event["patch"]["busy"] == true {
                    out.push(("turn/started".to_owned(), json!({})));
                }
            }
            "pushUserOrSyntheticItem" => {
                out.push(("item/completed".to_owned(), json!({ "text": event["text"], "displayText": event["text"] })));
                out.push(("thread/promptHistory/updated".to_owned(), json!({ "kind": "added", "prompt": event["text"] })));
            }
            other => panic!("an event this replay does not map: {other}"),
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

fn rust_frames(frames: &[(u64, String, Value)]) -> Vec<(String, Value)> {
    let mut out: Vec<(String, Value)> = frames
        .iter()
        .map(|(_, method, params)| {
            let payload = match method.as_str() {
                "item/completed" => {
                    assert_eq!(params["item"]["type"], "userMessage");
                    json!({ "text": params["item"]["content"][0]["text"], "displayText": params["item"]["displayText"] })
                }
                "thread/queue/changed" => json!({ "queued": params["queued"].as_array().unwrap().iter().map(|entry| entry["text"].clone()).collect::<Vec<_>>() }),
                "thread/promptHistory/updated" => params["value"].clone(),
                "turn/started" => {
                    assert_eq!(params["turn"]["status"], "inProgress");
                    json!({})
                }
                other => panic!("a frame this replay does not map: {other}"),
            };
            (method.clone(), payload)
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Every recorded Node submit (`submitToSession`), whole: the answer (`true` accepted, `false` refused) and what Node left
/// behind (its stored rows, its queue entries, and every state patch and row push it made) against what Rust stored,
/// queued and published for the same submission. Only what the submits added is compared: the stores and frames from after
/// the setup. Node's `closing` admission has no counterpart here: a user prompt is accepted there and here alike, and the
/// thread refuses starts only while an idle delete fences it (`threadClosing`).
#[tokio::test(start_paused = true)]
async fn every_recorded_submit_is_accepted_or_refused_as_nodes_is() {
    let all: Value = serde_json::from_str(include_str!("../../../../fixtures/phone-chat-core/phone-chat-core.json")).unwrap();
    let cases = all["cases"].as_array().unwrap().iter().filter(|case| case["kind"] == "submit").collect::<Vec<_>>();
    assert_eq!(cases.len(), 7);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let rig = Rig::new();
        let (directory, handle) = running_on_records(&rig).await;
        let frames = || rig.feeds.frames(handle.id.as_str());
        if case["busy"] == true {
            submit(&handle, 1, "op-busy", "running", "busy1").await.expect("the run ahead");
            // Its row, its history entry and its turn start: the setup is done when all three were published.
            eventually_on(&[&handle.cell.stepped, &*rig.feeds.published], || (frames().len() == 3).then_some(())).await;
        }
        if case["admission"] == "terminal" {
            directory.shutdown_for("recorded terminal admission").await;
        }
        let (base_records, base_frames) = (rig.store.records(&handle.id).len(), frames().len());
        let mut options = case["options"].clone();
        options["clientSubmissionId"] = json!("sub1");
        let answers = case["answers"].as_array().unwrap();
        for (turn, want) in answers.iter().enumerate() {
            let got = submit_with(&handle, 1, &format!("op-{turn}"), case["prompt"].clone(), options.clone()).await;
            match (want.as_bool().unwrap(), got) {
                (true, Ok(_)) => {}
                (false, got) => refused_any(got, name),
                (true, Err(error)) => panic!("{name}: Node accepted, Rust refused: {error:?}"),
            }
        }
        let since = || frames().into_iter().skip(base_frames).collect::<Vec<_>>();
        let node = &case["after"];
        let node_events = node["events"].as_array().unwrap();
        let want_frames = node_frames(node_events);
        // Paused time: the deadline is virtual, it only fires when no step can publish what Node did, so a missing frame fails here.
        let arrived = tokio::time::timeout(
            std::time::Duration::from_secs(60),
            eventually_on(&[&handle.cell.stepped, &*rig.feeds.published], || (since().len() >= want_frames.len()).then_some(())),
        )
        .await;
        assert!(arrived.is_ok(), "{name}: frames never arrived: {:?}, Node: {want_frames:?}", rust_frames(&since()));
        // The notifications.
        assert_eq!(rust_frames(&since()), want_frames, "{name}: notifications");
        let store: Vec<Value> = rig.store.records(&handle.id)[base_records..].iter().map(|(_, record)| serde_json::to_value(record).unwrap()).collect();
        // The stored rows: Node's `{text, id, kind, device}` (drain.mjs renderBatchItems) is Rust's user item record: the text
        // is its `prompt`, the id the submission the record answers (`op-0`, the first submit), the device its transcript meta.
        let rows: Vec<Value> = store
            .iter()
            .filter(|record| record["k"] == "item" && record["role"] == "user")
            .map(|record| {
                assert_eq!(record["op"]["id"], "op-0", "{name}: the row answers the first submit");
                let mut row = json!({ "text": record["prompt"]["inline"], "id": "sub1", "kind": "user" });
                if let Some(device) = record["body"]["inline"].pointer("/meta/transcript/device") {
                    row["device"] = device.clone();
                }
                row
            })
            .collect();
        assert_eq!(&rows, node["items"].as_array().unwrap(), "{name}: stored rows");
        // The queue: Node's `queued` (the same entries as `pending`) against Rust's.
        let queued: Vec<Value> = handle.cell.queue.load().iter().map(|queued| node_entry(&queued.entry, rig.clock.0.load(std::sync::atomic::Ordering::SeqCst), case["at"].as_i64().unwrap(), &store)).collect();
        assert_eq!(&queued, node["queued"].as_array().unwrap(), "{name}: queue entries");
        assert_eq!(node["pending"], node["queued"], "{name}: Node's pending list is its queue");
        assert_eq!(node["promptRestore"], Value::Null);
    }
}

fn refused_any(result: Result<Value, CoreError>, name: &str) {
    match result {
        Err(CoreError::DomainError { code: Some(code), .. }) => assert_eq!(code.as_ref(), super::actor::SUBMIT_REFUSED, "{name}"),
        other => panic!("{name}: Node refused, Rust answered {other:?}"),
    }
}
