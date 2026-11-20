//! The WebSocket server of the relay: what the `ws` package (8.21, `WebSocketServer` in `noServer` mode with
//! `maxPayload`, `perMessageDeflate: false`) gives `apps/relay/server.mjs`, in Rust and without a Node runtime.
//!
//! The HTTP layer hands an upgrade request over with its transport and the bytes it already read past the head
//! (`WebSocketServer::handle_upgrade`, the `wss.handleUpgrade` call of `server.mjs`). The request is validated as `ws`
//! validates it; a refusal is written as `abortHandshake` writes it; an accepted one is answered with the 101 head and
//! becomes a [`WebSocket`] with its [`WsEvents`].

pub mod codec;
pub mod handshake;
pub mod socket;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU8, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use bytes::Bytes;
use tokio::io::AsyncWriteExt;
use tokio::sync::watch;

pub use codec::{FrameError, ReceiverError};
pub use handshake::{HandshakeRequest, Refusal};
pub use socket::{FlushCallback, Gate, Holder, RawTap, ReadyState, SendError, Transport, WebSocket, WsEvent, WsEvents};

/// `CLOSE_TIMEOUT` of `ws`: how long `close` waits for the peer's close frame before it destroys the connection.
pub const CLOSE_TIMEOUT: Duration = Duration::from_secs(30);

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The options `server.mjs` gives the server: `maxPayload` (0 is unlimited). The close timeout is `ws`'s own 30 s unless
/// a test shortens it.
#[derive(Debug, Clone, Copy)]
pub struct ServerOptions {
    pub max_payload: u64,
    pub close_timeout: Duration,
}

impl ServerOptions {
    pub fn new(max_payload: u64) -> Self {
        Self { max_payload, close_timeout: CLOSE_TIMEOUT }
    }
}

/// Why `handle_upgrade` gave no socket. In every case the connection was ended and dropped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refused {
    /// The request was refused with this status, answered as `abortHandshake` does.
    Status(u16),
    /// The transport failed while the answer was written.
    Io,
}

const RUNNING: u8 = 0;
const CLOSING: u8 = 1;

struct Shared {
    state: AtomicU8,
    next_id: AtomicU64,
    clients: Mutex<HashMap<u64, WebSocket>>,
    count: watch::Sender<usize>,
}

/// `WebSocketServer({ noServer: true, maxPayload, perMessageDeflate: false })`.
pub struct WebSocketServer {
    options: ServerOptions,
    shared: Arc<Shared>,
}

impl WebSocketServer {
    pub fn new(options: ServerOptions) -> Self {
        let (count, _) = watch::channel(0);
        Self { options, shared: Arc::new(Shared { state: AtomicU8::new(RUNNING), next_id: AtomicU64::new(0), clients: Mutex::new(HashMap::new()), count }) }
    }

    /// `handleUpgrade`: refuse the request or answer it with 101 and return the open socket. Reading the connection starts
    /// when the first event is taken from [`WsEvents`], so what the caller installs right after this returns (the raw tap)
    /// sees every byte, `head` included.
    pub async fn handle_upgrade<S: Transport>(&self, request: &HandshakeRequest, mut io: S, head: Bytes) -> Result<(WebSocket, WsEvents), Refused> {
        let accepted = match handshake::validate(request) {
            Ok(accepted) => accepted,
            Err(refusal) => {
                return abort_handshake(io, refusal.status, Some(refusal.message), &refusal.headers).await;
            }
        };
        if self.shared.state.load(Ordering::SeqCst) != RUNNING {
            return abort_handshake(io, 503, None, &[]).await;
        }
        let answer = handshake::accept_bytes(&accepted.key, accepted.protocol.as_deref());
        if io.write_all(&answer).await.is_err() || io.flush().await.is_err() {
            return Err(Refused::Io);
        }
        let id = self.shared.next_id.fetch_add(1, Ordering::SeqCst);
        let shared = Arc::clone(&self.shared);
        let config = socket::SocketConfig { max_payload: self.options.max_payload, close_timeout: self.options.close_timeout, auto_pong: true };
        let on_close = Box::new(move || {
            let mut clients = lock(&shared.clients);
            clients.remove(&id);
            let left = clients.len();
            drop(clients);
            shared.count.send_replace(left);
        });
        let (socket, events) = socket::spawn(io, head, &config, on_close);
        {
            let mut clients = lock(&self.shared.clients);
            clients.insert(id, socket.clone());
            // A socket that closed before it was listed has already run its removal: list nothing.
            if socket.ready_state() == ReadyState::Closed {
                clients.remove(&id);
            }
            let total = clients.len();
            drop(clients);
            self.shared.count.send_replace(total);
        }
        Ok((socket, events))
    }

    /// `wss.clients`: the sockets not yet closed.
    pub fn clients(&self) -> Vec<WebSocket> {
        lock(&self.shared.clients).values().cloned().collect()
    }

    /// `wss.close()`: refuse new upgrades with 503 and wait until every socket has closed.
    pub async fn close(&self) {
        self.shared.state.store(CLOSING, Ordering::SeqCst);
        let mut count = self.shared.count.subscribe();
        let _ = count.wait_for(|clients| *clients == 0).await;
    }
}

/// `abortHandshake`: the refusal, then end the connection (and destroy it once the end is written).
async fn abort_handshake<S: Transport>(mut io: S, status: u16, message: Option<&str>, headers: &[(&str, &str)]) -> Result<(WebSocket, WsEvents), Refused> {
    let bytes = handshake::refusal_bytes(status, message, headers);
    let _ = io.write_all(&bytes).await;
    let _ = io.shutdown().await;
    Err(Refused::Status(status))
}
