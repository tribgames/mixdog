//! The live-view host against Node's recorded scenarios (`fixtures/live-view-host/host.json`,
//! recorded by driving the real `host.ts` and `viewer.ts` of b6f10295a with a scripted sender,
//! sources, signal transport and timers). Every dependency call, in order, and the settle state of
//! every phone signal after each step must equal what Node recorded.
//!
//! Node's pictures went to the sender window as `frame` commands, one in flight per source. The
//! core gives every connection an encoder of its own over the source's shared newest picture, so
//! those commands are not compared one by one: what is compared is what they were for. A
//! connection that comes up on a static page starts from the newest delivered picture, which is
//! the picture Node sent again at `connected`.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::task::Context;
use std::task::Poll;
use std::task::Waker;

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

const HOST: &str = include_str!("../../../../fixtures/live-view-host/host.json");

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
    /// The newest picture of each source, as the encoders read it.
    newest: HashMap<String, Bytes>,
    /// Peer connection id → its source.
    sources: HashMap<String, String>,
    /// What reached the pictures, in order: the host's own calls, and the recording's sender traffic.
    pictures: Vec<Pic>,
}

/// One thing that happened to a source's pictures. `Open` carries the newest picture the host held
/// when the connection came up (where its encoder starts); `Ack` is a sender acknowledgement of the
/// picture in flight and `Node` a picture command Node sent, both read from the recording.
#[derive(Clone, Debug)]
enum Pic {
    Open { connection: String, source: String, newest: Option<String> },
    Close { connection: String },
    Connected { connection: String },
    Picture { source: String, data: String },
    Ack { source: String, honoured: bool },
    Node { source: String, data: String },
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
        {
            let mut script = self.script();
            script.sources.insert(connection_id.to_owned(), source_key.to_owned());
            let newest = script.newest.get(source_key).map(|data| String::from_utf8_lossy(data).into_owned());
            script.pictures.push(Pic::Open { connection: connection_id.to_owned(), source: source_key.to_owned(), newest });
        }
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
        self.script().pictures.push(Pic::Close { connection: connection_id.to_owned() });
        self.command(json!({ "type": "close", "connectionId": connection_id }));
    }

    fn push_picture(&self, source_key: &str, picture: &Picture) {
        let mut script = self.script();
        script.newest.insert(source_key.to_owned(), picture.data.clone());
        script.pictures.push(Pic::Picture { source: source_key.to_owned(), data: String::from_utf8_lossy(&picture.data).into_owned() });
    }

    fn source_closed(&self, source_key: &str) {
        self.script().newest.remove(source_key);
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

fn sender_event(event: &Value) -> Option<SenderEvent> {
    let id = || event["connectionId"].as_str().unwrap().to_owned();
    let key = || event["sourceKey"].as_str().unwrap().to_owned();
    Some(match event["type"].as_str().unwrap() {
        "offer" => SenderEvent::Offer { connection_id: id(), sdp: event["sdp"].as_str().unwrap().to_owned() },
        "candidate" => SenderEvent::Candidate { connection_id: id(), candidate: parse_candidate(&event["candidate"]).unwrap() },
        "connected" => SenderEvent::Connected { connection_id: id(), certificate: Some(event["remoteCertificate"].clone()).filter(|c| !c.is_null()) },
        "failed" => SenderEvent::Failed { connection_id: id(), reason: CloseReason::from_wire(event["reason"].as_str().unwrap()).unwrap() },
        "channel" => SenderEvent::Channel { connection_id: id(), text: event["text"].as_str().unwrap().to_owned(), received_at: event["receivedAt"].as_f64().unwrap() },
        "source-captured" if event["ok"] == json!(true) => SenderEvent::CaptureOk { source_key: key() },
        "source-captured" => SenderEvent::CaptureFailed { source_key: key(), detail: event["detail"].as_str().unwrap_or_default().to_owned() },
        // The sender's per-picture acknowledgement: there is no picture in flight to settle here.
        "frame-done" => return None,
        other => panic!("unknown sender event {other}"),
    })
}

fn settle(slot: &mut [Option<Settle>], step: &Value, what: &str, context: &str) {
    let verdict = if step["ok"] == json!(true) { Ok(()) } else { Err(format!("Error: {}", step["message"].as_str().unwrap_or(what))) };
    let index = step["index"].as_u64().unwrap() as usize;
    slot.get_mut(index).unwrap_or_else(|| panic!("{context}: nothing to settle at {index}")).take().unwrap().send(verdict).ok();
}

fn is_picture_command(entry: &Value) -> bool {
    entry[0] == "sender" && entry[1]["type"] == "frame"
}

fn run_scenario(scenario: &Value) -> usize {
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
    let mut outstanding: HashMap<String, u64> = HashMap::new();
    for (number, (step, want)) in steps.iter().zip(recorded).enumerate() {
        let what = format!("{name} step {number} {}", step["op"]);
        let before = fx.script().trace.len();
        if step["op"] == "sender" && step["event"]["type"] == "connected" {
            let connection = step["event"]["connectionId"].as_str().unwrap().to_owned();
            fx.script().pictures.push(Pic::Connected { connection });
        }
        if step["op"] == "sender" && step["event"]["type"] == "frame-done" {
            // Node ignores an acknowledgement of a picture that is not the one in flight.
            let source = step["event"]["sourceKey"].as_str().unwrap().to_owned();
            let honoured = outstanding.get(&source).copied() == step["event"]["frameId"].as_u64();
            if honoured {
                outstanding.remove(&source);
            }
            fx.script().pictures.push(Pic::Ack { source, honoured });
        }
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
                if let Some(event) = sender_event(&step["event"]) {
                    host.sender_event(event);
                }
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
        for entry in want["trace"].as_array().unwrap().iter().filter(|entry| is_picture_command(entry)) {
            let (source, id) = (entry[1]["sourceKey"].as_str().unwrap().to_owned(), entry[1]["frameId"].as_u64().unwrap());
            outstanding.insert(source.clone(), id);
            fx.script().pictures.push(Pic::Node { source, data: entry[1]["data"].as_str().unwrap().to_owned() });
        }
        let trace: Vec<Value> = fx.script().trace[before..].to_vec();
        let expected: Vec<Value> = want["trace"].as_array().unwrap().iter().filter(|entry| !is_picture_command(entry)).cloned().collect();
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
        // A connection that comes up starts from the newest picture: the one Node sent again.
        if step["op"] == "sender" && step["event"]["type"] == "connected" {
            let resent = want["trace"].as_array().unwrap().iter().find(|entry| is_picture_command(entry));
            if let Some(resent) = resent {
                let source = fx.script().sources.get(step["event"]["connectionId"].as_str().unwrap()).cloned().unwrap();
                let newest = fx.script().newest.get(&source).cloned();
                assert_eq!(newest.as_deref(), resent[1]["data"].as_str().map(str::as_bytes), "{what}: first picture");
            }
        }
    }
    let pictures = fx.script().pictures.clone();
    assert_pictures(name, &pictures)
}

#[test]
fn the_host_behaves_as_nodes_did_in_every_recorded_scenario() {
    let recorded: Value = serde_json::from_str(HOST).unwrap();
    let scenarios = recorded["scenarios"].as_array().unwrap();
    assert_eq!(scenarios.len(), 29);
    let differing: usize = scenarios.iter().map(run_scenario).sum();
    assert_eq!(differing, KNOWN_DIFFERENCES.len(), "every known difference shows, and no other");
}

/// What each connection's picture stream is, per the core's design: an encoder of its own that
/// starts from the source's newest picture when the connection comes up, takes the newest picture
/// whenever it is free and skips the ones that came while it was busy. The encoder is free again when
/// the sender's acknowledgement of the picture in flight arrives (the recording's only completion
/// signal); a failed acknowledgement frees it too. A viewer shows pictures from the moment its
/// connection is up.
fn core_pictures(events: &[Pic]) -> Vec<(String, Vec<String>)> {
    struct Viewer {
        source: String,
        started: bool,
        busy: bool,
        unseen: bool,
        seen: Vec<String>,
    }
    let mut live: Vec<(String, Viewer)> = Vec::new();
    let mut done: Vec<(String, Vec<String>)> = Vec::new();
    let mut newest: HashMap<String, String> = HashMap::new();
    for event in events {
        match event {
            Pic::Open { connection, source, newest: held } => {
                assert_eq!(held, &newest.get(source).cloned(), "{connection}: the encoder starts from the newest picture the source had");
                live.push((connection.clone(), Viewer { source: source.clone(), started: false, busy: false, unseen: false, seen: Vec::new() }));
            }
            Pic::Connected { connection } => {
                for (_, viewer) in live.iter_mut().filter(|(id, _)| id == connection) {
                    viewer.started = true;
                    if let Some(picture) = newest.get(&viewer.source) {
                        viewer.seen.push(picture.clone());
                        viewer.busy = true;
                    }
                }
            }
            Pic::Close { connection } => {
                if let Some(at) = live.iter().position(|(id, _)| id == connection) {
                    let (id, viewer) = live.remove(at);
                    done.push((id, viewer.seen));
                }
            }
            Pic::Picture { source, data } => {
                newest.insert(source.clone(), data.clone());
                for (_, viewer) in live.iter_mut().filter(|(_, v)| v.started && v.source == *source) {
                    if viewer.busy {
                        viewer.unseen = true;
                    } else {
                        viewer.seen.push(data.clone());
                        viewer.busy = true;
                    }
                }
            }
            Pic::Ack { source, honoured: true } => {
                for (_, viewer) in live.iter_mut().filter(|(_, v)| v.started && v.source == *source) {
                    viewer.busy = false;
                    if std::mem::take(&mut viewer.unseen) {
                        viewer.seen.push(newest[source].clone());
                        viewer.busy = true;
                    }
                }
            }
            Pic::Ack { .. } | Pic::Node { .. } => {}
        }
    }
    done.extend(live.into_iter().map(|(id, viewer)| (id, viewer.seen)));
    done.sort();
    done
}

/// What a phone shows of Node's pictures: its sender window fed every connection of the source from
/// one track, so a connection that comes up shows the picture last sent and then each one after.
fn node_pictures(events: &[Pic]) -> Vec<(String, Vec<String>)> {
    let mut live: Vec<(String, String, bool, Vec<String>)> = Vec::new();
    let mut done: Vec<(String, Vec<String>)> = Vec::new();
    let mut sent: HashMap<String, String> = HashMap::new();
    for event in events {
        match event {
            Pic::Open { connection, source, .. } => live.push((connection.clone(), source.clone(), false, Vec::new())),
            Pic::Connected { connection } => {
                for (_, source, up, seen) in live.iter_mut().filter(|(id, ..)| id == connection) {
                    *up = true;
                    if let Some(picture) = sent.get(source) {
                        seen.push(picture.clone());
                    }
                }
            }
            Pic::Close { connection } => {
                if let Some(at) = live.iter().position(|(id, ..)| id == connection) {
                    let (id, _, _, seen) = live.remove(at);
                    done.push((id, seen));
                }
            }
            Pic::Node { source, data } => {
                sent.insert(source.clone(), data.clone());
                for (_, _, _, seen) in live.iter_mut().filter(|(_, of, up, _)| of == source && *up) {
                    seen.push(data.clone());
                }
            }
            _ => {}
        }
    }
    done.extend(live.into_iter().map(|(id, _, _, seen)| (id, seen)));
    done.sort();
    done
}
/// A picture sent again to a viewer that already shows it changes nothing on its screen.
fn distinct(pictures: Vec<(String, Vec<String>)>) -> Vec<(String, Vec<String>)> {
    pictures
        .into_iter()
        .map(|(id, mut seen)| {
            seen.dedup();
            (id, seen)
        })
        .collect()
}

/// Where what a connection shows differs from Node's, once a picture shown twice in a row is one: a
/// connection that comes up while a picture is in flight and a newer one waits. Node's track still
/// holds the last picture it sent, so the phone shows that one until the waiting picture is sent;
/// the core's encoder starts from the newest picture and shows only that. Both end on the same picture.
const KNOWN_DIFFERENCES: [(&str, &str, &[&str], &[&str]); 1] = [(
    "a viewer that connects while a picture is in flight and a newer one waits",
    "connection-id-0002",
    &["AAAA", "CCCC"],
    &["CCCC"],
)];

/// Checks one scenario's pictures and returns how many connections differ from Node.
fn assert_pictures(name: &str, events: &[Pic]) -> usize {
    let (core, node) = (distinct(core_pictures(events)), distinct(node_pictures(events)));
    assert_eq!(core.iter().map(|(id, _)| id).collect::<Vec<_>>(), node.iter().map(|(id, _)| id).collect::<Vec<_>>(), "{name}: the connections");
    let mut differing = 0;
    for ((id, shown), (_, sent)) in core.iter().zip(&node) {
        if shown == sent {
            continue;
        }
        differing += 1;
        let known = KNOWN_DIFFERENCES.iter().any(|(scenario, connection, node, core)| {
            *scenario == name && connection == id && node.iter().eq(sent.iter()) && core.iter().eq(shown.iter())
        });
        assert!(known, "{name}: {id} shows {shown:?} where Node showed {sent:?}");
    }
    differing
}