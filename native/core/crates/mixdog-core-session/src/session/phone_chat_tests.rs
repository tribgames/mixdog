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
use super::testing::awaiting;
use super::testing::awaiting_for;
use crate::eventually_on;
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

/// The recorded `another device cancels: the prompt travels through the state`.
#[tokio::test(start_paused = true)]
async fn another_device_stopping_sends_the_prompt_to_the_sender_through_prompt_restore() {
    let rig = Rig::new();
    let (_directory, handle) = running(&rig).await;
    submit(&handle, 1, "op-1", "draft", "sub1").await.expect("started");
    eventually_on!(&[&handle.cell.stepped, &*rig.feeds.published], || (rows(&handle).len() == 1).then_some(())).await;
    // The rig's clock at the moment of the restore, set by the test: `PromptRestore` is stamped from it (Node: `Date.now()`, `abort.mjs:72,76`).
    let clock: u64 = 7777;
    rig.clock.0.store(clock, std::sync::atomic::Ordering::SeqCst);
    let reply = stop(&handle, 2, None).await;
    assert_eq!((reply["aborted"].clone(), reply["restoreText"].clone(), reply["restoredSubmissionIds"].clone()), (json!(true), json!(""), json!([])));
    eventually_on!(&[&handle.cell.stepped, &*rig.feeds.published], || idle(&handle).then_some(())).await;
    let restores = awaiting(
        || "the prompt restore frame".to_owned(),
        eventually_on!(&[&handle.cell.stepped, &*rig.feeds.published], || Some(prompt_restores(&rig, &handle)).filter(|frames| !frames.is_empty())),
    )
    .await;
    let all: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/phone-chat-core/phone-chat-core.json")).unwrap();
    let case = all["cases"].as_array().unwrap().iter().find(|case| case["name"] == "another device cancels: the prompt travels through the state").unwrap();
    // The only restore Node's state held and published, whole. Two parts are the rig's, not the core's: the clock (Node's recorded
    // 1700000000450 is its fake clock; the id `restore-<clock>-<first submission id>` and `at` carry it, here the value the test set
    // before the stop) and the device name (Node's "PC" is connection 1, which `NamedDevices` names `desktop-1`).
    let mut want = case["after"]["promptRestore"].clone();
    want["id"] = json!(format!("restore-{clock}-{}", want["ids"][0].as_str().unwrap()));
    want["at"] = json!(clock);
    assert_eq!(want["device"], "PC");
    want["device"] = json!("desktop-1");
    assert_eq!(restores, vec![json!({ "threadId": handle.id, "value": want })]);
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

/// The message ids of one side, numbered by first appearance: `msg_<1>` is the first id seen, and every later sight of the same id is
/// the same number. Both sides are numbered this way (Rust's are random `msg_` and 32 hex digits; Node's recording is numbered the
/// same way by the recorder), so which rows share a message id and which differ is compared, not the random digits.
#[derive(Default)]
struct Labels(Vec<String>);

impl Labels {
    fn msg(&mut self, id: &str) -> String {
        let at = self.0.iter().position(|seen| seen == id).unwrap_or_else(|| {
            self.0.push(id.to_owned());
            self.0.len() - 1
        });
        format!("msg_<{}>", at + 1)
    }
}

/// Node's value with its message ids numbered as the recorder numbered them (first appearance), in the order this side was compared.
fn renumber(value: &Value, labels: &mut Labels) -> Value {
    match value {
        Value::String(text) if text.starts_with("msg_") => json!(labels.msg(text)),
        Value::Array(items) => Value::Array(items.iter().map(|item| renumber(item, labels)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(key, held)| (key.clone(), renumber(held, labels))).collect()),
        other => other.clone(),
    }
}

/// What is random on Rust's side, as a placeholder: a string equal to a known id, a `msg_` message id (numbered by first
/// appearance), an attempt id and a request digest. Everything else is compared as it is.
fn anon(value: &Value, ids: &[(&str, &str)], labels: &mut Labels) -> Value {
    match value {
        Value::String(text) => match ids.iter().find(|(id, _)| id == text) {
            Some((_, placeholder)) => json!(placeholder),
            None => match text.strip_prefix("msg_") {
                Some(digits) => {
                    assert!(digits.len() == 32 && digits.bytes().all(|b| b.is_ascii_hexdigit()), "{text}");
                    json!(labels.msg(text))
                }
                None => value.clone(),
            },
        },
        Value::Array(items) => Value::Array(items.iter().map(|item| anon(item, ids, labels)).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, held)| {
                    let held = match (key.as_str(), held) {
                        ("attemptId", Value::String(_)) => json!("<random>"),
                        ("digest", Value::String(digest)) => {
                            assert!(digest.starts_with("sha256:"), "{digest}");
                            json!("<digest>")
                        }
                        _ => anon(held, ids, labels),
                    };
                    (key.clone(), held)
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

/// A closed table over one recorded Node object: every field it holds is either `mapped` (the caller compares it to the Rust field it
/// maps to) or Node-only, named here with the exact value (and type) Node recorded and why no phone or desktop can see it. A field in
/// neither list fails, and so does a listed field the recording lacks or a Node-only one whose value differs.
fn closed(what: &str, node: &Value, mapped: &[&str], only: &[(&str, Value, &str)]) {
    let held = node.as_object().unwrap_or_else(|| panic!("{what}: not an object: {node}"));
    for (key, value) in held {
        if mapped.contains(&key.as_str()) {
            continue;
        }
        match only.iter().find(|(name, ..)| name == key) {
            Some((_, want, _)) => assert_eq!(value, want, "{what}: Node-only field {key}"),
            None => panic!("{what}: Node field {key} = {value} is in neither the mapped nor the Node-only list"),
        }
    }
    for key in mapped.iter().copied().chain(only.iter().map(|(name, ..)| *name)) {
        assert!(held.contains_key(key), "{what}: the table names {key}, the recording has none");
    }
}

/// The ids Rust gave a turn's rows, as the placeholders its comparisons use, and the operation that started it.
struct Place<'a> {
    iid: &'a str,
    turn: &'a str,
    op: &'a str,
}

/// Node's pushed user row (transcript-intake.mjs `pushUserOrSyntheticItem`: `{kind, id, text, at, messageId, device}`) as the wire
/// item Rust publishes for it. Each Node field has its Rust place, and every Rust field is either one of them or listed:
///   kind `'user'`  = `type: userMessage`;       id = `clientSubmissionId` (the submission id is the row's id in Node);
///   text           = `content[0].text` and `displayText` (Node's row text is the display text, `promptDisplayText`);
///   at, messageId  = `meta.at`, `meta.messageId` (`createTranscriptRouteMetadata`); device = `device`.
/// Rust-only, with no Node row field: the item's own `id`, its `turnId`s (Node's turn is not on the row) and
/// `countsForPromptHistory` (Node's `pushItem` rebuilds the prompt history for every user row: `true`).
fn wire_item(row: &Value, clock: u64, place: &Place) -> Value {
    let mut bare = row.clone();
    bare.as_object_mut().unwrap().remove("device");
    closed("Node user row", &bare, &["kind", "id", "text", "at", "messageId"], &[]);
    let mut item = json!({
        "type": "userMessage",
        "id": place.iid,
        "content": [{ "type": "text", "text": row["text"] }],
        "clientSubmissionId": row["id"],
        "displayText": row["text"],
        "countsForPromptHistory": true,
        "meta": { "turnId": place.turn, "at": clock, "messageId": row["messageId"] },
    });
    if let Some(device) = row.get("device") {
        item["device"] = device.clone();
    }
    item
}

/// The in-process callbacks of the options Node's runtime was asked with (`runtime.ask`): functions have no stored form.
const ASK_CALLBACKS: [&str; 21] = [
    "onSkillsApplied", "drainSteering", "onSteerMessage", "onContextPressure", "onCompactEvent", "onUsageDelta", "onAssistantToolCallObserved", "onToolCall",
    "onToolResult", "onToolPhaseCompleted", "onToolApproval", "onProviderSendStarted", "onStageChange", "onTextDelta", "onTextReset", "onAssistantText",
    "onReasoningDelta", "onStreamItemStart", "onRouteApplied", "onModelSwitch", "onSessionSwitches",
];

/// Node's pushed user row and the message Node's runtime was asked to run (`asked`: the `runtime.ask` content and its options), as the
/// record Rust stores for the prompt, whole. The options are a closed table: `id` and `submissionIds` are the submission id the record
/// keeps as `clientSubmissionId`, `submittedAt` is the submit time (`at`), `transcriptMeta` is the message's `meta.transcript` (every key of
/// it is kept, but `at`, Node's submit time against Rust's clock, the random `attemptId`, and `completionVerb`, which Node's persisted
/// prompt drops); the rest is Node-only. Rust's record adds
/// what Node keeps elsewhere: the row's text (`displayText`, only when it differs from the prompt), the row's id (`clientSubmissionId`)
/// and the item's own id (`checkpointId`, which Node's `stampCheckpoint` stamps on the history message too).
fn stored_item(row: &Value, asked: &Value, clock: u64, place: &Place) -> Value {
    let options = &asked["options"];
    let function = json!("[function]");
    let mut only: Vec<(&str, Value, &str)> = vec![
        ("retryFailedTurn", json!(false), "a retry's marker; this prompt is no retry, and the stored retry provenance is absent"),
        ("retryTurnId", Value::Null, "a retry's turn; none for a first run"),
        ("retryAttemptId", Value::Null, "a retry's attempt; none for a first run"),
        ("context", Value::Null, "a follow-up's caller context (`entry-shape.mjs:32`); none was given"),
    ];
    only.extend(ASK_CALLBACKS.iter().map(|name| (*name, function.clone(), "an in-process callback of the run; it has no stored or wire form")));
    closed("the options Node's runtime was asked with", options, &["id", "submissionIds", "submittedAt", "transcriptMeta"], &only);
    assert_eq!(options["id"], row["id"], "the run is named by the submission id");
    assert_eq!(options["submissionIds"], json!([row["id"]]), "the run's submissions");
    assert_eq!(options["submittedAt"], row["at"], "Node stamps one submit time");
    let mut transcript = options["transcriptMeta"].clone();
    assert_eq!(transcript["at"], row["at"], "Node stamps one submit time");
    assert_eq!(transcript["attemptId"], json!("<uuid>"));
    transcript["at"] = json!(clock);
    transcript["attemptId"] = json!("<random>");
    // The turn's verb stays with the turn: Node's persisted prompt leaves it out (`persistedUserTranscriptMetadata`,
    // transcript-metadata.mjs:92), and the `applied-skills` replay compares Rust's record with that persisted row whole.
    if let Some(meta) = transcript.as_object_mut() {
        meta.remove("completionVerb");
    }
    // Node keeps the shown text only as the row's `text`; Rust's record also holds it when it differs from the prompt.
    if asked["content"] != row["text"] {
        transcript["displayText"] = row["text"].clone();
    }
    transcript["checkpointId"] = json!(place.iid);
    transcript["clientSubmissionId"] = row["id"].clone();
    json!({
        "k": "item", "iid": place.iid, "turn": place.turn, "role": "user", "form": "message", "model": true, "visible": true,
        "op": { "id": place.op, "method": "turn/start", "digest": "<digest>", "result": { "kind": "started", "turnId": place.turn } },
        "prompt": { "inline": row["text"] },
        "refs": [],
        "body": { "inline": { "role": "user", "content": asked["content"], "meta": { "transcript": transcript } } },
    })
}

/// Node's durable queue entry (the steering mirror's shard, as `appendTuiSteeringPersist` wrote it) and its in-memory entry
/// (`makeQueueEntry`) as the record Rust stores when it queues the prompt, whole. Each is a closed table (`closed`).
/// Entry, mapped: `content` is Rust's `message`; `id` is `options.clientSubmissionId`; `submittedAt` is `enqueuedAt` (Rust's clock);
/// `transcriptMeta` and `priority` are the fields of the same name; `isMeta` is `restorable` (`isQueuedEntryEditable`, `queue-helpers.mjs:35`:
/// a prompt is editable unless it is meta); `text` and `displayText` are Node's copies of `content`, equal here as the prompt is plain text;
/// `steeringPersistId` is the mirror's own key for the entry (`shard.id`). Everything else is Node-only: the table below.
fn stored_queue(shard: &Value, entry: &Value, durable: &Value, at: i64, clock: u64) -> Value {
    // Evidence for every Node-only queue field: `projectSessionState` (`session-state-projection.mjs:34-50`) builds the queue a client is sent
    // from id, submittedAt, text, displayText, transcriptMeta's source fields, mode, priority and images only; `pastedImages` and `pastedTexts`
    // reach the composer through the interrupt reply (`queue-helpers.mjs:138,166`, `abort.mjs:50-51`) and are mapped above.
    const UNSET: &str = "an option the prompt did not set; Rust stores an option only when the prompt sets it (not in the client projection, session-state-projection.mjs:37-48)";
    closed(
        "Node queue entry",
        entry,
        &["id", "submittedAt", "text", "content", "transcriptMeta", "displayText", "steeringPersistId", "isMeta", "priority", "mode", "images", "pastedImages", "pastedTexts"],
        &[
            ("onCommitted", Value::Null, "an in-process callback a caller may pass; none was"),
            ("onSettled", Value::Null, "an in-process callback a caller may pass; none was"),
            ("onToolResult", Value::Null, "an in-process callback a caller may pass; none was"),
            ("context", Value::Null, "a follow-up's caller context; none was given"),
            ("key", Value::Null, "the dedupe key of a runtime-made entry; a user prompt has none"),
            ("origin", Value::Null, "the channel a prompt came from; none"),
            // The only renderer reader is conversation-prompt-items.ts:137, on the entries the projection sends; the projection drops the
            // field (session-state-projection.mjs:40-48), so that reader sees it absent for Node and for the core alike.
            ("skipSlashCommands", json!(false), UNSET),
            ("suppressDisplay", json!(false), "hides the row from the transcript; a user prompt shows"),
            ("abortDiscardOnAbort", json!(false), UNSET),
            ("resumeCompletionKeys", json!([]), "a pending-resume entry's completions; this is no resume"),
            ("skillSelection", Value::Null, UNSET),
            ("goalId", Value::Null, "the goal an entry belongs to; this belongs to none"),
            ("retryFailedTurn", json!(false), "a retry's marker; this prompt is no retry"),
            ("retryTurnId", Value::Null, "a retry's turn; none for a first run"),
            ("retryAttemptId", Value::Null, "a retry's attempt; none for a first run"),
        ],
    );
    // The mirror holds the pasted images only when the entry has them.
    let mut held = vec!["id", "text", "at", "submissionId", "submittedAt", "content", "transcriptMeta", "priority", "mode"];
    for key in ["pastedImages", "pastedTexts"] {
        assert_eq!(shard.get(key).is_some(), !entry[key].is_null(), "the mirror holds the entry's {key} when it has any");
        if shard.get(key).is_some() {
            assert_eq!(shard[key], entry[key], "the mirror holds the entry's {key}");
            held.push(key);
        }
    }
    closed(
        "Node steering mirror entry",
        shard,
        &held,
        &[],
    );
    closed(
        "Node steering mirror file",
        durable,
        &["sessions", "updatedAt", "sessionTouchedAt"],
        &[("version", json!(1), "the mirror file's format version; Rust's queue is the session's record log, not this file")],
    );
    assert_eq!(durable["updatedAt"], json!(at));
    assert!(durable["sessionTouchedAt"].as_object().unwrap().values().all(|touched| *touched == json!(at)));
    assert_eq!(entry["submittedAt"], json!(at));
    assert_eq!(shard["submittedAt"], json!(at));
    assert_eq!(shard["at"], json!(at));
    assert_eq!(shard["id"], entry["steeringPersistId"]);
    assert!(entry["steeringPersistId"].as_str().unwrap().starts_with("ts_"), "the mirror's own key");
    assert_eq!(shard["submissionId"], entry["id"]);
    for key in ["content", "transcriptMeta", "text", "priority"] {
        assert_eq!(shard[key], entry[key], "the mirror holds the entry's {key}");
    }
    // The shown text is the content's text: the content itself for a plain prompt, its `promptContentText` for parts (compared with the
    // core's published text in `queue_row`).
    assert_eq!(entry["text"], entry["displayText"], "text and the shown text are one");
    if entry["content"].is_string() {
        assert_eq!(entry["text"], entry["content"], "text is the content");
    }
    // Mapped: `pastedImages` is the option of that name; `mode` and `images` are what the client sees, compared in `node_frames`
    // (`queue_row`); a prompt's mode is `prompt`, which Rust leaves out of the stored entry.
    assert_eq!(entry["mode"], json!("prompt"));
    assert_eq!(shard["mode"], entry["mode"], "the mirror holds the entry's mode");
    // The case was recorded at Node's runtime, below the intake; the phone's `turn/start` is `submitAdmitted`, whose
    // `materializePromptSubmission` stores each inline text and image and queues references instead ([`taken_in`]).
    let taken = taken_in(entry);
    let mut options = json!({ "clientSubmissionId": entry["id"] });
    for key in ["pastedImages", "pastedTexts"] {
        if !taken[key].is_null() {
            options[key] = taken[key].clone();
        }
    }
    json!({
        "k": "queue", "qid": "<qid>", "action": "enqueue",
        "op": { "id": "op-0", "method": "turn/start", "digest": "<digest>", "result": { "kind": "queued", "queuedId": "<qid>" } },
        "entry": { "inline": {
            "message": taken["message"],
            "enqueuedAt": clock,
            "priority": entry["priority"],
            "options": options,
            "transcriptMeta": entry["transcriptMeta"],
            "restorable": entry["isMeta"] != json!(true),
        } },
    })
}

/// What the core's `turn/start` intake (`materializePromptSubmission`, [`super::prompt_submission`]) queues of a Node entry recorded
/// below the intake: `{ message, pastedImages, pastedTexts }`, each inline text and image stored and named by reference and the
/// content's text tokens turned into the stored texts they stand for. The store holds nothing beforehand; a save is named by its
/// bytes' SHA-256, as the attachment store names it.
fn taken_in(entry: &Value) -> Value {
    use super::prompt_submission::LongText;
    use super::prompt_submission::PromptStore;
    use super::prompt_submission::materialize_prompt_submission;
    use super::prompt_submission::saved;
    struct Fresh;
    impl PromptStore for Fresh {
        fn save(&self, bytes: &[u8]) -> Result<serde_json::Map<String, Value>, String> {
            use sha2::Digest;
            Ok(saved(&format!("{:x}", sha2::Sha256::digest(bytes)), bytes.len()))
        }
        fn stored_len(&self, _: &str) -> Result<Option<u64>, String> {
            Ok(None)
        }
    }
    let mut options = json!({});
    for key in ["pastedImages", "pastedTexts"] {
        if !entry[key].is_null() {
            options[key] = entry[key].clone();
        }
    }
    let taken = materialize_prompt_submission(&Fresh, &entry["content"], &options, LongText::Inline).expect("Node's entry is taken in");
    let table = |key: &str| taken.options.get(key).cloned().unwrap_or(Value::Null);
    json!({ "message": taken.prompt, "pastedImages": table("pastedImages"), "pastedTexts": table("pastedTexts") })
}

/// The queue row the core publishes for a Node entry recorded below the intake: Node's projection (`queue_row`), unless the
/// intake changed the entry ([`taken_in`]). Then the text and image chips are the core's drawing of the entry the intake queues
/// (`RecordTranscript::queued`): an image chip names its stored image and counts its stored bytes, and a stored paste shows as
/// its chip without the line count, as the core's queue row reads no store (Node's `promptDisplayText` over the same prompt
/// reads the paste back).
fn taken_row(mut row: Value, entry: &Value) -> Value {
    use super::seams::Transcript;
    let taken = taken_in(entry);
    if taken["message"] == entry["content"] && taken["pastedImages"] == entry["pastedImages"] && taken["pastedTexts"] == entry["pastedTexts"] {
        return row;
    }
    let drawn = super::transcript::RecordTranscript::new().queued("<qid>", &json!({ "message": taken["message"], "options": { "pastedImages": taken["pastedImages"] } }));
    row["text"] = drawn["text"].clone();
    match drawn.get("images") {
        Some(images) => row["images"] = images.clone(),
        None => drop(row.as_object_mut().map(|row| row.shift_remove("images"))),
    }
    row
}

/// One row of what Node's daemon sends a client of its queue (`projectSessionState`, `session-state-projection.mjs:33-49`), as the row the
/// core publishes for it. Every field the projection can hold is mapped: `id` is the submission id (the core's `id` is its own queue id,
/// `<qid>`); `submittedAt` is `enqueuedAt`; `text` and `displayText` are one text; `mode`, `priority`, the sender's source fields and
/// `images` keep their names. A field outside this table fails.
fn queue_row(projected: &Value, at: i64, clock: u64) -> Value {
    for key in projected.as_object().unwrap().keys() {
        assert!(["id", "submittedAt", "text", "displayText", "mode", "priority", "sender", "device", "fromAgent", "images"].contains(&key.as_str()), "Node projects a queue field {key} no table maps");
    }
    assert_eq!(projected["submittedAt"], json!(at), "Node stamps the submit time");
    assert_eq!(projected["displayText"], projected["text"], "the projection shows one text");
    let mut row = json!({ "id": "<qid>", "text": projected["text"], "mode": projected["mode"], "priority": projected["priority"], "enqueuedAt": clock, "clientSubmissionId": projected["id"] });
    for key in ["sender", "device", "fromAgent", "images"] {
        if let Some(held) = projected.get(key) {
            row[key] = held.clone();
        }
    }
    row
}

/// What Node's viewer was shown (`publications`: the store's published snapshot at each publication, whole), as the frames Rust
/// publishes for the same change, `(method, params)` with random ids as placeholders. A publication is one atomic snapshot: Node
/// has no order among the changes inside it, so inside one the frames are in Rust's order (rows, prompt history, queue, turn start);
/// the order across publications is Node's. A queue that is filled and emptied inside one chain is never published (the store
/// publishes the state as it stands at the flush, `frame-batched-store.mjs`), so it has no frame.
fn node_frames(publications: &[Value], at: i64, clock: u64) -> Vec<(String, Value)> {
    let mut out = Vec::new();
    let (mut rows, mut history, mut queued, mut busy) = (0usize, Vec::<Value>::new(), Vec::<Value>::new(), false);
    let mut structure = 0i64;
    for publication in publications {
        let state = &publication["state"];
        let items = state["items"].as_array().unwrap();
        for row in &items[rows..] {
            assert_eq!(row["at"], json!(at), "Node stamps the submit time");
            out.push(("item/completed".to_owned(), json!({ "turnId": "<turn>", "item": wire_item(row, clock, &Place { iid: "<iid>", turn: "<turn>", op: "op-0" }) })));
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
            let projected = publication["projectedQueued"].as_array().unwrap();
            assert_eq!(projected.len(), queue.len(), "Node's projection keeps every entry");
            let rows = projected.iter().zip(queue).map(|(row, entry)| taken_row(queue_row(row, at, clock), entry));
            out.push(("thread/queue/changed".to_owned(), json!({ "queued": rows.collect::<Vec<_>>() })));
            queued = queue.clone();
        }
        if state["busy"] == true && !busy {
            assert_eq!(state["spinner"]["startedAt"], json!(at), "the turn starts at the submit");
            out.push(("turn/started".to_owned(), json!({ "turn": { "id": "<turn>", "status": "inProgress", "startedAt": clock } })));
            // The same publication shows the turn busy with its spinner (`runTurn`); the spinner starts at the submit.
            let mut spinner = state["spinner"].clone();
            spinner["startedAt"] = json!(clock);
            out.push(("thread/runtime/updated".to_owned(), json!({ "value": { "busy": true, "commandBusy": state["commandBusy"], "spinner": spinner } })));
        }
        busy = state["busy"] == true;
        // Each recorded publication is one of Node's frames; its structure changed when `structureRevision` went up.
        let revision = state["structureRevision"].as_i64().unwrap();
        out.push(("thread/frame".to_owned(), json!({ "structureChanged": revision > structure })));
        structure = revision;
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
    let all: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/phone-chat-core/phone-chat-core.json")).unwrap();
    let cases = all["cases"].as_array().unwrap().iter().filter(|case| case["kind"] == "submit").collect::<Vec<_>>();
    assert_eq!(cases.len(), 11);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let rig = Rig::new();
        let (directory, handle) = running_on_records(&rig).await;
        let frames = || rig.feeds.frames(handle.id.as_str());
        // The load's own frame (its agent scope) comes before anything the case does.
        eventually_on!(&[&handle.cell.stepped, &*rig.feeds.published], || (!frames().is_empty()).then_some(())).await;
        let loaded = frames().len();
        if case["busy"] == true {
            submit(&handle, 1, "op-busy", "running", "busy1").await.expect("the run ahead");
            // Its row, its history entry, its turn start and its busy runtime: the setup is done when all four were published after
            // the load's and the phone's frame that carries them has closed.
            let done = || {
                let all = frames();
                let after = &all[loaded.min(all.len())..];
                (after.iter().filter(|(_, method, _)| method != "thread/frame").count() == 4 && after.last().is_some_and(|(_, method, _)| method == "thread/frame")).then_some(())
            };
            eventually_on!(&[&handle.cell.stepped, &*rig.feeds.published], done).await;
        }
        if case["admission"] == "terminal" {
            directory.shutdown_for("recorded terminal admission").await;
        }
        let (base_records, base_frames) = (rig.store.records(&handle.id).len(), frames().len());
        let mut options = case["options"].clone();
        options["clientSubmissionId"] = json!("sub1");
        let answers = case["answers"].as_array().unwrap();
        // A channel message queued as a task notification takes the router's path (`channel-session-router.mjs`), not a client's submit.
        let notification = case["options"]["mode"] == "task-notification";
        for (turn, want) in answers.iter().enumerate() {
            if notification {
                assert!(directory.queue_channel_notification(&handle.id, case["prompt"].as_str().unwrap().to_owned()).await, "{name}: Node accepted");
                continue;
            }
            let got = submit_with(&handle, 1, &format!("op-{turn}"), case["prompt"].clone(), options.clone()).await;
            match (want.as_bool().unwrap(), got) {
                (true, Ok(_)) => {}
                (false, got) => refused_any(got, name),
                (true, Err(error)) => panic!("{name}: Node accepted, Rust refused: {error:?}"),
            }
        }
        if notification {
            // The call returned once the notice was in the thread's inbox; the actor puts it on the queue in a step, which signals `stepped`.
            awaiting(|| format!("{name}: the channel notification on the thread's queue (held entries: {})", handle.cell.queue.load().len()), eventually_on!(&[&handle.cell.stepped], || (handle.cell.queue.load().len() == 1).then_some(()))).await;
        }
        let since = || frames().into_iter().skip(base_frames).collect::<Vec<_>>();
        let node = &case["after"];
        let at = case["at"].as_i64().unwrap();
        let clock = rig.clock.0.load(std::sync::atomic::Ordering::SeqCst);
        let (mut rust_labels, mut node_labels) = (Labels::default(), Labels::default());
        let want_frames: Vec<(String, Value)> = node_frames(node["publications"].as_array().unwrap(), at, clock).into_iter().map(|(method, params)| (method, renumber(&params, &mut node_labels))).collect();
        awaiting(
            || format!("{name}: the {} frames Node published (Rust's so far: {:?})", want_frames.len(), since()),
            eventually_on!(&[&handle.cell.stepped, &*rig.feeds.published], || (since().len() >= want_frames.len()).then_some(())),
        )
        .await;
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
                // Node's recorder holds the runtime's busy, commandBusy and spinner; the note's other fields have no recorded value.
                if method == "thread/runtime/updated" {
                    params["value"].as_object_mut().unwrap().retain(|key, _| ["busy", "commandBusy", "spinner"].contains(&key.as_str()));
                }
                (method, anon(&params, ids, &mut rust_labels))
            })
            .collect();
        assert_eq!(rust_frames, want_frames, "{name}: notifications");
        if notification {
            // Node keeps the entry out of the queue clients see (`isQueuedEntryVisible`): no queue frame on either side, and the entry is
            // the one queued task notification; its mode and origin are Node's.
            assert!(node["queued"].as_array().unwrap().is_empty() && !rust_frames.iter().any(|(method, _)| method == "thread/queue/changed"), "{name}");
            let pending = node["pending"].as_array().unwrap();
            assert_eq!(pending.len(), 1, "{name}");
            let held: Vec<Value> = handle.cell.queue.load().iter().map(|queued| queued.entry.clone()).collect();
            assert_eq!(held.len(), 1, "{name}");
            assert_eq!((held[0]["mode"].clone(), held[0]["origin"].clone(), held[0]["message"].clone(), held[0]["priority"].clone()), (pending[0]["mode"].clone(), pending[0]["origin"].clone(), pending[0]["content"].clone(), pending[0]["priority"].clone()), "{name}: the queued entry");
            continue;
        }

        // The stored rows, whole. Node's row maps to the record as `stored_item` says; the ids (`iid`, `turn`) are Rust's own,
        // and `checkpointId` is the item's own id.
        let node_rows = node["items"].as_array().unwrap();
        assert_eq!(user_records.len(), node_rows.len(), "{name}: stored rows");
        let asked = node["asked"].as_array().unwrap();
        assert_eq!(asked.len(), node_rows.len(), "{name}: a started turn per stored row");
        for ((record, row), asked) in user_records.iter().zip(node_rows).zip(asked) {
            assert_eq!(row["at"], json!(at));
            let want = renumber(&stored_item(row, asked, clock, &Place { iid: "<iid>", turn: "<turn>", op: "op-0" }), &mut node_labels);
            assert_eq!(anon(record, ids, &mut rust_labels), want, "{name}: stored row");
        }
        // The stored queue entries, whole, against Node's durable mirror and its in-memory entries; and the runtime records no Node row
        // stands for (bookkeeping of the run).
        let node_queued = node["queued"].as_array().unwrap();
        let shard: Vec<&Value> = node["durable"]["sessions"].as_object().into_iter().flat_map(|sessions| sessions.values()).flat_map(|rows| rows.as_array().unwrap()).collect();
        assert!(node["durable"].is_null() || node["durable"]["sessions"].as_object().unwrap().len() == 1, "{name}: one session's mirror");
        assert_eq!(shard.len(), node_queued.len(), "{name}: Node mirrors every queued entry");
        assert_eq!(queue_records.len(), node_queued.len(), "{name}: stored queue entries");
        for ((record, entry), shard) in queue_records.iter().zip(node_queued).zip(shard) {
            let want = renumber(&stored_queue(shard, entry, &node["durable"], at, clock), &mut node_labels);
            assert_eq!(anon(record, ids, &mut rust_labels), want, "{name}: stored queue entry");
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


/// Node's transcript rows after a turn (`user`, `assistant`, `turndone`) as the wire items Rust holds for them. Every key of Node's row
/// is taken from the row, and the key set is asserted, so a key this mapping does not place fails. Ids are placeholders by first
/// appearance (the user row's is the submission id, which Rust carries as `clientSubmissionId`); times are Rust's clock; a Node
/// `attemptId` is random. Where Rust keeps a Node field under another name: the turn end's `checkpointId` (the user row's id in Node)
/// is the user item's id here, the submission id riding in the end's `clientSubmissionId`.
fn rewind_wire(row: &Value, rows: &[Value], turn: usize, clock: u64) -> Value {
    let (iid, aid, eid, turn_id) = (format!("<iid{turn}>"), format!("<aid{turn}>"), format!("<eid{turn}>"), format!("<turn{turn}>"));
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
            wire_item(row, clock, &Place { iid: &iid, turn: &turn_id, op: "" })
        }
        "assistant" => {
            keys(&["kind", "id", "text", "at", "messageId", "device", "completionVerb", "attemptId", "streaming"]);
            json!({
                "type": "agentMessage", "id": aid, "text": row["text"],
                "meta": { "turnId": turn_id, "ext": { "attemptId": "<random>", "at": clock, "messageId": row["messageId"], "completionVerb": row["completionVerb"], "device": row["device"], "streaming": row["streaming"] } },
            })
        }
        "turndone" => {
            keys(&["kind", "id", "checkpointId", "elapsedMs", "status", "finalAssistantId", "outputTokens", "thinkingElapsedMs", "toolCount", "verb", "at", "device", "completionVerb", "attemptId"]);
            assert_eq!(row["checkpointId"], rows[0]["id"], "the end names the user row");
            assert_eq!(row["finalAssistantId"], rows[1]["id"], "the end names the answer");
            json!({
                "type": "turnEnd", "id": eid, "status": row["status"], "elapsedMs": row["elapsedMs"], "verb": row["verb"],
                "checkpointId": iid, "finalAssistantId": aid,
                "meta": { "turnId": turn_id, "at": clock, "ext": { "outputTokens": row["outputTokens"], "thinkingElapsedMs": row["thinkingElapsedMs"], "toolCount": row["toolCount"], "clientSubmissionId": rows[0]["id"], "device": row["device"], "attemptId": "<random>", "completionVerb": row["completionVerb"] } },
            })
        }
        other => panic!("a Node row of kind {other}"),
    }
}

/// Node's rows of several turns (three rows each: the prompt, its answer, its turn end) as the wire items Rust holds for them.
fn rewind_rows(rows: &[Value], clock: u64) -> Vec<Value> {
    rows.chunks(3).enumerate().flat_map(|(turn, rows)| rows.iter().map(move |row| rewind_wire(row, rows, turn, clock))).collect()
}

/// Rust's rows of several turns with each turn's ids as placeholders, as `rewind_rows` names them.
fn held_rows(items: &[Value], labels: &mut Labels) -> Vec<Value> {
    let mut ids: Vec<(String, String)> = Vec::new();
    for (turn, rows) in items.chunks(3).enumerate() {
        for (row, name) in rows.iter().zip(["iid", "aid", "eid"]) {
            ids.push((row["id"].as_str().unwrap().to_owned(), format!("<{name}{turn}>")));
        }
        ids.push((rows[0]["meta"]["turnId"].as_str().unwrap().to_owned(), format!("<turn{turn}>")));
    }
    let ids: Vec<(&str, &str)> = ids.iter().map(|(id, name)| (id.as_str(), name.as_str())).collect();
    items.iter().map(|item| anon(item, &ids, labels)).collect()
}

/// Node's message selector (`rewindToItem`, intake/rewind.mjs) on a submitted row: the client names the row by the id it shows, the
/// submission id, and Node resolves that on its rows, then rewinds to the row's stable message id. Rust resolves the displayed id the
/// same way, and answers what Node answers: the prompt's text and the number of rows removed (the prompt, its answer and its turn
/// end), an id that is no row as `ItemNotFound` (Node's `null`), a running turn as `PreconditionFailed` (Node's `null` while busy).
#[tokio::test(start_paused = true)]
async fn every_recorded_rewind_resolves_the_displayed_id_as_nodes_does() {
    let all: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/phone-chat-core/phone-chat-core.json")).unwrap();
    let cases = all["cases"].as_array().unwrap().iter().filter(|case| case["kind"] == "rewind").collect::<Vec<_>>();
    assert_eq!(cases.len(), 4);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let rig = Rig::new();
        let busy = case["busy"] == true;
        let turns = case["turns"].as_u64().unwrap() as usize;
        // The verb each answer completes with is the one Node recorded for that turn (`pickDoneVerb`), as the stored answer carries it.
        let verbs: Arc<Vec<String>> = Arc::new(case["before"]["items"].as_array().unwrap().iter().filter(|row| row["kind"] == "turndone").map(|row| row["completionVerb"].as_str().unwrap().to_owned()).collect());
        let answered = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        if busy {
            rig.set_script(Arc::new(|run| {
                Box::pin(async move {
                    run.cancel.cancelled().await;
                    RunOutcome::Interrupted
                })
            }));
        } else {
            // An answer in the stored message shape, which the record transcript shows as a row (the echo's `{text}` body is not one).
            rig.set_script(Arc::new(move |run| {
                let verb = verbs[answered.fetch_add(1, std::sync::atomic::Ordering::SeqCst)].clone();
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
                            body: json!({ "role": "assistant", "content": "hi", "meta": { "transcript": { "completion": { "verb": verb } } } }),
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
        let (mut rust_labels, mut node_labels) = (Labels::default(), Labels::default());
        let ops: Vec<String> = (0..turns).map(|turn| format!("op-{turn}")).collect();
        for turn in 0..turns {
            submit(&handle, 1, &ops[turn], case["prompt"].as_str().unwrap(), &format!("sub{}", turn + 1)).await.expect("the prompt");
            if !busy {
                // The prompt, its answer and the turn's live end: the rows Node held (`before.items`).
                awaiting(|| format!("{name}: never reached; rows {:?}", rows(&handle)), eventually_on!(&[&handle.cell.stepped, &*rig.feeds.published], || (idle(&handle) && rows(&handle).len() == 3 * (turn + 1)).then_some(()))).await;
            }
        }
        if busy {
            awaiting(|| format!("{name}: never reached; rows {:?}", rows(&handle)), eventually_on!(&[&handle.cell.stepped, &*rig.feeds.published], || (rows(&handle).len() == 1).then_some(()))).await;
        } else {
            let clock = rig.clock.0.load(std::sync::atomic::Ordering::SeqCst);
            let items: Vec<Value> = handle.cell.view.load_full().items.iter().map(|item| serde_json::to_value(item.as_ref()).unwrap()).collect();
            let node_rows = case["before"]["items"].as_array().unwrap();
            assert_eq!(node_rows.len(), 3 * turns, "{name}: Node's rows");
            let held = held_rows(&items, &mut rust_labels);
            let want = rewind_rows(node_rows, clock).iter().map(|row| renumber(row, &mut node_labels)).collect::<Vec<_>>();
            assert_eq!(held, want, "{name}: the rows the session held");
            // The stored user records against what Node's runtime was asked to persist, once each answer's own stamps are accounted for.
            let records = rig.store.records(&handle.id);
            let users: Vec<Value> = records.iter().map(|(_, record)| serde_json::to_value(record).unwrap()).filter(|record| record["k"] == "item" && record["role"] == "user").collect();
            assert_eq!(users.len(), turns, "{name}: stored prompts");
            for (turn, user) in users.iter().enumerate() {
                let mut asked = case["asked"][turn].clone();
                let stamps = asked["options"]["transcriptMeta"].as_object_mut().unwrap();
                assert_eq!(stamps.remove("assistantAt"), Some(node_rows[3 * turn + 1]["at"].clone()), "the answer's time");
                assert_eq!(stamps.remove("assistantMessageId"), Some(node_rows[3 * turn + 1]["messageId"].clone()), "the answer's message id");
                let (iid, turn_id) = (format!("<iid{turn}>"), format!("<turn{turn}>"));
                let place = Place { iid: &iid, turn: &turn_id, op: &ops[turn] };
                let want = renumber(&stored_item(&node_rows[3 * turn], &asked, clock, &place), &mut node_labels);
                let got = anon(user, &[(user["iid"].as_str().unwrap(), &iid), (user["turn"].as_str().unwrap(), &turn_id)], &mut rust_labels);
                assert_eq!(got, want, "{name}: stored row of turn {turn}");
            }
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
                // Node asked the runtime to rewind to the message id of the row it resolved, with its text; that row's message id is the
                // one the user row shows, and the runtime removed the messages the reply counts.
                let (dry, real) = (&case["runtimeCalls"][0], &case["runtimeCalls"][1]);
                let target = case["before"]["items"].as_array().unwrap().iter().find(|row| row["kind"] == "user" && row["id"] == case["itemId"]).expect("the row Node resolved");
                assert_eq!(real["options"]["messageId"], target["messageId"], "{name}: the message the runtime rewound to");
                assert_eq!(dry["options"]["messageId"], target["messageId"], "{name}: the message the preview named");
                assert_eq!(real["options"]["text"], reply["text"]);
                assert_eq!(real["result"]["removed"], reply["messages"], "the messages the runtime removed");
                let left = case["after"]["items"].as_array().unwrap();
                awaiting(|| format!("{name}: never reached; rows {:?}", rows(&handle)), eventually_on!(&[&handle.cell.stepped, &*rig.feeds.published], || (rows(&handle).len() == left.len()).then_some(()))).await;
                // What stays, whole: the rows of the turns before the one rewound, as Node's transcript holds them.
                let clock = rig.clock.0.load(std::sync::atomic::Ordering::SeqCst);
                let items: Vec<Value> = handle.cell.view.load_full().items.iter().map(|item| serde_json::to_value(item.as_ref()).unwrap()).collect();
                let held = held_rows(&items, &mut rust_labels);
                let want = rewind_rows(left, clock).iter().map(|row| renumber(row, &mut node_labels)).collect::<Vec<_>>();
                assert_eq!(held, want, "{name}: the rows left after the rewind");
            }
        }
    }
}

/// Every recorded image shape of a queue entry (Node's real `makeQueueEntry` shown by `projectSessionState`): the row the core
/// publishes for the same stored entry is Node's whole, the image list included (`content` for `data`, `mediaType` for `mimeType`,
/// `Number(sizeBytes)` with the length as the fallback).
#[test]
fn every_recorded_image_shape_is_published_as_nodes_queue_projection_shows_it() {
    use super::seams::Transcript;
    let all: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/phone-chat-core/phone-chat-core.json")).unwrap();
    let cases: Vec<&Value> = all["cases"].as_array().unwrap().iter().filter(|case| case["kind"] == "image-shape" || case["kind"] == "queue-shape").collect();
    assert!(cases.len() >= 34, "the recorded shapes");
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let projected = case["projected"].as_array().unwrap();
        assert_eq!(projected.len(), 1, "{name}");
        let mut options = json!({ "clientSubmissionId": "q1" });
        if !case["pastedImages"].is_null() {
            options["pastedImages"] = case["pastedImages"].clone();
        }
        let entry = json!({ "message": case["content"], "enqueuedAt": 1, "priority": "next", "options": options });
        let got = super::transcript::RecordTranscript::new().queued("<qid>", &entry);
        assert_eq!(got, queue_row(&projected[0], 1, 1), "{name}");
        if case["kind"] == "image-shape" {
            assert_eq!(projected[0]["images"].as_array().map(Vec::len), Some(1), "{name}: Node shows the image");
        }
    }
}

/// What the recorder's store published is Node's real `frame-batched-store` publishing: it guards and coalesces, so a chain of two
/// immediate flushes is one publication, and a publication always shows a change from the one before. A recorder that published per
/// call would show two (the reviewer's probe) or repeated snapshots here.
#[test]
fn the_recorded_publishing_is_coalesced_as_nodes_store_does() {
    let all: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/phone-chat-core/phone-chat-core.json")).unwrap();
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
