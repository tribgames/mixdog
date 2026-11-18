//! How long a connection lives: a connection the server leaves silent is not ended by the client, a call made after the
//! silence is answered on the same connection, and only the socket closing ends it; a connection the server ends is
//! reconnected and a call made meanwhile is answered once the client is back, with no failure.

use std::{path::PathBuf, sync::Arc, time::Duration};

use mixdog_app_server_client::{
    CallOptions, ClientError, ClientEvent, ConnectOptions, ConnectionStatus, Json, ProtocolClient, ReplyAddress, ServerRequestAnswer,
    Target, connect, mock::MockConn, mock::MockNetwork,
};
use serde_json::json;

#[allow(clippy::disallowed_methods, reason = "test-only: reads the committed client options synchronously")]
fn options() -> Json {
    let path = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../packages/protocol-client/conformance/options.json"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// The server side of one connection's `initialize`.
async fn handshake(conn: &MockConn) {
    let init: Json = serde_json::from_str(&conn.next_sent().await).unwrap();
    let mut result = options()["initializeResult"].clone();
    result["serverInstanceId"] = json!("s1");
    conn.server_send(&json!({ "id": init["id"], "result": result }));
    conn.next_sent().await; // initialized
}

/// A client connected over `net` and the connection it opened, the handshake done.
async fn attached(net: &Arc<MockNetwork>) -> (Arc<mixdog_app_server_client::engine::Client>, MockConn) {
    let options = options();
    let mut opts = ConnectOptions::new(Target { id: "local".into() }, net.clone(), serde_json::from_value(options["clientInfo"].clone()).unwrap());
    opts.capabilities = serde_json::from_value(options["capabilities"].clone()).unwrap();
    let connecting = tokio::spawn(connect(opts));
    let conn = net.accept().await;
    handshake(&conn).await;
    (Arc::new(connecting.await.unwrap().unwrap()), conn)
}

fn reconnects(events: &mut tokio::sync::broadcast::Receiver<ClientEvent>) -> Vec<u32> {
    let mut seen = Vec::new();
    while let Ok(event) = events.try_recv() {
        if let ClientEvent::Status(ConnectionStatus::Reconnecting { attempt }) = event {
            seen.push(attempt);
        }
    }
    seen
}

#[tokio::test(start_paused = true)]
async fn a_silent_connection_is_kept_until_its_socket_closes() {
    let net = Arc::new(MockNetwork::default());
    let (client, conn) = attached(&net).await;
    let mut events = client.events();
    assert!(matches!(client.status(), ConnectionStatus::Ready { .. }));

    tokio::time::advance(Duration::from_secs(600)).await;
    assert!(matches!(client.status(), ConnectionStatus::Ready { .. }), "ten silent minutes leave the connection the client's");
    assert_eq!(conn.client_close(), None, "the client closed nothing");
    assert!(reconnects(&mut events).is_empty());

    let asking = client.clone();
    let probe = tokio::spawn(async move { asking.call_raw("thread/list", json!({}), CallOptions::default()).await });
    let request: Json = serde_json::from_str(&conn.next_sent().await).unwrap();
    assert_eq!(request["method"], "thread/list", "the call went out on the same connection");
    conn.server_send(&json!({ "id": request["id"], "result": {} }));
    assert_eq!(probe.await.unwrap().expect("the call after the silence is answered"), json!({}));
    assert_eq!(net.opened(), 1, "no second connection was opened");

    conn.server_close(1006, "socket destroyed");
    let ended = mixdog_rt::time::timeout(Duration::from_secs(20), async {
        loop {
            if let ClientEvent::Status(ConnectionStatus::Reconnecting { .. }) = events.recv().await.expect("the client's events") {
                break;
            }
        }
    })
    .await;
    ended.expect("the closed socket is reported within 20 s");
}

#[tokio::test(start_paused = true)]
async fn a_connection_the_server_ends_is_reconnected_and_a_call_meanwhile_is_answered() {
    let net = Arc::new(MockNetwork::default());
    let (client, conn) = attached(&net).await;
    let mut events = client.events();
    conn.server_close(1006, "stream ended");
    let asking = client.clone();
    let probe = tokio::spawn(async move { asking.call_raw("thread/list", json!({}), CallOptions::default()).await });
    let second = net.accept().await;
    handshake(&second).await;
    let request: Json = serde_json::from_str(&second.next_sent().await).unwrap();
    assert_eq!(request["method"], "thread/list", "the call waited for the new connection");
    second.server_send(&json!({ "id": request["id"], "result": { "data": [] } }));
    assert_eq!(probe.await.unwrap().expect("the call made while the client reconnected is answered"), json!({ "data": [] }));

    let mut closed = false;
    let mut attempts = Vec::new();
    while let Ok(event) = events.try_recv() {
        match event {
            ClientEvent::Status(ConnectionStatus::Reconnecting { attempt }) => attempts.push(attempt),
            ClientEvent::Status(ConnectionStatus::Closed { .. }) => closed = true,
            _ => {}
        }
    }
    assert!(!closed, "the client never gave up");
    assert_eq!(attempts, vec![0], "the reconnect is reported once, as the first round of the ladder");
}

/// The address the client gives the server's request `id`, sent over `conn`.
async fn request_address(client: &mixdog_app_server_client::engine::Client, conn: &MockConn, id: &str) -> ReplyAddress {
    let mut events = client.events();
    let params = json!({ "threadId": "t1", "requestedAt": 1, "order": 1, "kind": "shell", "tool": "bash", "request": {} });
    conn.server_send(&json!({ "id": id, "method": "item/tool/requestApproval", "params": params }));
    loop {
        if let ClientEvent::ServerRequest(_, address) = events.recv().await.expect("the client's events") {
            return address;
        }
    }
}

#[tokio::test(start_paused = true)]
async fn an_answer_addressed_by_one_client_is_refused_by_another_at_the_same_socket_count() {
    let (net_a, net_b) = (Arc::new(MockNetwork::default()), Arc::new(MockNetwork::default()));
    let (a, conn_a) = attached(&net_a).await;
    let (b, conn_b) = attached(&net_b).await;
    // Both clients are on their first socket and the server reuses the request id: only the issuing client tells them apart.
    let from_a = request_address(&a, &conn_a, "ap_1").await;
    let from_b = request_address(&b, &conn_b, "ap_1").await;
    assert_ne!(from_a, from_b);
    let held: Vec<ReplyAddress> = b.pending_replies().into_iter().map(|(_, address)| address).collect();
    assert_eq!(held, vec![from_b.clone()], "the held request carries its own client's address");

    let refused = b.respond(from_a, ServerRequestAnswer::Result(json!({ "decision": "a" }))).await;
    assert!(matches!(refused, Err(ClientError::StaleAttachment)), "{refused:?}");
    b.respond(from_b, ServerRequestAnswer::Result(json!({ "decision": "b" }))).await.unwrap();
    let written: Json = serde_json::from_str(&conn_b.next_sent().await).unwrap();
    assert_eq!(written, json!({ "id": "ap_1", "result": { "decision": "b" } }), "B's wire carries its own answer and nothing of A's");
}
