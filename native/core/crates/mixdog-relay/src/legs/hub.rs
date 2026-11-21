//! The hub: every live desktop (`liveDesktops` of `server.mjs`), the phones attached to it, and the routing between them.
//!
//! All mutation of relay state happens in short sections under one relay-wide `std` mutex that is never held across an await, which
//! gives Node's run-to-completion atomicity: whatever one section reads, it still holds when it writes. Socket writes are
//! enqueues on the sockets' own queues (`ws`), so a section never waits for the network.
//!
//! A desktop entry outlives the desktop's connections: on a redial the previous entry is reused, so its phones stay attached and
//! are announced to the new leg ([`super::desktop`]). Everything about a receiver (its capacity, whether it takes text in the
//! binary envelope, what was last published to it) belongs to the CONNECTION and is discarded with it.
//!
//! The sockets code of the phone legs (`phone.rs`) and of the server calls [`Hub::attach_phone`], the [`PhoneHandle`] it returns,
//! and the read-only questions at the end of this file; the desktop leg is [`super::desktop`].

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use bytes::Bytes;
use mixdog_rt::TaskClass;
use mixdog_rt::time::{Instant, sleep_unrefed};
use serde_json::{Value, json};
use tokio::task::AbortHandle;

use super::dispatch::Dispatch;
use super::envelope;
use super::ingress::{IngressLeg, IngressLimits, IngressPool, LegKind};
use super::policy::{
    self, Admission, FrameQuery, InflightMeter, LegCharge, MAX_FRAME_BYTES, MAX_INFLIGHT_BYTES, MAX_UPLINK_CAPACITY_BYTES, Outbound, Oversize, PhoneLeg,
    Pressure, Release, SendFailed, UNDECLARED_CAPACITY_BYTES, UPLINK_QUEUE_LIMIT_BYTES, UplinkCeilings, UplinkLeg, UplinkPath, check_oversize, send_to_phone,
    uplink_ceilings,
};
use super::watchdog::{HandshakeTiming, Turn, Watch, WatchTarget, await_desktop_turn};
use crate::close_codes::DESKTOP_OFFLINE;
use crate::close_codes::DESKTOP_OFFLINE_REASON;
use crate::diagnostics::{DesktopSockets, PhoneSocket};
use crate::logline;
use crate::ws::{FlushCallback, Holder, WebSocket};
use crate::{js, store::DeviceStore};

/// How long phones stay parked at the relay after their desktop leg went before they are closed 4002 and the entry is dropped.
pub const OFFLINE_GRACE: Duration = Duration::from_secs(45);

/// What the legs code needs of a socket. A [`WebSocket`] is one; the tests of the legs hand in a scripted one.
pub trait LegSocket: Send + Sync + 'static {
    fn is_open(&self) -> bool;
    /// `bufferedAmount`: bytes handed to the socket and not yet taken by the transport.
    fn buffered_amount(&self) -> usize;
    /// Send a text message; `on_flushed` runs when it was written or could not be. It must not block and must not call back into
    /// the hub.
    fn send_text(&self, text: Bytes, on_flushed: Option<FlushCallback>);
    fn send_binary(&self, data: Bytes, on_flushed: Option<FlushCallback>);
    fn ping(&self);
    /// `close(code, reason)`; a close that cannot be sent (a reason over 123 bytes) is lost, as `closeQuietly` loses it.
    fn close(&self, code: u16, reason: &[u8]);
    fn terminate(&self);
    /// Stop reading the socket while the leg's own uplink backlog is outstanding (`legPausedUplink`), or read it again.
    fn hold_uplink(&self, hold: bool);
    /// Whether reads are held for backpressure by the uplink backlog or by ingress admission: a leg that cannot read cannot answer a
    /// ping, so the sweep gives it extra windows.
    fn read_held(&self) -> bool;
}

impl LegSocket for WebSocket {
    fn is_open(&self) -> bool {
        Self::is_open(self)
    }

    fn buffered_amount(&self) -> usize {
        Self::buffered_amount(self)
    }

    fn send_text(&self, text: Bytes, on_flushed: Option<FlushCallback>) {
        Self::send_text(self, text, on_flushed);
    }

    fn send_binary(&self, data: Bytes, on_flushed: Option<FlushCallback>) {
        Self::send_binary(self, data, on_flushed);
    }

    fn ping(&self) {
        // A ping that cannot be sent is surfaced as a close.
        let _ = Self::ping(self, Bytes::new(), None);
    }

    fn close(&self, code: u16, reason: &[u8]) {
        // Already gone, or a reason the frame cannot carry: nothing to do.
        let _ = Self::close(self, code, reason);
    }

    fn terminate(&self) {
        Self::terminate(self);
    }

    fn hold_uplink(&self, hold: bool) {
        if hold {
            self.gate().hold(Holder::Uplink);
        } else {
            self.gate().release(Holder::Uplink);
        }
    }

    fn read_held(&self) -> bool {
        self.gate().is_held(Holder::Uplink) || self.gate().is_held(Holder::Ingress)
    }
}

/// A socket the hub routes over.
pub type SocketRef = Arc<dyn LegSocket>;

/// What puts a leg's ingress meter on its socket: called by the hub with the kind of the leg once it knows it, because the limit a
/// phone's refusal quotes depends on the client id the hub hands out. `IngressLeg::install(&pool, &ws, kind, limits)` is the body.
pub type IngressInstall = Box<dyn FnOnce(LegKind) -> IngressLeg + Send>;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// `sendJson`: a JSON frame to a socket that is open; a socket that is not is told nothing.
pub fn send_json(socket: &dyn LegSocket, payload: &Value) {
    if socket.is_open() {
        socket.send_text(Bytes::from(js::wire(payload)), None);
    }
}

/// The numbers the hub is built with. Configuration enters the relay HERE and is normalised HERE, once: every later reader takes
/// these numbers, so no path can reach a raw option and no figure the relay publishes can differ from the one it enforces.
#[derive(Debug, Clone, Copy)]
pub struct HubConfig {
    /// The forwarding policy ceiling of one frame (`maxFrameBytes`).
    pub max_frame_bytes: usize,
    /// The most a desktop leg's declared capacity may be raised to (`uplinkCapacityBytes`); clamped to a usable capacity.
    pub uplink_capacity_ceiling: usize,
    /// The box-level ceiling a phone leg's sends are held to (`maxInflightBytes`).
    pub max_inflight_bytes: usize,
    pub handshake: HandshakeTiming,
    /// The numbers of every leg's ingress metering; `limit` is replaced by `max_frame_bytes` for the legs of the hub.
    pub ingress: IngressLimits,
}

impl Default for HubConfig {
    fn default() -> Self {
        Self {
            max_frame_bytes: MAX_FRAME_BYTES,
            uplink_capacity_ceiling: MAX_UPLINK_CAPACITY_BYTES,
            max_inflight_bytes: MAX_INFLIGHT_BYTES,
            handshake: HandshakeTiming::default(),
            ingress: IngressLimits::default(),
        }
    }
}

/// Whether a socket answered its last ping, and how many windows a leg that cannot answer has been given (`isAlive` and
/// `sweepGrace`). Written by the leg on every pong and every frame; read and reset by the sweep.
#[derive(Debug)]
pub struct Liveness {
    alive: AtomicBool,
    grace: AtomicU32,
}

impl Liveness {
    pub fn new() -> Arc<Self> {
        Arc::new(Self { alive: AtomicBool::new(true), grace: AtomicU32::new(0) })
    }

    /// The peer said something: a pong or a frame.
    pub fn mark(&self) {
        self.alive.store(true, Ordering::SeqCst);
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// The sweep opens a new window: the leg is presumed dead until it answers.
    pub fn start_window(&self) {
        self.alive.store(false, Ordering::SeqCst);
        self.grace.store(0, Ordering::SeqCst);
    }

    /// The sweep gave a draining leg one more window; returns how many it has had.
    pub fn bump_grace(&self) -> u32 {
        self.grace.fetch_add(1, Ordering::SeqCst) + 1
    }
}

/// One upgraded socket as the heartbeat sweep sees it (`wss.clients`).
#[derive(Clone)]
pub struct SweepLeg {
    pub socket: SocketRef,
    pub liveness: Arc<Liveness>,
    pub ingress: Option<IngressLeg>,
}

/// The stream of frames a proxied media request holds open at the desktop; the relay fails it when the leg goes.
pub trait MediaPending: Send {
    /// The desktop vanished mid-stream: end the response so the phone retries instead of hanging on an open socket.
    fn fail(self: Box<Self>);
}

/// `entry.media`: the media streams in flight over one desktop's leg, by request id.
#[derive(Default)]
pub struct MediaSlot {
    pending: HashMap<String, Box<dyn MediaPending>>,
}

impl MediaSlot {
    pub fn len(&self) -> usize {
        self.pending.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    pub fn contains(&self, id: &str) -> bool {
        self.pending.contains_key(id)
    }

    pub fn insert(&mut self, id: String, pending: Box<dyn MediaPending>) {
        self.pending.insert(id, pending);
    }

    pub fn remove(&mut self, id: &str) -> Option<Box<dyn MediaPending>> {
        self.pending.remove(id)
    }

    /// Everything in flight, leaving the slot empty: failed by the caller once it has left the hub's section.
    pub fn take_all(&mut self) -> Vec<Box<dyn MediaPending>> {
        std::mem::take(&mut self.pending).into_values().collect()
    }
}

/// One desktop connection: a socket and everything the relay knows about ITS receiver. Created with the socket, written only by
/// that socket's own leg, replaced by the next connection of the device. Nothing here is inherited from an earlier connection:
/// what a replacement leg has not declared is the floor, never the last leg's number.
pub(super) struct Conn {
    /// Distinguishes this connection from the ones before and after it: a leg that is no longer the live one is ignored.
    pub(super) generation: u64,
    pub(super) socket: SocketRef,
    /// What this socket holds in the box meter: the bytes of the phones' frames it has not flushed.
    pub(super) charge: Arc<LegCharge>,
    pub(super) uplink: UplinkLeg,
    /// The last time the leg said anything (a frame, a control frame or a pong).
    pub(super) heard: Option<Instant>,
}

pub(super) struct Entry {
    pub(super) conn: Conn,
    /// The phones attached to this desktop, in the order they attached (the order a fan-out visits them).
    pub(super) clients: Vec<Phone>,
    pub(super) media: MediaSlot,
    /// Whether the leg said it serves media; false until it says so (the media route degrades on the first request).
    pub(super) media_lane: bool,
    pub(super) pair_v2: bool,
    pub(super) host_name: Option<String>,
    pub(super) handshake: HandshakeTiming,
    pub(super) offline_timer: Option<AbortHandle>,
}

#[derive(Default)]
pub(super) struct HubState {
    pub(super) desktops: HashMap<String, Entry>,
    pub(super) next_generation: u64,
}

/// The state of a phone's uplink backlog, shared with the flush callbacks of the frames it sent: the phone stops being READ
/// while more than 2 MiB of its own frames are outstanding, and the stop lifts on that leg's own flush. The state is per leg, so
/// one slow phone never stalls a sibling or the shared desktop socket.
pub(super) struct UplinkFlow {
    socket: SocketRef,
    bytes: AtomicUsize,
    state: Mutex<FlowState>,
}

#[derive(Default)]
struct FlowState {
    paused: bool,
    timer: Option<AbortHandle>,
}

impl UplinkFlow {
    fn new(socket: SocketRef) -> Arc<Self> {
        Arc::new(Self { socket, bytes: AtomicUsize::new(0), state: Mutex::new(FlowState::default()) })
    }

    fn queued(&self) -> usize {
        self.bytes.load(Ordering::SeqCst)
    }

    fn add(&self, size: usize) {
        self.bytes.fetch_add(size, Ordering::SeqCst);
    }

    /// One of the phone's frames was flushed (or failed): lift the stop once the backlog is small again.
    fn settled(&self, size: usize) {
        let before = match self.bytes.try_update(Ordering::SeqCst, Ordering::SeqCst, |held| Some(held.saturating_sub(size))) {
            Ok(before) | Err(before) => before,
        };
        let left = before.saturating_sub(size);
        if !policy::uplink_pause_due(left) {
            self.resume();
        }
    }

    /// `pauseLeg`: stop reading this phone until its own frames flush. The safety net is a flush that never comes (the peer died
    /// mid-write).
    fn pause(self: &Arc<Self>) {
        let mut state = lock(&self.state);
        if state.paused {
            return;
        }
        state.paused = true;
        self.socket.hold_uplink(true);
        let flow = Arc::clone(self);
        let task = mixdog_rt::spawn("relay-uplink-resume", TaskClass::Control, async move {
            sleep_unrefed(policy::LEG_RESUME_TIMEOUT).await;
            flow.resume();
        });
        state.timer = Some(task.abort_handle());
    }

    fn resume(&self) {
        let mut state = lock(&self.state);
        if !state.paused {
            return;
        }
        state.paused = false;
        if let Some(timer) = state.timer.take() {
            timer.abort();
        }
        self.socket.hold_uplink(false);
    }

    /// The leg is gone: its safety timer goes with it.
    fn shutdown(&self) {
        if let Some(timer) = lock(&self.state).timer.take() {
            timer.abort();
        }
    }
}

/// What one phone's handle and its entry in the hub both hold.
pub(super) struct PhoneShared {
    pub(super) socket: SocketRef,
    pub(super) charge: Arc<LegCharge>,
    pub(super) liveness: Arc<Liveness>,
    pub(super) flow: Arc<UplinkFlow>,
    /// When the phone was last told the desktop is gone.
    gone_at: Mutex<Option<Instant>>,
    pub(super) ingress: Option<IngressLeg>,
    opened_at: Instant,
}

/// One phone leg in a desktop's entry.
pub(super) struct Phone {
    pub(super) id: String,
    pub(super) shared: Arc<PhoneShared>,
    /// The per-browser credential the relay authenticated when the leg upgraded: the desktop keys per-client trust on it, a phone
    /// cannot choose it.
    pub(super) browser_client_id: Option<String>,
    pub(super) attached: bool,
    /// The desktop rejected this phone: it is never announced or owed a handshake again.
    pub(super) closing: bool,
    resync_hinted: bool,
    inflight_ceiling: usize,
    pub(super) watch: Watch,
    /// The ceilings of the path this phone's frames take, recomputed when the live connection's declaration changes.
    ceiling_key: Option<(usize, bool)>,
    ceilings: UplinkCeilings,
}

/// The path a phone's next frame takes, read once from the connection it will be handed to: the ceilings that belong to THAT
/// connection's declaration, the envelope it travels in. Every decision about one message comes from this single snapshot, so a
/// redial between two of them can never measure a frame against one leg and deliver it to another.
struct Path {
    text_frames: bool,
    binary: usize,
    text: usize,
}

impl Phone {
    /// A phone the relay still routes a handshake for: open, attached, and not being rejected or closed.
    pub(super) fn live(&self) -> bool {
        self.attached && !self.closing && self.shared.socket.is_open()
    }

    fn path(&mut self, conn: &Conn, max_frame_bytes: usize) -> Path {
        let key = (conn.uplink.capacity, conn.uplink.text_frames);
        if self.ceiling_key != Some(key) {
            self.ceiling_key = Some(key);
            self.ceilings = uplink_ceilings(UplinkPath { capacity: key.0, client_id: &self.id, text_frames: key.1, policy: max_frame_bytes });
        }
        Path { text_frames: key.1, binary: self.ceilings.binary, text: self.ceilings.text }
    }
}

impl PhoneLeg for Phone {
    fn is_open(&self) -> bool {
        self.shared.socket.is_open()
    }

    fn buffered_amount(&self) -> usize {
        self.shared.socket.buffered_amount()
    }

    fn inflight_ceiling(&self) -> usize {
        if self.inflight_ceiling == 0 { MAX_INFLIGHT_BYTES } else { self.inflight_ceiling }
    }

    fn charge(&self) -> &Arc<LegCharge> {
        &self.shared.charge
    }

    fn resync_hinted(&self) -> bool {
        self.resync_hinted
    }

    fn set_resync_hinted(&mut self, hinted: bool) {
        self.resync_hinted = hinted;
    }

    fn send(&mut self, data: Outbound<'_>, release: Option<Release>) -> Result<(), SendFailed> {
        let on_flushed: Option<FlushCallback> = release.map(|release| -> FlushCallback { Box::new(move |_| release.run()) });
        match data {
            Outbound::Text(text) => self.shared.socket.send_text(Bytes::copy_from_slice(text.as_bytes()), on_flushed),
            Outbound::Binary(bytes) => self.shared.socket.send_binary(Bytes::copy_from_slice(bytes), on_flushed),
        }
        Ok(())
    }

    fn close(&mut self, code: u16, reason: &str) {
        self.shared.socket.close(code, reason.as_bytes());
    }
}

/// `deliverToPhone`: desktop -> one phone. A pushed legacy frame is recoverable (resync), so it may be dropped for a busy leg; a
/// transport frame is a record of an ordered, acknowledged stream, so whatever the sender's `droppable` flag says it is never
/// dropped: `send_to_phone` sends it, or cuts the leg (never defers or skips it), and the stream resumes over the phone's next leg.
pub(super) fn deliver_to_phone(phone: &mut Phone, data: Outbound<'_>, droppable: bool) -> bool {
    let transport = matches!(data, Outbound::Binary(bytes) if envelope::is_transport_frame(bytes));
    send_to_phone(phone, data, droppable && !transport, Pressure::Cut)
}

/// The `client-open` a desktop leg is told about a phone with. The credential rides along only when there is one, so older
/// desktops see the envelope they know.
pub(super) fn client_open(client_id: &str, browser_client_id: Option<&str>) -> Value {
    match browser_client_id {
        Some(browser) if !browser.is_empty() => json!({ "type": "client-open", "clientId": client_id, "browserClientId": browser }),
        _ => json!({ "type": "client-open", "clientId": client_id }),
    }
}

/// `announcePhone`: tell the desktop leg of a phone and start owing it a challenge. A phone being rejected or closed is never
/// announced again.
pub(super) fn announce_phone(hub: &Arc<Hub>, device_id: &str, conn: &Conn, timing: HandshakeTiming, phone: &mut Phone) {
    if !phone.live() {
        return;
    }
    send_json(&*conn.socket, &client_open(&phone.id, phone.browser_client_id.as_deref()));
    let target = WatchTarget { device_id: device_id.to_owned(), client_id: phone.id.clone(), generation: conn.generation };
    let live = phone.live();
    await_desktop_turn(hub, target, &mut phone.watch, live, timing, Turn::Challenge);
}

/// `signalPhoneDesktopGone`: the PC's leg is gone and this phone's frames have nowhere to go. Same cleartext channel as the oversize
/// notice: the phone acts on `resync` before decryption and drops the socket on any other cleartext key, so the notice is
/// `{"resync":"desktop-gone"}` and an older build just resyncs. `throttle` caps a notice the phone's own traffic provokes to one per
/// second; the notice at the time the leg goes is not throttled.
pub(super) fn signal_desktop_gone(shared: &PhoneShared, throttle: bool) {
    if !shared.socket.is_open() {
        return;
    }
    let now = Instant::now();
    let mut gone_at = lock(&shared.gone_at);
    if !policy::desktop_gone_notice_due(gone_at.map(Instant::into_std), now.into_std(), throttle) {
        return;
    }
    *gone_at = Some(now);
    drop(gone_at);
    shared.socket.send_text(Bytes::from_static(policy::DESKTOP_GONE_NOTICE.as_bytes()), None);
}

/// The payload of one phone frame on its way up the desktop leg.
enum Uplink {
    Text(String),
    Binary(Vec<u8>),
}

impl Uplink {
    fn len(&self) -> usize {
        match self {
            Self::Text(text) => text.len(),
            Self::Binary(bytes) => bytes.len(),
        }
    }
}

/// `sendUplink`: phone -> desktop. The bytes are charged to the desktop socket that holds them, while the pause is applied to the
/// PRODUCING phone leg and lifted by that same leg's flush: one phone can neither outrun the desktop nor stall another phone. A
/// refusal cuts the phone leg, never the desktop's. Returns whether the payload was handed over.
fn send_uplink(phone: &mut Phone, desktop: &Conn, payload: Uplink) -> bool {
    if !desktop.socket.is_open() {
        return false;
    }
    let size = payload.len();
    let queued = phone.shared.flow.queued();
    let decision = policy::admit_frame(&FrameQuery {
        queued,
        size,
        budget: UPLINK_QUEUE_LIMIT_BYTES,
        droppable: false,
        inflight: desktop.charge.meter().bytes(),
        ceiling: PhoneLeg::inflight_ceiling(phone),
    });
    if decision != Admission::Send {
        if let Some((code, reason)) = decision.close() {
            phone.shared.socket.close(code, reason.as_bytes());
        }
        return false;
    }
    let flow = Arc::clone(&phone.shared.flow);
    flow.add(size);
    let release = desktop.charge.charge(size);
    let settle_flow = Arc::clone(&flow);
    let settle: FlushCallback = Box::new(move |_| {
        release.run();
        settle_flow.settled(size);
    });
    match payload {
        Uplink::Text(text) => desktop.socket.send_text(Bytes::from(text), Some(settle)),
        Uplink::Binary(bytes) => desktop.socket.send_binary(Bytes::from(bytes), Some(settle)),
    }
    if policy::uplink_pause_due(flow.queued()) {
        flow.pause();
    }
    true
}

/// The options of one phone leg.
pub struct PhoneOptions {
    /// The per-browser credential the leg authenticated with.
    pub browser_client_id: Option<String>,
    /// The box-level ceiling this leg's sends are held to; 0 is the relay's default.
    pub inflight_ceiling: usize,
    /// Puts the leg's ingress meter on its socket; none for a socket that is not a [`WebSocket`] (the tests).
    pub ingress: Option<IngressInstall>,
}

impl Default for PhoneOptions {
    fn default() -> Self {
        Self { browser_client_id: None, inflight_ceiling: MAX_INFLIGHT_BYTES, ingress: None }
    }
}

/// The device has no live desktop entry: the phone cannot be attached.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NoDesktop;

impl std::fmt::Display for NoDesktop {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("no desktop leg for this device")
    }
}

impl std::error::Error for NoDesktop {}

/// A desktop's connection state as the HTTP routes read it (`entry` of `liveDesktops.get(deviceId)`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopInfo {
    /// `desktopLegOpen(entry)`: the leg socket is open.
    pub open: bool,
    pub media_lane: bool,
    pub pair_v2: bool,
    pub host_name: Option<String>,
    /// Phones attached (`entry.clients.size`).
    pub clients: usize,
}

/// The media half of an entry, for the media proxy.
pub struct MediaView<'a> {
    pub lane: bool,
    /// The desktop leg socket is open.
    pub open: bool,
    pub socket: &'a SocketRef,
    pub pending: &'a mut MediaSlot,
}

#[derive(Default)]
struct LegTable {
    next: u64,
    legs: BTreeMap<u64, SweepLeg>,
}

/// The relay's live desktops and the phones attached to them.
pub struct Hub {
    state: Mutex<HubState>,
    store: DeviceStore,
    config: HubConfig,
    meter: Arc<InflightMeter>,
    dispatch: Dispatch,
    pool: IngressPool,
    legs: Mutex<LegTable>,
}

impl Hub {
    /// `createRelayState`'s `liveDesktops` and the numbers it is held to. `pool` is the process's one ingress pool.
    pub fn new(store: DeviceStore, mut config: HubConfig, pool: IngressPool) -> Arc<Self> {
        config.uplink_capacity_ceiling = policy::bounded_capacity(Some(config.uplink_capacity_ceiling as f64), MAX_UPLINK_CAPACITY_BYTES);
        config.ingress.limit = config.max_frame_bytes;
        Arc::new(Self {
            state: Mutex::new(HubState::default()),
            store,
            config,
            meter: InflightMeter::new(),
            dispatch: Dispatch::default(),
            pool,
            legs: Mutex::new(LegTable::default()),
        })
    }

    pub fn store(&self) -> &DeviceStore {
        &self.store
    }

    pub fn config(&self) -> &HubConfig {
        &self.config
    }

    /// The registrations of the areas behind the desktop leg.
    pub fn dispatch(&self) -> &Dispatch {
        &self.dispatch
    }

    /// The box meter every leg's sends are charged to (`relayInflightBytes`).
    pub fn meter(&self) -> &Arc<InflightMeter> {
        &self.meter
    }

    /// The process's ingress pool.
    pub fn ingress_pool(&self) -> &IngressPool {
        &self.pool
    }

    /// The ingress numbers of the legs of this hub.
    pub fn ingress_limits(&self) -> IngressLimits {
        self.config.ingress
    }

    pub(super) fn lock(&self) -> MutexGuard<'_, HubState> {
        lock(&self.state)
    }

    // ---- the sweep's table: every upgraded socket ----

    /// Add a socket to the table the heartbeat sweep walks. The legs of the hub register themselves; the hook leg and the sockets
    /// answered only with a close code register through this. Returns the id to [`Hub::unregister_leg`] with.
    pub fn register_leg(&self, leg: SweepLeg) -> u64 {
        let mut table = lock(&self.legs);
        table.next += 1;
        let id = table.next;
        table.legs.insert(id, leg);
        id
    }

    pub fn unregister_leg(&self, id: u64) {
        lock(&self.legs).legs.remove(&id);
    }

    /// Every registered socket, oldest first (`wss.clients`).
    pub fn legs(&self) -> Vec<SweepLeg> {
        lock(&self.legs).legs.values().cloned().collect()
    }

    // ---- phones ----

    /// `runClientLeg`: attach a phone to the desktop of `device_id` and announce it to the desktop leg (`client-open`, then the
    /// challenge is owed within the watchdog's clock). The phone's `clientId` is a random UUID the hub hands out.
    pub fn attach_phone(self: &Arc<Self>, device_id: &str, socket: SocketRef, options: PhoneOptions) -> Result<PhoneHandle, NoDesktop> {
        let client_id = uuid::Uuid::new_v4().to_string();
        let ingress = options.ingress.map(|install| {
            let hub = Arc::downgrade(self);
            let (device, client) = (device_id.to_owned(), client_id.clone());
            let limit_for: Arc<dyn Fn(bool) -> usize + Send + Sync> =
                Arc::new(move |binary| hub.upgrade().map_or(0, |hub| hub.phone_limit(&device, &client, binary)));
            install(LegKind::Phone { limit_for })
        });
        let liveness = Liveness::new();
        let shared = Arc::new(PhoneShared {
            socket: Arc::clone(&socket),
            charge: LegCharge::new(Arc::clone(&self.meter)),
            liveness: Arc::clone(&liveness),
            flow: UplinkFlow::new(Arc::clone(&socket)),
            gone_at: Mutex::new(None),
            ingress: ingress.clone(),
            opened_at: Instant::now(),
        });
        let phone = Phone {
            id: client_id.clone(),
            shared: Arc::clone(&shared),
            browser_client_id: options.browser_client_id,
            attached: false,
            closing: false,
            resync_hinted: false,
            inflight_ceiling: options.inflight_ceiling,
            watch: Watch::default(),
            ceiling_key: None,
            ceilings: UplinkCeilings { binary: 0, text: 0 },
        };
        let leg_id = self.register_leg(SweepLeg { socket, liveness, ingress });
        if !self.join_desktop(device_id, phone) {
            if let Some(ingress) = &shared.ingress {
                ingress.release();
            }
            self.unregister_leg(leg_id);
            return Err(NoDesktop);
        }
        Ok(PhoneHandle { hub: Arc::clone(self), device_id: device_id.to_owned(), client_id, shared, leg_id, finished: AtomicBool::new(false) })
    }

    /// Adds `phone` to the entry of `device_id` and announces it to the desktop leg; `false` when that desktop is not connected.
    fn join_desktop(self: &Arc<Self>, device_id: &str, phone: Phone) -> bool {
        let mut guard = self.lock();
        let Some(entry) = guard.desktops.get_mut(device_id) else { return false };
        let Entry { conn, clients, handshake, .. } = entry;
        clients.push(phone);
        if let Some(phone) = clients.last_mut() {
            phone.attached = true;
            announce_phone(self, device_id, conn, *handshake, phone);
        }
        true
    }

    /// `oversizeLimitFor`: the stable ceiling of one phone's path in one wire form, the number every refusal quotes.
    fn phone_limit(&self, device_id: &str, client_id: &str, binary: bool) -> usize {
        let max_frame_bytes = self.config.max_frame_bytes;
        let mut guard = self.lock();
        let found = guard.desktops.get_mut(device_id).and_then(|entry| {
            let Entry { conn, clients, .. } = entry;
            clients.iter_mut().find(|phone| phone.id == client_id).map(|phone| phone.path(conn, max_frame_bytes))
        });
        let path = found.unwrap_or_else(|| undeclared_path(client_id, max_frame_bytes));
        if binary { path.binary } else { path.text }
    }

    /// The desktop leg of `device_id` closed 45 s ago and has not come back: its parked phones are closed 4002 and the entry goes.
    pub(super) fn desktop_offline_expired(&self, device_id: &str, generation: u64) {
        let mut guard = self.lock();
        let live = guard.desktops.get(device_id).is_some_and(|entry| entry.conn.generation == generation);
        if !live {
            return;
        }
        if let Some(entry) = guard.desktops.remove(device_id) {
            for phone in &entry.clients {
                phone.shared.socket.close(DESKTOP_OFFLINE, DESKTOP_OFFLINE_REASON.as_bytes());
            }
        }
    }

    // ---- what the routes and the other areas ask ----

    /// Send a JSON frame to the live desktop leg of a device; false when the device has no open leg.
    pub fn send_to_desktop(&self, device_id: &str, payload: &Value) -> bool {
        let guard = self.lock();
        let Some(entry) = guard.desktops.get(device_id) else { return false };
        if !entry.conn.socket.is_open() {
            return false;
        }
        send_json(&*entry.conn.socket, payload);
        true
    }

    /// `desktopLegOpen(liveDesktops.get(deviceId))`.
    pub fn desktop_open(&self, device_id: &str) -> bool {
        self.lock().desktops.get(device_id).is_some_and(|entry| entry.conn.socket.is_open())
    }

    /// What the routes know of a device's desktop: none when the device has no entry.
    pub fn desktop_info(&self, device_id: &str) -> Option<DesktopInfo> {
        self.lock().desktops.get(device_id).map(|entry| DesktopInfo {
            open: entry.conn.socket.is_open(),
            media_lane: entry.media_lane,
            pair_v2: entry.pair_v2,
            host_name: entry.host_name.clone(),
            clients: entry.clients.len(),
        })
    }

    /// `entry.clients.size`; 0 for a device with no entry.
    pub fn client_count(&self, device_id: &str) -> usize {
        self.lock().desktops.get(device_id).map_or(0, |entry| entry.clients.len())
    }

    /// Run `read` over the media half of a device's entry.
    pub fn with_media<R>(&self, device_id: &str, read: impl FnOnce(MediaView<'_>) -> R) -> Option<R> {
        let mut guard = self.lock();
        let entry = guard.desktops.get_mut(device_id)?;
        let open = entry.conn.socket.is_open();
        Some(read(MediaView { lane: entry.media_lane, open, socket: &entry.conn.socket, pending: &mut entry.media }))
    }

    /// The browsers (their per-browser credential ids) with a phone attached to a device.
    pub fn online_browsers(&self, device_id: &str) -> HashSet<String> {
        let guard = self.lock();
        let Some(entry) = guard.desktops.get(device_id) else { return HashSet::new() };
        entry.clients.iter().filter_map(|phone| phone.browser_client_id.clone()).filter(|id| !id.is_empty()).collect()
    }

    /// The sockets of every desktop entry, for the 30 s diagnostics line (`collectSockets`).
    pub fn snapshot(&self) -> Vec<DesktopSockets> {
        let guard = self.lock();
        guard
            .desktops
            .iter()
            .map(|(device_id, entry)| DesktopSockets {
                device_id: device_id.clone(),
                socket_attached: true,
                socket_buffered: entry.conn.socket.buffered_amount() as u64,
                phones: entry
                    .clients
                    .iter()
                    .map(|phone| PhoneSocket { client_id: phone.id.clone(), buffered: phone.shared.socket.buffered_amount() as u64 })
                    .collect(),
            })
            .collect()
    }

    /// `closeRelay`'s walk over `liveDesktops`: stop the offline timers, terminate every desktop and phone socket, forget the entries.
    pub fn shutdown(&self) {
        let entries: Vec<Entry> = self.lock().desktops.drain().map(|(_, entry)| entry).collect();
        for entry in entries {
            if let Some(timer) = &entry.offline_timer {
                timer.abort();
            }
            entry.conn.socket.terminate();
            for phone in &entry.clients {
                phone.shared.socket.terminate();
            }
        }
    }
}

fn undeclared_path(client_id: &str, max_frame_bytes: usize) -> Path {
    let ceilings = uplink_ceilings(UplinkPath { capacity: UNDECLARED_CAPACITY_BYTES, client_id, text_frames: false, policy: max_frame_bytes });
    Path { text_frames: false, binary: ceilings.binary, text: ceilings.text }
}

/// One attached phone leg, as its sockets code drives it: the frames and events of the socket go in through these methods.
pub struct PhoneHandle {
    hub: Arc<Hub>,
    device_id: String,
    client_id: String,
    shared: Arc<PhoneShared>,
    leg_id: u64,
    finished: AtomicBool,
}

impl PhoneHandle {
    /// The routing id the hub gave this phone.
    pub fn client_id(&self) -> &str {
        &self.client_id
    }

    pub fn liveness(&self) -> &Arc<Liveness> {
        &self.shared.liveness
    }

    /// The socket's pong.
    pub fn pong(&self) {
        self.shared.liveness.mark();
    }

    /// `handlePhoneFrame`: one message from the phone. A liveness probe is answered here (reaching this hop is the question being
    /// asked); everything else rides up the desktop leg inside the routing envelope. Oversize is answered on this leg and the leg
    /// stays open.
    pub fn frame(&self, data: Bytes, is_binary: bool) {
        let announced = self.shared.ingress.as_ref().is_some_and(IngressLeg::note_delivery);
        self.shared.liveness.mark();
        let routed = {
            let mut guard = self.hub.lock();
            self.route(&mut guard, &data, is_binary, announced)
        };
        if !routed {
            self.orphan(&data, is_binary, announced);
        }
    }

    /// Route one frame inside the hub's section; false when the entry is gone.
    fn route(&self, state: &mut HubState, data: &Bytes, is_binary: bool, announced: bool) -> bool {
        let max_frame_bytes = self.hub.config.max_frame_bytes;
        let Some(entry) = state.desktops.get_mut(&self.device_id) else { return false };
        let Entry { conn, clients, handshake, .. } = entry;
        let Some(phone) = clients.iter_mut().find(|phone| phone.id == self.client_id) else { return false };
        // The ceiling this phone is held to is the one its message can actually be DELIVERED under: this relay's policy, bounded by
        // what the desktop leg accepts once the routing envelope is on it. Past that is a payload error for this phone, never a
        // reason to drop the socket its session runs on.
        let path = phone.path(conn, max_frame_bytes);
        let limit = if is_binary { path.binary } else { path.text };
        if let Oversize::Refused { announce } = check_oversize(data.len(), limit, announced) {
            if announce {
                self.shared.socket.send_text(Bytes::from(policy::phone_oversize_notice(data.len(), limit)), None);
            }
            return true;
        }
        let payload = if is_binary {
            let Ok(frame) = envelope::encode_frame(&self.client_id, data, false, false) else { return true };
            self.note_turn(phone, conn.generation, *handshake);
            Uplink::Binary(frame)
        } else {
            let text = js::decode_utf8(data);
            if envelope::is_phone_ping(&text) {
                self.shared.socket.send_text(Bytes::from_static(envelope::PHONE_PONG.as_bytes()), None);
                return true;
            }
            self.note_turn(phone, conn.generation, *handshake);
            // A leg that decodes text inside the binary envelope gets it there: that envelope is a fixed header, so a message within
            // policy is still within policy on the wire. JSON escaping can make no such promise, which is why the text ceiling is a
            // worst case wherever JSON is the only option.
            if path.text_frames {
                let Ok(frame) = envelope::encode_frame(&self.client_id, data, false, true) else { return true };
                Uplink::Binary(frame)
            } else {
                Uplink::Text(envelope::json_frame(&self.client_id, &text))
            }
        };
        // Backpressure is charged to this leg only: it stops being read while its own frames are outstanding, and resumes on its
        // own flush.
        let sent = send_uplink(phone, conn, payload);
        if !sent && !conn.socket.is_open() {
            signal_desktop_gone(&self.shared, true);
        }
        true
    }

    /// The phone's first frame after a challenge is its hello; the desktop owes the answer from then on.
    fn note_turn(&self, phone: &mut Phone, generation: u64, timing: HandshakeTiming) {
        if phone.watch.turn() != Some(Turn::Hello) {
            return;
        }
        let target = WatchTarget { device_id: self.device_id.clone(), client_id: self.client_id.clone(), generation };
        let live = phone.live();
        await_desktop_turn(&self.hub, target, &mut phone.watch, live, timing, Turn::Ready);
    }

    /// A frame of a phone whose entry is gone (the desktop stayed away past the offline grace and the phone's close has not
    /// finished): nothing can carry it.
    fn orphan(&self, data: &Bytes, is_binary: bool, announced: bool) {
        let path = undeclared_path(&self.client_id, self.hub.config.max_frame_bytes);
        let limit = if is_binary { path.binary } else { path.text };
        if let Oversize::Refused { announce } = check_oversize(data.len(), limit, announced) {
            if announce {
                self.shared.socket.send_text(Bytes::from(policy::phone_oversize_notice(data.len(), limit)), None);
            }
            return;
        }
        if !is_binary && envelope::is_phone_ping(&js::decode_utf8(data)) {
            self.shared.socket.send_text(Bytes::from_static(envelope::PHONE_PONG.as_bytes()), None);
            return;
        }
        signal_desktop_gone(&self.shared, true);
    }

    /// The socket closed (`socket.on('close')` of `runClientLeg`): the phone leaves its desktop's entry, which is told, and the
    /// leg's accounting goes with it. One line says who hung up: a phone that reconnects every few seconds pays a full handshake
    /// and a full roster resync each time, and this is the one place both ends of that loop are visible. The code names who hung up:
    /// 1000 'background' is the app's own foreground gate, 1001/1006 is the link or the browser discarding the page, and 4xxx is
    /// this relay's own guard.
    pub fn closed(&self, code: u16, reason: &[u8]) {
        if self.finished.swap(true, Ordering::SeqCst) {
            return;
        }
        self.shared.flow.shutdown();
        self.shared.charge.release_all();
        if let Some(ingress) = &self.shared.ingress {
            ingress.release();
        }
        self.hub.unregister_leg(self.leg_id);
        let said: String = js::decode_utf8(reason).chars().take(60).collect();
        {
            let mut guard = self.hub.lock();
            if let Some(entry) = guard.desktops.get_mut(&self.device_id)
                && let Some(position) = entry.clients.iter().position(|phone| phone.id == self.client_id)
            {
                let mut phone = entry.clients.remove(position);
                phone.attached = false;
                phone.watch.end();
                // The PC logs who hung up (the code and reason below), so its own log explains a phone that keeps reconnecting.
                send_json(&*entry.conn.socket, &json!({ "type": "client-close", "clientId": self.client_id, "code": code, "reason": said }));
            }
        }
        let lived_ms = i64::try_from(self.shared.opened_at.elapsed().as_millis()).unwrap_or(i64::MAX);
        logline::emit(&logline::phone_leg_closed(&self.client_id, code, &js::decode_utf8(reason), lived_ms));
    }
}
