//! The relay connection type (P §4.1, SPEC R25): each paired phone's E2E channel becomes one
//! [`AcceptedConnection`] carrying the same JSON-RPC text frames, in process. `mixdog-remote`
//! owns pairing and encryption; it holds the [`RelayEndpoint`] and moves decrypted frames in
//! and out. Authorization is the pairing claim, expressed as `ConnectionOrigin::Relay`.

use bytes::Bytes;
use mixdog_app_protocol::limits::CloseCode;
use tokio::sync::mpsc;

use crate::connection::AcceptedConnection;
use crate::connection::ConnectionOrigin;
use crate::hub::ConnectionHub;
use crate::hub::ConnectionLimit;
use crate::socket::Incoming;
use crate::socket::SocketClosed;
use crate::socket::SocketRead;
use crate::socket::SocketWrite;
use crate::writer::ConnectionWriter;

/// Frames from the peer that the endpoint may have handed over ahead of the reader.
const INBOUND_QUEUE: usize = 16;

/// What the core sends to the phone, in write order.
#[derive(Debug, PartialEq, Eq)]
pub enum RelayOut {
    /// One JSON-RPC text frame.
    Text(Bytes),
    /// A relay-level ping: answer with [`RelayEndpoint::send_activity`] when the phone is alive.
    Ping,
    /// The connection ended; the last item.
    Close(CloseCode),
}

/// The channel is closed: the connection ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RelayClosed;

enum RelayIn {
    Text(String),
    Activity,
}

/// The relay side of one phone connection. Dropping it ends the connection as a peer close.
pub struct RelayEndpoint {
    to_core: mpsc::Sender<RelayIn>,
    from_core: mpsc::Receiver<RelayOut>,
    connection: ConnectionWriter,
}

impl RelayEndpoint {
    /// A decrypted text frame from the phone. Waits while the core's reader is behind, which
    /// is the backpressure for this phone only.
    pub async fn send_text(&self, frame: String) -> Result<(), RelayClosed> {
        self.to_core
            .send(RelayIn::Text(frame))
            .await
            .map_err(|_| RelayClosed)
    }

    /// Any liveness evidence from the phone (a pong, or any frame the core does not need).
    pub async fn send_activity(&self) -> Result<(), RelayClosed> {
        self.to_core
            .send(RelayIn::Activity)
            .await
            .map_err(|_| RelayClosed)
    }

    /// The next outbound item; `None` once the connection ended.
    pub async fn recv(&mut self) -> Option<RelayOut> {
        self.from_core.recv().await
    }

    pub fn connection(&self) -> &ConnectionWriter {
        &self.connection
    }
}

struct RelayRead(mpsc::Receiver<RelayIn>);

impl SocketRead for RelayRead {
    async fn next(&mut self) -> Option<Incoming> {
        Some(match self.0.recv().await? {
            RelayIn::Text(text) => Incoming::Text(text),
            RelayIn::Activity => Incoming::Activity,
        })
    }
}

struct RelayWrite(mpsc::Sender<RelayOut>);

impl RelayWrite {
    async fn put(&self, item: RelayOut) -> Result<(), SocketClosed> {
        self.0.send(item).await.map_err(|_| SocketClosed)
    }
}

impl SocketWrite for RelayWrite {
    async fn text(&mut self, frame: Bytes) -> Result<(), SocketClosed> {
        self.put(RelayOut::Text(frame)).await
    }

    async fn ping(&mut self) -> Result<(), SocketClosed> {
        self.put(RelayOut::Ping).await
    }

    async fn close(&mut self, code: CloseCode) -> Result<(), SocketClosed> {
        self.put(RelayOut::Close(code)).await
    }
}

/// Opens the connection of one paired phone. Fails when `maxConnections` are open.
pub fn open_relay(
    hub: &ConnectionHub,
    peer_id: String,
) -> Result<(AcceptedConnection, RelayEndpoint), ConnectionLimit> {
    let (to_core, inbound) = mpsc::channel(INBOUND_QUEUE);
    // One slot: a phone that stops reading stalls the writer, and the byte budget takes over.
    let (outbound, from_core) = mpsc::channel(1);
    let accepted = hub.attach(
        ConnectionOrigin::Relay { peer_id },
        RelayRead(inbound),
        RelayWrite(outbound),
    )?;
    let endpoint = RelayEndpoint {
        to_core,
        from_core,
        connection: accepted.sink.clone(),
    };
    Ok((accepted, endpoint))
}
