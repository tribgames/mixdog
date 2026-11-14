//! The `Mixdog-Window` and `Mixdog-Window-Role` headers on both listeners, over real loopback
//! sockets: which origin the connection takes and which headers are refused.

#[path = "it/common/mod.rs"]
mod common;

use std::net::SocketAddr;

use common::install_rt;
use common::small_limits;
use mixdog_app_server_transport::AcceptedConnection;
use mixdog_app_server_transport::ConnectionHub;
use mixdog_app_server_transport::ConnectionOrigin;
use mixdog_app_server_transport::Transport;
use mixdog_app_server_transport::WindowRole;
use mixdog_app_server_transport::websocket::BearerAuth;
use mixdog_app_server_transport::websocket::ListenerOrigin;
use mixdog_app_server_transport::websocket::WINDOW_HEADER;
use mixdog_app_server_transport::websocket::WINDOW_ROLE_HEADER;
use mixdog_app_server_transport::websocket::WebSocketListener;
use mixdog_protocol::Origin;
use tokio::net::TcpStream;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Error as WsError;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::StatusCode;

const TOKEN: &str = "discovery-token";

type Client = WebSocketStream<TcpStream>;

async fn listen(origin: ListenerOrigin) -> WebSocketListener {
    install_rt();
    let hub = ConnectionHub::new(small_limits()).unwrap();
    WebSocketListener::bind(
        "127.0.0.1:0".parse().unwrap(),
        hub,
        BearerAuth::new(TOKEN),
        origin,
    )
    .await
    .unwrap()
}

/// Dials with the given header lines, each `(name, value)` appended as written.
async fn dial(addr: SocketAddr, headers: &[(&str, &str)]) -> Result<Client, WsError> {
    let tcp = TcpStream::connect(addr).await.unwrap();
    let mut request = format!("ws://{addr}/rpc").into_client_request().unwrap();
    request
        .headers_mut()
        .insert("authorization", format!("Bearer {TOKEN}").parse().unwrap());
    for (name, value) in headers {
        request.headers_mut().append(
            tokio_tungstenite::tungstenite::http::HeaderName::from_bytes(name.as_bytes()).unwrap(),
            value.parse().unwrap(),
        );
    }
    tokio_tungstenite::client_async(request, tcp)
        .await
        .map(|(client, _)| client)
}

async fn accepted(origin: ListenerOrigin, headers: &[(&str, &str)]) -> (Client, AcceptedConnection) {
    let mut listener = listen(origin).await;
    let client = dial(listener.local_addr(), headers).await.unwrap();
    let server = listener.accept().await.expect("listener open");
    (client, server)
}

async fn refusal_reason(origin: ListenerOrigin, headers: &[(&str, &str)]) -> String {
    let listener = listen(origin).await;
    match dial(listener.local_addr(), headers).await {
        Err(WsError::Http(response)) => {
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{headers:?}");
            let body = response.body().clone().unwrap_or_default();
            let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
            json["reason"].as_str().unwrap().to_owned()
        }
        other => panic!("expected a refusal for {headers:?}, got {:?}", other.map(|_| "connected")),
    }
}

#[tokio::test]
async fn window_header_loopback_narrows() {
    let (_client, server) = accepted(ListenerOrigin::Loopback, &[(WINDOW_HEADER, "win-1")]).await;
    assert_eq!(
        server.origin,
        ConnectionOrigin::Window {
            window_id: "win-1".into(),
            tunnel: false,
            role: WindowRole::Main,
        }
    );
    assert_eq!(server.origin.window_id(), Some("win-1"));
    assert_eq!(server.origin.window_role(), Some(&WindowRole::Main));
    assert_eq!(server.origin.origin(), Origin::Local);
}

#[tokio::test]
async fn window_header_tunnel_narrows() {
    let (_client, server) = accepted(ListenerOrigin::SshTunnel, &[(WINDOW_HEADER, "win-2")]).await;
    assert_eq!(
        server.origin,
        ConnectionOrigin::Window {
            window_id: "win-2".into(),
            tunnel: true,
            role: WindowRole::Main,
        }
    );
    assert_eq!(server.origin.origin(), Origin::Ssh);
}

#[tokio::test]
async fn window_role_main_and_server() {
    for listener in [ListenerOrigin::Loopback, ListenerOrigin::SshTunnel] {
        let (_client, server) =
            accepted(listener, &[(WINDOW_HEADER, "w"), (WINDOW_ROLE_HEADER, "main")]).await;
        assert_eq!(server.origin.window_role(), Some(&WindowRole::Main));

        let (_client, server) = accepted(
            listener,
            &[(WINDOW_HEADER, "w"), (WINDOW_ROLE_HEADER, "server:conn_1.a:b-c")],
        )
        .await;
        assert_eq!(
            server.origin.window_role(),
            Some(&WindowRole::Server {
                connection_id: "conn_1.a:b-c".into()
            })
        );
    }
}

#[tokio::test]
async fn window_header_malformed_refused() {
    let long = "a".repeat(129);
    for listener in [ListenerOrigin::Loopback, ListenerOrigin::SshTunnel] {
        for bad in ["", "has space", "slash/id", long.as_str()] {
            assert_eq!(refusal_reason(listener, &[(WINDOW_HEADER, bad)]).await, "invalidWindow", "{bad:?}");
        }
        assert_eq!(
            refusal_reason(listener, &[(WINDOW_HEADER, "a"), (WINDOW_HEADER, "b")]).await,
            "invalidWindow"
        );
        for role in ["", "Main", "server", "server:", "server:bad id", "admin", "main:x"] {
            assert_eq!(
                refusal_reason(listener, &[(WINDOW_HEADER, "a"), (WINDOW_ROLE_HEADER, role)]).await,
                "invalidWindowRole",
                "{role:?}"
            );
        }
        assert_eq!(
            refusal_reason(
                listener,
                &[(WINDOW_HEADER, "a"), (WINDOW_ROLE_HEADER, "main"), (WINDOW_ROLE_HEADER, "main")]
            )
            .await,
            "invalidWindowRole"
        );
        // A role without a window names nothing.
        assert_eq!(
            refusal_reason(listener, &[(WINDOW_ROLE_HEADER, "main")]).await,
            "invalidWindowRole"
        );
    }
}

#[tokio::test]
async fn window_and_relay_peer_refused() {
    for listener in [ListenerOrigin::Loopback, ListenerOrigin::SshTunnel] {
        assert_eq!(
            refusal_reason(
                listener,
                &[(WINDOW_HEADER, "win-1"), ("mixdog-relay-peer", "0a1b2c3d-4e5f")]
            )
            .await,
            "conflictingNarrowing"
        );
    }
}

#[tokio::test]
async fn no_header_unchanged() {
    let (_client, server) = accepted(ListenerOrigin::Loopback, &[]).await;
    assert_eq!(server.origin, ConnectionOrigin::Loopback);
    assert_eq!(server.origin.window_id(), None);
    let (_client, server) = accepted(ListenerOrigin::SshTunnel, &[]).await;
    assert_eq!(server.origin, ConnectionOrigin::SshTunnel);
    let (_client, server) =
        accepted(ListenerOrigin::SshTunnel, &[("mixdog-relay-peer", "0a1b2c3d-4e5f")]).await;
    assert_eq!(server.origin, ConnectionOrigin::Relay { peer_id: "0a1b2c3d-4e5f".into() });
}
