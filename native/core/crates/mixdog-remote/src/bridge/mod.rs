//! The relay bridge (LR §9): per `client-open`, one WebSocket to the current target core — the
//! local core's `/rpc`, or the SSH tunnel endpoint of a server core — carrying the peer id.
//! Decrypted frames cross byte for byte in both directions without being parsed; `client-close`,
//! a revoke, or the loss of the relay leg or the target closes the bridged socket; a core's close
//! code (1001 draining, 4002 version) is forwarded to the phone as the close.
//!
//! Each peer is one task, so a stalled phone stops only its own task (DS-REM-5).

pub mod ws;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// The header the core reads to set `ConnectionOrigin::Relay { peer_id }`.
pub const RELAY_PEER_HEADER: &str = "Mixdog-Relay-Peer";
/// Phones queued per peer before `from_phone` waits.
const PEER_QUEUE: usize = 256;
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
}

/// What goes back to a phone: a frame to seal and send, or the end of its channel.
#[derive(Debug, PartialEq, Eq)]
pub enum ToPhone {
    Frame { peer_id: String, frame: Frame },
    Close { peer_id: String, code: u16, reason: String },
}

/// Where the bridge delivers. An implementation applies the per-client queue and byte budget; a
/// slow phone makes only that peer's task wait.
#[async_trait]
pub trait PhoneSink: Send + Sync {
    async fn deliver(&self, message: ToPhone);
}

struct Peer {
    /// Tells a replaced peer's finishing task from the current one.
    generation: u64,
    frames: mpsc::Sender<Frame>,
    stop: CancellationToken,
}

pub struct Bridge {
    sink: Arc<dyn PhoneSink>,
    dialer: Mutex<Arc<dyn Dialer>>,
    peers: Arc<Mutex<HashMap<String, Peer>>>,
    generations: AtomicU64,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl Bridge {
    pub fn new(dialer: Arc<dyn Dialer>, sink: Arc<dyn PhoneSink>) -> Self {
        Self { sink, dialer: Mutex::new(dialer), peers: Arc::new(Mutex::new(HashMap::new())), generations: AtomicU64::new(0) }
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
    pub fn client_open(&self, peer_id: &str) {
        let (frames, inbound) = mpsc::channel(PEER_QUEUE);
        let stop = CancellationToken::new();
        // A second open of one id replaces the first.
        let generation = self.generations.fetch_add(1, Ordering::Relaxed);
        if let Some(old) = lock(&self.peers).insert(peer_id.to_owned(), Peer { generation, frames, stop: stop.clone() }) {
            old.stop.cancel();
        }
        let dialer = lock(&self.dialer).clone();
        let sink = self.sink.clone();
        let peers = self.peers.clone();
        let id = peer_id.to_owned();
        tokio::spawn(async move {
            pump(dialer, sink, id.clone(), inbound, stop).await;
            let mut peers = lock(&peers);
            if peers.get(&id).is_some_and(|peer| peer.generation == generation) {
                peers.remove(&id);
            }
        });
    }

    /// A decrypted frame from the phone, passed on untouched. Frames of a peer with no open
    /// bridge are dropped.
    pub async fn from_phone(&self, peer_id: &str, frame: Frame) {
        let sender = lock(&self.peers).get(peer_id).map(|peer| peer.frames.clone());
        if let Some(sender) = sender {
            let _ = sender.send(frame).await;
        }
    }

    /// `client-close` or a revoke: the bridged socket is closed at once.
    pub fn close_peer(&self, peer_id: &str) {
        if let Some(peer) = lock(&self.peers).remove(peer_id) {
            peer.stop.cancel();
        }
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
    mut inbound: mpsc::Receiver<Frame>,
    stop: CancellationToken,
) {
    let dialed = tokio::select! {
        () = stop.cancelled() => return,
        dialed = dialer.dial(&peer_id) => dialed,
    };
    let mut upstream = match dialed {
        Ok(upstream) => upstream,
        Err(DialError) => {
            sink.deliver(ToPhone::Close { peer_id, code: CLOSE_TRY_AGAIN_LATER, reason: "core unavailable".into() }).await;
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
                let Some(frame) = frame else {
                    upstream.close(CLOSE_NORMAL).await;
                    return;
                };
                if upstream.send(frame).await.is_err() {
                    sink.deliver(ToPhone::Close { peer_id, code: CLOSE_TRY_AGAIN_LATER, reason: "core unavailable".into() }).await;
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
                        () = sink.deliver(ToPhone::Frame { peer_id: peer_id.clone(), frame }) => {}
                    }
                }
                Some(UpEvent::Closed { code, reason }) => {
                    sink.deliver(ToPhone::Close { peer_id, code, reason }).await;
                    return;
                }
                None => {
                    sink.deliver(ToPhone::Close { peer_id, code: CLOSE_TRY_AGAIN_LATER, reason: "core unavailable".into() }).await;
                    return;
                }
            },
        }
    }
}
