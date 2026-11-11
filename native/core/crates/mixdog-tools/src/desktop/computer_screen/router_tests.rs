//! Replay of Node's `ScreenInputRouter` (recorded by `record-screen-control-router.mjs` from the export of
//! b6f10295a): every scenario's script is run against Rust's router with two fake backends, and the whole trace
//! — every backend send start and end, every `allowed` evaluation with its answer, every hook, every dropped
//! report, every call's completion in order — and the final state must equal the recording. The router runs
//! on the product's runtime; the fakes answer as Node's do, through a promise (one turn later, `next_turn`),
//! and the recorder's `then` logs a call's end one turn after it settled.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use mixdog_core_api::domain::computer::DesktopIdentity;
use mixdog_core_api::domain::computer::PointerButton;
use mixdog_core_api::domain::computer::ScreenInput;
use serde_json::Value;
use serde_json::json;

use super::router::Allowed;
use super::router::BackendId;
use super::router::BoxFuture;
use super::router::Hook;
use super::router::RouteOutcome;
use super::router::ScreenBackend;
use super::router::ScreenInputRouter;
use super::router::SendError;
use super::router::SwitchHooks;
use super::testing::Gate;
use super::testing::Log;
use super::testing::Replay;
use super::testing::log_new;
use super::testing::log_push;
use super::testing::log_take;
use super::testing::manifest_names;
use super::testing::next_turn;

const RECORDING: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/screen-control/router/scenarios.json");
const MANIFEST: &str = include_str!("../../../../../fixtures/screen-control/router/MANIFEST.json");

fn button_name(button: PointerButton) -> &'static str {
    match button {
        PointerButton::Left => "left",
        PointerButton::Right => "right",
        PointerButton::Middle => "middle",
    }
}

fn command_json(command: &ScreenInput) -> Value {
    match command {
        ScreenInput::Move { x, y } => json!({"op": "move", "x": x, "y": y}),
        ScreenInput::Button { button, down, at } => {
            let mut value = json!({"op": "button", "button": button_name(*button), "down": down});
            if let Some((x, y)) = at {
                value["at"] = json!({"x": x, "y": y});
            }
            value
        }
        ScreenInput::Wheel { x, y, dx, dy } => json!({"op": "wheel", "x": x, "y": y, "dx": dx, "dy": dy}),
        ScreenInput::Key { vk, scan, extended, down } => json!({"op": "key", "vk": vk, "scan": scan, "extended": extended, "down": down}),
        ScreenInput::Text(text) => json!({"op": "text", "text": text}),
    }
}

fn int(value: &Value, field: &str) -> i32 {
    value[field].as_i64().unwrap_or_else(|| panic!("{field} is not a number in {value}")) as i32
}

fn command_from(value: &Value) -> ScreenInput {
    match value["op"].as_str().expect("a command has an op") {
        "move" => ScreenInput::Move { x: int(value, "x"), y: int(value, "y") },
        "button" => ScreenInput::Button {
            button: match value["button"].as_str().expect("a button") {
                "left" => PointerButton::Left,
                "right" => PointerButton::Right,
                _ => PointerButton::Middle,
            },
            down: value["down"].as_bool().expect("down"),
            at: value.get("at").map(|at| (int(at, "x"), int(at, "y"))),
        },
        "wheel" => ScreenInput::Wheel { x: int(value, "x"), y: int(value, "y"), dx: int(value, "dx"), dy: int(value, "dy") },
        "key" => ScreenInput::Key {
            vk: value["vk"].as_u64().expect("vk") as u32,
            scan: value["scan"].as_u64().expect("scan") as u32,
            extended: value["extended"].as_bool().expect("extended"),
            down: value["down"].as_bool().expect("down"),
        },
        "text" => ScreenInput::Text(value["text"].as_str().expect("text").to_string()),
        other => panic!("unknown command {other}"),
    }
}

fn identity_from(value: &Value) -> Option<DesktopIdentity> {
    (!value.is_null())
        .then(|| DesktopIdentity { session: value["session"].as_u64().expect("session") as u32, desktop: value["desktop"].as_str().expect("desktop").to_string() })
}

struct Fake {
    sent: Vec<Value>,
    reachable: bool,
    gate: Option<Arc<Gate>>,
    identity: Option<DesktopIdentity>,
    fail_text: bool,
}

type Shared = Arc<Mutex<Fake>>;

fn fake(shared: &Shared) -> std::sync::MutexGuard<'_, Fake> {
    shared.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct FakeBackend {
    name: &'static str,
    state: Shared,
    log: Log,
}

#[async_trait]
impl ScreenBackend for FakeBackend {
    async fn send(&self, command: ScreenInput) -> Result<(), SendError> {
        let shown = command_json(&command);
        log_push(&self.log, json!({"ev": "send", "backend": self.name, "phase": "start", "command": shown}));
        let gate = fake(&self.state).gate.clone();
        if let Some(gate) = gate {
            gate.wait().await;
        }
        let refused = {
            let state = fake(&self.state);
            !state.reachable || (state.fail_text && matches!(command, ScreenInput::Text(_)))
        };
        if refused {
            log_push(&self.log, json!({"ev": "send", "backend": self.name, "phase": "fail", "command": shown}));
            next_turn().await;
            return Err(SendError);
        }
        fake(&self.state).sent.push(shown.clone());
        log_push(&self.log, json!({"ev": "send", "backend": self.name, "phase": "ok", "command": shown}));
        next_turn().await;
        Ok(())
    }

    fn identity(&self) -> Option<DesktopIdentity> {
        fake(&self.state).identity.clone()
    }
}

fn backend_name(backend: BackendId) -> &'static str {
    match backend {
        BackendId::Desktop => "desktop",
        BackendId::Secure => "secure",
    }
}

fn backend_of(value: &Value) -> Option<BackendId> {
    match value.as_str() {
        Some("desktop") => Some(BackendId::Desktop),
        Some("secure") => Some(BackendId::Secure),
        _ => None,
    }
}

struct World {
    desktop: Shared,
    secure: Shared,
    log: Log,
}

impl World {
    fn of(&self, name: &str) -> &Shared {
        if name == "desktop" { &self.desktop } else { &self.secure }
    }
}

fn outcome_json(outcome: RouteOutcome) -> Value {
    json!(if outcome == RouteOutcome::Applied { "applied" } else { "rejected" })
}

/// The recorded policies: how a plan's `allowed` gate answers, each evaluation logged with its count.
fn allowed_for(call: &str, policy: &Value, world: &World) -> Allowed {
    let checks = Arc::new(AtomicU64::new(0));
    let call = call.to_string();
    let policy = policy.clone();
    let desktop = world.desktop.clone();
    let secure = world.secure.clone();
    let log = world.log.clone();
    Arc::new(move || {
        let n = checks.fetch_add(1, Ordering::SeqCst) + 1;
        let kind = policy.as_str().unwrap_or_else(|| policy["kind"].as_str().expect("a policy kind"));
        let pick = |policy: &Value| if policy["backend"] == "desktop" { desktop.clone() } else { secure.clone() };
        let value = match kind {
            "always" => true,
            "sent-count-is" => fake(&pick(&policy)).sent.len() as u64 == policy["count"].as_u64().expect("count"),
            "first-checks" => n <= policy["count"].as_u64().expect("count"),
            "no-text-sent" => !fake(&pick(&policy)).sent.iter().any(|command| command["op"] == "text"),
            "move-at-sent" => {
                let target = pick(&policy);
                let mut state = fake(&target);
                if state.sent.len() as u64 == policy["count"].as_u64().expect("count") {
                    state.identity = identity_from(&policy["to"]);
                }
                true
            }
            other => panic!("unknown policy {other}"),
        };
        log_push(&log, json!({"ev": "allowed", "call": call, "n": n, "value": value}));
        value
    })
}

fn hook_for(call: &str, name: &'static str, kind: Option<&str>, router: &Arc<ScreenInputRouter>, world: &World) -> Option<Hook> {
    let kind = kind?.to_string();
    let call = call.to_string();
    let router = router.clone();
    let log = world.log.clone();
    let desktop = world.desktop.clone();
    let secure = world.secure.clone();
    Some(Box::new(move || -> BoxFuture<Result<(), SendError>> {
        Box::pin(async move {
            let last = |shared: &Shared| fake(shared).sent.last().cloned().unwrap_or(Value::Null);
            let active = router.active_backend().map_or(Value::Null, |backend| json!(backend_name(backend)));
            log_push(
                &log,
                json!({"ev": "hook", "call": call, "name": name, "active": active, "lastDesktopSent": last(&desktop), "lastSecureSent": last(&secure)}),
            );
            match kind.as_str() {
                "never" => std::future::pending().await,
                "throws" => {
                    next_turn().await;
                    Err(SendError)
                }
                _ => {
                    next_turn().await;
                    Ok(())
                }
            }
        })
    }))
}

async fn play(replay: Replay, scenario: Value) -> (Vec<Value>, Value) {
    let name = scenario["name"].as_str().expect("a scenario name");
    let log = log_new();
    let new_fake = |identity: &Value| Arc::new(Mutex::new(Fake { sent: Vec::new(), reachable: true, gate: None, identity: identity_from(identity), fail_text: false }));
    let world = World { desktop: new_fake(&scenario["backends"]["desktop"]), secure: new_fake(&scenario["backends"]["secure"]), log: log.clone() };
    let dropped_log = log.clone();
    let router = Arc::new(ScreenInputRouter::new(
        Arc::new(FakeBackend { name: "desktop", state: world.desktop.clone(), log: log.clone() }),
        Arc::new(FakeBackend { name: "secure", state: world.secure.clone(), log: log.clone() }),
        move |backend, count| log_push(&dropped_log, json!({"ev": "dropped", "backend": backend_name(backend), "count": count})),
    ));
    let finished: Arc<Mutex<HashMap<String, bool>>> = Arc::new(Mutex::new(HashMap::new()));
    let start = |call: &str, future: BoxFuture<Value>| {
        finished.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(call.to_string(), false);
        let call = call.to_string();
        let log = log.clone();
        let finished = finished.clone();
        replay.spawn(Box::pin(async move {
            let value = future.await;
            log_push(&log, json!({"ev": "done", "call": call, "value": value}));
            finished.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(call, true);
        }));
    };
    let plan = |step: &Value| -> Vec<ScreenInput> { step["commands"].as_array().expect("commands").iter().map(command_from).collect() };
    for step in scenario["steps"].as_array().expect("steps") {
        let call = step["as"].as_str().unwrap_or_default();
        match step["op"].as_str().expect("a step op") {
            "switch" => {
                let hooks = SwitchHooks {
                    before: hook_for(call, "before", step["hooks"]["before"].as_str(), &router, &world),
                    after: hook_for(call, "after", step["hooks"]["after"].as_str(), &router, &world),
                };
                let switching = router.switch_to(backend_of(&step["to"]), hooks);
                start(call, Box::pin(async move {
                    switching.await;
                    Value::Null
                }));
            }
            "dispatch" => {
                let running = router.dispatch(plan(step), allowed_for(call, &step["allowed"], &world));
                start(call, Box::pin(async move { outcome_json(running.await) }));
            }
            "dispatchKeys" => {
                let running = router.dispatch_keys(plan(step), allowed_for(call, &step["allowed"], &world));
                start(call, Box::pin(async move { outcome_json(running.await) }));
            }
            "releaseAll" => {
                let releasing = router.release_all();
                start(call, Box::pin(async move {
                    releasing.await;
                    Value::Null
                }));
            }
            "cancel" => {
                router.cancel();
                log_push(&log, json!({"ev": "cancel"}));
            }
            "abandon" => {
                router.abandon();
                log_push(&log, json!({"ev": "abandon"}));
            }
            "gate" => {
                let mut state = fake(world.of(step["backend"].as_str().expect("a backend")));
                match step["mode"].as_str().expect("a gate mode") {
                    "open" => {
                        if let Some(gate) = state.gate.take() {
                            gate.open();
                        }
                    }
                    "hang" => state.gate = Some(Gate::hung()),
                    _ => state.gate = Some(Gate::closed()),
                }
            }
            "identity" => fake(world.of(step["backend"].as_str().expect("a backend"))).identity = identity_from(&step["value"]),
            "reachable" => fake(world.of(step["backend"].as_str().expect("a backend"))).reachable = step["value"].as_bool().expect("a flag"),
            "failText" => fake(world.of(step["backend"].as_str().expect("a backend"))).fail_text = step["value"].as_bool().expect("a flag"),
            "settle" => replay.settle().await,
            "await" => {
                replay.settle().await;
                let awaited = step["call"].as_str().expect("a call");
                assert!(finished.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(awaited).copied().unwrap_or(false), "{name}: {awaited} did not finish");
            }
            other => panic!("unknown step {other}"),
        }
    }
    replay.settle().await;
    let sent = |shared: &Shared| Value::Array(fake(shared).sent.clone());
    let final_state = json!({
        "active": router.active_backend().map_or(Value::Null, |backend| json!(backend_name(backend))),
        "holds": router.holds_input(),
        "sent": {"desktop": sent(&world.desktop), "secure": sent(&world.secure)},
    });
    (log_take(&log), final_state)
}

#[test]
fn every_recorded_router_scenario_replays_to_nodes_whole_trace() {
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
