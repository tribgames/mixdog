//! A bot's pick reaching one of its chats, over the route service of the Node recording
//! (`fixtures/ai-admin/route-service-twin.json`): the chat takes it as a deferred, session-only
//! selection, and a pick it already runs is left alone.

use std::sync::Arc;

use mixdog_core_api::ids::ThreadId;
use mixdog_core_ports::ports::route::ChatRouteSetter;
use mixdog_core_ports::ports::route::FollowOptions;
use mixdog_core_ports::ports::route::Route;
use mixdog_core_ports::ports::route_write::RouteWriter;
use serde_json::Value;
use serde_json::json;

use super::chat_routes::ChatRoutes;
use super::route_service_tests::rig;

fn twin() -> Value {
    serde_json::from_str(include_str!("../../../../../fixtures/ai-admin/route-service-twin.json")).unwrap()
}

/// A successful, unaddressed `setRoute` of the recording that names a model.
fn case() -> Value {
    twin()["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["kind"] == "setRoute" && c.get("error").is_none() && c["options"] == json!({}) && c["request"]["model"].is_string())
        .unwrap()
        .clone()
}

/// `sessionRoutePick`: the saved route's keys and `sessionOnly`.
fn pick(route: &Value) -> Route {
    let mut pick = route.as_object().cloned().unwrap();
    pick.insert("sessionOnly".into(), json!(true));
    pick
}

/// What `AgentRouteFollow` hands every chat.
fn deferred() -> FollowOptions {
    FollowOptions { defer_until_next_turn: true, switch_established: true, ..FollowOptions::default() }
}

#[tokio::test]
async fn a_bots_pick_reaches_the_chat_as_a_deferred_selection() {
    let case = case();
    let (service, _writer, log, _dir) = rig(&case).await;
    let chats = ChatRoutes::new(Arc::new(service));
    let thread = ThreadId::from("sess_home_writer");
    chats.set_route(&thread, pick(&case["request"]), deferred()).await.unwrap();
    let log = log.lock().unwrap();
    assert_eq!(log.follows.len(), 1, "the selection follows once");
    let follow = &log.follows[0];
    assert!(follow.defer_until_next_turn && follow.switch_established && !follow.apply_to_current_session, "{follow:?}");
}

#[tokio::test]
async fn a_pick_the_chat_already_runs_is_left_alone() {
    let case = case();
    let (service, writer, log, _dir) = rig(&case).await;
    let chats = ChatRoutes::new(Arc::new(service));
    let thread = ThreadId::from("sess_home_writer");
    chats.set_route(&thread, pick(&case["request"]), deferred()).await.unwrap();
    let live = writer.route(&thread);
    assert!(live.get("model").and_then(Value::as_str).is_some_and(|model| !model.is_empty()), "the first pick left a model: {live:?}");
    let same = pick(&json!({ "provider": live["provider"], "model": live["model"] }));
    chats.set_route(&thread, same, deferred()).await.unwrap();
    assert_eq!(log.lock().unwrap().follows.len(), 1, "no second selection");
}
