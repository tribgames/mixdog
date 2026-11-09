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

/// What is random on each side, as one placeholder: a string equal to a known id, a `msg_` message id, an attempt id and a request
/// digest. Everything else is compared as it is.
fn anon(value: &Value, ids: &[(&str, &str)]) -> Value {
    match value {
        Value::String(text) => match ids.iter().find(|(id, _)| id == text) {
            Some((_, placeholder)) => json!(placeholder),
            None => match text.strip_prefix("msg_") {
                Some(digits) => {
                    assert!(digits.len() == 32 && digits.bytes().all(|b| b.is_ascii_hexdigit()), "{text}");
                    json!("msg_<random>")
                }
                None => value.clone(),
            },
        },
        Value::Array(items) => Value::Array(items.iter().map(|item| anon(item, ids)).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, held)| {
                    let held = match (key.as_str(), held) {
                        ("attemptId", Value::String(_)) => json!("<random>"),
                        ("digest", Value::String(digest)) => {
                            assert!(digest.starts_with("sha256:"), "{digest}");
                            json!("<digest>")
                        }
                        _ => anon(held, ids),
                    };
                    (key.clone(), held)
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

/// Node's pushed user row (transcript-intake.mjs `pushUserOrSyntheticItem`: `{kind, id, text, at, messageId, device}`) as the wire
/// item Rust publishes for it. Each Node field has its Rust place, and every Rust field is either one of them or listed:
///   kind `'user'`  = `type: userMessage`;       id = `clientSubmissionId` (the submission id is the row's id in Node);
///   text           = `content[0].text` and `displayText` (Node's row text is the display text, `promptDisplayText`);
///   at, messageId  = `meta.at`, `meta.messageId` (`createTranscriptRouteMetadata`); device = `device`.
/// Rust-only, with no Node row field: the item's own `id`, its `turnId`s (Node's turn is not on the row) and
/// `countsForPromptHistory` (Node's `pushItem` rebuilds the prompt history for every user row: `true`).
fn wire_item(row: &Value, clock: u64) -> Value {
    let mut item = json!({
        "type": "userMessage",
        "id": "<iid>",
        "content": [{ "type": "text", "text": row["text"] }],
        "clientSubmissionId": row["id"],
        "displayText": row["text"],
        "countsForPromptHistory": true,
        "meta": { "turnId": "<turn>", "at": clock, "messageId": row["messageId"] },
    });
    if let Some(device) = row.get("device") {
        item["device"] = device.clone();
    }
    item
}

/// Node's pushed user row and the message Node's runtime was asked to run (`asked`: the `runtime.ask` content and its
/// `transcriptMeta`, which the runtime persists as the message's `meta.transcript`), as the record Rust stores for the prompt,
/// whole. Every key of Node's recorded metadata is kept as it is, but `at` (Node's submit time, Rust's clock) and `attemptId`
/// (random). Rust's record adds what Node keeps elsewhere: the row's text (`displayText`), its id (`clientSubmissionId`) and its own
/// item id (`checkpointId`, Node's `stampCheckpoint` stamps the same on the history message).
fn stored_item(row: &Value, asked: &Value, clock: u64) -> Value {
    let mut transcript = asked["options"]["transcriptMeta"].clone();
    assert_eq!(transcript["at"], row["at"], "Node stamps one submit time");
    assert_eq!(transcript["attemptId"], json!("<uuid>"));
    transcript["at"] = json!(clock);
    transcript["attemptId"] = json!("<random>");
    // Node keeps the shown text only as the row's `text`; Rust's record also holds it when it differs from the prompt.
    if asked["content"] != row["text"] {
        transcript["displayText"] = row["text"].clone();
    }
    transcript["checkpointId"] = json!("<iid>");
    transcript["clientSubmissionId"] = row["id"].clone();
    json!({
        "k": "item", "iid": "<iid>", "turn": "<turn>", "role": "user", "form": "message", "model": true, "visible": true,
        "op": { "id": "op-0", "method": "turn/start", "digest": "<digest>", "result": { "kind": "started", "turnId": "<turn>" } },
        "prompt": { "inline": row["text"] },
        "refs": [],
        "body": { "inline": { "role": "user", "content": asked["content"], "meta": { "transcript": transcript } } },
    })
}

/// Node's durable queue entry (the steering mirror's shard, as `appendTuiSteeringPersist` wrote it) and its in-memory entry
/// (`makeQueueEntry`) as the record Rust stores when it queues the prompt, whole. Rust's `message` is Node's `content`, its
/// `options.clientSubmissionId` Node's `submissionId`, `enqueuedAt` the submit time (Rust's clock) and `restorable` is
/// `isQueuedEntryEditable`, from Node's `isMeta` and `suppressDisplay`. Everything else Node's entry holds has no Rust field: it is
/// checked here to be Node's own mirror of those fields (`shard`) or an option the prompt did not set (null, false, empty).
fn stored_queue(shard: &Value, entry: &Value, at: i64, clock: u64) -> Value {
    assert_eq!(shard["submittedAt"], json!(at));
    assert_eq!(shard["at"], json!(at));
    assert_eq!(entry["submittedAt"], json!(at));
    assert_eq!(shard["id"], entry["steeringPersistId"]);
    assert_eq!(shard["submissionId"], entry["id"]);
    assert_eq!(shard["content"], entry["content"]);
    assert_eq!(shard["transcriptMeta"], entry["transcriptMeta"]);
    assert_eq!(shard["text"], entry["text"]);
    assert_eq!(entry["displayText"], entry["text"]);
    for key in ["mode", "priority"] {
        assert_eq!(shard[key], entry[key], "{key}");
    }
    assert_eq!(entry["mode"], json!("prompt"));
    let mirrored = ["id", "submittedAt", "text", "content", "transcriptMeta", "displayText", "steeringPersistId", "isMeta", "suppressDisplay", "mode", "priority"];
    for (key, value) in entry.as_object().unwrap().iter().filter(|(key, _)| !mirrored.contains(&key.as_str())) {
        assert!(value.is_null() || *value == json!(false) || *value == json!([]), "an option the prompt did not set, but Node's entry has it: {key} = {value}");
    }
    json!({
        "k": "queue", "qid": "<qid>", "action": "enqueue",
        "op": { "id": "op-0", "method": "turn/start", "digest": "<digest>", "result": { "kind": "queued", "queuedId": "<qid>" } },
        "entry": { "inline": {
            "message": shard["content"],
            "enqueuedAt": clock,
            "options": { "clientSubmissionId": shard["submissionId"] },
            "transcriptMeta": shard["transcriptMeta"],
            "restorable": entry["isMeta"] == false && entry["suppressDisplay"] == false,
        } },
    })
}

/// What Node's viewer was shown (`publications`: the store's published snapshot at each publication, whole), as the frames Rust
/// publishes for the same change, `(method, params)` with random ids as placeholders. A publication is one atomic snapshot: Node
/// has no order among the changes inside it, so inside one the frames are in Rust's order (rows, prompt history, queue, turn start);
/// the order across publications is Node's. A queue that is filled and emptied inside one chain is never published (the store
/// publishes the state as it stands at the flush, `frame-batched-store.mjs`), so it has no frame.
fn node_frames(publications: &[Value], at: i64, clock: u64) -> Vec<(String, Value)> {
    let mut out = Vec::new();
    let (mut rows, mut history, mut queued, mut busy) = (0usize, Vec::<Value>::new(), Vec::<Value>::new(), false);
    for publication in publications {
        let state = &publication["state"];
        let items = state["items"].as_array().unwrap();
        for row in &items[rows..] {
            assert_eq!(row["at"], json!(at), "Node stamps the submit time");
            out.push(("item/completed".to_owned(), json!({ "turnId": "<turn>", "item": wire_item(row, clock) })));
        }
        rows = items.len();
        let list = state["promptHistoryList"].as_array().unwrap();
        if *list != history {
            // `pushItem` puts the new prompt first in the merged list (`buildMergedPromptHistory`): an `added`.
            assert_eq!(list[1..], history[..], "the prompt history gained one prompt");
            out.push(("thread/promptHistory/updated".to_owned(), json!({ "value": { "kind": "added", "prompt": list[0] } })));
            history = list.clone();
        }
        let queue = state["queued"].as_array().unwrap();
        if *queue != queued {
            let row = |entry: &Value| json!({ "id": "<qid>", "text": entry["displayText"], "enqueuedAt": clock, "clientSubmissionId": entry["id"] });
            out.push(("thread/queue/changed".to_owned(), json!({ "queued": queue.iter().map(row).collect::<Vec<_>>() })));
            queued = queue.clone();
        }
        if state["busy"] == true && !busy {
            assert_eq!(state["spinner"]["startedAt"], json!(at), "the turn starts at the submit");
            out.push(("turn/started".to_owned(), json!({ "turn": { "id": "<turn>", "status": "inProgress", "startedAt": clock } })));
        }
        busy = state["busy"] == true;
    }
    out
}

/// Every recorded Node submit (`submitToSession`), whole: the answer (`true` accepted, `false` refused) and what Node left
/// behind (its stored rows, its queue entries, and what its viewer was shown) against what Rust stored, queued and published for
/// the same submission. Only what the submits added is compared: the stores and frames from after the setup. Node's `closing`
/// admission has no counterpart here: a user prompt is accepted there and here alike, and the thread refuses starts only while an
/// idle delete fences it (`threadClosing`). Every comparison is of the whole value: the stored records and the published frames
/// are built from Node's rows and entries and compared to Rust's as they are, so a field Rust adds fails.
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
        let at = case["at"].as_i64().unwrap();
        let clock = rig.clock.0.load(std::sync::atomic::Ordering::SeqCst);
        let want_frames = node_frames(node["publications"].as_array().unwrap(), at, clock);
        // Paused time: the deadline is virtual, it only fires when no step can publish what Node did, so a missing frame fails here.
        let arrived = tokio::time::timeout(
            std::time::Duration::from_secs(60),
            eventually_on(&[&handle.cell.stepped, &*rig.feeds.published], || (since().len() >= want_frames.len()).then_some(())),
        )
        .await;
        assert!(arrived.is_ok(), "{name}: frames never arrived: {:?}, Node: {want_frames:?}", since());
        let store: Vec<Value> = rig.store.records(&handle.id)[base_records..].iter().map(|(_, record)| serde_json::to_value(record).unwrap()).collect();
        // The ids Rust gave: the user item's and its turn's, the queue entry's.
        let id_of = |value: &Value, key: &str| value[key].as_str().unwrap().to_owned();
        let user_records = store.iter().filter(|record| record["k"] == "item" && record["role"] == "user").collect::<Vec<_>>();
        let queue_records = store.iter().filter(|record| record["k"] == "queue").collect::<Vec<_>>();
        let (iid, turn) = user_records.first().map(|record| (id_of(record, "iid"), id_of(record, "turn"))).unwrap_or_default();
        let qid = queue_records.first().map(|record| id_of(record, "qid")).unwrap_or_default();
        let ids = [(iid.as_str(), "<iid>"), (turn.as_str(), "<turn>"), (qid.as_str(), "<qid>")];
        let ids = &ids[..].iter().copied().filter(|(id, _)| !id.is_empty()).collect::<Vec<_>>();

        // The notifications, whole and in order.
        let rust_frames: Vec<(String, Value)> = since()
            .into_iter()
            .map(|(_, method, mut params)| {
                assert_eq!(params.as_object_mut().unwrap().remove("threadId"), Some(json!(handle.id)), "{name}: {method}");
                (method, anon(&params, ids))
            })
            .collect();
        assert_eq!(rust_frames, want_frames, "{name}: notifications");

        // The stored rows, whole. Node's row maps to the record as `stored_item` says; the ids (`iid`, `turn`) are Rust's own,
        // and `checkpointId` is the item's own id.
        let node_rows = node["items"].as_array().unwrap();
        assert_eq!(user_records.len(), node_rows.len(), "{name}: stored rows");
        let asked = node["asked"].as_array().unwrap();
        assert_eq!(asked.len(), node_rows.len(), "{name}: a started turn per stored row");
        for ((record, row), asked) in user_records.iter().zip(node_rows).zip(asked) {
            assert_eq!(row["at"], json!(at));
            assert_eq!(anon(record, ids), stored_item(row, asked, clock), "{name}: stored row");
        }
        // The stored queue entries, whole, against Node's durable mirror and its in-memory entries; and the runtime records no Node row
        // stands for (bookkeeping of the run).
        let node_queued = node["queued"].as_array().unwrap();
        let shard: Vec<&Value> = node["durable"]["sessions"].as_object().into_iter().flat_map(|sessions| sessions.values()).flat_map(|rows| rows.as_array().unwrap()).collect();
        assert_eq!(shard.len(), node_queued.len(), "{name}: Node mirrors every queued entry");
        assert_eq!(queue_records.len(), node_queued.len(), "{name}: stored queue entries");
        for ((record, entry), shard) in queue_records.iter().zip(node_queued).zip(shard) {
            let want = stored_queue(shard, entry, at, clock);
            assert_eq!(anon(record, ids), want, "{name}: stored queue entry");
        }
        for record in &store {
            assert!(["item", "queue", "meta", "run"].contains(&record["k"].as_str().unwrap()), "{name}: a record Node has no counterpart for: {record}");
        }
        // The queue Rust holds is the stored entries (the durable mirror).
        let queued: Vec<Value> = handle.cell.queue.load().iter().map(|queued| json!({ "k": "queue", "entry": { "inline": queued.entry } })).collect();
        let stored: Vec<Value> = queue_records.iter().map(|record| json!({ "k": "queue", "entry": record["entry"] })).collect();
        assert_eq!(queued, stored, "{name}: queue entries");
        // Every entry Node's viewer was shown is one of them, whole.
        for publication in node["publications"].as_array().unwrap() {
            for entry in publication["state"]["queued"].as_array().unwrap() {
                assert!(node_queued.contains(entry), "{name}: a published queue entry that Node does not keep");
            }
        }
        assert_eq!(node["pending"], node["queued"], "{name}: Node's pending list is its queue");
        assert_eq!(node["promptRestore"], Value::Null);
    }
}

/// A wait that fails with the rows it saw instead of hanging: paused time makes the deadline fire only when nothing can still happen.
async fn within<T>(wait: impl std::future::Future<Output = T>, name: &str, seen: &[(&'static str, String)]) -> T {
    tokio::time::timeout(std::time::Duration::from_secs(60), wait).await.unwrap_or_else(|_| panic!("{name}: never reached; rows {seen:?}"))
}

/// Node's transcript rows after a turn (`user`, `assistant`, `turndone`) as the wire items Rust holds for them. Every key of Node's row
/// is taken from the row, and the key set is asserted, so a key this mapping does not place fails. Ids are placeholders by first
/// appearance (the user row's is the submission id, which Rust carries as `clientSubmissionId`); times are Rust's clock; a Node
/// `attemptId` is random. Where Rust keeps a Node field under another name: the turn end's `checkpointId` (the user row's id in Node)
/// is the user item's id here, the submission id riding in the end's `clientSubmissionId`.
fn rewind_wire(row: &Value, rows: &[Value], clock: u64) -> Value {
    let keys = |expected: &[&str]| {
        let mut held: Vec<&str> = row.as_object().unwrap().keys().map(String::as_str).collect();
        held.sort_unstable();
        let mut expected = expected.to_vec();
        expected.sort_unstable();
        assert_eq!(held, expected, "the keys of Node's {} row", row["kind"]);
    };
    assert_eq!(row["at"], rows[0]["at"], "one submit time");
    match row["kind"].as_str().unwrap() {
        "user" => {
            keys(&["kind", "id", "text", "at", "messageId", "device"]);
            wire_item(row, clock)
        }
        "assistant" => {
            keys(&["kind", "id", "text", "at", "messageId", "device", "completionVerb", "attemptId", "streaming"]);
            json!({
                "type": "agentMessage", "id": "<aid>", "text": row["text"],
                "meta": { "turnId": "<turn>", "ext": { "attemptId": "<random>", "at": clock, "messageId": row["messageId"], "completionVerb": row["completionVerb"], "device": row["device"], "streaming": row["streaming"] } },
            })
        }
        "turndone" => {
            keys(&["kind", "id", "checkpointId", "elapsedMs", "status", "finalAssistantId", "outputTokens", "thinkingElapsedMs", "toolCount", "verb", "at", "device", "completionVerb", "attemptId"]);
            assert_eq!(row["checkpointId"], rows[0]["id"], "the end names the user row");
            assert_eq!(row["finalAssistantId"], rows[1]["id"], "the end names the answer");
            json!({
                "type": "turnEnd", "id": "<eid>", "status": row["status"], "elapsedMs": row["elapsedMs"], "verb": row["verb"],
                "checkpointId": "<iid>", "finalAssistantId": "<aid>",
                "meta": { "turnId": "<turn>", "at": clock, "ext": { "outputTokens": row["outputTokens"], "thinkingElapsedMs": row["thinkingElapsedMs"], "toolCount": row["toolCount"], "clientSubmissionId": rows[0]["id"], "device": row["device"], "attemptId": "<random>", "completionVerb": row["completionVerb"] } },
            })
        }
        other => panic!("a Node row of kind {other}"),
    }
}

/// Node's message selector (`rewindToItem`, intake/rewind.mjs) on a submitted row: the client names the row by the id it shows, the
/// submission id, and Node resolves that on its rows, then rewinds to the row's stable message id. Rust resolves the displayed id the
/// same way, and answers what Node answers: the prompt's text and the number of rows removed (the prompt, its answer and its turn
/// end), an id that is no row as `ItemNotFound` (Node's `null`), a running turn as `PreconditionFailed` (Node's `null` while busy).
#[tokio::test(start_paused = true)]
async fn every_recorded_rewind_resolves_the_displayed_id_as_nodes_does() {
    let all: Value = serde_json::from_str(include_str!("../../../../fixtures/phone-chat-core/phone-chat-core.json")).unwrap();
    let cases = all["cases"].as_array().unwrap().iter().filter(|case| case["kind"] == "rewind").collect::<Vec<_>>();
    assert_eq!(cases.len(), 3);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let rig = Rig::new();
        let busy = case["busy"] == true;
        if busy {
            rig.set_script(Arc::new(|run| {
                Box::pin(async move {
                    run.cancel.cancelled().await;
                    RunOutcome::Interrupted
                })
            }));
        } else {
            // An answer in the stored message shape, which the record transcript shows as a row (the echo's `{text}` body is not one).
            rig.set_script(Arc::new(|run| {
                Box::pin(async move {
                    run.port.input_durable().await.expect("input durable");
                    let iid = mixdog_core_api::ids::ItemId::from(format!("a-{}", run.turn));
                    run.port.delta(iid.clone(), "hi".into()).await.expect("delta");
                    run.port
                        .commit_item(super::ItemCommit {
                            iid,
                            role: Some("assistant".into()),
                            model: true,
                            visible: true,
                            // The stored answer carries the completion the runtime stamps (`meta.transcript.completion`).
                            body: json!({ "role": "assistant", "content": "hi", "meta": { "transcript": { "completion": { "verb": "Mapped" } } } }),
                            prompt: None,
                        })
                        .await
                        .expect("commit");
                    // The turn did something (the answer is its result), so it ends with its live end row, as Node's did (`isNoOpTurn`).
                    RunOutcome::Completed(Box::new(mixdog_agent::agent_tool::flow::seams::TurnResult { content: "hi".into(), ..Default::default() }))
                })
            }));
        }
        // The stored records' own rows: the rig's text-only transcript carries no submission id on the user row.
        let mut deps = rig.deps_parts(rig.store.clone());
        deps.transcript = Arc::new(super::testing::RecordTranscript::new());
        let directory = SessionDirectory::new(Arc::new(deps));
        let handle = start_thread(&directory).await;
        submit(&handle, 1, "op-0", case["prompt"].as_str().unwrap(), "sub1").await.expect("the prompt");
        if busy {
            within(eventually_on(&[&handle.cell.stepped, &*rig.feeds.published], || (rows(&handle).len() == 1).then_some(())), name, &rows(&handle)).await;
        } else {
            // The prompt, its answer and the turn's live end: the rows Node held (`before.items`).
            within(eventually_on(&[&handle.cell.stepped, &*rig.feeds.published], || (idle(&handle) && rows(&handle).len() == 3).then_some(())), name, &rows(&handle)).await;
            let clock = rig.clock.0.load(std::sync::atomic::Ordering::SeqCst);
            let items: Vec<Value> = handle.cell.view.load_full().items.iter().map(|item| serde_json::to_value(item.as_ref()).unwrap()).collect();
            let ids = [(items[0]["id"].as_str().unwrap(), "<iid>"), (items[1]["id"].as_str().unwrap(), "<aid>"), (items[2]["id"].as_str().unwrap(), "<eid>"), (items[0]["meta"]["turnId"].as_str().unwrap(), "<turn>")];
            let held: Vec<Value> = items.iter().map(|item| anon(item, &ids)).collect();
            let node_rows = case["before"]["items"].as_array().unwrap();
            let want: Vec<Value> = node_rows.iter().map(|row| rewind_wire(row, node_rows, clock)).collect();
            assert_eq!(held, want, "{name}: the rows the session held");
            // The stored user record against what Node's runtime was asked to persist, once the answer's own stamps are accounted for.
            let mut asked = case["asked"].clone();
            let stamps = asked["options"]["transcriptMeta"].as_object_mut().unwrap();
            assert_eq!(stamps.remove("assistantAt"), Some(node_rows[1]["at"].clone()), "the answer's time");
            assert_eq!(stamps.remove("assistantMessageId"), Some(node_rows[1]["messageId"].clone()), "the answer's message id");
            let records = rig.store.records(&handle.id);
            let user = records.iter().map(|(_, record)| serde_json::to_value(record).unwrap()).find(|record| record["k"] == "item" && record["role"] == "user").unwrap();
            let (iid, turn) = (user["iid"].as_str().unwrap(), user["turn"].as_str().unwrap());
            assert_eq!(anon(&user, &[(iid, "<iid>"), (turn, "<turn>")]), stored_item(&node_rows[0], &asked, clock), "{name}: stored row");
        }
        let rewound = handle
            .request(CoreRequest {
                method: Method("thread/rewind"),
                params: json!({ "threadId": handle.id, "opId": "op-rewind", "itemId": case["itemId"] }),
                op: Some(OpId::from("op-rewind")),
                ctx: from(1),
            })
            .await;
        match &case["reply"] {
            Value::Null if busy => assert!(matches!(rewound, Err(CoreError::PreconditionFailed { .. })), "{name}: {rewound:?}"),
            Value::Null => assert!(matches!(rewound, Err(CoreError::ItemNotFound { .. })), "{name}: {rewound:?}"),
            reply => {
                let Ok(Reply::Value(value)) = rewound else { panic!("{name}: Node rewound, Rust answered {rewound:?}") };
                assert_eq!(&value, reply, "{name}: the reply, whole");
                // Node asked the runtime to rewind to the row's message id with its text; the row is gone and the history is as before it.
                assert_eq!(case["runtimeCalls"][1]["options"]["text"], reply["text"]);
                assert_eq!(case["runtimeCalls"][1]["result"]["removed"], reply["messages"], "the messages the runtime removed");
                within(eventually_on(&[&handle.cell.stepped, &*rig.feeds.published], || rows(&handle).is_empty().then_some(())), name, &rows(&handle)).await;
                assert_eq!(case["after"]["items"], json!([]), "{name}: Node's transcript is empty");
            }
        }
    }
}

/// What the recorder's store published is Node's real `frame-batched-store` publishing: it guards and coalesces, so a chain of two
/// immediate flushes is one publication, and a publication always shows a change from the one before. A recorder that published per
/// call would show two (the reviewer's probe) or repeated snapshots here.
#[test]
fn the_recorded_publishing_is_coalesced_as_nodes_store_does() {
    let all: Value = serde_json::from_str(include_str!("../../../../fixtures/phone-chat-core/phone-chat-core.json")).unwrap();
    let cases = all["cases"].as_array().unwrap();
    let probe = cases.iter().find(|case| case["kind"] == "flush").expect("the flush probe is recorded");
    assert_eq!(probe["flushes"], json!(2));
    assert_eq!(probe["publications"].as_array().unwrap().len(), 1, "two immediate flushes in one chain");
    for case in cases {
        let publications = case["publications"].as_array().or_else(|| case["after"]["publications"].as_array());
        let Some(publications) = publications else { continue };
        for pair in publications.windows(2) {
            assert_ne!(pair[0]["state"], pair[1]["state"], "{}: a publication that shows nothing new", case["name"]);
        }
    }
}

fn refused_any(result: Result<Value, CoreError>, name: &str) {
    match result {
        Err(CoreError::DomainError { code: Some(code), .. }) => assert_eq!(code.as_ref(), super::actor::SUBMIT_REFUSED, "{name}"),
        other => panic!("{name}: Node refused, Rust answered {other:?}"),
    }
}
