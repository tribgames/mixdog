//! Turns an agent outside the loop runs: what the shared turn start hands it, and what becomes of a turn that began
//! on its route and never reached it.

use std::cell::RefCell;

use super::*;

thread_local! {
    /// The outside agents the next world of this thread is composed with.
    pub(super) static OUTSIDE: RefCell<Option<Arc<dyn OutsideAgents>>> = const { RefCell::new(None) };
    /// The liveness the next world of this thread is composed with, where a test reads what the pool would.
    pub(super) static LIVENESS: RefCell<Option<Arc<mixdog_services::task_reports::runtime_state::RuntimeLiveness>>> = const { RefCell::new(None) };
}

/// The agent of the route `outside`: it keeps what it is handed, makes `call` of the session's tools and ends the turn.
#[derive(Default)]
struct Agent {
    call: Option<ToolCall>,
    /// Each turn it ran: the header and the input row it was handed.
    turns: Mutex<Vec<(mixdog_store::schema::record::Header, Value)>>,
    /// Woken when it is handed a turn: a wait for that cannot count on the session committing or stepping after it.
    handed: tokio::sync::Notify,
    /// The text of each call's result, and whether it failed.
    results: Mutex<Vec<(String, bool)>>,
    /// Why each turn that never reached it was not run.
    unrun: Mutex<Vec<String>>,
    /// The route of each turn of the loop it was told of.
    loop_turns: Mutex<Vec<String>>,
    /// How many times it gave the change that takes its session out of the header.
    left: Mutex<usize>,
    /// What it says why it cannot run now; `None` for an agent that can.
    refusal: Option<String>,
    /// The refusal is the agent's sign-in not holding.
    signed_out: bool,
    /// The liveness the world is composed with, and the route it held for the thread when each turn was handed over.
    liveness: Option<Arc<mixdog_services::task_reports::runtime_state::RuntimeLiveness>>,
    routes: Mutex<Vec<Option<Value>>>,
    /// What each compaction of the session it made on a prompt `compact` came to.
    compacted: Mutex<Vec<Result<Option<String>, String>>>,
    /// Calls `turn.history.hand_over()` on each turn and records `(hand_over_summarizes, result)`.
    hand_over: bool,
    handed_over: Mutex<Vec<(bool, Result<Option<String>, String>)>>,
    /// It gives nothing and waits for the turn's stop.
    hold: bool,
    /// It ends its turn without a word.
    silent: bool,
    /// The usage it reports for each turn.
    usage: Option<mixdog_core_api::domain::provider::Usage>,
    /// It begins to answer, then goes quiet for hours of this clock.
    stalls: Option<Arc<Moving>>,
    /// Its turn's token fires as it finishes: a stop that lands once the turn is done.
    stopped_as_it_ends: bool,
}

/// The header key the stand-in agent's own session is kept under.
const AGENT_SESSION: &str = "agentSession";

fn provider_of(header: &mixdog_store::schema::record::Header) -> &str {
    header.get("provider").and_then(Value::as_str).unwrap_or_default()
}

#[async_trait]
impl OutsideAgents for Agent {
    fn serves(&self, header: &mixdog_store::schema::record::Header) -> bool {
        provider_of(header) == "outside"
    }

    fn refusal(&self, _: &mixdog_store::schema::record::Header) -> Option<String> {
        self.refusal.clone()
    }

    fn signed_out(&self, _: &mixdog_store::schema::record::Header) -> bool {
        self.signed_out
    }

    fn prompts(&self, _: &Value) -> bool {
        true
    }

    async fn run(&self, turn: OutsideTurn) -> RunOutcome {
        lock(&self.turns).push((turn.header.clone(), turn.input.clone()));
        if let Some(liveness) = &self.liveness {
            lock(&self.routes).push(liveness.request_route(turn.thread.as_str()).map(|route| Value::Object((*route).clone())));
        }
        self.handed.notify_waiters();
        if let Some(clock) = &self.stalls {
            let now = clock.now_ms();
            turn.progress.send_modify(|progress| {
                progress.ask_start(now);
                progress.stream_delta(mixdog_core_run::run_host::progress::StreamKind::Text, now);
            });
            clock.0.fetch_add(3 * 3_600_000, Ordering::SeqCst);
        }
        if self.hold {
            let _ = turn.port.input_durable().await;
            turn.cancel.cancelled().await;
            return RunOutcome::Interrupted;
        }
        // The usage an agent reports for its turn reaches the session as a call's report, and is kept for the turn's end.
        if let Some(usage) = &self.usage {
            let report = mixdog_core_session::session::UsageReport {
                iteration: 1,
                usage: usage.clone(),
                model: "default".to_owned(),
                requested_model: "default".to_owned(),
                delta_tool_calls: 0,
                request_ms: 1_000,
                delta_prompt: 0,
                send_tools: Arc::from(Vec::new()),
                reasoning_tokens: None,
                reasoning_tokens_complete: false,
                outgoing: Arc::from(Vec::new()),
                sent_at_ms: 0,
                input_excludes_cache: false,
                tail_book: None,
            };
            let _ = turn.port.usage(report).await;
            *lock(&turn.report.usage) = Some((usage.clone(), false));
        }
        if self.hand_over {
            let summarizes = turn.history.hand_over_summarizes();
            let handed = turn.history.hand_over().await;
            lock(&self.handed_over).push((summarizes, handed));
        }
        if prompt_text(&turn.input).starts_with("compact") {
            let made = turn.history.compact().await;
            lock(&self.compacted).push(made);
        }
        if let Some(call) = &self.call {
            let handed = turn.calls.call(call.clone()).await;
            lock(&self.results).push((handed.message.text(), handed.failed));
        }
        let _ = turn.port.input_durable().await;
        if self.stopped_as_it_ends {
            turn.cancel.cancel();
        }
        RunOutcome::Completed(Box::new(mixdog_agent::agent_tool::flow::seams::TurnResult {
            content: if self.silent { String::new() } else { "done".into() },
            report_content: None,
            termination: None,
            iterations: 1,
            tool_calls_total: 0,
            stop_reason: None,
        }))
    }

    async fn unrun(&self, _: &ThreadId, why: &str) {
        lock(&self.unrun).push(why.to_owned());
    }

    fn loop_turn(&self, _: &ThreadId, header: &mixdog_store::schema::record::Header) -> Option<mixdog_store::schema::record::HeaderChange> {
        lock(&self.loop_turns).push(provider_of(header).to_owned());
        if !header.contains_key(AGENT_SESSION) {
            return None;
        }
        *lock(&self.left) += 1;
        Some(mixdog_store::schema::record::HeaderChange { set: Default::default(), unset: vec![AGENT_SESSION.to_owned()], patch: Default::default() })
    }
}

/// A world whose route `outside` is `agent`'s, and a session on that route.
async fn on_agents_route(agent: &Arc<Agent>, loop_answers: &[&str], header: Value) -> (World, ThreadId, Arc<mixdog_core_session::session::SessionHandle>) {
    OUTSIDE.with(|slot| *slot.borrow_mut() = Some(agent.clone()));
    // The session's tools are the ones its header names, as a stored session's are: a header that names none has none.
    let surfaces = header.get("tools").is_some();
    let world = turn_world_full(scripted(loop_answers), Arc::new(NoMcp), Vec::new(), false, None, None, Arc::new(MockFileService::default()), surfaces).await;
    let (id, handle) = started_thread(&world, header).await;
    (world, id, handle)
}

async fn start_turn(id: &ThreadId, handle: &Arc<mixdog_core_session::session::SessionHandle>, prompt: &str) {
    let started =
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": prompt } }), "op-1")).await.expect("turn/start");
    assert!(matches!(started, Reply::Value(_)), "turn/start answers a value");
}

async fn until(world: &World, handle: &Arc<mixdog_core_session::session::SessionHandle>, what: &str, reached: impl Fn() -> bool) {
    eventually_on_awaiting(|| what.to_owned(), &[&world.rig.store.committed, handle.stepped()], || (reached() && !handle.turn_busy()).then_some(())).await;
}

/// A turn of a session on an outside agent's route is begun by the loop's own start and handed over where the loop
/// would be entered: the input the agent gets carries the reminders a turn of the loop sends with it, no provider of
/// Mixdog's is asked, and a call the agent makes of the session's tools runs through the turn's own pipeline.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_turn_on_an_outside_agents_route_is_begun_as_the_loops_and_handed_to_the_agent() {
    let call = ToolCall { id: "c1".into(), name: "list".into(), arguments: json!({ "path": "." }), native_type: None };
    let agent = Arc::new(Agent { call: Some(call), ..Agent::default() });
    let (world, id, handle) = on_agents_route(&agent, &[], json!({ "provider": "outside", "model": "default", "tools": [{ "name": "list" }] })).await;

    start_turn(&id, &handle, "what day is it today?").await;
    until(&world, &handle, "the agent's turn", || !lock(&agent.turns).is_empty()).await;

    let (header, input) = lock(&agent.turns)[0].clone();
    assert_eq!(provider_of(&header), "outside");
    let sent = prompt_text(&input);
    assert!(sent.starts_with("what day is it today?"), "{sent}");
    assert!(sent.contains("<system-reminder>\n# Current Time"), "the input carries the turn's reminders: {sent}");
    let results = lock(&agent.results).clone();
    assert_eq!(results.iter().map(|(_, failed)| *failed).collect::<Vec<_>>(), [false], "{results:?}");
    // The call's two approval entry points went where the composition sends a run's approvals, as a call of the loop's do.
    assert_eq!(*lock(&world.asked.0), [id.as_str(), id.as_str()]);
    assert!(lock(&agent.unrun).is_empty() && lock(&agent.loop_turns).is_empty());
    assert!(lock(&world.ledger.0).is_empty(), "no provider of Mixdog's answered the turn");
}

/// A sub-agent's turn on an outside agent's route has the route its header names, as the agents panel reads it, from
/// the moment the agent is handed the turn: the agent makes no model request for the pool to observe one from.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_sub_agents_turn_on_an_outside_route_carries_its_route_while_the_agent_runs_it() {
    let liveness = mixdog_services::task_reports::runtime_state::RuntimeLiveness::new();
    LIVENESS.with(|slot| *slot.borrow_mut() = Some(liveness.clone()));
    let agent = Arc::new(Agent { liveness: Some(liveness), ..Agent::default() });
    let header = json!({ "provider": "outside", "model": "gem", "effort": "high", "owner": "agent" });
    let (world, id, handle) = on_agents_route(&agent, &[], header).await;

    start_turn(&id, &handle, "go").await;
    until(&world, &handle, "the agent's turn", || !lock(&agent.turns).is_empty()).await;

    let route = lock(&agent.routes)[0].clone().expect("the turn's route is published");
    assert_eq!((route["provider"].as_str(), route["model"].as_str(), route["effort"].as_str()), (Some("outside"), Some("gem"), Some("high")));
}

/// The result an outside agent's finished turn gave is what the session keeps as its result for its owner, as a turn of
/// the loop keeps its own: an earlier turn's kept result is not read in its place.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_outside_agents_finished_turn_is_the_result_the_session_keeps_for_its_owner() {
    let agent = Arc::new(Agent::default());
    let header = json!({ "provider": "outside", "model": "default", "owner": "agent", "lastHandoff": "an earlier turn's result" });
    let (world, id, handle) = on_agents_route(&agent, &[], header).await;

    start_turn(&id, &handle, "go").await;
    until(&world, &handle, "the agent's turn", || !lock(&agent.turns).is_empty()).await;

    let header = handle.live_header().header();
    assert_eq!(header["lastHandoff"], "done");
    assert!(header["lastHandoffTurn"].as_str().is_some_and(|turn| !turn.is_empty()), "{header:?}");

    // A turn that committed no text leaves no result, so the owner reads the session's rows.
    let agent = Arc::new(Agent { silent: true, ..Agent::default() });
    let header = json!({ "provider": "outside", "model": "default", "owner": "agent", "lastHandoff": "an earlier turn's result" });
    let (world, id, handle) = on_agents_route(&agent, &[], header).await;
    start_turn(&id, &handle, "go").await;
    until(&world, &handle, "the agent's turn", || !lock(&agent.turns).is_empty()).await;
    let header = handle.live_header().header();
    assert!(!header.contains_key("lastHandoff") && !header.contains_key("lastHandoffTurn"), "{header:?}");
}

/// The asks the world's sessions recorded where the statusline footer reads a route's spend, every one written.
async fn recorded_asks(world: &World) -> Vec<Value> {
    world.gateway.flush_final().await;
    let written = crate::run_host::fixture_fs::read_to_string(world.gateway.store_path()).unwrap_or_default();
    written.lines().filter(|line| !line.trim().is_empty()).map(|line| serde_json::from_str(line).expect("an event")).collect()
}

/// The ask of an outside agent's finished turn is settled as a finished turn of the loop settles its own
/// (`settleAskTurn`): the usage the agent reported for it, which reached the session as a call's report, is counted once
/// in the session's totals, and the ask is recorded where the statusline footer reads a route's spend, over the
/// conversation as the request saw it: the system messages, then the prompt.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_outside_agents_finished_turn_settles_its_ask_with_the_usage_the_agent_reported() {
    let usage = mixdog_core_api::domain::provider::Usage { input_tokens: 1_200, output_tokens: 300, ..Default::default() };
    let agent = Arc::new(Agent { usage: Some(usage), ..Agent::default() });
    let header = json!({ "provider": "outside", "model": "default", "promptBase": "The session's rules." });
    let (world, id, handle) = on_agents_route(&agent, &[], header).await;

    start_turn(&id, &handle, "go").await;
    until(&world, &handle, "the agent's turn", || !lock(&agent.turns).is_empty()).await;

    let header = handle.live_header().header();
    let totals = (header.get("totalInputTokens").and_then(Value::as_f64), header.get("totalOutputTokens").and_then(Value::as_f64));
    assert_eq!(totals, (Some(1_200.0), Some(300.0)), "counted once: {header:?}");
    let asks = recorded_asks(&world).await;
    assert_eq!(asks.len(), 1, "{asks:?}");
    let ask = &asks[0];
    assert_eq!((ask["provider"].as_str(), ask["inputTokens"].as_f64(), ask["outputTokens"].as_f64()), (Some("outside"), Some(1_200.0), Some(300.0)), "{ask}");
    let system = system_messages(&header).len();
    assert!(system > 0, "the session has a system prompt: {header:?}");
    assert_eq!(ask["messageCount"].as_u64(), Some(system as u64 + 1), "{ask}");
}

/// A finished turn the agent reported no usage for has no ask to settle: the session's reading of its context and its
/// totals stay as they were, and no ask is recorded for the statusline.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_outside_agents_turn_that_reported_no_usage_settles_nothing() {
    let agent = Arc::new(Agent::default());
    let header = json!({ "provider": "outside", "model": "default", "lastContextTokens": 5_000 });
    let (world, id, handle) = on_agents_route(&agent, &[], header).await;

    start_turn(&id, &handle, "go").await;
    until(&world, &handle, "the agent's turn", || !lock(&agent.turns).is_empty()).await;

    let header = handle.live_header().header();
    assert_eq!(header.get("lastContextTokens").and_then(Value::as_f64), Some(5_000.0), "{header:?}");
    assert!(!header.contains_key("totalInputTokens") && !header.contains_key("totalOutputTokens"), "{header:?}");
    assert!(recorded_asks(&world).await.is_empty());
}

/// A stop whose token fires as an outside agent's turn finishes takes nothing from the finished turn: its result is kept
/// for its owner and its ask is settled with the usage the agent reported.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stop_landing_as_an_outside_agents_turn_finishes_keeps_its_settlement() {
    let usage = mixdog_core_api::domain::provider::Usage { input_tokens: 1_200, output_tokens: 300, ..Default::default() };
    let agent = Arc::new(Agent { usage: Some(usage), stopped_as_it_ends: true, ..Agent::default() });
    let (world, id, handle) = on_agents_route(&agent, &[], json!({ "provider": "outside", "model": "default", "owner": "agent" })).await;

    start_turn(&id, &handle, "go").await;
    until(&world, &handle, "the agent's turn", || !lock(&agent.turns).is_empty()).await;

    let header = handle.live_header().header();
    assert_eq!(header["lastHandoff"], "done", "{header:?}");
    assert_eq!(recorded_asks(&world).await.len(), 1, "the finished ask is settled");
}

struct NoRelease;

impl mixdog_core_session::session::agent_registry::RuntimeRelease for NoRelease {
    fn release(&self, _: &ThreadId, _: &str) {}
}

/// An unattended turn (a sub-agent's) on an agent's route whose agent goes quiet after it began to answer is stopped as a
/// stalled turn of the loop is: the watchdog reads the progress the agent's turn marks, and the turn fails with its
/// sentence.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stalled_unattended_turn_on_an_agents_route_is_stopped_by_the_watchdog() {
    use mixdog_agent::agent_tool::flow::seams::{ToolResultMessage, TurnHooks, TurnKind, TurnRequest, TurnSessions};
    let clock = Arc::new(Moving(AtomicI64::new(1_700_000_000_000)));
    let agent = Arc::new(Agent { hold: true, stalls: Some(clock.clone()), ..Agent::default() });
    OUTSIDE.with(|slot| *slot.borrow_mut() = Some(agent.clone()));
    let world = turn_world_at(
        scripted(&[]),
        Arc::new(NoMcp),
        Vec::new(),
        false,
        None,
        None,
        Arc::new(MockFileService::default()),
        false,
        clock,
        Arc::new(Config),
        false,
        None,
    )
    .await;
    let (id, _handle) = started_thread(&world, json!({ "provider": "outside", "model": "default" })).await;
    let turns = mixdog_core_session::session::agent_registry::SessionTurns::new(world.directory.clone(), Arc::new(NoRelease));
    let request = TurnRequest {
        kind: TurnKind::Spawn,
        session_id: id.as_str().to_owned(),
        prompt: "go".to_owned(),
        attachments: Vec::new(),
        context: None,
        cwd: String::new(),
        skill_selection: None,
        hooks: TurnHooks {
            submission_id: "sub-1".into(),
            notify: Arc::new(|_, _| true),
            on_tool_result: Arc::new(|_: &ToolResultMessage| {}),
            on_terminal_result: None,
            on_submitted: None,
            on_stage: None,
        },
        slot: None,
        cancel: None,
    };
    let ended = mixdog_core_session::session::testing::awaiting(|| "the stalled turn's end".to_owned(), turns.run_turn(request)).await;
    let error = ended.err().expect("the stalled turn fails");
    assert!(mixdog_agent::agent_tool::watchdog::is_watchdog_abort(&error.message), "{}", error.message);
    assert_eq!(lock(&agent.turns).len(), 1, "the agent ran the turn");
}

/// A user's stop that keeps the prompt of an outside agent's turn that produced nothing closes it as the loop closes such
/// a turn: the prompt stays, followed by the interruption line.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_outside_agents_stopped_turn_that_keeps_its_prompt_is_followed_by_the_interruption_line() {
    let agent = Arc::new(Agent { hold: true, ..Agent::default() });
    let (world, id, handle) = on_agents_route(&agent, &[], json!({ "provider": "outside", "model": "default" })).await;
    let input = json!({ "prompt": "keep it", "options": { "clientSubmissionId": "sub-1" } });
    let started = handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": input }), "op-1")).await.expect("turn/start");
    assert!(matches!(started, Reply::Value(_)), "turn/start answers a value");
    eventually_on_awaiting(
        || "the agent's turn".to_owned(),
        &[&world.rig.store.committed, handle.stepped(), &agent.handed],
        || (!lock(&agent.turns).is_empty()).then_some(()),
    )
    .await;

    let ctx = CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, mixdog_rt::CancellationToken::new());
    let stopped = handle
        .stop(mixdog_core_api::thread::Stop { turn: None, restore_prompt: Some(false), submission_id: Some("sub-1".to_owned()), ctx })
        .await
        .expect("stop");
    assert_eq!(stopped["restoreText"], json!(""), "the prompt is kept: {stopped}");
    until(&world, &handle, "the stopped turn's end", || true).await;

    let records = world.rig.store.records(&id);
    assert!(!records.iter().any(|(_, record)| matches!(record, Record::Rewind(_))), "the prompt stays: {records:?}");
    assert!(format!("{records:?}").contains("[Request interrupted]"), "the interruption line follows the prompt: {records:?}");
}

/// A stopped turn of an outside agent that added nothing after its prompt closes as a stopped turn of the loop that
/// produced nothing: the prompt's row leaves the conversation, a prompt no composer takes back (a kickoff) included.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_outside_agents_stopped_turn_that_produced_nothing_takes_its_prompt_out_of_the_conversation() {
    let agent = Arc::new(Agent { hold: true, ..Agent::default() });
    let (world, id, handle) = on_agents_route(&agent, &[], json!({ "provider": "outside", "model": "default" })).await;
    let input = json!({ "prompt": "greet the user", "options": { "clientSubmissionId": "sub-k", "kickoff": true } });
    let started = handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": input }), "op-1")).await.expect("turn/start");
    assert!(matches!(started, Reply::Value(_)), "turn/start answers a value");
    eventually_on_awaiting(
        || "the agent's turn".to_owned(),
        &[&world.rig.store.committed, handle.stepped(), &agent.handed],
        || (!lock(&agent.turns).is_empty()).then_some(()),
    )
    .await;

    let ctx = CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, mixdog_rt::CancellationToken::new());
    let stopped = handle
        .stop(mixdog_core_api::thread::Stop { turn: None, restore_prompt: Some(true), submission_id: Some("sub-k".to_owned()), ctx })
        .await
        .expect("stop");
    assert_eq!(stopped["restoreText"], json!(""), "no composer takes a kickoff back: {stopped}");
    until(&world, &handle, "the stopped turn's end", || true).await;

    let records = world.rig.store.records(&id);
    assert!(records.iter().any(|(_, record)| matches!(record, Record::Rewind(_))), "the prompt's row is rewound: {records:?}");
}

/// A turn that begins on an outside agent's route and fails before it is handed over is a failed turn, and the agent is
/// told it was not run, so nothing the agent queued for it waits for another turn.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_turn_that_fails_before_it_reaches_its_agent_tells_the_agent_it_was_not_run() {
    let agent = Arc::new(Agent::default());
    let (world, id, handle) = on_agents_route(&agent, &[], json!({ "provider": "outside", "model": "default", "cwd": "not/an/absolute/folder" })).await;

    start_turn(&id, &handle, "go").await;
    until(&world, &handle, "the agent told of the turn it never got", || !lock(&agent.unrun).is_empty()).await;

    let unrun = lock(&agent.unrun).clone();
    assert_eq!(unrun.len(), 1, "{unrun:?}");
    assert!(unrun[0].contains("working directory"), "{unrun:?}");
    assert!(lock(&agent.turns).is_empty(), "a turn whose start failed reaches no agent");
}

/// A turn start that moves the session off the agent's route (a pick held for the turn, a setting that moved) runs the
/// turn in the loop, on the route the header then names; the agent is told a turn of the loop began.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_turn_start_that_moves_the_session_off_the_agents_route_runs_the_turn_in_the_loop() {
    let agent = Arc::new(Agent::default());
    let (world, id, handle) = on_agents_route(&agent, &["from the loop"], json!({ "provider": "outside", "model": "default" })).await;
    *lock(&world.live_settings) = json!({ "provider": "scripted", "model": "m" }).as_object().expect("a route").clone();

    start_turn(&id, &handle, "go").await;
    until(&world, &handle, "the loop's answer", || !lock(&world.ledger.0).is_empty()).await;

    assert_eq!(*lock(&agent.loop_turns), ["scripted"]);
    assert!(lock(&agent.turns).is_empty() && lock(&agent.unrun).is_empty(), "the moved turn is the loop's alone");
    assert_eq!(provider_of(&handle.live_header().header()), "scripted");
}

/// A session that leaves the agent for the loop has left once its header no longer names the agent's own session: the
/// loop's turn is asked on a header without it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_leaves_the_agent_only_once_its_header_no_longer_names_the_agents_session() {
    let agent = Arc::new(Agent::default());
    let header = json!({ "provider": "outside", "model": "default", AGENT_SESSION: { "agent": "outside", "sessionId": "s-1" } });
    let (world, id, handle) = on_agents_route(&agent, &["from the loop"], header).await;
    *lock(&world.live_settings) = json!({ "provider": "scripted", "model": "m" }).as_object().expect("a route").clone();
    start_turn(&id, &handle, "go").await;
    until(&world, &handle, "the loop's answer", || !lock(&world.ledger.0).is_empty()).await;
    assert_eq!(*lock(&agent.left), 1, "the turn began on a header that named the agent's session");
    assert!(!handle.live_header().header().contains_key(AGENT_SESSION), "the header no longer names the agent's session");
    assert!(lock(&agent.unrun).is_empty(), "the turn ran");
}

/// A compaction of a session an agent holds leaves the agent's session behind before it stores the summary: a stop
/// between the two writes leaves a conversation whose next turn hands it over, never a stored summary under a header
/// that still names the session holding what the summary replaced.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_compaction_leaves_the_agents_session_behind_before_it_stores_the_summary() {
    const HELD: &str = mixdog_core_session::session::turn_ops::AGENT_SESSION;
    let agent = Arc::new(Agent::default());
    let header = json!({ "provider": "outside", "model": "default", HELD: { "agent": "outside", "sessionId": "s-1" } });
    let (world, id, handle) = on_agents_route(&agent, &[], header).await;
    // A first turn gives the session a conversation to compact.
    start_turn(&id, &handle, "go").await;
    until(&world, &handle, "the first turn", || lock(&agent.turns).len() == 1).await;
    *lock(&world.rig.compaction.heir_rows) = Some(vec![json!({ "role": "user", "content": "what was said before" })]);

    let started =
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-2", "input": { "prompt": "compact" } }), "op-2")).await.expect("turn/start");
    assert!(matches!(started, Reply::Value(_)), "turn/start answers a value");
    until(&world, &handle, "the compaction", || !lock(&agent.compacted).is_empty()).await;

    let compacted = lock(&agent.compacted).clone();
    assert!(matches!(compacted.as_slice(), [Ok(Some(summary))] if summary.contains("what was said before")), "{compacted:?}");
    assert!(!handle.live_header().header().contains_key(HELD), "the header no longer names the agent's session");
    let records = world.rig.store.records(&id);
    let left = records.iter().position(
        |(_, record)| matches!(record, Record::Meta(meta) if matches!(&meta.change, Slot::Inline(change) if change.unset.iter().any(|key| key == HELD))),
    );
    let stored = records.iter().position(|(_, record)| matches!(record, Record::Compacted(_)));
    let (left, stored) = (left.expect("the write that leaves the agent's session"), stored.expect("the stored summary"));
    assert!(left < stored, "the summary was stored at {stored}, before the session was left behind at {left}");
}

/// A turn on an agent's route whose agent cannot run now (signed out, not installed) is not the agent's: the route hops
/// to its fallback before the turn's first request, as a route whose provider is not available does, with the agent's
/// own refusal as the reason the hop records, and the turn runs on the fallback in the loop.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_turn_on_a_route_whose_agent_cannot_run_hops_to_the_routes_fallback() {
    let refusal = "Test Agent is signed out. Sign in to it in Settings.";
    let agent = Arc::new(Agent { refusal: Some(refusal.to_owned()), ..Agent::default() });
    OUTSIDE.with(|slot| *slot.borrow_mut() = Some(agent.clone()));
    let fallback = scripted(&["from the fallback"]);
    let providers = GatedProviders::new(vec![("scripted", fallback.clone() as Arc<dyn ProviderAdapter>)]);
    // The agent's route provider is no provider of Mixdog's: the providers map names the fallback's alone, as the
    // product's settings do.
    let config = json!({
        "default": "lead-route",
        "presets": [{ "id": "lead-route", "provider": "outside", "model": "default", "fallbacks": [{ "provider": "scripted", "model": "m" }] }],
        "providers": { "scripted": { "enabled": true } },
    });
    let world = turn_world_routed(
        fallback.clone(),
        Arc::new(NoMcp),
        Vec::new(),
        false,
        None,
        None,
        Arc::new(MockFileService::default()),
        false,
        Arc::new(Fixed),
        Arc::new(Config),
        false,
        None,
        Some(routed(providers, config)),
    )
    .await;
    let (id, handle) = started_thread(&world, json!({ "provider": "outside", "model": "default", "agent": "lead" })).await;

    start_turn(&id, &handle, "go").await;
    until(&world, &handle, "the fallback's answer", || !lock(&fallback.requests).is_empty()).await;

    let header = handle.live_header().header();
    assert_eq!((provider_of(&header), header["model"].as_str()), ("scripted", Some("m")));
    assert_eq!(header["routeFallbackFailures"][0]["error"], refusal, "the hop's reason is the agent's own");
    let switched = world
        .rig
        .feeds
        .frames(id.as_str())
        .iter()
        .filter(|(_, method, params)| method == "item/completed" && params["item"].to_string().contains("switched to"))
        .count();
    assert_eq!(switched, 1, "the switch is told");
    assert!(lock(&agent.turns).is_empty() && lock(&agent.unrun).is_empty(), "the turn was the loop's");
    assert_eq!(*lock(&agent.loop_turns), ["outside"], "the session left the agent once the hop was made");
}

/// A turn that starts on the loop's route and is moved onto the agent's by its own start (a pick held for the turn, a
/// setting that moved) is the agent's from there: a start that then fails tells the agent the turn was not run.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_turn_its_own_start_moves_onto_the_agent_tells_the_agent_when_it_then_fails() {
    let agent = Arc::new(Agent::default());
    let (world, id, handle) = on_agents_route(&agent, &[], json!({ "provider": "scripted", "model": "m", "cwd": "not/an/absolute/folder" })).await;
    *lock(&world.live_settings) = json!({ "provider": "outside", "model": "default" }).as_object().expect("a route").clone();

    start_turn(&id, &handle, "go").await;
    until(&world, &handle, "the agent told of the turn it never got", || !lock(&agent.unrun).is_empty()).await;

    let unrun = lock(&agent.unrun).clone();
    assert_eq!(unrun.len(), 1, "{unrun:?}");
    assert!(lock(&agent.turns).is_empty() && lock(&world.ledger.0).is_empty());
}

/// A turn on the route of an agent that is already known signed out, with no fallback, fails with the kind of a provider's
/// authentication failure, so the transcript offers the sign-in.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_turn_on_a_signed_out_agent_fails_as_an_authentication_failure() {
    let agent = Arc::new(Agent { refusal: Some("Test Agent is signed out. Sign in to it in Settings.".to_owned()), signed_out: true, ..Agent::default() });
    let (world, id, handle) = on_agents_route(&agent, &[], json!({ "provider": "outside", "model": "default" })).await;

    start_turn(&id, &handle, "go").await;
    until(&world, &handle, "the failure", || world.rig.feeds.frames(id.as_str()).iter().any(|(_, _, params)| params.to_string().contains(r#""kind":"auth""#)))
        .await;
    assert!(lock(&agent.turns).is_empty(), "the agent ran nothing");
}

/// A session whose first turn failed on another provider left only an unanswered failed user row ahead of the next
/// turn: moving the route to an outside agent does not summarize it, sends no compaction request, and emits no divider.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_whose_first_turn_failed_on_another_provider_is_not_summarized_on_hand_over() {
    let agent = Arc::new(Agent { hand_over: true, ..Agent::default() });
    OUTSIDE.with(|slot| *slot.borrow_mut() = Some(agent.clone()));
    let mut refusal = ProviderError::new(mixdog_core_api::domain::provider::ErrorKind::InvalidRequest, DeliveryState::NotSent);
    refusal.message = "quota exhausted".to_owned();
    let failing: Arc<dyn ProviderAdapter> = Arc::new(Refusing {
        id: ProviderId::from("scripted"),
        policy: RetryPolicy::codex_default(),
        keepalive: KeepaliveSchedule::SPEC,
        codec: MockCodec,
        error: refusal,
    });
    let world = turn_world_full(failing, Arc::new(NoMcp), Vec::new(), false, None, None, Arc::new(MockFileService::default()), false).await;
    let (id, handle) = started_thread(&world, json!({ "provider": "scripted", "model": "m", "owner": "agent" })).await;

    start_turn(&id, &handle, "audit the renderer").await;
    until(&world, &handle, "the failed first turn", || world.rig.store.records(&id).iter().any(|(_, record)| matches!(record, Record::Amend(_)))).await;

    *lock(&world.rig.compaction.heir_rows) = Some(vec![json!({ "role": "user", "content": "should never summarize" })]);
    *lock(&world.live_settings) = json!({ "provider": "outside", "model": "default" }).as_object().expect("a route").clone();
    let started = handle
        .request(request("turn/start", json!({ "threadId": id, "opId": "op-2", "input": { "prompt": "audit the renderer" } }), "op-2"))
        .await
        .expect("turn/start");
    assert!(matches!(started, Reply::Value(_)), "turn/start answers a value");
    until(&world, &handle, "the agent's turn", || !lock(&agent.turns).is_empty()).await;

    assert_eq!(*lock(&agent.handed_over), [(false, Ok(None))]);
    assert!(lock(&world.rig.compaction.heir_asked).is_empty(), "no compaction request is made");
    let compactions = world.rig.store.records(&id).into_iter().filter(|(_, record)| matches!(record, Record::Compacted(_))).count();
    assert_eq!(compactions, 0, "no compaction record is written");
    let dividers = world
        .rig
        .feeds
        .frames(id.as_str())
        .iter()
        .filter(|(_, method, params)| method == "item/completed" && params["item"]["type"] == "contextCompaction")
        .count();
    assert_eq!(dividers, 0, "no live compaction divider is emitted");
}

/// A fresh session holding only `SessionStart` hook rows (even when the hook context contains a closing reminder tag
/// followed by its synthetic `context-ack`) is not summarized when handed over to an outside agent.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_with_only_session_start_hook_rows_is_not_summarized_on_hand_over() {
    let agent = Arc::new(Agent { hand_over: true, ..Agent::default() });
    let (world, id, handle) = on_agents_route(&agent, &[], json!({ "provider": "outside", "model": "default" })).await;
    let rows: Vec<Value> = mixdog_core_session::session::lifecycle_hooks::session_start_rows(&["note with </system-reminder> inside".to_owned()])
        .expect("session start rows")
        .into_iter()
        .map(|body| json!({ "body": body, "visible": false }))
        .collect();
    handle
        .request(CoreRequest {
            method: Method("thread/roomRows/commit"),
            params: json!({ "rows": rows }),
            op: None,
            ctx: CallContext::internal("session-start-hook"),
        })
        .await
        .expect("commit session start rows");
    *lock(&world.rig.compaction.heir_rows) = Some(vec![json!({ "role": "user", "content": "should never summarize" })]);

    start_turn(&id, &handle, "hello").await;
    until(&world, &handle, "the agent's turn", || !lock(&agent.turns).is_empty()).await;

    assert_eq!(*lock(&agent.handed_over), [(false, Ok(None))]);
    assert!(lock(&world.rig.compaction.heir_asked).is_empty(), "no compaction request is made");
    let compactions = world.rig.store.records(&id).into_iter().filter(|(_, record)| matches!(record, Record::Compacted(_))).count();
    assert_eq!(compactions, 0, "no compaction record is written");
    let dividers = world
        .rig
        .feeds
        .frames(id.as_str())
        .iter()
        .filter(|(_, method, params)| method == "item/completed" && params["item"]["type"] == "contextCompaction")
        .count();
    assert_eq!(dividers, 0, "no live compaction divider is emitted");
}

/// A real earlier conversation handed over to an outside agent is summarized once and shows as a compaction does: by
/// one divider, with no hand-over notice beside it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_real_earlier_conversation_hands_over_with_one_compaction_divider() {
    let agent = Arc::new(Agent { hand_over: true, ..Agent::default() });
    let (world, id, handle) = on_agents_route(&agent, &["first answer"], json!({ "provider": "scripted", "model": "m" })).await;

    start_turn(&id, &handle, "first question").await;
    until(&world, &handle, "the first turn's answer", || !lock(&world.ledger.0).is_empty()).await;

    *lock(&world.rig.compaction.heir_rows) = Some(vec![json!({ "role": "user", "content": "summary of turn 1" })]);
    *lock(&world.live_settings) = json!({ "provider": "outside", "model": "default" }).as_object().expect("a route").clone();
    let started =
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-2", "input": { "prompt": "continue" } }), "op-2")).await.expect("turn/start");
    assert!(matches!(started, Reply::Value(_)), "turn/start answers a value");
    until(&world, &handle, "the agent's hand-over turn", || !lock(&agent.turns).is_empty()).await;

    let handed = lock(&agent.handed_over).clone();
    assert!(matches!(handed.as_slice(), [(true, Ok(Some(summary)))] if summary.contains("summary of turn 1")), "{handed:?}");
    assert_eq!(lock(&world.rig.compaction.heir_asked).len(), 1, "the compactor runs once");
    let records = world.rig.store.records(&id);
    let hand_over_compaction = records.iter().find_map(|(_, record)| match record {
        Record::Compacted(compacted)
            if matches!(&compacted.replacement, Slot::Inline(rows) if rows.iter().any(|row| row.body["content"] == "summary of turn 1")) =>
        {
            Some(compacted)
        }
        _ => None,
    });
    let hand_over_compaction = hand_over_compaction.expect("the hand-over summary is stored as a compaction");
    assert_eq!(hand_over_compaction.silent, None, "the hand-over compaction keeps its divider");
    let dividers = world
        .rig
        .feeds
        .frames(id.as_str())
        .iter()
        .filter(|(_, method, params)| method == "item/completed" && params["item"]["type"] == "contextCompaction")
        .count();
    assert_eq!(dividers, 1, "the hand-over shows one compaction divider");
}
