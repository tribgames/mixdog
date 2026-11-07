use std::collections::HashMap;
use std::sync::atomic::Ordering;

use serde_json::{Value, json};
use tokio::sync::oneshot;

use super::*;
use crate::rooms::calls::tests::{Fake, status};
use crate::rooms::room_relay::tests::{options, relay_over};
use mixdog_services::bots::delivery::env::FollowRecord;

/// Node's recording of the real `agent-room-host.mjs` over attach and detach steps (`record-room-host.mjs`).
const TWIN: &str = include_str!("../../../../../fixtures/room-host/room-host-twin.json");

struct NoRecord;

#[async_trait]
impl FollowRecord for NoRecord {
    async fn record(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
}

fn follow() -> WakeFollow {
    WakeFollow::new(Arc::new(NoRecord))
}

/// The recorder's stand-in host: its turn settles with its own name, and what it was asked is kept in the shared log.
struct Named {
    name: String,
    asked: Arc<Mutex<Vec<Value>>>,
}

#[async_trait]
impl RoomRelay for Named {
    async fn relay(&self, session_id: &str, prompt: &str, options: WakeOptions, _: WakeFollow) -> Result<Option<WakeTurn>, String> {
        self.asked.lock().unwrap().push(json!({ "host": self.name, "sessionId": session_id, "prompt": prompt, "id": options.id, "hop": options.hop }));
        let (settle, settled) = oneshot::channel();
        settle.send(self.name.clone()).unwrap();
        Ok(Some(WakeTurn { settled }))
    }
}

/// `agentRoomHost()`: which host is active, told by the turn it answers.
async fn active_name(registry: &RoomHostRegistry) -> Result<String, String> {
    let host = registry.active()?;
    let turn = host.relay("probe", "", options("", 0), follow()).await?.expect("a turn");
    Ok(status(turn.settled).await)
}

#[tokio::test]
async fn attach_detach_and_relay_answer_as_nodes_registry_does() {
    let twin: Value = serde_json::from_str(TWIN).unwrap();
    let steps = twin["steps"].as_array().unwrap();
    assert!(steps.len() > 25);
    let registry = Arc::new(RoomHostRegistry::default());
    let asked = Arc::new(Mutex::new(Vec::new()));
    let mut handles = HashMap::new();
    for step in steps {
        let expected = &step["answer"];
        let node_error = expected.get("error").map(|error| {
            assert_eq!(error["name"], "Error", "Node throws a plain Error: {step}");
            error["message"].as_str().unwrap().to_owned()
        });
        match step["op"].as_str().unwrap() {
            "register" => {
                let host = Named { name: step["host"].as_str().unwrap().to_owned(), asked: asked.clone() };
                handles.insert(step["as"].as_str().unwrap().to_owned(), registry.register(Arc::new(host)));
            }
            "unregister" => handles[step["as"].as_str().unwrap()].unregister(),
            "active" => match active_name(&registry).await {
                Ok(name) => assert_eq!(json!({ "host": name }), *expected, "{step}"),
                Err(message) => assert_eq!(Some(message), node_error, "{step}"),
            },
            "relay" => {
                asked.lock().unwrap().clear();
                let given = WakeOptions { id: step["options"]["id"].as_str().unwrap().to_owned(), hop: step["options"]["hop"].as_u64().unwrap().try_into().unwrap() };
                let got = registry.relay(step["sessionId"].as_str().unwrap(), step["prompt"].as_str().unwrap(), given, follow()).await;
                match got {
                    Ok(turn) => {
                        let host = status(turn.expect("a turn").settled).await;
                        let seen = asked.lock().unwrap().clone();
                        assert_eq!(seen.len(), 1, "{step}");
                        assert_eq!(json!({ "relayed": seen[0] }), *expected, "{step}");
                        assert_eq!(seen[0]["host"], host.as_str());
                    }
                    Err(message) => {
                        assert_eq!(Some(message), node_error, "{step}");
                        assert!(asked.lock().unwrap().is_empty(), "{step}");
                    }
                }
            }
            other => panic!("a recorded step with no mapping: {other}"),
        }
    }
}

#[tokio::test]
async fn the_attached_core_relays_in_its_room_and_a_detached_one_refuses_with_nodes_text() {
    let runner = Arc::new(Fake::default());
    let (member_relay, _) = relay_over(&runner).await;
    let session = mixdog_core_base::rooms::ids::room_member_session_id("room01", "bench").unwrap();
    let registry = Arc::new(RoomHostRegistry::default());

    // Nothing attached yet: the relay throws before it reaches any room.
    let before = registry.relay(&session, "REPORT: done", options("awake_1", 2), follow()).await;
    assert_eq!(before.err().as_deref(), Some("group rooms run in the desktop app, and no desktop app is attached to this runtime"));

    let attached = registry.register(Arc::new(member_relay));
    let turn = registry.relay(&session, "REPORT: done", options("awake_2", 2), follow()).await.unwrap().expect("a turn");
    assert_eq!(status(turn.settled).await, "done");
    assert_eq!(*runner.seen.lock().unwrap(), vec![(vec!["bench".to_string()], true, 1)]);
    assert_eq!(runner.cut_offs.load(Ordering::SeqCst), 0);

    // The host's own refusals come through the registry unchanged.
    let plain = registry.relay("sess_home_bench", "REPORT", options("awake_3", 0), follow()).await;
    assert_eq!(plain.err().as_deref(), Some("Not a group-room member session."));

    // Detached again: the next relay refuses and reaches no room.
    attached.unregister();
    runner.seen.lock().unwrap().clear();
    let after = registry.relay(&session, "REPORT: done", options("awake_4", 2), follow()).await;
    assert_eq!(after.err().as_deref(), Some(NO_HOST));
    assert!(runner.seen.lock().unwrap().is_empty());
}
