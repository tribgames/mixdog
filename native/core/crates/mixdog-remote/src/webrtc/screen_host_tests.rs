//! A paired phone's whole-PC screen through the live-view host: the host takes a screen source, its viewer runs the transport
//! machine to promotion, the screen's channel messages reach the source, and a promoted channel is told the source's state.

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use base64::Engine;
use futures::future::BoxFuture;
use serde_json::Value;
use serde_json::json;

use super::config::Candidate;
use super::config::IceServer;
use super::host::HostEnv;
use super::host::LiveHost;
use super::host::Picture;
use super::host::SenderEvent;
use super::host::VideoSource;
use super::signal::ClientSignal;
use super::signal::ConnectionRef;
use super::signal::DesktopSignal;
use super::signal::Fingerprint;
use super::signal::Geometry;
use super::signal::HelperCredential;
use super::signal::Resize;
use super::signal::ScreenMessage;
use super::signal::Source;
use super::signal::VideoLimit;

type Log = Arc<Mutex<Vec<String>>>;

const CLIENT: &str = "client-1";
const CONNECTION: &str = "connection-id-0001";

fn geometry() -> Geometry {
    Geometry { generation: 1, css_width: 1920, css_height: 1080, device_scale_factor: 1.0, pixel_width: 1920, pixel_height: 1080 }
}

fn fingerprint() -> Fingerprint {
    Fingerprint { algorithm: "sha-256".into(), value: (0..32).map(|i| format!("{:02X}", i + 16)).collect::<Vec<_>>().join(":") }
}

fn sdp() -> String {
    format!("v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\na=fingerprint:sha-256 {}\r\n", fingerprint().value)
}

fn controller_key() -> String {
    let mut point = vec![4u8];
    point.extend([7u8; 64]);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(point)
}

fn source() -> Source {
    Source::Screen { screen_id: "0".into() }
}

fn connection() -> ConnectionRef {
    ConnectionRef { source: source(), connection_id: CONNECTION.into(), generation: 1 }
}

struct Screen {
    log: Log,
}

impl Screen {
    fn note(&self, entry: String) {
        self.log.lock().unwrap().push(entry);
    }
}

#[async_trait]
impl VideoSource for Screen {
    fn start(&self) {
        self.note("start".into());
    }

    fn stop(&self) {
        self.note("stop".into());
    }

    fn page(&self) -> (Option<String>, Option<Geometry>) {
        (None, Some(geometry()))
    }

    async fn dispatch(&self, control: &Value) -> Result<(), String> {
        self.note(format!("dispatch {control}"));
        Ok(())
    }

    async fn resize(&self, _request: &Resize) -> Result<(), String> {
        Ok(())
    }

    fn video_limit(&self, _limit: VideoLimit) {}

    async fn release(&self, releases: Vec<Value>) {
        self.note(format!("release {}", releases.len()));
    }

    fn channel_state(&self) -> Vec<Value> {
        vec![json!({ "v": 1, "kind": "screen-status", "status": { "state": "live" } })]
    }

    fn frame_seen(&self, epoch: u64) {
        self.note(format!("frame-seen {epoch}"));
    }

    fn helper_grant(&self, epoch: u64, challenge: String, signature: String) {
        self.note(format!("grant {epoch} {} {}", challenge.len(), signature.len()));
    }

    fn helper_install(&self, controller_key: String) {
        self.note(format!("install {}", controller_key.len()));
    }

    fn helper_credential(&self, controller_key: String, credential: HelperCredential) {
        self.note(format!("credential {} {:?} {}", controller_key.len(), credential.user, credential.password.len()));
    }
}

struct Env {
    log: Log,
}

impl Env {
    fn note(&self, entry: String) {
        self.log.lock().unwrap().push(entry);
    }
}

impl HostEnv for Env {
    fn spawn(&self, work: BoxFuture<'static, ()>) {
        tokio::spawn(work);
    }

    fn send_signal(&self, _client: &str, signal: &DesktopSignal) -> BoxFuture<'static, Result<(), String>> {
        self.note(format!("signal {}", signal.type_name()));
        Box::pin(async { Ok(()) })
    }

    fn source(&self, source: &Source, _client: &str, _signal: &str) -> Option<Arc<dyn VideoSource>> {
        matches!(source, Source::Screen { screen_id } if screen_id == "0").then(|| Arc::new(Screen { log: self.log.clone() }) as Arc<dyn VideoSource>)
    }

    fn open(&self, connection_id: &str, source_key: &str, _ice_servers: &[IceServer], _receive_codecs: &[String]) {
        self.note(format!("open {connection_id} {source_key}"));
    }

    fn answer(&self, connection_id: &str, _sdp: &str) {
        self.note(format!("answer {connection_id}"));
    }

    fn candidate(&self, _connection_id: &str, _candidate: &Option<Candidate>) {}

    fn channel_send(&self, _connection_id: &str, text: &str) {
        self.note(format!("channel-send {text}"));
    }

    fn close(&self, connection_id: &str) {
        self.note(format!("close {connection_id}"));
    }

    fn push_picture(&self, _source_key: &str, _frame_id: u64, _picture: &Picture) {}

    fn source_closed(&self, source_key: &str) {
        self.note(format!("source-closed {source_key}"));
    }

    fn report(&self, _event: &str, _data: Value) {}

    fn new_connection_id(&self) -> String {
        CONNECTION.to_owned()
    }

    fn now(&self) -> f64 {
        0.0
    }

    fn set_timer(&self, _ms: u64, _run: Arc<dyn Fn(u64) + Send + Sync>) -> u64 {
        1
    }

    fn clear_timer(&self, _handle: u64) {}
}

fn host() -> (LiveHost, Log) {
    let log = Log::default();
    (LiveHost::new(Arc::new(Env { log: log.clone() })), log)
}

fn entries(log: &Log) -> Vec<String> {
    log.lock().unwrap().clone()
}

fn saw(log: &Log, needle: &str) -> bool {
    entries(log).iter().any(|entry| entry.contains(needle))
}

async fn settle() {
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
}

/// Brings a screen viewer from the phone's `ready` to the promoted channel.
async fn promoted(host: &LiveHost, log: &Log) {
    let ready = ClientSignal::Ready { source: source(), receive_codecs: vec!["video/VP8".into()], video_limit: None };
    host.signal(CLIENT, &ready, &[]).await.unwrap();
    assert!(saw(log, "signal geometry") && saw(log, "start") && saw(log, &format!("open {CONNECTION} screen:0")));
    host.sender_event(SenderEvent::Offer { connection_id: CONNECTION.into(), sdp: sdp() });
    assert!(saw(log, "signal offer"));
    host.signal(CLIENT, &ClientSignal::Answer { connection: connection(), sdp: sdp(), fingerprints: vec![fingerprint()] }, &[]).await.unwrap();
    assert!(saw(log, &format!("answer {CONNECTION}")));
    let certificate = json!({ "fingerprintAlgorithm": "sha-256", "fingerprint": fingerprint().value });
    host.sender_event(SenderEvent::Connected { connection_id: CONNECTION.into(), certificate: Some(certificate) });
    // The capture track delivers frames of the current geometry by itself.
    host.sender_event(SenderEvent::CaptureOk { source_key: "screen:0".into() });
    host.signal(CLIENT, &ClientSignal::GeometryAck { source: source(), geometry_generation: 1 }, &[]).await.unwrap();
    // A screen has no documents: its media-ready carries none, and promotes.
    let media = ClientSignal::MediaReady { connection: connection(), document_id: None, geometry_generation: 1, pixel_width: 1920, pixel_height: 1080 };
    host.signal(CLIENT, &media, &[]).await.unwrap();
    assert!(saw(log, "signal promote"), "{:?}", entries(log));
    host.signal(CLIENT, &ClientSignal::PromoteAck { connection: connection(), input_epoch: 2 }, &[]).await.unwrap();
}

fn channel(host: &LiveHost, text: &Value) {
    host.sender_event(SenderEvent::Channel { connection_id: CONNECTION.into(), text: text.to_string(), received_at: 1.0 });
}

#[tokio::test]
async fn a_screen_source_is_taken_and_a_promoted_channel_is_told_its_state() {
    let (host, log) = host();
    promoted(&host, &log).await;
    let told: Vec<String> = entries(&log).into_iter().filter(|entry| entry.starts_with("channel-send ")).collect();
    assert_eq!(told.len(), 1, "{told:?}");
    assert!(told[0].contains("screen-status") && told[0].contains("\"state\":\"live\""), "{told:?}");
}

#[tokio::test]
async fn a_source_the_environment_does_not_stream_is_refused() {
    let (host, _log) = host();
    let ready = ClientSignal::Ready { source: Source::Screen { screen_id: "7".into() }, receive_codecs: vec![], video_limit: None };
    assert_eq!(host.signal(CLIENT, &ready, &[]).await, Err("remote webrtc source is not streamed.".to_owned()));
}

#[tokio::test]
async fn the_screens_channel_messages_reach_the_source() {
    let (host, log) = host();
    promoted(&host, &log).await;
    channel(&host, &json!({ "v": 1, "kind": "screen-frame-seen", "epoch": 7 }));
    channel(&host, &json!({ "v": 1, "kind": "screen-helper-grant", "epoch": 7, "challenge": format!("{}==", "A".repeat(22)), "signature": format!("{}==", "A".repeat(86)) }));
    channel(&host, &json!({ "v": 1, "kind": "screen-helper-install", "publicKey": controller_key() }));
    channel(&host, &json!({ "v": 1, "kind": "screen-helper-enroll", "publicKey": controller_key() }));
    channel(&host, &json!({ "v": 1, "kind": "screen-helper-install", "publicKey": controller_key(), "credential": { "user": "admin", "password": "secret" } }));
    channel(&host, &json!({ "v": 1, "kind": "screen-helper-enroll", "publicKey": controller_key(), "credential": { "password": "secret" } }));
    let seen = entries(&log);
    assert!(seen.contains(&"frame-seen 7".to_owned()));
    assert!(seen.contains(&"grant 7 24 88".to_owned()));
    assert_eq!(seen.iter().filter(|entry| entry.as_str() == "install 87").count(), 2);
    assert!(seen.contains(&"credential 87 Some(\"admin\") 6".to_owned()));
    assert!(seen.contains(&"credential 87 None 6".to_owned()));
    // Nothing of a password is in what the host logs of a message.
    assert!(!seen.iter().any(|entry| entry.contains("secret")));
}

#[tokio::test]
async fn screen_input_is_dispatched_in_order_and_acknowledged() {
    let (host, log) = host();
    promoted(&host, &log).await;
    for seq in 1..=2 {
        channel(
            &host,
            &json!({
                "v": 1, "kind": "screen-input", "epoch": 2, "seq": seq, "geometryGeneration": 1, "sentAt": 5,
                "control": { "type": "screen-pointer", "action": "move", "x": seq * 10, "y": 20 },
            }),
        );
    }
    // A repeat is dropped; another epoch is refused, unapplied.
    channel(&host, &json!({ "v": 1, "kind": "screen-input", "epoch": 2, "seq": 2, "geometryGeneration": 1, "sentAt": 5, "control": { "type": "screen-release" } }));
    channel(&host, &json!({ "v": 1, "kind": "screen-input", "epoch": 1, "seq": 9, "geometryGeneration": 1, "sentAt": 5, "control": { "type": "screen-release" } }));
    settle().await;
    let seen = entries(&log);
    let dispatched: Vec<&String> = seen.iter().filter(|entry| entry.starts_with("dispatch ")).collect();
    assert_eq!(dispatched.len(), 2, "{seen:?}");
    assert!(dispatched[0].contains("\"x\":10") && dispatched[1].contains("\"x\":20"));
    let acks: Vec<&String> = seen.iter().filter(|entry| entry.contains("input-ack")).collect();
    assert_eq!(acks.len(), 3, "{seen:?}");
    // The other epoch is refused as it arrives; the two inputs are acknowledged once applied.
    assert!(acks[0].contains("\"outcome\":\"rejected\"") && acks[0].contains("\"seq\":9"));
    assert!(acks[1..].iter().all(|ack| ack.contains("\"outcome\":\"applied\"")));
}

#[tokio::test]
async fn a_pointer_input_of_another_geometry_generation_is_refused() {
    let (host, log) = host();
    promoted(&host, &log).await;
    channel(
        &host,
        &json!({
            "v": 1, "kind": "screen-input", "epoch": 2, "seq": 1, "geometryGeneration": 5, "sentAt": 5,
            "control": { "type": "screen-wheel", "x": 1, "y": 2, "deltaY": -120 },
        }),
    );
    settle().await;
    let seen = entries(&log);
    assert!(!seen.iter().any(|entry| entry.starts_with("dispatch ")), "{seen:?}");
    assert!(seen.iter().any(|entry| entry.contains("\"outcome\":\"rejected\"")));
}

#[tokio::test]
async fn a_page_input_on_a_screen_channel_ends_the_connection_and_releases_what_the_screen_holds() {
    let (host, log) = host();
    promoted(&host, &log).await;
    channel(
        &host,
        &json!({
            "v": 1, "kind": "input", "epoch": 2, "seq": 1, "geometryGeneration": 1, "sentAt": 5,
            "control": { "type": "key", "key": "a", "documentId": "p1:1" },
        }),
    );
    settle().await;
    let seen = entries(&log);
    assert!(seen.contains(&"signal demote".to_owned()), "{seen:?}");
    assert!(seen.contains(&"release 0".to_owned()), "{seen:?}");
}

#[tokio::test]
async fn the_screen_ending_stops_its_viewer() {
    let (host, log) = host();
    promoted(&host, &log).await;
    host.geometry_changed("screen:0", None);
    settle().await;
    assert!(saw(&log, "signal close") && saw(&log, "source-closed screen:0"), "{:?}", entries(&log));
}

fn parsed(value: Value) -> Result<ScreenMessage, String> {
    ScreenMessage::parse(&value.to_string())
}

fn input(control: Value) -> Value {
    json!({ "v": 1, "kind": "screen-input", "epoch": 1, "seq": 1, "geometryGeneration": 1, "sentAt": 0, "control": control })
}

fn control(message: ScreenMessage) -> Value {
    match message {
        ScreenMessage::Input { control, .. } => control,
        other => panic!("not an input: {other:?}"),
    }
}

#[test]
fn screen_inputs_are_read_and_normalized() {
    let cases = [
        (json!({ "type": "screen-pointer", "action": "move", "x": 10.5, "y": 20 }), json!({ "type": "screen-pointer", "action": "move", "x": 10.5, "y": 20 })),
        (
            json!({ "type": "screen-pointer", "action": "down", "button": "right", "x": 1, "y": 2, "ignored": true }),
            json!({ "type": "screen-pointer", "action": "down", "button": "right", "x": 1, "y": 2 }),
        ),
        (json!({ "type": "screen-wheel", "x": 1, "y": 2 }), json!({ "type": "screen-wheel", "x": 1, "y": 2, "deltaX": 0, "deltaY": 0 })),
        (json!({ "type": "screen-wheel", "x": 1, "y": 2, "deltaX": null, "deltaY": -4800 }), json!({ "type": "screen-wheel", "x": 1, "y": 2, "deltaX": 0, "deltaY": -4800 })),
        (json!({ "type": "screen-key", "action": "up", "vk": 65 }), json!({ "type": "screen-key", "action": "up", "vk": 65, "scan": 0, "extended": false })),
        (json!({ "type": "screen-key", "action": "down", "scan": 28, "extended": true }), json!({ "type": "screen-key", "action": "down", "vk": 0, "scan": 28, "extended": true })),
        (
            json!({ "type": "screen-keys", "keys": [{ "vk": 17 }, { "vk": 67 }] }),
            json!({ "type": "screen-keys", "keys": [{ "vk": 17, "scan": 0, "extended": false }, { "vk": 67, "scan": 0, "extended": false }] }),
        ),
        (json!({ "type": "screen-text", "text": "hi" }), json!({ "type": "screen-text", "text": "hi" })),
        (json!({ "type": "screen-release" }), json!({ "type": "screen-release" })),
    ];
    for (given, expected) in cases {
        assert_eq!(control(parsed(input(given.clone())).unwrap()), expected, "{given}");
    }
}

#[test]
fn a_malformed_screen_input_is_refused() {
    let refused = [
        json!({ "type": "screen-pointer", "action": "move", "x": -1, "y": 2 }),
        json!({ "type": "screen-pointer", "action": "move", "x": 5000, "y": 2 }),
        json!({ "type": "screen-pointer", "action": "down", "button": "back", "x": 1, "y": 2 }),
        json!({ "type": "screen-pointer", "action": "drag", "x": 1, "y": 2 }),
        json!({ "type": "screen-wheel", "x": 1, "y": 2, "deltaX": 1.5 }),
        json!({ "type": "screen-wheel", "x": 1, "y": 2, "deltaY": 4801 }),
        json!({ "type": "screen-key", "action": "press", "vk": 65 }),
        json!({ "type": "screen-key", "action": "down" }),
        json!({ "type": "screen-key", "action": "down", "vk": 255 }),
        json!({ "type": "screen-key", "action": "down", "vk": 65, "extended": null }),
        json!({ "type": "screen-keys", "keys": [] }),
        json!({ "type": "screen-keys", "keys": [{ "vk": 17 }, { "vk": 17 }] }),
        json!({ "type": "screen-keys", "keys": (0..9).map(|n| json!({ "vk": n + 1 })).collect::<Vec<_>>() }),
        json!({ "type": "screen-text", "text": "" }),
        json!({ "type": "screen-text", "text": "x".repeat(257) }),
        json!({ "type": "pointer" }),
        json!("not a record"),
    ];
    for control in refused {
        assert!(parsed(input(control.clone())).is_err(), "{control}");
    }
    assert!(parsed(input(json!({ "type": "screen-text", "text": "x".repeat(256) }))).is_ok());
}

#[test]
fn the_helper_messages_are_read_as_node_read_them() {
    let nonce = format!("{}==", "A".repeat(22));
    let signature = format!("{}==", "g".repeat(86));
    assert_eq!(
        parsed(json!({ "v": 1, "kind": "screen-helper-grant", "epoch": 3, "challenge": nonce, "signature": signature })),
        Ok(ScreenMessage::HelperGrant { epoch: 3, challenge: nonce.clone(), signature: signature.clone() })
    );
    for (epoch, challenge, signed) in [(0, &nonce, &signature), (3, &"A".repeat(24), &signature), (3, &format!("{}=B", "A".repeat(22)), &signature), (3, &nonce, &nonce)] {
        assert!(parsed(json!({ "v": 1, "kind": "screen-helper-grant", "epoch": epoch, "challenge": challenge, "signature": signed })).is_err());
    }
    assert_eq!(parsed(json!({ "v": 1, "kind": "screen-frame-seen", "epoch": 4 })), Ok(ScreenMessage::FrameSeen { epoch: 4 }));
    assert!(parsed(json!({ "v": 1, "kind": "screen-frame-seen", "epoch": 0 })).is_err());
    assert!(parsed(json!({ "v": 2, "kind": "screen-frame-seen", "epoch": 4 })).is_err());
    assert!(ScreenMessage::parse("not json").is_err());
}

#[test]
fn an_install_carries_a_key_extra_keys_and_a_bounded_credential() {
    let key = controller_key();
    let install = |extra: Value| {
        let mut message = json!({ "v": 1, "kind": "screen-helper-install", "publicKey": key });
        message.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        parsed(message)
    };
    assert_eq!(install(json!({})), Ok(ScreenMessage::HelperInstall { public_key: key.clone(), credential: None }));
    assert_eq!(install(json!({ "keys": [key.clone(), key.clone()], "credential": null })), Ok(ScreenMessage::HelperInstall { public_key: key.clone(), credential: None }));
    assert_eq!(
        install(json!({ "credential": { "user": "", "password": "p" } })),
        Ok(ScreenMessage::HelperInstall { public_key: key.clone(), credential: Some(HelperCredential { user: None, password: "p".into() }) })
    );
    assert!(install(json!({ "keys": ["short"] })).is_err());
    assert!(install(json!({ "keys": "no" })).is_err());
    assert!(install(json!({ "keys": vec![key.clone(); 257] })).is_err());
    assert!(install(json!({ "credential": { "password": "" } })).is_err());
    assert!(install(json!({ "credential": { "password": "p".repeat(257) } })).is_err());
    assert!(install(json!({ "credential": { "password": "p", "user": "u".repeat(514) } })).is_err());
    assert!(install(json!({ "credential": { "password": "p", "user": 3 } })).is_err());
    assert!(install(json!({ "credential": "hunter2" })).is_err());
    assert!(parsed(json!({ "v": 1, "kind": "screen-helper-install", "publicKey": "nope" })).is_err());
    // A credential is never printed.
    let shown = format!("{:?}", HelperCredential { user: Some("admin".into()), password: "hunter2".into() });
    assert!(shown.contains("admin") && !shown.contains("hunter2"));
}

#[test]
fn a_page_input_and_a_revoke_are_not_a_screens_to_read() {
    assert!(parsed(json!({ "v": 1, "kind": "input", "epoch": 1, "seq": 1, "geometryGeneration": 1, "sentAt": 0, "control": { "type": "key", "key": "a" } })).is_err());
    assert!(parsed(json!({ "v": 1, "kind": "screen-helper-revoke", "publicKey": controller_key() })).is_err());
}
