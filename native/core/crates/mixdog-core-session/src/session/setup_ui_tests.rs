//! The setup tool's desktop request notice against `fixtures/setup-ui/golden.json` (recorded by
//! `record-setup-ui.mjs` from Node's own `createSetupUiRequests` over `createNotificationBus`,
//! with a session store's router or `mixdog exec`'s listener bound): the event the thread's feed
//! carries, whether the request is taken, and the request's outcome through the real broker.
//! A golden `store` listener is a daemon session runtime, which here is a thread loaded in the
//! directory; no client needs to watch it. A session without one is a thread not loaded.

use std::collections::HashMap;
use std::sync::Arc;

use mixdog_app_protocol::v2::thread::ThreadSessionOptions;
use mixdog_app_protocol::v2::thread::ToolProfile;
use mixdog_core_agents::setup::DesktopAnswer;
use mixdog_core_agents::setup::SetupDesktop;
use mixdog_core_agents::setup::SetupRequests;
use mixdog_core_agents::setup::SetupUiSurface;
use mixdog_protocol::ThreadId;
use serde_json::Value;
use serde_json::json;

use super::SessionSetupUi;
use crate::session::SessionDirectory;
use crate::session::testing::Rig;
use crate::session::tests::eventually;
use crate::session::tests::start_thread;

fn golden() -> Value {
    serde_json::from_str(include_str!("../../../../fixtures/setup-ui/golden.json")).expect("golden.json")
}

/// The scenarios a daemon thread can be in: every one but `exec-only`, whose headless runtime
/// has no daemon counterpart (see `exec_runs_never_reach_a_desktop_request`).
fn daemon_scenarios(golden: &Value) -> impl Iterator<Item = &Value> {
    golden["scenarios"].as_array().expect("scenarios").iter().filter(|s| s["name"] != "exec-only")
}

/// The `thread/notification` params published on `thread`'s feed so far.
fn notices(rig: &Rig, thread: &ThreadId) -> Vec<Value> {
    rig.feeds.frames(thread.as_str()).into_iter().filter(|(_, method, _)| method == "thread/notification").map(|(_, _, params)| params).collect()
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_scenario_answers_and_publishes_as_node() {
    let golden = golden();
    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    let surface = SessionSetupUi::new(directory.clone());
    for scenario in daemon_scenarios(&golden) {
        let name = scenario["name"].as_str().expect("name");
        let threads = threads(&directory, &golden, scenario).await;
        let call = &scenario["calls"][0];
        let id = call["meta"]["id"].as_str().expect("request id");
        let from = &threads[golden["session"].as_str().expect("session")];
        assert_eq!(surface.notify(from, id).await, call["handled"].as_bool().expect("handled"), "{name}");
        // Each thread's feed carries the events its store took.
        for (session, thread) in &threads {
            let expected: Vec<Value> = scenario["received"]
                .as_array()
                .expect("received")
                .iter()
                .filter(|r| r["session"] == session.as_str() && r["listener"] == "store")
                .map(|r| json!({ "threadId": thread.as_str(), "content": r["event"]["content"], "meta": r["event"]["meta"] }))
                .collect();
            if !expected.is_empty() {
                eventually(|| (!notices(&rig, thread).is_empty()).then_some(())).await;
            }
            assert_eq!(notices(&rig, thread), expected, "{name} {session}");
        }
    }
}

/// Time is paused: the claim always comes inside Node's 15 s window, however slow the machine.
#[tokio::test(start_paused = true)]
async fn the_broker_runs_nodes_scenarios_over_the_session_surface() {
    let golden = golden();
    let owner = golden["owner"].as_str().expect("owner");
    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    let broker = Arc::new(SetupRequests::new(Arc::new(SessionSetupUi::new(directory.clone()))));
    for scenario in daemon_scenarios(&golden) {
        let name = scenario["name"].as_str().expect("name");
        let from = threads(&directory, &golden, scenario).await[golden["session"].as_str().expect("session")].clone();
        let outcome = &scenario["outcome"];
        if scenario["claim"].is_null() {
            // Node's unclaimed error, at once.
            assert_eq!(outcome["code"], "SETUP_DESKTOP_UNCLAIMED", "{name}");
            let answer = broker.request(&from, &golden["args"]).await.expect("answer");
            assert_eq!(answer, DesktopAnswer::Unclaimed(outcome["error"].as_str().expect("error").to_owned()), "{name}");
            assert!(notices(&rig, &from).is_empty(), "{name}");
            continue;
        }
        // The desktop takes the notice from the feed, claims the request it names and completes it.
        let pending = tokio::spawn({
            let (broker, from, args) = (broker.clone(), from.clone(), golden["args"].clone());
            async move { broker.request(&from, &args).await }
        });
        let notice = eventually(|| notices(&rig, &from).into_iter().next()).await;
        let event = &scenario["received"][0]["event"];
        assert_eq!(notice["content"], event["content"], "{name}");
        assert_eq!(notice["meta"]["kind"], event["meta"]["kind"], "{name}");
        let keys = |meta: &Value| meta.as_object().expect("meta").keys().cloned().collect::<std::collections::BTreeSet<_>>();
        assert_eq!(keys(&notice["meta"]), keys(&event["meta"]), "{name}");
        let id = notice["meta"]["id"].as_str().expect("request id");
        let claim = broker.claim(&from, id, owner).expect("claimed");
        assert_eq!(claim, json!({ "id": id, "args": scenario["claim"]["args"], "scope": scenario["claim"]["scope"] }), "{name}");
        assert!(broker.complete(id, owner, &golden["receipt"]).expect("receipt"), "{name}");
        assert_eq!(pending.await.expect("request").expect("answer"), DesktopAnswer::Done(outcome["value"].clone()), "{name}");
    }
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
