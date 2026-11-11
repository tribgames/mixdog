//! The phones' browser streams and JPEG view, served by the live view, against Node's recording (`fixtures/browser-streams`,
//! `record-browser-streams.mjs`): Node's relay-client call dispatch, stream pacing and WebRTC relay at b6f10295a, driven by the
//! same inputs on a virtual clock.
//!
//! Each recorded step reaches the service where its Node counterpart reached Node's relay: a phone's `browserRemoteStream` call
//! is a `browser/stream` request on that phone's connection, its `browserRemoteStreamAck` a `browser/streamAck` notification, a
//! desktop frame the host's `host/browser/frame` facts followed by the X17 picture on the session's stream, a departed phone the
//! connection's close, a time step the clock's advance, and the WebRTC hand-over steps the service's own relay (`accept`, `send`).
//! A device's unpair is what the runtime's unpair does: every connection of the device is revoked for the view (the registry's
//! `screen_revoked`, Node's `revokeCredential`), then the live view's `unpaired` runs for each of them in the order they were admitted
//! (`PairedDeviceCleanup::unpaired`, Node's `dropClient` of each connection `revokeCredential` names); a missed drop is the revocation
//! alone. A departed phone is no longer attached (`peer_attached`) and its connection closed. The relay's close is `relay_closed`,
//! Node's `dispose`. A `hold` is Node's delivery encrypting every push until the `release`: a frame the core queued for its phone
//! is written then, asked again as the runtime asks at the write (`DeviceRegistry::write_view`), and a WebRTC signal's send, which
//! Node's relay awaits, stops on its way before the view gate (`Seams::on_its_way`) until then. The recording is of b6f10295a with
//! `node-fix-unpair-keeps-stream.patch` (see the manifest).
//!
//! What each step sent is compared with what Node sent, as serialized text: every message whole, in order, with its fields in the
//! order they go out. The names map one to one:
//! - a phone's push: `browser/frame` with params P is Node's `browserRemoteFrame` event with payload P; `browser/webrtcSignal` with
//!   params `{signal: S}` (that one field and no other) is Node's `browserRemoteWebrtc` with payload S;
//! - the desktop's view request: `host/browser/viewFrames` `{tabId, streamId, on, request}` (those fields, in that order) is Node's
//!   `browserRemote('stream', [tabId, request])` when `on`, and `[tabId, null]` when off with `request: null`. `streamId` is the
//!   core's own number for the session's X17 stream, which Node has no counterpart of: it must stay the same from a session's first
//!   `on` to its `off`;
//! - the reply to `browser/stream`: the protocol's empty result is Node's `{id, ok: true, value: null}`, its `remote` domain error
//!   with message M Node's `{id, ok: false, error: M}`;
//! - the relay's answers and the state queries are compared as recorded.

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;

use base64::Engine;
use mixdog_app_protocol::media::MediaFormat;
use mixdog_app_protocol::media::MediaFlags;
use mixdog_app_protocol::media::MediaPurpose;
use mixdog_core_api::ConnectionNotifier;
use mixdog_core_api::HostMediaSink;
use mixdog_core_api::call::CallContext;
use mixdog_protocol::Origin;

use super::tests::Scripted;
use super::tests::runtime;
use super::*;

const STREAMS: &str = include_str!("../../../fixtures/browser-streams/streams.json");
const HOST_CONNECTION: u64 = 99;

/// The recording's clock: time moves only by `advance`, which runs the due timers in due-time then registration order, one at a time.
#[derive(Default)]
struct VirtualClock {
    now: Mutex<f64>,
    timers: Mutex<(u64, BTreeMap<u64, (f64, Box<dyn FnOnce() + Send>)>)>,
}

impl VirtualClock {
    fn starting_at(now: f64) -> Arc<Self> {
        Arc::new(Self { now: Mutex::new(now), timers: Mutex::default() })
    }

    fn advance(&self, ms: f64) {
        let target = *lock(&self.now) + ms;
        loop {
            let next = {
                let mut timers = lock(&self.timers);
                let due = timers.1.iter().filter(|(_, (due, _))| *due <= target).min_by(|a, b| a.1.0.total_cmp(&b.1.0).then(a.0.cmp(b.0))).map(|(handle, _)| *handle);
                due.and_then(|handle| timers.1.remove(&handle))
            };
            let Some((due, run)) = next else { break };
            *lock(&self.now) = due;
            run();
        }
        *lock(&self.now) = target;
    }
}

impl Clock for VirtualClock {
    fn now(&self) -> f64 {
        *lock(&self.now)
    }

    fn set_timer(&self, ms: f64, run: Box<dyn FnOnce() + Send>) -> u64 {
        let due = *lock(&self.now) + ms.max(0.0);
        let mut timers = lock(&self.timers);
        timers.0 += 1;
        let handle = timers.0;
        timers.1.insert(handle, (due, run));
        handle
    }

    fn clear_timer(&self, handle: u64) {
        lock(&self.timers).1.remove(&handle);
    }
}

/// Everything that crossed the boundary in one step, in Node's recorded form.
type Log = Arc<Mutex<Vec<Value>>>;

fn client_name(connection: u64) -> &'static str {
    match connection {
        1 => "phone_A",
        2 => "phone_B",
        3 => "phone_C",
        other => panic!("no phone has connection {other}"),
    }
}

fn connection_of(client: &str) -> u64 {
    match client {
        "phone_A" => 1,
        "phone_B" => 2,
        "phone_C" => 3,
        other => panic!("unmapped phone {other}"),
    }
}

/// The paired device each phone's connection acts as (the recorder's `CREDENTIALS`), in the order the connections were admitted.
const CREDENTIALS: [(&str, &str); 3] = [("phone_A", "cred_1"), ("phone_B", "cred_2"), ("phone_C", "cred_1")];

fn keys(value: &Value) -> Vec<&str> {
    value.as_object().map(|object| object.keys().map(String::as_str).collect()).unwrap_or_default()
}

/// The desktop: its view requests under the name table above; anything else it is asked is logged as it came, so it can only fail
/// the comparison.
struct Desktop {
    log: Log,
    /// Each viewed session's stream number, from its first `on` to its `off`.
    streams: Mutex<HashMap<String, Value>>,
}

#[async_trait]
impl HostChannel for Desktop {
    async fn request(&self, _capability: HostCapability, method: Method, params: Value) -> Result<Value, HostError> {
        lock(&self.log).push(json!(["host", method.as_str(), params]));
        Ok(json!({}))
    }

    fn notify(&self, _capability: HostCapability, method: Method, params: Value) -> Result<(), CoreError> {
        let entry = if method.as_str() == "host/browser/viewFrames" && keys(&params) == ["tabId", "streamId", "on", "request"] {
            let tab = params["tabId"].as_str().unwrap_or_default().to_owned();
            let mut streams = lock(&self.streams);
            let held = streams.entry(tab.clone()).or_insert_with(|| params["streamId"].clone()).clone();
            match (&params["on"], &params["request"]) {
                (Value::Bool(true), request) if held == params["streamId"] => json!(["request", tab, request]),
                (Value::Bool(false), Value::Null) if held == params["streamId"] => {
                    streams.remove(&tab);
                    json!(["request", tab, null])
                }
                _ => json!(["host", method.as_str(), params, "held stream", held]),
            }
        } else {
            json!(["host", method.as_str(), params])
        };
        lock(&self.log).push(entry);
        Ok(())
    }
}

/// A push held between a `hold` and its `release`, in the order it was held.
enum Parked {
    /// A frame queued for its phone, written at the release where the runtime writes it (`DeviceRegistry::write_view`: only while the
    /// phone is attached and not revoked for the view).
    Write(Box<dyn FnOnce() + Send>),
    /// A WebRTC signal's send, stopped on its way (`Seams::on_its_way`): it goes on at the release.
    Send(std::sync::mpsc::Sender<()>),
}

/// The phones: each push under the name table above, as the relay's encrypted push `{event, payload}`, written when the runtime
/// writes it.
struct Phones {
    log: Log,
    holding: Arc<AtomicBool>,
    parked: Arc<Mutex<Vec<Parked>>>,
    /// The connections revoked for the view and those whose peer left (the registry's facts the write is asked about).
    revoked: Arc<Mutex<HashSet<u64>>>,
    left: Arc<Mutex<HashSet<u64>>>,
}

impl ConnectionNotifier for Phones {
    fn notify(&self, to: ConnectionId, method: Method, params: Value) -> Result<(), CoreError> {
        let pushed = match method.as_str() {
            "browser/frame" => json!({ "event": "browserRemoteFrame", "payload": params }),
            "browser/webrtcSignal" if keys(&params) == ["signal"] => json!({ "event": "browserRemoteWebrtc", "payload": params["signal"] }),
            other => json!({ "unexpected": other, "params": params }),
        };
        let entry = json!(["push", client_name(to.0), pushed]);
        if !self.holding.load(Ordering::SeqCst) {
            lock(&self.log).push(entry);
            return Ok(());
        }
        let (log, revoked, left) = (self.log.clone(), self.revoked.clone(), self.left.clone());
        lock(&self.parked).push(Parked::Write(Box::new(move || {
            if !lock(&revoked).contains(&to.0) && !lock(&left).contains(&to.0) {
                lock(&log).push(entry);
            }
        })));
        Ok(())
    }
}

fn call(connection: u64, params: Value) -> CoreRequest {
    CoreRequest { method: Method("browser/stream"), params, op: None, ctx: CallContext::connection(ConnectionId(connection), Origin::Relay, tokio_util::sync::CancellationToken::new()) }
}

/// The desktop's frame as the host sends it: the facts, the picture announced by `image.mimeType`, then the X17 picture.
fn send_frame(service: &LiveViewService, media: &HostMedia, frame: &Value) {
    let session = frame["sessionId"].as_str().unwrap();
    let mut facts = frame.clone();
    let picture = facts.get_mut("image").and_then(Value::as_object_mut).and_then(|image| image.remove("data"));
    service.notify(Method("host/browser/frame"), json!({ "tabId": session, "frame": facts }), ConnectionId(HOST_CONNECTION));
    let stream = lock(&service.inner.state).streams.get(session).map(|stream| stream.stream_id);
    // A session nobody views has no stream: the host sends it no picture.
    let (Some(picture), Some(stream_id)) = (picture, stream) else { return };
    let mut flags = 0;
    if frame["fitSettled"] == json!(true) {
        flags |= MediaFlags::FIT_SETTLED;
    }
    if frame["fitFailed"] == json!(true) {
        flags |= MediaFlags::FIT_FAILED;
    }
    let header = MediaFrameHeader {
        purpose: MediaPurpose::BrowserView,
        flags,
        stream_id,
        width: frame["width"].as_u64().unwrap() as u16,
        height: frame["height"].as_u64().unwrap() as u16,
        format: MediaFormat::Jpeg,
    };
    let mut bytes = header.encode().to_vec();
    bytes.extend_from_slice(&base64::engine::general_purpose::STANDARD.decode(picture.as_str().unwrap()).unwrap());
    media.frame(ConnectionId(HOST_CONNECTION), Bytes::from(bytes));
}

/// One service over the recording's clock, desktop and phones.
struct World {
    service: Arc<LiveViewService>,
    media: Arc<HostMedia>,
    clock: Arc<VirtualClock>,
    log: Log,
    ids: std::sync::atomic::AtomicU64,
    /// Connections revoked for the view (the registry's `screen_revoked`: live at their device's unpair).
    revoked: Arc<Mutex<HashSet<u64>>>,
    /// Connections whose peer left (no longer `peer_attached`).
    left: Arc<Mutex<HashSet<u64>>>,
    /// Between a `hold` and its `release` (Node's delivery encrypting every push until then): a frame is queued and written at the
    /// release, a WebRTC signal's send waits on its way (Node's relay awaits that delivery, its streams do not await a frame's).
    holding: Arc<AtomicBool>,
    /// The held pushes, in the order they were held.
    parked: Arc<Mutex<Vec<Parked>>>,
    /// Told each time a send stops on its way.
    parked_events: tokio::sync::Mutex<tokio::sync::mpsc::UnboundedReceiver<()>>,
    /// The steps whose send stopped on its way, still running on their own threads, in the order they stopped.
    running: Mutex<Vec<tokio::sync::oneshot::Receiver<()>>>,
}

impl World {
    fn new(dir: &std::path::Path, clock_start: f64) -> Arc<Self> {
        let log: Log = Arc::default();
        let media = HostMedia::new(1 << 20);
        let clock = VirtualClock::starting_at(clock_start);
        let (revoked, left): (Arc<Mutex<HashSet<u64>>>, Arc<Mutex<HashSet<u64>>>) = Default::default();
        let (held, gone) = (revoked.clone(), left.clone());
        let access = PairedScreenAccess::new(
            Arc::new(|_| None),
            Arc::new(move |connection| lock(&held).contains(&connection.0)),
            Arc::new(move |connection| !lock(&gone).contains(&connection.0)),
        );
        let (holding, parked): (Arc<AtomicBool>, Arc<Mutex<Vec<Parked>>>) = Default::default();
        let phones = Phones { log: log.clone(), holding: holding.clone(), parked: parked.clone(), revoked: revoked.clone(), left: left.clone() };
        let service = Arc::new(LiveViewService::with_clock(
            Arc::new(Desktop { log: log.clone(), streams: Mutex::default() }),
            Arc::new(phones),
            media.clone(),
            runtime(dir),
            Arc::new(Scripted::default()),
            Arc::new(access),
            clock.clone(),
        ));
        let (parked_tx, parked_rx) = tokio::sync::mpsc::unbounded_channel();
        let (on, stopped) = (holding.clone(), parked.clone());
        lock(&service.inner.seams).on_its_way = Some(Arc::new(move |_connection, method| {
            if method != "browser/webrtcSignal" || !on.load(Ordering::SeqCst) {
                return;
            }
            let (go_tx, go_rx) = std::sync::mpsc::channel();
            lock(&stopped).push(Parked::Send(go_tx));
            let _ = parked_tx.send(());
            go_rx.recv_timeout(GATE_DEADLINE).expect("the release let the held push go on within 30 s");
        }));
        Arc::new(Self {
            service,
            media,
            clock,
            log,
            ids: Default::default(),
            revoked,
            left,
            holding,
            parked,
            parked_events: tokio::sync::Mutex::new(parked_rx),
            running: Mutex::default(),
        })
    }

    /// A step between a `hold` and its `release`, on its own thread: done when it ends, or once a send of it stopped on its way.
    async fn held_step(self: &Arc<Self>, step: &Value, what: &str) {
        let (done_tx, mut done_rx) = tokio::sync::oneshot::channel::<()>();
        let (runtime, world, step, label) = (tokio::runtime::Handle::current(), self.clone(), step.clone(), what.to_owned());
        std::thread::Builder::new()
            .name("held-push-step".to_owned())
            .spawn(move || {
                runtime.block_on(world.step(&step, &label));
                let _ = done_tx.send(());
            })
            .unwrap();
        let mut parked = self.parked_events.lock().await;
        let stopped = mixdog_rt::time::timeout(GATE_DEADLINE, async {
            tokio::select! {
                ended = &mut done_rx => {
                    ended.unwrap_or_else(|_| panic!("{what}: the step failed"));
                    false
                }
                _ = parked.recv() => true,
            }
        })
        .await
        .unwrap_or_else(|_| panic!("{what}: the step neither ended nor stopped a push on its way within 30 s"));
        drop(parked);
        if stopped {
            lock(&self.running).push(done_rx);
        }
    }

    /// The `release`: each held push goes on in the order it was held (as Node's encryptions complete), a send's step ending before
    /// the next goes on.
    async fn release(&self, what: &str) {
        self.holding.store(false, Ordering::SeqCst);
        let parked = std::mem::take(&mut *lock(&self.parked));
        let mut running = std::mem::take(&mut *lock(&self.running)).into_iter();
        for held in parked {
            match held {
                Parked::Write(write) => write(),
                Parked::Send(go) => {
                    let done = running.next().unwrap_or_else(|| panic!("{what}: a stopped send without its step"));
                    go.send(()).unwrap();
                    mixdog_rt::time::timeout(GATE_DEADLINE, done)
                        .await
                        .unwrap_or_else(|_| panic!("{what}: a released step did not end within 30 s"))
                        .unwrap_or_else(|_| panic!("{what}: a released step failed"));
                }
            }
        }
        assert!(running.next().is_none(), "{what}: one stopped send per held step");
    }

    /// The connections of a device, in the order they were admitted.
    fn connections_of(credential: &str) -> Vec<u64> {
        CREDENTIALS.iter().filter(|(_, held)| *held == credential).map(|(client, _)| connection_of(client)).collect()
    }

    fn take(&self) -> Vec<Value> {
        std::mem::take(&mut *lock(&self.log))
    }

    async fn step(&self, step: &Value, what: &str) {
        let service = &self.service;
        let log = &self.log;
        match step["op"].as_str().unwrap() {
            "call" => {
                let client = step["client"].as_str().unwrap();
                let connection = connection_of(client);
                let params = &step["params"];
                match step["method"].as_str().unwrap() {
                    "browserRemoteStream" => {
                        let id = self.ids.fetch_add(1, Ordering::SeqCst) + 1;
                        let options = &params[1];
                        let mut request = json!({ "sessionId": params[0], "on": !options.is_null() });
                        if !options.is_null() {
                            request["request"] = options.clone();
                        }
                        let reply = match service.call(call(connection, request)).await {
                            // The protocol's empty result is Node's `value: null` of a void call.
                            Ok(Reply::Value(value)) if value == json!({}) => json!({ "id": id, "ok": true, "value": null }),
                            Err(CoreError::DomainError { domain, code: None, message: Some(message), detail: None }) if &*domain == "remote" => {
                                json!({ "id": id, "ok": false, "error": &*message })
                            }
                            other => panic!("{what}: {other:?}"),
                        };
                        lock(&log).push(json!(["reply", client, reply]));
                    }
                    "browserRemoteStreamAck" => {
                        service.notify(Method("browser/streamAck"), json!({ "sessionId": params[0], "seq": params[1] }), ConnectionId(connection));
                    }
                    other => panic!("{what}: unmapped call {other}"),
                }
            }
            "frame" => send_frame(service, &self.media, &step["frame"]),
            "advance" => self.clock.advance(step["ms"].as_f64().unwrap()),
            "leave" => {
                let connection = connection_of(step["client"].as_str().unwrap());
                lock(&self.left).insert(connection);
                service.connection_closed(ConnectionId(connection));
            }
            "unpair" | "revokeOnly" => {
                let connections = Self::connections_of(step["credential"].as_str().unwrap());
                lock(&self.revoked).extend(connections.iter().copied());
                if step["op"] == "unpair" {
                    for connection in connections {
                        service.unpaired(ConnectionId(connection));
                    }
                }
            }
            "dispose" => service.relay_closed(),
            "hold" => self.holding.store(true, Ordering::SeqCst),
            "release" => self.release(what).await,
            "query" => {
                let (client, session) = (connection_of(step["client"].as_str().unwrap()).to_string(), step["session"].as_str().unwrap());
                let streams = service.inner.streams();
                lock(&log).push(json!(["state", { "subscribed": streams.subscribed(&client, session), "awaitingFit": streams.awaiting_fit(&client, session) }]));
            }
            "accept" => {
                let client = connection_of(step["client"].as_str().unwrap()).to_string();
                let entry = match service.inner.relay().accept(&client, &step["raw"]) {
                    Ok(_) => json!(["accepted"]),
                    Err(error) => json!(["refused", error]),
                };
                lock(&log).push(entry);
            }
            "send" => {
                let client = connection_of(step["client"].as_str().unwrap()).to_string();
                let relay = service.inner.relay().clone();
                let entry = match relay.send(&client, &step["raw"]).await {
                    Ok(()) => json!(["sent"]),
                    Err(error) => json!(["refused", error]),
                };
                lock(&log).push(entry);
            }
            other => panic!("{what}: unmapped op {other}"),
        }
    }
}

/// What went out against what Node sent, as serialized text: whole messages, in order, with their fields in order.
fn same_on_the_wire(got: Vec<Value>, want: &[Value], what: &str) {
    assert_eq!(serde_json::to_string(&got).unwrap(), serde_json::to_string(want).unwrap(), "{what}");
}

fn recording() -> (Value, f64) {
    let recorded: Value = serde_json::from_str(STREAMS).unwrap();
    let clock_start = recorded["clockStart"].as_f64().unwrap();
    (recorded, clock_start)
}

fn scenario<'a>(recorded: &'a Value, name: &str) -> (&'a [Value], &'a [Value]) {
    let scenario = recorded["scenarios"].as_array().unwrap().iter().find(|scenario| scenario["name"] == name).unwrap_or_else(|| panic!("the recording has no scenario {name:?}"));
    let (steps, outcomes) = (scenario["steps"].as_array().unwrap(), scenario["recorded"].as_array().unwrap());
    assert_eq!(steps.len(), outcomes.len(), "{name}: a recorded outcome per step");
    (steps, outcomes)
}

/// Runs steps one after the other, each compared with its recorded outcome. Between a `hold` and its `release` a step runs until it
/// ends or a send of it stops on its way.
async fn replay_steps(world: &Arc<World>, name: &str, steps: &[Value], outcomes: &[Value], from: usize) {
    let mut holding = false;
    for (number, (step, want)) in steps.iter().zip(outcomes).enumerate() {
        let what = format!("{name} step {} {step}", from + number);
        match step["op"].as_str().unwrap() {
            "hold" | "release" => {
                holding = step["op"] == "hold";
                world.step(step, &what).await;
            }
            _ if holding => world.held_step(step, &what).await,
            _ => world.step(step, &what).await,
        }
        same_on_the_wire(world.take(), want.as_array().unwrap(), &what);
    }
    assert!(!holding, "{name}: a hold without its release");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_live_view_serves_nodes_recorded_browser_streams() {
    mixdog_rt::testing::tokens();
    let (recorded, clock_start) = recording();
    let scenarios = recorded["scenarios"].as_array().unwrap();
    assert!(!scenarios.is_empty(), "the recording holds scenarios");
    let dir = tempfile::tempdir().unwrap();
    for scenario in scenarios {
        let name = scenario["name"].as_str().unwrap();
        let (steps, outcomes) = self::scenario(&recorded, name);
        replay_steps(&World::new(dir.path(), clock_start), name, steps, outcomes, 0).await;
    }
}

/// The orders the streams keep when two steps race: the first step of each pair is held on its own thread at the point it releases
/// the streams' state (its change made, its effects not yet delivered), the next steps run meanwhile, then the held one goes on.
/// Everything sent must be what Node sent running the same steps one after the other (`gate: …` scenarios): the effects of a change
/// leave before those of every later change, never after.
///
/// The steps that run meanwhile have a deadline of their own: one that delivers the held step's effects while it holds a lock those
/// effects' handlers take never returns (`gate: a lapse, then a promote-ack`: the relay's `accept` holds its state while it settles
/// the images, and the lapse's dropped view goes back to the relay).
const GATED: [(&str, usize, usize); 6] = [
    ("gate: a lapse, then a fresh subscribe", 1, 2),
    ("gate: a resend, then an unsubscribe", 3, 4),
    ("gate: an ack, then a newer frame resent", 3, 5),
    ("gate: a resend, then a phone joins", 3, 4),
    ("gate: a fit failure, then a renewal", 1, 2),
    ("gate: a lapse, then a promote-ack", 5, 6),
];

const HELD: &str = "held-step";
const GATE_DEADLINE: Duration = Duration::from_secs(30);

/// Where a held step stops while the others run.
#[derive(Clone, Copy)]
enum Point {
    /// It released the streams' state, its effects queued and not yet delivered.
    Released,
    /// A subscribe has begun and not yet taken the streams' state.
    Subscribing,
}

async fn gated(name: &str, held: usize, last: usize) {
    let meanwhile: Vec<usize> = (held + 1..=last).collect();
    let want: Vec<usize> = (held..=last).collect();
    forced(name, held, held, &meanwhile, &want, Point::Released).await;
}

/// Replays the steps before `before`, holds step `held` at `point` on its own thread, runs the `meanwhile` steps, lets the held one go
/// on, and compares what went out, whole, with Node's outcomes of the `want` steps one after the other.
async fn forced(name: &str, before: usize, held: usize, meanwhile: &[usize], want: &[usize], point: Point) {
    let (recorded, clock_start) = recording();
    let (steps, outcomes) = scenario(&recorded, name);
    let dir = tempfile::tempdir().unwrap();
    let world = World::new(dir.path(), clock_start);
    replay_steps(&world, name, &steps[..before], &outcomes[..before], 0).await;

    let (reached_tx, reached_rx) = tokio::sync::oneshot::channel::<()>();
    let (go_tx, go_rx) = std::sync::mpsc::channel::<()>();
    let (reached_tx, go_rx, fired) = (Mutex::new(Some(reached_tx)), Mutex::new(go_rx), AtomicBool::new(false));
    let hook: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
        if std::thread::current().name() != Some(HELD) || fired.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Some(reached) = lock(&reached_tx).take() {
            let _ = reached.send(());
        }
        lock(&go_rx).recv_timeout(GATE_DEADLINE).expect("the test let the held step go on within 30 s");
    });
    let streams = world.service.inner.streams();
    *lock(match point {
        Point::Released => &streams.released,
        Point::Subscribing => &streams.subscribing,
    }) = Some(hook);
    let (done_tx, done_rx) = tokio::sync::oneshot::channel::<()>();
    let (runtime, held_world, held_step) = (tokio::runtime::Handle::current(), world.clone(), steps[held].clone());
    std::thread::Builder::new()
        .name(HELD.to_owned())
        .spawn(move || {
            runtime.block_on(held_world.step(&held_step, "the held step"));
            let _ = done_tx.send(());
        })
        .unwrap();
    mixdog_rt::time::timeout(GATE_DEADLINE, reached_rx)
        .await
        .unwrap_or_else(|_| panic!("{name}: the held step {held} did not reach its point within 30 s"))
        .unwrap_or_else(|_| panic!("{name}: the held step {held} ended before it reached its point"));
    let (meanwhile_tx, meanwhile_rx) = tokio::sync::oneshot::channel::<()>();
    let (runtime, meanwhile_world) = (tokio::runtime::Handle::current(), world.clone());
    let meanwhile: Vec<Value> = meanwhile.iter().map(|&number| steps[number].clone()).collect();
    let label = name.to_owned();
    std::thread::Builder::new()
        .name("meanwhile-steps".to_owned())
        .spawn(move || {
            for step in &meanwhile {
                runtime.block_on(meanwhile_world.step(step, &format!("{label} step {step}")));
            }
            let _ = meanwhile_tx.send(());
        })
        .unwrap();
    mixdog_rt::time::timeout(GATE_DEADLINE, meanwhile_rx)
        .await
        .unwrap_or_else(|_| panic!("{name}: the steps after the held step {held} did not finish within 30 s (a step delivered effects under a lock their handlers take)"))
        .unwrap_or_else(|_| panic!("{name}: a step after the held step {held} failed"));
    go_tx.send(()).unwrap();
    mixdog_rt::time::timeout(GATE_DEADLINE, done_rx)
        .await
        .unwrap_or_else(|_| panic!("{name}: the held step {held} did not finish within 30 s of going on"))
        .unwrap_or_else(|_| panic!("{name}: the held step {held} failed"));
    let wanted: Vec<Value> = want.iter().flat_map(|&number| outcomes[number].as_array().unwrap().iter().cloned()).collect();
    same_on_the_wire(world.take(), &wanted, &format!("{name}: steps {want:?} as Node ran them, step {held} held while the others ran"));
}

#[tokio::test(flavor = "multi_thread")]
async fn racing_steps_send_in_the_order_their_changes_were_made() {
    mixdog_rt::testing::tokens();
    for (name, held, last) in GATED {
        gated(name, held, last).await;
    }
}

const UNPAIRED_LEFT_OPEN: &str = "an unpaired device whose connections stay open is refused and sent nothing";

/// A phone subscribes while its device is unpaired: the unpair (its revocation, then the live view's drop) runs where the subscribe
/// has begun and not yet taken the streams' state. The subscribe asks with the state taken, so it is refused, as Node refused the
/// subscribe it ran after the unpair (step 8 after step 5), and the desktop is asked for nothing more.
#[tokio::test(flavor = "multi_thread")]
async fn a_subscribe_that_meets_an_unpair_is_refused() {
    mixdog_rt::testing::tokens();
    forced(UNPAIRED_LEFT_OPEN, 5, 8, &[5], &[5, 8], Point::Subscribing).await;
}

const UNPAIR: &str = "unpair-step";

/// A push to a phone (step `held`) is held where it passed its check, and the device's unpair (step `unpair`) runs meanwhile: it
/// revokes, drops the device's streams (their effects wait for the delivery the held push is in), then must wait at the view gate
/// until the push is enqueued. What goes out is Node's push then Node's unpair, and nothing reaches the device once the cleanup
/// returned.
async fn forced_push(name: &str, before: usize, held: usize, unpair: usize) {
    let (recorded, clock_start) = recording();
    let (steps, outcomes) = scenario(&recorded, name);
    let dir = tempfile::tempdir().unwrap();
    let world = World::new(dir.path(), clock_start);
    replay_steps(&world, name, &steps[..before], &outcomes[..before], 0).await;
    let device: Vec<&str> = World::connections_of(steps[unpair]["credential"].as_str().unwrap()).into_iter().map(client_name).collect();

    let (reached_tx, reached_rx) = tokio::sync::oneshot::channel::<()>();
    let (go_tx, go_rx) = std::sync::mpsc::channel::<()>();
    let (reached_tx, go_rx, fired) = (Mutex::new(Some(reached_tx)), Mutex::new(go_rx), AtomicBool::new(false));
    let (events_tx, mut events) = tokio::sync::mpsc::unbounded_channel::<&'static str>();
    let waits = events_tx.clone();
    {
        let mut seams = lock(&world.service.inner.seams);
        seams.checked = Some(Arc::new(move |_connection| {
            if std::thread::current().name() != Some(HELD) || fired.swap(true, Ordering::SeqCst) {
                return;
            }
            if let Some(reached) = lock(&reached_tx).take() {
                let _ = reached.send(());
            }
            lock(&go_rx).recv_timeout(GATE_DEADLINE).expect("the test let the held push go on within 30 s");
        }));
        seams.cleanup_waits = Some(Arc::new(move || {
            let _ = waits.send("waited at the view gate");
        }));
    }
    let (done_tx, done_rx) = tokio::sync::oneshot::channel::<()>();
    let (runtime, held_world, held_step) = (tokio::runtime::Handle::current(), world.clone(), steps[held].clone());
    std::thread::Builder::new()
        .name(HELD.to_owned())
        .spawn(move || {
            runtime.block_on(held_world.step(&held_step, "the held push"));
            let _ = done_tx.send(());
        })
        .unwrap();
    mixdog_rt::time::timeout(GATE_DEADLINE, reached_rx)
        .await
        .unwrap_or_else(|_| panic!("{name}: the push of step {held} did not pass its check within 30 s"))
        .unwrap_or_else(|_| panic!("{name}: step {held} ended before its push passed its check"));

    let (returned_tx, returned_rx) = tokio::sync::oneshot::channel::<usize>();
    let (runtime, unpair_world, unpair_step) = (tokio::runtime::Handle::current(), world.clone(), steps[unpair].clone());
    std::thread::Builder::new()
        .name(UNPAIR.to_owned())
        .spawn(move || {
            runtime.block_on(unpair_world.step(&unpair_step, "the unpair"));
            // What had gone out when the unpair's cleanup returned.
            let _ = returned_tx.send(lock(&unpair_world.log).len());
            let _ = events_tx.send("returned");
        })
        .unwrap();
    let first = mixdog_rt::time::timeout(GATE_DEADLINE, events.recv())
        .await
        .unwrap_or_else(|_| panic!("{name}: the unpair of step {unpair} neither waited at the view gate nor went on within 30 s"))
        .unwrap();
    assert_eq!(first, "waited at the view gate", "{name}: the unpair's cleanup went on while the push of step {held}, past its check, was not yet enqueued");
    go_tx.send(()).unwrap();
    mixdog_rt::time::timeout(GATE_DEADLINE, done_rx)
        .await
        .unwrap_or_else(|_| panic!("{name}: step {held} did not end within 30 s of going on"))
        .unwrap_or_else(|_| panic!("{name}: step {held} failed"));
    let returned_at = mixdog_rt::time::timeout(GATE_DEADLINE, returned_rx)
        .await
        .unwrap_or_else(|_| panic!("{name}: the unpair of step {unpair} did not end within 30 s"))
        .unwrap_or_else(|_| panic!("{name}: the unpair of step {unpair} failed"));

    let sent = world.take();
    let last_to_device = sent.iter().rposition(|entry| entry[0] == "push" && entry[1].as_str().is_some_and(|client| device.contains(&client)));
    assert!(
        last_to_device.is_some_and(|at| at < returned_at),
        "{name}: the held push went out before the unpair's cleanup returned, and nothing after it: {sent:?}, {returned_at} had gone out at its return"
    );
    let wanted: Vec<Value> = [held, unpair].iter().flat_map(|&number| outcomes[number].as_array().unwrap().iter().cloned()).collect();
    same_on_the_wire(sent, &wanted, &format!("{name}: step {held} held past its check while step {unpair} ran, as Node ran them one after the other"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_push_past_its_check_is_enqueued_before_the_unpairs_cleanup_returns() {
    mixdog_rt::testing::tokens();
    // A frame, to the phone that alone streams the session (the WebRTC signal goes through the same `push_view`).
    forced_push("an unpaired phone that alone streams a session stops the desktop view", 1, 1, 3).await;
}
