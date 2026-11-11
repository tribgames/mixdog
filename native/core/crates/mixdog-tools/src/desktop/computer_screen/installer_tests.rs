//! Replay of Node's install request and key ops (recorded by `record-screen-control-install.mjs` from the
//! export of b6f10295a): every scenario's script of requests, key ops, state reads, service starts, exits of the
//! launched elevation and virtual-clock advances is run against Rust's installer on the product's runtime, with
//! a fake port that only records what it is asked. The whole trace and the final state must equal the
//! recording. Nothing is launched, installed or prompted: `run_key_op` is a list entry the script ends.
//!
//! The fake answers as Node's does, through a promise: an answer it already has reaches the installer one turn
//! later (`next_turn`), and the recorder's `then` logs a call's end one turn after it settled.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;

use serde_json::Value;
use serde_json::json;
use tokio::sync::oneshot;

use super::installer::HelperStatus;
use super::installer::ImageCheck;
use super::installer::InstallState;
use super::installer::InstallerPort;
use super::installer::KeyChangeOptions;
use super::installer::KeyOp;
use super::installer::SecureDesktopInstaller;
use super::router::BoxFuture;
use super::testing::Log;
use super::testing::Replay;
use super::testing::VirtualTimers;
use super::testing::log_new;
use super::testing::log_push;
use super::testing::log_take;
use super::testing::manifest_names;
use super::testing::next_turn;

const RECORDING: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/screen-control/install/scenarios.json");
const MANIFEST: &str = include_str!("../../../../../fixtures/screen-control/install/MANIFEST.json");

fn state_of(value: &Value) -> InstallState {
    serde_json::from_value(value.clone()).unwrap_or_else(|_| panic!("an install state, got {value}"))
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
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
    image: Value,
    counters: Arc<Mutex<Counters>>,
    log: Log,
}

/// A value the fake already has, delivered as a settled promise is: one turn later.
fn answer<T: Send + 'static>(value: T) -> BoxFuture<T> {
    Box::pin(async move {
        next_turn().await;
        value
    })
}

impl InstallerPort for FakePort {
    fn check(&self, controller_key: Option<String>) -> BoxFuture<InstallState> {
        log_push(&self.log, json!({"ev": "port", "call": "check", "key": controller_key}));
        let mut held = lock(&self.counters);
        let by_key = controller_key.as_ref().and_then(|key| self.by_key.get(key)).copied();
        let state = by_key.unwrap_or_else(|| self.states[held.checks.min(self.states.len() - 1)]);
        held.checks += 1;
        answer(state)
    }

    fn verify_image(&self) -> BoxFuture<ImageCheck> {
        log_push(&self.log, json!({"ev": "port", "call": "verifyImage"}));
        let image = if self.image["ok"] == false {
            ImageCheck::Refused { detail: self.image["detail"].as_str().expect("a detail").to_string() }
        } else {
            ImageCheck::Ok
        };
        answer(image)
    }

    fn start_service(&self) -> BoxFuture<HelperStatus> {
        log_push(&self.log, json!({"ev": "port", "call": "startService"}));
        let mut held = lock(&self.counters);
        let next = (!self.starts.is_empty()).then(|| self.starts[held.starts.min(self.starts.len() - 1)].clone());
        held.starts += 1;
        answer(next.unwrap_or(HelperStatus { installed: false, running: false, version: None }))
    }

    fn run_key_op(&self, op: KeyOp) -> BoxFuture<Result<i32, String>> {
        log_push(
            &self.log,
            json!({"ev": "port", "call": "runKeyOp", "verb": op.verb, "keys": op.keys, "revoke": op.revoke, "credential": op.credential, "delegated": op.delegated}),
        );
        let mut held = lock(&self.counters);
        let next = self.elevations.get(held.elevations).cloned().unwrap_or(Value::Null);
        held.elevations += 1;
        if next == "defer" {
            let (exit, ended) = oneshot::channel();
            held.children.push(exit);
            return Box::pin(async move { Ok(ended.await.expect("the script ends the launched elevation")) });
        }
        if let Some(message) = next["throw"].as_str() {
            return answer(Err(message.to_string()));
        }
        answer(Ok(next.as_i64().expect("an exit code") as i32))
    }
}

async fn play(replay: Replay, scenario: Value) -> (Vec<Value>, Value) {
    let name = scenario["name"].as_str().expect("a scenario name");
    let world = &scenario["world"];
    let log = log_new();
    let held = Arc::new(Mutex::new(Counters { checks: 0, starts: 0, elevations: 0, children: Vec::new() }));
    let states: Vec<InstallState> = world.get("states").map_or_else(|| vec![InstallState::Installed], |states| states.as_array().expect("states").iter().map(state_of).collect());
    let by_key = world.get("statesByKey").and_then(Value::as_object).map(|map| map.iter().map(|(key, state)| (key.clone(), state_of(state))).collect()).unwrap_or_default();
    let fake = FakePort {
        states,
        by_key,
        elevations: world.get("elevations").and_then(Value::as_array).cloned().unwrap_or_default(),
        starts: world.get("starts").map_or_else(Vec::new, |starts| serde_json::from_value(starts.clone()).expect("starts")),
        image: world.get("image").cloned().unwrap_or(json!({"ok": true})),
        counters: held.clone(),
        log: log.clone(),
    };
    let timers = VirtualTimers::new(replay.clone());
    let installer = SecureDesktopInstaller::new(Arc::new(fake), Arc::new(timers.clone()), world["reportAfterMs"].as_u64());
    let finished: Arc<Mutex<HashMap<String, bool>>> = Arc::new(Mutex::new(HashMap::new()));
    let start = |call: &str, future: BoxFuture<Value>| {
        lock(&finished).insert(call.to_string(), false);
        let call = call.to_string();
        let log = log.clone();
        let finished = finished.clone();
        replay.spawn(Box::pin(async move {
            let value = future.await;
            log_push(&log, json!({"ev": "done", "call": call, "ok": true, "value": value}));
            lock(&finished).insert(call, true);
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
            "requestUnawaited" => {
                // The caller goes away (its session ended): the request's future is dropped unpolled.
                drop(installer.request(step["key"].as_str().expect("a key")));
            }
            "state" => {
                let reading = installer.state(step["key"].as_str().map(str::to_string));
                start(call, Box::pin(async move { serde_json::to_value(reading.await).expect("serializes") }));
            }
            "ensure" => {
                let starting = installer.ensure_running();
                start(call, Box::pin(async move { serde_json::to_value(starting.await).expect("serializes") }));
            }
            "keyOp" => {
                let keys: Vec<String> = serde_json::from_value(step["keys"].clone()).expect("keys");
                let options: KeyChangeOptions = step.get("options").map_or_else(KeyChangeOptions::default, |options| serde_json::from_value(options.clone()).expect("options"));
                let running = match step["verb"].as_str().expect("a verb") {
                    "install" => installer.install(keys, options),
                    "enroll" => installer.enroll(keys, options),
                    _ => installer.revoke(keys.into_iter().next().expect("a key"), options),
                };
                start(call, Box::pin(async move { serde_json::to_value(running.await).expect("serializes") }));
            }
            "exit" => {
                let child = lock(&held).children.remove(step["n"].as_u64().expect("n") as usize);
                child.send(step["code"].as_i64().expect("a code") as i32).expect("the elevation is still waiting");
            }
            "advance" => {
                let ms = step["ms"].as_u64().expect("ms");
                let ran = timers.advance(ms).await;
                log_push(&log, json!({"ev": "advance", "ms": ms, "ran": ran}));
            }
            "query" => log_push(&log, json!({"ev": "query", "what": "pending", "value": installer.pending()})),
            "settle" => replay.settle().await,
            "await" => {
                replay.settle().await;
                let awaited = step["call"].as_str().expect("a call");
                assert!(lock(&finished).get(awaited).copied().unwrap_or(false), "{name}: {awaited} did not finish");
            }
            other => panic!("unknown step {other}"),
        }
    }
    replay.settle().await;
    log_push(&log, json!({"ev": "query", "what": "pending", "value": installer.pending()}));
    let final_state = {
        let held = lock(&held);
        json!({"elapsedMs": timers.elapsed(), "checks": held.checks, "elevations": held.elevations})
    };
    (log_take(&log), final_state)
}

#[test]
fn every_recorded_install_scenario_replays_to_nodes_whole_trace() {
    let recording: Value = serde_json::from_str(&RECORDING).expect("the recording parses");
    let scenarios = recording["scenarios"].as_array().expect("scenarios");
    manifest_names(MANIFEST, scenarios);
    for scenario in scenarios {
        let name = scenario["name"].as_str().expect("a scenario name");
        let (trace, final_state) = Replay::run(|replay| play(replay, scenario.clone()));
        assert_eq!(Value::Array(trace), scenario["trace"], "{name}: the trace");
        assert_eq!(final_state, scenario["final"], "{name}: the final state");
    }
}
