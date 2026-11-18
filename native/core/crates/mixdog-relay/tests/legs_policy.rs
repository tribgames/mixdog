//! The relay envelope and the pure forwarding policy of the legs: binary envelopes, admission, congestion, capacity, oversize notices and refusal attribution.

use std::sync::Arc;
use std::time::{Duration, Instant};

use mixdog_relay::close_codes::{RELAY_BUSY, SLOW_PEER};
use mixdog_relay::legs::envelope::{self, InvalidClientId};
use mixdog_relay::legs::policy::{
    self, Admission, FrameQuery, InflightMeter, LegCharge, MAX_FRAME_BYTES, MAX_INFLIGHT_BYTES, MAX_UPLINK_CAPACITY_BYTES,
    MAX_WS_PAYLOAD_BYTES, Outbound, Oversize, PhoneLeg, Pressure, Release, SendFailed, UNDECLARED_CAPACITY_BYTES, UplinkLeg, UplinkPath,
};

const MEGABYTE: usize = 1024 * 1024;
const GIGABYTE: f64 = 1024.0 * 1024.0 * 1024.0;
const ID: &str = "12345678-abcd-4321-abcd-1234567890ab";
const CANONICAL: &str = "00000000-0000-4000-8000-000000000000";

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn uuid(seed: u32) -> String {
    format!("{seed:08x}-0000-4000-8000-000000000000")
}

/// A socket stand-in for the forwarding policy: records what was handed over and only "flushes" when the test says so.
struct FakePhone {
    open: bool,
    buffered: usize,
    sent: Vec<String>,
    sent_bytes: Vec<usize>,
    closed: Option<(u16, String)>,
    hinted: bool,
    charge: Arc<LegCharge>,
    pending: Option<Release>,
    ceiling: usize,
    refuse: bool,
}

impl FakePhone {
    fn new(meter: &Arc<InflightMeter>, buffered: usize) -> Self {
        Self {
            open: true,
            buffered,
            sent: Vec::new(),
            sent_bytes: Vec::new(),
            closed: None,
            hinted: false,
            charge: LegCharge::new(Arc::clone(meter)),
            pending: None,
            ceiling: MAX_INFLIGHT_BYTES,
            refuse: false,
        }
    }

    fn flush(&mut self) {
        self.buffered = 0;
        if let Some(release) = self.pending.take() {
            release.run();
        }
    }
}

impl PhoneLeg for FakePhone {
    fn is_open(&self) -> bool {
        self.open
    }
    fn buffered_amount(&self) -> usize {
        self.buffered
    }
    fn inflight_ceiling(&self) -> usize {
        self.ceiling
    }
    fn charge(&self) -> &Arc<LegCharge> {
        &self.charge
    }
    fn resync_hinted(&self) -> bool {
        self.hinted
    }
    fn set_resync_hinted(&mut self, hinted: bool) {
        self.hinted = hinted;
    }
    fn send(&mut self, data: Outbound<'_>, release: Option<Release>) -> Result<(), SendFailed> {
        if self.refuse {
            return Err(SendFailed);
        }
        self.sent_bytes.push(data.len());
        self.sent.push(match data {
            Outbound::Text(text) if text.len() < 64 => text.to_owned(),
            Outbound::Text(_) | Outbound::Binary(_) => String::new(),
        });
        self.buffered += data.len();
        if release.is_some() {
            self.pending = release;
        }
        Ok(())
    }
    fn close(&mut self, code: u16, reason: &str) {
        self.closed = Some((code, reason.to_owned()));
    }
}

// ---- envelope ----

#[test]
fn routing_id_predicate_shared_with_the_binary_frame() {
    // 'not-a-routing-id' has a legal length but is not a routing id: the decoder refuses it.
    let encoded = envelope::encode_frame("not-a-routing-id", &[1], false, false).expect("a 16 byte id encodes");
    assert_eq!(envelope::decode_frame(&encoded), None);
    // The text lane names the ids the router hands out and no other.
    let frame = |id: &str| format!(r#"{{"type":"frame","clientId":"{id}","data":""}}"#);
    assert_eq!(policy::routed_client_id(frame(ID).as_bytes()).as_deref(), Some(ID));
    assert_eq!(policy::routed_client_id(frame("00000001").as_bytes()).as_deref(), Some("00000001"));
    assert_eq!(policy::routed_client_id(frame("0000001").as_bytes()), None);
}

#[test]
fn binary_relay_envelopes_preserve_routing_metadata_without_base64() {
    let encoded = envelope::encode_frame(ID, &[0, 1, 2, 255], true, false).unwrap();
    let decoded = envelope::decode_frame(&encoded).expect("decodes");
    assert_eq!(decoded.client_id, ID);
    assert!(decoded.droppable);
    assert!(!decoded.text);
    assert_eq!(decoded.data, &[0, 1, 2, 255]);
}

#[test]
fn envelope_byte_vectors() {
    // The envelope bytes for each flag combination.
    let droppable = envelope::encode_frame(ID, &[0, 1, 2, 255], true, false).unwrap();
    assert_eq!(hex(&droppable), "4d585201012431323334353637382d616263642d343332312d616263642d313233343536373839306162000102ff");
    let text = envelope::encode_frame("abcdefgh", b"hi", false, true).unwrap();
    assert_eq!(hex(&text), "4d585201020861626364656667686869");
    let both = envelope::encode_frame("abcdefgh", &[], true, true).unwrap();
    assert_eq!(hex(&both), "4d58520103086162636465666768");
    assert_eq!(envelope::MAGIC, [0x4d, 0x58, 0x52, 0x01]);
    assert_eq!(envelope::TRANSPORT_MAGIC, [0x4d, 0x58, 0x54, 0x01]);
    assert_eq!(envelope::HEADER_BYTES, 6);
}

#[test]
fn text_flagged_frames_decode_as_text_and_old_frames_stay_bytes() {
    let text_frame = envelope::encode_frame("abcdef01", b"hi", false, true).unwrap();
    let text = envelope::decode_frame(&text_frame).unwrap();
    assert!(text.text && !text.droppable);
    assert_eq!(text.data, b"hi");
    let both_frame = envelope::encode_frame("abcdef01", &[], true, true).unwrap();
    let both = envelope::decode_frame(&both_frame).unwrap();
    assert!(both.text && both.droppable);
    assert!(both.data.is_empty());
}

#[test]
fn the_encoder_and_decoder_refuse_malformed_envelopes() {
    assert_eq!(envelope::encode_frame("", b"x", false, false), Err(InvalidClientId));
    assert_eq!(envelope::encode_frame(&"a".repeat(65), b"x", false, false), Err(InvalidClientId));
    assert!(envelope::encode_frame(&"a".repeat(64), b"x", false, false).is_ok());
    assert_eq!(InvalidClientId.to_string(), "clientId is invalid.");
    let good = envelope::encode_frame("abcdefgh", b"x", false, false).unwrap();
    // Too short for a header and one id byte, another magic, an id length of 0 or 65, an id longer than the frame.
    assert_eq!(envelope::decode_frame(&good[..6]), None);
    let mut wrong_magic = good.clone();
    wrong_magic[3] = 2;
    assert_eq!(envelope::decode_frame(&wrong_magic), None);
    let mut zero = good.clone();
    zero[5] = 0;
    assert_eq!(envelope::decode_frame(&zero), None);
    let mut long = good.clone();
    long[5] = 65;
    assert_eq!(envelope::decode_frame(&long), None);
    let mut past = good.clone();
    past[5] = 40;
    assert_eq!(envelope::decode_frame(&past), None);
    // An id that is not UTF-8 is not a routing id.
    let mut bad_utf8 = good.clone();
    bad_utf8[6] = 0xff;
    assert_eq!(envelope::decode_frame(&bad_utf8), None);
    // An id of upper-case hex is not a routing id either.
    assert_eq!(envelope::decode_frame(&envelope::encode_frame("ABCDEFGH", b"x", false, false).unwrap()), None);
}

#[test]
fn the_carrier_magic_and_the_phone_ping() {
    assert!(envelope::is_transport_frame(b"MXT\x01rest"));
    assert!(envelope::is_transport_frame(b"MXT\x01"));
    assert!(!envelope::is_transport_frame(b"MXT"));
    assert!(!envelope::is_transport_frame(b"MXR\x01rest"));
    assert!(envelope::is_phone_ping(r#"{"ping":1}"#));
    assert!(envelope::is_phone_ping(r#"{"ping""#));
    assert!(!envelope::is_phone_ping(r#"{ "ping":1}"#));
    assert_eq!(envelope::PHONE_PONG, r#"{"pong":1}"#);
}

#[test]
fn the_json_wrapper_is_what_json_stringify_writes() {
    assert_eq!(envelope::json_frame(ID, "x"), format!(r#"{{"type":"frame","clientId":"{ID}","data":"x"}}"#));
    // Control characters escape as JavaScript writes them; DEL, U+2028 and non-ASCII text stay as they are.
    let id = "a\u{1}\"\\\n";
    let data = "q\u{0}\u{1f}\u{7f}/\t\u{2028}\u{e9}\u{1f600}";
    assert_eq!(
        envelope::json_frame(id, data),
        "{\"type\":\"frame\",\"clientId\":\"a\\u0001\\\"\\\\\\n\",\"data\":\"q\\u0000\\u001f\u{7f}/\\t\u{2028}\u{e9}\u{1f600}\"}"
    );
    // The JSON envelope of an empty frame for a UUID client.
    assert_eq!(envelope::json_frame_overhead(CANONICAL), 76);
    assert_eq!(envelope::binary_overhead(CANONICAL), 42);
}

// ---- admission ----

#[test]
fn frame_admission_bounds_every_leg_without_stalling_its_neighbours() {
    let query = |queued, size, droppable, inflight| FrameQuery {
        queued,
        size,
        budget: 8 * MEGABYTE,
        droppable,
        inflight,
        ..FrameQuery::default()
    };
    // An idle leg may always take one frame of any supported size.
    assert_eq!(policy::admit_frame(&query(0, MAX_FRAME_BYTES, false, 0)), Admission::Send);
    // A leg that is not draining does not get another one, and the decision is taken BEFORE the enqueue.
    assert_eq!(policy::admit_frame(&query(7 * MEGABYTE, 2 * MEGABYTE, false, 0)), Admission::Slow);
    assert_eq!(policy::admit_frame(&query(7 * MEGABYTE, 2 * MEGABYTE, true, 0)), Admission::Drop);
    assert_eq!(policy::admit_frame(&query(0, 2 * MEGABYTE, false, MAX_INFLIGHT_BYTES)), Admission::Busy);
    assert_eq!(policy::admit_frame(&query(0, 2 * MEGABYTE, true, MAX_INFLIGHT_BYTES)), Admission::Drop);
    // The box ceiling is decided before the leg budget.
    assert_eq!(policy::admit_frame(&query(7 * MEGABYTE, 2 * MEGABYTE, false, MAX_INFLIGHT_BYTES)), Admission::Busy);
    assert_eq!(Admission::Slow.close(), Some((SLOW_PEER, "slow consumer")));
    assert_eq!(Admission::Busy.close(), Some((RELAY_BUSY, "relay busy")));
    assert_eq!(Admission::Send.close(), None);
    assert_eq!(Admission::Drop.close(), None);
}

#[test]
fn a_congested_phone_is_dropped_hinted_or_cut_and_its_sibling_is_untouched() {
    let meter = InflightMeter::new();
    let mut congested = FakePhone::new(&meter, 8 * MEGABYTE);
    let mut healthy = FakePhone::new(&meter, 0);
    let frame = "x".repeat(2 * MEGABYTE);
    let before = meter.bytes();
    // A droppable push to a congested leg is dropped with one resync hint...
    assert!(!policy::send_to_phone(&mut congested, Outbound::Text(&frame), true, Pressure::Cut));
    assert_eq!(congested.sent, vec![r#"{"resync":1}"#.to_owned()]);
    assert_eq!(congested.closed, None);
    // ...once per congestion window...
    assert!(!policy::send_to_phone(&mut congested, Outbound::Text(&frame), true, Pressure::Cut));
    assert_eq!(congested.sent.len(), 1);
    // ...a critical one cuts that leg instead of queueing past its budget...
    assert!(!policy::send_to_phone(&mut congested, Outbound::Text(&frame), false, Pressure::Cut));
    assert_eq!(congested.closed, Some((4008, "slow consumer".to_owned())));
    // ...and neither outcome touches the sibling leg.
    assert!(policy::send_to_phone(&mut healthy, Outbound::Text(&frame), false, Pressure::Cut));
    assert_eq!(healthy.sent_bytes, vec![frame.len()]);
    assert_eq!(healthy.closed, None);
    assert_eq!(meter.bytes(), before + frame.len());
    healthy.flush();
    assert_eq!(meter.bytes(), before);
    assert_eq!(healthy.charge.pending_bytes(), 0);
}

#[test]
fn a_leg_that_is_not_open_takes_nothing() {
    let meter = InflightMeter::new();
    let mut phone = FakePhone::new(&meter, 0);
    phone.open = false;
    assert!(!policy::send_to_phone(&mut phone, Outbound::Text("x"), false, Pressure::Cut));
    assert!(phone.sent.is_empty());
    assert_eq!(phone.closed, None);
}

#[test]
fn a_hint_is_sent_again_after_a_frame_was_carried() {
    let meter = InflightMeter::new();
    let mut phone = FakePhone::new(&meter, 2 * MEGABYTE);
    assert!(!policy::send_to_phone(&mut phone, Outbound::Text("push"), true, Pressure::Cut));
    assert!(phone.hinted);
    phone.flush();
    // It drained: a frame goes out and the congestion window is over.
    assert!(policy::send_to_phone(&mut phone, Outbound::Text("push"), true, Pressure::Cut));
    assert!(!phone.hinted);
    phone.flush();
    phone.buffered = 2 * MEGABYTE;
    assert!(!policy::send_to_phone(&mut phone, Outbound::Text("push"), true, Pressure::Cut));
    assert_eq!(phone.sent.iter().filter(|text| *text == r#"{"resync":1}"#).count(), 2);
}

#[test]
fn a_critical_fan_out_defers_what_the_box_cannot_carry_and_closes_no_healthy_leg() {
    let meter = InflightMeter::new();
    let mut phone = FakePhone::new(&meter, 0);
    phone.ceiling = 3 * MEGABYTE;
    let frame = "y".repeat(2 * MEGABYTE);
    // The first leg of the loop takes its frame; the box is now holding 2 MiB of its 3 MiB.
    assert!(policy::send_to_phone(&mut phone, Outbound::Text(&frame), false, Pressure::Defer));
    let mut behind = FakePhone::new(&meter, 0);
    behind.ceiling = 3 * MEGABYTE;
    // The leg behind it is refused for box-level pressure: in a fan-out it keeps its socket and is told to resync...
    assert!(!policy::send_to_phone(&mut behind, Outbound::Text(&frame), false, Pressure::Defer));
    assert_eq!(behind.closed, None);
    assert_eq!(behind.sent, vec![r#"{"resync":1}"#.to_owned()]);
    // ...while the single-leg path cuts it with 4009.
    let mut alone = FakePhone::new(&meter, 0);
    alone.ceiling = 3 * MEGABYTE;
    assert!(!policy::send_to_phone(&mut alone, Outbound::Text(&frame), false, Pressure::Cut));
    assert_eq!(alone.closed, Some((4009, "relay busy".to_owned())));
    // A leg with congestion of its own is cut in a fan-out too: only box-level pressure is deferred.
    let mut slow = FakePhone::new(&meter, 7 * MEGABYTE);
    assert!(!policy::send_to_phone(&mut slow, Outbound::Text(&frame), false, Pressure::Defer));
    assert_eq!(slow.closed, Some((4008, "slow consumer".to_owned())));
}

#[test]
fn a_failed_send_releases_its_charge_and_a_gone_leg_takes_its_charge_with_it() {
    let meter = InflightMeter::new();
    let mut phone = FakePhone::new(&meter, 0);
    phone.refuse = true;
    // The frame is handed over and released when the socket throws; the answer is still true.
    assert!(policy::send_to_phone(&mut phone, Outbound::Text("abcd"), false, Pressure::Cut));
    assert_eq!(meter.bytes(), 0);
    phone.refuse = false;
    assert!(policy::send_to_phone(&mut phone, Outbound::Text("abcd"), false, Pressure::Cut));
    assert_eq!(meter.bytes(), 4);
    let stale = phone.pending.take().expect("a release is pending");
    phone.charge.release_all();
    assert_eq!(meter.bytes(), 0);
    // The release of a frame the dead leg never flushed is a no-op: the counter cannot drift.
    let other = LegCharge::new(Arc::clone(&meter)).charge(10);
    stale.run();
    assert_eq!(meter.bytes(), 10);
    other.run();
    other.run();
    assert_eq!(meter.bytes(), 0);
}

#[test]
fn the_uplink_pause_follows_the_two_mebibyte_backlog() {
    assert!(!policy::uplink_pause_due(2 * MEGABYTE));
    assert!(policy::uplink_pause_due(2 * MEGABYTE + 1));
    assert_eq!(policy::LEG_RESUME_TIMEOUT, Duration::from_secs(10));
    assert_eq!(policy::UPLINK_QUEUE_LIMIT_BYTES, 8 * MEGABYTE);
}

// ---- capacity and ceilings ----

#[test]
fn constants_are_the_ones_the_protocol_is_published_with() {
    assert_eq!(MAX_FRAME_BYTES, 64 * MEGABYTE);
    assert_eq!(MAX_WS_PAYLOAD_BYTES, 68 * MEGABYTE);
    assert_eq!(MAX_UPLINK_CAPACITY_BYTES, MAX_WS_PAYLOAD_BYTES);
    assert_eq!(UNDECLARED_CAPACITY_BYTES, 64 * 1024);
    assert_eq!(MAX_INFLIGHT_BYTES, 128 * MEGABYTE);
    assert_eq!(policy::PHONE_QUEUE_LIMIT_BYTES, 8 * MEGABYTE);
    assert_eq!(policy::SKIP_PUSH_BUFFER_BYTES, MEGABYTE);
    assert_eq!(policy::INGRESS_RESERVATION_BYTES, 68 * MEGABYTE);
    assert_eq!(policy::MAX_INGRESS_BYTES, 136 * MEGABYTE);
    assert_eq!(policy::INGRESS_FREE_WINDOW_BYTES, 256 * 1024);
    assert_eq!(policy::OVERSIZE_ID_SCAN_BYTES, 512);
}

#[test]
fn a_desktop_leg_is_held_to_the_capacity_it_declares_not_to_configuration() {
    let kib = |n: usize| Some((n * 1024) as f64);
    assert_eq!(policy::uplink_capacity_for(kib(64), kib(128)), 64 * 1024);
    assert_eq!(policy::uplink_capacity_for(kib(256), kib(128)), 128 * 1024);
    assert_eq!(policy::uplink_capacity_for(None, kib(128)), UNDECLARED_CAPACITY_BYTES);
    assert_eq!(policy::uplink_capacity_for(None, Some(MAX_UPLINK_CAPACITY_BYTES as f64)), UNDECLARED_CAPACITY_BYTES);
    assert_eq!(policy::uplink_capacity_for(Some(0.0), kib(128)), UNDECLARED_CAPACITY_BYTES);
}

#[test]
fn capacity_configuration_is_clamped_on_both_inputs_and_normalises_nonsense() {
    let max = MAX_UPLINK_CAPACITY_BYTES;
    // Neither a peer's claim nor an operator's configuration can raise the relay above its own largest frame.
    assert_eq!(policy::uplink_capacity_for(Some(GIGABYTE), Some(GIGABYTE)), max);
    assert_eq!(policy::uplink_capacity_for(Some(GIGABYTE), None), max);
    assert_eq!(policy::uplink_capacity_for(Some(9_007_199_254_740_991.0), Some(9_007_199_254_740_991.0)), max);
    // An undeclared leg stays at the floor however large the configured clamp.
    assert_eq!(policy::uplink_capacity_for(None, Some(GIGABYTE)), UNDECLARED_CAPACITY_BYTES);
    // Malformed values are normalised HERE, never carried onward.
    let kib128 = Some(128.0 * 1024.0);
    assert_eq!(policy::uplink_capacity_for(Some(f64::NAN), Some(f64::NAN)), UNDECLARED_CAPACITY_BYTES);
    assert_eq!(policy::uplink_capacity_for(Some(f64::INFINITY), Some(f64::INFINITY)), UNDECLARED_CAPACITY_BYTES);
    assert_eq!(policy::uplink_capacity_for(Some(-1.0), kib128), UNDECLARED_CAPACITY_BYTES);
    assert_eq!(policy::uplink_capacity_for(policy::js_number(&serde_json::json!("nonsense")), kib128), UNDECLARED_CAPACITY_BYTES);
    assert_eq!(policy::uplink_capacity_for(kib128, Some(-1.0)), 128 * 1024);
    assert_eq!(policy::uplink_capacity_for(Some(65_536.9), kib128), 65_536);
    // Too small to carry the relay's own envelope: it normalises up to the protocol minimum.
    assert_eq!(policy::uplink_capacity_for(Some(10.0), Some(GIGABYTE)), 1024);
}

#[test]
fn a_declared_capacity_is_read_the_way_number_reads_it() {
    use serde_json::json;
    assert_eq!(policy::js_number(&json!(65536)), Some(65536.0));
    assert_eq!(policy::js_number(&json!("65536")), Some(65536.0));
    assert_eq!(policy::js_number(&json!(" 0x10 ")), Some(16.0));
    assert_eq!(policy::js_number(&json!("nonsense")), None);
    assert_eq!(policy::js_number(&json!(null)), Some(0.0));
    assert_eq!(policy::js_number(&json!(true)), Some(1.0));
    assert_eq!(policy::js_number(&json!([])), Some(0.0));
    assert_eq!(policy::js_number(&json!(["7"])), Some(7.0));
    // `Number([true])` reads the string "true": NaN, not 1.
    assert_eq!(policy::js_number(&json!([true])), None);
    assert_eq!(policy::js_number(&json!([[]])), Some(0.0));
    assert_eq!(policy::js_number(&json!([1, 2])), None);
    assert_eq!(policy::js_number(&json!({})), None);
}

#[test]
fn a_declared_text_frame_leg_carries_text_in_the_envelope_that_cannot_inflate() {
    // 64 MiB of quotes is 128 MiB of JSON and 64 MiB of NULs approaches 384 MiB, so NO fixed headroom carries a 64 MiB
    // policy through a JSON wrapper; the envelope with a fixed header does.
    let path = |text_frames| UplinkPath { capacity: MAX_WS_PAYLOAD_BYTES, client_id: CANONICAL, text_frames, ..UplinkPath::default() };
    let json_path = policy::uplink_ceilings(path(false));
    assert_eq!(json_path.binary, MAX_FRAME_BYTES);
    assert!(json_path.text < MAX_FRAME_BYTES);
    // The ceilings: 64 MiB binary and 11883848 bytes as text.
    assert_eq!(json_path.text, 11_883_848);
    assert_eq!(policy::uplink_ceilings(path(true)).text, MAX_FRAME_BYTES);
}

#[test]
fn uplink_ceilings_follow_the_capacity_rules() {
    let at = |capacity, policy_bytes, text_frames| {
        let c = policy::uplink_ceilings(UplinkPath { capacity, client_id: CANONICAL, text_frames, policy: policy_bytes });
        (c.binary, c.text)
    };
    assert_eq!(at(64 * 1024, MAX_FRAME_BYTES, false), (65_494, 10_910));
    assert_eq!(at(64 * 1024, MAX_FRAME_BYTES, true), (65_494, 65_494));
    assert_eq!(at(1024, 500, false), (500, 158));
    // A capacity smaller than the envelope is clamped to zero rather than wrapping.
    assert_eq!(at(10, MAX_FRAME_BYTES, false), (0, 0));
    assert_eq!(at(10, MAX_FRAME_BYTES, true), (0, 0));
    // Defaults: the undeclared floor, no client id, the full policy.
    let default = policy::uplink_ceilings(UplinkPath::default());
    assert_eq!((default.binary, default.text), (65_530, (65_536 - 40) / 6));
}

#[test]
fn published_equals_enforced_and_a_nonsense_configuration_is_normalised_once() {
    // A stale unit file, an unparsed env var: nonsense is normalised where it ENTERS the relay.
    let ceiling = policy::bounded_capacity(Some(f64::NAN), MAX_UPLINK_CAPACITY_BYTES);
    assert_eq!(ceiling, MAX_UPLINK_CAPACITY_BYTES);
    let mut leg = UplinkLeg::new(128 * 1024);
    assert_eq!(leg.capacity, UNDECLARED_CAPACITY_BYTES);
    assert!(!leg.text_frames);
    let none: [String; 0] = [];
    let published = |leg: &UplinkLeg, max: usize, platforms: &[String], web: bool, ice: bool| {
        mixdog_relay::js::wire(&policy::relay_capabilities(leg, max, platforms, web, ice))
    };
    // The published capabilities of a 128 KiB leg with both push platforms.
    assert_eq!(
        published(&leg, 1_048_576, &["apns".to_owned(), "fcm".to_owned()], true, true),
        r#"{"type":"relay-capabilities","binaryFrames":1,"maxFrameBytes":1048576,"uplinkCapacityBytes":65536,"uplinkBinaryCeilingBytes":65494,"uplinkTextCeilingBytes":10910,"nativePush":1,"nativePushPlatforms":["apns","fcm"],"webPush":1,"ice":1}"#
    );
    // The enforcement path reads the same leg: the ceilings published are the ceilings of a canonical client's path.
    let enforced = policy::uplink_ceilings(UplinkPath { capacity: leg.capacity, client_id: CANONICAL, text_frames: leg.text_frames, policy: 1_048_576 });
    assert_eq!((enforced.binary, enforced.text), (65_494, 10_910));
    // A declaration that acknowledges text in the envelope moves the numbers and adds `textFrames`.
    leg.declare(Some(256.0 * 1024.0), true);
    assert_eq!(
        published(&leg, 1_048_576, &none, false, false),
        r#"{"type":"relay-capabilities","binaryFrames":1,"maxFrameBytes":1048576,"textFrames":1,"uplinkCapacityBytes":131072,"uplinkBinaryCeilingBytes":131030,"uplinkTextCeilingBytes":131030}"#
    );
    // A ceiling too small for the protocol is lifted to the minimum, never published as zero.
    assert_eq!(
        published(&UplinkLeg::new(5), 4096, &none, false, false),
        r#"{"type":"relay-capabilities","binaryFrames":1,"maxFrameBytes":4096,"uplinkCapacityBytes":1024,"uplinkBinaryCeilingBytes":982,"uplinkTextCeilingBytes":158}"#
    );
    // A redial starts again from the floor: a leg's claim is never carried to the next connection.
    let redial = UplinkLeg::new(128 * 1024);
    assert_eq!(redial.capacity, UNDECLARED_CAPACITY_BYTES);
    assert_eq!(redial.published, "");
}

// ---- attribution and oversize notices ----

fn notice_of(raw: &[u8], binary: bool) -> serde_json::Value {
    mixdog_relay::js::parse(&policy::desktop_oversize_notice(8192, 4096, raw, binary)).expect("a notice is JSON")
}

#[test]
fn oversize_notices_have_their_published_bytes() {
    assert_eq!(policy::phone_oversize_notice(8192, 1024), r#"{"resync":1,"error":"frame-too-large","bytes":8192,"limit":1024}"#);
    let text = format!(r#"{{"type":"frame","clientId":"{ID}","data":"x"}}"#);
    assert_eq!(
        policy::desktop_oversize_notice(8192, 4096, text.as_bytes(), false),
        format!(r#"{{"type":"frame-too-large","clientId":"{ID}","bytes":8192,"limit":4096}}"#)
    );
    assert_eq!(
        policy::desktop_oversize_notice(8192, 4096, br#"{"clientId":5}...."#, false),
        r#"{"type":"frame-too-large","bytes":8192,"limit":4096}"#
    );
    let binary = envelope::encode_frame(ID, &[1, 1, 1], false, false).unwrap();
    assert_eq!(
        policy::desktop_oversize_notice(8192, 4096, &binary, true),
        format!(r#"{{"type":"frame-too-large","clientId":"{ID}","bytes":8192,"limit":4096}}"#)
    );
    assert_eq!(policy::DESKTOP_GONE_NOTICE, r#"{"resync":"desktop-gone"}"#);
}

#[test]
fn the_refusal_is_sent_once_and_the_sender_keeps_its_leg() {
    assert_eq!(policy::check_oversize(4096, 4096, false), Oversize::Fits);
    assert_eq!(policy::check_oversize(4097, 4096, false), Oversize::Refused { announce: true });
    // The ingress meter already answered this message while it was arriving.
    assert_eq!(policy::check_oversize(4097, 4096, true), Oversize::Refused { announce: false });
}

#[test]
fn a_binary_refusal_is_named_by_the_decoder_that_routes_it() {
    let binary = envelope::encode_frame(ID, &[1u8; 8192], false, false).unwrap();
    assert_eq!(notice_of(&binary, true)["clientId"], ID);
    // Only the head is read: the id is settled however large the frame is.
    assert_eq!(notice_of(&binary[..policy::OVERSIZE_ID_SCAN_BYTES], true)["clientId"], ID);
    // JSON-shaped bytes on the binary lane, a bad magic or an id of the wrong length reach no client.
    let json = format!(r#"{{"type":"frame","clientId":"{ID}","data":"x"}}"#);
    assert_eq!(notice_of(json.as_bytes(), true).get("clientId"), None);
    let mut bad_magic = binary.clone();
    bad_magic[0] = b'Z';
    assert_eq!(notice_of(&bad_magic, true).get("clientId"), None);
    let mut bad_length = binary.clone();
    bad_length[5] = 65;
    assert_eq!(notice_of(&bad_length, true).get("clientId"), None);
    // A frame under eight bytes names nobody.
    assert_eq!(policy::oversize_frame_client_id(b"{}", false), None);
    // The same bytes read on the text lane are not an envelope either.
    assert_eq!(notice_of(&binary, false).get("clientId"), None);
}

#[test]
fn a_nested_client_id_in_the_payload_never_attributes_a_refusal() {
    // A payload is attacker-shaped bytes; this one carries a `clientId` field of its own, which a prefix search would route.
    let nested = r#"{\"clientId\":\"aaaaaaaa\"}"#;
    let pad = "y".repeat(8192);
    let first = format!(r#"{{"type":"frame","clientId":"{ID}","data":"{nested}{pad}"}}"#);
    assert_eq!(policy::routed_client_id(first.as_bytes()).as_deref(), Some(ID));
    let hostile = format!(r#"{{"type":"frame","data":"{nested}{pad}","clientId":"{ID}"}}"#);
    let named = policy::routed_client_id(hostile.as_bytes());
    assert_eq!(named.as_deref(), Some(ID));
    assert_ne!(named.as_deref(), Some("aaaaaaaa"));
    assert_eq!(notice_of(hostile.as_bytes(), false)["clientId"], ID);
}

#[test]
fn a_refusal_names_the_client_the_router_itself_would_have_used() {
    let decoy = uuid(0xdec0);
    // Two top-level `clientId` keys: JSON routing keeps the LAST one.
    let hostile = format!(r#"{{"type":"frame","clientId":"{decoy}","clientId":"{ID}","data":"{}"}}"#, "y".repeat(8192));
    assert_eq!(policy::routed_client_id(hostile.as_bytes()).as_deref(), Some(ID));
    assert_ne!(policy::routed_client_id(hostile.as_bytes()).as_deref(), Some(decoy.as_str()));
    let deliverable = format!(r#"{{"type":"frame","clientId":"{decoy}","clientId":"{ID}","data":"ok"}}"#);
    assert_eq!(policy::routed_client_id(deliverable.as_bytes()).as_deref(), Some(ID));
}

#[test]
fn no_padding_length_lets_a_decoy_id_outrank_the_routed_id() {
    let decoy = uuid(0xdec0);
    for padding in [0usize, 600, 4 * 1024, 64 * 1024, 512 * 1024] {
        let frame = format!(
            r#"{{"type":"frame","clientId":"{decoy}","pad":"{}","clientId":"{ID}","data":"{}"}}"#,
            "p".repeat(padding),
            "y".repeat(8192)
        );
        let named = policy::routed_client_id(frame.as_bytes());
        assert_eq!(named.as_deref(), Some(ID), "padding {padding}");
        assert_ne!(named.as_deref(), Some(decoy.as_str()));
    }
    // The authoritative key behind a payload no bounded prefix could hold.
    let trailing = format!(r#"{{"type":"frame","data":"{}","clientId":"{ID}"}}"#, "y".repeat(256 * 1024));
    assert_eq!(policy::routed_client_id(trailing.as_bytes()).as_deref(), Some(ID));
    let data = "y".repeat(8192);
    // A last key the relay could never route with names nobody, never the key that lost.
    let unroutable = format!(r#"{{"type":"frame","clientId":"{ID}","clientId":42,"data":"{data}"}}"#);
    assert_eq!(policy::routed_client_id(unroutable.as_bytes()), None);
    // An escape JSON does not define makes the parser reject the WHOLE frame, so it routes nowhere.
    let bad_escape = format!(r#"{{"type":"frame","pad":"\q","clientId":"{ID}","data":"{data}"}}"#);
    assert_eq!(policy::routed_client_id(bad_escape.as_bytes()), None);
    // Same for a `\u` the parser would refuse: four hex digits or nothing.
    let short_unicode = format!(r#"{{"type":"frame","pad":"\u01","clientId":"{ID}","data":"{data}"}}"#);
    assert_eq!(policy::routed_client_id(short_unicode.as_bytes()), None);
    // A legal escape is still walked through.
    let legal = format!(r#"{{"type":"frame","pad":"A\n\"","clientId":"{ID}","data":"{data}"}}"#);
    assert_eq!(policy::routed_client_id(legal.as_bytes()).as_deref(), Some(ID));
    // A frame that is not one whole JSON object is delivered to nobody, so it is attributed to nobody.
    let truncated = format!(r#"{{"type":"frame","clientId":"{ID}","data":"{data}"#);
    assert_eq!(policy::routed_client_id(truncated.as_bytes()), None);
}

#[test]
fn only_a_whole_json_object_with_a_routing_id_string_is_attributed() {
    let id = |value: &str| format!(r#"{{"clientId":{value}}}"#);
    assert_eq!(policy::routed_client_id(id(&format!("\"{ID}\"")).as_bytes()).as_deref(), Some(ID));
    for value in ["12345678", "null", "true", "[\"12345678\"]", "{}", "\"0000001\"", "\"ABCDEFGH\""] {
        assert_eq!(policy::routed_client_id(id(value).as_bytes()), None, "{value}");
    }
    assert_eq!(policy::routed_client_id(format!("[{{\"clientId\":\"{ID}\"}}]").as_bytes()), None);
    assert_eq!(policy::routed_client_id(format!("\"{ID}\"").as_bytes()), None);
    assert_eq!(policy::routed_client_id(format!("{{\"clientId\":\"{ID}\"}} x").as_bytes()), None);
    assert_eq!(policy::routed_client_id(b""), None);
    assert_eq!(policy::routed_client_id(&[0xff, 0xfe]), None);
    // A frame with whitespace around the object is still the router's frame.
    assert_eq!(policy::routed_client_id(format!(" \n{{\"clientId\":\"{ID}\"}}\t").as_bytes()).as_deref(), Some(ID));
    // Escaped characters inside the id spell the same id.
    assert_eq!(policy::routed_client_id(br#"{"clientId":"abc\u0064ef01"}"#).as_deref(), Some("abcdef01"));
}

#[test]
fn attribution_costs_one_pass_over_the_frame_whatever_shape_it_is() {
    // What attribution must never do is let the SHAPE of a frame buy more work than its bytes did: a search per string is
    // quadratic on millions of short keys (8 MiB of them stalled a relay for over a minute). The bound is loose for an
    // unoptimised build and still far below a quadratic walk; the cost must also track size, not shape.
    let size = 8 * MEGABYTE;
    let decoy = uuid(0xdec0);
    let repeat_to = |unit: &str, total: usize| unit.repeat((total / unit.len()).max(1));
    let shapes: Vec<(&str, String)> = vec![
        ("payload-string", format!(r#"{{"type":"frame","clientId":"{ID}","data":"{}"}}"#, repeat_to("y", size))),
        ("numeric-token", format!(r#"{{"type":"frame","clientId":"{ID}","n":{}}}"#, repeat_to("9", size))),
        (
            "many-eight-byte-keys",
            format!(r#"{{"clientId":"{decoy}",{}"clientId":"{ID}","data":"x"}}"#, repeat_to("\"kkkkkkkk\":1,", size)),
        ),
        (
            "many-client-ids",
            format!(r#"{{"type":"frame",{}"clientId":"{ID}","data":"x"}}"#, repeat_to(&format!("\"clientId\":\"{decoy}\","), size)),
        ),
    ];
    let mut timings = Vec::new();
    for (shape, text) in &shapes {
        assert!(text.len() >= size, "{shape} is not a full-size frame");
        let started = Instant::now();
        let named = policy::routed_client_id(text.as_bytes());
        let elapsed = started.elapsed();
        assert_eq!(named.as_deref(), Some(ID), "{shape} named the wrong client");
        assert!(elapsed < Duration::from_secs(20), "{shape} took {elapsed:?}");
        timings.push((*shape, elapsed));
    }
    // The same crafted shape four times as large: one pass costs what the frame weighs.
    let big = format!(r#"{{"clientId":"{decoy}",{}"clientId":"{ID}","data":"x"}}"#, repeat_to("\"kkkkkkkk\":1,", 4 * size));
    let started = Instant::now();
    assert_eq!(policy::routed_client_id(big.as_bytes()).as_deref(), Some(ID));
    let largest = started.elapsed();
    let base = timings.iter().find(|(shape, _)| *shape == "many-eight-byte-keys").map(|(_, t)| *t).unwrap();
    assert!(largest < base.max(Duration::from_millis(50)) * 40, "cost grew from {base:?} to {largest:?} for four times the bytes");
}

#[test]
fn a_desktop_gone_notice_is_throttled_only_when_the_phone_provoked_it() {
    let now = Instant::now();
    assert!(policy::desktop_gone_notice_due(None, now, true));
    assert!(policy::desktop_gone_notice_due(Some(now), now, false));
    assert!(!policy::desktop_gone_notice_due(Some(now), now + Duration::from_millis(999), true));
    assert!(policy::desktop_gone_notice_due(Some(now), now + Duration::from_secs(1), true));
}
