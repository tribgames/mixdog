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

/// Takes the conversation down to a summary once a tool result is in it: the call that result answered leaves the model context.
#[derive(Default)]
struct CompactsAfterAResult {
    done: AtomicBool,
}

#[async_trait]
impl Compactor for CompactsAfterAResult {
    fn estimate_tokens(&self, _: &[AgentMessage]) -> u64 {
        1_000_000
    }

    async fn reduces(&self, request: &CompactRequest<'_>) -> bool {
        request.messages.iter().any(|m| m.role() == Role::Tool) && !self.done.swap(true, Ordering::SeqCst)
    }

    async fn compact(&self, request: CompactRequest<'_>) -> Result<CompactOutput, CompactError> {
        let mut messages: Vec<AgentMessage> = request.messages.iter().take_while(|m| m.role() == Role::System).cloned().collect();
        messages.push(AgentMessage::user("[summary]"));
        Ok(CompactOutput {
            messages,
            usage: None,
            input_excludes_cache: false,
            dropped_count: 0,
            dropped: None,
            skipped: false,
            pipeline_ms: 0.0,
            summary_ms: None,
            summary_route: None,
        })
    }
}

/// Answers with the round its call names.
struct Quick(ToolSpec);

#[async_trait]
impl Tool for Quick {
    fn spec(&self) -> &ToolSpec {
        &self.0
    }
    async fn call(&self, _ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        Ok(ToolOutput { parts: vec![ToolPart::Text(format!("quick-{}", args["round"]))], ..ToolOutput::default() })
    }
}

/// A read of a state an `edit` call changes: it answers with its run's number and the state it read. Its first run may
/// wait to be let go, and its second waits for the first to end when the first is not held.
struct Peeks {
    spec: ToolSpec,
    edited: Arc<AtomicBool>,
    runs: std::sync::atomic::AtomicUsize,
    /// `Some`: the first run waits for it.
    first_held: Option<Arc<tokio::sync::Notify>>,
    first_ended: tokio::sync::watch::Sender<bool>,
    /// Told as the first run starts: the scripted stream ends only then ([`streamed_behind`]).
    first_started: Arc<tokio::sync::Notify>,
}

#[async_trait]
impl Tool for Peeks {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }
    async fn call(&self, _ctx: &ToolContext, _args: JsonValue) -> ToolOutcome {
        let run = self.runs.fetch_add(1, Ordering::SeqCst) + 1;
        if run == 1 {
            self.first_started.notify_one();
        }
        match (run, &self.first_held) {
            (1, Some(held)) => held.notified().await,
            (1, None) => {}
            (_, Some(_)) => {}
            (_, None) => {
                let _ = self.first_ended.subscribe().wait_for(|ended| *ended).await;
            }
        }
        let read = if self.edited.load(Ordering::SeqCst) { "after" } else { "before" };
        if run == 1 {
            self.first_ended.send_replace(true);
        }
        Ok(ToolOutput { parts: vec![ToolPart::Text(format!("peek-{run}-{read}"))], ..ToolOutput::default() })
    }
}

/// The change [`Peeks`] reads.
struct Edits(ToolSpec, Arc<AtomicBool>);

#[async_trait]
impl Tool for Edits {
    fn spec(&self) -> &ToolSpec {
        &self.0
    }
    async fn call(&self, _ctx: &ToolContext, _args: JsonValue) -> ToolOutcome {
        self.1.store(true, Ordering::SeqCst);
        Ok(ToolOutput { parts: vec![ToolPart::Text("edited".into())], ..ToolOutput::default() })
    }
}

/// The round `e1` edit, `r1` peek, `h1` holder, whose stop waits until `peeks` started its first run: a read starts as it
/// streams only while the stream is open, and one whose stream ended first is run once, in the batch, after the edit.
fn streamed_behind(peeks: &Peeks) -> Arc<dyn ProviderAdapter> {
    let round = scripted_rounds(vec![vec![tool_call("e1", "edit"), tool_call("r1", "peek"), tool_call("h1", "holder"), tool_use()]]);
    let round = Arc::into_inner(round).expect("the round's one owner");
    Arc::new(HeldScripted(round, peeks.first_started.clone(), 0))
}

fn tool_spec(name: &str, read_only: bool) -> ToolSpec {
    ToolSpec {
        name: name.into(),
        title: None,
        trigger: None,
        public: true,
        aliases: Vec::new(),
        description: name.into(),
        input_schema: json!({ "type": "object" }),
        annotations: if read_only {
            ToolAnnotations { read_only_hint: Some(true), idempotent_hint: Some(true), ..ToolAnnotations::default() }
        } else {
            ToolAnnotations::default()
        },
        parallel_safe: true,
        exclusive_with: Vec::new(),
    }
}

/// A read streamed behind an edit runs twice: as it streams, and again once the edit is in. The process dies before the
/// batch's rows are committed (a third call never ends), so the draft is all the next process has of the results. It
/// recovers the read of the call's last run, made after the edit, whichever way the two runs raced: with the first run
/// ended and told before the second (`first_run_first`), or held until the second's result was in the draft and ended
/// only then. The first run's read is recovered in neither.
async fn a_read_run_again_is_recovered_as_its_last_run(first_run_first: bool) {
    let spec = tool_spec;
    let edited = Arc::new(AtomicBool::new(false));
    let first_held = (!first_run_first).then(|| Arc::new(tokio::sync::Notify::new()));
    let peeks = Arc::new(Peeks {
        spec: spec("peek", true),
        edited: edited.clone(),
        runs: std::sync::atomic::AtomicUsize::new(0),
        first_held: first_held.clone(),
        first_ended: tokio::sync::watch::Sender::new(false),
        first_started: Arc::new(tokio::sync::Notify::new()),
    });
    let (blocked, release) = (Arc::new(tokio::sync::Notify::new()), Arc::new(tokio::sync::Notify::new()));
    let more: Vec<Arc<dyn Tool>> =
        vec![Arc::new(Edits(spec("edit", false), edited)), peeks.clone(), Arc::new(Blocker(spec("holder", true), blocked.clone(), release.clone()))];
    let (rig, workspace) = (Rig::new(), tempfile::tempdir().unwrap());
    let provider = streamed_behind(&peeks);
    let directory = restartable_with(&rig, &provider, workspace.path(), more);
    let reply = directory
        .request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start"))
        .await
        .expect("thread/start");
    let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
    let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
    let handle = directory.handle(&id).expect("loaded");
    handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");
    let drafted = || format!("{:?}", rig.store.draft_files(&id));
    eventually_on_awaiting(|| "the second run's read in the draft".to_owned(), &[handle.stepped()], || drafted().contains("peek-2-after").then_some(())).await;
    if let Some(held) = &first_held {
        // The first run ends only now, behind the second's result.
        held.notify_one();
        let mut ended = peeks.first_ended.subscribe();
        tokio::time::timeout(Duration::from_secs(30), ended.wait_for(|ended| *ended)).await.expect("the first run ends within 30 s").expect("the tool lives");
        // Long enough for a result of it to reach the draft, were one written.
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    assert_eq!(peeks.runs.load(Ordering::SeqCst), 2, "the read ran as it streamed and again behind the edit");
    let stored = |rig: &Rig| format!("{:?}", rig.store.records(&id));
    assert!(!stored(&rig).contains("peek-"), "no result is a row yet: the draft is all there is of them");
    let interrupted = |rig: &Rig| {
        rig.store
            .records(&id)
            .iter()
            .any(|(_, record)| matches!(record, Record::Run(run) if matches!(run.phase, mixdog_store::schema::record::RunPhase::Interrupted)))
    };

    // The process dies here: the held call never ends.
    let next: Arc<dyn ProviderAdapter> = scripted_rounds(vec![answer_events("later")]);
    let resumed = restartable(&rig, &next, workspace.path());
    let handle = resumed.open_handle(&id, &CallContext::internal("test")).await.expect("the thread reopens from its files");
    eventually_on_awaiting(|| "the crashed turn's recovery".to_owned(), &[handle.stepped()], || (handle.recovered() && interrupted(&rig)).then_some(())).await;
    let results: Vec<(String, String)> = rig
        .store
        .records(&id)
        .into_iter()
        .filter_map(|(_, record)| match record {
            Record::Item(item) => match item.body {
                Slot::Inline(body) => body.get("toolCallId").and_then(Value::as_str).map(|call| (call.to_owned(), body["content"].to_string())),
                Slot::Blob(_) => None,
            },
            _ => None,
        })
        .collect();
    let read: Vec<&(String, String)> = results.iter().filter(|(call, _)| call == "r1").collect();
    assert_eq!(read.len(), 1, "the read is answered once: {results:?}");
    assert!(read[0].1.contains("peek-2-after"), "by its last run, made after the edit: {results:?}");
    assert!(!results.iter().any(|(_, content)| content.contains("peek-1-")), "the first run's read is recovered for no call: {results:?}");
    release.notify_one();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_read_run_again_behind_an_edit_is_recovered_as_its_last_run_when_its_first_run_ended_first() {
    a_read_run_again_is_recovered_as_its_last_run(true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_read_run_again_behind_an_edit_is_recovered_as_its_last_run_when_its_first_run_ended_last() {
    a_read_run_again_is_recovered_as_its_last_run(false).await;
}

/// The session's surface refuses `edit`.
struct DeniesEdit;

#[async_trait]
impl mixdog_agent::env::ToolGate for DeniesEdit {
    async fn check_call(&self, _call_id: &str, _call: &mixdog_agent::env::GateCall) -> mixdog_agent::env::GateDecision {
        mixdog_agent::env::GateDecision::Allow
    }
    fn pre_dispatch_deny(&self, call: &mixdog_agent::env::GateCall) -> Option<String> {
        (call.name == "edit").then(|| "edit is off on this surface".to_owned())
    }
}

/// [`Parts`] whose turns are judged by [`DeniesEdit`].
struct EditDenied(Parts);

#[async_trait]
impl RunParts for EditDenied {
    async fn reconcile_turn(
        &self,
        thread: &ThreadId,
        header: mixdog_store::schema::record::Header,
        conversation: bool,
    ) -> Result<mixdog_store::schema::record::Header, TurnError> {
        self.0.reconcile_turn(thread, header, conversation).await
    }

    async fn assemble(&self, input: AssembleInput<'_>) -> Result<Assembled, TurnError> {
        let mut assembled = self.0.assemble(input).await?;
        assembled.gate = Box::new(|_| Arc::new(DeniesEdit));
        Ok(assembled)
    }
}

/// A read streamed behind an edit the session's surface refuses is the call's only run: the edit never runs, so the batch
/// takes the read's result as it is and runs nothing again. A third call never ends and the process dies before the
/// batch's rows are committed, so the draft is all the next process has: it recovers the read's result, and does not
/// report a read that completed as cancelled.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_read_behind_an_edit_the_surface_refused_is_recovered_by_its_one_run() {
    let edited = Arc::new(AtomicBool::new(false));
    let peeks = Arc::new(Peeks {
        spec: tool_spec("peek", true),
        edited: edited.clone(),
        runs: std::sync::atomic::AtomicUsize::new(0),
        first_held: None,
        first_ended: tokio::sync::watch::Sender::new(false),
        first_started: Arc::new(tokio::sync::Notify::new()),
    });
    let (blocked, release) = (Arc::new(tokio::sync::Notify::new()), Arc::new(tokio::sync::Notify::new()));
    let more: Vec<Arc<dyn Tool>> = vec![
        Arc::new(Edits(tool_spec("edit", false), edited.clone())),
        peeks.clone(),
        Arc::new(Blocker(tool_spec("holder", true), blocked.clone(), release.clone())),
    ];
    let (rig, workspace) = (Rig::new(), tempfile::tempdir().unwrap());
    let provider = streamed_behind(&peeks);
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.runs = Arc::new(RunHostFactory::new(
        mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(),
        mixdog_tools::web::NativeSearchUsageSinks::new(),
        Arc::new(EditDenied(Parts { provider: provider.clone(), workspace: workspace.path().to_path_buf(), more, settle: None, effort: None })),
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
    let drafted = || format!("{:?}", rig.store.draft_files(&id));
    eventually_on_awaiting(|| "the read's result in the draft".to_owned(), &[handle.stepped()], || drafted().contains("peek-1-before").then_some(())).await;
    // The batch has decided the read by now (its result is in the draft); long enough for a second run to start, were one due.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(peeks.runs.load(Ordering::SeqCst), 1, "the read ran once: nothing changed what it read");
    assert!(!edited.load(Ordering::SeqCst), "the refused edit did not run");
    assert!(!format!("{:?}", rig.store.records(&id)).contains("peek-"), "no result is a row yet: the draft is all there is of them");
    let interrupted = |rig: &Rig| {
        rig.store
            .records(&id)
            .iter()
            .any(|(_, record)| matches!(record, Record::Run(run) if matches!(run.phase, mixdog_store::schema::record::RunPhase::Interrupted)))
    };

    // The process dies here: the held call never ends.
    let next: Arc<dyn ProviderAdapter> = scripted_rounds(vec![answer_events("later")]);
    let resumed = restartable(&rig, &next, workspace.path());
    let handle = resumed.open_handle(&id, &CallContext::internal("test")).await.expect("the thread reopens from its files");
    eventually_on_awaiting(|| "the crashed turn's recovery".to_owned(), &[handle.stepped()], || (handle.recovered() && interrupted(&rig)).then_some(())).await;
    let results: Vec<(String, String)> = rig
        .store
        .records(&id)
        .into_iter()
        .filter_map(|(_, record)| match record {
            Record::Item(item) => match item.body {
                Slot::Inline(body) => body.get("toolCallId").and_then(Value::as_str).map(|call| (call.to_owned(), body["content"].to_string())),
                Slot::Blob(_) => None,
            },
            _ => None,
        })
        .collect();
    let read: Vec<&(String, String)> = results.iter().filter(|(call, _)| call == "r1").collect();
    assert_eq!(read.len(), 1, "the read is answered once: {results:?}");
    assert!(read[0].1.contains("peek-1-before"), "by the result of its one run: {results:?}");
    release.notify_one();
}

/// The text of every draft file under `data`.
fn draft_files(data: &std::path::Path) -> String {
    let mut text = String::new();
    let mut dirs = vec![data.to_path_buf()];
    while let Some(dir) = dirs.pop() {
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                dirs.push(path);
            } else if entry.file_name().to_string_lossy().starts_with("draft-") {
                text.push_str(&std::fs::read_to_string(&path).unwrap_or_default());
            }
        }
    }
    text
}

/// A provider that gives every call the same id, over the real store and the run host's own recovery. The first call's
/// result lands as a row; a compaction inside the turn takes that call out of the model context; the provider names its
/// next call by the same id, beside a call that never ends, and that call's result settles early, so the draft is the one
/// place it is; the process dies. The draft file was only appended to: it holds the first result too. The next process
/// recovers the second result for the second call and nothing for the first: the second call entered the session under
/// an id of its own, so the first result's row in the log answers the first call alone.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_result_drafted_for_a_call_whose_provider_repeated_an_id_is_recovered_for_that_call_over_the_real_store() {
    use mixdog_core_api::domain::mock::MockOwnership;
    use mixdog_core_session::session::StoreThreads;
    use mixdog_store::sqlite::SqliteStore;

    let data = tempfile::tempdir().expect("data dir");
    let tokens = mixdog_rt::testing::tokens();
    let root = data.path().to_path_buf();
    let index = mixdog_rt::LaneToken::submit(tokens.maintenance_io, &mixdog_rt::CancellationToken::new(), move |lane| {
        SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &root)
    })
    .expect("lane")
    .await
    .expect("job ran")
    .expect("index");
    let store: Arc<dyn mixdog_core_session::session::ThreadStore> =
        Arc::new(StoreThreads::over_data_dir(data.path(), index, Arc::new(MockOwnership::default()), tokens.maintenance_io).await.expect("the thread store"));

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
    let tools = || -> Vec<Arc<dyn Tool>> { vec![Arc::new(Blocker(spec("holder"), blocked.clone(), release.clone())), Arc::new(Quick(spec("quick")))] };
    let call = |id: &str, name: &str, round: u32| {
        StreamEvent::ToolCallDone(ToolCall { id: id.into(), name: name.into(), arguments: json!({ "round": round }), native_type: None })
    };
    let first = scripted_rounds(vec![vec![call("c", "quick", 1), tool_use()], vec![call("h", "holder", 2), call("c", "quick", 2), tool_use()]]);
    let (rig, workspace) = (Rig::new(), tempfile::tempdir().unwrap());
    let mut deps = rig.deps_parts(store.clone());
    deps.runs = Arc::new(RunHostFactory::new(
        mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(),
        mixdog_tools::web::NativeSearchUsageSinks::new(),
        Arc::new(Compacting {
            inner: Parts { provider: first.clone(), workspace: workspace.path().to_path_buf(), more: tools(), settle: None, effort: None },
            compactor: Arc::new(CompactsAfterAResult::default()),
            settings: mixdog_agent::boundary::CompactSettings { auto: true, context_window: Some(1_000), token_calibration: 1.0, ..Default::default() },
        }),
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
    tokio::time::timeout(Duration::from_secs(30), blocked.notified()).await.expect("the second round's held call started within 30 s");
    let drafted = tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let files = draft_files(data.path());
            if files.contains("quick-2") {
                break files;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the second result reached the draft file within 30 s");
    assert!(drafted.contains("quick-1"), "the file was only appended to and holds the first result still: {drafted}");
    let second_request = format!("{:?}", lock(&first.requests)[1].messages);
    assert!(second_request.contains("[summary]") && !second_request.contains("quick-1"), "the first call left the model context: {second_request}");

    // The process dies here: the held call never ends, and the files are what the next process has.
    let next = scripted_rounds(vec![answer_events("later")]);
    let mut deps = rig.deps_parts(store);
    deps.runs = Arc::new(RunHostFactory::new(
        mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(),
        mixdog_tools::web::NativeSearchUsageSinks::new(),
        Arc::new(Parts { provider: next.clone(), workspace: workspace.path().to_path_buf(), more: tools(), settle: None, effort: None }),
    ));
    let resumed = SessionDirectory::new(Arc::new(deps));
    let handle = resumed.open_handle(&id, &CallContext::internal("test")).await.expect("the thread reopens from its files");
    eventually_on_awaiting(|| "the crashed turn's recovery".to_owned(), &[handle.stepped()], || handle.recovered().then_some(())).await;
    handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-2", "input": { "prompt": "again" } }), "op-2")).await.expect("turn/start");
    eventually_on_awaiting(
        || "the resumed turn's end".to_owned(),
        &[handle.stepped()],
        || (!lock(&next.requests).is_empty() && !handle.turn_busy()).then_some(()),
    )
    .await;

    let sent = lock(&next.requests)[0].messages.clone();
    let results: Vec<(String, String)> =
        sent.iter().filter(|m| m.role == Role::Tool).map(|m| (m.tool_call_id.clone().unwrap_or_default(), format!("{:?}", m.content))).collect();
    let calls: Vec<String> = sent.iter().flat_map(|m| m.tool_calls.iter().map(|call| call.id.clone())).collect();
    let recovered: Vec<&(String, String)> = results.iter().filter(|(_, content)| content.contains("quick-2")).collect();
    assert_eq!(recovered.len(), 1, "the drafted result is recovered once: {results:?}");
    let again = recovered[0].0.as_str();
    assert_ne!(again, "c", "the second call did not enter under the first call's id: {calls:?}");
    assert_eq!(mixdog_protocol::tool_call_ids::provider_id(again), "c", "and its provider's id is still read from it");
    assert!(calls.iter().any(|call| call == again), "the recovered result answers the second call: {calls:?} {results:?}");
    assert!(!results.iter().any(|(_, content)| content.contains("quick-1")), "the first result is the log's and is not brought back: {results:?}");
    assert_eq!(results.len(), calls.len(), "every call of the crashed turn is answered once, the held one as interrupted: {calls:?} {results:?}");
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
