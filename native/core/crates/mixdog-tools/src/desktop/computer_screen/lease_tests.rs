//! Replay of Node's helper lease (recorded by `record-screen-control-lease.mjs` from the export of b6f10295a):
//! every scenario's script is run against Rust's lease with a fake adapter and a fake installer port that only
//! records what it is asked; the whole trace (adapter calls across rebuilt adapters, installer calls, listener
//! notifications, each call's outcome) and the final state must equal the recording.

use std::collections::HashMap;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::Weak;

use mixdog_core_api::domain::computer::ScreenInput;
use serde_json::Value;
use serde_json::json;
use tokio::sync::oneshot;

use super::installer::HelperStatus;
use super::installer::InstallResult;
use super::installer::InstallState;
use super::lease::Challenge;
use super::lease::DECLINED_ON_PC;
use super::lease::Grant;
use super::lease::HelperAdapter;
use super::lease::HelperDeps;
use super::lease::HelperError;
use super::lease::HelperFrame;
use super::lease::InstallPort;
use super::lease::SecureDesktopHelper;
use super::lease::SecureDesktopLease;
use super::lease::Unsub;
use super::router::BoxFuture;
use super::testing::Log;
use super::testing::Sim;
use super::testing::log_new;
use super::testing::log_push;
use super::testing::log_take;

const RECORDING: &str = include_str!("../../../../../fixtures/screen-control/lease/scenarios.json");

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

type Callbacks<T> = Mutex<(u64, Vec<(u64, Arc<dyn Fn(&T) + Send + Sync>)>)>;

fn add<T: 'static>(set: &Arc<Callbacks<T>>, listener: Arc<dyn Fn(&T) + Send + Sync>) -> Unsub {
    let id = {
        let mut held = lock(set);
        held.0 += 1;
        let id = held.0;
        held.1.push((id, listener));
        id
    };
    let set = set.clone();
    Box::new(move || lock(&set).1.retain(|(held, _)| *held != id))
}

fn fire<T>(set: &Callbacks<T>, value: &T) {
    let listeners: Vec<_> = lock(set).1.iter().map(|(_, listener)| listener.clone()).collect();
    for listener in listeners {
        listener(value);
    }
}

struct FakeAdapter {
    index: usize,
    installed: bool,
    connected: Mutex<bool>,
    change: Arc<Callbacks<()>>,
    frame: Arc<Callbacks<HelperFrame>>,
    challenge: Arc<Callbacks<Challenge>>,
    issue: Arc<Callbacks<String>>,
    log: Log,
}

impl FakeAdapter {
    fn note(&self, call: Value) {
        log_push(&self.log, json!({"ev": "adapter", "adapter": self.index, "call": call}));
    }

    fn attached(&self) -> usize {
        lock(&self.change).1.len() + lock(&self.frame).1.len() + lock(&self.challenge).1.len() + lock(&self.issue).1.len()
    }
}

impl HelperAdapter for FakeAdapter {
    fn installed(&self) -> bool {
        self.installed
    }

    fn connected(&self) -> bool {
        *lock(&self.connected)
    }

    fn desktop(&self) -> Option<String> {
        None
    }

    fn session(&self) -> Option<u32> {
        None
    }

    fn locked(&self) -> Option<bool> {
        None
    }

    fn set_active(&self, active: bool) -> BoxFuture<()> {
        self.note(json!(["active", active]));
        Box::pin(async {})
    }

    fn send_input(&self, command: ScreenInput) -> BoxFuture<Result<(), HelperError>> {
        let op = match command {
            ScreenInput::Key { .. } => "key",
            _ => "other",
        };
        self.note(json!(["input", op]));
        Box::pin(async { Ok(()) })
    }

    fn send_grant(&self, grant: Grant) -> BoxFuture<Result<(), HelperError>> {
        self.note(json!(["grant", grant.epoch]));
        Box::pin(async { Ok(()) })
    }

    fn set_video_run(&self, epoch: u64) {
        self.note(json!(["run", epoch]));
    }

    fn latest_frame(&self) -> Option<HelperFrame> {
        None
    }

    fn on_frame(&self, listener: Arc<dyn Fn(&HelperFrame) + Send + Sync>) -> Unsub {
        add(&self.frame, listener)
    }

    fn on_desktop_changed(&self, listener: Arc<dyn Fn(&()) + Send + Sync>) -> Unsub {
        add(&self.change, listener)
    }

    fn on_grant_challenge(&self, listener: Arc<dyn Fn(&Challenge) + Send + Sync>) -> Unsub {
        add(&self.challenge, listener)
    }

    fn on_helper_issue(&self, listener: Arc<dyn Fn(&String) + Send + Sync>) -> Unsub {
        add(&self.issue, listener)
    }

    fn dispose(&self) {
        self.note(json!(["dispose"]));
    }
}

struct Installer {
    current: Mutex<InstallState>,
    result: Mutex<Option<InstallResult>>,
    defer_request: Mutex<bool>,
    defer_ensure: Mutex<bool>,
    requests: Mutex<Vec<oneshot::Sender<InstallResult>>>,
    ensures: Mutex<VecDeque<oneshot::Sender<HelperStatus>>>,
    log: Log,
}

impl InstallPort for Installer {
    fn state(&self, controller_key: Option<String>) -> BoxFuture<InstallState> {
        log_push(&self.log, json!({"ev": "installer", "call": "state", "key": controller_key}));
        let state = *lock(&self.current);
        Box::pin(async move { state })
    }

    fn request(&self, controller_key: String) -> BoxFuture<InstallResult> {
        log_push(&self.log, json!({"ev": "installer", "call": "request", "key": controller_key}));
        if *lock(&self.defer_request) {
            let (send, receive) = oneshot::channel();
            lock(&self.requests).push(send);
            return Box::pin(async move { receive.await.expect("the script finishes the request") });
        }
        let result = lock(&self.result).clone().expect("a result was set");
        Box::pin(async move { result })
    }

    fn ensure_running(&self) -> BoxFuture<HelperStatus> {
        log_push(&self.log, json!({"ev": "installer", "call": "ensureRunning"}));
        if *lock(&self.defer_ensure) {
            let (send, receive) = oneshot::channel();
            lock(&self.ensures).push_back(send);
            return Box::pin(async move { receive.await.expect("the script finishes the start") });
        }
        Box::pin(async { HelperStatus { installed: true, running: true, version: None } })
    }
}

fn frame_of(id: u32) -> HelperFrame {
    HelperFrame { width: id, height: 0, stride: 0, origin_x: 0, origin_y: 0, pixels: Arc::new(Vec::new()) }
}

fn outcome_value<T: serde::Serialize>(result: Result<T, HelperError>) -> (bool, Value) {
    match result {
        Ok(value) => (true, serde_json::to_value(value).expect("serializes")),
        Err(error) => (false, json!(error.0)),
    }
}

fn play(scenario: &Value) -> (Vec<Value>, Value) {
    let name = scenario["name"].as_str().expect("a scenario name");
    let log = log_new();
    let built: Arc<Mutex<Vec<Arc<FakeAdapter>>>> = Arc::new(Mutex::new(Vec::new()));
    let first_installed = scenario["world"]["installed"].as_bool().expect("installed");
    let installer = Arc::new(Installer {
        current: Mutex::new(serde_json::from_value(scenario["world"]["state"].clone()).expect("a state")),
        result: Mutex::new(None),
        defer_request: Mutex::new(false),
        defer_ensure: Mutex::new(false),
        requests: Mutex::new(Vec::new()),
        ensures: Mutex::new(VecDeque::new()),
        log: log.clone(),
    });
    let factory_built = built.clone();
    let factory_log = log.clone();
    let helper = SecureDesktopHelper::new(HelperDeps {
        adapter: Box::new(move || {
            let mut held = lock(&factory_built);
            let adapter = Arc::new(FakeAdapter {
                index: held.len(),
                installed: held.is_empty().then_some(first_installed).unwrap_or(true),
                connected: Mutex::new(false),
                change: Arc::new(Mutex::new((0, Vec::new()))),
                frame: Arc::new(Mutex::new((0, Vec::new()))),
                challenge: Arc::new(Mutex::new((0, Vec::new()))),
                issue: Arc::new(Mutex::new((0, Vec::new()))),
                log: factory_log.clone(),
            });
            held.push(adapter.clone());
            adapter
        }),
        installer: installer.clone(),
    });
    let sim = Sim::new();
    let finished: Arc<Mutex<HashMap<String, bool>>> = Arc::new(Mutex::new(HashMap::new()));
    let start = |call: &str, future: BoxFuture<(bool, Value)>| {
        lock(&finished).insert(call.to_string(), false);
        let call = call.to_string();
        let log = log.clone();
        let finished = finished.clone();
        sim.spawn(Box::pin(async move {
            let (ok, value) = future.await;
            let event = if ok { json!({"ev": "done", "call": call, "ok": true, "value": value}) } else { json!({"ev": "done", "call": call, "ok": false, "error": value}) };
            log_push(&log, event);
            lock(&finished).insert(call, true);
        }));
    };
    let mut leases: Vec<(String, Arc<SecureDesktopLease>)> = Vec::new();
    let find = |leases: &Vec<(String, Arc<SecureDesktopLease>)>, step: &Value| {
        let wanted = step["lease"].as_str()?;
        leases.iter().find(|(held, _)| held == wanted).map(|(_, lease)| lease.clone())
    };
    let current = |built: &Arc<Mutex<Vec<Arc<FakeAdapter>>>>| lock(built).last().expect("an adapter").clone();
    for step in scenario["steps"].as_array().expect("steps") {
        let call = step["as"].as_str().unwrap_or_default();
        let held = find(&leases, step);
        match step["op"].as_str().expect("a step op") {
            "lease" => leases.push((call.to_string(), Arc::new(helper.lease()))),
            "listen" => {
                let held = held.expect("a lease");
                let lease_name = step["lease"].as_str().expect("a lease").to_string();
                let hold = step["hold"].clone();
                let weak: Weak<SecureDesktopLease> = Arc::downgrade(&held);
                let hold_log = log.clone();
                let hold_name = lease_name.clone();
                drop(held.on_hold(Arc::new(move |_: &()| {
                    let Some(lease) = weak.upgrade() else {
                        return;
                    };
                    if hold == "mint" {
                        let epoch = lease.mint_video_run();
                        log_push(&hold_log, json!({"ev": "hold", "lease": hold_name, "epoch": epoch}));
                        lease.set_video_run(epoch);
                    } else if hold.is_null() {
                        log_push(&hold_log, json!({"ev": "hold", "lease": hold_name, "epoch": null}));
                    } else {
                        let epoch = hold["declare"].as_u64().expect("an epoch");
                        log_push(&hold_log, json!({"ev": "hold", "lease": hold_name, "epoch": epoch}));
                        lease.set_video_run(epoch);
                    }
                })));
                let weak = Arc::downgrade(&held);
                let change_log = log.clone();
                let change_name = lease_name.clone();
                drop(held.on_desktop_changed(Arc::new(move |_: &()| {
                    if let Some(lease) = weak.upgrade() {
                        log_push(&change_log, json!({"ev": "heard", "lease": change_name, "kind": "change", "ownedElsewhere": lease.owned_elsewhere(), "installed": lease.installed()}));
                    }
                })));
                let challenge_log = log.clone();
                let challenge_name = lease_name.clone();
                drop(held.on_grant_challenge(Arc::new(move |challenge: &Challenge| {
                    log_push(&challenge_log, json!({"ev": "heard", "lease": challenge_name, "kind": "challenge", "challenge": {"nonce": challenge.nonce, "challenge": challenge.challenge}}));
                })));
                let issue_log = log.clone();
                let issue_name = lease_name.clone();
                drop(held.on_helper_issue(Arc::new(move |code: &String| {
                    log_push(&issue_log, json!({"ev": "heard", "lease": issue_name, "kind": "issue", "code": code}));
                })));
                let frame_log = log.clone();
                drop(held.on_frame(Arc::new(move |frame: &HelperFrame| {
                    log_push(&frame_log, json!({"ev": "heard", "lease": lease_name, "kind": "frame", "frame": {"id": frame.width}}));
                })));
            }
            "setActive" => {
                let pending = held.expect("a lease").set_active(step["active"].as_bool().expect("a flag"));
                start(call, Box::pin(async move {
                    pending.await;
                    (true, Value::Null)
                }));
            }
            "setVideoRun" => {
                held.expect("a lease").set_video_run(step["epoch"].as_u64().expect("an epoch"));
                log_push(&log, json!({"ev": "declared", "lease": step["lease"], "epoch": step["epoch"]}));
            }
            "mintRun" => {
                let lease = held.expect("a lease");
                let epoch = lease.mint_video_run();
                log_push(&log, json!({"ev": "minted", "lease": step["lease"], "epoch": epoch}));
                if step["declare"] == true {
                    lease.set_video_run(epoch);
                }
            }
            "sendGrant" => {
                let grant = Grant { challenge: step["grant"]["challenge"].as_str().expect("c").to_string(), epoch: step["grant"]["epoch"].as_u64().expect("e"), signature: step["grant"]["signature"].as_str().expect("s").to_string() };
                let pending = held.expect("a lease").send_grant(grant);
                start(call, Box::pin(async move { outcome_value(pending.await.map(|()| Value::Null)) }));
            }
            "sendInput" => {
                let pending = held.expect("a lease").send_input(ScreenInput::Key { vk: 0x41, scan: 0x1e, extended: false, down: true });
                start(call, Box::pin(async move { outcome_value(pending.await.map(|()| Value::Null)) }));
            }
            "latestFrame" => {
                let frame = held.expect("a lease").latest_frame().map_or(Value::Null, |frame| json!({"id": frame.width}));
                log_push(&log, json!({"ev": "latestFrame", "lease": step["lease"], "frame": frame}));
            }
            "query" => {
                let lease = held.expect("a lease");
                let value = if step["what"] == "installed" { lease.installed() } else { lease.owned_elsewhere() };
                log_push(&log, json!({"ev": "query", "lease": step["lease"], "what": step["what"], "value": value}));
            }
            "requestInstall" => {
                let pending = held.expect("a lease").request_install(step["key"].as_str().expect("a key"));
                start(call, Box::pin(async move { (true, serde_json::to_value(pending.await).expect("serializes")) }));
            }
            "installState" => {
                let pending = held.expect("a lease").install_state(step["key"].as_str().map(str::to_string));
                start(call, Box::pin(async move { (true, serde_json::to_value(pending.await).expect("serializes")) }));
            }
            "ensureRunning" => {
                let pending = held.expect("a lease").ensure_running();
                start(call, Box::pin(async move { (true, serde_json::to_value(pending.await).expect("serializes")) }));
            }
            "disposeLease" => held.expect("a lease").dispose(),
            "disposeHelper" => helper.dispose(),
            "adapterChallenge" => fire(&current(&built).challenge, &Challenge { nonce: step["nonce"].as_str().expect("n").to_string(), challenge: step["challenge"].as_str().expect("c").to_string() }),
            "adapterIssue" => fire(&current(&built).issue, &step["code"].as_str().expect("a code").to_string()),
            "adapterFrame" => fire(&current(&built).frame, &frame_of(step["frame"]["id"].as_u64().expect("an id") as u32)),
            "adapterConnected" => *lock(&current(&built).connected) = step["value"].as_bool().expect("a flag"),
            "installerState" => *lock(&installer.current) = serde_json::from_value(step["value"].clone()).expect("a state"),
            "installerResult" => *lock(&installer.result) = Some(serde_json::from_value(step["value"].clone()).expect("a result")),
            "installerDefer" => {
                *lock(&installer.defer_request) = step["request"].as_bool().expect("a flag");
                *lock(&installer.defer_ensure) = step["ensure"].as_bool().expect("a flag");
            }
            "finishRequest" => {
                let send = lock(&installer.requests).remove(0);
                assert!(send.send(serde_json::from_value(step["result"].clone()).expect("a result")).is_ok(), "{name}: the request still waits");
            }
            "finishEnsure" => {
                let send = lock(&installer.ensures).pop_front().expect("a start is waiting");
                assert!(send.send(serde_json::from_value(step["result"].clone()).expect("a status")).is_ok(), "{name}: the start still waits");
            }
            "settle" => sim.settle(),
            "await" => {
                sim.settle();
                let awaited = step["call"].as_str().expect("a call");
                assert!(lock(&finished).get(awaited).copied().unwrap_or(false), "{name}: {awaited} did not finish");
            }
            other => panic!("unknown step {other}"),
        }
    }
    sim.settle();
    let adapters = lock(&built).clone();
    let owned: serde_json::Map<String, Value> = leases.iter().map(|(held, lease)| (held.clone(), json!(lease.owned_elsewhere()))).collect();
    let final_state = json!({"built": adapters.len(), "attached": adapters.iter().map(|adapter| adapter.attached()).collect::<Vec<_>>(), "ownedElsewhere": owned});
    (log_take(&log), final_state)
}

#[test]
fn every_recorded_lease_scenario_replays_to_nodes_whole_trace() {
    let recording: Value = serde_json::from_str(RECORDING).expect("the recording parses");
    assert_eq!(recording["declinedOnPc"], DECLINED_ON_PC, "the latched decline's text");
    let scenarios = recording["scenarios"].as_array().expect("scenarios");
    assert!(scenarios.len() >= 13, "the recording holds {} scenarios", scenarios.len());
    for scenario in scenarios {
        let name = scenario["name"].as_str().expect("a scenario name");
        let (trace, final_state) = play(scenario);
        assert_eq!(Value::Array(trace), scenario["trace"], "{name}: the trace");
        assert_eq!(final_state, scenario["final"], "{name}: the final state");
    }
}
