//! The wire contracts of the live view and the transport: which signals a phone or the desktop may send and how a refusal
//! reads, the transport states a stream may move between, the carrier framing of records, and the redial schedule.

use std::time::Duration;

use mixdog_remote::leg::redial::{RETRY_MAX, RETRY_MIN, Redial};
use mixdog_remote::transport::consts::{CHUNK_BYTES, CHUNK_HEADER_BYTES};
use mixdog_remote::transport::consts::{FRAGMENT_BYTES, MAX_RECORD_PLAINTEXT_BYTES};
use mixdog_remote::transport::frame::{Message, RecordMessage, decode_message, encode_control, encode_record};
use mixdog_remote::transport::path::{PathMonitor, RttEstimate, Stall};
use mixdog_remote::transport::signal::{Role, Signal, parse_signal};
use mixdog_remote::transport::split::{Assembly, AssemblyPool, MessageAssembler, split_payload};
use mixdog_remote::webrtc::signal::{ClientSignal, CloseReason, Source, TransportState};
use serde_json::{Value, json};

fn source() -> Value {
    json!({ "kind": "browser", "sessionId": "session-1" })
}

fn ready() -> Value {
    json!({ "type": "ready", "v": 1, "source": source(), "receiveCodecs": ["video/VP8"] })
}

fn refusal(value: &Value) -> String {
    ClientSignal::parse(value).expect_err("the signal is refused")
}

#[test]
fn a_phones_ready_signal_is_read_and_written_back_unchanged() {
    let mut with_limit = ready();
    with_limit["videoLimit"] = json!({ "maxWidth": 1280, "maxHeight": 720 });
    for signal in [ready(), with_limit] {
        let parsed = ClientSignal::parse(&signal).expect("a valid ready");
        assert_eq!(parsed.type_name(), "ready");
        assert_eq!(parsed.source(), &Source::Browser { session_id: "session-1".to_owned() });
        assert_eq!(parsed.to_json(), signal);
    }
}

#[test]
fn a_phone_signal_with_a_wrong_version_type_codec_or_limit_is_refused_naming_the_field() {
    let edit = |change: &dyn Fn(&mut Value)| {
        let mut signal = ready();
        change(&mut signal);
        refusal(&signal)
    };
    assert_eq!(edit(&|s| s["v"] = json!(2)), "remote webrtc version is invalid.");
    assert_eq!(edit(&|s| s["type"] = json!("hello")), "remote webrtc signal type is invalid.");
    assert_eq!(edit(&|s| s["source"] = json!({ "kind": "tab" })), "remote webrtc source is invalid.");
    assert_eq!(edit(&|s| s["source"]["sessionId"] = json!("has space")), "remote webrtc session id is invalid.");
    assert_eq!(edit(&|s| s["receiveCodecs"] = json!("video/VP8")), "remote webrtc receive codecs is invalid.");
    assert_eq!(edit(&|s| s["receiveCodecs"] = json!(["audio/opus"])), "remote webrtc receive codec is invalid.");
    assert_eq!(edit(&|s| s["receiveCodecs"] = json!(vec!["video/VP8"; 33])), "remote webrtc receive codecs is invalid.");
    assert_eq!(edit(&|s| s["videoLimit"] = json!({ "maxWidth": 63, "maxHeight": 720 })), "remote webrtc video limit width is invalid.");
    assert_eq!(refusal(&json!("ready")), "remote webrtc signal is invalid.");
}

#[test]
fn a_phones_close_signal_names_its_peer_connection_a_known_reason_and_a_short_detail() {
    let close = |connection: &str, reason: &str, detail: Option<String>| {
        let mut signal = json!({ "type": "close", "v": 1, "source": source(), "connectionId": connection, "generation": 1, "reason": reason });
        if let Some(detail) = detail {
            signal["detail"] = json!(detail);
        }
        signal
    };
    let id = "abcdefghijklmnop";
    let signal = close(id, "viewer-left", Some("x".repeat(200)));
    assert_eq!(ClientSignal::parse(&signal).expect("valid").to_json(), signal);
    for name in [
        "viewer-left",
        "superseded",
        "unsupported",
        "turn-unavailable",
        "negotiation-timeout",
        "ice-failed",
        "dtls-failed",
        "fingerprint-mismatch",
        "media-timeout",
        "channel-failed",
        "sender-failed",
        "unauthorized",
        "protocol-error",
    ] {
        assert_eq!(CloseReason::from_wire(name).map(CloseReason::wire_name), Some(name));
        assert!(ClientSignal::parse(&close(id, name, None)).is_ok(), "{name}");
    }
    assert_eq!(refusal(&close(id, "bored", None)), "remote webrtc close reason is invalid.");
    assert_eq!(refusal(&close("short", "viewer-left", None)), "remote webrtc connection id is invalid.");
    assert_eq!(refusal(&close(id, "viewer-left", Some("x".repeat(201)))), "remote webrtc close detail is invalid.");
}

#[test]
fn a_sources_key_tells_browser_sessions_from_screens() {
    assert_eq!(Source::parse(&source()).expect("browser").key(), "browser:session-1");
    let screen = Source::parse(&json!({ "kind": "screen", "screenId": "display-0" })).expect("screen");
    assert_eq!((screen.key(), screen.session_id()), ("screen:display-0".to_owned(), None));
}

#[test]
fn only_a_screen_viewer_departure_can_omit_the_peer_reference() {
    let display = json!({ "kind": "screen", "screenId": "1" });
    let mut leave = json!({ "v": 1, "source": display, "type": "close", "reason": "viewer-left", "viewerAttempt": 3 });
    assert_eq!(ClientSignal::parse(&leave).unwrap().to_json(), leave);
    leave["connectionId"] = json!("abcdefghijklmnop");
    assert_eq!(refusal(&leave), "remote webrtc generation is invalid.");
    leave["generation"] = json!(1);
    assert_eq!(ClientSignal::parse(&leave).unwrap().to_json(), leave);
    leave["source"] = source();
    assert_eq!(refusal(&leave), "remote webrtc viewer attempt is invalid.");
}

#[test]
fn a_stream_moves_only_along_the_transport_states_and_only_the_connected_one_closes_for_good() {
    use TransportState::*;
    assert!(Relay.can_move_to(Negotiating) && Negotiating.can_move_to(Connected) && Connected.can_move_to(Promoting));
    assert!(Promoting.can_move_to(Webrtc) && Webrtc.can_move_to(Demoting) && Demoting.can_move_to(Cooldown));
    assert!(Cooldown.can_move_to(Relay) && Cooldown.can_move_to(Negotiating));
    assert!(!Relay.can_move_to(Webrtc) && !Webrtc.can_move_to(Relay) && !Connected.can_move_to(Webrtc));
    for state in TransportState::ALL {
        assert_eq!(state == Closed, state.transitions().is_empty(), "{}", state.name());
        assert!(state == Closed || state.can_move_to(Closed), "{} can always be closed", state.name());
    }
    // JPEG frames stop only while the video track carries the picture; page input follows the live path.
    assert!(!Webrtc.jpeg_active() && !Closed.jpeg_active() && Promoting.jpeg_active());
    assert_eq!((Webrtc.input_owner(), Relay.input_owner(), Demoting.input_owner(), Closed.input_owner()), (Some("channel"), Some("relay"), None, None));
}

fn transport_signal(kind: &str) -> Value {
    let mut signal = json!({ "v": 1, "t": kind, "sessionId": "s".repeat(43), "connectionId": "conn-0001", "generation": 1 });
    if kind == "close" {
        signal["reason"] = json!("restart");
    }
    signal
}

#[test]
fn a_transport_close_signal_is_read_from_either_side_and_an_offer_only_from_the_desktop() {
    for role in [Role::Desktop, Role::Client] {
        let parsed = parse_signal(&transport_signal("close"), role).expect("a close");
        assert!(matches!(parsed, Signal::Close { .. }));
        assert_eq!(parsed.to_json(), transport_signal("close"));
    }
    assert_eq!(parse_signal(&transport_signal("offer"), Role::Client).expect_err("refused"), "remote transport: invalid offer direction.");
    assert_eq!(parse_signal(&transport_signal("answer"), Role::Desktop).expect_err("refused"), "remote transport: invalid answer direction.");
    let mut bad = transport_signal("close");
    bad["reason"] = json!("bored");
    assert_eq!(parse_signal(&bad, Role::Client).expect_err("refused"), "remote transport: invalid close reason.");
    let mut short = transport_signal("close");
    short["sessionId"] = json!("short");
    assert_eq!(parse_signal(&short, Role::Client).expect_err("refused"), "remote transport: invalid session id.");
    let mut zero = transport_signal("close");
    zero["generation"] = json!(0);
    assert_eq!(parse_signal(&zero, Role::Client).expect_err("refused"), "remote transport: invalid generation.");
}

/// A box the framing accepts: the application magic, a sequence, filler.
fn app_box(sequence: u64, len: usize) -> Vec<u8> {
    let mut out = vec![0u8; len];
    out[..4].copy_from_slice(&[0x4d, 0x58, 0x45, 0x01]);
    out[4..12].copy_from_slice(&sequence.to_be_bytes());
    out
}

#[test]
fn a_record_that_fits_one_message_is_carried_whole_and_a_larger_one_in_fixed_chunks() {
    let small = app_box(7, 100);
    let messages = encode_record(&small).expect("encodes");
    assert_eq!(messages.len(), 1);
    assert_eq!(&messages[0][..5], &[0x4d, 0x58, 0x54, 0x01, 1]);
    assert_eq!(decode_message(&messages[0]), Ok(Message::Record(RecordMessage::App { sequence: 7, box_bytes: small })));

    let total = 2 * CHUNK_BYTES + 10;
    let big = app_box(9, total);
    let messages = encode_record(&big).expect("encodes");
    assert_eq!(messages.len(), 3);
    let mut joined = Vec::new();
    for (position, bytes) in messages.iter().enumerate() {
        let Message::Record(RecordMessage::Chunk { sequence, index, count, total: declared, data }) = decode_message(bytes).expect("decodes") else {
            panic!("a chunk")
        };
        assert_eq!((sequence, index as usize, count, declared as usize), (9, position, 3, total));
        assert_eq!(bytes.len(), CHUNK_HEADER_BYTES + data.len());
        joined.extend(data);
    }
    assert_eq!(joined, big);
}

#[test]
fn framing_refuses_what_a_conforming_peer_cannot_produce() {
    assert!(encode_record(&[0u8; 10]).is_err(), "not a box");
    assert!(encode_record(&app_box(0, 100)).is_err(), "sequence zero");
    assert!(decode_message(&[0x4d, 0x58, 0x54, 0x01]).is_err(), "no kind");
    assert!(decode_message(&[0x00, 0x58, 0x54, 0x01, 1, 0, 0]).is_err(), "wrong magic");
    let mut unknown = encode_record(&app_box(1, 100)).expect("encodes").remove(0);
    unknown[4] = 9;
    assert!(decode_message(&unknown).is_err(), "unknown kind");
    let mut chunk = encode_record(&app_box(1, CHUNK_BYTES + 50)).expect("encodes").remove(0);
    chunk[13..17].copy_from_slice(&5u32.to_be_bytes());
    assert!(decode_message(&chunk).is_err(), "an index past the count");
    let mut short = encode_record(&app_box(1, CHUNK_BYTES + 50)).expect("encodes").remove(1);
    short.pop();
    assert!(decode_message(&short).is_err(), "a chunk shorter than its place in the record");
    let mut control = vec![0u8; 60];
    control[..4].copy_from_slice(&[0x4d, 0x58, 0x43, 0x01]);
    let carried = encode_control(&control).expect("a control box");
    assert_eq!(decode_message(&carried), Ok(Message::Control { box_bytes: control }));
    assert!(encode_control(&app_box(1, 60)).is_err(), "an application box is not a control box");
}

#[test]
fn the_desktop_redials_with_a_doubling_delay_at_once_after_a_stalled_handshake_and_resets_once_a_leg_holds() {
    let mut redial = Redial::default();
    let delays: Vec<_> = (0..7).map(|_| redial.after_close(None)).collect();
    assert_eq!(delays, [1, 2, 4, 8, 16, 30, 30].map(Duration::from_secs));
    assert_eq!(RETRY_MAX, Duration::from_secs(30));
    redial.on_open();
    assert_eq!(redial.after_close(None), RETRY_MIN, "an open after ordinary drops restarts the backoff");

    let mut stalled = Redial::default();
    assert_eq!(stalled.after_close(Some(4010)), Duration::ZERO);
    assert_eq!(stalled.after_close(Some(4010)), Duration::ZERO);
    assert_eq!(stalled.after_close(Some(4010)), RETRY_MIN, "the third stalled close backs off");
    stalled.on_open();
    assert_eq!(stalled.after_close(None), RETRY_MIN * 2, "an open does not reset while stalled closes are counted");
    stalled.on_stable();
    assert_eq!(stalled.after_close(Some(4010)), Duration::ZERO, "a leg that held clears the count");
}

#[test]
fn a_message_over_one_record_travels_as_fragments_and_is_reassembled_byte_for_byte() {
    let short = r#"{"jsonrpc":"2.0"}"#;
    assert_eq!(split_payload(short, 1).expect("fits"), [short]);

    let body = format!(r#"{{"text":"{}"}}"#, "é€".repeat(MAX_RECORD_PLAINTEXT_BYTES / 4));
    assert!(body.len() > MAX_RECORD_PLAINTEXT_BYTES);
    let parts = split_payload(&body, 5).expect("splits");
    assert_eq!(parts.len(), body.len().div_ceil(FRAGMENT_BYTES));
    assert!(parts.len() >= 2 && parts[0].contains(r#""id":5"#) && parts[0].contains(r#""index":0"#));
    let pool = AssemblyPool::default();
    let mut assembler = MessageAssembler::new(pool.clone());
    for (index, part) in parts.iter().enumerate() {
        let got = assembler.accept(part.as_bytes(), 0).expect("accepted");
        if index + 1 < parts.len() {
            assert_eq!(got, Assembly::Partial);
            assert!(pool.used_bytes() > 0, "the pool is held while a message assembles");
        } else {
            assert_eq!(got, Assembly::Complete(body.clone().into_bytes()));
        }
    }
    assert_eq!(pool.used_bytes(), 0, "the reservation is released on completion");
    assert_eq!(assembler.accept(short.as_bytes(), 0), Ok(Assembly::Complete(short.as_bytes().to_vec())));
}

#[test]
fn fragments_out_of_order_or_interleaved_with_a_whole_message_end_the_assembly_and_free_the_pool() {
    let body = format!(r#"{{"text":"{}"}}"#, "x".repeat(MAX_RECORD_PLAINTEXT_BYTES + 10));
    let parts = split_payload(&body, 1).expect("splits");
    let pool = AssemblyPool::default();
    let mut assembler = MessageAssembler::new(pool.clone());
    assert!(assembler.accept(parts[1].as_bytes(), 0).is_err(), "a message cannot begin at fragment 1");
    assert_eq!(assembler.accept(parts[0].as_bytes(), 0), Ok(Assembly::Partial));
    assert!(assembler.accept(br#"{"jsonrpc":"2.0"}"#, 1).is_err(), "a whole message inside a fragmented one");
    assert!(assembler.accept(parts[0].as_bytes(), 2).is_err(), "the same fragment twice");
    assembler.close();
    assert_eq!(pool.used_bytes(), 0);

    let full = AssemblyPool::new(10);
    let mut waiting = MessageAssembler::new(full);
    assert_eq!(waiting.accept(parts[0].as_bytes(), 0), Ok(Assembly::Wait), "a full pool makes the first fragment wait");
    assert_eq!(waiting.pending_bytes(), 0);
}

#[test]
fn a_path_is_silent_after_the_idle_timeout_and_without_progress_while_records_stay_outstanding() {
    let mut path = PathMonitor::new(0);
    assert_eq!(path.stalled(1_000, 0), None);
    assert_eq!(path.stalled(6_000, 0), Some(Stall::Silent), "nothing heard for the six second idle timeout");

    let mut path = PathMonitor::new(0);
    path.inbound(5_000);
    assert_eq!(path.stalled(5_500, 1_000), None);
    path.inbound(10_000);
    assert_eq!(path.stalled(11_600, 1_000), Some(Stall::NoProgress), "heard, but nothing outstanding was acknowledged");
    path.ack_advanced(11_600);
    assert_eq!(path.stalled(12_000, 1_000), None, "an ack is progress");

    let mut draining = PathMonitor::new(0);
    draining.inbound(100);
    assert_eq!(draining.stalled(100, 5_000), None);
    draining.buffered(5_000, 2_000);
    draining.buffered(1_000, 5_000);
    draining.inbound(5_900);
    assert_eq!(draining.stalled(6_000, 5_000), None, "a falling buffer is progress");
}

#[test]
fn round_trip_samples_follow_the_smoothing_rules_of_a_transport_path() {
    let mut path = PathMonitor::new(0);
    assert_eq!(path.smoothed_rtt_ms(), 333.0, "before any sample the initial estimate stands");
    path.rtt_sample(100.0);
    assert_eq!(path.smoothed_rtt_ms(), 100.0);
    assert_eq!(path.pto_ms(), 100.0 + 200.0 + 25.0, "smoothed + 4 x variance (50) + the ack delay");
    path.rtt_sample(180.0);
    assert_eq!(path.smoothed_rtt_ms(), 110.0, "7/8 old + 1/8 new");
    assert!(path.loss_delay_ms() > 110.0);
    assert_eq!(path.idle_timeout_ms(), 6_000.0);
}
