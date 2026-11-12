//! The live-view host against Node's recorded scenarios (`fixtures/live-view-host/host.json`,
//! recorded by driving the real `host.ts` and `viewer.ts` of b6f10295a with a scripted sender,
//! sources, signal transport and timers). Every dependency call, in order, and the settle state of
//! every phone signal after each step must equal what Node recorded.
//!
//! Node's pictures went to the sender window as `frame` commands, one in flight per source, each
//! acknowledged by `frame-done`; the host hands them over the same way, and they are compared with
//! every other call. The sender window's envelope of a picture (pixel size, mime type) is not the
//! host's: only `type`, `sourceKey`, `frameId` and `data` of a recorded frame command are compared.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::task::Context;
use std::task::Poll;

use async_trait::async_trait;
use bytes::Bytes;
use futures::channel::oneshot;
use futures::future::BoxFuture;
use futures::task::ArcWake;
use mixdog_remote::webrtc::config::Candidate;
use mixdog_remote::webrtc::config::IceServer;
use mixdog_remote::webrtc::host::HostEnv;
use mixdog_remote::webrtc::host::LiveHost;
use mixdog_remote::webrtc::host::Picture;
use mixdog_remote::webrtc::host::SenderEvent;
use mixdog_remote::webrtc::host::VideoSource;
use mixdog_remote::webrtc::signal::ClientSignal;
use mixdog_remote::webrtc::signal::CloseReason;
use mixdog_remote::webrtc::signal::DesktopSignal;
use mixdog_remote::webrtc::signal::Geometry;
use mixdog_remote::webrtc::signal::ICE_TRANSPORT_POLICY;
use mixdog_remote::webrtc::signal::Resize;
use mixdog_remote::webrtc::signal::Source;
use mixdog_remote::webrtc::signal::VideoLimit;
use mixdog_remote::webrtc::signal::candidate_json;
use mixdog_remote::webrtc::signal::ice_servers_json;
use mixdog_remote::webrtc::signal::parse_candidate;
use mixdog_remote::webrtc::signal::parse_ice_servers;
use serde_json::Value;
use serde_json::json;

const HOST: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/live-view-host/host.json");

type Settle = oneshot::Sender<Result<(), String>>;

#[derive(Default)]
struct Script {
    trace: Vec<Value>,
    pages: HashMap<String, (Option<String>, Option<Geometry>)>,
    streamed: HashMap<String, bool>,
    hold_signals: bool,
    clock: f64,
    timer_seq: u64,
    timers: HashMap<u64, Arc<dyn Fn(u64) + Send + Sync>>,
    id_seq: u64,
    dispatches: Vec<Option<Settle>>,
    resizes: Vec<Option<Settle>>,
    sends: Vec<Option<Settle>>,
    tasks: Vec<BoxFuture<'static, ()>>,
}

#[derive(Clone, Default)]
struct Fx(Arc<Mutex<Script>>);

impl Fx {
    fn script(&self) -> std::sync::MutexGuard<'_, Script> {
        self.0.lock().unwrap()
    }

    fn log(&self, entry: Value) {
        self.script().trace.push(entry);
    }

    fn command(&self, command: Value) {
        self.log(json!(["sender", command]));
    }
}

fn settled(receiver: oneshot::Receiver<Result<(), String>>) -> BoxFuture<'static, Result<(), String>> {
    Box::pin(async move { receiver.await.expect("the scenario keeps its settlement") })
}

impl HostEnv for Fx {
    fn spawn(&self, work: BoxFuture<'static, ()>) {
        self.script().tasks.push(work);
    }

    fn send_signal(&self, client: &str, signal: &DesktopSignal) -> BoxFuture<'static, Result<(), String>> {
        self.log(json!(["sendSignal", client, signal.to_json()]));
        if !self.script().hold_signals {
            return Box::pin(async { Ok(()) });
        }
        let (settle, receiver) = oneshot::channel();
        self.script().sends.push(Some(settle));
        settled(receiver)
    }

    fn source(&self, source: &Source, client: &str, signal: &str) -> Option<Arc<dyn VideoSource>> {
        self.log(json!(["resolve", source.to_json(), { "clientId": client, "signal": signal }]));
        let key = source.key();
        match source {
            Source::Browser { .. } if self.script().streamed.get(&key).copied().unwrap_or(false) => Some(Arc::new(Page { fx: self.clone(), key })),
            _ => None,
        }
    }

    fn open(&self, connection_id: &str, source_key: &str, ice_servers: &[IceServer], receive_codecs: &[String]) {
        self.command(json!({
            "type": "open",
            "connectionId": connection_id,
            "sourceKey": source_key,
            "iceServers": ice_servers_json(ice_servers),
            "iceTransportPolicy": ICE_TRANSPORT_POLICY,
            "receiveCodecs": receive_codecs,
        }));
    }

    fn answer(&self, connection_id: &str, sdp: &str) {
        self.command(json!({ "type": "answer", "connectionId": connection_id, "sdp": sdp }));
    }

    fn candidate(&self, connection_id: &str, candidate: &Option<Candidate>) {
        self.command(json!({ "type": "candidate", "connectionId": connection_id, "candidate": candidate_json(candidate) }));
    }

    fn channel_send(&self, connection_id: &str, text: &str) {
        self.command(json!({ "type": "channel-send", "connectionId": connection_id, "text": text }));
    }

    fn close(&self, connection_id: &str) {
        self.command(json!({ "type": "close", "connectionId": connection_id }));
    }

    fn push_picture(&self, source_key: &str, frame_id: u64, picture: &Picture) {
        self.command(json!({ "type": "frame", "sourceKey": source_key, "frameId": frame_id, "data": String::from_utf8_lossy(&picture.data) }));
    }

    fn source_closed(&self, source_key: &str) {
        self.command(json!({ "type": "source-close", "sourceKey": source_key }));
    }

    fn report(&self, event: &str, data: Value) {
        self.log(json!(["report", event, data]));
    }

    fn new_connection_id(&self) -> String {
        let mut script = self.script();
        script.id_seq += 1;
        format!("connection-id-{:04}", script.id_seq)
    }

    fn now(&self) -> f64 {
        self.script().clock
    }

    fn set_timer(&self, ms: u64, run: Arc<dyn Fn(u64) + Send + Sync>) -> u64 {
        let mut script = self.script();
        script.timer_seq += 1;
        let handle = script.timer_seq;
        script.timers.insert(handle, run);
        script.trace.push(json!(["setTimer", handle, ms]));
        handle
    }

    fn clear_timer(&self, handle: u64) {
        let mut script = self.script();
        script.timers.remove(&handle);
        script.trace.push(json!(["clearTimer", handle]));
    }
}

struct Page {
    fx: Fx,
    key: String,
}

#[async_trait]
impl VideoSource for Page {
    fn start(&self) {
        self.fx.log(json!(["source", self.key, "start"]));
    }

    fn stop(&self) {
        self.fx.log(json!(["source", self.key, "stop"]));
    }

    fn page(&self) -> (Option<String>, Option<Geometry>) {
        self.fx.script().pages.get(&self.key).cloned().unwrap_or_default()
    }

    async fn dispatch(&self, control: &Value) -> Result<(), String> {
        let (settle, receiver) = oneshot::channel();
        {
            let mut script = self.fx.script();
            script.dispatches.push(Some(settle));
            script.trace.push(json!(["source", self.key, "dispatch", control]));
        }
        settled(receiver).await
    }

    async fn resize(&self, request: &Resize) -> Result<(), String> {
        let (settle, receiver) = oneshot::channel();
        {
            let mut script = self.fx.script();
            script.resizes.push(Some(settle));
            script.trace.push(json!(["source", self.key, "resize", request.to_json()]));
        }
        settled(receiver).await
    }

    fn video_limit(&self, limit: VideoLimit) {
        self.fx.log(json!(["source", self.key, "videoLimit", { "maxWidth": limit.max_width, "maxHeight": limit.max_height }]));
    }
}

struct Call {
    work: Pin<Box<dyn Future<Output = Result<(), String>> + Send>>,
    state: Option<Result<(), String>>,
}

struct Woken(AtomicBool);

impl ArcWake for Woken {
    fn wake_by_ref(woken: &Arc<Self>) {
        woken.0.store(true, Ordering::SeqCst);
    }
}

/// Polls everything the host spawned and every pending phone signal until nothing can move: a round
/// ends the flush only when no task was woken, none was spawned and no call finished in it. The
/// scenario's own settlements are the only thing that makes anything wait.
fn flush(fx: &Fx, calls: &mut [Call]) {
    let woken = Arc::new(Woken(AtomicBool::new(false)));
    let waker = futures::task::waker(woken.clone());
    let mut cx = Context::from_waker(&waker);
    loop {
        woken.0.store(false, Ordering::SeqCst);
        let tasks = std::mem::take(&mut fx.script().tasks);
        let mut pending = Vec::new();
        for mut task in tasks {
            if task.as_mut().poll(&mut cx).is_pending() {
                pending.push(task);
            }
        }
        let mut spawned = {
            let mut script = fx.script();
            let spawned = !script.tasks.is_empty();
            pending.append(&mut script.tasks);
            script.tasks = pending;
            spawned
        };
        let known = fx.script().tasks.len();
        let mut finished = false;
        for call in calls.iter_mut().filter(|call| call.state.is_none()) {
            if let Poll::Ready(outcome) = call.work.as_mut().poll(&mut cx) {
                call.state = Some(outcome);
                finished = true;
            }
        }
        // A call that spawned work while it was polled has handed it over for the next round.
        spawned |= fx.script().tasks.len() > known;
        if !(woken.0.load(Ordering::SeqCst) || spawned || finished) {
            return;
        }
    }
}
fn geometry(value: &Value) -> Option<Geometry> {
    (!value.is_null()).then(|| Geometry::parse(value).unwrap())
}

fn sender_event(event: &Value) -> SenderEvent {
    let id = || event["connectionId"].as_str().unwrap().to_owned();
    let key = || event["sourceKey"].as_str().unwrap().to_owned();
    match event["type"].as_str().unwrap() {
        "offer" => SenderEvent::Offer { connection_id: id(), sdp: event["sdp"].as_str().unwrap().to_owned() },
        "candidate" => SenderEvent::Candidate { connection_id: id(), candidate: parse_candidate(&event["candidate"]).unwrap() },
        "connected" => SenderEvent::Connected { connection_id: id(), certificate: Some(event["remoteCertificate"].clone()).filter(|c| !c.is_null()) },
        "failed" => SenderEvent::Failed { connection_id: id(), reason: CloseReason::from_wire(event["reason"].as_str().unwrap()).unwrap() },
        "channel" => SenderEvent::Channel { connection_id: id(), text: event["text"].as_str().unwrap().to_owned(), received_at: event["receivedAt"].as_f64().unwrap() },
        "source-captured" if event["ok"] == json!(true) => SenderEvent::CaptureOk { source_key: key() },
        "source-captured" => SenderEvent::CaptureFailed { source_key: key(), detail: event["detail"].as_str().unwrap_or_default().to_owned() },
        "frame-done" => SenderEvent::FrameDone { source_key: key(), frame_id: event["frameId"].as_u64().unwrap(), ok: event["ok"] == json!(true) },
        other => panic!("unknown sender event {other}"),
    }
}

fn settle(slot: &mut [Option<Settle>], step: &Value, what: &str, context: &str) {
    let verdict = if step["ok"] == json!(true) { Ok(()) } else { Err(format!("Error: {}", step["message"].as_str().unwrap_or(what))) };
    let index = step["index"].as_u64().unwrap() as usize;
    slot.get_mut(index).unwrap_or_else(|| panic!("{context}: nothing to settle at {index}")).take().unwrap().send(verdict).ok();
}

/// A recorded command as the host makes it: a frame command is reduced to what the host owns.
fn host_command(entry: &Value) -> Value {
    if entry[0] != "sender" || entry[1]["type"] != "frame" {
        return entry.clone();
    }
    let frame = &entry[1];
    json!(["sender", { "type": "frame", "sourceKey": frame["sourceKey"], "frameId": frame["frameId"], "data": frame["data"] }])
}

fn run_scenario(scenario: &Value) {
    let name = scenario["name"].as_str().unwrap();
    let fx = Fx::default();
    {
        let mut script = fx.script();
        script.clock = 1_000_000.0;
        script.hold_signals = scenario["options"]["holdSignals"] == json!(true);
        for key in ["browser:sess_1", "browser:sess_2"] {
            script.pages.insert(key.to_owned(), (None, None));
            script.streamed.insert(key.to_owned(), true);
        }
    }
    let host = LiveHost::new(Arc::new(fx.clone()));
    let mut calls: Vec<Call> = Vec::new();
    let steps = scenario["steps"].as_array().unwrap();
    let recorded = scenario["recorded"].as_array().unwrap();
    assert_eq!(steps.len(), recorded.len(), "{name}");
    for (number, (step, want)) in steps.iter().zip(recorded).enumerate() {
        let what = format!("{name} step {number} {}", step["op"]);
        let before = fx.script().trace.len();
        match step["op"].as_str().unwrap() {
            "page" => {
                let page = (step["documentId"].as_str().map(str::to_owned), geometry(&step["geometry"]));
                fx.script().pages.insert(step["key"].as_str().unwrap().to_owned(), page);
            }
            "streamed" => {
                fx.script().streamed.insert(step["key"].as_str().unwrap().to_owned(), step["value"] == json!(true));
            }
            "tick" => fx.script().clock += step["ms"].as_f64().unwrap(),
            "signal" => {
                let client = step["client"].as_str().unwrap().to_owned();
                let ice = match &step["iceServers"] {
                    Value::Array(_) => parse_ice_servers(&step["iceServers"]).unwrap(),
                    _ => Vec::new(),
                };
                let host = host.clone();
                let parsed = ClientSignal::parse(&step["raw"]);
                // Node checks the client id before it parses the signal; a malformed signal and an invalid client are never in one step.
                let work: Pin<Box<dyn Future<Output = Result<(), String>> + Send>> = match parsed {
                    Ok(signal) => Box::pin(async move { host.signal(&client, &signal, &ice).await }),
                    Err(error) => Box::pin(async move { Err(error) }),
                };
                calls.push(Call { work, state: None });
            }
            "sender" => {
                host.sender_event(sender_event(&step["event"]));
            }
            "senderGone" => host.sender_event(SenderEvent::Gone),
            "viewerLeft" => host.viewer_left(step["client"].as_str().unwrap(), step["sourceKey"].as_str().unwrap()),
            "geometryChanged" => host.geometry_changed(step["sourceKey"].as_str().unwrap(), geometry(&step["geometry"]).as_ref()),
            "frame" => {
                let picture = &step["picture"];
                host.frame(
                    step["sourceKey"].as_str().unwrap(),
                    Picture {
                        document_id: picture["documentId"].as_str().map(str::to_owned),
                        generation: picture["geometry"]["generation"].as_u64().unwrap(),
                        data: Bytes::from(picture["data"].as_str().unwrap().to_owned()),
                    },
                );
            }
            "channelPush" => host.channel_push(step["sourceKey"].as_str().unwrap(), step["text"].as_str().unwrap()),
            "dispose" => host.dispose(),
            "fireTimer" => {
                let handle = step["handle"].as_u64().unwrap();
                let run = fx.script().timers.remove(&handle);
                match run {
                    Some(run) => run(handle),
                    None => fx.log(json!(["noTimer", handle])),
                }
            }
            "dispatchDone" => {
                let mut script = fx.script();
                settle(&mut script.dispatches, step, "dispatch failed", &what);
            }
            "resizeDone" => {
                let mut script = fx.script();
                settle(&mut script.resizes, step, "resize failed", &what);
            }
            "sendDone" => {
                let mut script = fx.script();
                settle(&mut script.sends, step, "send failed", &what);
            }
            other => panic!("unknown host op {other}"),
        }
        flush(&fx, &mut calls);
        let trace: Vec<Value> = fx.script().trace[before..].to_vec();
        let expected: Vec<Value> = want["trace"].as_array().unwrap().iter().map(host_command).collect();
        assert_eq!(json!(trace), json!(expected), "{what}: calls");
        let states: Vec<String> = calls
            .iter()
            .map(|call| match &call.state {
                None => "pending".to_owned(),
                Some(Ok(())) => "ok".to_owned(),
                Some(Err(error)) => format!("threw:{error}"),
            })
            .collect();
        assert_eq!(json!(states), want["signals"], "{what}: settled");
    }
}

#[test]
fn the_host_behaves_as_nodes_did_in_every_recorded_scenario() {
    let recorded: Value = serde_json::from_str(&HOST).unwrap();
    let scenarios = recorded["scenarios"].as_array().unwrap();
    assert_eq!(scenarios.len(), 30);
    scenarios.iter().for_each(run_scenario);
}
