//! The WebSocket pool of the OpenAI routes (`openai-ws-pool.mjs`): sockets are
//! kept per session between responses so the next request can continue on the
//! socket that holds the previous response (`previous_response_id` delta
//! frames), and the per-session transport switch to HTTP/SSE.
//!
//! One response runs on a socket at a time: a socket is checked out for the
//! response and parked again with its [`Chain`] when the response completed.
//! A socket that failed, was abandoned or was opened beyond the per-session
//! cap is dropped, and the session's next attempt opens a fresh one.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;

use sha2::Digest;
use sha2::Sha256;

use super::delta::Chain;
use crate::transport::WsSocket;

/// `MAX_POOLED_SOCKETS_PER_KEY`: a session's sockets, in use or parked; a
/// further one is opened for its response only.
pub const MAX_SOCKETS_PER_KEY: usize = 8;

/// What a parked socket was opened for: a socket serves only the same
/// credential and prompt-cache lane.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Compat {
    pub auth: String,
    pub cache_key: String,
}

impl Compat {
    /// The credential is compared by its hash, the account id when there is one
    /// so a token refresh keeps the connection.
    pub fn new(route: &str, identity: &str, cache_key: &str) -> Self {
        let digest = Sha256::digest(format!("{route}\0{identity}").as_bytes());
        Self { auth: digest.iter().map(|b| format!("{b:02x}")).collect(), cache_key: cache_key.to_owned() }
    }
}

struct Parked {
    socket: Box<dyn WsSocket>,
    owner: u64,
    chain: Chain,
    compat: Compat,
    released: u64,
}

/// What hears that a session's socket closed (`_onEntryClosed`: `retireCodexTurnStateOwner(poolKey, entry)`), and
/// that a session's sockets were all closed (`clearCodexTurnStateScope`).
pub trait SocketEvents: Send + Sync {
    fn closed(&self, key: &str, owner: u64);
    fn session_closed(&self, key: &str);
}

#[derive(Default)]
struct State {
    idle: HashMap<String, Vec<Parked>>,
    leased: HashMap<String, usize>,
    released: u64,
    /// Sessions whose next attempt must open a new socket.
    fresh: HashSet<String>,
    /// Sessions on HTTP/SSE for good.
    http: HashSet<String>,
    /// Consecutive failed WebSocket exchanges per session, and whether the
    /// last was one a transport switch answers.
    failures: HashMap<String, (u32, bool)>,
}

#[derive(Default)]
pub struct WsPool {
    state: Mutex<State>,
    /// Numbers the sockets, so a turn's state knows the connection that owns it.
    sockets: std::sync::atomic::AtomicU64,
    events: Option<Arc<dyn SocketEvents>>,
}

/// A socket checked out for one response.
pub struct Checkout {
    pool: Arc<WsPool>,
    key: String,
    compat: Compat,
    /// Whether the socket returns to the pool.
    pooled: bool,
    /// Sessionless sockets are shared: they start with no chain.
    shared: bool,
    pub socket: Option<Box<dyn WsSocket>>,
    /// The socket's number ([`WsPool::number`]), set with the socket.
    pub owner: u64,
    pub chain: Chain,
}

impl WsPool {
    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// A pool whose socket closings are reported to `events`.
    pub fn with_events(events: Arc<dyn SocketEvents>) -> Self {
        Self { events: Some(events), ..Self::default() }
    }

    /// The number of a socket just opened.
    pub fn number(&self) -> u64 {
        self.sockets.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1
    }

    /// The socket `owner` of `key` is closed (dropped).
    fn closed(&self, key: &str, owner: u64) {
        if let Some(events) = &self.events {
            events.closed(key, owner);
        }
    }

    /// Checks out a socket for `key` when a compatible parked one is alive,
    /// else an empty checkout the caller dials into. A retry after a failure
    /// (or `force_fresh`) never reuses a parked socket and is not parked.
    pub fn checkout(self: &Arc<Self>, key: &str, compat: &Compat, shared: bool, force_fresh: bool) -> Checkout {
        let mut state = self.state();
        let fresh = state.fresh.remove(key) || force_fresh;
        let mut closed = Vec::new();
        if let Some(parked) = state.idle.get_mut(key) {
            // Idle sockets of another credential or lane, dead ones and ones at
            // the provider's connection age limit are closed here.
            let (kept, gone): (Vec<Parked>, Vec<Parked>) = std::mem::take(parked).into_iter().partition(|p| {
                p.compat == *compat
                    && matches!(p.socket.link().liveness(), mixdog_core_api::domain::keepalive::LinkLiveness::Alive)
                    && p.socket.link().may_start_response()
            });
            *parked = kept;
            closed = gone;
        }
        let reused = if fresh {
            None
        } else {
            let idle = state.idle.entry(key.to_owned()).or_default();
            idle.iter().enumerate().max_by_key(|(_, p)| p.released).map(|(i, _)| i).map(|i| idle.swap_remove(i))
        };
        let parked_count = state.idle.get(key).map_or(0, Vec::len);
        let leased = state.leased.get(key).copied().unwrap_or(0);
        let pooled = !fresh && parked_count + leased < MAX_SOCKETS_PER_KEY;
        *state.leased.entry(key.to_owned()).or_default() += 1;
        drop(state);
        for gone in closed {
            drop(gone.socket);
            self.closed(key, gone.owner);
        }
        let (socket, owner, chain) = match reused {
            Some(p) => (Some(p.socket), p.owner, if shared { Chain::default() } else { p.chain }),
            None => (None, 0, Chain::default()),
        };
        Checkout { pool: self.clone(), key: key.to_owned(), compat: compat.clone(), pooled, shared, socket, owner, chain }
    }

    pub fn http_active(&self, keys: &[&str]) -> bool {
        let state = self.state();
        keys.iter().any(|k| state.http.contains(*k))
    }

    pub fn mark_http(&self, key: &str) {
        self.state().http.insert(key.to_owned());
    }

    /// A WebSocket exchange of `key` failed; `switchable` when the failure is
    /// one a transport switch answers. Returns the consecutive failures.
    pub fn ws_failed(&self, key: &str, switchable: bool) -> u32 {
        let mut state = self.state();
        let entry = state.failures.entry(key.to_owned()).or_insert((0, false));
        entry.0 += 1;
        entry.1 = switchable;
        entry.0
    }

    pub fn ws_ok(&self, key: &str) {
        self.state().failures.remove(key);
    }

    /// Whether the session's WebSocket retry budget is spent by switchable
    /// failures, so its next attempt goes to HTTP/SSE.
    pub fn budget_spent(&self, key: &str, attempts: u32) -> bool {
        self.state().failures.get(key).is_some_and(|(n, switchable)| *switchable && *n + 1 >= attempts)
    }

    /// Drops a session's sockets and transport state (the session ended).
    pub fn release_session(&self, key: &str) {
        let gone = {
            let mut state = self.state();
            state.fresh.remove(key);
            state.http.remove(key);
            state.failures.remove(key);
            state.idle.remove(key)
        };
        drop(gone);
        if let Some(events) = &self.events {
            events.session_closed(key);
        }
    }

    #[cfg(test)]
    pub fn parked(&self, key: &str) -> usize {
        self.state().idle.get(key).map_or(0, Vec::len)
    }
}

impl Checkout {
    pub fn key(&self) -> &str {
        &self.key
    }

    /// The response completed: the socket keeps `chain` for the next request
    /// and goes back to the pool when it is poolable.
    pub fn finish(mut self, chain: Chain) {
        self.pool.state().failures.remove(&self.key);
        let Some(socket) = self.socket.take() else {
            return;
        };
        if !self.pooled {
            drop(socket);
            self.pool.closed(&self.key, self.owner);
            return;
        }
        let chain = if self.shared { Chain::default() } else { chain };
        let mut state = self.pool.state();
        state.released += 1;
        let released = state.released;
        state.idle.entry(self.key.clone()).or_default().push(Parked { socket, owner: self.owner, chain, compat: self.compat.clone(), released });
    }
}

impl Drop for Checkout {
    fn drop(&mut self) {
        {
            let mut state = self.pool.state();
            if let Some(n) = state.leased.get_mut(&self.key) {
                *n = n.saturating_sub(1);
                if *n == 0 {
                    state.leased.remove(&self.key);
                }
            }
            // A socket that did not finish its response is gone: whatever follows
            // opens its own.
            if self.socket.is_some() {
                state.fresh.insert(self.key.clone());
            }
        }
        if let Some(socket) = self.socket.take() {
            drop(socket);
            self.pool.closed(&self.key, self.owner);
        }
    }
}
