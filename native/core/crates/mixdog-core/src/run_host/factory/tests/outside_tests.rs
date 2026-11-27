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
    /// It asks for the conversation it starts without, as an agent with no session of its own does, and keeps the answer.
    hands_over: bool,
    hands_over_results: Mutex<Vec<Result<Option<String>, String>>>,
    /// Records `turn.history.compaction_due()` observed on each round of a turn.
    seen_due: Mutex<Vec<Option<(u64, u64)>>>,
    /// When set, writes `(contextWindow, lastContextTokens)` to the header on round 1.
    round1_header_usage: Option<(u64, u64)>,
    /// When set, calls `turn.history.auto_compaction_trigger(window)` and `turn.history.compact_mid_turn(Some(window))`.
    mid_turn_compact_window: Option<u64>,
    seen_auto_triggers: Mutex<Vec<Option<u64>>>,
    mid_turn_compacted: Mutex<Vec<Result<Option<String>, String>>>,
}

/// The header key the stand-in agent's own session is kept under.
const AGENT_SESSION: &str = "agentSession";

/// The route provider the world's route facts answer as an agent's, which the stand-in agent serves too.
const AGENT_ROUTE: &str = "acp-agent";

fn provider_of(header: &mixdog_store::schema::record::Header) -> &str {
    header.get("provider").and_then(Value::as_str).unwrap_or_default()
}

#[async_trait]
impl OutsideAgents for Agent {
    fn serves(&self, header: &mixdog_store::schema::record::Header) -> bool {
        matches!(provider_of(header), "outside" | AGENT_ROUTE)
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
        lock(&self.seen_due).push(turn.history.compaction_due());
        if let Some((window, used)) = self.round1_header_usage
            && lock(&self.turns).len() == 1
        {
            let mut set = serde_json::Map::new();
            set.insert("contextWindow".into(), json!(window));
            set.insert("lastContextTokens".into(), json!(used));
            set.insert("lastContextTokensStaleAfterCompact".into(), json!(false));
            let _ = turn.port.save_header(mixdog_store::schema::record::HeaderChange { set, unset: Vec::new(), patch: Default::default() }).await;
        }
        if let Some(window) = self.mid_turn_compact_window {
            lock(&self.seen_auto_triggers).push(turn.history.auto_compaction_trigger(window));
            let made = turn.history.compact_mid_turn(Some(window)).await;
            lock(&self.mid_turn_compacted).push(made);
        }
        if self.hands_over {
            let handed = turn.history.hand_over().await;
            lock(&self.hands_over_results).push(handed);
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

/// The loop's provider of the route `primary` whose accounts are all out from its `from`th request on (counted from 0):
/// that request is refused before anything is sent, as an account rotation with no account left refuses it.
struct OutFrom {
    inner: Arc<ArmedRefusal>,
    from: usize,
    sent: std::sync::atomic::AtomicUsize,
}

impl OutFrom {
    fn new(rounds: Vec<Vec<StreamEvent>>, from: usize) -> Arc<Self> {
        Self::named("primary", rounds, from)
    }

    fn named(id: &str, rounds: Vec<Vec<StreamEvent>>, from: usize) -> Arc<Self> {
        let script = Arc::new(Scripted {
            id: ProviderId::from(id),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new(rounds.into()),
            requests: Mutex::new(Vec::new()),
            fail_first: std::sync::atomic::AtomicBool::new(false),
        });
        Arc::new(Self { inner: ArmedRefusal::new(script), from, sent: std::sync::atomic::AtomicUsize::new(0) })
    }
}

#[async_trait]
impl ProviderAdapter for OutFrom {
    fn release_send(&self, group: &str) {
        self.inner.release_send(group);
    }
    fn id(&self) -> &ProviderId {
        self.inner.id()
    }
    fn codec(&self) -> &dyn WireCodec {
        self.inner.codec()
    }
    fn retry_policy(&self) -> &RetryPolicy {
        self.inner.retry_policy()
    }
    fn keepalive(&self) -> &KeepaliveSchedule {
        self.inner.keepalive()
    }
    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        if self.sent.fetch_add(1, Ordering::SeqCst) >= self.from {
            let mut out = ProviderError::new(mixdog_core_api::domain::provider::ErrorKind::QuotaExhausted, DeliveryState::NotSent);
            out.message = "OpenAI OAuth quota/rate limit hit: All connected accounts have exhausted their quota.".into();
            *lock(&self.inner.refusal) = Some(out);
        }
        self.inner.attempt(request).await
    }
}

/// A world whose route `primary`, sent on by `primary`, falls back to the agent's route [`AGENT_ROUTE`], and a session
/// on `primary` with `header`'s fields.
async fn falling_back_to_the_agent(
    agent: &Arc<Agent>,
    primary: Arc<OutFrom>,
    header: Value,
) -> (World, ThreadId, Arc<mixdog_core_session::session::SessionHandle>) {
    OUTSIDE.with(|slot| *slot.borrow_mut() = Some(agent.clone()));
    let providers = GatedProviders::new(vec![("primary", primary.clone() as Arc<dyn ProviderAdapter>)]);
    let config = json!({
        "default": "lead-route",
        "presets": [{ "id": "lead-route", "provider": "primary", "model": "m1", "fallbacks": [{ "provider": AGENT_ROUTE, "model": "gem" }] }],
        "providers": { "primary": { "enabled": true } },
    });
    let world = turn_world_routed(
        primary,
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
    let (id, handle) = started_thread(&world, header).await;
    (world, id, handle)
}

/// A main session's first request, refused before anything was sent because every account of its route is out, moves
/// to the route's fallback on an agent outside the loop as it would to a provider's: the session is written onto the
/// agent's route with the failure recorded, the switch is told once, and the agent runs the turn on the input as the loop
/// sent it, to the turn's end.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_request_every_account_refuses_hands_the_turn_to_the_routes_agent_fallback() {
    let agent = Arc::new(Agent::default());
    let (world, id, handle) =
        falling_back_to_the_agent(&agent, OutFrom::new(Vec::new(), 0), json!({ "provider": "primary", "model": "m1", "agent": "lead" })).await;

    start_turn(&id, &handle, "review the change today").await;
    until(&world, &handle, "the agent's turn", || !lock(&agent.turns).is_empty()).await;

    let (header, input) = lock(&agent.turns)[0].clone();
    assert_eq!((provider_of(&header), header["model"].as_str()), (AGENT_ROUTE, Some("gem")));
    let sent = prompt_text(&input);
    assert!(sent.starts_with("review the change today"), "{sent}");
    assert_eq!(sent.matches("# Current Time").count(), 1, "the input carries the turn's reminders once: {sent}");
    let header = handle.live_header().header();
    assert_eq!(provider_of(&header), AGENT_ROUTE);
    assert_eq!(header["routeFallbackFailures"][0]["kind"], "quota_exhausted", "{header:?}");
    assert_eq!(header["lastHandoff"], "done", "the agent's answer is the turn's result");
    let switched = world
        .rig
        .feeds
        .frames(id.as_str())
        .iter()
        .filter(|(_, method, params)| method == "item/completed" && params["item"].to_string().contains("switched to"))
        .count();
    assert_eq!(switched, 1, "the switch is told once");
}

/// A sub-agent's route that runs out after the turn's first tool round hands the rest of the turn to its fallback on an
/// agent outside the loop: the conversation reaches the agent as the session's own compaction summarizes it, made of the
/// turn as the loop left it (its input, the call and the call's result), and the agent runs the turn there.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_sub_agents_route_running_out_mid_turn_hands_what_was_done_to_the_agent_fallback() {
    let agent = Arc::new(Agent { hands_over: true, ..Agent::default() });
    let round = vec![
        StreamEvent::ToolCallDone(ToolCall { id: "c1".into(), name: "list".into(), arguments: json!({ "path": "." }), native_type: None }),
        StreamEvent::Completed { stop: Some(StopReason::ToolUse), pricing_model: None, request_ms: None },
    ];
    let header = json!({ "provider": "primary", "model": "m1", "agent": "reviewer", "owner": "agent", "routeFallbackSource": { "preset": "lead-route" } });
    let (world, id, handle) = falling_back_to_the_agent(&agent, OutFrom::new(vec![round], 1), header).await;
    *lock(&world.rig.compaction.heir_rows) = Some(vec![json!({ "role": "user", "content": "a review was asked for; the files were listed" })]);

    start_turn(&id, &handle, "review the change").await;
    until(&world, &handle, "the agent's turn", || !lock(&agent.turns).is_empty()).await;

    let seen = lock(&world.rig.compaction.heir_seen).clone();
    let roles: Vec<&str> = seen.first().into_iter().flatten().map(|row| row["role"].as_str().unwrap_or_default()).collect();
    assert_eq!(roles, ["user", "assistant", "tool"], "{seen:?}");
    assert!(prompt_text(&seen[0][0]).starts_with("review the change"), "{seen:?}");
    let handed = lock(&agent.hands_over_results).clone();
    assert!(matches!(handed.as_slice(), [Ok(Some(summary))] if summary.contains("the files were listed")), "{handed:?}");
    let (header, _) = lock(&agent.turns)[0].clone();
    assert_eq!((provider_of(&header), header["owner"].as_str()), (AGENT_ROUTE, Some("agent")));
}

/// Mid-turn tool-only hand-over through the real compactor (no stubbed `heir_rows`) summarizes the tool call, hands
/// the agent the tool call name/args and labeled result, and stores the compacted transcript with the turn's input
/// ahead of the retained loop tool rows.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mid_turn_tool_only_hand_over_uses_real_compactor_and_keeps_input_before_loop_tool_rows() {
    let agent = Arc::new(Agent { hands_over: true, ..Agent::default() });
    OUTSIDE.with(|slot| *slot.borrow_mut() = Some(agent.clone()));
    let round = vec![
        StreamEvent::ToolCallDone(ToolCall { id: "c1".into(), name: "list".into(), arguments: json!({ "path": "." }), native_type: None }),
        StreamEvent::Completed { stop: Some(StopReason::ToolUse), pricing_model: None, request_ms: None },
    ];
    let primary = OutFrom::new(vec![round], 1);
    let providers = GatedProviders::new(vec![("primary", primary.clone() as Arc<dyn ProviderAdapter>)]);
    let config = json!({
        "default": "lead-route",
        "presets": [{ "id": "lead-route", "provider": "primary", "model": "m1", "fallbacks": [{ "provider": AGENT_ROUTE, "model": "gem" }] }],
        "providers": { "primary": { "enabled": true } },
    });
    let world = turn_world_routed(
        primary,
        Arc::new(NoMcp),
        Vec::new(),
        false,
        None,
        None,
        Arc::new(MockFileService::default()),
        false,
        Arc::new(Fixed),
        Arc::new(Windowed { auto: false }),
        true,
        None,
        Some(routed(providers, config)),
    )
    .await;
    let header = json!({ "provider": "primary", "model": "m1", "agent": "reviewer", "owner": "agent", "routeFallbackSource": { "preset": "lead-route" } });
    let (id, handle) = started_thread(&world, header).await;

    start_turn(&id, &handle, "review the change").await;
    until(&world, &handle, "the agent's turn", || !lock(&agent.turns).is_empty()).await;

    let handed = lock(&agent.hands_over_results).clone();
    let summary = match handed.as_slice() {
        [Ok(Some(summary))] => summary.as_str(),
        other => panic!("expected real-compactor hand-over summary: {other:?}"),
    };
    assert!(summary.contains(mixdog_agent::compact::fresh::SUMMARY_PREFIX), "{summary}");
    assert!(summary.contains("acp-agent|gem|"), "summary came from the real compactor: {summary}");
    assert!(summary.contains("[tool call] list({\"path\":\".\"})"), "tool call preserved: {summary}");
    assert!(summary.contains("## Tool result (list)"), "tool result labeled with call name: {summary}");

    let records = world.rig.store.records(&id);
    let replacement = records
        .iter()
        .rev()
        .find_map(|(_, record)| match record {
            Record::Compacted(compacted) => match &compacted.replacement {
                Slot::Inline(entries) => Some(entries.clone()),
                _ => None,
            },
            _ => None,
        })
        .expect("compacted record stored");
    let user_pos = replacement.iter().position(|entry| prompt_text(&entry.body).starts_with("review the change")).expect("turn input kept");
    let call_pos =
        replacement.iter().position(|entry| entry.body["role"] == "assistant" && entry.body.to_string().contains("\"list\"")).expect("loop tool-call row kept");
    let tool_pos = replacement.iter().position(|entry| entry.body["role"] == "tool").expect("loop tool-result row kept");
    assert!(user_pos < call_pos && call_pos < tool_pos, "input must precede loop tool rows: {replacement:?}");
}

/// Chained fallback (provider A -> provider B -> ACP agent) on a fresh session does not treat the turn's own input as
/// prior conversation even though the first hop called `sink.replace` and raised `base.held`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chained_fallback_on_fresh_session_treats_turn_as_having_no_prior_conversation() {
    let agent = Arc::new(Agent { hands_over: true, ..Agent::default() });
    OUTSIDE.with(|slot| *slot.borrow_mut() = Some(agent.clone()));
    let primary = OutFrom::named("primary", Vec::new(), 0);
    let secondary = OutFrom::named("secondary", Vec::new(), 0);
    let providers =
        GatedProviders::new(vec![("primary", primary.clone() as Arc<dyn ProviderAdapter>), ("secondary", secondary.clone() as Arc<dyn ProviderAdapter>)]);
    let config = json!({
        "default": "lead-route",
        "presets": [{
            "id": "lead-route",
            "provider": "primary",
            "model": "m1",
            "fallbacks": [
                { "provider": "secondary", "model": "m2" },
                { "provider": AGENT_ROUTE, "model": "gem" },
            ],
        }],
        "providers": { "primary": { "enabled": true }, "secondary": { "enabled": true } },
    });
    let world = turn_world_routed(
        primary,
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
    let (id, handle) = started_thread(&world, json!({ "provider": "primary", "model": "m1", "agent": "lead" })).await;

    start_turn(&id, &handle, "fresh chained turn").await;
    until(&world, &handle, "the agent's turn", || !lock(&agent.turns).is_empty()).await;

    assert_eq!(*lock(&agent.hands_over_results), [Ok(None)], "fresh session has no prior conversation to summarize");
    assert!(lock(&world.rig.compaction.heir_seen).is_empty(), "fresh session must not invoke compactor");
    let records = world.rig.store.records(&id);
    assert!(
        !records.iter().any(|(_, record)| matches!(record, Record::Compacted(c) if c.silent != Some(true) || c.dropped_count != Some(0))),
        "no spurious compaction record: {records:?}"
    );
}

/// Stopping an ACP fallback turn after an earlier hop already completed tool work does not rewind the turn's prompt.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stopping_acp_fallback_after_earlier_hop_and_tool_round_does_not_rewind_prompt() {
    let agent = Arc::new(Agent { hold: true, hands_over: true, ..Agent::default() });
    OUTSIDE.with(|slot| *slot.borrow_mut() = Some(agent.clone()));
    let round = vec![
        StreamEvent::ToolCallDone(ToolCall { id: "c1".into(), name: "list".into(), arguments: json!({ "path": "." }), native_type: None }),
        StreamEvent::Completed { stop: Some(StopReason::ToolUse), pricing_model: None, request_ms: None },
    ];
    let primary = OutFrom::named("primary", Vec::new(), 0);
    let secondary = OutFrom::named("secondary", vec![round], 1);
    let providers =
        GatedProviders::new(vec![("primary", primary.clone() as Arc<dyn ProviderAdapter>), ("secondary", secondary.clone() as Arc<dyn ProviderAdapter>)]);
    let config = json!({
        "default": "lead-route",
        "presets": [{
            "id": "lead-route",
            "provider": "primary",
            "model": "m1",
            "fallbacks": [
                { "provider": "secondary", "model": "m2" },
                { "provider": AGENT_ROUTE, "model": "gem" },
            ],
        }],
        "providers": { "primary": { "enabled": true }, "secondary": { "enabled": true } },
    });
    let world = turn_world_routed(
        primary,
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
    let (id, handle) = started_thread(&world, json!({ "provider": "primary", "model": "m1", "agent": "lead" })).await;
    let input = json!({ "prompt": "run then stop", "options": { "clientSubmissionId": "sub-chain" } });
    let started = handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": input }), "op-1")).await.expect("turn/start");
    assert!(matches!(started, Reply::Value(_)), "turn/start answers a value");
    eventually_on_awaiting(
        || "the agent's turn".to_owned(),
        &[&world.rig.store.committed, handle.stepped(), &agent.handed],
        || (!lock(&agent.turns).is_empty()).then_some(()),
    )
    .await;

    let ctx = CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, mixdog_rt::CancellationToken::new());
    handle
        .stop(mixdog_core_api::thread::Stop { turn: None, restore_prompt: Some(true), submission_id: Some("sub-chain".to_owned()), ctx })
        .await
        .expect("stop");
    until(&world, &handle, "the stopped turn's end", || true).await;

    let records = world.rig.store.records(&id);
    assert!(!records.iter().any(|(_, record)| matches!(record, Record::Rewind(_))), "work was performed so prompt must not rewind: {records:?}");
}

/// Mid-turn hand-over reuses the turn's existing `TodoGuards` instead of calling `start_turn` a second time, preserving
/// both `todoCheck` mutation counts and any todo list finished during the loop half.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mid_turn_hand_over_preserves_todo_guards_and_finished_todo_list() {
    use mixdog_tools::state::todo::{TodoList, TodoPhase, TodoStatus, TodoStore, TodoTask};

    // Part 1: mutation count recorded during the loop half survives hand-over into saved `todoCheck`.
    let agent = Arc::new(Agent::default());
    OUTSIDE.with(|slot| *slot.borrow_mut() = Some(agent.clone()));
    let edit_round = vec![
        StreamEvent::ToolCallDone(ToolCall { id: "e1".into(), name: "edit".into(), arguments: json!({}), native_type: None }),
        StreamEvent::Completed { stop: Some(StopReason::ToolUse), pricing_model: None, request_ms: None },
    ];
    let primary = OutFrom::new(vec![edit_round], 1);
    let providers = GatedProviders::new(vec![("primary", primary.clone() as Arc<dyn ProviderAdapter>)]);
    let config = json!({
        "default": "lead-route",
        "presets": [{ "id": "lead-route", "provider": "primary", "model": "m1", "fallbacks": [{ "provider": AGENT_ROUTE, "model": "gem" }] }],
        "providers": { "primary": { "enabled": true } },
    });
    let world = turn_world_routed(
        primary,
        Arc::new(NoMcp),
        Vec::new(),
        false,
        None,
        Some(vec![named("list"), named("edit")]),
        Arc::new(MockFileService::default()),
        true,
        Arc::new(Fixed),
        Arc::new(Config),
        false,
        None,
        Some(routed(providers, config.clone())),
    )
    .await;
    let (id, handle) =
        started_thread(&world, json!({ "provider": "primary", "model": "m1", "agent": "lead", "tools": [{ "name": "list" }, { "name": "edit" }] })).await;
    start_turn(&id, &handle, "edit then hand over").await;
    until(&world, &handle, "the agent's turn", || !lock(&agent.turns).is_empty()).await;
    assert_eq!(handle.live_header().header()["todoCheck"]["staleMutations"], json!(1), "{:?}", handle.live_header().header()["todoCheck"]);

    // Part 2: a todo list finished during the loop half is not cleared by a second `start_turn(true)` on hand-over.
    struct FinishTodo(ToolSpec, Arc<std::sync::OnceLock<Arc<mixdog_core_session::session::testing::TestTodos>>>);
    #[async_trait]
    impl Tool for FinishTodo {
        fn spec(&self) -> &ToolSpec {
            &self.0
        }
        async fn call(&self, _: &ToolContext, _: JsonValue) -> ToolOutcome {
            let todos = self.1.get().expect("todo store wired");
            let done = TodoList {
                phases: vec![TodoPhase {
                    name: "Work".to_owned(),
                    tasks: vec![TodoTask { content: "done step".to_owned(), status: TodoStatus::Completed, note: None }],
                }],
                updated_at_ms: 1,
            };
            *lock(&todos.0) = done;
            Ok(ToolOutput { parts: vec![ToolPart::Text("finished".into())], ..ToolOutput::default() })
        }
    }
    let finish_slot = Arc::new(std::sync::OnceLock::new());
    let finish_tool: Arc<dyn Tool> = Arc::new(FinishTodo(
        ToolSpec {
            name: "finish_todo".into(),
            title: None,
            trigger: None,
            public: true,
            aliases: Vec::new(),
            description: "finish_todo".into(),
            input_schema: json!({ "type": "object" }),
            annotations: ToolAnnotations::default(),
            parallel_safe: true,
            exclusive_with: Vec::new(),
        },
        finish_slot.clone(),
    ));
    let agent = Arc::new(Agent::default());
    OUTSIDE.with(|slot| *slot.borrow_mut() = Some(agent.clone()));
    let finish_round = vec![
        StreamEvent::ToolCallDone(ToolCall { id: "f1".into(), name: "finish_todo".into(), arguments: json!({}), native_type: None }),
        StreamEvent::Completed { stop: Some(StopReason::ToolUse), pricing_model: None, request_ms: None },
    ];
    let primary = OutFrom::new(vec![finish_round], 1);
    let providers = GatedProviders::new(vec![("primary", primary.clone() as Arc<dyn ProviderAdapter>)]);
    let world = turn_world_routed(
        primary,
        Arc::new(NoMcp),
        Vec::new(),
        false,
        None,
        Some(vec![named("list"), finish_tool]),
        Arc::new(MockFileService::default()),
        true,
        Arc::new(Fixed),
        Arc::new(Config),
        false,
        None,
        Some(routed(providers, config)),
    )
    .await;
    let (id, handle) =
        started_thread(&world, json!({ "provider": "primary", "model": "m1", "agent": "lead", "tools": [{ "name": "list" }, { "name": "finish_todo" }] }))
            .await;
    let _ = finish_slot.set(world.rig.todos.clone());
    start_turn(&id, &handle, "finish todos then hand over").await;
    until(&world, &handle, "the agent's turn", || !lock(&agent.turns).is_empty()).await;
    let remaining = world.rig.todos.read(&id).await;
    assert_eq!(remaining.phases.len(), 1, "finished todo list must not be cleared on mid-turn hand-over: {remaining:?}");
}

/// Outside-agent turns preload explicit skills (`$demo-skill`), record `appliedSkills` on the input row, commit the
/// hidden skill context/body rows, and include the loaded `<skill>` body in the prompt handed to the agent.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn outside_turn_preloads_explicit_skills_records_applied_and_places_body() {
    struct MockSkillTool(ToolSpec);
    #[async_trait]
    impl Tool for MockSkillTool {
        fn spec(&self) -> &ToolSpec {
            &self.0
        }
        async fn call(&self, _: &ToolContext, args: JsonValue) -> ToolOutcome {
            let name = args["name"].as_str().unwrap_or_default();
            Ok(ToolOutput {
                parts: vec![ToolPart::Text(format!("Loaded skill: {name}"))],
                follow_up_messages: vec![mixdog_core_api::domain::tool::FollowUpMessage {
                    text: format!("<skill>\n<name>{name}</name>\nFollow demo-skill rules.\n</skill>"),
                    meta: None,
                }],
                ..ToolOutput::default()
            })
        }
    }
    let skill_tool: Arc<dyn Tool> = Arc::new(MockSkillTool(ToolSpec {
        name: "Skill".into(),
        title: None,
        trigger: None,
        public: true,
        aliases: Vec::new(),
        description: "Skill".into(),
        input_schema: json!({ "type": "object" }),
        annotations: ToolAnnotations::default(),
        parallel_safe: true,
        exclusive_with: Vec::new(),
    }));
    let agent = Arc::new(Agent::default());
    OUTSIDE.with(|slot| *slot.borrow_mut() = Some(agent.clone()));
    let world =
        turn_world_full(scripted(&[]), Arc::new(NoMcp), Vec::new(), false, None, Some(vec![skill_tool]), Arc::new(MockFileService::default()), true).await;
    let header = json!({
        "provider": "outside",
        "model": "default",
        "tools": [{ "name": "Skill" }],
        "availableSkills": ["demo-skill"],
    });
    let (id, handle) = started_thread(&world, header).await;

    start_turn(&id, &handle, "please use $demo-skill here").await;
    until(&world, &handle, "the agent's turn with preloaded skill", || !lock(&agent.turns).is_empty()).await;

    let sent = prompt_text(&lock(&agent.turns)[0].1);
    assert!(sent.contains("<skill>\n<name>demo-skill</name>\nFollow demo-skill rules.\n</skill>"), "{sent}");
    let records = world.rig.store.records(&id);
    let has_skill_row = records.iter().any(|(_, record)| {
        matches!(
            record,
            Record::Item(item)
                if matches!(
                    &item.body,
                    Slot::Inline(body)
                        if body.get("meta").and_then(Value::as_str) == Some("skill")
                            || body.pointer("/meta/source").and_then(Value::as_str) == Some("skill")
                )
        )
    });
    assert!(has_skill_row, "loaded skill body must be persisted as a sourced skill row: {records:?}");
    let has_applied = records.iter().any(|(_, record)| {
        matches!(
            record,
            Record::Amend(amend)
                if matches!(&amend.body, Slot::Inline(body) if body.pointer("/meta/transcript/appliedSkills") == Some(&json!(["demo-skill"])))
        )
    });
    assert!(has_applied, "input row must record appliedSkills: {records:?}");
}

/// Outside-agent turns run the Todo completion audit (`guards.completion_reminder`) when unfinished todos remain at
/// turn completion, injecting a continuation round until the agent finishes or the guard stops reminding.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn outside_turn_runs_completion_reminder_on_incomplete_todos() {
    use mixdog_tools::state::todo::{TodoList, TodoPhase, TodoStatus, TodoTask};

    let agent = Arc::new(Agent::default());
    let (world, id, handle) = on_agents_route(&agent, &[], json!({ "provider": "outside", "model": "default" })).await;
    let pending = TodoList {
        phases: vec![TodoPhase {
            name: "Work".to_owned(),
            tasks: vec![TodoTask { content: "finish migration".to_owned(), status: TodoStatus::Pending, note: None }],
        }],
        updated_at_ms: 1,
    };
    *lock(&world.rig.todos.0) = pending;

    start_turn(&id, &handle, "do the work").await;
    until(&world, &handle, "completion reminder continuation", || lock(&agent.turns).len() >= 2).await;

    let second_prompt = prompt_text(&lock(&agent.turns)[1].1);
    assert!(second_prompt.contains("finish migration") || second_prompt.contains("todo"), "expected todo completion reminder: {second_prompt}");
}

/// Outside-agent turns attach matching `TailReminder` rules (such as `claude-opus-5-5` with non-English language) ONLY
/// to the outgoing prompt handed to the agent and never persist the tail reminder onto the stored user row.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn outside_turn_appends_tail_reminder_only_to_outgoing_prompt() {
    let agent = Arc::new(Agent::default());
    let header = json!({
        "provider": "outside",
        "model": "claude-opus-5-5",
        "responseLanguage": { "id": "ko", "name": "Korean" },
    });
    let (world, id, handle) = on_agents_route(&agent, &[], header).await;

    start_turn(&id, &handle, "analyze this").await;
    until(&world, &handle, "tail reminder turn", || !lock(&agent.turns).is_empty()).await;

    let sent = prompt_text(&lock(&agent.turns)[0].1);
    assert!(sent.contains("Write all user-facing text in Korean"), "tail reminder must be attached to outgoing prompt: {sent}");
    let stored_has_tail = world.rig.store.records(&id).iter().any(|(_, record)| match record {
        Record::Item(item) => matches!(&item.body, Slot::Inline(body) if body.to_string().contains("Write all user-facing text in Korean")),
        Record::Amend(amend) => matches!(&amend.body, Slot::Inline(body) if body.to_string().contains("Write all user-facing text in Korean")),
        _ => false,
    });
    assert!(!stored_has_tail, "tail reminder must never be persisted into stored transcript rows");
}

/// A failed `reconcile_turn` during continuation header refresh must fail/stop the continuation instead of
/// falling back to the stale pre-session header (which would otherwise cause `runs.rs` to kill the live ACP process).
#[tokio::test]
async fn outside_turn_continuation_header_refresh_failure_propagates_error_without_stale_fallback() {
    struct RefreshParts {
        result: Mutex<Option<Result<mixdog_store::schema::record::Header, TurnError>>>,
        seen_probe: Mutex<Option<mixdog_store::schema::record::Header>>,
    }

    #[async_trait]
    impl RunParts for RefreshParts {
        async fn assemble(&self, _: AssembleInput<'_>) -> Result<Assembled, TurnError> {
            unreachable!("not used in refresh_continuation_header test")
        }

        async fn reconcile_turn(
            &self,
            _: &ThreadId,
            header: mixdog_store::schema::record::Header,
            _: bool,
        ) -> Result<mixdog_store::schema::record::Header, TurnError> {
            *lock(&self.seen_probe) = Some(header);
            lock(&self.result).take().expect("configured result")
        }
    }

    let mut stale = mixdog_store::schema::record::Header::new();
    stale.insert("provider".into(), json!("outside"));
    stale.insert("pendingRoute".into(), json!({ "provider": "outside", "model": "default" }));

    // 1. Reconcile error must propagate as RunOutcome::Failed and never return the stale header.
    let failing = RefreshParts {
        result: Mutex::new(Some(Err(TurnError {
            message: "failed to read persisted session header".into(),
            data: json!({ "reason": "store_unavailable" }),
            provider_error: None,
        }))),
        seen_probe: Mutex::new(None),
    };
    let cancel = tokio_util::sync::CancellationToken::new();
    let outcome = super::super::outside::refresh_continuation_header(&failing, &ThreadId::from("thr_refresh"), &stale, &cancel).await;
    match outcome {
        Err(RunOutcome::Failed(err)) => {
            assert_eq!(err.message, "failed to read persisted session header");
            assert_eq!(err.data, json!({ "reason": "store_unavailable" }));
        }
        other => panic!("expected RunOutcome::Failed on reconcile error, got {other:?}"),
    }
    let probe = lock(&failing.seen_probe).clone().expect("probe passed to reconcile_turn");
    assert!(!probe.contains_key("pendingRoute"), "pendingRoute must be stripped before reconciling continuation");

    // 2. Successful reconcile returns the refreshed header containing the persisted agentSession.
    let mut refreshed = stale.clone();
    refreshed.shift_remove("pendingRoute");
    refreshed.insert(AGENT_SESSION.into(), json!({ "agent": "antigravity", "sessionId": "sess-live" }));
    let succeeding = RefreshParts { result: Mutex::new(Some(Ok(refreshed))), seen_probe: Mutex::new(None) };
    let ok = super::super::outside::refresh_continuation_header(&succeeding, &ThreadId::from("thr_refresh"), &stale, &cancel).await.expect("refreshed header");
    assert_eq!(ok.get(AGENT_SESSION).and_then(|v| v.get("sessionId")), Some(&json!("sess-live")));

    // 3. Cancellation interrupts cleanly instead of returning a stale header.
    cancel.cancel();
    let cancelled = RefreshParts { result: Mutex::new(None), seen_probe: Mutex::new(None) };
    let interrupted = super::super::outside::refresh_continuation_header(&cancelled, &ThreadId::from("thr_refresh"), &stale, &cancel).await;
    assert!(matches!(interrupted, Err(RunOutcome::Interrupted)), "expected Interrupted, got {interrupted:?}");
}

/// `ConfigSeams` mirroring `run_seams::compact_settings_with` by populating `CompactSettings` from the session header.
struct HeaderCompactConfig;

impl crate::run_host::host_seams::ConfigSeams for HeaderCompactConfig {
    fn hidden_agent(&self, agent: Option<&str>) -> bool {
        crate::run_host::host_seams::ConfigSeams::hidden_agent(&Config, agent)
    }
    fn synced_compaction(&self, header: &mixdog_store::schema::record::Header, install: bool) -> Option<Value> {
        crate::run_host::host_seams::ConfigSeams::synced_compaction(&Config, header, install)
    }
    fn route_config(&self, header: &mixdog_store::schema::record::Header) -> mixdog_app_protocol::v2::thread::ThreadRoute {
        crate::run_host::host_seams::ConfigSeams::route_config(&Config, header)
    }
    fn settings_changes(&self, _: &ThreadId) -> Option<mixdog_core_session::session::turn_ops::SettingsFeed> {
        None
    }
    fn run_settings(&self, thread: &ThreadId, header: &mixdog_store::schema::record::Header) -> crate::run_host::assemble::RunSettings {
        let mut settings = crate::run_host::host_seams::ConfigSeams::run_settings(&Config, thread, header);
        let u64_of = |key: &str| header.get(key).and_then(Value::as_u64);
        settings.compact = Some(mixdog_agent::boundary::CompactSettings {
            auto: true,
            context_window: u64_of("contextWindow"),
            explicit_boundary: u64_of("compactBoundaryTokens"),
            auto_limit: u64_of("autoCompactTokenLimit"),
            token_calibration: 1.0,
            ..Default::default()
        });
        settings
    }
    fn stored_instruction_files(&self) -> Option<Value> {
        None
    }
    fn response_language(&self) -> Option<(String, String)> {
        None
    }
}

/// Continuation rounds inside `drive_outside` must compute `History::compaction_due()` from the refreshed session
/// header instead of passing `due: None`, so context pressure accumulated during round 1 triggers compaction before
/// round 2 runs.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn outside_turn_continuation_round_computes_compaction_due_from_refreshed_header() {
    use mixdog_tools::state::todo::{TodoList, TodoPhase, TodoStatus, TodoTask};

    let agent = Arc::new(Agent { round1_header_usage: Some((256_000, 256_000)), ..Agent::default() });
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
        Arc::new(Fixed),
        Arc::new(HeaderCompactConfig),
        false,
        None,
    )
    .await;
    let (id, handle) = started_thread(&world, json!({ "provider": "outside", "model": "default" })).await;
    *lock(&world.rig.todos.0) = TodoList {
        phases: vec![TodoPhase {
            name: "Work".to_owned(),
            tasks: vec![TodoTask { content: "finish task".to_owned(), status: TodoStatus::Pending, note: None }],
        }],
        updated_at_ms: 1,
    };

    start_turn(&id, &handle, "do the work").await;
    until(&world, &handle, "continuation round with compaction due", || lock(&agent.turns).len() >= 2).await;

    let seen_due = lock(&agent.seen_due).clone();
    assert!(seen_due.len() >= 2, "expected at least 2 rounds, got {seen_due:?}");
    assert_eq!(seen_due[0], None, "round 1 starts with no prior usage");
    assert_eq!(seen_due[1], Some((256_000, 256_000)), "round 2 must receive compaction_due from refreshed header");
}

/// `History::auto_compaction_trigger` clamps a stale 1M `compactBoundaryTokens` to the live capped `effective_window`,
/// and `History::compact_mid_turn` summarizes live `ModelContext` rows, leaves `agentSession` behind first, stores the
/// compaction replacement, and resets `lastContextTokens` to 0.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn outside_turn_mid_turn_compaction_compacts_live_context_and_clamps_stale_boundary() {
    const HELD: &str = mixdog_core_session::session::turn_ops::AGENT_SESSION;
    let agent = Arc::new(Agent { mid_turn_compact_window: Some(256_000), ..Agent::default() });
    let header = json!({
        "provider": "outside",
        "model": "default",
        "contextWindow": 1_048_576,
        "compactBoundaryTokens": 1_048_576,
        "lastContextTokens": 210_000,
        "todo": { "phases": [{ "name": "Work", "tasks": [
            { "content": "map the modules", "status": "completed" },
            { "content": "write the report", "status": "in_progress" },
        ] }], "updatedAt": 1 },
        HELD: { "agent": "outside", "sessionId": "s-mid" },
    });
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
        Arc::new(Fixed),
        Arc::new(HeaderCompactConfig),
        false,
        None,
    )
    .await;
    let (id, handle) = started_thread(&world, header).await;
    *lock(&world.rig.compaction.heir_rows) = Some(vec![json!({ "role": "user", "content": "mid-turn summary body" })]);

    start_turn(&id, &handle, "long turn work").await;
    until(&world, &handle, "mid-turn compaction", || !lock(&agent.mid_turn_compacted).is_empty()).await;

    let triggers = lock(&agent.seen_auto_triggers).clone();
    assert_eq!(triggers, vec![Some(256_000)], "stale 1M explicit boundary must be clamped to effective_window=256k");

    let compacted = lock(&agent.mid_turn_compacted).clone();
    assert!(matches!(compacted.as_slice(), [Ok(Some(summary))] if summary.contains("mid-turn summary body")), "expected mid-turn summary, got {compacted:?}");
    // The agent that goes on is told where the work stands, as a provider's request is after a compaction: without
    // the step list it plans the task anew after every rollover.
    assert!(
        matches!(compacted.as_slice(), [Ok(Some(summary))] if summary.contains("<todo_state>") && summary.contains("write the report")),
        "the summary carries the open step list: {compacted:?}"
    );
    let live_header = handle.live_header().header();
    assert!(!live_header.contains_key(HELD), "agentSession must be unset on mid-turn compaction");
    assert_eq!(live_header.get("lastContextTokens"), Some(&json!(0)), "lastContextTokens must be reset to 0");

    let records = world.rig.store.records(&id);
    let left = records.iter().position(
        |(_, record)| matches!(record, Record::Meta(meta) if matches!(&meta.change, Slot::Inline(change) if change.unset.iter().any(|key| key == HELD))),
    );
    let stored = records.iter().position(|(_, record)| matches!(record, Record::Compacted(_)));
    let (left, stored) = (left.expect("agentSession unset write"), stored.expect("Record::Compacted write"));
    assert!(left < stored, "agentSession must be unset before Record::Compacted is committed");
}
