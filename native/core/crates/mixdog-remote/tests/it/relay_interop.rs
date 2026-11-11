//! DS-REM-2: the Rust leg, clients, claims, caps, control requests and pair code against the
//! unmodified `apps/relay/server.mjs`, run locally on an ephemeral port with a scratch data dir.
//! No real relay or account credentials are involved; a Rust phone peer completes the E2EE
//! handshake and exchanges an application frame through the relay.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
#[allow(clippy::disallowed_types, reason = "test runs the unmodified Node relay as the reference peer")]
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use mixdog_remote::clients::{ClaimBindings, ClaimStep, ClientTable, ReadyContext, Received, challenge_flags};
use mixdog_remote::e2ee::{Challenge, ClientHandshakeOptions, Sealed, ServerIdentity, Wire, create_client_handshake};
use mixdog_remote::identity::DeviceIdentity;
use mixdog_remote::leg::frame::{Payload, json_frame};
use mixdog_remote::leg::{ControlRequests, Inbound, LegConfig, LegEvent, Outgoing, RelayCaps, open_envelopes, run_leg};
use serde_json::{Map, Value, json};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_util::sync::CancellationToken;

struct Relay {
    child: Child,
    port: u16,
    _data: tempfile::TempDir,
}

impl Relay {
    #[allow(
        clippy::disallowed_methods,
        clippy::disallowed_types,
        reason = "test runs the unmodified Node relay as the reference peer"
    )]
    fn spawn() -> Self {
        let server = std::env::var("MIXDOG_RELAY_SERVER").map(PathBuf::from).unwrap_or_else(|_| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../apps/relay/server.mjs")
        });
        let data = tempfile::tempdir().unwrap();
        let mut child = Command::new("node")
            .arg(server)
            .env("PORT", "0")
            .env("DATA_DIR", data.path())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap());
        let mut port = 0;
        let mut line = String::new();
        while lines.read_line(&mut line).unwrap() > 0 {
            if let Some(rest) = line.split("listening on :").nth(1) {
                port = rest.split_whitespace().next().unwrap().parse().unwrap();
                break;
            }
            line.clear();
        }
        assert_ne!(port, 0, "relay did not report its port");
        // Keep draining so the relay never blocks on a full pipe.
        std::thread::spawn(move || while lines.read_line(&mut String::new()).unwrap_or(0) > 0 {});
        Self { child, port, _data: data }
    }
}

impl Drop for Relay {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

async fn next<T>(rx: &mut mpsc::Receiver<T>) -> T {
    rx.recv().await.expect("closed")
}

fn text(value: Value) -> Outgoing {
    Outgoing::Text(value.to_string())
}

#[tokio::test(flavor = "multi_thread")]
async fn leg_pairs_and_serves_a_phone_through_the_real_relay() {
    let relay = Relay::spawn();
    let identity = DeviceIdentity { device_id: uuid::Uuid::new_v4().to_string(), device_secret: "ab".repeat(24) };
    let (events_tx, mut events) = mpsc::channel(64);
    let (out_tx, out_rx) = mpsc::channel(64);
    let cancel = CancellationToken::new();
    let config_device_id = identity.device_id.clone();
    let config = LegConfig::desktop(format!("ws://127.0.0.1:{}", relay.port), identity, 80 << 20);
    let leg = tokio::spawn(run_leg(config, events_tx, out_rx, cancel.clone()));

    // The leg opens, announces itself, and registers the phone token before any client binds.
    assert!(matches!(next(&mut events).await, LegEvent::Open));
    let token = "cd".repeat(24);
    for frame in open_envelopes("FIXTURE-PC", Some(("0.0.0-test", None)), &token) {
        out_tx.send(text(frame)).await.unwrap();
    }
    let mut caps = RelayCaps::default();
    loop {
        if let LegEvent::Inbound(Inbound::Capabilities(envelope)) = next(&mut events).await {
            caps.handle(&envelope);
            break;
        }
    }
    assert!(caps.frame_limit() > 0);

    // Control requests are answered with the request id echoed; pump the leg from here on.
    let controls = Arc::new(ControlRequests::default());
    let (inbound_tx, mut inbound) = mpsc::channel(64);
    {
        let controls = controls.clone();
        tokio::spawn(async move {
            while let Some(event) = events.recv().await {
                match event {
                    LegEvent::Inbound(Inbound::ControlAnswer(answer)) => controls.settle(&answer),
                    LegEvent::Inbound(other) => {
                        let _ = inbound_tx.send(other).await;
                    }
                    _ => {}
                }
            }
        });
    }
    let send = |tx: mpsc::Sender<Outgoing>| move |envelope: Value| tx.try_send(text(envelope)).is_ok();
    let clients = controls.request("list-clients", Map::new(), send(out_tx.clone())).await.unwrap();
    assert_eq!(clients, json!([]));
    // An unknown credential is refused with `ok:false`, which rejects the request as the Node leg does.
    let revoked = controls
        .request("revoke-client", mixdog_remote::clients::revoke_payload("nobody"), send(out_tx.clone()))
        .await;
    assert!(matches!(revoked, Err(mixdog_remote::leg::ControlError::Failed(_))));
    // A relay without TURN configured ignores the request; the caller's timeout degrades to no servers.
    let ice = controls.request("ice-servers-request", Map::new(), send(out_tx.clone())).await;
    assert_eq!(ice, Err(mixdog_remote::leg::ControlError::TimedOut));

    // Pairing v2: a published 6-digit code comes back for the lease that asked.
    out_tx.send(text(json!({"type":"pair-code-request","lease":"lease0001","name":"FIXTURE-PC"}))).await.unwrap();
    loop {
        if let Inbound::PairCode(issued) = next(&mut inbound).await {
            assert_eq!(issued["type"], "pair-code-issued");
            assert_eq!(issued["lease"], "lease0001");
            assert!(issued["code"].as_str().is_some_and(|c| c.len() == 6 && c.bytes().all(|b| b.is_ascii_digit())));
            break;
        }
    }

    // Pairing by claim: the phone claims with a throwaway key, this PC approves sealed to that
    // key only, and the phone opens the box with the pairing material and the phone credential.
    let server = ServerIdentity::generate();
    let pair = mixdog_remote::e2ee::generate_claim_key_pair();
    let phone_id = uuid::Uuid::new_v4().to_string();
    let device_id = config_device_id.clone();
    let origin = format!("http://127.0.0.1:{}", relay.port);
    let body = json!({"deviceId": device_id, "clientId": phone_id, "publicKey": pair.public_key, "name": "Test phone"});
    let (status, answer) = http(relay.port, "POST", "/claim", Some(&origin), Some(&body.to_string())).await;
    assert_eq!(status, 202, "{answer}");
    let claim_id = serde_json::from_str::<Value>(&answer).unwrap()["claimId"].as_str().unwrap().to_owned();
    let mut bindings = ClaimBindings::default();
    let request = loop {
        let Inbound::ClientClaim(envelope) = next(&mut inbound).await else { continue };
        let ClaimStep::Ask(request) = bindings.deliver(&envelope, now_ms()) else { panic!("claim not asked") };
        break request;
    };
    assert_eq!(request.claim_id, claim_id);
    assert_eq!(request.name, "Test phone");
    out_tx.send(text(bindings.answer(&claim_id, true, &server.pairing()))).await.unwrap();
    let approved = loop {
        let (status, answer) = http(relay.port, "GET", &format!("/claim/{claim_id}"), None, None).await;
        assert_eq!(status, 200);
        let value: Value = serde_json::from_str(&answer).unwrap();
        if value["status"] == "approved" {
            break value;
        }
        mixdog_rt::time::sleep(Duration::from_millis(50)).await;
    };
    let sealed_box: mixdog_remote::e2ee::SealedBox = serde_json::from_value(approved["sealed"].clone()).unwrap();
    let material = mixdog_remote::e2ee::open_sealed_pairing(&sealed_box, &pair).expect("sealed to this phone only");
    assert_eq!(material.pairing_secret, server.pairing().pairing_secret);
    assert!(mixdog_remote::e2ee::open_sealed_pairing(&sealed_box, &mixdog_remote::e2ee::generate_claim_key_pair()).is_none());
    let phone_token = approved["token"].as_str().unwrap().to_owned();

    // The phone attaches with its own credential; the relay announces it to the leg.
    // A browser sends its own origin; the relay admits only a same-origin upgrade.
    let mut request = format!("ws://127.0.0.1:{}/ws?token={phone_token}", relay.port).into_client_request().unwrap();
    request.headers_mut().insert("Origin", origin.parse().unwrap());
    let (mut phone, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    let client_id = loop {
        if let Inbound::ClientOpen { client_id, credential_id } = next(&mut inbound).await {
            assert_eq!(credential_id, phone_id, "the relay names the credential it authenticated");
            break client_id;
        }
    };
    let mut table = ClientTable::default();
    let challenge = table.open(&client_id, &phone_id, &challenge_flags(caps.binary_frames(), false, false)).unwrap();
    out_tx.send(text(json_frame(&client_id, &challenge))).await.unwrap();

    // The phone reads the challenge and answers with its hello.
    let Some(Ok(Message::Text(received))) = phone.next().await else { panic!("expected the challenge") };
    let parsed = Challenge::parse(serde_json::from_str(received.as_str()).unwrap()).unwrap();
    let (hello, mut phone_channel) =
        create_client_handshake(&material, &parsed, ClientHandshakeOptions::default()).unwrap();
    phone.send(Message::Text(hello.to_string().into())).await.unwrap();

    let routing = Map::new();
    let ready = ReadyContext { host_name: "FIXTURE-PC", routing: &routing };
    let sealed = loop {
        let Inbound::Frame { payload, .. } = next(&mut inbound).await else { continue };
        match table.receive(&server, &client_id, &payload, &ready) {
            Received::Ready(frames) => break frames,
            other => panic!("handshake did not complete: {other:?}"),
        }
    };
    for frame in sealed {
        out_tx.send(text(frame_envelope(&client_id, &frame))).await.unwrap();
    }
    let opened = match phone.next().await {
        Some(Ok(Message::Text(t))) => phone_channel.open(Wire::Text(t.as_str())).unwrap(),
        Some(Ok(Message::Binary(b))) => phone_channel.open(Wire::Binary(&b)).unwrap(),
        other => panic!("expected e2ee-ready, got {other:?}"),
    };
    let ready_message: Value = serde_json::from_slice(&opened).unwrap();
    assert_eq!(ready_message["type"], "e2ee-ready");
    assert_eq!(ready_message["hostName"], "FIXTURE-PC");

    // An application frame crosses the relay opaque and arrives decrypted, byte for byte.
    let Sealed::Text(box_text) = phone_channel.seal(b"{\"jsonrpc\":\"2.0\",\"id\":1}", false).unwrap() else {
        panic!("text carrier expected")
    };
    phone.send(Message::Text(box_text.into())).await.unwrap();
    loop {
        let Inbound::Frame { payload, .. } = next(&mut inbound).await else { continue };
        let Received::Plain { bytes, binary } = table.receive(&server, &client_id, &payload, &ready) else {
            panic!("expected a decrypted frame")
        };
        assert_eq!(bytes, b"{\"jsonrpc\":\"2.0\",\"id\":1}");
        assert!(!binary);
        break;
    }

    // client-close from the relay side when the phone leaves.
    drop(phone);
    loop {
        if let Inbound::ClientClose(id) = next(&mut inbound).await {
            assert_eq!(id, client_id);
            break;
        }
    }
    cancel.cancel();
    leg.await.unwrap();
}

fn frame_envelope(client_id: &str, sealed: &Sealed) -> Value {
    match sealed {
        Sealed::Text(t) => json_frame(client_id, t),
        Sealed::Binary(b) => {
            use base64::Engine;
            json!({"type":"frame","clientId":client_id,"data":base64::engine::general_purpose::STANDARD.encode(b)})
        }
    }
}

#[test]
fn payload_enum_is_text_or_binary() {
    assert_eq!(Payload::Text("a".into()).len(), 1);
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64
}

/// One HTTP/1.0 request (so the reply is never chunked); returns the status and body.
async fn http(port: u16, method: &str, path: &str, origin: Option<&str>, body: Option<&str>) -> (u16, String) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let body = body.unwrap_or_default();
    let origin = origin.map(|o| format!("Origin: {o}\r\n")).unwrap_or_default();
    let request = format!(
        "{method} {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n{origin}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.unwrap();
    let text = String::from_utf8_lossy(&raw).into_owned();
    let status = text.split_whitespace().nth(1).unwrap().parse().unwrap();
    let body = text.split("\r\n\r\n").nth(1).unwrap_or_default().to_owned();
    (status, body)
}