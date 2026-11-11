//! The configured route values and the settings announcement: Node's initial state holds `baseRouteState()` from its first read
//! (no frame announces it), and `setupChanged` counts each settings change the runtime announced (`notification-router.mjs`).

use std::sync::Arc;

use mixdog_app_protocol::v2::thread::ThreadContext;
use mixdog_app_protocol::v2::thread::ThreadRoute;
use mixdog_core_api::RunControl;
use mixdog_core_api::ids::TurnId;
use mixdog_core_ports::ports::threads::Section;
use serde_json::Value;
use serde_json::json;

use super::SessionDirectory;
use super::seams::RunOutcome;
use super::testing::Rig;
use super::testing::lock;
use crate::eventually_on;
use super::tests::idle;
use super::tests::start_thread;
use super::tests::turn;

fn newest(rig: &Rig, thread: &str, method: &str) -> Option<Value> {
    rig.feeds.frames(thread).into_iter().rev().find(|(_, name, _)| name == method).map(|(_, _, params)| params["value"].clone())
}

/// What Node recorded for `setupChanged` (`testdata/node-setup-changed.json`): the value its session published for a thread started with a
/// draft route (the real-turn harness's recording), and the `seq` of each of two settings announcements delivered before the state was read
/// (`testdata/record-setup-changed.mjs` runs Node's own modules through them; the state ends on the last).
fn node_setup_changed() -> (Value, Vec<u64>) {
    let recorded: Value = serde_json::from_str(include_str!("../../testdata/node-setup-changed.json")).expect("the recording parses");
    let deliveries = &recorded["twoDeliveries"];
    let seqs: Vec<u64> = deliveries["published"].as_array().expect("the recorded deliveries").iter().map(|delivery| delivery["seq"].as_u64().expect("a seq")).collect();
    assert_eq!(deliveries["final"]["seq"].as_u64(), seqs.last().copied(), "the recorded state is the last delivery");
    (recorded["frame"]["patch"]["set"]["setupChanged"].clone(), seqs)
}

/// The `seq` of each `setupChanged` the thread's feed published, in order, each once (later runtime frames carry the held value again).
fn published_setup_seqs(rig: &Rig, thread: &str) -> Vec<u64> {
    let mut seqs: Vec<u64> = rig
        .feeds
        .frames(thread)
        .into_iter()
        .filter(|(_, method, _)| method == "thread/runtime/updated")
        .filter_map(|(_, _, params)| params["value"]["setupChanged"]["seq"].as_u64())
        .collect();
    seqs.dedup();
    seqs
}

/// An installed session holds the configured route values in its state, and publishes no route frame to say so; the next route
/// frame carries them.
#[tokio::test(start_paused = true)]
async fn the_configured_route_values_are_state_from_install_and_no_frame() {
    let rig = Rig::new();
    let auto_clear = json!({ "enabled": true, "idleMs": 3_600_000, "custom": false });
    let system_shell = json!({ "source": "auto", "command": "", "effective": "" });
    let web_search_route = json!({ "provider": "default", "model": "default" });
    *lock(&rig.compaction.route) = ThreadRoute {
        auto_clear: Some(auto_clear.clone()),
        system_shell: Some(system_shell.clone()),
        web_search_route: Some(web_search_route.clone()),
        ..Default::default()
    };
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    assert_eq!(newest(&rig, handle.id.as_str(), "thread/route/updated"), None, "install publishes no route frame");
    handle.set_section(Section::Route(ThreadRoute { effort: Some("high".into()), ..Default::default() })).await.expect("route");
    let route = eventually_on!(&[&handle.cell.stepped], || newest(&rig, handle.id.as_str(), "thread/route/updated")).await;
    assert_eq!((&route["autoClear"], &route["systemShell"], &route["webSearchRoute"]), (&auto_clear, &system_shell, &web_search_route));
}

/// A route written into the header (`updateSessionRoute`) moves the route state: `provider`, `model` and the session's own
/// (`sessionProvider`, `sessionModel`) follow, and the values read under the provider (`autoClear`) are read again.
#[tokio::test(start_paused = true)]
async fn a_route_written_into_the_header_moves_the_route_state() {
    let rig = Rig::new();
    let auto_clear = json!({ "enabled": true, "provider": "anthropic-oauth" });
    *lock(&rig.compaction.route) = ThreadRoute { auto_clear: Some(auto_clear.clone()), ..Default::default() };
    let directory = SessionDirectory::new(rig.deps());
    let handle = super::tests::start_routed_thread(&directory).await;
    let route = eventually_on!(&[&handle.cell.stepped], || newest(&rig, handle.id.as_str(), "thread/route/updated")).await;
    assert_eq!(
        (&route["provider"], &route["model"], &route["sessionProvider"], &route["sessionModel"], &route["autoClear"]),
        (&json!(super::tests::ROUTE_PROVIDER), &json!(super::tests::ROUTE_MODEL), &json!(super::tests::ROUTE_PROVIDER), &json!(super::tests::ROUTE_MODEL), &auto_clear)
    );
}

/// The context a run's pressure check publishes: the window, and the display fields Node's `syncContextDisplayFields` sets once a turn
/// that was not cancelled has measured its context.
fn pressure() -> ThreadContext {
    ThreadContext {
        context_window: Some(9_000),
        display_context_window: Some(9_000),
        auto_compact_token_limit: Some(7_000),
        compact_boundary_tokens: Some(8_000),
        ..Default::default()
    }
}

/// Runs one turn whose run publishes [`pressure`] and then ends as `interrupted` or completed; the thread's context afterwards.
async fn context_after_turn(interrupted: bool) -> ThreadContext {
    let rig = Rig::new();
    rig.set_script(Arc::new(move |run| {
        Box::pin(async move {
            run.port.section(Section::Context(pressure())).await.expect("pressure");
            if interrupted {
                run.cancel.cancelled().await;
                RunOutcome::Interrupted
            } else {
                RunOutcome::Completed(Default::default())
            }
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let started = turn(&handle, "measure", "op-1").await;
    // The window is published while the turn runs; the display fields are not.
    let published = eventually_on!(&[&handle.cell.stepped], || newest(&rig, handle.id.as_str(), "thread/context/updated").filter(|context| context["contextWindow"] == json!(9_000))).await;
    if interrupted {
        assert_eq!(published["displayContextWindow"], json!(0), "a running turn has not published its display fields");
        handle.interrupt(&TurnId::from(started["turnId"].as_str().expect("turn id")), None).expect("interrupt");
    }
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    handle.cell.view.load_full().state.context.clone().expect("context")
}

/// Node's `syncContextDisplayFields` runs with the measurement of a turn that was not cancelled: a cancelled turn leaves the display
/// fields at their initial 0, a completed one publishes them.
#[tokio::test(start_paused = true)]
async fn a_cancelled_turn_leaves_the_context_display_fields_and_a_completed_one_publishes_them() {
    let cancelled = context_after_turn(true).await;
    assert_eq!(
        (cancelled.display_context_window, cancelled.auto_compact_token_limit, cancelled.compact_boundary_tokens),
        (Some(0), Some(0), Some(0))
    );
    let completed = context_after_turn(false).await;
    assert_eq!(
        (completed.display_context_window, completed.auto_compact_token_limit, completed.compact_boundary_tokens),
        (Some(9_000), Some(7_000), Some(8_000))
    );
}

/// A context gauge whose status is slow (one second on the injected clock) and follows the model of the header it is read for: the
/// route window of `wide` is 200000 with a trigger of 190000, any other model's 100000 with 90000. The load's pass reads nothing.
struct SlowStatus;

const STATUS_DELAY: std::time::Duration = std::time::Duration::from_secs(1);

fn figures_of(model: &str) -> (i64, i64) {
    if model == "wide" { (200_000, 190_000) } else { (100_000, 90_000) }
}

#[async_trait::async_trait]
impl super::thread_context::ContextStatusHost for SlowStatus {
    async fn context_status(&self, _: Option<mixdog_core_api::ids::ThreadId>, _: Option<Value>) -> Result<Value, mixdog_core_api::error::CoreError> {
        tokio::time::sleep(STATUS_DELAY).await;
        Ok(Value::Null)
    }

    async fn context_status_for(&self, _: mixdog_core_api::ids::ThreadId, header: serde_json::Map<String, Value>) -> Result<Value, mixdog_core_api::error::CoreError> {
        tokio::time::sleep(STATUS_DELAY).await;
        let (window, trigger) = figures_of(header.get("model").and_then(Value::as_str).unwrap_or_default());
        Ok(json!({ "contextWindow": window, "compaction": { "boundaryTokens": window, "triggerTokens": trigger } }))
    }
}

/// The model and the compaction trigger a state shows.
fn model_and_trigger(state: &Value) -> (Value, Value) {
    (state["route"]["model"].clone(), state["context"]["autoCompactTokenLimit"].clone())
}

/// A model switch (`updateSessionRoute` writing the new route into the header) shows the new route's figures with the new model:
/// Node's `setRoute` runs `syncContextStats` before `publishRoute` (routes-write.mjs:133-142). With the status read slow, every frame
/// and every read that shows the new model shows its trigger, and the switch answers only once that state is out.
#[tokio::test(start_paused = true)]
async fn a_model_switch_shows_the_new_routes_figures_with_the_new_model() {
    let rig = Rig::new();
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.context_status = Arc::new(SlowStatus);
    let directory = SessionDirectory::new(Arc::new(deps));
    let handle = super::tests::start_routed_thread(&directory).await;
    let state = || serde_json::to_value(&handle.cell.view.load_full().state).expect("state");
    assert_eq!(model_and_trigger(&state()), (json!(super::tests::ROUTE_MODEL), json!(figures_of(super::tests::ROUTE_MODEL).1)));
    let params = json!({ "threadId": handle.id, "set": { "model": "wide", "contextWindow": 200_000 }, "unset": ["autoCompactTokenLimit"] });
    let switch = mixdog_core_api::ThreadHandle::request(&*handle, mixdog_core_api::CoreRequest {
        method: mixdog_core_api::ids::Method("thread/header/patch"),
        params,
        op: None,
        ctx: mixdog_core_api::call::CallContext::internal("test"),
    });
    tokio::pin!(switch);
    // While the new route's status is read, reads show the old route whole.
    assert!(tokio::time::timeout(STATUS_DELAY / 2, switch.as_mut()).await.is_err(), "the switch answers after its figures");
    assert_eq!(model_and_trigger(&state()), (json!(super::tests::ROUTE_MODEL), json!(figures_of(super::tests::ROUTE_MODEL).1)));
    switch.await.expect("switched");
    assert_eq!(model_and_trigger(&state()), (json!("wide"), json!(figures_of("wide").1)), "the answer follows the new state");
    // The frames folded in order, as a client holds them: the new model never shows without its trigger.
    let (mut model, mut trigger) = (Value::Null, Value::Null);
    let mut shown = false;
    for (_, method, params) in rig.feeds.frames(handle.id.as_str()) {
        match method.as_str() {
            "thread/route/updated" => model = params["value"]["model"].clone(),
            "thread/context/updated" => trigger = params["value"]["autoCompactTokenLimit"].clone(),
            _ => continue,
        }
        if model == json!("wide") {
            shown = true;
            assert_eq!(trigger, json!(figures_of("wide").1), "a frame shows the new model with the old trigger");
        }
    }
    assert!(shown, "the switch was published");
}

/// A context gauge whose route-move reads wait until the test lets them through ([`GatedStatus::open`]) and then answer the figures
/// of the header's model, or fail when `fail` is set; `passes` counts the status passes (`context_status`), which read nothing.
struct GatedStatus {
    gate: tokio::sync::Semaphore,
    fail: std::sync::atomic::AtomicBool,
    held: std::sync::atomic::AtomicUsize,
    passes: std::sync::atomic::AtomicUsize,
    /// Told when a read comes to the gate: the read runs off the actor, so no step of the thread announces it.
    arrived: tokio::sync::Notify,
}

impl GatedStatus {
    fn new() -> Arc<Self> {
        Arc::new(Self { gate: tokio::sync::Semaphore::new(0), fail: Default::default(), held: Default::default(), passes: Default::default(), arrived: Default::default() })
    }

    fn open(&self, reads: usize) {
        self.gate.add_permits(reads);
    }

    fn held(&self) -> usize {
        self.held.load(std::sync::atomic::Ordering::SeqCst)
    }
}

#[async_trait::async_trait]
impl super::thread_context::ContextStatusHost for GatedStatus {
    async fn context_status(&self, _: Option<mixdog_core_api::ids::ThreadId>, _: Option<Value>) -> Result<Value, mixdog_core_api::error::CoreError> {
        self.passes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(Value::Null)
    }

    async fn context_status_for(&self, _: mixdog_core_api::ids::ThreadId, header: serde_json::Map<String, Value>) -> Result<Value, mixdog_core_api::error::CoreError> {
        self.held.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.arrived.notify_waiters();
        self.gate.acquire().await.expect("the gate stays open").forget();
        self.held.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        if self.fail.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(mixdog_core_api::error::CoreError::Internal { incident_id: "test-status-failed".into() });
        }
        let (window, trigger) = figures_of(header.get("model").and_then(Value::as_str).unwrap_or_default());
        Ok(json!({ "contextWindow": window, "compaction": { "boundaryTokens": window, "triggerTokens": trigger } }))
    }
}

/// A rig whose thread runs on [`GatedStatus`], started on its route (the start's own move let through).
async fn gated_thread(rig: &Rig, status: &Arc<GatedStatus>) -> (Arc<SessionDirectory>, Arc<super::SessionHandle>) {
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.context_status = status.clone();
    let directory = Arc::new(SessionDirectory::new(Arc::new(deps)));
    // The start's move reads only when it is one; a permit given ahead would be left for the test's own move when it is not.
    let mut start = tokio::spawn({
        let directory = directory.clone();
        async move { super::tests::start_routed_thread(&directory).await }
    });
    loop {
        let arrived = status.arrived.notified();
        tokio::pin!(arrived);
        arrived.as_mut().enable();
        if status.held() == 1 {
            status.open(1);
        }
        tokio::select! {
            biased;
            handle = &mut start => return (directory, handle.expect("started")),
            () = arrived => {}
        }
    }
}

/// `thread/header/patch` of the thread's route (`updateSessionRoute`).
fn move_route<'a>(handle: &'a super::SessionHandle, model: &'a str) -> impl std::future::Future<Output = Result<mixdog_core_api::Reply, mixdog_core_api::error::CoreError>> + 'a {
    let params = json!({ "threadId": handle.id, "set": { "model": model }, "unset": ["autoCompactTokenLimit"] });
    mixdog_core_api::ThreadHandle::request(handle, mixdog_core_api::CoreRequest {
        method: mixdog_core_api::ids::Method("thread/header/patch"),
        params,
        op: None,
        ctx: mixdog_core_api::call::CallContext::internal("test"),
    })
}

/// Waits until `count` route-move reads are held at the gate.
async fn held(handle: &super::SessionHandle, status: &GatedStatus, count: usize) {
    eventually_on!(&[&handle.cell.stepped, &status.arrived], || (status.held() == count).then_some(())).await;
}

/// A route move whose status read is held leaves the thread serving: a `thread/read` is answered, a turn starts on the route the
/// thread holds and its cancel ends it, all before the move is written; the move then lands with its figures.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pending_route_move_leaves_the_thread_serving() {
    let rig = Rig::new();
    rig.set_script(Arc::new(|run| {
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            run.cancel.cancelled().await;
            RunOutcome::Interrupted
        })
    }));
    let status = GatedStatus::new();
    let (_directory, handle) = gated_thread(&rig, &status).await;
    let state = || serde_json::to_value(&handle.cell.view.load_full().state).expect("state");
    let switch = tokio::spawn({
        let handle = handle.clone();
        async move { move_route(&handle, "wide").await }
    });
    held(&handle, &status, 1).await;

    let read = mixdog_core_api::CoreRequest {
        method: mixdog_core_api::ids::Method("thread/read"),
        params: json!({ "threadId": handle.id }),
        op: None,
        ctx: mixdog_core_api::call::CallContext::internal("test"),
    };
    let answered = tokio::time::timeout(std::time::Duration::from_secs(5), mixdog_core_api::ThreadHandle::request(&*handle, read)).await;
    assert!(matches!(answered, Ok(Ok(_))), "thread/read is answered while the move is pending");
    let started = turn(&handle, "go", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || handle.cell.busy.load(std::sync::atomic::Ordering::SeqCst).then_some(())).await;
    assert_eq!(model_and_trigger(&state()).0, json!(super::tests::ROUTE_MODEL), "the turn starts on the route the thread holds");
    handle.interrupt(&TurnId::from(started["turnId"].as_str().expect("turn id")), None).expect("interrupt");
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    assert_eq!(status.held(), 1, "the cancel was served while the read was held");
    assert!(!switch.is_finished(), "the move answers after its figures");

    status.open(1);
    switch.await.expect("joined").expect("switched");
    assert_eq!(model_and_trigger(&state()), (json!("wide"), json!(figures_of("wide").1)));
}

/// Two route moves in a row are written in order, each with its figures, and the thread ends on the second.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_route_moves_in_a_row_end_on_the_second_with_its_figures() {
    let rig = Rig::new();
    let status = GatedStatus::new();
    let (_directory, handle) = gated_thread(&rig, &status).await;
    let first = tokio::spawn({
        let handle = handle.clone();
        async move { move_route(&handle, "wide").await }
    });
    held(&handle, &status, 1).await;
    let second = tokio::spawn({
        let handle = handle.clone();
        async move { move_route(&handle, "narrow").await }
    });
    // The second waits behind the first: its read starts only once the first is written.
    tokio::task::yield_now().await;
    assert_eq!(status.held(), 1);
    status.open(2);
    first.await.expect("joined").expect("first");
    second.await.expect("joined").expect("second");
    let state = serde_json::to_value(&handle.cell.view.load_full().state).expect("state");
    assert_eq!(model_and_trigger(&state), (json!("narrow"), json!(figures_of("narrow").1)));
    let (mut model, mut trigger, mut models) = (Value::Null, Value::Null, Vec::new());
    // A step publishes the move's figures ahead of its route: each route frame shows the figures of its own model.
    for (_, method, params) in rig.feeds.frames(handle.id.as_str()) {
        match method.as_str() {
            "thread/route/updated" => model = params["value"]["model"].clone(),
            "thread/context/updated" => {
                trigger = params["value"]["autoCompactTokenLimit"].clone();
                continue;
            }
            _ => continue,
        }
        if let Some(name) = model.as_str() {
            assert_eq!(trigger, json!(figures_of(name).1), "a frame shows {name} with another route's trigger");
            if models.last() != Some(&model) {
                models.push(model.clone());
            }
        }
    }
    assert_eq!(models, vec![json!(super::tests::ROUTE_MODEL), json!("wide"), json!("narrow")]);
}

/// A route move through the route write (`write_route`: `update_header_awaiting`, the route's hops and a session's own pick) is the
/// same pending step: written once its figures are read, with them.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_route_write_moves_with_its_figures() {
    let rig = Rig::new();
    let status = GatedStatus::new();
    let (directory, handle) = gated_thread(&rig, &status).await;
    let update: super::actor::AwaitingHeaderUpdate = Box::new(|_| {
        Box::pin(async move {
            mixdog_store::schema::record::HeaderChange { set: [("model".to_owned(), json!("wide"))].into_iter().collect(), unset: vec!["autoCompactTokenLimit".to_owned()] }
        })
    });
    let write = tokio::spawn({
        let (directory, id) = (directory.clone(), handle.id.clone());
        async move { directory.update_header_awaiting(&id, update).await }
    });
    held(&handle, &status, 1).await;
    let state = || serde_json::to_value(&handle.cell.view.load_full().state).expect("state");
    assert_eq!(model_and_trigger(&state()).0, json!(super::tests::ROUTE_MODEL), "not written before its figures");
    status.open(1);
    write.await.expect("joined").expect("written");
    let frames: Vec<_> = rig.feeds.frames(handle.id.as_str()).into_iter().map(|(_, method, params)| (method, params)).collect();
    assert_eq!(model_and_trigger(&state()), (json!("wide"), json!(figures_of("wide").1)), "frames: {frames:?}");
}

/// A route move whose status read fails is written as Node publishes a route its runtime has no status for (`syncContextStats` patches
/// nothing, `routeState` shows 0 for a moved window, context-state.mjs:100-113,137-142), and nothing is read again for it.
#[tokio::test(start_paused = true)]
async fn a_route_move_whose_status_read_fails_shows_route_states_figures_and_reads_nothing_more() {
    let rig = Rig::new();
    let status = GatedStatus::new();
    let (_directory, handle) = gated_thread(&rig, &status).await;
    tokio::time::advance(super::actor::STATUS_SETTLE * 2).await;
    eventually_on!(&[&handle.cell.stepped], || (status.passes.load(std::sync::atomic::Ordering::SeqCst) == 1).then_some(())).await;
    status.fail.store(true, std::sync::atomic::Ordering::SeqCst);
    status.open(1);
    let params = json!({ "threadId": handle.id, "set": { "model": "wide", "contextWindow": 200_000 }, "unset": ["autoCompactTokenLimit"] });
    mixdog_core_api::ThreadHandle::request(&*handle, mixdog_core_api::CoreRequest {
        method: mixdog_core_api::ids::Method("thread/header/patch"),
        params,
        op: None,
        ctx: mixdog_core_api::call::CallContext::internal("test"),
    })
    .await
    .expect("the move is written");
    let state = serde_json::to_value(&handle.cell.view.load_full().state).expect("state");
    assert_eq!(model_and_trigger(&state), (json!("wide"), json!(0)));
    assert_eq!((&state["context"]["displayContextWindow"], &state["context"]["compactBoundaryTokens"]), (&json!(0), &json!(0)));
    tokio::time::advance(super::actor::STATUS_SETTLE * 4).await;
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    assert_eq!(status.passes.load(std::sync::atomic::Ordering::SeqCst), 1, "no status pass follows the failed read");
}

/// Each announced settings change moves `setupChanged` (`{ action: 'settings_changed', seq, at }`, `seq` counting the thread's changes), and
/// the route section follows the saved configuration.
#[tokio::test(start_paused = true)]
async fn each_announced_settings_change_moves_setup_changed() {
    let rig = Rig::new();
    let (announce, changes) = tokio::sync::watch::channel(0_u64);
    *lock(&rig.compaction.settings) = Some(changes);
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let seq_of = |value: Option<Value>| value.and_then(|runtime| runtime["setupChanged"]["seq"].as_u64());
    assert_eq!(seq_of(newest(&rig, handle.id.as_str(), "thread/runtime/updated")), None, "nothing is announced before a change");
    let (recorded, seqs) = node_setup_changed();
    announce.send_modify(|count| *count += 1);
    let first = eventually_on!(&[&handle.cell.stepped], || newest(&rig, handle.id.as_str(), "thread/runtime/updated").filter(|runtime| runtime["setupChanged"]["seq"] == recorded["seq"])).await;
    assert_eq!(first["setupChanged"]["action"], recorded["action"]);
    announce.send_modify(|count| *count += 1);
    eventually_on!(&[&handle.cell.stepped], || newest(&rig, handle.id.as_str(), "thread/runtime/updated").filter(|runtime| runtime["setupChanged"]["seq"] == json!(seqs[1]))).await;
}

/// A route that saves the configuration `saves` times while the new thread is being created, as the draft's route does (`adopt_draft`
/// saves it): each save moves the settings counter once, as an announced change.
struct SavingRoute {
    counter: tokio::sync::watch::Sender<u64>,
    saves: u64,
}

#[async_trait::async_trait]
impl super::NewThreadRoute for SavingRoute {
    async fn adopt(&self, _: &mixdog_core_api::ids::ThreadId, _: Option<&serde_json::Map<String, Value>>) -> Result<serde_json::Map<String, Value>, String> {
        for _ in 0..self.saves {
            self.counter.send_modify(|count| *count += 1);
        }
        Ok(serde_json::Map::new())
    }

    async fn adopt_control(&self, _: &mixdog_core_api::ids::ThreadId) -> Result<serde_json::Map<String, Value>, String> {
        Ok(serde_json::Map::new())
    }

    async fn seat(&self, _: &mixdog_core_api::ids::ThreadId) -> Result<(), String> {
        Ok(())
    }
}

/// In Node the session exists (`client.create`) before the draft's `setRoute` saves the route, so the save is a settings change the session
/// sees: a settings change made while a thread is being created reaches its `setupChanged`.
#[tokio::test(start_paused = true)]
async fn a_settings_change_the_creation_makes_reaches_the_new_threads_setup_changed() {
    let rig = Rig::new();
    let (announce, changes) = tokio::sync::watch::channel(0_u64);
    *lock(&rig.compaction.settings) = Some(changes);
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.new_route = Arc::new(SavingRoute { counter: announce, saves: 1 });
    let directory = SessionDirectory::new(Arc::new(deps));
    let handle = start_thread(&directory).await;
    let (recorded, _) = node_setup_changed();
    let first = eventually_on!(&[&handle.cell.stepped], || newest(&rig, handle.id.as_str(), "thread/runtime/updated").filter(|runtime| runtime["setupChanged"]["seq"] == recorded["seq"])).await;
    assert_eq!(first["setupChanged"]["action"], recorded["action"]);
}

/// Announcements made before the thread's actor runs (the counter moves once per recorded delivery while it is created) are separate
/// deliveries to a Node session: the thread publishes setupChanged once for each, with the seqs Node recorded, and holds the last.
#[tokio::test(start_paused = true)]
async fn announcements_made_before_install_each_count() {
    let rig = Rig::new();
    let (announce, changes) = tokio::sync::watch::channel(0_u64);
    *lock(&rig.compaction.settings) = Some(changes);
    let (_, seqs) = node_setup_changed();
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.new_route = Arc::new(SavingRoute { counter: announce, saves: seqs.len() as u64 });
    let directory = SessionDirectory::new(Arc::new(deps));
    let handle = start_thread(&directory).await;
    let last = *seqs.last().expect("a recorded delivery");
    eventually_on!(&[&handle.cell.stepped], || newest(&rig, handle.id.as_str(), "thread/runtime/updated").filter(|runtime| runtime["setupChanged"]["seq"] == json!(last))).await;
    assert_eq!(published_setup_seqs(&rig, handle.id.as_str()), seqs);
}

/// The count behind a thread when it begins is not its own: a counter already at 5 is no delivery to a thread that follows it from now on.
#[tokio::test(start_paused = true)]
async fn announcements_before_the_thread_begins_do_not_count() {
    let rig = Rig::new();
    let (announce, changes) = tokio::sync::watch::channel(5_u64);
    *lock(&rig.compaction.settings) = Some(changes);
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    announce.send_modify(|count| *count += 1);
    let (recorded, _) = node_setup_changed();
    eventually_on!(&[&handle.cell.stepped], || newest(&rig, handle.id.as_str(), "thread/runtime/updated").filter(|runtime| runtime["setupChanged"]["seq"] == recorded["seq"])).await;
}

/// A turn's close does not take `setupChanged`: the settings announcement is the session's, not the run's, and a client reads it after the turn.
#[tokio::test(start_paused = true)]
async fn a_turn_end_leaves_setup_changed_in_the_state() {
    let rig = Rig::new();
    let (announce, changes) = tokio::sync::watch::channel(0_u64);
    *lock(&rig.compaction.settings) = Some(changes);
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let (recorded, _) = node_setup_changed();
    announce.send_modify(|count| *count += 1);
    eventually_on!(&[&handle.cell.stepped], || newest(&rig, handle.id.as_str(), "thread/runtime/updated").filter(|runtime| runtime["setupChanged"]["seq"] == recorded["seq"])).await;
    turn(&handle, "go", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    eventually_on!(&[&handle.cell.stepped], || {
        rig.feeds.frames(handle.id.as_str()).iter().any(|(_, method, _)| method == "turn/completed").then_some(())
    })
    .await;
    let after = newest(&rig, handle.id.as_str(), "thread/runtime/updated").expect("a runtime frame");
    assert_eq!(after["setupChanged"]["seq"], recorded["seq"], "the frame after the turn still carries it");
    assert!(handle.cell.view.load_full().state.runtime.clone().expect("runtime").setup_changed.is_some());
}