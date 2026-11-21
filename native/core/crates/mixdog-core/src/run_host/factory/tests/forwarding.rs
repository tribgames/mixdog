use super::*;

/// The contract of a row's hand-over ([`row_handover`]): a report's media preparation is held ahead of the response's
/// tool-call row, so the row waits for that report's own preparation and the tool, which waits for the row's hand-over, has
/// not started; once the preparation ends the tool starts and the thread shows the turn in the order the loop produced it.
#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn a_held_forwarding_holds_back_no_tool_and_reorders_nothing_shown() {
    let turn = HeldTurn::start().await;
    turn.a_preparation_is_held().await;
    assert!(!turn.ran.load(std::sync::atomic::Ordering::SeqCst), "the tool waits for the report ahead of its row");
    assert!(turn.shown().iter().all(|name| *name == "text"), "nothing produced after the held report is shown: {:?}", turn.shown());

    turn.rig.compaction.prepare_held.send_replace(false);
    tokio::time::timeout(std::time::Duration::from_secs(30), turn.ran_now.notified()).await.expect("the tool started within 30 s");
    eventually_on_awaiting(|| format!("the answer shown: {:?}", turn.shown()), &[turn.handle.stepped()], || turn.shown().contains(&"answer").then_some(()))
        .await;
    assert_eq!(turn.shown(), ["text", "card", "tool started", "result", "answer"], "shown in the order produced");
    // The turn's normal end waits for every preparation it started: none is left running once it settled.
    eventually_on_awaiting(|| "the turn settled".to_owned(), &[turn.handle.stepped()], || (!turn.handle.turn_busy()).then_some(())).await;
    let compaction = &turn.rig.compaction;
    assert_eq!(*compaction.prepare_ended.borrow(), *compaction.prepare_started.borrow(), "no preparation outlives the turn");
}

/// A forwarder that dies (its task dropped mid-report, as a panic unwinds it) while a report's preparation is held, nothing
/// released and nothing cancelled: the preparation it owned ends, the row it held goes at once, a report produced after it
/// died starts no preparation, and a row placed after it died goes at once (its channel gone).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_dead_forwarder_holds_back_no_row_and_leaves_no_preparation() {
    let (port_tx, mut port_rx) = mpsc::unbounded_channel::<RunPort>();
    let (done_tx, done_rx) = tokio::sync::oneshot::channel::<()>();
    let done_rx = Arc::new(Mutex::new(Some(done_rx)));
    let rig = Rig::new();
    rig.set_script(Arc::new(move |run| {
        let (port_tx, done_rx) = (port_tx.clone(), lock(&done_rx).take());
        Box::pin(async move {
            let _ = port_tx.send(run.port.clone());
            if let Some(done) = done_rx {
                let _ = done.await;
            }
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let reply = directory
        .request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start"))
        .await
        .expect("thread/start");
    let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
    let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
    let handle = directory.handle(&id).expect("loaded");
    handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");
    let port = port_rx.recv().await.expect("the run's port");

    let compaction = rig.compaction.clone();
    let started_before = *compaction.prepare_started.borrow();
    compaction.prepare_held.send_replace(true);
    let (shown_tx, shown_rx) = mpsc::unbounded_channel();
    let (jobs_tx, mut jobs_rx) = mpsc::unbounded_channel();
    let jobs = Jobs { observed: Arc::default(), seq: AtomicU64::new(0), tx: jobs_tx, shown: Some(shown_tx.clone()), taken: Mutex::default() };
    // A token nothing fires: only the forwarder's death can end what it owns.
    let forwarder = spawn_forwarder(port.clone(), shown_rx, tokio_util::sync::CancellationToken::new());
    let check = || Shown::Check(mixdog_core_session::session::run::SendCheck { messages: Arc::from(Vec::new()), tools: Vec::new(), reactive: false });
    send_prepared(&shown_tx, &port, check());
    let item = |iid: &str| ItemCommit {
        iid: ItemId::from(iid),
        role: Some("assistant".into()),
        model: true,
        visible: true,
        body: json!({ "content": "x" }),
        prompt: None,
    };
    jobs.row(true, None, item("held"));
    let Some(Job::Commit(_, _, Some(held))) = jobs_rx.recv().await else { panic!("the row with its place") };
    let within = std::time::Duration::from_secs(30);
    let mut started = compaction.prepare_started.subscribe();
    tokio::time::timeout(within, started.wait_for(|started| *started > started_before)).await.expect("the preparation held within 30 s").expect("the counter");

    forwarder.abort();
    assert!(matches!(tokio::time::timeout(within, row_handover(Some(held))).await.expect("the held row goes within 30 s"), Handover::Gone));
    let _ = forwarder.await;
    let mut ended = compaction.prepare_ended.subscribe();
    let all_ended = ended.wait_for(|ended| *ended == *compaction.prepare_started.borrow());
    tokio::time::timeout(within, all_ended).await.expect("the owned preparation ended within 30 s, still held").expect("the counter");
    assert!(*compaction.prepare_held.borrow(), "nothing released the hold");

    let started_after = *compaction.prepare_started.borrow();
    send_prepared(&shown_tx, &port, check());
    tokio::task::yield_now().await;
    assert_eq!(*compaction.prepare_started.borrow(), started_after, "no preparation starts once the forwarding is gone");
    jobs.row(true, None, item("after"));
    let Some(Job::Commit(_, _, Some(after))) = jobs_rx.recv().await else { panic!("the row with its place") };
    assert!(matches!(tokio::time::timeout(within, row_handover(Some(after))).await.expect("the later row goes within 30 s"), Handover::Gone));
    compaction.prepare_held.send_replace(false);
    let _ = done_tx.send(());
}

/// Several media-bearing reports ahead of a row prepare at once: every preparation has started while each is still held
/// (a forwarder that prepared them in turn would have started one), and the row's place is answered only once they are done.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_reports_ahead_of_a_row_prepare_at_once() {
    let (port_tx, mut port_rx) = mpsc::unbounded_channel::<RunPort>();
    let (done_tx, done_rx) = tokio::sync::oneshot::channel::<()>();
    let done_rx = Arc::new(Mutex::new(Some(done_rx)));
    let rig = Rig::new();
    rig.set_script(Arc::new(move |run| {
        let (port_tx, done_rx) = (port_tx.clone(), lock(&done_rx).take());
        Box::pin(async move {
            let _ = port_tx.send(run.port.clone());
            if let Some(done) = done_rx {
                let _ = done.await;
            }
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let reply = directory
        .request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start"))
        .await
        .expect("thread/start");
    let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
    let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
    let handle = directory.handle(&id).expect("loaded");
    handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");
    let port = port_rx.recv().await.expect("the run's port");

    let before = *rig.compaction.prepare_started.borrow();
    rig.compaction.prepare_held.send_replace(true);
    let (shown_tx, shown_rx) = mpsc::unbounded_channel();
    let cancel = tokio_util::sync::CancellationToken::new();
    let forwarder = spawn_forwarder(port.clone(), shown_rx, cancel.clone());
    let check = || Shown::Check(mixdog_core_session::session::run::SendCheck { messages: Arc::from(Vec::new()), tools: Vec::new(), reactive: false });
    for _ in 0..3 {
        send_prepared(&shown_tx, &port, check());
    }
    let (reached, mut place) = tokio::sync::oneshot::channel();
    let _ = shown_tx.send(Shown::Row(reached));
    let mut started = rig.compaction.prepare_started.subscribe();
    tokio::time::timeout(std::time::Duration::from_secs(30), started.wait_for(|started| *started >= before + 3))
        .await
        .expect("three preparations under way within 30 s")
        .expect("the counter");
    assert!(matches!(place.try_recv(), Err(tokio::sync::oneshot::error::TryRecvError::Empty)), "the row waits while the reports ahead prepare");

    rig.compaction.prepare_held.send_replace(false);
    let handed =
        tokio::time::timeout(std::time::Duration::from_secs(30), place).await.expect("the place answered within 30 s").expect("the forwarder reached the row");
    let _ = handed.send(());
    cancel.cancel();
    let _ = forwarder.await;
    let _ = done_tx.send(());
}

/// A turn a provider timeout ended (no retry recovered it, nothing else stopped it) reaps the shells it started
/// since its ask (`armTurnTimeoutOnProviderError`); a turn any other provider error ended keeps them.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_turn_ended_by_a_provider_timeout_reaps_its_shells() {
    let failed_end = |rig: &Rig, id: &ThreadId| {
        rig.store.records(id).into_iter().any(|(_, record)| match record {
            Record::Amend(amend) => match amend.body {
                Slot::Inline(body) => body.pointer("/meta/transcript/completion/status") == Some(&json!("failed")),
                _ => false,
            },
            _ => false,
        })
    };
    for (code, reaped) in [(Some("EPROVIDERTIMEOUT"), true), (None, false)] {
        let mut refusal = ProviderError::new(mixdog_core_api::domain::provider::ErrorKind::InvalidRequest, DeliveryState::NotSent);
        refusal.code = code.map(str::to_owned);
        refusal.message = "provider timed out after 1000ms".to_owned();
        let provider = Arc::new(Refusing {
            id: ProviderId::from("mock"),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            error: refusal,
        });
        let workspace = tempfile::tempdir().unwrap();
        let rig = Rig::new();
        let (reaps, woke) = (Arc::new(Mutex::new(Vec::new())), Arc::new(tokio::sync::Notify::new()));
        let parts = Reaping {
            inner: Parts { provider, workspace: workspace.path().to_path_buf(), more: Vec::new(), settle: None, effort: None },
            reaps: reaps.clone(),
            woke: woke.clone(),
        };
        let mut deps = rig.deps_parts(rig.store.clone());
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
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");
        tokio::time::timeout(Duration::from_secs(60), async {
            while !failed_end(&rig, &id) {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the failed turn records its end");
        let reaps = lock(&reaps).clone();
        if reaped {
            let [(thread, since)] = reaps.as_slice() else { panic!("one reap of the timed-out turn: {reaps:?}") };
            assert_eq!(thread, &id);
            assert!(*since > 0, "the reap starts at the turn's ask");
        } else {
            assert!(reaps.is_empty(), "a turn another error ended keeps its shells: {reaps:?}");
        }
    }
}

/// The account pool's two notices reach the thread once each, as status and as thread state (Node
/// `applyStageChange`), never as transcript rows: on a direct run and on one whose provider answers through the
/// model proxy's wire.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_pools_switching_and_changed_notices_reach_the_thread_once_each() {
    use mixdog_core_api::domain::provider::AccountStage;
    use mixdog_core_domains::domains::ai_admin::model_proxy as proxy;
    let switching = "Quota exhausted — switching to the next account";
    let events = vec![
        StreamEvent::AccountStage(AccountStage::Switching { message: switching.into() }),
        StreamEvent::TextDelta("ok".into()),
        StreamEvent::AccountStage(AccountStage::Changed { provider: "custom-x".into(), account_id: "k2".into(), at: 7 }),
        StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None },
    ];
    let crossed: Vec<StreamEvent> = events
        .iter()
        .map(|event| {
            let wire = serde_json::to_value(proxy::event_out(event)).unwrap();
            match proxy::event_in(serde_json::from_value(wire).unwrap()).unwrap() {
                proxy::Incoming::Event(event) => event,
                other => panic!("{other:?}"),
            }
        })
        .collect();
    for (how, script) in [("direct", events.clone()), ("model proxy", crossed)] {
        let provider = Arc::new(Scripted {
            id: ProviderId::from("custom-x"),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new(VecDeque::from([script])),
            requests: Mutex::new(Vec::new()),
            fail_first: std::sync::atomic::AtomicBool::new(false),
        });
        let workspace = tempfile::tempdir().unwrap();
        let rig = Rig::new();
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
        let frames =
            |method: &str| -> Vec<Value> { rig.feeds.frames(id.as_str()).into_iter().filter(|(_, m, _)| m == method).map(|(_, _, params)| params).collect() };
        eventually_on_awaiting(|| format!("{how}: the turn's end"), &[handle.stepped()], || (!frames("turn/completed").is_empty()).then_some(())).await;
        let stages: Vec<Value> = frames("thread/stage/updated").into_iter().filter(|p| p["stage"] == "reconnecting").collect();
        assert_eq!(stages, [json!({ "threadId": id, "stage": "reconnecting", "detail": { "message": switching } })], "{how}: the switching status, once");
        let changed: Vec<Value> = frames("thread/providerAccount/changed").into_iter().filter(|p| p.to_string().contains("\"custom-x\"")).collect();
        assert_eq!(changed.len(), 1, "{how}: the account change, once: {changed:?}");
        // The PC's account id never leaves the PC (Node's `scalarDetail`); a direct run names it.
        assert_eq!(changed[0].to_string().contains("\"k2\""), how == "direct", "{how}: {changed:?}");
        let rows = serde_json::to_string(&rig.feeds.frames(id.as_str()).into_iter().filter(|(_, m, _)| m.starts_with("item/")).collect::<Vec<_>>()).unwrap();
        assert!(!rows.contains(switching), "{how}: the switching message is not a transcript row");
    }
}
