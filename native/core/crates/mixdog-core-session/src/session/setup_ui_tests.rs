//! The setup tool's desktop request notice against `fixtures/setup-ui/golden.json` (recorded by
//! `record-setup-ui.mjs` from Node's own `createSetupUiRequests` over `createNotificationBus`,
//! with a session store's router or `mixdog exec`'s listener bound): the event a surface
//! receives, whether the request finds one, and the request's outcome through the real broker.
//! A golden `store` listener is a desktop watching the thread (a session surface); an `exec`
//! one is a `mixdog exec` client attached to the thread's feed, which is not.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;

use mixdog_core_agents::setup::DesktopAnswer;
use mixdog_core_agents::setup::SetupDesktop;
use mixdog_core_agents::setup::SetupRequests;
use mixdog_core_agents::setup::SetupUiSurface;
use mixdog_core_api::SessionSurfaces;
use mixdog_protocol::ThreadId;
use serde_json::Value;
use serde_json::json;

use super::SessionSetupUi;
use crate::session::SessionDirectory;
use crate::session::SessionHandle;
use crate::session::testing::Rig;
use crate::session::testing::lock;
use crate::session::tests::eventually;
use crate::session::tests::start_thread;

fn golden() -> Value {
    serde_json::from_str(include_str!("../../../../fixtures/setup-ui/golden.json")).expect("golden.json")
}

/// The threads a session surface watches, as the server's connection table answers.
#[derive(Default)]
struct Watching(Mutex<HashSet<ThreadId>>);

impl SessionSurfaces for Watching {
    fn surface_on(&self, thread: &ThreadId) -> bool {
        lock(&self.0).contains(thread)
    }
}

/// A client attaches to the thread's feed (the counting `FeedSource::attach`); a session
/// surface also watches it.
fn attach(handle: &SessionHandle, watching: &Watching, surface: bool) {
    assert!(handle.cell.subscribing());
    handle.cell.subscribed(true);
    if surface {
        lock(&watching.0).insert(handle.id.clone());
    }
}

/// The `thread/notification` params published on `thread`'s feed so far.
fn notices(rig: &Rig, thread: &ThreadId) -> Vec<Value> {
    rig.feeds.frames(thread.as_str()).into_iter().filter(|(_, method, _)| method == "thread/notification").map(|(_, _, params)| params).collect()
}

struct World {
    rig: Rig,
    directory: Arc<SessionDirectory>,
    watching: Arc<Watching>,
}

impl World {
    fn new() -> Self {
        let rig = Rig::new();
        let directory = Arc::new(SessionDirectory::new(rig.deps()));
        Self { rig, directory, watching: Arc::default() }
    }

    fn surface(&self) -> SessionSetupUi {
        SessionSetupUi::new(self.directory.clone(), self.watching.clone())
    }

    /// One fresh thread per golden session id, with the scenario's listeners attached.
    async fn threads(&self, golden: &Value, scenario: &Value) -> HashMap<String, Arc<SessionHandle>> {
        let mut threads = HashMap::new();
        for session in [golden["session"].as_str().expect("session"), "sess_other"] {
            threads.insert(session.to_owned(), start_thread(&self.directory).await);
        }
        for surface in scenario["surfaces"].as_array().expect("surfaces") {
            let handle = &threads[surface["session"].as_str().expect("session")];
            attach(handle, &self.watching, surface["listener"] == "store");
        }
        threads
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_scenario_answers_and_publishes_as_node() {
    let golden = golden();
    let world = World::new();
    let surface = world.surface();
    for scenario in golden["scenarios"].as_array().expect("scenarios") {
        let name = scenario["name"].as_str().expect("name");
        let threads = world.threads(&golden, scenario).await;
        let from = &threads[golden["session"].as_str().expect("session")];
        let call = &scenario["calls"][0];
        let id = call["meta"]["id"].as_str().expect("request id");
        assert_eq!(surface.notify(&from.id, id).await, call["handled"].as_bool().expect("handled"), "{name}");
        // The event each session store took; a listener that did not take it shows nothing.
        let taken: Vec<&Value> = if call["handled"] == true {
            scenario["received"].as_array().expect("received").iter().filter(|r| r["listener"] == "store").collect()
        } else {
            Vec::new()
        };
        for (session, handle) in &threads {
            let expected: Vec<Value> = taken
                .iter()
                .filter(|r| r["session"] == session.as_str())
                .map(|r| json!({ "threadId": handle.id.as_str(), "content": r["event"]["content"], "meta": r["event"]["meta"] }))
                .collect();
            if !expected.is_empty() {
                eventually(|| (!notices(&world.rig, &handle.id).is_empty()).then_some(())).await;
            }
            assert_eq!(notices(&world.rig, &handle.id), expected, "{name} {session}");
        }
    }
    // A thread this process has not loaded shows nothing, whoever watches it.
    let ghost = ThreadId::from("sess_not_loaded");
    lock(&world.watching.0).insert(ghost.clone());
    assert!(!surface.notify(&ghost, "id").await);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_broker_runs_nodes_scenarios_over_the_session_surface() {
    let golden = golden();
    let owner = golden["owner"].as_str().expect("owner");
    let world = World::new();
    let broker = Arc::new(SetupRequests::new(Arc::new(world.surface())));
    for scenario in golden["scenarios"].as_array().expect("scenarios") {
        let name = scenario["name"].as_str().expect("name");
        let threads = world.threads(&golden, scenario).await;
        let from = threads[golden["session"].as_str().expect("session")].id.clone();
        let outcome = &scenario["outcome"];
        if scenario["claim"].is_null() {
            // Node's unclaimed error, at once.
            assert_eq!(outcome["code"], "SETUP_DESKTOP_UNCLAIMED", "{name}");
            let answer = broker.request(&from, &golden["args"]).await.expect("answer");
            assert_eq!(answer, DesktopAnswer::Unclaimed(outcome["error"].as_str().expect("error").to_owned()), "{name}");
            assert!(notices(&world.rig, &from).is_empty(), "{name}");
            continue;
        }
        // The surface takes the notice, claims the request it names and completes it.
        let pending = tokio::spawn({
            let (broker, from, args) = (broker.clone(), from.clone(), golden["args"].clone());
            async move { broker.request(&from, &args).await }
        });
        let notice = eventually(|| notices(&world.rig, &from).into_iter().next()).await;
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
