//! What a transport hands the server for each accepted connection (P §2.3).

use std::future::Future;

use mixdog_app_protocol::JsonRpcMessage;
use mixdog_core_api::ids::ConnectionId;
use mixdog_protocol::Origin;
use tokio::sync::mpsc;

use crate::writer::ConnectionWriter;

/// Where a connection came from, known from the listener or relay channel that accepted it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ConnectionOrigin {
    /// The loopback listener (desktop, TUI, CLI on this machine).
    Loopback,
    /// The listener an SSH port forward targets.
    SshTunnel,
    /// One paired phone's relay channel.
    Relay { peer_id: String },
}

impl ConnectionOrigin {
    /// The origin the method table scopes calls by.
    pub fn origin(&self) -> Origin {
        match self {
            Self::Loopback => Origin::Local,
            Self::SshTunnel => Origin::Ssh,
            Self::Relay { .. } => Origin::Relay,
        }
    }
}

/// Decoded inbound requests and notifications of one connection, in arrival order.
///
/// The reader stops reading the socket while this queue is full, so a connection whose
/// processing falls behind slows only its own peer. [`Self::recv`] answers `None` once the
/// connection is closed. Dropping it closes the connection with 1000.
pub struct InboundFrames {
    rx: mpsc::Receiver<JsonRpcMessage>,
    writer: ConnectionWriter,
}

impl InboundFrames {
    pub(crate) fn new(rx: mpsc::Receiver<JsonRpcMessage>, writer: ConnectionWriter) -> Self {
        Self { rx, writer }
    }

    pub async fn recv(&mut self) -> Option<JsonRpcMessage> {
        self.rx.recv().await
    }
}

impl Drop for InboundFrames {
    fn drop(&mut self) {
        self.writer.close(mixdog_app_protocol::limits::CloseCode::Normal);
    }
}

pub struct AcceptedConnection {
    pub id: ConnectionId,
    pub origin: ConnectionOrigin,
    pub inbound: InboundFrames,
    pub sink: ConnectionWriter,
}

/// A source of authenticated connections.
pub trait Transport: Send + 'static {
    /// The next authenticated connection; `None` when the listener is closed (drain).
    fn accept(&mut self) -> impl Future<Output = Option<AcceptedConnection>> + Send;
}
