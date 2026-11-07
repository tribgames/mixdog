//! Shared harness: a connection over in-memory socket halves, so writer, reader, heartbeat and
//! feed ordering are tested without a network.

#![allow(dead_code)]

use std::sync::Arc;

use bytes::Bytes;
use mixdog_app_protocol::limits::CloseCode;
use mixdog_app_protocol::limits::Limits;
use mixdog_app_server_transport::AcceptedConnection;
use mixdog_app_server_transport::ConnectionHub;
use mixdog_app_server_transport::ConnectionOrigin;
use mixdog_app_server_transport::Incoming;
use mixdog_app_server_transport::SocketClosed;
use mixdog_app_server_transport::SocketRead;
use mixdog_app_server_transport::SocketWrite;
use mixdog_core_api::mock::MockLimits;
use tokio::sync::Semaphore;
use tokio::sync::mpsc;

/// What reached the socket.
#[derive(Debug, PartialEq, Eq)]
pub enum Wire {
    Text(String),
    Ping,
    Close(CloseCode),
}

pub struct TestWrite {
    out: mpsc::UnboundedSender<Wire>,
    /// A write takes one permit first: a stalled peer is a semaphore with no permits.
    gate: Arc<Semaphore>,
}

impl TestWrite {
    async fn put(&mut self, wire: Wire) -> Result<(), SocketClosed> {
        let permit = self.gate.acquire().await.map_err(|_| SocketClosed)?;
        permit.forget();
        self.out.send(wire).map_err(|_| SocketClosed)
    }
}

impl SocketWrite for TestWrite {
    async fn text(&mut self, frame: Bytes) -> Result<(), SocketClosed> {
        self.put(Wire::Text(String::from_utf8_lossy(&frame).into_owned()))
            .await
    }

    async fn ping(&mut self) -> Result<(), SocketClosed> {
        self.put(Wire::Ping).await
    }

    async fn close(&mut self, code: CloseCode) -> Result<(), SocketClosed> {
        self.put(Wire::Close(code)).await
    }
}

pub struct TestRead(mpsc::UnboundedReceiver<Incoming>);

impl TestRead {
    /// A stream that has already ended.
    pub fn closed() -> Self {
        Self(mpsc::unbounded_channel().1)
    }
}

impl TestWrite {
    /// A socket nobody reads from.
    pub fn sink() -> Self {
        Self {
            out: mpsc::unbounded_channel().0,
            gate: Arc::new(Semaphore::new(0)),
        }
    }
}

impl SocketRead for TestRead {
    async fn next(&mut self) -> Option<Incoming> {
        self.0.recv().await
    }
}

/// The test's side of one connection.
pub struct Peer {
    pub connection: AcceptedConnection,
    pub wire: mpsc::UnboundedReceiver<Wire>,
    pub send: mpsc::UnboundedSender<Incoming>,
    pub gate: Arc<Semaphore>,
}

impl Peer {
    /// Lets `n` more socket writes complete.
    pub fn allow(&self, n: usize) {
        self.gate.add_permits(n);
    }

    /// Reads exactly `n` wire items (bounded wait only so a bug fails instead of hanging).
    pub async fn take(&mut self, n: usize) -> Vec<Wire> {
        let mut items = Vec::new();
        while items.len() < n {
            let item = self.wire.recv().await.expect("socket still open");
            items.push(item);
        }
        items
    }

    /// Texts of `take(n)`.
    pub async fn take_text(&mut self, n: usize) -> Vec<String> {
        self.take(n)
            .await
            .into_iter()
            .map(|wire| match wire {
                Wire::Text(text) => text,
                other => panic!("expected text, got {other:?}"),
            })
            .collect()
    }

    /// Everything the socket produced until it closed.
    pub async fn until_closed(&mut self) -> Vec<Wire> {
        let mut items = Vec::new();
        loop {
            match self.wire.recv().await {
                Some(item) => items.push(item),
                None => return items,
            }
        }
    }
}

pub fn connect(hub: &ConnectionHub, origin: ConnectionOrigin, writable: bool) -> Peer {
    let (wire_tx, wire) = mpsc::unbounded_channel();
    let (send, read_rx) = mpsc::unbounded_channel();
    let gate = Arc::new(Semaphore::new(if writable { Semaphore::MAX_PERMITS } else { 0 }));
    let connection = hub
        .attach(
            origin,
            TestRead(read_rx),
            TestWrite {
                out: wire_tx,
                gate: Arc::clone(&gate),
            },
        )
        .expect("below the connection limit");
    Peer {
        connection,
        wire,
        send,
        gate,
    }
}

pub fn install_rt() {
    mixdog_rt::testing::tokens();
}

/// Limits small enough to fill in a test, still satisfying the P §6.5 invariants.
pub fn small_limits() -> Limits {
    let kib = 1024;
    Limits {
        max_item_field_bytes: kib,
        max_frame_bytes: kib + 64 * kib,
        queue_bytes: 576 * kib,
        control_reserve_bytes: 64 * kib,
        event_budget_bytes: 512 * kib,
        max_snapshot_bytes: 16 * kib,
        max_blob_put_chunk_bytes: 128 * kib,
        ..Limits::default()
    }
}

/// The mock feed's limits matching [`small_limits`].
pub fn mock_limits(limits: &Limits) -> MockLimits {
    MockLimits {
        queue_bytes: limits.queue_bytes as usize,
        control_reserve_bytes: limits.control_reserve_bytes as usize,
        max_snapshot_bytes: limits.max_snapshot_bytes as usize,
        ring_bytes: limits.ring_bytes as usize,
    }
}
