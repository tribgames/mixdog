//! The in-process dialer (SPEC R25): when the target is this PC's own core, a phone's channel is
//! one relay connection (`ConnectionOrigin::Relay { peer_id }`) in the core's connection table,
//! and no socket is involved. The server's own heartbeat pings it at relay level; the relay
//! server's sweep owns a silent phone, so the bridge answers the ping while the connection lives.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_app_server_transport::relay::{RelayEndpoint, RelayOut, open_relay};
use mixdog_app_server_transport::{AcceptedConnection, ConnectionHub};

use super::{DialError, Dialer, Frame, UpEvent, Upstream};

/// Hands an accepted connection to the server that drives it.
pub type Accept = Arc<dyn Fn(AcceptedConnection) + Send + Sync>;

pub struct LocalDialer {
    hub: ConnectionHub,
    accept: Accept,
}

impl LocalDialer {
    pub fn new(hub: ConnectionHub, accept: Accept) -> Self {
        Self { hub, accept }
    }
}

pub struct LocalUpstream {
    /// `None` once closed: dropping the endpoint ends the connection as a peer close.
    endpoint: Option<RelayEndpoint>,
}

#[async_trait]
impl Dialer for LocalDialer {
    async fn dial(&self, peer_id: &str) -> Result<Box<dyn Upstream>, DialError> {
        let (accepted, endpoint) = open_relay(&self.hub, peer_id.to_owned()).map_err(|_| DialError)?;
        (self.accept)(accepted);
        Ok(Box::new(LocalUpstream { endpoint: Some(endpoint) }))
    }
}

#[async_trait]
impl Upstream for LocalUpstream {
    /// The relay connection carries JSON-RPC text only; a binary frame ends it, as a binary frame
    /// does on any other transport of the core.
    async fn send(&mut self, frame: Frame) -> Result<(), DialError> {
        match (frame, self.endpoint.as_ref()) {
            (Frame::Text(text), Some(endpoint)) => endpoint.send_text(text).await.map_err(|_| DialError),
            _ => Err(DialError),
        }
    }

    async fn recv(&mut self) -> Option<UpEvent> {
        loop {
            match self.endpoint.as_mut()?.recv().await? {
                RelayOut::Text(bytes) => {
                    return Some(UpEvent::Frame(Frame::Text(String::from_utf8_lossy(&bytes).into_owned())));
                }
                RelayOut::Ping => {
                    self.endpoint.as_ref()?.send_activity().await.ok()?;
                }
                RelayOut::Close(code) => return Some(UpEvent::Closed { code: code.code(), reason: code.reason().to_owned() }),
            }
        }
    }

    async fn close(&mut self, _code: u16) {
        self.endpoint = None;
    }
}
