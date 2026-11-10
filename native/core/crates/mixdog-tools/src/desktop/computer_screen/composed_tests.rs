//! Replay of Node's composed screen control (recorded by `record-screen-control-composed.mjs` from the export of
//! b6f10295a): a viewer's session on a lease of the helper of [`ScreenControl`], whose adapter runs over the helper
//! client, driven end to end on the product's runtime. The fakes sit at the edges only — the helper's pipe (records
//! what the client writes, takes each write one turn later), the installer, the input host, the displays, the
//! authorization, the indicator and the log. The whole trace and the final state must equal the recording.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::Weak;

use mixdog_secure_desktop::protocol::Message;
use serde_json::Value;
use serde_json::json;

use super::helper_client::ClientSession;
use super::helper_client::HelperConnector;
use super::helper_client::HelperPipe;
use super::helper_client::PipeEvents;
use super::installer::HelperStatus;
use super::installer::InstallResult;
use super::installer::InstallState;
use super::lease::Challenge;
use super::lease::Grant;
use super::lease::InstallPort;
use super::lease::Listener;
use super::lease::ListenerSet;
use super::lease::Unsub;
use super::router::BoxFuture;
use super::router::RouteOutcome;
use super::service::ScreenControl;
use super::session::HostCommand;
use super::session::IndicatorView;
use super::session::ScreenDisplay;
use super::session::ScreenDisplays;
use super::session::ScreenHost;
use super::session::ScreenIndicator;
use super::session::ScreenSession;
use super::session::SessionDeps;
use super::session::ViewerAuthorization;
use super::switch::LocalDesktop;
use super::testing::Log;
use super::testing::Replay;
use super::testing::VirtualTimers;
use super::testing::log_new;
use super::testing::log_push;
use super::testing::log_take;
use super::testing::manifest_names;
use super::testing::next_turn;

const RECORDING: &str = include_str!("../../../../../fixtures/screen-control/composed/scenarios.json");
const MANIFEST: &str = include_str!("../../../../../fixtures/screen-control/composed/MANIFEST.json");

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn answer<T: Send + 'static>(value: T) -> BoxFuture<T> {
    Box::pin(async move {
        next_turn().await;
        value
    })
}

fn note(log: &Log, who: &str, call: &str, fields: Value) {
    let mut event = json!({"ev": who, "call": call});
    if let (Some(event), Value::Object(fields)) = (event.as_object_mut(), fields) {
        event.extend(fields);
    }
    log_push(log, event);
}

struct Pipe {
    log: Log,
    replay: Replay,
}

impl HelperPipe for Pipe {
    fn write(&self, message: Message, done: Box<dyn FnOnce(Result<(), String>) + Send>) {
        note(&self.log, "pipe", "write", json!({"message": message}));
        self.replay.spawn(Box::pin(async move { done(Ok(())) }));
    }
    fn end(&self) {
        note(&self.log, "pipe", "end", json!({}));
    }
}

struct Connector {
    log: Log,
    replay: Replay,
    installed: bool,
    events: Mutex<Option<Arc<dyn PipeEvents>>>,
}

impl HelperConnector for Connector {
    fn available(&self) -> bool {
        self.installed
    }
    fn connect(&self, events: Arc<dyn PipeEvents>) -> BoxFuture<Result<(Arc<dyn HelperPipe>, ClientSession), String>> {
        note(&self.log, "pipe", "open", json!({}));
        *lock(&self.events) = Some(events);
        let pipe: Arc<dyn HelperPipe> = Arc::new(Pipe { log: self.log.clone(), replay: self.replay.clone() });
        let hello = ClientSession { protocol: 4, version: "1.4.5".to_string(), session: 1, desktop: "Winlogon".to_string(), locked: Some(false) };
        answer(Ok((pipe, hello)))
    }
}

struct Installer {
    log: Log,
    state: InstallState,
}

impl InstallPort for Installer {
    fn state(&self, controller_key: Option<String>) -> BoxFuture<InstallState> {
        note(&self.log, "installer", "state", json!({"key": controller_key}));
        answer(self.state)
    }
    fn request(&self, controller_key: String) -> BoxFuture<InstallResult> {
        note(&self.log, "installer", "request", json!({"key": controller_key}));
        answer(InstallResult { outcome: super::installer::InstallOutcome::Declined, state: self.state, detail: None })
    }
    fn ensure_running(&self) -> BoxFuture<HelperStatus> {
        note(&self.log, "installer", "ensureRunning", json!({}));
        answer(HelperStatus { installed: self.state == InstallState::Installed, running: true, version: None })
    }
}

struct Host {
    log: Log,
    local: Mutex<LocalDesktop>,
    desktop: Arc<ListenerSet<LocalDesktop>>,
}

impl ScreenHost for Host {
    fn start(&self) -> BoxFuture<Result<(), String>> {
        note(&self.log, "host", "start", json!({}));
        answer(Ok(()))
    }
    fn command(&self, command: HostCommand) -> BoxFuture<Result<Vec<String>, String>> {
        let HostCommand::Input(mixdog_core_api::domain::computer::ScreenInput::Key { vk, scan, extended, down }) = command else {
            panic!("the composed scenarios send keys only");
        };
        note(&self.log, "host", "command", json!({"command": {"op": "key", "vk": vk, "scan": scan, "extended": extended, "down": down}}));
        answer(Ok(Vec::new()))
    }
    fn desktop(&self) -> Option<LocalDesktop> {
        Some(lock(&self.local).clone())
    }
    fn session(&self) -> Option<u32> {
        Some(1)
    }
    fn on_desktop(&self, listener: Listener<LocalDesktop>) -> Unsub {
        self.desktop.add(listener)
    }
    fn on_exit(&self, _listener: Listener<()>) -> Unsub {
        Box::new(|| {})
    }
    fn stop(&self) -> BoxFuture<()> {
        note(&self.log, "host", "stop", json!({}));
        answer(())
    }
    fn kill(&self) {
        note(&self.log, "host", "kill", json!({}));
    }
}

struct Displays;

impl ScreenDisplays for Displays {
    fn list(&self) -> Vec<ScreenDisplay> {
        vec![
            serde_json::from_value(json!({
                "screenId": "7",
                "label": "Display 1",
                "primary": true,
                "scaleFactor": 1,
                "bounds": {"x": 0, "y": 0, "width": 1920, "height": 1080},
                "physical": {"x": 0, "y": 0, "width": 1920, "height": 1080},
                "captureSourceId": "screen:0:0",
            }))
            .expect("a display"),
        ]
    }
    fn on_change(&self, _listener: Listener<()>) -> Unsub {
        Box::new(|| {})
    }
}

struct Paired;

impl ViewerAuthorization for Paired {
    fn paired(&self) -> bool {
        true
    }
    fn lost(&self) -> String {
        "revoked".to_string()
    }
    fn on_change(&self, _listener: Listener<()>) -> Unsub {
        Box::new(|| {})
    }
}

struct Indicator(Log);

impl ScreenIndicator for Indicator {
    fn show(&self, view: IndicatorView) {
        note(&self.0, "indicator", "show", json!({"controlling": view.controlling}));
    }
    fn update(&self, controlling: bool) {
        note(&self.0, "indicator", "update", json!({"controlling": controlling}));
    }
    fn hide(&self) {
        note(&self.0, "indicator", "hide", json!({}));
    }
}

fn local_of(value: &Value) -> LocalDesktop {
    serde_json::from_value(value.clone()).expect("a local desktop")
}

async fn play(replay: Replay, scenario: Value) -> (Vec<Value>, Value) {
    let world = &scenario["world"];
    let log = log_new();
    let timers = VirtualTimers::new(replay.clone());
    let connector = Arc::new(Connector {
        log: log.clone(),
        replay: replay.clone(),
        installed: world.get("notInstalled").is_none(),
        events: Mutex::new(None),
    });
    let install_state: InstallState = serde_json::from_value(world["installState"].clone()).expect("an install state");
    let control = ScreenControl::new(connector.clone(), Arc::new(Installer { log: log.clone(), state: install_state }), Arc::new(timers.clone()));
    let lease = control.lease();
    let host = Arc::new(Host {
        log: log.clone(),
        local: Mutex::new(local_of(&json!({"inputDesktop": "Default", "consent": false, "logonUi": false}))),
        desktop: ListenerSet::new(),
    });
    let event_log = log.clone();
    let created = host.clone();
    let session = Arc::new(ScreenSession::new(SessionDeps {
        client_id: "phone-1".to_string(),
        client_label: "Phone".to_string(),
        screen_id: "7".to_string(),
        displays: Arc::new(Displays),
        authorization: Arc::new(Paired),
        create_input_host: Box::new(move || created.clone()),
        secure_desktop: lease.clone(),
        pc_access: None,
        indicator: Arc::new(Indicator(log.clone())),
        log: Box::new(move |event| log_push(&event_log, json!({"ev": "log", "event": event}))),
        timers: Arc::new(timers.clone()),
        max_frame_rate: None,
        sample_cursor: false,
        shutdown_deadline_ms: None,
    }));
    let listen_log = log.clone();
    drop(session.on_status(Arc::new(move |status: &Value| log_push(&listen_log, json!({"ev": "status", "status": status})))));
    let listen_log = log.clone();
    drop(session.on_video_path(Arc::new(move |path| log_push(&listen_log, json!({"ev": "videoPath", "path": path})))));
    // The viewer's side (screen-webrtc-source.ts): a fresh run on the hold, each challenge kept for the grant.
    let run: Arc<Mutex<Option<u64>>> = Arc::new(Mutex::new(None));
    let challenge: Arc<Mutex<Option<Challenge>>> = Arc::new(Mutex::new(None));
    let (held_run, held_log, viewer): (_, _, Weak<ScreenSession>) = (run.clone(), log.clone(), Arc::downgrade(&session));
    drop(session.on_helper_hold(Arc::new(move |_: &()| {
        let Some(viewer) = viewer.upgrade() else {
            return;
        };
        let epoch = viewer.next_video_run();
        *lock(&held_run) = Some(epoch);
        log_push(&held_log, json!({"ev": "hold", "run": epoch}));
        viewer.set_video_run(epoch);
    })));
    let (kept, kept_log) = (challenge.clone(), log.clone());
    drop(session.on_helper_challenge(Arc::new(move |next: &Challenge| {
        *lock(&kept) = Some(next.clone());
        log_push(&kept_log, json!({"ev": "challenge", "challenge": {"nonce": next.nonce, "challenge": next.challenge}}));
    })));

    let calls: Arc<Mutex<HashMap<String, bool>>> = Arc::new(Mutex::new(HashMap::new()));
    let start_call = |name: &str, done: BoxFuture<Value>| {
        lock(&calls).insert(name.to_string(), false);
        let (calls, log, name) = (calls.clone(), log.clone(), name.to_string());
        replay.spawn(Box::pin(async move {
            let mut event = done.await;
            lock(&calls).insert(name.clone(), true);
            event["call"] = json!(name);
            log_push(&log, event);
        }));
    };
    for step in scenario["steps"].as_array().expect("steps") {
        let call = step["as"].as_str().unwrap_or_default();
        match step["op"].as_str().expect("a step op") {
            "start" => {
                let started = session.start();
                start_call(
                    call,
                    Box::pin(async move {
                        match started.await {
                            Ok(value) => json!({"ev": "done", "ok": true, "value": value}),
                            Err(error) => json!({"ev": "done", "ok": false, "error": error}),
                        }
                    }),
                );
            }
            "query" => log_push(&log, json!({"ev": "query", "status": session.status(), "videoPath": session.video_path()})),
            "hostDesktop" => {
                let local = local_of(&step["local"]);
                *lock(&host.local) = local.clone();
                host.desktop.call(&local);
            }
            "peer" => {
                let events = lock(&connector.events).clone().expect("the client dialled");
                let message = &step["message"];
                match message["type"].as_str().expect("a message type") {
                    "grant-challenge" => events.grant_challenge(Challenge {
                        nonce: message["nonce"].as_str().expect("a nonce").to_string(),
                        challenge: message["challenge"].as_str().expect("a challenge").to_string(),
                    }),
                    "desktop-changed" => events.desktop_changed(
                        message["desktop"].as_str().expect("a desktop").to_string(),
                        message["session"].as_u64().expect("a session") as u32,
                        message["locked"].as_bool(),
                    ),
                    other => panic!("unknown peer message {other}"),
                }
            }
            "grant" => {
                let epoch = lock(&run).expect("a run");
                let challenge = lock(&challenge).clone().expect("a challenge");
                session.helper_grant(Grant { challenge: challenge.challenge, epoch, signature: "signed-by-the-phone".to_string() });
            }
            "helperVideo" => session.set_helper_video(step["value"].as_bool().expect("a flag")),
            "input" => {
                let handled = session.handle_input(&step["input"], 1);
                start_call(
                    call,
                    Box::pin(async move {
                        let outcome = handled.await;
                        json!({"ev": "done", "ok": true, "value": if outcome == RouteOutcome::Applied { "applied" } else { "rejected" }})
                    }),
                );
            }
            "stop" => {
                let stopped = session.stop("user", None);
                start_call(
                    call,
                    Box::pin(async move {
                        stopped.await;
                        json!({"ev": "done", "ok": true, "value": null})
                    }),
                );
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
    lease.dispose();
    control.dispose();
    replay.settle().await;
    let final_state = json!({"elapsedMs": timers.elapsed(), "pendingTimers": timers.pending()});
    (log_take(&log), final_state)
}

#[test]
fn every_recorded_composed_scenario_replays_to_nodes_whole_trace() {
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
