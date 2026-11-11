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

#[tokio::test(start_paused = true)]
async fn a_silent_connection_is_kept_until_its_socket_closes() {
    let recorded = recording();
    let node = recorded["cases"].as_array().unwrap().iter().find(|case| case["testLine"] == 446).expect("state-lanes case 446");
    let steps = node["result"]["steps"].as_array().unwrap();
    let silence = Duration::from_millis(node["input"]["virtualClock"][0]["ms"].as_u64().unwrap());
    // Node: one event stream, no disconnect before or after the silence, and the call made after it answered.
    assert_eq!((steps[0]["eventRequests"].as_u64(), steps[0]["disconnects"].as_array().map(Vec::len)), (Some(1), Some(0)));
    assert_eq!((steps[2]["eventRequests"].as_u64(), steps[2]["disconnects"].as_array().map(Vec::len)), (Some(1), Some(0)));
    assert_eq!(steps[3]["disconnects"].as_array().map(Vec::len), Some(1), "Node reported the socket's end once");

    let options = options();
    let net = Arc::new(MockNetwork::default());
    let mut opts = ConnectOptions::new(Target { id: "local".into() }, net.clone(), serde_json::from_value(options["clientInfo"].clone()).unwrap());
    opts.capabilities = serde_json::from_value(options["capabilities"].clone()).unwrap();
    let connecting = tokio::spawn(connect(opts));
    let conn = net.accept().await;
    let init: Json = serde_json::from_str(&conn.next_sent().await).unwrap();
    let mut result = options["initializeResult"].clone();
    result["serverInstanceId"] = json!("s1");
    conn.server_send(&json!({ "id": init["id"], "result": result }));
    conn.next_sent().await; // initialized
    let client = Arc::new(connecting.await.unwrap().unwrap());
    let mut events = client.events();
    assert!(matches!(client.status(), ConnectionStatus::Ready { .. }));

    tokio::time::advance(silence).await;
    assert!(matches!(client.status(), ConnectionStatus::Ready { .. }), "the silent connection is still the client's");
    assert_eq!(conn.client_close(), None, "the client closed nothing");

    let asking = client.clone();
    let probe = tokio::spawn(async move { asking.call_raw("thread/list", json!({}), CallOptions::default()).await });
    let request: Json = serde_json::from_str(&conn.next_sent().await).unwrap();
    assert_eq!(request["method"], "thread/list", "the call went out on the same connection");
    conn.server_send(&json!({ "id": request["id"], "result": {} }));
    assert_eq!(probe.await.unwrap().expect("the call after the silence is answered"), json!({}));

    conn.server_close(1006, "socket destroyed");
    let ended = mixdog_rt::time::timeout(Duration::from_secs(20), async {
        loop {
            if let ClientEvent::Status(ConnectionStatus::Reconnecting { .. }) = events.recv().await.expect("the client's events") {
                break;
            }
        }
    })
    .await;
    ended.expect("the closed socket reported within 20 s");
}