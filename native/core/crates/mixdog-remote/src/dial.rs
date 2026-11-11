//! The one way the relay legs dial a WebSocket: the connect, TLS and upgrade handshake share a
//! single [`Liveness`], so a relay that accepts the TCP connection and never answers cannot park
//! a leg in "connecting" (hang audit F16; the leg's heartbeat only starts once it is open).
//!
//! Node's relay legs dial with `ws` and no handshake timeout (`relay-tunnel.mjs:234`). Divergence
//! (decisions.md): 30 s, the startup bound of Codex's MCP client (`codex-mcp/src/rmcp_client.rs:114`)
//! and of Node's `DEFAULT_MCP_STARTUP_TIMEOUT_MS`.

use std::io;
use std::time::Duration;

use mixdog_rt::Liveness;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite;
use tokio_tungstenite::tungstenite::handshake::client::Request;
use tokio_tungstenite::tungstenite::http::Response;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

pub(crate) const DIAL: Liveness = Liveness::stream(Duration::from_secs(30));

pub(crate) type Dialed = (
    WebSocketStream<MaybeTlsStream<TcpStream>>,
    Response<Option<Vec<u8>>>,
);

pub(crate) async fn connect(
    request: Request,
    config: Option<WebSocketConfig>,
) -> Result<Dialed, tungstenite::Error> {
    DIAL.bound_head(tokio_tungstenite::connect_async_with_config(
        request, config, false,
    ))
    .await
    .map_err(|expired| {
        tungstenite::Error::Io(io::Error::new(
            io::ErrorKind::TimedOut,
            format!("relay dial timed out after {}ms", expired.after.as_millis()),
        ))
    })?
}

#[cfg(test)]
mod tests {
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    use super::*;

    /// A relay that accepts the connection and never answers the upgrade.
    #[tokio::test(start_paused = true)]
    async fn a_relay_that_never_answers_the_upgrade_fails_the_dial() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/desktop", listener.local_addr().unwrap());
        let silent = tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((socket, _)) = listener.accept().await {
                held.push(socket);
            }
        });
        let request = url.as_str().into_client_request().unwrap();
        let outcome = mixdog_rt::time::timeout(Duration::from_secs(90), connect(request, None)).await;
        assert!(
            matches!(outcome, Ok(Err(_))),
            "the dial deadline ends it, the test timeout does not"
        );
        silent.abort();
    }
}
