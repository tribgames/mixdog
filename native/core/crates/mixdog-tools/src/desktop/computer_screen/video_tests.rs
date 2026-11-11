//! Replay of Node's helper video runs (recorded by `record-screen-control-video.mjs` from the export of
//! b6f10295a): every scenario's script is run against Rust's video source on the product's runtime and the
//! virtual clock, with a fake screen session and a fake sink that only record what they are told; the whole trace
//! and the final state must equal the recording. The fakes answer as Node's do, through a promise (one turn
//! later). A frame is the recorder's fake frame itself (`{id}`).

use std::sync::Arc;
use std::sync::Mutex;

use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::installer::Credential;
use super::installer::Timers;
use super::lease::Challenge;
use super::lease::Grant;
use super::lease::Unsub;
use super::router::BoxFuture;
use super::router::RouteOutcome;
use super::testing::Log;
use super::testing::Replay;
use super::testing::VirtualTimers;
use super::testing::log_new;
use super::testing::log_push;
use super::testing::log_take;
use super::testing::manifest_names;
use super::testing::DEADLINE;
use super::testing::ThreadedTimers;
use super::testing::next_turn;
use super::turn::Turn;
use super::video::ScreenVideoSource;
use super::video::SinkFrame;
use super::video::VideoPath;
use super::video::VideoScreen;
use super::video::VideoSink;

const RECORDING: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/screen-control/video/scenarios.json");
const MANIFEST: &str = include_str!("../../../../../fixtures/screen-control/video/MANIFEST.json");

/// The recorder's fake frame, carried whole.
#[derive(Clone)]
struct RecordedFrame(Value);

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn answer<T: Send + 'static>(value: T) -> BoxFuture<T> {
    Box::pin(async move {
        next_turn().await;
        value
    })
}

type Listeners<T> = Arc<Mutex<Vec<(u64, Arc<dyn Fn(&T) + Send + Sync>)>>>;

fn listen<T: 'static>(set: &Listeners<T>, next: &Mutex<u64>, listener: Arc<dyn Fn(&T) + Send + Sync>) -> Unsub {
    let id = {
        let mut next = lock(next);
        *next += 1;
        *next
    };
    lock(set).push((id, listener));
    let set = set.clone();
    Box::new(move || lock(&set).retain(|(held, _)| *held != id))
}

fn emit<T>(set: &Listeners<T>, value: &T) {
    let listeners: Vec<_> = lock(set).iter().map(|(_, listener)| listener.clone()).collect();
    for listener in listeners {
        listener(value);
    }
}

struct World {
    running: bool,
    geometry: Option<Value>,
    status: Value,
    cursor: Option<Value>,
    runs: u64,
    minted: Vec<u64>,
    inputs: Vec<Value>,
    handled: usize,
    max_frame_rate: Value,
    start_fails: Option<String>,
}

struct FakeScreen {
    world: Mutex<World>,
    log: Log,
    next: Mutex<u64>,
    geometry: Listeners<Value>,
    stop: Listeners<String>,
    status: Listeners<Value>,
    cursor: Listeners<Value>,
    challenge: Listeners<Challenge>,
    hold: Listeners<()>,
    path: Listeners<VideoPath>,
    frame: Listeners<RecordedFrame>,
}

impl FakeScreen {
    fn note(&self, call: &str, mut fields: Map<String, Value>) {
        let mut event = Map::new();
        event.insert("ev".into(), json!("screen"));
        event.insert("call".into(), json!(call));
        event.append(&mut fields);
        log_push(&self.log, Value::Object(event));
    }

    fn plan(world: &World) -> Value {
        json!({"sourceId": "screen:0", "width": 1280, "height": 720, "maxFrameRate": world.max_frame_rate})
    }
}

fn fields(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

impl VideoScreen<RecordedFrame> for FakeScreen {
    fn status(&self) -> Value {
        lock(&self.world).status.clone()
    }
    fn cursor(&self) -> Option<Value> {
        lock(&self.world).cursor.clone()
    }
    fn running(&self) -> bool {
        lock(&self.world).running
    }
    fn geometry(&self) -> Option<Value> {
        lock(&self.world).geometry.clone()
    }
    fn capture_plan(&self) -> Option<Value> {
        Some(Self::plan(&lock(&self.world)))
    }
    fn next_video_run(&self) -> u64 {
        let epoch = {
            let mut world = lock(&self.world);
            world.runs += 1;
            let epoch = world.runs;
            world.minted.push(epoch);
            epoch
        };
        self.note("nextVideoRun", fields(json!({"epoch": epoch})));
        epoch
    }
    fn set_video_run(&self, epoch: u64) {
        self.note("setVideoRun", fields(json!({"epoch": epoch})));
    }
    fn set_helper_video(&self, delivering: bool) {
        self.note("setHelperVideo", fields(json!({"delivering": delivering})));
    }
    fn helper_grant(&self, grant: Grant) {
        self.note("helperGrant", fields(json!({"grant": {"epoch": grant.epoch, "challenge": grant.challenge, "signature": grant.signature}})));
    }
    fn request_helper_install(&self, controller_key: String) {
        self.note("requestHelperInstall", fields(json!({"key": controller_key})));
    }
    fn request_helper_credential(&self, controller_key: String, credential: Credential) {
        self.note("requestHelperCredential", fields(json!({"key": controller_key, "credential": credential})));
    }
    fn release_input(&self) -> BoxFuture<()> {
        self.note("releaseInput", Map::new());
        answer(())
    }
    fn handle_input(&self, control: Value, generation: u64) -> BoxFuture<RouteOutcome> {
        // Past the scripted answers Node's fake answers `undefined`: not `rejected`, so it counts as applied, and
        // the logged event has no `outcome`.
        let outcome = {
            let mut world = lock(&self.world);
            let outcome = world.inputs.get(world.handled).cloned();
            world.handled += 1;
            outcome
        };
        let mut event = fields(json!({"control": control, "generation": generation}));
        if let Some(outcome) = &outcome {
            event.insert("outcome".into(), outcome.clone());
        }
        self.note("handleInput", event);
        answer(if outcome.is_some_and(|outcome| outcome == "rejected") { RouteOutcome::Rejected } else { RouteOutcome::Applied })
    }
    fn start(&self) -> BoxFuture<Result<Value, String>> {
        self.note("start", Map::new());
        let mut world = lock(&self.world);
        if let Some(error) = world.start_fails.clone() {
            return answer(Err(error));
        }
        world.running = true;
        answer(Ok(world.geometry.clone().unwrap_or(Value::Null)))
    }
    fn stop(&self, reason: &str) -> BoxFuture<()> {
        self.note("stop", fields(json!({"reason": reason})));
        answer(())
    }
    fn on_geometry(&self, listener: Arc<dyn Fn(&Value) + Send + Sync>) -> Unsub {
        listen(&self.geometry, &self.next, listener)
    }
    fn on_stop(&self, listener: Arc<dyn Fn(&String) + Send + Sync>) -> Unsub {
        listen(&self.stop, &self.next, listener)
    }
    fn on_status(&self, listener: Arc<dyn Fn(&Value) + Send + Sync>) -> Unsub {
        listen(&self.status, &self.next, listener)
    }
    fn on_cursor(&self, listener: Arc<dyn Fn(&Value) + Send + Sync>) -> Unsub {
        listen(&self.cursor, &self.next, listener)
    }
    fn on_helper_challenge(&self, listener: Arc<dyn Fn(&Challenge) + Send + Sync>) -> Unsub {
        listen(&self.challenge, &self.next, listener)
    }
    fn on_helper_hold(&self, listener: Arc<dyn Fn(&()) + Send + Sync>) -> Unsub {
        listen(&self.hold, &self.next, listener)
    }
    fn on_video_path(&self, listener: Arc<dyn Fn(&VideoPath) + Send + Sync>) -> Unsub {
        listen(&self.path, &self.next, listener)
    }
    fn on_frame(&self, listener: Arc<dyn Fn(&RecordedFrame) + Send + Sync>) -> Unsub {
        listen(&self.frame, &self.next, listener)
    }
}

struct FakeSink {
    log: Log,
    /// The clock's elapsed time, as the recorder writes it.
    elapsed: Arc<dyn Fn() -> Value + Send + Sync>,
}

impl FakeSink {
    fn note(&self, call: &str, key: &str, mut extra: Map<String, Value>) {
        let mut event = Map::new();
        event.insert("ev".into(), json!("sink"));
        event.insert("call".into(), json!(call));
        event.insert("key".into(), json!(key));
        event.append(&mut extra);
        log_push(&self.log, Value::Object(event));
    }
}

impl VideoSink<RecordedFrame> for FakeSink {
    fn geometry_changed(&self, key: &str, geometry: Option<Value>) {
        self.note("geometryChanged", key, fields(json!({"geometry": geometry})));
    }
    fn capture_changed(&self, key: &str) {
        self.note("captureChanged", key, Map::new());
    }
    fn channel_push(&self, key: &str, message: Value) {
        self.note("channelPush", key, fields(json!({"message": message})));
    }
    fn drawn_track(&self, key: &str, drawn: bool) {
        self.note("drawnTrack", key, fields(json!({"drawn": drawn})));
    }
    fn frame(&self, key: &str, frame: SinkFrame<RecordedFrame>) {
        let mut shown = fields(json!({"documentId": frame.document_id, "geometry": frame.geometry, "epoch": frame.epoch, "mimeType": frame.mime_type}));
        shown.append(&mut fields(frame.picture.0));
        self.note("frame", key, fields(json!({"frame": shown, "at": (self.elapsed)()})));
    }
}

fn fake_screen(world: &Value, log: &Log) -> Arc<FakeScreen> {
    Arc::new(FakeScreen {
        world: Mutex::new(World {
            running: false,
            geometry: Some(json!({"generation": 3, "width": 1280, "height": 720})),
            status: json!({"state": "live", "helper": "not-needed", "control": false}),
            cursor: None,
            runs: 0,
            minted: Vec::new(),
            inputs: world.get("inputs").and_then(Value::as_array).cloned().unwrap_or_default(),
            handled: 0,
            max_frame_rate: world.get("maxFrameRate").cloned().unwrap_or(json!(30)),
            start_fails: world.get("startFails").and_then(Value::as_str).map(str::to_string),
        }),
        log: log.clone(),
        next: Mutex::new(0),
        geometry: Arc::new(Mutex::new(Vec::new())),
        stop: Arc::new(Mutex::new(Vec::new())),
        status: Arc::new(Mutex::new(Vec::new())),
        cursor: Arc::new(Mutex::new(Vec::new())),
        challenge: Arc::new(Mutex::new(Vec::new())),
        hold: Arc::new(Mutex::new(Vec::new())),
        path: Arc::new(Mutex::new(Vec::new())),
        frame: Arc::new(Mutex::new(Vec::new())),
    })
}

fn video_source(screen: &Arc<FakeScreen>, log: &Log, timers: Arc<dyn Timers>, elapsed: Arc<dyn Fn() -> Value + Send + Sync>) -> ScreenVideoSource<RecordedFrame> {
    let sink = Arc::new(FakeSink { log: log.clone(), elapsed });
    let error_log = log.clone();
    ScreenVideoSource::new(screen.clone(), "7", sink, timers, move |message| {
        log_push(&error_log, json!({"ev": "startError", "message": message}));
    })
}

/// The script's `current` and `previous`: the last two epochs the screen minted. Before a second one there is no
/// previous run: Node passes `undefined`, which no run's epoch equals, so nothing is called with it.
fn epoch_of(screen: &FakeScreen, name: &Value) -> Option<u64> {
    let world = lock(&screen.world);
    let back = if name == "current" { 1 } else { 2 };
    world.minted.len().checked_sub(back).map(|index| world.minted[index])
}

fn epoch_event(kind: &str, epoch: Option<u64>) -> Value {
    match epoch {
        Some(epoch) => json!({"ev": kind, "epoch": epoch}),
        None => json!({"ev": kind}),
    }
}

/// The steps both the replay and the forced interleavings play, as the recorder plays them: `false` for another.
fn play_step(step: &Value, screen: &FakeScreen, source: &ScreenVideoSource<RecordedFrame>, log: &Log, turn: &Arc<Turn>) -> bool {
    let quiet = step["quiet"] == true;
    match step["op"].as_str().expect("a step op") {
        "path" => {
            log_push(log, json!({"ev": "path", "path": step["path"]}));
            let path = if step["path"] == "helper" { VideoPath::Helper } else { VideoPath::Capture };
            emit(&screen.path, &path);
        }
        "delivered" => {
            let epoch = epoch_of(screen, &step["epoch"]);
            if !quiet {
                log_push(log, epoch_event("delivered", epoch));
            }
            if let Some(epoch) = epoch {
                source.delivered(epoch);
            }
        }
        "frameSeen" => {
            let epoch = epoch_of(screen, &step["epoch"]);
            log_push(log, epoch_event("frameSeen", epoch));
            if let Some(epoch) = epoch {
                source.frame_seen(epoch);
            }
        }
        // The session ends: an entry of the screen control like any other of the session's, in its turn.
        "stopped" => turn.enter(|| {
            lock(&screen.world).running = false;
            emit(&screen.stop, &"user".to_string());
        }),
        _ => return false,
    }
    true
}

async fn play(replay: Replay, scenario: Value) -> (Vec<Value>, Value) {
    let log = log_new();
    let screen = fake_screen(&scenario["world"], &log);
    let timers = VirtualTimers::new(replay.clone());
    let clock = timers.clone();
    let source = video_source(&screen, &log, Arc::new(timers.clone()), Arc::new(move || clock.elapsed()));
    let turn = timers.turn().clone();
    for step in scenario["steps"].as_array().expect("steps") {
        if play_step(step, &screen, &source, &log, &turn) {
            continue;
        }
        match step["op"].as_str().expect("a step op") {
            "start" => source.start(),
            "stop" => source.stop(),
            "hold" => {
                log_push(&log, json!({"ev": "hold"}));
                emit(&screen.hold, &());
            }
            "frame" => emit(&screen.frame, &RecordedFrame(json!({"id": step["id"]}))),
            "repeatDelivered" => {
                for _ in 0..step["times"].as_u64().expect("times") {
                    let epoch = epoch_of(&screen, &json!("current")).expect("a current run");
                    log_push(&log, json!({"ev": "delivered", "epoch": epoch}));
                    source.delivered(epoch);
                    let every = step["every"].as_u64().expect("every");
                    let ran = timers.advance(every).await;
                    log_push(&log, json!({"ev": "advance", "ms": every, "ran": ran}));
                }
            }
            "grant" => {
                if let Some(epoch) = epoch_of(&screen, &step["epoch"]) {
                    source.helper_grant(Grant {
                        challenge: step["challenge"].as_str().expect("a challenge").to_string(),
                        epoch,
                        signature: step["signature"].as_str().expect("a signature").to_string(),
                    });
                }
            }
            "challenge" => emit(
                &screen.challenge,
                &Challenge { nonce: step["nonce"].as_str().expect("n").to_string(), challenge: step["challenge"].as_str().expect("c").to_string() },
            ),
            "release" => {
                log_push(&log, json!({"ev": "release"}));
                replay.spawn(source.release());
            }
            "dispatch" => {
                let dispatched = source.dispatch(step["control"].clone());
                let log = log.clone();
                replay.spawn(Box::pin(async move {
                    let event = match dispatched.await {
                        Ok(()) => json!({"ev": "dispatched", "ok": true}),
                        Err(error) => json!({"ev": "dispatched", "ok": false, "error": error}),
                    };
                    log_push(&log, event);
                }));
            }
            "channelState" => log_push(&log, json!({"ev": "channelState", "messages": source.channel_state()})),
            "page" => log_push(&log, json!({"ev": "page", "page": source.page()})),
            "capturePlan" => log_push(&log, json!({"ev": "capturePlan", "plan": source.capture_plan()})),
            "install" => source.helper_install(step["key"].as_str().expect("a key").to_string()),
            "credential" => source.helper_credential(
                step["key"].as_str().expect("a key").to_string(),
                serde_json::from_value(step["credential"].clone()).expect("a credential"),
            ),
            "running" => lock(&screen.world).running = step["value"].as_bool().expect("a flag"),
            "noGeometry" => lock(&screen.world).geometry = None,
            "status" => {
                lock(&screen.world).status = step["status"].clone();
                emit(&screen.status, &step["status"]);
            }
            "cursor" => {
                lock(&screen.world).cursor = Some(step["cursor"].clone());
                emit(&screen.cursor, &step["cursor"]);
            }
            "geometry" => {
                lock(&screen.world).geometry = Some(step["geometry"].clone());
                emit(&screen.geometry, &step["geometry"]);
            }
            "advance" => {
                let ms = step["ms"].as_u64().expect("ms");
                let ran = timers.advance(ms).await;
                if step["quiet"] != true {
                    log_push(&log, json!({"ev": "advance", "ms": ms, "ran": ran}));
                }
            }
            "settle" => replay.settle().await,
            other => panic!("unknown step {other}"),
        }
    }
    replay.settle().await;
    let final_state = json!({"elapsedMs": timers.elapsed(), "pendingTimers": timers.pending()});
    (log_take(&log), final_state)
}

#[test]
fn every_recorded_video_scenario_replays_to_nodes_whole_trace() {
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

// Forced interleavings. In the product the video source's entries arrive from several threads: the sender's
// deliveries, the viewer's channel, the stall watchdog started by the runtime on a worker, the session's own
// stop. Node runs each handler whole on one thread, so a check of the run and the update it decides are never split.
// Here the source runs on a multi-threaded runtime; a recorded step marked `race: 'held'` is stopped by the source's
// test gate just after its check, and each following `race: 'meanwhile'` step is started from another thread while
// it is held. The gate is let go as soon as a racing step has to wait for its turn, or once all of them ended
// (which only happens when nothing serialises them). The trace must be the one Node recorded for the same steps run
// one after the other.

#[derive(Debug, PartialEq)]
enum Told {
    /// The held step reached its gate.
    Reached,
    /// A thread started waiting for the turn.
    Waiting,
    /// A racing step (by index) or the held one (`None`) ended.
    Ended(Option<usize>),
}

/// The race's events, with those that came before the one awaited kept for later.
struct Events {
    told: std::sync::mpsc::Receiver<Told>,
    kept: Vec<Told>,
}

impl Events {
    fn wait(&mut self, what: &str, wanted: impl Fn(&Told) -> bool) -> Told {
        if let Some(index) = self.kept.iter().position(&wanted) {
            return self.kept.remove(index);
        }
        loop {
            let event = self.told.recv_timeout(DEADLINE).unwrap_or_else(|_| panic!("waiting for {what}: nothing came within {DEADLINE:?}"));
            if wanted(&event) {
                return event;
            }
            if event != Told::Waiting {
                self.kept.push(event);
            }
        }
    }
}

fn race(scenario: &Value) -> (Vec<Value>, Value) {
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("a multi-threaded runtime");
    let log = log_new();
    let screen = fake_screen(&scenario["world"], &log);
    let timers = ThreadedTimers::new(runtime.handle().clone());
    let clock = timers.clone();
    let source = Arc::new(video_source(&screen, &log, Arc::new(timers.clone()), Arc::new(move || clock.elapsed())));
    let (tell, told) = std::sync::mpsc::channel::<Told>();
    let mut events = Events { told, kept: Vec::new() };
    let waiting = tell.clone();
    timers.turn.on_waiting(Arc::new(move || drop(waiting.send(Told::Waiting))));
    let (open, opened) = std::sync::mpsc::channel::<()>();
    let opened = Arc::new(Mutex::new(Some(opened)));
    let armed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        let (tell, armed) = (tell.clone(), armed.clone());
        source.set_gate(Arc::new(move |_point: &'static str| {
            if !armed.swap(false, std::sync::atomic::Ordering::SeqCst) {
                return;
            }
            drop(tell.send(Told::Reached));
            let opened = lock(&opened).take().expect("one held step");
            opened.recv_timeout(DEADLINE).unwrap_or_else(|_| panic!("the held step was not let go within {DEADLINE:?}"));
        }));
    }
    let turn = timers.turn.clone();
    // A step on its own thread, telling when it ended.
    let spawn_step = |step: Value, ended: Option<usize>| {
        let (screen, source, log, turn, timers, tell) = (screen.clone(), source.clone(), log.clone(), turn.clone(), timers.clone(), tell.clone());
        std::thread::spawn(move || {
            if step["op"] == "advance" {
                assert_eq!(step["quiet"], true, "a racing advance logs nothing of its own");
                for started in timers.advance(step["ms"].as_u64().expect("ms")) {
                    timers.finish(started, "a timer callback");
                }
            } else {
                assert!(play_step(&step, &screen, &source, &log, &turn), "a racing step the race plays: {step}");
            }
            drop(tell.send(Told::Ended(ended)));
        })
    };
    let steps = scenario["steps"].as_array().expect("steps");
    let mut threads = Vec::new();
    let mut index = 0;
    while index < steps.len() {
        let step = &steps[index];
        index += 1;
        if step["race"] == "held" {
            armed.store(true, std::sync::atomic::Ordering::SeqCst);
            threads.push(spawn_step(step.clone(), None));
            events.wait("the held step at its gate", |event| *event == Told::Reached);
            let mut released = false;
            let mut running: Option<usize> = None;
            let mut racing = 0;
            while index < steps.len() && steps[index]["race"] == "meanwhile" {
                if let Some(previous) = running.take() {
                    events.wait("the previous racing step to end", |event| *event == Told::Ended(Some(previous)));
                }
                threads.push(spawn_step(steps[index].clone(), Some(racing)));
                if released {
                    running = Some(racing);
                } else {
                    let racer = racing;
                    let event = events.wait("a racing step to wait for its turn or end", |event| {
                        *event == Told::Waiting || *event == Told::Ended(Some(racer))
                    });
                    if event == Told::Waiting {
                        open.send(()).expect("the held step waits at its gate");
                        released = true;
                        running = Some(racing);
                    }
                }
                racing += 1;
                index += 1;
            }
            if !released {
                open.send(()).expect("the held step waits at its gate");
            }
            events.wait("the held step to end", |event| *event == Told::Ended(None));
            if let Some(last) = running {
                events.wait("the last racing step to end", |event| *event == Told::Ended(Some(last)));
            }
            continue;
        }
        if play_step(step, &screen, &source, &log, &turn) {
            continue;
        }
        match step["op"].as_str().expect("a step op") {
            "start" => source.start(),
            "settle" => timers.settle(),
            "advance" => {
                let ms = step["ms"].as_u64().expect("ms");
                let started = timers.advance(ms);
                let ran = started.len();
                for task in started {
                    timers.finish(task, "a timer callback");
                }
                log_push(&log, json!({"ev": "advance", "ms": ms, "ran": ran}));
            }
            other => panic!("a step the race does not play: {other}"),
        }
    }
    timers.settle();
    for thread in threads {
        thread.join().expect("a step's thread");
    }
    let final_state = json!({"elapsedMs": timers.elapsed(), "pendingTimers": timers.pending()});
    (log_take(&log), final_state)
}

#[test]
fn no_entry_comes_between_a_runs_check_and_its_update_on_a_multi_threaded_runtime() {
    let recording: Value = serde_json::from_str(&RECORDING).expect("the recording parses");
    let scenarios: Vec<&Value> = recording["scenarios"]
        .as_array()
        .expect("scenarios")
        .iter()
        .filter(|scenario| scenario["steps"].as_array().expect("steps").iter().any(|step| step["race"] == "held"))
        .collect();
    assert_eq!(scenarios.len(), 3, "the recorded forced interleavings: a stale frame-seen, a late delivery, a frame-seen against stop");
    let mut failures = Vec::new();
    for scenario in scenarios {
        let name = scenario["name"].as_str().expect("a scenario name");
        let (trace, final_state) = race(scenario);
        if Value::Array(trace.clone()) != scenario["trace"] || final_state != scenario["final"] {
            failures.push(format!("{name}\n  rust: {}\n    {final_state}\n  node: {}\n    {}", Value::Array(trace), scenario["trace"], scenario["final"]));
        }
    }
    assert!(failures.is_empty(), "interleavings Node cannot produce:\n{}", failures.join("\n"));
}
