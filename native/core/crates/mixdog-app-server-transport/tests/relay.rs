//! The relay connection type (P §4.1, SPEC R25).

mod common;

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
