//! The WebSocket listener over real loopback sockets (P §4.1, §14.2; SPEC R1, R8).

use crate::common;

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::Mutex;

use bytes::Bytes;
use common::install_rt;
use common::small_limits;
use futures::SinkExt;
use futures::StreamExt;
use mixdog_app_protocol::JsonRpcMessage;
use mixdog_app_protocol::limits::CloseCode;
use mixdog_app_protocol::limits::Limits;
use mixdog_app_server_transport::AcceptedConnection;
use mixdog_app_server_transport::ConnectionHub;
use mixdog_app_server_transport::ConnectionOrigin;
use mixdog_app_server_transport::Transport;
use mixdog_app_server_transport::websocket::BearerAuth;
use mixdog_app_server_transport::websocket::ListenError;
use mixdog_app_server_transport::websocket::ListenerOrigin;
use mixdog_app_server_transport::websocket::WebSocketListener;
use mixdog_core_api::HostMediaSink;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::sink::ConnectionSink;
use tokio::net::TcpStream;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Error as WsError;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::StatusCode;

const TOKEN: &str = "discovery-token";
const REQUEST: &str = r#"{"id":1,"method":"initialize","params":{}}"#;

type Client = WebSocketStream<TcpStream>;

async fn listen(limits: Limits) -> (ConnectionHub, WebSocketListener) {
    listen_as(limits, ListenerOrigin::Loopback).await
}

async fn listen_as(limits: Limits, origin: ListenerOrigin) -> (ConnectionHub, WebSocketListener) {
    install_rt();
    let hub = ConnectionHub::new(limits).unwrap();
    let listener = WebSocketListener::bind(
        "127.0.0.1:0".parse().unwrap(),
        hub.clone(),
        BearerAuth::new(TOKEN),
        origin,
    )
    .await
    .unwrap();
    (hub, listener)
}

struct Dial<'a> {
    path: &'a str,
    token: Option<&'a str>,
    origin: Option<&'a str>,
    /// The `Mixdog-Relay-Peer` header values.
    peers: &'a [&'a str],
}

impl Default for Dial<'_> {
    fn default() -> Self {
        Self {
            path: "/rpc",
            token: Some(TOKEN),
            origin: None,
            peers: &[],
        }
    }
}

async fn dial(addr: SocketAddr, dial: Dial<'_>) -> Result<Client, WsError> {
    let tcp = TcpStream::connect(addr).await.unwrap();
    let mut request = format!("ws://{addr}{}", dial.path)
        .into_client_request()
        .unwrap();
    if let Some(token) = dial.token {
        request
            .headers_mut()
            .insert("authorization", format!("Bearer {token}").parse().unwrap());
    }
    if let Some(origin) = dial.origin {
        request.headers_mut().insert("origin", origin.parse().unwrap());
    }
    for peer in dial.peers {
        request.headers_mut().append("mixdog-relay-peer", peer.parse().unwrap());
    }
    tokio_tungstenite::client_async(request, tcp)
        .await
        .map(|(client, _)| client)
}

async fn connected(
    listener: &mut WebSocketListener,
    dial_with: Dial<'_>,
) -> (Client, AcceptedConnection) {
    let client = dial(listener.local_addr(), dial_with).await.unwrap();
    let server = listener.accept().await.expect("listener open");
    (client, server)
}

fn refused_with(result: Result<Client, WsError>) -> StatusCode {
    match result {
        Err(WsError::Http(response)) => response.status(),
        other => panic!("expected an HTTP refusal, got {:?}", other.map(|_| "connected")),
    }
}

async fn close_code(client: &mut Client) -> u16 {
    loop {
        match client.next().await {
            Some(Ok(Message::Close(Some(frame)))) => return u16::from(frame.code),
            Some(Ok(_)) => continue,
            other => panic!("expected a close frame, got {:?}", other.map(|r| r.is_ok())),
        }
    }
}

#[tokio::test]
async fn requests_and_responses_cross_the_socket() {
    let (_hub, mut listener) = listen(small_limits()).await;
    let (mut client, mut server) = connected(&mut listener, Dial::default()).await;
    assert_eq!(server.origin, ConnectionOrigin::Loopback);

    client.send(Message::text(REQUEST)).await.unwrap();
    let request = server.inbound.recv().await.unwrap();
    assert!(matches!(request, JsonRpcMessage::Request(r) if r.method == "initialize"));

    server
        .sink
        .send_control(Bytes::from_static(br#"{"id":1,"result":{}}"#))
        .unwrap();
    let reply = client.next().await.unwrap().unwrap();
    assert_eq!(reply, Message::text(r#"{"id":1,"result":{}}"#));
}

#[tokio::test]
async fn upgrades_without_the_token_or_with_an_origin_are_refused() {
    let (_hub, listener) = listen(small_limits()).await;
    let addr = listener.local_addr();
    let missing = Dial {
        token: None,
        ..Dial::default()
    };
    assert_eq!(refused_with(dial(addr, missing).await), StatusCode::UNAUTHORIZED);
    let wrong = Dial {
        token: Some("other"),
        ..Dial::default()
    };
    assert_eq!(refused_with(dial(addr, wrong).await), StatusCode::UNAUTHORIZED);
    let browser = Dial {
        origin: Some("http://example.test"),
        ..Dial::default()
    };
    assert_eq!(refused_with(dial(addr, browser).await), StatusCode::FORBIDDEN);
    let elsewhere = Dial {
        path: "/other",
        ..Dial::default()
    };
    assert_eq!(refused_with(dial(addr, elsewhere).await), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_bridged_phone_on_the_ssh_listener_is_a_relay_connection() {
    let (hub, mut listener) = listen_as(small_limits(), ListenerOrigin::SshTunnel).await;
    let peer = Dial { peers: &["0a1b2c3d-4e5f"], ..Dial::default() };
    let (_client, server) = connected(&mut listener, peer).await;
    assert_eq!(server.origin, ConnectionOrigin::Relay { peer_id: "0a1b2c3d-4e5f".into() });
    // The hub and the method table see the same narrowed origin the accept reported.
    assert_eq!(hub.connection_origin(server.id), Some(server.origin.clone()));
    assert_eq!(hub.origin_of(server.id), Some(mixdog_app_protocol::Origin::Relay));

    // Without the header the tunnel keeps its own origin.
    let (_plain, server) = connected(&mut listener, Dial::default()).await;
    assert_eq!(server.origin, ConnectionOrigin::SshTunnel);
}

#[tokio::test]
async fn the_relay_peer_header_never_raises_rights_or_works_off_the_ssh_listener() {
    // The loopback listener ignores the header.
    let (_hub, mut loopback) = listen(small_limits()).await;
    let claimed = Dial { peers: &["0a1b2c3d-4e5f"], ..Dial::default() };
    let (_client, server) = connected(&mut loopback, claimed).await;
    assert_eq!(server.origin, ConnectionOrigin::Loopback);

    // On the SSH listener a header that is not exactly one routing id is refused, so a bad
    // value never leaves the phone with the tunnel's wider rights.
    let (_hub, ssh) = listen_as(small_limits(), ListenerOrigin::SshTunnel).await;
    for peers in [&["short"][..], &["UPPERCASE-ID"], &["0a1b2c3d-4e5f", "1a2b3c4d-5e6f"], &[""]] {
        let result = dial(ssh.local_addr(), Dial { peers, ..Dial::default() }).await;
        assert_eq!(refused_with(result), StatusCode::BAD_REQUEST, "{peers:?}");
    }

    // Everything a relay connection may call, a local or SSH one may call as well.
    use mixdog_app_protocol::{CLIENT_METHODS, Origin};
    // The exceptions are calls only a paired phone makes, which Node serves per relay client and nowhere else:
    // the device's one-file grant (`remote-relay-device-methods.ts` `fileGrantsFor`: held per relay credential, so a
    // local or SSH connection has nothing to mint into), and the phone's live view, whose stream, signals and display
    // list belong to the relay client that asked (`remote-relay-client-calls.ts` `browserRemoteStream`;
    // `desktop-service.ts` `browserRemoteWebrtcSignal`, called with the relay client's id; `remote-webrtc.ts`
    // `REMOTE_WEBRTC_SCREEN_DISPLAYS_METHOD`), and the phone's download stages: Node serves `fileDownloadAuthorize`, `fileDownloadBegin`
    // and `fileDownloadFinish` only in the relay's method table (`remote-methods.ts:874`, `fileDownloadRemoteMethods`), so the desktop's
    // own window and an SSH client never call them (`transfer/readRange` and `transfer/endRead` also serve their local reads).
    let phone_only = [
        ("transfer/authorizeRead", serde_json::json!({ "sessionId": "s1", "source": { "kind": "sessionFile", "path": "/outside/file.txt" }, "purpose": "save" })),
        ("transfer/redeemGrant", serde_json::json!({ "grantId": "00000000-0000-4000-8000-000000000001" })),
        ("transfer/finishRead", serde_json::json!({ "transferId": "00000000-0000-4000-8000-000000000002" })),
        ("transfer/grant/mint", serde_json::json!({ "path": "/outside/file.txt" })),
        ("browser/stream", serde_json::json!({ "sessionId": "s1", "on": true })),
        ("browser/webrtcSignal", serde_json::json!({ "signal": {} })),
        ("browser/screenDisplays", serde_json::json!({})),
    ];
    for spec in CLIENT_METHODS.iter().filter(|spec| spec.allows(Origin::Relay) && phone_only.iter().all(|(method, _)| spec.method != *method)) {
        assert!(spec.allows(Origin::Local) && spec.allows(Origin::Ssh), "{} is relay-only", spec.method);
    }

    // Each exception stated outright, not read back from the table it is an exception to: the real server behind each
    // listener refuses the call to a local and to an SSH connection (a relay peer header on the loopback listener
    // changes nothing), and serves it to a relay connection.
    for (method, params) in &phone_only {
        for (listener, peers, origin) in [
            (ListenerOrigin::Loopback, &[][..], "local"),
            (ListenerOrigin::Loopback, &["0a1b2c3d-4e5f"][..], "local"),
            (ListenerOrigin::SshTunnel, &[][..], "ssh"),
        ] {
            let answer = answer_to(listener, peers, method, params).await;
            assert_eq!(
                answer["error"]["data"],
                serde_json::json!({ "reason": "permissionDenied", "method": method, "origin": origin }),
                "{method} {origin} {peers:?}: {answer}"
            );
        }
        let served = answer_to(ListenerOrigin::SshTunnel, &["0a1b2c3d-4e5f"], method, params).await;
        assert!(served.get("error").is_none(), "a relay connection is served {method}: {served}");
        assert_eq!(served["result"]["method"], *method, "{served}");
    }
}

/// `method` sent over a connection to a listener of `origin` (dialled with the relay `peers` header) on the real server
/// over the mock core, which echoes what it is served; the answer to it.
async fn answer_to(origin: ListenerOrigin, peers: &[&str], method: &'static str, params: &serde_json::Value) -> serde_json::Value {
    use mixdog_app_protocol::v1::{CapabilityState, ServerCapabilities};
    use mixdog_app_server::{AppServer, Inbound, Outgoing, ServerConfig, VersionOrder};
    use mixdog_core_api::mock::{MockCore, MockLimits};

    let (hub, mut listener) = listen_as(Limits::default(), origin).await;
    let origins = hub.clone();
    let available = || CapabilityState::Available;
    let server = AppServer::new(
        Arc::new(MockCore::new(
            &["transfer/authorizeRead", "transfer/redeemGrant", "transfer/finishRead", "transfer/grant/mint", "browser/stream", "browser/webrtcSignal", "browser/screenDisplays"],
            MockLimits::default(),
        )),
        Outgoing::new(),
        Arc::new(move |id| origins.origin_of(id)),
        ServerConfig {
            user_agent: "mixdog-test".to_owned(),
            platform_family: "windows".to_owned(),
            platform_os: "windows".to_owned(),
            server_version: "1.4.6".to_owned(),
            server_build: "test".to_owned(),
            server_instance_id: "instance-1".to_owned(),
            defaults_separation: Default::default(),
            capabilities: ServerCapabilities {
                office: available(),
                js_skills: available(),
                browser: available(),
                computer: available(),
                voice: available(),
                remote: Default::default(),
            },
            native_push: Arc::new(|| false),
            limits: Limits::default(),
            version_gate: Arc::new(|_| VersionOrder::Equal),
        },
    )
    .unwrap();
    let (mut client, accepted) = connected(&mut listener, Dial { peers, ..Dial::default() }).await;
    let AcceptedConnection { id, mut inbound, sink, .. } = accepted;
    let handle = server.open(id, Arc::new(sink.clone()));
    tokio::spawn(async move {
        while let Some(message) = inbound.recv().await {
            match handle.on_message(message) {
                Inbound::Continue => {}
                Inbound::Pause(resume) => resume.await,
                Inbound::Close(code) => {
                    sink.close(code);
                    break;
                }
            }
        }
    });

    let initialize = serde_json::json!({
        "id": 0, "method": "initialize",
        "params": { "clientInfo": { "name": "test", "version": "1.4.6", "kind": "desktop" }, "capabilities": {} },
    });
    let call = serde_json::json!({ "id": 1, "method": method, "params": params });
    for request in [initialize, call] {
        client.send(Message::text(request.to_string())).await.unwrap();
        loop {
            let Message::Text(text) = client.next().await.expect("the connection ended").unwrap() else { continue };
            let frame: serde_json::Value = serde_json::from_str(&text).unwrap();
            if frame["id"] == request["id"] {
                if request["id"] == 1 {
                    return frame;
                }
                break;
            }
        }
    }
    unreachable!("the call is the last request sent")
}

#[tokio::test]
async fn only_loopback_addresses_are_bound() {
    install_rt();
    let hub = ConnectionHub::new(small_limits()).unwrap();
    for addr in ["0.0.0.0:0", "192.0.2.1:0", "[::]:0"] {
        let result = WebSocketListener::bind(
            addr.parse().unwrap(),
            hub.clone(),
            BearerAuth::new(TOKEN),
            ListenerOrigin::Loopback,
        )
        .await;
        assert!(matches!(result, Err(ListenError::NotLoopback(_))), "{addr}");
    }
}

#[tokio::test]
async fn the_upgrade_past_max_connections_answers_503() {
    let (_hub, mut listener) = listen(Limits {
        max_connections: 1,
        ..small_limits()
    })
    .await;
    let (_first, _server) = connected(&mut listener, Dial::default()).await;
    let refused = dial(listener.local_addr(), Dial::default()).await;
    match refused {
        Err(WsError::Http(response)) => {
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
            assert_eq!(
                response.body().as_deref(),
                Some(br#"{"reason":"connectionLimit"}"#.as_slice())
            );
        }
        other => panic!("expected 503, got {:?}", other.map(|_| "connected")),
    }
}

#[tokio::test]
async fn oversized_text_and_bad_json_close_with_1009_and_1007() {
    let (hub, mut listener) = listen(small_limits()).await;
    let (mut client, _server) = connected(&mut listener, Dial::default()).await;
    let bound = hub.limits().max_inbound_frame_bytes as usize;
    let oversized = format!(r#"{{"id":1,"method":"x","params":"{}"}}"#, "a".repeat(bound));
    client.send(Message::text(oversized)).await.unwrap();
    assert_eq!(close_code(&mut client).await, 1009);

    let (mut client, _server) = connected(&mut listener, Dial::default()).await;
    client.send(Message::text("{not json")).await.unwrap();
    assert_eq!(close_code(&mut client).await, 1007);
}

#[derive(Default)]
struct Media(Mutex<Vec<Bytes>>);

impl HostMediaSink for Media {
    fn frame(&self, _from: ConnectionId, frame: Bytes) {
        self.0.lock().unwrap().push(frame);
    }
}

#[tokio::test]
async fn binary_frames_close_1003_unless_the_connection_holds_the_host_role() {
    let (_hub, mut listener) = listen(small_limits()).await;
    let (mut client, _server) = connected(&mut listener, Dial::default()).await;
    client
        .send(Message::Binary(Bytes::from_static(&[1; 32])))
        .await
        .unwrap();
    assert_eq!(close_code(&mut client).await, 1003);

    let (mut host, mut server) = connected(&mut listener, Dial::default()).await;
    let media = Arc::new(Media::default());
    server.sink.grant_host_media(media.clone());
    let mut frame = vec![1, 0, 0, 0, 0, 7, 2, 128, 1, 224, 1, 0, 0, 0, 0, 0];
    frame.extend_from_slice(b"jpeg");
    host.send(Message::Binary(Bytes::from(frame.clone())))
        .await
        .unwrap();
    // Ordered behind the media frame on the same socket.
    host.send(Message::text(REQUEST)).await.unwrap();
    server.inbound.recv().await.unwrap();
    assert_eq!(*media.0.lock().unwrap(), [Bytes::from(frame)]);
}

#[tokio::test]
async fn close_after_a_response_delivers_both_and_the_code() {
    let (_hub, mut listener) = listen(small_limits()).await;
    let (mut client, server) = connected(&mut listener, Dial::default()).await;
    server
        .sink
        .send_control(Bytes::from_static(br#"{"id":1,"error":{"code":-32600,"message":"x"}}"#))
        .unwrap();
    server.sink.close(CloseCode::VersionRefused);
    assert!(matches!(client.next().await, Some(Ok(Message::Text(_)))));
    assert_eq!(close_code(&mut client).await, 4002);
    // The client's close reply completes the handshake and releases the table slot.
    while client.next().await.is_some() {}
}

#[tokio::test]
async fn a_peer_that_never_answers_pings_is_closed_with_4001() {
    let (hub, mut listener) = listen(small_limits()).await;
    let (mut client, server) = connected(&mut listener, Dial::default()).await;
    // Tick 3 pings, tick 5 closes; the client reads nothing, so it answers nothing. (Pings
    // are asserted at the socket-half level in tests/it/connection.rs.)
    for _ in 0..4 {
        hub.heartbeat_tick();
    }
    assert_eq!(server.sink.close_code(), Some(CloseCode::PeerUnresponsive));
    assert_eq!(close_code(&mut client).await, 4001);
}

#[tokio::test]
async fn drain_closes_connections_with_1001_and_the_listener_stops_accepting() {
    let (hub, mut listener) = listen(small_limits()).await;
    let (mut client, _server) = connected(&mut listener, Dial::default()).await;
    listener.close();
    hub.close_all();
    assert_eq!(close_code(&mut client).await, 1001);
    assert!(listener.accept().await.is_none());
}
