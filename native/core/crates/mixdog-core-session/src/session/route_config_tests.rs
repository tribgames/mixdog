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
use super::testing::awaiting;
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

/// Node's `syncContextDisplayFields` runs when the turn settles (turn.mjs:530): a stopped turn publishes the display fields as a
/// completed one does (the phone's Stop recordings, remote-protocol-chat-abort.node/, end every Stop case with them set).
#[tokio::test(start_paused = true)]
async fn a_stopped_turn_and_a_completed_one_both_publish_the_context_display_fields() {
    let cancelled = context_after_turn(true).await;
    assert_eq!(
        (cancelled.display_context_window, cancelled.auto_compact_token_limit, cancelled.compact_boundary_tokens),
        (Some(9_000), Some(7_000), Some(8_000))
    );
    let completed = context_after_turn(false).await;
    assert_eq!(
        (completed.display_context_window, completed.auto_compact_token_limit, completed.compact_boundary_tokens),
        (Some(9_000), Some(7_000), Some(8_000))
    );
}

/// The fields a route move writes as the phone's snapshot shows them (`desktopSessionState`): the route and the window figures
/// `setRoute` publishes (routes-write.mjs:133-142, context-state.mjs:100-142).
const MOVED: [&str; 8] = ["provider", "model", "contextWindow", "rawContextWindow", "effectiveContextWindowPercent", "displayContextWindow", "compactBoundaryTokens", "autoCompactTokenLimit"];
/// The route fields of [`MOVED`]: what the move's header patch writes (the route Node resolved, `updateSessionRoute`).
const ROUTE_FIELDS: [&str; 5] = ["provider", "model", "contextWindow", "rawContextWindow", "effectiveContextWindowPercent"];

/// A route move Node recorded (`apps/mobile/fixtures/phone-worktree/golden.json`, a session entry with `switchRoute`): the [`MOVED`]
/// fields the session showed before it, right after it and once a status pass ran, and the status its sync read (`None`: the
/// injected failure).
struct RecordedMove {
    model: String,
    read: Option<Value>,
    before: Value,
    after: Value,
    settled: Value,
}

fn phone_worktree(name: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../apps/mobile/fixtures/phone-worktree").join(name);
    serde_json::from_str(&mixdog_testkit::read_string(path)).expect("the recording parses")
}

/// The [`MOVED`] fields of a recorded read's snapshot.
fn moved_of(read: &Value) -> Value {
    let snapshot = &read["value"]["snapshot"];
    Value::Object(MOVED.iter().map(|field| ((*field).to_owned(), snapshot[*field].clone())).collect())
}

fn recorded_moves() -> Vec<RecordedMove> {
    let golden = phone_worktree("golden.json");
    let moves: Vec<RecordedMove> = golden["cases"]
        .as_array()
        .expect("the cases")
        .iter()
        .filter(|entry| entry.get("switchRoute").is_some())
        .map(|entry| {
            let reads = entry["statusReads"].as_array().expect("the move's status reads");
            assert_eq!(reads.len(), 1, "Node's setRoute syncs once (routes-write.mjs:142)");
            let failed = entry["failStatus"] == true;
            assert_eq!(reads[0].is_null(), failed, "only the injected failure finds no status");
            RecordedMove {
                model: entry["switchRoute"]["model"].as_str().expect("model").to_owned(),
                read: (!failed).then(|| reads[0].clone()),
                before: moved_of(&entry["before"]),
                after: moved_of(&entry["frame"]),
                settled: moved_of(&entry["settled"]),
            }
        })
        .collect();
    assert!(moves.iter().any(|m| m.read.is_none()) && moves.iter().filter(|m| m.read.is_some()).count() >= 2, "a failed read and two read ones");
    moves
}

/// The thread's [`MOVED`] fields.
fn shown(handle: &super::SessionHandle) -> Value {
    let state = serde_json::to_value(&handle.cell.view.load_full().state).expect("state");
    Value::Object(
        MOVED
            .iter()
            .map(|field| {
                let section = if ["provider", "model"].contains(field) { "route" } else { "context" };
                ((*field).to_owned(), state[section][*field].clone())
            })
            .collect(),
    )
}

/// `shown` is what Node answered right after `recorded`, field by field, or in a field of the manifest's `fasterInCore` what Node
/// settled on (the same content, only faster).
fn assert_answers_as_node(shown: &Value, recorded: &RecordedMove, what: &str) {
    let manifest = phone_worktree("MANIFEST.json");
    let faster: Vec<&str> = manifest["fasterInCore"]["fields"].as_array().expect("the fasterInCore fields").iter().filter_map(Value::as_str).collect();
    let differing: Vec<String> = MOVED
        .iter()
        .filter(|field| shown[**field] != recorded.after[**field] && !(faster.contains(field) && shown[**field] == recorded.settled[**field]))
        .map(|field| format!("{field}: core {} node {} (settled {})", shown[*field], recorded.after[*field], recorded.settled[*field]))
        .collect();
    assert!(differing.is_empty(), "{what}: {differing:#?}");
}

/// The status whose display fields are `state`'s (what `syncContextDisplayFields` takes): the read of the move that seats a new
/// thread on a recorded state.
fn status_showing(state: &Value) -> Value {
    json!({ "contextWindow": state["displayContextWindow"], "compaction": { "boundaryTokens": state["compactBoundaryTokens"], "triggerTokens": state["autoCompactTokenLimit"] } })
}

/// `thread/header/patch` of a move to the route `state` shows (`updateSessionRoute`).
fn move_to<'a>(handle: &'a super::SessionHandle, state: &Value) -> impl std::future::Future<Output = Result<mixdog_core_api::Reply, mixdog_core_api::error::CoreError>> + 'a {
    let set: serde_json::Map<String, Value> = ROUTE_FIELDS.iter().map(|field| ((*field).to_owned(), state[*field].clone())).collect();
    let params = json!({ "threadId": handle.id, "set": set, "unset": [] });
    mixdog_core_api::ThreadHandle::request(handle, mixdog_core_api::CoreRequest {
        method: mixdog_core_api::ids::Method("thread/header/patch"),
        params,
        op: None,
        ctx: mixdog_core_api::call::CallContext::internal("test"),
    })
}

/// A context gauge whose route-move reads wait until the test lets each through ([`GatedStatus::let_through`]) with its answer;
/// `passes` counts the status passes (`context_status`), which read nothing.
struct GatedStatus {
    gate: tokio::sync::Semaphore,
    answers: std::sync::Mutex<std::collections::VecDeque<Option<Value>>>,
    held: std::sync::atomic::AtomicUsize,
    most_held: std::sync::atomic::AtomicUsize,
    passes: std::sync::atomic::AtomicUsize,
    /// Told when a read comes to the gate: the read runs off the actor, so no step of the thread announces it.
    arrived: tokio::sync::Notify,
    /// Told on each status pass.
    passed: tokio::sync::Notify,
}

impl GatedStatus {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            gate: tokio::sync::Semaphore::new(0),
            answers: Default::default(),
            held: Default::default(),
            most_held: Default::default(),
            passes: Default::default(),
            arrived: Default::default(),
            passed: Default::default(),
        })
    }

    /// Lets the next read through with `answer` (`None`: the read fails).
    fn let_through(&self, answer: Option<Value>) {
        self.answers.lock().unwrap().push_back(answer);
        self.gate.add_permits(1);
    }

    fn held(&self) -> usize {
        self.held.load(std::sync::atomic::Ordering::SeqCst)
    }
}

#[async_trait::async_trait]
impl super::thread_context::ContextStatusHost for GatedStatus {
    async fn context_status(&self, _: Option<mixdog_core_api::ids::ThreadId>, _: Option<Value>) -> Result<Value, mixdog_core_api::error::CoreError> {
        self.passes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.passed.notify_waiters();
        Ok(Value::Null)
    }

    async fn context_status_for(&self, _: mixdog_core_api::ids::ThreadId, _: serde_json::Map<String, Value>) -> Result<Value, mixdog_core_api::error::CoreError> {
        let held = self.held.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        self.most_held.fetch_max(held, std::sync::atomic::Ordering::SeqCst);
        self.arrived.notify_waiters();
        awaiting(|| "the test to let the route move's status read through".to_owned(), self.gate.acquire()).await.expect("the gate stays open").forget();
        self.held.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        let answer = self.answers.lock().unwrap().pop_front().expect("an answer for each read let through");
        answer.ok_or_else(|| mixdog_core_api::error::CoreError::Internal { incident_id: "test-status-failed".into() })
    }
}

/// A rig whose thread runs on [`GatedStatus`], seated on the recorded `state` by a move whose read shows its figures, with the
/// load's status pass done.
async fn gated_thread(rig: &Rig, status: &Arc<GatedStatus>, state: &Value) -> (Arc<SessionDirectory>, Arc<super::SessionHandle>) {
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.context_status = status.clone();
    let directory = Arc::new(SessionDirectory::new(Arc::new(deps)));
    let handle = awaiting(|| "the thread to start".to_owned(), start_thread(&directory)).await;
    status.let_through(Some(status_showing(state)));
    awaiting(|| "the seating move to answer".to_owned(), move_to(&handle, state)).await.expect("seated");
    assert!(status.answers.lock().unwrap().is_empty(), "the seating move read its status");
    eventually_on!(&[&status.passed], || (status.passes.load(std::sync::atomic::Ordering::SeqCst) >= 1).then_some(())).await;
    assert_eq!(shown(&handle), *state, "the thread is seated on the recorded state");
    (directory, handle)
}

/// A model switch (`updateSessionRoute` writing the new route into the header) shows the new route's figures with the new model:
/// Node's `setRoute` runs `syncContextStats` before `publishRoute` (routes-write.mjs:133-142). With the recorded move's read held,
/// reads show the old route whole and the switch is not answered; let through, it answers as Node did, and no frame shows the new
/// model without its trigger.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_model_switch_shows_the_new_routes_figures_with_the_new_model() {
    let recorded = recorded_moves().into_iter().find(|m| m.read.is_some()).expect("a read move");
    let rig = Rig::new();
    let status = GatedStatus::new();
    let (_directory, handle) = gated_thread(&rig, &status, &recorded.before).await;
    let switch = move_to(&handle, &recorded.after);
    tokio::pin!(switch);
    assert!(futures::poll!(switch.as_mut()).is_pending());
    held(&handle, &status, 1).await;
    assert!(futures::poll!(switch.as_mut()).is_pending(), "the switch answers after its figures");
    assert_eq!(shown(&handle), recorded.before, "while the new route's status is read, reads show the old route whole");
    status.let_through(recorded.read.clone());
    awaiting(|| "the switch to answer".to_owned(), switch).await.expect("switched");
    let now = shown(&handle);
    assert_answers_as_node(&now, &recorded, "the switch");
    // The frames folded in order, as a client holds them: the new model never shows without its trigger.
    let (mut model, mut trigger) = (Value::Null, Value::Null);
    let mut seen = false;
    for (_, method, params) in rig.feeds.frames(handle.id.as_str()) {
        match method.as_str() {
            "thread/route/updated" => model = params["value"]["model"].clone(),
            "thread/context/updated" => trigger = params["value"]["autoCompactTokenLimit"].clone(),
            _ => continue,
        }
        if model.as_str() == Some(recorded.model.as_str()) {
            seen = true;
            assert_eq!(trigger, now["autoCompactTokenLimit"], "a frame shows the new model with another trigger");
        }
    }
    assert!(seen, "the switch was published");
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
    let recorded = recorded_moves().into_iter().find(|m| m.read.is_some()).expect("a read move");
    let status = GatedStatus::new();
    let (_directory, handle) = gated_thread(&rig, &status, &recorded.before).await;
    let switch = tokio::spawn({
        let (handle, after) = (handle.clone(), recorded.after.clone());
        async move { move_to(&handle, &after).await }
    });
    held(&handle, &status, 1).await;

    let read = mixdog_core_api::CoreRequest {
        method: mixdog_core_api::ids::Method("thread/read"),
        params: json!({ "threadId": handle.id }),
        op: None,
        ctx: mixdog_core_api::call::CallContext::internal("test"),
    };
    let answered = awaiting(|| "thread/read while the move is pending".to_owned(), mixdog_core_api::ThreadHandle::request(&*handle, read)).await;
    assert!(answered.is_ok(), "thread/read is answered while the move is pending");
    let started = awaiting(|| "the turn to start while the move is pending".to_owned(), turn(&handle, "go", "op-1")).await;
    eventually_on!(&[&handle.cell.stepped], || handle.cell.busy.load(std::sync::atomic::Ordering::SeqCst).then_some(())).await;
    assert_eq!(shown(&handle), recorded.before, "the turn starts on the route the thread holds");
    handle.interrupt(&TurnId::from(started["turnId"].as_str().expect("turn id")), None).expect("interrupt");
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    assert_eq!(status.held(), 1, "the cancel was served while the read was held");
    assert!(!switch.is_finished(), "the move answers after its figures");

    status.let_through(recorded.read.clone());
    awaiting(|| "the move to answer".to_owned(), switch).await.expect("joined").expect("switched");
    assert_answers_as_node(&shown(&handle), &recorded, "the move");
}

/// Two route moves in a row (Node's recorded moves to the wider model and back) are written in order, one read at a time, and the
/// thread ends on the second as Node answered it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_route_moves_in_a_row_end_on_the_second_with_its_figures() {
    let moves: Vec<RecordedMove> = recorded_moves().into_iter().filter(|m| m.read.is_some()).collect();
    let (first_move, second_move) = (&moves[0], &moves[1]);
    assert_ne!(first_move.model, second_move.model, "two moves to two models");
    let rig = Rig::new();
    let status = GatedStatus::new();
    let (_directory, handle) = gated_thread(&rig, &status, &first_move.before).await;
    let first = tokio::spawn({
        let (handle, after) = (handle.clone(), first_move.after.clone());
        async move { move_to(&handle, &after).await }
    });
    held(&handle, &status, 1).await;
    let second = tokio::spawn({
        let (handle, after) = (handle.clone(), second_move.after.clone());
        async move { move_to(&handle, &after).await }
    });
    status.let_through(first_move.read.clone());
    awaiting(|| "the first move to answer".to_owned(), first).await.expect("joined").expect("first");
    // The second's read comes once the first is written: the thread shows the first's move while it is held.
    held(&handle, &status, 1).await;
    assert_answers_as_node(&shown(&handle), first_move, "the first move");
    status.let_through(second_move.read.clone());
    awaiting(|| "the second move to answer".to_owned(), second).await.expect("joined").expect("second");
    assert_eq!(status.most_held.load(std::sync::atomic::Ordering::SeqCst), 1, "one read at a time");
    assert_answers_as_node(&shown(&handle), second_move, "the second move");
}

/// A route move through the route write (`write_route`: `update_header_awaiting`, the route's hops and a session's own pick) is the
/// same pending step: written once its figures are read, with them, as Node answered the recorded move.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_route_write_moves_with_its_figures() {
    let recorded = recorded_moves().into_iter().find(|m| m.read.is_some()).expect("a read move");
    let rig = Rig::new();
    let status = GatedStatus::new();
    let (directory, handle) = gated_thread(&rig, &status, &recorded.before).await;
    let set: serde_json::Map<String, Value> = ROUTE_FIELDS.iter().map(|field| ((*field).to_owned(), recorded.after[*field].clone())).collect();
    let update: super::actor::AwaitingHeaderUpdate = Box::new(move |_| Box::pin(async move { mixdog_store::schema::record::HeaderChange { set, unset: Vec::new() } }));
    let write = tokio::spawn({
        let (directory, id) = (directory.clone(), handle.id.clone());
        async move { directory.update_header_awaiting(&id, update).await }
    });
    held(&handle, &status, 1).await;
    assert_eq!(shown(&handle), recorded.before, "not written before its figures");
    status.let_through(recorded.read.clone());
    awaiting(|| "the route write to answer".to_owned(), write).await.expect("joined").expect("written");
    assert_answers_as_node(&shown(&handle), &recorded, "the route write");
}

/// Each route move Node recorded, replayed in order on one thread (`thread/header/patch` with the route Node resolved, the status read
/// answered as Node's was, failing where the recording injected the failure): the thread holds what Node held before each and shows
/// what Node answered right after it, each move reading its status once.
#[tokio::test]
async fn each_recorded_route_move_answers_as_node_did() {
    let moves = recorded_moves();
    let rig = Rig::new();
    let status = GatedStatus::new();
    let (_directory, handle) = gated_thread(&rig, &status, &moves[0].before).await;
    for (n, recorded) in moves.iter().enumerate() {
        let what = format!("move {n} to {}{}", recorded.model, if recorded.read.is_none() { " (failed read)" } else { "" });
        assert_eq!(shown(&handle), recorded.before, "{what}: the thread holds what Node held before it");
        status.let_through(recorded.read.clone());
        awaiting(|| format!("{what} to answer"), move_to(&handle, &recorded.after)).await.expect("the move is written");
        assert!(status.answers.lock().unwrap().is_empty(), "{what}: the move read its status");
        assert_answers_as_node(&shown(&handle), recorded, &what);
    }
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