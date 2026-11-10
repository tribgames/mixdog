//! The phones' browser streams and JPEG view, served by the live view, against Node's recording (`fixtures/browser-streams`,
//! `record-browser-streams.mjs`): Node's relay-client call dispatch, stream pacing and WebRTC relay at b6f10295a, driven by the
//! same inputs on a virtual clock.
//!
//! Each recorded step reaches the service where its Node counterpart reached Node's relay: a phone's `browserRemoteStream` call
//! is a `browser/stream` request on that phone's connection, its `browserRemoteStreamAck` a `browser/streamAck` notification, a
//! desktop frame the host's `host/browser/frame` facts followed by the X17 picture on the session's stream, a departed phone the
//! connection's close, a time step the clock's advance, and the WebRTC hand-over steps the service's own relay (`accept`, `send`).
//! A device's unpair is the live view's `unpaired` for each of its connections (what the unpair's device cleanup calls,
//! `PairedDeviceCleanup::unpaired`), Node's `dropClient`; the relay's close is its `relay_closed`, Node's `dispose`.
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

/// The phones: each push under the name table above, as the relay's encrypted push `{event, payload}`.
struct Phones(Log);

impl ConnectionNotifier for Phones {
    fn notify(&self, to: ConnectionId, method: Method, params: Value) -> Result<(), CoreError> {
        let pushed = match method.as_str() {
            "browser/frame" => json!({ "event": "browserRemoteFrame", "payload": params }),
            "browser/webrtcSignal" if keys(&params) == ["signal"] => json!({ "event": "browserRemoteWebrtc", "payload": params["signal"] }),
            other => json!({ "unexpected": other, "params": params }),
        };
        lock(&self.0).push(json!(["push", client_name(to.0), pushed]));
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
    /// Connections whose device's unpair is in force (the registry's `screen_revoked`), for the send-time refusal.
    revoked: Arc<Mutex<HashSet<u64>>>,
}

impl World {
    fn new(dir: &std::path::Path, clock_start: f64) -> Arc<Self> {
        let log: Log = Arc::default();
        let media = HostMedia::new(1 << 20);
        let clock = VirtualClock::starting_at(clock_start);
        let revoked: Arc<Mutex<HashSet<u64>>> = Arc::default();
        let held = revoked.clone();
        let service = Arc::new(LiveViewService::with_clock(
            Arc::new(Desktop { log: log.clone(), streams: Mutex::default() }),
            Arc::new(Phones(log.clone())),
            media.clone(),
            runtime(dir),
            Arc::new(Scripted::default()),
            Arc::new(PairedScreenAccess::new(Arc::new(|_| None), Arc::new(move |connection| lock(&held).contains(&connection.0)), Arc::new(|_| true))),
            clock.clone(),
        ));
        Arc::new(Self { service, media, clock, log, ids: Default::default(), revoked })
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
            "leave" => service.connection_closed(ConnectionId(connection_of(step["client"].as_str().unwrap()))),
            "dropClient" => service.unpaired(ConnectionId(connection_of(step["client"].as_str().unwrap()))),
            "dispose" => service.relay_closed(),
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

/// Runs steps one after the other, each compared with its recorded outcome.
async fn replay_steps(world: &World, name: &str, steps: &[Value], outcomes: &[Value], from: usize) {
    for (number, (step, want)) in steps.iter().zip(outcomes).enumerate() {
        let what = format!("{name} step {} {step}", from + number);
        world.step(step, &what).await;
        same_on_the_wire(world.take(), want.as_array().unwrap(), &what);
    }
}

#[tokio::test]
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

/// A phone whose device was unpaired is sent no frame even when the unpair's drop of its subscriptions never reached the streams: the
/// send itself asks whether the connection may still see the view. Node's recorded unpair scenario is replayed up to the unpair; then
/// only the registry's revocation happens (the drop is missed) and the rest of the scenario's steps run: phone_A, whose frame was in
/// flight and whose resend was armed, must get nothing from the frame and the resend that follow.
#[tokio::test]
async fn a_phone_whose_unpair_was_missed_is_sent_no_frame() {
    mixdog_rt::testing::tokens();
    let (recorded, clock_start) = recording();
    let name = "an unpaired phone is dropped at once, its frame in flight and its resend with it";
    let (steps, outcomes) = scenario(&recorded, name);
    let unpair = steps.iter().position(|step| step["op"] == "dropClient").expect("the scenario unpairs a phone");
    let dir = tempfile::tempdir().unwrap();
    let world = World::new(dir.path(), clock_start);
    replay_steps(&world, name, &steps[..unpair], &outcomes[..unpair], 0).await;
    let phone = steps[unpair]["client"].as_str().unwrap();
    lock(&world.revoked).insert(connection_of(phone));
    for (number, step) in steps.iter().enumerate().skip(unpair + 1) {
        world.step(step, &format!("{name} step {number}")).await;
    }
    let to_phone: Vec<Value> = world.take().into_iter().filter(|entry| entry[0] == "push" && entry[1] == phone).collect();
    assert_eq!(to_phone, Vec::<Value>::new(), "a frame reached {phone} after its device was unpaired");
}

/// The orders the streams keep when two steps race: the first step of each pair is held on its own thread at the point it releases
/// the streams' state (its change made, its effects not yet delivered), the next steps run meanwhile, then the held one goes on.
/// Everything sent must be what Node sent running the same steps one after the other (`gate: …` scenarios): the effects of a change
/// leave before those of every later change, never after.
const GATED: [(&str, usize, usize); 5] = [
    ("gate: a lapse, then a fresh subscribe", 1, 2),
    ("gate: a resend, then an unsubscribe", 3, 4),
    ("gate: an ack, then a newer frame resent", 3, 5),
    ("gate: a resend, then a phone joins", 3, 4),
    ("gate: a fit failure, then a renewal", 1, 2),
];

const HELD: &str = "held-step";
const GATE_DEADLINE: Duration = Duration::from_secs(30);

async fn gated(name: &str, held: usize, last: usize) {
    let (recorded, clock_start) = recording();
    let (steps, outcomes) = scenario(&recorded, name);
    let dir = tempfile::tempdir().unwrap();
    let world = World::new(dir.path(), clock_start);
    replay_steps(&world, name, &steps[..held], &outcomes[..held], 0).await;

    let (reached_tx, reached_rx) = tokio::sync::oneshot::channel::<()>();
    let (go_tx, go_rx) = std::sync::mpsc::channel::<()>();
    let (reached_tx, go_rx, fired) = (Mutex::new(Some(reached_tx)), Mutex::new(go_rx), AtomicBool::new(false));
    *lock(&world.service.inner.streams().released) = Some(Arc::new(move || {
        if std::thread::current().name() != Some(HELD) || fired.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Some(reached) = lock(&reached_tx).take() {
            let _ = reached.send(());
        }
        lock(&go_rx).recv_timeout(GATE_DEADLINE).expect("the test let the held step go on within 30 s");
    }));
    let (done_tx, done_rx) = tokio::sync::oneshot::channel::<()>();
    let (runtime, held_world, held_step) = (tokio::runtime::Handle::current(), world.clone(), steps[held].clone());
    std::thread::Builder::new()
        .name(HELD.to_owned())
        .spawn(move || {
            runtime.block_on(held_world.step(&held_step, "the held step"));
            let _ = done_tx.send(());
        })
        .unwrap();
    tokio::time::timeout(GATE_DEADLINE, reached_rx)
        .await
        .unwrap_or_else(|_| panic!("{name}: the held step {held} did not release the streams' state within 30 s"))
        .unwrap_or_else(|_| panic!("{name}: the held step {held} ended before it released the streams' state"));
    for step in &steps[held + 1..=last] {
        world.step(step, &format!("{name} step {step}")).await;
    }
    go_tx.send(()).unwrap();
    tokio::time::timeout(GATE_DEADLINE, done_rx)
        .await
        .unwrap_or_else(|_| panic!("{name}: the held step {held} did not finish within 30 s of going on"))
        .unwrap_or_else(|_| panic!("{name}: the held step {held} failed"));
    let want: Vec<Value> = outcomes[held..=last].iter().flat_map(|outcome| outcome.as_array().unwrap().iter().cloned()).collect();
    same_on_the_wire(world.take(), &want, &format!("{name}: steps {held}..={last}, step {held} held at its release"));
}

#[tokio::test(flavor = "multi_thread")]
async fn racing_steps_send_in_the_order_their_changes_were_made() {
    mixdog_rt::testing::tokens();
    for (name, held, last) in GATED {
        gated(name, held, last).await;
    }
}
