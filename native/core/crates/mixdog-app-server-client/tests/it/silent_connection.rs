//! Node's silent event stream against the core's client connection (`session-transport-state-lanes` case 446, recorded from
//! `record-session-transport-state-lanes.mjs`): a connection the server leaves silent for ten minutes is not ended by the client;
//! a call made after the silence is answered on the same connection, and only the socket closing ends it.
// Test code reads the shared recording directly.
#![allow(clippy::disallowed_methods)]

use std::{path::PathBuf, sync::Arc, time::Duration};

use mixdog_app_server_client::{
    CallOptions, ClientEvent, ConnectOptions, ConnectionStatus, Json, ProtocolClient, Target, connect, mock::MockNetwork,
};
use serde_json::json;

fn recording() -> Json {
    let path = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/session-transport-state-lanes/recording.json"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn options() -> Json {
    let path = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../packages/protocol-client/conformance/options.json"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}


/// A client connected over `net` and the connection it opened, the handshake done.
async fn attached(net: &Arc<MockNetwork>) -> (Arc<mixdog_app_server_client::engine::Client>, mixdog_app_server_client::mock::MockConn) {
    let options = options();
    let mut opts = ConnectOptions::new(Target { id: "local".into() }, net.clone(), serde_json::from_value(options["clientInfo"].clone()).unwrap());
    opts.capabilities = serde_json::from_value(options["capabilities"].clone()).unwrap();
    let connecting = tokio::spawn(connect(opts));
    let conn = net.accept().await;
    handshake(&conn).await;
    (Arc::new(connecting.await.unwrap().unwrap()), conn)
}

/// The server side of one connection's `initialize`.
async fn handshake(conn: &mixdog_app_server_client::mock::MockConn) {
    let init: Json = serde_json::from_str(&conn.next_sent().await).unwrap();
    let mut result = options()["initializeResult"].clone();
    result["serverInstanceId"] = json!("s1");
    conn.server_send(&json!({ "id": init["id"], "result": result }));
    conn.next_sent().await; // initialized
}

#[tokio::test(start_paused = true)]
async fn a_silent_connection_is_kept_until_its_socket_closes() {
    let recorded = recording();
    let node = recorded["cases"].as_array().unwrap().iter().find(|case| case["testLine"] == 446).expect("state-lanes case 446");
    let recorded_steps = node["result"]["steps"].as_array().unwrap();
    let silence = Duration::from_millis(node["input"]["virtualClock"][0]["ms"].as_u64().unwrap());

    let net = Arc::new(MockNetwork::default());
    let (client, conn) = attached(&net).await;
    let mut events = client.events();
    assert!(matches!(client.status(), ConnectionStatus::Ready { .. }));
    // Each step of Node's recording as the core shows it: the event streams opened so far and the disconnects reported since the
    // last step. The manifest's exclusions are what is not compared: the step's prose, Node's `ok` (the scripted daemon answered
    // `{}`, which its client returns as `undefined`; the core's answer is the `{}` result), the disconnect's reason text (Node's
    // "sse aborted" has no core counterpart), and the HTTP exchanges.
    let mut observed = Vec::new();
    let mut step = |net: &MockNetwork, events: &mut tokio::sync::broadcast::Receiver<ClientEvent>| {
        let mut disconnects = Vec::new();
        while let Ok(event) = events.try_recv() {
            if let ClientEvent::Status(ConnectionStatus::Reconnecting { .. }) = event {
                disconnects.push(json!({}));
            }
        }
        json!({ "eventRequests": net.opened(), "disconnects": disconnects })
    };
    observed.push(step(&net, &mut events));

    tokio::time::advance(silence).await;
    observed.push(json!({}));
    assert!(matches!(client.status(), ConnectionStatus::Ready { .. }), "the silent connection is still the client's");
    assert_eq!(conn.client_close(), None, "the client closed nothing");

    let asking = client.clone();
    let probe = tokio::spawn(async move { asking.call_raw("thread/list", json!({}), CallOptions::default()).await });
    let request: Json = serde_json::from_str(&conn.next_sent().await).unwrap();
    assert_eq!(request["method"], "thread/list", "the call went out on the same connection");
    conn.server_send(&json!({ "id": request["id"], "result": {} }));
    assert_eq!(probe.await.unwrap().expect("the call after the silence is answered"), json!({}));
    observed.push(step(&net, &mut events));

    conn.server_close(1006, "socket destroyed");
    let mut disconnects = Vec::new();
    let ended = mixdog_rt::time::timeout(Duration::from_secs(20), async {
        loop {
            if let ClientEvent::Status(ConnectionStatus::Reconnecting { .. }) = events.recv().await.expect("the client's events") {
                disconnects.push(json!({}));
                break;
            }
        }
    })
    .await;
    ended.expect("the closed socket reported within 20 s");
    observed.push(json!({ "eventRequests": net.opened(), "disconnects": disconnects }));
    let declared = |step: &Json| {
        let mut step = step.clone();
        if let Some(fields) = step.as_object_mut() {
            fields.remove("step");
            fields.remove("ok");
        }
        if let Some(disconnects) = step.get_mut("disconnects") {
            *disconnects = Json::Array(disconnects.as_array().unwrap().iter().map(|_| json!({})).collect());
        }
        step
    };
    let expected: Vec<Json> = recorded_steps.iter().map(declared).collect();
    assert_eq!(Json::Array(observed), Json::Array(expected), "every step of the recorded outcome");
}
/// state-lanes case 192: the server ends the connection and a call made then is answered once the client is back, with no
/// failure; the reconnect is reported as the first attempt. Not compared (the manifest says so): Node's `registrations` (its
/// client registers once and re-opens only the event stream; the core's connection is one socket, so a reconnect is a new
/// `initialize`, which is why this test answers it), the reconnect's reason text and its `downtimeMs`. The attempt counts from 1 in Node and from 0 in the\n/// core (`ConnectionStatus::Reconnecting` counts the ladder rounds made since the last handshake), so the core's is shown plus one.
#[tokio::test(start_paused = true)]
async fn a_connection_the_server_ends_is_reconnected_and_a_call_meanwhile_is_answered() {
    let recorded = recording();
    let node = recorded["cases"].as_array().unwrap().iter().find(|case| case["testLine"] == 192).expect("state-lanes case 192");
    let steps = node["result"]["steps"].as_array().unwrap();
    let net = Arc::new(MockNetwork::default());
    let (client, conn) = attached(&net).await;
    let mut events = client.events();
    conn.server_close(1006, "stream ended");
    let asking = client.clone();
    let probe = tokio::spawn(async move { asking.call_raw("thread/list", json!({}), CallOptions::default()).await });
    let second = net.accept().await;
    handshake(&second).await;
    let request: Json = serde_json::from_str(&second.next_sent().await).unwrap();
    second.server_send(&json!({ "id": request["id"], "result": steps[1]["ok"] }));
    let answered = probe.await.unwrap().expect("the call made while the client reconnected is answered");
    let (mut fatals, mut reconnects) = (Vec::new(), Vec::new());
    while let Ok(event) = events.try_recv() {
        match event {
            ClientEvent::Status(ConnectionStatus::Reconnecting { attempt }) => reconnects.push(json!({ "attempt": attempt + 1 })),
            ClientEvent::Status(ConnectionStatus::Closed { .. }) => fatals.push(json!({})),
            _ => {}
        }
    }
    let observed = json!({ "ok": answered, "fatals": fatals, "reconnects": reconnects });
    let reconnected = node["result"]["steps"][2]["reconnects"].as_array().unwrap().iter().map(|reconnect| json!({ "attempt": reconnect["attempt"] })).collect::<Vec<_>>();
    let expected = json!({ "ok": steps[1]["ok"], "fatals": steps[2]["fatals"], "reconnects": reconnected });
    assert_eq!(observed, expected, "the recorded outcome");
}
