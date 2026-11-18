//! The live view's service end, each state machine driven by scripted peers and expected in literals: the relay (which phone
//! signals are accepted, who owns page input, which `ready` is current), the viewer (negotiation, promotion, demotion, input
//! epochs and the dispatch lane) and the host (viewers per client and source, one picture in flight, routing of peer events).

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use bytes::Bytes;
use futures::future::BoxFuture;
use mixdog_remote::webrtc::config::{Candidate, IceServer};
use mixdog_remote::webrtc::host::{HostEnv, LiveHost, Picture, SenderEvent, VideoSource};
use mixdog_remote::webrtc::relay::{Origin, Relay, RelayDeps};
use mixdog_remote::webrtc::signal::{ClientSignal, CloseReason, DesktopSignal, Geometry, Resize, Source, TransportState, VideoLimit};
use mixdog_remote::webrtc::viewer::{Page, Viewer, ViewerEffects};
use serde_json::{Value, json};
use tokio::sync::oneshot;

const CONN: &str = "connection-00001";
const SESSION: &str = "session-1";

fn fingerprint() -> String {
    vec!["AB"; 32].join(":")
}

fn sdp() -> String {
    format!("v=0\r\na=fingerprint:sha-256 {}\r\n", fingerprint())
}

fn browser() -> Value {
    json!({ "kind": "browser", "sessionId": SESSION })
}

fn screen() -> Value {
    json!({ "kind": "screen", "screenId": "display-0" })
}

fn geometry() -> Geometry {
    Geometry { generation: 1, css_width: 800, css_height: 600, device_scale_factor: 1.0, pixel_width: 800, pixel_height: 600 }
}

fn reference(source: &Value, connection: &str, generation: u64) -> Value {
    json!({ "v": 1, "source": source, "connectionId": connection, "generation": generation })
}

fn with(mut base: Value, fields: Value) -> Value {
    for (name, value) in fields.as_object().expect("an object").clone() {
        base[name] = value;
    }
    base
}

fn ready(source: &Value) -> ClientSignal {
    ClientSignal::parse(&json!({ "type": "ready", "v": 1, "source": source, "receiveCodecs": ["video/VP8"] })).expect("ready")
}

fn client(fields: Value, source: &Value, connection: &str) -> ClientSignal {
    ClientSignal::parse(&with(reference(source, connection, 1), fields)).expect("a client signal")
}

fn answer(connection: &str) -> ClientSignal {
    client(json!({ "type": "answer", "sdp": sdp(), "fingerprints": [{ "algorithm": "sha-256", "value": fingerprint() }] }), &browser(), connection)
}

fn media_ready(connection: &str) -> ClientSignal {
    client(
        json!({ "type": "media-ready", "documentId": "p1:2", "geometryGeneration": 1, "pixelWidth": 800, "pixelHeight": 600 }),
        &browser(),
        connection,
    )
}

fn desktop(fields: Value) -> Value {
    with(reference(&browser(), CONN, 1), fields)
}

fn offer_json() -> Value {
    desktop(json!({
        "type": "offer", "sdp": sdp(), "fingerprints": [{ "algorithm": "sha-256", "value": fingerprint() }], "iceServers": [],
        "iceTransportPolicy": "all", "geometry": geometry().to_json(), "inputEpoch": 2,
    }))
}

// ---- the relay ----

#[derive(Default)]
struct RelayLog {
    calls: Vec<String>,
    sent: Vec<Value>,
}

#[derive(Default)]
struct Deps {
    log: Mutex<RelayLog>,
    awaiting_fit: Mutex<bool>,
    screen_allowed: Mutex<bool>,
    screen_gates: Mutex<VecDeque<oneshot::Receiver<bool>>>,
    ice_gates: Mutex<VecDeque<oneshot::Receiver<Vec<IceServer>>>>,
}

impl Deps {
    fn note(&self, line: String) {
        self.log.lock().unwrap().calls.push(line);
    }

    fn calls(&self) -> Vec<String> {
        self.log.lock().unwrap().calls.clone()
    }
}

fn stun() -> IceServer {
    IceServer { urls: vec!["stun:stun.example.org:3478".to_owned()], username: None, credential: None }
}

#[derive(Clone)]
struct D(Arc<Deps>);

#[async_trait]
impl RelayDeps for D {
    fn subscribed(&self, client: &str, session: &str) -> bool {
        client == "c1" && session == SESSION
    }

    fn awaiting_fit(&self, _client: &str, _session: &str) -> bool {
        *self.0.awaiting_fit.lock().unwrap()
    }

    async fn screen_authorized(&self, _client: &str, _origin: Origin) -> bool {
        let gate = self.0.screen_gates.lock().unwrap().pop_front();
        match gate {
            Some(gate) => gate.await.unwrap(),
            None => *self.0.screen_allowed.lock().unwrap(),
        }
    }

    fn set_images(&self, client: &str, session: &str, enabled: bool) {
        self.0.note(format!("images {client} {session} {enabled}"));
    }

    async fn resolve_ice_servers(&self) -> Result<Vec<IceServer>, String> {
        let gate = self.0.ice_gates.lock().unwrap().pop_front();
        match gate {
            Some(gate) => Ok(gate.await.unwrap()),
            None => Ok(vec![stun()]),
        }
    }

    async fn forward(&self, client: &str, signal: &ClientSignal, ice_servers: Option<&[IceServer]>, _origin: Origin) -> Result<(), String> {
        self.0.note(format!("forward {client} {} ice={:?}", signal.type_name(), ice_servers.map(<[IceServer]>::len)));
        Ok(())
    }

    fn viewer_left(&self, client: &str, source_key: &str) {
        self.0.note(format!("left {client} {source_key}"));
    }

    async fn screen_displays(&self) -> Result<Value, String> {
        Ok(json!([{ "id": "display-0" }]))
    }

    async fn send(&self, _client: &str, payload: Value) -> Result<(), String> {
        self.0.log.lock().unwrap().sent.push(payload);
        Ok(())
    }
}

fn relay() -> (Relay<D>, Arc<Deps>) {
    let deps = Arc::new(Deps::default());
    (Relay::new(D(deps.clone())), deps)
}

const NOT_STREAMED: &str = "remote webrtc source is not streamed by this client.";
const SCREEN_REFUSED: &str = "Remote screen is not allowed for this device.";

#[test]
fn a_phone_signal_is_accepted_only_for_a_session_it_streams_and_a_screen_is_judged_when_forwarded() {
    let (relay, _) = relay();
    let ready = ready(&browser()).to_json();
    assert!(relay.accept("c1", &ready).is_ok());
    assert_eq!(relay.accept("c2", &ready).err().as_deref(), Some(NOT_STREAMED));
    assert_eq!(relay.accept("c1", &json!({ "type": "nope" })).err().as_deref(), Some("remote webrtc signal type is invalid."));
    assert!(relay.accept("c2", &self::ready(&screen()).to_json()).is_ok(), "a screen has no subscription to check at decode time");
}

#[tokio::test]
async fn a_ready_is_forwarded_with_fresh_ice_servers_and_refused_for_a_session_the_client_does_not_stream() {
    let (relay, deps) = relay();
    relay.forward("c1", &ready(&browser()), 0).await.expect("forwarded");
    assert_eq!(deps.calls(), ["forward c1 ready ice=Some(1)"]);
    assert_eq!(relay.forward("c2", &ready(&browser()), 0).await.err().as_deref(), Some(NOT_STREAMED));
    assert_eq!(deps.calls().len(), 1, "nothing was forwarded for the refused client");
}

#[tokio::test]
async fn a_newer_ready_makes_an_older_one_still_resolving_its_servers_stale() {
    let (relay, deps) = relay();
    let (first_tx, first_rx) = oneshot::channel();
    let (second_tx, second_rx) = oneshot::channel();
    deps.ice_gates.lock().unwrap().extend([first_rx, second_rx]);
    let signal = ready(&browser());
    let (first, second, ()) = futures::join!(relay.forward("c1", &signal, 0), relay.forward("c1", &signal, 0), async {
        first_tx.send(vec![]).unwrap();
        second_tx.send(vec![stun(), stun()]).unwrap();
    });
    assert_eq!((first, second), (Ok(()), Ok(())));
    assert_eq!(deps.calls(), ["forward c1 ready ice=Some(2)"], "only the newest ready reaches the host");
}

#[tokio::test]
async fn a_media_ready_is_dropped_while_the_take_over_waits_for_its_first_fitted_picture() {
    let (relay, deps) = relay();
    let signal = media_ready(CONN);
    *deps.awaiting_fit.lock().unwrap() = true;
    assert_eq!(relay.forward("c1", &signal, 0).await, Ok(()));
    assert!(deps.calls().is_empty());
    *deps.awaiting_fit.lock().unwrap() = false;
    assert_eq!(relay.forward("c1", &signal, 0).await, Ok(()));
    assert_eq!(deps.calls(), ["forward c1 media-ready ice=None"]);
}

#[tokio::test]
async fn the_screen_is_forwarded_only_for_a_connection_that_may_use_it_and_a_removed_connection_cancels_its_ready() {
    let (relay, deps) = relay();
    let signal = ready(&screen());
    assert_eq!(relay.forward("c1", &signal, 0).await.err().as_deref(), Some(SCREEN_REFUSED));
    assert_eq!(relay.screen_displays("c1", 0).await.err().as_deref(), Some(SCREEN_REFUSED));
    *deps.screen_allowed.lock().unwrap() = true;
    assert_eq!(relay.forward("c1", &signal, 0).await, Ok(()));
    assert_eq!(relay.screen_displays("c1", 0).await, Ok(json!([{ "id": "display-0" }])));
    assert_eq!(deps.calls(), ["forward c1 ready ice=Some(1)"]);

    let (gate, opened) = oneshot::channel();
    deps.screen_gates.lock().unwrap().push_back(opened);
    let (outcome, ()) = futures::join!(relay.forward("c1", &signal, 0), async {
        relay.connection_removed("c1");
        gate.send(true).unwrap();
    });
    assert_eq!(outcome, Ok(()));
    assert_eq!(deps.calls().len(), 1, "the cancelled ready was never forwarded");
}

#[tokio::test]
async fn a_host_signal_reaches_its_phone_wrapped_as_the_live_view_event() {
    let (relay, deps) = relay();
    let close = desktop(json!({ "type": "close", "reason": "ice-failed" }));
    relay.send("c1", &close).await.expect("sent");
    let sent = deps.log.lock().unwrap().sent.clone();
    assert_eq!(sent, vec![json!({ "event": "browserRemoteWebrtc", "payload": DesktopSignal::parse(&close).unwrap().to_json() })]);
    assert!(relay.send("c1", &json!({ "type": "close" })).await.is_err(), "a malformed host signal is refused");
}

#[tokio::test]
async fn page_input_follows_the_epoch_barrier_from_offer_to_promote_ack_to_demote_ack() {
    let (relay, deps) = relay();
    let allowed = |relay: &Relay<D>| relay.relay_input_allowed("c1", SESSION);
    assert!(allowed(&relay));
    relay.send("c1", &offer_json()).await.unwrap();
    relay.send("c1", &desktop(json!({ "type": "promote", "inputEpoch": 2, "geometryGeneration": 1 }))).await.unwrap();
    assert!(allowed(&relay), "the relay still owns input until the phone acknowledges the promotion");

    let ack = |kind: &str, epoch: u64| json!({ "type": kind, "v": 1, "source": browser(), "connectionId": CONN, "generation": 1, "inputEpoch": epoch });
    relay.accept("c1", &ack("promote-ack", 9)).unwrap();
    assert!(allowed(&relay), "an acknowledgement of another epoch changes nothing");
    relay.accept("c1", &ack("promote-ack", 2)).unwrap();
    assert!(!allowed(&relay), "the channel owns input after the matching acknowledgement");
    assert_eq!(deps.calls(), [format!("images c1 {SESSION} false")]);

    relay.send("c1", &desktop(json!({ "type": "demote", "inputEpoch": 3, "reason": "ice-failed" }))).await.unwrap();
    assert!(!allowed(&relay), "no page input between the demotion and its acknowledgement");
    assert_eq!(deps.calls().last().map(String::as_str), Some(format!("images c1 {SESSION} true").as_str()), "the JPEG view returns at once");
    relay.accept("c1", &ack("demote-ack", 2)).unwrap();
    assert!(!allowed(&relay));
    relay.accept("c1", &ack("demote-ack", 3)).unwrap();
    assert!(allowed(&relay), "the matching demote-ack gives input back to the relay");
}

#[tokio::test]
async fn a_viewer_who_leaves_while_the_channel_owns_the_view_gets_the_jpeg_view_back() {
    let (relay, deps) = relay();
    relay.send("c1", &offer_json()).await.unwrap();
    relay.send("c1", &desktop(json!({ "type": "promote", "inputEpoch": 2, "geometryGeneration": 1 }))).await.unwrap();
    let ack = json!({ "type": "promote-ack", "v": 1, "source": browser(), "connectionId": CONN, "generation": 1, "inputEpoch": 2 });
    relay.accept("c1", &ack).unwrap();
    relay.viewer_left("c1", SESSION);
    assert_eq!(deps.calls(), [format!("images c1 {SESSION} false"), format!("images c1 {SESSION} true"), format!("left c1 browser:{SESSION}")]);
    assert!(relay.relay_input_allowed("c1", SESSION));
}

// ---- the viewer ----

#[derive(Default)]
struct Rig {
    log: Mutex<Vec<String>>,
    signals: Mutex<Vec<DesktopSignal>>,
    dispatched: Mutex<Vec<Value>>,
    released: Mutex<Vec<Vec<Value>>>,
    page: Mutex<Page>,
    ids: AtomicU64,
    timers: AtomicU64,
}

impl Rig {
    fn with_page() -> Arc<Self> {
        let rig = Arc::new(Self::default());
        *rig.page.lock().unwrap() = Page { document_id: Some("p1:2".to_owned()), geometry: Some(geometry()), frames_since_current: 1 };
        rig
    }

    fn note(&self, line: impl Into<String>) {
        self.log.lock().unwrap().push(line.into());
    }

    fn log(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }

    fn signals(&self) -> Vec<Value> {
        self.signals.lock().unwrap().iter().map(DesktopSignal::to_json).collect()
    }
}

struct Fx(Arc<Rig>);

#[async_trait]
impl ViewerEffects for Fx {
    fn signal(&self, signal: &DesktopSignal) {
        self.0.signals.lock().unwrap().push(signal.clone());
    }

    fn open(&self, connection_id: &str, ice_servers: &[IceServer], receive_codecs: &[String]) {
        self.0.note(format!("open {connection_id} servers={} codecs={}", ice_servers.len(), receive_codecs.join(",")));
    }

    fn answer(&self, connection_id: &str, _sdp: &str) {
        self.0.note(format!("answer {connection_id}"));
    }

    fn candidate(&self, connection_id: &str, candidate: &Option<Candidate>) {
        self.0.note(format!("candidate {connection_id} {}", candidate.is_some()));
    }

    fn channel_send(&self, _connection_id: &str, text: &str) {
        self.0.note(format!("channel {text}"));
    }

    fn close(&self, connection_id: &str) {
        self.0.note(format!("close {connection_id}"));
    }

    async fn dispatch(&self, control: &Value) -> Result<(), String> {
        self.0.dispatched.lock().unwrap().push(control.clone());
        Ok(())
    }

    async fn release(&self, releases: Vec<Value>) {
        self.0.released.lock().unwrap().push(releases);
    }

    fn page(&self) -> Page {
        self.0.page.lock().unwrap().clone()
    }

    fn new_connection_id(&self) -> String {
        format!("connection-{:05}", self.0.ids.fetch_add(1, Ordering::SeqCst) + 1)
    }

    fn now(&self) -> f64 {
        1000.0
    }

    fn set_timer(&self, ms: u64) -> u64 {
        let handle = self.0.timers.fetch_add(1, Ordering::SeqCst) + 1;
        self.0.note(format!("timer {ms} #{handle}"));
        handle
    }

    fn clear_timer(&self, handle: u64) {
        self.0.note(format!("clear #{handle}"));
    }

    fn report(&self, _event: &str, _data: Value) {}

    fn receiver_stats(&self, _stats: &Value) {}

    fn promoted(&self) {
        self.0.note("promoted");
    }
}

fn viewer() -> (Viewer<Fx>, Arc<Rig>) {
    let rig = Rig::with_page();
    (Viewer::new(Source::Browser { session_id: SESSION.to_owned() }, Fx(rig.clone())).expect("a viewer"), rig)
}

fn codecs() -> Vec<String> {
    vec!["video/VP8".to_owned()]
}

fn certificate() -> Value {
    json!({ "fingerprintAlgorithm": "sha-256", "fingerprint": fingerprint() })
}

/// Drives a viewer to `connected`: offered, answered, certificate matched, geometry acknowledged.
fn connect(viewer: &Viewer<Fx>) {
    viewer.ready(codecs(), vec![]).unwrap();
    viewer.sender_offer(CONN, &sdp()).unwrap();
    viewer.signal(&answer(CONN)).unwrap();
    viewer.sender_connected(CONN, Some(&certificate())).unwrap();
    viewer.geometry_ack(1);
}

fn input(epoch: u64, seq: u64, text: &str) -> String {
    json!({
        "v": 1, "kind": "input", "epoch": epoch, "seq": seq, "geometryGeneration": 1, "sentAt": 900,
        "control": { "type": "text", "documentId": "p1:2", "text": text },
    })
    .to_string()
}

#[tokio::test]
async fn a_viewer_negotiates_promotes_applies_channel_input_and_hands_input_back_on_demotion() {
    let (viewer, rig) = viewer();
    viewer.ready(codecs(), vec![stun()]).unwrap();
    let view = viewer.view();
    assert_eq!((view.state, view.epoch, view.connection_id.as_deref(), view.generation), (TransportState::Negotiating, 1, Some(CONN), 1));
    assert_eq!(rig.log(), ["timer 39500 #1", "open connection-00001 servers=1 codecs=video/VP8"]);

    viewer.sender_offer(CONN, &sdp()).unwrap();
    assert_eq!(rig.signals()[0], with(offer_json(), json!({ "inputEpoch": 1, "iceServers": [{ "urls": ["stun:stun.example.org:3478"] }] })));
    viewer.signal(&answer(CONN)).unwrap();
    viewer.sender_connected(CONN, Some(&certificate())).unwrap();
    assert_eq!(viewer.view().state, TransportState::Connected);

    // The phone is promoted only once it acknowledged the geometry and showed the current page.
    viewer.signal(&media_ready(CONN)).unwrap();
    assert_eq!(viewer.view().state, TransportState::Connected, "an unacknowledged geometry is not a reason to promote");
    viewer.geometry_ack(1);
    viewer.signal(&media_ready(CONN)).unwrap();
    assert_eq!((viewer.view().state, viewer.view().epoch), (TransportState::Promoting, 2));
    assert_eq!(rig.signals()[1], desktop(json!({ "type": "promote", "inputEpoch": 2, "geometryGeneration": 1 })));
    assert!(rig.log().contains(&"promoted".to_owned()));

    // Input of the new epoch is held until the phone acknowledges the promotion, then applied in order.
    viewer.channel(CONN, &input(2, 1, "hi"), 950.0).unwrap();
    assert!(!viewer.wants_pump(), "held while promoting");
    viewer.signal(&client(json!({ "type": "promote-ack", "inputEpoch": 2 }), &browser(), CONN)).unwrap();
    assert_eq!(viewer.view().state, TransportState::Webrtc);
    assert!(viewer.wants_pump());
    viewer.pump().await;
    assert_eq!(*rig.dispatched.lock().unwrap(), [json!({ "type": "text", "documentId": "p1:2", "text": "hi" })]);
    let ack = |seq: u64, outcome: &str, queued: u64| {
        format!("channel {{\"v\":1,\"kind\":\"input-ack\",\"epoch\":2,\"seq\":{seq},\"outcome\":\"{outcome}\",\"sentAt\":900,\"queuedMs\":{queued},\"dispatchMs\":0}}")
    };
    assert!(rig.log().contains(&ack(1, "applied", 50)), "{:?}", rig.log());

    // A repeat of a sequence number is never applied twice; an input of an old epoch is refused at once.
    viewer.channel(CONN, &input(2, 1, "hi"), 960.0).unwrap();
    viewer.channel(CONN, &input(1, 5, "late"), 960.0).unwrap();
    viewer.pump().await;
    assert_eq!(rig.dispatched.lock().unwrap().len(), 1);
    assert!(rig.log().contains(&ack(5, "rejected", 0).replace("\"epoch\":2", "\"epoch\":1")));

    // The channel failing demotes: a new epoch, nothing late is applied, and the phone must acknowledge the demotion.
    viewer.fail(CloseReason::ChannelFailed).unwrap();
    assert_eq!((viewer.view().state, viewer.view().epoch), (TransportState::Demoting, 3));
    assert_eq!(rig.signals()[2], desktop(json!({ "type": "demote", "inputEpoch": 3, "reason": "channel-failed" })));
    assert!(viewer.wants_pump());
    viewer.pump().await;
    assert_eq!(*rig.released.lock().unwrap(), [Vec::<Value>::new()], "what the channel pressed is let go");
    viewer.signal(&client(json!({ "type": "demote-ack", "inputEpoch": 3 }), &browser(), CONN)).unwrap();
    assert_eq!(viewer.view().state, TransportState::Cooldown);
    assert_eq!(rig.signals()[3], desktop(json!({ "type": "close", "reason": "channel-failed", "retryAfterMs": 0 })));
}

#[test]
fn a_negotiation_that_times_out_closes_without_a_retry_until_the_viewer_comes_back() {
    let (viewer, rig) = viewer();
    viewer.ready(codecs(), vec![]).unwrap();
    viewer.timer_fired(99).unwrap();
    assert_eq!(viewer.view().state, TransportState::Negotiating, "a timer that is not the armed one does nothing");
    viewer.timer_fired(1).unwrap();
    assert_eq!(viewer.view().state, TransportState::Cooldown);
    assert_eq!(rig.signals(), vec![desktop(json!({ "type": "close", "reason": "negotiation-timeout" }))]);
    viewer.ready(codecs(), vec![]).unwrap();
    assert_eq!(viewer.view().state, TransportState::Cooldown, "a path that never worked is not tried again");
    assert_eq!(rig.log().iter().filter(|line| line.starts_with("open")).count(), 1);
}

#[test]
fn a_peer_certificate_that_is_not_the_answered_one_ends_the_attempt_with_a_fingerprint_mismatch() {
    let (viewer, rig) = viewer();
    viewer.ready(codecs(), vec![]).unwrap();
    viewer.sender_offer(CONN, &sdp()).unwrap();
    viewer.signal(&answer(CONN)).unwrap();
    viewer.sender_connected(CONN, Some(&json!({ "fingerprintAlgorithm": "sha-256", "fingerprint": vec!["CD"; 32].join(":") }))).unwrap();
    assert_eq!(viewer.view().state, TransportState::Cooldown);
    assert_eq!(rig.signals().last(), Some(&desktop(json!({ "type": "close", "reason": "fingerprint-mismatch" }))));
    assert!(rig.log().contains(&format!("close {CONN}")));
}

#[test]
fn a_ready_waits_for_the_source_geometry_and_a_newer_ready_supersedes_the_connection_in_progress() {
    let (viewer, rig) = viewer();
    rig.page.lock().unwrap().geometry = None;
    viewer.ready(codecs(), vec![]).unwrap();
    assert_eq!(viewer.view().state, TransportState::Relay, "no offer without a locked geometry");
    rig.page.lock().unwrap().geometry = Some(geometry());
    viewer.geometry_changed().unwrap();
    assert_eq!(rig.signals()[0]["type"], "geometry");
    assert_eq!(viewer.view().connection_id.as_deref(), Some(CONN));

    viewer.ready(codecs(), vec![]).unwrap();
    assert_eq!(rig.signals()[1], desktop(json!({ "type": "close", "reason": "superseded", "retryAfterMs": 0 })));
    let view = viewer.view();
    assert_eq!((view.state, view.connection_id.as_deref(), view.generation), (TransportState::Negotiating, Some("connection-00002"), 2));
}

#[test]
fn signals_of_another_connection_or_state_are_ignored_and_a_stopped_viewer_says_it_left() {
    let (viewer, rig) = viewer();
    connect(&viewer);
    viewer.signal(&answer("connection-99999")).unwrap();
    viewer.signal(&answer(CONN)).unwrap();
    assert_eq!(rig.log().iter().filter(|line| line.starts_with("answer")).count(), 1, "one answer, from the current connection");
    viewer.stop().unwrap();
    assert_eq!(viewer.view().state, TransportState::Closed);
    assert_eq!(rig.signals().last(), Some(&desktop(json!({ "type": "close", "reason": "viewer-left" }))));
    assert!(viewer.ready(codecs(), vec![]).is_ok());
    assert_eq!(viewer.view().state, TransportState::Closed, "a closed viewer never restarts");
}

// ---- the host ----

#[derive(Default)]
struct FakeSource {
    started: AtomicUsize,
    stopped: AtomicUsize,
    limits: Mutex<Vec<VideoLimit>>,
}

#[async_trait]
impl VideoSource for FakeSource {
    fn start(&self) {
        self.started.fetch_add(1, Ordering::SeqCst);
    }

    fn stop(&self) {
        self.stopped.fetch_add(1, Ordering::SeqCst);
    }

    fn page(&self) -> (Option<String>, Option<Geometry>) {
        (Some("p1:2".to_owned()), Some(geometry()))
    }

    async fn dispatch(&self, _control: &Value) -> Result<(), String> {
        Ok(())
    }

    async fn resize(&self, _request: &Resize) -> Result<(), String> {
        Ok(())
    }

    fn video_limit(&self, limit: VideoLimit) {
        self.limits.lock().unwrap().push(limit);
    }
}

#[derive(Default)]
struct FakeEnv {
    source: Arc<FakeSource>,
    streamed: Mutex<bool>,
    log: Mutex<Vec<String>>,
    signals: Mutex<Vec<(String, Value)>>,
    pictures: Mutex<Vec<(u64, Vec<u8>)>>,
    ids: AtomicU64,
}

impl FakeEnv {
    fn log(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }
}

impl HostEnv for FakeEnv {
    fn spawn(&self, work: BoxFuture<'static, ()>) {
        tokio::spawn(work);
    }

    fn send_signal(&self, client: &str, signal: &DesktopSignal) -> BoxFuture<'static, Result<(), String>> {
        self.signals.lock().unwrap().push((client.to_owned(), signal.to_json()));
        Box::pin(async { Ok(()) })
    }

    fn source(&self, _source: &Source, _client: &str, _signal: &str) -> Option<Arc<dyn VideoSource>> {
        (*self.streamed.lock().unwrap()).then(|| self.source.clone() as Arc<dyn VideoSource>)
    }

    fn open(&self, connection_id: &str, source_key: &str, ice_servers: &[IceServer], _receive_codecs: &[String]) {
        self.log.lock().unwrap().push(format!("open {connection_id} {source_key} servers={}", ice_servers.len()));
    }

    fn answer(&self, connection_id: &str, _sdp: &str) {
        self.log.lock().unwrap().push(format!("answer {connection_id}"));
    }

    fn candidate(&self, connection_id: &str, _candidate: &Option<Candidate>) {
        self.log.lock().unwrap().push(format!("candidate {connection_id}"));
    }

    fn channel_send(&self, _connection_id: &str, text: &str) {
        self.log.lock().unwrap().push(format!("channel {text}"));
    }

    fn close(&self, connection_id: &str) {
        self.log.lock().unwrap().push(format!("close {connection_id}"));
    }

    fn push_picture(&self, _source_key: &str, frame_id: u64, picture: &Picture) {
        self.pictures.lock().unwrap().push((frame_id, picture.data.to_vec()));
    }

    fn source_closed(&self, source_key: &str) {
        self.log.lock().unwrap().push(format!("source closed {source_key}"));
    }

    fn report(&self, event: &str, _data: Value) {
        self.log.lock().unwrap().push(format!("report {event}"));
    }

    fn new_connection_id(&self) -> String {
        format!("connection-{:05}", self.ids.fetch_add(1, Ordering::SeqCst) + 1)
    }

    fn now(&self) -> f64 {
        1000.0
    }

    fn set_timer(&self, _ms: u64, _run: Arc<dyn Fn(u64) + Send + Sync>) -> u64 {
        1
    }

    fn clear_timer(&self, _handle: u64) {}
}

fn host() -> (LiveHost, Arc<FakeEnv>) {
    let env = Arc::new(FakeEnv::default());
    *env.streamed.lock().unwrap() = true;
    (LiveHost::new(env.clone()), env)
}

fn picture(text: &str) -> Picture {
    Picture { document_id: Some("p1:2".to_owned()), generation: 1, data: Bytes::from(text.to_owned()) }
}

const KEY: &str = "browser:session-1";

#[tokio::test]
async fn a_signal_for_a_client_or_source_that_cannot_be_served_is_refused() {
    let (host, env) = host();
    assert_eq!(host.signal("bad id", &ready(&browser()), &[]).await, Err("remote webrtc client id is invalid.".to_owned()));
    *env.streamed.lock().unwrap() = false;
    assert_eq!(host.signal("c1", &ready(&browser()), &[]).await, Err("remote webrtc source is not streamed.".to_owned()));
    assert!(env.log().is_empty() && env.signals.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_first_ready_tells_the_phone_the_geometry_then_opens_one_connection_and_starts_the_source() {
    let (host, env) = host();
    let limit = VideoLimit { max_width: 1280, max_height: 720 };
    let signal = ClientSignal::parse(&json!({
        "type": "ready", "v": 1, "source": browser(), "receiveCodecs": ["video/VP8"], "videoLimit": { "maxWidth": 1280, "maxHeight": 720 },
    }))
    .unwrap();
    host.signal("c1", &signal, &[stun()]).await.unwrap();
    // The viewer reports its move from relay to negotiating (every transition is reported) before the connection opens.
    assert_eq!(env.log(), ["report state".to_owned(), format!("open {CONN} {KEY} servers=1")]);
    let signals = env.signals.lock().unwrap().clone();
    assert_eq!(signals.len(), 1);
    assert_eq!(signals[0].0, "c1");
    assert_eq!(signals[0].1["type"], "geometry");
    assert_eq!(env.source.started.load(Ordering::SeqCst), 1);
    assert_eq!(*env.source.limits.lock().unwrap(), [limit]);
    host.signal("c1", &signal, &[stun()]).await.unwrap();
    assert_eq!(env.log().iter().filter(|line| line.starts_with("open")).count(), 2, "the same viewer restarts its attempt, no second viewer");
    assert_eq!(env.signals.lock().unwrap().iter().filter(|(_, signal)| signal["type"] == "geometry").count(), 1);
}

#[tokio::test]
async fn one_picture_is_in_flight_per_source_and_the_newest_waiting_one_replaces_the_rest() {
    let (host, env) = host();
    host.signal("c1", &ready(&browser()), &[]).await.unwrap();
    host.frame(KEY, picture("one"));
    host.frame(KEY, picture("two"));
    host.frame(KEY, picture("three"));
    assert_eq!(*env.pictures.lock().unwrap(), [(1, b"one".to_vec())], "the next picture waits for the sender to take this one");
    host.sender_event(SenderEvent::FrameDone { source_key: KEY.to_owned(), frame_id: 7, ok: true });
    assert_eq!(env.pictures.lock().unwrap().len(), 1, "an acknowledgement of another picture is ignored");
    host.sender_event(SenderEvent::FrameDone { source_key: KEY.to_owned(), frame_id: 1, ok: true });
    assert_eq!(*env.pictures.lock().unwrap(), [(1, b"one".to_vec()), (2, b"three".to_vec())], "two was superseded by three");
}

#[tokio::test]
async fn a_viewer_that_leaves_closes_its_connection_stops_an_unwanted_source_and_tells_its_phone() {
    let (host, env) = host();
    host.signal("c1", &ready(&browser()), &[]).await.unwrap();
    host.viewer_left("c1", KEY);
    assert!(env.log().contains(&format!("close {CONN}")));
    assert_eq!(env.source.stopped.load(Ordering::SeqCst), 1);
    let last = env.signals.lock().unwrap().last().cloned().expect("a signal");
    assert_eq!(last, ("c1".to_owned(), desktop(json!({ "type": "close", "reason": "viewer-left" }))));
    // Its next ready is a new viewer with a new connection.
    host.signal("c1", &ready(&browser()), &[]).await.unwrap();
    assert!(env.log().contains(&format!("open connection-00002 {KEY} servers=0")));
}

#[tokio::test]
async fn a_peer_that_reports_a_failure_or_a_vanished_sender_sends_its_viewers_back_to_the_jpeg_view() {
    let (host, env) = host();
    host.signal("c1", &ready(&browser()), &[]).await.unwrap();
    host.sender_event(SenderEvent::Failed { connection_id: CONN.to_owned(), reason: CloseReason::IceFailed });
    let signals = env.signals.lock().unwrap().clone();
    assert_eq!(signals.last().unwrap().1, desktop(json!({ "type": "close", "reason": "ice-failed" })));

    let (host, env) = self::host();
    host.signal("c1", &ready(&browser()), &[]).await.unwrap();
    host.sender_event(SenderEvent::Gone);
    let signals = env.signals.lock().unwrap().clone();
    assert_eq!(signals.last().unwrap().1, desktop(json!({ "type": "close", "reason": "sender-failed" })));
}

#[tokio::test]
async fn a_source_that_ends_stops_every_viewer_of_it_and_drops_its_shared_picture() {
    let (host, env) = host();
    host.signal("c1", &ready(&browser()), &[]).await.unwrap();
    host.geometry_changed(KEY, None);
    assert!(env.log().contains(&format!("close {CONN}")));
    assert!(env.log().contains(&format!("source closed {KEY}")));
    host.frame(KEY, picture("late"));
    assert!(env.pictures.lock().unwrap().is_empty(), "a source that ended takes no more pictures");
}
