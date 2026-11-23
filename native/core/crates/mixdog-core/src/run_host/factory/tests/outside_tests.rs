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
    /// The liveness the world is composed with, and the route it held for the thread when each turn was handed over.
    liveness: Option<Arc<mixdog_services::task_reports::runtime_state::RuntimeLiveness>>,
    routes: Mutex<Vec<Option<Value>>>,
    /// What each compaction of the session it made on a prompt `compact` came to.
    compacted: Mutex<Vec<Result<Option<String>, String>>>,
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

    fn prompts(&self, _: &Value) -> bool {
        true
    }

    async fn run(&self, turn: OutsideTurn) -> RunOutcome {
        lock(&self.turns).push((turn.header.clone(), turn.input.clone()));
        if let Some(liveness) = &self.liveness {
            lock(&self.routes).push(liveness.request_route(turn.thread.as_str()).map(|route| Value::Object((*route).clone())));
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
        RunOutcome::Completed(Box::new(mixdog_agent::agent_tool::flow::seams::TurnResult {
            content: "done".into(),
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
