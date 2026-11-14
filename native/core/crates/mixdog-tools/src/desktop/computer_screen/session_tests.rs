//! Replay of Node's screen session (recorded by `record-screen-control-session.mjs` from the export of b6f10295a):
//! every scenario's script is run against Rust's session on the product's runtime and the virtual clock, with
//! fakes of every dependency (displays, authorization, input host, helper lease, PC access, indicator, log) that
//! only record what they are told and answer as Node's do, through a promise (one turn later). The whole trace and
//! the final state must equal the recording.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;

use mixdog_core_api::domain::computer::ScreenInput;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio::sync::oneshot;

use super::installer::Credential;
use super::installer::HelperStatus;
use super::installer::InstallResult;
use super::installer::InstallState;
use super::lease::Challenge;
use super::lease::Grant;
use super::lease::HelperError;
use super::lease::HelperFrame;
use super::lease::Listener;
use super::lease::ListenerSet;
use super::lease::Unsub;
use super::router::BoxFuture;
use super::router::RouteOutcome;
use super::session::AbortSignal;
use super::session::CredentialResult;
use super::session::HostCommand;
use super::session::IndicatorView;
use super::session::ScreenDisplay;
use super::session::ScreenDisplays;
use super::session::ScreenHost;
use super::session::ScreenIndicator;
use super::session::ScreenPcAccess;
use super::session::ScreenSession;
use super::session::SessionDeps;
use super::session::SessionHelper;
use super::session::SharedCredential;
use super::session::ViewerAuthorization;
use super::session::number;
use super::super::computer_screen_input::InputDesktop;
use super::switch::HelperView;
use super::testing::Gate;
use super::testing::Log;
use super::testing::Replay;
use super::testing::VirtualTimers;
use super::testing::log_new;
use super::testing::log_push;
use super::testing::log_take;
use super::testing::manifest_names;
use super::testing::next_turn;

const RECORDING: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/screen-control/session/scenarios.json");
const MANIFEST: &str = include_str!("../../../../../fixtures/screen-control/session/MANIFEST.json");

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn answer<T: Send + 'static>(value: T) -> BoxFuture<T> {
    Box::pin(async move {
        next_turn().await;
        value
    })
}

/// A promise the script settles later; one never settled stays pending.
fn deferred<T: Send + 'static>(pending: &Mutex<Vec<oneshot::Sender<T>>>) -> BoxFuture<T> {
    let (sender, receiver) = oneshot::channel();
    lock(pending).push(sender);
    Box::pin(async move {
        match receiver.await {
            Ok(value) => value,
            Err(_) => std::future::pending().await,
        }
    })
}

fn note(log: &Log, who: &str, call: &str, fields: Value) {
    let mut event = Map::new();
    event.insert("ev".into(), json!(who));
    event.insert("call".into(), json!(call));
    if let Value::Object(mut fields) = fields {
        event.append(&mut fields);
    }
    log_push(log, Value::Object(event));
}

fn command_json(command: &HostCommand) -> Value {
    match command {
        HostCommand::Cursor => json!({"op": "cursor"}),
        HostCommand::Input(input) => input_json(input),
    }
}

fn input_json(command: &ScreenInput) -> Value {
    let button = |button: &mixdog_core_api::domain::computer::PointerButton| match button {
        mixdog_core_api::domain::computer::PointerButton::Left => "left",
        mixdog_core_api::domain::computer::PointerButton::Right => "right",
        mixdog_core_api::domain::computer::PointerButton::Middle => "middle",
    };
    match command {
        ScreenInput::Move { x, y } => json!({"op": "move", "x": x, "y": y}),
        ScreenInput::Button { button: pressed, down, at } => {
            let mut value = json!({"op": "button", "button": button(pressed), "down": down});
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

#[derive(Default)]
struct Helper {
    installed: bool,
    connected: bool,
    desktop: Option<String>,
    session: Option<u32>,
    locked: Option<bool>,
    owned_elsewhere: bool,
}

impl Helper {
    fn merge(&mut self, fields: &Value) {
        let Some(fields) = fields.as_object() else {
            return;
        };
        for (field, value) in fields {
            match field.as_str() {
                "installed" => self.installed = value.as_bool().expect("installed"),
                "connected" => self.connected = value.as_bool().expect("connected"),
                "desktop" => self.desktop = value.as_str().map(str::to_string),
                "session" => self.session = value.as_u64().map(|session| session as u32),
                "locked" => self.locked = value.as_bool(),
                "ownedElsewhere" => self.owned_elsewhere = value.as_bool().expect("ownedElsewhere"),
                other => panic!("unknown helper field {other}"),
            }
        }
    }
}

struct World {
    paired: bool,
    lost: String,
    displays: Vec<ScreenDisplay>,
    install_state: InstallState,
    helper: Helper,
    ensure: Vec<Value>,
    ensures: usize,
    cursor: Vec<Value>,
    cursors: usize,
    account_is_admin: Option<bool>,
    host_start_fails: Option<String>,
    host_stop_hangs: bool,
    host_fails: Option<String>,
    host_hangs: bool,
    local: InputDesktop,
    runs: u64,
}

struct Fakes {
    world: Mutex<World>,
    log: Log,
    display_change: Arc<ListenerSet<()>>,
    auth_change: Arc<ListenerSet<()>>,
    host_desktop: Arc<ListenerSet<InputDesktop>>,
    host_exit: Arc<ListenerSet<()>>,
    helper_change: Arc<ListenerSet<()>>,
    helper_frame: Arc<ListenerSet<HelperFrame>>,
    helper_challenge: Arc<ListenerSet<Challenge>>,
    helper_issue: Arc<ListenerSet<String>>,
    helper_hold: Arc<ListenerSet<()>>,
    installs: Mutex<Vec<oneshot::Sender<Result<InstallResult, String>>>>,
    credentials: Mutex<Vec<oneshot::Sender<Result<CredentialResult, String>>>>,
    credentials_given: Mutex<Vec<SharedCredential>>,
    indicator_stop: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

struct Host(Arc<Fakes>);

impl ScreenHost for Host {
    fn start(&self) -> BoxFuture<Result<(), String>> {
        note(&self.0.log, "host", "start", json!({}));
        answer(lock(&self.0.world).host_start_fails.clone().map_or(Ok(()), Err))
    }
    fn command(&self, command: HostCommand) -> BoxFuture<Result<Vec<String>, String>> {
        note(&self.0.log, "host", "command", json!({"command": command_json(&command)}));
        let mut world = lock(&self.0.world);
        if world.host_hangs {
            let gate = Gate::hung();
            return Box::pin(async move {
                gate.wait().await;
                Ok(Vec::new())
            });
        }
        if let Some(error) = world.host_fails.clone() {
            return answer(Err(error));
        }
        if command == HostCommand::Cursor {
            let index = world.cursors.min(world.cursor.len().saturating_sub(1));
            let fields = world.cursor.get(index).and_then(Value::as_array).cloned().unwrap_or_default();
            world.cursors += 1;
            return answer(Ok(fields.iter().map(|field| field.as_str().expect("a field").to_string()).collect()));
        }
        answer(Ok(Vec::new()))
    }
    fn desktop(&self) -> Option<InputDesktop> {
        Some(lock(&self.0.world).local.clone())
    }
    fn session(&self) -> Option<u32> {
        Some(1)
    }
    fn on_desktop(&self, listener: Listener<InputDesktop>) -> Unsub {
        self.0.host_desktop.add(listener)
    }
    fn on_exit(&self, listener: Listener<()>) -> Unsub {
        self.0.host_exit.add(listener)
    }
    fn stop(&self) -> BoxFuture<()> {
        note(&self.0.log, "host", "stop", json!({}));
        if lock(&self.0.world).host_stop_hangs {
            return Box::pin(std::future::pending());
        }
        answer(())
    }
    fn kill(&self) {
        note(&self.0.log, "host", "kill", json!({}));
    }
}

struct Lease(Arc<Fakes>);

impl HelperView for Lease {
    fn installed(&self) -> bool {
        lock(&self.0.world).helper.installed
    }
    fn connected(&self) -> bool {
        lock(&self.0.world).helper.connected
    }
    fn desktop(&self) -> Option<String> {
        lock(&self.0.world).helper.desktop.clone()
    }
    fn session(&self) -> Option<u32> {
        lock(&self.0.world).helper.session
    }
}

impl SessionHelper for Lease {
    fn locked(&self) -> Option<bool> {
        lock(&self.0.world).helper.locked
    }
    fn owned_elsewhere(&self) -> bool {
        lock(&self.0.world).helper.owned_elsewhere
    }
    fn mint_video_run(&self) -> u64 {
        let epoch = {
            let mut world = lock(&self.0.world);
            world.runs += 1;
            world.runs
        };
        note(&self.0.log, "helper", "mintVideoRun", json!({"epoch": epoch}));
        epoch
    }
    fn on_hold(&self, listener: Listener<()>) -> Unsub {
        self.0.helper_hold.add(listener)
    }
    fn set_active(&self, active: bool) -> BoxFuture<()> {
        note(&self.0.log, "helper", "setActive", json!({"active": active}));
        answer(())
    }
    fn send_input(&self, command: ScreenInput) -> BoxFuture<Result<(), HelperError>> {
        note(&self.0.log, "helper", "sendInput", json!({"command": input_json(&command)}));
        answer(Ok(()))
    }
    fn send_grant(&self, grant: Grant) -> BoxFuture<Result<(), HelperError>> {
        note(&self.0.log, "helper", "sendGrant", json!({"grant": {"epoch": grant.epoch, "challenge": grant.challenge, "signature": grant.signature}}));
        answer(Ok(()))
    }
    fn set_video_run(&self, epoch: u64) {
        note(&self.0.log, "helper", "setVideoRun", json!({"epoch": epoch}));
    }
    fn on_frame(&self, listener: Listener<HelperFrame>) -> Unsub {
        self.0.helper_frame.add(listener)
    }
    fn on_desktop_changed(&self, listener: Listener<()>) -> Unsub {
        self.0.helper_change.add(listener)
    }
    fn on_grant_challenge(&self, listener: Listener<Challenge>) -> Unsub {
        self.0.helper_challenge.add(listener)
    }
    fn on_helper_issue(&self, listener: Listener<String>) -> Unsub {
        self.0.helper_issue.add(listener)
    }
    fn install_state(&self) -> BoxFuture<InstallState> {
        note(&self.0.log, "helper", "installState", json!({"key": null}));
        answer(lock(&self.0.world).install_state)
    }
    fn request_install(&self, controller_key: &str) -> BoxFuture<Result<InstallResult, String>> {
        note(&self.0.log, "helper", "requestInstall", json!({"key": controller_key}));
        deferred(&self.0.installs)
    }
    fn ensure_running(&self) -> BoxFuture<Result<HelperStatus, String>> {
        note(&self.0.log, "helper", "ensureRunning", json!({}));
        let next = {
            let mut world = lock(&self.0.world);
            let index = world.ensures.min(world.ensure.len().saturating_sub(1));
            let next = world.ensure.get(index).cloned().unwrap_or(json!({"installed": true, "running": true}));
            world.ensures += 1;
            next
        };
        if next == "reject" {
            return answer(Err("start failed".to_string()));
        }
        answer(Ok(serde_json::from_value(next).expect("a helper status")))
    }
}

struct PcAccess(Arc<Fakes>);

impl ScreenPcAccess for PcAccess {
    fn account_is_admin(&self) -> BoxFuture<Result<Option<bool>, String>> {
        note(&self.0.log, "pcAccess", "accountIsAdmin", json!({}));
        answer(Ok(lock(&self.0.world).account_is_admin))
    }
    fn approve_with_credential(
        &self,
        client_id: &str,
        public_key: &str,
        credential: SharedCredential,
        signal: AbortSignal,
    ) -> BoxFuture<Result<CredentialResult, String>> {
        let shown = serde_json::to_value(&*lock(&credential)).expect("a credential");
        note(&self.0.log, "pcAccess", "approveWithCredential", json!({"clientId": client_id, "publicKey": public_key, "credential": shown}));
        let log = self.0.log.clone();
        signal.on_abort(Box::new(move || note(&log, "pcAccess", "aborted", json!({}))));
        lock(&self.0.credentials_given).push(credential);
        deferred(&self.0.credentials)
    }
}

struct Indicator(Arc<Fakes>);

impl ScreenIndicator for Indicator {
    fn show(&self, view: IndicatorView) {
        *lock(&self.0.indicator_stop) = Some(view.on_stop.clone());
        note(&self.0.log, "indicator", "show", json!({"clientLabel": view.client_label, "controlling": view.controlling, "screenId": view.screen_id}));
    }
    fn update(&self, controlling: bool) {
        note(&self.0.log, "indicator", "update", json!({"controlling": controlling}));
    }
    fn hide(&self) {
        note(&self.0.log, "indicator", "hide", json!({}));
    }
}

struct Displays(Arc<Fakes>);

impl ScreenDisplays for Displays {
    fn list(&self) -> Vec<ScreenDisplay> {
        lock(&self.0.world).displays.clone()
    }
    fn on_change(&self, listener: Listener<()>) -> Unsub {
        self.0.display_change.add(listener)
    }
}

struct Authorization(Arc<Fakes>);

impl ViewerAuthorization for Authorization {
    fn paired(&self) -> bool {
        lock(&self.0.world).paired
    }
    fn lost(&self) -> String {
        lock(&self.0.world).lost.clone()
    }
    fn on_change(&self, listener: Listener<()>) -> Unsub {
        self.0.auth_change.add(listener)
    }
}

fn displays_of(value: &Value) -> Vec<ScreenDisplay> {
    serde_json::from_value(value.clone()).expect("displays")
}

fn world_of(world: &Value) -> World {
    let default_display = json!([{
        "screenId": "7",
        "label": "Display 1",
        "primary": true,
        "scaleFactor": 1.5,
        "bounds": {"x": 0, "y": 0, "width": 1280, "height": 720},
        "physical": {"x": 0, "y": 0, "width": 1920, "height": 1080},
        "captureSourceId": "screen:0:0",
    }]);
    let mut helper = Helper::default();
    helper.merge(&world["helper"]);
    World {
        paired: world.get("paired").and_then(Value::as_bool).unwrap_or(true),
        lost: "revoked".to_string(),
        displays: displays_of(world.get("displays").unwrap_or(&default_display)),
        install_state: serde_json::from_value(world.get("installState").cloned().unwrap_or(json!("not-installed"))).expect("an install state"),
        helper,
        ensure: world.get("ensure").and_then(Value::as_array).cloned().unwrap_or_default(),
        ensures: 0,
        cursor: world.get("cursor").and_then(Value::as_array).cloned().unwrap_or_default(),
        cursors: 0,
        account_is_admin: world.get("accountIsAdmin").and_then(Value::as_bool),
        host_start_fails: world.get("hostStartFails").and_then(Value::as_str).map(str::to_string),
        host_stop_hangs: world.get("hostStopHangs").and_then(Value::as_bool).unwrap_or(false),
        host_fails: None,
        host_hangs: false,
        local: InputDesktop { name: Some("Default".to_string()), consent: false, logon_ui: false },
        runs: 0,
    }
}

fn picture_json(picture: &super::session::HelperPicture) -> Value {
    json!({
        "bytes": picture.rows.len(),
        "width": picture.width,
        "height": picture.height,
        "stride": picture.stride,
        "source": {"x": picture.source.x, "y": picture.source.y, "width": picture.source.width, "height": picture.source.height},
        "target": {"x": number(picture.target.x), "y": number(picture.target.y), "width": number(picture.target.width), "height": number(picture.target.height)},
    })
}

async fn play(replay: Replay, scenario: Value) -> (Vec<Value>, Value) {
    let world = &scenario["world"];
    let log = log_new();
    let fakes = Arc::new(Fakes {
        world: Mutex::new(world_of(world)),
        log: log.clone(),
        display_change: ListenerSet::new(),
        auth_change: ListenerSet::new(),
        host_desktop: ListenerSet::new(),
        host_exit: ListenerSet::new(),
        helper_change: ListenerSet::new(),
        helper_frame: ListenerSet::new(),
        helper_challenge: ListenerSet::new(),
        helper_issue: ListenerSet::new(),
        helper_hold: ListenerSet::new(),
        installs: Mutex::new(Vec::new()),
        credentials: Mutex::new(Vec::new()),
        credentials_given: Mutex::new(Vec::new()),
        indicator_stop: Mutex::new(None),
    });
    let timers = VirtualTimers::new(replay.clone());
    let host_fakes = fakes.clone();
    let host_log = log.clone();
    let event_log = log.clone();
    let session = Arc::new(ScreenSession::new(SessionDeps {
        client_id: "phone-1".to_string(),
        client_label: "Phone".to_string(),
        screen_id: "7".to_string(),
        displays: Arc::new(Displays(fakes.clone())),
        authorization: Arc::new(Authorization(fakes.clone())),
        create_input_host: Box::new(move || {
            note(&host_log, "deps", "createInputHost", json!({}));
            Arc::new(Host(host_fakes.clone()))
        }),
        secure_desktop: Arc::new(Lease(fakes.clone())),
        pc_access: if world.get("noPcAccess").is_some() { None } else { Some(Arc::new(PcAccess(fakes.clone()))) },
        indicator: Arc::new(Indicator(fakes.clone())),
        log: Box::new(move |event| log_push(&event_log, json!({"ev": "log", "event": event}))),
        timers: Arc::new(timers.clone()),
        max_frame_rate: world.get("maxFrameRate").and_then(Value::as_f64),
        sample_cursor: world.get("sampleCursor").and_then(Value::as_bool).unwrap_or(false),
        shutdown_deadline_ms: world.get("shutdownDeadlineMs").and_then(Value::as_u64),
    }));
    let listen_log = log.clone();
    drop(session.on_status(Arc::new(move |status: &Value| log_push(&listen_log, json!({"ev": "status", "status": status})))));
    let listen_log = log.clone();
    drop(session.on_video_path(Arc::new(move |path| log_push(&listen_log, json!({"ev": "videoPath", "path": path})))));
    let listen_log = log.clone();
    drop(session.on_cursor(Arc::new(move |cursor: &Value| log_push(&listen_log, json!({"ev": "cursor", "cursor": cursor})))));
    let listen_log = log.clone();
    drop(session.on_geometry(Arc::new(move |renewal: &Value| log_push(&listen_log, json!({"ev": "geometry", "renewal": renewal})))));
    let listen_log = log.clone();
    drop(session.on_stop(Arc::new(move |reason: &String| log_push(&listen_log, json!({"ev": "stopped", "reason": reason})))));
    let listen_log = log.clone();
    drop(session.on_helper_hold(Arc::new(move |_: &()| log_push(&listen_log, json!({"ev": "hold"})))));
    let listen_log = log.clone();
    drop(session.on_helper_challenge(Arc::new(move |challenge: &Challenge| {
        log_push(&listen_log, json!({"ev": "challenge", "challenge": {"nonce": challenge.nonce, "challenge": challenge.challenge}}));
    })));
    let listen_log = log.clone();
    drop(session.on_frame(Arc::new(move |picture| log_push(&listen_log, json!({"ev": "frame", "picture": picture_json(picture)})))));

    let calls: Arc<Mutex<HashMap<String, bool>>> = Arc::new(Mutex::new(HashMap::new()));
    let start_call = |name: &str, done: BoxFuture<Value>| {
        lock(&calls).insert(name.to_string(), false);
        let (calls, log, name) = (calls.clone(), log.clone(), name.to_string());
        replay.spawn(Box::pin(async move {
            let event = done.await;
            lock(&calls).insert(name.clone(), true);
            let mut event = event;
            event["call"] = json!(name);
            log_push(&log, event);
        }));
    };
    let ok = |value: Value| json!({"ev": "done", "ok": true, "value": value});
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
            "query" => log_push(
                &log,
                json!({
                    "ev": "query",
                    "running": session.running(),
                    "geometry": session.geometry(),
                    "plan": session.capture_plan(),
                    "status": session.status(),
                    "videoPath": session.video_path(),
                    "cursor": session.cursor(),
                }),
            ),
            "listDisplays" => log_push(&log, json!({"ev": "displays", "list": session.list_displays()})),
            "hostDesktop" => {
                let local: InputDesktop = serde_json::from_value(step["local"].clone()).expect("a local desktop");
                lock(&fakes.world).local = local.clone();
                fakes.host_desktop.call(&local);
            }
            "helper" => {
                lock(&fakes.world).helper.merge(&step["fields"]);
                if step["changed"].as_bool().expect("changed") {
                    fakes.helper_change.call(&());
                }
            }
            "helperFrame" => {
                let frame = &step["frame"];
                let int = |field: &str| frame[field].as_i64().expect("a frame field");
                let (stride, height) = (int("stride"), int("height"));
                fakes.helper_frame.call(&HelperFrame {
                    width: int("width") as u32,
                    height: height as u32,
                    stride: stride as u32,
                    origin_x: int("originX") as i32,
                    origin_y: int("originY") as i32,
                    pixels: Arc::new(vec![0; (stride * height) as usize]),
                });
            }
            "helperIssue" => fakes.helper_issue.call(&step["code"].as_str().expect("a code").to_string()),
            "helperChallenge" => fakes.helper_challenge.call(&Challenge {
                nonce: step["challenge"]["nonce"].as_str().expect("a nonce").to_string(),
                challenge: step["challenge"]["challenge"].as_str().expect("a challenge").to_string(),
            }),
            "helperHold" => fakes.helper_hold.call(&()),
            "setHelperVideo" => session.set_helper_video(step["value"].as_bool().expect("a flag")),
            "setVideoRun" => session.set_video_run(step["epoch"].as_u64().expect("an epoch")),
            "nextVideoRun" => {
                let epoch = session.next_video_run();
                log_push(&log, json!({"ev": "nextVideoRun", "epoch": epoch}));
            }
            "input" => {
                let handled = session.handle_input(&step["input"], step["generation"].as_u64().expect("a generation"));
                start_call(
                    call,
                    Box::pin(async move {
                        let outcome = handled.await;
                        ok(json!(if outcome == RouteOutcome::Applied { "applied" } else { "rejected" }))
                    }),
                );
            }
            "grant" => session.helper_grant(Grant {
                challenge: step["grant"]["challenge"].as_str().expect("a challenge").to_string(),
                epoch: step["grant"]["epoch"].as_u64().expect("an epoch"),
                signature: step["grant"]["signature"].as_str().expect("a signature").to_string(),
            }),
            "install" => session.request_helper_install(step["key"].as_str().expect("a key")),
            "finishInstall" => {
                let sender = lock(&fakes.installs)
                    .get_mut(step["n"].as_u64().expect("n") as usize)
                    .map(|slot| std::mem::replace(slot, oneshot::channel().0))
                    .expect("a pending install");
                let result = match step["reject"].as_str() {
                    Some(error) => Err(error.to_string()),
                    None => Ok(serde_json::from_value(step["result"].clone()).expect("an install result")),
                };
                let _ = sender.send(result);
            }
            "credential" => {
                let credential: SharedCredential =
                    Arc::new(Mutex::new(serde_json::from_value::<Credential>(step["credential"].clone()).expect("a credential")));
                session.request_helper_credential(step["key"].as_str().expect("a key"), credential.clone());
                let after = serde_json::to_value(&*lock(&credential)).expect("a credential");
                log_push(&log, json!({"ev": "credentialAfter", "credential": after}));
            }
            "finishCredential" => {
                let sender = lock(&fakes.credentials)
                    .get_mut(step["n"].as_u64().expect("n") as usize)
                    .map(|slot| std::mem::replace(slot, oneshot::channel().0))
                    .expect("a pending credential request");
                let result = match step["reject"].as_str() {
                    Some(error) => Err(error.to_string()),
                    None => Ok(serde_json::from_value(step["result"].clone()).expect("a credential result")),
                };
                let _ = sender.send(result);
            }
            "displays" => {
                lock(&fakes.world).displays = displays_of(&step["list"]);
                fakes.display_change.call(&());
            }
            "unpair" => {
                {
                    let mut world = lock(&fakes.world);
                    world.paired = false;
                    world.lost = step["reason"].as_str().expect("a reason").to_string();
                }
                fakes.auth_change.call(&());
            }
            "indicatorStop" => {
                let stop = lock(&fakes.indicator_stop).clone().expect("the indicator is shown");
                stop();
            }
            "hostExit" => fakes.host_exit.call(&()),
            "hostFails" => lock(&fakes.world).host_fails = step["value"].as_str().map(str::to_string),
            "hostHangs" => lock(&fakes.world).host_hangs = true,
            "stop" => {
                let stopped = session.stop(step["reason"].as_str().expect("a reason"), step["deadlineMs"].as_u64());
                start_call(
                    call,
                    Box::pin(async move {
                        stopped.await;
                        ok(Value::Null)
                    }),
                );
            }
            "released" => {
                let released = session.released();
                start_call(
                    call,
                    Box::pin(async move {
                        released.await;
                        ok(Value::Null)
                    }),
                );
            }
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
    let wiped: Vec<Value> =
        lock(&fakes.credentials_given).iter().map(|credential| serde_json::to_value(&*lock(credential)).expect("a credential")).collect();
    log_push(&log, json!({"ev": "credentials", "wiped": wiped}));
    let final_state = json!({"elapsedMs": timers.elapsed(), "pendingTimers": timers.pending()});
    (log_take(&log), final_state)
}

#[test]
fn every_recorded_session_scenario_replays_to_nodes_whole_trace() {
    let recording: Value = serde_json::from_str(&RECORDING).expect("the recording parses");
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
