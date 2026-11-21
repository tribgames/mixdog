use super::*;

/// A prompt fold that moved the prefix owes the stored thinking a rebind (`thinkingRebindPending`, written with the prefix). A
/// turn that fails to assemble after the reconcile leaves the debt in the header, and the turn that follows a reopen pays it: the
/// request it sends carries no thinking the old prefix signed, and the debt is cleared.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_assembly_leaves_the_thinking_rebind_owed_to_the_next_turn_after_a_reopen() {
    const SIGNATURE: &str = "sig-owed";
    let done = |text: &str| {
        vec![StreamEvent::TextDelta(text.into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }]
    };
    let mut first_round = vec![StreamEvent::ThinkingBlocks(json!([{ "type": "thinking", "thinking": "hm", "signature": SIGNATURE }]))];
    first_round.extend(done("one"));
    let (first, third) = (scripted_rounds(vec![first_round]), scripted_rounds(vec![done("three")]));
    let workspace = tempfile::tempdir().unwrap();
    let rig = Rig::new();
    let provider: Arc<dyn ProviderAdapter> = first.clone();
    let directory = restartable_failing(&rig, &provider, workspace.path(), false);
    let reply = directory
        .request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start"))
        .await
        .expect("thread/start");
    let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
    let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
    let handle = directory.handle(&id).expect("loaded");
    handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");
    eventually_on_awaiting(|| "the end record of the first turn".to_owned(), &[handle.stepped()], || (ended_runs(&rig, &id) > 0).then_some(())).await;
    // The fold's write: the prefix moved and the rebind is owed, in one header change.
    let owed = json!({ "threadId": id, "set": { "thinkingRebindPending": true }, "unset": [] });
    handle
        .request(CoreRequest { method: Method("thread/header/patch"), params: owed, op: None, ctx: CallContext::internal("test") })
        .await
        .expect("the owed rebind");
    drop(handle);
    drop(directory);

    // The next turn fails after its reconcile, before its rows are written.
    let failing = restartable_failing(&rig, &provider, workspace.path(), true);
    let handle = failing.open_handle(&id, &CallContext::internal("test")).await.expect("reopen");
    handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-2", "input": { "prompt": "again" } }), "op-2")).await.expect("turn/start");
    eventually_on_awaiting(|| "the failed turn's end".to_owned(), &[handle.stepped()], || (ended_runs(&rig, &id) > 1 && !handle.turn_busy()).then_some(()))
        .await;
    assert_eq!(handle.live_header().header().get("thinkingRebindPending"), Some(&Value::Bool(true)), "the debt outlives the failed turn");
    drop(handle);
    drop(failing);

    // A process that opens the files honours it: the request carries no signed thinking, and the debt is paid.
    let next: Arc<dyn ProviderAdapter> = third.clone();
    let resumed = restartable_failing(&rig, &next, workspace.path(), false);
    let handle = resumed.open_handle(&id, &CallContext::internal("test")).await.expect("reopen again");
    assert_eq!(handle.live_header().header().get("thinkingRebindPending"), Some(&Value::Bool(true)), "the debt is on disk");
    handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-3", "input": { "prompt": "third" } }), "op-3")).await.expect("turn/start");
    eventually_on_awaiting(
        || "the third turn's end".to_owned(),
        &[handle.stepped()],
        || (!lock(&third.requests).is_empty() && !handle.turn_busy()).then_some(()),
    )
    .await;
    let sent = format!("{:?}", lock(&third.requests)[0].messages);
    assert!(sent.contains("one") && sent.contains("third"), "the history and the new prompt are sent: {sent}");
    assert!(!sent.contains(SIGNATURE), "the thinking the old prefix signed is not replayed: {sent}");
    assert!(handle.live_header().header().get("thinkingRebindPending").is_none(), "the debt is cleared once paid");
}

/// A session resumed by a new process over the same files sends the same request prefix the first process did, then the new
/// turn: nothing before the prompt is rebuilt differently, the answer the first process stored is in it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_resumed_after_a_restart_sends_the_prefix_it_sent_before() {
    let (first, second) = (scripted(&["ok"]), scripted(&["later"]));
    let workspace = tempfile::tempdir().unwrap();
    let rig = Rig::new();
    let provider: Arc<dyn ProviderAdapter> = first.clone();
    let directory = restartable(&rig, &provider, workspace.path());
    let reply = directory
        .request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start"))
        .await
        .expect("thread/start");
    let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
    let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
    let handle = directory.handle(&id).expect("loaded");
    let patch = json!({ "threadId": id, "set": { "promptBase": "rules" }, "unset": [] });
    handle
        .request(CoreRequest { method: Method("thread/header/patch"), params: patch, op: None, ctx: CallContext::internal("test") })
        .await
        .expect("the system prompt");
    handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");
    eventually_on_awaiting(|| "the end record of the first turn".to_owned(), &[handle.stepped()], || (ended_runs(&rig, &id) > 0).then_some(())).await;
    drop(handle);
    drop(directory);
    // A new process: a new directory over what the first one wrote.
    let provider: Arc<dyn ProviderAdapter> = second.clone();
    let resumed = restartable(&rig, &provider, workspace.path());
    let handle = resumed.open_handle(&id, &CallContext::internal("test")).await.expect("the thread reopens from its files");
    handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-2", "input": { "prompt": "again" } }), "op-2")).await.expect("turn/start");
    eventually_on_awaiting(|| "the end record of the second turn".to_owned(), &[handle.stepped()], || (ended_runs(&rig, &id) > 1).then_some(())).await;
    let (before, after) = (lock(&first.requests).clone(), lock(&second.requests).clone());
    let wire = |request: &ModelRequest| request.messages.iter().map(|m| format!("{:?}", m)).collect::<Vec<_>>();
    let (sent_before, sent_after) = (wire(&before[0]), wire(&after[0]));
    assert_eq!(sent_after[..sent_before.len()], sent_before[..], "the prefix is the same");
    assert_eq!(sent_after.len(), sent_before.len() + 2, "then the first answer and the new prompt");
    assert!(sent_after[sent_before.len()].contains("ok") && sent_after[sent_before.len() + 1].contains("again"), "{sent_after:?}");
}

/// What is on disk at each point a crash can fall in a turn: with the request on the wire the prompt and the turn's start are
/// durable and no end is; after the answer the end is.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_prompt_is_durable_before_the_request_leaves_and_the_turns_end_only_after_the_answer() {
    let release = Arc::new(tokio::sync::Notify::new());
    let provider = Arc::new(HeldScripted(Arc::try_unwrap(scripted(&["ok"])).ok().expect("one owner"), release.clone(), 0));
    let workspace = tempfile::tempdir().unwrap();
    let rig = Rig::new();
    let adapter: Arc<dyn ProviderAdapter> = provider.clone();
    let directory = restartable(&rig, &adapter, workspace.path());
    let reply = directory
        .request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start"))
        .await
        .expect("thread/start");
    let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
    let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
    let handle = directory.handle(&id).expect("loaded");
    handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");
    eventually_on_awaiting(|| "the request on the wire".to_owned(), &[handle.stepped()], || (!lock(&provider.0.requests).is_empty()).then_some(())).await;
    let records = rig.store.records(&id);
    let items = records.iter().filter(|(_, record)| matches!(record, Record::Item(_))).count();
    let started =
        records.iter().filter(|(_, record)| matches!(record, Record::Run(run) if matches!(run.phase, mixdog_store::schema::record::RunPhase::Started))).count();
    assert_eq!((items >= 1, started, ended_runs(&rig, &id)), (true, 1, 0), "with the request on the wire: the prompt and the start are on disk, no end");
    release.notify_one();
    eventually_on_awaiting(|| "the end record".to_owned(), &[handle.stepped()], || (ended_runs(&rig, &id) > 0).then_some(())).await;
    let after = rig.store.records(&id).iter().filter(|(_, record)| matches!(record, Record::Item(_))).count();
    assert!(after > items, "the answer was stored with the end of the turn");
}

/// While the store refuses every write from the first request on, the turn goes on through its tool round to the answer: every
/// request is sent, the tool runs and its result reaches the next request, and nothing after the failure is on disk.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_store_that_starts_failing_mid_turn_does_not_stop_the_turn_and_nothing_after_it_reaches_disk() {
    let inner = scripted_rounds(vec![vec![tool_call("c1", "echo"), tool_use()], answer_events("done")]);
    let (rig, workspace) = (Rig::new(), tempfile::tempdir().unwrap());
    let id_cell: Arc<Mutex<Option<ThreadId>>> = Arc::default();
    let on_disk_at_failure = Arc::new(Mutex::new(None));
    let provider = Arc::new(OnFirstSend {
        inner: inner.clone(),
        on_first: Mutex::new(Some({
            let (failing, store, id_cell, seen) = (rig.store.failing.clone(), rig.store.clone(), id_cell.clone(), on_disk_at_failure.clone());
            Box::new(move || {
                let id = lock(&id_cell).clone().expect("the thread is known");
                *lock(&seen) = Some(store.records(&id).iter().filter(|(_, record)| matches!(record, Record::Item(_))).count());
                *lock(&failing) = Some("disk full".into());
            })
        })),
    });
    let adapter: Arc<dyn ProviderAdapter> = provider;
    let directory = restartable(&rig, &adapter, workspace.path());
    let reply = directory
        .request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start"))
        .await
        .expect("thread/start");
    let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
    let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
    *lock(&id_cell) = Some(id.clone());
    let handle = directory.handle(&id).expect("loaded");
    handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");
    eventually_on_awaiting(
        || "the turn carried on to the end".to_owned(),
        &[handle.stepped()],
        || (lock(&inner.requests).len() == 2 && !handle.turn_busy()).then_some(()),
    )
    .await;
    let second = format!("{:?}", lock(&inner.requests)[1].messages);
    assert!(second.contains("echo:"), "the tool ran and its result went on to the next request: {second}");
    assert_eq!(Some(item_rows(&rig, &id)), *lock(&on_disk_at_failure), "no row written after the store began refusing reached disk");
}

/// A process that dies while a tool runs leaves the prompt and the turn's start on disk and no end; the process that opens the
/// files takes the next prompt and sends it after the first one.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_crash_inside_a_tool_run_leaves_the_prompt_and_no_end_and_the_next_process_sends_it_after_that_prompt() {
    let (blocked, release) = (Arc::new(tokio::sync::Notify::new()), Arc::new(tokio::sync::Notify::new()));
    let spec = ToolSpec {
        name: "blocker".into(),
        title: None,
        trigger: None,
        public: true,
        aliases: Vec::new(),
        description: "blocker".into(),
        input_schema: json!({ "type": "object" }),
        annotations: ToolAnnotations { read_only_hint: Some(true), idempotent_hint: Some(true), ..ToolAnnotations::default() },
        parallel_safe: true,
        exclusive_with: Vec::new(),
    };
    let (first, second) = (scripted_rounds(vec![vec![tool_call("c1", "blocker"), tool_use()]]), scripted_rounds(vec![answer_events("later")]));
    let (rig, workspace) = (Rig::new(), tempfile::tempdir().unwrap());
    let provider: Arc<dyn ProviderAdapter> = first.clone();
    let directory = restartable_with(&rig, &provider, workspace.path(), vec![Arc::new(Blocker(spec, blocked.clone(), release.clone()))]);
    let reply = directory
        .request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start"))
        .await
        .expect("thread/start");
    let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
    let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
    let handle = directory.handle(&id).expect("loaded");
    handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");
    tokio::time::timeout(std::time::Duration::from_secs(30), blocked.notified()).await.expect("the tool started within 30 s");
    // The process dies here: the tool never ends, and only the files are what the next process has.
    let started = rig
        .store
        .records(&id)
        .iter()
        .filter(|(_, record)| matches!(record, Record::Run(run) if matches!(run.phase, mixdog_store::schema::record::RunPhase::Started)))
        .count();
    assert_eq!((item_rows(&rig, &id) >= 1, started, ended_runs(&rig, &id)), (true, 1, 0), "the prompt and the start are on disk, no end");
    let next: Arc<dyn ProviderAdapter> = second.clone();
    let resumed = restartable(&rig, &next, workspace.path());
    let handle = resumed.open_handle(&id, &CallContext::internal("test")).await.expect("the thread reopens from its files");
    handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-2", "input": { "prompt": "again" } }), "op-2")).await.expect("turn/start");
    eventually_on_awaiting(
        || "the resumed turn's end".to_owned(),
        &[handle.stepped()],
        || (!lock(&second.requests).is_empty() && !handle.turn_busy()).then_some(()),
    )
    .await;
    let sent = format!("{:?}", lock(&second.requests)[0].messages);
    let (go, again) = (sent.find("go").expect("the first prompt is in the request"), sent.find("again").expect("the new prompt is in the request"));
    assert!(go < again, "the first prompt precedes the new one: {sent}");
    release.notify_one();
}

/// The prefix guard is the actor incarnation's: a thread rewound after its guard was kept, then unloaded at its idle deadline,
/// reopens on no guard, so the next send reaches the provider (it was refused as `Session state changed unexpectedly.` when the
/// guard outlived the actor and the rewrite's lineage was only the old actor's to name).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_send_after_the_idle_unload_of_a_rewound_thread_reaches_the_provider() {
    let done = |text: &str| {
        vec![StreamEvent::TextDelta(text.into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }]
    };
    let provider = Arc::new(Scripted {
        id: ProviderId::from("scripted"),
        policy: RetryPolicy::codex_default(),
        keepalive: KeepaliveSchedule::SPEC,
        codec: MockCodec,
        script: Mutex::new(VecDeque::from([done("one"), done("two"), done("three")])),
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
    let phases = |wanted: mixdog_store::schema::record::RunPhase| {
        rig.store.records(&id).into_iter().filter(|(_, record)| matches!(record, Record::Run(run) if run.phase == wanted)).count()
    };
    for (turns, (op, prompt)) in [("op-1", "go"), ("op-2", "again")].into_iter().enumerate() {
        handle.request(request("turn/start", json!({ "threadId": id, "opId": op, "input": { "prompt": prompt } }), op)).await.expect("turn/start");
        eventually_on_awaiting(
            || format!("the end record of turn {op}"),
            &[handle.stepped()],
            || (phases(mixdog_store::schema::record::RunPhase::Completed) > turns).then_some(()),
        )
        .await;
    }
    // The second turn's prompt leaves the transcript; the first actor's guard still describes the longer history.
    let again = rig
        .store
        .records(&id)
        .into_iter()
        .find_map(|(_, record)| match record {
            Record::Item(item) if matches!(&item.body, Slot::Inline(body) if body["role"] == "user" && body["content"].as_str().is_some_and(|text| text.contains("again"))) => Some(item.iid.as_str().to_owned()),
            _ => None,
        })
        .expect("the second prompt's row");
    handle.request(request("thread/rewind", json!({ "threadId": id, "opId": "op-rewind", "itemId": again }), "op-rewind")).await.expect("thread/rewind");
    // The idle deadline's decision: nothing watches or runs the thread, so it leaves the directory.
    // A release never waits for work under way: the turn's settle may still be finishing as its end record lands, and the
    // thread then stays until its idle clock decides again. The decision is asked again after each step the actor takes.
    loop {
        let mut stepped = Box::pin(handle.stepped().notified());
        stepped.as_mut().enable();
        directory.release(&id).await;
        if directory.handle(&id).is_none() {
            break;
        }
        tokio::time::timeout(std::time::Duration::from_secs(30), stepped).await.expect("the thread became idle within 30 s");
    }
    let reopened = directory.open_handle(&id, &CallContext::internal("test")).await.expect("reopen");
    assert!(!Arc::ptr_eq(&reopened, &handle), "a replacement actor");
    reopened.request(request("turn/start", json!({ "threadId": id, "opId": "op-3", "input": { "prompt": "third" } }), "op-3")).await.expect("turn/start");
    eventually_on_awaiting(
        || "the send after the unload ends".to_owned(),
        &[reopened.stepped()],
        || (phases(mixdog_store::schema::record::RunPhase::Completed) + phases(mixdog_store::schema::record::RunPhase::Failed) >= 3).then_some(()),
    )
    .await;
    assert_eq!(phases(mixdog_store::schema::record::RunPhase::Failed), 0, "no refusal: {:?}", rig.store.records(&id));
    assert_eq!(lock(&provider.requests).len(), 3, "the third send reached the provider");
}

/// A turn is assembled from the header the settings reconcile returns, not the one it started
/// with: a gate that moved since the last turn reaches the request (`await reconcileTurnSettings()`).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_turn_is_assembled_from_the_reconciled_header() {
    let provider = Arc::new(Scripted {
        id: ProviderId::from("scripted"),
        policy: RetryPolicy::codex_default(),
        keepalive: KeepaliveSchedule::SPEC,
        codec: MockCodec,
        script: Mutex::new(VecDeque::from([vec![
            StreamEvent::TextDelta("ok".into()),
            StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None },
        ]])),
        requests: Mutex::new(Vec::new()),
        fail_first: std::sync::atomic::AtomicBool::new(false),
    });
    let workspace = tempfile::tempdir().unwrap();
    let rig = Rig::new();
    let settle = Arc::new(Settle { add: ("featureDeniedTools", json!(["web_search"])), seen: Mutex::default() });
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.runs = Arc::new(RunHostFactory::new(
        mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(),
        mixdog_tools::web::NativeSearchUsageSinks::new(),
        Arc::new(Parts { provider: provider.clone(), workspace: workspace.path().to_path_buf(), more: Vec::new(), settle: Some(settle.clone()), effort: None }),
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
        || "the assistant's answer in the store".to_owned(),
        &[handle.stepped()],
        || {
            let answered = rig
                .store
                .records(&id)
                .into_iter()
                .any(|(_, record)| matches!(record, Record::Item(item) if matches!(&item.body, Slot::Inline(body) if body["role"] == "assistant")));
            answered.then_some(())
        },
    )
    .await;
    let seen = lock(&settle.seen).clone();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0]["featureDeniedTools"], json!(["web_search"]));
}

/// A failed turn's retry removes the stale copy of its prompt from the model context for good
/// (`prepareAskTurn`): the retry's own request and the next turn's both carry the prompt once,
/// while the transcript keeps every row it showed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_retried_prompt_is_in_the_next_turns_model_context_once() {
    let done = |text: &str| {
        vec![StreamEvent::TextDelta(text.into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }]
    };
    let provider = Arc::new(Scripted {
        id: ProviderId::from("scripted"),
        policy: RetryPolicy::codex_default(),
        keepalive: KeepaliveSchedule::SPEC,
        codec: MockCodec,
        script: Mutex::new(VecDeque::from([done("fixed"), done("welcome")])),
        requests: Mutex::new(Vec::new()),
        fail_first: std::sync::atomic::AtomicBool::new(true),
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
    let ended = || {
        rig.store
            .records(&id)
            .into_iter()
            .filter(|(_, record)| matches!(record, Record::Run(run) if matches!(run.phase, mixdog_store::schema::record::RunPhase::Completed | mixdog_store::schema::record::RunPhase::Failed)))
            .count()
    };
    let turn = |input: Value, op: &str, want: usize| {
        let (handle, op, thread) = (handle.clone(), op.to_owned(), id.clone());
        let ended = &ended;
        async move {
            let started = handle.request(request("turn/start", json!({ "threadId": thread, "opId": op, "input": input }), &op)).await.expect("turn/start");
            let Reply::Value(started) = started else { panic!("turn/start answers a value") };
            // The previous turn's run is over once its record is written, but its settlement
            // (the Goal runtime's `turn_settled`) is not: a prompt arriving in between is
            // queued behind it and starts when it is done, with the options it was sent with.
            // Node queues the same way (`drain.mjs` runs the queue only after `runTurn` returns),
            // so both answers are right; the first turn, on an idle thread, can only start.
            let kind = started["kind"].as_str().expect("turn/start names its answer");
            assert!(kind == "queued" && want > 1 || kind == "started", "turn {op}: {started}");
            // Woken by each step of the thread's actor, which is where a run's end is acknowledged after its record is stored.
            eventually_on_awaiting(
                || format!("the end record of run {want} in the store (turn {op})"),
                &[handle.stepped()],
                || (ended() >= want).then_some(()),
            )
            .await;
        }
    };
    turn(json!({ "prompt": "fix it" }), "op-1", 1).await;
    assert!(lock(&provider.requests).is_empty(), "the first attempt was refused");
    turn(json!({ "prompt": "fix it", "options": { "retryFailedTurn": true } }), "op-2", 2).await;
    turn(json!({ "prompt": "thanks" }), "op-3", 3).await;

    let prompts_of = |request: &ModelRequest| request.messages.iter().filter(|m| m.role == Role::User && format!("{:?}", m.content).contains("fix it")).count();
    let requests = lock(&provider.requests).clone();
    assert_eq!(requests.len(), 2, "the retry and the next turn each asked once");
    assert_eq!(prompts_of(&requests[0]), 1, "the retry's request carries the prompt once");
    assert_eq!(prompts_of(&requests[1]), 1, "the next turn's request carries it once, not the failed copy and the retry's");
    assert_eq!(requests[1].messages.iter().map(|m| m.role).collect::<Vec<_>>(), [Role::User, Role::Assistant, Role::User]);
    let transcript_prompts = rig
        .store
        .records(&id)
        .into_iter()
        .filter(|(_, record)| matches!(record, Record::Item(item) if item.visible && matches!(&item.body, Slot::Inline(body) if body["content"] == "fix it")))
        .count();
    assert_eq!(transcript_prompts, 2, "the transcript keeps the failed prompt beside the retry's");
}
