//! Node's recording `fixtures/session-message-sanitize/recording.json` (`record-session-message-sanitize.mjs`, test
//! file `session/manager/message-sanitize.test.mjs`), read when the test runs and decoded with [`Exact`]. Each case's
//! messages reach a thread the way the core stores them (the conversation rows of `thread/inheritedRows/append`, the
//! rows a run commits) and come back through the read a client makes, `thread/modelMessages/list`: the model-visible
//! snapshot Node's `filterModelVisibleSessionMessages` gives. Line 66 (the steering drain, a real agent turn) is in
//! `mixdog-core` (`run_host/session_message_sanitize_replay.rs`).

use std::sync::Arc;

use mixdog_core_api::Reply;
use mixdog_core_api::ThreadDirectory;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::ItemId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::ThreadId;
use mixdog_rt::CancellationToken;
use mixdog_testkit::exact::Exact;
use serde_json::Value;
use serde_json::json;

use super::ItemCommit;
use super::SessionDirectory;
use super::SessionHandle;
use super::seams::RunOutcome;
use super::testing::Rig;
use super::tests::real_store;
use super::tests::start_thread;
use super::tests::turn;

fn recording() -> Exact {
    let text = mixdog_testkit::fixture!("../../fixtures/session-message-sanitize/recording.json");
    Exact::decode(&serde_json::from_str(text).expect("the recording is JSON")).expect("the recording decodes")
}

fn case(recording: &Exact, line: f64) -> &Exact {
    recording.get("cases").as_array().iter().find(|case| case.get("testLine").as_f64() == line).unwrap_or_else(|| panic!("no case at line {line}"))
}

fn plain(value: &Exact) -> Value {
    value.to_plain().unwrap_or_else(|error| panic!("recorded input: {error}"))
}

fn rows(value: &Exact) -> Vec<Value> {
    value.as_array().iter().map(plain).collect()
}

fn client() -> CallContext {
    CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, CancellationToken::new())
}

/// The rows as a conversation the thread holds (the inheritance carry's append).
async fn append(handle: &SessionHandle, messages: Vec<Value>) {
    let request = CoreRequest { method: Method("thread/inheritedRows/append"), params: json!({ "messages": messages }), op: None, ctx: CallContext::internal("replay") };
    handle.request(request).await.expect("the rows are appended");
}

/// `thread/modelMessages/list` from the first message, as a client reads it.
async fn model_messages(directory: &SessionDirectory, id: &ThreadId) -> Vec<Value> {
    let request = CoreRequest { method: Method("thread/modelMessages/list"), params: json!({ "threadId": id, "start": 0 }), op: None, ctx: client() };
    let Reply::Value(reply) = directory.request(request).await.expect("thread/modelMessages/list") else { panic!("a value reply") };
    reply["messages"].as_array().cloned().expect("the messages")
}

fn array(rows: &[Value]) -> Exact {
    Exact::plain(&Value::Array(rows.to_vec()))
}

/// Line 32: a snapshot keeps the notification (with its execution provenance), the tool work after it and an image
/// part; changing the snapshot leaves the thread's messages as they were. The snapshot is a copy (`sameArray` false);
/// `sameElements` (Node's element identity) is the elements' equality, as the manifest declares.
#[tokio::test(start_paused = true)]
async fn line_32_the_snapshot_keeps_notifications_tool_work_and_images() {
    let recording = recording();
    let case = case(&recording, 32.0);
    let messages = rows(case.get("input").get("messages"));
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    append(&handle, messages.clone()).await;
    let mut snapshot = model_messages(&directory, &handle.id).await;
    let encoded = array(&snapshot);
    let same_elements = snapshot == messages;
    snapshot.push(json!({ "role": "assistant", "content": "Next response." }));
    let source = model_messages(&directory, &handle.id).await;
    let got = Exact::Object(vec![
        ("snapshot".into(), encoded),
        ("sameArray".into(), Exact::Bool(false)),
        ("sameElements".into(), Exact::Bool(same_elements)),
        ("sourceAfterPush".into(), array(&source)),
    ]);
    assert_eq!(got, *case.get("result"));
}

/// Line 50: a shell and an agent completion envelope and three legacy notification texts, each as a string and as a
/// one-part list, stay in the snapshot with the tool work that follows them.
#[tokio::test(start_paused = true)]
async fn line_50_restored_and_legacy_notification_text_stays_in_the_snapshot() {
    let recording = recording();
    let case = case(&recording, 50.0);
    let mut got = Vec::new();
    for row in case.get("result").as_array() {
        let messages = rows(row.get("messages"));
        let rig = Rig::new();
        let directory = SessionDirectory::new(rig.deps());
        let handle = start_thread(&directory).await;
        append(&handle, messages.clone()).await;
        let snapshot = model_messages(&directory, &handle.id).await;
        got.push(Exact::Object(vec![("messages".into(), array(&messages)), ("snapshot".into(), array(&snapshot))]));
    }
    assert_eq!(Exact::Array(got), *case.get("result"));
}

/// The id the core's turn start stamps on its prompt row (`meta.transcript.messageId`, Node's `stableMessageId`),
/// removed where the recording holds the test's literal prompt row without one (declared in the manifest).
fn without_prompt_id(mut row: Value) -> Value {
    let Some(meta) = row.get_mut("meta").and_then(Value::as_object_mut) else { return row };
    if let Some(transcript) = meta.get_mut("transcript").and_then(Value::as_object_mut) {
        transcript.shift_remove("messageId");
        if transcript.is_empty() {
            meta.shift_remove("transcript");
        }
    }
    if meta.is_empty() {
        row.as_object_mut().expect("a row").shift_remove("meta");
    }
    row
}

/// Line 96: the process dies while the turn holds a notification, an answered tool call and its result (a response
/// had started); the thread reopened over the same store shows them kept, the result marked as the sent request's
/// tail, and the restart line after it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn line_96_an_interrupted_turn_keeps_notifications_and_tool_work() {
    let recording = recording();
    let case = case(&recording, 96.0);
    let input = case.get("input");
    assert_eq!(input.get("abortReason").as_str(), "process-crash", "the recorded interruption is a process crash");
    let messages = rows(input.get("messages"));
    let prompt = input.get("currentUserContent").as_str().to_owned();
    assert_eq!(messages[0], json!({ "role": "user", "content": prompt }), "the first row is the turn's prompt");
    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let rig = Rig::new();
    let committed = Arc::new(tokio::sync::Notify::new());
    let (told, work) = (committed.clone(), messages[1..].to_vec());
    rig.set_script(Arc::new(move |run| {
        let (told, work) = (told.clone(), work.clone());
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            for (n, body) in work.into_iter().enumerate() {
                let role = body["role"].as_str().map(str::to_owned);
                let item = ItemCommit { iid: ItemId::from(format!("itm_work_{n}")), role, model: true, visible: true, body, prompt: None };
                run.port.commit_item(item).await.expect("the row is durable");
            }
            told.notify_one();
            // The process dies here: the run never ends.
            std::future::pending::<RunOutcome>().await
        })
    }));
    let first = SessionDirectory::new(rig.deps_on(store.clone()));
    let handle = start_thread(&first).await;
    let id = handle.id.clone();
    turn(&handle, &prompt, "op-1").await;
    super::testing::awaiting(|| "the turn's tool work to be durable".to_owned(), committed.notified()).await;

    let second = SessionDirectory::new(rig.deps_on(store));
    second.open_handle(&id, &CallContext::internal("replay")).await.expect("the thread reopens");
    let mut recovered = model_messages(&second, &id).await;
    recovered[0] = without_prompt_id(recovered[0].clone());
    // The one field compared less: the core's own stored mark on the rows its recovery wrote (`meta.restartRecovery`,
    // FORMAT.md §5.2), which Node, recovering from its checkpoint, has no row to carry.
    for row in &mut recovered {
        if let Some(meta) = row.get_mut("meta").and_then(Value::as_object_mut) {
            meta.shift_remove("restartRecovery");
            if meta.is_empty() {
                row.as_object_mut().expect("a row").shift_remove("meta");
            }
        }
    }
    // Node's two flags as the client sees them: the turn's prompt is still the conversation's (not handed back), and
    // the response the turn made (every row after the prompt but the restart line) is still in it.
    let user_turn_preserved = recovered.first() == Some(&messages[0]);
    let response_preserved = recovered.len() > 2;
    let got = Exact::Object(vec![
        ("messages".into(), array(&recovered)),
        ("responsePreserved".into(), Exact::Bool(response_preserved)),
        ("userTurnPreserved".into(), Exact::Bool(user_turn_preserved)),
    ]);
    assert_eq!(got, *case.get("result"));
}
