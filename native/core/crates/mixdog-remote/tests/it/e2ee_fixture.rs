//! End-to-end encrypted sessions between the desktop and a phone in both carrier forms, the transport session, sealed claims and
//! web-push keys.

use mixdog_remote::e2ee::*;

#[test]
fn rust_sessions_round_trip_and_reject_replay() {
    let server_identity = ServerIdentity::generate();
    let reloaded = ServerIdentity::from_json(&server_identity.to_json()).unwrap();
    assert_eq!(reloaded.server_public_key, server_identity.server_public_key);
    for binary in [true, false] {
        let challenge = Challenge::create(&["binaryFrames", "deflate", "mediaE2ee"]);
        let (hello, mut phone) = create_client_handshake(&reloaded.pairing(), &challenge, Default::default()).unwrap();
        let mut pc = accept_client_hello(&reloaded, &challenge, &hello).unwrap();
        let small = br#"{"jsonrpc":"2.0","id":1}"#.to_vec();
        let big = serde_json::to_vec(&serde_json::json!({"text": "x".repeat(4000)})).unwrap();
        for payload in [&small, &big] {
            let sealed = pc.seal(payload, binary).unwrap();
            let bytes;
            let text;
            let wire = match &sealed {
                Sealed::Binary(b) => {
                    bytes = b.clone();
                    Wire::Binary(&bytes)
                }
                Sealed::Text(t) => {
                    text = t.clone();
                    Wire::Text(&text)
                }
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

#[test]
fn a_hello_with_a_wrong_proof_or_for_another_challenge_is_refused() {
    let identity = ServerIdentity::generate();
    let challenge = Challenge::create(&["binaryFrames"]);
    let (hello, _) = create_client_handshake(&identity.pairing(), &challenge, Default::default()).unwrap();
    assert!(accept_client_hello(&identity, &challenge, &hello).is_ok());
    let mut forged = hello.clone();
    forged["proof"] = serde_json::json!("A".repeat(43));
    assert_eq!(accept_client_hello(&identity, &challenge, &forged).err(), Some(E2eeError::Auth));
    let other = Challenge::create(&["binaryFrames"]);
    assert_eq!(accept_client_hello(&identity, &other, &hello).err(), Some(E2eeError::Auth));
    let stranger = ServerIdentity::generate();
    assert_eq!(accept_client_hello(&stranger, &challenge, &hello).err(), Some(E2eeError::Auth));
}

#[test]
fn a_sealed_pairing_opens_only_with_the_claim_key_it_was_sealed_for() {
    let identity = ServerIdentity::generate();
    let pair = generate_claim_key_pair();
    let sealed = seal_pairing(&identity.pairing(), &pair.public_key).unwrap();
    assert_eq!(open_sealed_pairing(&sealed, &pair), Some(identity.pairing()));
    assert_eq!(open_sealed_pairing(&sealed, &generate_claim_key_pair()), None);
    assert!(seal_pairing(&identity.pairing(), "short").is_err());
}

#[test]
fn web_push_keys_open_for_their_own_endpoint_only() {
    let identity = ServerIdentity::generate();
    let keys = WebPushKeys { p256dh: "B".repeat(87), auth: "a".repeat(22) };
    let sealed = seal_web_push_keys(&identity.pairing(), "https://push.example/1", &keys).unwrap();
    assert_eq!(open_web_push_keys(&identity, "https://push.example/1", &sealed), Some(keys));
    assert!(open_web_push_keys(&identity, "https://other.invalid/", &sealed).is_none());
    assert!(open_web_push_keys(&ServerIdentity::generate(), "https://push.example/1", &sealed).is_none());
}
