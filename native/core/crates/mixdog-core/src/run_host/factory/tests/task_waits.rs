use super::*;

/// An eager wait of send 1 settles after send 2 began: a wait with the same call id in send 2 is not suppressed by it, stays
/// open through it, and closes only on its own result.
#[test]
fn an_earlier_sends_late_settlement_neither_suppresses_nor_closes_a_later_wait() {
    let mut waits = TaskWaits::default();
    waits.begin_send();
    let first = waits.generation;
    waits.begin_send();
    assert_eq!(waits.settle("w", first), None);
    assert_eq!(waits.open("w", Some("t".into())), Some(Some("t".into())), "the later send's wait opens");
    assert_eq!(waits.settle("w", first), None);
    assert!(waits.open.contains_key("w"), "a late settlement of the earlier send leaves the wait open");
    assert_eq!(waits.settle("w", waits.generation), Some(Some("t".into())), "its own result closes it");
    assert!(waits.open.is_empty());
}

/// The owner's case with the real run: a response calls two tools, which start as their blocks stream (eager dispatch, so the
/// first's gate answer precedes the step's usage); the first finishes and the second stays blocked. Before the second is
/// released the feed carries the usage, both cards, the first's closed card, and a message the person sent meanwhile.
#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn a_step_with_a_blocked_eager_call_is_published_as_it_happens() {
    let scripted = Arc::new(Scripted {
        id: ProviderId::from("scripted"),
        policy: RetryPolicy::codex_default(),
        keepalive: KeepaliveSchedule::SPEC,
        codec: MockCodec,
        script: Mutex::new(VecDeque::from([
            vec![
                StreamEvent::TextDelta("looking".into()),
                StreamEvent::ToolCallDone(ToolCall { id: "c1".into(), name: "probe".into(), arguments: json!({}), native_type: None }),
                StreamEvent::ToolCallDone(ToolCall { id: "c2".into(), name: "blocker".into(), arguments: json!({}), native_type: None }),
                StreamEvent::Completed { stop: Some(StopReason::ToolUse), pricing_model: None, request_ms: None },
            ],
            vec![StreamEvent::TextDelta("all done".into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }],
        ])),
        requests: Mutex::new(Vec::new()),
        fail_first: std::sync::atomic::AtomicBool::new(false),
    });
    let spec = |name: &str| ToolSpec {
        name: name.into(),
        title: None,
        trigger: None,
        public: true,
        aliases: Vec::new(),
        description: name.into(),
        input_schema: json!({ "type": "object" }),
        annotations: ToolAnnotations { read_only_hint: Some(true), idempotent_hint: Some(true), ..ToolAnnotations::default() },
        parallel_safe: true,
        exclusive_with: Vec::new(),
    };
    let (ran, ran_now) = (Arc::new(std::sync::atomic::AtomicBool::new(false)), Arc::new(tokio::sync::Notify::new()));
    let (blocked, release) = (Arc::new(tokio::sync::Notify::new()), Arc::new(tokio::sync::Notify::new()));
    let rig = Rig::new();
    let workspace = tempfile::tempdir().unwrap();
    let mut deps = rig.deps_parts(rig.store.clone());
    let more: Vec<Arc<dyn Tool>> =
        vec![Arc::new(Probe(spec("probe"), ran.clone(), ran_now.clone())), Arc::new(Blocker(spec("blocker"), blocked.clone(), release.clone()))];
    deps.runs = Arc::new(RunHostFactory::new(
        mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(),
        mixdog_tools::web::NativeSearchUsageSinks::new(),
        Arc::new(Parts { provider: scripted, workspace: workspace.path().to_path_buf(), more, settle: None, effort: None }),
    ));
    let directory = SessionDirectory::new(Arc::new(deps));
    let reply = directory
        .request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start"))
        .await
        .expect("thread/start");
    let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
    let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
    let handle = directory.handle(&id).expect("loaded");
    handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");

    tokio::time::timeout(std::time::Duration::from_secs(30), blocked.notified()).await.expect("the second call started within 30 s");
    // The two calls run side by side: the first is waited for, not assumed to be ahead of the second.
    tokio::time::timeout(std::time::Duration::from_secs(30), ran_now.notified()).await.expect("the first call ran within 30 s");
    assert!(ran.load(std::sync::atomic::Ordering::SeqCst), "the first call ran");
    handle
        .request(request("turn/start", json!({ "threadId": id, "opId": "op-2", "input": { "prompt": "typed while blocked" } }), "op-2"))
        .await
        .expect("the second prompt is taken");
    let frames = || rig.feeds.frames(id.as_str());
    fn card_told(frames: &[(u64, String, Value)], call: &str, closed: bool) -> bool {
        frames.iter().any(|(_, method, params)| {
            method == "item/completed" && params["item"]["run"]["callId"] == call && params["item"]["run"]["completedAt"].is_null() != closed
        })
    }
    let told = || {
        let frames = frames();
        let method = |wanted: &str| frames.iter().any(|(_, method, _)| method == wanted);
        method("thread/tokenUsage/updated")
            && card_told(&frames, "c1", false)
            && card_told(&frames, "c2", false)
            && card_told(&frames, "c1", true)
            && method("thread/queue/changed")
    };
    eventually_on_awaiting(
        || format!("the step shown with its second call blocked: {:?}", frames().iter().map(|(_, method, _)| method.clone()).collect::<Vec<_>>()),
        &[handle.stepped()],
        || told().then_some(()),
    )
    .await;
    assert!(
        !frames().iter().any(|(_, method, params)| method == "item/completed"
            && params["item"]["run"]["callId"] == "c2"
            && !params["item"]["run"]["completedAt"].is_null()),
        "the blocked call's card is not closed"
    );
    release.notify_one();
    eventually_on_awaiting(|| "the turn settled".to_owned(), &[handle.stepped()], || (!handle.turn_busy()).then_some(())).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn a_late_settlement_of_an_earlier_send_before_the_wait_opens_does_not_hide_it() {
    a_held_calls_late_settlement_leaves_a_later_sends_wait_alone(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn a_late_settlement_of_an_earlier_send_after_the_wait_opened_does_not_close_it() {
    a_held_calls_late_settlement_leaves_a_later_sends_wait_alone(true).await;
}

/// A `task wait` that finishes while its response still streams (its early result precedes the batch) sits beside a blocked
/// sibling: the wait is over, so the spinner never shows `task-wait` and no agent counts it open while the sibling runs.
#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn an_early_completed_task_wait_beside_a_blocked_call_is_not_shown_as_open() {
    let (ran, ran_now) = (Arc::new(std::sync::atomic::AtomicBool::new(false)), Arc::new(tokio::sync::Notify::new()));
    let settled = Arc::new(tokio::sync::Notify::new());
    SETTLED_HOOKS.lock().unwrap().push(("early-wait".into(), settled.clone()));
    let scripted = Arc::new(HeldScripted(
        Scripted {
            id: ProviderId::from("scripted"),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new(VecDeque::from([
                vec![
                    StreamEvent::ToolCallDone(ToolCall {
                        id: "early-wait".into(),
                        name: "task".into(),
                        arguments: json!({ "action": "wait" }),
                        native_type: None,
                    }),
                    StreamEvent::ToolCallDone(ToolCall { id: "c2".into(), name: "blocker".into(), arguments: json!({}), native_type: None }),
                    StreamEvent::Completed { stop: Some(StopReason::ToolUse), pricing_model: None, request_ms: None },
                ],
                vec![
                    StreamEvent::TextDelta("all done".into()),
                    StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None },
                ],
            ])),
            requests: Mutex::new(Vec::new()),
            fail_first: std::sync::atomic::AtomicBool::new(false),
        },
        settled,
        0,
    ));
    let spec = |name: &str| ToolSpec {
        name: name.into(),
        title: None,
        trigger: None,
        public: true,
        aliases: Vec::new(),
        description: name.into(),
        input_schema: json!({ "type": "object" }),
        annotations: ToolAnnotations { read_only_hint: Some(true), idempotent_hint: Some(true), ..ToolAnnotations::default() },
        parallel_safe: true,
        exclusive_with: Vec::new(),
    };
    let (blocked, release) = (Arc::new(tokio::sync::Notify::new()), Arc::new(tokio::sync::Notify::new()));
    let rig = Rig::new();
    let workspace = tempfile::tempdir().unwrap();
    let mut deps = rig.deps_parts(rig.store.clone());
    let more: Vec<Arc<dyn Tool>> =
        vec![Arc::new(Probe(spec("task"), ran.clone(), ran_now.clone())), Arc::new(Blocker(spec("blocker"), blocked.clone(), release.clone()))];
    deps.runs = Arc::new(RunHostFactory::new(
        mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(),
        mixdog_tools::web::NativeSearchUsageSinks::new(),
        Arc::new(Parts { provider: scripted, workspace: workspace.path().to_path_buf(), more, settle: None, effort: None }),
    ));
    let directory = SessionDirectory::new(Arc::new(deps));
    let reply = directory
        .request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start"))
        .await
        .expect("thread/start");
    let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
    let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
    let handle = directory.handle(&id).expect("loaded");
    handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");

    tokio::time::timeout(std::time::Duration::from_secs(30), blocked.notified()).await.expect("the second call started within 30 s");
    tokio::time::timeout(std::time::Duration::from_secs(30), ran_now.notified()).await.expect("the wait ran within 30 s");
    assert!(ran.load(std::sync::atomic::Ordering::SeqCst), "the wait ran");
    let frames = || rig.feeds.frames(id.as_str());
    let shown = || {
        frames()
            .iter()
            .any(|(_, method, params)| method == "item/completed" && params["item"]["run"]["callId"] == "c2" && params["item"]["run"]["completedAt"].is_null())
    };
    eventually_on_awaiting(|| "the blocked call's card shown".to_owned(), &[handle.stepped()], || shown().then_some(())).await;
    let waiting = frames().iter().any(|(_, method, params)| method == "thread/runtime/updated" && params["value"]["spinner"]["mode"] == "task-wait");
    assert!(!waiting, "a wait that already ended is not shown as waiting");
    // The agent row's `awaitingTask: "wait"` reads this flag (`job_status_row`, the pool list's `taskWaits`).
    assert!(!directory.worker_live(&id, 0, &NoJobs).task_waiting, "the agent row does not await a wait that already ended");
    release.notify_one();
    eventually_on_awaiting(|| "the turn settled".to_owned(), &[handle.stepped()], || (!handle.turn_busy()).then_some(())).await;
}
