//! The phone leg: the liveness sweep, the upgrade gate and its refusals, the desktop-offline close, closing sockets and per-device limits.

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use bytes::Bytes;
use mixdog_relay::close_codes::{
    DESKTOP_HANDSHAKE_STALLED, DESKTOP_OFFLINE, DESKTOP_REJECTED_CLIENT, PAIRING_RESCAN_REQUIRED, REVOKED, SUPERSEDED,
};
use mixdog_relay::http1::Headers;
use mixdog_relay::legs::envelope::decode_frame;
use mixdog_relay::legs::hub::{Hub, HubConfig, LegSocket, Liveness, SweepLeg};
use mixdog_relay::legs::ingress::IngressPool;
use mixdog_relay::legs::phone::{
    ANSWERED_CLOSE_GRACE, Decision, MAX_PHONE_CLIENTS_PER_DEVICE, MAX_PHONE_CONNECTIONS_PER_MINUTE, PhoneLegs, PhoneLimits, PhoneRequest,
    phone_client_capacity_available,
};
use mixdog_relay::legs::sweep::{SWEEP_DRAIN_GRACE_WINDOWS, SWEEP_INTERVAL, sweep_legs};
use mixdog_relay::legs::watchdog::HandshakeTiming;
use mixdog_relay::rate_limit::RateLimiter;
use mixdog_relay::store::{DeviceStore, ProfileInput};
use mixdog_relay::ws::{FlushCallback, HandshakeRequest, ServerOptions, WebSocketServer};
use mixdog_rt::time::{Instant, sleep, timeout};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
use url::Url;

const DEVICE: &str = "6f1d3c2e-8a4b-4c5d-9e7f-0a1b2c3d4e5f";
const SECRET: &str = "0123456789abcdef";
const KEY: &str = "dGhlIHNhbXBsZSBub25jZQ==";
const MASK: [u8; 4] = [0x0a, 0x0b, 0x0c, 0x0d];
const HOST: &str = "relay.test";

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

// ---- the socket stand-in ----

#[derive(Default)]
struct FakeInner {
    open: bool,
    texts: Vec<String>,
    binaries: Vec<Vec<u8>>,
    buffered: usize,
    pings: usize,
    terminated: bool,
    read_held: bool,
}

struct Fake {
    inner: Mutex<FakeInner>,
}

impl Fake {
    fn new() -> Arc<Self> {
        Arc::new(Self { inner: Mutex::new(FakeInner { open: true, ..FakeInner::default() }) })
    }

    fn inner(&self) -> MutexGuard<'_, FakeInner> {
        locked(&self.inner)
    }

    fn pings(&self) -> usize {
        self.inner().pings
    }

    fn terminated(&self) -> bool {
        self.inner().terminated
    }

    fn set_buffered(&self, bytes: usize) {
        self.inner().buffered = bytes;
    }

    fn set_read_held(&self, held: bool) {
        self.inner().read_held = held;
    }

    fn set_open(&self, open: bool) {
        self.inner().open = open;
    }

    fn texts(&self) -> Vec<String> {
        self.inner().texts.clone()
    }

    /// The size of the message inside every routing envelope sent to this socket.
    fn uplinked(&self) -> Vec<usize> {
        let binaries = self.inner().binaries.clone();
        binaries.iter().filter_map(|frame| decode_frame(frame)).map(|decoded| decoded.data.len()).collect()
    }

    fn frames_of(&self, kind: &str) -> Vec<Value> {
        let texts = self.inner().texts.clone();
        texts
            .iter()
            .filter_map(|text| mixdog_relay::js::parse(text).ok())
            .filter(|value| value.get("type").and_then(Value::as_str) == Some(kind))
            .collect()
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
        self.inner().texts.push(String::from_utf8_lossy(&text).into_owned());
        if let Some(callback) = on_flushed {
            callback(Ok(()));
        }
    }

    fn send_binary(&self, data: Bytes, on_flushed: Option<FlushCallback>) {
        self.inner().binaries.push(data.to_vec());
        if let Some(callback) = on_flushed {
            callback(Ok(()));
        }
    }

    fn ping(&self) {
        self.inner().pings += 1;
    }

    fn close(&self, _code: u16, _reason: &[u8]) {}

    fn terminate(&self) {
        let mut inner = self.inner();
        inner.open = false;
        inner.terminated = true;
    }

    fn hold_uplink(&self, hold: bool) {
        self.inner().read_held = hold;
    }

    fn read_held(&self) -> bool {
        self.inner().read_held
    }
}

fn leg_of(socket: &Arc<Fake>) -> SweepLeg {
    SweepLeg { socket: socket.clone(), liveness: Liveness::new(), ingress: None }
}

// ---- the liveness sweep ----

#[test]
fn a_leg_that_never_answers_its_ping_is_terminated_on_the_next_sweep() {
    let dead = Fake::new();
    let legs = [leg_of(&dead)];
    sweep_legs(&legs, Instant::now());
    assert_eq!(dead.pings(), 1);
    assert!(!dead.terminated());
    sweep_legs(&legs, Instant::now());
    assert!(dead.terminated());
}

#[test]
fn a_leg_draining_a_queue_or_paused_by_backpressure_gets_extra_windows_before_it_is_cut() {
    assert_eq!(SWEEP_DRAIN_GRACE_WINDOWS, 2);
    for (name, busy) in [("buffered", 0), ("paused uplink", 1), ("paused ingress", 2)] {
        let slow = Fake::new();
        match busy {
            0 => slow.set_buffered(4096),
            // The socket reports reads held for the uplink pause and for ingress admission alike.
            _ => slow.set_read_held(true),
        }
        let legs = [leg_of(&slow)];
        for _ in 0..3 {
            sweep_legs(&legs, Instant::now());
        }
        assert!(!slow.terminated(), "{name}");
        sweep_legs(&legs, Instant::now());
        assert!(slow.terminated(), "{name} is still bounded");
    }
}

#[test]
fn answering_a_ping_restores_the_full_grace_for_the_next_stall() {
    let slow = Fake::new();
    slow.set_buffered(10);
    let leg = leg_of(&slow);
    let legs = [leg.clone()];
    sweep_legs(&legs, Instant::now());
    sweep_legs(&legs, Instant::now());
    // The pong arrived.
    leg.liveness.mark();
    for _ in 0..3 {
        sweep_legs(&legs, Instant::now());
    }
    assert!(!slow.terminated());
}

#[test]
fn a_leg_that_answers_is_pinged_every_pass_and_never_cut() {
    assert_eq!(SWEEP_INTERVAL, Duration::from_secs(10));
    let live = Fake::new();
    let leg = leg_of(&live);
    let legs = [leg.clone()];
    for pass in 1..=5 {
        sweep_legs(&legs, Instant::now());
        assert_eq!(live.pings(), pass);
        leg.liveness.mark();
    }
    assert!(!live.terminated());
}

// ---- the PC-offline close ----

#[test]
fn the_pc_offline_close_is_its_own_code_and_never_a_pairing_revoking_one() {
    assert_eq!(DESKTOP_OFFLINE, 4002);
    assert!(![REVOKED, DESKTOP_REJECTED_CLIENT, PAIRING_RESCAN_REQUIRED].contains(&DESKTOP_OFFLINE));
    assert!(![SUPERSEDED, DESKTOP_OFFLINE, REVOKED, DESKTOP_REJECTED_CLIENT, PAIRING_RESCAN_REQUIRED, 4008, 4009].contains(&DESKTOP_HANDSHAKE_STALLED));
    // Both ends give the handshake 10 s; a missed turn plus the probe uses 6 s of it and leaves 4 s for the redial and a fresh challenge.
    let timing = HandshakeTiming::default();
    assert_eq!(timing.stall + timing.probe, Duration::from_secs(6));
}

#[test]
fn the_phone_numbers_are_the_relays() {
    assert_eq!(MAX_PHONE_CONNECTIONS_PER_MINUTE, 120);
    assert_eq!(MAX_PHONE_CLIENTS_PER_DEVICE, 32);
    assert_eq!(ANSWERED_CLOSE_GRACE, Duration::from_secs(5));
    assert!(phone_client_capacity_available(31));
    assert!(!phone_client_capacity_available(32));
    assert!(!phone_client_capacity_available(33));
}

struct Rig {
    hub: Arc<Hub>,
    legs: Arc<PhoneLegs>,
    unauthorized: Arc<Mutex<RateLimiter>>,
    token: String,
    _dir: tempfile::TempDir,
}

fn headers(origin: Option<&str>) -> Headers {
    let mut headers = Headers::default();
    headers.add("host", HOST.to_owned());
    if let Some(origin) = origin {
        headers.add("origin", origin.to_owned());
    }
    headers
}

fn handshake() -> HandshakeRequest {
    HandshakeRequest::new(
        "GET",
        &[("Upgrade", "websocket"), ("Connection", "Upgrade"), ("Sec-WebSocket-Key", KEY), ("Sec-WebSocket-Version", "13"), ("Host", HOST)],
    )
}

/// The decision for an upgrade of `/ws?token=...` from the relay's own origin.
fn decide(rig: &Rig, token: &str) -> Decision {
    decide_with(rig, &format!("/ws?token={token}"), Some(&format!("http://{HOST}")))
}

fn decide_with(rig: &Rig, target: &str, origin: Option<&str>) -> Decision {
    let url = Url::parse(&format!("http://localhost{target}")).expect("a request line");
    let (headers, handshake) = (headers(origin), handshake());
    rig.legs.decide(&PhoneRequest { url: &url, headers: &headers, handshake: &handshake, encrypted: false, remote_address: Some("203.0.113.7") })
}

fn attach(rig: &Rig) -> (Arc<Fake>, mixdog_relay::legs::hub::PhoneHandle) {
    let socket = Fake::new();
    let handle = rig.hub.attach_phone(DEVICE, socket.clone(), mixdog_relay::legs::hub::PhoneOptions::default()).expect("a desktop leg is live");
    (socket, handle)
}

fn refused(decision: &Decision) -> Option<(u16, &'static str)> {
    match decision {
        Decision::Refuse { status, reason } => Some((*status, *reason)),
        _ => None,
    }
}

fn answered(decision: &Decision) -> Option<(u16, &'static str)> {
    match decision {
        Decision::Answer { code, reason, .. } => Some((*code, *reason)),
        _ => None,
    }
}

// ---- on a transport ----

fn masked_frame(first: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = vec![first, 0x80 | u8::try_from(payload.len()).expect("a short payload")];
    out.extend_from_slice(&MASK);
    out.extend(payload.iter().enumerate().map(|(index, byte)| byte ^ MASK[index % 4]));
    out
}

async fn eventually(what: &str, mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !condition() {
        assert!(Instant::now() < deadline, "timed out waiting for: {what}");
        sleep(Duration::from_millis(10)).await;
    }
}


// ---- rigs ----

fn io() -> mixdog_rt::DurabilityIo {
    mixdog_rt::testing::tokens().durability_io
}
async fn build(limits: PhoneLimits) -> Rig {
    build_with(limits, HubConfig::default().max_frame_bytes).await
}
async fn build_with(limits: PhoneLimits, max_frame_bytes: usize) -> Rig {
    let dir = tempfile::tempdir().expect("a temporary directory");
    let store = DeviceStore::open(dir.path(), io()).await.expect("the store opens");
    assert!(store.authenticate(DEVICE, SECRET).await);
    let registered = store.register_client(DEVICE, "bbbbbbbb", &ProfileInput::default()).await.expect("a browser credential");
    // A watchdog that never fires within a test.
    let config = HubConfig { max_frame_bytes, handshake: HandshakeTiming { stall: Duration::from_secs(600), probe: Duration::from_secs(600) }, ..HubConfig::default() };
    let hub = Hub::new(store, config, IngressPool::new());
    let unauthorized = Arc::new(Mutex::new(RateLimiter::new(1000, 60_000)));
    let sockets = Arc::new(WebSocketServer::new(ServerOptions::new(64 * 1024 * 1024)));
    let legs = PhoneLegs::new(Arc::clone(&hub), sockets, Arc::clone(&unauthorized), limits);
    Rig { hub, legs, unauthorized, token: registered.token, _dir: dir }
}
fn desktop_leg(rig: &Rig) -> (Arc<Fake>, mixdog_relay::legs::desktop::DesktopHandle) {
    let socket = Fake::new();
    let handle = rig.hub.attach_desktop(DEVICE, socket.clone(), None);
    (socket, handle)
}
// ---- the /ws decision ----

#[tokio::test]
async fn a_browser_upgrade_from_another_origin_is_refused_403_before_anything_is_looked_at() {
    let rig = build(PhoneLimits::default()).await;
    let (_desktop, _handle) = desktop_leg(&rig);
    let target = format!("/ws?token={}", rig.token);
    for origin in [None, Some("http://evil.test"), Some("https://relay.test"), Some("http://relay.test/path"), Some("http://user@relay.test")] {
        assert_eq!(refused(&decide_with(&rig, &target, origin)), Some((403, "Forbidden")), "{origin:?}");
    }
    assert_eq!(rig.hub.client_count(DEVICE), 0);
}
#[tokio::test]
async fn a_missing_stale_or_legacy_token_is_answered_4005_and_a_flood_of_them_is_throttled() {
    let rig = build(PhoneLimits::default()).await;
    let (_desktop, _handle) = desktop_leg(&rig);
    // An empty token, an unknown one, and the device's own shared secret (not a browser credential).
    for token in ["", "f".repeat(32).as_str(), SECRET] {
        assert_eq!(answered(&decide(&rig, token)), Some((4005, "pairing rescan required")), "token {token:?}");
    }
    // No token at all.
    assert_eq!(answered(&decide_with(&rig, "/ws", Some(&format!("http://{HOST}")))), Some((4005, "pairing rescan required")));
    *locked(&rig.unauthorized) = RateLimiter::new(2, 60_000);
    assert!(answered(&decide(&rig, "nope")).is_some());
    assert!(answered(&decide(&rig, "nope")).is_some());
    assert_eq!(refused(&decide(&rig, "nope")), Some((429, "Too Many Requests")), "charged to the unauthorized limiter of the caller");
}
#[tokio::test]
async fn the_first_token_of_the_query_is_the_one_read() {
    let rig = build(PhoneLimits::default()).await;
    let (_desktop, _handle) = desktop_leg(&rig);
    let origin = format!("http://{HOST}");
    let target = format!("/ws?token={}&token=other", rig.token);
    assert!(matches!(decide_with(&rig, &target, Some(&origin)), Decision::Attach { .. }));
    let target = format!("/ws?token=other&token={}", rig.token);
    assert_eq!(answered(&decide_with(&rig, &target, Some(&origin))), Some((4005, "pairing rescan required")));
}
#[tokio::test]
async fn a_paired_phone_of_a_live_pc_is_attached_as_its_browser() {
    let rig = build(PhoneLimits::default()).await;
    let (_desktop, _handle) = desktop_leg(&rig);
    match decide(&rig, &rig.token) {
        Decision::Attach { device_id, browser_client_id } => {
            assert_eq!(device_id, DEVICE);
            assert_eq!(browser_client_id, "bbbbbbbb");
        }
        _ => panic!("a paired phone of a live PC is attached"),
    }
}
#[tokio::test]
async fn an_offline_pc_is_answered_4002_whether_it_never_connected_or_its_leg_is_closed() {
    let rig = build(PhoneLimits::default()).await;
    assert_eq!(answered(&decide(&rig, &rig.token)), Some((4002, "desktop offline")));
    let (desktop, _handle) = desktop_leg(&rig);
    assert!(matches!(decide(&rig, &rig.token), Decision::Attach { .. }));
    desktop.set_open(false);
    assert_eq!(answered(&decide(&rig, &rig.token)), Some((4002, "desktop offline")), "a parked entry is not a live PC");
}
#[tokio::test]
async fn pc_offline_answers_are_rate_limited_and_bounded() {
    // The offline answer is charged to the per-device connect limit.
    let rig = build(PhoneLimits::default()).await;
    let mut results = Vec::new();
    for _ in 0..=MAX_PHONE_CONNECTIONS_PER_MINUTE {
        let decision = decide(&rig, &rig.token);
        results.push(answered(&decision).or_else(|| refused(&decision)).map_or(0, |(number, _)| number));
    }
    assert_eq!(results.iter().filter(|code| **code == DESKTOP_OFFLINE).count(), MAX_PHONE_CONNECTIONS_PER_MINUTE);
    assert_eq!(results.last(), Some(&429));

    // Peers that never acknowledge the close hold a slot each, up to the per-device phone capacity; past it the upgrade is refused,
    // and a slot freed is a slot given back.
    let rig = build_unlimited().await;
    let mut held = Vec::new();
    for _ in 0..MAX_PHONE_CLIENTS_PER_DEVICE {
        match decide(&rig, &rig.token) {
            Decision::Answer { code, slot, .. } => {
                assert_eq!(code, DESKTOP_OFFLINE);
                held.push(slot);
            }
            _ => panic!("an answer within the capacity"),
        }
    }
    assert_eq!(refused(&decide(&rig, &rig.token)), Some((429, "Too Many Requests")), "outstanding closing sockets are bounded");
    drop(held.pop());
    assert!(answered(&decide(&rig, &rig.token)).is_some(), "a slot freed is available again");
}
async fn build_unlimited() -> Rig {
    build(PhoneLimits { connects_per_window: 10_000, ..PhoneLimits::default() }).await
}
#[tokio::test]
async fn one_device_cannot_hold_more_than_32_phone_legs_and_a_rate_limited_device_is_refused_before_the_pc_is_asked() {
    let rig = build_unlimited().await;
    let (_desktop, _handle) = desktop_leg(&rig);
    let mut phones = Vec::new();
    for _ in 0..MAX_PHONE_CLIENTS_PER_DEVICE {
        assert!(matches!(decide(&rig, &rig.token), Decision::Attach { .. }));
        phones.push(attach(&rig));
    }
    assert_eq!(refused(&decide(&rig, &rig.token)), Some((429, "Too Many Requests")));
    let (_socket, last) = phones.pop().expect("a phone");
    last.closed(1000, b"background");
    assert!(matches!(decide(&rig, &rig.token), Decision::Attach { .. }), "a leg that left gives its place back");

    let rig = build(PhoneLimits { connects_per_window: 1, ..PhoneLimits::default() }).await;
    let (_desktop, _handle) = desktop_leg(&rig);
    assert!(matches!(decide(&rig, &rig.token), Decision::Attach { .. }));
    assert_eq!(refused(&decide(&rig, &rig.token)), Some((429, "Too Many Requests")));
}
/// What the relay's side of a transport did, as the peer sees it.
struct Peer {
    io: DuplexStream,
    buffer: Vec<u8>,
}
/// The peer end of an upgrade served on the other end of an in-memory transport.
fn dial(rig: &Rig, target: &str, origin: bool) -> Peer {
    let (client, server) = tokio::io::duplex(64 * 1024);
    let legs = Arc::clone(&rig.legs);
    let target = target.to_owned();
    tokio::spawn(async move {
        let url = Url::parse(&format!("http://localhost{target}")).expect("a request line");
        let (headers, handshake) = (headers(origin.then_some(&format!("http://{HOST}")[..])), handshake());
        let request = PhoneRequest { url: &url, headers: &headers, handshake: &handshake, encrypted: false, remote_address: Some("203.0.113.7") };
        legs.serve_upgrade(&request, server, Bytes::new()).await;
    });
    Peer { io: client, buffer: Vec::new() }
}
impl Peer {
    /// The status the relay answered the upgrade with (the HTTP layer has read the head; what is written here is the answer).
    async fn start(&mut self) -> u16 {
        let mut answer = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let count = timeout(Duration::from_secs(10), self.io.read(&mut chunk)).await.expect("an answer in time").expect("read the answer");
            if count == 0 {
                break;
            }
            answer.extend_from_slice(&chunk[..count]);
            if let Some(at) = answer.windows(4).position(|window| window == b"\r\n\r\n") {
                self.buffer = answer[at + 4..].to_vec();
                break;
            }
        }
        let text = String::from_utf8_lossy(&answer).into_owned();
        text.split(' ').nth(1).and_then(|status| status.parse().ok()).unwrap_or(0)
    }

    /// The next frame of the relay (unmasked): `(opcode, payload)`, or none when the connection ended.
    async fn frame(&mut self) -> Option<(u8, Vec<u8>)> {
        loop {
            if self.buffer.len() >= 2 {
                let length = usize::from(self.buffer[1] & 0x7f);
                assert!(length < 126, "a short frame");
                if self.buffer.len() >= 2 + length {
                    let opcode = self.buffer[0] & 0x0f;
                    let payload = self.buffer[2..2 + length].to_vec();
                    self.buffer.drain(..2 + length);
                    return Some((opcode, payload));
                }
            }
            let mut chunk = [0u8; 4096];
            let count = timeout(Duration::from_secs(10), self.io.read(&mut chunk)).await.ok()?.ok()?;
            if count == 0 {
                return None;
            }
            self.buffer.extend_from_slice(&chunk[..count]);
        }
    }

    async fn close_frame(&mut self) -> Option<(u16, String)> {
        loop {
            let (opcode, payload) = self.frame().await?;
            if opcode == 8 {
                return Some((u16::from_be_bytes([payload[0], payload[1]]), String::from_utf8_lossy(&payload[2..]).into_owned()));
            }
        }
    }

    async fn send(&mut self, bytes: &[u8]) {
        self.io.write_all(bytes).await.expect("write");
    }

    async fn ended(&mut self) -> bool {
        let mut chunk = [0u8; 256];
        loop {
            match timeout(Duration::from_secs(10), self.io.read(&mut chunk)).await {
                Ok(Ok(0)) | Ok(Err(_)) => return true,
                Ok(Ok(_)) => {}
                Err(_) => return false,
            }
        }
    }
}
#[tokio::test]
async fn a_refusal_is_the_raw_status_line_and_the_connection_ends() {
    let rig = build(PhoneLimits::default()).await;
    let mut peer = dial(&rig, &format!("/ws?token={}", rig.token), false);
    let mut answer = Vec::new();
    timeout(Duration::from_secs(10), peer.io.read_to_end(&mut answer)).await.expect("the connection ends").expect("read");
    assert_eq!(String::from_utf8_lossy(&answer), "HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
}
#[tokio::test]
async fn an_unpaired_phone_gets_the_handshake_and_then_close_4005() {
    let rig = build(PhoneLimits::default()).await;
    let mut peer = dial(&rig, "/ws?token=legacy", true);
    assert_eq!(peer.start().await, 101);
    assert_eq!(peer.close_frame().await, Some((4005, "pairing rescan required".to_owned())));
}
#[tokio::test]
async fn a_phone_of_an_offline_pc_is_closed_4002_and_the_pairing_is_untouched() {
    let rig = build(PhoneLimits::default()).await;
    let mut peer = dial(&rig, &format!("/ws?token={}", rig.token), true);
    assert_eq!(peer.start().await, 101);
    assert_eq!(peer.close_frame().await, Some((4002, "desktop offline".to_owned())));
    assert!(rig.hub.store().has_client(DEVICE, "bbbbbbbb"));
}
#[tokio::test]
async fn peers_that_never_acknowledge_the_close_hold_a_slot_each_and_the_next_is_refused() {
    let rig = build_unlimited().await;
    let mut peers = Vec::new();
    for _ in 0..MAX_PHONE_CLIENTS_PER_DEVICE {
        let mut peer = dial(&rig, &format!("/ws?token={}", rig.token), true);
        assert_eq!(peer.start().await, 101);
        peers.push(peer);
    }
    let mut extra = dial(&rig, &format!("/ws?token={}", rig.token), true);
    assert_eq!(extra.start().await, 429, "outstanding closing sockets are bounded");
}
#[tokio::test]
async fn a_malformed_frame_on_an_answered_closing_socket_cannot_crash_and_frees_its_slot() {
    let rig = build_unlimited().await;
    // Upgrade, never acknowledge the close, and answer with what the relay must reject: a client frame without a mask.
    let mut peers = Vec::new();
    for _ in 0..MAX_PHONE_CLIENTS_PER_DEVICE {
        let mut peer = dial(&rig, &format!("/ws?token={}", rig.token), true);
        assert_eq!(peer.start().await, 101);
        peer.send(&[0x81, 0x01, 0x41]).await;
        peers.push(peer);
    }
    // The unpaired (4005) answer is the same kind of socket.
    let mut unpaired = dial(&rig, &format!("/ws?token={}", "f".repeat(32)), true);
    assert_eq!(unpaired.start().await, 101);
    unpaired.send(&[0x81, 0x01, 0x41]).await;
    for peer in &mut peers {
        assert!(peer.ended().await, "a socket that misbehaves is cut there and then");
    }
    assert!(unpaired.ended().await);
    eventually("the cut sockets gave their slots back", || rig.hub.legs().is_empty()).await;
    let mut again = dial(&rig, &format!("/ws?token={}", rig.token), true);
    assert_eq!(again.start().await, 101, "a cut socket no longer holds a PC-offline slot");
}
#[tokio::test]
async fn a_peer_that_never_replies_to_the_close_is_cut_after_the_grace_and_its_slot_returns() {
    let rig = build(PhoneLimits { answered_close_grace: Duration::from_millis(100), ..PhoneLimits::default() }).await;
    let mut peer = dial(&rig, &format!("/ws?token={}", rig.token), true);
    assert_eq!(peer.start().await, 101);
    assert_eq!(peer.close_frame().await, Some((4002, "desktop offline".to_owned())));
    assert_eq!(rig.hub.legs().len(), 1, "an upgraded socket is listed for the sweep");
    assert!(peer.ended().await, "cut after the grace");
    eventually("the socket left the sweep's table", || rig.hub.legs().is_empty()).await;
}
#[tokio::test]
async fn a_phone_leg_answers_its_probe_locally_and_tells_its_pc_when_it_leaves() {
    let rig = build(PhoneLimits::default()).await;
    let (desktop, _handle) = desktop_leg(&rig);
    let mut peer = dial(&rig, &format!("/ws?token={}", rig.token), true);
    assert_eq!(peer.start().await, 101);
    eventually("the phone is announced to its PC", || !desktop.frames_of("client-open").is_empty()).await;
    let open = desktop.frames_of("client-open").remove(0);
    assert_eq!(open["browserClientId"], "bbbbbbbb");
    assert_eq!(rig.hub.client_count(DEVICE), 1);
    assert_eq!(rig.hub.legs().len(), 2, "the PC's leg and the phone's are listed");

    // A liveness probe is answered at the relay, whether or not the PC is behind it.
    peer.send(&masked_frame(0x81, b"{\"ping\":1}")).await;
    assert_eq!(peer.frame().await, Some((1, b"{\"pong\":1}".to_vec())));
    assert!(desktop.frames_of("frame").is_empty(), "the probe is not forwarded");

    // Anything else rides up the PC's leg inside the routing envelope.
    peer.send(&masked_frame(0x81, b"{\"hello\":1}")).await;
    eventually("the frame reaches the PC", || !desktop.frames_of("frame").is_empty()).await;
    let routed = desktop.frames_of("frame").remove(0);
    assert_eq!(routed["clientId"], open["clientId"]);
    assert_eq!(routed["data"], "{\"hello\":1}");

    peer.send(&masked_frame(0x88, &[0x03, 0xe8])).await;
    // A browser answers the relay's close frame by ending its side of the connection; the socket closes when both sides have.
    assert_eq!(peer.close_frame().await.map(|(code, _)| code), Some(1000));
    peer.io.shutdown().await.expect("end the peer's side");
    eventually("the PC is told the phone left", || !desktop.frames_of("client-close").is_empty()).await;
    assert_eq!(desktop.frames_of("client-close")[0]["clientId"], open["clientId"]);
    eventually("the phone left its entry", || rig.hub.client_count(DEVICE) == 0).await;
}
#[tokio::test]
async fn one_phone_cannot_shrink_the_path_of_the_phone_beside_it() {
    let rig = build_with(PhoneLimits::default(), 1024 * 1024).await;
    let kib = |count: usize| Bytes::from(vec![1u8; count * 1024]);
    let declare = |bytes: usize| mixdog_relay::js::wire(&serde_json::json!({ "type": "desktop-lanes", "media": false, "maxPayloadBytes": bytes }));
    let (first, first_handle) = desktop_leg(&rig);
    first_handle.frame(Bytes::from(declare(128 * 1024)), false).await;
    let (attacker_socket, attacker) = attach(&rig);
    let (victim_socket, victim) = attach(&rig);

    // One phone sends inside the claim, and the shared leg dies for it.
    attacker.frame(kib(110), true);
    assert_eq!(first.uplinked(), [110 * 1024]);
    first.set_open(false);
    first_handle.closed();

    // The desktop comes back with the same declaration. A frame that fits the real path still crosses it: distrust derived from one
    // phone's traffic and applied to every phone on the device is one client degrading another.
    let (second, second_handle) = desktop_leg(&rig);
    second_handle.frame(Bytes::from(declare(128 * 1024)), false).await;
    victim.frame(kib(80), true);
    assert_eq!(second.uplinked(), [80 * 1024]);
    // ...and the phone that caused the close keeps its own path too: no client was named, so no client was punished.
    attacker.frame(kib(60), true);
    assert_eq!(second.uplinked(), [80 * 1024, 60 * 1024]);
    assert!(attacker_socket.texts().iter().all(|text| !text.contains("frame-too-large")));
    assert!(victim_socket.texts().iter().all(|text| !text.contains("frame-too-large")));
    assert!(attacker_socket.is_open() && victim_socket.is_open());
}
