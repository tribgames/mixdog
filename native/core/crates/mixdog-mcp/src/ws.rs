//! WebSocket transport: JSON-RPC messages as text frames over a socket opened with the `mcp`
//! subprotocol and the server's configured headers.

use mixdog_rt::Liveness;
use std::collections::BTreeMap;

use async_trait::async_trait;
use futures::SinkExt;
use futures::StreamExt;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderName;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::transport::CloseCause;
use crate::transport::Incoming;
use crate::transport::IncomingRx;
use crate::transport::Transport;
use crate::transport::TransportError;

pub struct WebSocketTransport {
    outgoing: mpsc::UnboundedSender<String>,
    shutdown: CancellationToken,
}

impl WebSocketTransport {
    pub async fn connect(url: &Url, headers: &BTreeMap<String, String>) -> Result<(Self, IncomingRx), TransportError> {
        let mut request = url
            .as_str()
            .into_client_request()
            .map_err(|e| TransportError::Request(e.to_string()))?;
        let map = request.headers_mut();
        map.insert("sec-websocket-protocol", HeaderValue::from_static("mcp"));
        for (name, value) in headers {
            let name = HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| TransportError::Request(format!("invalid header name {name:?}")))?;
            let value = HeaderValue::from_str(value)
                .map_err(|_| TransportError::Request(format!("invalid value for header {name}")))?;
            map.insert(name, value);
        }
        let (socket, _) = tokio_tungstenite::connect_async(request)
            .await
            .map_err(|e| TransportError::Request(format!("WebSocket connect failed: {e}")))?;
        let (mut sink, mut stream) = socket.split();
        let (incoming, rx) = mpsc::unbounded_channel();
        let (outgoing, mut outgoing_rx) = mpsc::unbounded_channel::<String>();
        let shutdown = CancellationToken::new();
        let stop = shutdown.clone();
        mixdog_rt::spawn("mcp.ws.io", mixdog_rt::TaskClass::Work, async move {
            let reason = loop {
                tokio::select! {
                    () = stop.cancelled() => {
                        let _ = sink.close().await;
                        break "closed by client".to_owned();
                    }
                    queued = outgoing_rx.recv() => {
                        let Some(text) = queued else { break "closed by client".to_owned() };
                        if let Err(error) = sink.send(Message::Text(text.into())).await {
                            break format!("WebSocket send failed: {error}");
                        }
                    }
                    frame = stream.next() => match frame {
                        Some(Ok(Message::Text(text))) => match serde_json::from_str::<Value>(text.as_str()) {
                            Ok(message) => { let _ = incoming.send(Incoming::Message(message)); }
                            Err(error) => tracing::warn!(%error, "mcp ws: frame is not JSON"),
                        },
                        Some(Ok(Message::Close(_))) | None => break "WebSocket closed".to_owned(),
                        Some(Ok(_)) => {}
                        Some(Err(error)) => break format!("WebSocket error: {error}"),
                    },
                }
            };
            let _ = incoming.send(Incoming::Closed(CloseCause { reason, stderr_tail: String::new() }));
        });
        Ok((Self { outgoing, shutdown }, rx))
    }
}

impl Drop for WebSocketTransport {
    fn drop(&mut self) {
        self.shutdown.cancel();
    }
}

#[async_trait]
impl Transport for WebSocketTransport {
    async fn send(&self, message: Value, _liveness: Liveness) -> Result<(), TransportError> {
        let text =
            serde_json::to_string(&message).map_err(|e| TransportError::Request(e.to_string()))?;
        self.outgoing.send(text).map_err(|_| TransportError::Closed)
    }

    async fn close(&self) {
        self.shutdown.cancel();
    }
}
