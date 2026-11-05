//! Known-answer vectors recorded from the Node product (fixtures/remote-e2ee/session.json) and
//! Rust-to-Rust sessions in both carrier forms.

use mixdog_remote::e2ee::*;
use serde_json::Value;

#[allow(clippy::disallowed_methods, reason = "test reads a checked-in fixture")]
fn fixture() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/remote-e2ee/session.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn identity(f: &Value) -> ServerIdentity {
    ServerIdentity::from_json(&f["identity"].to_string()).expect("the product's identity file loads")
}

fn wire_bytes(frame: &Value) -> (bool, Vec<u8>, String) {
    let wire = frame["wire"].as_str().unwrap();
    if frame["carrier"] == "binary" {
        use base64::Engine;
        (true, base64::engine::general_purpose::STANDARD.decode(wire).unwrap(), String::new())
    } else {
        (false, Vec::new(), wire.to_owned())
    }
}

#[test]
fn recorded_sessions_open_in_both_directions() {
    let f = fixture();
    let identity = identity(&f);
    let mut checked = 0;
    for session in f["sessions"].as_array().unwrap().iter().filter(|s| s["frames"].is_array()) {
        let challenge = Challenge::parse(session["challenge"].clone()).unwrap();
        // The PC side: accepts the product's recorded hello and opens the phone's boxes.
        let mut server = accept_client_hello(&identity, &challenge, &session["hello"]).unwrap();
        // The phone side: replays the recorded ephemeral key to open the PC's boxes.
        let key = secret_from_jwk(&session["clientKey"]["privateKeyJwk"]).unwrap();
        let (_, mut client) = create_client_handshake(
            &identity.pairing(),
            &challenge,
            ClientHandshakeOptions { client_key: Some(key), ..Default::default() },
        )
        .unwrap();
        for frame in session["frames"].as_array().unwrap() {
            let (binary, bytes, text) = wire_bytes(frame);
            let wire = if binary { Wire::Binary(&bytes) } else { Wire::Text(&text) };
            let opened = if frame["dir"] == "phone->pc" { server.open(wire) } else { client.open(wire) }.unwrap();
            assert_eq!(serde_json::from_slice::<Value>(&opened).unwrap(), frame["plaintext"]);
            checked += 1;
        }
        assert_eq!(server.media_key(), client.media_key());
        assert!(server.media_key().is_some());
    }
    assert!(checked >= 6, "both carrier forms were replayed");
}

#[test]
fn a_bad_proof_is_refused() {
    let f = fixture();
    let bad = f["sessions"].as_array().unwrap().iter().find(|s| s["name"] == "bad-proof").unwrap();
    let challenge = Challenge::parse(bad["challenge"].clone()).unwrap();
    assert_eq!(accept_client_hello(&identity(&f), &challenge, &bad["hello"]).err(), Some(E2eeError::Auth));
}

#[test]
fn recorded_claims_and_web_push_keys_open() {
    let f = fixture();
    let identity = identity(&f);
    for claim in f["claims"].as_array().unwrap() {
        let answer = &claim["answer"];
        if answer["type"] == "claim-deny" {
            assert!(answer.get("sealed").is_none());
            continue;
        }
        let secret = secret_from_jwk(&claim["claimKey"]["privateKeyJwk"]).unwrap();
        let pair = ClaimKeyPair { public_key: claim["claimKey"]["publicKey"].as_str().unwrap().to_owned(), secret };
        let sealed: SealedBox = serde_json::from_value(answer["sealed"].clone()).unwrap();
        assert_eq!(open_sealed_pairing(&sealed, &pair), Some(identity.pairing()));
    }
    let push = &f["webPush"];
    let sealed: SealedBox = serde_json::from_value(push["sealed"].clone()).unwrap();
    let endpoint = push["endpoint"].as_str().unwrap();
    let keys = open_web_push_keys(&identity, endpoint, &sealed).unwrap();
    assert_eq!(keys.p256dh, push["keys"]["p256dh"]);
    assert_eq!(keys.auth, push["keys"]["auth"]);
    assert!(open_web_push_keys(&identity, "https://other.invalid/", &sealed).is_none());
}

#[test]
fn rust_sessions_round_trip_and_reject_replay() {
    let server_identity = ServerIdentity::generate();
    let reloaded = ServerIdentity::from_json(&server_identity.to_json()).unwrap();
    assert_eq!(reloaded.server_public_key, server_identity.server_public_key);
    for binary in [true, false] {
        let challenge = Challenge::create(&["binaryFrames", "deflate", "mediaE2ee"]);
        let (hello, mut phone) =
            create_client_handshake(&reloaded.pairing(), &challenge, Default::default()).unwrap();
        let mut pc = accept_client_hello(&reloaded, &challenge, &hello).unwrap();
        let small = br#"{"jsonrpc":"2.0","id":1}"#.to_vec();
        let big = serde_json::to_vec(&serde_json::json!({"text": "x".repeat(4000)})).unwrap();
        for payload in [&small, &big] {
            let sealed = pc.seal(payload, binary).unwrap();
            let bytes;
            let text;
            let wire = match &sealed {
                Sealed::Binary(b) => { bytes = b.clone(); Wire::Binary(&bytes) }
                Sealed::Text(t) => { text = t.clone(); Wire::Text(&text) }
            };
            assert_eq!(&phone.open(wire).unwrap(), payload);
            assert_eq!(phone.open(wire).err(), Some(E2eeError::Replay));
        }
    }
}

#[test]
fn transport_session_negotiates_confirms_and_separates_domains() {
    let identity = ServerIdentity::generate();
    let challenge = Challenge::create(&["binaryFrames", "transportWebrtc"]);
    let options = ClientHandshakeOptions { transport: true, ..Default::default() };
    let (hello, mut phone) = create_client_handshake(&identity.pairing(), &challenge, options).unwrap();
    let mut pc = accept_client_hello(&identity, &challenge, &hello).unwrap();
    assert!(pc.transport_enabled() && phone.transport_enabled());
    // Nothing is sent before the server's transcript is confirmed.
    assert_eq!(phone.seal(b"{}", true).err(), Some(E2eeError::Unconfirmed));
    let ready = serde_json::json!({"type":"e2ee-ready","transcript":pc.handshake_confirmation().unwrap()});
    let Sealed::Binary(ready_box) = pc.seal(ready.to_string().as_bytes(), true).unwrap() else { panic!() };
    phone.open(Wire::Binary(&ready_box)).unwrap();
    assert_eq!(phone.confirm_handshake(&serde_json::json!({"type":"e2ee-ready","transcript":"forged"})).err(), Some(E2eeError::TranscriptMismatch));
    phone.confirm_handshake(&ready).unwrap();
    phone.seal(b"{}", true).unwrap();

    let lane = ControlLane::direct(1, "conn-a").unwrap();
    assert!(pc.seal_control(b"{}", &lane).is_err(), "unregistered lane");
    for side in [&mut pc, &mut phone] {
        side.register_control_lane(&lane).unwrap();
    }
    let boxed = pc.seal_control(br#"{"t":"ack"}"#, &lane).unwrap();
    assert_eq!(phone.open_control(&boxed, &lane).unwrap(), ControlOpen::Fresh { sequence: 1, value: br#"{"t":"ack"}"#.to_vec() });
    assert_eq!(phone.open_control(&boxed, &lane).unwrap(), ControlOpen::Stale { sequence: 1 });
    let other = ControlLane::direct(2, "conn-b").unwrap();
    phone.register_control_lane(&other).unwrap();
    assert!(phone.open_control(&boxed, &other).is_err(), "a box opens only on the lane it was sealed for");
    phone.retire_control_lane(&other).unwrap();
    assert!(phone.register_control_lane(&other).is_err(), "a retired epoch never returns");
    // An app box does not open as control, and the oversize bound holds before a sequence is spent.
    assert!(pc.seal(&vec![b'a'; 1024 * 1024 + 1], true).is_err());
}
