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
    /// A client in this process (headless `mixdogd exec`). It holds the local user's authority,
    /// so the method table scopes it as `Origin::Local`: the protocol has no separate origin.
    InProcess,
    /// One desktop window's socket: it named itself with `Mixdog-Window` on the loopback
    /// listener, or on the one an SSH port forward targets (`tunnel`). It keeps the rights of
    /// the listener it came through, so the method table scopes it as `Local` or `Ssh`.
    Window {
        window_id: String,
        tunnel: bool,
        role: WindowRole,
    },
}

/// What a window's socket is for, from `Mixdog-Window-Role`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WindowRole {
    /// The window's own main connection (no role header means this).
    Main,
    /// A socket the window keeps for the server connection `connection_id`.
    Server { connection_id: String },
}

impl ConnectionOrigin {
    /// The window id of a [`Self::Window`] connection.
    pub fn window_id(&self) -> Option<&str> {
        match self {
            Self::Window { window_id, .. } => Some(window_id),
            _ => None,
        }
    }

    /// The role of a [`Self::Window`] connection.
    pub fn window_role(&self) -> Option<&WindowRole> {
        match self {
            Self::Window { role, .. } => Some(role),
            _ => None,
        }
    }

    /// The origin the method table scopes calls by.
    pub fn origin(&self) -> Origin {
        match self {
            Self::Loopback | Self::InProcess => Origin::Local,
            Self::SshTunnel | Self::Window { tunnel: true, .. } => Origin::Ssh,
            Self::Window { tunnel: false, .. } => Origin::Local,
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
