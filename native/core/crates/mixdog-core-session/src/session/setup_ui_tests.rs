//! The setup tool's desktop request against `fixtures/setup-ui/golden.json` (recorded by
//! `record-setup-ui.mjs` from Node's own `createSetupUiRequests` over `createNotificationBus`,
//! with a session store's router or `mixdog exec`'s listener bound): whether the request is
//! taken, the `setupUiRequest` the thread then holds (the store's patch), and the request's
//! outcome through the real broker. A golden `store` listener is a daemon session runtime,
//! here a thread loaded in the directory; no client needs to watch it. A session without one
//! is a thread not loaded.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use bytes::Bytes;
use mixdog_app_protocol::v2::thread::ThreadSessionOptions;
use mixdog_app_protocol::v2::thread::ToolProfile;
use mixdog_core_agents::setup::DesktopAnswer;
use mixdog_core_agents::setup::SetupDesktop;
use mixdog_core_agents::setup::SetupRequests;
use mixdog_core_agents::setup::SetupUiSurface;
use mixdog_core_api::FeedSource;
use mixdog_core_api::feed::Window;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::mock::MockConnection;
use mixdog_core_api::mock::MockLimits;
use mixdog_core_api::sink::ConnectionSink;
use mixdog_protocol::ThreadId;
use serde_json::Value;
use serde_json::json;

use super::SessionSetupUi;
use crate::session::SessionDirectory;
use crate::session::SessionHandle;
use crate::session::testing::Rig;
use crate::eventually_on_until;
use crate::eventually_on;
use crate::session::tests::start_thread;

/// Far beyond any test: the window that never ends inside one.
const LONG: Duration = Duration::from_secs(600);

fn golden() -> Value {
    serde_json::from_str(include_str!("../../../../fixtures/setup-ui/golden.json")).expect("golden.json")
}

/// The scenarios a daemon thread can be in: every one but `exec-only`, whose headless runtime
/// has no daemon counterpart (see `exec_runs_never_reach_a_desktop_request`).
fn daemon_scenarios(golden: &Value) -> impl Iterator<Item = &Value> {
    golden["scenarios"].as_array().expect("scenarios").iter().filter(|s| s["name"] != "exec-only")
}

/// A rig whose clock reads the golden's (`Date.now` of the recording).
fn rig(golden: &Value) -> (Rig, Arc<SessionDirectory>) {
    let rig = Rig::new();
    rig.clock.0.store(golden["now"].as_u64().expect("now"), Ordering::SeqCst);
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    (rig, directory)
}

/// The `thread/setupUiRequest/updated` values published on `thread`'s feed so far.
fn published(rig: &Rig, thread: &ThreadId) -> Vec<Value> {
    rig.feeds
        .frames(thread.as_str())
        .into_iter()
        .filter(|(_, method, _)| method == "thread/setupUiRequest/updated")
        .map(|(_, _, params)| params["value"].clone())
        .collect()
}

/// The thread of each golden session id: loaded (with no subscriber) when the session has a
/// store listener, otherwise an id this directory never loaded.
async fn threads(directory: &SessionDirectory, golden: &Value, scenario: &Value) -> HashMap<String, ThreadId> {
    let name = scenario["name"].as_str().expect("name");
    let mut threads = HashMap::new();
    for session in [golden["session"].as_str().expect("session"), "sess_other"] {
        let live = scenario["surfaces"].as_array().expect("surfaces").iter().any(|s| s["session"] == session && s["listener"] == "store");
        let id = if live { start_thread(directory).await.id.clone() } else { ThreadId::from(format!("{name}-{session}").as_str()) };
        threads.insert(session.to_owned(), id);
    }
    threads
}

/// A client attaches to the thread's feed by snapshot (no resume position) and stays attached:
/// the `state` its `thread/snapshot` carries.
async fn snapshot_state(handle: &Arc<SessionHandle>, client: u64) -> Value {
    let connection = MockConnection::new(ConnectionId(client), MockLimits::default());
    let source: Arc<dyn FeedSource> = handle.clone();
    let sub = format!("snapshot-{client}");
    let attached = mixdog_core_api::feed::subscribe(&source, sub.as_str().into(), Window::LastItems(10), None, &connection).expect("attach");
    connection.send_control_release(Bytes::from_static(b"{}"), attached.release).expect("release");
    // `drain_text` renders `control:<frame>` or `<sub>:<frame>`.
    let frame_of = |text: &String| serde_json::from_str::<Value>(text.split_once(':').expect("a rendered frame").1).expect("a JSON frame");
    let frames = connection.drain_text_until(|texts| texts.iter().any(|text| frame_of(text)["method"] == "thread/snapshot")).await;
    frames.iter().map(frame_of).find(|frame| frame["method"] == "thread/snapshot").expect("the awaited snapshot")["params"]["state"].clone()
}

#[tokio::test(start_paused = true)]
async fn every_scenario_answers_and_holds_the_request_as_node() {
    let golden = golden();
    let (rig, directory) = rig(&golden);
    let surface = SessionSetupUi::new(directory.clone());
    for scenario in daemon_scenarios(&golden) {
        let name = scenario["name"].as_str().expect("name");
        let threads = threads(&directory, &golden, scenario).await;
        let call = &scenario["calls"][0];
        let id = call["meta"]["id"].as_str().expect("request id");
        let from = &threads[golden["session"].as_str().expect("session")];
        assert_eq!(surface.notify(from, id, LONG).await, call["handled"].as_bool().expect("handled"), "{name}");
        // The thread that took the request holds the store's `setupUiRequest`; no other does.
        for (session, thread) in &threads {
            let expected: Vec<Value> = if session == golden["session"].as_str().expect("session") {
                scenario["patches"].as_array().expect("patches").iter().map(|patch| patch["setupUiRequest"].clone()).collect()
            } else {
                Vec::new()
            };
            if !expected.is_empty() {
                eventually_on!(&[&rig.feeds.published], || (!published(&rig, thread).is_empty()).then_some(())).await;
            }
            assert_eq!(published(&rig, thread), expected, "{name} {session}");
        }
    }
}

/// Time is paused: the claim always comes inside Node's 15 s window, however slow the machine.
#[tokio::test(start_paused = true)]
async fn the_broker_runs_nodes_scenarios_over_the_session_surface() {
    let golden = golden();
    let owner = golden["owner"].as_str().expect("owner");
    let (rig, directory) = rig(&golden);
    let broker = Arc::new(SetupRequests::new(Arc::new(SessionSetupUi::new(directory.clone()))));
    for scenario in daemon_scenarios(&golden) {
        let name = scenario["name"].as_str().expect("name");
        let from = threads(&directory, &golden, scenario).await[golden["session"].as_str().expect("session")].clone();
        let outcome = &scenario["outcome"];
        if scenario["claim"].is_null() {
            // Node's unclaimed error, at once; the thread shows nothing.
            assert_eq!(outcome["code"], "SETUP_DESKTOP_UNCLAIMED", "{name}");
            let answer = broker.request(&from, &golden["args"]).await.expect("answer");
            assert_eq!(answer, DesktopAnswer::Unclaimed(outcome["error"].as_str().expect("error").to_owned()), "{name}");
            assert!(published(&rig, &from).is_empty(), "{name}");
            continue;
        }
        // A window reads the request from the thread, claims it and completes it; the claim
        // takes it off the thread.
        let mut pending = tokio::spawn({
            let (broker, from, args) = (broker.clone(), from.clone(), golden["args"].clone());
            async move { broker.request(&from, &args).await }
        });
        let shown = eventually_on_until!(&[&rig.feeds.published], || published(&rig, &from).into_iter().next(), &mut pending).await;
        let patch = &scenario["patches"][0]["setupUiRequest"];
        assert_eq!(shown["at"], patch["at"], "{name}");
        let keys = |v: &Value| v.as_object().expect("request").keys().cloned().collect::<std::collections::BTreeSet<_>>();
        assert_eq!(keys(&shown), keys(patch), "{name}");
        let id = shown["id"].as_str().expect("request id");
        let claim = broker.claim(&from, id, owner).expect("claimed");
        assert_eq!(claim, json!({ "id": id, "args": scenario["claim"]["args"], "scope": scenario["claim"]["scope"] }), "{name}");
        eventually_on_until!(&[&rig.feeds.published], || (published(&rig, &from).len() == 2).then_some(()), &mut pending).await;
        assert_eq!(published(&rig, &from)[1], Value::Null, "{name}: the claim clears it");
        assert!(broker.complete(id, owner, &golden["receipt"]).expect("receipt"), "{name}");
        assert_eq!(pending.await.expect("request").expect("answer"), DesktopAnswer::Done(outcome["value"].clone()), "{name}");
    }
}

/// A client that attaches by snapshot inside the claim window sees the request, as a replay
/// client does; one that attaches after the window ends, or after a claim, does not.
#[tokio::test(start_paused = true)]
async fn a_snapshot_carries_the_request_only_while_it_can_be_claimed() {
    let golden = golden();
    let (rig, directory) = rig(&golden);
    // The window ends only when the test advances the virtual clock past it, so a snapshot and a claim inside it cannot be late.
    let window = Duration::from_millis(1500);
    let broker = Arc::new(SetupRequests::with_timeouts(Arc::new(SessionSetupUi::new(directory.clone())), window, LONG));
    let handle = start_thread(&directory).await;
    let thread = handle.id.clone();
    let request = |broker: &Arc<SetupRequests>| {
        let (broker, thread, args) = (broker.clone(), thread.clone(), golden["args"].clone());
        tokio::spawn(async move { broker.request(&thread, &args).await })
    };

    // Unclaimed: seen inside the window, gone after it.
    let mut pending = request(&broker);
    let shown = eventually_on_until!(&[&rig.feeds.published], || published(&rig, &thread).into_iter().next(), &mut pending).await;
    assert_eq!(snapshot_state(&handle, 1).await["setupUiRequest"], shown, "inside the window");
    tokio::time::advance(window).await;
    assert_eq!(
        pending.await.expect("request").expect("answer"),
        DesktopAnswer::Unclaimed("setup: no Desktop window claimed the request; nothing was changed".into())
    );
    eventually_on!(&[&rig.feeds.published], || (published(&rig, &thread).last() == Some(&Value::Null)).then_some(())).await;
    assert!(snapshot_state(&handle, 2).await.get("setupUiRequest").is_none(), "after the window");

    // Claimed inside the window: a later snapshot no longer carries it.
    let mut pending = request(&broker);
    let shown = eventually_on_until!(&[&rig.feeds.published], || published(&rig, &thread).into_iter().nth(2), &mut pending).await;
    assert_eq!(snapshot_state(&handle, 3).await["setupUiRequest"], shown, "a second request, inside its window");
    let id = shown["id"].as_str().expect("request id");
    broker.claim(&thread, id, golden["owner"].as_str().expect("owner")).expect("claimed");
    eventually_on_until!(&[&rig.feeds.published], || (published(&rig, &thread).len() == 4).then_some(()), &mut pending).await;
    assert!(snapshot_state(&handle, 4).await.get("setupUiRequest").is_none(), "after the claim");
    broker.dispose();
    let _ = pending.await;
}

/// `exec-only`: Node's headless runtime never takes the notice. `mixdog exec` runs its own core
/// with the headless tool profile, whose schema allowlist (`HEADLESS_MODEL_TOOL_NAMES`) has no
/// `setup` tool, so no exec thread can make a desktop request.
#[test]
fn exec_runs_never_reach_a_desktop_request() {
    let golden = golden();
    let exec = golden["scenarios"].as_array().expect("scenarios").iter().find(|s| s["name"] == "exec-only").expect("exec-only");
    assert_eq!(exec["calls"][0]["handled"], false);
    let mut header = mixdog_store::schema::record::Header::new();
    crate::session::session_options::write_header(&ThreadSessionOptions { tool_profile: Some(ToolProfile::Headless), ..ThreadSessionOptions::default() }, &mut header);
    let allowed = header["schemaAllowedTools"].as_array().expect("schemaAllowedTools");
    assert!(!allowed.is_empty() && !allowed.contains(&json!("setup")), "{allowed:?}");
}
