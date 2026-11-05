//! Session behavior over the test doubles of `testing`: one scripted run per test, durable
//! state observed through the acked view and the frames the thread feed published.

use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use mixdog_core_api::CoreError;
use mixdog_core_api::Reply;
use mixdog_core_api::RunControl;
use mixdog_core_api::ThreadDirectory;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::domain::approval::ApprovalAsk;
use mixdog_core_api::domain::approval::ApprovalGate;
use mixdog_core_api::domain::approval::ApprovalKind;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::ItemId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::OpId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::ids::TurnId;
use mixdog_core_api::mock::ServerRequestEvent;
use mixdog_core_api::thread::Decision;
use mixdog_protocol::ApprovalResolution;
use mixdog_protocol::ConnectionKind;
use mixdog_protocol::ThreadItem;
use mixdog_rt::CancellationToken;
use serde_json::Value;
use serde_json::json;

use super::ItemCommit;
use super::SessionDirectory;
use super::SessionHandle;
use super::seams::RunOutcome;
use super::testing::Rig;
use super::testing::Script;
use super::testing::lock;

fn connection() -> CallContext {
    CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, CancellationToken::new())
}

fn request(method: &'static str, params: Value, op: &str) -> CoreRequest {
    CoreRequest {
        method: Method(method),
        params,
        op: Some(OpId::from(op)),
        ctx: connection(),
    }
}

async fn eventually<T>(mut probe: impl FnMut() -> Option<T>) -> T {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(value) = probe() {
            return value;
        }
        assert!(tokio::time::Instant::now() < deadline, "condition not reached in 5 s");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

async fn start_thread(directory: &SessionDirectory) -> Arc<SessionHandle> {
    let reply = directory
        .request(request(
            "thread/start",
            json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }),
            "op-start",
        ))
        .await
        .expect("thread/start");
    let Reply::Subscribe(subscribe) = reply else {
        panic!("thread/start subscribes");
    };
    let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
    directory.handle(&id).expect("loaded")
}

async fn turn(handle: &SessionHandle, prompt: &str, op: &str) -> Value {
    let reply = handle
        .request(request(
            "turn/start",
            json!({ "threadId": handle.id, "opId": op, "input": { "prompt": prompt } }),
            op,
        ))
        .await
        .expect("turn/start");
    let Reply::Value(value) = reply else {
        panic!("turn/start answers a value");
    };
    value
}

/// Each run answers its prompt with `re: <prompt>` and completes.
fn echo() -> Script {
    Arc::new(|run| {
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let text = match &run.input.prompt {
                mixdog_protocol::PromptContent::Text(text) => text.clone(),
                mixdog_protocol::PromptContent::Parts(_) => String::new(),
            };
            run.port
                .commit_item(ItemCommit {
                    iid: ItemId::from(format!("a-{}", run.turn)),
                    role: Some("assistant".into()),
                    model: true,
                    visible: true,
                    body: json!({ "text": format!("re: {text}") }),
                })
                .await
                .expect("commit");
            RunOutcome::Completed
        })
    })
}

/// `(role, text)` of the acked view's items.
fn rows(handle: &SessionHandle) -> Vec<(&'static str, String)> {
    handle
        .cell
        .view
        .load_full()
        .items
        .iter()
        .map(|item| match item.as_ref() {
            ThreadItem::UserMessage { content, .. } => (
                "user",
                serde_json::to_value(content).unwrap()[0]["text"]
                    .as_str()
                    .unwrap()
                    .to_owned(),
            ),
            ThreadItem::AgentMessage { text, .. } => {
                ("assistant", serde_json::to_value(text).unwrap().as_str().unwrap().to_owned())
            }
            _ => ("other", String::new()),
        })
        .collect()
}

fn prompt_list(handle: &SessionHandle) -> Vec<String> {
    handle
        .cell
        .view
        .load_full()
        .state
        .prompt_history_list
        .clone()
        .unwrap_or_default()
}

fn idle(handle: &SessionHandle) -> bool {
    handle.cell.run.load().is_none()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_turn_publishes_its_rows_in_order_after_they_are_durable() {
    let rig = Rig::new();
    rig.set_script(echo());
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;

    let started = turn(&handle, "write a haiku", "op-1").await;
    assert_eq!(started["kind"], "started");
    eventually(|| (rows(&handle).len() == 2 && idle(&handle)).then_some(())).await;

    assert_eq!(
        rows(&handle),
        vec![
            ("user", "write a haiku".to_owned()),
            ("assistant", "re: write a haiku".to_owned())
        ]
    );
    // Every published frame describes durable state: the rows are in the log, in order.
    let logged: Vec<String> = rig
        .store
        .records(&handle.id)
        .into_iter()
        .filter_map(|(_, record)| match record {
            mixdog_store::schema::record::Record::Item(item) => Some(item.iid.as_str().to_owned()),
            _ => None,
        })
        .collect();
    assert_eq!(logged.len(), 2);
    let frames = rig.feeds.frames(handle.id.as_str());
    let seqs: Vec<u64> = frames.iter().map(|(seq, ..)| *seq).collect();
    assert_eq!(seqs, (1..=seqs.len() as u64).collect::<Vec<_>>(), "contiguous seqs");
    let completed: Vec<String> = frames
        .iter()
        .filter(|(_, method, _)| method == "item/completed")
        .map(|(_, _, params)| params["item"]["id"].as_str().unwrap_or_default().to_owned())
        .collect();
    assert_eq!(completed, logged);
    assert!(frames.iter().any(|(_, method, _)| method == "turn/completed"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn prompt_history_follows_todays_derivation_and_updates_incrementally() {
    let rig = Rig::new();
    rig.set_script(echo());
    let file = rig.prompts.file("/ws").expect("history file");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, br#"{"version":1,"entries":["older","one"]}"#).unwrap();
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    eventually(|| (prompt_list(&handle) == ["one", "older"]).then_some(())).await;

    turn(&handle, "two", "op-1").await;
    eventually(|| idle(&handle).then_some(())).await;
    turn(&handle, "  one  ", "op-2").await;
    eventually(|| (idle(&handle) && rows(&handle).len() == 4).then_some(())).await;
    eventually(|| (prompt_list(&handle) == ["one", "two", "older"]).then_some(())).await;
    // The persisted history of the cwd took both submits (`appendPromptHistory`).
    let saved: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert_eq!(saved, json!({ "version": 1, "entries": ["older", "two", "one"] }));

    let updates: Vec<Value> = rig
        .feeds
        .frames(handle.id.as_str())
        .into_iter()
        .filter(|(_, method, _)| method == "thread/promptHistory/updated")
        .map(|(_, _, params)| params["value"].clone())
        .collect();
    assert!(updates.contains(&json!({ "kind": "added", "prompt": "two" })));
    assert!(updates.contains(&json!({ "kind": "added", "prompt": "one" })));

    // Rewind to the second prompt: its text returns to the composer and leaves the list.
    let second = handle.cell.view.load_full().items[2].id().clone();
    let reply = handle
        .request(request(
            "thread/rewind",
            json!({ "threadId": handle.id, "opId": "op-3", "itemId": second }),
            "op-3",
        ))
        .await
        .expect("rewind");
    let Reply::Value(value) = reply else { panic!() };
    assert_eq!(value["text"], "one");
    eventually(|| (rows(&handle).len() == 2).then_some(())).await;
    assert_eq!(prompt_list(&handle), ["two", "older"]);
    let frames = rig.feeds.frames(handle.id.as_str());
    let reset = frames
        .iter()
        .find(|(_, method, _)| method == "thread/historyReset")
        .expect("historyReset");
    assert_eq!(reset.2["hasOlder"], false);
    assert_eq!(
        frames.last().map(|(_, m, p)| (m.as_str(), p["value"].clone())),
        Some(("thread/promptHistory/updated", json!({ "kind": "replaced", "prompts": ["two", "older"] })))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_first_valid_decision_wins_and_an_invalid_one_is_rejected() {
    let rig = Rig::new();
    let resolved: Arc<Mutex<Option<ApprovalResolution>>> = Arc::default();
    let seen = resolved.clone();
    rig.set_script(Arc::new(move |run| {
        let seen = seen.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let resolution = run
                .port
                .request(ApprovalAsk {
                    kind: ApprovalKind::Tool,
                    call_id: None,
                    tool: Some("shell".into()),
                    action_kind: None,
                    reason: None,
                    payload: json!({ "kind": "shell", "tool": "shell", "request": { "target": "rm -rf build" } }),
                    remember: Vec::new(),
                    expires_after: None,
                })
                .await;
            *lock(&seen) = Some(resolution);
            RunOutcome::Completed
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "clean", "op-1").await;
    let published = eventually(|| {
        rig.sink.events().into_iter().find_map(|event| match event {
            ServerRequestEvent::Published(request) => Some(request),
            _ => None,
        })
    })
    .await;

    let decide = |connection: u64, result: Value| Decision {
        request: published.id.clone(),
        connection: ConnectionId(connection),
        device: format!("desktop-{connection}"),
        connection_kind: ConnectionKind::Desktop,
        result,
    };
    handle.decide(decide(7, json!({ "approved": "yes" }))).expect("routed");
    handle.decide(decide(8, json!({ "approved": true }))).expect("routed");
    handle.decide(decide(9, json!({ "approved": false }))).expect("routed");
    let resolution = eventually(|| lock(&resolved).clone()).await;
    let ApprovalResolution::Decided { decision, device, .. } = resolution else {
        panic!("decided");
    };
    assert!(decision.approved);
    assert_eq!(device, "desktop-8");
    let rejected: Vec<ConnectionId> = rig
        .sink
        .events()
        .into_iter()
        .filter_map(|event| match event {
            ServerRequestEvent::ResponseRejected(connection, _) => Some(connection),
            _ => None,
        })
        .collect();
    assert_eq!(rejected, vec![ConnectionId(7)]);
    eventually(|| idle(&handle).then_some(())).await;
    let result = handle
        .cell
        .view
        .load_full()
        .state
        .approvals
        .clone()
        .and_then(|approvals| approvals.tool_approval_result)
        .expect("result");
    assert_eq!(
        serde_json::to_value(result).unwrap(),
        json!({ "id": published.id.as_str(), "approved": true, "device": "desktop-8", "at": 1000 })
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn interrupt_is_answered_on_the_control_path_and_ends_the_run() {
    let rig = Rig::new();
    rig.set_script(Arc::new(|run| {
        Box::pin(async move {
            run.cancel.cancelled().await;
            RunOutcome::Interrupted
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let started = turn(&handle, "long job", "op-1").await;
    let turn_id = TurnId::from(started["turnId"].as_str().expect("turn id"));
    // Rewind is idle-only.
    let busy = handle
        .request(request(
            "thread/rewind",
            json!({ "threadId": handle.id, "opId": "op-r", "itemId": "any" }),
            "op-r",
        ))
        .await;
    assert!(matches!(busy, Err(CoreError::PreconditionFailed { .. })), "{busy:?}");

    // No await: the control cell answers synchronously.
    handle.interrupt(&turn_id).expect("interrupt");
    assert!(matches!(
        handle.interrupt(&TurnId::from("other")),
        Err(CoreError::TurnNotActive { .. })
    ));
    eventually(|| idle(&handle).then_some(())).await;
    // `turn/completed` is published once its run record is durable, after the slot clears.
    let completed = eventually(|| {
        rig.feeds
            .frames(handle.id.as_str())
            .into_iter()
            .find(|(_, method, _)| method == "turn/completed")
    })
    .await;
    assert_eq!(completed.2["turn"]["status"], "interrupted");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn input_and_task_notifications_release_the_runs_wait() {
    use mixdog_tools::exec::TaskNotifier;
    use mixdog_tools::exec::WakeReason;
    let rig = Rig::new();
    let wakes = rig.wakes.clone();
    let reasons: Arc<Mutex<Vec<WakeReason>>> = Arc::default();
    let seen = reasons.clone();
    // The run's `task wait`, twice: once released by new input, once by a notification.
    rig.set_script(Arc::new(move |run| {
        let wakes = wakes.clone();
        let seen = seen.clone();
        Box::pin(async move {
            for _ in 0..2 {
                let wait = wakes.begin(&run.thread);
                wait.released().await;
                lock(&seen).push(wait.wake().expect("released").reason);
            }
            RunOutcome::Completed
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "build", "op-1").await;
    eventually(|| (rig.wakes.active_waits(&handle.id) == 1).then_some(())).await;
    assert_eq!(turn(&handle, "next", "op-2").await["kind"], "queued");
    eventually(|| (rig.wakes.active_waits(&handle.id) == 1 && lock(&reasons).len() == 1).then_some(()))
        .await;

    directory.finished(&handle.id, "job-7", "completed", "Async shell task job-7 finished.".into()).await;
    eventually(|| (lock(&reasons).len() == 2).then_some(())).await;
    assert_eq!(*lock(&reasons), [WakeReason::UserMessage, WakeReason::Notification]);

    // The completion is a task-notification row of the running turn; it is no prompt.
    let note = eventually(|| {
        rig.store.records(&handle.id).into_iter().find_map(|(_, record)| match record {
            mixdog_store::schema::record::Record::Item(item)
                if item.prompt.is_none() && item.role.as_ref().is_some_and(|r| r.as_str() == "user") =>
            {
                Some(item)
            }
            _ => None,
        })
    })
    .await;
    let mixdog_store::schema::blob::Slot::Inline(body) = &note.body else { panic!() };
    assert_eq!(body["meta"]["source"], "task-notification");
    assert_eq!(body["meta"]["execution"]["taskId"], "job-7");
    assert_eq!(body["content"], "Async shell task job-7 finished.");
    assert!(note.turn.is_some());
    assert!(!prompt_list(&handle).iter().any(|p| p.contains("job-7")));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_barrier_applies_nothing_and_answers_the_mutation() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    rig.store.fail_next.store(true, std::sync::atomic::Ordering::SeqCst);
    let error = handle
        .request(request(
            "thread/name/set",
            json!({ "threadId": handle.id, "opId": "op-1", "title": "renamed" }),
            "op-1",
        ))
        .await
        .expect_err("barrier failed");
    assert!(!matches!(error, CoreError::InvalidParams { .. }), "{error:?}");
    assert_ne!(handle.cell.view.load_full().state.title.as_deref(), Some("renamed"));
    // The next write succeeds.
    handle
        .request(request(
            "thread/name/set",
            json!({ "threadId": handle.id, "opId": "op-2", "title": "renamed" }),
            "op-2",
        ))
        .await
        .expect("name/set");
    eventually(|| {
        (handle.cell.view.load_full().state.title.as_deref() == Some("renamed")).then_some(())
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cold_open_is_single_flight_and_reopens_the_same_state() {
    let rig = Rig::new();
    rig.set_script(echo());
    let first = SessionDirectory::new(rig.deps());
    let handle = start_thread(&first).await;
    turn(&handle, "hello", "op-1").await;
    eventually(|| (idle(&handle) && rows(&handle).len() == 2).then_some(())).await;
    let before = rows(&handle);
    let prompts = prompt_list(&handle);
    let id = handle.id.clone();

    let second = Arc::new(SessionDirectory::new(rig.deps()));
    let reads = rig.store.head_reads.load(std::sync::atomic::Ordering::SeqCst);
    let opens: Vec<_> = (0..8)
        .map(|_| {
            let (directory, id) = (second.clone(), id.clone());
            tokio::spawn(async move {
                directory
                    .open_handle(&id, &CallContext::internal("test"))
                    .await
                    .expect("open")
            })
        })
        .collect();
    let mut handles = Vec::new();
    for open in opens {
        handles.push(open.await.expect("join"));
    }
    assert_eq!(rig.store.head_reads.load(std::sync::atomic::Ordering::SeqCst), reads + 1);
    // The effort judge was prewarmed at the create and at the one open.
    assert_eq!(*lock(&rig.prewarms.0), [id.clone(), id.clone()]);
    assert!(handles.iter().all(|h| Arc::ptr_eq(h, &handles[0])));
    let reopened = &handles[0];
    assert_eq!(rows(reopened), before);
    eventually(|| (prompt_list(reopened) == prompts).then_some(())).await;
    assert!(second.get(&ThreadId::from("missing")).is_none());
    assert!(matches!(
        second.open(&ThreadId::from("missing"), &CallContext::internal("test")).await,
        Err(CoreError::ThreadNotFound { .. })
    ));
}

/// The real thread store (log writer, codec, index) over the data dir `data`.
async fn real_store(data: &std::path::Path) -> Arc<dyn super::ThreadStore> {
    use mixdog_core_api::domain::mock::MockOwnership;
    use mixdog_store::blobs::BlobStore;
    use mixdog_store::log::OsIo;
    use mixdog_store::log::WriterDeps;
    use mixdog_store::sqlite::SqliteStore;

    std::fs::create_dir_all(data.join("sessions")).unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let root = data.to_path_buf();
    let index = mixdog_rt::LaneToken::submit(tokens.maintenance_io, &mixdog_rt::CancellationToken::new(), move |lane| {
        SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &root)
    })
    .expect("lane")
    .await
    .expect("job ran")
    .expect("index");
    let blobs = BlobStore::new(data);
    let writer = WriterDeps {
        io: Arc::new(OsIo),
        blobs: blobs.clone(),
        ownership: Arc::new(MockOwnership::default()),
        index: Arc::new(index.clone()),
    };
    Arc::new(super::StoreThreads::new(data, blobs, index, writer))
}

/// A prompt larger than a frame's inline budget goes through the runtime codec into a
/// blob of its own, and a reopen gives it back (prompt history and the rewind text).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_large_prompt_round_trips_through_the_real_store() {
    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let rig = Rig::new();
    rig.set_script(echo());
    let first = SessionDirectory::new(rig.deps_on(store.clone()));
    let handle = start_thread(&first).await;
    let text = format!("ask {}", "p".repeat(300 << 10));
    turn(&handle, &text, "op-1").await;
    eventually(|| (idle(&handle) && rows(&handle).len() == 2).then_some(())).await;
    let id = handle.id.clone();
    // Body and prompt are blobs: the log holds neither copy of the text.
    let log = std::fs::read(data.path().join("sessions").join(id.as_str()).join("log.000000")).unwrap();
    assert!(log.len() < 64 << 10, "{} log bytes", log.len());

    let second = SessionDirectory::new(rig.deps_on(store));
    let reopened = second.open_handle(&id, &CallContext::internal("test")).await.expect("open");
    assert_eq!(prompt_list(&reopened), [text.clone()]);
    let asked = reopened.cell.view.load_full().items[0].id().clone();
    let reply = reopened
        .request(request("thread/rewind", json!({ "threadId": id, "opId": "op-2", "itemId": asked }), "op-2"))
        .await
        .expect("rewind");
    let Reply::Value(value) = reply else { panic!() };
    assert_eq!(value["text"], text.as_str());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_real_store_reopens_a_thread_and_appends_after_it() {
    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let rig = Rig::new();
    rig.set_script(echo());

    let first = SessionDirectory::new(rig.deps_on(store.clone()));
    let handle = start_thread(&first).await;
    turn(&handle, "hello", "op-1").await;
    eventually(|| (idle(&handle) && rows(&handle).len() == 2).then_some(())).await;
    turn(&handle, "again", "op-2").await;
    eventually(|| (idle(&handle) && rows(&handle).len() == 4).then_some(())).await;
    let id = handle.id.clone();
    handle
        .request(request(
            "thread/name/set",
            json!({ "threadId": id, "opId": "op-name", "title": "  Haiku  " }),
            "op-name",
        ))
        .await
        .expect("name/set");
    // The index answers the metadata with the raw title, without loading anything.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let meta = loop {
        let meta = first.session_meta(&id).await.expect("meta");
        if meta.as_ref().is_some_and(|m| m.title.as_deref() == Some("  Haiku  ")) {
            break meta.expect("listed");
        }
        assert!(tokio::time::Instant::now() < deadline, "meta not indexed: {meta:?}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    assert_eq!(meta.agent, Value::Null);
    assert_eq!(meta.owner_session_id, Value::Null);
    assert_eq!(
        first.session_meta(&ThreadId::from("missing")).await.expect("meta"),
        None
    );

    // A fresh directory opens the thread from its log and the index.
    let second = SessionDirectory::new(rig.deps_on(store));
    let reopened = second
        .open_handle(&id, &CallContext::internal("test"))
        .await
        .expect("open");
    assert_eq!(rows(&reopened), rows(&handle));
    assert_eq!(prompt_list(&reopened), ["again", "hello"]);

    // The first write after the open appends to the same log.
    let again = reopened.cell.view.load_full().items[2].id().clone();
    let reply = reopened
        .request(request(
            "thread/rewind",
            json!({ "threadId": id, "opId": "op-3", "itemId": again }),
            "op-3",
        ))
        .await
        .expect("rewind");
    let Reply::Value(value) = reply else { panic!() };
    assert_eq!(value["text"], "again");
    eventually(|| (rows(&reopened).len() == 2).then_some(())).await;
    eventually(|| (prompt_list(&reopened) == ["hello"]).then_some(())).await;
}

/// A subscriber attaches (the counting `FeedSource::attach` does around the feed).
fn subscribe(handle: &SessionHandle) {
    assert!(handle.cell.subscribing());
    handle.cell.subscribed(true);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_idle_thread_unloads_when_its_last_subscriber_leaves_and_ingests_its_context() {
    let rig = Rig::new();
    rig.set_script(echo());
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "hello", "op-1").await;
    eventually(|| idle(&handle).then_some(())).await;
    subscribe(&handle);
    subscribe(&handle);
    handle.cell.unsubscribed();
    assert!(directory.handle(&handle.id).is_some(), "one subscriber is left");

    handle.cell.unsubscribed();
    eventually(|| directory.handle(&handle.id).is_none().then_some(())).await;
    eventually(|| (lock(&rig.closes.seen).len() == 1).then_some(())).await;
    assert_eq!(lock(&rig.closes.seen)[0].1.len(), 2, "the input row and the reply");
    assert!(!handle.cell.subscribing(), "an unloaded thread takes no subscriber");
    // A later open loads it again.
    let reopened = directory.open_handle(&handle.id, &connection()).await.expect("reopen");
    assert!(!Arc::ptr_eq(&reopened.cell, &handle.cell));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_live_run_keeps_the_thread_loaded_until_it_ends() {
    let rig = Rig::new();
    let (release, gate) = tokio::sync::watch::channel(false);
    rig.set_script(Arc::new(move |run| {
        let mut gate = gate.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let _ = gate.wait_for(|open| *open).await;
            RunOutcome::Completed
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    subscribe(&handle);
    turn(&handle, "hold", "op-1").await;
    handle.cell.unsubscribed();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(directory.handle(&handle.id).is_some(), "the run is live");

    release.send(true).expect("release");
    eventually(|| directory.handle(&handle.id).is_none().then_some(())).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_waits_for_the_ingests_at_most_2500_ms() {
    let rig = Rig::new();
    rig.set_script(echo());
    *lock(&rig.closes.delay) = Duration::from_secs(10);
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "hello", "op-1").await;
    eventually(|| idle(&handle).then_some(())).await;

    let started = tokio::time::Instant::now();
    directory.shutdown().await;
    let took = started.elapsed();
    assert!(took >= Duration::from_millis(2400) && took < Duration::from_millis(4000), "{took:?}");
    assert!(directory.handle(&handle.id).is_none());
    assert!(lock(&rig.closes.seen).is_empty(), "the slow ingest was not waited for");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_completed_turn_goes_to_session_search_with_its_model_context() {
    let rig = Rig::new();
    rig.set_script(echo());
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "hello", "op-1").await;
    eventually(|| (lock(&rig.ingests.0).len() == 1).then_some(())).await;
    let (thread, messages) = lock(&rig.ingests.0)[0].clone();
    assert_eq!(thread, handle.id);
    assert_eq!(messages.len(), 2, "the input row and the reply: {messages:?}");
    assert_eq!(messages[1]["text"], "re: hello");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_saved_provider_state_reaches_the_next_turn_whole_and_a_clear_drops_it() {
    use mixdog_core_api::domain::provider::ProviderState;

    let rig = Rig::new();
    let seen: Arc<Mutex<Vec<Option<ProviderState>>>> = Arc::default();
    let saved = ProviderState {
        gemini: None,
        rest: json!({ "xaiResponses": { "previousResponseId": "r1" } })
            .as_object()
            .cloned()
            .expect("object"),
    };
    let (seen_in, saved_in) = (seen.clone(), saved.clone());
    rig.set_script(Arc::new(move |run| {
        let (seen, saved) = (seen_in.clone(), saved_in.clone());
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let state = run.port.provider_state().await;
            lock(&seen).push(state);
            run.port.save_provider_state(Some(saved)).await.expect("saved");
            RunOutcome::Completed
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "one", "op-1").await;
    eventually(|| (idle(&handle) && lock(&seen).len() == 1).then_some(())).await;
    turn(&handle, "two", "op-2").await;
    eventually(|| (idle(&handle) && lock(&seen).len() == 2).then_some(())).await;
    assert_eq!(lock(&seen).clone(), vec![None, Some(saved.clone())]);
    assert_eq!(
        handle.live_header().header().get("providerState"),
        Some(&json!({ "xaiResponses": { "previousResponseId": "r1" } }))
    );

    handle
        .request(request(
            "thread/clear",
            json!({ "threadId": handle.id, "opId": "op-3" }),
            "op-3",
        ))
        .await
        .expect("clear");
    assert_eq!(handle.live_header().header().get("providerState"), None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tool_result_completes_its_call_in_place() {
    let rig = Rig::new();
    rig.set_script(Arc::new(|run| {
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let call = json!({ "id": "c1", "name": "shell", "arguments": { "command": "ls" } });
            run.port
                .commit_item(ItemCommit {
                    iid: ItemId::from(format!("a-{}", run.turn)),
                    role: Some("assistant".into()),
                    model: true,
                    visible: true,
                    body: json!({ "text": "listing", "toolCalls": [call] }),
                })
                .await
                .expect("call");
            run.port
                .commit_item(ItemCommit {
                    iid: ItemId::from(format!("t-{}", run.turn)),
                    role: Some("tool".into()),
                    model: true,
                    visible: true,
                    body: json!({ "toolCallId": "c1", "text": "a.txt" }),
                })
                .await
                .expect("result");
            RunOutcome::Completed
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "ls", "op-1").await;
    eventually(|| (idle(&handle) && rows(&handle).len() == 3).then_some(())).await;

    let call = handle
        .cell
        .view
        .load_full()
        .items
        .iter()
        .find(|item| item.id().as_str() == "call:c1")
        .cloned()
        .expect("call item");
    let ThreadItem::ToolCall { name, input, run, .. } = call.as_ref() else {
        panic!("tool call");
    };
    assert_eq!(name, "shell");
    assert_eq!(input["command"], "ls");
    assert_eq!(run.result, Some(mixdog_protocol::MaybeBlob::Inline("a.txt".into())));
    // Both the call and its merged result were published as `item/completed`.
    let completed: Vec<Value> = rig
        .feeds
        .frames(handle.id.as_str())
        .into_iter()
        .filter(|(_, method, params)| method == "item/completed" && params["item"]["id"] == "call:c1")
        .map(|(_, _, params)| params["item"]["run"]["result"].clone())
        .collect();
    assert_eq!(completed.len(), 2);
    assert_eq!(completed[1], "a.txt");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn runs_get_the_sessions_tool_surface() {
    let rig = Rig::new();
    let seen: Arc<Mutex<Vec<Vec<String>>>> = Arc::default();
    let record = seen.clone();
    rig.set_script(Arc::new(move |run| {
        let record = record.clone();
        Box::pin(async move {
            lock(&record).push(run.surface.borrow().disallowed.clone());
            RunOutcome::Completed
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "go", "op-1").await;
    eventually(|| (lock(&seen).len() == 1).then_some(())).await;
    assert_eq!(lock(&seen)[0], Vec::<String>::new());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_live_header_follows_acked_header_changes() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let live = handle.live_header();
    assert_ne!(live.header().get("title"), Some(&json!("renamed")));
    handle
        .request(request(
            "thread/name/set",
            json!({ "threadId": handle.id, "opId": "op-1", "title": "renamed" }),
            "op-1",
        ))
        .await
        .expect("name/set");
    assert_eq!(live.header().get("title"), Some(&json!("renamed")));
}
