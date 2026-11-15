//! Ingress metering and admission of a leg, over the raw byte stream of its socket (`trackLegIngress`, `admitIngress`,
//! `noteIngressDelivery`, `releaseIngressLeg` of `lib/relay-transport.mjs` and the ingress branches of `sweepLegs`).
//!
//! The parser assembles a whole message (up to `maxPayload`) per leg before any handler sees it, so N authenticated legs are
//! N x `maxPayload` of heap that no later decision can bound. Ingress is therefore metered on the RAW stream, while the frame is
//! still on the wire: [`install`](IngressLeg::install) puts a [`RawTap`] on the socket that reads the WebSocket framing
//! ([`meter`]), so the size of a message is known from its header before its bytes arrive.
//!
//! - A leg reads freely inside a window ([`INGRESS_FREE_WINDOW_BYTES`]); a larger message takes a reservation of the leg's worst
//!   case (the transport ceiling) out of one box pool ([`pool`]).
//! - With no room the leg is PARKED (its reads paused through [`Holder::Ingress`]) in FIFO order, never cut: waiting for room is
//!   not misbehaviour. The wait is bounded by [`IngressLeg::sweep`], and a parked leg is never ping-swept.
//! - A message past the transport size is refused while it is still arriving, once per message, attributed from the first
//!   [`policy::OVERSIZE_ID_SCAN_BYTES`] unmasked bytes through [`policy`](super::policy). Whether a message was refused travels with it:
//!   the delivery path asks [`IngressLeg::note_delivery`] and never refuses the same message twice.
//!
//! What the sockets code (the legs, the hook leg, the server's sweep) must do:
//! - build one [`IngressPool`] for the process and call [`IngressLeg::install`] right after the upgrade, before the first
//!   `WsEvents::next`, so the tap sees the leftover bytes first;
//! - call [`IngressLeg::note_delivery`] for every `WsEvent::Message` (it returns whether the message was already refused: pass
//!   that as `announced` to [`policy::check_oversize`](super::policy::check_oversize));
//! - call [`IngressLeg::release`] when the socket closes (it hands the reservation back, wakes the next waiter and lets go of the
//!   socket handle the leg keeps) and from the sweep before it closes a leg;
//! - call [`IngressLeg::sweep`] for each socket in the heartbeat sweep and skip the ping sweep unless it answers
//!   [`Sweep::Clear`].

mod meter;
mod pool;

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use mixdog_rt::time::Instant;

use self::meter::{MeterEvents, WireMeter};
pub use self::pool::{Admit, AdmitQuery, IngressPool, admit_ingress};
#[cfg(any(test, feature = "test-support"))]
pub use self::pool::IngressStats;
use super::policy::{
    self, INGRESS_FREE_WINDOW_BYTES, INGRESS_RESERVATION_BYTES, MAX_FRAME_BYTES, MAX_INGRESS_BYTES, MAX_WS_PAYLOAD_BYTES,
};
use crate::close_codes::{RELAY_BUSY, RELAY_BUSY_REASON, SLOW_PEER, SLOW_PRODUCER_REASON};
use crate::ws::{Gate, Holder, RawTap, WebSocket};

/// A holder that stops making progress pins box memory for a peer that went quiet mid-frame: it is cut after this.
pub const INGRESS_STALL_TIMEOUT: Duration = Duration::from_secs(30);
/// A parked leg cannot answer a ping while it is not read, so its wait is what the sweep bounds.
pub const INGRESS_WAIT_TIMEOUT: Duration = Duration::from_secs(60);
/// The limit on a hook leg's frames (`MAX_HOOK_BODY_BYTES` of `relay-hook.mjs`).
pub const HOOK_FRAME_LIMIT_BYTES: usize = 1024 * 1024;
/// "Was this message already refused" is a property of the MESSAGE: several can arrive in one read, so the answers queue up in
/// delivery order. The cap only bounds an absurd backlog.
const MAX_ANNOUNCED_QUEUE: usize = 256;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// What a leg is, which decides who is told about a refused message and with what.
#[derive(Clone)]
pub enum LegKind {
    /// The desktop leg: the refusal is a `frame-too-large` notice naming the client whose call produced the frame, when its own
    /// router would have delivered it to that client. The ceiling quoted is [`IngressLimits::limit`].
    Desktop,
    /// A phone leg: the refusal rides the cleartext `resync` key. `limit_for(binary)` is the stable ceiling of this path in the
    /// wire form of the message (`oversizeLimitFor`).
    Phone { limit_for: Arc<dyn Fn(bool) -> usize + Send + Sync> },
    /// A hook leg: metered and admitted like the others, but nobody is told about a refused message.
    Hook,
}

/// The numbers of one leg's metering (the `legIngress` options of the server plus the leg's own limit).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IngressLimits {
    /// The box pool this leg's reservation is charged against.
    pub ceiling: usize,
    /// This leg's worst case: what one reservation charges.
    pub reservation: usize,
    /// How much a leg reads before it needs a reservation.
    pub window: usize,
    /// The application ceiling a refusal quotes (`maxFrameBytes`; a hook leg's own).
    pub limit: usize,
    /// The size past which the transport gives up on a message (`maxPayload`): the point of an early refusal.
    pub transport: usize,
}

impl Default for IngressLimits {
    fn default() -> Self {
        Self::with_limit(MAX_FRAME_BYTES)
    }
}

impl IngressLimits {
    /// The defaults of the relay, with the application ceiling of this leg.
    pub fn with_limit(limit: usize) -> Self {
        Self {
            ceiling: MAX_INGRESS_BYTES,
            reservation: INGRESS_RESERVATION_BYTES,
            window: INGRESS_FREE_WINDOW_BYTES,
            limit,
            transport: MAX_WS_PAYLOAD_BYTES,
        }
    }

    /// A hook leg's: its 1 MiB limit, through the same pool.
    pub fn hook() -> Self {
        Self::with_limit(HOOK_FRAME_LIMIT_BYTES)
    }
}

/// What the heartbeat sweep must do with a leg after its ingress branches.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sweep {
    /// The leg held a reservation without progress for [`INGRESS_STALL_TIMEOUT`] (closed 4008 "slow producer"), or waited for one
    /// for [`INGRESS_WAIT_TIMEOUT`] (closed 4009 "relay busy"): it was released and closed here; the sweep moves on.
    Closed,
    /// The leg is parked for admission and is not being read: it must not be ping-swept (that would turn backpressure into a
    /// disconnect). The sweep moves on.
    Parked,
    /// Nothing ingress-related: the rest of the sweep (the ping window) applies.
    Clear,
}

struct LegShared {
    pool: IngressPool,
    kind: LegKind,
    limits: IngressLimits,
    gate: Gate,
    /// The socket, for what ingress itself says on it (refusals, the closes of the sweep) and for "is it open". Let go of by
    /// [`IngressLeg::release`], which breaks the cycle through the socket's own tap.
    socket: Mutex<Option<WebSocket>>,
    /// One entry per message that completed on the wire, in delivery order.
    announced: Mutex<VecDeque<bool>>,
    holding: AtomicBool,
    waiting: AtomicBool,
    progress_ms: AtomicU64,
    waiting_since_ms: AtomicU64,
}

impl LegShared {
    fn socket(&self) -> Option<WebSocket> {
        lock(&self.socket).clone()
    }

    fn is_open(&self) -> bool {
        lock(&self.socket).as_ref().is_some_and(WebSocket::is_open)
    }

    fn touch(&self) {
        self.progress_ms.store(self.pool.now_ms(), Ordering::SeqCst);
    }

    /// `evaluateLegIngress`: the decision for the message now declared.
    fn evaluate(self: &Arc<Self>, pending: u64) {
        if !self.is_open() {
            return;
        }
        let now = self.pool.now_ms();
        let mut pool = self.pool.lock();
        let decision = admit_ingress(&AdmitQuery {
            pending: usize::try_from(pending).unwrap_or(usize::MAX),
            holding: self.holding.load(Ordering::SeqCst),
            window: self.limits.window,
            reservation: self.limits.reservation,
            reserved: pool.reserved,
            ceiling: self.limits.ceiling,
        });
        match decision {
            Admit::Read => self.progress_ms.store(now, Ordering::SeqCst),
            Admit::Reserve => pool.take_reservation(self, now),
            Admit::Wait => pool.park(self, now),
        }
    }

    /// `oversizeSignal`: tell the peer a message was refused. `raw` is the frame, or the head of it when the refusal was decided
    /// while it was still arriving.
    fn signal(&self, bytes: usize, limit: usize, raw: &[u8], binary: bool) {
        let notice = match self.kind {
            LegKind::Desktop => policy::desktop_oversize_notice(bytes, limit, raw, binary),
            LegKind::Phone { .. } => policy::phone_oversize_notice(bytes, limit),
            LegKind::Hook => return,
        };
        if let Some(socket) = self.socket() {
            socket.send_text(notice, None);
        }
    }
}

/// The events of the meter, applied to one leg.
struct LegEvents<'a> {
    leg: &'a Arc<LegShared>,
}

impl MeterEvents for LegEvents<'_> {
    fn declared(&mut self, pending: u64) {
        self.leg.evaluate(pending);
    }

    fn refused(&mut self, bytes: u64, head: Option<&[u8]>, binary: bool) {
        // Quote the ceiling this leg would enforce for a message of THIS wire form, so every refusal a client sees names the same
        // number it can keep.
        let limit = match &self.leg.kind {
            LegKind::Phone { limit_for } => limit_for(binary),
            LegKind::Desktop | LegKind::Hook => self.leg.limits.limit,
        };
        self.leg.signal(usize::try_from(bytes).unwrap_or(usize::MAX), limit, head.unwrap_or(&[]), binary);
    }

    fn completed(&mut self, announced: bool) {
        let mut queue = lock(&self.leg.announced);
        queue.push_back(announced);
        if queue.len() > MAX_ANNOUNCED_QUEUE {
            queue.pop_front();
        }
    }

    fn progress(&mut self) {
        self.leg.touch();
    }
}

struct IngressTap {
    leg: Arc<LegShared>,
    meter: WireMeter,
}

impl RawTap for IngressTap {
    fn chunk(&mut self, bytes: &[u8], _gate: &Gate) {
        if bytes.is_empty() {
            return;
        }
        let mut events = LegEvents { leg: &self.leg };
        self.meter.feed(bytes, &mut events);
    }
}

/// The ingress state of one leg: a handle the sockets code keeps next to the socket.
#[derive(Clone)]
pub struct IngressLeg {
    shared: Arc<LegShared>,
}

impl IngressLeg {
    /// `trackLegIngress`: meter `socket` from now on. Call it before the first event is taken from the socket's `WsEvents`.
    pub fn install(pool: &IngressPool, socket: &WebSocket, kind: LegKind, limits: IngressLimits) -> Self {
        let shared = Arc::new(LegShared {
            pool: pool.clone(),
            kind,
            limits,
            gate: socket.gate().clone(),
            socket: Mutex::new(Some(socket.clone())),
            announced: Mutex::new(VecDeque::new()),
            holding: AtomicBool::new(false),
            waiting: AtomicBool::new(false),
            progress_ms: AtomicU64::new(pool.now_ms()),
            waiting_since_ms: AtomicU64::new(0),
        });
        let transport = u64::try_from(limits.transport).unwrap_or(u64::MAX);
        socket.set_raw_tap(Box::new(IngressTap { leg: Arc::clone(&shared), meter: WireMeter::new(transport) }));
        Self { shared }
    }

    /// `noteIngressDelivery`: the parser delivered a message, so this leg's reservation goes back (the wire meter has already
    /// retired the bytes). Returns whether THIS message was already refused while it was arriving: one queued answer per
    /// completed message, taken in delivery order, so the delivery path never sends a second notice for it.
    pub fn note_delivery(&self) -> bool {
        let shared = &self.shared;
        let now = shared.pool.now_ms();
        shared.progress_ms.store(now, Ordering::SeqCst);
        shared.pool.lock().release_reservation(shared, now);
        lock(&shared.announced).pop_front().unwrap_or(false)
    }

    /// `releaseIngressLeg`: a leg that goes away (or is cut) hands its slice of the pool back, and the next waiter takes it.
    /// Safe to call again. Also lets go of the socket handle, so the socket and its tap can be freed.
    pub fn release(&self) {
        let shared = &self.shared;
        let now = shared.pool.now_ms();
        {
            let mut pool = shared.pool.lock();
            if shared.waiting.swap(false, Ordering::SeqCst) {
                pool.remove_waiting(shared);
            }
            shared.gate.release(Holder::Ingress);
            pool.release_reservation(shared, now);
        }
        drop(lock(&shared.socket).take());
    }

    /// The ingress branches of `sweepLegs`, at `now`.
    pub fn sweep(&self, now: Instant) -> Sweep {
        let shared = &self.shared;
        let now_ms = shared.pool.ms_at(now);
        let stalled = shared.holding.load(Ordering::SeqCst)
            && now_ms.saturating_sub(shared.progress_ms.load(Ordering::SeqCst)) > millis(INGRESS_STALL_TIMEOUT);
        if stalled {
            self.cut(SLOW_PEER, SLOW_PRODUCER_REASON);
            return Sweep::Closed;
        }
        if shared.waiting.load(Ordering::SeqCst) {
            if now_ms.saturating_sub(shared.waiting_since_ms.load(Ordering::SeqCst)) > millis(INGRESS_WAIT_TIMEOUT) {
                self.cut(RELAY_BUSY, RELAY_BUSY_REASON);
                return Sweep::Closed;
            }
            return Sweep::Parked;
        }
        Sweep::Clear
    }

    fn cut(&self, code: u16, reason: &str) {
        let socket = self.shared.socket();
        self.release();
        if let Some(socket) = socket {
            // Already gone is not an error here.
            let _ = socket.close(code, reason);
        }
    }

    /// `socket.oversizeSignal`: refuse a message the delivery path found past its limit (it was not refused while arriving).
    /// `raw` is the frame; `binary` its wire form. A hook leg says nothing.
    pub fn signal_oversize(&self, bytes: usize, limit: usize, raw: &[u8], binary: bool) {
        self.shared.signal(bytes, limit, raw, binary);
    }

    /// Whether this leg holds a reservation.
    pub fn is_holding(&self) -> bool {
        self.shared.holding.load(Ordering::SeqCst)
    }

    /// Whether this leg is parked for admission.
    pub fn is_waiting(&self) -> bool {
        self.shared.waiting.load(Ordering::SeqCst)
    }
}

fn millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}
