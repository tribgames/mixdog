//! The session half of the thread settings
//! (the pure switches of a pending workflow or mode, and the adapters over the production session directory: the real
//! actor and log over the in-memory store).

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::ids::ItemId;
use mixdog_core_api::ids::ThreadId;
use mixdog_store::schema::record::Header;
use serde_json::Value;
use serde_json::json;

use super::*;
use crate::eventually_on;
use crate::session::ItemCommit;
use crate::session::seams::RunOutcome;
use crate::session::testing::NoProviders;
use crate::session::testing::NoShells;
use crate::session::testing::Rig;
use crate::session::testing::Script;
use crate::session::testing::lock;
use crate::session::tests::turn;

/// The prompt side's stubs: the workflows the surface knows, the standalone tools and the mode texts.
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

    async fn internal_tools(&self, _: &Header) -> Result<Vec<Value>, SurfaceFailure> {
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
    async fn internal_tools(&self, _: &Header) -> Result<Vec<Value>, SurfaceFailure> {
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

// ---- the context switch ---------------------------------------------------------------------------

/// The context cache, recording its call.
struct Cache(Arc<Mutex<Vec<Value>>>);

/// The production target (`GaugeTarget`) over a recording cache; the surface generation it moves is
/// `invalidatePreSessionToolSurface`.
#[derive(Default)]
struct Target {
    calls: Arc<Mutex<Vec<Value>>>,
    generation: mixdog_core_base::surface::SurfaceGeneration,
}
/// A context switch moves the surface generation with the context cache (`context-switch.mjs:56-57`).
#[test]
fn the_gauge_target_moves_the_surface_generation() {
    struct Cache;
    impl ContextStatusCache for Cache {
        fn invalidate(&self, _: &ThreadId) {}
    }
    let generation = mixdog_core_base::surface::SurfaceGeneration::default();
    GaugeTarget(Arc::new(Cache), generation.clone()).invalidate(&ThreadId::from("t"));
    assert_eq!(generation.get(), 1);
}

/// The workflows the surface knows (what each denies and says), the mode texts and the frozen clock the adapters run on.
fn inline_golden() -> Value {
    let workflow = |id: &str, name: &str, denied: Value, orchestration: &str, agents: &str, delegates: bool| {
        json!({ "summary": { "id": id, "name": name, "description": format!("{name} pack"), "source": "built-in", "delegatesAgents": delegates },
            "denied": denied, "packContext": format!("PACK {id}"), "orchestrationContext": orchestration, "agentCatalogContext": agents })
    };
    json!({
        "now": 1_700_000_000_000_u64,
        "workflows": {
            "alpha": workflow("alpha", "Alpha", json!([]), "ORCH alpha", "AGENTS alpha", true),
            "beta": workflow("beta", "Beta", json!(["shell"]), "", "", true),
        },
        "standalone": [],
        "instructions": { "none": "# Orchestration Mode: Solo", "focused": "# Orchestration Mode: Focused", "balanced": "# Orchestration Mode: Balanced", "swarm": "# Orchestration Mode: Swarm" },
    })
}

async fn world() -> World {
    let golden = inline_golden();
    let rig = Rig::new();
    rig.clock.0.store(golden["now"].as_u64().expect("clock"), std::sync::atomic::Ordering::SeqCst);
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    let switches = SessionSwitchAdapter::new(directory.clone(), Arc::new(Table::of(&golden)));
    World { rig, directory, switches }
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
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.run.load().is_none() && world.rig.store.records(&ThreadId::from("sess_a")).len() > 4)
        .then_some(()))
    .await;
    assert!(!world.switches.settings_reach("sess_a").await, "a conversation keeps its prompt");

    // alpha -> beta (the prompt carries alpha): an overlay, its notice and the transcript boundary.
    let switch = json!({ "fromId": "alpha", "from": "Alpha", "toId": "beta", "to": "Beta", "at": 1_700_000_000_000_u64 });
    let got = world.switches.switch_workflow("sess_a", "beta").await.expect("switched").expect("a conversation");
    let beta = json!({ "id": "beta", "name": "Beta", "description": "Beta pack", "source": "built-in", "delegatesAgents": true });
    assert_eq!(got, json!({ "appliedToCurrentSession": true, "workflow": beta, "workflowSwitch": switch }));
    let stored = world.stored("sess_a").await;
    assert_eq!(stored["workflow"], beta);
    assert_eq!(stored["workflowOverlay"]["prompt"]["id"], "alpha", "the prompt still carries alpha, so the choice is an overlay");
    assert_eq!(stored["workflowOverlay"]["deniedTools"], json!(["shell"]));
    assert_eq!(
        stored["workflowSwitch"],
        json!({ "version": 1, "revision": 1, "from": { "id": "alpha", "name": "Alpha" }, "to": { "id": "beta", "name": "Beta" } })
    );
    let anchor = world.anchor("sess_a").await;
    assert_eq!(anchor["meta"]["workflowSwitches"], json!([switch]));

    // The same choice again: nothing moves, nothing is recorded twice.
    let again = world.switches.switch_workflow("sess_a", "beta").await.expect("switched").expect("a conversation");
    assert_eq!(again, json!({ "appliedToCurrentSession": true, "workflow": beta, "workflowSwitch": null }));
    let iid = world.directory.model_context(&ThreadId::from("sess_a")).read().await.expect("context").last().expect("a message").0.clone();
    assert_eq!(world.amends("sess_a", iid.as_str()).len(), 1, "the repeated choice amended nothing");

    // A workflow that is gone is refused with its own text and changes nothing.
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

    // Each switch republishes the thread's workflow state (`publishRoute()`): the session's workflow and mode, none pending.
    let shown = json!({ "workflow": stored["workflow"], "orchestrationMode": "none", "pendingWorkflowSwitch": false, "pendingOrchestrationModeSwitch": false });
    world.shows_workflow("sess_a", shown).await;
}
#[tokio::test(start_paused = true)]
async fn a_running_turn_holds_the_choice_for_the_next_one() {
    let world = world().await;
    world.rig.set_script(answer_then_wait());
    let handle = world.session("sess_b", world.scenario_header("in-flight-then-pending")).await;
    turn(&handle, "first", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.run.load().is_none() && world.rig.store.records(&ThreadId::from("sess_b")).len() > 4)
        .then_some(()))
    .await;
    turn(&handle, "second", "op-2").await;
    eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load().is_some().then_some(())).await;

    let deferred = world.switches.switch_workflow("sess_b", "beta").await.expect("staged").expect("a conversation");
    assert_eq!(deferred["deferred"], true);
    assert_eq!(deferred["workflow"]["id"], "beta");
    assert_eq!(world.stored("sess_b").await["pendingWorkflowId"], "beta");
    let mode = world.switches.switch_orchestration_mode("sess_b", "swarm").await.expect("staged").expect("a conversation");
    assert_eq!(mode, json!({ "appliedToCurrentSession": true, "deferred": true, "mode": "swarm", "orchestrationModeSwitch": null }));
    // A choice of what the session already runs cancels the held one.
    world.switches.switch_workflow("sess_b", "alpha").await.expect("staged");
    assert!(!world.stored("sess_b").await.contains_key("pendingWorkflowId"));
    assert!(!world.stored("sess_b").await.contains_key("pendingWorkflow"), "the meta leaves with the cancelled id");
    world.switches.switch_workflow("sess_b", "beta").await.expect("staged");
    assert_eq!(world.stored("sess_b").await["pendingWorkflow"], deferred["workflow"], "the staged meta is kept with its id, so a restart shows it");
    // The held choices show at once, marked pending (`routeState`: the staged workflow's meta, `pendingOrchestrationMode`).
    let held = json!({ "workflow": deferred["workflow"], "orchestrationMode": "swarm", "pendingWorkflowSwitch": true, "pendingOrchestrationModeSwitch": true });
    world.shows_workflow("sess_b", held).await;
    // A held workflow is never shown as the old one marked pending: the one `publishRoute()` shows the staged summary.
    let pending_shown: Vec<Value> = world
        .rig
        .feeds
        .frames("sess_b")
        .into_iter()
        .filter(|(_, method, params)| method == "thread/workflow/updated" && params["value"]["pendingWorkflowSwitch"] == json!(true))
        .map(|(_, _, params)| params["value"]["workflow"]["id"].clone())
        .collect();
    assert!(!pending_shown.is_empty() && pending_shown.iter().all(|id| id == "beta"), "{pending_shown:?}");

    // The turn ends; the next turn start applies what was held, the mode first.
    assert!(world.directory.abort_session_turn(&ThreadId::from("sess_b"), "test"));
    eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load().is_none().then_some(())).await;
    let applied = world.switches.apply_pending_switches(&ThreadId::from("sess_b")).await.expect("applied").expect("held choices");
    assert_eq!(applied["orchestrationModeSwitch"]["to"], "swarm");
    assert_eq!(applied["workflowSwitch"]["toId"], "beta");
    let stored = world.stored("sess_b").await;
    assert_eq!((stored["workflow"]["id"].clone(), stored["orchestrationMode"].clone()), (json!("beta"), json!("swarm")));
    assert!(!stored.contains_key("pendingWorkflowId") && !stored.contains_key("pendingOrchestrationMode") && !stored.contains_key("pendingWorkflow"));
    let applied_state =
        json!({ "workflow": stored["workflow"], "orchestrationMode": "swarm", "pendingWorkflowSwitch": false, "pendingOrchestrationModeSwitch": false });
    world.shows_workflow("sess_b", applied_state).await;
    assert_eq!(world.switches.apply_pending_switches(&ThreadId::from("sess_b")).await, Ok(None));
}
#[tokio::test(start_paused = true)]
async fn only_a_coding_session_with_a_prompt_switches() {
    let world = world().await;
    world.rig.set_script(answer_then_wait());
    for (id, scenario, want) in [
        ("sess_w", "agent-owner", "Only a coding session has a workflow."),
        ("sess_old", "too-old", "This session is too old to switch its workflow; start a new task."),
    ] {
        let handle = world.session(id, world.scenario_header(scenario)).await;
        turn(&handle, "hi", "op-1").await;
        eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load().is_none().then_some(())).await;
        let refused = world.switches.switch_workflow(id, "beta").await.expect_err("refused");
        assert_eq!(refused, want, "{scenario}");
        assert!(!world.stored(id).await.contains_key("workflowOverlay"), "{scenario}: nothing changed");
        world.rig.set_script(answer_then_wait());
    }
}
fn context_switch(world: &World) -> (SessionContextSwitch, Arc<Target>) {
    let providers = Arc::new(mixdog_ai::registry::providers::ProviderRegistry::new(Arc::new(NoProviders)));
    let read_state = Arc::new(mixdog_tools::fs::ReadState::new(None));
    let shells: Arc<dyn crate::session::shell_jobs::OwnedShells> = Arc::new(NoShells);
    let close = Arc::new(crate::session::close::SessionClose::new(world.directory.clone(), providers.clone(), shells.clone(), read_state.clone()));
    let target = Arc::new(Target::default());
    (SessionContextSwitch::new(world.directory.clone(), close, target.clone()), target)
}
/// A switch with no thread open (a start, or a client that held none) invalidates nothing and closes nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_context_switch_with_no_thread_open_makes_no_call_for_a_thread() {
    let world = world().await;
    let (switch, target) = context_switch(&world);
    for (cwd, desktop, for_resume) in [(None, None, false), (Some("/work/a".to_owned()), None, true), (None, Some(json!({ "id": "d1" })), false)] {
        lock(&target.calls).clear();
        switch.switch_context("", cwd, desktop, for_resume).await.expect("switched");
        assert!(lock(&target.calls).is_empty(), "no open thread, no call");
    }
}

/// The session left: a scratch one is tombstoned, any other stays resumable; both have their
/// memory ingested and their work stopped.
#[tokio::test(start_paused = true)]
async fn the_session_left_is_tombstoned_only_when_it_is_a_scratch_one() {
    let world = world().await;
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
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.run.load().is_none() && world.rig.store.records(&ThreadId::from("sess_used")).len() > 4)
        .then_some(()))
    .await;
    turn(&handle, "again", "op-2").await;
    eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load().is_some().then_some(())).await;
    lock(&target.calls).clear();
    switch.switch_context("sess_used", None, Some(json!({ "id": "d1" })), false).await.expect("switched");
    let kept = world.stored("sess_used").await;
    assert!(kept.get("closed").is_none(), "a conversation stays resumable: {kept:?}");
    assert_eq!(kept.get("detachedReason"), Some(&json!(CONTEXT_SWITCH_REASON)), "but it is detached, as a close that is not a tombstone does: {kept:?}");
    assert!(kept.get("generation").and_then(Value::as_f64).is_some_and(|generation| generation >= 1.0), "which moves its generation on: {kept:?}");
    eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load().is_none().then_some(())).await;
    eventually_on!(&[&*world.rig.closes.ended], || lock(&world.rig.closes.seen).iter().any(|(id, _)| id.as_str() == "sess_used").then_some(())).await;
    assert_eq!(
        *lock(&target.calls),
        [json!(["invalidateContextStatusCache"]), json!(["invalidatePreSessionToolSurface"])],
        "the outgoing thread gets its context status and tool surface invalidated, in that order"
    );
}
/// Teardown closes each runtime's own session and no worker's (`closeOwnSession`, `teardown.mjs:258`): the conversation
/// is detached (its generation moves on, `detachedReason` is the stop's), a worker session keeps what the agents' close
/// left, and a worker not detached before is not detached by the exit.
#[tokio::test(start_paused = true)]
async fn the_exit_closes_the_runtimes_own_session_and_no_worker() {
    let world = world().await;
    let providers = Arc::new(mixdog_ai::registry::providers::ProviderRegistry::new(Arc::new(NoProviders)));
    let close = Arc::new(crate::session::close::SessionClose::new(
        world.directory.clone(),
        providers,
        Arc::new(NoShells),
        Arc::new(mixdog_tools::fs::ReadState::new(None)),
    ));
    world.directory.set_exit_close(close.clone()).map_err(|_| "bound").expect("bound once");

    world.rig.set_script(answer_then_wait());
    let mut worker_header = world.scenario_header("idle-workflow-round-trip");
    worker_header.insert("owner".into(), json!("agent"));
    let mut handles = Vec::new();
    for (id, header) in
        [("sess_lead", world.scenario_header("idle-workflow-round-trip")), ("sess_worker", worker_header.clone()), ("sess_detached", worker_header)]
    {
        let handle = world.session(id, header).await;
        turn(&handle, "hi", "op-1").await;
        eventually_on!(&[&handle.cell.stepped], || (handle.cell.run.load().is_none() && world.rig.store.records(&ThreadId::from(id)).len() > 4).then_some(()))
            .await;
        handles.push(handle);
    }
    // The agents' close ran first and detached this worker.
    assert!(close.detach("sess_detached", "cli-agent-close", true).await);
    let before = world.stored("sess_detached").await;
    let generation = |header: &Header| header.get("generation").and_then(Value::as_f64).unwrap_or(0.0);

    world.directory.shutdown_for("no live session clients").await;

    let lead = world.stored("sess_lead").await;
    assert_eq!(lead.get("detachedReason"), Some(&json!("no live session clients")), "{lead:?}");
    assert_eq!(generation(&lead), 1.0, "the runtime's own session is detached once: {lead:?}");
    assert!(lead.get("closed").is_none(), "and stays resumable: {lead:?}");
    let worker = world.stored("sess_worker").await;
    assert_eq!(
        (generation(&worker), worker.get("detachedReason")),
        (0.0, None),
        "a worker the agents' close did not detach is not detached by the exit: {worker:?}"
    );
    let detached = world.stored("sess_detached").await;
    assert_eq!(generation(&detached), generation(&before), "a detached worker gets no second bump: {detached:?}");
    assert_eq!(detached.get("detachedReason"), Some(&json!("cli-agent-close")));
}

// ---- production session state --------------------------------------------------------------------

/// Each thread's first run answers and completes; its later runs wait to be stopped.
fn answer_then_wait() -> Script {
    let answered = Arc::new(Mutex::new(std::collections::HashSet::new()));
    Arc::new(move |run| {
        let first = lock(&answered).insert(run.thread.clone());
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
}
impl World {
    /// The stored header of a thread in the named state: a coding conversation that has answered, a thread with no conversation
    /// yet, an agent worker, or a conversation older than the workflow switch.
    fn scenario_header(&self, name: &str) -> Header {
        let mut header = header_of(&json!({
            "promptIdentity": { "v": 1 },
            "workflow": { "id": "alpha", "name": "Alpha", "description": "Alpha pack", "source": "built-in", "delegatesAgents": true },
            "orchestrationMode": "balanced",
            "tools": [{ "name": "shell", "description": "Run" }, { "name": "read", "description": "Read" }],
            "deferredToolCatalog": [{ "name": "agent", "description": "Delegate work" }, { "name": "recall", "description": "Recall" }],
            "disallowedTools": [],
            "createdAt": 1
        }));
        match name {
            "agent-owner" => {
                header.insert("owner".into(), json!("agent"));
            }
            "too-old" => {
                header.shift_remove("promptIdentity");
            }
            _ => {}
        }
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

    /// The thread's workflow state as it published it last (`thread/workflow/updated`), once it is `want`.
    async fn shows_workflow(&self, id: &str, want: Value) {
        let newest = || {
            self.rig.feeds.frames(id).into_iter().rev().find(|(_, method, _)| method == "thread/workflow/updated").map(|(_, _, params)| params["value"].clone())
        };
        eventually_on!(&[&self.rig.feeds.published], || (newest().as_ref() == Some(&want)).then_some(())).await;
    }
}

impl ContextStatusCache for Cache {
    fn invalidate(&self, _: &ThreadId) {
        lock(&self.0).push(json!(["invalidateContextStatusCache"]));
    }
}
impl ContextTarget for Target {
    fn invalidate(&self, thread: &ThreadId) {
        let before = self.generation.get();
        GaugeTarget(Arc::new(Cache(self.calls.clone())), self.generation.clone()).invalidate(thread);
        if self.generation.get() != before {
            lock(&self.calls).push(json!(["invalidatePreSessionToolSurface"]));
        }
    }
}
