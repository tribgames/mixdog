//! The session half of the thread settings against the Node recording
//! (`fixtures/thread-settings/session-switches.json`, `context-switch.json`): the pure switches
//! replayed over the recorded sessions, and the adapters over the production session directory
//! (the real actor and log over the in-memory store).

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::ids::ItemId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_ports::ports::route::record_transcript_boundary;
use mixdog_store::schema::record::Header;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::*;
use crate::session::ItemCommit;
use crate::session::seams::RunOutcome;
use crate::session::testing::Rig;
use crate::session::testing::Script;
use crate::session::testing::lock;
use crate::session::tests::eventually;
use crate::session::tests::turn;

fn recording(name: &str) -> Value {
    let text = match name {
        "session-switches.json" => include_str!("../../../../fixtures/thread-settings/session-switches.json"),
        "context-switch.json" => include_str!("../../../../fixtures/thread-settings/context-switch.json"),
        _ => unreachable!("a recording of this set"),
    };
    serde_json::from_str(text).expect("json")
}

/// The recorder's stubs for the prompt side, read from the recording itself.
struct Table {
    workflows: Value,
    standalone: Vec<Value>,
    instructions: Value,
}

impl Table {
    fn of(golden: &Value) -> Self {
        Self {
            workflows: golden["workflows"].clone(),
            standalone: golden["standalone"].as_array().cloned().unwrap_or_default(),
            instructions: golden["instructions"].clone(),
        }
    }
}

#[async_trait]
impl WorkflowSurface for Table {
    async fn target(&self, _: &Header, workflow_id: &str, mode: Option<&str>) -> Result<WorkflowTarget, SurfaceFailure> {
        let entry = self.workflows.get(workflow_id).unwrap_or(&self.workflows["alpha"]);
        let text = |key: &str| entry[key].as_str().unwrap_or_default().to_owned();
        Ok(WorkflowTarget {
            summary: entry["summary"].clone(),
            orchestration_mode: mode.unwrap_or("balanced").to_owned(),
            pack_context: text("packContext"),
            orchestration_context: text("orchestrationContext"),
            agent_catalog_context: text("agentCatalogContext"),
            contact_catalog_context: String::new(),
        })
    }

    async fn live_denied_tools(&self, _: &Header, summary: &Value) -> Result<Vec<String>, SurfaceFailure> {
        let id = summary["id"].as_str().unwrap_or_default();
        Ok(self.workflows[id]["denied"].as_array().map(|list| list.iter().filter_map(|n| n.as_str().map(str::to_owned)).collect()).unwrap_or_default())
    }

    async fn standalone_tools(&self, _: &Header) -> Result<Vec<Value>, SurfaceFailure> {
        Ok(self.standalone.clone())
    }

    async fn orchestration_instructions(&self, mode: &str) -> Result<String, SurfaceFailure> {
        Ok(self.instructions[mode].as_str().unwrap_or_default().to_owned())
    }
}

/// A surface whose reads cannot run.
struct Refusing;

#[async_trait]
impl WorkflowSurface for Refusing {
    async fn target(&self, _: &Header, _: &str, _: Option<&str>) -> Result<WorkflowTarget, SurfaceFailure> {
        Err(SurfaceFailure("the pack read could not run".into()))
    }
    async fn live_denied_tools(&self, _: &Header, _: &Value) -> Result<Vec<String>, SurfaceFailure> {
        Err(SurfaceFailure("the gate read could not run".into()))
    }
    async fn standalone_tools(&self, _: &Header) -> Result<Vec<Value>, SurfaceFailure> {
        Err(SurfaceFailure("the gate read could not run".into()))
    }
    async fn orchestration_instructions(&self, _: &str) -> Result<String, SurfaceFailure> {
        Err(SurfaceFailure("the mode text read could not run".into()))
    }
}

/// A read that cannot run stops the switch with its own text: the pending workflow is not
/// dropped as gone, and no mode reminder is written without its text.
#[tokio::test]
async fn a_surface_that_cannot_read_stops_the_switch() {
    let mut pending_workflow = header_of(&json!({ "id": "sess_a", "pendingWorkflowId": "beta" }));
    assert_eq!(apply_pending(&mut pending_workflow, &Refusing, 1).await.err(), Some(SurfaceFailure("the pack read could not run".into())));
    let mut pending_mode = header_of(&json!({ "id": "sess_a", "pendingOrchestrationMode": "none" }));
    assert_eq!(apply_pending(&mut pending_mode, &Refusing, 1).await.err(), Some(SurfaceFailure("the mode text read could not run".into())));
    let mut idle = header_of(&json!({ "id": "sess_a" }));
    assert!(matches!(apply_pending(&mut idle, &Refusing, 1).await, Ok(None)));
}

fn header_of(value: &Value) -> Header {
    value.as_object().cloned().unwrap_or_default()
}

/// Every recorded scenario, replayed over the recorded session: the answer, the session after
/// each step and the boundaries recorded on its messages are Node's.
#[tokio::test]
async fn the_switches_match_node() {
    let golden = recording("session-switches.json");
    let surface = Table::of(&golden);
    let now = golden["now"].as_i64().expect("the frozen clock");
    for scenario in golden["scenarios"].as_array().expect("scenarios") {
        let name = scenario["name"].as_str().unwrap_or_default();
        // A runtime with no session: the adapter answers it (`no_session_answers_the_empty_path`).
        if scenario["session"].is_null() {
            continue;
        }
        let mut session = header_of(&scenario["session"]);
        let mut messages = array(session.shift_remove("messages").as_ref());
        let mut in_flight = scenario["inFlight"] == json!(true);
        for (i, step) in scenario["steps"].as_array().expect("steps").iter().enumerate() {
            let op = step["op"].as_str().unwrap_or_default();
            if op == "idle" {
                in_flight = false;
                continue;
            }
            let conversation = has_conversation_messages(&messages) || has_conversation_messages(&array(session.get("liveTurnMessages")));
            let facts = Facts { now, in_flight, conversation };
            let arg = step["arg"].as_str().unwrap_or_default();
            let done = match op {
                "workflow" => switch_workflow(&mut session, &facts, &surface, arg).await,
                "mode" => switch_mode(&mut session, &facts, &surface, arg).await,
                _ => apply_pending(&mut session, &surface, now).await.map_err(String::from),
            };
            let label = format!("{name} #{i} {op} {arg}");
            match done {
                Ok(switched) => {
                    let got = switched.as_ref().map_or(Value::Null, |s| s.result.clone());
                    assert_eq!(got, step["ok"], "{label}");
                    for boundary in switched.iter().flat_map(|s| &s.boundaries) {
                        record_transcript_boundary(&mut messages, boundary.field, boundary.value.clone(), boundary.same());
                    }
                }
                Err(message) => assert_eq!(json!(message), step["error"], "{label}"),
            }
            assert_eq!(Value::Object(session.clone()), step["session"], "{label}: session");
            let metas: Vec<Value> = messages.iter().map(|m| m.get("meta").cloned().unwrap_or(Value::Null)).collect();
            assert_eq!(Value::Array(metas), step["boundaries"], "{label}: boundaries");
        }
    }
}

// ---- production session state --------------------------------------------------------------------

/// A first run answers and completes; later runs wait to be stopped.
fn answer_then_wait() -> Script {
    let runs = Arc::new(Mutex::new(0_u32));
    Arc::new(move |run| {
        let first = {
            let mut runs = lock(&runs);
            *runs += 1;
            *runs == 1
        };
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            if !first {
                run.cancel.cancelled().await;
                return RunOutcome::Interrupted;
            }
            run.port
                .commit_item(ItemCommit {
                    iid: ItemId::from(format!("a-{}", run.turn)),
                    role: Some("assistant".into()),
                    model: true,
                    visible: true,
                    body: json!({ "text": "answer" }),
                    prompt: None,
                })
                .await
                .expect("commit");
            RunOutcome::Completed(Default::default())
        })
    })
}

struct World {
    rig: Rig,
    directory: Arc<SessionDirectory>,
    switches: SessionSwitchAdapter,
    golden: Value,
}

async fn world() -> World {
    let golden = recording("session-switches.json");
    let rig = Rig::new();
    rig.clock.0.store(golden["now"].as_u64().expect("clock"), std::sync::atomic::Ordering::SeqCst);
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    let switches = SessionSwitchAdapter::new(directory.clone(), Arc::new(Table::of(&golden)));
    World { rig, directory, switches, golden }
}

impl World {
    /// The recorded session of a scenario as a stored thread, without its messages.
    fn scenario_header(&self, name: &str) -> Header {
        let scenario = self.golden["scenarios"].as_array().unwrap().iter().find(|s| s["name"] == name).expect("scenario");
        let mut header = header_of(&scenario["session"]);
        header.shift_remove("messages");
        header.shift_remove("id");
        header.insert("createdAt".into(), json!(1));
        header
    }

    async fn session(&self, id: &str, header: Header) -> Arc<crate::session::SessionHandle> {
        self.directory.create_with_id(ThreadId::from(id), header, json!({})).await.expect("created");
        self.directory.handle(&ThreadId::from(id)).expect("loaded")
    }

    async fn stored(&self, id: &str) -> Header {
        self.directory.stored_header(&ThreadId::from(id)).await.expect("stored")
    }

    /// The last model message of the conversation: where the boundaries land.
    async fn anchor(&self, id: &str) -> Value {
        let context = self.directory.model_context(&ThreadId::from(id)).read().await.expect("context");
        let (iid, message) = context.last().cloned().expect("a message");
        self.amends(id, iid.as_str()).pop().unwrap_or(message)
    }

    /// The bodies the row `iid` was amended to, in order. The in-memory store keeps the amend
    /// records but does not fold them into its model context, so the boundary is read from them.
    fn amends(&self, id: &str, iid: &str) -> Vec<Value> {
        use mixdog_store::schema::blob::Slot;
        use mixdog_store::schema::record::Record;
        self.rig
            .store
            .records(&ThreadId::from(id))
            .into_iter()
            .filter_map(|(_, record)| match record {
                Record::Amend(amend) if amend.iid.as_str() == iid => match amend.body {
                    Slot::Inline(body) => Some(body),
                    Slot::Blob(_) => None,
                },
                _ => None,
            })
            .collect()
    }
}

/// The recorded step `n` of a scenario: its answer and the session keys it left.
fn step(world: &World, name: &str, n: usize) -> Value {
    world.golden["scenarios"].as_array().unwrap().iter().find(|s| s["name"] == name).unwrap()["steps"][n].clone()
}

/// What the stored header holds of the keys the recorded session left.
fn assert_header_has(stored: &Header, recorded: &Value, label: &str) {
    for (key, value) in recorded.as_object().expect("a session") {
        if matches!(key.as_str(), "id" | "messages") {
            continue;
        }
        assert_eq!(stored.get(key), Some(value), "{label}: {key}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn no_session_answers_the_empty_path() {
    let world = world().await;
    assert!(world.switches.settings_reach("").await);
    assert!(world.switches.settings_reach("sess_gone").await);
    assert_eq!(world.switches.switch_workflow("", "beta").await, Ok(None));
    assert_eq!(world.switches.switch_orchestration_mode("sess_gone", "swarm").await, Ok(None));
    // A session without a conversation is rebuilt at its next turn: the setting reaches it, the
    // choice is the configured one's.
    world.session("sess_empty", world.scenario_header("empty-conversation")).await;
    assert!(world.switches.settings_reach("sess_empty").await);
    assert_eq!(world.switches.switch_workflow("sess_empty", "beta").await, Ok(None));
    assert_eq!(world.switches.switch_orchestration_mode("sess_empty", "swarm").await, Ok(None));
    let stored = world.stored("sess_empty").await;
    assert_eq!(stored["workflow"]["id"], "alpha");
    assert!(!stored.contains_key("workflowOverlay"));
}

#[tokio::test(start_paused = true)]
async fn an_idle_conversation_takes_the_switch_now_and_keeps_its_boundary() {
    let world = world().await;
    world.rig.set_script(answer_then_wait());
    let handle = world.session("sess_a", world.scenario_header("idle-workflow-round-trip")).await;
    turn(&handle, "hi", "op-1").await;
    eventually(|| (handle.cell.run.load().is_none() && world.rig.store.records(&ThreadId::from("sess_a")).len() > 4).then_some(())).await;
    assert!(!world.switches.settings_reach("sess_a").await, "a conversation keeps its prompt");

    // alpha -> beta (the prompt carries alpha): an overlay, its notice and the transcript boundary.
    let want = step(&world, "idle-workflow-round-trip", 0);
    let got = world.switches.switch_workflow("sess_a", "beta").await.expect("switched").expect("a conversation");
    assert_eq!(got, want["ok"]);
    assert_header_has(&world.stored("sess_a").await, &want["session"], "beta");
    let anchor = world.anchor("sess_a").await;
    assert_eq!(anchor["meta"]["workflowSwitches"], json!([want["ok"]["workflowSwitch"]]));

    // The same choice again: nothing moves, nothing is recorded twice.
    let again = world.switches.switch_workflow("sess_a", "beta").await.expect("switched").expect("a conversation");
    assert_eq!(again, step(&world, "idle-workflow-round-trip", 1)["ok"]);
    let iid = world.directory.model_context(&ThreadId::from("sess_a")).read().await.expect("context").last().expect("a message").0.clone();
    assert_eq!(world.amends("sess_a", iid.as_str()).len(), 1, "the repeated choice amended nothing");

    // A workflow that is gone is refused with Node's text and changes nothing.
    let gone = world.switches.switch_workflow("sess_a", "nope").await.expect_err("gone");
    assert_eq!(gone, "workflow \"nope\" not found");
    assert_eq!(world.stored("sess_a").await["workflow"]["id"], "beta");

    // The mode, on the workflow's pattern, lands on the same anchor under its own list.
    let mode = world.switches.switch_orchestration_mode("sess_a", "none").await.expect("switched").expect("a conversation");
    assert_eq!(mode["mode"], "none");
    assert_eq!(mode["orchestrationModeSwitch"]["from"], "balanced");
    let stored = world.stored("sess_a").await;
    assert_eq!(stored["orchestrationModeOverlay"]["prompt"], "balanced");
    assert_eq!(world.anchor("sess_a").await["meta"]["orchestrationModeSwitches"][0]["to"], "none");
}

#[tokio::test(start_paused = true)]
async fn a_running_turn_holds_the_choice_for_the_next_one() {
    let world = world().await;
    world.rig.set_script(answer_then_wait());
    let handle = world.session("sess_b", world.scenario_header("in-flight-then-pending")).await;
    turn(&handle, "first", "op-1").await;
    eventually(|| (handle.cell.run.load().is_none() && world.rig.store.records(&ThreadId::from("sess_b")).len() > 4).then_some(())).await;
    turn(&handle, "second", "op-2").await;
    eventually(|| handle.cell.run.load().is_some().then_some(())).await;

    let deferred = world.switches.switch_workflow("sess_b", "beta").await.expect("staged").expect("a conversation");
    assert_eq!(deferred["deferred"], true);
    assert_eq!(deferred["workflow"]["id"], "beta");
    assert_eq!(world.stored("sess_b").await["pendingWorkflowId"], "beta");
    let mode = world.switches.switch_orchestration_mode("sess_b", "swarm").await.expect("staged").expect("a conversation");
    assert_eq!(mode, json!({ "appliedToCurrentSession": true, "deferred": true, "mode": "swarm", "orchestrationModeSwitch": null }));
    // A choice of what the session already runs cancels the held one.
    world.switches.switch_workflow("sess_b", "alpha").await.expect("staged");
    assert!(!world.stored("sess_b").await.contains_key("pendingWorkflowId"));
    world.switches.switch_workflow("sess_b", "beta").await.expect("staged");

    // The turn ends; the next turn start applies what was held, the mode first.
    assert!(world.directory.abort_session_turn(&ThreadId::from("sess_b"), "test"));
    eventually(|| handle.cell.run.load().is_none().then_some(())).await;
    let applied = world.switches.apply_pending_switches(&ThreadId::from("sess_b")).await.expect("applied").expect("held choices");
    assert_eq!(applied["orchestrationModeSwitch"]["to"], "swarm");
    assert_eq!(applied["workflowSwitch"]["toId"], "beta");
    let stored = world.stored("sess_b").await;
    assert_eq!((stored["workflow"]["id"].clone(), stored["orchestrationMode"].clone()), (json!("beta"), json!("swarm")));
    assert!(!stored.contains_key("pendingWorkflowId") && !stored.contains_key("pendingOrchestrationMode"));
    assert_eq!(world.switches.apply_pending_switches(&ThreadId::from("sess_b")).await, Ok(None));
}

#[tokio::test(start_paused = true)]
async fn only_a_coding_session_with_a_prompt_switches() {
    let world = world().await;
    world.rig.set_script(answer_then_wait());
    for (id, scenario, owner) in [("sess_w", "agent-owner", "workflow"), ("sess_old", "too-old", "workflow")] {
        let handle = world.session(id, world.scenario_header(scenario)).await;
        turn(&handle, "hi", "op-1").await;
        eventually(|| handle.cell.run.load().is_none().then_some(())).await;
        let refused = world.switches.switch_workflow(id, "beta").await.expect_err("refused");
        assert_eq!(json!(refused), step(&world, scenario, 0)["error"], "{owner}");
        world.rig.set_script(answer_then_wait());
    }
}

// ---- the context switch ---------------------------------------------------------------------------

#[derive(Default)]
struct Target {
    calls: Mutex<Vec<Value>>,
}

impl ContextTarget for Target {
    fn invalidate(&self, _: &ThreadId) {
        lock(&self.calls).push(json!(["invalidateContextStatusCache"]));
        lock(&self.calls).push(json!(["invalidatePreSessionToolSurface"]));
    }
}

struct NoShells;

impl crate::session::shell_jobs::OwnedShells for NoShells {
    fn cancel_owned(&self, _: &ThreadId) {}
}

struct NoProviders;

#[async_trait]
impl mixdog_ai::registry::providers::ProviderBuilder for NoProviders {
    async fn build(&self, name: &str, _: &Value) -> Result<Arc<dyn mixdog_core_api::domain::provider::ProviderAdapter>, String> {
        Err(format!("no {name}"))
    }
    async fn custom_key_ids(&self, _: &str) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
    fn available(&self, _: &str) -> bool {
        false
    }
    async fn oauth_credentials_usable(&self, _: &str) -> Result<bool, String> {
        Ok(false)
    }
}

fn context_switch(world: &World) -> (SessionContextSwitch, Arc<Target>) {
    let providers = Arc::new(mixdog_ai::registry::providers::ProviderRegistry::new(Arc::new(NoProviders)));
    let read_state = Arc::new(mixdog_tools::fs::ReadState::new(None));
    let shells: Arc<dyn crate::session::shell_jobs::OwnedShells> = Arc::new(NoShells);
    let close = Arc::new(crate::session::close::SessionClose::new(world.directory.clone(), providers.clone(), shells.clone(), read_state.clone()));
    let target = Arc::new(Target::default());
    (SessionContextSwitch::new(world.directory.clone(), close, providers, shells, read_state, target.clone()), target)
}

/// Node's calls of `switchContext` that the daemon does not make, because they retarget the
/// runtime's single session for the next one (decisions.md, "wp-run-host: thread/switchContext
/// retargets no global"): the next thread takes its cwd and desktop session from `thread/start`
/// and resolves the configured Lead route on first read, and Rust has no route-preparation gate
/// to clear.
const DROPPED_CALLS: [&str; 5] = ["clearRoutePreparation", "setDesktopSession", "applyResolvedCwd", "setRoute", "refreshRouteEffort"];

/// The calls that name the thread being left; with no outgoing thread they are not made either.
const OUTGOING_CALLS: [&str; 2] = ["invalidateContextStatusCache", "invalidatePreSessionToolSurface"];

/// Every call of the Node recording is either made for the outgoing thread or one of the dropped
/// ones; with nothing open the target receives none.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_context_switch_makes_the_calls_that_name_the_thread_left_and_drops_the_rest() {
    let world = world().await;
    let (switch, target) = context_switch(&world);
    for (i, case) in recording("context-switch.json")["cases"].as_array().unwrap().iter().enumerate() {
        if case["open"] != json!(false) {
            continue;
        }
        for call in case["calls"].as_array().unwrap() {
            let name = call[0].as_str().unwrap();
            assert!(DROPPED_CALLS.contains(&name) || OUTGOING_CALLS.contains(&name), "case {i}: unexpected recorded call {name}");
        }
        let input = &case["input"];
        let cwd = input.get("cwd").and_then(Value::as_str).map(str::to_owned);
        let desktop = input.get("desktopSession").filter(|d| d.is_object() || d.is_array()).cloned();
        let for_resume = input.get("forResume").is_some_and(|v| mixdog_ai::service::admin_route::truthy(Some(v)));
        lock(&target.calls).clear();
        switch.switch_context("", cwd, desktop, for_resume).await.expect("switched");
        assert!(lock(&target.calls).is_empty(), "case {i}: no open thread, no call");
    }
}
/// The session left: a scratch one is tombstoned, any other stays resumable; both have their
/// memory ingested and their work stopped.
#[tokio::test(start_paused = true)]
async fn the_session_left_is_closed_as_node_closes_it() {
    let world = world().await;
    let cases = recording("context-switch.json");
    let tombstone = |kind: &str| {
        cases["cases"].as_array().unwrap().iter().find(|c| c["open"] == kind).unwrap()["calls"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c[0] == "closeSurfaceSession")
            .map(|c| c[2]["tombstone"].clone())
            .expect("closed")
    };
    assert_eq!((tombstone("scratch"), tombstone("conversation")), (json!(true), json!(false)));
    let (switch, target) = context_switch(&world);

    world.session("sess_scratch", world.scenario_header("empty-conversation")).await;
    switch.switch_context("sess_scratch", Some("/work/a".into()), None, true).await.expect("switched");
    // The closed thread is unloaded and the in-memory store reads its header from the session
    // record alone, so the tombstone is read from the header change it committed.
    let tombstoned = world.rig.store.records(&ThreadId::from("sess_scratch")).into_iter().any(|(_, record)| match record {
        mixdog_store::schema::record::Record::Meta(meta) => match meta.change {
            mixdog_store::schema::blob::Slot::Inline(change) => {
                change.set.get("closed") == Some(&json!(true)) && change.set.get("closedReason") == Some(&json!(CONTEXT_SWITCH_REASON))
            }
            mixdog_store::schema::blob::Slot::Blob(_) => false,
        },
        _ => false,
    });
    assert!(tombstoned, "a scratch session is tombstoned with the context-switch reason");

    world.rig.set_script(answer_then_wait());
    let handle = world.session("sess_used", world.scenario_header("idle-workflow-round-trip")).await;
    turn(&handle, "hi", "op-1").await;
    eventually(|| (handle.cell.run.load().is_none() && world.rig.store.records(&ThreadId::from("sess_used")).len() > 4).then_some(())).await;
    turn(&handle, "again", "op-2").await;
    eventually(|| handle.cell.run.load().is_some().then_some(())).await;
    lock(&target.calls).clear();
    switch.switch_context("sess_used", None, Some(json!({ "id": "d1" })), false).await.expect("switched");
    let kept = world.stored("sess_used").await;
    assert!(kept.get("closed").is_none(), "a conversation stays resumable: {kept:?}");
    eventually(|| handle.cell.run.load().is_none().then_some(())).await;
    eventually(|| lock(&world.rig.closes.seen).iter().any(|(id, _)| id.as_str() == "sess_used").then_some(())).await;
    assert_eq!(
        *lock(&target.calls),
        [json!(["invalidateContextStatusCache"]), json!(["invalidatePreSessionToolSurface"])],
        "the outgoing thread gets the kept calls in Node's order, without the dropped ones"
    );
    let _: Map<String, Value> = kept;
}
