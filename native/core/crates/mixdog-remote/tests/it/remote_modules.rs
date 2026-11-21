//! Behaviour of the relay-facing modules against in-process mocks: identity files (DS-REM-8),
//! leg framing/caps/redial, media windows and crypto, relay push, ICE, and the bridge (LR §9).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use mixdog_remote::bridge::{Bridge, DialError, Dialer, Frame, PhoneSink, ToPhone, UpEvent, Upstream};
use mixdog_remote::identity::{DeviceFiles, Roster, is_owner_only, load_or_create_e2ee_identity, rotate_e2ee_identity};
use mixdog_remote::leg::caps::RelayCaps;
use mixdog_remote::leg::frame::{Payload, decode_binary_frame, encode_binary_frame};
use mixdog_remote::leg::inbound::{Inbound, classify};
use mixdog_remote::leg::redial::Redial;
use mixdog_remote::media::crypto::*;
use mixdog_remote::media::range::{Range, parse_range, window};
use mixdog_remote::push::web::{WebPushTarget, encrypt_web_push_payload};
use mixdog_rt::CancellationToken;
use mixdog_rt::LaneToken;
use serde_json::json;
use tokio::sync::mpsc;

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
    assert_eq!((hook.path.as_str(), hook.heartbeat, hook.stable_reset, hook.framing), ("/hookleg", Duration::from_secs(25), None, Framing::Raw));
    // Same credential, other path; query and fragment are dropped.
    let (a, auth_a) = leg_socket_request("wss://relay.example/x?y#z", "/desktop", &id).unwrap();
    let (b, auth_b) = leg_socket_request("wss://relay.example/x?y#z", "/hookleg", &id).unwrap();
    assert_eq!((a.as_str(), b.as_str()), ("wss://relay.example/desktop", "wss://relay.example/hookleg"));
    assert_eq!(auth_a, auth_b);
    // Desktop texts keep their periods; the hook texts have none.
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
    let ua = p256::SecretKey::generate();
    let mut auth = [0u8; 16];
    rand::fill(&mut auth[..]);
    use base64::Engine;
    use p256::elliptic_curve::Generate;
    use p256::elliptic_curve::sec1::ToSec1Point;
    let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let keys = mixdog_remote::e2ee::WebPushKeys { p256dh: b64.encode(ua.public_key().to_sec1_point(false).as_bytes()), auth: b64.encode(auth) };
    let local = p256::SecretKey::generate();
    let body = encrypt_web_push_payload(&keys, b"hello", [1u8; 16], &local).unwrap();
    assert_eq!(&body[16..20], &4096u32.to_be_bytes());
    assert_eq!(body.len(), 16 + 4 + 1 + 65 + 5 + 1 + 16);
    assert!(encrypt_web_push_payload(&keys, &[0u8; 4000], [1u8; 16], &local).is_err());
    let _ = WebPushTarget { endpoint: String::new(), client_id: String::new(), p256dh: String::new(), auth: String::new() };
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
    /// What a request submitted now is stamped with.
    clock: u64,
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
    fn now_ms(&self) -> u64 {
        self.clock
    }
}

/// `PairCode` with one owner per connection id, each with a lifetime token that a close cancels before its hook runs; the
/// event time of a call is also the clock of its `Fx`.
struct Harness {
    inner: mixdog_remote::pair_code::PairCode,
    owners: std::collections::BTreeMap<u64, mixdog_remote::pair_code::PairOwner>,
}

impl Harness {
    fn new() -> Self {
        Self { inner: mixdog_remote::pair_code::PairCode::new(), owners: Default::default() }
    }
    fn owner(&mut self, id: u64) -> mixdog_remote::pair_code::PairOwner {
        self.owners.entry(id).or_insert_with(|| mixdog_remote::pair_code::PairOwner { id, alive: CancellationToken::new() }).clone()
    }
    fn want(&mut self, fx: &mut Fx, host: &str, now: u64, id: u64) {
        fx.clock = now;
        let owner = self.owner(id);
        self.inner.want(fx, host, now, &owner).unwrap();
    }
    fn renew(&mut self, fx: &mut Fx, host: &str, now: u64) {
        fx.clock = now;
        let owner = self.owner(1);
        self.inner.renew(fx, host, now, &owner).unwrap();
    }
    fn release(&mut self, fx: &mut Fx, id: u64) {
        self.inner.release(fx, id);
    }
    /// The connection ends: its token is cancelled, then the hook runs.
    fn connection_closed(&mut self, fx: &mut Fx, id: u64) {
        self.owner(id).alive.cancel();
        self.inner.connection_closed(fx, id);
    }
    fn on_issued(&mut self, fx: &mut Fx, envelope: &serde_json::Value, now: u64) {
        fx.clock = now;
        self.inner.on_issued(fx, envelope, now);
    }
    fn on_used(&mut self, fx: &mut Fx, envelope: &serde_json::Value) {
        self.inner.on_used(fx, envelope);
    }
    fn on_connected(&mut self, fx: &mut Fx, host: &str, now: u64) {
        fx.clock = now;
        self.inner.on_connected(fx, host, now);
    }
    fn on_tick(&mut self, fx: &mut Fx, now: u64) {
        fx.clock = now;
        self.inner.on_tick(fx, now);
    }
    fn unsupported(&self) -> bool {
        self.inner.unsupported()
    }
}

#[test]
fn a_new_code_request_clears_the_shown_code_until_the_relay_answers() {
    let (mut pc, mut fx) = (Harness::new(), Fx::default());
    pc.want(&mut fx, "PC", 1000, 1);
    let lease = fx.sent[0]["lease"].as_str().unwrap().to_owned();
    pc.on_issued(&mut fx, &json!({"ok":true,"lease":lease,"code":"123456","expiresInMs":300000}), 1000);
    pc.renew(&mut fx, "PC", 2000);
    assert!(pc.inner.current().is_none(), "the old code is not returned while the new one is awaited");
    assert_eq!(fx.published.last(), Some(&None));
    let lease = fx.sent.last().unwrap()["lease"].as_str().unwrap().to_owned();
    pc.on_issued(&mut fx, &json!({"ok":true,"lease":lease,"code":"654321","expiresInMs":300000}), 2500);
    assert_eq!(fx.published.last(), Some(&Some(("654321".into(), 302_500))));
}

#[test]
fn pair_code_is_published_on_change_and_nulled_by_the_ticker_at_expiry() {
    use self::Harness as PairCode;
    let (mut pc, mut fx) = (PairCode::new(), Fx::default());
    pc.want(&mut fx, "PC", 1000, 1);
    let lease = fx.sent[0]["lease"].as_str().unwrap().to_owned();
    pc.want(&mut fx, "PC", 1001, 1);
    assert_eq!(fx.sent.len(), 1, "a request is already outstanding");
    pc.on_issued(&mut fx, &json!({"ok":true,"lease":lease,"code":"123456","expiresInMs":300000}), 1000);
    assert_eq!(fx.published, vec![Some(("123456".into(), 301_000))]);
    assert_eq!(fx.wakes.last(), Some(&271_000), "the renewal lead is the first thing due");
    pc.want(&mut fx, "PC", 299_000, 1);
    pc.on_tick(&mut fx, 300_999);
    assert_eq!(fx.published.len(), 1, "not yet expired");
    pc.on_tick(&mut fx, 301_000);
    assert_eq!(fx.published.last(), Some(&None));
    // renewed, then consumed by its own lease only
    pc.renew(&mut fx, "PC", 301_000);
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

fn requests(fx: &Fx) -> usize {
    fx.sent.iter().filter(|frame| frame["type"] == "pair-code-request").count()
}

/// The relay answers the newest request with `code`.
fn answer(pc: &mut Harness, fx: &mut Fx, code: &str, ttl: u64, now: u64) -> String {
    let lease = fx.sent.iter().rev().find(|frame| frame["type"] == "pair-code-request").unwrap()["lease"].as_str().unwrap().to_owned();
    pc.on_issued(fx, &json!({"ok":true,"lease":lease,"code":code,"expiresInMs":ttl}), now);
    lease
}

fn shown(fx: &Fx) -> Option<String> {
    fx.published.last().cloned().flatten().map(|(code, _)| code)
}

#[test]
fn a_used_code_is_replaced_without_leaving_the_screen_and_a_second_phone_can_pair() {
    use self::Harness as PairCode;
    let (mut pc, mut fx) = (PairCode::new(), Fx::default());
    pc.want(&mut fx, "PC", 0, 1);
    let first = answer(&mut pc, &mut fx, "111111", 300_000, 100);
    pc.on_used(&mut fx, &json!({"lease": first}));
    assert_eq!(shown(&fx), None);
    assert_eq!(fx.wakes.last(), Some(&0), "the replacement is due at once");
    pc.on_tick(&mut fx, 200);
    assert_eq!(requests(&fx), 2);
    let second = answer(&mut pc, &mut fx, "222222", 300_000, 300);
    assert_eq!(shown(&fx).as_deref(), Some("222222"));
    pc.on_used(&mut fx, &json!({"lease": second}));
    pc.on_tick(&mut fx, 400);
    assert_eq!(requests(&fx), 3);
    answer(&mut pc, &mut fx, "333333", 300_000, 500);
    assert_eq!(shown(&fx).as_deref(), Some("333333"));
    assert_eq!(fx.sent.iter().find(|f| f["type"] == "pair-code-request").unwrap()["name"], "PC");
}

#[test]
fn the_next_code_is_asked_before_the_shown_one_expires() {
    use self::Harness as PairCode;
    let (mut pc, mut fx) = (PairCode::new(), Fx::default());
    pc.want(&mut fx, "PC", 0, 1);
    answer(&mut pc, &mut fx, "111111", 300_000, 0);
    assert_eq!(requests(&fx), 1);
    assert_eq!(fx.wakes.last(), Some(&270_000), "the renewal lead is the next thing due, with no further call from the view");
    pc.on_tick(&mut fx, 270_000);
    assert_eq!(requests(&fx), 2);
    assert_eq!(shown(&fx).as_deref(), Some("111111"), "the old code stays up until the new one lands");
    answer(&mut pc, &mut fx, "222222", 300_000, 270_100);
    assert_eq!(shown(&fx).as_deref(), Some("222222"));
    assert!(fx.published.iter().all(Option::is_some), "the screen never showed a gap");
    // The old code's expiry, reached meanwhile, takes nothing away.
    pc.on_tick(&mut fx, 300_000);
    assert_eq!(shown(&fx).as_deref(), Some("222222"));
    // And an open view stays served for ever: each code is replaced ahead of its end.
    pc.on_tick(&mut fx, 540_100);
    assert_eq!(requests(&fx), 3);
    answer(&mut pc, &mut fx, "333333", 300_000, 540_200);
    assert_eq!(shown(&fx).as_deref(), Some("333333"));
    assert!(fx.published.iter().all(Option::is_some), "the screen never showed a gap");
}

#[test]
fn a_silent_relay_ends_as_unsupported_until_a_leg_opens_again() {
    use self::Harness as PairCode;
    let (mut pc, mut fx) = (PairCode::new(), Fx::default());
    pc.want(&mut fx, "PC", 0, 1);
    assert_eq!(fx.wakes.last(), Some(&5_001), "the end of the wait is armed");
    pc.on_tick(&mut fx, 5_000);
    assert!(!pc.unsupported(), "still within the wait");
    pc.on_tick(&mut fx, 5_001);
    assert!(pc.unsupported());
    pc.renew(&mut fx, "PC", 6_000);
    pc.want(&mut fx, "PC", 7_000, 1);
    assert_eq!(requests(&fx), 1, "a relay without codes is not asked again");
    pc.on_connected(&mut fx, "PC", 10_000);
    assert!(!pc.unsupported());
    assert_eq!(requests(&fx), 2);
    pc.on_tick(&mut fx, 15_001);
    assert!(pc.unsupported());
    // A refusal is the same state.
    let (mut pc, mut fx) = (PairCode::new(), Fx::default());
    pc.want(&mut fx, "PC", 0, 1);
    let lease = fx.sent[0]["lease"].as_str().unwrap().to_owned();
    pc.on_issued(&mut fx, &json!({"ok":false,"lease":lease}), 10);
    assert!(pc.unsupported());
}

#[test]
fn a_released_view_is_not_served_any_more() {
    use self::Harness as PairCode;
    let (mut pc, mut fx) = (PairCode::new(), Fx::default());
    pc.want(&mut fx, "PC", 0, 1);
    let lease = answer(&mut pc, &mut fx, "111111", 300_000, 0);
    pc.release(&mut fx, 1);
    assert_eq!(fx.sent.last().unwrap()["type"], "pair-code-clear");
    let (sent, wakes) = (fx.sent.len(), fx.wakes.len());
    pc.on_used(&mut fx, &json!({"lease": lease}));
    pc.on_tick(&mut fx, 10);
    pc.on_tick(&mut fx, 400_000);
    pc.on_connected(&mut fx, "PC", 500_000);
    assert_eq!((fx.sent.len(), fx.wakes.len()), (sent, wakes), "nothing is requested or armed for a view that is gone");
}

#[test]
fn two_views_hold_independently_and_the_last_connection_dropping_ends_the_hold() {
    use self::Harness as PairCode;
    let (mut pc, mut fx) = (PairCode::new(), Fx::default());
    pc.want(&mut fx, "PC", 0, 1);
    pc.want(&mut fx, "PC", 10, 2);
    assert_eq!(requests(&fx), 1, "the second view joins the code in hand");
    answer(&mut pc, &mut fx, "111111", 300_000, 20);
    // One view released, the other's connection untouched: still served.
    pc.release(&mut fx, 1);
    assert_eq!(shown(&fx).as_deref(), Some("111111"));
    assert!(fx.sent.iter().all(|frame| frame["type"] != "pair-code-clear"));
    pc.on_tick(&mut fx, 270_100);
    assert_eq!(requests(&fx), 2, "still renewed for the view that remains");
    // A release by a connection that holds nothing changes nothing.
    pc.release(&mut fx, 9);
    assert_eq!(shown(&fx).as_deref(), Some("111111"));
    // The remaining view's connection drops without a release: the hold ends and the code is withdrawn.
    pc.connection_closed(&mut fx, 2);
    assert_eq!(shown(&fx), None);
    assert_eq!(fx.sent.last().unwrap()["type"], "pair-code-clear");
    let (sent, wakes) = (fx.sent.len(), fx.wakes.len());
    pc.on_tick(&mut fx, 400_000);
    pc.on_connected(&mut fx, "PC", 500_000);
    assert_eq!((fx.sent.len(), fx.wakes.len()), (sent, wakes), "no more codes are minted");
    // The same view reconnecting takes a new hold and is served again.
    pc.want(&mut fx, "PC", 600_000, 3);
    assert_eq!(requests(&fx), 3);
    answer(&mut pc, &mut fx, "222222", 300_000, 600_100);
    assert_eq!(shown(&fx).as_deref(), Some("222222"));
}

#[test]
fn the_last_connection_closing_clears_the_code_and_a_late_issuance_is_ignored() {
    use mixdog_remote::pair_code::NotHeld;
    let (mut h, mut fx) = (Harness::new(), Fx::default());
    let (a, b) = (h.owner(1), h.owner(2));
    h.inner.want(&mut fx, "PC", 0, &a).unwrap();
    h.inner.want(&mut fx, "PC", 0, &b).unwrap();
    let late = fx.sent[0]["lease"].as_str().unwrap().to_owned();
    // The first owner closes while the request is still out; the second stays: its code is still served.
    h.connection_closed(&mut fx, 1);
    assert!(fx.sent.iter().all(|frame| frame["type"] != "pair-code-clear"));
    // The last owner closes: the pending request is dropped and withdrawn, so its answer changes nothing.
    h.connection_closed(&mut fx, 2);
    assert_eq!(fx.sent.last().unwrap()["type"], "pair-code-clear");
    h.on_issued(&mut fx, &json!({"ok":true,"lease":late,"code":"999999","expiresInMs":300000}), 10);
    assert!(fx.published.is_empty(), "a late issuance is not shown");
    // A connection that has already closed cannot take a hold.
    let (sent, wakes) = (fx.sent.len(), fx.wakes.len());
    assert_eq!(h.inner.want(&mut fx, "PC", 20, &a), Err(NotHeld));
    assert_eq!((fx.sent.len(), fx.wakes.len(), fx.published.len()), (sent, wakes, 0));
}

#[test]
fn an_ended_owners_late_renew_does_not_touch_a_surviving_owners_code() {
    use mixdog_remote::pair_code::NotHeld;
    let (mut h, mut fx) = (Harness::new(), Fx::default());
    let (a, b) = (h.owner(1), h.owner(2));
    h.inner.want(&mut fx, "PC", 0, &a).unwrap();
    h.inner.want(&mut fx, "PC", 0, &b).unwrap();
    answer(&mut h, &mut fx, "111111", 300_000, 10);
    h.connection_closed(&mut fx, 1);
    let before = (fx.sent.len(), fx.wakes.len(), fx.published.len());
    assert_eq!(h.inner.renew(&mut fx, "PC", 20, &a), Err(NotHeld), "its connection has closed");
    let stranger = h.owner(7);
    assert_eq!(h.inner.renew(&mut fx, "PC", 20, &stranger), Err(NotHeld), "it holds nothing");
    assert_eq!((fx.sent.len(), fx.wakes.len(), fx.published.len()), before);
    assert_eq!(shown(&fx).as_deref(), Some("111111"));
    // An owner whose connection has ended counts for nothing even before its close hook ran.
    b.alive.cancel();
    h.on_tick(&mut fx, 270_100);
    assert_eq!(requests(&fx), 1, "no renewal for a view that is gone");
    h.connection_closed(&mut fx, 2);
    assert_eq!(shown(&fx), None);
}

#[test]
fn a_request_is_stamped_when_it_is_sent_so_it_gets_its_full_response_timeout() {
    let (mut h, mut fx) = (Harness::new(), Fx::default());
    let a = h.owner(1);
    // The caller's own `now` is long stale (taken before a slow startup); the clock at submission is what counts.
    fx.clock = 50_000;
    h.inner.want(&mut fx, "PC", 0, &a).unwrap();
    assert_eq!(fx.wakes.last(), Some(&55_001));
    h.on_tick(&mut fx, 55_000);
    assert!(!h.unsupported(), "the wait is not over at its full length");
    h.on_tick(&mut fx, 55_001);
    assert!(h.unsupported());
}

/// What a recording `PairCodeEffects` saw, shared with the test.
#[derive(Default)]
struct Seen {
    sent: Vec<serde_json::Value>,
    published: Vec<Option<(String, u64)>>,
}

struct SeenFx(Arc<Mutex<Seen>>);

impl mixdog_remote::pair_code::PairCodeEffects for SeenFx {
    fn send(&mut self, envelope: serde_json::Value) -> bool {
        self.0.lock().unwrap().sent.push(envelope);
        true
    }
    fn publish(&mut self, code: Option<&mixdog_remote::pair_code::PairCodeView>) {
        self.0.lock().unwrap().published.push(code.map(|c| (c.code.clone(), c.expires_at)));
    }
    fn wake_at(&mut self, _: u64) {}
}

fn owner_of(id: u64) -> mixdog_remote::pair_code::PairOwner {
    mixdog_remote::pair_code::PairOwner { id, alive: CancellationToken::new() }
}

fn frames(seen: &Arc<Mutex<Seen>>) -> Vec<String> {
    seen.lock().unwrap().sent.iter().map(|frame| frame["type"].as_str().unwrap().to_owned()).collect()
}

type Startup = tokio::sync::oneshot::Receiver<Result<(), mixdog_remote::access::runtime::RemoteError>>;

async fn startup_of(rx: Startup) -> Result<(), mixdog_remote::access::runtime::RemoteError> {
    rx.await.unwrap()
}

#[derive(Default)]
struct Recorded(Mutex<Vec<(mixdog_protocol::SectionName, Option<String>, serde_json::Value)>>);

impl mixdog_core_api::state::StatePublisher for Recorded {
    fn publish(&self, section: mixdog_protocol::SectionName, key: Option<String>, change: mixdog_core_api::state::SectionChange) {
        let mixdog_core_api::state::SectionChange::Set(bytes) = change else { panic!("inline expected") };
        self.0.lock().unwrap().push((section, key, serde_json::from_slice(&bytes).unwrap()));
    }
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

#[tokio::test]
async fn bridge_tells_the_phone_when_the_core_is_unreachable() {
    let (bridge, _dialer, mut phone) = rig(true);
    bridge.client_open_as("p", 0);
    let ToPhone::Close { code, .. } = phone.recv().await.unwrap() else { panic!("expected close") };
    assert_eq!(code, 1013);
}

/// A core socket whose send never completes, and that counts its closes.
struct Blocked(Arc<Mutex<u32>>);

#[async_trait]
impl Upstream for Blocked {
    async fn send(&mut self, _: Frame) -> Result<(), DialError> {
        std::future::pending().await
    }
    async fn recv(&mut self) -> Option<UpEvent> {
        std::future::pending().await
    }
    async fn close(&mut self, _: u16) {
        *self.0.lock().unwrap() += 1;
    }
}

struct BlockedDialer(Arc<Mutex<u32>>);

#[async_trait]
impl Dialer for BlockedDialer {
    async fn dial(&self, _: &str) -> Result<Box<dyn Upstream>, DialError> {
        Ok(Box::new(Blocked(self.0.clone())))
    }
}

/// A target whose dial never finishes: nothing leaves a peer's queue.
struct Stuck;

#[async_trait]
impl Dialer for Stuck {
    async fn dial(&self, _peer: &str) -> Result<Box<dyn Upstream>, DialError> {
        std::future::pending().await
    }
}

fn stuck_bridge(budget: u64) -> Bridge {
    let (tx, _phone) = mpsc::unbounded_channel();
    Bridge::with_frame_budget(Arc::new(Stuck), Arc::new(Collect(tx)), budget)
}

/// The budget check: a phone past 256 frames, past the byte budget, or a phone that takes
/// all of them past 512 frames or twice the budget, is refused at once, never parked behind the queue.
#[tokio::test]
async fn a_phone_over_its_frame_budget_is_refused_not_waited_for() {
    let bridge = stuck_bridge(1 << 20);
    bridge.client_open_as("p1", 0);
    for _ in 0..256 {
        assert!(bridge.from_phone("p1", 0, Frame::Text("x".into())), "within the budget");
    }
    assert!(!bridge.from_phone("p1", 0, Frame::Text("x".into())), "one past 256 frames is refused");
    assert!(bridge.from_phone("nobody", 0, Frame::Text("x".into())), "a peer with no bridge is dropped, not a backlog");

    // Bytes: one peer's budget, then all peers' twice that.
    let bridge = stuck_bridge(100);
    for id in ["a", "b", "c"] {
        bridge.client_open_as(id, 0);
    }
    assert!(bridge.from_phone("a", 0, Frame::Binary(vec![0; 60])));
    assert!(!bridge.from_phone("a", 0, Frame::Binary(vec![0; 41])), "past one peer's byte budget");
    assert!(bridge.from_phone("a", 0, Frame::Binary(vec![0; 40])));
    assert!(bridge.from_phone("b", 0, Frame::Binary(vec![0; 100])));
    assert!(!bridge.from_phone("c", 0, Frame::Binary(vec![0; 1])), "all peers together are at twice the budget");

    // Frames: 512 over all peers.
    let bridge = stuck_bridge(1 << 20);
    for id in ["a", "b", "c"] {
        bridge.client_open_as(id, 0);
    }
    for _ in 0..256 {
        assert!(bridge.from_phone("a", 0, Frame::Text("x".into())));
        assert!(bridge.from_phone("b", 0, Frame::Text("x".into())));
    }
    assert!(!bridge.from_phone("c", 0, Frame::Text("x".into())), "a third peer is refused at 512 frames in all");
}

/// Many phones delivering at once never take more than the 512 frames all together may hold: the last places are won by exactly as
/// many deliveries as there are places.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_deliveries_never_pass_the_total_frame_budget() {
    let bridge = Arc::new(stuck_bridge(1 << 20));
    let ids: Vec<String> = (0..8).map(|n| format!("p{n}")).collect();
    for id in &ids {
        bridge.client_open_as(id, 0);
    }
    let admitted = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let workers: Vec<_> = ids
        .into_iter()
        .map(|id| {
            let (bridge, admitted) = (bridge.clone(), admitted.clone());
            std::thread::spawn(move || {
                for _ in 0..200 {
                    if bridge.from_phone(&id, 0, Frame::Text("x".into())) {
                        admitted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    }
                }
            })
        })
        .collect();
    for worker in workers {
        worker.join().unwrap();
    }
    assert_eq!(admitted.load(std::sync::atomic::Ordering::SeqCst), 512, "exactly the 512 places, never one more");
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
        let owner_only = is_owner_only(&path.join("e2ee.json")).unwrap();
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
async fn settle() {
    mixdog_rt::time::sleep(Duration::from_millis(50)).await;
}
#[tokio::test(start_paused = true)]
async fn bridge_is_byte_transparent_and_forwards_core_close() {
    let (bridge, dialer, mut phone) = rig(false);
    bridge.client_open_as("p1", 0);
    let frames = [Frame::Text("{\"a\":1} \u{1F600}".into()), Frame::Binary(vec![0, 255, 1]), Frame::Text(String::new())];
    for frame in &frames {
        assert!(bridge.from_phone("p1", 0, frame.clone()));
    }
    settle().await;
    let (mut core_rx, core_tx) = dialer.cores.lock().unwrap().pop().unwrap();
    for frame in &frames {
        assert_eq!(&core_rx.recv().await.unwrap(), frame);
        core_tx.send(UpEvent::Frame(frame.clone())).unwrap();
        assert_eq!(phone.recv().await.unwrap(), ToPhone::Frame { peer_id: "p1".into(), generation: 0, frame: frame.clone() });
    }
    core_tx.send(UpEvent::Closed { code: 4002, reason: "version".into() }).unwrap();
    assert_eq!(phone.recv().await.unwrap(), ToPhone::Close { peer_id: "p1".into(), generation: 0, code: 4002, reason: "version".into() });
}
#[tokio::test(start_paused = true)]
async fn bridge_closes_on_client_close_revoke_leg_loss_and_target_change() {
    let (bridge, dialer, _phone) = rig(false);
    for id in ["a", "b", "c"] {
        bridge.client_open_as(id, 0);
    }
    settle().await;
    bridge.close_peer("a", 0);
    settle().await;
    assert_eq!(bridge.peer_count(), 2);
    bridge.close_all();
    settle().await;
    assert_eq!(bridge.peer_count(), 0);
    assert_eq!(dialer.closed.lock().unwrap().len(), 3);
    bridge.client_open_as("d", 0);
    settle().await;
    let (other, _, _) = rig(false);
    drop(other);
    bridge.set_target(Arc::new(MockDialer { cores: Mutex::new(Vec::new()), closed: Arc::default(), fail: true }));
    settle().await;
    assert_eq!(bridge.peer_count(), 0);
    bridge.client_open_as("e", 0);
    settle().await;
}
/// A socket blocked in its send is closed when the peer is reopened, and nothing it later does can close the replacement: the old
/// open is no longer the peer's, which is what a sink checks before it acts on a close.
#[tokio::test(start_paused = true)]
async fn a_blocked_old_socket_is_closed_on_reopen_and_its_open_is_no_longer_current() {
    let closes = Arc::new(Mutex::new(0));
    let (tx, mut phone) = mpsc::unbounded_channel();
    let bridge = Bridge::new(Arc::new(BlockedDialer(closes.clone())), Arc::new(Collect(tx)));
    bridge.client_open_as("p1", 0);
    settle().await;
    assert!(bridge.from_phone("p1", 0, Frame::Text("x".into())));
    settle().await;
    assert!(bridge.is_current("p1", 0));
    bridge.client_open_as("p1", 1);
    settle().await;
    assert_eq!(*closes.lock().unwrap(), 1, "the blocked send did not keep the old socket open");
    assert!(!bridge.is_current("p1", 0) && bridge.is_current("p1", 1));
    assert!(phone.try_recv().is_err(), "the retired open reported nothing to the phone");
}
/// A frame the core has taken frees its place: a phone that keeps up is never refused.
#[tokio::test(start_paused = true)]
async fn the_budget_is_freed_as_the_core_takes_frames() {
    let (bridge, dialer, _phone) = rig(false);
    bridge.client_open_as("p1", 0);
    settle().await;
    let (mut core_rx, _core_tx) = dialer.cores.lock().unwrap().pop().unwrap();
    for _ in 0..3 {
        for _ in 0..200 {
            assert!(bridge.from_phone("p1", 0, Frame::Text("x".into())));
        }
        for _ in 0..200 {
            core_rx.recv().await.unwrap();
        }
        settle().await;
    }
}
#[tokio::test(start_paused = true)]
async fn a_stalled_phone_does_not_delay_another() {
    let dialer = Arc::new(MockDialer { cores: Mutex::new(Vec::new()), closed: Arc::default(), fail: false });
    let (tx, mut rx) = mpsc::unbounded_channel();
    let bridge = Bridge::new(dialer.clone(), Arc::new(SlowFor("slow", tx)));
    bridge.client_open_as("slow", 0);
    settle().await;
    bridge.client_open_as("fast", 0);
    settle().await;
    let (fast_tx, slow_tx) = {
        let mut cores = dialer.cores.lock().unwrap();
        (cores.pop().unwrap().1, cores.pop().unwrap().1)
    };
    for _ in 0..3 {
        slow_tx.send(UpEvent::Frame(Frame::Text("x".into()))).unwrap();
    }
    fast_tx.send(UpEvent::Frame(Frame::Text("y".into()))).unwrap();
    let got = mixdog_rt::time::timeout(Duration::from_secs(2), rx.recv()).await.unwrap().unwrap();
    assert_eq!(got, ToPhone::Frame { peer_id: "fast".into(), generation: 0, frame: Frame::Text("y".into()) });
}

/// A runtime that never starts (the tests give `pair_code_after` the startup it waits for), over a recording pair-code effects.
fn pair_runtime(dir: &std::path::Path) -> (mixdog_remote::access::runtime::RemoteRuntime, Arc<Mutex<Seen>>) {
    use mixdog_remote::access::runtime::{LegLink, RemoteRuntime, RuntimeConfig};
    use mixdog_remote::access::settings::AccessSettings;
    use mixdog_remote::registry::DeviceRegistry;
    use mixdog_remote::section::{RemoteSection, RemoteSectionValue};
    let seen = Arc::new(Mutex::new(Seen::default()));
    let cfg = RuntimeConfig {
        dir: dir.to_path_buf(),
        relay_url: Some("ws://127.0.0.1:9".to_owned()),
        app_version: None,
        durability: mixdog_rt::testing::tokens().durability_io,
        dialer: Arc::new(crate::common::NoDial),
        registry: Arc::new(DeviceRegistry::default()),
        section: Arc::new(RemoteSection::new(Arc::new(crate::common::Silent), RemoteSectionValue::default())),
        settings: Arc::new(AccessSettings::new(dir.to_path_buf(), Arc::new(|| "PC".to_owned()))),
        link: LegLink::default(),
        events: Arc::new(crate::common::Quiet),
    };
    let handle = seen.clone();
    (RemoteRuntime::new(cfg, Box::new(move |_| Box::new(SeenFx(handle)))), seen)
}
#[tokio::test]
async fn closing_the_connection_during_startup_leaves_no_hold_whether_startup_succeeds_or_fails() {
    use mixdog_remote::access::runtime::RemoteError;
    let dir = tempfile::tempdir().unwrap();
    let (rt, seen) = pair_runtime(dir.path());
    for outcome in [Ok(()), Err(RemoteError::Failed("no leg".into()))] {
        let (first, second) = (owner_of(1), owner_of(2));
        let (tx, rx) = tokio::sync::oneshot::channel();
        let mut ensure = Box::pin(rt.pair_code_after("ensure", Some(first.clone()), startup_of(rx)));
        assert!(futures::poll!(ensure.as_mut()).is_pending(), "startup is suspended");
        assert_eq!(frames(&seen).last().map(String::as_str), Some("pair-code-request"), "the hold was taken before startup");
        // The connection closes (its token first, then the hook) while startup is still running.
        first.alive.cancel();
        rt.connection_closed(first.id);
        assert_eq!(frames(&seen).last().map(String::as_str), Some("pair-code-clear"));
        let after_close = frames(&seen);
        tx.send(outcome.clone()).unwrap();
        assert_eq!(ensure.await.is_ok(), outcome.is_ok());
        assert_eq!(frames(&seen), after_close, "finishing startup mints nothing");
        assert!(seen.lock().unwrap().published.is_empty());
        // The ended owner cannot renew, and a reconnecting view takes a new hold under a new connection.
        assert!(rt.pair_code_after("renew", Some(first), async { Ok(()) }).await.is_err());
        assert_eq!(frames(&seen), after_close);
        rt.pair_code_after("ensure", Some(second.clone()), async { Ok(()) }).await.unwrap();
        assert_eq!(frames(&seen).last().map(String::as_str), Some("pair-code-request"));
        rt.connection_closed(second.id);
        seen.lock().unwrap().sent.clear();
    }
}
#[tokio::test]
async fn a_failed_startup_leaves_the_hold_of_a_view_that_is_still_open() {
    use mixdog_remote::access::runtime::RemoteError;
    let dir = tempfile::tempdir().unwrap();
    let (rt, seen) = pair_runtime(dir.path());
    let owner = owner_of(1);
    let failed = rt.pair_code_after("ensure", Some(owner.clone()), async { Err(RemoteError::Failed("no leg".into())) }).await;
    assert!(failed.is_err());
    assert_eq!(frames(&seen), ["pair-code-request"], "nothing is taken back or asked again");
    // The hold is still the view's own: it can renew, and its close ends it.
    rt.pair_code_after("renew", Some(owner.clone()), async { Ok(()) }).await.unwrap();
    owner.alive.cancel();
    rt.connection_closed(owner.id);
    assert_eq!(frames(&seen).last().map(String::as_str), Some("pair-code-clear"));
}
#[tokio::test]
async fn an_acquisition_after_the_connection_closed_or_without_a_connection_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let (rt, seen) = pair_runtime(dir.path());
    let closed = owner_of(1);
    closed.alive.cancel();
    assert!(rt.pair_code_after("ensure", Some(closed.clone()), async { Ok(()) }).await.is_err());
    assert!(rt.pair_code_after("renew", Some(closed), async { Ok(()) }).await.is_err());
    for action in ["ensure", "renew", "release"] {
        assert!(rt.pair_code_after(action, None, async { Ok(()) }).await.is_err(), "{action} needs a connection");
    }
    assert!(frames(&seen).is_empty() && seen.lock().unwrap().published.is_empty(), "nothing was created");
}
#[tokio::test]
async fn a_release_during_startup_is_not_undone_by_the_startup_finishing() {
    let dir = tempfile::tempdir().unwrap();
    let (rt, seen) = pair_runtime(dir.path());
    let owner = owner_of(1);
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut ensure = Box::pin(rt.pair_code_after("ensure", Some(owner.clone()), startup_of(rx)));
    assert!(futures::poll!(ensure.as_mut()).is_pending());
    // A release waits for no startup: this one would fail it if it ran.
    rt.pair_code_after("release", Some(owner.clone()), async { Err(mixdog_remote::access::runtime::RemoteError::Failed("startup ran".into())) }).await.unwrap();
    assert_eq!(frames(&seen), ["pair-code-request", "pair-code-clear"]);
    tx.send(Ok(())).unwrap();
    ensure.await.unwrap();
    assert_eq!(frames(&seen), ["pair-code-request", "pair-code-clear"], "the owner's connection is open, and still nothing is reacquired");
}
#[tokio::test]
async fn a_second_owner_keeps_the_code_served_until_it_too_closes() {
    let dir = tempfile::tempdir().unwrap();
    let (rt, seen) = pair_runtime(dir.path());
    let (a, b) = (owner_of(1), owner_of(2));
    rt.pair_code_after("ensure", Some(a.clone()), async { Ok(()) }).await.unwrap();
    rt.pair_code_after("ensure", Some(b.clone()), async { Ok(()) }).await.unwrap();
    assert_eq!(frames(&seen), ["pair-code-request"], "the second view joins the request in flight");
    a.alive.cancel();
    rt.connection_closed(a.id);
    assert_eq!(frames(&seen), ["pair-code-request"], "served for the second owner");
    rt.pair_code_after("renew", Some(b.clone()), async { Ok(()) }).await.unwrap();
    assert_eq!(frames(&seen), ["pair-code-request", "pair-code-request"], "the survivor can still renew");
    b.alive.cancel();
    rt.connection_closed(b.id);
    assert_eq!(frames(&seen), ["pair-code-request", "pair-code-request", "pair-code-clear"]);
}
