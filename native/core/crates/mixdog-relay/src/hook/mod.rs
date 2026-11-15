//! The webhook tunnel (`lib/relay-hook.mjs`): public webhook forwarding that replaces per-user ngrok tunnels. The channel
//! worker keeps one outbound `/hookleg` WebSocket ([`HookHub::run_leg`]) and the relay replays the inbound
//! `/hook/<deviceId>/...` HTTP requests ([`HookHub::handle_request`]) over it as JSON frames. Payloads pass through
//! un-inspected; the HMAC check stays on the agent.
//!
//! One [`HookHub`] per process holds the live legs (`liveHooks`) and the caller limiter (`hookLimiter`). What the router and
//! the upgrade code of `server` must do:
//! - route every request whose target starts with `/hook/` to [`HookHub::handle_request`] (it answers the whole request);
//! - on `/hookleg`, authenticate the device exactly as for `/desktop`, upgrade, and run [`HookHub::run_leg`] on a task with
//!   the socket and its events: it meters the leg (1 MiB frames, through the process's [`IngressPool`]) and returns when the
//!   socket has closed;
//! - sweep each socket of [`HookHub::legs`] like the other legs (ingress branches first, then the ping window: see
//!   [`HookLeg`]);
//! - on close, call [`HookHub::fail_pending_and_clear`].

mod http;
mod leg;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use tokio::sync::oneshot;

pub use self::leg::{BodyRejected, MAX_HOOK_RESPONSE_BODY_BYTES, decode_response_body};
use crate::legs::ingress::{IngressLeg, IngressLimits, IngressPool};
use crate::rate_limit::RateLimiter;
use crate::ws::WebSocket;

/// `MAX_HOOK_BODY_BYTES`: the most a webhook body, and a frame of the agent, may carry.
pub const MAX_HOOK_BODY_BYTES: usize = 1024 * 1024;
/// `HOOK_TIMEOUT_MS`: how long an inbound request waits for the agent's answer.
pub const HOOK_TIMEOUT: Duration = Duration::from_secs(30);
/// `MAX_HOOK_PENDING_PER_DEVICE`: requests parked or still arriving per agent leg.
pub const MAX_HOOK_PENDING_PER_DEVICE: usize = 64;
/// `HOOK_SOCKET_BUFFER_LIMIT_BYTES`: what the relay will buffer toward one agent leg.
pub const HOOK_SOCKET_BUFFER_LIMIT_BYTES: usize = 4 * 1024 * 1024;
/// `HOOK_RATE_LIMIT` and `HOOK_RATE_WINDOW_MS`: calls per device id and per address in one window.
pub const HOOK_RATE_LIMIT: usize = 120;
pub const HOOK_RATE_WINDOW_MS: i64 = 60_000;

/// The options `startRelay` gives the tunnel (`maxHookPending`) and the answer timeout.
#[derive(Debug, Clone, Copy)]
pub struct HookOptions {
    pub max_pending: usize,
    pub timeout: Duration,
    /// The metering numbers of a leg (the `legIngress` options of the server with the hook leg's own 1 MiB limit).
    pub ingress: IngressLimits,
}

impl Default for HookOptions {
    fn default() -> Self {
        Self { max_pending: MAX_HOOK_PENDING_PER_DEVICE, timeout: HOOK_TIMEOUT, ingress: IngressLimits::hook() }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// What settles a parked request.
pub(crate) enum Answer {
    /// The agent's `http-response`: a status 100 to 599, a content type and the decoded body.
    Reply { status: u16, content_type: String, body: Vec<u8> },
    /// A relay-made 502 with this error code.
    Failed(&'static str),
}

#[derive(Default)]
struct EntryState {
    /// Requests forwarded and not yet answered.
    pending: HashMap<String, oneshot::Sender<Answer>>,
    /// Requests admitted whose body is still arriving.
    inflight: usize,
}

/// One live agent leg (`{ socket, pending, inflight }` of `liveHooks`).
pub(crate) struct HookEntry {
    socket: WebSocket,
    state: Mutex<EntryState>,
    alive: AtomicBool,
    ingress: IngressLeg,
}

/// A place for a body that is still arriving; given back when it is dropped, however the request ends.
pub(crate) struct Slot {
    entry: Arc<HookEntry>,
    released: bool,
}

impl Drop for Slot {
    fn drop(&mut self) {
        if !self.released {
            let mut state = lock(&self.entry.state);
            state.inflight = state.inflight.saturating_sub(1);
        }
    }
}

impl HookEntry {
    /// Takes a place for a body when the leg holds fewer than `max_pending` requests (parked and arriving together) and the
    /// relay has not buffered more than the limit toward it; `None` is "agent busy".
    fn admit(self: &Arc<Self>, max_pending: usize) -> Option<Slot> {
        let mut state = lock(&self.state);
        if state.pending.len() + state.inflight >= max_pending || self.socket.buffered_amount() > HOOK_SOCKET_BUFFER_LIMIT_BYTES {
            return None;
        }
        state.inflight += 1;
        Some(Slot { entry: Arc::clone(self), released: false })
    }

    /// The reservation becomes a `pending` entry in one step, so the two counters never count the same request twice.
    fn park(&self, mut slot: Slot, id: &str) -> oneshot::Receiver<Answer> {
        let (tx, rx) = oneshot::channel();
        let mut state = lock(&self.state);
        state.pending.insert(id.to_owned(), tx);
        state.inflight = state.inflight.saturating_sub(1);
        slot.released = true;
        drop(state);
        rx
    }

    /// Takes a parked request out of the table: whoever gets it is the one to answer it.
    fn take(&self, id: &str) -> Option<oneshot::Sender<Answer>> {
        lock(&self.state).pending.remove(id)
    }

    /// `failHookPending`: every parked request is answered 502 `agent disconnected`.
    fn fail_pending(&self) {
        let parked: Vec<_> = lock(&self.state).pending.drain().collect();
        for (_, sender) in parked {
            let _ = sender.send(Answer::Failed("agent disconnected"));
        }
    }
}

/// A live hook leg as the heartbeat sweep sees it (`socket.isAlive`, `socket.ingress`).
#[derive(Clone)]
pub struct HookLeg {
    entry: Arc<HookEntry>,
}

impl HookLeg {
    pub fn socket(&self) -> &WebSocket {
        &self.entry.socket
    }

    /// The ingress metering of the leg: the sweep asks it first (`IngressLeg::sweep`) and goes on to the ping window only on
    /// `Sweep::Clear`.
    pub fn ingress(&self) -> &IngressLeg {
        &self.entry.ingress
    }

    /// `socket.isAlive`: set by a pong and by every message of the agent.
    pub fn is_alive(&self) -> bool {
        self.entry.alive.load(Ordering::SeqCst)
    }

    /// The sweep clears it before it pings.
    pub fn set_alive(&self, alive: bool) {
        self.entry.alive.store(alive, Ordering::SeqCst);
    }
}

/// `liveHooks`, the caller limiter and the numbers of the tunnel.
pub struct HookHub {
    legs: Mutex<HashMap<String, Arc<HookEntry>>>,
    limiter: Mutex<RateLimiter>,
    pool: IngressPool,
    options: HookOptions,
}

impl HookHub {
    /// `pool` is the process's ingress pool, the one every leg is metered against.
    pub fn new(pool: IngressPool, options: HookOptions) -> Arc<Self> {
        Arc::new(Self {
            legs: Mutex::new(HashMap::new()),
            limiter: Mutex::new(RateLimiter::new(HOOK_RATE_LIMIT, HOOK_RATE_WINDOW_MS)),
            pool,
            options,
        })
    }

    /// The live legs, for the sweep.
    pub fn legs(&self) -> Vec<HookLeg> {
        lock(&self.legs).values().map(|entry| HookLeg { entry: Arc::clone(entry) }).collect()
    }

    /// What `closeRelay` does with the tunnel: every parked request fails 502 and the table is emptied. The sockets are
    /// terminated by the server with the others.
    pub fn fail_pending_and_clear(&self) {
        let entries: Vec<_> = lock(&self.legs).drain().map(|(_, entry)| entry).collect();
        for entry in entries {
            entry.fail_pending();
        }
    }

    fn live(&self, device_id: &str) -> Option<Arc<HookEntry>> {
        lock(&self.legs).get(device_id).filter(|entry| entry.socket.is_open()).cloned()
    }

    fn allow(&self, key: &str) -> bool {
        lock(&self.limiter).allow(key)
    }
}
