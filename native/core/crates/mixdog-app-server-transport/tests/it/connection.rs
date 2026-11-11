//! Reader rules, close behaviour, connection limit and heartbeat over in-memory sockets
//! (P §3, §4.5, §4.7, §14.2, §14.11; X17; SPEC R8, R13).

use crate::common;

use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use bytes::Bytes;
use common::Wire;
use common::connect;
use common::install_rt;
use common::small_limits;
use mixdog_app_protocol::JsonRpcMessage;
use mixdog_app_protocol::limits::CloseCode;
use mixdog_app_protocol::limits::Limits;
use mixdog_app_protocol::media::MediaFlags;
use mixdog_app_protocol::media::MediaFormat;
use mixdog_app_protocol::media::MediaFrameHeader;
use mixdog_app_protocol::media::MediaPurpose;
use mixdog_app_server_transport::ConnectionHub;
use mixdog_app_server_transport::ConnectionLimit;
use mixdog_app_server_transport::ConnectionOrigin;
use mixdog_app_server_transport::Incoming;
use mixdog_core_api::HostMediaSink;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::sink::ConnectionSink;
use tokio::task::yield_now;

fn hub() -> ConnectionHub {
    install_rt();
    ConnectionHub::new(small_limits()).unwrap()
}

async fn settle() {
    for _ in 0..20 {
        yield_now().await;
    }
}

const REQUEST: &str = r#"{"id":1,"method":"initialize","params":{}}"#;

#[derive(Default)]
struct Media(Mutex<Vec<(ConnectionId, Bytes)>>);

impl HostMediaSink for Media {
    fn frame(&self, from: ConnectionId, frame: Bytes) {
        self.0.lock().unwrap().push((from, frame));
    }
}

fn media_frame(payload: &[u8]) -> Bytes {
    let header = MediaFrameHeader {
        purpose: MediaPurpose::BrowserView,
        flags: MediaFlags::FIT_SETTLED,
        stream_id: 7,
        width: 640,
        height: 480,
        format: MediaFormat::Jpeg,
    };
    let mut frame = header.encode().to_vec();
    frame.extend_from_slice(payload);
    Bytes::from(frame)
}

#[tokio::test]
async fn text_frames_decode_in_arrival_order() {
    let hub = hub();
    let mut peer = connect(&hub, ConnectionOrigin::Loopback, true);
    peer.send.send(Incoming::Text(REQUEST.into())).unwrap();
    peer.send
        .send(Incoming::Text(r#"{"method":"initialized"}"#.into()))
        .unwrap();
    let first = peer.connection.inbound.recv().await.unwrap();
    assert!(matches!(first, JsonRpcMessage::Request(r) if r.method == "initialize"));
    let second = peer.connection.inbound.recv().await.unwrap();
    assert!(matches!(second, JsonRpcMessage::Notification(n) if n.method == "initialized"));
}

#[tokio::test]
async fn bad_json_closes_with_1007_and_oversized_text_with_1009() {
    let hub = hub();
    let mut bad = connect(&hub, ConnectionOrigin::Loopback, true);
    bad.send.send(Incoming::Text("{not json".into())).unwrap();
    assert_eq!(
        bad.until_closed().await,
        [Wire::Close(CloseCode::InvalidFrame)]
    );

    let mut big = connect(&hub, ConnectionOrigin::Loopback, true);
    let oversized = format!(
        r#"{{"id":1,"method":"x","params":"{}"}}"#,
        "a".repeat(hub.limits().max_inbound_frame_bytes as usize)
    );
    big.send.send(Incoming::Text(oversized)).unwrap();
    assert_eq!(
        big.until_closed().await,
        [Wire::Close(CloseCode::FrameTooBig)]
    );
    // The closed connections ended their inbound stream.
    assert!(bad.connection.inbound.recv().await.is_none());
}

#[tokio::test]
async fn binary_frames_need_the_host_media_role() {
    let hub = hub();
    let mut plain = connect(&hub, ConnectionOrigin::Loopback, true);
    plain
        .send
        .send(Incoming::Binary(media_frame(b"jpeg")))
        .unwrap();
    assert_eq!(
        plain.until_closed().await,
        [Wire::Close(CloseCode::UnsupportedData)]
    );

    let media = Arc::new(Media::default());
    let host = connect(&hub, ConnectionOrigin::Loopback, true);
    assert!(host.connection.sink.grant_host_media(media.clone()));
    assert!(!host.connection.sink.grant_host_media(media.clone()));
    let frame = media_frame(b"jpeg");
    host.send.send(Incoming::Binary(frame.clone())).unwrap();
    // A text request behind it proves the media frame was handled in order and the
    // connection is still open.
    host.send.send(Incoming::Text(REQUEST.into())).unwrap();
    let mut host = host;
    host.connection.inbound.recv().await.unwrap();
    assert_eq!(
        *media.0.lock().unwrap(),
        [(host.connection.id, frame)],
        "media frames bypass the request queue"
    );
}

#[tokio::test]
async fn host_media_frames_are_validated() {
    install_rt();
    let limits = Limits {
        max_media_frame_bytes: 8,
        ..small_limits()
    };
    let hub = ConnectionHub::new(limits).unwrap();
    for (frame, expected) in [
        (media_frame(&[0; 9]), CloseCode::FrameTooBig),
        (Bytes::from_static(b"short"), CloseCode::InvalidFrame),
        (Bytes::from(vec![0xFF; 16]), CloseCode::InvalidFrame),
    ] {
        let mut host = connect(&hub, ConnectionOrigin::Loopback, true);
        host.connection
            .sink
            .grant_host_media(Arc::new(Media::default()));
        host.send.send(Incoming::Binary(frame)).unwrap();
        assert_eq!(host.until_closed().await, [Wire::Close(expected)]);
    }
}

#[tokio::test]
async fn close_writes_queued_control_frames_first_and_refuses_new_ones() {
    let hub = hub();
    let mut peer = connect(&hub, ConnectionOrigin::Loopback, true);
    let sink = peer.connection.sink.clone();
    sink.send_control(Bytes::from_static(b"error")).unwrap();
    sink.close(CloseCode::VersionRefused);
    sink.close(CloseCode::Normal);
    assert!(sink.send_control(Bytes::from_static(b"late")).is_err());
    assert!(sink.closed().is_cancelled());
    assert_eq!(
        peer.until_closed().await,
        [
            Wire::Text("error".into()),
            Wire::Close(CloseCode::VersionRefused)
        ],
        "the first close code wins"
    );
}

#[tokio::test]
async fn peer_close_ends_the_connection_without_a_close_frame() {
    let hub = hub();
    let mut peer = connect(&hub, ConnectionOrigin::Loopback, true);
    peer.send.send(Incoming::Close).unwrap();
    // A real socket yields `None` after the close handshake; the harness ends the stream.
    drop(peer.send);
    assert!(peer.connection.inbound.recv().await.is_none());
    assert!(peer.connection.sink.closed().is_cancelled());
    assert_eq!(peer.connection.sink.close_code(), None);
    assert_eq!(peer.wire.recv().await, None);
}

#[tokio::test]
async fn dropping_the_inbound_queue_closes_normally() {
    let hub = hub();
    let peer = connect(&hub, ConnectionOrigin::Loopback, true);
    let mut wire = peer.wire;
    drop(peer.connection.inbound);
    assert_eq!(wire.recv().await, Some(Wire::Close(CloseCode::Normal)));
}

#[tokio::test]
async fn drain_closes_every_connection_with_going_away() {
    let hub = hub();
    let mut one = connect(&hub, ConnectionOrigin::Loopback, true);
    let mut two = connect(&hub, ConnectionOrigin::SshTunnel, true);
    one.connection
        .sink
        .send_control(Bytes::from_static(b"last"))
        .unwrap();
    hub.close_all();
    assert_eq!(
        one.until_closed().await,
        [Wire::Text("last".into()), Wire::Close(CloseCode::GoingAway)]
    );
    assert_eq!(
        two.until_closed().await,
        [Wire::Close(CloseCode::GoingAway)]
    );
}

#[tokio::test]
async fn connections_past_the_limit_are_refused_and_slots_are_reused() {
    install_rt();
    let hub = ConnectionHub::new(Limits {
        max_connections: 2,
        ..small_limits()
    })
    .unwrap();
    let origin = || ConnectionOrigin::Loopback;
    let first = connect(&hub, origin(), true);
    let _second = connect(&hub, origin(), true);
    assert_eq!(hub.len(), 2);
    assert!(hub.admit(origin()).over_limit());
    let refused = hub.attach(origin(), common::TestRead::closed(), common::TestWrite::sink());
    assert_eq!(refused.err(), Some(ConnectionLimit));
    assert_eq!(hub.len(), 2, "a refused socket does not keep its slot");

    // The first peer goes away: its stream ends and its socket closes.
    drop(first.send);
    first.connection.sink.close(CloseCode::Normal);
    for _ in 0..100 {
        if hub.len() == 1 {
            break;
        }
        yield_now().await;
    }
    assert_eq!(hub.len(), 1);
    let _third = connect(&hub, origin(), true);
    assert_eq!(hub.len(), 2);
}

#[tokio::test]
async fn silent_peer_is_pinged_then_closed_after_two_more_ticks() {
    let hub = hub();
    let mut peer = connect(&hub, ConnectionOrigin::Loopback, true);
    assert_eq!(hub.heartbeat_tick(), 2);
    assert_eq!(hub.heartbeat_tick(), 3);
    assert_eq!(peer.take(1).await, [Wire::Ping]);
    hub.heartbeat_tick();
    assert!(!peer.connection.sink.is_closed());
    hub.heartbeat_tick();
    assert_eq!(
        peer.until_closed().await,
        [Wire::Close(CloseCode::PeerUnresponsive)]
    );
    assert_eq!(
        peer.connection.sink.close_code(),
        Some(CloseCode::PeerUnresponsive)
    );
    // The peer never completed the close: two more ticks abandon the socket.
    hub.heartbeat_tick();
    hub.heartbeat_tick();
    for _ in 0..100 {
        if hub.is_empty() {
            break;
        }
        yield_now().await;
    }
    assert!(hub.is_empty());
}

#[tokio::test]
async fn any_received_frame_keeps_a_peer_alive() {
    let hub = hub();
    let mut peer = connect(&hub, ConnectionOrigin::Loopback, true);
    hub.heartbeat_tick();
    hub.heartbeat_tick();
    hub.heartbeat_tick();
    assert_eq!(peer.take(1).await, [Wire::Ping]);
    // The pong clears the outstanding ping.
    peer.send.send(Incoming::Activity).unwrap();
    settle().await;
    for _ in 0..4 {
        hub.heartbeat_tick();
        settle().await;
        peer.send.send(Incoming::Activity).unwrap();
        settle().await;
    }
    assert!(!peer.connection.sink.is_closed());
}

#[tokio::test(start_paused = true)]
async fn one_heartbeat_task_serves_every_connection() {
    install_rt();
    let hub = ConnectionHub::new(Limits {
        heartbeat_tick_ms: 100,
        ..small_limits()
    })
    .unwrap();
    let heartbeat = hub.spawn_heartbeat();
    let mut silent = connect(&hub, ConnectionOrigin::Loopback, true);
    let mut quiet_too = connect(&hub, ConnectionOrigin::SshTunnel, true);
    let live = connect(&hub, ConnectionOrigin::Loopback, true);

    // Paused time advances by itself while everything waits: the silent peers are pinged and
    // closed by the one interval; the live peer answers every tick.
    let silent_wire = silent.until_closed();
    let quiet_wire = quiet_too.until_closed();
    let keep_alive = async {
        for _ in 0..200 {
            live.send.send(Incoming::Activity).unwrap();
            mixdog_rt::time::sleep(Duration::from_millis(50)).await;
        }
    };
    let (silent_wire, quiet_wire, ()) = tokio::join!(silent_wire, quiet_wire, keep_alive);
    assert_eq!(
        silent_wire,
        [Wire::Ping, Wire::Close(CloseCode::PeerUnresponsive)]
    );
    assert_eq!(
        quiet_wire,
        [Wire::Ping, Wire::Close(CloseCode::PeerUnresponsive)]
    );
    assert!(!live.connection.sink.is_closed());
    heartbeat.abort();
}

#[tokio::test]
async fn the_hub_answers_each_connections_origin_until_it_closes() {
    let hub = hub();
    let local = connect(&hub, ConnectionOrigin::Loopback, false);
    let phone = connect(&hub, ConnectionOrigin::Relay { peer_id: "p1".into() }, true);
    let ssh = connect(&hub, ConnectionOrigin::SshTunnel, false);

    assert_eq!(hub.origin_of(local.connection.id), Some(mixdog_protocol::Origin::Local));
    assert_eq!(hub.origin_of(phone.connection.id), Some(mixdog_protocol::Origin::Relay));
    assert_eq!(hub.origin_of(ssh.connection.id), Some(mixdog_protocol::Origin::Ssh));
    assert_eq!(
        hub.connection_origin(phone.connection.id),
        Some(ConnectionOrigin::Relay { peer_id: "p1".into() })
    );
    assert_eq!(hub.origin_of(ConnectionId(9_999)), None);

    let gone = phone.connection.id;
    drop(phone.send);
    phone.connection.sink.close(CloseCode::Normal);
    for _ in 0..100 {
        if hub.origin_of(gone).is_none() {
            break;
        }
        yield_now().await;
    }
    assert_eq!(hub.origin_of(gone), None);
}
#[tokio::test]
async fn a_closed_connection_has_no_origin_right_after_close() {
    let hub = hub();
    let local = connect(&hub, ConnectionOrigin::Loopback, true);
    let ssh = connect(&hub, ConnectionOrigin::SshTunnel, true);
    let id = local.connection.id;
    assert_eq!(hub.origin_of(id), Some(mixdog_protocol::Origin::Local));

    local.connection.sink.close(CloseCode::Normal);
    assert_eq!(hub.origin_of(id), None, "closing connections answer no origin");
    assert_eq!(hub.connection_origin(id), None);
    assert_eq!(hub.origin_of(ssh.connection.id), Some(mixdog_protocol::Origin::Ssh));
}