//! The live-view viewer against Node's recorded scenarios (`fixtures/live-view/viewer.json`,
//! recorded by driving the real `viewer.ts` of b6f10295a with a scripted page, clock, timers and
//! dispatch results). Every effect, in order, and the viewer's position after each step must
//! equal what Node recorded.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;
use std::task::Context;
use std::task::Waker;

use async_trait::async_trait;
use mixdog_remote::webrtc::config::Candidate;
use mixdog_remote::webrtc::config::IceServer;
use mixdog_remote::webrtc::signal::ClientSignal;
use mixdog_remote::webrtc::signal::CloseReason;
use mixdog_remote::webrtc::signal::DesktopSignal;
use mixdog_remote::webrtc::signal::Geometry;
use mixdog_remote::webrtc::signal::Source;
use mixdog_remote::webrtc::signal::candidate_json;
use mixdog_remote::webrtc::signal::ice_servers_json;
use mixdog_remote::webrtc::signal::parse_candidate;
use mixdog_remote::webrtc::signal::parse_ice_servers;
use mixdog_remote::webrtc::viewer::Page;
use mixdog_remote::webrtc::viewer::Viewer;
use mixdog_remote::webrtc::viewer::ViewerEffects;
use serde_json::Value;
use serde_json::json;
use tokio::sync::oneshot;

const VIEWER: &str = include_str!("../../../../fixtures/live-view/viewer.json");

#[derive(Default)]
struct Script {
    trace: Vec<Value>,
    page: Page,
    clock: f64,
    timer_seq: u64,
    timers: Vec<u64>,
    id_seq: u64,
    dispatches: Vec<Option<oneshot::Sender<Result<(), String>>>>,
    releases: Vec<Option<oneshot::Sender<()>>>,
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
}

#[async_trait]
impl ViewerEffects for Fx {
    fn signal(&self, signal: &DesktopSignal) {
        self.log(json!(["signal", signal.to_json()]));
    }

    fn open(&self, connection_id: &str, ice_servers: &[IceServer], receive_codecs: &[String]) {
        self.log(json!(["open", { "connectionId": connection_id, "iceServers": ice_servers_json(ice_servers), "receiveCodecs": receive_codecs }]));
    }

    fn answer(&self, connection_id: &str, sdp: &str) {
        self.log(json!(["answer", connection_id, sdp]));
    }

    fn candidate(&self, connection_id: &str, candidate: &Option<Candidate>) {
        self.log(json!(["candidate", connection_id, candidate_json(candidate)]));
    }

    fn channel_send(&self, connection_id: &str, text: &str) {
        self.log(json!(["channelSend", connection_id, text]));
    }

    fn close(&self, connection_id: &str) {
        self.log(json!(["close", connection_id]));
    }

    async fn dispatch(&self, control: &Value) -> Result<(), String> {
        let (settle, settled) = oneshot::channel();
        {
            let mut script = self.script();
            script.dispatches.push(Some(settle));
            script.trace.push(json!(["dispatch", control]));
        }
        settled.await.expect("the scenario keeps its settlement")
    }

    async fn release(&self, releases: Vec<Value>) {
        let (settle, settled) = oneshot::channel();
        {
            let mut script = self.script();
            script.releases.push(Some(settle));
            script.trace.push(json!(["release", releases]));
        }
        settled.await.expect("the scenario keeps its settlement");
    }

    fn page(&self) -> Page {
        self.script().page.clone()
    }

    fn new_connection_id(&self) -> String {
        let mut script = self.script();
        script.id_seq += 1;
        format!("connection-id-{:04}", script.id_seq)
    }

    fn now(&self) -> f64 {
        self.script().clock
    }

    fn set_timer(&self, ms: u64) -> u64 {
        let mut script = self.script();
        script.timer_seq += 1;
        let handle = script.timer_seq;
        script.timers.push(handle);
        script.trace.push(json!(["setTimer", handle, ms]));
        handle
    }

    fn clear_timer(&self, handle: u64) {
        let mut script = self.script();
        script.timers.retain(|armed| *armed != handle);
        script.trace.push(json!(["clearTimer", handle]));
    }

    fn report(&self, event: &str, data: Value) {
        self.log(json!(["report", event, data]));
    }

    fn receiver_stats(&self, stats: &Value) {
        self.log(json!(["receiverStats", stats]));
    }

    fn promoted(&self) {
        self.log(json!(["promoted"]));
    }
}

fn browser(source: &Value) -> Source {
    Source::parse(source).expect("the recorded source is valid")
}

fn page_from(step: &Value) -> Page {
    Page {
        document_id: step["documentId"].as_str().map(str::to_owned),
        geometry: (!step["geometry"].is_null()).then(|| Geometry::parse(&step["geometry"]).unwrap()),
        frames_since_current: step["framesSinceCurrent"].as_u64().unwrap_or(0),
    }
}

fn codecs(step: &Value) -> Vec<String> {
    step["receiveCodecs"].as_array().unwrap().iter().map(|c| c.as_str().unwrap().to_owned()).collect()
}

fn reason(name: &Value) -> CloseReason {
    CloseReason::from_wire(name.as_str().unwrap()).unwrap()
}

type Lane<'a> = Option<Pin<Box<dyn Future<Output = ()> + 'a>>>;

/// Runs the dispatch lane as far as it can go, as the host would.
fn flush<'a>(fx: &Fx, viewer: &'a Viewer<Fx>, lane: &mut Lane<'a>) {
    let mut cx = Context::from_waker(Waker::noop());
    loop {
        let before = fx.script().trace.len();
        if lane.is_none() && viewer.wants_pump() {
            *lane = Some(Box::pin(viewer.pump()));
        }
        let Some(running) = lane.as_mut() else { return };
        if running.as_mut().poll(&mut cx).is_ready() {
            *lane = None;
        }
        if lane.is_some() && before == fx.script().trace.len() {
            return;
        }
    }
}

fn run_scenario(scenario: &Value) {
    let name = scenario["name"].as_str().unwrap();
    let fx = Fx::default();
    fx.script().clock = 1_000_000.0;
    let viewer = Viewer::new(browser(&scenario["source"]), fx.clone()).unwrap();
    let mut lane: Lane<'_> = None;
    let steps = scenario["steps"].as_array().unwrap();
    let recorded = scenario["recorded"].as_array().unwrap();
    assert_eq!(steps.len(), recorded.len(), "{name}");
    for (number, (step, want)) in steps.iter().zip(recorded).enumerate() {
        let what = format!("{name} step {number} {}", step["op"]);
        let before = fx.script().trace.len();
        let outcome: Result<(), String> = match step["op"].as_str().unwrap() {
            "page" => {
                fx.script().page = page_from(step);
                Ok(())
            }
            "tick" => {
                fx.script().clock += step["ms"].as_f64().unwrap();
                Ok(())
            }
            "ready" => viewer.ready(codecs(step), parse_ice_servers(&step["iceServers"]).unwrap()),
            "geometryChanged" => viewer.geometry_changed(),
            "geometryAck" => {
                viewer.geometry_ack(step["generation"].as_u64().unwrap());
                Ok(())
            }
            "signal" => viewer.signal(&ClientSignal::parse(&step["raw"]).unwrap()),
            "senderOffer" => viewer.sender_offer(step["connectionId"].as_str().unwrap(), step["sdp"].as_str().unwrap()),
            "senderCandidate" => {
                viewer.sender_candidate(step["connectionId"].as_str().unwrap(), parse_candidate(&step["candidate"]).unwrap());
                Ok(())
            }
            "senderConnected" => viewer.sender_connected(step["connectionId"].as_str().unwrap(), Some(&step["certificate"]).filter(|c| !c.is_null())),
            "senderFailed" => viewer.sender_failed(step["connectionId"].as_str().unwrap(), reason(&step["reason"])),
            "channel" => viewer.channel(step["connectionId"].as_str().unwrap(), step["text"].as_str().unwrap(), step["receivedAt"].as_f64().unwrap()),
            "push" => {
                viewer.push(step["text"].as_str().unwrap());
                Ok(())
            }
            "fail" => viewer.fail(reason(&step["reason"])),
            "stop" => viewer.stop(),
            "fireTimer" => {
                let handle = step["handle"].as_u64().unwrap();
                let armed = fx.script().timers.contains(&handle);
                if armed {
                    fx.script().timers.retain(|h| *h != handle);
                    viewer.timer_fired(handle)
                } else {
                    fx.log(json!(["noTimer", handle]));
                    Ok(())
                }
            }
            "dispatchDone" => {
                let settle = fx.script().dispatches[step["index"].as_u64().unwrap() as usize].take().unwrap();
                let verdict = if step["ok"] == json!(true) { Ok(()) } else { Err(step["message"].as_str().unwrap_or("dispatch failed").to_owned()) };
                settle.send(verdict).ok();
                Ok(())
            }
            "releaseDone" => {
                fx.script().releases[step["index"].as_u64().unwrap() as usize].take().unwrap().send(()).ok();
                Ok(())
            }
            other => panic!("unknown viewer op {other}"),
        };
        flush(&fx, &viewer, &mut lane);
        let view = viewer.view();
        let trace: Vec<Value> = fx.script().trace[before..].to_vec();
        assert_eq!(outcome.err().map(Value::from), want.get("threw").cloned(), "{what}: threw");
        assert_eq!(json!(trace), want["trace"], "{what}: effects");
        let got = json!({ "state": view.state.name(), "epoch": view.epoch, "connectionId": view.connection_id, "generation": view.generation });
        assert_eq!(got, want["view"], "{what}: position");
    }
}

#[test]
fn the_viewer_behaves_as_nodes_did_in_every_recorded_scenario() {
    let recorded: Value = serde_json::from_str(VIEWER).unwrap();
    let scenarios = recorded["scenarios"].as_array().unwrap();
    assert_eq!(scenarios.len(), 35);
    for scenario in scenarios {
        run_scenario(scenario);
    }
}
