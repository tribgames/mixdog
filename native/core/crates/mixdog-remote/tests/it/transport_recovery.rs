//! The transport's stream cores driven by scripted peers: the sender's retention, acknowledgement and re-send rules, the
//! receiver's reorder, duplicate and loss rules, and the signal and media message tables with every refusal.

use mixdog_remote::transport::consts::{BUFFER_LOW_BYTES, CHUNK_BYTES, MAX_CONTROL_PLAINTEXT_BYTES, MAX_RECORDS_IN_FLIGHT, RECORD_EXPIRY_MS};
use mixdog_remote::transport::control::{Ack, Authenticated, Control, Repair, ack_json, read_control, repair_json};
use mixdog_remote::transport::frame::RecordMessage;
use mixdog_remote::transport::path::RttEstimate;
use mixdog_remote::transport::receiver::{AcceptResult, AckDue, Receiver};
use mixdog_remote::transport::sender::{Admission, Due, Sender};
use mixdog_remote::transport::signal::{Media, Role, Signal, parse_signal, read_media};
use serde_json::{Value, json};

fn app_box(sequence: u64, len: usize) -> Vec<u8> {
    let mut out = vec![0u8; len];
    out[..4].copy_from_slice(&[0x4d, 0x58, 0x45, 0x01]);
    out[4..12].copy_from_slice(&sequence.to_be_bytes());
    out
}

fn ack(through: u64, ranges: &[(u64, u64)], control_sequence: u64) -> Authenticated<Ack> {
    let value: Value = serde_json::from_str(&ack_json(through, ranges)).expect("json");
    match read_control(&value, control_sequence, false).expect("an ack").expect("not stale") {
        Control::Ack(ack) => ack,
        other => panic!("{other:?}"),
    }
}

fn repair(sequences: &[u64], control_sequence: u64) -> Authenticated<Repair> {
    let value: Value = serde_json::from_str(&repair_json(sequences)).expect("json");
    match read_control(&value, control_sequence, false).expect("a repair").expect("not stale") {
        Control::Repair(repair) => repair,
        other => panic!("{other:?}"),
    }
}

fn sender_with(records: u64) -> Sender {
    let mut sender = Sender::new();
    for sequence in 1..=records {
        assert_eq!(sender.push(app_box(sequence, 100), &Admission::default()), Ok(sequence));
    }
    sender
}

fn sequences(due: &[Due]) -> Vec<u64> {
    due.iter().map(|d| d.sequence).collect()
}

#[test]
fn the_sender_takes_records_in_sequence_only_and_hands_them_over_in_order_within_the_budget() {
    let mut sender = Sender::new();
    assert!(sender.push(app_box(2, 100), &Admission::default()).is_err(), "a gap in the sequence");
    assert_eq!(sender.next_sequence(), 1);
    let mut sender = sender_with(3);
    assert_eq!(sender.next_sequence(), 4);
    assert_eq!(sequences(&sender.due(0, 1e9)), vec![1, 2, 3]);
    assert_eq!(sequences(&sender.due(0, 1.0)), vec![1], "the first record is always offered");
    assert_eq!(sequences(&sender.due(0, 0.0)), Vec::<u64>::new(), "none without room");
    sender.mark_sent(1, "relay", 0);
    assert_eq!(sequences(&sender.due(0, 1e9)), vec![2, 3], "a record handed over is not due again");
}

#[test]
fn an_ack_releases_what_it_covers_refuses_what_was_never_sent_and_a_repeat_releases_nothing() {
    let mut sender = sender_with(3);
    for sequence in 1..=3 {
        sender.mark_sent(sequence, "relay", 10);
    }
    assert!(sender.acknowledge(&ack(9, &[], 1), 20).is_err(), "an ack past the sent records");
    assert_eq!(sender.acknowledge(&ack(2, &[], 2), 20), Ok(2));
    let stats = sender.stats();
    assert_eq!((stats.acked_through, stats.retained_records), (2, 1));
    assert_eq!(sender.acknowledge(&ack(2, &[], 3), 30), Ok(0));
    assert_eq!(sender.acknowledge(&ack(1, &[], 4), 30), Ok(0), "an older ack changes nothing");
    assert_eq!(sender.stats().retained_records, 1);
}

#[test]
fn a_repair_sends_the_named_sent_records_again_counts_the_re_send_and_ignores_unsent_ones() {
    let mut sender = sender_with(3);
    for sequence in 1..=3 {
        sender.mark_sent(sequence, "relay", 0);
    }
    assert_eq!(sender.repair(&repair(&[2, 5], 1)), 1, "record 5 was never sent");
    assert_eq!(sequences(&sender.due(1, 1e9)), vec![2]);
    sender.mark_sent(2, "relay", 1);
    assert_eq!(sender.stats().retransmits, 1);
    assert_eq!(sequences(&sender.due(1, 1e9)), Vec::<u64>::new());
}

#[test]
fn after_a_carrier_fails_its_records_wait_out_the_hold_skip_what_a_selective_ack_covers_and_go_early_on_a_newer_ack() {
    for newer_ack_at_120 in [false, true] {
        let mut sender = sender_with(4);
        for sequence in 1..=4 {
            sender.mark_sent(sequence, "relay", 0);
        }
        assert_eq!(sender.acknowledge(&ack(1, &[(3, 3)], 1), 50), Ok(1));
        assert_eq!(sender.carrier_failed("relay", 100, 50.0), 3);
        assert_eq!(sequences(&sender.due(120, 1e9)), Vec::<u64>::new(), "held");
        if newer_ack_at_120 {
            assert_eq!(sender.acknowledge(&ack(1, &[(3, 3)], 2), 120), Ok(0));
            assert_eq!(sequences(&sender.due(120, 1e9)), vec![2, 4], "an ack newer than the failure ends the hold");
        } else {
            assert_eq!(sequences(&sender.due(150, 1e9)), vec![2, 4], "record 3 is held by the receiver");
        }
    }
}

#[test]
fn a_repair_after_a_selective_ack_makes_the_record_due_again() {
    let mut sender = sender_with(3);
    for sequence in 1..=3 {
        sender.mark_sent(sequence, "relay", 0);
    }
    assert_eq!(sender.acknowledge(&ack(0, &[(2, 2)], 1), 10), Ok(0));
    assert_eq!(sender.carrier_failed("relay", 20, 0.0), 3);
    assert_eq!(sequences(&sender.due(20, 1e9)), vec![1, 3]);
    assert_eq!(sender.repair(&repair(&[2], 2)), 1);
    assert_eq!(sequences(&sender.due(20, 1e9)), vec![1, 2, 3]);
}

#[test]
fn a_session_with_records_unacknowledged_for_a_minute_is_expired_and_one_fully_acknowledged_is_not() {
    let mut sender = sender_with(1);
    sender.mark_sent(1, "relay", 0);
    assert!(!sender.expired(RECORD_EXPIRY_MS - 1));
    assert!(sender.expired(RECORD_EXPIRY_MS));
    assert_eq!(sender.acknowledge(&ack(1, &[], 1), 100), Ok(1));
    assert!(!sender.expired(RECORD_EXPIRY_MS * 10));
}

#[test]
fn the_probe_timeout_doubles_with_each_probe_and_restarts_after_an_ack() {
    let mut sender = sender_with(2);
    assert!(!sender.probe_due(1_000, 100.0), "nothing sent yet");
    sender.mark_sent(1, "relay", 0);
    sender.mark_sent(2, "relay", 0);
    assert!(!sender.probe_due(99, 100.0));
    assert!(sender.probe_due(100, 100.0));
    assert!(!sender.probe_due(299, 100.0), "the second wait is twice as long");
    assert!(sender.probe_due(300, 100.0));
    assert_eq!(sender.acknowledge(&ack(1, &[], 1), 310), Ok(1));
    assert!(!sender.probe_due(409, 100.0), "the wait starts over");
    assert!(sender.probe_due(410, 100.0));
    assert_eq!(sender.acknowledge(&ack(2, &[], 2), 500), Ok(1));
    assert!(!sender.probe_due(10_000, 100.0), "everything sent is acknowledged");
}

#[test]
fn a_bulk_record_is_admitted_only_while_the_carrier_queue_is_low() {
    let sender = Sender::new();
    let bulk = |buffered_amount| Admission { stream: Some("media-1"), buffered_amount };
    assert!(sender.can_admit(&bulk(0)));
    assert!(sender.can_admit(&bulk(BUFFER_LOW_BYTES)));
    assert!(!sender.can_admit(&bulk(BUFFER_LOW_BYTES + 1)));
    assert!(sender.can_admit(&Admission { stream: None, buffered_amount: BUFFER_LOW_BYTES + 1 }), "an ordinary record ignores the queue");
}

struct Rtt;

impl RttEstimate for Rtt {
    fn loss_delay_ms(&self) -> f64 {
        100.0
    }
    fn pto_ms(&self) -> f64 {
        200.0
    }
}

fn whole(sequence: u64) -> RecordMessage {
    RecordMessage::App { sequence, box_bytes: app_box(sequence, 100) }
}

fn deliver(receiver: &mut Receiver, sequence: u64, now: u64) {
    assert_eq!(receiver.next().map(|(seq, _)| seq), Some(sequence));
    receiver.commit(sequence, now).expect("commits");
}

#[test]
fn records_that_arrive_out_of_order_are_delivered_in_order_and_acked_after_two_or_a_delay() {
    let mut receiver = Receiver::new();
    assert_eq!(receiver.accept(&whole(3), 0), AcceptResult::Buffered);
    assert_eq!(receiver.accept(&whole(2), 0), AcceptResult::Buffered);
    assert!(receiver.next().is_none(), "record 1 is missing");
    assert_eq!(receiver.accept(&whole(1), 5), AcceptResult::Buffered);
    deliver(&mut receiver, 1, 10);
    assert_eq!(receiver.ack_due(10), None, "one record is not enough to ack at once");
    assert_eq!(receiver.ack_due(35), Some(AckDue { through: 1, ranges: vec![(2, 3)] }), "after 25 ms, with the records already held");
    deliver(&mut receiver, 2, 36);
    assert_eq!(receiver.ack_due(36), Some(AckDue { through: 2, ranges: vec![(3, 3)] }), "two unacknowledged records");
    receiver.ack_sent(2);
    assert_eq!(receiver.ack_due(1_000), None);
    deliver(&mut receiver, 3, 40);
    assert_eq!(receiver.stats().delivered_through, 3);
}

#[test]
fn a_duplicate_is_counted_and_one_of_a_delivered_record_asks_for_the_ack_again() {
    let mut receiver = Receiver::new();
    assert_eq!(receiver.accept(&whole(2), 0), AcceptResult::Buffered);
    assert_eq!(receiver.accept(&whole(2), 1), AcceptResult::Duplicate);
    assert_eq!(receiver.accept(&whole(1), 1), AcceptResult::Buffered);
    deliver(&mut receiver, 1, 2);
    deliver(&mut receiver, 2, 2);
    receiver.ack_sent(2);
    assert_eq!(receiver.ack_due(3), None);
    assert_eq!(receiver.accept(&whole(1), 4), AcceptResult::Duplicate);
    assert_eq!(receiver.ack_due(4), Some(AckDue { through: 2, ranges: vec![] }));
    assert_eq!(receiver.stats().duplicates, 2);
}

#[test]
fn records_outside_the_window_and_chunks_that_name_another_sequence_are_refused() {
    let mut receiver = Receiver::new();
    assert_eq!(receiver.accept(&whole(MAX_RECORDS_IN_FLIGHT + 1), 0), AcceptResult::OutOfWindow);
    assert_eq!(receiver.accept(&whole(MAX_RECORDS_IN_FLIGHT), 0), AcceptResult::Buffered);
    let forged = RecordMessage::Chunk { sequence: 5, index: 0, count: 2, total: (CHUNK_BYTES + 50) as u32, data: app_box(6, CHUNK_BYTES) };
    assert_eq!(receiver.accept(&forged, 0), AcceptResult::Mismatch);
}

#[test]
fn a_chunked_record_is_assembled_from_chunks_in_any_order_and_a_repeated_chunk_is_a_duplicate() {
    let mut receiver = Receiver::new();
    let total = (CHUNK_BYTES + 50) as u32;
    let box_bytes = app_box(1, CHUNK_BYTES + 50);
    let second = RecordMessage::Chunk { sequence: 1, index: 1, count: 2, total, data: box_bytes[CHUNK_BYTES..].to_vec() };
    let first = RecordMessage::Chunk { sequence: 1, index: 0, count: 2, total, data: box_bytes[..CHUNK_BYTES].to_vec() };
    assert_eq!(receiver.accept(&second, 0), AcceptResult::Buffered);
    assert!(receiver.next().is_none(), "half a record is not delivered");
    assert_eq!(receiver.accept(&second, 0), AcceptResult::Duplicate);
    assert_eq!(receiver.accept(&first, 1), AcceptResult::Buffered);
    let (sequence, bytes) = receiver.next().expect("complete");
    assert_eq!((sequence, bytes), (1, box_bytes.as_slice()));
}

#[test]
fn a_gap_is_declared_lost_by_a_later_record_or_after_the_loss_delay_and_probed_with_a_doubling_wait() {
    let mut receiver = Receiver::new();
    assert_eq!(receiver.accept(&whole(1), 0), AcceptResult::Buffered);
    deliver(&mut receiver, 1, 0);
    assert_eq!(receiver.accept(&whole(5), 100), AcceptResult::Buffered);
    assert_eq!(receiver.repair_due(100, &Rtt), vec![2], "three records arrived past it");
    assert_eq!(receiver.repair_due(150, &Rtt), Vec::<u64>::new());
    assert_eq!(receiver.repair_due(200, &Rtt), vec![3, 4], "the loss delay passed");
    assert_eq!(receiver.repair_due(399, &Rtt), Vec::<u64>::new());
    assert_eq!(receiver.repair_due(400, &Rtt), vec![2, 3], "a probe asks for at most two");
    assert_eq!(receiver.repair_due(799, &Rtt), Vec::<u64>::new(), "the next probe waits twice as long");
    assert_eq!(receiver.repair_due(800, &Rtt), vec![2, 3]);
    assert_eq!(receiver.accept(&whole(2), 810), AcceptResult::Buffered);
    deliver(&mut receiver, 2, 810);
    assert_eq!(receiver.repair_due(1_009, &Rtt), Vec::<u64>::new(), "progress restarts the wait");
    assert_eq!(receiver.repair_due(1_010, &Rtt), vec![3, 4]);
}

#[test]
fn a_ping_naming_the_last_record_reveals_a_lost_final_record() {
    let mut receiver = Receiver::new();
    receiver.probe(2, 0);
    assert_eq!(receiver.repair_due(50, &Rtt), Vec::<u64>::new());
    assert_eq!(receiver.repair_due(100, &Rtt), vec![1, 2]);
}

#[test]
fn a_stalled_assembly_is_evicted_and_asked_for_again() {
    let mut receiver = Receiver::new();
    let total = (CHUNK_BYTES + 50) as u32;
    let half = RecordMessage::Chunk { sequence: 2, index: 0, count: 2, total, data: app_box(2, CHUNK_BYTES) };
    assert_eq!(receiver.accept(&half, 0), AcceptResult::Buffered);
    assert_eq!(receiver.sweep(5_999, 6_000.0), 0);
    assert_eq!(receiver.sweep(6_000, 6_000.0), 1);
    assert_eq!(receiver.stats().evicted, 1);
    assert_eq!(receiver.repair_due(6_000, &Rtt), vec![1, 2], "the evicted record, and the one before it that never came");
}

#[test]
fn a_record_that_fails_to_open_is_discarded_and_asked_for_again() {
    let mut receiver = Receiver::new();
    assert_eq!(receiver.accept(&whole(1), 0), AcceptResult::Buffered);
    receiver.discard(1);
    assert!(receiver.next().is_none());
    assert_eq!(receiver.stats().discarded, 1);
    assert_eq!(receiver.repair_due(0, &Rtt), vec![1]);
    assert!(receiver.commit(2, 0).is_err(), "out of order");
    assert!(receiver.commit(1, 0).is_err(), "nothing complete to commit");
}

#[test]
fn a_carrier_change_sends_the_resume_point_at_once() {
    let mut receiver = Receiver::new();
    receiver.accept(&whole(1), 0);
    deliver(&mut receiver, 1, 0);
    receiver.ack_sent(1);
    receiver.accept(&whole(3), 1);
    assert_eq!(receiver.ack_due(1), None);
    receiver.carrier_changed(2);
    assert_eq!(receiver.ack_due(2), Some(AckDue { through: 1, ranges: vec![(3, 3)] }));
}

// ---- signals ------------------------------------------------------------------------------------------------------

fn fingerprint(seed: u8) -> String {
    (0..32).map(|i| format!("{:02X}", i as u8 ^ seed)).collect::<Vec<_>>().join(":")
}

fn sdp_with(fingerprint: &str) -> String {
    format!("v=0\r\na=fingerprint:sha-256 {fingerprint}\r\n")
}

fn offer() -> Value {
    let print = fingerprint(0);
    json!({ "v": 1, "t": "offer", "sessionId": "s".repeat(43), "connectionId": "conn-0001", "generation": 3,
        "sdp": sdp_with(&print), "fingerprints": [{ "algorithm": "sha-256", "value": print }], "iceServers": [] })
}

fn with(mut base: Value, field: &str, value: Value) -> Value {
    base[field] = value;
    base
}

fn without(mut base: Value, field: &str) -> Value {
    base.as_object_mut().expect("object").remove(field);
    base
}

fn refused(value: &Value, from: Role) -> String {
    parse_signal(value, from).expect_err("refused")
}

#[test]
fn an_offer_with_matching_fingerprints_is_read_and_written_back_as_it_came() {
    let parsed = parse_signal(&offer(), Role::Desktop).expect("an offer");
    assert!(matches!(&parsed, Signal::Offer { at, fingerprints, ice_servers, .. } if at.generation == 3 && fingerprints.len() == 1 && ice_servers.is_empty()));
    assert_eq!(parsed.to_json(), offer());
    let mut answer = with(offer(), "t", json!("answer"));

    answer.as_object_mut().unwrap().remove("iceServers");
    let parsed = parse_signal(&answer, Role::Client).expect("an answer");
    assert!(matches!(parsed, Signal::Answer { .. }));
    assert_eq!(parsed.to_json(), answer);
}

#[test]
fn every_malformed_signal_is_refused_naming_the_first_field_that_is_wrong() {
    let print = fingerprint(0);
    let table: Vec<(&str, Value, &str)> = vec![
        ("not an object", json!([]), "remote transport: invalid signal."),
        ("wrong version", with(offer(), "v", json!(2)), "remote transport: invalid version."),
        ("no version", without(offer(), "v"), "remote transport: invalid version."),
        ("session id too short", with(offer(), "sessionId", json!("s".repeat(42))), "remote transport: invalid session id."),
        ("session id too long", with(offer(), "sessionId", json!("s".repeat(44))), "remote transport: invalid session id."),
        ("session id outside the alphabet", with(offer(), "sessionId", json!(format!("{}+", "s".repeat(42)))), "remote transport: invalid session id."),
        ("connection id too short", with(offer(), "connectionId", json!("short")), "remote transport: invalid connection id."),
        ("connection id too long", with(offer(), "connectionId", json!("c".repeat(65))), "remote transport: invalid connection id."),
        ("generation zero", with(offer(), "generation", json!(0)), "remote transport: invalid generation."),
        ("generation fractional", with(offer(), "generation", json!(1.5)), "remote transport: invalid generation."),
        ("generation text", with(offer(), "generation", json!("1")), "remote transport: invalid generation."),
        ("no type", without(offer(), "t"), "remote transport: invalid signal type."),
        ("unknown type", with(offer(), "t", json!("hello")), "remote transport: invalid signal type."),
        ("sdp not text", with(offer(), "sdp", json!(7)), "remote webrtc sdp is invalid."),
        ("sdp not starting v=0", with(offer(), "sdp", json!("o=- 1")), "remote webrtc sdp is invalid."),
        ("ice-lite sdp", with(offer(), "sdp", json!(format!("v=0\r\na=ice-lite\r\na=fingerprint:sha-256 {print}\r\n"))), "remote webrtc sdp ice-lite is invalid."),
        ("sdp over one control box", with(offer(), "sdp", json!(format!("v=0{}", "x".repeat(MAX_CONTROL_PLAINTEXT_BYTES)))), "remote transport: invalid sdp size."),
        ("no fingerprints", without(offer(), "fingerprints"), "remote transport: invalid fingerprints."),
        ("empty fingerprints", with(offer(), "fingerprints", json!([])), "remote transport: invalid fingerprints."),
        ("four fingerprints", with(offer(), "fingerprints", json!([1, 2, 3, 4])), "remote transport: invalid fingerprints."),
        ("fingerprint not in the sdp", with(offer(), "fingerprints", json!([{ "algorithm": "sha-256", "value": fingerprint(1) }])), "remote transport: invalid fingerprints."),
        ("fingerprint null", with(offer(), "fingerprints", json!([null])), "remote transport: invalid fingerprints."),
        ("no ice servers", without(offer(), "iceServers"), "remote webrtc ice servers is invalid."),
        ("ice server without a scheme", with(offer(), "iceServers", json!([{ "urls": "example.org" }])), "remote webrtc ice server url is invalid."),
    ];
    for (what, signal, message) in table {
        assert_eq!(refused(&signal, Role::Desktop), message, "{what}");
    }
}

#[test]
fn an_answer_flows_only_from_the_client_and_an_offer_only_from_the_desktop() {
    assert_eq!(refused(&offer(), Role::Client), "remote transport: invalid offer direction.");
    let answer = with(offer(), "t", json!("answer"));
    assert_eq!(refused(&answer, Role::Desktop), "remote transport: invalid answer direction.");
    assert!(parse_signal(&answer, Role::Client).is_ok(), "an answer needs no ice servers");
}

#[test]
fn a_candidate_signal_ends_the_candidates_with_null_and_refuses_what_is_not_a_candidate() {
    let candidate = |value: Value| with(with(offer(), "t", json!("candidate")), "candidate", value);
    let line = "candidate:1 1 udp 2113937151 192.0.2.1 54400 typ host";
    let parsed = parse_signal(&candidate(json!({ "candidate": line, "sdpMid": "0" })), Role::Client).expect("a candidate");
    assert!(matches!(parsed, Signal::Candidate { candidate: Some(ref c), .. } if c.candidate == line && c.sdp_mid.as_deref() == Some("0")));
    let end = parse_signal(&candidate(json!(null)), Role::Client).expect("the end");
    assert!(matches!(end, Signal::Candidate { candidate: None, .. }));
    assert_eq!(end.to_json()["candidate"], Value::Null);
    let missing = without(candidate(json!(null)), "candidate");
    assert_eq!(refused(&missing, Role::Client), "remote webrtc candidate is invalid.", "a missing member is not the end marker");
    assert_eq!(refused(&candidate(json!({ "candidate": "garbage", "sdpMid": "0" })), Role::Client), "remote webrtc candidate is invalid.");
    assert_eq!(refused(&candidate(json!({ "candidate": line })), Role::Client), "remote webrtc candidate is invalid.", "neither a mid nor a line index");
    assert_eq!(refused(&candidate(json!({ "candidate": line, "sdpMid": "0", "sdpMLineIndex": 256 })), Role::Client), "remote webrtc candidate line is invalid.");
}

#[test]
fn a_close_signal_carries_a_known_reason_and_a_detail_of_at_most_two_hundred_characters() {
    let close = |reason: Value| with(with(offer(), "t", json!("close")), "reason", reason);
    for reason in [
        "superseded", "negotiation-timeout", "ice-failed", "dtls-failed", "fingerprint-mismatch", "channel-failed", "stall", "restart",
        "peer-host-unavailable", "session-ended", "revoked", "suspended", "protocol-error",
    ] {
        let parsed = parse_signal(&close(json!(reason)), Role::Client).expect(reason);
        assert_eq!(parsed.to_json()["reason"], json!(reason));
    }
    assert_eq!(refused(&close(json!("Restart")), Role::Client), "remote transport: invalid close reason.");
    assert_eq!(refused(&close(json!(null)), Role::Client), "remote transport: invalid close reason.");
    let long = with(close(json!("stall")), "detail", json!("d".repeat(201)));
    assert_eq!(refused(&long, Role::Client), "remote transport: invalid close detail.");
    let edge = with(close(json!("stall")), "detail", json!("d".repeat(200)));
    assert!(parse_signal(&edge, Role::Client).is_ok());
}

fn media(op: &str) -> Value {
    json!({ "type": "transport-media", "op": op, "id": "m-1" })
}

#[test]
fn media_adapter_messages_are_read_each_from_its_own_side_and_written_back_as_they_came() {
    let request = json!({ "type": "transport-media", "op": "request", "id": "m-1", "assetId": "0123abcd-4567", "variant": "full", "range": "bytes=0-99", "enc": "mxe1" });
    let frame = "A".repeat(40);
    let cases = [
        (request, Role::Client),
        (media("cancel"), Role::Client),
        (with(media("head"), "status", json!(200)), Role::Desktop),
        (with(media("chunk"), "frame", json!(frame)), Role::Desktop),
        (media("end"), Role::Desktop),
        (media("error"), Role::Desktop),
    ];
    for (input, from) in cases {
        let parsed = read_media(&input, from).expect("read").expect("a media message");
        assert_eq!(parsed.to_json(), input);
        assert_eq!(parsed.id(), "m-1");
    }
    assert!(matches!(read_media(&media("cancel"), Role::Client), Ok(Some(Media::Cancel { .. }))));
}

#[test]
fn what_is_not_a_media_message_is_passed_over_and_every_malformed_one_is_refused() {
    assert_eq!(read_media(&json!([1]), Role::Client), Ok(None));
    assert_eq!(read_media(&json!({ "type": "something-else" }), Role::Client), Ok(None));
    let request = json!({ "type": "transport-media", "op": "request", "id": "m-1", "assetId": "0123abcd-4567", "variant": "full", "range": "", "enc": "mxe1" });
    assert!(read_media(&request, Role::Client).is_ok(), "an empty range is the whole asset");
    let frame = json!("A".repeat(40));
    let table: Vec<(&str, Value, Role, &str)> = vec![
        ("empty id", with(media("end"), "id", json!("")), Role::Desktop, "remote transport: invalid media id."),
        ("id outside the alphabet", with(media("end"), "id", json!("a b")), Role::Desktop, "remote transport: invalid media id."),
        ("request from the desktop", request.clone(), Role::Desktop, "remote transport: invalid media direction."),
        ("head from the client", with(media("head"), "status", json!(200)), Role::Client, "remote transport: invalid media direction."),
        ("unknown op", media("rewind"), Role::Desktop, "remote transport: invalid media op."),
        ("asset too short", with(request.clone(), "assetId", json!("abc")), Role::Client, "remote transport: invalid media asset."),
        ("asset not hex", with(request.clone(), "assetId", json!("zzzzzzzzzz")), Role::Client, "remote transport: invalid media asset."),
        ("range without bytes=", with(request.clone(), "range", json!("0-9")), Role::Client, "remote transport: invalid media range."),
        ("variant empty", with(request.clone(), "variant", json!("")), Role::Client, "remote transport: invalid media variant."),
        ("scheme too long", with(request.clone(), "enc", json!("e".repeat(17))), Role::Client, "remote transport: invalid media scheme."),
        ("status not allowed", with(media("head"), "status", json!(201)), Role::Desktop, "remote transport: invalid media status."),
        ("status not a number", with(media("head"), "status", json!("200")), Role::Desktop, "remote transport: invalid media status."),
        ("frame too short", with(media("chunk"), "frame", json!("short")), Role::Desktop, "remote transport: invalid media frame."),
        ("frame not base64url", with(media("chunk"), "frame", json!(format!("{}=", frame.as_str().unwrap()))), Role::Desktop, "remote transport: invalid media frame."),
    ];
    for (what, message, from, expected) in table {
        assert_eq!(read_media(&message, from), Err(expected.to_owned()), "{what}");
    }
    for status in [200, 403, 404, 405, 412, 416, 500] {
        assert_eq!(read_media(&with(media("head"), "status", json!(status)), Role::Desktop), Ok(Some(Media::Head { id: "m-1".into(), status })));
    }
}
