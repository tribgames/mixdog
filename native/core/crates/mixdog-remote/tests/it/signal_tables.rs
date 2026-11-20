//! Every message a phone sends the live view and the desktop sends back, table by table: each signal kind read and written back
//! unchanged, and every malformed form refused with the exact refusal text naming the field that is wrong. The data channel's page
//! inputs and screen messages are covered the same way.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use mixdog_remote::webrtc::signal::{ChannelMessage, ClientSignal, DesktopSignal, HelperCredential, ScreenMessage};
use serde_json::{Value, json};

fn edit(mut value: Value, change: impl FnOnce(&mut Value)) -> Value {
    change(&mut value);
    value
}

fn without(value: Value, name: &str) -> Value {
    edit(value, |v| {
        v.as_object_mut().expect("object").remove(name);
    })
}

fn invalid(what: &str) -> String {
    format!("remote webrtc {what} is invalid.")
}

fn source() -> Value {
    json!({ "kind": "browser", "sessionId": "session-1" })
}

fn screen() -> Value {
    json!({ "kind": "screen", "screenId": "display-0" })
}

fn connection(kind: &str) -> Value {
    json!({ "type": kind, "v": 1, "source": source(), "connectionId": "abcdefghijklmnop", "generation": 2 })
}

fn print() -> String {
    (0..32).map(|i| format!("{i:02X}")).collect::<Vec<_>>().join(":")
}

fn sdp() -> String {
    format!("v=0\r\na=fingerprint:sha-256 {}\r\n", print())
}

fn declared() -> Value {
    json!([{ "algorithm": "sha-256", "value": print() }])
}

fn geometry() -> Value {
    json!({ "generation": 1, "cssWidth": 800, "cssHeight": 600, "deviceScaleFactor": 2, "pixelWidth": 1600, "pixelHeight": 1200 })
}

fn answer() -> Value {
    edit(connection("answer"), |v| {
        v["sdp"] = json!(sdp());
        v["fingerprints"] = declared();
    })
}

fn media_ready() -> Value {
    edit(connection("media-ready"), |v| {
        v["documentId"] = json!("p1:2");
        v["geometryGeneration"] = json!(1);
        v["pixelWidth"] = json!(1280);
        v["pixelHeight"] = json!(720);
    })
}

fn client_table_ok() -> Vec<Value> {
    vec![
        json!({ "type": "geometry-ack", "v": 1, "source": source(), "geometryGeneration": 3 }),
        json!({ "type": "resize-request", "v": 1, "source": source(), "resize": { "mode": "page" } }),
        json!({ "type": "resize-request", "v": 1, "source": screen(), "resize": { "mode": "fit-client", "cssWidth": 800, "cssHeight": 600, "deviceScaleFactor": 1.5 } }),
        answer(),
        edit(connection("candidate"), |v| v["candidate"] = json!(null)),
        media_ready(),
        edit(media_ready(), |v| {
            v["source"] = screen();
            v["documentId"] = json!(null);
        }),
        edit(connection("promote-ack"), |v| v["inputEpoch"] = json!(1)),
        edit(connection("demote-ack"), |v| v["inputEpoch"] = json!(7)),
    ]
}

#[test]
fn every_kind_of_phone_signal_is_read_and_written_back_unchanged() {
    for signal in client_table_ok() {
        let parsed = ClientSignal::parse(&signal).unwrap_or_else(|e| panic!("{signal}: {e}"));
        assert_eq!(parsed.to_json(), signal, "{signal}");
        assert_eq!(parsed.type_name(), signal["type"].as_str().expect("type"));
    }
}

#[test]
fn a_phone_signal_that_moves_the_barrier_is_told_from_the_others() {
    let barrier = |signal: Value| ClientSignal::parse(&signal).expect("valid").is_barrier();
    assert!(barrier(edit(connection("promote-ack"), |v| v["inputEpoch"] = json!(1))));
    assert!(barrier(edit(connection("demote-ack"), |v| v["inputEpoch"] = json!(1))));
    assert!(!barrier(answer()));
    assert!(!barrier(media_ready()));
}

#[test]
fn every_malformed_phone_signal_is_refused_naming_the_field_that_is_wrong() {
    let ack = json!({ "type": "geometry-ack", "v": 1, "source": source(), "geometryGeneration": 3 });
    let resize = |mode: Value| json!({ "type": "resize-request", "v": 1, "source": source(), "resize": mode });
    let fit =
        |change: &dyn Fn(&mut Value)| resize(edit(json!({ "mode": "fit-client", "cssWidth": 800, "cssHeight": 600, "deviceScaleFactor": 2 }), |v| change(v)));
    let promote = edit(connection("promote-ack"), |v| v["inputEpoch"] = json!(1));
    let screen_ready = edit(media_ready(), |v| {
        v["source"] = screen();
        v["documentId"] = json!(null);
    });
    let table: Vec<(&str, Value, String)> = vec![
        ("not an object", json!(5), invalid("signal")),
        ("no type", without(ack.clone(), "type"), invalid("signal type")),
        ("unknown type", edit(ack.clone(), |v| v["type"] = json!("hello")), invalid("signal type")),
        ("ack: no version", without(ack.clone(), "v"), invalid("version")),
        ("ack: no source", without(ack.clone(), "source"), invalid("source")),
        ("ack: session id", edit(ack.clone(), |v| v["source"]["sessionId"] = json!("a b")), invalid("session id")),
        ("ack: screen id", edit(ack.clone(), |v| v["source"] = json!({ "kind": "screen", "screenId": "" })), invalid("screen id")),
        ("ack: generation zero", edit(ack.clone(), |v| v["geometryGeneration"] = json!(0)), invalid("geometry generation")),
        ("ack: generation missing", without(ack.clone(), "geometryGeneration"), invalid("geometry generation")),
        ("resize: not an object", resize(json!("page")), invalid("resize")),
        ("resize: unknown mode", resize(json!({ "mode": "zoom" })), invalid("resize mode")),
        ("resize: width low", fit(&|v| v["cssWidth"] = json!(199)), invalid("resize width")),
        ("resize: width high", fit(&|v| v["cssWidth"] = json!(3841)), invalid("resize width")),
        ("resize: width fractional", fit(&|v| v["cssWidth"] = json!(800.5)), invalid("resize width")),
        ("resize: height low", fit(&|v| v["cssHeight"] = json!(199)), invalid("resize height")),
        ("resize: scale low", fit(&|v| v["deviceScaleFactor"] = json!(0.4)), invalid("resize scale")),
        ("resize: scale high", fit(&|v| v["deviceScaleFactor"] = json!(4.1)), invalid("resize scale")),
        (
            "ready: video limit not an object",
            edit(json!({ "type": "ready", "v": 1, "source": source(), "receiveCodecs": [] }), |v| v["videoLimit"] = json!(null)),
            invalid("video limit"),
        ),
        (
            "ready: video limit height",
            json!({ "type": "ready", "v": 1, "source": source(), "receiveCodecs": [], "videoLimit": { "maxWidth": 64, "maxHeight": 4097 } }),
            invalid("video limit height"),
        ),
        ("ready: codec without a subtype", json!({ "type": "ready", "v": 1, "source": source(), "receiveCodecs": ["video/"] }), invalid("receive codec")),
        ("answer: no sdp", without(answer(), "sdp"), invalid("sdp")),
        ("answer: sdp not v=0", edit(answer(), |v| v["sdp"] = json!("x")), invalid("sdp")),
        (
            "answer: ice-lite",
            edit(answer(), |v| v["sdp"] = json!(format!("v=0\r\na=ice-lite\r\na=fingerprint:sha-256 {}\r\n", print()))),
            invalid("sdp ice-lite"),
        ),
        ("answer: no fingerprints", without(answer(), "fingerprints"), invalid("fingerprints")),
        ("answer: four fingerprints", edit(answer(), |v| v["fingerprints"] = json!([1, 2, 3, 4])), invalid("fingerprints")),
        ("answer: unknown algorithm", edit(answer(), |v| v["fingerprints"][0]["algorithm"] = json!("md5")), invalid("fingerprint algorithm")),
        ("answer: short fingerprint", edit(answer(), |v| v["fingerprints"][0]["value"] = json!("AA:BB")), invalid("fingerprint value")),
        (
            "answer: fingerprint not in the sdp",
            edit(answer(), |v| v["fingerprints"][0]["value"] = json!(print().replace("00:", "FF:"))),
            "remote webrtc fingerprint-mismatch: SDP and signaled fingerprints differ.".to_owned(),
        ),
        ("answer: connection id short", edit(answer(), |v| v["connectionId"] = json!("short")), invalid("connection id")),
        ("answer: generation zero", edit(answer(), |v| v["generation"] = json!(0)), invalid("generation")),
        ("candidate: member missing", connection("candidate"), invalid("candidate")),
        ("candidate: not a candidate", edit(connection("candidate"), |v| v["candidate"] = json!({ "candidate": "x", "sdpMid": "0" })), invalid("candidate")),
        ("media: browser without a document", without(media_ready(), "documentId"), invalid("document id")),
        ("media: document token malformed", edit(media_ready(), |v| v["documentId"] = json!("p0:1")), invalid("document id")),
        ("media: screen with a document", edit(screen_ready.clone(), |v| v["documentId"] = json!("p1:2")), invalid("document id")),
        ("media: screen without the member", without(screen_ready, "documentId"), invalid("document id")),
        ("media: generation zero", edit(media_ready(), |v| v["geometryGeneration"] = json!(0)), invalid("geometry generation")),
        ("media: odd width", edit(media_ready(), |v| v["pixelWidth"] = json!(1281)), invalid("media width")),
        ("media: width past the bound", edit(media_ready(), |v| v["pixelWidth"] = json!(4098)), invalid("media width")),
        ("media: height too small", edit(media_ready(), |v| v["pixelHeight"] = json!(0)), invalid("media height")),
        ("promote-ack: epoch zero", edit(promote.clone(), |v| v["inputEpoch"] = json!(0)), invalid("input epoch")),
        ("promote-ack: epoch missing", without(promote, "inputEpoch"), invalid("input epoch")),
        ("demote-ack: epoch text", edit(connection("demote-ack"), |v| v["inputEpoch"] = json!("1")), invalid("input epoch")),
    ];
    for (what, signal, expected) in table {
        assert_eq!(ClientSignal::parse(&signal), Err(expected), "{what}");
    }
}

fn offer() -> Value {
    edit(connection("offer"), |v| {
        v["sdp"] = json!(sdp());
        v["fingerprints"] = declared();
        v["iceServers"] = json!([{ "urls": ["turn:turn.example.org:3478"], "username": "u", "credential": "c" }]);
        v["iceTransportPolicy"] = json!("relay");
        v["geometry"] = geometry();
        v["inputEpoch"] = json!(4);
    })
}

#[test]
fn every_kind_of_desktop_signal_is_read_and_written_back_unchanged() {
    let table = [
        json!({ "type": "geometry", "v": 1, "source": source(), "geometry": geometry() }),
        offer(),
        edit(offer(), |v| {
            v["iceServers"] = json!([]);
            v["iceTransportPolicy"] = json!("all");
        }),
        edit(connection("candidate"), |v| v["candidate"] = json!(null)),
        edit(connection("promote"), |v| {
            v["inputEpoch"] = json!(2);
            v["geometryGeneration"] = json!(1);
        }),
        edit(connection("demote"), |v| {
            v["inputEpoch"] = json!(2);
            v["reason"] = json!("channel-failed");
        }),
        edit(connection("close"), |v| v["reason"] = json!("superseded")),
        edit(connection("close"), |v| {
            v["reason"] = json!("turn-unavailable");
            v["retryAfterMs"] = json!(1500);
        }),
    ];
    for signal in table {
        let parsed = DesktopSignal::parse(&signal).unwrap_or_else(|e| panic!("{signal}: {e}"));
        assert_eq!(parsed.to_json(), signal, "{signal}");
        assert_eq!(parsed.type_name(), signal["type"].as_str().expect("type"));
    }
}

#[test]
fn every_malformed_desktop_signal_is_refused_naming_the_field_that_is_wrong() {
    let geometry_signal = |change: &dyn Fn(&mut Value)| json!({ "type": "geometry", "v": 1, "source": source(), "geometry": edit(geometry(), |v| change(v)) });
    let promote = edit(connection("promote"), |v| {
        v["inputEpoch"] = json!(2);
        v["geometryGeneration"] = json!(1);
    });
    let demote = edit(connection("demote"), |v| {
        v["inputEpoch"] = json!(2);
        v["reason"] = json!("ice-failed");
    });
    let close = edit(connection("close"), |v| v["reason"] = json!("superseded"));
    let table: Vec<(&str, Value, String)> = vec![
        ("no type", without(offer(), "type"), invalid("signal type")),
        ("unknown type", edit(offer(), |v| v["type"] = json!("hello")), invalid("signal type")),
        ("geometry: not an object", json!({ "type": "geometry", "v": 1, "source": source(), "geometry": 1 }), invalid("geometry")),
        ("geometry: generation zero", geometry_signal(&|v| v["generation"] = json!(0)), invalid("geometry generation")),
        ("geometry: scale zero", geometry_signal(&|v| v["deviceScaleFactor"] = json!(0)), invalid("geometry scale")),
        ("geometry: scale high", geometry_signal(&|v| v["deviceScaleFactor"] = json!(33)), invalid("geometry scale")),
        ("geometry: width zero", geometry_signal(&|v| v["cssWidth"] = json!(0)), invalid("geometry width")),
        ("geometry: width high", geometry_signal(&|v| v["cssWidth"] = json!(16385)), invalid("geometry width")),
        ("geometry: height zero", geometry_signal(&|v| v["cssHeight"] = json!(0)), invalid("geometry height")),
        ("geometry: odd pixel width", geometry_signal(&|v| v["pixelWidth"] = json!(1601)), invalid("geometry pixel width")),
        ("geometry: pixel height high", geometry_signal(&|v| v["pixelHeight"] = json!(4098)), invalid("geometry pixel height")),
        ("offer: no sdp", without(offer(), "sdp"), invalid("sdp")),
        ("offer: fingerprints missing", without(offer(), "fingerprints"), invalid("fingerprints")),
        ("offer: connection id", edit(offer(), |v| v["connectionId"] = json!("x")), invalid("connection id")),
        ("offer: ice servers missing", without(offer(), "iceServers"), invalid("ice servers")),
        ("offer: ice server scheme", edit(offer(), |v| v["iceServers"] = json!([{ "urls": "example.org" }])), invalid("ice server url")),
        ("offer: policy", edit(offer(), |v| v["iceTransportPolicy"] = json!("any")), invalid("ice transport policy")),
        ("offer: geometry missing", without(offer(), "geometry"), invalid("geometry")),
        ("offer: epoch zero", edit(offer(), |v| v["inputEpoch"] = json!(0)), invalid("input epoch")),
        ("candidate: member missing", connection("candidate"), invalid("candidate")),
        ("promote: epoch zero", edit(promote.clone(), |v| v["inputEpoch"] = json!(0)), invalid("input epoch")),
        ("promote: generation missing", without(promote, "geometryGeneration"), invalid("geometry generation")),
        ("demote: reason unknown", edit(demote.clone(), |v| v["reason"] = json!("bored")), invalid("close reason")),
        ("demote: epoch missing", without(demote, "inputEpoch"), invalid("input epoch")),
        ("close: reason missing", without(close.clone(), "reason"), invalid("close reason")),
        ("close: retry negative", edit(close.clone(), |v| v["retryAfterMs"] = json!(-1)), invalid("retry after")),
        ("close: retry fractional", edit(close.clone(), |v| v["retryAfterMs"] = json!(1.5)), invalid("retry after")),
        ("close: retry text", edit(close, |v| v["retryAfterMs"] = json!("soon")), invalid("retry after")),
    ];
    for (what, signal, expected) in table {
        assert_eq!(DesktopSignal::parse(&signal), Err(expected), "{what}");
    }
}

// ---- the data channel ---------------------------------------------------------------------------------------------------

fn input(control: Value) -> String {
    json!({ "v": 1, "kind": "input", "epoch": 1, "seq": 5, "geometryGeneration": 1, "sentAt": 1000, "control": control }).to_string()
}

fn page(kind: &str, fields: Value) -> Value {
    let mut control = json!({ "type": kind, "documentId": "p1:2" });
    for (name, value) in fields.as_object().expect("object") {
        control[name] = value.clone();
    }
    control
}

fn pointer() -> Value {
    page("pointer", json!({ "phase": "mouseMoved", "button": "none", "x": 10, "y": 20, "buttons": 0, "modifiers": 0, "clickCount": 0 }))
}

#[test]
fn every_page_input_is_read_into_its_normal_form() {
    let table = [
        pointer(),
        edit(pointer(), |v| {
            v["phase"] = json!("mousePressed");
            v["button"] = json!("left");
            v["buttons"] = json!(1);
            v["clickCount"] = json!(2);
        }),
        page("wheel", json!({ "x": 1, "y": 2, "deltaX": -20, "deltaY": 120 })),
        page("text", json!({ "text": "hi" })),
        page("key", json!({ "key": "Enter" })),
        page("composition", json!({ "text": "ab", "selectionStart": 0, "selectionEnd": 2 })),
        page("composition-end", json!({ "text": "ab" })),
    ];
    for control in table {
        let parsed = ChannelMessage::parse(&input(control.clone())).unwrap_or_else(|e| panic!("{control}: {e}"));
        let ChannelMessage::Input { epoch, seq, geometry_generation, sent_at, control: read } = parsed else { panic!("an input") };
        assert_eq!((epoch, seq, geometry_generation, sent_at), (1, 5, 1, 1000.0));
        assert_eq!(read, control);
    }
}

#[test]
fn a_page_input_or_its_envelope_that_is_malformed_is_refused_naming_what_is_wrong() {
    let envelope = |change: &dyn Fn(&mut Value)| edit(serde_json::from_str(&input(pointer())).expect("json"), |v| change(v)).to_string();
    let table: Vec<(&str, String, String)> = vec![
        ("not json", "{".to_owned(), invalid("channel message")),
        ("not an object", "[]".to_owned(), invalid("channel message")),
        ("wrong version", envelope(&|v| v["v"] = json!(2)), invalid("version")),
        ("epoch zero", envelope(&|v| v["epoch"] = json!(0)), invalid("input epoch")),
        ("seq zero", envelope(&|v| v["seq"] = json!(0)), invalid("input seq")),
        ("generation zero", envelope(&|v| v["geometryGeneration"] = json!(0)), invalid("geometry generation")),
        ("sent at negative", envelope(&|v| v["sentAt"] = json!(-1)), invalid("input time")),
        ("unknown kind", envelope(&|v| v["kind"] = json!("hello")), invalid("channel message kind")),
        ("control not an object", envelope(&|v| v["control"] = json!(1)), invalid("input")),
        ("unknown control", input(page("scroll", json!({}))), invalid("input type")),
        ("document token malformed", input(edit(pointer(), |v| v["documentId"] = json!("p0:1"))), "remote browser document id is invalid.".to_owned()),
        ("text too long", input(page("text", json!({ "text": "t".repeat(2001) }))), "remote browser text is invalid.".to_owned()),
        ("text empty", input(page("text", json!({ "text": "" }))), "Browser text is invalid.".to_owned()),
        ("key missing", input(page("key", json!({}))), "Browser key is invalid.".to_owned()),
        ("key too long", input(page("key", json!({ "key": "k".repeat(65) }))), "Browser key is invalid.".to_owned()),
        ("pointer phase", input(edit(pointer(), |v| v["phase"] = json!("hover"))), "Browser pointer is invalid.".to_owned()),
        ("pointer button", input(edit(pointer(), |v| v["button"] = json!("side"))), "Browser pointer is invalid.".to_owned()),
        ("pointer x", input(edit(pointer(), |v| v["x"] = json!(-1))), "Browser x is invalid.".to_owned()),
        ("pointer buttons", input(edit(pointer(), |v| v["buttons"] = json!(8))), "Browser buttons is invalid.".to_owned()),
        ("pointer modifiers", input(edit(pointer(), |v| v["modifiers"] = json!(16))), "Browser modifiers is invalid.".to_owned()),
        ("pointer click count", input(edit(pointer(), |v| v["clickCount"] = json!(4))), "Browser clickCount is invalid.".to_owned()),
        ("wheel delta", input(page("wheel", json!({ "x": 1, "y": 2, "deltaX": 20001, "deltaY": 0 }))), "Browser deltaX is invalid.".to_owned()),
        (
            "selection past the text",
            input(page("composition", json!({ "text": "ab", "selectionStart": 0, "selectionEnd": 3 }))),
            "Browser selectionEnd is invalid.".to_owned(),
        ),
        (
            "selection fractional",
            input(page("composition", json!({ "text": "ab", "selectionStart": 0.5, "selectionEnd": 1 }))),
            "Browser composition selection is invalid.".to_owned(),
        ),
    ];
    for (what, text, expected) in table {
        assert_eq!(ChannelMessage::parse(&text), Err(expected), "{what}");
    }
}

fn stats() -> Value {
    json!({
        "connectionId": "abcdefghijklmnop", "generation": 2, "at": 5000, "framesReceived": 10, "framesDecoded": 9, "framesDropped": 1,
        "totalDecodeTimeMs": 120, "codec": "video/VP8", "freezeCount": 0,
        "candidatePair": { "localType": "host", "remoteType": "relay", "protocol": "udp", "relayProtocol": "tls", "currentRoundTripTimeMs": 30 }
    })
}

fn stats_message(stats: Value) -> String {
    json!({ "v": 1, "kind": "stats", "stats": stats }).to_string()
}

#[test]
fn the_phones_receiver_statistics_are_read_by_both_viewers_and_refused_when_malformed() {
    let expected = Ok(stats());
    assert_eq!(ChannelMessage::parse(&stats_message(stats())), expected.clone().map(ChannelMessage::Stats));
    assert_eq!(ScreenMessage::parse(&stats_message(stats())), expected.map(ScreenMessage::Stats));
    let table: Vec<(&str, Value, String)> = vec![
        ("not an object", json!(1), invalid("stats")),
        ("connection id", edit(stats(), |v| v["connectionId"] = json!("x")), invalid("connection id")),
        ("generation", edit(stats(), |v| v["generation"] = json!(0)), invalid("generation")),
        ("time", edit(stats(), |v| v["at"] = json!(-1)), invalid("stats time")),
        ("frames received missing", without(stats(), "framesReceived"), invalid("frames received")),
        ("decode time", edit(stats(), |v| v["totalDecodeTimeMs"] = json!("1")), invalid("decode time")),
        ("label too long", edit(stats(), |v| v["codec"] = json!("c".repeat(129))), invalid("stats label")),
        ("optional count", edit(stats(), |v| v["freezeCount"] = json!(-1)), invalid("freeze count")),
        ("pair not an object", edit(stats(), |v| v["candidatePair"] = json!(1)), invalid("candidate pair")),
        ("pair protocol", edit(stats(), |v| v["candidatePair"]["protocol"] = json!("sctp")), invalid("candidate protocol")),
        ("pair type", edit(stats(), |v| v["candidatePair"]["localType"] = json!("lan")), invalid("candidate type")),
        ("pair relay protocol", edit(stats(), |v| v["candidatePair"]["relayProtocol"] = json!("quic")), invalid("relay protocol")),
        ("pair round trip", edit(stats(), |v| v["candidatePair"]["currentRoundTripTimeMs"] = json!(-1)), invalid("round trip")),
    ];
    for (what, value, expected) in table {
        assert_eq!(ChannelMessage::parse(&stats_message(value.clone())), Err(expected.clone()), "browser viewer: {what}");
        assert_eq!(ScreenMessage::parse(&stats_message(value)), Err(expected), "screen viewer: {what}");
    }
}

#[test]
fn a_screen_message_is_valid_json_the_browser_viewer_passes_over() {
    for kind in ["screen-frame-seen", "screen-helper-grant", "screen-helper-install", "screen-input"] {
        let text = json!({ "v": 1, "kind": kind }).to_string();
        assert_eq!(ChannelMessage::parse(&text), Ok(ChannelMessage::Screen), "{kind}");
    }
}

// ---- a screen source's messages -------------------------------------------------------------------------------------------

fn controller_key(first: u8) -> String {
    let mut bytes = vec![4u8];
    bytes.extend((0..64).map(|i| first.wrapping_add(i)));
    URL_SAFE_NO_PAD.encode(bytes)
}

fn screen_message(kind: &str, fields: Value) -> Value {
    let mut message = json!({ "v": 1, "kind": kind });
    for (name, value) in fields.as_object().expect("object") {
        message[name] = value.clone();
    }
    message
}

fn screen_input(control: Value) -> Value {
    screen_message("screen-input", json!({ "epoch": 2, "seq": 3, "geometryGeneration": 1, "sentAt": 500, "control": control }))
}

fn parse_screen(message: &Value) -> Result<ScreenMessage, String> {
    ScreenMessage::parse(&message.to_string())
}

fn grant() -> Value {
    screen_message("screen-helper-grant", json!({ "epoch": 2, "challenge": format!("{}A==", "A".repeat(21)), "signature": format!("{}A==", "A".repeat(85)) }))
}

fn install() -> Value {
    screen_message("screen-helper-install", json!({ "publicKey": controller_key(1) }))
}

#[test]
fn the_screen_messages_of_a_phone_are_read_into_their_variants() {
    assert_eq!(parse_screen(&screen_message("screen-frame-seen", json!({ "epoch": 4 }))), Ok(ScreenMessage::FrameSeen { epoch: 4 }));
    assert_eq!(
        parse_screen(&grant()),
        Ok(ScreenMessage::HelperGrant { epoch: 2, challenge: format!("{}A==", "A".repeat(21)), signature: format!("{}A==", "A".repeat(85)) })
    );
    assert_eq!(parse_screen(&install()), Ok(ScreenMessage::HelperInstall { public_key: controller_key(1), credential: None }));
    let with_credential = edit(install(), |v| {
        v["credential"] = json!({ "user": "admin", "password": "pw" });
        v["keys"] = json!([controller_key(2)]);
    });
    assert_eq!(
        parse_screen(&with_credential),
        Ok(ScreenMessage::HelperInstall {
            public_key: controller_key(1),
            credential: Some(HelperCredential { user: Some("admin".into()), password: "pw".into() })
        })
    );
    let enroll = screen_message("screen-helper-enroll", json!({ "publicKey": controller_key(3), "credential": { "user": "", "password": "pw" } }));
    assert_eq!(
        parse_screen(&enroll),
        Ok(ScreenMessage::HelperEnroll { public_key: controller_key(3), credential: Some(HelperCredential { user: None, password: "pw".into() }) }),
        "an empty user is the account running the core"
    );
    let no_credential = edit(enroll, |v| v["credential"] = json!(null));
    assert_eq!(parse_screen(&no_credential), Ok(ScreenMessage::HelperEnroll { public_key: controller_key(3), credential: None }));
}

#[test]
fn every_screen_input_is_read_into_its_normal_form() {
    let table = [
        (json!({ "type": "screen-pointer", "action": "move", "x": 10, "y": 20 }), json!({ "type": "screen-pointer", "action": "move", "x": 10, "y": 20 })),
        (
            json!({ "type": "screen-pointer", "action": "down", "button": "left", "x": 1.5, "y": 2 }),
            json!({ "type": "screen-pointer", "action": "down", "button": "left", "x": 1.5, "y": 2 }),
        ),
        (
            json!({ "type": "screen-wheel", "x": 5, "y": 6, "deltaX": 120, "deltaY": -240 }),
            json!({ "type": "screen-wheel", "x": 5, "y": 6, "deltaX": 120, "deltaY": -240 }),
        ),
        (json!({ "type": "screen-wheel", "x": 5, "y": 6 }), json!({ "type": "screen-wheel", "x": 5, "y": 6, "deltaX": 0, "deltaY": 0 })),
        (
            json!({ "type": "screen-key", "action": "down", "vk": 13, "scan": 28 }),
            json!({ "type": "screen-key", "action": "down", "vk": 13, "scan": 28, "extended": false }),
        ),
        (
            json!({ "type": "screen-keys", "keys": [{ "vk": 17 }, { "vk": 67, "scan": 46, "extended": true }] }),
            json!({ "type": "screen-keys", "keys": [{ "vk": 17, "scan": 0, "extended": false }, { "vk": 67, "scan": 46, "extended": true }] }),
        ),
        (json!({ "type": "screen-text", "text": "hello" }), json!({ "type": "screen-text", "text": "hello" })),
        (json!({ "type": "screen-release" }), json!({ "type": "screen-release" })),
    ];
    for (control, normal) in table {
        let Ok(ScreenMessage::Input { epoch, seq, geometry_generation, sent_at, control: read }) = parse_screen(&screen_input(control.clone())) else {
            panic!("{control} is an input")
        };
        assert_eq!((epoch, seq, geometry_generation, sent_at), (2, 3, 1, 500.0));
        assert_eq!(read, normal, "{control}");
    }
}

#[test]
fn every_malformed_screen_message_is_refused_naming_what_is_wrong() {
    let key = |change: &dyn Fn(&mut Value)| screen_input(edit(json!({ "type": "screen-key", "action": "down", "vk": 13, "scan": 28 }), |v| change(v)));
    let keys = |list: Value| screen_input(json!({ "type": "screen-keys", "keys": list }));
    let credential = |value: Value| edit(install(), |v| v["credential"] = value);
    let pointer = |change: &dyn Fn(&mut Value)| {
        screen_input(edit(json!({ "type": "screen-pointer", "action": "down", "button": "left", "x": 1, "y": 2 }), |v| change(v)))
    };
    let wheel = |change: &dyn Fn(&mut Value)| screen_input(edit(json!({ "type": "screen-wheel", "x": 1, "y": 2 }), |v| change(v)));
    let same_key = json!({ "vk": 17 });
    let table: Vec<(&str, Value, String)> = vec![
        ("wrong version", edit(grant(), |v| v["v"] = json!(2)), invalid("version")),
        ("a page input kind", screen_message("input", json!({})), invalid("channel message kind")),
        ("no kind", json!({ "v": 1 }), invalid("channel message kind")),
        ("frame seen: epoch", screen_message("screen-frame-seen", json!({ "epoch": 0 })), invalid("video epoch")),
        ("grant: epoch", edit(grant(), |v| v["epoch"] = json!(0)), invalid("video epoch")),
        ("grant: challenge", edit(grant(), |v| v["challenge"] = json!("AAAA")), invalid("helper challenge")),
        ("grant: challenge padding", edit(grant(), |v| v["challenge"] = json!(format!("{}B==", "A".repeat(21)))), invalid("helper challenge")),
        ("grant: signature", edit(grant(), |v| v["signature"] = json!(format!("{}A==", "A".repeat(84)))), invalid("helper signature")),
        ("install: key", edit(install(), |v| v["publicKey"] = json!("short")), invalid("controller key")),
        ("install: key missing", without(install(), "publicKey"), invalid("controller key")),
        ("install: keys not a list", edit(install(), |v| v["keys"] = json!("x")), invalid("helper keys")),
        ("install: too many keys", edit(install(), |v| v["keys"] = json!(vec![controller_key(2); 257])), invalid("helper keys")),
        ("install: a bad extra key", edit(install(), |v| v["keys"] = json!([controller_key(2), "bad"])), invalid("controller key")),
        ("install: credential not an object", credential(json!("pw")), invalid("credential")),
        ("install: password empty", credential(json!({ "password": "" })), invalid("credential password")),
        ("install: password missing", credential(json!({ "user": "a" })), invalid("credential password")),
        ("install: password too long", credential(json!({ "password": "p".repeat(257) })), invalid("credential password")),
        ("install: user not text", credential(json!({ "user": 1, "password": "pw" })), invalid("credential user")),
        ("install: user too long", credential(json!({ "user": "u".repeat(514), "password": "pw" })), invalid("credential user")),
        ("enroll: key", screen_message("screen-helper-enroll", json!({ "publicKey": 1 })), invalid("controller key")),
        ("input: epoch", edit(screen_input(json!({ "type": "screen-release" })), |v| v["epoch"] = json!(0)), invalid("input epoch")),
        ("input: seq", edit(screen_input(json!({ "type": "screen-release" })), |v| v["seq"] = json!(0)), invalid("input seq")),
        ("input: generation", edit(screen_input(json!({ "type": "screen-release" })), |v| v["geometryGeneration"] = json!(0)), invalid("geometry generation")),
        ("input: time", edit(screen_input(json!({ "type": "screen-release" })), |v| v["sentAt"] = json!(-1)), invalid("input time")),
        ("input: control not an object", edit(screen_input(json!(null)), |_| {}), invalid("screen input")),
        ("input: unknown control", screen_input(json!({ "type": "screen-drag" })), invalid("screen input type")),
        ("pointer: action", pointer(&|v| v["action"] = json!("drag")), invalid("pointer action")),
        ("pointer: button", pointer(&|v| v["button"] = json!("side")), invalid("pointer button")),
        ("pointer: x", pointer(&|v| v["x"] = json!(4097)), invalid("pointer x")),
        ("pointer: y", pointer(&|v| v["y"] = json!(-1)), invalid("pointer y")),
        ("wheel: position", wheel(&|v| v["x"] = json!("1")), invalid("wheel position")),
        ("wheel: x delta", wheel(&|v| v["deltaX"] = json!(4801)), invalid("wheel x")),
        ("wheel: y delta", wheel(&|v| v["deltaY"] = json!(-4801)), invalid("wheel y")),
        ("wheel: fractional delta", wheel(&|v| v["deltaY"] = json!(1.5)), invalid("wheel y")),
        ("key: action", key(&|v| v["action"] = json!("tap")), invalid("key action")),
        ("key: virtual key", key(&|v| v["vk"] = json!(255)), invalid("virtual key")),
        ("key: scan code", key(&|v| v["scan"] = json!(256)), invalid("scan code")),
        (
            "key: neither code",
            key(&|v| {
                v["vk"] = json!(0);
                v["scan"] = json!(0);
            }),
            invalid("key"),
        ),
        ("key: extended not a bool", key(&|v| v["extended"] = json!("yes")), invalid("key extended")),
        ("keys: not a list", screen_input(json!({ "type": "screen-keys", "keys": 1 })), invalid("key combo")),
        ("keys: empty", keys(json!([])), invalid("key combo")),
        ("keys: nine keys", keys(json!((1..=9).map(|vk| json!({ "vk": vk })).collect::<Vec<_>>())), invalid("key combo")),
        ("keys: an entry that is not an object", keys(json!([1])), invalid("combo key")),
        ("keys: a repeated key", keys(json!([same_key.clone(), same_key])), invalid("key combo repeats a key")),
        ("text: empty", screen_input(json!({ "type": "screen-text", "text": "" })), invalid("text")),
        ("text: too long", screen_input(json!({ "type": "screen-text", "text": "t".repeat(257) })), invalid("text")),
    ];
    for (what, message, expected) in table {
        assert_eq!(parse_screen(&message), Err(expected), "{what}");
    }
    assert_eq!(ScreenMessage::parse("{"), Err(invalid("channel message")));
    assert_eq!(ScreenMessage::parse("[]"), Err(invalid("channel message")));
}
