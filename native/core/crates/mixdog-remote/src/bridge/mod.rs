//! The relay bridge (LR §9): per `client-open`, one connection to the current target core — an
//! in-process relay connection for this PC's own core ([`local`]), or a WebSocket to the SSH
//! tunnel endpoint of a server core ([`ws`]) — carrying the peer id.
//! Decrypted frames cross byte for byte in both directions without being parsed; `client-close`,
//! a revoke, or the loss of the relay leg or the target closes the bridged socket; a core's close
//! code (1001 draining, 4002 version) is forwarded to the phone as the close.
//!
//! Each peer is one task, so a stalled phone stops only its own task (DS-REM-5).

pub mod local;
pub mod ws;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// The header the core's SSH listener reads to set `ConnectionOrigin::Relay { peer_id }`.
pub use mixdog_app_server_transport::websocket::RELAY_PEER_HEADER;
/// Frames queued per peer before `from_phone` refuses (Node's `REMOTE_CLIENT_PENDING_FRAMES`).
const PEER_QUEUE: usize = 256;
/// Frames of all phones the core has not taken at once (Node's `MAX_PENDING_REMOTE_TOTAL_FRAMES`, `remote-relay-clients.ts:24`).
pub const MAX_TOTAL_FRAMES: usize = 512;
/// Normal closure, sent upstream for `client-close`.
pub const CLOSE_NORMAL: u16 = 1000;
/// The target could not be reached.
pub const CLOSE_TRY_AGAIN_LATER: u16 = 1013;
pub const CLOSE_GOING_AWAY: u16 = 1001;
pub const CLOSE_VERSION: u16 = 4002;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Frame {
    Text(String),
    Binary(Vec<u8>),
}

#[derive(Debug)]
pub enum UpEvent {
    Frame(Frame),
    Closed { code: u16, reason: String },
}

#[derive(Debug, thiserror::Error)]
#[error("the target core could not be reached")]
pub struct DialError;

/// One bridged socket to a core.
#[async_trait]
pub trait Upstream: Send {
    async fn send(&mut self, frame: Frame) -> Result<(), DialError>;
    /// `None` when the socket ended without a close frame.
    async fn recv(&mut self) -> Option<UpEvent>;
    async fn close(&mut self, code: u16);
}

/// Opens a socket to the current target core for one peer.
#[async_trait]
pub trait Dialer: Send + Sync {
    async fn dial(&self, peer_id: &str) -> Result<Box<dyn Upstream>, DialError>;
    /// [`dial`](Self::dial) for the open `generation` of the peer: a dialer that registers the connection it makes names the open it
    /// was made for (`DeviceRegistry::connect_relay_in`), so the connection never resolves to a replacement's record.
    async fn dial_open(&self, peer_id: &str, _generation: u64) -> Result<Box<dyn Upstream>, DialError> {
        self.dial(peer_id).await
    }
}

/// What goes back to a phone: a frame to seal and send, or the end of its channel.
#[derive(Debug, PartialEq, Eq)]
pub enum ToPhone {
    /// `generation`: the bridge open the frame came from; a sink drops it unless that is still the peer's.
    Frame { peer_id: String, generation: u64, frame: Frame },
    /// `generation` is the bridge open (`client_open`) this close belongs to: a sink acts on it only while that open is still the peer's
    /// ([`Bridge::is_current`]), so a replaced socket's late failure never closes the client that replaced it.
    Close { peer_id: String, generation: u64, code: u16, reason: String },
}

/// Where the bridge delivers. An implementation applies the per-client queue and byte budget; a
/// slow phone makes only that peer's task wait.
#[async_trait]
pub trait PhoneSink: Send + Sync {
    async fn deliver(&self, message: ToPhone);
}

/// Frames and bytes handed to the core's socket queue and not yet taken (Node's `pendingFrames`, `pendingBytes`).
#[derive(Default)]
struct Pending {
    frames: AtomicUsize,
    bytes: AtomicU64,
}

/// One admitted frame's place in the budgets of its peer and of all peers; it ends when the frame has been handed to the core
/// (Node's `releaseFrame`).
struct Charge {
    peer: Arc<Pending>,
    total: Arc<Pending>,
    bytes: u64,
}

impl Drop for Charge {
    fn drop(&mut self) {
        for held in [&self.peer, &self.total] {
            held.frames.fetch_sub(1, Ordering::SeqCst);
            held.bytes.fetch_sub(self.bytes, Ordering::SeqCst);
        }
    }
}

struct Peer {
    /// Tells a replaced peer's finishing task from the current one.
    generation: u64,
    frames: mpsc::Sender<(Frame, Charge)>,
    pending: Arc<Pending>,
    stop: CancellationToken,
}

pub struct Bridge {
    sink: Arc<dyn PhoneSink>,
    dialer: Mutex<Arc<dyn Dialer>>,
    peers: Arc<Mutex<HashMap<String, Peer>>>,
    generations: AtomicU64,
    /// Every peer's pending frames and bytes together.
    total: Arc<Pending>,
    /// Serializes the check and the reservation of a frame's place: two deliveries never both see the last free place.
    admission: Mutex<()>,
    /// One peer's byte budget; all peers together may hold twice it (`frameBudgetBytes`, `remote-relay.ts:297`).
    frame_budget: u64,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl Bridge {
    pub fn new(dialer: Arc<dyn Dialer>, sink: Arc<dyn PhoneSink>) -> Self {
        Self::with_frame_budget(dialer, sink, crate::leg::MAX_WS_PAYLOAD_BYTES)
    }

    /// A bridge whose peers may each hold `frame_budget` bytes of frames the core has not taken, and all together twice that.
    pub fn with_frame_budget(dialer: Arc<dyn Dialer>, sink: Arc<dyn PhoneSink>, frame_budget: u64) -> Self {
        Self {
            sink,
            dialer: Mutex::new(dialer),
            peers: Arc::new(Mutex::new(HashMap::new())),
            generations: AtomicU64::new(0),
            total: Arc::new(Pending::default()),
            admission: Mutex::new(()),
            frame_budget,
        }
    }

    pub fn peer_count(&self) -> usize {
        lock(&self.peers).len()
    }

    /// Points new peers at another target core (a desktop attached to a server core, or back).
    /// Peers bridged to the old target are closed: one ladder per target.
    pub fn set_target(&self, dialer: Arc<dyn Dialer>) {
        *lock(&self.dialer) = dialer;
        self.close_all();
    }

    /// The phone's relay client opened: dial the target and pump both ways.
    ///
    /// The open's generation is the caller's own, the one its client table made (`client_open_as`); this one makes a fresh one, for a
    /// composition that has no table.
    pub fn client_open(&self, peer_id: &str) -> u64 {
        let generation = self.generations.fetch_add(1, Ordering::Relaxed);
        self.client_open_as(peer_id, generation);
        generation
    }

    /// The phone's relay client opened as `generation`; a second open of one id replaces the first, whose socket is closed and whose
    /// late events are dropped.
    pub fn client_open_as(&self, peer_id: &str, generation: u64) {
        let (frames, inbound) = mpsc::channel(PEER_QUEUE);
        let stop = CancellationToken::new();
        let pending = Arc::new(Pending::default());
        if let Some(old) = lock(&self.peers).insert(peer_id.to_owned(), Peer { generation, frames, pending, stop: stop.clone() }) {
            old.stop.cancel();
        }
        let dialer = lock(&self.dialer).clone();
        let sink = self.sink.clone();
        let peers = self.peers.clone();
        let id = peer_id.to_owned();
        tokio::spawn(async move {
            pump(dialer, sink, id.clone(), generation, inbound, stop).await;
            let mut peers = lock(&peers);
            if peers.get(&id).is_some_and(|peer| peer.generation == generation) {
                peers.remove(&id);
            }
        });
    }

    /// A decrypted frame from the phone, passed on untouched. Frames of a peer with no open
    /// bridge are dropped. `false`: the frame would take the peer past [`PEER_QUEUE`] frames or its byte budget, or all peers past
    /// [`MAX_TOTAL_FRAMES`] frames or twice the byte budget (Node's `budgetAvailable`, `remote-relay-clients.ts:217-222`), so it was
    /// refused and the caller closes the client ("remote client backlog exceeded", `admitFrame`); waiting here would stop every
    /// other phone's frames behind it.
    pub fn from_phone(&self, peer_id: &str, generation: u64, frame: Frame) -> bool {
        let Some((sender, pending)) =
            lock(&self.peers).get(peer_id).filter(|peer| peer.generation == generation).map(|peer| (peer.frames.clone(), peer.pending.clone()))
        else {
            return true;
        };
        let bytes = match &frame {
            Frame::Text(text) => text.len() as u64,
            Frame::Binary(data) => data.len() as u64,
        };
        // Check and reserve in one step; only releases (a `Charge` dropping) happen outside it, and they only free room.
        let reservation = lock(&self.admission);
        let admitted = pending.frames.load(Ordering::SeqCst) < PEER_QUEUE
            && pending.bytes.load(Ordering::SeqCst) + bytes <= self.frame_budget
            && self.total.frames.load(Ordering::SeqCst) < MAX_TOTAL_FRAMES
            && self.total.bytes.load(Ordering::SeqCst) + bytes <= self.frame_budget * 2;
        if !admitted {
            return false;
        }
        for held in [&pending, &self.total] {
            held.frames.fetch_add(1, Ordering::SeqCst);
            held.bytes.fetch_add(bytes, Ordering::SeqCst);
        }
        drop(reservation);
        let charge = Charge { peer: pending, total: self.total.clone(), bytes };
        // A refused send drops the charge with the frame.
        sender.try_send((frame, charge)).is_ok()
    }

    /// Whether `generation` is still the open the peer's bridge runs on.
    pub fn is_current(&self, peer_id: &str, generation: u64) -> bool {
        lock(&self.peers).get(peer_id).is_some_and(|peer| peer.generation == generation)
    }

    /// `client-close` or a revoke: the bridged socket is closed at once.
    /// Only the open `generation`: another open of the id (a replacement) is left running.
    pub fn close_peer(&self, peer_id: &str, generation: u64) -> bool {
        let mut peers = lock(&self.peers);
        if peers.get(peer_id).is_none_or(|peer| peer.generation != generation) {
            return false;
        }
        if let Some(peer) = peers.remove(peer_id) {
            peer.stop.cancel();
        }
        true
    }

    /// The relay leg or the target was lost: every bridged socket is closed.
    pub fn close_all(&self) {
        for (_, peer) in lock(&self.peers).drain() {
            peer.stop.cancel();
        }
    }
}

async fn pump(
    dialer: Arc<dyn Dialer>,
    sink: Arc<dyn PhoneSink>,
    peer_id: String,
    generation: u64,
    mut inbound: mpsc::Receiver<(Frame, Charge)>,
    stop: CancellationToken,
) {
    let dialed = tokio::select! {
        () = stop.cancelled() => return,
        dialed = dialer.dial_open(&peer_id, generation) => dialed,
    };
    let mut upstream = match dialed {
        Ok(upstream) => upstream,
        Err(DialError) => {
            sink.deliver(ToPhone::Close { peer_id, generation, code: CLOSE_TRY_AGAIN_LATER, reason: "core unavailable".into() }).await;
            return;
        }
    };
    loop {
        tokio::select! {
            () = stop.cancelled() => {
                upstream.close(CLOSE_NORMAL).await;
                return;
            }
            frame = inbound.recv() => {
                let Some((frame, charge)) = frame else {
                    upstream.close(CLOSE_NORMAL).await;
                    return;
                };
                // A blocked old socket must not outlive its retirement: the send is abandoned when the peer is closed or replaced.
                let sent = tokio::select! {
                    () = stop.cancelled() => {
                        drop(charge);
                        upstream.close(CLOSE_NORMAL).await;
                        return;
                    }
                    sent = upstream.send(frame) => sent,
                };
                // The core has taken it (or the socket is gone): its place in the budgets is free.
                drop(charge);
                if sent.is_err() {
                    sink.deliver(ToPhone::Close { peer_id, generation, code: CLOSE_TRY_AGAIN_LATER, reason: "core unavailable".into() }).await;
                    return;
                }
            }
            event = upstream.recv() => match event {
                Some(UpEvent::Frame(frame)) => {
                    // A slow phone parks this task here and nothing else.
                    tokio::select! {
                        () = stop.cancelled() => {
                            upstream.close(CLOSE_NORMAL).await;
                            return;
                        }
                        () = sink.deliver(ToPhone::Frame { peer_id: peer_id.clone(), generation, frame }) => {}
                    }
                }
                Some(UpEvent::Closed { code, reason }) => {
                    sink.deliver(ToPhone::Close { peer_id, generation, code, reason }).await;
                    return;
                }
                None => {
                    sink.deliver(ToPhone::Close { peer_id, generation, code: CLOSE_TRY_AGAIN_LATER, reason: "core unavailable".into() }).await;
                    return;
                }
            },
        }
    }
}
