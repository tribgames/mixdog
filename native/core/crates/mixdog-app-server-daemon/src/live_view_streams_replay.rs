//! The phones' browser streams and JPEG view, served by the live view, against Node's recording (`fixtures/browser-streams`,
//! `record-browser-streams.mjs`): Node's relay-client call dispatch, stream pacing and WebRTC relay at b6f10295a, driven by the
//! same inputs on a virtual clock.
//!
//! Each recorded step reaches the service where its Node counterpart reached Node's relay: a phone's `browserRemoteStream` call
//! is a `browser/stream` request on that phone's connection, its `browserRemoteStreamAck` a `browser/streamAck` notification, a
//! desktop frame the host's `host/browser/frame` facts followed by the X17 picture on the session's stream, a departed phone the
//! connection's close, a time step the clock's advance, and the WebRTC hand-over steps the service's own relay (`accept`, `send`).
//! What each step did is compared, whole and in order, with what Node did: the reply the phone got, the pushes it got
//! (`browser/frame` is Node's `browserRemoteFrame` event, `browser/webrtcSignal` its `browserRemoteWebrtc`), the view requests the
//! desktop got (`host/browser/viewFrames`: `on` with its request is Node's `stream` request with those options, `off` its
//! `null`), and the relay's answers and state.

use std::collections::BTreeMap;

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

/// The desktop: its view requests in Node's form; anything else it is asked is logged as it came, so it can only fail the comparison.
struct Desktop(Log);

#[async_trait]
impl HostChannel for Desktop {
    async fn request(&self, _capability: HostCapability, method: Method, params: Value) -> Result<Value, HostError> {
        lock(&self.0).push(json!(["host", method.as_str(), params]));
        Ok(json!({}))
    }

    fn notify(&self, _capability: HostCapability, method: Method, params: Value) -> Result<(), CoreError> {
        let entry = if method.as_str() == "host/browser/viewFrames" {
            let options = if params["on"] == json!(true) { params["request"].clone() } else { Value::Null };
            json!(["request", params["tabId"], options])
        } else {
            json!(["host", method.as_str(), params])
        };
        lock(&self.0).push(entry);
        Ok(())
    }
}

/// The phones: each push in Node's form (`{event, payload}` of the relay's encrypted push).
struct Phones(Log);

impl ConnectionNotifier for Phones {
    fn notify(&self, to: ConnectionId, method: Method, params: Value) -> Result<(), CoreError> {
        let pushed = match method.as_str() {
            "browser/frame" => json!({ "event": "browserRemoteFrame", "payload": params["frame"] }),
            "browser/webrtcSignal" => json!({ "event": "browserRemoteWebrtc", "payload": params["signal"] }),
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

async fn replay(scenario: &Value, dir: &std::path::Path, clock_start: f64) {
    let name = scenario["name"].as_str().unwrap();
    let log: Log = Arc::default();
    let media = HostMedia::new(1 << 20);
    let clock = VirtualClock::starting_at(clock_start);
    let service = LiveViewService::with_clock(
        Arc::new(Desktop(log.clone())),
        Arc::new(Phones(log.clone())),
        media.clone(),
        runtime(dir),
        Arc::new(Scripted::default()),
        Arc::new(PairedScreenAccess::new(Arc::new(|_| None), Arc::new(|_| false))),
        clock.clone(),
    );
    let mut id = 0;
    let steps = scenario["steps"].as_array().unwrap();
    let recorded = scenario["recorded"].as_array().unwrap();
    assert_eq!(steps.len(), recorded.len(), "{name}: a recorded outcome per step");
    for (number, (step, want)) in steps.iter().zip(recorded).enumerate() {
        let what = format!("{name} step {number} {step}");
        match step["op"].as_str().unwrap() {
            "call" => {
                let client = step["client"].as_str().unwrap();
                let connection = connection_of(client);
                let params = &step["params"];
                match step["method"].as_str().unwrap() {
                    "browserRemoteStream" => {
                        id += 1;
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
            "frame" => send_frame(&service, &media, &step["frame"]),
            "advance" => clock.advance(step["ms"].as_f64().unwrap()),
            "leave" => service.connection_closed(ConnectionId(connection_of(step["client"].as_str().unwrap()))),
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
        let got = std::mem::take(&mut *lock(&log));
        assert_eq!(Value::Array(got), *want, "{what}");
    }
}

#[tokio::test]
async fn the_live_view_serves_nodes_recorded_browser_streams() {
    mixdog_rt::testing::tokens();
    let recorded: Value = serde_json::from_str(STREAMS).unwrap();
    let scenarios = recorded["scenarios"].as_array().unwrap();
    assert!(!scenarios.is_empty(), "the recording holds scenarios");
    let clock_start = recorded["clockStart"].as_f64().unwrap();
    let dir = tempfile::tempdir().unwrap();
    for scenario in scenarios {
        replay(scenario, dir.path(), clock_start).await;
    }
}
