//! The real dialer: a WebSocket to a core's `/rpc` (local discovery, or the SSH tunnel endpoint of
//! a server core) with the discovery token as Bearer and `Mixdog-Relay-Peer: <peerId>`. The core
//! sets the connection's origin from that header; the bridge sends and receives frames untouched.

use async_trait::async_trait;
use futures::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use super::{DialError, Dialer, Frame, RELAY_PEER_HEADER, UpEvent, Upstream};
use crate::leg::frame::is_routing_id;

pub struct WsDialer {
    /// `ws://127.0.0.1:<port>/rpc`, or the tunnel's local end.
    pub url: String,
    pub token: String,
}

pub struct WsUpstream {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
}

#[async_trait]
impl Dialer for WsDialer {
    async fn dial(&self, peer_id: &str) -> Result<Box<dyn Upstream>, DialError> {
        // The peer id becomes a header value; only a routing id is ever one.
        if !is_routing_id(peer_id) {
            return Err(DialError);
        }
        let mut request = self.url.as_str().into_client_request().map_err(|_| DialError)?;
        let headers = request.headers_mut();
        headers.insert(
            "Authorization",
            HeaderValue::from_str(&format!("Bearer {}", self.token)).map_err(|_| DialError)?,
        );
        headers.insert(
            RELAY_PEER_HEADER,
            HeaderValue::from_str(peer_id).map_err(|_| DialError)?,
        );
        let (socket, _) = crate::dial::connect(request, None)
            .await
            .map_err(|_| DialError)?;
        Ok(Box::new(WsUpstream { socket }))
    }
}

#[async_trait]
impl Upstream for WsUpstream {
    async fn send(&mut self, frame: Frame) -> Result<(), DialError> {
        let message = match frame {
            Frame::Text(text) => Message::Text(text.into()),
            Frame::Binary(bytes) => Message::Binary(bytes.into()),
        };
        self.socket.send(message).await.map_err(|_| DialError)
    }

    async fn recv(&mut self) -> Option<UpEvent> {
        loop {
            match self.socket.next().await? {
                Ok(Message::Text(text)) => return Some(UpEvent::Frame(Frame::Text(text.as_str().to_owned()))),
                Ok(Message::Binary(bytes)) => return Some(UpEvent::Frame(Frame::Binary(bytes.to_vec()))),
                Ok(Message::Close(frame)) => {
                    let (code, reason) = frame.map_or((1005, String::new()), |f| (u16::from(f.code), f.reason.to_string()));
                    return Some(UpEvent::Closed { code, reason });
                }
                Ok(_) => {}
                Err(_) => return None,
            }
        }
    }

    async fn close(&mut self, code: u16) {
        let frame = CloseFrame { code: CloseCode::from(code), reason: "".into() };
        let _ = self.socket.close(Some(frame)).await;
    }
}
