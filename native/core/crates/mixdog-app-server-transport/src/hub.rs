//! The connection table and the one heartbeat (P §4.7, SPEC R13).
//!
//! Every transport registers its connections here, so the connection limit, the ids and the
//! heartbeat are process-wide. The heartbeat is one task with one interval timer for the whole
//! table; connections hold only tick counters.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
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
use crate::connection::WindowRole;
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

/// Where log lines go (the daemon log).
pub type LineSink = Arc<dyn Fn(&str) + Send + Sync>;

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
    /// Where the line of each socket that never becomes a connection goes (the daemon log, through its contained sink).
    log: OnceLock<LineSink>,
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
                log: OnceLock::new(),
            }),
        })
    }

    /// Where the lines of sockets that never become a connection go (refused, abandoned, handshake failed); set once.
    pub fn set_log(&self, sink: LineSink) -> Result<(), LineSink> {
        self.inner.log.set(sink)
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
        let unserved = Unserved {
            hub: Arc::clone(&self.inner),
            id,
            origin: origin_name(shared.origin()),
            reason: Mutex::new(None),
            armed: true,
        };
        Pending {
            shared,
            registration: Registration {
                hub: Arc::clone(&self.inner),
                id,
            },
            unserved,
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

/// The origin's kind alone (no peer or window ids), for lines about a socket that has no identity yet.
fn origin_name(origin: &ConnectionOrigin) -> &'static str {
    match origin {
        ConnectionOrigin::Loopback => "loopback",
        ConnectionOrigin::SshTunnel => "sshTunnel",
        ConnectionOrigin::Relay { .. } => "relay",
        ConnectionOrigin::InProcess => "inProcess",
        ConnectionOrigin::Window { .. } => "window",
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

/// The end of a socket that never became a connection: the one place such a socket is recorded, whatever ended it.
/// `Pending::start` disarms it; connections that start are recorded by the server that serves them.
struct Unserved {
    hub: Arc<HubInner>,
    id: ConnectionId,
    origin: &'static str,
    reason: Mutex<Option<String>>,
    armed: bool,
}

impl Drop for Unserved {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let reason = self.reason.get_mut().unwrap_or_else(|poisoned| poisoned.into_inner()).take().unwrap_or_else(|| "peerClosed".to_owned());
        let (id, origin) = (self.id.0, self.origin);
        let (open, max) = (self.hub.entries().len(), self.hub.limits.max_connections);
        if let Some(log) = self.hub.log.get() {
            log(&format!("connection ended before service id={id} origin={origin} reason={reason} open={open} max={max}"));
        }
    }
}

/// A registered socket that has not become a connection yet.
pub struct Pending {
    // Declared first so it drops first: its line counts the table while this socket is still in it.
    unserved: Unserved,
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

    /// Scopes this socket as one desktop window's. The window keeps the listener's rights
    /// (`Local` on the loopback listener, `Ssh` on the tunnel's); only the window id and role
    /// are added, and only before the connection starts. False when an origin was taken already.
    pub fn narrow_to_window(&self, window_id: String, role: WindowRole) -> bool {
        let tunnel = matches!(self.shared.origin(), ConnectionOrigin::SshTunnel);
        self.shared.narrow(ConnectionOrigin::Window {
            window_id,
            tunnel,
            role,
        })
    }

    /// Why this socket will not become a connection (a fixed name: `refused status=503 reason=connectionLimit`, `abandoned`,
    /// `handshakeFailed`). Dropping it unstarted is its one line; a peer that just leaves says `peerClosed`.
    pub fn ends_because(&self, reason: String) {
        *self.unserved.reason.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(reason);
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
            mut unserved,
        } = self;
        unserved.armed = false;
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
