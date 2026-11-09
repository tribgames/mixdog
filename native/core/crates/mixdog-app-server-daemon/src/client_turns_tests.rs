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
//! Compared with Node, the whole trace but three things, which have no counterpart in this layer:
//!  - `patches`: the key names of Node's TUI state store that a step touched. Each is a function of the `card` and `outcome` that are
//!    compared (a card shown is `toolApproval`, a card answered is `toolApproval` and `toolApprovalResult`); Rust's own publication is the
//!    protocol's server request, covered by the app server's tests;
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
