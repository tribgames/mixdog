//! The live view's wire contract against Node's recorded outcomes (`fixtures/live-view/signals.json`,
//! recorded from `apps/desktop/src/shared/remote-webrtc.ts` at b6f10295a): every valid message, and
//! every field of every message replaced by junk or removed, must be accepted or refused with the
//! value and the words Node gave.

use mixdog_remote::webrtc::signal::ChannelMessage;
use mixdog_remote::webrtc::signal::ClientSignal;
use mixdog_remote::webrtc::signal::DesktopSignal;
use mixdog_remote::webrtc::signal::Fingerprint;
use mixdog_remote::webrtc::signal::Source;
use mixdog_remote::webrtc::signal::TransportState;
use mixdog_remote::webrtc::signal::assert_sdp_fingerprints;
use mixdog_remote::webrtc::signal::certificate_value_matches;
use mixdog_remote::webrtc::signal::is_candidate_line;
use mixdog_remote::webrtc::signal::sdp_fingerprints;
use serde_json::Value;
use serde_json::json;

const SIGNALS: &str = include_str!("../../../../fixtures/live-view/signals.json");

fn recorded() -> Value {
    serde_json::from_str(SIGNALS).expect("the recording is JSON")
}

fn list<'a>(recorded: &'a Value, name: &str) -> &'a [Value] {
    recorded[name].as_array().unwrap_or_else(|| panic!("{name} is recorded"))
}

fn settle(case: &Value, got: Result<Value, String>, what: &str) {
    if case["ok"] == json!(true) {
        assert_eq!(got.as_ref(), Ok(&case["value"]), "{what}: {}", case["input"]);
    } else {
        assert_eq!(got, Err(case["error"].as_str().unwrap().to_owned()), "{what}: {}", case["input"]);
    }
}

#[test]
fn a_phones_signals_are_accepted_or_refused_as_node_did() {
    let recorded = recorded();
    let cases = list(&recorded, "client");
    assert!(cases.len() > 2000);
    for case in cases {
        settle(case, ClientSignal::parse(&case["input"]).map(|s| s.to_json()), "client signal");
    }
}

#[test]
fn the_desktops_signals_are_accepted_or_refused_as_node_did() {
    let recorded = recorded();
    let cases = list(&recorded, "desktop");
    assert!(cases.len() > 1000);
    for case in cases {
        settle(case, DesktopSignal::parse(&case["input"]).map(|s| s.to_json()), "desktop signal");
    }
}

#[test]
fn data_channel_messages_are_read_as_node_read_them() {
    let recorded = recorded();
    let cases = list(&recorded, "channel");
    assert!(cases.len() > 1000);
    let (mut inputs, mut stats, mut screen) = (0, 0, 0);
    for case in cases {
        let text = case["text"].as_str().unwrap();
        let got = ChannelMessage::parse(text);
        let parsed: Option<Value> = serde_json::from_str(text).ok();
        let screen_kind = parsed.as_ref().is_some_and(|v| {
            v["v"] == json!(1)
                && matches!(v["kind"].as_str(), Some("screen-frame-seen" | "screen-helper-grant" | "screen-helper-install" | "screen-input"))
        });
        // A screen source's messages are not a browser viewer's to read: whatever Node made of
        // them, a browser viewer ends the connection (the viewer replay records that).
        if screen_kind {
            assert_eq!(got, Ok(ChannelMessage::Screen), "{text}");
            screen += 1;
            continue;
        }
        let as_node = got.map(|message| match message {
            ChannelMessage::Input { epoch, seq, geometry_generation, sent_at, control } => {
                inputs += 1;
                json!({
                    "v": 1, "kind": "input", "epoch": epoch, "seq": seq, "geometryGeneration": geometry_generation,
                    "sentAt": mixdog_remote::webrtc::signal::num_json(sent_at), "control": control,
                })
            }
            ChannelMessage::Stats(value) => {
                stats += 1;
                json!({ "v": 1, "kind": "stats", "stats": value })
            }
            ChannelMessage::Screen => unreachable!("only screen kinds read as screen"),
        });
        settle(case, as_node, "channel message");
    }
    assert!(inputs > 100 && stats > 50 && screen > 10, "{inputs} inputs, {stats} stats, {screen} screen");
}

#[test]
fn candidate_lines_are_judged_as_node_judged_them() {
    let recorded = recorded();
    let cases = list(&recorded, "candidateLines");
    assert!(cases.len() > 70);
    for case in cases {
        let line = case["line"].as_str().unwrap();
        assert_eq!(is_candidate_line(line), case["ok"] == json!(true), "{line:?}");
    }
}

#[test]
fn sdp_fingerprints_are_read_as_node_read_them() {
    let recorded = recorded();
    for case in list(&recorded, "sdpFingerprints") {
        let got = sdp_fingerprints(case["sdp"].as_str().unwrap()).map(|prints| Value::Array(prints.iter().map(Fingerprint::to_json).collect()));
        settle(case, got, "sdp");
    }
}

#[test]
fn a_connected_certificate_matches_only_a_signaled_fingerprint() {
    let recorded = recorded();
    let cases = list(&recorded, "certificates");
    assert!(cases.len() > 10);
    for case in cases {
        let declared: Vec<Fingerprint> = case["declared"].as_array().unwrap().iter().map(|v| Fingerprint::parse(v).unwrap()).collect();
        assert_eq!(certificate_value_matches(&declared, &case["certificate"]), case["matches"] == json!(true), "{}", case["certificate"]);
    }
    // The SDP itself must name exactly the declared prints.
    let sdp_cases = list(&recorded, "sdpFingerprints");
    let declared = sdp_fingerprints(sdp_cases[0]["sdp"].as_str().unwrap()).unwrap();
    assert!(assert_sdp_fingerprints(sdp_cases[0]["sdp"].as_str().unwrap(), &declared).is_ok());
    assert!(assert_sdp_fingerprints(sdp_cases[0]["sdp"].as_str().unwrap(), &[]).is_err());
}

#[test]
fn the_transport_state_table_is_nodes() {
    let recorded = recorded();
    let rows = list(&recorded, "states");
    assert_eq!(rows.len(), TransportState::ALL.len());
    for (row, state) in rows.iter().zip(TransportState::ALL) {
        assert_eq!(row["state"], json!(state.name()));
        let next: Vec<&str> = TransportState::ALL.into_iter().filter(|to| state.can_move_to(*to)).map(TransportState::name).collect();
        assert_eq!(json!(next), row["next"], "{}", state.name());
        assert_eq!(state.jpeg_active(), row["jpegActive"] == json!(true), "{}", state.name());
        assert_eq!(json!(state.input_owner()), row["inputOwner"], "{}", state.name());
    }
}

#[test]
fn sources_are_keyed_and_barriers_are_chosen_as_node_did() {
    let recorded = recorded();
    for row in list(&recorded, "sourceKeys") {
        let source = &row["source"];
        let source = match source["kind"].as_str().unwrap() {
            "browser" => Source::Browser { session_id: source["sessionId"].as_str().unwrap().to_owned() },
            _ => Source::Screen { screen_id: source["screenId"].as_str().unwrap().to_owned() },
        };
        assert_eq!(json!(source.key()), row["key"]);
    }
    let barriers = list(&recorded, "barriers");
    assert!(barriers.iter().any(|row| row["barrier"] == json!(true)));
    for row in barriers {
        assert_eq!(ClientSignal::parse(&row["raw"]).unwrap().is_barrier(), row["barrier"] == json!(true), "{}", row["name"]);
    }
    let constants = &recorded["constants"];
    assert_eq!(constants["version"], json!(mixdog_remote::webrtc::signal::VERSION));
    assert_eq!(constants["signalMethod"], json!(mixdog_remote::webrtc::signal::SIGNAL_METHOD));
    assert_eq!(constants["signalEvent"], json!(mixdog_remote::webrtc::signal::SIGNAL_EVENT));
    assert_eq!(constants["iceTransportPolicy"], json!(mixdog_remote::webrtc::signal::ICE_TRANSPORT_POLICY));
    assert_eq!(constants["inputChannel"], json!(mixdog_remote::webrtc::config::INPUT_CHANNEL_LABEL));
}
