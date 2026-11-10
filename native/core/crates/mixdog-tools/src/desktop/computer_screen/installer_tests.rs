//! Replay of Node's install request (recorded by `record-screen-control-install.mjs` from the export of
//! b6f10295a): every scenario's script of requests, state reads, service starts, exits of the launched
//! elevation and virtual-clock advances is run against Rust's installer with a fake port that only records what
//! it is asked, and the whole trace and the final state must equal the recording. Nothing is launched,
//! installed or prompted: `run_key_op` is a list entry the script ends.
//!
//! The PC-side approval hook is held to the same recording: a hook that approves changes nothing in any
//! scenario's trace, and one that refuses answers as Node's declined prompt with nothing launched.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;

use serde_json::Value;
use serde_json::json;
use tokio::sync::oneshot;

use super::installer::ApprovedPort;
use super::installer::ELEVATION_DECLINED_EXIT;
use super::installer::HelperStatus;
use super::installer::ImageCheck;
use super::installer::InstallApproval;
use super::installer::InstallState;
use super::installer::InstallerPort;
use super::installer::KeyOp;
use super::installer::KeyVerb;
use super::installer::PcApproval;
use super::installer::SecureDesktopInstaller;
use super::router::BoxFuture;
use super::testing::Log;
use super::testing::Sim;
use super::testing::VirtualTimers;
use super::testing::log_new;
use super::testing::log_push;
use super::testing::log_take;

const RECORDING: &str = include_str!("../../../../../fixtures/screen-control/install/scenarios.json");

fn state_of(value: &Value) -> InstallState {
    serde_json::from_value(value.clone()).unwrap_or_else(|_| panic!("an install state, got {value}"))
}

struct Counters {
    checks: usize,
    starts: usize,
    elevations: usize,
    children: Vec<oneshot::Sender<i32>>,
}

struct FakePort {
    states: Vec<InstallState>,
    by_key: HashMap<String, InstallState>,
    elevations: Vec<Value>,
    starts: Vec<HelperStatus>,
    image: ImageCheck,
    counters: Arc<Mutex<Counters>>,
    log: Log,
}

fn counters(shared: &Arc<Mutex<Counters>>) -> std::sync::MutexGuard<'_, Counters> {
    shared.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl InstallerPort for FakePort {
    fn check(&self, controller_key: Option<String>) -> BoxFuture<InstallState> {
        log_push(&self.log, json!({"ev": "port", "call": "check", "key": controller_key}));
        let mut held = counters(&self.counters);
        let by_key = controller_key.as_ref().and_then(|key| self.by_key.get(key)).copied();
        let state = by_key.unwrap_or_else(|| self.states[held.checks.min(self.states.len() - 1)]);
        held.checks += 1;
        Box::pin(async move { state })
    }

    fn verify_image(&self) -> BoxFuture<ImageCheck> {
        log_push(&self.log, json!({"ev": "port", "call": "verifyImage"}));
        let image = self.image.clone();
        Box::pin(async move { image })
    }

    fn start_service(&self) -> BoxFuture<HelperStatus> {
        log_push(&self.log, json!({"ev": "port", "call": "startService"}));
        let mut held = counters(&self.counters);
        let next = (!self.starts.is_empty()).then(|| self.starts[held.starts.min(self.starts.len() - 1)].clone());
        held.starts += 1;
        let status = next.unwrap_or(HelperStatus { installed: false, running: false, version: None });
        Box::pin(async move { status })
    }

    fn run_key_op(&self, op: KeyOp) -> BoxFuture<Result<i32, String>> {
        let verb = if op.verb == KeyVerb::Install { "install" } else { "enroll" };
        log_push(&self.log, json!({"ev": "port", "call": "runKeyOp", "verb": verb, "keys": op.keys, "revoke": op.revoke}));
        let mut held = counters(&self.counters);
        let next = self.elevations.get(held.elevations).cloned().unwrap_or(Value::Null);
        held.elevations += 1;
        if next == "defer" {
            let (exit, ended) = oneshot::channel();
            held.children.push(exit);
            return Box::pin(async move { Ok(ended.await.expect("the script ends the launched elevation")) });
        }
        if let Some(message) = next["throw"].as_str() {
            let message = message.to_string();
            return Box::pin(async move { Err(message) });
        }
        let code = next.as_i64().expect("an exit code") as i32;
        Box::pin(async move { Ok(code) })
    }
}

/// The PC-side approval hook, answering as told and recording what it was asked.
struct Approval {
    allow: bool,
    asked: Arc<Mutex<Vec<Value>>>,
}

impl PcApproval for Approval {
    fn approve(&self, request: InstallApproval) -> BoxFuture<bool> {
        let verb = if request.verb == KeyVerb::Install { "install" } else { "enroll" };
        self.asked.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).push(json!({"verb": verb, "keys": request.keys}));
        let allow = self.allow;
        Box::pin(async move { allow })
    }
}

fn play(scenario: &Value, approval: Option<Arc<dyn PcApproval>>) -> (Vec<Value>, Value) {
    let name = scenario["name"].as_str().expect("a scenario name");
    let world = &scenario["world"];
    let log = log_new();
    let held = Arc::new(Mutex::new(Counters { checks: 0, starts: 0, elevations: 0, children: Vec::new() }));
    let states: Vec<InstallState> = world.get("states").map_or_else(|| vec![InstallState::Installed], |states| states.as_array().expect("states").iter().map(state_of).collect());
    let by_key = world.get("statesByKey").and_then(Value::as_object).map(|map| map.iter().map(|(key, state)| (key.clone(), state_of(state))).collect()).unwrap_or_default();
    let image = match world.get("image") {
        Some(image) if image["ok"] == false => ImageCheck::Refused { detail: image["detail"].as_str().expect("a detail").to_string() },
        _ => ImageCheck::Ok,
    };
    let starts: Vec<HelperStatus> = world.get("starts").map_or_else(Vec::new, |starts| serde_json::from_value(starts.clone()).expect("starts"));
    let fake = FakePort {
        states,
        by_key,
        elevations: world.get("elevations").and_then(Value::as_array).cloned().unwrap_or_default(),
        starts,
        image,
        counters: held.clone(),
        log: log.clone(),
    };
    let port: Arc<dyn InstallerPort> = match approval {
        Some(approval) => Arc::new(ApprovedPort::new(Arc::new(fake), approval)),
        None => Arc::new(fake),
    };
    let sim = Sim::new();
    let timers = VirtualTimers::new(sim.clone());
    let installer = SecureDesktopInstaller::new(port, Arc::new(timers.clone()), world["reportAfterMs"].as_u64());
    let finished: Arc<Mutex<HashMap<String, bool>>> = Arc::new(Mutex::new(HashMap::new()));
    let start = |call: &str, future: BoxFuture<Value>| {
        finished.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(call.to_string(), false);
        let call = call.to_string();
        let log = log.clone();
        let finished = finished.clone();
        sim.spawn(Box::pin(async move {
            let value = future.await;
            log_push(&log, json!({"ev": "done", "call": call, "ok": true, "value": value}));
            finished.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(call, true);
        }));
    };
    for step in scenario["steps"].as_array().expect("steps") {
        let call = step["as"].as_str().unwrap_or_default();
        match step["op"].as_str().expect("a step op") {
            "request" => {
                // A key the recording left out is invalid in Node too, whatever the text.
                let running = installer.request(step["key"].as_str().unwrap_or(""));
                start(call, Box::pin(async move { serde_json::to_value(running.await).expect("serializes") }));
            }
            "state" => {
                let reading = installer.state(step["key"].as_str().map(str::to_string));
                start(call, Box::pin(async move { serde_json::to_value(reading.await).expect("serializes") }));
            }
            "ensure" => {
                let starting = installer.ensure_running();
                start(call, Box::pin(async move { serde_json::to_value(starting.await).expect("serializes") }));
            }
            "exit" => {
                let child = counters(&held).children.remove(step["n"].as_u64().expect("n") as usize);
                child.send(step["code"].as_i64().expect("a code") as i32).expect("the elevation is still waiting");
            }
            "advance" => {
                let ms = step["ms"].as_u64().expect("ms");
                let ran = timers.advance(ms);
                log_push(&log, json!({"ev": "advance", "ms": ms, "ran": ran}));
            }
            "query" => log_push(&log, json!({"ev": "query", "what": "pending", "value": installer.pending()})),
            "settle" => sim.settle(),
            "await" => {
                sim.settle();
                let awaited = step["call"].as_str().expect("a call");
                assert!(finished.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(awaited).copied().unwrap_or(false), "{name}: {awaited} did not finish");
            }
            other => panic!("unknown step {other}"),
        }
    }
    sim.settle();
    log_push(&log, json!({"ev": "query", "what": "pending", "value": installer.pending()}));
    let final_state = {
        let held = counters(&held);
        json!({"elapsedMs": timers.elapsed(), "checks": held.checks, "elevations": held.elevations})
    };
    (log_take(&log), final_state)
}

fn recording() -> Value {
    serde_json::from_str(RECORDING).expect("the recording parses")
}

#[test]
fn every_recorded_install_scenario_replays_to_nodes_whole_trace() {
    let recording = recording();
    let scenarios = recording["scenarios"].as_array().expect("scenarios");
    assert!(scenarios.len() >= 18, "the recording holds {} scenarios", scenarios.len());
    for scenario in scenarios {
        let name = scenario["name"].as_str().expect("a scenario name");
        let (trace, final_state) = play(scenario, None);
        assert_eq!(Value::Array(trace), scenario["trace"], "{name}: the trace");
        assert_eq!(final_state, scenario["final"], "{name}: the final state");
    }
}

#[test]
fn an_approving_hook_changes_nothing_in_any_recorded_scenario() {
    let recording = recording();
    for scenario in recording["scenarios"].as_array().expect("scenarios") {
        let name = scenario["name"].as_str().expect("a scenario name");
        let asked = Arc::new(Mutex::new(Vec::new()));
        let (trace, final_state) = play(scenario, Some(Arc::new(Approval { allow: true, asked: asked.clone() })));
        assert_eq!(Value::Array(trace.clone()), scenario["trace"], "{name}: the trace");
        assert_eq!(final_state, scenario["final"], "{name}: the final state");
        // Asked exactly where Node launched an elevation, with what it launched.
        let launched: Vec<Value> = trace.iter().filter(|event| event["call"] == "runKeyOp").map(|event| json!({"verb": event["verb"], "keys": event["keys"]})).collect();
        assert_eq!(*asked.lock().unwrap_or_else(|poisoned| poisoned.into_inner()), launched, "{name}: what the hook was asked");
    }
}

#[test]
fn a_refusing_hook_is_a_declined_prompt_and_nothing_is_launched() {
    let recording = recording();
    let scenario = recording["scenarios"].as_array().expect("scenarios").iter().find(|scenario| scenario["name"] == "a declined prompt reports declined and is not retried").expect("the declined scenario");
    // What Node answered when the prompt itself was declined (exit 1223).
    assert_eq!(scenario["world"]["elevations"][0], json!(ELEVATION_DECLINED_EXIT));
    let node_answer = scenario["trace"].as_array().expect("trace").iter().find(|event| event["call"] == "request").expect("the request's answer")["value"].clone();
    let asked = Arc::new(Mutex::new(Vec::new()));
    let (trace, _) = play(scenario, Some(Arc::new(Approval { allow: false, asked: asked.clone() })));
    let answer = trace.iter().find(|event| event["call"] == "request").expect("the request's answer")["value"].clone();
    assert_eq!(answer, node_answer, "the same answer as a declined prompt");
    assert!(trace.iter().all(|event| event["call"] != "runKeyOp"), "nothing was launched: {trace:?}");
    assert_eq!(asked.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).len(), 1, "asked once");
}
