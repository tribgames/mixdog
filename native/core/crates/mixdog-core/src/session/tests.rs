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
use super::SteerInput;
use super::run::DrainRequest;
use super::run::DrainStage;
use super::run::Priority;
use super::run::SteerMode;
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

pub(crate) async fn eventually<T>(mut probe: impl FnMut() -> Option<T>) -> T {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(value) = probe() {
            return value;
        }
        assert!(tokio::time::Instant::now() < deadline, "condition not reached in 5 s");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

pub(super) async fn start_thread(directory: &SessionDirectory) -> Arc<SessionHandle> {
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

pub(crate) async fn turn(handle: &SessionHandle, prompt: &str, op: &str) -> Value {
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
                    prompt: None,
                })
                .await
                .expect("commit");
            RunOutcome::Completed(Default::default())
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

pub(crate) fn idle(handle: &SessionHandle) -> bool {
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
#[allow(clippy::disallowed_methods, reason = "test setup writes and reads the history file")]
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
async fn an_implicit_approval_session_asks_nobody() {
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
                    reason: Some("shell needs a look".into()),
                    payload: json!({ "name": "shell" }),
                    remember: Vec::new(),
                    expires_after: None,
                })
                .await;
            *lock(&seen) = Some(resolution);
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let reply = directory
        .request(request(
            "thread/start",
            json!({
                "opId": "op-start", "kind": "task", "projectPath": "/ws",
                "session": { "toolProfile": "headless", "approvalMode": "implicit" },
            }),
            "op-start",
        ))
        .await
        .expect("thread/start");
    let Reply::Subscribe(started) = reply else { panic!("thread/start subscribes") };
    let id = ThreadId::from(started.result["thread"]["id"].as_str().expect("thread id"));
    let handle = directory.handle(&id).expect("loaded");
    turn(&handle, "clean", "op-1").await;
    let resolution = eventually(|| lock(&resolved).clone()).await;
    assert!(matches!(resolution, ApprovalResolution::Unavailable { .. }), "{resolution:?}");
    eventually(|| idle(&handle).then_some(())).await;
    assert!(rig.sink.events().is_empty(), "no approval request is published");
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
            RunOutcome::Completed(Default::default())
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
    let reason: Arc<Mutex<Option<String>>> = Arc::default();
    let seen = reason.clone();
    rig.set_script(Arc::new(move |run| {
        let seen = seen.clone();
        Box::pin(async move {
            run.cancel.cancelled().await;
            *seen.lock().unwrap() = Some(run.signal.reason());
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
    // The user's stop carries `abortRuntime`'s text.
    let expected = format!("Session \"{}\" closed: runtime abort (reason=cli-abort)", handle.id.as_str());
    assert_eq!(reason.lock().unwrap().as_deref(), Some(expected.as_str()));
}

/// The turn's review (`snapshot-tracker.mjs`): the run begins it once its workspace is final, a
/// tool waits for the baseline, and the turn settles only after the seal, so its edit is the
/// sealed turn's change record under the input row's checkpoint.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup: a git workspace and the run's file edit")]
async fn a_turn_that_edits_a_file_seals_its_review_before_it_settles() {
    use mixdog_core_api::turn_review::ChangesRead;
    let rig = Rig::new();
    let ws = tempfile::tempdir().unwrap();
    let root = ws.path().canonicalize().unwrap().to_string_lossy().trim_start_matches(r"\\?\").to_owned();
    assert!(std::process::Command::new("git").args(["init", "-q"]).current_dir(&root).status().unwrap().success());
    std::fs::write(ws.path().join("a.txt"), "one\n").unwrap();
    let checkpoints: Arc<Mutex<Vec<String>>> = Arc::default();
    let seen = checkpoints.clone();
    let cwd = root.clone();
    let deps = rig.deps();
    let review = deps.turn_review.clone();
    let tool = review.clone();
    rig.set_script(Arc::new(move |run| {
        let (seen, cwd, tool) = (seen.clone(), cwd.clone(), tool.clone());
        Box::pin(async move {
            use mixdog_core_api::turn_review::{CallChange, ReviewContent};
            run.port.input_durable().await.expect("input durable");
            // The turn's checkpoint is its input row.
            seen.lock().unwrap().push(run.input_item.as_str().to_owned());
            run.review.start(&cwd);
            // The edit tool waits for the baseline, writes, and records its call.
            assert!(run.review.ready().await.is_some(), "a baseline");
            let file = std::path::Path::new(&cwd).join("a.txt");
            std::fs::write(&file, "two\n").unwrap();
            let change = CallChange {
                path: file.to_string_lossy().into_owned(),
                new_path: None,
                before: ReviewContent::Bytes(b"one\n".to_vec().into()),
                after: ReviewContent::Bytes(b"two\n".to_vec().into()),
            };
            tool.record_call("call-1", run.thread.as_str(), &cwd, vec![change]).await;
            RunOutcome::Completed(Box::default())
        })
    }));
    let directory = SessionDirectory::new(deps);
    let handle = start_thread(&directory).await;
    turn(&handle, "edit a.txt", "op-1").await;
    // The baseline and the seal run real Git (a shadow repository); under a loaded suite they
    // take longer than `eventually`'s 5 s (measured 7.7 s).
    let started = std::time::Instant::now();
    while !idle(&handle) {
        assert!(started.elapsed() < std::time::Duration::from_secs(60), "the turn settles");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let checkpoint = checkpoints.lock().unwrap()[0].clone();
    assert!(!checkpoint.is_empty());
    // Settled means sealed: the record is readable at once.
    let read = ChangesRead { checkpoint_id: checkpoint, patch: true, file: None };
    let changes = review.turn_changes(handle.id.as_str(), read).await.expect("the turn's change record");
    let text = Value::Object(changes).to_string();
    assert!(text.contains("a.txt") && text.contains("+two"), "{text}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn input_and_task_notifications_release_the_runs_wait() {
    use mixdog_tools::exec::TaskNotifier;
    use mixdog_tools::exec::WakeReason;
    let rig = Rig::new();
    let wakes = rig.wakes.clone();
    let reasons: Arc<Mutex<Vec<WakeReason>>> = Arc::default();
    let seen = reasons.clone();
    let inputs: Arc<Mutex<Vec<Value>>> = Arc::default();
    let bodies = inputs.clone();
    // The first run's `task wait`, twice: once released by new input, once by a notification.
    rig.set_script(Arc::new(move |run| {
        let wakes = wakes.clone();
        let seen = seen.clone();
        let first = {
            let mut bodies = lock(&bodies);
            bodies.push(run.input_body.clone());
            bodies.len() == 1
        };
        Box::pin(async move {
            for _ in 0..usize::from(first) * 2 {
                let wait = wakes.begin(&run.thread);
                wait.released().await;
                lock(&seen).push(wait.wake().expect("released").reason);
            }
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "build", "op-1").await;
    eventually(|| (rig.wakes.active_waits(&handle.id) == 1).then_some(())).await;
    assert_eq!(turn(&handle, "next", "op-2").await["kind"], "queued");
    eventually(|| (rig.wakes.active_waits(&handle.id) == 1 && lock(&reasons).len() == 1).then_some(()))
        .await;

    directory.finished(&handle.id, "shell", "job-7", "completed", "Async shell task job-7 finished.".into()).await;
    eventually(|| (lock(&reasons).len() == 2).then_some(())).await;
    assert_eq!(*lock(&reasons), [WakeReason::UserMessage, WakeReason::Notification]);

    // The completion was queued, never a queued prompt; the turn took no boundary after it, so
    // it runs as its own turn after the queued prompt, as a task-notification row.
    eventually(|| (lock(&inputs).len() == 3).then_some(())).await;
    let bodies = lock(&inputs).clone();
    assert_eq!(bodies[1]["content"], "next");
    assert_eq!(bodies[2]["meta"]["source"], "task-notification");
    assert_eq!(bodies[2]["meta"]["execution"], json!({ "surface": "shell", "id": "job-7", "status": "completed" }));
    assert_eq!(bodies[2]["content"], "Async shell task job-7 finished.");
    assert!(!prompt_list(&handle).iter().any(|p| p.contains("job-7")));
    eventually(|| idle(&handle).then_some(())).await;
    assert!(handle.cell.view.load_full().state.queued.as_ref().is_some_and(Vec::is_empty));
}

/// A queued completion as the run takes it at a boundary: `SteerMode::TaskNotification`
/// with its execution, after steered prompts; taken, it never starts a turn of its own.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_running_turn_takes_a_completion_at_its_next_boundary() {
    use mixdog_tools::exec::TaskNotifier;
    let rig = Rig::new();
    let gate = Arc::new(tokio::sync::Notify::new());
    let taken: Arc<Mutex<Vec<SteerInput>>> = Arc::default();
    let (open, out) = (gate.clone(), taken.clone());
    rig.set_script(Arc::new(move |run| {
        let (open, out) = (open.clone(), out.clone());
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            open.notified().await;
            let steers = run.port.take_steers(drain(DrainStage::PreSend)).await.expect("take");
            lock(&out).extend(steers);
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "build", "op-1").await;
    directory.finished(&handle.id, "shell", "job-7", "completed", "job-7 finished.".into()).await;
    // Durable before the boundary looks.
    eventually(|| {
        rig.store.records(&handle.id).into_iter().any(|(_, record)| {
            matches!(record, mixdog_store::schema::record::Record::Queue(_))
        })
        .then_some(())
    })
    .await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    gate.notify_one();
    eventually(|| idle(&handle).then_some(())).await;
    let taken = lock(&taken).clone();
    assert_eq!(taken.len(), 1);
    assert_eq!(taken[0].mode, SteerMode::TaskNotification);
    assert_eq!(taken[0].execution, Some(json!({ "surface": "shell", "id": "job-7", "status": "completed" })));
    assert_eq!(taken[0].content, "job-7 finished.");
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(runs_started(&rig, &handle.id), 1, "a taken completion starts no turn");
}

fn drain(stage: DrainStage) -> DrainRequest {
    DrainRequest { stage, max_priority: Priority::Next }
}

/// `ask-turn-steering-drain.mjs:44-58`: a mid-chain boundary takes queued input only while the
/// queue holds task notifications alone; the terminal boundary takes it all, the prompts merged
/// into one input and each completion on its own, and none of it starts a turn of its own.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn queued_prompts_wait_for_the_terminal_boundary_and_merge() {
    use mixdog_tools::exec::TaskNotifier;
    let rig = Rig::new();
    let gate = Arc::new(tokio::sync::Notify::new());
    let taken: Arc<Mutex<Vec<Vec<SteerInput>>>> = Arc::default();
    let (open, out) = (gate.clone(), taken.clone());
    rig.set_script(Arc::new(move |run| {
        let (open, out) = (open.clone(), out.clone());
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            if lock(&out).is_empty() {
                open.notified().await;
            }
            for stage in [DrainStage::PreSend, DrainStage::Terminal] {
                let steers = run.port.take_steers(drain(stage)).await.expect("take");
                lock(&out).push(steers);
            }
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "build", "op-1").await;
    let first = turn(&handle, "first", "op-2").await;
    let second = turn(&handle, "second", "op-3").await;
    directory.finished(&handle.id, "shell", "job-7", "completed", "job-7 finished.".into()).await;
    eventually(|| {
        let queued = rig.store.records(&handle.id).into_iter().filter(|(_, record)| {
            matches!(record, mixdog_store::schema::record::Record::Queue(_))
        });
        (queued.count() == 3).then_some(())
    })
    .await;
    gate.notify_one();
    eventually(|| idle(&handle).then_some(())).await;
    let taken = lock(&taken).clone();
    assert_eq!(taken.len(), 2);
    assert!(taken[0].is_empty(), "a queued prompt keeps the mid-chain boundary from the queue");
    let terminal = &taken[1];
    assert_eq!(terminal.len(), 2);
    assert_eq!(terminal[0].mode, SteerMode::Prompt);
    assert_eq!(terminal[0].content, "first\nsecond");
    let ids: Vec<&str> = terminal[0].queued_ids.iter().map(|id| id.as_str()).collect();
    assert_eq!(ids, [first["queuedId"].as_str().unwrap(), second["queuedId"].as_str().unwrap()]);
    assert_eq!(terminal[1].mode, SteerMode::TaskNotification);
    assert_eq!(terminal[1].content, "job-7 finished.");
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(runs_started(&rig, &handle.id), 1, "taken input starts no turn");
    assert!(handle.cell.view.load_full().state.queued.as_ref().is_some_and(Vec::is_empty));
}

/// `notification-bus.test.mjs` "one wake per session is in flight, and a suppressed wake
/// replays afterwards": completions that land after the woken turn's last look each get a
/// turn of their own, oldest first, and a replay that finds nothing ends the chain.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn completions_after_the_woken_turns_last_look_replay_oldest_first() {
    use mixdog_tools::exec::TaskNotifier;
    let rig = Rig::new();
    let gate = Arc::new(tokio::sync::Notify::new());
    let inputs: Arc<Mutex<Vec<(Value, usize)>>> = Arc::default();
    let (open, seen) = (gate.clone(), inputs.clone());
    rig.set_script(Arc::new(move |run| {
        let (open, seen) = (open.clone(), seen.clone());
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let first = lock(&seen).is_empty();
            // The boundary looks first; the woken turn then waits past its last look.
            let took = run.port.take_steers(drain(DrainStage::PreSend)).await.expect("take").len();
            lock(&seen).push((run.input_body.clone(), took));
            if first {
                open.notified().await;
            }
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    directory.finished(&handle.id, "shell", "job-1", "completed", "job-1 finished.".into()).await;
    eventually(|| (lock(&inputs).len() == 1).then_some(())).await;
    directory.finished(&handle.id, "shell", "job-2", "completed", "job-2 finished.".into()).await;
    directory.finished(&handle.id, "shell", "job-3", "completed", "job-3 finished.".into()).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    gate.notify_one();
    eventually(|| (lock(&inputs).len() == 3).then_some(())).await;
    eventually(|| idle(&handle).then_some(())).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let inputs = lock(&inputs).clone();
    let order: Vec<&str> = inputs.iter().map(|(body, _)| body["content"].as_str().unwrap()).collect();
    assert_eq!(order, ["job-1 finished.", "job-2 finished.", "job-3 finished."]);
    // The replayed wake drained both: job-3 is its own turn, not taken by job-2's boundary.
    assert!(inputs.iter().all(|(_, took)| *took == 0), "{inputs:?}");
    assert_eq!(runs_started(&rig, &handle.id), 3, "a replay that finds nothing ends the chain");
}

/// The ports' header seam: `thread/header/patch` is one durable `meta` record and
/// `thread/header/read` answers the acked header; a connection may do neither.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_header_is_patched_and_read_through_the_ports_seam_only() {
    use crate::ports::threads::SessionThreads;
    use crate::ports::threads::ThreadState;
    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    let handle = start_thread(&directory).await;
    let threads = SessionThreads::new(directory.clone());
    let mut set = serde_json::Map::new();
    set.insert("pendingRoute".into(), json!({ "provider": "p", "model": "m" }));
    set.insert("title".into(), json!("held"));
    threads.patch_header(&handle.id, set, Vec::new()).await.expect("patch");
    let header = threads.header(&handle.id).await.expect("read");
    assert_eq!(header["pendingRoute"], json!({ "provider": "p", "model": "m" }));
    assert!(rig.store.records(&handle.id).into_iter().any(|(_, record)| matches!(
        record,
        mixdog_store::schema::record::Record::Meta(meta)
            if matches!(&meta.change, mixdog_store::schema::blob::Slot::Inline(c) if c.set.contains_key("pendingRoute"))
    )));
    threads.patch_header(&handle.id, serde_json::Map::new(), vec!["pendingRoute".into()]).await.expect("unset");
    let header = threads.header(&handle.id).await.expect("read");
    assert!(!header.contains_key("pendingRoute"));
    assert_eq!(header["title"], "held");

    for method in ["thread/header/patch", "thread/header/read"] {
        let refused = handle
            .request(request(method, json!({ "threadId": handle.id, "set": { "x": 1 } }), "op-x"))
            .await;
        assert!(matches!(refused, Err(CoreError::InvalidParams { .. })), "{method}: {refused:?}");
    }
}

/// `ask-turn-steering-drain.mjs:48`: while a route saved during the turn is held, the queued
/// completion is left to the next turn.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_held_route_leaves_a_completion_to_the_next_turn() {
    use crate::ports::threads::SessionThreads;
    use crate::ports::threads::ThreadState;
    use mixdog_tools::exec::TaskNotifier;
    let rig = Rig::new();
    let gate = Arc::new(tokio::sync::Notify::new());
    let took: Arc<Mutex<Vec<usize>>> = Arc::default();
    let (open, seen) = (gate.clone(), took.clone());
    rig.set_script(Arc::new(move |run| {
        let (open, seen) = (open.clone(), seen.clone());
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            if lock(&seen).is_empty() {
                open.notified().await;
            }
            let n = run.port.take_steers(drain(DrainStage::PreSend)).await.expect("take").len();
            lock(&seen).push(n);
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    let handle = start_thread(&directory).await;
    turn(&handle, "build", "op-1").await;
    let mut set = serde_json::Map::new();
    set.insert("pendingRoute".into(), json!({ "provider": "p", "model": "m" }));
    SessionThreads::new(directory.clone()).patch_header(&handle.id, set, Vec::new()).await.expect("held");
    directory.finished(&handle.id, "shell", "job-7", "completed", "job-7 finished.".into()).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    gate.notify_one();
    eventually(|| (lock(&took).len() == 2).then_some(())).await;
    assert_eq!(lock(&took)[0], 0, "held: not taken by this turn");
    assert_eq!(runs_started(&rig, &handle.id), 2, "the next turn is the completion's");
}

fn runs_started(rig: &Rig, id: &ThreadId) -> usize {
    use mixdog_store::schema::record::Record;
    use mixdog_store::schema::record::RunPhase;
    rig.store
        .records(id)
        .into_iter()
        .filter(|(_, record)| matches!(record, Record::Run(run) if run.phase == RunPhase::Started))
        .count()
}

async fn start_with_session(directory: &SessionDirectory, session: Value) -> Arc<SessionHandle> {
    let reply = directory
        .request(request(
            "thread/start",
            json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws", "session": session }),
            "op-start",
        ))
        .await
        .expect("thread/start");
    let Reply::Subscribe(started) = reply else { panic!("thread/start subscribes") };
    let id = ThreadId::from(started.result["thread"]["id"].as_str().expect("thread id"));
    directory.handle(&id).expect("loaded")
}

/// `notification-bus.test.mjs` "a queued completion wakes its owner session" and
/// `ask-queue.mjs:87-101`: the completion is the woken turn's input, a task-notification row.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_completion_on_an_idle_thread_wakes_it_with_the_completion_as_the_turns_input() {
    use mixdog_tools::exec::TaskNotifier;
    let rig = Rig::new();
    let inputs: Arc<Mutex<Vec<Value>>> = Arc::default();
    let seen = inputs.clone();
    rig.set_script(Arc::new(move |run| {
        lock(&seen).push(run.input_body.clone());
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    directory.finished(&handle.id, "shell", "job-7", "completed", "Async shell task job-7 finished.".into()).await;
    eventually(|| (lock(&inputs).len() == 1).then_some(())).await;
    let body = lock(&inputs)[0].clone();
    assert_eq!(body["role"], "user");
    assert_eq!(body["content"], "Async shell task job-7 finished.");
    assert_eq!(body["meta"]["source"], "task-notification");
    assert_eq!(body["meta"]["execution"], json!({ "surface": "shell", "id": "job-7", "status": "completed" }));
    eventually(|| idle(&handle).then_some(())).await;
    assert_eq!(runs_started(&rig, &handle.id), 1);
    assert!(prompt_list(&handle).is_empty(), "a completion is no prompt");
}

/// `autoWakeCompletions: false` (`infrastructure.mjs:154`) and an owner that is not the live
/// session (`notification-bus.test.mjs` "no longer the live session"): the completion is kept
/// for the next turn and starts none.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn no_wake_without_auto_wake_or_for_a_thread_opened_for_the_completion() {
    use mixdog_tools::exec::TaskNotifier;
    let rig = Rig::new();
    rig.set_script(echo());
    let directory = SessionDirectory::new(rig.deps());
    let quiet = start_with_session(&directory, json!({ "autoWakeCompletions": false })).await;
    directory.finished(&quiet.id, "shell", "job-1", "completed", "job-1 finished.".into()).await;

    let parked = start_thread(&directory).await;
    subscribe(&parked);
    parked.cell.unsubscribed();
    eventually(|| directory.handle(&parked.id).is_none().then_some(())).await;
    directory.finished(&parked.id, "shell", "job-2", "completed", "job-2 finished.".into()).await;

    for (handle, task) in [(&quiet, "job-1"), (&parked, "job-2")] {
        let queued = eventually(|| {
            rig.store.records(&handle.id).into_iter().find_map(|(_, record)| match record {
                mixdog_store::schema::record::Record::Queue(queue) => queue.entry,
                _ => None,
            })
        })
        .await;
        let mixdog_store::schema::blob::Slot::Inline(entry) = &queued else { panic!("inline entry") };
        assert_eq!(entry["executionId"], task, "kept for the next turn");
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(runs_started(&rig, &quiet.id), 0);
    assert_eq!(runs_started(&rig, &parked.id), 0);
}

/// `thread/revertTurnReview` and `thread/revertTurnReviewFile` reach the turn review through the
/// thread handle: a thread with no turn answers Node's refusal, a malformed call is invalid params.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn turn_review_reverts_are_served_by_the_thread_handle() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    for (method, params) in [
        ("thread/revertTurnReview", json!({ "threadId": handle.id, "opId": "op-1" })),
        ("thread/revertTurnReviewFile", json!({ "threadId": handle.id, "opId": "op-1", "file": "a.txt" })),
    ] {
        let error = handle.request(request(method, params, "op-1")).await.expect_err("no turn to revert");
        match error {
            CoreError::DomainError { domain, message: Some(message), .. } => {
                assert_eq!((&*domain, &*message), ("turnReview", "turn worktree snapshot is unavailable"), "{method}");
            }
            other => panic!("{method}: {other:?}"),
        }
    }
    let error = handle
        .request(request("thread/revertTurnReviewFile", json!({ "threadId": handle.id, "opId": "op-2" }), "op-2"))
        .await
        .expect_err("a file is required");
    assert!(matches!(error, CoreError::InvalidParams { .. }), "{error:?}");
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
#[allow(clippy::disallowed_methods, reason = "test setup makes the sessions folder")]
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
    Arc::new(super::StoreThreads::new(data, blobs, index, writer, tokens.maintenance_io))
}

/// `thread/delete` (`deleteSession`): the pending approval leaves the list and the running
/// turn is aborted with the close reason and ends first; then the agent tool forgets it, its
/// work is released, the mark makes it gone (not openable, not deleted twice) and the purge
/// removes its files, the purge hooks run in the order a 1.4.5 daemon registers them (the turn
/// review's in its place), the app feed hears `thread/deleted`, and the search copy and the
/// worktree go after.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[allow(clippy::disallowed_methods, reason = "the test checks the purged folder")]
async fn a_delete_closes_the_running_turn_and_purges_in_nodes_order() {
    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let rig = Rig::new();
    let aborted: Arc<Mutex<Option<(ApprovalResolution, String)>>> = Arc::default();
    let seen = aborted.clone();
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
                    payload: json!({ "kind": "shell", "tool": "shell", "request": { "target": "make" } }),
                    remember: Vec::new(),
                    expires_after: None,
                })
                .await;
            run.cancel.cancelled().await;
            *seen.lock().unwrap() = Some((resolution, run.signal.reason()));
            RunOutcome::Interrupted
        })
    }));
    let directory = SessionDirectory::new(rig.deps_on(store));
    let handle = start_thread(&directory).await;
    let id = handle.id.clone();
    turn(&handle, "long job", "op-1").await;
    let published = eventually(|| {
        rig.sink.events().into_iter().find_map(|event| match event {
            ServerRequestEvent::Published(request) => Some(request.id),
            _ => None,
        })
    })
    .await;
    let reply = handle
        .request(request("thread/delete", json!({ "threadId": id, "opId": "op-del" }), "op-del"))
        .await
        .expect("thread/delete");
    assert!(matches!(reply, Reply::Value(Value::Bool(true))), "{reply:?}");
    let reason = mixdog_agent::cancel::close_session_reason(id.as_str(), super::delete::DELETE_REASON);
    let (resolution, signal) = aborted.lock().unwrap().clone().expect("the turn ended before the delete went on");
    assert!(matches!(resolution, ApprovalResolution::Interrupted { .. }), "{resolution:?}");
    assert_eq!(signal, reason);
    assert!(
        rig.sink.events().iter().any(|event| matches!(event, ServerRequestEvent::Resolved(rid, _) if *rid == published)),
        "the approval left the list"
    );
    assert!(directory.handle(&id).is_none(), "the thread left the directory");
    assert!(matches!(
        directory.open(&id, &CallContext::internal("test")).await,
        Err(CoreError::ThreadNotFound { .. })
    ));
    assert!(!data.path().join("sessions").join(id.as_str()).exists(), "no fork reads it: its files are gone");

    // The hook order is the golden's (the turn review's hook is not recorded here).
    let golden: Vec<String> = serde_json::from_str(include_str!("delete_goldens/purge_order.json")).unwrap();
    let name = |path: &str| match path.rsplit('/').next().unwrap() {
        "tool-result-offload.mjs:506" => "toolResultOffload",
        "usage-metrics.mjs:21" => "usageMetrics",
        "runtime-liveness.mjs:65" => "browserSession",
        "session-transcript-purge.mjs:20" => "transcripts",
        "cache-warm.mjs:424" => "cacheWarm",
        "read-cache.mjs:317" => "readCache",
        "compaction-archive-capture.mjs:738" => "compactionCapture",
        "session-close.mjs:282" => "providerConnections",
        "providers.mjs:54" => "connectorAccounts",
        "runtime-review-api.mjs:26" => "turnReview",
        "worker-turns.mjs:208" => "workerTurns",
        "agent-tool.mjs:347" => "agentStatus",
        other => panic!("{other}"),
    };
    let s = id.as_str();
    let mut expected = vec![format!("forgetLeadSession:{s}"), format!("releaseSessionWork:{s}:desktop-session-delete")];
    for hook in golden.iter().map(|path| name(path)).filter(|hook| *hook != "turnReview").chain(["compactionArchive", "scratchDir"]) {
        expected.push(format!("{hook}:{s}:/ws"));
    }
    expected.extend([format!("thread/deleted:{s}"), format!("forgetSessionSearch:{s}"), format!("releaseDeletedWorktree:{s}")]);
    eventually(|| (lock(&rig.deletes.0).len() == expected.len()).then_some(())).await;
    assert_eq!(*lock(&rig.deletes.0), expected);

    // Deleted already, or not a session id: nothing is deleted, nothing runs.
    let other = start_thread(&directory).await;
    for target in [id.as_str(), "../x"] {
        let reply = other.request(request("thread/delete", json!({ "threadId": target, "opId": "op-bad" }), "op-bad")).await.expect("delete");
        assert!(matches!(reply, Reply::Value(Value::Bool(false))), "{target}");
    }
    // A thread that cannot be opened (deleted, or never there) is answered by the directory:
    // nothing to delete, `false`, never `threadNotFound`.
    for target in [id.as_str(), "sess_missing"] {
        assert!(matches!(
            directory.open(&ThreadId::from(target), &CallContext::internal("test")).await,
            Err(CoreError::ThreadNotFound { .. })
        ));
        let params = json!({ "threadId": target, "opId": "op-gone" });
        let reply = mixdog_core_api::ThreadDirectory::request(&directory, request("thread/delete", params, "op-gone")).await.expect("delete");
        assert!(matches!(reply, Reply::Value(Value::Bool(false))), "{target}: {reply:?}");
    }
    assert_eq!(lock(&rig.deletes.0).len(), expected.len());
}

/// A deleted base keeps its files while a fork reads them: the fork still opens with the
/// base's history.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[allow(clippy::disallowed_methods, reason = "the test checks the kept folder")]
async fn a_deleted_base_stays_readable_by_its_fork() {
    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let rig = Rig::new();
    rig.set_script(echo());
    let directory = SessionDirectory::new(rig.deps_on(store.clone()));
    let base = start_thread(&directory).await;
    turn(&base, "first", "op-1").await;
    eventually(|| (idle(&base) && rows(&base).len() == 2).then_some(())).await;
    let reply = base
        .request(request("thread/fork", json!({ "threadId": base.id, "opId": "op-fork" }), "op-fork"))
        .await
        .expect("thread/fork");
    let Reply::Value(value) = reply else { panic!("thread/fork answers a value") };
    let fork = ThreadId::from(value["thread"]["id"].as_str().expect("fork id"));
    let reply = base
        .request(request("thread/delete", json!({ "threadId": base.id, "opId": "op-del" }), "op-del"))
        .await
        .expect("thread/delete");
    assert!(matches!(reply, Reply::Value(Value::Bool(true))), "{reply:?}");
    assert!(data.path().join("sessions").join(base.id.as_str()).exists(), "the fork reads it");
    let second = SessionDirectory::new(rig.deps_on(store));
    let reopened = second.open_handle(&fork, &CallContext::internal("test")).await.expect("the fork opens");
    assert_eq!(rows(&reopened).len(), 2, "the base's history shows in the fork");
}

/// `thread/delete` with `ifIdle` (`deleteSessionIfIdle`): each refusal in Node's order deletes
/// nothing; an archived, unfavored, idle and unchanged session is deleted.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_idle_delete_refuses_as_node_does_and_deletes_an_idle_archived_session() {
    use super::delete::SidebarState;
    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let rig = Rig::new();
    let release: Arc<tokio::sync::Notify> = Arc::default();
    let gate = release.clone();
    rig.set_script(Arc::new(move |run| {
        let gate = gate.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            gate.notified().await;
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps_on(store));
    let handle = start_thread(&directory).await;
    let id = handle.id.clone();
    let ask = |expected: Value| {
        let handle = handle.clone();
        let id = id.clone();
        async move {
            match handle
                .request(request("thread/delete", json!({ "threadId": id, "opId": "op-d", "ifIdle": expected }), "op-d"))
                .await
                .expect("delete")
            {
                Reply::Value(value) => value,
                other => panic!("{other:?}"),
            }
        }
    };
    let state = |archived: bool, favorite: bool| {
        let mut sidebar = SidebarState::default();
        if archived {
            sidebar.archived.insert(id.as_str().to_owned());
        }
        if favorite {
            sidebar.favorites.insert(id.as_str().to_owned());
        }
        *lock(&rig.deletes.1) = Some(sidebar);
    };
    let refused = |reason: &str| json!({ "deleted": false, "reason": reason });
    assert_eq!(ask(json!({})).await, refused("not-archived"), "no sidebar state");
    state(false, false);
    assert_eq!(ask(json!({})).await, refused("not-archived"));
    state(true, true);
    assert_eq!(ask(json!({})).await, refused("favorite"));
    state(true, false);
    turn(&handle, "work", "op-1").await;
    assert_eq!(ask(json!({})).await, refused("busy"));
    release.notify_one();
    eventually(|| idle(&handle).then_some(())).await;
    // The turn moved `lastUsedAt` past what the caller saw.
    let used = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let meta = directory.session_meta(&id).await.expect("meta").expect("listed");
            if meta.last_used_at > 0.0 {
                break meta.last_used_at;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the completed turn stamps lastUsedAt");
    assert_eq!(ask(json!({ "lastUsedAt": used - 1.0 })).await, refused("changed"));
    assert!(lock(&rig.deletes.0).is_empty(), "a refusal deletes nothing");
    assert_eq!(ask(json!({ "lastUsedAt": used })).await, json!({ "deleted": true }));
    let s = id.as_str();
    let worktree = format!("releaseDeletedWorktree:{s}");
    eventually(|| lock(&rig.deletes.0).contains(&worktree).then_some(())).await;
    let steps = lock(&rig.deletes.0).clone();
    assert_eq!(steps[0], format!("toolResultOffload:{s}:/ws"), "the purge hooks run first");
    let tail: Vec<&str> = steps[steps.len() - 5..].iter().map(String::as_str).collect();
    assert_eq!(
        tail,
        [
            format!("thread/deleted:{s}"),
            format!("forgetLeadSession:{s}"),
            format!("releaseSessionWork:{s}:desktop-auto-delete"),
            format!("forgetSessionSearch:{s}"),
            format!("releaseDeletedWorktree:{s}"),
        ]
    );
}

/// A prompt larger than a frame's inline budget goes through the runtime codec into a
/// blob of its own, and a reopen gives it back (prompt history and the rewind text).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[allow(clippy::disallowed_methods, reason = "the test reads the written log")]
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

/// The whole stored history reads every page of the lineage, oldest first, and a rewind's
/// superseded rows are not part of it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_real_store_reads_the_whole_history_oldest_first() {
    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let rig = Rig::new();
    rig.set_script(echo());
    let directory = SessionDirectory::new(rig.deps_on(store));
    let handle = start_thread(&directory).await;
    turn(&handle, "one", "op-1").await;
    eventually(|| (idle(&handle) && rows(&handle).len() == 2).then_some(())).await;
    turn(&handle, "two", "op-2").await;
    eventually(|| (idle(&handle) && rows(&handle).len() == 4).then_some(())).await;
    let ids = |items: Vec<mixdog_protocol::ThreadItem>| items.iter().map(|i| i.id().clone()).collect::<Vec<_>>();
    let shown: Vec<_> = handle.cell.view.load_full().items.iter().map(|i| i.id().clone()).collect();
    assert_eq!(ids(directory.history_items(&handle.id).await.expect("history")), shown);

    let second = shown[2].clone();
    let reply = handle
        .request(request("thread/rewind", json!({ "threadId": handle.id, "opId": "op-3", "itemId": second }), "op-3"))
        .await
        .expect("rewind");
    assert!(matches!(reply, Reply::Value(_)));
    eventually(|| (rows(&handle).len() == 2).then_some(())).await;
    assert_eq!(ids(directory.history_items(&handle.id).await.expect("history")), shown[..2]);
    assert!(directory.history_items(&ThreadId::from("missing")).await.is_err());
}

/// The run publishes its progress into the session cell; the registry's `runtime_stage` and the
/// worker views' `live` read that one value, and a thread this process does not host has none.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_runs_progress_is_read_from_the_session_cell() {
    use crate::run_host::progress::ProgressPublisher;
    use crate::run_host::progress::WaitedJobs;
    use crate::session::agent_registry::LiveSessions;

    struct At(i64);
    impl mixdog_agent::env::Clock for At {
        fn now_ms(&self) -> i64 {
            self.0
        }
    }
    struct NoJobs;
    impl WaitedJobs for NoJobs {
        fn silence(&self, _: &[String], _: i64) -> Option<mixdog_agent::agent_tool::progress::ToolSilence> {
            None
        }
    }

    let rig = Rig::new();
    rig.set_script(Arc::new(|run| {
        Box::pin(async move {
            let progress = ProgressPublisher::new(run.progress.clone(), Arc::new(At(1_000)));
            progress.ask_start();
            progress.stage("streaming");
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    assert_eq!(LiveSessions::runtime_stage(&directory, handle.id.as_str()), None, "no marker yet");
    turn(&handle, "go", "op-1").await;
    eventually(|| idle(&handle).then_some(())).await;
    assert_eq!(LiveSessions::runtime_stage(&directory, handle.id.as_str()).as_deref(), Some("streaming"));
    let live = directory.worker_live(&handle.id, 2_000, &NoJobs);
    assert_eq!(live.runtime_stage.as_deref(), Some("streaming"));
    assert_eq!(live.runtime.map(|facts| facts.ask_started_at), Some(1_000));
    assert_eq!(directory.worker_live(&ThreadId::from("elsewhere"), 2_000, &NoJobs), Default::default());
}

/// `assertAgentEditorAccess` reads the caller record's own `agent`
/// (`String(caller?.agent || '').trim()`): an agent home carries it from creation, a coding
/// Lead names none; a thread that cannot be opened is an error, not "no agent".
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_acting_agent_is_the_callers_own_agent_field() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let header = |value: Value| value.as_object().cloned().unwrap();
    directory
        .create_with_id(ThreadId::from("sess_home_my_bot"), header(json!({ "agent": "my.bot" })), json!({}))
        .await
        .expect("home");
    directory
        .create_with_id(ThreadId::from("sess_w1"), header(json!({ "owner": "agent", "agent": " reviewer " })), json!({}))
        .await
        .expect("worker");
    directory.create_with_id(ThreadId::from("sess_lead1"), header(json!({ "agent": false })), json!({})).await.expect("lead");
    assert_eq!(directory.acting_agent(&ThreadId::from("sess_home_my_bot")).await.expect("home"), "my.bot");
    assert_eq!(directory.acting_agent(&ThreadId::from("sess_w1")).await.expect("worker"), "reviewer");
    assert_eq!(directory.acting_agent(&ThreadId::from("sess_lead1")).await.expect("lead"), "");
    assert!(matches!(
        directory.acting_agent(&ThreadId::from("sess_missing")).await,
        Err(CoreError::ThreadNotFound { .. })
    ));
}

/// After a compaction the conversation is the summary alone, so the switch anchors on the
/// summary entry: it has no history row, and the record names the compaction frame.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_model_switch_after_a_compaction_anchors_on_the_summary() {
    use mixdog_store::schema::record::Record;
    let rig = Rig::new();
    let id = ThreadId::from("sess_compacted");
    let item: Record = serde_json::from_value(json!({
        "k": "item", "iid": "u1", "form": "message", "model": true, "visible": true, "role": "user",
        "refs": [], "body": { "inline": { "role": "user", "content": "hi" } },
    }))
    .expect("item");
    let compacted: Record = serde_json::from_value(json!({
        "k": "compacted", "cid": "c1", "summary_iid": "sum1",
        "replacement": { "inline": [{ "iid": "sum1", "body": { "role": "user", "content": "[summary] earlier work" } }] },
    }))
    .expect("compacted");
    rig.store.seed(&id, vec![item, compacted]);
    let directory = SessionDirectory::new(rig.deps());
    let boundary = json!({ "provider": "openai", "modelId": "gpt-next", "at": 300 });
    assert!(super::record_model_switch(&directory, &id, &boundary).await.expect("record"));
    let anchors: Vec<(String, u64)> = rig
        .store
        .records(&id)
        .into_iter()
        .filter_map(|(_, record)| match record {
            Record::ModelSwitch(switch) => Some((switch.anchor.iid.as_str().to_owned(), switch.anchor.ordinal)),
            _ => None,
        })
        .collect();
    assert_eq!(anchors, [("sum1".to_owned(), 1)], "the compaction frame's ordinal");
}

/// A run's live-only events reach the view and the feed as Node's turn shows them: reasoning
/// grows its item (`item/reasoning/textDelta`), a notice is a polished `info` line, a model
/// call's usage is `thread/tokenUsage/updated`, a compaction that changed the context marks
/// where the turn began, and a committed row's own prompt text joins the prompt history.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_runs_live_events_show_as_nodes_turn_shows_them() {
    let rig = Rig::new();
    let gate: Arc<tokio::sync::Notify> = Arc::default();
    let release = gate.clone();
    rig.set_script(Arc::new(move |run| {
        let release = release.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let reasoning = ItemId::from("r1".to_owned());
            let item = ThreadItem::Reasoning { id: reasoning.clone(), summary: Vec::new(), content: Vec::new(), meta: Default::default() };
            run.port.item_started(item).await.expect("started");
            run.port.reasoning_delta(reasoning.clone(), "think ".into()).await.expect("delta");
            run.port.reasoning_delta(reasoning.clone(), "more".into()).await.expect("delta");
            run.port.reasoning_completed(reasoning, "think more".into()).await.expect("completed");
            run.port.notice("model switch failed".into()).await.expect("notice");
            let usage = mixdog_core_api::domain::provider::Usage { input_tokens: 10, output_tokens: 5, cache_read_tokens: 3, cache_write_tokens: 2, ..Default::default() };
            let tool = mixdog_core_api::domain::provider::ToolDefinition { name: "read".into(), description: "d".into(), input_schema: json!({ "type": "object" }), defer_loading: true };
            run.port
                .usage(crate::session::UsageReport {
                    iteration: 1,
                    usage,
                    model: "gpt-answered".into(),
                    requested_model: "gpt-asked".into(),
                    delta_tool_calls: 2,
                    request_ms: 340,
                    delta_prompt: 15,
                    send_tools: vec![tool],
                    reasoning_tokens: Some(4),
                    reasoning_tokens_complete: true,
                })
                .await
                .expect("usage");
            let event = mixdog_agent::env::CompactEvent {
                dropped_count: 2,
                dropped: None,
                trigger: mixdog_agent::env::CompactTrigger::Auto,
                status: mixdog_agent::env::CompactStatus::Compacted,
                before_tokens: 0,
                duration_ms: 0,
                after_tokens: 0,
                before_messages: 4,
                after_messages: 1,
                pressure_tokens: 900,
                trigger_tokens: 800,
                boundary_tokens: 1000,
                target_budget_tokens: 500,
            };
            run.port.compact_event(event).await.expect("compact");
            run.port
                .commit_item(ItemCommit {
                    iid: ItemId::from(format!("s-{}", run.turn)),
                    role: Some("user".into()),
                    model: true,
                    visible: true,
                    body: json!({ "role": "user", "content": "steered", "meta": { "transcript": { "at": 1 } } }),
                    prompt: Some("steered words".into()),
                })
                .await
                .expect("commit");
            release.notified().await;
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "go", "op-1").await;
    let items = |handle: &SessionHandle| -> Vec<ThreadItem> { handle.cell.view.load_full().items.iter().map(|item| (**item).clone()).collect() };
    let thinking = eventually(|| {
        items(&handle).into_iter().find_map(|item| match item {
            ThreadItem::Reasoning { content, .. } if content.concat() == "think more" => Some(content),
            _ => None,
        })
    })
    .await;
    assert_eq!(thinking, ["think more"], "one growing part");
    eventually(|| prompt_list(&handle).contains(&"steered words".to_owned()).then_some(())).await;
    gate.notify_one();
    eventually(|| idle(&handle).then_some(())).await;

    let shown = items(&handle);
    let kinds: Vec<String> = shown
        .iter()
        .map(|item| match item {
            ThreadItem::UserMessage { display_text, .. } => format!("user:{display_text}"),
            ThreadItem::StatusRow { kind, meta, .. } => format!("{kind}:{}", meta.label.clone().unwrap_or_default()),
            other => format!("{:?}", std::mem::discriminant(other)),
        })
        .collect();
    let marker = kinds.iter().position(|k| k == "statusdone:Compact complete").expect("the marker");
    assert_eq!(kinds[marker + 1], "user:go", "the marker stands before the turn's input row: {kinds:?}");
    let notice = shown
        .iter()
        .find_map(|item| match item {
            ThreadItem::StatusRow { kind, meta, .. } if kind == "notice" => Some(serde_json::to_value(meta).expect("meta")),
            _ => None,
        })
        .expect("the notice");
    assert_eq!((notice["ext"]["text"].clone(), notice["ext"]["tone"].clone()), (json!("Couldn’t switch model."), json!("info")), "{notice}");

    let frames = rig.feeds.frames(handle.id.as_str());
    let methods: Vec<&str> = frames.iter().map(|(_, method, _)| method.as_str()).collect();
    assert_eq!(methods.iter().filter(|m| **m == "item/reasoning/textDelta").count(), 2);
    let usage = frames.iter().find(|(_, method, _)| method == "thread/tokenUsage/updated").expect("usage").2["usage"].clone();
    assert_eq!(
        (usage["deltaInput"].clone(), usage["deltaOutput"].clone(), usage["deltaCachedRead"].clone(), usage["deltaCacheWrite"].clone(), usage["iterationIndex"].clone()),
        (json!(10), json!(5), json!(3), json!(2), json!(1))
    );
    // `usageDeltaEvent`'s other fields, in Node's key order.
    let keys: Vec<&str> = usage.as_object().expect("usage").keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        [
            "sessionId", "iterationIndex", "source", "requestedModel", "model", "deltaInput", "deltaOutput", "deltaToolCalls", "reasoningTokens",
            "reasoningTokensComplete", "deltaPrompt", "requestMs", "promptKnown", "deltaCachedRead", "deltaCacheWrite", "contextInputTokens",
            "contextOutputTokens", "contextPromptTokens", "contextCachedReadTokens", "contextCacheWriteTokens", "contextMeasuredTokens", "sendTools", "ts"
        ]
    );
    assert_eq!(
        (usage["model"].clone(), usage["requestedModel"].clone(), usage["deltaToolCalls"].clone(), usage["requestMs"].clone(), usage["deltaPrompt"].clone(), usage["reasoningTokens"].clone()),
        (json!("gpt-answered"), json!("gpt-asked"), json!(2), json!(340), json!(15), json!(4))
    );
    assert_eq!(usage["sendTools"], json!([{ "name": "read", "description": "d", "inputSchema": { "type": "object" }, "deferLoading": true }]));
    // The finished thinking is `item/completed` of type `reasoning`, once, in place of the live item.
    let completed: Vec<&Value> = frames
        .iter()
        .filter(|(_, method, params)| method == "item/completed" && params["item"]["type"] == "reasoning")
        .map(|(_, _, params)| params)
        .collect();
    assert_eq!(completed.len(), 1);
    assert_eq!((completed[0]["item"]["id"].clone(), completed[0]["item"]["content"].clone()), (json!("r1"), json!(["think more"])));
    assert_eq!(shown.iter().filter(|item| matches!(item, ThreadItem::Reasoning { .. })).count(), 1);
}

/// A Goal set during a user turn continues across it: once the turn settles with the Goal
/// active and the thread idle, the runtime's continuation runs as an automatic turn whose input
/// is runtime-synthetic (no user row); that turn pausing the Goal ends the chain, and the lane
/// shows the paused Goal.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_goal_continues_across_a_turn_until_it_stops() {
    use crate::goal::hooks::GoalViewHooks;

    let rig = Rig::new();
    let inputs: Arc<Mutex<Vec<Value>>> = Arc::default();
    let (seen, goals) = (inputs.clone(), rig.goals.clone());
    rig.set_script(Arc::new(move |run| {
        let (seen, goals) = (seen.clone(), goals.clone());
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let automatic = run.input_body.pointer("/meta/source") == Some(&json!("goal-continuation"));
            lock(&seen).push(run.input_body.clone());
            let action = if automatic {
                // The automatic turn does work, then the Goal is paused.
                let call = ItemCommit {
                    iid: ItemId::from(format!("t-{}", run.turn)),
                    role: Some("tool".into()),
                    model: true,
                    visible: true,
                    body: json!({ "role": "tool", "toolCallId": "c1", "content": "ok" }),
                    prompt: None,
                };
                run.port.commit_item(call).await.expect("tool row");
                json!({ "action": "pause" })
            } else {
                json!({ "action": "create", "objective": "Ship the feature" })
            };
            goals.goal_control(&run.thread, action).await.expect("goal control");
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "start", "op-1").await;
    eventually(|| (lock(&inputs).len() == 2 && idle(&handle)).then_some(())).await;
    let goal_status = |frames: &[(u64, String, Value)]| {
        frames.iter().rev().find(|(_, method, _)| method == "thread/goal/updated").map(|(_, _, p)| p["value"]["status"].clone())
    };
    eventually(|| (goal_status(&rig.feeds.frames(handle.id.as_str())) == Some(json!("paused"))).then_some(())).await;
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let inputs = lock(&inputs).clone();
    assert_eq!(inputs.len(), 2, "a paused Goal does not continue: {inputs:?}");
    assert_eq!(inputs[1]["meta"], json!({ "source": "goal-continuation", "synthetic": true }));
    assert!(!inputs[1]["content"].as_str().unwrap_or_default().is_empty(), "the runtime's continuation prompt");
    let users: Vec<String> = rows(&handle).into_iter().filter(|(role, _)| *role == "user").map(|(_, text)| text).collect();
    assert_eq!(users, ["start"], "the automatic turn shows no user row");
    let frames = rig.feeds.frames(handle.id.as_str());
    let statuses: Vec<Value> = frames.iter().filter(|(_, m, _)| m == "thread/goal/updated").map(|(_, _, p)| p["value"]["status"].clone()).collect();
    assert!(statuses.contains(&json!("active")), "{statuses:?}");
}

/// The Goal runtime with a held `turn_settled`.
struct HeldSettle {
    goals: crate::goal::GoalRuntime,
    release: Arc<tokio::sync::Notify>,
    settled: Arc<std::sync::atomic::AtomicUsize>,
}

#[async_trait::async_trait]
impl crate::goal::hooks::GoalTurnHooks for HeldSettle {
    async fn turn_started(&self, thread: &ThreadId) -> crate::goal::GoalResult<Option<crate::goal::js::Goal>> {
        crate::goal::hooks::GoalTurnHooks::turn_started(&self.goals, thread).await
    }
    async fn turn_settled(&self, thread: &ThreadId, detail: Value) -> crate::goal::GoalResult<Option<crate::goal::js::Goal>> {
        self.release.notified().await;
        let goal = crate::goal::hooks::GoalTurnHooks::turn_settled(&self.goals, thread, detail).await;
        self.settled.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        goal
    }
    async fn archive_completed_on_user_input(&self, thread: &ThreadId) -> crate::goal::GoalResult<Option<crate::goal::js::Goal>> {
        crate::goal::hooks::GoalTurnHooks::archive_completed_on_user_input(&self.goals, thread).await
    }
    async fn reactivate_usage_limited(
        &self,
        thread: &ThreadId,
        goal_id: &str,
        admission: crate::goal::Admission,
    ) -> crate::goal::GoalResult<Option<crate::goal::js::Goal>> {
        crate::goal::hooks::GoalTurnHooks::reactivate_usage_limited(&self.goals, thread, goal_id, admission).await
    }
}

#[async_trait::async_trait]
impl crate::goal::hooks::GoalContinuationHooks for HeldSettle {
    async fn continuation(&self, thread: &ThreadId, input: crate::goal::ContinuationInput) -> crate::goal::GoalResult<crate::goal::Continuation> {
        crate::goal::hooks::GoalContinuationHooks::continuation(&self.goals, thread, input).await
    }
    fn reset_continuation_rules(&self, thread: &ThreadId) -> crate::goal::GoalResult<()> {
        crate::goal::hooks::GoalContinuationHooks::reset_continuation_rules(&self.goals, thread)
    }
}

#[async_trait::async_trait]
impl crate::goal::hooks::GoalViewHooks for HeldSettle {
    async fn goal_status(&self, thread: &ThreadId) -> crate::goal::GoalResult<Option<crate::goal::js::Goal>> {
        crate::goal::hooks::GoalViewHooks::goal_status(&self.goals, thread).await
    }
    async fn goal_control(&self, thread: &ThreadId, request: Value) -> crate::goal::GoalResult<Value> {
        crate::goal::hooks::GoalViewHooks::goal_control(&self.goals, thread, request).await
    }
    fn on_goal_change(&self, listener: Box<dyn Fn(&crate::goal::GoalEvent) + Send + Sync>) -> crate::goal::Subscription {
        crate::goal::hooks::GoalViewHooks::on_goal_change(&self.goals, listener)
    }
}

/// A turn queued behind a running one starts only once the running turn's settlement
/// (`turn_settled`) has returned, as Node's queue drains after `runTurn` awaits it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_queued_turn_starts_after_the_settlement_returns() {
    use std::sync::atomic::Ordering;

    let rig = Rig::new();
    rig.set_script(echo());
    let release: Arc<tokio::sync::Notify> = Arc::default();
    let settled: Arc<std::sync::atomic::AtomicUsize> = Arc::default();
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.goals = Arc::new(HeldSettle { goals: rig.goals.clone(), release: release.clone(), settled: settled.clone() });
    let directory = SessionDirectory::new(Arc::new(deps));
    let handle = start_thread(&directory).await;
    turn(&handle, "one", "op-1").await;
    eventually(|| idle(&handle).then_some(())).await;
    // The first turn ended; its settlement is held. A new prompt waits behind it.
    let queued = turn(&handle, "two", "op-2").await;
    assert_eq!(queued["kind"], "queued", "{queued}");
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(idle(&handle), "no turn starts before the settlement");
    assert_eq!(settled.load(Ordering::SeqCst), 0);
    release.notify_one();
    eventually(|| (settled.load(Ordering::SeqCst) == 1).then_some(())).await;
    eventually(|| rows(&handle).iter().any(|(role, text)| *role == "user" && text == "two").then_some(())).await;
    release.notify_one();
    eventually(|| (idle(&handle) && rows(&handle).len() == 4).then_some(())).await;
}

/// Each run fails on exhausted provider quota; its failed turn end carries the quota stop.
fn quota_failure() -> Script {
    Arc::new(|run| {
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let end = json!({
                "type": "turnEnd", "id": format!("end-{}", run.turn), "status": "failed", "elapsedMs": 5,
                "quota": { "provider": "anthropic", "model": "m", "resetAt": 5000 },
                "meta": { "turnId": run.turn, "ext": { "attemptId": run.turn } },
            });
            run.port
                .commit_item(ItemCommit {
                    iid: ItemId::from(format!("end-{}", run.turn)),
                    role: Some("assistant".into()),
                    model: false,
                    visible: true,
                    body: json!({ "shownItem": end }),
                    prompt: None,
                })
                .await
                .expect("commit");
            let provider = mixdog_protocol::ProviderErrorDetail {
                provider: "anthropic".into(),
                status: Some(429),
                kind: "quota_exhausted".into(),
                delivery: None,
            };
            RunOutcome::Failed(mixdog_protocol::TurnError { message: "quota".into(), data: json!({}), provider_error: Some(provider) })
        })
    })
}

/// `beginQuotaSettlement` / `finishQuotaSettlement`: an automatic Goal turn that fails on quota
/// queues its resume and, once its Goal settled `usage_limited`, records that Goal for the
/// resume. A user prompt inside the settling window (after the failed turn end, before the
/// Goal settlement) cancels the resume and keeps the suspension from being recorded.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cancel_inside_the_quota_settling_window_keeps_the_suspension_unrecorded() {
    use std::sync::atomic::Ordering;

    use crate::goal::hooks::GoalViewHooks;

    let rig = Rig::new();
    let release: Arc<tokio::sync::Notify> = Arc::default();
    let settled: Arc<std::sync::atomic::AtomicUsize> = Arc::default();
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.goals = Arc::new(HeldSettle { goals: rig.goals.clone(), release: release.clone(), settled: settled.clone() });
    let directory = SessionDirectory::new(Arc::new(deps));
    // A new active Goal continues at once: its automatic turn fails on quota, and the
    // settlement is held.
    let failed_turn = |rig: &Rig, handle: Arc<SessionHandle>| {
        let goals = rig.goals.clone();
        async move {
            goals.goal_control(&handle.id, json!({ "action": "create", "objective": "Ship it" })).await.expect("create");
            let goal = goals.goal_status(&handle.id).await.expect("status").expect("a goal");
            let attempt = eventually(|| {
                handle.cell.view.load_full().items.iter().find_map(|item| match item.as_ref() {
                    ThreadItem::TurnEnd { meta, .. } => meta.ext.get("attemptId").and_then(Value::as_str).map(str::to_owned),
                    _ => None,
                })
            })
            .await;
            (goal["id"].as_str().expect("goal id").to_owned(), format!("attempt:{attempt}"))
        }
    };
    rig.set_script(quota_failure());

    // Settled undisturbed: the resume waits and the suspended Goal is recorded.
    let first = start_thread(&directory).await;
    let (goal_id, key) = failed_turn(&rig, first.clone()).await;
    eventually(|| rig.quota.entry(first.id.as_str()).filter(|entry| entry.turn_key == key)).await;
    assert_eq!(settled.load(Ordering::SeqCst), 0);
    release.notify_one();
    eventually(|| (rig.quota.suspended_goal(first.id.as_str(), &key) == goal_id).then_some(())).await;

    // A prompt while the failed turn settles: the resume goes, and the settlement records nothing.
    let second = start_thread(&directory).await;
    let (_, key) = failed_turn(&rig, second.clone()).await;
    let id = second.id.as_str();
    eventually(|| rig.quota.entry(id).filter(|entry| entry.turn_key == key)).await;
    rig.set_script(echo());
    let queued = turn(&second, "next", "op-next").await;
    assert_eq!(queued["kind"], "queued", "the failed turn is still settling: {queued}");
    eventually(|| rig.quota.entry(id).is_none().then_some(())).await;
    release.notify_one();
    eventually(|| (settled.load(Ordering::SeqCst) == 2).then_some(())).await;
    eventually(|| rows(&second).iter().any(|(role, text)| *role == "user" && text == "next").then_some(())).await;
    release.notify_one();
    eventually(|| (settled.load(Ordering::SeqCst) == 3).then_some(())).await;
    // The settlement's store call runs after the cancel's, on the session's quota lane.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(rig.quota.suspended_goal(id, &key), "", "the cancel inside the window wins");
    assert!(rig.quota.entry(id).is_none());
}

/// `thread/clear` resets the environment in the same header change that drops the provider
/// state (`resetSessionBp3Environment`): the `env` block becomes the environment tail alone and
/// the next ask adds the `# Session` block again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_clear_resets_the_environment_with_the_provider_state() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let patch = json!({
        "threadId": handle.id,
        "set": {
            "providerState": { "x": 1 },
            "bp3EnvSplit": true,
            "promptEnv": "# Session\nold\n\ntail",
            "bp3EnvironmentContext": "tail",
            "sessionStartMetaInjected": true,
        },
    });
    handle
        .request(CoreRequest { method: Method("thread/header/patch"), params: patch, op: None, ctx: CallContext::internal("test") })
        .await
        .expect("patch");
    let expected = crate::run_host::route_change::environment_reset(&handle.cell.header.load());
    handle
        .request(request("thread/clear", json!({ "threadId": handle.id, "opId": "op-clear" }), "op-clear"))
        .await
        .expect("clear");
    let header = handle.cell.header.load_full();
    assert!(header.get("providerState").is_none());
    assert_eq!((header.get("promptEnv"), header.get("sessionStartMetaInjected")), (Some(&json!("tail")), Some(&json!(false))));
    for (key, value) in &expected.set {
        assert_eq!(header.get(key), Some(value), "{key}");
    }
    for key in &expected.unset {
        assert!(header.get(key).is_none(), "{key}");
    }
}

/// A restored window shows each compaction's divider where 1.4.5 restores it (after the rows
/// before the compaction, when its replacement kept none of them), the switches anchored on its
/// summary right after it, and a switch recorded live on the summary joins them.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restored_compaction_shows_its_divider_and_the_switches_on_its_summary() {
    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let rig = Rig::new();
    rig.set_script(echo());
    let directory = SessionDirectory::new(rig.deps_on(store.clone()));
    let handle = start_thread(&directory).await;
    turn(&handle, "first", "op-1").await;
    eventually(|| (idle(&handle) && rows(&handle).len() == 2).then_some(())).await;
    rig.set_script(Arc::new(|run| {
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let summary = json!({ "role": "user", "content": "[summary] earlier work" });
            let compaction = super::run::Compaction { replacement: vec![(ItemId::from("sum1".to_owned()), summary)], at: 777, dropped_count: 3, dropped: None };
            run.port.compacted(compaction).await.expect("compacted");
            RunOutcome::Completed(Default::default())
        })
    }));
    turn(&handle, "compact", "op-2").await;
    eventually(|| (idle(&handle) && rows(&handle).len() == 4).then_some(())).await;
    let ids = |handle: &SessionHandle| -> Vec<String> {
        handle.cell.view.load_full().items.iter().map(|item| item.id().as_str().to_owned()).collect()
    };
    // Live: the divider shows where the compaction happened, and a switch on its summary
    // shows right after it.
    let live = ids(&handle);
    assert!(live[3].starts_with("divider:") && !live[3].contains(":model:"), "{live:?}");
    let id = handle.id.clone();
    let switch = |at: i64| json!({ "provider": "openai", "modelId": "gpt-next", "at": at });
    assert!(super::record_model_switch(&directory, &id, &switch(300)).await.expect("record"));
    eventually(|| (ids(&handle).len() == 5).then_some(())).await;
    assert_eq!(ids(&handle)[4], format!("{}:model:300", live[3]));

    let reopened = SessionDirectory::new(rig.deps_on(store));
    let restored = reopened.open_handle(&id, &CallContext::internal("test")).await.expect("open");
    let shown = ids(&restored);
    let divider = shown.iter().position(|id| id.starts_with("divider:") && !id.contains(":model:")).expect("a divider");
    assert_eq!(divider, 3, "after the rows before the compaction: {shown:?}");
    let cid = shown[divider].trim_start_matches("divider:").to_owned();
    assert_eq!(shown[divider + 1..], [format!("divider:{cid}:model:300")]);
    let ThreadItem::ContextCompaction { meta, .. } = restored.cell.view.load_full().items[divider].as_ref().clone() else {
        panic!("the divider is a compaction row");
    };
    assert_eq!(meta.at, Some(777));

    assert!(super::record_model_switch(&reopened, &id, &switch(400)).await.expect("record live"));
    eventually(|| (ids(&restored).len() == shown.len() + 1).then_some(())).await;
    assert_eq!(ids(&restored)[divider + 1..], [format!("divider:{cid}:model:300"), format!("divider:{cid}:model:400")]);
}

/// `recordModelSwitchBoundary`: the boundary goes on the switch anchor once, as a record
/// naming the stored row; the live row follows the anchor's, and a reader folds the record
/// back onto the anchor's `meta.modelSwitches`. A connection cannot write one.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_model_switch_is_recorded_once_on_its_anchor_and_read_back_folded() {
    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let rig = Rig::new();
    rig.set_script(echo());
    let directory = SessionDirectory::new(rig.deps_on(store.clone()));
    let handle = start_thread(&directory).await;
    turn(&handle, "hello", "op-1").await;
    eventually(|| (idle(&handle) && rows(&handle).len() == 2).then_some(())).await;
    let id = handle.id.clone();
    let boundary = json!({ "provider": "openai", "modelId": "gpt-next", "at": 200 });
    assert!(super::record_model_switch(&directory, &id, &boundary).await.expect("record"));
    assert!(super::record_model_switch(&directory, &id, &boundary).await.expect("again"), "recorded once");
    let items = handle.cell.view.load_full().items.clone();
    assert_eq!(items.len(), 3, "the switch row follows the anchor's");
    // The test transcript shows a row under its stored id.
    let anchor_iid = items[1].id().as_str().to_owned();
    assert_eq!(items[2].id().as_str(), format!("{anchor_iid}:model:200"));

    let reopened = SessionDirectory::new(rig.deps_on(store));
    let (_, anchor) = reopened.history_row(&id, &anchor_iid).await.expect("read").expect("anchor row");
    let mixdog_store::schema::blob::Slot::Inline(body) = &anchor.body else { panic!("inline") };
    assert_eq!(body["meta"]["modelSwitches"], json!([boundary]));

    let refused = handle
        .request(request(
            "thread/boundary/record",
            json!({ "threadId": id, "anchor": { "iid": anchor_iid, "ordinal": 1 }, "entry": boundary }),
            "op-x",
        ))
        .await;
    assert!(matches!(refused, Err(CoreError::InvalidParams { .. })), "{refused:?}");
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
async fn a_headless_session_keeps_its_options_and_ingests_no_memory_when_it_closes() {
    let rig = Rig::new();
    rig.set_script(echo());
    let directory = SessionDirectory::new(rig.deps());
    let reply = directory
        .request(request(
            "thread/start",
            json!({
                "opId": "op-start", "kind": "task", "projectPath": "/ws",
                "session": { "toolProfile": "headless", "approvalMode": "implicit", "memory": false },
            }),
            "op-start",
        ))
        .await
        .expect("thread/start");
    let Reply::Subscribe(started) = reply else { panic!("thread/start subscribes") };
    let id = ThreadId::from(started.result["thread"]["id"].as_str().expect("thread id"));
    let handle = directory.handle(&id).expect("loaded");
    let header = handle.cell.header.load_full();
    assert_eq!(header["approvalMode"], "implicit");
    assert_eq!(header["sourceType"], "exec");

    turn(&handle, "hello", "op-1").await;
    eventually(|| idle(&handle).then_some(())).await;
    subscribe(&handle);
    handle.cell.unsubscribed();
    eventually(|| directory.handle(&handle.id).is_none().then_some(())).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(lock(&rig.closes.seen).is_empty(), "memory is off for this session");
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
            RunOutcome::Completed(Default::default())
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
async fn a_value_marked_sensitive_while_a_turn_runs_reingests_its_session_search_copy() {
    let rig = Rig::new();
    let (release, gate) = tokio::sync::watch::channel(false);
    rig.set_script(Arc::new(move |run| {
        let mut gate = gate.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let _ = gate.wait_for(|open| *open).await;
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let fill = json!({
        "name": "browser",
        "arguments": { "action": "fill", "input": { "sensitive": true, "text": "hunter2" } },
    });
    // Outside a turn a mark re-ingests nothing.
    assert!(rig.sensitive.remember(handle.id.as_str(), &[fill.clone()]));
    turn(&handle, "hold", "op-1").await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(lock(&rig.ingests.0).is_empty());

    let again = json!({
        "name": "browser",
        "arguments": { "action": "fill", "input": { "sensitive": true, "text": "s3cret" } },
    });
    assert!(rig.sensitive.remember(handle.id.as_str(), &[again]));
    eventually(|| (lock(&rig.ingests.0).len() == 1).then_some(())).await;
    let (thread, messages) = lock(&rig.ingests.0)[0].clone();
    assert_eq!(thread, handle.id);
    assert_eq!(messages.len(), 1, "the turn's durable input row: {messages:?}");

    release.send(true).expect("release");
    eventually(|| (lock(&rig.ingests.0).len() == 2).then_some(())).await;
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
            RunOutcome::Completed(Default::default())
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
                    prompt: None,
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
                    prompt: None,
                })
                .await
                .expect("result");
            RunOutcome::Completed(Default::default())
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
            RunOutcome::Completed(Default::default())
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

/// `thread/reactions/set`: the reaction is stored on the user's message (an amend of its row), a
/// repeat changes nothing, and the refusals carry Node's text.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reaction_is_stored_on_the_users_message_and_refused_as_node_does() {
    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let rig = Rig::new();
    rig.set_script(Arc::new(|run| {
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            run.port
                .commit_item(ItemCommit {
                    iid: ItemId::from("u1".to_owned()),
                    role: Some("user".into()),
                    model: true,
                    visible: true,
                    body: json!({ "role": "user", "content": "hello", "meta": { "transcript": { "at": 1, "messageId": "m1" } } }),
                    prompt: None,
                })
                .await
                .expect("commit");
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps_on(store.clone()));
    let handle = start_thread(&directory).await;
    turn(&handle, "go", "op-1").await;
    eventually(|| idle(&handle).then_some(())).await;
    let id = handle.id.clone();
    let react = |params: Value| {
        handle.request(CoreRequest {
            method: Method("thread/reactions/set"),
            params,
            op: None,
            ctx: CallContext::internal("test"),
        })
    };
    let value = |reply: Result<Reply, CoreError>| match reply.expect("reply") {
        Reply::Value(value) => value,
        Reply::Subscribe(_) => panic!("a value"),
    };

    let set = value(react(json!({ "agentId": "rev", "emoji": "👍", "messagesBack": 0 })).await);
    assert_eq!((set["changed"].clone(), set["messageId"].clone()), (json!(true), json!("m1")));
    assert_eq!(set["reactions"][0]["emoji"], "👍");
    let again = value(react(json!({ "agentId": "rev", "emoji": "👍" })).await);
    assert_eq!(again["changed"], false, "the same emoji again changes nothing");

    let stored = |directory: SessionDirectory| {
        let id = id.clone();
        async move {
            let (_, row) = directory.history_row(&id, "u1").await.expect("read").expect("row");
            let mixdog_store::schema::blob::Slot::Inline(body) = row.body else { panic!("inline") };
            body["meta"]["transcript"].clone()
        }
    };
    let reopened = SessionDirectory::new(rig.deps_on(store.clone()));
    let transcript = stored(reopened).await;
    assert_eq!(transcript["reactions"][0]["agentId"], "rev");
    assert_eq!(transcript["reactions"][0]["emoji"], "👍");

    let domain = |reply: Result<Reply, CoreError>| match reply {
        Err(CoreError::DomainError { message: Some(message), .. }) => message.to_string(),
        other => panic!("a domain error, got {other:?}"),
    };
    let taken = domain(react(json!({ "agentId": "bob", "emoji": "👍", "othersKeep": true })).await);
    assert_eq!(taken, "react: rev already left 👍 on that message");
    let far = domain(react(json!({ "agentId": "rev", "emoji": "🙏", "messagesBack": 3 })).await);
    assert_eq!(far, "react: there are only 1 user messages to react to");

    let removed = value(react(json!({ "agentId": "rev", "emoji": null })).await);
    assert_eq!((removed["changed"].clone(), removed["reactions"].clone()), (json!(true), json!([])));
    let reopened = SessionDirectory::new(rig.deps_on(store));
    assert!(stored(reopened).await.get("reactions").is_none(), "the last removal drops the key");
    let refused = handle
        .request(request("thread/reactions/set", json!({ "agentId": "rev", "emoji": "👍" }), "op-x"))
        .await;
    assert!(matches!(refused, Err(CoreError::InvalidParams { .. }) | Err(CoreError::PermissionDenied { .. })), "{refused:?}");
}

/// The room log (`agent-room-delivery.mjs` `commit`): a post's rows land in the room session
/// without a turn and show at once; a messageId the conversation holds, or the post repeats,
/// is stored once; a session that does not exist is not available, in Node's words.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_room_post_stores_each_message_once_and_shows_it() {
    use super::room_log::RoomLog;
    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(rig.deps_on(store.clone())));
    let handle = start_thread(&directory).await;
    let id = handle.id.clone();
    let log = super::room_log::SessionRoomLog::new(directory.clone());
    let row = |message_id: &str, text: &str| {
        json!({
            "role": "user",
            "content": text,
            "meta": { "source": "room", "room": { "id": "r1", "speaker": "alice" }, "transcript": { "at": 5, "messageId": message_id } },
        })
    };
    let before = rows(&handle).len();
    let added = log.append_rows(id.as_str(), vec![row("m1", "one"), row("m2", "two"), row("m1", "again")]).await.expect("post");
    assert_eq!(added, 2, "a messageId repeated in the post is one row");
    let added = log.append_rows(id.as_str(), vec![row("m2", "two"), row("m3", "three")]).await.expect("post");
    assert_eq!(added, 1, "a messageId the conversation holds is skipped");
    eventually(|| (rows(&handle).len() == before + 3).then_some(())).await;

    let reopened = SessionDirectory::new(rig.deps_on(store));
    let reread = reopened.open_handle(&id, &CallContext::internal("test")).await.expect("open");
    let Reply::Value(value) = reread
        .request(CoreRequest {
            method: Method("thread/messages/read"),
            params: json!({}),
            op: None,
            ctx: CallContext::internal("test"),
        })
        .await
        .expect("messages")
    else {
        panic!("a value")
    };
    let texts: Vec<&str> = value["messages"].as_array().expect("messages").iter().filter_map(|m| m["content"].as_str()).collect();
    assert_eq!(texts, ["one", "two", "three"]);

    let missing = log.append_rows("sess_gone", vec![row("m9", "x")]).await;
    match missing {
        Err(CoreError::DomainError { message: Some(message), .. }) => assert_eq!(message.to_string(), "session sess_gone is not available"),
        other => panic!("{other:?}"),
    }
}