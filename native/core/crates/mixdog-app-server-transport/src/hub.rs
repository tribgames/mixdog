//! The connection table and the one heartbeat (P §4.7, SPEC R13).
//!
//! Every transport registers its connections here, so the connection limit, the ids and the
//! heartbeat are process-wide. The heartbeat is one task with one interval timer for the whole
//! table; connections hold only tick counters.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::Weak;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use mixdog_app_protocol::limits::CloseCode;
use mixdog_app_protocol::limits::Limits;
use mixdog_app_protocol::limits::LimitsViolation;
use mixdog_core_api::ids::ConnectionId;
use mixdog_protocol::Origin;
use mixdog_rt::TaskClass;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_util::sync::WaitForCancellationFuture;

use crate::connection::AcceptedConnection;
use crate::connection::ConnectionOrigin;
use crate::connection::InboundFrames;
use crate::inbound::read_loop;
use crate::socket::SocketRead;
use crate::socket::SocketWrite;
use crate::writer::Closing;
use crate::writer::ConnectionWriter;
use crate::writer::Shared;
use crate::writer::WriterLimits;
use crate::writer::write_loop;

/// Requests the reader may have decoded ahead of the server (C0 admission queue, RL §4.2).
const INBOUND_QUEUE: usize = 64;

/// `limits.maxConnections` connections are open already.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ConnectionLimit;

struct HubInner {
    limits: Limits,
    writer_limits: WriterLimits,
    /// Heartbeat tick counter. Starts at 1 so 0 can mean "never" in per-connection stamps.
    clock: Arc<AtomicU64>,
    next_id: AtomicU64,
    entries: Mutex<HashMap<ConnectionId, Arc<Shared>>>,
}

impl HubInner {
    fn entries(&self) -> std::sync::MutexGuard<'_, HashMap<ConnectionId, Arc<Shared>>> {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[derive(Clone)]
pub struct ConnectionHub {
    inner: Arc<HubInner>,
}

impl ConnectionHub {
    /// Validates the limits (P §6.5 invariants): a violation is a configuration error and the
    /// core refuses to start.
    pub fn new(limits: Limits) -> Result<Self, LimitsViolation> {
        limits.check()?;
        Ok(Self {
            inner: Arc::new(HubInner {
                writer_limits: WriterLimits::new(&limits),
                limits,
                clock: Arc::new(AtomicU64::new(1)),
                next_id: AtomicU64::new(1),
                entries: Mutex::new(HashMap::new()),
            }),
        })
    }

    pub fn limits(&self) -> &Limits {
        &self.inner.limits
    }

    /// Open connections plus sockets still in their upgrade.
    pub fn len(&self) -> usize {
        self.inner.entries().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Where the connection `id` came from, `None` once it is closing or gone (or never existed). A caller
    /// that needs a decision for an unknown id must fail closed, e.g. as [`Origin::Relay`].
    pub fn connection_origin(&self, id: ConnectionId) -> Option<ConnectionOrigin> {
        self.inner
            .entries()
            .get(&id)
            .filter(|shared| shared.closing().is_none())
            .map(|shared| shared.origin().clone())
    }

    /// The method-table origin of connection `id` (`connection_origin(id).origin()`), the
    /// shape the workspace's `origin_of` needs.
    pub fn origin_of(&self, id: ConnectionId) -> Option<Origin> {
        self.connection_origin(id).map(|origin| origin.origin())
    }

    /// Registers a socket that is about to become a connection. It counts against
    /// `maxConnections` and is reaped by the heartbeat if it never finishes its upgrade.
    pub fn admit(&self, origin: ConnectionOrigin) -> Pending {
        let id = ConnectionId(self.inner.next_id.fetch_add(1, Ordering::Relaxed));
        let shared = Arc::new(Shared::new(
            id,
            origin,
            self.inner.writer_limits,
            Arc::clone(&self.inner.clock),
        ));
        self.inner.entries().insert(id, Arc::clone(&shared));
        Pending {
            shared,
            registration: Registration {
                hub: Arc::clone(&self.inner),
                id,
            },
        }
    }

    /// A connection over an already established socket (the relay channel, tests).
    pub fn attach<R: SocketRead, W: SocketWrite>(
        &self,
        origin: ConnectionOrigin,
        reader: R,
        writer: W,
    ) -> Result<AcceptedConnection, ConnectionLimit> {
        let pending = self.admit(origin);
        if pending.over_limit() {
            return Err(ConnectionLimit);
        }
        Ok(pending.start(reader, writer))
    }

    /// One heartbeat tick: pings silent peers and closes unresponsive ones (P §4.7). Returns
    /// the tick number. [`Self::spawn_heartbeat`] calls it on its interval.
    pub fn heartbeat_tick(&self) -> u64 {
        let tick = self.inner.clock.fetch_add(1, Ordering::AcqRel) + 1;
        // Ticks run on a snapshot so the table lock is never held while connections close.
        let connections: Vec<Arc<Shared>> = self.inner.entries().values().cloned().collect();
        for connection in connections {
            connection.on_tick(tick);
        }
        tick
    }

    /// Starts the heartbeat: one task, one interval timer (`heartbeatTickMs`) for the whole
    /// table. It ends when the last hub handle is dropped.
    pub fn spawn_heartbeat(&self) -> JoinHandle<()> {
        let hub: Weak<HubInner> = Arc::downgrade(&self.inner);
        let period = Duration::from_millis(self.inner.limits.heartbeat_tick_ms);
        mixdog_rt::spawn("transport.heartbeat", TaskClass::Control, async move {
            let mut interval =
                mixdog_rt::time::interval_at(tokio::time::Instant::now() + period, period);
            loop {
                interval.tick().await;
                let Some(inner) = hub.upgrade() else { return };
                ConnectionHub { inner }.heartbeat_tick();
            }
        })
    }

    /// Drain: closes every connection with 1001 after its queued control frames, and abandons
    /// sockets that never finished their upgrade.
    pub fn close_all(&self) {
        let connections: Vec<Arc<Shared>> = self.inner.entries().values().cloned().collect();
        for connection in connections {
            if connection.is_upgraded() {
                connection.begin_close(Closing::Send(CloseCode::GoingAway), true);
            } else {
                connection.abort.cancel();
            }
        }
    }
}

/// Removes a connection from the table when its last task ends.
struct Registration {
    hub: Arc<HubInner>,
    id: ConnectionId,
}

impl Drop for Registration {
    fn drop(&mut self) {
        self.hub.entries().remove(&self.id);
    }
}

/// A registered socket that has not become a connection yet.
pub struct Pending {
    shared: Arc<Shared>,
    registration: Registration,
}

impl Pending {
    /// More than `maxConnections` sockets are registered (this one included).
    pub fn over_limit(&self) -> bool {
        self.registration.hub.entries().len() > self.registration.hub.limits.max_connections as usize
    }

    /// Scopes this socket as one paired phone's relay channel. Only the relay origin can be
    /// taken this way, and only before the connection starts: the method table gives `Relay`
    /// a subset of what `Local` and `Ssh` may call, so a peer can lower its own rights and
    /// never raise them.
    pub fn narrow_to_relay(&self, peer_id: String) -> bool {
        self.shared.narrow(ConnectionOrigin::Relay { peer_id })
    }

    /// Resolves when the heartbeat or a drain abandons this socket.
    pub fn abandoned(&self) -> WaitForCancellationFuture<'_> {
        self.shared.abort.cancelled()
    }

    /// Turns the socket into a connection: starts its writer and reader tasks on RT-C.
    pub fn start<R: SocketRead, W: SocketWrite>(self, reader: R, writer: W) -> AcceptedConnection {
        let Self {
            shared,
            registration,
        } = self;
        let id = shared.id();
        let origin = shared.origin().clone();
        shared.mark_upgraded();
        shared.note_rx();
        let (inbound_tx, inbound_rx) = mpsc::channel(INBOUND_QUEUE);
        let registration = Arc::new(registration);
        {
            let shared = Arc::clone(&shared);
            let registration = Arc::clone(&registration);
            mixdog_rt::spawn("transport.write", TaskClass::Control, async move {
                write_loop(shared, writer).await;
                drop(registration);
            });
        }
        {
            let shared = Arc::clone(&shared);
            mixdog_rt::spawn("transport.read", TaskClass::Control, async move {
                read_loop(shared, reader, inbound_tx).await;
                drop(registration);
            });
        }
        let sink = ConnectionWriter::new(shared);
        AcceptedConnection {
            id,
            origin,
            inbound: InboundFrames::new(inbound_rx, sink.clone()),
            sink,
        }
    }
}
