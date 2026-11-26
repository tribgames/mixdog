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
use super::tests::idle;
use super::tests::start_thread;
use super::tests::turn;
use crate::eventually_on;

fn newest(rig: &Rig, thread: &str, method: &str) -> Option<Value> {
    rig.feeds.frames(thread).into_iter().rev().find(|(_, name, _)| name == method).map(|(_, _, params)| params["value"].clone())
}

/// No picker reply drives an external control's UI: the actor must publish tuning as well as model changes.
#[tokio::test(start_paused = true)]
async fn model_and_effort_changes_reach_both_the_route_feed_and_thread_read() {
    use mixdog_core_api::ThreadHandle;
    use mixdog_core_ports::ports::threads::ThreadState;
    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    let handle = start_thread(&directory).await;
    let threads = super::thread_state::SessionThreads::new(directory.clone());
    handle.set_section(Section::Route(ThreadRoute { effort: Some("medium".into()), ..Default::default() })).await.unwrap();
    for (set, unset, model, effort) in [
        (json!({ "provider": "p", "model": "running", "effort": "low" }), vec![], "running", Some("low")),
        (json!({ "effort": "high", "effortAuto": false }), vec![], "running", Some("high")),
        (json!({ "pendingRoute": { "provider": "p", "model": "next", "effort": "ultra", "effectiveEffort": "high" } }), vec![], "next", Some("high")),
        (json!({ "model": "fallback", "effort": "low" }), vec![], "next", Some("high")),
        (json!({ "pendingRoute": { "provider": "p", "model": "next", "effort": null } }), vec![], "next", None),
        (json!({ "model": "next", "effort": null }), vec!["pendingRoute".into()], "next", None),
    ] {
        threads.patch_header(&handle.id, set.as_object().unwrap().clone(), unset).await.unwrap();
        // Drain a subsequent route section through the same actor, without publishing route values for the test.
        handle.set_section(Section::TurnEffort(Some("medium".into()))).await.unwrap();
        let read = handle.request(super::tests::request("thread/read", json!({ "threadId": handle.id }), "read")).await.unwrap();
        let mixdog_core_api::Reply::Value(read) = read else { panic!("thread/read must answer a value") };
        assert_eq!(read["state"]["route"]["model"], model);
        assert_eq!(read["state"]["route"]["effort"].as_str(), effort);
        let published = newest(&rig, handle.id.as_str(), "thread/route/updated").expect("route publication");
        assert_eq!(published["model"], model);
        assert_eq!(published["effort"].as_str(), effort);
    }
    directory.shutdown().await;
}

#[tokio::test(start_paused = true)]
async fn a_quota_hop_publishes_the_destination_settings_in_one_route() {
    use mixdog_core_api::ThreadHandle;
    use mixdog_core_ports::ports::threads::ThreadState;
    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    let handle = start_thread(&directory).await;
    let threads = super::thread_state::SessionThreads::new(directory.clone());
    let (writer, thread) = (&threads, &handle.id);
    let patch = |set: Value| async move {
        writer.patch_header(thread, set.as_object().unwrap().clone(), Vec::new()).await.unwrap();
    };
    patch(json!({ "provider": "anthropic-oauth", "model": "claude-sonnet-5-5", "effort": "medium", "fast": false })).await;
    handle
        .set_section(Section::Route(ThreadRoute {
            session_model: Some("claude-sonnet-5-5".into()),
            effort: Some("medium".into()),
            fast: Some(false),
            ..Default::default()
        }))
        .await
        .unwrap();
    patch(json!({
        "provider": "openai-oauth", "model": "gpt-6.2-sol", "effort": "high", "fast": true,
        "modelParameters": { "serviceTier": "ultrafast" }, "selectedContextWindow": 640_000,
        "routeFallbackIndex": 1,
        "routeFallbackFailures": [{ "provider": "anthropic-oauth", "model": "claude-sonnet-5-5", "kind": "quota_exhausted" }]
    }))
    .await;
    let route =
        eventually_on!(&[&handle.cell.stepped], || newest(&rig, handle.id.as_str(), "thread/route/updated").filter(|r| r["model"] == "gpt-6.2-sol")).await;
    let check = |r: &Value| {
        assert_eq!(r["sessionProvider"], "openai-oauth");
        assert_eq!(r["sessionModel"], "gpt-6.2-sol");
        assert_eq!(r["effort"], "high");
        assert_eq!(r["fast"], true);
        assert_eq!(r["modelParameters"]["serviceTier"], "ultrafast");
        assert_eq!(r["selectedContextWindow"], 640_000);
    };
    check(&route);
    let read = handle.request(super::tests::request("thread/read", json!({ "threadId": handle.id }), "read")).await.unwrap();
    let mixdog_core_api::Reply::Value(read) = read else { panic!("thread/read must answer a value") };
    check(&read["state"]["route"]);
    directory.shutdown().await;
}

/// A quota hop moves the seated route only: the effort choice published for a pick held for the next turn is not the old
/// route's, and survives it, while the seated model shown is the destination's.
#[tokio::test(start_paused = true)]
async fn a_quota_hop_leaves_the_effort_choice_of_a_held_pick() {
    use mixdog_core_api::ThreadHandle;
    use mixdog_core_ports::ports::threads::ThreadState;
    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    let handle = start_thread(&directory).await;
    let threads = super::thread_state::SessionThreads::new(directory.clone());
    let (writer, thread) = (&threads, &handle.id);
    let patch = |set: Value| async move {
        writer.patch_header(thread, set.as_object().unwrap().clone(), Vec::new()).await.unwrap();
    };
    patch(json!({ "provider": "anthropic-oauth", "model": "claude-fable-5-2", "effort": "medium" })).await;
    patch(json!({ "pendingRoute": { "provider": "anthropic-oauth", "model": "claude-opus-5-5", "effort": "low" } })).await;
    handle
        .set_section(Section::Route(ThreadRoute {
            effort: Some("xhigh".into()),
            effort_options: Some(vec![json!({ "value": "xhigh" })]),
            ..Default::default()
        }))
        .await
        .unwrap();
    patch(json!({
        "provider": "openai-oauth", "model": "gpt-6.2-astra", "effort": "high",
        "routeFallbackIndex": 1,
        "routeFallbackFailures": [{ "provider": "anthropic-oauth", "model": "claude-fable-5-2", "kind": "quota_exhausted" }]
    }))
    .await;
    let read = handle.request(super::tests::request("thread/read", json!({ "threadId": handle.id }), "read")).await.unwrap();
    let mixdog_core_api::Reply::Value(read) = read else { panic!("thread/read must answer a value") };
    let route = &read["state"]["route"];
    assert_eq!((&route["sessionModel"], &route["model"]), (&json!("gpt-6.2-astra"), &json!("claude-opus-5-5")));
    assert_eq!(route["effort"], "xhigh");
    assert_eq!(route["effortOptions"], json!([{ "value": "xhigh" }]));
    directory.shutdown().await;
}

/// Speed, parameters, the selected window and the context choice of the seated route are published when they move, each followed
/// by the frame that carries it, and read back as the selected route holds them (`baseRouteState`: `runtime.fast`,
/// `runtime.modelParameters`, `runtime.contextPercent`); a held pick's own values show while it is held.
#[tokio::test(start_paused = true)]
async fn a_speed_parameters_or_context_change_on_the_seated_route_is_published() {
    use mixdog_core_api::ThreadHandle;
    use mixdog_core_ports::ports::threads::ThreadState;
    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    let handle = start_thread(&directory).await;
    let threads = super::thread_state::SessionThreads::new(directory.clone());
    let id = handle.id.as_str().to_owned();
    // The note's newest value, once a `thread/frame` follows it.
    let framed = |method: &str| {
        let frames = rig.feeds.frames(&id);
        let at = frames.iter().rposition(|(_, name, _)| name == method)?;
        frames[at + 1..].iter().any(|(_, name, _)| name == "thread/frame").then(|| frames[at].2["value"].clone())
    };
    let read = || async {
        let read = handle.request(super::tests::request("thread/read", json!({ "threadId": handle.id }), "read")).await.unwrap();
        let mixdog_core_api::Reply::Value(read) = read else { panic!("thread/read must answer a value") };
        read["state"].clone()
    };
    // The header write is answered once its record is released (its notes published); the frame timer then closes the frame.
    let (writer, thread) = (&threads, &handle.id);
    let patch = |set: Value| async move {
        writer.patch_header(thread, set.as_object().unwrap().clone(), Vec::new()).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    };
    patch(json!({ "provider": "p", "model": "seated" })).await;

    patch(json!({ "fast": true, "modelParameters": { "verbosity": "low" }, "selectedContextWindow": 400_000 })).await;
    let want = (json!(true), json!({ "verbosity": "low" }), json!(400_000));
    let shown = |route: &Value| (route["fast"].clone(), route["modelParameters"].clone(), route["selectedContextWindow"].clone());
    assert_eq!(framed("thread/route/updated").as_ref().map(shown), Some(want.clone()));
    assert_eq!(shown(&read().await["route"]), want);

    patch(json!({ "fast": false })).await;
    assert_eq!(framed("thread/route/updated").map(|route| route["fast"].clone()), Some(json!(false)));

    patch(json!({ "contextPercent": 50, "contextTokens": 200_000 })).await;
    let percent = |context: &Value| (context["contextPercent"].clone(), context["contextTokens"].clone());
    assert_eq!(framed("thread/context/updated").as_ref().map(percent), Some((json!(50.0), json!(200_000))));
    assert_eq!(percent(&read().await["context"]), (json!(50.0), json!(200_000)));

    // A held pick that states no percent shows the session's (`state.route?.contextPercent ?? state.session?.contextPercent`,
    // runtime-facade.mjs), while its exact window is its own alone: none (`state.route.contextTokens || null`).
    patch(json!({ "pendingRoute": { "provider": "p", "model": "next", "fast": true } })).await;
    assert_eq!(framed("thread/context/updated").as_ref().map(percent), Some((json!(50.0), Value::Null)));
    assert_eq!(percent(&read().await["context"]), (json!(50.0), Value::Null));

    // A pick held for the next turn is the selected route: its own speed and window show, not the seated route's.
    patch(json!({ "pendingRoute": { "provider": "p", "model": "next", "fast": true, "contextPercent": 30 } })).await;
    assert_eq!(framed("thread/context/updated").map(|context| context["contextPercent"].clone()), Some(json!(30.0)));
    let state = read().await;
    assert_eq!(
        (state["route"]["model"].clone(), state["route"]["fast"].clone(), state["route"]["modelParameters"].clone()),
        (json!("next"), json!(true), json!({}))
    );
    directory.shutdown().await;
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

/// The turn's effort reaches clients only when it changed, as Node's route state does (`local-session-runtime.mjs:162`
/// `publishChanged` skips a value equal to the one published): a run that starts with the effort already in force publishes no
/// route frame.
#[tokio::test(start_paused = true)]
async fn an_unchanged_turn_effort_publishes_no_route_frame() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let routes = || {
        rig.feeds
            .frames(handle.id.as_str())
            .into_iter()
            .filter(|(_, name, _)| name == "thread/route/updated")
            .map(|(_, _, p)| p["value"]["turnEffort"].clone())
            .collect::<Vec<_>>()
    };
    for effort in [None, Some("high"), Some("high"), None] {
        handle.set_section(Section::TurnEffort(effort.map(Into::into))).await.expect("effort");
    }
    handle.set_section(Section::Route(ThreadRoute { effort: Some("low".into()), ..Default::default() })).await.expect("route");
    eventually_on!(&[&handle.cell.stepped], || (routes().len() >= 3).then_some(())).await;
    assert_eq!(routes(), vec![json!("high"), Value::Null, Value::Null]);
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
        (
            &json!(super::tests::ROUTE_PROVIDER),
            &json!(super::tests::ROUTE_MODEL),
            &json!(super::tests::ROUTE_PROVIDER),
            &json!(super::tests::ROUTE_MODEL),
            &auto_clear
        )
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
    let published = eventually_on!(&[&handle.cell.stepped], || newest(&rig, handle.id.as_str(), "thread/context/updated")
        .filter(|context| context["contextWindow"] == json!(9_000)))
    .await;
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
const MOVED: [&str; 8] = [
    "provider",
    "model",
    "contextWindow",
    "rawContextWindow",
    "effectiveContextWindowPercent",
    "displayContextWindow",
    "compactBoundaryTokens",
    "autoCompactTokenLimit",
];
/// The route fields of [`MOVED`]: what the move's header patch writes (the route Node resolved, `updateSessionRoute`).
const ROUTE_FIELDS: [&str; 5] = ["provider", "model", "contextWindow", "rawContextWindow", "effectiveContextWindowPercent"];

/// A route move: the [`MOVED`] fields the session showed before it and right after it, and the status its sync read (`None`: the
/// injected failure).
struct RecordedMove {
    model: String,
    read: Option<Value>,
    before: Value,
    after: Value,
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

/// The status whose display fields are `state`'s (what `syncContextDisplayFields` takes): the read of the move that seats a new
/// thread on a recorded state.
fn status_showing(state: &Value) -> Value {
    json!({ "contextWindow": state["displayContextWindow"], "compaction": { "boundaryTokens": state["compactBoundaryTokens"], "triggerTokens": state["autoCompactTokenLimit"] } })
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

/// Waits until `count` route-move reads are held at the gate.
async fn held(handle: &super::SessionHandle, status: &GatedStatus, count: usize) {
    eventually_on!(&[&handle.cell.stepped, &status.arrived], || (status.held() == count).then_some(())).await;
}

/// A gauge whose answer to the load's status pass is the stored reading of a session (`measurement`), as a restarted core reads it off the header.
struct StoredReading(Value);

/// `thread/header/patch` of a move to the route `state` shows (`updateSessionRoute`).
fn move_to<'a>(
    handle: &'a super::SessionHandle,
    state: &Value,
) -> impl std::future::Future<Output = Result<mixdog_core_api::Reply, mixdog_core_api::error::CoreError>> + 'a {
    let set: serde_json::Map<String, Value> = ROUTE_FIELDS.iter().map(|field| ((*field).to_owned(), state[*field].clone())).collect();
    let params = json!({ "threadId": handle.id, "set": set, "unset": [] });
    mixdog_core_api::ThreadHandle::request(
        handle,
        mixdog_core_api::CoreRequest {
            method: mixdog_core_api::ids::Method("thread/header/patch"),
            params,
            op: None,
            ctx: mixdog_core_api::call::CallContext::internal("test"),
        },
    )
}
#[async_trait::async_trait]
impl super::thread_context::ContextStatusHost for GatedStatus {
    async fn context_status(&self, _: Option<mixdog_core_api::ids::ThreadId>, _: Option<Value>) -> Result<Value, mixdog_core_api::error::CoreError> {
        self.passes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.passed.notify_waiters();
        Ok(Value::Null)
    }

    async fn context_status_for(
        &self,
        _: mixdog_core_api::ids::ThreadId,
        _: serde_json::Map<String, Value>,
    ) -> Result<Value, mixdog_core_api::error::CoreError> {
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
#[async_trait::async_trait]
impl super::thread_context::ContextStatusHost for StoredReading {
    async fn context_status(&self, _: Option<mixdog_core_api::ids::ThreadId>, _: Option<Value>) -> Result<Value, mixdog_core_api::error::CoreError> {
        Ok(self.0.clone())
    }

    async fn context_status_for(
        &self,
        _: mixdog_core_api::ids::ThreadId,
        _: serde_json::Map<String, Value>,
    ) -> Result<Value, mixdog_core_api::error::CoreError> {
        Ok(self.0.clone())
    }
}
/// The context reading of a conversation is part of its restored state: a thread loaded after a restart shows the stored reading in its
/// `stats` without a model response, and a call of its own keeps its live reading over the stored one.
#[tokio::test(start_paused = true)]
async fn a_loaded_thread_shows_the_stored_context_reading_before_any_model_response() {
    let rig = Rig::new();
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.context_status = Arc::new(StoredReading(json!({
        "contextWindow": 200_000,
        "measurement": { "tokens": 42_000, "source": "last_api_request", "updatedAt": 7_000 },
    })));
    let directory = SessionDirectory::new(Arc::new(deps));
    let handle = start_thread(&directory).await;
    let stats = |handle: &super::SessionHandle| handle.cell.view.load_full().state.context.clone().expect("context").stats.expect("stats");
    assert_eq!(stats(&handle)["currentContextSource"], "pending", "before the load's status pass");
    tokio::time::advance(super::actor::STATUS_SETTLE).await;
    eventually_on!(&[&handle.cell.stepped], || (stats(&handle)["currentContextTokens"] == json!(42_000)).then_some(())).await;
    let stats = stats(&handle);
    assert_eq!((&stats["currentContextSource"], &stats["currentContextUpdatedAt"]), (&json!("last_api_request"), &json!(7_000)));
}

/// A gauge whose route-move read panics.
struct PanickingRead;

#[async_trait::async_trait]
impl super::thread_context::ContextStatusHost for PanickingRead {
    async fn context_status(&self, _: Option<mixdog_core_api::ids::ThreadId>, _: Option<Value>) -> Result<Value, mixdog_core_api::error::CoreError> {
        Ok(Value::Null)
    }

    async fn context_status_for(
        &self,
        _: mixdog_core_api::ids::ThreadId,
        _: serde_json::Map<String, Value>,
    ) -> Result<Value, mixdog_core_api::error::CoreError> {
        panic!("the route move's status read died")
    }
}

/// A route move whose status read panics is answered with the failure, not left pending, and the thread keeps its route.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_route_move_whose_status_read_panics_is_refused() {
    let rig = Rig::new();
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.context_status = Arc::new(PanickingRead);
    let directory = SessionDirectory::new(Arc::new(deps));
    let handle = awaiting(|| "the thread to start".to_owned(), start_thread(&directory)).await;
    let before = shown(&handle);
    let answer = awaiting(|| "the move to answer".to_owned(), move_to(&handle, &route_state("fixture-model", 128_000))).await;
    assert!(matches!(&answer, Err(mixdog_core_api::error::CoreError::Internal { incident_id }) if &**incident_id == "route-status-panicked"), "{answer:?}");
    assert_eq!(shown(&handle), before, "the refused move is not written");
}

/// The [`MOVED`] fields of a thread on `model` of the 128000-token custom route, compacting at `trigger`.
fn route_state(model: &str, trigger: u64) -> Value {
    json!({
        "provider": "custom-fixture", "model": model, "contextWindow": 128_000, "rawContextWindow": 128_000,
        "effectiveContextWindowPercent": 100, "displayContextWindow": 128_000, "compactBoundaryTokens": 128_000,
        "autoCompactTokenLimit": trigger,
    })
}
/// Three route moves in a row (to the wider model and back, then to the wider one again with the status read failing); a move's sync
/// reads its status once (routes-write.mjs:142). The wider model's status names a trigger of its own, so a move that kept the old
/// model's trigger shows.
fn recorded_moves() -> Vec<RecordedMove> {
    const WIDE_TRIGGER: u64 = 100_000;
    let read = |trigger: u64| {
        Some(json!({ "contextWindow": 128_000, "compaction": { "boundaryTokens": 128_000, "triggerTokens": trigger, "autoCompactTokenLimit": null } }))
    };
    let (model, wide) = ("fixture-model", "fixture-wide");
    vec![
        RecordedMove { model: wide.to_owned(), read: read(WIDE_TRIGGER), before: route_state(model, 128_000), after: route_state(wide, WIDE_TRIGGER) },
        RecordedMove { model: model.to_owned(), read: read(128_000), before: route_state(wide, WIDE_TRIGGER), after: route_state(model, 128_000) },
        RecordedMove { model: wide.to_owned(), read: None, before: route_state(model, 128_000), after: route_state(wide, 128_000) },
    ]
}
/// `shown` is what the thread answered right after `recorded`, field by field.
fn assert_answers_as_node(shown: &Value, recorded: &RecordedMove, what: &str) {
    let differing: Vec<String> = MOVED
        .iter()
        .filter(|field| shown[**field] != recorded.after[**field])
        .map(|field| format!("{field}: core {} expected {}", shown[*field], recorded.after[*field]))
        .collect();
    assert!(differing.is_empty(), "{what}: {differing:#?}");
}
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
    let update: super::actor::AwaitingHeaderUpdate =
        Box::new(move |_| Box::pin(async move { mixdog_store::schema::record::HeaderChange { set, unset: Vec::new(), patch: Default::default() } }));
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
/// A route move whose status read fails is still written: the thread shows the new route, and the move answers.
#[tokio::test]
async fn a_route_move_whose_status_read_fails_is_still_written() {
    let moves = recorded_moves();
    let failed = moves.iter().find(|m| m.read.is_none()).expect("a failed read move");
    let rig = Rig::new();
    let status = GatedStatus::new();
    let (_directory, handle) = gated_thread(&rig, &status, &failed.before).await;
    status.let_through(failed.read.clone());
    awaiting(|| "the move to answer".to_owned(), move_to(&handle, &failed.after)).await.expect("the move is written");
    assert!(status.answers.lock().unwrap().is_empty(), "the move read its status once");
    assert_answers_as_node(&shown(&handle), failed, "the move with a failed read");
}
/// The header writes that waited behind a route move are taken as the inbox takes them: a stored patch whose replay reads the
/// journal holds the write sent after it until that read answers, so the two land in the order they were sent.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn writes_queued_behind_a_route_move_wait_for_a_stored_patchs_journal_read() {
    use mixdog_core_api::ThreadHandle;
    use mixdog_store::schema::blob::Slot;
    use mixdog_store::schema::record::Record;
    let recorded = recorded_moves().into_iter().find(|m| m.read.is_some()).expect("a read move");
    let rig = Rig::new();
    let status = GatedStatus::new();
    let (_directory, handle) = gated_thread(&rig, &status, &recorded.before).await;
    let switch = tokio::spawn({
        let (handle, after) = (handle.clone(), recorded.after.clone());
        async move { move_to(&handle, &after).await }
    });
    held(&handle, &status, 1).await;
    let ctx = || mixdog_core_api::call::CallContext::internal("test");
    let method = mixdog_core_api::ids::Method("thread/header/patch");
    let replay = mixdog_core_api::CoreRequest {
        method,
        params: json!({ "threadId": handle.id, "set": { "first": 1 }, "unset": [], "incarnation": &*handle.log_id }),
        op: Some(mixdog_core_api::ids::OpId::from("stored-1")),
        ctx: ctx(),
    };
    let stored = handle.stored_patch(replay, mixdog_core_ports::ports::threads::Attempt::Replay);
    tokio::pin!(stored);
    assert!(futures::poll!(stored.as_mut()).is_pending(), "the stored patch waits behind the move");
    let next = mixdog_core_api::CoreRequest { method, params: json!({ "threadId": handle.id, "set": { "second": 2 }, "unset": [] }), op: None, ctx: ctx() };
    let written = handle.request(next);
    tokio::pin!(written);
    assert!(futures::poll!(written.as_mut()).is_pending(), "the write waits behind the move");
    // Taken in after both: once it is answered, both wait in the move's queue.
    awaiting(|| "the unsaved rows".to_owned(), handle.model_messages(None)).await.expect("unsaved rows");
    status.let_through(recorded.read.clone());
    awaiting(|| "the stored patch to answer".to_owned(), stored).await.expect("the replay found no record and applied the change");
    awaiting(|| "the write to answer".to_owned(), written).await.expect("written");
    awaiting(|| "the move to answer".to_owned(), switch).await.expect("joined").expect("moved");
    let at = |key: &str| {
        rig.store
            .records(&handle.id)
            .iter()
            .position(|(_, record)| matches!(record, Record::Meta(meta) if matches!(&meta.change, Slot::Inline(change) if change.set.contains_key(key))))
    };
    assert!(at("first").expect("the stored patch") < at("second").expect("the write after it"), "the write waited for the stored patch's read");
}

#[tokio::test(start_paused = true)]
async fn switching_to_an_agent_route_replaces_a_prior_turns_context_window() {
    use mixdog_core_api::ThreadHandle;
    use mixdog_core_ports::ports::threads::ThreadState;

    struct HeaderStatus;
    #[async_trait::async_trait]
    impl super::thread_context::ContextStatusHost for HeaderStatus {
        async fn context_status(&self, _: Option<mixdog_core_api::ids::ThreadId>, _: Option<Value>) -> Result<Value, mixdog_core_api::error::CoreError> {
            Ok(Value::Null)
        }

        async fn context_status_for(
            &self,
            _: mixdog_core_api::ids::ThreadId,
            header: serde_json::Map<String, Value>,
        ) -> Result<Value, mixdog_core_api::error::CoreError> {
            Ok(json!({
                "contextWindow": header.get("contextWindow"),
                "compaction": {
                    "boundaryTokens": header.get("compactBoundaryTokens"),
                    "triggerTokens": header.get("autoCompactTokenLimit"),
                },
            }))
        }
    }

    let rig = Rig::new();
    rig.set_script(Arc::new(|run| {
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            run.cancel.cancelled().await;
            RunOutcome::Interrupted
        })
    }));
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.context_status = Arc::new(HeaderStatus);
    let directory = Arc::new(SessionDirectory::new(Arc::new(deps)));
    let handle = start_thread(&directory).await;
    let threads = super::thread_state::SessionThreads::new(directory.clone());
    let thread = &handle.id;
    let patch = |set: Value| {
        let writer = &threads;
        async move {
            writer.patch_header(thread, set.as_object().unwrap().clone(), Vec::new()).await.unwrap();
        }
    };
    let read_context = || async {
        let read = handle.request(super::tests::request("thread/read", json!({ "threadId": handle.id }), "read")).await.unwrap();
        let mixdog_core_api::Reply::Value(read) = read else { panic!("thread/read must answer a value") };
        read["state"]["context"].clone()
    };

    patch(json!({
        "provider": "anthropic-oauth",
        "model": "claude-opus-5-5",
        "contextWindow": 500_000,
        "rawContextWindow": 1_000_000,
        "effectiveContextWindowPercent": 50,
        "compactBoundaryTokens": 500_000,
        "autoCompactTokenLimit": 460_000,
    }))
    .await;
    handle
        .set_section(Section::Context(ThreadContext {
            context_window: Some(500_000),
            display_context_window: Some(500_000),
            compact_boundary_tokens: Some(500_000),
            auto_compact_token_limit: Some(460_000),
            ..Default::default()
        }))
        .await
        .unwrap();
    assert_eq!(read_context().await["contextWindow"], json!(500_000));

    patch(json!({
        "provider": "acp-antigravity-cli",
        "model": "claude-opus-5-5",
        "contextWindow": 1_000_000,
        "rawContextWindow": 1_000_000,
        "effectiveContextWindowPercent": 100,
        "compactBoundaryTokens": 1_000_000,
        "autoCompactTokenLimit": 1_000_000,
    }))
    .await;
    let after_switch = read_context().await;
    assert_eq!(
        (&after_switch["contextWindow"], &after_switch["displayContextWindow"], &after_switch["compactBoundaryTokens"]),
        (&json!(1_000_000), &json!(1_000_000), &json!(1_000_000))
    );

    let started = turn(&handle, "agent-turn", "op-acp").await;
    patch(json!({
        "contextWindow": 1_048_576,
        "rawContextWindow": 1_048_576,
        "compactBoundaryTokens": 1_048_576,
        "acpContextWindow": 1_048_576,
    }))
    .await;
    assert_eq!(read_context().await["contextWindow"], json!(1_048_576));
    handle.interrupt(&TurnId::from(started["turnId"].as_str().expect("turn id")), None).expect("interrupt");
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    let settled = read_context().await;
    assert_eq!(
        (&settled["contextWindow"], &settled["displayContextWindow"], &settled["compactBoundaryTokens"]),
        (&json!(1_048_576), &json!(1_048_576), &json!(1_048_576))
    );
    directory.shutdown().await;
}
