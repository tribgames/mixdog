//! A bot's pick reaching one of its chats: the chat takes it as a deferred, session-only selection, and a pick it already runs
//! is left alone.

use std::sync::Arc;

use mixdog_core_api::ids::ThreadId;
use mixdog_core_ports::ports::route::{ChatRouteSetter, FollowOptions, Route};
use mixdog_core_ports::ports::route_write::RouteWriter;
use serde_json::{Value, json};

use super::chat_routes::ChatRoutes;
use super::route_service_tests::rig;

fn case() -> Value {
    json!({
        "config": {
            "default": "quick",
            "presets": [{ "id": "quick", "model": "nope-9", "name": "Quick", "provider": "openai", "type": "agent" }],
            "providers": { "openai": { "apiKey": "sk-fake" } }
        },
        "live": { "autoEffort": true, "effort": null, "fast": false, "model": "nope-9", "modelParameters": {}, "provider": "openai" },
        "meta": { "contextWindow": 400000, "id": "x", "maxContextWindow": 200000, "name": "Model X", "provider": "y", "supportsFastMode": true },
        "fastTable": { "gemini": false },
        "continueSession": null
    })
}

fn pick(route: Value) -> Route {
    let mut pick = route.as_object().cloned().unwrap();
    pick.insert("sessionOnly".into(), json!(true));
    pick
}

fn deferred() -> FollowOptions {
    FollowOptions { defer_until_next_turn: true, switch_established: true, ..FollowOptions::default() }
}

#[tokio::test]
async fn a_bots_pick_reaches_the_chat_as_a_deferred_selection() {
    let (service, _writer, log, _dir) = rig(&case()).await;
    let chats = ChatRoutes::new(Arc::new(service));
    let thread = ThreadId::from("sess_home_writer");
    chats.set_route(&thread, pick(json!({ "provider": "gemini", "model": "gemini-2.5-pro" })), deferred()).await.unwrap();
    let log = log.lock().unwrap();
    assert_eq!(log.follows.len(), 1, "the selection follows once");
    let follow = &log.follows[0];
    assert!(follow.defer_until_next_turn && follow.switch_established && !follow.apply_to_current_session, "{follow:?}");
}

#[tokio::test]
async fn a_pick_the_chat_already_runs_is_left_alone() {
    let (service, writer, log, _dir) = rig(&case()).await;
    let chats = ChatRoutes::new(Arc::new(service));
    let thread = ThreadId::from("sess_home_writer");
    chats.set_route(&thread, pick(json!({ "provider": "gemini", "model": "gemini-2.5-pro" })), deferred()).await.unwrap();
    let live = writer.route(&thread);
    assert_eq!(live.get("model"), Some(&json!("gemini-2.5-pro")), "the first pick left its model: {live:?}");
    chats.set_route(&thread, pick(json!({ "provider": live["provider"], "model": live["model"] })), deferred()).await.unwrap();
    assert_eq!(log.lock().unwrap().follows.len(), 1, "no second selection");
}
