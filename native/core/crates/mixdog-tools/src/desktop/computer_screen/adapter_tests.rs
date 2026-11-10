//! Replay of Node's secure-desktop adapter (recorded by `record-screen-control-adapter.mjs` from the export of
//! b6f10295a): every scenario's script is run against Rust's adapter on the product's runtime and the virtual clock,
//! with a fake helper client that only records what it is told and answers as Node's does (a settled promise one turn
//! later, a connect when the script settles it). The whole trace and the final state must equal the recording.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;

use mixdog_core_api::domain::computer::PointerButton;
use mixdog_core_api::domain::computer::ScreenInput;
use mixdog_secure_desktop::protocol::FrameHeader;
use mixdog_secure_desktop::protocol::InputEvent;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio::sync::oneshot;

use super::adapter::HelperService;
use super::adapter::HelperSession;
use super::adapter::SecureDesktopAdapter;
use super::lease::Challenge;
use super::lease::Grant;
use super::lease::HelperFrame;
use super::lease::Listener;
use super::lease::ListenerSet;
use super::lease::Unsub;
use super::router::BoxFuture;
use super::testing::Log;
use super::testing::Replay;
use super::testing::VirtualTimers;
use super::testing::log_new;
use super::testing::log_push;
use super::testing::log_take;
use super::testing::manifest_names;
use super::testing::next_turn;

const RECORDING: &str = include_str!("../../../../../fixtures/screen-control/adapter/scenarios.json");
const MANIFEST: &str = include_str!("../../../../../fixtures/screen-control/adapter/MANIFEST.json");

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn answer<T: Send + 'static>(value: T) -> BoxFuture<T> {
    Box::pin(async move {
        next_turn().await;
        value
    })
}

fn note(log: &Log, call: &str, fields: Value) {
    let mut event = Map::new();
    event.insert("ev".into(), json!("service"));
    event.insert("call".into(), json!(call));
    if let Value::Object(mut fields) = fields {
        event.append(&mut fields);
    }
    log_push(log, Value::Object(event));
}

struct Service {
    log: Log,
    available: bool,
    send_fails: Option<String>,
    grant_fails: Option<String>,
    session: Mutex<Option<HelperSession>>,
    connects: Mutex<Vec<oneshot::Sender<Result<(), String>>>>,
    desktop_changed: Arc<ListenerSet<HelperSession>>,
    closed: Arc<ListenerSet<()>>,
    challenges: Arc<ListenerSet<Challenge>>,
    errors: Arc<ListenerSet<(String, String)>>,
    frames: Arc<ListenerSet<(FrameHeader, Arc<Vec<u8>>)>>,
}

fn sent(result: &Option<String>) -> BoxFuture<Result<(), String>> {
    answer(result.clone().map_or(Ok(()), Err))
}

impl HelperService for Service {
    fn available(&self) -> bool {
        self.available
    }
    fn session(&self) -> Option<HelperSession> {
        lock(&self.session).clone()
    }
    fn connect(&self) -> BoxFuture<Result<(), String>> {
        note(&self.log, "connect", json!({}));
        let (sender, receiver) = oneshot::channel();
        lock(&self.connects).push(sender);
        Box::pin(async move {
            match receiver.await {
                Ok(outcome) => outcome,
                Err(_) => std::future::pending().await,
            }
        })
    }
    fn on_desktop_changed(&self, listener: Listener<HelperSession>) -> Unsub {
        self.desktop_changed.add(listener)
    }
    fn on_close(&self, listener: Listener<()>) -> Unsub {
        self.closed.add(listener)
    }
    fn on_grant_challenge(&self, listener: Listener<Challenge>) -> Unsub {
        self.challenges.add(listener)
    }
    fn on_error(&self, listener: Listener<(String, String)>) -> Unsub {
        self.errors.add(listener)
    }
    fn on_frame(&self, listener: Listener<(FrameHeader, Arc<Vec<u8>>)>) -> Unsub {
        self.frames.add(listener)
    }
    fn set_active(&self, active: bool) {
        note(&self.log, "setActive", json!({"active": active}));
    }
    fn send_input(&self, event: InputEvent) -> BoxFuture<Result<(), String>> {
        note(&self.log, "sendInput", json!({"event": event}));
        sent(&self.send_fails)
    }
    fn close(&self) {
        note(&self.log, "close", json!({}));
        *lock(&self.session) = None;
    }
    fn set_video_run(&self, epoch: u64) {
        note(&self.log, "setVideoRun", json!({"epoch": epoch}));
    }
    fn send_grant(&self, grant: Grant) -> BoxFuture<Result<(), String>> {
        note(&self.log, "sendGrant", json!({"grant": {"challenge": grant.challenge, "epoch": grant.epoch, "signature": grant.signature}}));
        sent(&self.grant_fails)
    }
    fn sas(&self) -> BoxFuture<Result<(), String>> {
        note(&self.log, "sas", json!({}));
        answer(Ok(()))
    }
}

fn int(value: &Value, field: &str) -> i64 {
    value[field].as_i64().unwrap_or_else(|| panic!("{field} is not a number in {value}"))
}

fn command_from(value: &Value) -> ScreenInput {
    let button = || match value["button"].as_str().expect("a button") {
        "left" => PointerButton::Left,
        "right" => PointerButton::Right,
        _ => PointerButton::Middle,
    };
    match value["op"].as_str().expect("a command has an op") {
        "move" => ScreenInput::Move { x: int(value, "x") as i32, y: int(value, "y") as i32 },
        "button" => ScreenInput::Button {
            button: button(),
            down: value["down"].as_bool().expect("down"),
            at: value.get("at").map(|at| (int(at, "x") as i32, int(at, "y") as i32)),
        },
        "wheel" => ScreenInput::Wheel { x: int(value, "x") as i32, y: int(value, "y") as i32, dx: int(value, "dx") as i32, dy: int(value, "dy") as i32 },
        "key" => ScreenInput::Key {
            vk: int(value, "vk") as u32,
            scan: int(value, "scan") as u32,
            extended: value["extended"].as_bool().expect("extended"),
            down: value["down"].as_bool().expect("down"),
        },
        "text" => ScreenInput::Text(value["text"].as_str().expect("text").to_string()),
        other => panic!("unknown command {other}"),
    }
}

const SESSION: (u32, &str, Option<bool>) = (1, "Winlogon", Some(false));

async fn play(replay: Replay, scenario: Value) -> (Vec<Value>, Value) {
    let world = &scenario["world"];
    let log = log_new();
    let service = Arc::new(Service {
        log: log.clone(),
        available: world.get("available").and_then(Value::as_bool).unwrap_or(true),
        send_fails: world.get("sendFails").and_then(Value::as_str).map(str::to_string),
        grant_fails: world.get("grantFails").and_then(Value::as_str).map(str::to_string),
        session: Mutex::new(None),
        connects: Mutex::new(Vec::new()),
        desktop_changed: ListenerSet::new(),
        closed: ListenerSet::new(),
        challenges: ListenerSet::new(),
        errors: ListenerSet::new(),
        frames: ListenerSet::new(),
    });
    let timers = VirtualTimers::new(replay.clone());
    let adapter = SecureDesktopAdapter::create(service.clone(), Arc::new(timers.clone()));
    let calls: Arc<Mutex<HashMap<String, bool>>> = Arc::new(Mutex::new(HashMap::new()));
    let start_call = |name: &str, done: BoxFuture<Result<(), String>>| {
        lock(&calls).insert(name.to_string(), false);
        let (calls, log, name) = (calls.clone(), log.clone(), name.to_string());
        replay.spawn(Box::pin(async move {
            let event = match done.await {
                Ok(()) => json!({"ev": "done", "call": name, "ok": true, "value": null}),
                Err(error) => json!({"ev": "done", "call": name, "ok": false, "error": error}),
            };
            lock(&calls).insert(name, true);
            log_push(&log, event);
        }));
    };
    let mut listening: Vec<Unsub> = Vec::new();
    for step in scenario["steps"].as_array().expect("steps") {
        let call = step["as"].as_str().unwrap_or_default();
        match step["op"].as_str().expect("a step op") {
            "read" => {
                let latest = adapter.latest_frame().map(|frame| json!({"width": frame.width, "originX": frame.origin_x}));
                log_push(
                    &log,
                    json!({
                        "ev": "read",
                        "installed": adapter.installed(),
                        "connected": adapter.connected(),
                        "desktop": adapter.desktop(),
                        "session": adapter.session(),
                        "locked": adapter.locked(),
                        "latestFrame": latest,
                    }),
                );
            }
            "setActive" => {
                let activated = adapter.set_active(step["active"].as_bool().expect("active"));
                start_call(
                    call,
                    Box::pin(async move {
                        activated.await;
                        Ok(())
                    }),
                );
            }
            "input" => {
                let sent = adapter.send_input(command_from(&step["command"]));
                start_call(call, Box::pin(async move { sent.await.map_err(|error| error.0) }));
            }
            "grant" => {
                let grant = &step["grant"];
                let sent = adapter.send_grant(Grant {
                    challenge: grant["challenge"].as_str().expect("a challenge").to_string(),
                    epoch: grant["epoch"].as_u64().expect("an epoch"),
                    signature: grant["signature"].as_str().expect("a signature").to_string(),
                });
                start_call(call, Box::pin(async move { sent.await.map_err(|error| error.0) }));
            }
            "videoRun" => adapter.set_video_run(step["epoch"].as_u64().expect("an epoch")),
            "connect" => {
                let pending = {
                    let mut connects = lock(&service.connects);
                    assert!(!connects.is_empty(), "{}: no connect is running", scenario["name"]);
                    connects.remove(0)
                };
                if step["ok"].as_bool().expect("ok") {
                    *lock(&service.session) = Some(HelperSession { session: SESSION.0, desktop: SESSION.1.to_string(), locked: SESSION.2 });
                    let _ = pending.send(Ok(()));
                } else {
                    let _ = pending.send(Err("secure desktop helper unreachable".to_string()));
                }
            }
            "close" => {
                *lock(&service.session) = None;
                service.closed.call(&());
            }
            "desktopChanged" => {
                let changed = HelperSession {
                    session: step["session"].as_u64().expect("a session") as u32,
                    desktop: step["desktop"].as_str().expect("a desktop").to_string(),
                    locked: step["locked"].as_bool(),
                };
                {
                    let mut session = lock(&service.session);
                    if session.is_some() {
                        *session = Some(changed.clone());
                    }
                }
                service.desktop_changed.call(&changed);
            }
            "challenge" => service.challenges.call(&Challenge {
                nonce: step["challenge"]["nonce"].as_str().expect("a nonce").to_string(),
                challenge: step["challenge"]["challenge"].as_str().expect("a challenge").to_string(),
            }),
            "error" => {
                let code = step["code"].as_str().expect("a code").to_string();
                let message = format!("{code} reported");
                service.errors.call(&(code, message));
            }
            "frame" => {
                let frame = &step["frame"];
                let header = FrameHeader {
                    seq: 1,
                    width: int(frame, "width") as u32,
                    height: int(frame, "height") as u32,
                    stride: int(frame, "stride") as u32,
                    format: "bgra".to_string(),
                    timestamp_ms: 0,
                    origin_x: int(frame, "originX") as i32,
                    origin_y: int(frame, "originY") as i32,
                    desktop: "Winlogon".to_string(),
                    dirty: Vec::new(),
                };
                let pixels = Arc::new(vec![0; (header.stride * header.height) as usize]);
                service.frames.call(&(header, pixels));
            }
            "listen" => {
                let changed = log.clone();
                let challenged = log.clone();
                let issued = log.clone();
                let framed = log.clone();
                listening = vec![
                    adapter.on_desktop_changed(Arc::new(move |_: &()| log_push(&changed, json!({"ev": "changed"})))),
                    adapter.on_grant_challenge(Arc::new(move |challenge: &Challenge| {
                        log_push(&challenged, json!({"ev": "challenge", "challenge": {"nonce": challenge.nonce, "challenge": challenge.challenge}}));
                    })),
                    adapter.on_helper_issue(Arc::new(move |code: &String| log_push(&issued, json!({"ev": "issue", "code": code})))),
                    adapter.on_frame(Arc::new(move |frame: &HelperFrame| {
                        log_push(
                            &framed,
                            json!({
                                "ev": "frame",
                                "width": frame.width,
                                "height": frame.height,
                                "stride": frame.stride,
                                "originX": frame.origin_x,
                                "originY": frame.origin_y,
                                "bytes": frame.pixels.len(),
                            }),
                        );
                    })),
                ];
            }
            "unlisten" => {
                for off in listening.drain(..) {
                    off();
                }
            }
            "dispose" => adapter.dispose(),
            "advance" => {
                let ms = step["ms"].as_u64().expect("ms");
                let ran = timers.advance(ms).await;
                log_push(&log, json!({"ev": "advance", "ms": ms, "ran": ran}));
            }
            "settle" => replay.settle().await,
            "await" => {
                replay.settle().await;
                let name = step["call"].as_str().expect("a call");
                assert!(lock(&calls).get(name).copied().unwrap_or(false), "{}: {name} did not finish", scenario["name"]);
            }
            other => panic!("unknown step {other}"),
        }
    }
    replay.settle().await;
    let final_state = json!({"elapsedMs": timers.elapsed(), "pendingTimers": timers.pending(), "connectsRunning": lock(&service.connects).len()});
    (log_take(&log), final_state)
}

#[test]
fn every_recorded_adapter_scenario_replays_to_nodes_whole_trace() {
    let recording: Value = serde_json::from_str(RECORDING).expect("the recording parses");
    let scenarios = recording["scenarios"].as_array().expect("scenarios");
    manifest_names(MANIFEST, scenarios);
    let mut failures = Vec::new();
    for scenario in scenarios {
        let name = scenario["name"].as_str().expect("a scenario name");
        let (trace, final_state) = Replay::run(|replay| play(replay, scenario.clone()));
        let want = scenario["trace"].as_array().expect("a trace");
        if let Some(index) = (0..trace.len().max(want.len())).find(|&index| trace.get(index) != want.get(index)) {
            failures.push(format!("{name}: trace event {index}\n  rust: {:?}\n  node: {:?}", trace.get(index), want.get(index)));
        } else if final_state != scenario["final"] {
            failures.push(format!("{name}: the final state\n  rust: {final_state}\n  node: {}", scenario["final"]));
        }
    }
    assert!(failures.is_empty(), "{} of {} scenarios differ from Node:\n{}", failures.len(), scenarios.len(), failures.join("\n"));
}
