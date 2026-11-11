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
use crate::transport::ws::WsCloser;

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

/// A checkout's socket as the pool sees it while it is in use.
struct Lease {
    key: String,
    closer: Option<WsCloser>,
    /// Its scope was disposed while it was in use: it is closed, and never parked.
    revoked: bool,
}

#[derive(Default)]
struct State {
    idle: HashMap<String, Vec<Parked>>,
    leased: HashMap<String, usize>,
    /// The checkouts holding a socket, by checkout number.
    leases: HashMap<u64, Lease>,
    /// The checkout that owns each session's sockets (`_poolOwnerByKey`): one at a time; the next waits for it. A kept
    /// socket hands ownership back when it is parked, any other when it has actually closed.
    owners: HashMap<String, u64>,
    checkouts: u64,
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
    /// An owner let go of its session.
    owner_released: tokio::sync::Notify,
}

/// A socket checked out for one response.
pub struct Checkout {
    pool: Arc<WsPool>,
    /// This checkout's number: its lease, and its ownership of a session's sockets.
    id: u64,
    /// It owns its session's sockets and has not handed that on.
    owns: bool,
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

    /// The socket `owner` of `key` has closed (`_onEntryClosed`): its turn state's ownership is retired, and the
    /// checkout `claim` that still owned the session, if any, lets go of it.
    fn closed(&self, key: &str, owner: u64, claim: Option<u64>) {
        if let Some(claim) = claim {
            self.release_owner(key, claim);
        }
        if let Some(events) = &self.events {
            events.closed(key, owner);
        }
    }

    /// `_releasePoolOwner`: `claim` lets go of `key`, unless another owns it by now.
    fn release_owner(&self, key: &str, claim: u64) {
        let mut state = self.state();
        if state.owners.get(key) == Some(&claim) {
            state.owners.remove(key);
            drop(state);
            self.owner_released.notify_waiters();
        }
    }

    /// Closes `socket` (with `close`, else by dropping it) and reports it closed once it has actually closed, as Node's
    /// `close` handler runs (`_onEntryClosed`), not when it was let go of.
    fn retire(self: &Arc<Self>, key: &str, owner: u64, claim: Option<u64>, socket: Box<dyn WsSocket>, close: Option<(u16, &str)>) {
        let closed = socket.closed();
        match close {
            Some((code, reason)) => socket.close(code, reason),
            None => drop(socket),
        }
        match closed {
            Some(mut closed) => {
                let (pool, key) = (self.clone(), key.to_owned());
                mixdog_rt::spawn("ai.openai.ws_closed", mixdog_rt::TaskClass::Work, async move {
                    let _ = closed.wait_for(|gone| *gone).await;
                    pool.closed(&key, owner, claim);
                });
            }
            None => self.closed(key, owner, claim),
        }
    }

    /// Checks out a socket for `key` when a compatible parked one is alive,
    /// else an empty checkout the caller dials into. A retry after a failure
    /// (or `force_fresh`) never reuses a parked socket and is not parked. A
    /// session's checkout waits until the one before it let go of the session
    /// (`_claimPoolOwner`); a sessionless one never waits.
    pub async fn checkout(self: &Arc<Self>, key: &str, compat: &Compat, shared: bool, force_fresh: bool) -> Checkout {
        let mut state = loop {
            let released = self.owner_released.notified();
            tokio::pin!(released);
            released.as_mut().enable();
            {
                let state = self.state();
                if shared || !state.owners.contains_key(key) {
                    break state;
                }
            }
            released.await;
        };
        state.checkouts += 1;
        let id = state.checkouts;
        if !shared {
            state.owners.insert(key.to_owned(), id);
        }
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
        if let Some(p) = &reused {
            state.leases.insert(id, Lease { key: key.to_owned(), closer: p.socket.closer(), revoked: false });
        }
        drop(state);
        for gone in closed {
            self.retire(key, gone.owner, None, gone.socket, None);
        }
        let (socket, owner, chain) = match reused {
            Some(p) => (Some(p.socket), p.owner, if shared { Chain::default() } else { p.chain }),
            None => (None, 0, Chain::default()),
        };
        Checkout { pool: self.clone(), id, owns: !shared, key: key.to_owned(), compat: compat.clone(), pooled, shared, socket, owner, chain }
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

    /// Closes a scope's sockets for good with `reason`, the ones in use too, and drops its transport state
    /// (`closeOpenaiWsPoolForSession`: `_clearPoolOwnerScope`, then `_shutdownEntry(entry, reason)`,
    /// `socket.close(1000, reason)`, for every pooled entry, busy or not, and every unpooled one). A socket in use goes
    /// on delivering what arrives until the server's close; its checkout never parks it.
    pub fn release_scope(self: &Arc<Self>, key: &str, reason: &str) {
        let (gone, in_use, released) = {
            let mut state = self.state();
            // `_clearPoolOwnerScope` first, and in the same hold as the scan below: a checkout still dialing has no lease
            // to revoke, and finds the session's ownership gone when its socket arrives (`attach`).
            let released = state.owners.remove(key).is_some();
            state.fresh.remove(key);
            state.http.remove(key);
            state.failures.remove(key);
            let in_use: Vec<WsCloser> = state.leases.values_mut().filter(|lease| lease.key == key).filter_map(|lease| {
                lease.revoked = true;
                lease.closer.clone()
            }).collect();
            (state.idle.remove(key), in_use, released)
        };
        if released {
            self.owner_released.notify_waiters();
        }
        for parked in gone.into_iter().flatten() {
            self.retire(key, parked.owner, None, parked.socket, Some((1000, reason)));
        }
        for closer in in_use {
            closer.close(1000, reason);
        }
        if let Some(events) = &self.events {
            events.session_closed(key);
        }
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

    /// The socket a dial opened for this checkout, numbered as the owner of its turn state. `false` when the session's
    /// ownership left this checkout while it dialed (its scope was disposed): the socket is closed with Node's code and
    /// reason and the checkout holds none (`_bindPoolOwner`: `socket.close(1000, 'pool_owner_changed')`, then throws).
    #[must_use]
    pub fn attach(&mut self, socket: Box<dyn WsSocket>) -> bool {
        self.owner = self.pool.number();
        let mut state = self.pool.state();
        if self.owns && state.owners.get(&self.key) != Some(&self.id) {
            drop(state);
            self.owns = false;
            self.pool.retire(&self.key, self.owner, None, socket, Some((1000, "pool_owner_changed")));
            return false;
        }
        state.leases.insert(self.id, Lease { key: self.key.clone(), closer: socket.closer(), revoked: false });
        drop(state);
        self.socket = Some(socket);
        true
    }

    /// The session's ownership this checkout holds, if it still holds it; it is handed on once.
    fn claim(&mut self) -> Option<u64> {
        std::mem::take(&mut self.owns).then_some(self.id)
    }

    /// Lets go of the socket for good: closed with `close` (or dropped), reported closed once it has, and the session's
    /// ownership handed on only then (`releaseWebSocket` with `keep: false` keeps the claim until the `close` event).
    fn retire_socket(&mut self, close: Option<(u16, &str)>) {
        let Some(socket) = self.socket.take() else { return };
        let revoked = self.pool.state().leases.remove(&self.id).is_some_and(|lease| lease.revoked);
        // A socket its scope's disposal closed already is not closed again (`ws` sends one close frame).
        let close = if revoked { None } else { close };
        let claim = self.claim();
        self.pool.retire(&self.key, self.owner, claim, socket, close);
    }

    /// The response was given up mid-stream: its socket is closed with `code` and `reason` (`socket-handlers.mjs`
    /// `onAbort`: `socket.close(4002, 'aborted')`) and never parked; the session's next attempt opens a fresh one.
    pub fn abandon(&mut self, code: u16, reason: &str) {
        if self.socket.is_none() {
            return;
        }
        self.pool.state().fresh.insert(self.key.clone());
        self.retire_socket(Some((code, reason)));
    }

    /// The response completed: the socket keeps `chain` for the next request and goes back to the pool when it is
    /// poolable, handing the session on; one that is not is let go of, and one whose scope was disposed meanwhile is
    /// already closing: it is never parked.
    pub fn finish(mut self, chain: Chain) {
        // One hold of the pool from the disposal check to the parking: a disposal lands before it (the socket is not
        // parked) or after it (the socket is parked, and the disposal closes it with the idle ones).
        let mut state = self.pool.state();
        state.failures.remove(&self.key);
        if self.socket.is_none() {
            return;
        }
        let revoked = state.leases.get(&self.id).is_some_and(|lease| lease.revoked);
        if !self.pooled || revoked {
            drop(state);
            self.retire_socket(None);
            return;
        }
        let socket = self.socket.take().expect("checked above");
        let chain = if self.shared { Chain::default() } else { chain };
        state.leases.remove(&self.id);
        state.released += 1;
        let released = state.released;
        state.idle.entry(self.key.clone()).or_default().push(Parked { socket, owner: self.owner, chain, compat: self.compat.clone(), released });
        drop(state);
        if let Some(claim) = self.claim() {
            self.pool.release_owner(&self.key, claim);
        }
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
        if self.socket.is_some() {
            // `releaseWebSocket({ keep: false })` after a failed exchange.
            self.retire_socket(Some((1000, "release_no_keep")));
        } else if let Some(claim) = self.claim() {
            // Nothing was held (the dial failed, or the socket went elsewhere): the session is free now.
            self.pool.release_owner(&self.key, claim);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tokio::io::AsyncReadExt;

    use super::*;
    use crate::transport::ws::WsConnection;

    const WITHIN: Duration = Duration::from_secs(20);

    // P2 (recheck): a scope disposed while one of its sockets is checked out closes that socket at once with Node's
    // code and reason (`closeOpenaiWsPoolForSession` shuts busy entries down too), the session is free for the next
    // checkout at once (`_clearPoolOwnerScope`), and the response finishing afterwards never parks the socket.
    #[tokio::test]
    async fn a_disposal_closes_a_socket_in_use_and_its_finish_never_parks_it() {
        mixdog_rt::testing::tokens();
        let (near, mut far) = tokio::io::duplex(1 << 12);
        let pool = Arc::new(WsPool::default());
        let compat = Compat::new("route", "identity", "cache");
        let mut held = pool.checkout("scope-a", &compat, false, false).await;
        assert!(held.attach(Box::new(WsConnection::client_over(near).await)));
        pool.release_scope("scope-a", "transport_scope_disposed");
        let mut head = [0u8; 6];
        mixdog_rt::time::timeout(WITHIN, far.read_exact(&mut head)).await.expect("a close frame within 20 s").unwrap();
        let reason = b"transport_scope_disposed";
        assert_eq!(head[..2], [0x88, 0x80 | (2 + reason.len() as u8)], "a masked close frame: {head:02x?}");
        let mut payload = vec![0u8; 2 + reason.len()];
        mixdog_rt::time::timeout(WITHIN, far.read_exact(&mut payload)).await.expect("the close payload within 20 s").unwrap();
        payload.iter_mut().enumerate().for_each(|(i, b)| *b ^= head[2 + i % 4]);
        assert_eq!(payload, [&[0x03, 0xe8][..], reason].concat(), "1000 transport_scope_disposed");
        let next = mixdog_rt::time::timeout(WITHIN, pool.checkout("scope-a", &compat, false, false)).await.expect("the session free at the disposal");
        drop(next);
        held.finish(Chain::default());
        assert_eq!(pool.parked("scope-a"), 0, "a socket its scope's disposal closed is never parked");
    }

    // A scope disposed while its checkout was still dialing: the socket the dial then brings is closed with Node's
    // code and reason and never held or parked (`_bindPoolOwner`), whether or not another checkout took the session.
    #[tokio::test]
    async fn a_socket_dialed_across_its_scopes_disposal_is_closed_and_not_held() {
        mixdog_rt::testing::tokens();
        let (near, mut far) = tokio::io::duplex(1 << 12);
        let pool = Arc::new(WsPool::default());
        let compat = Compat::new("route", "identity", "cache");
        let mut dialing = pool.checkout("scope-a", &compat, false, false).await;
        pool.release_scope("scope-a", "transport_scope_disposed");
        assert!(!dialing.attach(Box::new(WsConnection::client_over(near).await)), "the session's ownership left this checkout");
        assert!(dialing.socket.is_none());
        let mut head = [0u8; 6];
        mixdog_rt::time::timeout(WITHIN, far.read_exact(&mut head)).await.expect("a close frame within 20 s").unwrap();
        let reason = b"pool_owner_changed";
        assert_eq!(head[..2], [0x88, 0x80 | (2 + reason.len() as u8)], "a masked close frame: {head:02x?}");
        let mut payload = vec![0u8; 2 + reason.len()];
        mixdog_rt::time::timeout(WITHIN, far.read_exact(&mut payload)).await.expect("the close payload within 20 s").unwrap();
        payload.iter_mut().enumerate().for_each(|(i, b)| *b ^= head[2 + i % 4]);
        assert_eq!(payload, [&[0x03, 0xe8][..], reason].concat(), "1000 pool_owner_changed");
        dialing.finish(Chain::default());
        assert_eq!(pool.parked("scope-a"), 0);
        assert!(pool.state().leases.is_empty(), "no lease was taken for it");
    }
}
