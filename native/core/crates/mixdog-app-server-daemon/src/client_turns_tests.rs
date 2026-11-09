//! A client turn whose clients leave, against the Node recording `fixtures/client-turns` (`record-client-turns.mjs`, `b6f10295a`, exact
//! manifest).
//!
//! Node ran a real `askSession` turn of a room member's session, started by a client (its `onToolApproval` is the client turn's, over
//! the session's own approval queue), with a scripted provider that asks for one tool, then another, that needs approval. The script
//! detaches every client, moves the virtual clock a hundred years, reattaches and answers; the recording is what the user's clients can
//! see (the card, the queue behind it, the outcome of the last card), what Mixy's heartbeat counts as held, and what the model is told.
//!
//! This replays each default-configuration scenario against the composition's own pieces (see `held_runs_tests`): the turn's gate is
//! assembled once, at `start`, with the clients present, as the assembly does at the start of a turn, and the card is the thread's own
//! gate, waiting for the script's answer as the session's queue does.
//!
//! The card is replayed twice: over the stand-in card (every scenario), and, for the scenario that detaches and reattaches, over the real
//! path (`a_card_pending_on_the_real_thread_gate_survives_its_clients`): the thread's own gate is the session actor's `RunPort`, the card
//! is the `item/tool/requestApproval` the actor publishes into the app server's `Outgoing`, the client is a real connection that is
//! dropped while the card is pending (`connection_close.rs`) and reopened, is sent the very pending request (`server.rs:176-180`),
//! and answers it over the wire.
//!
//! Compared with Node, the whole trace but these, which have no counterpart in this layer:
//!  - `patches`: the key names of Node's TUI state store that a step touched. They come only from the two `set(...)` calls that show and
//!    settle a card (`src/tui/session/tool-approval.mjs:108,155`: `{toolApproval, toolApprovalResult}`), so each is a function of the
//!    `card` and `outcome` that are compared; Rust's own publication is the protocol's server request;
//!  - the `args`, `reason` and `timeoutMs` of a card, and `at`, `expired`, `interrupted` of an outcome: the TUI store's presentation
//!    of the ask (`at` is the TUI's own stamp, `expired`/`interrupted` are set only by the turn-abort path at `tool-approval.mjs:200-206` and the opt-in expiry, none
//!    of which the default scenarios reach); the tool's name and the absence of an expiry are compared, and the real-path test
//!    additionally asserts the reattached client is sent the identical request frame;
//!  - the text of an allowed call in `toolMessages`: it is the `read` tool's output, not the approval's; every denial is compared exactly;
//!  - the two scenarios that set `MIXDOG_TOOL_APPROVAL_TIMEOUT_MS`, the opt-in limit (its source says "tests and ops use"): Rust has no such
//!    setting, its cards carry no expiry (`expires_after: None`), which is Node's default; they are asserted to be exactly those two.

use super::*;

const GOLDEN: &str = include_str!("../../../fixtures/client-turns/golden.json");

/// Node's step shape for the card the queue presents, from the ask the card holds.
fn card_json(ask: &ApprovalAsk) -> Value {
    json!({
        "name": ask.tool,
        "args": ask.payload.get("args").cloned().unwrap_or(Value::Null),
        "reason": ask.reason,
        "timeoutMs": ask.expires_after.map(|after| after.as_millis() as u64),
        "expiresAt": Value::Null,
    })
}

/// The state every Node step but `start` carries: the card shown, how many wait behind it, the outcome of the last card.
fn state(scene: &Scene, outcome: &Value) -> Value {
    let waiting = scene.card.waiting.lock().unwrap();
    json!({
        "card": waiting.first().map(|(ask, _)| card_json(ask)),
        "waiting": waiting.len().saturating_sub(1),
        "outcome": outcome,
    })
}

fn merge(mut step: Value, state: Value) -> Value {
    step.as_object_mut().unwrap().extend(state.as_object().unwrap().clone());
    step
}

async fn replay(scenario: &Value) -> Vec<Value> {
    let mut scene = Scene::new(scenario["now"].as_i64().expect("now"));
    scene.card.waits.store(true, Ordering::SeqCst);
    *scene.hook.lock().unwrap() = Some(HookDecision { action: HookAction::Ask, reason: Some("needs approval".into()), name: None, args: None });
    let session = scenario["session"].as_str().expect("the session").to_owned();
    let replies = scenario["replies"].as_array().expect("replies");
    let mut trace = Vec::new();
    let mut gate: Option<Arc<PolicyGate>> = None;
    let mut call: Option<tokio::task::JoinHandle<Value>> = None;
    let mut released = 0;
    let (mut sends, mut turn_done) = (0, false);
    let mut outcome = Value::Null;
    let mut tool_messages: Vec<String> = Vec::new();
    // What the model is told of a settled call: a denial is the text the gate gave, an allowed call is the tool's own output.
    let told = |settled: &Value| settled["denial"].as_str().map_or_else(|| "allowed".to_owned(), str::to_owned);

    for op in scenario["script"].as_array().unwrap() {
        match op["op"].as_str().unwrap() {
            "start" => {
                // A client starts the turn: it is watching the thread, and the gate of the turn is assembled with it present.
                scene.ui_attached.store(true, Ordering::SeqCst);
                gate = Some(scene.gate(&session));
                sends = 1;
                trace.push(json!({ "op": "start", "sends": sends }));
            }
            "detach" | "reattach" => {
                scene.ui_attached.store(op["op"] == "reattach", Ordering::SeqCst);
                trace.push(merge(json!({ "op": op["op"] }), state(&scene, &outcome)));
            }
            "release" => {
                let reply = &replies[released];
                released += 1;
                if let Some(tool) = reply["toolCalls"].get(0) {
                    let gate = gate.clone().expect("a started turn");
                    let (id, name, args) = (tool["id"].as_str().unwrap().to_owned(), tool["name"].as_str().unwrap().to_owned(), tool["arguments"].clone());
                    let mut task = tokio::spawn(async move {
                        let call = GateCall::new(name, args);
                        present(&call, gate.check_call(&id, &call).await)
                    });
                    // The card arrives, or the call settles without one.
                    tokio::select! {
                        settled = &mut task => {
                            tool_messages.push(told(&settled.expect("the call settles")));
                            sends += 1;
                        }
                        arrived = scene.card.arrived.0.acquire() => arrived.expect("the card").forget(),
                        push = scene.waiting.recv() => panic!("{}: the ask of a client turn was held, not shown on the turn's card: {:?}", scenario["name"], push),
                    }
                    if !task.is_finished() {
                        call = Some(task);
                    }
                } else {
                    turn_done = true;
                }
                trace.push(merge(json!({ "op": "release", "sends": sends, "turnDone": turn_done }), state(&scene, &outcome)));
            }
            "facts" => {
                let facts = FactSources { catalog: Arc::new(EmptyCatalog), watches: Arc::new(NoWatches), held: scene.held.clone(), routines: Arc::new(NoRoutines) }
                    .collect(0)
                    .await
                    .expect("the facts");
                trace.push(merge(json!({ "op": "facts", "approvals": facts.approvals }), state(&scene, &outcome)));
            }
            "advance" => {
                let ms = op["ms"].as_u64().unwrap();
                scene.now.fetch_add(ms as i64, Ordering::SeqCst);
                tokio::time::advance(Duration::from_millis(ms)).await;
                trace.push(merge(json!({ "op": "advance", "ms": ms, "now": scene.now.load(Ordering::SeqCst) }), state(&scene, &outcome)));
            }
            "answer" => {
                let decision = &op["decision"];
                let (ask, answer) = scene.card.waiting.lock().unwrap().remove(0);
                let _ = ask;
                let approved = decision["approved"].as_bool().unwrap();
                let device = decision["device"].as_str().unwrap_or_default().to_owned();
                let accepted = answer
                    .send(ApprovalResolution::Decided {
                        decision: ToolApprovalDecision {
                            approved,
                            reason: decision["reason"].as_str().map(str::to_owned),
                            answers: None,
                            reply: None,
                            response: Some(if approved { HumanGateResponse::Approve } else { HumanGateResponse::Deny }),
                            edited_args: None,
                            remember: None,
                            scope: None,
                        },
                        device: device.clone(),
                        connection_kind: ConnectionKind::Desktop,
                        at: scene.now.load(Ordering::SeqCst),
                    })
                    .is_ok();
                let settled = call.take().expect("a call waiting on its card").await.expect("the call settles");
                tool_messages.push(told(&settled));
                sends += 1;
                outcome = json!({ "approved": approved, "device": device, "expired": false, "interrupted": false, "at": scene.now.load(Ordering::SeqCst) });
                trace.push(merge(json!({ "op": "answer", "accepted": accepted }), state(&scene, &outcome)));
            }
            other => panic!("unknown op {other}"),
        }
    }
    trace.push(merge(
        json!({ "op": "end", "answer": replies[released - 1]["content"], "sends": sends, "toolMessages": tool_messages }),
        state(&scene, &outcome),
    ));
    trace
}

/// Node's recorded steps, less what the module comment names: `patches`, and an allowed call's text.
fn recorded(scenario: &Value) -> Vec<Value> {
    scenario["trace"]
        .as_array()
        .unwrap()
        .iter()
        .map(|step| {
            let mut step = step.clone();
            let fields = step.as_object_mut().unwrap();
            fields.remove("patches");
            if let Some(messages) = fields.get_mut("toolMessages") {
                for message in messages.as_array_mut().unwrap() {
                    if !message.as_str().unwrap().starts_with("Error: tool") {
                        *message = "allowed".into();
                    }
                }
            }
            step
        })
        .collect()
}

#[tokio::test(start_paused = true)]
async fn a_client_turn_whose_clients_leave_keeps_its_card_as_node_does() {
    let golden: Value = serde_json::from_str(GOLDEN).expect("golden parses");
    let scenarios = golden["scenarios"].as_array().expect("scenarios");
    assert_eq!(scenarios.len(), 6, "the recorded scenario list");
    let (default, limited): (Vec<&Value>, Vec<&Value>) = scenarios.iter().partition(|s| s["env"].as_object().unwrap().is_empty());
    assert_eq!(limited.len(), 2, "the scenarios with the opt-in limit");
    assert!(limited.iter().all(|s| s["env"] == json!({ "MIXDOG_TOOL_APPROVAL_TIMEOUT_MS": "600000" })));
    for scenario in default {
        assert_eq!(scenario["timers"]["registered"], 0, "Node registers no timer for a card without a limit: {}", scenario["name"]);
        let (got, want) = (replay(scenario).await, recorded(scenario));
        for (index, (g, w)) in got.iter().zip(&want).enumerate() {
            assert_eq!(g, w, "{} step {index}", scenario["name"]);
        }
        assert_eq!(got.len(), want.len(), "{}", scenario["name"]);
    }
}

// ---- the real path: the thread's own gate (`RunPort` over the session actor), the app server's connections and the real directory ----

struct RealCore {
    mock: Arc<mixdog_core_api::mock::MockCore>,
    directory: Arc<mixdog_core_session::session::SessionDirectory>,
}

/// The core of the composition for what this test reads: the real session directory behind `threads()`, the mock for the rest.
impl mixdog_core_api::CoreHandle for RealCore {
    fn threads(&self) -> &dyn mixdog_core_api::ThreadDirectory {
        &*self.directory
    }
    fn app_feed(&self) -> Arc<dyn mixdog_core_api::FeedSource> {
        self.mock.app_feed()
    }
    fn scoped_feed(&self, id: &mixdog_core_api::ids::FeedId) -> Option<Arc<dyn mixdog_core_api::FeedSource>> {
        self.mock.scoped_feed(id)
    }
    fn ops(&self) -> &dyn mixdog_core_api::OpIndex {
        self.mock.ops()
    }
    fn domain_for(&self, method: &str) -> Option<&dyn mixdog_core_api::DomainService> {
        self.mock.domain_for(method)
    }
    fn host_media(&self) -> &dyn mixdog_core_api::HostMediaSink {
        self.mock.host_media()
    }
    fn lifecycle(&self) -> watch::Receiver<mixdog_core_api::CoreState> {
        self.mock.lifecycle()
    }
    fn connection_closed(&self, connection: mixdog_core_api::ids::ConnectionId) {
        self.mock.connection_closed(connection);
    }
    fn connection_opened(&self, connection: mixdog_core_api::ids::ConnectionId, origin: mixdog_protocol::Origin, device: &str, kind: ConnectionKind) {
        self.mock.connection_opened(connection, origin, device, kind);
    }
    fn request_started(&self) -> mixdog_core_api::handle::RequestGuard {
        self.mock.request_started()
    }
}

/// The session's clock, following the script's virtual clock.
struct VirtualClock(Arc<std::sync::atomic::AtomicI64>);

impl mixdog_core_session::session::Clock for VirtualClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

/// The server-request sink the session actor publishes into: the app server's `Outgoing`, counting what the actor published.
struct Published {
    outgoing: Arc<mixdog_app_server::Outgoing>,
    arrived: tokio::sync::Semaphore,
    frames: Mutex<Vec<Value>>,
    /// The `serverRequest/resolved` frames the actor published: the resolution it actually produced.
    resolved_frames: Mutex<Vec<Value>>,
    resolved_arrived: tokio::sync::Semaphore,
}

impl mixdog_core_api::ServerRequestSink for Published {
    fn publish(&self, req: mixdog_core_api::server_request::PendingServerRequest) {
        self.frames.lock().unwrap().push(serde_json::from_slice(&req.frame).expect("a frame"));
        self.outgoing.publish(req);
        self.arrived.add_permits(1);
    }
    fn resolved(&self, id: &mixdog_core_api::ids::ServerRequestId, frame: bytes::Bytes) {
        self.resolved_frames.lock().unwrap().push(serde_json::from_slice(&frame).expect("a frame"));
        self.resolved_arrived.add_permits(1);
        self.outgoing.resolved(id, frame);
    }
    fn response_rejected(&self, to: mixdog_core_api::ids::ConnectionId, error: mixdog_core_api::CoreError) {
        self.outgoing.response_rejected(to, error);
    }
}

async fn connect(server: &mixdog_app_server::AppServer, id: u64, thread: &str) -> Client {
    use mixdog_core_api::mock::MockConnection;
    use mixdog_core_api::mock::MockLimits;

    let wire = Arc::new(MockConnection::new(mixdog_core_api::ids::ConnectionId(id), MockLimits::default()));
    let client = Client::new(server.open(mixdog_core_api::ids::ConnectionId(id), wire.clone()), wire);
    client.request(0, "initialize", json!({ "clientInfo": { "name": "Pixel", "version": env!("CARGO_PKG_VERSION"), "kind": "desktop" }, "capabilities": { "approvalsInbox": false } }));
    client.response(0).await;
    client.request(1, "thread/resume", json!({ "threadId": thread, "window": { "lastItems": 10 } }));
    client.response(1).await;
    client
}

/// Scenario 0 of the recording (the clients leave before the tool is asked; a hundred years pass; a client returns and approves) on the
/// real path: the gate of the turn is the thread's own, a `RunPort` that sends its ask to the session actor, which publishes it to the
/// app server's connections; the clients are real connections of the real server (`ConnectionHandle`, dropped as a transport drops them),
/// and the answer is the client's response frame, routed by the server to the actor (`server.rs` `on_response`).
#[tokio::test(start_paused = true)]
async fn a_card_pending_on_the_real_thread_gate_survives_its_clients() {
    use mixdog_core_api::call::CallContext;
    use mixdog_core_api::call::CoreRequest;
    use mixdog_core_api::ids::Method;
    use mixdog_core_api::ids::OpId;
    use mixdog_core_api::mock::MockCore;
    use mixdog_core_api::mock::MockLimits;
    use mixdog_core_session::session::RunOutcome;
    use mixdog_core_session::session::SessionDirectory;
    use mixdog_core_session::session::approval_surfaces::ThreadApprovalSurfaces;
    use mixdog_core_session::session::testing::Rig;

    let golden: Value = serde_json::from_str(GOLDEN).expect("golden parses");
    let scenario = &golden["scenarios"][0];
    assert_eq!(scenario["env"], json!({}));
    let member = scenario["session"].as_str().expect("the session").to_owned();
    let outgoing = mixdog_app_server::Outgoing::new();
    let rig = Rig::new();
    let published = Arc::new(Published { outgoing: outgoing.clone(), arrived: tokio::sync::Semaphore::new(0), frames: Mutex::default(), resolved_frames: Mutex::default(), resolved_arrived: tokio::sync::Semaphore::new(0) });
    let mut parts = rig.deps_parts(rig.store.clone());
    parts.server_requests = published.clone();
    // Who answered is the composition's own device layer over the registry the transport fills, not the rig's stand-in; and the
    // resolution's time is read from the script's virtual clock, as Node's recorder reads its own.
    let registry = Arc::new(mixdog_remote::registry::DeviceRegistry::default());
    parts.devices = Arc::new(mixdog_core_base::approvals::devices::RegistryDevices::new(registry.clone()));
    let virtual_now = Arc::new(std::sync::atomic::AtomicI64::new(scenario["now"].as_i64().expect("now")));
    parts.clock = Arc::new(VirtualClock(virtual_now.clone()));
    let directory = Arc::new(SessionDirectory::new(Arc::new(parts)));
    let core = Arc::new(RealCore { mock: Arc::new(MockCore::new(&[], MockLimits::default())), directory: directory.clone() });
    let server = mixdog_app_server::AppServer::new(core, outgoing.clone(), Arc::new(|_| Some(mixdog_protocol::Origin::Local)), crate::server::server_config(mixdog_app_protocol::limits::Limits::default(), Default::default()))
        .expect("the default limits are valid");
    let surfaces = Arc::new(ThreadApprovalSurfaces::new(directory.clone(), outgoing.clone()));
    let mut scene = Scene::over(scenario["now"].as_i64().expect("now"), Arc::new(AtomicBool::new(false)), surfaces);
    *scene.hook.lock().unwrap() = Some(HookDecision { action: HookAction::Ask, reason: Some("needs approval".into()), name: None, args: None });

    // The turn: its gate is assembled when the run starts, over the run's own port, and then serves the calls the test sends it.
    let kit = scene.kit();
    let (calls, wanted) = mpsc::unbounded_channel::<(String, GateCall)>();
    let (settled, mut results) = mpsc::unbounded_channel::<Value>();
    let (ready, mut started) = mpsc::unbounded_channel::<()>();
    let wanted = Arc::new(Mutex::new(Some(wanted)));
    rig.set_script(Arc::new(move |run| {
        let (kit, wanted, settled, ready) = (kit.clone(), wanted.clone(), settled.clone(), ready.clone());
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let gate = kit.gate_over(run.thread.as_str(), Arc::new(run.port.clone()));
            let mut wanted = wanted.lock().unwrap().take().expect("one run");
            ready.send(()).expect("the test waits");
            while let Some((id, call)) = wanted.recv().await {
                let outcome = present(&call, gate.check_call(&id, &call).await);
                settled.send(outcome).expect("the test waits");
            }
            RunOutcome::Completed(Default::default())
        })
    }));
    directory.create_with_id(ThreadId::from(member.as_str()), serde_json::Map::new(), json!({})).await.expect("the thread");

    let mut trace = Vec::new();
    let mut client = None;
    let mut sends = 0;
    let mut outcome = Value::Null;
    let mut tool_messages: Vec<String> = Vec::new();
    let mut shown: Option<Value> = None;
    let replies = scenario["replies"].as_array().unwrap();
    let mut released = 0;
    let mut turn_done = false;
    for op in scenario["script"].as_array().unwrap() {
        match op["op"].as_str().unwrap() {
            "start" => {
                client = Some(connect(&server, 1, &member).await);
                let handle = directory.handle(&ThreadId::from(member.as_str())).expect("loaded");
                use mixdog_core_api::ThreadHandle;
                handle
                    .request(CoreRequest { method: Method("turn/start"), params: json!({ "threadId": member, "opId": "op-1", "input": { "prompt": "go" } }), op: Some(OpId::from("op-1")), ctx: CallContext::internal("test") })
                    .await
                    .expect("turn/start");
                started.recv().await.expect("the run started");
                sends = 1;
                trace.push(json!({ "op": "start", "sends": sends }));
            }
            "detach" => {
                // The transport drops the connection: `ConnectionHandle` drops, as on every end path.
                client = None;
                trace.push(json!({ "op": "detach", "card": shown.as_ref().map(real_card), "outcome": outcome }));
            }
            "reattach" => {
                // The returning client is a phone the relay paired as "Pixel", as the recording's answering device is.
                registry.connect_relay(2, "peer-pixel");
                registry.attach_peer("peer-pixel", "cred-pixel", "Pixel", "Safari");
                client = Some(connect(&server, 2, &member).await);
                trace.push(json!({ "op": "reattach", "card": shown.as_ref().map(real_card), "outcome": outcome }));
            }
            "release" => {
                let reply = &replies[released];
                released += 1;
                if let Some(tool) = reply["toolCalls"].get(0) {
                    let call = GateCall::new(tool["name"].as_str().unwrap().to_owned(), tool["arguments"].clone());
                    calls.send((tool["id"].as_str().unwrap().to_owned(), call)).expect("the run waits");
                    tokio::select! {
                        arrived = published.arrived.acquire() => arrived.expect("the card").forget(),
                        outcome = results.recv() => panic!("{}: the call settled without a card: {outcome:?}", scenario["name"]),
                        push = scene.waiting.recv() => panic!("{}: the ask was held, not published to the clients: {push:?}", scenario["name"]),
                    }
                    shown = published.frames.lock().unwrap().last().cloned();
                } else {
                    turn_done = true;
                }
                trace.push(json!({ "op": "release", "sends": sends, "turnDone": turn_done, "card": shown.as_ref().map(real_card), "outcome": outcome }));
            }
            "facts" => {
                let facts = FactSources { catalog: Arc::new(EmptyCatalog), watches: Arc::new(NoWatches), held: scene.held.clone(), routines: Arc::new(NoRoutines) }.collect(0).await.expect("the facts");
                trace.push(json!({ "op": "facts", "approvals": facts.approvals, "card": shown.as_ref().map(real_card), "outcome": outcome }));
            }
            "advance" => {
                let ms = op["ms"].as_u64().unwrap();
                scene.now.fetch_add(ms as i64, Ordering::SeqCst);
                virtual_now.fetch_add(ms as i64, Ordering::SeqCst);
                tokio::time::advance(Duration::from_millis(ms)).await;
                trace.push(json!({ "op": "advance", "ms": ms, "now": scene.now.load(Ordering::SeqCst), "card": shown.as_ref().map(real_card), "outcome": outcome }));
            }
            "answer" => {
                let client = client.as_ref().expect("a client has returned");
                // The card is still there: the reattached connection is sent the very request the actor published.
                // The connection's frames are ordered: once a request sent after the reattach is answered, a pending card it was owed has been sent or never will be.
                client.request(2, "thread/resume", json!({ "threadId": member, "window": { "lastItems": 10 } }));
                client.response(2).await;
                let frame = client.approval_request_seen().expect("the reattached client is sent the pending card");
                assert_eq!(Some(&frame), shown.as_ref(), "{}: the returning client is sent the pending card", scenario["name"]);
                // The whole card the returning client receives is the card Node's queue presented before the answer.
                let answered_at = scenario["trace"].as_array().unwrap().iter().position(|step| step["op"] == "answer").expect("an answer step");
                assert_eq!(real_card(&frame), scenario["trace"][answered_at - 1]["card"], "{}: the redelivered card", scenario["name"]);
                let decision = &op["decision"];
                client.handle.on_message(
                    serde_json::from_value(json!({ "id": frame["id"], "result": { "approved": decision["approved"], "response": if decision["approved"] == true { "approve" } else { "deny" }, "reason": decision["reason"] } })).expect("a response"),
                );
                let settled = results.recv().await.expect("the call settles");
                tool_messages.push(settled["denial"].as_str().map_or_else(|| "allowed".to_owned(), str::to_owned));
                sends += 1;
                // The outcome is the resolution the actor produced for this request, as it published it; the end of the wait is the
                // actor's own signal, and on the paused clock the deadline only fires if the actor never publishes it.
                tokio::time::timeout(Duration::from_secs(1), published.resolved_arrived.acquire()).await.expect("the actor published the resolution").expect("the sink").forget();
                let resolution = published.resolved_frames.lock().unwrap().last().cloned().expect("a resolved frame")["params"]["resolution"].clone();
                outcome = json!({
                    "approved": resolution["decision"]["approved"],
                    "device": resolution["device"],
                    "expired": resolution["kind"] == "timedOut",
                    "interrupted": resolution["kind"] == "interrupted",
                    "at": resolution["at"],
                });
                shown = None;
                trace.push(json!({ "op": "answer", "accepted": resolution["kind"] == "decided", "card": Value::Null, "outcome": outcome }));
            }
            other => panic!("unknown op {other}"),
        }
    }
    trace.push(json!({ "op": "end", "answer": replies[released - 1]["content"], "sends": sends, "toolMessages": tool_messages, "card": Value::Null, "outcome": outcome }));
    drop(calls);
    drop(client);

    // Compared with the recording whole: every step, with the card and outcome the real path produced. Only the recording's `waiting`
    // (how many cards queue behind the shown one in the TUI store) is not a field of a step here; the stand-in replay compares it.
    let want: Vec<Value> = recorded(scenario)
        .into_iter()
        .map(|mut step| {
            step.as_object_mut().unwrap().remove("waiting");
            step
        })
        .collect();
    assert_eq!(trace, want);
}

/// The card of a published request, in the recording's terms, all from the frame the client receives: the tool, its arguments, the
/// reason, and the expiry (`expiresAt`, and its length from `requestedAt`; both null when the card carries none).
fn real_card(frame: &Value) -> Value {
    let params = &frame["params"];
    let timeout = params.get("expiresAt").map_or(Value::Null, |at| json!(at.as_i64().unwrap() - params["requestedAt"].as_i64().unwrap()));
    json!({ "name": params["name"], "args": params["args"], "reason": params["reason"], "timeoutMs": timeout, "expiresAt": params.get("expiresAt").cloned().unwrap_or(Value::Null) })
}
