//! Behaviour of the relay-facing modules against in-process mocks: identity files (DS-REM-8),
//! leg framing/caps/redial, media windows and crypto, relay push, ICE, and the bridge (LR §9).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use mixdog_remote::bridge::{Bridge, DialError, Dialer, Frame, PhoneSink, ToPhone, UpEvent, Upstream};
use mixdog_remote::identity::{DeviceFiles, Roster, is_owner_only, load_or_create_e2ee_identity, rotate_e2ee_identity};
use mixdog_remote::leg::caps::RelayCaps;
use mixdog_remote::leg::frame::{decode_binary_frame, encode_binary_frame, Payload};
use mixdog_remote::leg::inbound::{Inbound, classify};
use mixdog_remote::leg::redial::Redial;
use mixdog_remote::media::crypto::*;
use mixdog_remote::media::range::{Range, parse_range, window};
use mixdog_remote::push::decision::*;
use mixdog_remote::push::web::{WebPushTarget, encrypt_web_push_payload};
use mixdog_rt::LaneToken;
use mixdog_rt::CancellationToken;
use serde_json::json;
use tokio::sync::mpsc;

fn on_lane<R: Send + 'static>(job: impl FnOnce(&mixdog_rt::InLane<mixdog_rt::DurabilityIo>) -> R + Send + 'static) -> R {
    let out = Arc::new(Mutex::new(None));
    let slot = out.clone();
    mixdog_rt::testing::tokens()
        .durability_io
        .submit(&CancellationToken::new(), move |lane| {
            *slot.lock().unwrap() = Some(job(lane));
        })
        .unwrap();
    out.lock().unwrap().take().unwrap()
}

#[tokio::test]
async fn identity_files_are_owner_only_and_rotation_changes_them() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_path_buf();
    let (first, second, device_a, device_b, owner_only, queued) = on_lane(move |lane| {
        let first = load_or_create_e2ee_identity(lane, &path).unwrap();
        let again = load_or_create_e2ee_identity(lane, &path).unwrap();
        assert_eq!(first.server_public_key, again.server_public_key);
        let owner_only = is_owner_only(&path.join("relay-e2ee.json")).unwrap();
        // A readable-by-others copy is tightened on the next read, never served as is.
        assert!(load_or_create_e2ee_identity(lane, &path).is_ok());
        let second = rotate_e2ee_identity(lane, &path).unwrap();
        let files = DeviceFiles::new(&path);
        let device_a = files.load_or_create(lane).unwrap();
        let device_b = files.rotate(lane).unwrap();
        let queued = files.load_queue(lane).unwrap();
        (first.server_public_key, second.server_public_key, device_a, device_b, owner_only, queued)
    });
    assert!(owner_only);
    assert_ne!(first, second);
    assert_ne!(device_a.device_id, device_b.device_id);
    assert_eq!(queued, vec![device_a]);
}

#[tokio::test]
async fn a_named_device_file_is_kept_apart_from_the_desktop_registration() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_path_buf();
    let (desktop, hook, hook_again, owner_only) = on_lane(move |lane| {
        let desktop = DeviceFiles::new(&path).load_or_create(lane).unwrap();
        let hook_files = DeviceFiles::at(&path, "relay-hook-device.json");
        let hook = hook_files.load_or_create(lane).unwrap();
        let hook_again = DeviceFiles::at(&path, "relay-hook-device.json").load_or_create(lane).unwrap();
        let owner_only = is_owner_only(&path.join("relay-hook-device.json")).unwrap();
        // The desktop file is untouched by the other registration.
        assert_eq!(DeviceFiles::new(&path).load_or_create(lane).unwrap(), desktop);
        (desktop, hook, hook_again, owner_only)
    });
    assert_ne!(desktop, hook);
    assert_eq!(hook, hook_again);
    assert!(owner_only);
}

#[test]
fn leg_configs_keep_the_desktop_behavior_and_give_the_hook_leg_its_own() {
    use mixdog_remote::identity::DeviceIdentity;
    use mixdog_remote::leg::{Framing, LegConfig, RelayUrlError, leg_socket_request, validated_relay_url};
    let id = DeviceIdentity { device_id: "abcdef12".into(), device_secret: "0123456789abcdef".into() };
    let desktop = LegConfig::desktop("wss://relay.example".into(), id.clone(), 1024);
    assert_eq!(
        (desktop.path.as_str(), desktop.heartbeat, desktop.stable_reset, desktop.framing),
        ("/desktop", Duration::from_secs(10), Some(Duration::from_secs(30)), Framing::Desktop)
    );
    let hook = LegConfig::hook("wss://relay.example".into(), id.clone(), 1024);
    assert_eq!(
        (hook.path.as_str(), hook.heartbeat, hook.stable_reset, hook.framing),
        ("/hookleg", Duration::from_secs(25), None, Framing::Raw)
    );
    // Same credential, other path; query and fragment are dropped.
    let (a, auth_a) = leg_socket_request("wss://relay.example/x?y#z", "/desktop", &id).unwrap();
    let (b, auth_b) = leg_socket_request("wss://relay.example/x?y#z", "/hookleg", &id).unwrap();
    assert_eq!((a.as_str(), b.as_str()), ("wss://relay.example/desktop", "wss://relay.example/hookleg"));
    assert_eq!(auth_a, auth_b);
    // Desktop texts keep their periods; the hook texts (relay-tunnel.mjs) have none.
    let cases = [
        ("nonsense", "MIXDOG_RELAY_URL is invalid."),
        ("ws://example.com", "MIXDOG_RELAY_URL must use wss://; ws:// is allowed only for loopback development."),
        ("wss://u:p@example.com", "MIXDOG_RELAY_URL must not contain credentials."),
    ];
    for (raw, text) in cases {
        let error: RelayUrlError = validated_relay_url(raw).unwrap_err();
        assert_eq!(error.to_string(), text);
        assert_eq!(error.hook_text(), text.trim_end_matches('.'));
    }
}

#[tokio::test]
async fn roster_owes_access_keys_and_survives_reload() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_path_buf();
    let key = mixdog_remote::e2ee::generate_claim_key_pair().public_key;
    on_lane(move |lane| {
        let mut roster = Roster::load(lane, &path).unwrap();
        roster.set_controller_key(lane, "c1", &key).unwrap();
        roster.queue_revoke(lane, "c1").unwrap();
        let reloaded = Roster::load(lane, &path).unwrap();
        assert_eq!(reloaded.pending(), vec!["c1".to_owned()]);
        assert_eq!(reloaded.owed_access().keys, vec![key]);
        assert!(!reloaded.repair_required());
    });
}

#[test]
fn binary_frames_round_trip_and_caps_reset() {
    let id = "0123abcd-ef01";
    let frame = encode_binary_frame(id, b"hi", true, true).unwrap();
    let decoded = decode_binary_frame(&frame).unwrap();
    assert_eq!(decoded.payload, Payload::Text("hi".into()));
    assert!(decoded.droppable);
    assert!(decode_binary_frame(b"junk").is_none());
    let mut caps = RelayCaps::default();
    caps.handle(&json!({"type":"relay-capabilities","binaryFrames":1,"textFrames":1,"maxFrameBytes":1000,"webPush":1,"ice":1}));
    assert!(caps.binary_frames() && caps.web_push() && caps.ice());
    caps.learn_refused_limit(500);
    assert_eq!(caps.frame_limit(), 500);
    caps.reset();
    assert!(!caps.web_push());
    assert!(matches!(classify(json!({"type":"client-open","clientId":"x","browserClientId":"b"})), Inbound::ClientOpen { .. }));
}

#[test]
fn redial_backs_off_and_redials_stalled_handshakes_at_once() {
    let mut redial = Redial::default();
    assert_eq!(redial.after_close(None), Duration::from_secs(1));
    assert_eq!(redial.after_close(None), Duration::from_secs(2));
    redial.on_stable();
    assert_eq!(redial.after_close(Some(4010)), Duration::ZERO);
    assert_eq!(redial.after_close(Some(4010)), Duration::ZERO);
    assert_ne!(redial.after_close(Some(4010)), Duration::ZERO);
}

#[test]
fn media_ranges_windows_and_frames() {
    assert_eq!(parse_range("bytes=10-", 100), Range::Bytes { start: 10, end: 99 });
    assert_eq!(parse_range("bytes=-5", 100), Range::Bytes { start: 95, end: 99 });
    assert_eq!(parse_range("bytes=200-", 100), Range::Unsatisfiable);
    assert_eq!(window(Range::Whole, 10, 1 << 20), Some((0, 9)));
    let key = [7u8; 32];
    let meta = MediaWindowMeta { size: 10, mime: "video/mp4".into(), start: 0, end: 9, version: None };
    let frame = encrypt_media_meta(&key, "a", "original", &meta);
    let mut reader = MediaFrameReader::default();
    let bodies = [reader.push(&frame[..5]).unwrap(), reader.push(&frame[5..]).unwrap()].concat();
    assert_eq!(decrypt_media_meta(&key, "a", "original", 0, &bodies[0]).unwrap(), meta);
    assert!(decrypt_media_meta(&key, "b", "original", 0, &bodies[0]).is_err());
    let seg = encrypt_media_segment(&key, "a", "original", 0, 10, b"0123456789");
    assert_eq!(decrypt_media_segment(&key, "a", "original", 0, 10, &seg[4..]).unwrap(), b"0123456789");
    assert!(decrypt_media_segment(&key, "a", "original", 0, 11, &seg[4..]).is_err());
}

#[test]
fn web_push_payload_is_bounded_and_decryptable_shape() {
    let ua = p256::SecretKey::random(&mut p256::elliptic_curve::rand_core::OsRng);
    let mut auth = [0u8; 16];
    rand::fill(&mut auth[..]);
    use base64::Engine;
    use p256::elliptic_curve::sec1::ToEncodedPoint;
    let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let keys = mixdog_remote::e2ee::WebPushKeys {
        p256dh: b64.encode(ua.public_key().to_encoded_point(false).as_bytes()),
        auth: b64.encode(auth),
    };
    let local = p256::SecretKey::random(&mut p256::elliptic_curve::rand_core::OsRng);
    let body = encrypt_web_push_payload(&keys, b"hello", [1u8; 16], &local).unwrap();
    assert_eq!(&body[16..20], &4096u32.to_be_bytes());
    assert_eq!(body.len(), 16 + 4 + 1 + 65 + 5 + 1 + 16);
    assert!(encrypt_web_push_payload(&keys, &[0u8; 4000], [1u8; 16], &local).is_err());
    let _ = WebPushTarget { endpoint: String::new(), client_id: String::new(), p256dh: String::new(), auth: String::new() };
}

#[test]
fn notification_decision_orders_its_rules() {
    let prefs = DevicePreferences::default();
    let conversation = Conversation {
        session_id: "s".into(),
        kind: ConversationKind::Coding,
        origin: Origin::User,
        agent_id: String::new(),
        room_id: String::new(),
    };
    let input = |prefs: &DevicePreferences, foreground: bool, overrides: &[Override]| {
        decide(&DecisionInput {
            event: Event::Finished,
            conversation: &conversation,
            preferences: prefs,
            overrides,
            now: 1000,
            local: LocalTime { minute: 600, weekday: 2 },
            foreground,
            desktop_active: false,
        })
    };
    assert_eq!(input(&prefs, false, &[]), Decision::Notify);
    assert_eq!(input(&prefs, true, &[]), Decision::Skip(SkipReason::Foreground));
    let muted = [Override { kind: TargetKind::Session, id: "s".into(), setting: Setting::Muted { until: None } }];
    assert_eq!(input(&prefs, false, &muted), Decision::Skip(SkipReason::Muted));
    let mut bots = prefs.clone();
    bots.scope = Scope::Bots;
    assert_eq!(input(&bots, false, &[]), Decision::Skip(SkipReason::Scope));
    let mut quiet = prefs;
    quiet.quiet_hours.enabled = true;
    quiet.quiet_hours.start = "09:00".into();
    quiet.quiet_hours.end = "11:00".into();
    assert_eq!(input(&quiet, false, &[]), Decision::Skip(SkipReason::QuietHours));
}

#[tokio::test]
async fn ice_serves_cache_and_degrades_to_stun() {
    use mixdog_remote::ice::RemoteIceServers;
    let ice = RemoteIceServers::new();
    let issue = json!({"ok":true,"ttlSeconds":7200,"remainingMs":7_200_000,"servers":[
        {"urls":["stun:s.example:3478"]},
        {"urls":["turn:t.example:3478"],"username":"u","credential":"c"}]});
    let first = ice.resolve(|| async { Ok::<_, ()>(Some(issue)) }).await;
    assert_eq!(first.len(), 2);
    let cached = ice.resolve(|| async { Err::<Option<serde_json::Value>, ()>(()) }).await;
    assert_eq!(cached, first);
    ice.invalidate();
    let degraded = ice.resolve(|| async { Err::<Option<serde_json::Value>, ()>(()) }).await;
    assert_eq!(degraded.len(), 1);
    assert_eq!(degraded[0].urls, vec!["stun:s.example:3478".to_owned()]);
}

#[derive(Default)]
struct Fx {
    sent: Vec<serde_json::Value>,
    published: Vec<Option<(String, u64)>>,
    wakes: Vec<u64>,
}

impl mixdog_remote::pair_code::PairCodeEffects for Fx {
    fn send(&mut self, envelope: serde_json::Value) -> bool {
        self.sent.push(envelope);
        true
    }
    fn publish(&mut self, code: Option<&mixdog_remote::pair_code::PairCodeView>) {
        self.published.push(code.map(|c| (c.code.clone(), c.expires_at)));
    }
    fn wake_at(&mut self, at_ms: u64) {
        self.wakes.push(at_ms);
    }
}

#[test]
fn pair_code_is_published_on_change_and_nulled_by_the_ticker_at_expiry() {
    use mixdog_remote::pair_code::PairCode;
    let (mut pc, mut fx) = (PairCode::new(), Fx::default());
    pc.want(&mut fx, "PC", 1000);
    let lease = fx.sent[0]["lease"].as_str().unwrap().to_owned();
    pc.want(&mut fx, "PC", 1001);
    assert_eq!(fx.sent.len(), 1, "a request is already outstanding");
    pc.on_issued(&mut fx, &json!({"ok":true,"lease":lease,"code":"123456","expiresInMs":300000}), 1000);
    assert_eq!(fx.published, vec![Some(("123456".into(), 301_000))]);
    assert_eq!(fx.wakes, vec![301_000]);
    pc.on_tick(&mut fx, 300_999);
    assert_eq!(fx.published.len(), 1, "not yet expired");
    pc.on_tick(&mut fx, 301_000);
    assert_eq!(fx.published.last(), Some(&None));
    // renewed, then consumed by its own lease only
    pc.renew(&mut fx, "PC");
    let lease = fx.sent.last().unwrap()["lease"].as_str().unwrap().to_owned();
    pc.on_issued(&mut fx, &json!({"ok":true,"lease":lease,"code":"654321","expiresInMs":1000}), 5000);
    pc.on_used(&mut fx, &json!({"lease":"other"}));
    assert_eq!(fx.published.last(), Some(&Some(("654321".into(), 6000))));
    pc.on_used(&mut fx, &json!({"lease":lease}));
    assert_eq!(fx.published.last(), Some(&None));
    // an answer to a lease nobody asked for changes nothing
    let before = fx.published.len();
    pc.on_issued(&mut fx, &json!({"ok":true,"lease":"zzz","code":"111111","expiresInMs":1000}), 5000);
    assert_eq!(fx.published.len(), before);
}

#[derive(Default)]
struct Recorded(Mutex<Vec<(mixdog_protocol::SectionName, Option<String>, serde_json::Value)>>);

impl mixdog_core_api::state::StatePublisher for Recorded {
    fn publish(
        &self,
        section: mixdog_protocol::SectionName,
        key: Option<String>,
        change: mixdog_core_api::state::SectionChange,
    ) {
        let mixdog_core_api::state::SectionChange::Set(bytes) = change else { panic!("inline expected") };
        self.0.lock().unwrap().push((section, key, serde_json::from_slice(&bytes).unwrap()));
    }
}

#[test]
fn remote_section_publishes_the_whole_value_at_start_and_on_every_change() {
    use mixdog_remote::pair_code::PairCodeView;
    use mixdog_remote::section::{RemoteSection, RemoteSectionValue};
    let recorded = Arc::new(Recorded::default());
    let section = RemoteSection::new(recorded.clone(), RemoteSectionValue::default());
    {
        let log = recorded.0.lock().unwrap();
        assert_eq!(log.len(), 1, "first publish at startup");
        assert_eq!(log[0].0, mixdog_protocol::SectionName::Remote);
        assert_eq!(log[0].2["pairCode"], serde_json::Value::Null);
        for member in ["info", "settings", "claims", "clients", "controllerKeys", "owedKeys", "pairCode"] {
            assert!(log[0].2.get(member).is_some(), "{member} missing from the whole value");
        }
    }
    section.update(|v| v.settings = json!({"enabled": true}));
    section.set_pair_code(Some(&PairCodeView { code: "123456".into(), expires_at: 9000 }));
    section.set_pair_code(Some(&PairCodeView { code: "123456".into(), expires_at: 9000 }));
    section.set_pair_code(None);
    let log = recorded.0.lock().unwrap();
    assert_eq!(log.len(), 4, "an unchanged value is not republished");
    assert_eq!(log[2].2["pairCode"], json!({"code":"123456","expiresAt":9000}));
    assert_eq!(log[2].2["settings"], json!({"enabled": true}), "a pair-code change carries the rest of the section");
    assert_eq!(log[3].2["pairCode"], serde_json::Value::Null);
}

// ---- bridge (LR §9) ----

struct MockUp {
    to_core: mpsc::UnboundedSender<Frame>,
    from_core: mpsc::UnboundedReceiver<UpEvent>,
    closed: Arc<Mutex<Vec<u16>>>,
}

#[async_trait]
impl Upstream for MockUp {
    async fn send(&mut self, frame: Frame) -> Result<(), DialError> {
        self.to_core.send(frame).map_err(|_| DialError)
    }
    async fn recv(&mut self) -> Option<UpEvent> {
        self.from_core.recv().await
    }
    async fn close(&mut self, code: u16) {
        self.closed.lock().unwrap().push(code);
    }
}

type CoreEnd = (mpsc::UnboundedReceiver<Frame>, mpsc::UnboundedSender<UpEvent>);

struct MockDialer {
    cores: Mutex<Vec<CoreEnd>>,
    closed: Arc<Mutex<Vec<u16>>>,
    fail: bool,
}

#[async_trait]
impl Dialer for MockDialer {
    async fn dial(&self, _peer: &str) -> Result<Box<dyn Upstream>, DialError> {
        if self.fail {
            return Err(DialError);
        }
        let (to_core, core_rx) = mpsc::unbounded_channel();
        let (core_tx, from_core) = mpsc::unbounded_channel();
        self.cores.lock().unwrap().push((core_rx, core_tx));
        Ok(Box::new(MockUp { to_core, from_core, closed: self.closed.clone() }))
    }
}

struct Collect(mpsc::UnboundedSender<ToPhone>);

#[async_trait]
impl PhoneSink for Collect {
    async fn deliver(&self, message: ToPhone) {
        let _ = self.0.send(message);
    }
}

fn rig(fail: bool) -> (Bridge, Arc<MockDialer>, mpsc::UnboundedReceiver<ToPhone>) {
    let dialer = Arc::new(MockDialer { cores: Mutex::new(Vec::new()), closed: Arc::default(), fail });
    let (tx, rx) = mpsc::unbounded_channel();
    (Bridge::new(dialer.clone(), Arc::new(Collect(tx))), dialer, rx)
}

async fn settle() {
    tokio::time::sleep(Duration::from_millis(50)).await;
}

#[tokio::test]
async fn bridge_is_byte_transparent_and_forwards_core_close() {
    let (bridge, dialer, mut phone) = rig(false);
    bridge.client_open("p1");
    let frames = [Frame::Text("{\"a\":1} \u{1F600}".into()), Frame::Binary(vec![0, 255, 1]), Frame::Text(String::new())];
    for frame in &frames {
        bridge.from_phone("p1", frame.clone()).await;
    }
    settle().await;
    let (mut core_rx, core_tx) = dialer.cores.lock().unwrap().pop().unwrap();
    for frame in &frames {
        assert_eq!(&core_rx.recv().await.unwrap(), frame);
        core_tx.send(UpEvent::Frame(frame.clone())).unwrap();
        assert_eq!(phone.recv().await.unwrap(), ToPhone::Frame { peer_id: "p1".into(), frame: frame.clone() });
    }
    core_tx.send(UpEvent::Closed { code: 4002, reason: "version".into() }).unwrap();
    assert_eq!(phone.recv().await.unwrap(), ToPhone::Close { peer_id: "p1".into(), code: 4002, reason: "version".into() });
}

#[tokio::test]
async fn bridge_closes_on_client_close_revoke_leg_loss_and_target_change() {
    let (bridge, dialer, _phone) = rig(false);
    for id in ["a", "b", "c"] {
        bridge.client_open(id);
    }
    settle().await;
    bridge.close_peer("a");
    settle().await;
    assert_eq!(bridge.peer_count(), 2);
    bridge.close_all();
    settle().await;
    assert_eq!(bridge.peer_count(), 0);
    assert_eq!(dialer.closed.lock().unwrap().len(), 3);
    bridge.client_open("d");
    settle().await;
    let (other, _, _) = rig(false);
    drop(other);
    bridge.set_target(Arc::new(MockDialer { cores: Mutex::new(Vec::new()), closed: Arc::default(), fail: true }));
    settle().await;
    assert_eq!(bridge.peer_count(), 0);
    bridge.client_open("e");
    settle().await;
}

#[tokio::test]
async fn bridge_tells_the_phone_when_the_core_is_unreachable() {
    let (bridge, _dialer, mut phone) = rig(true);
    bridge.client_open("p");
    let ToPhone::Close { code, .. } = phone.recv().await.unwrap() else { panic!("expected close") };
    assert_eq!(code, 1013);
}

struct SlowFor(&'static str, mpsc::UnboundedSender<ToPhone>);

#[async_trait]
impl PhoneSink for SlowFor {
    async fn deliver(&self, message: ToPhone) {
        if matches!(&message, ToPhone::Frame { peer_id, .. } if peer_id == self.0) {
            std::future::pending::<()>().await;
        }
        let _ = self.1.send(message);
    }
}

#[tokio::test]
async fn a_stalled_phone_does_not_delay_another() {
    let dialer = Arc::new(MockDialer { cores: Mutex::new(Vec::new()), closed: Arc::default(), fail: false });
    let (tx, mut rx) = mpsc::unbounded_channel();
    let bridge = Bridge::new(dialer.clone(), Arc::new(SlowFor("slow", tx)));
    bridge.client_open("slow");
    settle().await;
    bridge.client_open("fast");
    settle().await;
    let (fast_tx, slow_tx) = {
        let mut cores = dialer.cores.lock().unwrap();
        (cores.pop().unwrap().1, cores.pop().unwrap().1)
    };
    for _ in 0..3 {
        slow_tx.send(UpEvent::Frame(Frame::Text("x".into()))).unwrap();
    }
    fast_tx.send(UpEvent::Frame(Frame::Text("y".into()))).unwrap();
    let got = tokio::time::timeout(Duration::from_secs(2), rx.recv()).await.unwrap().unwrap();
    assert_eq!(got, ToPhone::Frame { peer_id: "fast".into(), frame: Frame::Text("y".into()) });
}
