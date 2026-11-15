//! The pure forwarding policy of the relay (`lib/relay-transport.mjs`): frame and capacity ceilings, per-leg capacity, the
//! admission decision for one frame, the desktop -> phone send over a socket abstraction, attribution of a refused frame to
//! the client it was routed to, and the oversize notices. Everything here is a function over plain inputs; the sockets code
//! of the legs and the tests call the same ones.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::envelope;
use crate::close_codes::{RELAY_BUSY, RELAY_BUSY_REASON, SLOW_CONSUMER_REASON, SLOW_PEER};
use crate::ids::is_routing_id;
use crate::js;

/// Forwarding policy ceiling for ONE frame. It matches the desktop leg's own budget: gallery originals ride the RPC
/// fallback as single frames, so a smaller ceiling would cut supported traffic. Memory is protected by admission control
/// and backpressure, never by shrinking what a supported client may send.
pub const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;
/// The transport stop sits ABOVE the policy ceiling on purpose: past it the connection is killed (1009), which the user
/// only sees as "relay disconnected". The policy check runs first and answers with a payload error while the leg stays open.
pub const MAX_WS_PAYLOAD_BYTES: usize = MAX_FRAME_BYTES + 4 * 1024 * 1024;
/// Upper clamp for a capacity. A configured number may only LOWER what a leg said about itself.
pub const MAX_UPLINK_CAPACITY_BYTES: usize = MAX_WS_PAYLOAD_BYTES;
/// One NUL becomes `\u0000`: six bytes for one, so a JSON wrapper is bounded by the worst case.
const JSON_ESCAPE_WORST_CASE: usize = 6;
/// What a desktop leg is taken to receive until IT says otherwise, on the connection in hand: the conservative floor every
/// receiver of the protocol takes. A first connection, a redial and a restarted relay all start here.
pub const UNDECLARED_CAPACITY_BYTES: usize = 64 * 1024;
/// The smallest capacity the protocol can express: below the relay's own envelope nothing can be forwarded.
pub const MIN_UPLINK_CAPACITY_BYTES: usize = 1024;
/// Every phone leg is routed by a random UUID, so the envelope overhead is the same for all of them; this stand-in only
/// publishes that overhead as a number.
pub const CANONICAL_CLIENT_ID: &str = "00000000-0000-4000-8000-000000000000";

/// A droppable push to a phone with more than this buffered is skipped (and the phone is hinted to resync).
pub const SKIP_PUSH_BUFFER_BYTES: usize = 1024 * 1024;
/// Per-leg queue budget toward a phone. A leg with an EMPTY queue may always take one frame of any supported size.
pub const PHONE_QUEUE_LIMIT_BYTES: usize = 8 * 1024 * 1024;
/// Per-leg queue budget of a phone's frames toward the desktop.
pub const UPLINK_QUEUE_LIMIT_BYTES: usize = 8 * 1024 * 1024;
/// A phone stops being READ while more than this of its own frames are outstanding.
pub const UPLINK_PAUSE_BYTES: usize = 2 * 1024 * 1024;
/// The pause lifts on that leg's own flush; this is the safety net for a flush that never comes.
pub const LEG_RESUME_TIMEOUT: Duration = Duration::from_secs(10);
/// Box-level ceiling across every leg.
pub const MAX_INFLIGHT_BYTES: usize = 128 * 1024 * 1024;

/// The reservation of one arriving message out of the box ingress pool: the transport ceiling, the leg's worst case.
pub const INGRESS_RESERVATION_BYTES: usize = MAX_WS_PAYLOAD_BYTES;
/// The box ingress pool: two reservations.
pub const MAX_INGRESS_BYTES: usize = 2 * INGRESS_RESERVATION_BYTES;
/// Every leg reads freely up to this window; a larger message needs a reservation.
pub const INGRESS_FREE_WINDOW_BYTES: usize = 256 * 1024;
/// How much of a refused frame's head is read to name the client it belongs to.
pub const OVERSIZE_ID_SCAN_BYTES: usize = 512;

/// At most one desktop-gone notice per phone in this window when the phone's own frames provoke it.
pub const DESKTOP_GONE_NOTICE_INTERVAL: Duration = Duration::from_secs(1);
/// The cleartext notice that the PC's leg is gone (`{"resync":"desktop-gone"}`: an older build just resyncs).
pub const DESKTOP_GONE_NOTICE: &str = "{\"resync\":\"desktop-gone\"}";
/// The hint a phone gets after a dropped push: ask for a full snapshot.
pub const RESYNC_HINT: &str = "{\"resync\":1}";

/// `Number(value)` of a JSON value, the way a declared capacity reaches the relay; `None` is NaN.
pub fn js_number(value: &Value) -> Option<f64> {
    let number = mixdog_js::to_number(value);
    (!number.is_nan()).then_some(number)
}

/// `boundedCapacity`: anything malformed (negative, zero, NaN, fractional below one, absurd) becomes the fallback; anything
/// usable is floored and bounded between the protocol minimum and the transport ceiling.
pub fn bounded_capacity(value: Option<f64>, fallback: usize) -> usize {
    let Some(number) = value.filter(|n| n.is_finite()) else { return fallback };
    let whole = number.floor();
    if whole <= 0.0 {
        return fallback;
    }
    whole.clamp(MIN_UPLINK_CAPACITY_BYTES as f64, MAX_UPLINK_CAPACITY_BYTES as f64) as usize
}

/// `uplinkCapacityFor`: the capacity of ONE desktop leg, what it declared on THIS connection clamped by configuration. A
/// leg that declared nothing gets the floor. `None` configured is no configuration: the transport ceiling.
pub fn uplink_capacity_for(declared: Option<f64>, configured: Option<f64>) -> usize {
    let ceiling = bounded_capacity(configured, MAX_UPLINK_CAPACITY_BYTES);
    let leg = bounded_capacity(declared, UNDECLARED_CAPACITY_BYTES);
    ceiling.min(leg)
}

/// The path a phone message takes to a desktop leg: the inputs of [`uplink_ceilings`].
#[derive(Debug, Clone, Copy)]
pub struct UplinkPath<'a> {
    pub capacity: usize,
    pub client_id: &'a str,
    /// The leg acknowledged text in the binary envelope on this connection.
    pub text_frames: bool,
    pub policy: usize,
}

impl Default for UplinkPath<'_> {
    fn default() -> Self {
        Self { capacity: UNDECLARED_CAPACITY_BYTES, client_id: "", text_frames: false, policy: MAX_FRAME_BYTES }
    }
}

/// The largest phone message a leg can carry, per wire form.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UplinkCeilings {
    pub binary: usize,
    pub text: usize,
}

/// `uplinkCeilings`: properties of the PATH (capacity, client id, envelope in use), never of the message in hand. The binary
/// envelope is a fixed header so its ceiling is exact; the JSON wrapper escapes what it carries so its ceiling assumes the
/// worst case, unless the leg acknowledged text in the binary envelope.
pub fn uplink_ceilings(path: UplinkPath<'_>) -> UplinkCeilings {
    let binary = path.capacity.saturating_sub(envelope::binary_overhead(path.client_id)).min(path.policy);
    let text = if path.text_frames {
        binary
    } else {
        (path.capacity.saturating_sub(envelope::json_frame_overhead(path.client_id)) / JSON_ESCAPE_WORST_CASE).min(path.policy)
    };
    UplinkCeilings { binary, text }
}

/// Everything the relay knows about ONE desktop connection's receiver: created with the socket, written only by that
/// socket's own handler, discarded with it. It keeps no memory of a past failure to spend on a future frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UplinkLeg {
    pub capacity_ceiling: usize,
    pub capacity: usize,
    pub text_frames: bool,
    /// The capabilities frame last published on this socket, so a declaration that moves the numbers is answered and one that
    /// changes nothing is not.
    pub published: String,
}

impl UplinkLeg {
    /// `newUplinkLeg`: until THIS connection declares, the floor.
    pub fn new(capacity_ceiling: usize) -> Self {
        Self {
            capacity_ceiling,
            capacity: uplink_capacity_for(None, Some(capacity_ceiling as f64)),
            text_frames: false,
            published: String::new(),
        }
    }

    /// `declareUplinkLeg`: this connection's declaration, normalised once.
    pub fn declare(&mut self, declared: Option<f64>, text_frames: bool) {
        self.capacity = uplink_capacity_for(declared, Some(self.capacity_ceiling as f64));
        self.text_frames = text_frames;
    }
}

/// What this relay publishes to a desktop leg about itself (`relayCapabilities`). `text_frames` is an ACKNOWLEDGEMENT: it
/// appears only where the relay will carry phone text in the binary envelope on this leg. The ceilings are computed from the
/// leg state the enforcement path reads, so what is PUBLISHED is what is ENFORCED.
pub fn relay_capabilities(
    leg: &UplinkLeg,
    max_frame_bytes: usize,
    native_push_platforms: &[String],
    web_push: bool,
    ice: bool,
) -> Value {
    let ceilings = uplink_ceilings(UplinkPath {
        capacity: leg.capacity,
        client_id: CANONICAL_CLIENT_ID,
        text_frames: leg.text_frames,
        policy: max_frame_bytes,
    });
    let mut frame = serde_json::Map::new();
    frame.insert("type".into(), json!("relay-capabilities"));
    frame.insert("binaryFrames".into(), json!(1));
    frame.insert("maxFrameBytes".into(), json!(max_frame_bytes));
    if leg.text_frames {
        frame.insert("textFrames".into(), json!(1));
    }
    frame.insert("uplinkCapacityBytes".into(), json!(leg.capacity));
    frame.insert("uplinkBinaryCeilingBytes".into(), json!(ceilings.binary));
    frame.insert("uplinkTextCeilingBytes".into(), json!(ceilings.text));
    // Present only when this relay holds APNs/FCM credentials.
    if !native_push_platforms.is_empty() {
        frame.insert("nativePush".into(), json!(1));
        frame.insert("nativePushPlatforms".into(), json!(native_push_platforms));
    }
    // Present when this relay owns the Web Push sender identity.
    if web_push {
        frame.insert("webPush".into(), json!(1));
    }
    // Present when this relay can issue TURN credentials.
    if ice {
        frame.insert("ice".into(), json!(1));
    }
    Value::Object(frame)
}

/// What to do with one frame before anything is enqueued (`admitFrame`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Admission {
    /// Hand it over.
    Send,
    /// Skip a recoverable push.
    Drop,
    /// Cut a leg that is not draining: close 4008 `slow consumer`.
    Slow,
    /// Cut a leg the box can no longer carry: close 4009 `relay busy`.
    Busy,
}

impl Admission {
    /// The close a refusing decision ends in; `None` for `Send` and `Drop`.
    pub fn close(self) -> Option<(u16, &'static str)> {
        match self {
            Self::Slow => Some((SLOW_PEER, SLOW_CONSUMER_REASON)),
            Self::Busy => Some((RELAY_BUSY, RELAY_BUSY_REASON)),
            Self::Send | Self::Drop => None,
        }
    }
}

/// The inputs of [`admit_frame`].
#[derive(Debug, Clone, Copy)]
pub struct FrameQuery {
    pub queued: usize,
    pub size: usize,
    pub budget: usize,
    pub droppable: bool,
    pub inflight: usize,
    pub ceiling: usize,
}

impl Default for FrameQuery {
    fn default() -> Self {
        Self { queued: 0, size: 0, budget: PHONE_QUEUE_LIMIT_BYTES, droppable: false, inflight: 0, ceiling: MAX_INFLIGHT_BYTES }
    }
}

/// `admitFrame`: admission of one frame on one leg. An idle leg may always take one frame: the budget bounds ACCUMULATION,
/// not the payload size a supported client may send.
pub fn admit_frame(query: &FrameQuery) -> Admission {
    if query.inflight + query.size > query.ceiling {
        return if query.droppable { Admission::Drop } else { Admission::Busy };
    }
    if query.queued > 0 && query.queued + query.size > query.budget {
        return if query.droppable { Admission::Drop } else { Admission::Slow };
    }
    Admission::Send
}

/// Whether a phone's own uplink backlog has reached the point where the phone stops being read.
pub fn uplink_pause_due(uplink_bytes: usize) -> bool {
    uplink_bytes > UPLINK_PAUSE_BYTES
}

/// Bytes handed to sockets that have not flushed them yet, box-wide. One meter is shared by every leg of the process.
#[derive(Debug, Default)]
pub struct InflightMeter {
    bytes: AtomicUsize,
}

impl InflightMeter {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// `relayInflightBytes`.
    pub fn bytes(&self) -> usize {
        self.bytes.load(Ordering::SeqCst)
    }

    fn add(&self, size: usize) {
        self.bytes.fetch_add(size, Ordering::SeqCst);
    }

    fn sub(&self, size: usize) {
        let _ = self.bytes.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |held| Some(held.saturating_sub(size)));
    }
}

/// What one socket holds in the box meter: bytes charged to it that it has not flushed.
#[derive(Debug)]
pub struct LegCharge {
    meter: Arc<InflightMeter>,
    pending: AtomicUsize,
    epoch: AtomicU64,
}

impl LegCharge {
    pub fn new(meter: Arc<InflightMeter>) -> Arc<Self> {
        Arc::new(Self { meter, pending: AtomicUsize::new(0), epoch: AtomicU64::new(0) })
    }

    /// The box meter this leg is charged to.
    pub fn meter(&self) -> &Arc<InflightMeter> {
        &self.meter
    }

    /// Bytes charged to this socket and not yet released.
    pub fn pending_bytes(&self) -> usize {
        self.pending.load(Ordering::SeqCst)
    }

    /// `chargeFrame`: charge one frame to the socket holding it. The returned [`Release`] runs when the frame flushes.
    pub fn charge(self: &Arc<Self>, size: usize) -> Release {
        self.pending.fetch_add(size, Ordering::SeqCst);
        self.meter.add(size);
        Release(Arc::new(ReleaseState {
            leg: Arc::clone(self),
            size,
            epoch: self.epoch.load(Ordering::SeqCst),
            released: AtomicBool::new(false),
        }))
    }

    /// `releaseLeg`: a leg that goes away takes its outstanding charge with it. The epoch bump makes the stale releases
    /// no-ops so the counter cannot drift.
    pub fn release_all(&self) {
        let held = self.pending.swap(0, Ordering::SeqCst);
        self.meter.sub(held);
        self.epoch.fetch_add(1, Ordering::SeqCst);
    }
}

#[derive(Debug)]
struct ReleaseState {
    leg: Arc<LegCharge>,
    size: usize,
    epoch: u64,
    released: AtomicBool,
}

/// The release of one charged frame: run it once, when the socket has flushed (or failed) the frame.
#[derive(Debug, Clone)]
pub struct Release(Arc<ReleaseState>);

impl Release {
    pub fn run(&self) {
        let state = &self.0;
        if state.leg.epoch.load(Ordering::SeqCst) != state.epoch || state.released.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = state.leg.pending.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |held| Some(held.saturating_sub(state.size)));
        state.leg.meter.sub(state.size);
    }
}

/// One outbound WebSocket message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outbound<'a> {
    Text(&'a str),
    Binary(&'a [u8]),
}

impl Outbound<'_> {
    /// `frameBytes`: the bytes it weighs on the wire.
    pub fn len(&self) -> usize {
        match self {
            Self::Text(text) => text.len(),
            Self::Binary(bytes) => bytes.len(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// What a phone leg must offer the send policy.
pub trait PhoneLeg {
    fn is_open(&self) -> bool;
    /// Bytes handed to the socket and not flushed (`bufferedAmount`).
    fn buffered_amount(&self) -> usize;
    /// The box-level ceiling that applies to this leg.
    fn inflight_ceiling(&self) -> usize {
        MAX_INFLIGHT_BYTES
    }
    fn charge(&self) -> &Arc<LegCharge>;
    /// Whether this leg was already hinted to resync during the present congestion.
    fn resync_hinted(&self) -> bool;
    fn set_resync_hinted(&mut self, hinted: bool);
    /// Hand one message to the socket; `release` runs when it flushes. `Err` is a socket that refused the message.
    fn send(&mut self, data: Outbound<'_>, release: Option<Release>) -> Result<(), SendFailed>;
    fn close(&mut self, code: u16, reason: &str);
}

/// The socket refused a message (it vanished).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SendFailed;

/// What a box-level refusal means for one leg.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pressure {
    /// The single-leg path: the ceiling is filled by other conversations, so this leg is cut.
    Cut,
    /// The fan-out path: the ceiling is filled by the very loop this leg sits in, so no flush can release until the loop
    /// ends. A leg that showed no congestion of its own is never closed for that: it keeps its socket and is told to resync.
    Defer,
}

fn hint_resync(phone: &mut impl PhoneLeg) {
    // This leg just lost a push; one hint per congestion window makes it ask for a full snapshot as soon as it drains.
    if phone.resync_hinted() {
        return;
    }
    phone.set_resync_hinted(true);
    let _ = phone.send(Outbound::Text(RESYNC_HINT), None);
}

/// `sendToPhone`: desktop -> phone. Admission is per phone leg, so a congested phone never slows the shared desktop socket or
/// a sibling phone. Returns whether the message was handed over.
pub fn send_to_phone(phone: &mut impl PhoneLeg, data: Outbound<'_>, droppable: bool, pressure: Pressure) -> bool {
    if !phone.is_open() {
        return false;
    }
    let queued = phone.buffered_amount();
    if droppable && queued > SKIP_PUSH_BUFFER_BYTES {
        hint_resync(phone);
        return false;
    }
    let size = data.len();
    let decision = admit_frame(&FrameQuery {
        queued,
        size,
        budget: PHONE_QUEUE_LIMIT_BYTES,
        droppable,
        inflight: phone.charge().meter().bytes(),
        ceiling: phone.inflight_ceiling(),
    });
    if decision == Admission::Drop || (decision == Admission::Busy && pressure == Pressure::Defer) {
        hint_resync(phone);
        return false;
    }
    if let Some((code, reason)) = decision.close() {
        phone.close(code, reason);
        return false;
    }
    phone.set_resync_hinted(false);
    let release = phone.charge().charge(size);
    if phone.send(data, Some(release.clone())).is_err() {
        release.run();
    }
    true
}

/// Whether an oversize frame is refused, and whether the refusal still has to be sent: the ingress meter may have answered
/// this message while it was still arriving (`announced`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Oversize {
    Fits,
    Refused { announce: bool },
}

/// `rejectOversizeFrame` without the socket: the sender keeps its leg either way.
pub fn check_oversize(size: usize, limit: usize, announced: bool) -> Oversize {
    if size <= limit { Oversize::Fits } else { Oversize::Refused { announce: !announced } }
}

/// `signalPhoneOversize`: the notice for a phone leg. Everything on that leg is ciphertext and the phone's shim handles two
/// cleartext keys before decryption (`pong` and `resync`), so the refusal rides `resync`: a shim that predates this frame
/// recovers with a resync instead of disconnecting, and one that reads `error` fails the call with a payload error. `limit`
/// is the stable ceiling of this path in this wire form, never a per-payload measurement.
pub fn phone_oversize_notice(bytes: usize, limit: usize) -> String {
    js::wire(&json!({ "resync": 1, "error": "frame-too-large", "bytes": bytes, "limit": limit }))
}

/// `signalDesktopOversize`: the notice for the desktop leg, naming the client whose call produced the refused frame only when
/// the frame's own router would have delivered it to that client. `raw` is the frame, or the head of it when the refusal was
/// decided while it was still arriving.
pub fn desktop_oversize_notice(bytes: usize, limit: usize, raw: &[u8], binary: bool) -> String {
    let mut notice = serde_json::Map::new();
    notice.insert("type".into(), json!("frame-too-large"));
    if let Some(client_id) = oversize_frame_client_id(raw, binary) {
        notice.insert("clientId".into(), Value::String(client_id));
    }
    notice.insert("bytes".into(), json!(bytes));
    notice.insert("limit".into(), json!(limit));
    js::wire(&Value::Object(notice))
}

/// Name the client a refused frame belongs to, and ONLY when that is the client the frame's own router would have delivered it
/// to. A binary frame is decoded by the same call that routes it, so bytes it refuses (JSON-shaped bytes on the binary lane, a
/// bad magic, an id of the wrong length) reach no client; a text frame is routed by the JSON parser, which reads its id.
/// Naming nobody is always available, so every uncertainty resolves that way.
pub fn oversize_frame_client_id(raw: &[u8], binary: bool) -> Option<String> {
    if raw.len() < 8 {
        return None;
    }
    if binary {
        // The routing header is fixed-size and sits at the front: settled by the head, however large the frame.
        return envelope::decode_frame(&raw[..raw.len().min(OVERSIZE_ID_SCAN_BYTES)]).map(|frame| frame.client_id);
    }
    routed_client_id(raw)
}

/// `routedClientId`: the `clientId` a text frame would be ROUTED to, or `None` when it would be routed to nobody. It is the
/// router's decision taken with the router's own tool: the text lane routes by `JSON.parse` and reads `clientId` off the
/// result, so duplicate keys (the last wins), escapes, control bytes, trailing bytes and truncation are answered by the parser.
/// A frame the parser rejects, one that is not an object, and one whose id is not a routing id are attributed to nobody. One
/// pass: the cost follows the size of the frame and never its shape, and no window bounds it.
pub fn routed_client_id(bytes: &[u8]) -> Option<String> {
    let Ok(Value::Object(envelope)) = js::parse_bytes(bytes) else { return None };
    match envelope.get("clientId") {
        Some(Value::String(client_id)) if is_routing_id(client_id) => Some(client_id.clone()),
        _ => None,
    }
}

/// Whether a desktop-gone notice goes out now: the close-time notice is unthrottled, one a phone's own traffic provokes is
/// capped to one per [`DESKTOP_GONE_NOTICE_INTERVAL`].
pub fn desktop_gone_notice_due(last_sent: Option<Instant>, now: Instant, throttle: bool) -> bool {
    !throttle || last_sent.is_none_or(|last| now.saturating_duration_since(last) >= DESKTOP_GONE_NOTICE_INTERVAL)
}
