//! The desktop leg and the hub: announcing phones, capabilities, handshake turns and probes, offline notices, transport-frame delivery under pressure, redial and the legs without HTTP.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use bytes::Bytes;
use mixdog_relay::close_codes::{DESKTOP_HANDSHAKE_STALLED, DESKTOP_OFFLINE, DESKTOP_REJECTED_CLIENT, RELAY_BUSY, REVOKED, SLOW_PEER, SUPERSEDED};
use mixdog_relay::legs::desktop::{BUILT_IN_TYPES, DesktopHandle};
use mixdog_relay::legs::dispatch::{CapabilityOffer, Handler, HandlerFuture, LegCall, Rejected, RevokeHook};
use mixdog_relay::legs::envelope::{self, decode_frame, encode_frame};
use mixdog_relay::legs::hub::{Hub, HubConfig, LegSocket, PhoneHandle, PhoneOptions};
use mixdog_relay::legs::ingress::IngressPool;
use mixdog_relay::legs::watchdog::HandshakeTiming;
use mixdog_relay::store::{DeviceStore, ProfileInput};
use mixdog_relay::ws::FlushCallback;
use serde_json::{Value, json};

const MIB: usize = 1024 * 1024;
const DEVICE: &str = "6f1d3c2e-8a4b-4c5d-9e7f-0a1b2c3d4e5f";
const SECRET: &str = "0123456789abcdef";
/// A transport carrier message (`MXT\x01`).
const TRANSPORT: [u8; 5] = [0x4d, 0x58, 0x54, 0x01, 0x01];
/// A pushed E2EE box (`MXE\x01`): recoverable by resync.
const LEGACY: [u8; 4] = [0x4d, 0x58, 0x45, 0x01];

// ---- the socket stand-in ----

#[derive(Debug, Clone, PartialEq, Eq)]
enum Sent {
    Text(String),
    Binary(Vec<u8>),
}

struct FakeInner {
    open: bool,
    sent: Vec<Sent>,
    closed: Option<(u16, String)>,
    buffered: usize,
    holding: bool,
    held: VecDeque<(usize, Option<FlushCallback>)>,
    pings: usize,
    uplink_held: bool,
}

struct Fake {
    inner: Mutex<FakeInner>,
}

impl Fake {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(FakeInner {
                open: true,
                sent: Vec::new(),
                closed: None,
                buffered: 0,
                holding: false,
                held: VecDeque::new(),
                pings: 0,
                uplink_held: false,
            }),
        })
    }

    fn inner(&self) -> MutexGuard<'_, FakeInner> {
        self.inner.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn push(&self, item: Sent, size: usize, on_flushed: Option<FlushCallback>) {
        let now = {
            let mut inner = self.inner();
            inner.sent.push(item);
            if inner.holding {
                inner.buffered += size;
                inner.held.push_back((size, on_flushed));
                None
            } else {
                on_flushed
            }
        };
        if let Some(callback) = now {
            callback(Ok(()));
        }
    }

    fn sent(&self) -> Vec<Sent> {
        self.inner().sent.clone()
    }

    fn texts(&self) -> Vec<String> {
        self.sent()
            .into_iter()
            .filter_map(|item| match item {
                Sent::Text(text) => Some(text),
                Sent::Binary(_) => None,
            })
            .collect()
    }

    fn binaries(&self) -> Vec<Vec<u8>> {
        self.sent()
            .into_iter()
            .filter_map(|item| match item {
                Sent::Binary(bytes) => Some(bytes),
                Sent::Text(_) => None,
            })
            .collect()
    }

    /// The `type` of every JSON text frame sent, in order.
    fn types(&self) -> Vec<String> {
        self.texts().iter().filter_map(|text| parsed(text).get("type").and_then(Value::as_str).map(str::to_owned)).collect()
    }

    /// Every JSON text frame of one type.
    fn frames_of(&self, kind: &str) -> Vec<Value> {
        self.texts().iter().map(|text| parsed(text)).filter(|value| value.get("type").and_then(Value::as_str) == Some(kind)).collect()
    }

    fn closed(&self) -> Option<(u16, String)> {
        self.inner().closed.clone()
    }

    fn pings(&self) -> usize {
        self.inner().pings
    }

    fn set_buffered(&self, bytes: usize) {
        self.inner().buffered = bytes;
    }

    fn set_open(&self, open: bool) {
        self.inner().open = open;
    }

    fn uplink_held(&self) -> bool {
        self.inner().uplink_held
    }

    /// Hold every flush callback from now on, as a congested peer does: `buffered_amount` is what is held.
    fn hold_flushes(&self) {
        self.inner().holding = true;
    }

    fn pending(&self) -> usize {
        self.inner().held.len()
    }

    /// Release the oldest `count` held frames first.
    fn flush(&self, count: usize) {
        for _ in 0..count {
            let released = {
                let mut inner = self.inner();
                let item = inner.held.pop_front();
                if let Some((size, _)) = &item {
                    inner.buffered -= size;
                }
                item
            };
            match released {
                Some((_, Some(callback))) => callback(Ok(())),
                Some((_, None)) => {}
                None => return,
            }
        }
    }

    fn flush_all(&self) {
        let count = self.pending();
        self.flush(count);
    }
}

impl LegSocket for Fake {
    fn is_open(&self) -> bool {
        self.inner().open
    }

    fn buffered_amount(&self) -> usize {
        self.inner().buffered
    }

    fn send_text(&self, text: Bytes, on_flushed: Option<FlushCallback>) {
        let size = text.len();
        self.push(Sent::Text(String::from_utf8_lossy(&text).into_owned()), size, on_flushed);
    }

    fn send_binary(&self, data: Bytes, on_flushed: Option<FlushCallback>) {
        let size = data.len();
        self.push(Sent::Binary(data.to_vec()), size, on_flushed);
    }

    fn ping(&self) {
        self.inner().pings += 1;
    }

    fn close(&self, code: u16, reason: &[u8]) {
        self.inner().closed = Some((code, String::from_utf8_lossy(reason).into_owned()));
    }

    fn terminate(&self) {
        self.inner().open = false;
    }

    fn hold_uplink(&self, hold: bool) {
        self.inner().uplink_held = hold;
    }

    fn read_held(&self) -> bool {
        self.inner().uplink_held
    }
}

// ---- rigs ----

fn parsed(text: &str) -> Value {
    mixdog_relay::js::parse(text).expect("a JSON frame")
}

fn wire(value: &Value) -> Bytes {
    Bytes::from(mixdog_relay::js::wire(value))
}

fn millis(ms: u64) -> Duration {
    Duration::from_millis(ms)
}

/// A desktop leg wired the way the server wires it: a 64 KiB capacity ceiling and a quick handshake watchdog.
fn config() -> HubConfig {
    HubConfig {
        max_frame_bytes: 1024,
        uplink_capacity_ceiling: 64 * 1024,
        handshake: HandshakeTiming { stall: millis(30), probe: millis(30) },
        ..HubConfig::default()
    }
}

/// A watchdog that never fires within a test.
fn patient(mut config: HubConfig) -> HubConfig {
    config.handshake = HandshakeTiming { stall: millis(60_000), probe: millis(30) };
    config
}

struct Rig {
    hub: Arc<Hub>,
    _dir: tempfile::TempDir,
}

fn desktop(hub: &Arc<Hub>, device: &str) -> (Arc<Fake>, DesktopHandle) {
    let socket = Fake::new();
    let handle = hub.attach_desktop(device, socket.clone(), None);
    (socket, handle)
}

fn phone(hub: &Arc<Hub>, device: &str, browser: Option<&str>) -> (Arc<Fake>, PhoneHandle) {
    phone_with(hub, device, PhoneOptions { browser_client_id: browser.map(str::to_owned), ..PhoneOptions::default() })
}

fn phone_with(hub: &Arc<Hub>, device: &str, options: PhoneOptions) -> (Arc<Fake>, PhoneHandle) {
    let socket = Fake::new();
    let handle = hub.attach_phone(device, socket.clone(), options).expect("a desktop leg is live");
    (socket, handle)
}

async fn settle() {
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }
}

async fn send(handle: &DesktopHandle, frame: &Value) {
    handle.frame(wire(frame), false).await;
}

async fn send_binary(handle: &DesktopHandle, client: &str, data: &[u8], droppable: bool) {
    handle.frame(Bytes::from(encode_frame(client, data, droppable, false).expect("a routing id")), true).await;
}

fn delivered(phone: &Fake, data: &[u8]) -> bool {
    phone.sent().iter().any(|item| matches!(item, Sent::Binary(bytes) if bytes.as_slice() == data))
}

fn resync_hints(phone: &Fake) -> usize {
    phone.texts().iter().filter(|text| text.as_str() == "{\"resync\":1}").count()
}

/// A PC leg with one attached phone, whose queue the test sets.
struct Routed {
    _rig: Rig,
    desktop: Arc<Fake>,
    handle: DesktopHandle,
    phone: Arc<Fake>,
    phone_handle: PhoneHandle,
    client: String,
}

impl Routed {
    async fn binary(&self, data: &[u8], droppable: bool) {
        send_binary(&self.handle, &self.client, data, droppable).await;
    }

    async fn text(&self, data: &str, droppable: bool) {
        send(&self.handle, &json!({ "type": "frame", "clientId": self.client, "data": data, "droppable": droppable })).await;
    }

    async fn broadcast(&self, data: &str, critical: bool) {
        send(&self.handle, &json!({ "type": "broadcast", "data": data, "critical": critical })).await;
    }
}

#[test]
fn a_transport_frame_is_recognised_by_its_magic_in_clear_and_nothing_else() {
    let mut transport = TRANSPORT.to_vec();
    transport.extend_from_slice(&[7; 64]);
    let mut legacy = LEGACY.to_vec();
    legacy.extend_from_slice(&[9; 64]);
    assert!(envelope::is_transport_frame(&transport));
    assert!(!envelope::is_transport_frame(&legacy));
    assert!(!envelope::is_transport_frame(&[0x4d, 0x58, 0x54, 0x02]));
    assert!(!envelope::is_transport_frame(&[0x4d, 0x58, 0x54]));
    assert!(!envelope::is_transport_frame(&[]));
}

fn transport_bytes() -> Vec<u8> {
    let mut bytes = TRANSPORT.to_vec();
    bytes.extend_from_slice(&[7; 64]);
    bytes
}

fn legacy_bytes() -> Vec<u8> {
    let mut bytes = LEGACY.to_vec();
    bytes.extend_from_slice(&[9; 64]);
    bytes
}

/// Transport frame number `n`: `MXT\x01`, u16 n, padding up to `size` bytes.
fn numbered(n: u16, size: usize) -> Vec<u8> {
    let mut frame = vec![(n & 0xff) as u8; size];
    frame[..6].copy_from_slice(&[0x4d, 0x58, 0x54, 0x01, (n >> 8) as u8, (n & 0xff) as u8]);
    frame
}

fn number_of(frame: &[u8]) -> u16 {
    u16::from_be_bytes([frame[4], frame[5]])
}

fn transport_numbers(sent: &[Sent]) -> Vec<u16> {
    sent.iter()
        .filter_map(|item| match item {
            Sent::Binary(bytes) if envelope::is_transport_frame(bytes) => Some(number_of(bytes)),
            _ => None,
        })
        .collect()
}

impl Routed {
    fn hub(&self) -> &Arc<Hub> {
        &self._rig.hub
    }
}

async fn declare(handle: &DesktopHandle, bytes: usize) {
    send(handle, &json!({ "type": "desktop-lanes", "media": false, "maxPayloadBytes": bytes })).await;
}

/// A phone's frame of `bytes` bytes on its desktop's leg; returns what the leg received.
fn uplink_of(phone: &PhoneHandle, desktop: &Fake, bytes: usize) -> Vec<usize> {
    let before = desktop.binaries().len();
    phone.frame(Bytes::from(vec![1; bytes]), true);
    desktop.binaries()[before..].iter().filter_map(|raw| decode_frame(raw).map(|decoded| decoded.data.len())).collect()
}

// ---- the control frames and the registrations ----

struct Recorder {
    calls: Mutex<Vec<String>>,
}

impl RevokeHook for Recorder {
    fn device_revoked(&self, device_id: &str) {
        self.calls.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(format!("device:{device_id}"));
    }

    fn client_revoked(&self, device_id: &str, client_id: &str) {
        self.calls.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(format!("client:{device_id}:{client_id}"));
    }
}

fn recording_handler(seen: &Arc<Mutex<Vec<Value>>>) -> Handler {
    let seen = Arc::clone(seen);
    Arc::new(move |call: LegCall| -> HandlerFuture {
        let seen = Arc::clone(&seen);
        Box::pin(async move {
            seen.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(call.message);
        })
    })
}

fn io() -> mixdog_rt::DurabilityIo {
    mixdog_rt::testing::tokens().durability_io
}
async fn rig(config: HubConfig) -> Rig {
    let dir = tempfile::tempdir().expect("a temporary directory");
    let store = DeviceStore::open(dir.path(), io()).await.expect("the store opens");
    Rig { hub: Hub::new(store, config, IngressPool::new()), _dir: dir }
}
/// Let `ms` of the paused clock pass and run what became due.
async fn step(ms: u64) {
    tokio::time::advance(millis(ms)).await;
    settle().await;
}
/// Let `ms` pass the way a running process lives it: in slices short enough that a timer which a due timer arms is armed at the
/// instant its parent fired (one jump of the paused clock arms it at the end of the jump, which no process ever sees).
async fn elapse(ms: u64) {
    let mut left = ms;
    while left > 0 {
        let slice = left.min(5);
        step(slice).await;
        left -= slice;
    }
}
async fn routed(buffered: usize, max_frame_bytes: usize, inflight_ceiling: usize) -> Routed {
    let rig = rig(patient(HubConfig { max_frame_bytes, ..config() })).await;
    let (desktop, handle) = desktop(&rig.hub, "dev");
    let (phone, phone_handle) =
        phone_with(&rig.hub, "dev", PhoneOptions { browser_client_id: Some("browser-1".into()), inflight_ceiling, ..PhoneOptions::default() });
    phone.set_buffered(buffered);
    let client = phone_handle.client_id().to_owned();
    Routed { _rig: rig, desktop, handle, phone, phone_handle, client }
}
// ---- the desktop leg and the hub ----

#[tokio::test]
async fn a_phone_is_announced_to_the_desktop_and_leaves_its_entry_when_it_closes() {
    let rig = rig(config()).await;
    let (desktop, _handle) = desktop(&rig.hub, "dev");
    let (_socket, phone) = phone(&rig.hub, "dev", Some("browser-1"));
    assert_eq!(rig.hub.client_count("dev"), 1);
    let open = &desktop.frames_of("client-open")[0];
    assert!(open["clientId"].is_string());
    assert_eq!(open["clientId"], phone.client_id());
    // The authenticated credential rides along so the desktop can key trust on it.
    assert_eq!(open["browserClientId"], "browser-1");
    phone.closed(1000, b"background");
    assert_eq!(rig.hub.client_count("dev"), 0);
    let close = &desktop.frames_of("client-close")[0];
    assert_eq!(close["clientId"], open["clientId"]);
    assert_eq!((&close["code"], &close["reason"]), (&json!(1000), &json!("background")), "the PC is told who hung up");
    assert_eq!(desktop.types(), ["relay-capabilities", "client-open", "client-close"]);
}
#[tokio::test]
async fn a_desktop_leg_publishes_capabilities_and_replays_the_live_phone_ids() {
    let rig = rig(config()).await;
    let (_first, _first_handle) = desktop(&rig.hub, "dev");
    let (_socket, phone) = phone(&rig.hub, "dev", Some("browser-1"));
    let (second, _second_handle) = desktop(&rig.hub, "dev");
    let types = second.types();
    assert_eq!(types[0], "relay-capabilities");
    assert_eq!(types[1], "client-open");
    let open = &second.frames_of("client-open")[0];
    assert_eq!(open["clientId"], phone.client_id());
    assert_eq!(open["browserClientId"], "browser-1");
}
#[tokio::test(start_paused = true)]
async fn a_phone_the_pc_rejected_never_holds_the_pc_to_a_handshake_turn_even_if_it_withholds_its_close() {
    let rig = rig(config()).await;
    let (desktop, handle) = desktop(&rig.hub, "dev");
    // A phone that never acknowledges the relay's close: no close event, so it stays in the entry.
    let (socket, phone) = phone(&rig.hub, "dev", Some("browser-1"));
    send(&handle, &json!({ "type": "close-client", "clientId": phone.client_id(), "reason": "limit" })).await;
    assert_eq!(socket.closed(), Some((DESKTOP_REJECTED_CLIENT, "limit".to_owned())));
    step(150).await;
    assert_eq!(desktop.closed(), None, "the PC answered the phone with a rejection; its leg stays up");
    assert_eq!(desktop.pings(), 0, "no liveness probe for a turn that was answered");

    // A replacement leg is not told about the closing phone, and owes it nothing.
    let (replacement, _replacement_handle) = self::desktop(&rig.hub, "dev");
    assert!(!replacement.types().contains(&"client-open".to_owned()), "a closing phone is never replayed");
    step(150).await;
    assert_eq!(replacement.closed(), None);
}
#[tokio::test(start_paused = true)]
async fn a_missed_handshake_turn_closes_the_pc_leg_only_when_the_leg_is_also_silent_through_a_probe() {
    // Live PC: busy with other traffic while one phone's challenge is late.
    {
        let rig = rig(config()).await;
        let (desktop, handle) = desktop(&rig.hub, "dev");
        let (_phone_socket, _phone) = phone(&rig.hub, "dev", Some("browser-1"));
        for _ in 0..30 {
            step(5).await;
            send(&handle, &json!({ "type": "desktop-name", "name": "PC" })).await;
        }
        assert_eq!(desktop.closed(), None, "a slow handshake on a responsive PC never costs the shared leg");
    }
    // Quiet but alive PC: it answers the probe.
    {
        let rig = rig(config()).await;
        let (desktop, handle) = desktop(&rig.hub, "dev");
        let (_phone_socket, _phone) = phone(&rig.hub, "dev", Some("browser-1"));
        let mut ponged = false;
        let mut pinged_at = None;
        for tick in 0..30u64 {
            step(5).await;
            if desktop.pings() == 1 && pinged_at.is_none() {
                pinged_at = Some(tick);
            }
            if let Some(at) = pinged_at
                && !ponged
                && tick > at
            {
                handle.pong();
                ponged = true;
            }
        }
        assert_eq!(desktop.pings(), 1, "the silent leg is probed once");
        assert_eq!(desktop.closed(), None, "a leg that answers its probe stays up");
    }
    // Dead PC: silent through the turn and the probe.
    {
        let rig = rig(config()).await;
        let (desktop, _handle) = desktop(&rig.hub, "dev");
        let (phone_socket, _phone) = phone(&rig.hub, "dev", Some("browser-1"));
        elapse(150).await;
        assert_eq!(desktop.pings(), 1);
        assert_eq!(desktop.closed().map(|(code, _)| code), Some(DESKTOP_HANDSHAKE_STALLED));
        assert_eq!(phone_socket.closed(), None, "the phone keeps its socket through the redial");
    }
}
#[tokio::test(start_paused = true)]
async fn parked_phones_are_told_once_when_the_pc_leg_closes_then_once_a_second_per_phone_while_calls_go_nowhere() {
    let rig = rig(patient(config())).await;
    let (desktop, handle) = desktop(&rig.hub, "dev");
    let (first, first_phone) = phone(&rig.hub, "dev", Some("browser-1"));
    let (second, _second_phone) = phone(&rig.hub, "dev", Some("browser-2"));
    let notice = "{\"resync\":\"desktop-gone\"}".to_owned();

    // A live PC: calls are carried and nobody is told anything.
    first_phone.frame(Bytes::from_static(b"{\"call\":1}"), false);
    assert!(first.texts().is_empty());

    // The PC leg closes: every parked phone hears it, in the cleartext resync shape.
    desktop.set_open(false);
    handle.closed();
    assert_eq!(first.texts(), [notice.clone()]);
    assert_eq!(second.texts(), [notice.clone()]);

    // Calls into the gap are told again, but never more than once a second.
    step(5_000).await;
    first_phone.frame(Bytes::from_static(b"{\"call\":2}"), false);
    first_phone.frame(Bytes::from_static(b"{\"call\":3}"), false);
    first_phone.frame(Bytes::from_static(&[1, 2, 3]), true);
    assert_eq!(first.texts(), [notice.clone(), notice.clone()]);
    assert_eq!(second.texts(), [notice.clone()], "a quiet phone is not told again");
    step(1_000).await;
    first_phone.frame(Bytes::from_static(b"{\"call\":4}"), false);
    assert_eq!(first.texts(), [notice.clone(), notice.clone(), notice.clone()]);

    // Pings are still answered by the relay and are not calls.
    step(5_000).await;
    first_phone.frame(Bytes::from_static(b"{\"ping\":1}"), false);
    assert_eq!(first.texts().last().map(String::as_str), Some("{\"pong\":1}"));
    assert_eq!(first.texts().len(), 4);
}
#[tokio::test]
async fn a_superseded_pc_leg_closing_does_not_tell_phones_the_pc_is_gone() {
    let rig = rig(patient(config())).await;
    let (old, old_handle) = desktop(&rig.hub, "dev");
    let (phone_socket, _phone) = phone(&rig.hub, "dev", Some("browser-1"));
    let (_replacement, _replacement_handle) = desktop(&rig.hub, "dev");
    assert_eq!(old.closed(), Some((SUPERSEDED, "superseded".to_owned())));
    old.set_open(false);
    old_handle.closed();
    assert!(phone_socket.texts().is_empty());
    assert_eq!(rig.hub.client_count("dev"), 1);
}
#[tokio::test]
async fn a_transport_frame_marked_droppable_is_still_delivered_to_a_phone_past_the_push_skip_mark() {
    let route = routed(2 * MIB, 4096, 0).await;
    route.binary(&transport_bytes(), true).await;
    assert!(delivered(&route.phone, &transport_bytes()));
    assert_eq!(resync_hints(&route.phone), 0);
    assert_eq!(route.phone.closed(), None);
}
#[tokio::test]
async fn a_full_phone_queue_cuts_the_leg_for_a_transport_frame_instead_of_silently_dropping_it() {
    let route = routed(9 * MIB, 4096, 0).await;
    route.binary(&transport_bytes(), true).await;
    assert!(!delivered(&route.phone, &transport_bytes()));
    // Not a drop: no resync hint stands in for it, and the phone is told by the cut.
    assert_eq!(resync_hints(&route.phone), 0);
    assert_eq!(route.phone.closed(), Some((SLOW_PEER, "slow consumer".to_owned())));
}
#[tokio::test]
async fn a_box_that_cannot_carry_a_transport_frame_cuts_the_leg_never_defers_or_drops_it() {
    let route = routed(0, 4096, 8).await;
    route.binary(&transport_bytes(), true).await;
    assert!(!delivered(&route.phone, &transport_bytes()));
    assert_eq!(resync_hints(&route.phone), 0);
    assert_eq!(route.phone.closed(), Some((RELAY_BUSY, "relay busy".to_owned())));
}
#[tokio::test]
async fn legacy_droppable_frames_keep_dropping_skipped_past_1_mib_dropped_at_a_full_queue_with_a_resync_hint() {
    for buffered in [2 * MIB, 9 * MIB] {
        let route = routed(buffered, 4096, 0).await;
        route.binary(&legacy_bytes(), true).await;
        assert!(!delivered(&route.phone, &legacy_bytes()));
        assert_eq!(resync_hints(&route.phone), 1);
        assert_eq!(route.phone.closed(), None);
    }
}
#[tokio::test]
async fn legacy_non_droppable_frames_keep_their_behavior_delivered_when_queued_cut_at_a_full_queue() {
    let queued = routed(2 * MIB, 4096, 0).await;
    queued.binary(&legacy_bytes(), false).await;
    assert!(delivered(&queued.phone, &legacy_bytes()));
    let full = routed(9 * MIB, 4096, 0).await;
    full.binary(&legacy_bytes(), false).await;
    assert_eq!(full.phone.closed(), Some((SLOW_PEER, "slow consumer".to_owned())));
}
#[tokio::test]
async fn legacy_text_frames_and_broadcasts_keep_their_droppable_behavior() {
    let drop = routed(2 * MIB, 4096, 0).await;
    drop.text("{\"legacy\":1}", true).await;
    assert_eq!(drop.phone.texts(), ["{\"resync\":1}"]);
    let keep = routed(2 * MIB, 4096, 0).await;
    keep.text("{\"legacy\":2}", false).await;
    assert_eq!(keep.phone.texts(), ["{\"legacy\":2}"]);
    let cast = routed(2 * MIB, 4096, 0).await;
    cast.broadcast("{\"state\":1}", false).await;
    assert_eq!(cast.phone.texts(), ["{\"resync\":1}"]);
    let critical = routed(2 * MIB, 4096, 0).await;
    critical.broadcast("{\"state\":2}", true).await;
    assert_eq!(critical.phone.texts(), ["{\"state\":2}"]);
}
#[tokio::test]
async fn downstream_transport_frames_reach_a_pressured_phone_in_the_order_the_pc_sent_them_flush_by_flush() {
    let route = routed(0, 2 * MIB, 0).await;
    route.phone.hold_flushes();
    let frame = |n: u16| numbered(n, 700 * 1024);
    // The sender's droppable flag varies; a legacy droppable frame sent while the phone is past the push-skip mark is dropped, and
    // never lands between transport frames or moves them.
    route.binary(&frame(1), true).await;
    route.binary(&frame(2), false).await;
    route.binary(&legacy_bytes(), true).await;
    route.binary(&frame(3), true).await;
    route.binary(&frame(4), false).await;
    assert!(route.phone.sent().len() > 4);
    assert!(route.phone.inner().buffered > MIB, "the phone is under real pressure");
    assert_eq!(transport_numbers(&route.phone.sent()), [1, 2, 3, 4]);
    assert!(!delivered(&route.phone, &legacy_bytes()));
    // Flushes release oldest first; frames sent meanwhile queue behind the rest.
    route.phone.flush(2);
    route.binary(&frame(5), true).await;
    route.binary(&frame(6), false).await;
    route.phone.flush(1);
    route.binary(&frame(7), true).await;
    assert_eq!(transport_numbers(&route.phone.sent()), (1..=7).collect::<Vec<u16>>());
    route.phone.flush_all();
    route.binary(&frame(8), false).await;
    assert_eq!(transport_numbers(&route.phone.sent()), (1..=8).collect::<Vec<u16>>());
    route.phone.flush_all();
    assert_eq!(route.phone.closed(), None);
    assert_eq!(route.phone.inner().buffered, 0);
}
#[tokio::test]
async fn upstream_transport_frames_reach_the_pc_in_the_order_the_phone_sent_them_flush_by_flush() {
    let route = routed(0, 128 * 1024, 0).await;
    let base = route.desktop.sent().len();
    route.desktop.hold_flushes();
    let arrived = |route: &Routed| -> Vec<u16> {
        route.desktop.binaries()[..]
            .iter()
            .filter_map(|raw| decode_frame(raw))
            .map(|decoded| {
                assert_eq!(decoded.client_id, route.client);
                number_of(decoded.data)
            })
            .collect()
    };
    let up = |n: u16| route.phone_handle.frame(Bytes::from(numbered(n, 60_000)), true);
    for n in 1..=6 {
        up(n);
    }
    assert_eq!(arrived(&route), (1..=6).collect::<Vec<u16>>());
    route.desktop.flush(4);
    for n in 7..=9 {
        up(n);
    }
    assert_eq!(arrived(&route), (1..=9).collect::<Vec<u16>>());
    route.desktop.flush_all();
    up(10);
    assert_eq!(arrived(&route), (1..=10).collect::<Vec<u16>>());
    route.desktop.flush_all();
    assert_eq!(route.phone.closed(), None);
    assert_eq!(route.hub().client_count("dev"), 1);
    assert!(route.desktop.sent().len() > base);
}
#[tokio::test]
async fn upstream_an_exhausted_queue_cuts_the_phone_leg_after_a_contiguous_prefix_never_a_silent_loss() {
    let route = routed(0, 128 * 1024, 0).await;
    let base = route.desktop.sent().len();
    route.desktop.hold_flushes();
    let mut sent_count: u16 = 0;
    // The PC does not drain: nothing flushes. The phone keeps sending until the relay refuses; it must refuse by cutting the leg.
    while route.phone.closed().is_none() && sent_count < 400 {
        sent_count += 1;
        route.phone_handle.frame(Bytes::from(numbered(sent_count, 60_000)), true);
    }
    assert_eq!(route.phone.closed(), Some((SLOW_PEER, "slow consumer".to_owned())));
    assert!(route.phone.uplink_held(), "past 2 MiB outstanding the phone stops being read");
    let numbers: Vec<u16> = route.desktop.sent()[base..]
        .iter()
        .filter_map(|item| match item {
            Sent::Binary(raw) => decode_frame(raw).map(|decoded| number_of(decoded.data)),
            Sent::Text(_) => None,
        })
        .collect();
    // What the PC got is exactly frames 1..k, in order, no hole; the frame that met the full queue (and anything after it) was not
    // delivered, and the leg was cut at that very frame.
    assert!(numbers.len() > 100 && numbers.len() < usize::from(sent_count), "delivered {} of {sent_count}", numbers.len());
    assert_eq!(numbers, (1..=u16::try_from(numbers.len()).expect("fits")).collect::<Vec<u16>>());
    assert_eq!(usize::from(sent_count), numbers.len() + 1);
    assert!(route.desktop.pending() >= numbers.len(), "every delivered frame was still unflushed when the leg was cut");
    assert!(numbers.len() * 60_000 <= 8 * MIB);
    // The socket reports its close; only this phone is cut, the shared PC leg stays up and is told the phone left.
    route.phone_handle.closed(SLOW_PEER, b"slow consumer");
    assert_eq!(route.desktop.closed(), None);
    assert_eq!(route.hub().client_count("dev"), 0);
    assert_eq!(route.desktop.frames_of("client-close").len(), 1);
    route.desktop.flush_all();
}
#[tokio::test]
async fn client_open_omits_the_credential_when_the_leg_has_none_older_desktops() {
    let rig = rig(config()).await;
    let (desktop, _handle) = desktop(&rig.hub, "dev");
    let (_socket, _phone) = phone(&rig.hub, "dev", None);
    let open = &desktop.frames_of("client-open")[0];
    assert!(open.get("browserClientId").is_none());
}
// ---- the legs without HTTP ----

#[tokio::test]
async fn a_phone_survives_a_desktop_leg_redial_and_is_re_announced() {
    let rig = rig(patient(config())).await;
    let (first, first_handle) = desktop(&rig.hub, "dev");
    let (phone_socket, phone) = phone(&rig.hub, "dev", Some("bbbbbbbb"));
    first.set_open(false);
    first_handle.closed();
    assert_eq!(phone_socket.closed(), None);
    let (second, _second_handle) = desktop(&rig.hub, "dev");
    assert_eq!(second.frames_of("client-open")[0]["clientId"], phone.client_id());
    assert_eq!(phone_socket.closed(), None);
    assert_eq!(rig.hub.client_count("dev"), 1);
}
#[tokio::test(start_paused = true)]
async fn a_handshake_turn_stall_closes_the_pc_leg_so_it_redials() {
    let rig = rig(config()).await;
    let (phone_socket, phone) = {
        let (_anchor, _handle) = desktop(&rig.hub, "dev");
        phone(&rig.hub, "dev", Some("bbbbbbbb"))
    };
    let client = phone.client_id().to_owned();

    // A desktop that answers both of its turns keeps its leg.
    let (healthy, healthy_handle) = desktop(&rig.hub, "dev");
    send(&healthy_handle, &json!({ "type": "frame", "clientId": client, "data": "{\"challenge\":\"c\"}" })).await;
    assert_eq!(phone_socket.texts().last().map(String::as_str), Some("{\"challenge\":\"c\"}"));
    phone.frame(Bytes::from_static(b"{\"hello\":1}"), false);
    assert!(healthy.frames_of("frame").len() == 1);
    send(&healthy_handle, &json!({ "type": "frame", "clientId": client, "data": "{\"ready\":1}" })).await;
    elapse(90).await;
    assert_eq!(healthy.closed(), None, "an answered handshake leaves the leg alone");

    // A leg that neither takes its turn nor answers the probe is dead: the relay closes the leg, never the phone.
    let (silent, _silent_handle) = desktop(&rig.hub, "dev");
    elapse(150).await;
    assert_eq!(silent.closed().map(|(code, _)| code), Some(DESKTOP_HANDSHAKE_STALLED));

    // A leg that sends the challenge but never answers the hello is cut too, and the clock for the answer starts at the hello.
    let (halfway, halfway_handle) = desktop(&rig.hub, "dev");
    step(5).await;
    send(&halfway_handle, &json!({ "type": "frame", "clientId": client, "data": "{\"challenge\":\"d\"}" })).await;
    elapse(20).await;
    assert_eq!(halfway.closed(), None, "no clock runs while the phone owes its hello");
    phone.frame(Bytes::from_static(b"{\"hello\":2}"), false);
    elapse(40).await;
    assert_eq!(halfway.closed(), None);
    elapse(30).await;
    assert_eq!(halfway.closed().map(|(code, _)| code), Some(DESKTOP_HANDSHAKE_STALLED));
    assert_eq!(phone_socket.closed(), None, "the waiting phone keeps its socket through the redial");
}
#[tokio::test(start_paused = true)]
async fn the_parked_phones_of_a_gone_pc_are_closed_4002_after_the_grace() {
    assert_eq!(DESKTOP_OFFLINE, 4002);
    for revoking in [4003, 4004, 4005] {
        assert_ne!(DESKTOP_OFFLINE, revoking);
    }
    for taken in [4000, 4002, 4003, 4004, 4005, 4008, 4009] {
        assert_ne!(DESKTOP_HANDSHAKE_STALLED, taken);
    }
    // A parked phone outlives the PC's absence by 45 s, and is then closed with that code.
    let rig = rig(patient(config())).await;
    let (desktop, handle) = desktop(&rig.hub, "dev");
    let (phone_socket, _phone) = phone(&rig.hub, "dev", Some("bbbbbbbb"));
    desktop.set_open(false);
    handle.closed();
    elapse(44_000).await;
    assert_eq!(phone_socket.closed(), None);
    assert_eq!(rig.hub.client_count("dev"), 1);
    elapse(1_500).await;
    assert_eq!(phone_socket.closed(), Some((DESKTOP_OFFLINE, "desktop offline".to_owned())));
    assert!(rig.hub.desktop_info("dev").is_none());
}
/// A receiver that takes 4400 bytes and a 3050-byte text message, which only fits when the wrapper is the fixed one.
const TEXT_ENVELOPE_CAPACITY: usize = 4400;

async fn text_envelope_rig() -> (Rig, String) {
    let rig = rig(patient(HubConfig { max_frame_bytes: MIB, uplink_capacity_ceiling: TEXT_ENVELOPE_CAPACITY, ..config() })).await;
    (rig, "t".repeat(3050))
}

#[tokio::test]
async fn a_leg_that_declares_no_text_envelope_is_never_acknowledged_one() {
    let capacity = TEXT_ENVELOPE_CAPACITY;
    let (rig, payload) = text_envelope_rig().await;

    // A leg that declares nothing is answered with nothing extra: one capabilities frame, and no acknowledgement to infer anything from.
    let (legacy, _legacy_handle) = desktop(&rig.hub, "legacy");
    let caps = legacy.frames_of("relay-capabilities");
    assert_eq!(caps.len(), 1);
    assert_eq!(caps[0]["binaryFrames"], 1);
    assert!(caps[0].get("textFrames").is_none());
    assert_eq!(caps[0]["uplinkCapacityBytes"], capacity);
    assert_eq!(caps[0]["uplinkBinaryCeilingBytes"], capacity - 42);
    // JSON worst case, floor((4400 - 76) / 6): the ceiling the reviewer measured.
    assert_eq!(caps[0]["uplinkTextCeilingBytes"], 720);
    let (legacy_phone_socket, legacy_phone) = phone(&rig.hub, "legacy", Some("bbbbbbbb"));
    legacy_phone.frame(Bytes::from(payload.clone()), false);
    // Published equals enforced: the frame a fixed-wrapper guess would have passed is refused at exactly the advertised ceiling, and
    // never forwarded.
    let refusals = legacy_phone_socket.texts();
    assert_eq!(refusals.len(), 1);
    let refusal = parsed(&refusals[0]);
    assert_eq!(refusal["error"], "frame-too-large");
    assert_eq!(refusal["limit"], 720);
    assert!(legacy.binaries().is_empty());
    assert!(legacy.frames_of("frame").is_empty());
    assert_eq!(legacy.closed(), None);
}

#[tokio::test]
async fn a_leg_that_declares_the_text_envelope_is_answered_on_that_connection() {
    let capacity = TEXT_ENVELOPE_CAPACITY;
    let (rig, payload) = text_envelope_rig().await;
    let (modern, modern_handle) = desktop(&rig.hub, "modern");
    send(&modern_handle, &json!({ "type": "desktop-lanes", "media": false, "textFrames": 1, "maxPayloadBytes": capacity })).await;
    let caps = modern.frames_of("relay-capabilities");
    assert_eq!(caps.len(), 2);
    let ack = &caps[1];
    assert_eq!(ack["textFrames"], 1);
    assert_eq!(ack["uplinkCapacityBytes"], capacity);
    assert_eq!(ack["uplinkBinaryCeilingBytes"], capacity - 42);
    // With the acknowledgement the text path IS the binary path.
    assert_eq!(ack["uplinkTextCeilingBytes"], capacity - 42);
    let (modern_phone_socket, modern_phone) = phone(&rig.hub, "modern", Some("bbbbbbbb"));
    modern_phone.frame(Bytes::from(payload.clone()), false);
    let arrived = modern.binaries();
    assert_eq!(arrived.len(), 1);
    let decoded = decode_frame(&arrived[0]).expect("a routing envelope");
    assert!(decoded.text, "the envelope says the payload is text");
    assert_eq!(decoded.data, payload.as_bytes());
    assert!(modern_phone_socket.texts().is_empty());
    // ...and the acknowledged ceiling is what that leg enforces, too.
    modern_phone.frame(Bytes::from("t".repeat(capacity)), false);
    let refusals = modern_phone_socket.texts();
    assert_eq!(refusals.len(), 1);
    assert_eq!(parsed(&refusals[0])["limit"], capacity - 42);
    assert_eq!(modern.binaries().len(), 1);
    assert_eq!(modern.closed(), None);
}
#[tokio::test]
async fn a_claim_is_trusted_on_the_connection_that_made_it_and_on_no_other() {
    let rig = rig(patient(HubConfig { max_frame_bytes: MIB, uplink_capacity_ceiling: 4 * MIB, ..config() })).await;
    let (first, first_handle) = desktop(&rig.hub, "dev");
    // This leg ENFORCES 64 KiB and CLAIMS 128 KiB: a lie, or a build whose declaration drifted from its own receiver.
    declare(&first_handle, 128 * 1024).await;
    let (phone_socket, phone) = phone(&rig.hub, "dev", Some("bbbbbbbb"));
    // Inside the claim, past the real receiver: the claim is trusted on the connection that made it, so the frame goes out. The leg dies
    // of it, and NO client is accused: the relay cannot know which frame the receiver refused.
    assert_eq!(uplink_of(&phone, &first, 64 * 1024), [64 * 1024]);
    first.set_open(false);
    first_handle.closed();
    assert!(phone_socket.texts().iter().all(|text| !text.contains("frame-too-large")));
    assert_eq!(phone_socket.closed(), None);

    // The desktop redials and repeats the same claim: it is believed again. What must never happen is the verdict outliving the
    // connection that earned it.
    let (second, second_handle) = desktop(&rig.hub, "dev");
    declare(&second_handle, 128 * 1024).await;
    assert_eq!(uplink_of(&phone, &second, 64 * 1024), [64 * 1024]);
    second.set_open(false);
    second_handle.closed();

    // An honest claim on a fresh connection is a new statement and is trusted in full, with no penalty inherited from either failure
    // before it.
    let (third, third_handle) = desktop(&rig.hub, "dev");
    declare(&third_handle, 256 * 1024).await;
    assert_eq!(uplink_of(&phone, &third, 64 * 1024), [64 * 1024]);
    assert!(phone_socket.texts().iter().all(|text| !text.contains("frame-too-large")));
    assert_eq!(third.closed(), None);
}
#[tokio::test]
async fn a_redialed_leg_carries_nothing_it_has_not_declared_on_that_connection() {
    let rig = rig(patient(HubConfig { max_frame_bytes: MIB, uplink_capacity_ceiling: 4 * MIB, ..config() })).await;
    let (first, first_handle) = desktop(&rig.hub, "dev");
    send(&first_handle, &json!({ "type": "desktop-lanes", "media": false, "maxPayloadBytes": 128 * 1024 })).await;
    let (phone_socket, phone) = phone(&rig.hub, "dev", Some("bbbbbbbb"));
    assert_eq!(uplink_of(&phone, &first, 64 * 1024), [64 * 1024]);
    first.set_open(false);
    first_handle.closed();

    // The replacement leg has declared NOTHING yet. Handing it the previous leg's roomy default is what killed a second connection
    // with the very same frame; an undeclared connection is held to the floor instead, so the phone is answered and the leg survives.
    let (second, _second_handle) = desktop(&rig.hub, "dev");
    assert!(uplink_of(&phone, &second, 64 * 1024).is_empty());
    let refusals = phone_socket.texts().into_iter().map(|text| parsed(&text)).filter(|v| v["error"] == "frame-too-large").collect::<Vec<_>>();
    assert_eq!(refusals.len(), 1);
    assert_eq!(refusals[0]["bytes"], 64 * 1024);
    assert_eq!(refusals[0]["limit"], 64 * 1024 - 42);
    assert!(second.binaries().is_empty());
    assert_eq!(second.closed(), None);
    assert_eq!(phone_socket.closed(), None);

    // The floor is where every connection starts, so losing state can never upgrade a peer's trust; the next leg to declare an honest
    // number is believed on the spot.
    let (third, third_handle) = desktop(&rig.hub, "dev");
    send(&third_handle, &json!({ "type": "desktop-lanes", "media": false, "maxPayloadBytes": 256 * 1024 })).await;
    assert_eq!(uplink_of(&phone, &third, 64 * 1024), [64 * 1024]);
}
#[tokio::test]
async fn a_critical_fan_out_defers_what_the_box_cannot_carry_and_closes_no_healthy_leg() {
    // A box budget that cannot hold this broadcast for all 32 legs at once: the shape that used to close 30 of them with 4009.
    let inflight = 256 * 1024;
    let rig = rig(patient(HubConfig { max_frame_bytes: 4 * MIB, max_inflight_bytes: inflight, ..config() })).await;
    let (desktop, handle) = desktop(&rig.hub, "dev");
    let mut legs = Vec::new();
    for index in 0..32 {
        let (socket, handle) = phone_with(
            &rig.hub,
            "dev",
            PhoneOptions { browser_client_id: Some(format!("{index:08x}")), inflight_ceiling: inflight, ..PhoneOptions::default() },
        );
        // Flush callbacks run only once the loop has ended, as on a real socket.
        socket.hold_flushes();
        legs.push((socket, handle));
    }
    // Critical: a full snapshot is the recovery frame, so it is never dropped silently, but the whole fan-out runs before ONE flush
    // callback can release, so the ceiling it fills is the loop's own doing.
    send(&handle, &json!({ "type": "broadcast", "critical": true, "data": "x".repeat(120 * 1024) })).await;
    let served = legs.iter().filter(|(socket, _)| socket.texts().iter().any(|text| text.starts_with('x'))).count();
    let deferred = legs.iter().filter(|(socket, _)| resync_hints(socket) > 0).count();
    // The ceiling really was reached: 2 x 120 KiB fits in 256 KiB, the rest does not.
    assert_eq!(served, 2);
    assert_eq!(deferred, legs.len() - served);
    for (socket, _) in &legs {
        // Every leg is still here. A deferred one was told to resync, which is how it recovers the snapshot it did not get.
        assert_eq!(socket.closed(), None);
    }
    assert_eq!(desktop.closed(), None);
    for (socket, _) in &legs {
        socket.flush_all();
    }
    // Nothing leaked out of the accounting once the served legs drained.
    assert_eq!(rig.hub.meter().bytes(), 0);
}
#[tokio::test]
async fn a_revocation_that_cannot_persist_keeps_the_leg_and_a_real_one_closes_everything() {
    let rig = rig(patient(config())).await;
    let recorder = Arc::new(Recorder { calls: Mutex::new(Vec::new()) });
    rig.hub.dispatch().register_revoke_hook(recorder.clone());
    // An unknown device cannot be revoked: reported as a failure, the leg is kept.
    let (unknown, unknown_handle) = desktop(&rig.hub, "unknown-device");
    send(&unknown_handle, &json!({ "type": "revoke-device" })).await;
    assert_eq!(unknown.frames_of("device-revoked")[0]["ok"], false);
    assert_eq!(unknown.closed(), None);
    assert!(recorder.calls.lock().unwrap_or_else(std::sync::PoisonError::into_inner).is_empty());

    assert!(rig.hub.store().authenticate(DEVICE, SECRET).await);
    let (desktop, handle) = desktop(&rig.hub, DEVICE);
    let (phone_socket, _phone) = phone(&rig.hub, DEVICE, Some("bbbbbbbb"));
    send(&handle, &json!({ "type": "revoke-device" })).await;
    assert_eq!(desktop.frames_of("device-revoked")[0]["ok"], true);
    assert_eq!(desktop.closed(), Some((REVOKED, "device revoked".to_owned())));
    assert_eq!(phone_socket.closed(), Some((REVOKED, "pairing revoked".to_owned())));
    assert_eq!(*recorder.calls.lock().unwrap_or_else(std::sync::PoisonError::into_inner), [format!("device:{DEVICE}")]);
    // Nothing more this leg says is acted on.
    send(&handle, &json!({ "type": "desktop-name", "name": "after" })).await;
    assert_eq!(rig.hub.desktop_info(DEVICE).and_then(|info| info.host_name), None);
}
#[tokio::test]
async fn list_clients_marks_the_browsers_with_a_live_phone_and_revoke_client_closes_theirs() {
    let rig = rig(patient(config())).await;
    let recorder = Arc::new(Recorder { calls: Mutex::new(Vec::new()) });
    rig.hub.dispatch().register_revoke_hook(recorder.clone());
    assert!(rig.hub.store().authenticate(DEVICE, SECRET).await);
    assert!(rig.hub.store().register_client(DEVICE, "bbbbbbbb", &ProfileInput::text("Pixel", "android", "chrome")).await.is_some());
    assert!(rig.hub.store().register_client(DEVICE, "cccccccc", &ProfileInput::text("Laptop", "windows", "edge")).await.is_some());
    let (desktop, handle) = desktop(&rig.hub, DEVICE);
    let (online_socket, _online) = phone(&rig.hub, DEVICE, Some("bbbbbbbb"));
    let (other_socket, _other) = phone(&rig.hub, DEVICE, Some("cccccccc"));

    send(&handle, &json!({ "type": "list-clients", "requestId": "r1" })).await;
    let listed = &desktop.frames_of("clients-list")[0];
    assert_eq!(listed["requestId"], "r1");
    let clients = listed["clients"].as_array().expect("an array");
    assert_eq!(clients.len(), 2);
    assert!(clients.iter().all(|client| client["online"] == true));
    assert!(clients.iter().any(|client| client["id"] == "bbbbbbbb" && client["name"] == "Pixel" && client["platform"] == "android"));
    // A frame without its request id is ignored like an unknown one.
    send(&handle, &json!({ "type": "list-clients" })).await;
    assert_eq!(desktop.frames_of("clients-list").len(), 1);

    send(&handle, &json!({ "type": "revoke-client", "requestId": "r2", "clientId": "bbbbbbbb" })).await;
    let answer = &desktop.frames_of("client-revoked")[0];
    assert_eq!((answer["requestId"].as_str(), answer["ok"].as_bool()), (Some("r2"), Some(true)));
    assert_eq!(online_socket.closed(), Some((REVOKED, "pairing revoked".to_owned())));
    assert_eq!(other_socket.closed(), None);
    assert_eq!(*recorder.calls.lock().unwrap_or_else(std::sync::PoisonError::into_inner), [format!("client:{DEVICE}:bbbbbbbb")]);
    // Revoking it again changes nothing and closes nothing.
    send(&handle, &json!({ "type": "revoke-client", "requestId": "r3", "clientId": "bbbbbbbb" })).await;
    assert_eq!(desktop.frames_of("client-revoked")[1]["ok"], false);
    assert_eq!(recorder.calls.lock().unwrap_or_else(std::sync::PoisonError::into_inner).len(), 1);
}
#[tokio::test]
async fn the_frame_types_the_legs_do_not_answer_go_to_the_area_that_registered_them() {
    let rig = rig(patient(config())).await;
    let seen = Arc::new(Mutex::new(Vec::new()));
    let dispatch = rig.hub.dispatch();
    assert_eq!(dispatch.register("claim-approve", recording_handler(&seen)), Ok(()));
    assert_eq!(dispatch.register_prefix("media-", recording_handler(&seen)), Ok(()));
    assert_eq!(dispatch.register("claim-approve", recording_handler(&seen)), Err(Rejected::Taken("claim-approve".into())));
    for kind in BUILT_IN_TYPES {
        assert_eq!(dispatch.register(kind, recording_handler(&seen)), Err(Rejected::BuiltIn(kind.to_owned())));
    }
    let (_desktop, handle) = desktop(&rig.hub, "dev");
    send(&handle, &json!({ "type": "claim-approve", "claimId": "c1" })).await;
    send(&handle, &json!({ "type": "media-head", "id": "m1" })).await;
    send(&handle, &json!({ "type": "nobody-owns-this" })).await;
    // A frame that is not an object, or whose type is not a string, is ignored; so is bytes that are not JSON.
    send(&handle, &json!(7)).await;
    send(&handle, &json!({ "type": 5 })).await;
    handle.frame(Bytes::from_static(b"not json"), false).await;
    handle.frame(Bytes::from_static(b"null"), false).await;
    let kinds: Vec<String> =
        seen.lock().unwrap_or_else(std::sync::PoisonError::into_inner).iter().map(|m| m["type"].as_str().unwrap_or("").to_owned()).collect();
    assert_eq!(kinds, ["claim-approve", "media-head"]);
}
#[tokio::test]
async fn a_superseded_leg_may_answer_for_itself_but_nothing_it_says_belongs_to_the_connection_that_replaced_it() {
    let rig = rig(patient(config())).await;
    let seen = Arc::new(Mutex::new(Vec::new()));
    assert_eq!(rig.hub.dispatch().register("claim-deny", recording_handler(&seen)), Ok(()));
    let (_old, old_handle) = desktop(&rig.hub, "dev");
    let (_phone_socket, phone) = phone(&rig.hub, "dev", Some("bbbbbbbb"));
    let (_new, new_handle) = desktop(&rig.hub, "dev");
    send(&new_handle, &json!({ "type": "desktop-lanes", "media": true, "pairV2": 1 })).await;
    send(&old_handle, &json!({ "type": "desktop-lanes", "media": false })).await;
    send(&old_handle, &json!({ "type": "desktop-name", "name": "stale" })).await;
    send(&old_handle, &json!({ "type": "claim-deny", "claimId": "c1" })).await;
    send(&old_handle, &json!({ "type": "broadcast", "data": "stale", "critical": true })).await;
    send_binary(&old_handle, phone.client_id(), b"stale", false).await;
    let info = rig.hub.desktop_info("dev").expect("an entry");
    assert!(info.media_lane && info.pair_v2, "the live leg's declaration stands");
    assert_eq!(info.host_name, None);
    assert!(seen.lock().unwrap_or_else(std::sync::PoisonError::into_inner).is_empty());
    assert!(_phone_socket.sent().is_empty());
    // A redial resets the media lane and keeps what the entry knew of the pairing mode.
    let (_third, _third_handle) = desktop(&rig.hub, "dev");
    let info = rig.hub.desktop_info("dev").expect("an entry");
    assert!(!info.media_lane && info.pair_v2);
}
#[tokio::test]
async fn what_the_registered_services_publish_reaches_every_connecting_leg_and_the_close_hook_only_the_live_one() {
    let rig = rig(patient(config())).await;
    let dispatch = rig.hub.dispatch();
    dispatch.register_capability(Arc::new(|| CapabilityOffer { native_push_platforms: vec!["apns".into(), "fcm".into()], ..CapabilityOffer::default() }));
    dispatch.register_capability(Arc::new(|| CapabilityOffer { web_push: true, ice: true, ..CapabilityOffer::default() }));
    dispatch.register_connect_frame(Arc::new(|device: &str| Some(json!({ "type": "webpush-subscriptions", "device": device }))));
    let closed = Arc::new(Mutex::new(Vec::<String>::new()));
    let hook = Arc::clone(&closed);
    dispatch.register_close_hook(Arc::new(move |device: &str| hook.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(device.to_owned())));
    let (first, first_handle) = desktop(&rig.hub, "dev");
    let caps = &first.frames_of("relay-capabilities")[0];
    assert_eq!(caps["nativePush"], 1);
    assert_eq!(caps["nativePushPlatforms"], json!(["apns", "fcm"]));
    assert_eq!((caps["webPush"].clone(), caps["ice"].clone()), (json!(1), json!(1)));
    assert_eq!(first.types(), ["relay-capabilities", "webpush-subscriptions"]);
    assert_eq!(first.frames_of("webpush-subscriptions")[0]["device"], "dev");
    // A declaration that changes nothing is answered with nothing.
    send(&first_handle, &json!({ "type": "desktop-lanes", "media": false })).await;
    assert_eq!(first.frames_of("relay-capabilities").len(), 1);
    let (_second, second_handle) = desktop(&rig.hub, "dev");
    first_handle.closed();
    assert!(closed.lock().unwrap_or_else(std::sync::PoisonError::into_inner).is_empty(), "a superseded leg must not clear its replacement's pairing code");
    second_handle.closed();
    assert_eq!(*closed.lock().unwrap_or_else(std::sync::PoisonError::into_inner), ["dev"]);
}
#[tokio::test]
async fn a_frame_to_a_phone_is_sent_as_json_text_and_a_rejection_reason_is_clipped_to_120_units() {
    let rig = rig(patient(config())).await;
    let (_desktop, handle) = desktop(&rig.hub, "dev");
    let (socket, phone) = phone(&rig.hub, "dev", Some("bbbbbbbb"));
    // An id that is not a phone's routes nowhere.
    handle.frame(Bytes::from_static(br#"{"type":"frame","clientId":"12345678","data":"a"}"#.as_slice()), false).await;
    assert!(socket.texts().is_empty());
    // A lone surrogate becomes U+FFFD, as `Buffer.from(string)` writes it.
    let raw = format!(r#"{{"type":"frame","clientId":"{}","data":"a\ud83dz"}}"#, phone.client_id());
    handle.frame(Bytes::from(raw), false).await;
    assert_eq!(socket.texts(), ["a\u{fffd}z"]);
    // The rejection reason: 120 units at most.
    send(&handle, &json!({ "type": "close-client", "clientId": phone.client_id(), "reason": "x".repeat(200) })).await;
    assert_eq!(socket.closed(), Some((DESKTOP_REJECTED_CLIENT, "x".repeat(120))));
    let (fallback_socket, fallback) = self::phone(&rig.hub, "dev", Some("cccccccc"));
    send(&handle, &json!({ "type": "close-client", "clientId": fallback.client_id() })).await;
    assert_eq!(fallback_socket.closed(), Some((DESKTOP_REJECTED_CLIENT, "desktop rejected client".to_owned())));
}
#[tokio::test]
async fn an_oversize_desktop_frame_is_answered_on_that_leg_and_names_the_client() {
    let rig = rig(patient(config())).await;
    let (desktop, handle) = desktop(&rig.hub, "dev");
    let (socket, phone) = phone(&rig.hub, "dev", Some("bbbbbbbb"));
    send(&handle, &json!({ "type": "frame", "clientId": phone.client_id(), "data": "x".repeat(2000) })).await;
    let notice = &desktop.frames_of("frame-too-large")[0];
    assert_eq!(notice["clientId"], phone.client_id());
    assert_eq!(notice["limit"], 1024);
    assert!(notice["bytes"].as_u64().unwrap_or(0) > 2000);
    assert_eq!(desktop.closed(), None);
    assert!(socket.texts().is_empty());
    // A binary frame is attributed by the binary decoder that routes it.
    send_binary(&handle, phone.client_id(), &[0; 2000], false).await;
    assert_eq!(desktop.frames_of("frame-too-large")[1]["clientId"], phone.client_id());
    // A frame that names nobody is attributed to nobody.
    let before = desktop.frames_of("frame-too-large").len();
    handle.frame(Bytes::from(vec![b'x'; 2000]), false).await;
    assert_eq!(desktop.frames_of("frame-too-large").len(), before + 1);
    assert!(desktop.frames_of("frame-too-large")[before].get("clientId").is_none());
}
#[tokio::test]
async fn the_desktop_name_is_cleaned_and_the_lanes_it_declares_are_read_strictly() {
    let rig = rig(patient(config())).await;
    let (_desktop, handle) = desktop(&rig.hub, "dev");
    send(&handle, &json!({ "type": "desktop-name", "name": "  My\u{7}\u{1f} PC \u{7f}" })).await;
    assert_eq!(rig.hub.desktop_info("dev").and_then(|info| info.host_name), Some("My PC".to_owned()));
    send(&handle, &json!({ "type": "desktop-name", "name": 5 })).await;
    assert_eq!(rig.hub.desktop_info("dev").and_then(|info| info.host_name), Some(String::new()));
    // `media === true` and `pairV2 === 1`, nothing looser.
    send(&handle, &json!({ "type": "desktop-lanes", "media": "yes", "pairV2": true })).await;
    let info = rig.hub.desktop_info("dev").expect("an entry");
    assert!(!info.media_lane && !info.pair_v2);
    send(&handle, &json!({ "type": "desktop-lanes", "media": true, "pairV2": 1 })).await;
    let info = rig.hub.desktop_info("dev").expect("an entry");
    assert!(info.media_lane && info.pair_v2 && info.open && info.clients == 0);
}
