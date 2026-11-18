//! The relay connection type (P §4.1, SPEC R25).

use crate::common;

use bytes::Bytes;
use common::install_rt;
use common::small_limits;
use mixdog_app_protocol::JsonRpcMessage;
use mixdog_app_protocol::limits::CloseCode;
use mixdog_app_protocol::limits::Limits;
use mixdog_app_server_transport::ConnectionHub;
use mixdog_app_server_transport::ConnectionLimit;
use mixdog_app_server_transport::ConnectionOrigin;
use mixdog_app_server_transport::relay::RelayOut;
use mixdog_app_server_transport::relay::open_relay;
use mixdog_core_api::sink::ConnectionSink;
use mixdog_protocol::Origin;

fn hub() -> ConnectionHub {
    install_rt();
    ConnectionHub::new(small_limits()).unwrap()
}

#[tokio::test]
async fn frames_travel_both_ways_with_the_pairing_origin() {
    let hub = hub();
    let (mut connection, mut endpoint) = open_relay(&hub, "phone-1".into()).unwrap();
    assert_eq!(
        connection.origin,
        ConnectionOrigin::Relay {
            peer_id: "phone-1".into()
        }
    );
    assert_eq!(connection.origin.origin(), Origin::Relay);

    endpoint
        .send_text(r#"{"id":"a","method":"initialize"}"#.into())
        .await
        .unwrap();
    let request = connection.inbound.recv().await.unwrap();
    assert!(matches!(request, JsonRpcMessage::Request(r) if r.method == "initialize"));

    connection
        .sink
        .send_control(Bytes::from_static(br#"{"id":"a","result":{}}"#))
        .unwrap();
    assert_eq!(
        endpoint.recv().await,
        Some(RelayOut::Text(Bytes::from_static(br#"{"id":"a","result":{}}"#)))
    );
}

#[tokio::test]
async fn paired_writes_hide_provisioning_state_without_gaps_in_the_app_feed() {
    use serde_json::{Value, json};

    let hub = hub();
    let (connection, mut endpoint) = open_relay(&hub, "test-peer".into()).unwrap();
    let config = json!({ "section": "config", "key": "notifications", "revision": 1, "value": { "devices": {} } });
    let remote = json!({ "section": "remote", "key": null, "revision": 2, "value": {
        "info": { "relay": { "token": "test-token" } },
        "claims": [{ "claimId": "test-claim" }],
        "pairCode": { "code": "012345" },
    }});
    let feed = json!({ "id": "app", "epoch": "test-epoch", "seq": 20 });
    let next = json!({ "id": "app", "epoch": "test-epoch", "seq": 21 });
    for (input, expected) in [
        (
            json!({ "method": "app/snapshot", "params": { "sections": [config.clone(), remote.clone()] }, "feed": feed.clone() }),
            json!({ "method": "app/snapshot", "params": { "sections": [config] }, "feed": feed }),
        ),
        (
            json!({ "method": "remote/state/updated", "params": remote, "feed": next.clone() }),
            json!({ "method": "remote/state/updated", "params": { "section": "remote", "key": null, "revision": 2, "removed": true }, "feed": next }),
        ),
    ] {
        connection.sink.send_control(Bytes::from(serde_json::to_vec(&input).unwrap())).unwrap();
        let Some(RelayOut::Text(frame)) = endpoint.recv().await else { panic!("expected the filtered feed frame") };
        assert_eq!(serde_json::from_slice::<Value>(&frame).unwrap(), expected);
    }
}

#[tokio::test]
async fn a_silent_phone_is_pinged_at_relay_level_and_closed() {
    let hub = hub();
    let (connection, mut endpoint) = open_relay(&hub, "phone-1".into()).unwrap();
    // Ticks 2..=4: the peer is quiet since tick 1, so tick 3 pings.
    for _ in 0..3 {
        hub.heartbeat_tick();
    }
    assert_eq!(endpoint.recv().await, Some(RelayOut::Ping));
    endpoint.send_activity().await.unwrap();
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
    hub.heartbeat_tick();
    assert!(!connection.sink.is_closed(), "a pong answers the ping");

    // Silence again: tick 6 pings, tick 8 (two later) closes.
    hub.heartbeat_tick();
    assert_eq!(endpoint.recv().await, Some(RelayOut::Ping));
    hub.heartbeat_tick();
    hub.heartbeat_tick();
    assert_eq!(
        endpoint.recv().await,
        Some(RelayOut::Close(CloseCode::PeerUnresponsive))
    );
}

#[tokio::test]
async fn dropping_the_endpoint_ends_the_connection() {
    let hub = hub();
    let (mut connection, endpoint) = open_relay(&hub, "phone-1".into()).unwrap();
    drop(endpoint);
    assert!(connection.inbound.recv().await.is_none());
    assert!(connection.sink.is_closed());
    assert_eq!(connection.sink.close_code(), None);
}

#[tokio::test]
async fn relay_connections_count_against_the_connection_limit() {
    install_rt();
    let hub = ConnectionHub::new(Limits {
        max_connections: 1,
        ..small_limits()
    })
    .unwrap();
    let _held = open_relay(&hub, "phone-1".into()).unwrap();
    assert_eq!(open_relay(&hub, "phone-2".into()).err(), Some(ConnectionLimit));
}
