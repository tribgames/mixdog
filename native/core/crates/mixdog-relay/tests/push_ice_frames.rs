//! The native push and ICE server frames of the desktop leg, through a live hub: the credential issuer, the capability, bind and send frames.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use bytes::Bytes;
use mixdog_relay::ice;
use mixdog_relay::ice::turn::{TurnConfig, turn_config_from_env, verify_turn_credential};
use mixdog_relay::legs::desktop::DesktopHandle;
use mixdog_relay::legs::hub::{Hub, HubConfig, LegSocket};
use mixdog_relay::legs::ingress::IngressPool;
use mixdog_relay::legs::watchdog::HandshakeTiming;
use mixdog_relay::native_push::{BoxFuture, NativePushService, PushMessage, PushSender, SendResult, frames};
use mixdog_relay::store::{DeviceStore, ProfileInput};
use mixdog_relay::ws::FlushCallback;
use serde_json::{Value, json};

const DEVICE: &str = "6f1d3c2e-8a4b-4c5d-9e7f-0a1b2c3d4e5f";
const OTHER_DEVICE: &str = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const SECRET: &str = "0123456789abcdef";
const TURN_SECRET: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const ISSUE_LIMIT: usize = 3;
const APNS_TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// ---- the socket stand-in ----

struct Fake {
    sent: Mutex<Vec<String>>,
}

impl Fake {
    fn new() -> Arc<Self> {
        Arc::new(Self { sent: Mutex::new(Vec::new()) })
    }

    fn lock(&self) -> MutexGuard<'_, Vec<String>> {
        self.sent.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn frames_of(&self, kind: &str) -> Vec<Value> {
        let texts = self.lock().clone();
        texts.iter().filter_map(|text| mixdog_relay::js::parse(text).ok()).filter(|value| value.get("type").and_then(Value::as_str) == Some(kind)).collect()
    }
}

impl LegSocket for Fake {
    fn is_open(&self) -> bool {
        true
    }

    fn buffered_amount(&self) -> usize {
        0
    }

    fn send_text(&self, text: Bytes, on_flushed: Option<FlushCallback>) {
        self.lock().push(String::from_utf8_lossy(&text).into_owned());
        if let Some(callback) = on_flushed {
            callback(Ok(()));
        }
    }

    fn send_binary(&self, _data: Bytes, on_flushed: Option<FlushCallback>) {
        if let Some(callback) = on_flushed {
            callback(Ok(()));
        }
    }

    fn ping(&self) {}

    fn close(&self, _code: u16, _reason: &[u8]) {}

    fn terminate(&self) {}

    fn hold_uplink(&self, _hold: bool) {}

    fn read_held(&self) -> bool {
        false
    }
}

// ---- the sender stand-in ----

struct FakePush {
    platforms: Vec<&'static str>,
    result: SendResult,
    sent: Mutex<Vec<PushMessage>>,
    /// A send waits for a permit when there is a gate: a push in flight.
    gate: Option<Arc<tokio::sync::Semaphore>>,
}

impl FakePush {
    fn new(platforms: &[&'static str], gate: Option<Arc<tokio::sync::Semaphore>>) -> Arc<Self> {
        let result = SendResult { ok: true, status: 200, invalid: false, error: None };
        Arc::new(Self { platforms: platforms.to_vec(), result, sent: Mutex::new(Vec::new()), gate })
    }

    fn sent(&self) -> usize {
        self.sent.lock().unwrap_or_else(std::sync::PoisonError::into_inner).len()
    }
}

impl PushSender for FakePush {
    fn platforms(&self) -> Vec<&'static str> {
        self.platforms.clone()
    }

    fn send<'a>(&'a self, message: &'a PushMessage) -> BoxFuture<'a, SendResult> {
        self.sent.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(message.clone());
        Box::pin(async move {
            if let Some(gate) = &self.gate {
                gate.acquire().await.expect("the gate stays open").forget();
            }
            self.result.clone()
        })
    }

    fn close(&self) {}
}

// ---- rigs ----

fn config() -> HubConfig {
    HubConfig {
        max_frame_bytes: 1024,
        uplink_capacity_ceiling: 64 * 1024,
        handshake: HandshakeTiming { stall: Duration::from_secs(60), probe: Duration::from_millis(30) },
        ..HubConfig::default()
    }
}

struct Rig {
    hub: Arc<Hub>,
    _dir: tempfile::TempDir,
}

async fn new_rig() -> Rig {
    let dir = tempfile::tempdir().expect("a temporary directory");
    let io = mixdog_rt::testing::tokens().durability_io;
    let store = DeviceStore::open(dir.path(), io).await.expect("the store opens");
    for device in [DEVICE, OTHER_DEVICE] {
        assert!(store.authenticate(device, SECRET).await);
    }
    Rig { hub: Hub::new(store, config(), IngressPool::new()), _dir: dir }
}

async fn pair(rig: &Rig, device: &str, client: &str) {
    assert!(rig.hub.store().register_client(device, client, &ProfileInput::text("Pixel", "android", "chrome")).await.is_some());
}

fn desktop(hub: &Arc<Hub>, device: &str) -> (Arc<Fake>, DesktopHandle) {
    let socket = Fake::new();
    let handle = hub.attach_desktop(device, socket.clone(), None);
    (socket, handle)
}

async fn send(handle: &DesktopHandle, frame: &Value) {
    handle.frame(Bytes::from(mixdog_relay::js::wire(frame)), false).await;
}

/// Waits (a few milliseconds at a time, 2 s at most) for what a spawned send has still to write.
async fn until(mut done: impl FnMut() -> bool) {
    for _ in 0..400 {
        if done() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("the awaited frame never came");
}

// ---- ICE ----

fn turn_env(extra: &[(&str, &str)], drop: &[&str]) -> BTreeMap<String, String> {
    let mut env: BTreeMap<String, String> =
        [("TURN_AUTH_SECRET", TURN_SECRET), ("TURN_HOST", "relay.example.com"), ("TURN_TLS_PORT", "5349"), ("TURN_ISSUE_LIMIT", "3")]
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect();
    for name in drop {
        env.remove(*name);
    }
    for (name, value) in extra {
        env.insert((*name).to_owned(), (*value).to_owned());
    }
    env
}

fn turn() -> TurnConfig {
    turn_config_from_env(&turn_env(&[], &[])).expect("a valid environment").expect("TURN is configured")
}

/// Request ids as the desktop mints them (`randomUUID`).
fn id(n: usize) -> String {
    format!("00000000-0000-4000-8000-{n:012}")
}

fn ice_request(request_id: &Value) -> Value {
    json!({ "type": "ice-servers-request", "requestId": request_id })
}

async fn ice_rig() -> Rig {
    let rig = new_rig().await;
    ice::frames::register(rig.hub.dispatch(), turn()).expect("the frame is free");
    rig
}

#[tokio::test]
async fn an_unpaired_device_is_refused_no_credential_only_the_public_stun_url() {
    let rig = ice_rig().await;
    let (socket, handle) = desktop(&rig.hub, DEVICE);
    send(&handle, &ice_request(&json!(id(1)))).await;
    assert_eq!(
        socket.frames_of("ice-servers"),
        vec![json!({ "type": "ice-servers", "requestId": id(1), "ok": false, "error": "not-paired", "stun": ["stun:relay.example.com:3478"] })]
    );
    let text = socket.lock().join("\n");
    assert!(!text.contains("credential") && !text.contains("username"));
}

#[tokio::test]
async fn a_device_with_a_paired_phone_gets_a_credential_coturn_would_accept_until_it_expires() {
    let rig = ice_rig().await;
    pair(&rig, DEVICE, "aaaaaaaa").await;
    let (socket, handle) = desktop(&rig.hub, DEVICE);
    send(&handle, &ice_request(&json!(id(1)))).await;
    let replies = socket.frames_of("ice-servers");
    let reply = &replies[0];
    assert_eq!((reply["requestId"].clone(), reply["ok"].clone(), reply["ttlSeconds"].clone()), (json!(id(1)), json!(true), json!(86_400)));
    let expires_at = reply["expiresAt"].as_i64().expect("a whole second");
    let remaining = reply["remainingMs"].as_i64().expect("milliseconds");
    assert!(remaining > 86_399_000 && remaining <= 86_400_000, "{remaining}");
    assert_eq!(reply["servers"][0], json!({ "urls": ["stun:relay.example.com:3478"] }));
    let turn = &reply["servers"][1];
    assert_eq!(
        turn["urls"],
        json!(["turn:relay.example.com:3478?transport=udp", "turn:relay.example.com:3478?transport=tcp", "turns:relay.example.com:5349?transport=tcp"])
    );
    let (username, credential) = (turn["username"].as_str(), turn["credential"].as_str());
    let now = mixdog_relay::rate_limit::now_ms();
    assert!(verify_turn_credential(TURN_SECRET, username, credential, now));
    assert!(!verify_turn_credential(TURN_SECRET, username, credential, expires_at * 1000));
    // The device's routing id never travels in the STUN username.
    assert!(!username.expect("a username").contains(DEVICE));
    assert!(!mixdog_relay::js::wire(reply).contains(TURN_SECRET));
}

#[tokio::test]
async fn credentials_are_per_device_and_issuance_is_limited_per_device_with_the_wait_named() {
    let rig = ice_rig().await;
    pair(&rig, DEVICE, "aaaaaaaa").await;
    pair(&rig, OTHER_DEVICE, "bbbbbbbb").await;
    let (a, a_handle) = desktop(&rig.hub, DEVICE);
    let (b, b_handle) = desktop(&rig.hub, OTHER_DEVICE);
    for index in 0..ISSUE_LIMIT {
        send(&a_handle, &ice_request(&json!(id(index)))).await;
    }
    assert!(a.frames_of("ice-servers").iter().all(|reply| reply["ok"] == true));
    send(&a_handle, &ice_request(&json!(id(99)))).await;
    let replies = a.frames_of("ice-servers");
    let refusal = replies.last().expect("a refusal");
    assert_eq!((refusal["ok"].clone(), refusal["error"].clone()), (json!(false), json!("rate-limited")));
    assert_eq!(refusal["stun"], json!(["stun:relay.example.com:3478"]));
    // The limit is per credential lifetime (86 400 s): the wait is under that and above zero.
    let wait = refusal["retryAfterMs"].as_i64().expect("a wait");
    assert!(wait > 0 && wait <= 86_400_000, "{wait}");
    send(&b_handle, &ice_request(&json!(id(50)))).await;
    let other = b.frames_of("ice-servers");
    assert_eq!(other[0]["ok"], true);
    assert_ne!(other[0]["servers"][1]["username"], replies[0]["servers"][1]["username"]);
}

#[tokio::test]
async fn a_request_id_that_is_not_a_routing_id_is_dropped_never_truncated_or_echoed() {
    let rig = ice_rig().await;
    pair(&rig, DEVICE, "aaaaaaaa").await;
    let (socket, handle) = desktop(&rig.hub, DEVICE);
    send(&handle, &json!({ "type": "ice-servers-request" })).await;
    for bad in [json!(7), json!("r1"), json!(format!("{}0", "a".repeat(64))), json!("A".repeat(36)), json!(null)] {
        send(&handle, &ice_request(&bad)).await;
    }
    assert!(socket.frames_of("ice-servers").is_empty());
    // 64 characters is the shared routing-id bound and is still answered whole.
    send(&handle, &ice_request(&json!("a".repeat(64)))).await;
    assert_eq!(socket.frames_of("ice-servers")[0]["requestId"], json!("a".repeat(64)));
}

#[tokio::test]
async fn a_relay_without_turn_settings_advertises_nothing_and_never_answers() {
    let rig = new_rig().await;
    pair(&rig, DEVICE, "aaaaaaaa").await;
    let (socket, handle) = desktop(&rig.hub, DEVICE);
    assert!(socket.frames_of("relay-capabilities")[0].get("ice").is_none());
    send(&handle, &ice_request(&json!(id(1)))).await;
    assert!(socket.frames_of("ice-servers").is_empty());
    // The settings that leave a relay without TURN: none, a short secret, no issue limit.
    let none = turn_env(&[], &["TURN_AUTH_SECRET", "TURN_HOST", "TURN_TLS_PORT", "TURN_ISSUE_LIMIT"]);
    for env in [none, turn_env(&[("TURN_AUTH_SECRET", "short")], &[]), turn_env(&[], &["TURN_ISSUE_LIMIT"])] {
        assert!(!matches!(turn_config_from_env(&env), Ok(Some(_))));
    }
}

#[tokio::test]
async fn over_a_desktop_leg_the_relay_advertises_ice_refuses_until_a_phone_is_paired_then_issues() {
    let rig = ice_rig().await;
    let (socket, handle) = desktop(&rig.hub, DEVICE);
    assert_eq!(socket.frames_of("relay-capabilities")[0]["ice"], 1);

    send(&handle, &ice_request(&json!(id(1)))).await;
    let refused = socket.frames_of("ice-servers");
    assert_eq!((refused[0]["requestId"].clone(), refused[0]["ok"].clone(), refused[0]["error"].clone()), (json!(id(1)), json!(false), json!("not-paired")));

    pair(&rig, DEVICE, "aaaaaaaa").await;
    send(&handle, &ice_request(&json!(id(2)))).await;
    let issued = &socket.frames_of("ice-servers")[1];
    assert_eq!((issued["requestId"].clone(), issued["ok"].clone()), (json!(id(2)), json!(true)));
    let turn = &issued["servers"][1];
    assert!(verify_turn_credential(TURN_SECRET, turn["username"].as_str(), turn["credential"].as_str(), mixdog_relay::rate_limit::now_ms()));

    // Revoking the last phone ends eligibility.
    send(&handle, &json!({ "type": "revoke-client", "requestId": "r1", "clientId": "aaaaaaaa" })).await;
    send(&handle, &ice_request(&json!(id(3)))).await;
    assert_eq!(socket.frames_of("ice-servers")[2]["error"], "not-paired");
}

#[tokio::test]
async fn the_ice_frame_is_registered_once() {
    let rig = ice_rig().await;
    assert!(ice::frames::register(rig.hub.dispatch(), turn()).is_err());
}

// ---- native push ----

fn push_rig(platforms: &[&'static str], gate: Option<Arc<tokio::sync::Semaphore>>) -> (Arc<FakePush>, Arc<NativePushService>) {
    let push = FakePush::new(platforms, gate);
    let sender: Option<Arc<dyn PushSender>> = if platforms.is_empty() { None } else { Some(Arc::clone(&push) as Arc<dyn PushSender>) };
    (push, Arc::new(NativePushService::new(sender)))
}

fn bind_frame(client: &str) -> Value {
    json!({ "type": "native-push-bind", "clientId": client, "platform": "apns", "token": APNS_TOKEN })
}

fn push_frame() -> Value {
    json!({ "type": "native-push", "platform": "apns", "token": APNS_TOKEN, "mx": "bXg", "reason": "turn-finished", "collapseKey": "c1", "sandbox": false })
}

fn results(socket: &Fake) -> Vec<Value> {
    socket.frames_of("native-push-result")
}

#[tokio::test]
async fn capabilities_advertise_native_push_only_when_the_relay_can_deliver() {
    let credentialed = new_rig().await;
    let (_, service) = push_rig(&["apns", "fcm"], None);
    frames::register(credentialed.hub.dispatch(), &service).expect("the frames are free");
    let (socket, _handle) = desktop(&credentialed.hub, DEVICE);
    let capabilities = &socket.frames_of("relay-capabilities")[0];
    assert_eq!((capabilities["nativePush"].clone(), capabilities["nativePushPlatforms"].clone()), (json!(1), json!(["apns", "fcm"])));

    let bare = new_rig().await;
    let (_, none) = push_rig(&[], None);
    frames::register(bare.hub.dispatch(), &none).expect("the frames are free");
    let (socket, _handle) = desktop(&bare.hub, DEVICE);
    let capabilities = &socket.frames_of("relay-capabilities")[0];
    assert!(capabilities.get("nativePush").is_none() && capabilities.get("nativePushPlatforms").is_none());
}

#[tokio::test]
async fn only_the_desktop_that_bound_a_token_to_its_own_paired_client_can_send_to_it() {
    let rig = new_rig().await;
    pair(&rig, DEVICE, "aaaaaaaa").await;
    pair(&rig, OTHER_DEVICE, "bbbbbbbb").await;
    let (push, service) = push_rig(&["apns", "fcm"], None);
    frames::register(rig.hub.dispatch(), &service).expect("the frames are free");
    let (a, a_handle) = desktop(&rig.hub, DEVICE);
    let (b, b_handle) = desktop(&rig.hub, OTHER_DEVICE);

    send(&a_handle, &push_frame()).await;
    until(|| results(&a).len() == 1).await;
    assert_eq!(results(&a)[0]["error"], "unbound-token");

    // A client the desktop does not own cannot be bound.
    send(&a_handle, &bind_frame("bbbbbbbb")).await;
    send(&a_handle, &push_frame()).await;
    until(|| results(&a).len() == 2).await;
    assert_eq!(results(&a)[1]["error"], "unbound-token");

    send(&a_handle, &bind_frame("aaaaaaaa")).await;
    send(&a_handle, &push_frame()).await;
    until(|| results(&a).len() == 3).await;
    assert_eq!(
        results(&a)[2],
        json!({ "type": "native-push-result", "platform": "apns", "token": APNS_TOKEN, "collapseKey": "c1", "ok": true, "status": 200 })
    );
    assert_eq!(push.sent(), 1);

    // Another device cannot send through A's association, nor bind a client it does not own.
    send(&b_handle, &bind_frame("aaaaaaaa")).await;
    send(&b_handle, &push_frame()).await;
    until(|| results(&b).len() == 1).await;
    assert_eq!(results(&b)[0]["error"], "unbound-token");
    assert_eq!(push.sent(), 1);
}

#[tokio::test]
async fn unbinding_drops_this_desktops_association_and_revoking_a_client_or_the_device_drops_the_rest() {
    let rig = new_rig().await;
    pair(&rig, DEVICE, "aaaaaaaa").await;
    pair(&rig, DEVICE, "cccccccc").await;
    let (_, service) = push_rig(&["apns"], None);
    frames::register(rig.hub.dispatch(), &service).expect("the frames are free");
    let (socket, handle) = desktop(&rig.hub, DEVICE);

    send(&handle, &bind_frame("aaaaaaaa")).await;
    assert_eq!(service.association_count(APNS_TOKEN), Some(1));
    send(&handle, &json!({ "type": "native-push-unbind", "token": APNS_TOKEN })).await;
    assert_eq!(service.association_count(APNS_TOKEN), None);

    // Revoking the paired client drops its binding.
    send(&handle, &bind_frame("aaaaaaaa")).await;
    send(&handle, &json!({ "type": "revoke-client", "requestId": "r1", "clientId": "aaaaaaaa" })).await;
    assert_eq!(service.association_count(APNS_TOKEN), None);
    send(&handle, &push_frame()).await;
    until(|| results(&socket).len() == 1).await;
    assert_eq!(results(&socket)[0]["error"], "unbound-token");

    // Revoking the device drops every binding it held.
    send(&handle, &bind_frame("cccccccc")).await;
    assert_eq!(service.association_count(APNS_TOKEN), Some(1));
    send(&handle, &json!({ "type": "revoke-device" })).await;
    assert_eq!(service.association_count(APNS_TOKEN), None);
}

#[tokio::test]
async fn sends_are_validated_before_they_reach_the_platform() {
    let rig = new_rig().await;
    pair(&rig, DEVICE, "aaaaaaaa").await;
    let (push, service) = push_rig(&["apns"], None);
    frames::register(rig.hub.dispatch(), &service).expect("the frames are free");
    let (socket, handle) = desktop(&rig.hub, DEVICE);
    send(&handle, &bind_frame("aaaaaaaa")).await;
    let mut bad = push_frame();
    bad["reason"] = json!("nope");
    send(&handle, &bad).await;
    let mut no_key = push_frame();
    no_key.as_object_mut().expect("an object").remove("collapseKey");
    send(&handle, &no_key).await;
    until(|| results(&socket).len() == 2).await;
    assert_eq!(
        results(&socket)[0],
        json!({ "type": "native-push-result", "platform": "apns", "token": APNS_TOKEN, "collapseKey": "c1", "ok": false, "error": "invalid-message" })
    );
    assert_eq!(results(&socket)[1]["error"], "invalid-message");
    assert_eq!(push.sent(), 0);
}

#[tokio::test]
async fn a_push_in_flight_does_not_hold_back_the_frames_behind_it() {
    let rig = new_rig().await;
    pair(&rig, DEVICE, "aaaaaaaa").await;
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let (push, service) = push_rig(&["apns"], Some(Arc::clone(&gate)));
    frames::register(rig.hub.dispatch(), &service).expect("the frames are free");
    let (socket, handle) = desktop(&rig.hub, DEVICE);
    send(&handle, &bind_frame("aaaaaaaa")).await;
    send(&handle, &push_frame()).await;
    until(|| push.sent() == 1).await;
    send(&handle, &json!({ "type": "list-clients", "requestId": "r1" })).await;
    assert_eq!(socket.frames_of("clients-list").len(), 1);
    assert!(results(&socket).is_empty());
    gate.add_permits(1);
    until(|| results(&socket).len() == 1).await;
    assert_eq!(results(&socket)[0]["ok"], true);
}

#[tokio::test]
async fn a_relay_without_credentials_ignores_native_push_frames() {
    let rig = new_rig().await;
    pair(&rig, DEVICE, "aaaaaaaa").await;
    let (_, service) = push_rig(&[], None);
    frames::register(rig.hub.dispatch(), &service).expect("the frames are free");
    let (socket, handle) = desktop(&rig.hub, DEVICE);
    send(&handle, &bind_frame("aaaaaaaa")).await;
    send(&handle, &push_frame()).await;
    send(&handle, &json!({ "type": "list-clients", "requestId": "r1" })).await;
    assert!(results(&socket).is_empty());
    assert_eq!(service.association_count(APNS_TOKEN), None);
}
