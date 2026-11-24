use super::*;

/// Text, a tool block, more text in one response (`turn-stream.mjs` `closeAssistantSegment`): the text before the block is
/// final when the block starts and the text after it streams under a new item; the committed reply takes both rows' places,
/// one row each, in the order shown (text, card, text), and a reopened thread shows the same rows. Repeated tool progress and
/// an empty delta open no segment of their own.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_text_around_a_tool_block_is_two_segments_live_and_on_reload() {
    use mixdog_core_api::domain::provider::{ItemKind, ProgressKind};
    let scripted = Arc::new(Scripted {
        id: ProviderId::from("scripted"),
        policy: RetryPolicy::codex_default(),
        keepalive: KeepaliveSchedule::SPEC,
        codec: MockCodec,
        script: Mutex::new(VecDeque::from([
            vec![
                StreamEvent::ItemStart { kind: ItemKind::Text, phase: None },
                StreamEvent::TextDelta("before".into()),
                StreamEvent::ItemStart { kind: ItemKind::Tool, phase: None },
                StreamEvent::Progress(ProgressKind::Tool),
                StreamEvent::Progress(ProgressKind::Tool),
                StreamEvent::ToolCallDone(ToolCall { id: "c1".into(), name: "echo".into(), arguments: json!({ "a": 1 }), native_type: None }),
                StreamEvent::TextDelta(String::new()),
                StreamEvent::ItemStart { kind: ItemKind::Text, phase: None },
                StreamEvent::TextDelta("after".into()),
                StreamEvent::Completed { stop: Some(StopReason::ToolUse), pricing_model: None, request_ms: None },
            ],
            vec![StreamEvent::TextDelta("all done".into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }],
        ])),
        requests: Mutex::new(Vec::new()),
        fail_first: std::sync::atomic::AtomicBool::new(false),
    });
    let rig = Rig::new();
    let workspace = tempfile::tempdir().unwrap();
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.transcript = Arc::new(mixdog_core_session::session::testing::RecordTranscript::new());
    deps.runs = Arc::new(RunHostFactory::new(
        mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(),
        mixdog_tools::web::NativeSearchUsageSinks::new(),
        Arc::new(Parts { provider: scripted.clone(), workspace: workspace.path().to_path_buf(), more: Vec::new(), settle: None, effort: None }),
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
    eventually_on_awaiting(
        || "the turn's end".to_owned(),
        &[handle.stepped()],
        || rig.feeds.frames(id.as_str()).iter().any(|(_, method, params)| method == "item/agentMessage/delta" && params["delta"] == "all done").then_some(()),
    )
    .await;
    eventually_on_awaiting(|| "the turn settled".to_owned(), &[handle.stepped()], || (!handle.turn_busy()).then_some(())).await;

    let frames = rig.feeds.frames(id.as_str());
    let delta_item = |text: &str| {
        frames
            .iter()
            .find(|(_, method, params)| method == "item/agentMessage/delta" && params["delta"] == text)
            .map(|(_, _, params)| params["itemId"].as_str().unwrap_or_default().to_owned())
            .expect("the delta")
    };
    let (before, after) = (delta_item("before"), delta_item("after"));
    assert_ne!(before, after, "the text after the tool block is an item of its own");
    let position = |found: &dyn Fn(&str, &Value) -> bool| frames.iter().position(|(_, method, params)| found(method, params)).expect("the frame");
    let before_final = position(&|method, params| method == "item/completed" && params["item"]["id"] == before.as_str() && params["item"]["text"] == "before");
    let after_starts = position(&|method, params| method == "item/agentMessage/delta" && params["delta"] == "after");
    assert!(before_final < after_starts, "the text before the block is final before the text after it streams");
    let started: Vec<&Value> = frames
        .iter()
        .filter(|(_, method, params)| method == "item/started" && params["item"]["type"] == "agentMessage")
        .map(|(_, _, params)| &params["item"]["id"])
        .collect();
    assert_eq!(started.len(), 3, "one item per segment and the answer, none for an empty delta: {started:?}");

    let rows = |items: &[Arc<ThreadItem>]| -> Vec<(String, String)> {
        items
            .iter()
            .filter_map(|item| match item.as_ref() {
                ThreadItem::AgentMessage { id, text: MaybeBlob::Inline(text), .. } => Some((id.as_str().to_owned(), text.clone())),
                ThreadItem::ToolCall { run, .. } => Some(("card".to_owned(), run.call_id.clone().unwrap_or_default())),
                _ => None,
            })
            .collect()
    };
    let live = rows(&handle.view_items());
    let expected = vec![(before.clone(), "before".to_owned()), ("card".to_owned(), "c1".to_owned()), (after.clone(), "after".to_owned())];
    assert_eq!(live[..3], expected[..], "the committed reply's rows, where they were shown: {live:?}");
    directory.shutdown().await;

    let mut deps = rig.deps_parts(rig.store.clone());
    deps.transcript = Arc::new(mixdog_core_session::session::testing::RecordTranscript::new());
    let reopened = SessionDirectory::new(Arc::new(deps));
    let handle = reopened.open_handle(&id, &CallContext::internal("test")).await.expect("reopen");
    eventually_on_awaiting(|| "the reopen".to_owned(), &[handle.stepped()], || handle.recovered().then_some(())).await;
    let restored = rows(&handle.view_items());
    assert_eq!(restored[..3], expected[..], "the reopened rows are the rows shown, no text lost or repeated: {restored:?}");
    reopened.shutdown().await;
}

/// A Stop that hands the prompt back while the turn is still setting up (`abort.mjs` `reclaimInFlightPrompt`, with the
/// runtime's abort ending the turn as stopped): the step that was waiting on a save when the token fired (the first
/// turn's title, "the session's title could not be saved") does not fail the turn. It ends interrupted, its prompt's
/// row is rewound, and no model was asked.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stop_before_the_model_is_asked_ends_the_turn_stopped_and_takes_the_prompt_back() {
    use mixdog_store::schema::record::RunPhase;
    let provider = Arc::new(Scripted {
        id: ProviderId::from("scripted"),
        policy: RetryPolicy::codex_default(),
        keepalive: KeepaliveSchedule::SPEC,
        codec: MockCodec,
        script: Mutex::new(VecDeque::new()),
        requests: Mutex::new(Vec::new()),
        fail_first: std::sync::atomic::AtomicBool::new(false),
    });
    let hooks = Arc::new(HeldPrompt { reached: tokio::sync::Notify::new() });
    let workspace = tempfile::tempdir().unwrap();
    let rig = Rig::new();
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.lifecycle = hooks.clone();
    deps.runs = Arc::new(RunHostFactory::new(
        mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(),
        mixdog_tools::web::NativeSearchUsageSinks::new(),
        Arc::new(Parts { provider: provider.clone(), workspace: workspace.path().to_path_buf(), more: Vec::new(), settle: None, effort: None }),
    ));
    let directory = SessionDirectory::new(Arc::new(deps));
    let reply = directory
        .request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start"))
        .await
        .expect("thread/start");
    let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
    let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
    let handle = directory.handle(&id).expect("loaded");
    let records = || rig.store.records(&id);
    let ended = || {
        records()
            .into_iter()
            .filter_map(|(_, record)| match record {
                Record::Run(run) if matches!(run.phase, RunPhase::Completed | RunPhase::Failed | RunPhase::Interrupted) => Some(format!("{:?}", run.phase)),
                _ => None,
            })
            .collect::<Vec<_>>()
    };

    handle
        .request(request(
            "turn/start",
            json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "give it back", "options": { "clientSubmissionId": "sub-1" } } }),
            "op-1",
        ))
        .await
        .expect("turn/start");
    mixdog_core_session::session::testing::awaiting(|| "the turn to reach its UserPromptSubmit hook".to_owned(), hooks.reached.notified()).await;
    let ctx = CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, mixdog_rt::CancellationToken::new());
    let stopped = handle
        .stop(mixdog_core_api::thread::Stop { turn: None, restore_prompt: Some(true), submission_id: Some("sub-1".to_owned()), ctx })
        .await
        .expect("stop");
    assert_eq!(stopped["restoreText"], json!("give it back"), "the stop hands the prompt back: {stopped}");
    eventually_on_awaiting(|| "the stopped turn's end record".to_owned(), &[handle.stepped()], || (!ended().is_empty()).then_some(())).await;
    assert_eq!(ended(), ["Interrupted"], "a stop during the setup is a stopped turn, not a failed one");
    assert!(records().iter().any(|(_, record)| matches!(record, Record::Rewind(_))), "the handed-back prompt's row is rewound");
    assert!(lock(&provider.requests).is_empty(), "no model was asked");
    let stored = format!("{:?}", records());
    assert!(!stored.contains("could not be saved"), "no setup step's failure is recorded: {stored}");
}

/// A tool's progress reaches the thread's clients: the run's sink writes the cell's progress,
/// the hint is published as the runtime section while the tool runs, and it is withdrawn when
/// the turn moves on.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_running_tools_output_is_published_to_the_threads_clients_and_withdrawn_after() {
    let provider = Arc::new(Scripted {
        id: ProviderId::from("scripted"),
        policy: RetryPolicy::codex_default(),
        keepalive: KeepaliveSchedule::SPEC,
        codec: MockCodec,
        script: Mutex::new(VecDeque::from([
            vec![
                StreamEvent::ToolCallDone(ToolCall { id: "c1".into(), name: "report".into(), arguments: json!({}), native_type: None }),
                StreamEvent::Completed { stop: Some(StopReason::ToolUse), pricing_model: None, request_ms: None },
            ],
            vec![StreamEvent::TextDelta("ok".into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }],
        ])),
        requests: Mutex::new(Vec::new()),
        fail_first: std::sync::atomic::AtomicBool::new(false),
    });
    let (reported, release) = (Arc::new(tokio::sync::Notify::new()), Arc::new(tokio::sync::Notify::new()));
    let reporter = Reporter {
        spec: ToolSpec {
            name: "report".into(),
            title: None,
            trigger: None,
            public: true,
            aliases: Vec::new(),
            description: "report".into(),
            input_schema: json!({ "type": "object" }),
            annotations: ToolAnnotations { read_only_hint: Some(true), idempotent_hint: Some(true), ..ToolAnnotations::default() },
            parallel_safe: true,
            exclusive_with: Vec::new(),
        },
        reported: reported.clone(),
        release: release.clone(),
    };
    let workspace = tempfile::tempdir().unwrap();
    let rig = Rig::new();
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.runs = Arc::new(RunHostFactory::new(
        mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(),
        mixdog_tools::web::NativeSearchUsageSinks::new(),
        Arc::new(Parts { provider, workspace: workspace.path().to_path_buf(), more: vec![Arc::new(reporter)], settle: None, effort: None }),
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

    let hints = || -> Vec<Value> {
        rig.feeds
            .frames(id.as_str())
            .into_iter()
            .filter(|(_, method, _)| method == "thread/runtime/updated")
            .map(|(_, _, params)| params["value"]["progressHint"].clone())
            .collect()
    };
    mixdog_core_session::session::testing::awaiting(|| "the report tool to be called".to_owned(), reported.notified()).await;
    eventually_on_awaiting(
        || "the tool-output hint with outputTail \"compiling\" published to the thread's clients".to_owned(),
        &[&rig.feeds.published],
        || hints().contains(&json!({ "outputTail": "compiling" })).then_some(()),
    )
    .await;
    release.notify_one();
    eventually_on_awaiting(
        || "the tool-output hint withdrawn (a null hint published last) after the tool ends".to_owned(),
        &[&rig.feeds.published],
        || (hints().last() == Some(&Value::Null)).then_some(()),
    )
    .await;
}

/// One real turn: the session actor starts it, the factory builds the run, the loop asks the
/// scripted provider, the tool runs behind the review gate, and the rows settle in the store.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_turn_runs_from_the_factory_through_the_loop_and_a_tool_to_settle() {
    let provider = Arc::new(Scripted {
        id: ProviderId::from("scripted"),
        policy: RetryPolicy::codex_default(),
        keepalive: KeepaliveSchedule::SPEC,
        codec: MockCodec,
        script: Mutex::new(VecDeque::from([
            vec![
                StreamEvent::TextDelta("looking".into()),
                StreamEvent::ToolCallDone(ToolCall { id: "c1".into(), name: "echo".into(), arguments: json!({ "a": 1 }), native_type: None }),
                StreamEvent::Completed { stop: Some(StopReason::ToolUse), pricing_model: None, request_ms: None },
            ],
            vec![StreamEvent::TextDelta("all done".into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }],
        ])),
        requests: Mutex::new(Vec::new()),
        fail_first: std::sync::atomic::AtomicBool::new(false),
    });
    let workspace = tempfile::tempdir().unwrap();
    let rig = Rig::new();
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.runs = Arc::new(RunHostFactory::new(
        mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(),
        mixdog_tools::web::NativeSearchUsageSinks::new(),
        Arc::new(Parts { provider: provider.clone(), workspace: workspace.path().to_path_buf(), more: Vec::new(), settle: None, effort: None }),
    ));
    let directory = SessionDirectory::new(Arc::new(deps));
    let reply = directory
        .request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start"))
        .await
        .expect("thread/start");
    let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
    let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
    let handle = directory.handle(&id).expect("loaded");
    let started =
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");
    let Reply::Value(started) = started else { panic!("turn/start answers a value") };
    assert_eq!(started["kind"], "started");

    let roles = || -> Vec<(String, Value)> {
        rig.store
            .records(&id)
            .into_iter()
            .filter_map(|(_, record)| match record {
                Record::Item(item) => match item.body {
                    Slot::Inline(body) => Some((body["role"].as_str().unwrap_or_default().to_owned(), body)),
                    _ => None,
                },
                _ => None,
            })
            .collect()
    };
    // Woken by each step of the thread's actor, which acknowledges each row after the store holds it.
    eventually_on_awaiting(
        || "the four-role transcript (user, assistant, tool, assistant) in the store".to_owned(),
        &[handle.stepped()],
        || (roles().len() >= 4).then_some(()),
    )
    .await;
    let rows = roles();
    assert_eq!(rows.iter().map(|(role, _)| role.as_str()).collect::<Vec<_>>(), ["user", "assistant", "tool", "assistant"]);
    assert_eq!(rows[1].1["content"], "looking");
    assert_eq!(rows[1].1["toolCalls"][0]["name"], "echo");
    assert_eq!(rows[2].1["toolCallId"], "c1");
    assert_eq!(rows[2].1["content"], "echo:{\"a\":1}");
    assert_eq!(rows[3].1["content"], "all done");
    let requests = lock(&provider.requests).clone();
    assert_eq!(requests.len(), 2);
    let second: Vec<_> = requests[1].messages.iter().map(|m| m.role).collect();
    assert_eq!(second, [Role::User, Role::Assistant, Role::Tool]);
    let _ = AtomicI64::new(0);
}

/// The text a `todo` call carried and the reply after it are one result: the record keeps it as the turn's `lastHandoff`,
/// which no single row holds.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_record_keeps_the_turns_whole_result_past_its_todo_calls() {
    let provider = Arc::new(Scripted {
        id: ProviderId::from("scripted"),
        policy: RetryPolicy::codex_default(),
        keepalive: KeepaliveSchedule::SPEC,
        codec: MockCodec,
        script: Mutex::new(VecDeque::from([
            vec![
                StreamEvent::TextDelta("Full report.".into()),
                StreamEvent::ToolCallDone(ToolCall { id: "c1".into(), name: "todo".into(), arguments: json!({ "op": "view" }), native_type: None }),
                StreamEvent::Completed { stop: Some(StopReason::ToolUse), pricing_model: None, request_ms: None },
            ],
            vec![
                StreamEvent::TextDelta("Every step is closed.".into()),
                StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None },
            ],
        ])),
        requests: Mutex::new(Vec::new()),
        fail_first: std::sync::atomic::AtomicBool::new(false),
    });
    let workspace = tempfile::tempdir().unwrap();
    let rig = Rig::new();
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.runs = Arc::new(RunHostFactory::new(
        mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(),
        mixdog_tools::web::NativeSearchUsageSinks::new(),
        Arc::new(Parts { provider: provider.clone(), workspace: workspace.path().to_path_buf(), more: Vec::new(), settle: None, effort: None }),
    ));
    let directory = SessionDirectory::new(Arc::new(deps));
    let reply = directory
        .request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start"))
        .await
        .expect("thread/start");
    let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
    let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
    let handle = directory.handle(&id).expect("loaded");
    let started =
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");
    assert!(matches!(started, Reply::Value(_)), "turn/start answers a value");
    let kept =
        eventually_on_awaiting(|| "the turn's result on the record".to_owned(), &[handle.stepped()], || handle.header_snapshot().get("lastHandoff").cloned())
            .await;
    assert_eq!(kept, json!("Full report.\n\nEvery step is closed."));
}

/// The show rule end to end, through the run's own sink (`PortSink`) and the actor: from its first request on the disk
/// takes no write, and still the response's text, its call's card, the tool's start and the tool's result reach the
/// thread's feed, in the order the loop produced them (Node's `onTextDelta`, `onToolCall`, `onToolPhaseStarted`,
/// `onToolResult`), with none of their rows stored. The next request, which the answer after the tool comes from, waits
/// for the tool's row (`crash-tool-wire`); once the disk takes the writes the turn ends with every row, in order.
#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn a_held_disk_holds_back_nothing_the_turn_shows() {
    let scripted = Arc::new(Scripted {
        id: ProviderId::from("scripted"),
        policy: RetryPolicy::codex_default(),
        keepalive: KeepaliveSchedule::SPEC,
        codec: MockCodec,
        script: Mutex::new(VecDeque::from([
            vec![
                StreamEvent::TextDelta("looking".into()),
                StreamEvent::ToolCallDone(ToolCall { id: "c1".into(), name: "echo".into(), arguments: json!({ "a": 1 }), native_type: None }),
                StreamEvent::Completed { stop: Some(StopReason::ToolUse), pricing_model: None, request_ms: None },
            ],
            vec![StreamEvent::TextDelta("all done".into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }],
        ])),
        requests: Mutex::new(Vec::new()),
        fail_first: std::sync::atomic::AtomicBool::new(false),
    });
    let rig = Rig::new();
    // From the first request on, the log takes no write until `go`. The run's draft (the crash checkpoint, written apart
    // from the log) is not held: its write runs on the actor's own thread under the test backend's inline lanes, so a
    // held draft would stop the session itself, which no slow disk does.
    let (arrived, (go, held)) = (Arc::new(tokio::sync::Notify::new()), std::sync::mpsc::channel::<()>());
    let (gate, at_gate) = (rig.store.commit_gate.clone(), arrived.clone());
    let arm: Box<dyn FnOnce() + Send> = Box::new(move || {
        *lock(&gate) = Some((at_gate, held));
    });
    let provider = Arc::new(ArmedOnSend { inner: scripted.clone(), arm: Mutex::new(Some(arm)) });
    let workspace = tempfile::tempdir().unwrap();
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.runs = Arc::new(RunHostFactory::new(
        mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(),
        mixdog_tools::web::NativeSearchUsageSinks::new(),
        Arc::new(Parts { provider, workspace: workspace.path().to_path_buf(), more: Vec::new(), settle: None, effort: None }),
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

    let roles = || -> Vec<String> {
        rig.store
            .records(&id)
            .into_iter()
            .filter_map(|(_, record)| match record {
                Record::Item(item) => match item.body {
                    Slot::Inline(body) => Some(body["role"].as_str().unwrap_or_default().to_owned()),
                    _ => None,
                },
                _ => None,
            })
            .collect()
    };
    // What the feed showed of the turn, each once, in the order it first showed it.
    let shown = || -> Vec<&'static str> {
        let mut out = Vec::new();
        for (_, method, params) in rig.feeds.frames(id.as_str()) {
            let call = params["item"]["run"]["callId"] == "c1";
            let name = match method.as_str() {
                "item/agentMessage/delta" if params["delta"] == "looking" => "text",
                "item/completed" if call && params["item"]["run"]["completedAt"].is_null() => "card",
                "item/completed" if call => "result",
                "thread/toolBatch/updated" if params["phase"] == "started" => "tool started",
                "item/agentMessage/delta" if params["delta"] == "all done" => "answer",
                _ => continue,
            };
            if !out.contains(&name) {
                out.push(name);
            }
        }
        out
    };
    eventually_on_awaiting(
        || format!("the tool's result shown with the disk held: {:?}", shown()),
        &[handle.stepped()],
        || shown().contains(&"result").then_some(()),
    )
    .await;
    assert_eq!(shown(), ["text", "card", "tool started", "result"], "shown as produced, the answer after the tool not yet");
    assert_eq!(roles(), ["user"], "none of the turn's rows is stored");
    assert_eq!(lock(&scripted.requests).len(), 1, "the next request waits for the tool's row");

    go.send(()).expect("the disk waits");
    eventually_on_awaiting(|| "the turn's rows in the store".to_owned(), &[handle.stepped()], || (roles().len() >= 4).then_some(())).await;
    assert_eq!(roles(), ["user", "assistant", "tool", "assistant"]);
    eventually_on_awaiting(|| "the answer shown".to_owned(), &[handle.stepped()], || shown().contains(&"answer").then_some(())).await;
    assert_eq!(shown(), ["text", "card", "tool started", "result", "answer"]);
    drop(arrived);
}

/// A Stop while a report's preparation is held and the response's row waits for its place: the preparation and the
/// forwarder end with the run's cancel, the row goes at once and is saved, the run's flush completes and the run ends.
#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn a_stop_while_a_row_waits_for_its_place_saves_the_row_and_ends_the_run() {
    let turn = HeldTurn::start().await;
    turn.a_preparation_is_held().await;
    let ctx = CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, mixdog_rt::CancellationToken::new());
    turn.handle.stop(mixdog_core_api::thread::Stop { turn: None, restore_prompt: Some(false), submission_id: None, ctx }).await.expect("stop");
    // The hold is never let go: nothing of the stopped run waits for it.
    eventually_on_awaiting(|| format!("the stopped run ended: {:?}", turn.stored()), &[turn.handle.stepped()], || (!turn.handle.turn_busy()).then_some(()))
        .await;
    assert!(
        turn.stored().iter().any(|body| body["role"] == "assistant" && body["toolCalls"][0]["name"] == "probe"),
        "the row that waited for its place is saved: {:?}",
        turn.stored()
    );
    assert!(!turn.ran.load(std::sync::atomic::Ordering::SeqCst), "the stopped tool never started");
}

/// A turn's hooks (`turn-run.mjs` `runTurn`): `UserPromptSubmit` with the prompt as submitted, before the model is asked;
/// the context it adds leads the prompt the model reads (`# Additional context` / `# Task`). A handler's block
/// refuses the turn with Node's message before any request, that turn fires `StopFailure`, and the next turn's request does not carry the refused prompt.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_turn_fires_its_prompt_and_stop_hooks_and_a_blocked_prompt_asks_no_model() {
    use mixdog_core_session::session::lifecycle_hooks::PromptVerdict;
    let done = |text: &str| {
        vec![StreamEvent::TextDelta(text.into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }]
    };
    let provider = Arc::new(Scripted {
        id: ProviderId::from("scripted"),
        policy: RetryPolicy::codex_default(),
        keepalive: KeepaliveSchedule::SPEC,
        codec: MockCodec,
        script: Mutex::new(VecDeque::from([done("ok"), done("later")])),
        requests: Mutex::new(Vec::new()),
        fail_first: std::sync::atomic::AtomicBool::new(false),
    });
    let hooks = Arc::new(TurnHooks::default());
    *lock(&hooks.verdict) = PromptVerdict { blocked: false, reason: None, context: vec!["remember X".to_owned(), " and Y\n".to_owned()] };
    let workspace = tempfile::tempdir().unwrap();
    let rig = Rig::new();
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.lifecycle = hooks.clone();
    deps.runs = Arc::new(RunHostFactory::new(
        mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(),
        mixdog_tools::web::NativeSearchUsageSinks::new(),
        Arc::new(Parts { provider: provider.clone(), workspace: workspace.path().to_path_buf(), more: Vec::new(), settle: None, effort: None }),
    ));
    let directory = SessionDirectory::new(Arc::new(deps));
    let reply = directory
        .request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start"))
        .await
        .expect("thread/start");
    let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
    let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
    let handle = directory.handle(&id).expect("loaded");
    let ended = || {
        rig.store
            .records(&id)
            .into_iter()
            .filter(|(_, record)| matches!(record, Record::Run(run) if matches!(run.phase, mixdog_store::schema::record::RunPhase::Completed | mixdog_store::schema::record::RunPhase::Failed)))
            .count()
    };
    let calls = || lock(&hooks.calls).clone();

    handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");
    eventually_on_awaiting(|| "the first turn's end record".to_owned(), &[handle.stepped()], || (ended() >= 1).then_some(())).await;
    assert_eq!(calls(), ["UserPromptSubmit:/ws:\"go\""]);
    let requests = lock(&provider.requests).clone();
    assert_eq!(requests.len(), 1);
    let asked = format!("{:?}", requests[0].messages.iter().find(|m| m.role == Role::User).expect("the prompt").content);
    // The debug form writes each line break as `\n`. The joined context is trimmed as one text, as Node trims it.
    assert!(asked.contains(r"# Additional context\nremember X\n\n and Y\n\n# Task\ngo"), "the context leads the prompt: {asked}");

    *lock(&hooks.verdict) = PromptVerdict { blocked: true, reason: Some("not now".to_owned()), context: vec!["never read".to_owned()] };
    handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-2", "input": { "prompt": "again" } }), "op-2")).await.expect("turn/start");
    eventually_on_awaiting(
        || "the refused turn's end record and its StopFailure".to_owned(),
        &[handle.stepped()],
        || (ended() >= 2 && calls().len() >= 3).then_some(()),
    )
    .await;
    assert_eq!(calls()[1..], ["UserPromptSubmit:/ws:\"again\"", "StopFailure:unknown"]);
    assert_eq!(lock(&provider.requests).len(), 1, "a blocked prompt asks no model");
    let stored = format!("{:?}", rig.store.records(&id));
    assert!(stored.contains("prompt blocked by hook: not now"), "the turn failed with Node's message");

    *lock(&hooks.verdict) = PromptVerdict::default();
    handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-3", "input": { "prompt": "third" } }), "op-3")).await.expect("turn/start");
    eventually_on_awaiting(|| "the third turn's end record".to_owned(), &[handle.stepped()], || (ended() >= 3).then_some(())).await;
    let requests = lock(&provider.requests).clone();
    let roles: Vec<_> = requests[1].messages.iter().map(|m| m.role).collect();
    assert_eq!(roles, [Role::User, Role::Assistant, Role::User], "the refused prompt is not in the model history");
    // The refusal leaves the rows the provider last saw: no new lineage, so the kept prefix guard still holds
    // (Node's `session.messages` and guard are untouched by it). The first turn's context restart (its hook context joined
    // the prompt) names the lineage the refused turn opens on; none is named after the refused turn started.
    let mut started = 0;
    let mut epochs_after_refusal = 0;
    for (_, record) in rig.store.records(&id) {
        match record {
            Record::Run(run) if matches!(run.phase, mixdog_store::schema::record::RunPhase::Started) => started += 1,
            Record::Meta(meta) if started >= 2 && matches!(&meta.change, Slot::Inline(change) if change.set.contains_key("transcriptEpoch")) => {
                epochs_after_refusal += 1
            }
            _ => {}
        }
    }
    assert_eq!(epochs_after_refusal, 0, "a refused prompt names no new transcript lineage");
}

/// The rewrite keeps one copy of the system prompt but retires the old provider continuation.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_automatic_compaction_sends_a_full_request_without_the_retired_continuation() {
    use mixdog_ai::providers::compat::responses::CompatResponsesCodec;
    use mixdog_ai::providers::compat::{CompatConfig, CompatProfile};
    use mixdog_core_api::domain::keepalive::TransportKind;
    let done = |text: &str| {
        vec![StreamEvent::TextDelta(text.into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }]
    };
    let provider = Arc::new(Scripted {
        id: ProviderId::from("scripted"),
        policy: RetryPolicy::codex_default(),
        keepalive: KeepaliveSchedule::SPEC,
        codec: MockCodec,
        script: Mutex::new(VecDeque::from([done("ok"), done("later")])),
        requests: Mutex::new(Vec::new()),
        fail_first: std::sync::atomic::AtomicBool::new(false),
    });
    let workspace = tempfile::tempdir().unwrap();
    let rig = Rig::new();
    let mut deps = rig.deps_parts(rig.store.clone());
    let parts = Compacting {
        inner: Parts { provider: provider.clone(), workspace: workspace.path().to_path_buf(), more: Vec::new(), settle: None, effort: None },
        compactor: Arc::new(CompactsOnce::default()),
        settings: mixdog_agent::boundary::CompactSettings { auto: true, context_window: Some(1_000), token_calibration: 1.0, ..Default::default() },
    };
    deps.runs = Arc::new(RunHostFactory::new(
        mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(),
        mixdog_tools::web::NativeSearchUsageSinks::new(),
        Arc::new(parts),
    ));
    let directory = SessionDirectory::new(Arc::new(deps));
    let reply = directory
        .request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start"))
        .await
        .expect("thread/start");
    let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
    let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
    let handle = directory.handle(&id).expect("loaded");
    let continuation = json!({ "compatResponses": { "previousResponseId": "resp_retired", "store": true, "seenMessageCount": 1 } });
    let patch = json!({ "threadId": id, "set": { "promptBase": "rules", "providerState": continuation }, "unset": [] });
    handle
        .request(CoreRequest { method: Method("thread/header/patch"), params: patch, op: None, ctx: CallContext::internal("test") })
        .await
        .expect("the system prompt and saved continuation");
    let ended = || {
        rig.store
            .records(&id)
            .into_iter()
            .filter(|(_, record)| matches!(record, Record::Run(run) if matches!(run.phase, mixdog_store::schema::record::RunPhase::Completed | mixdog_store::schema::record::RunPhase::Failed)))
            .count()
    };
    for (turns, (op, prompt)) in [("op-1", "go"), ("op-2", "again")].into_iter().enumerate() {
        handle.request(request("turn/start", json!({ "threadId": id, "opId": op, "input": { "prompt": prompt } }), op)).await.expect("turn/start");
        eventually_on_awaiting(|| format!("the end record of turn {op}"), &[handle.stepped()], || (ended() > turns).then_some(())).await;
    }
    let requests = lock(&provider.requests).clone();
    assert_eq!(requests.len(), 2, "each turn asked the model once");
    let codec = CompatResponsesCodec::new(CompatProfile::command_code_oauth(), CompatConfig::default(), TransportKind::Http1);
    let encode = |request: &ModelRequest| -> Value { serde_json::from_slice(&codec.encode(request).unwrap().body).unwrap() };
    let mut control = requests[0].as_ref().clone();
    control.options.provider_state = Some(serde_json::from_value(continuation).unwrap());
    assert_eq!(encode(&control)["previous_response_id"], "resp_retired", "the stale anchor would otherwise be accepted");
    let first = encode(&requests[0]);
    assert!(first["input"].to_string().contains("[summary]"), "the complete compacted transcript goes on the wire");
    assert!(first.get("previous_response_id").is_none(), "the live loop must not reuse the retired anchor");
    assert!(encode(&requests[1]).get("previous_response_id").is_none(), "a later turn must not reload the retired anchor");
    let system = |at: usize| requests[at].messages.iter().filter(|m| m.role == Role::System).count();
    assert!(format!("{:?}", requests[0].messages).contains("[summary]"), "the first turn's request is the compacted transcript");
    assert!(system(0) > 0, "the header's prompt leads the request");
    assert_eq!(system(1), system(0), "the next turn's request carries the system prompt once");
}

/// [`CompactsOnce`] on the turn whose prompt is `turn-two`: the turns before it are sent their whole history.
#[derive(Default)]
struct CompactsTurnTwo(AtomicBool);

#[async_trait]
impl Compactor for CompactsTurnTwo {
    fn estimate_tokens(&self, messages: &[AgentMessage]) -> u64 {
        let due = !self.0.load(Ordering::SeqCst) && messages.iter().any(|m| m.role() == Role::User && m.text().contains("turn-two"));
        if due { 1_000_000 } else { 10 }
    }

    async fn reduces(&self, _: &CompactRequest<'_>) -> bool {
        !self.0.load(Ordering::SeqCst)
    }

    async fn compact(&self, request: CompactRequest<'_>) -> Result<CompactOutput, CompactError> {
        self.0.store(true, Ordering::SeqCst);
        CompactsOnce::default().compact(request).await
    }
}

/// A turn stopped after its automatic compaction closes on the compacted context: the next turn is sent the summary and
/// none of the history the compaction dropped.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_turn_stopped_after_its_compaction_leaves_the_compacted_context() {
    use mixdog_store::schema::record::RunPhase;
    let stop = |stop: StopReason| StreamEvent::Completed { stop: Some(stop), pricing_model: None, request_ms: None };
    let provider = Arc::new(Scripted {
        id: ProviderId::from("scripted"),
        policy: RetryPolicy::codex_default(),
        keepalive: KeepaliveSchedule::SPEC,
        codec: MockCodec,
        script: Mutex::new(VecDeque::from([
            vec![StreamEvent::TextDelta("first answer".into()), stop(StopReason::EndTurn)],
            vec![
                StreamEvent::ToolCallDone(ToolCall { id: "c1".into(), name: "holder".into(), arguments: json!({}), native_type: None }),
                stop(StopReason::ToolUse),
            ],
            vec![StreamEvent::TextDelta("third answer".into()), stop(StopReason::EndTurn)],
        ])),
        requests: Mutex::new(Vec::new()),
        fail_first: std::sync::atomic::AtomicBool::new(false),
    });
    let spec = ToolSpec {
        name: "holder".into(),
        title: None,
        trigger: None,
        public: true,
        aliases: Vec::new(),
        description: "holder".into(),
        input_schema: json!({ "type": "object" }),
        annotations: ToolAnnotations { read_only_hint: Some(true), idempotent_hint: Some(true), ..ToolAnnotations::default() },
        parallel_safe: true,
        exclusive_with: Vec::new(),
    };
    let (blocked, release) = (Arc::new(tokio::sync::Notify::new()), Arc::new(tokio::sync::Notify::new()));
    let workspace = tempfile::tempdir().unwrap();
    let rig = Rig::new();
    let mut deps = rig.deps_parts(rig.store.clone());
    let parts = Compacting {
        inner: Parts {
            provider: provider.clone(),
            workspace: workspace.path().to_path_buf(),
            more: vec![Arc::new(Blocker(spec, blocked.clone(), release))],
            settle: None,
            effort: None,
        },
        compactor: Arc::new(CompactsTurnTwo::default()),
        settings: mixdog_agent::boundary::CompactSettings { auto: true, context_window: Some(1_000), token_calibration: 1.0, ..Default::default() },
    };
    deps.runs = Arc::new(RunHostFactory::new(
        mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(),
        mixdog_tools::web::NativeSearchUsageSinks::new(),
        Arc::new(parts),
    ));
    let directory = SessionDirectory::new(Arc::new(deps));
    let reply = directory
        .request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start"))
        .await
        .expect("thread/start");
    let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
    let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
    let handle = directory.handle(&id).expect("loaded");
    let completed = || rig.store.records(&id).into_iter().filter(|(_, record)| matches!(record, Record::Run(run) if run.phase == RunPhase::Completed)).count();

    handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "turn-one" } }), "op-1")).await.expect("turn/start");
    eventually_on_awaiting(
        || "the first turn's end".to_owned(),
        &[&rig.store.committed, handle.stepped()],
        || (completed() == 1 && !handle.turn_busy()).then_some(()),
    )
    .await;
    handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-2", "input": { "prompt": "turn-two" } }), "op-2")).await.expect("turn/start");
    mixdog_core_session::session::testing::awaiting(|| "the compacted turn's call".to_owned(), blocked.notified()).await;
    let ctx = CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, mixdog_rt::CancellationToken::new());
    handle.stop(mixdog_core_api::thread::Stop { turn: None, restore_prompt: Some(false), submission_id: None, ctx }).await.expect("stop");
    eventually_on_awaiting(|| "the stopped turn's end".to_owned(), &[handle.stepped()], || (!handle.turn_busy()).then_some(())).await;
    handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-3", "input": { "prompt": "turn-three" } }), "op-3")).await.expect("turn/start");
    eventually_on_awaiting(
        || "the third turn's end".to_owned(),
        &[&rig.store.committed, handle.stepped()],
        || (completed() == 2 && !handle.turn_busy()).then_some(()),
    )
    .await;

    let requests = lock(&provider.requests).clone();
    assert_eq!(requests.len(), 3, "each turn asked the model once");
    assert!(format!("{:?}", requests[1].messages).contains("[summary]"), "the second turn compacted before its request");
    let after = format!("{:?}", requests[2].messages);
    assert!(after.contains("[summary]"), "the stop kept the compaction's summary: {after}");
    assert!(!after.contains("turn-one") && !after.contains("first answer"), "the stop brought back what the compaction dropped: {after}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_large_scanned_pdf_goes_by_reference_before_send_even_with_auto_compaction_off() {
    use super::super::super::assemble::CompactorInput;
    use super::super::super::attachment_store::StoreFiles;
    use super::super::super::compaction_world::{ProcessCompactionWorld, tests::services};
    use super::super::super::compactors::SessionCompactors;
    use super::super::super::host_seams::CompactorSource;
    use super::super::super::media::{AttachmentFacts, StoredFacts};
    use mixdog_agent::boundary::CompactSettings;
    use mixdog_agent::offload::{Artifact, ArtifactStore};
    use mixdog_core_api::domain::provider::ContentPart;
    use mixdog_store::blobs::{BlobStore, digest_of, hex};

    struct ScannedPdf(String);
    #[async_trait]
    impl AttachmentFacts for ScannedPdf {
        async fn facts(&self, reference: &str) -> Option<StoredFacts> {
            (reference == self.0).then_some(StoredFacts { page_count: Some(90), text_pages: Some(0), text_chars: Some(0), ..Default::default() })
        }
    }
    struct NoArchive;
    #[async_trait]
    impl ArtifactStore for NoArchive {
        async fn persist(&self, _: &str) -> Option<Artifact> {
            None
        }
        async fn preview(&self, _: &str) -> Option<Artifact> {
            None
        }
    }

    let workspace = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let blobs = BlobStore::new(workspace.path());
    // Stub the inspector's result; the blob store and named on-disk copy are real.
    let bytes = b"%PDF-1.7\nscan fixture";
    let digest = digest_of(bytes);
    let reference = hex(&digest);
    super::super::super::fixture_fs::write(blobs.path(&digest).as_path(), bytes.to_vec());
    let mut services = services(workspace.path(), json!({}), Arc::default()).await;
    services.attachment_facts = Arc::new(ScannedPdf(reference.to_owned()));
    services.files = Arc::new(StoreFiles::new(blobs, workspace.path(), &tokens));
    let compactors = SessionCompactors::new(Arc::new(ProcessCompactionWorld::new(services)), Arc::new(Fixed));

    for auto in [false, true] {
        let provider = scripted(&["ok"]);
        let rig = Rig::new();
        let mut deps = rig.deps_parts(rig.store.clone());
        // The product's user row keeps the prompt's parts; the rig's text transcript writes a parts prompt as empty text.
        deps.transcript = Arc::new(mixdog_core_session::session::testing::RecordTranscript::new());
        let settings = CompactSettings { auto, context_window: Some(100_000), token_calibration: 1.0, ..Default::default() };
        let id = ThreadId::from("sess_scan");
        let header = json!({ "provider": "scripted", "model": "m" }).as_object().unwrap().clone();
        let input = CompactorInput { settings: settings.clone(), rows: Arc::default(), archive: Arc::new(NoArchive), blobs: Arc::new(NoBlobs) };
        let compactor = compactors.compactor(&id, &header, &[], input).await.expect("a compactor even when auto is off");
        let parts = Compacting {
            inner: Parts { provider: provider.clone(), workspace: workspace.path().to_path_buf(), more: Vec::new(), settle: None, effort: None },
            compactor,
            settings,
        };
        deps.runs = Arc::new(RunHostFactory::new(
            mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(),
            mixdog_tools::web::NativeSearchUsageSinks::new(),
            Arc::new(parts),
        ));
        let directory = SessionDirectory::new(Arc::new(deps));
        directory.create_with_id(id.clone(), header, json!({})).await.expect("the session");
        let handle = directory.open_handle(&id, &CallContext::internal("test")).await.expect("open");
        let prompt = json!([
            { "type": "text", "text": "Review this scan." },
            { "type": "file", "attachmentRef": reference, "filename": "scan.pdf", "mimeType": "application/pdf" }
        ]);
        let started =
            handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": prompt } }), "op-1")).await.expect("turn/start");
        assert!(matches!(started, Reply::Value(_)), "the turn starts");
        eventually_on_awaiting(|| format!("the turn's end record (auto={auto})"), &[handle.stepped()], || (ended_runs(&rig, &id) == 1).then_some(())).await;

        let requests = lock(&provider.requests);
        assert_eq!(requests.len(), 1, "one provider request (auto={auto})");
        // The prompt's message, not a runtime notice sent after it.
        let prompt_of = |message: &&mixdog_core_api::domain::provider::Message| match &message.content {
            Content::Text(text) => text.contains("Review this scan."),
            Content::Parts(parts) => parts.iter().any(|part| matches!(part, ContentPart::Text(text, _) if text.contains("Review this scan."))),
        };
        let user = requests[0].messages.iter().filter(|message| message.role == Role::User).rfind(prompt_of).unwrap_or_else(|| {
            panic!("the user prompt (auto={auto}) in {:?}", requests[0].messages.iter().map(|m| (m.role, format!("{:?}", m.content))).collect::<Vec<_>>())
        });
        let Content::Parts(parts) = &user.content else { panic!("expected prompt and PDF reference (auto={auto})") };
        let copy = workspace.path().join("prompt-attachments").join("files").join(reference).join("scan.pdf");
        assert!(parts.iter().any(|part| matches!(part, ContentPart::Text(text, _) if text.contains("Review this scan."))));
        assert!(
            parts.iter().any(
                |part| matches!(part, ContentPart::Text(text, _) if text.contains("no text layer (scanned pages)") && text.contains(copy.to_str().unwrap()))
            ),
            "the first send points to the scan (auto={auto})"
        );
        assert!(parts.iter().all(|part| matches!(part, ContentPart::Text(..))), "no PDF sent inline (auto={auto})");
        assert_eq!(std::fs::read(copy).unwrap(), bytes);
    }
}
