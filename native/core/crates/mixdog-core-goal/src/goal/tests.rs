//! Goal runtime tests: the Node twin (`fixtures/goal/goal-runtime-twin.json`, recorded from Node's
//! real `createGoalRuntime` by `benchmarks/rust-core/recorders/record-goal-runtime.mjs`) replayed
//! operation by operation under a scripted clock and scripted timers. Every answer, refusal text,
//! listener event, armed deadline and stored byte must equal the recording.
#![allow(
    clippy::disallowed_methods,
    reason = "test harness: it lays out and reads back the temp record files outside any lane"
)]

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::mock::{MockApprovalGate, MockFileService, MockProcessManager, MockProgress};
use mixdog_core_api::domain::tool::*;
use mixdog_protocol::{ThreadId, ToolCallId, TurnId};
use mixdog_rt::CancellationToken as RtCancel;
use mixdog_tools::orch::ports::CallerFacts;
use mixdog_tools::state::goal::GoalTool;
use mixdog_tools::state::todo::{TodoEdit, TodoList, TodoStore};
use regex::Regex;
use serde_json::{Map, Value, json};

use super::error::{GoalError, GoalResult};
use super::js::Goal;
use super::recovery::{RecoverySource, StoredGoals, recover_active_goals};
use super::runtime::{GoalClock, GoalConfig, GoalEnv, GoalRuntime, GoalTimers, GoalTitles, Timer, TimerKind};
use super::state::{DEFAULT_COMPLETED_GOAL_TTL_MS, goal_state_snapshot, parse_goal_duration, parse_user_command};
use super::text::{continuation_prompt, duration_label, goal_state_reminder};
use super::{Admission, ContinuationInput};

const SESSIONS: [&str; 3] = ["s1", "s2", "sess_3"];

struct FakeTimer {
    due: f64,
    title: bool,
    beat: bool,
    callback: Option<Box<dyn FnOnce() + Send>>,
}

/// The scripted world of one case: the wall clock, the paired monotonic clock and the timers.
struct World {
    clock: Mutex<f64>,
    mono: Mutex<f64>,
    monotonic: bool,
    timers: Mutex<BTreeMap<u64, FakeTimer>>,
    seq: AtomicU64,
    /// Node's heartbeat is one `setInterval`: its place among equal due times never changes. The
    /// Rust beat re-arms a fresh timer, so it takes over the place of the beat that just fired.
    beat_places: Mutex<Vec<(u64, f64)>>,
}

impl World {
    fn clock(&self) -> f64 {
        *self.clock.lock().unwrap()
    }
}

struct Clock(Arc<World>);

impl GoalClock for Clock {
    fn now(&self) -> f64 {
        self.0.clock()
    }
    fn monotonic(&self) -> Option<f64> {
        self.0.monotonic.then(|| *self.0.mono.lock().unwrap())
    }
}

struct Timers(Arc<World>);

impl GoalTimers for Timers {
    fn after(&self, kind: TimerKind, delay_ms: f64, callback: Box<dyn FnOnce() + Send>) -> Timer {
        let beat = kind == TimerKind::Heartbeat;
        let reused = if beat {
            let mut places = self.0.beat_places.lock().unwrap();
            (!places.is_empty()).then(|| places.remove(0))
        } else {
            None
        };
        let (id, due) = match reused {
            Some((id, fired_due)) => (id, fired_due + delay_ms),
            None => (self.0.seq.fetch_add(1, Ordering::SeqCst), self.0.clock() + delay_ms.max(0.0)),
        };
        let title = kind == TimerKind::Title;
        self.0.timers.lock().unwrap().insert(id, FakeTimer { due, title, beat, callback: Some(callback) });
        let world = self.0.clone();
        Timer::new(move || {
            world.timers.lock().unwrap().remove(&id);
        })
    }
}

/// The title model of the recording: a pure function of the objective.
struct Titles;

#[async_trait]
impl GoalTitles for Titles {
    async fn generate(&self, objective: &str, _cancel: &RtCancel) -> GoalResult<String> {
        if objective.contains("boom") {
            return Err(GoalError::new("title model failed"));
        }
        if objective.contains("notitle") {
            return Ok(String::new());
        }
        if objective.contains("same") {
            return Ok(objective.to_owned());
        }
        let head: Vec<&str> = objective.split_whitespace().take(3).collect();
        Ok(format!("Title: {}", head.join(" ")))
    }
}

struct NoTodos;

#[async_trait]
impl TodoStore for NoTodos {
    async fn read(&self, _: &ThreadId) -> TodoList {
        Default::default()
    }
    async fn update(&self, _: &ThreadId, _: &mut TodoEdit<'_>) -> Result<(), String> {
        Ok(())
    }
    fn note_user_wait(&self, _: &ThreadId) {}
    fn user_waiting(&self, _: &ThreadId) -> bool {
        false
    }
    fn turn_started(&self, _: &ThreadId) {}
}

struct Facts;

impl CallerFacts for Facts {
    fn is_heartbeat(&self, _: &ThreadId) -> bool {
        false
    }
    fn is_unattended(&self, _: &ThreadId) -> bool {
        false
    }
    fn user_available(&self, _: &ThreadId) -> bool {
        true
    }
}

fn tool_ctx(thread: &str) -> ToolContext {
    let tokens = mixdog_rt::testing::tokens();
    ToolContext {
        call_id: ToolCallId::from("c"),
        thread_id: ThreadId::from(thread),
        turn_id: TurnId::from("r"),
        tool: "goal".into(),
        cwd: AbsPath::new(std::env::temp_dir()).expect("absolute temp dir"),
        surface: SurfaceKind::Lead,
        cancel: tokio_util::sync::CancellationToken::new(),
        deadline: None,
        progress: Arc::new(MockProgress::default()),
        io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
        approvals: Arc::new(MockApprovalGate::default()),
        files: Arc::new(MockFileService::default()),
        processes: Arc::new(MockProcessManager::default()),
        options: Default::default(),
        review: None,
    }
}

/// Numbers are compared by value: an integral `f64` equals the integer Node wrote.
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q)),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w))),
        _ => a == b,
    }
}

fn shorten(value: &Value) -> String {
    let text = serde_json::to_string(value).unwrap();
    if text.len() > 1500 { format!("{}…", text.chars().take(1500).collect::<String>()) } else { text }
}

fn goal_value(goal: Option<Goal>) -> Value {
    goal.map_or(Value::Null, Value::Object)
}

/// Ids are random: each distinct one is named by order of first appearance, per case.
struct Namer {
    ids: Vec<String>,
    pattern: Regex,
}

impl Namer {
    fn new() -> Self {
        Self { ids: Vec::new(), pattern: Regex::new("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}").unwrap() }
    }
    fn name(&mut self, value: &Value) -> Value {
        let text = serde_json::to_string(value).unwrap();
        let ids = &mut self.ids;
        let named = self.pattern.replace_all(&text, |caps: &regex::Captures<'_>| {
            let id = caps[0].to_owned();
            let at = match ids.iter().position(|known| *known == id) {
                Some(at) => at,
                None => {
                    ids.push(id);
                    ids.len() - 1
                }
            };
            format!("<goal {}>", at + 1)
        });
        serde_json::from_str(&named).unwrap()
    }
}

fn scrub(dir: &Path, value: &Value) -> Value {
    let plain = dir.to_string_lossy().into_owned();
    let escaped = serde_json::to_string(&plain).unwrap();
    let escaped = escaped[1..escaped.len() - 1].to_owned();
    let flat = plain.replace('\\', "/");
    let text = serde_json::to_string(value).unwrap().replace(&escaped, "<dir>").replace(&flat, "<dir>");
    serde_json::from_str(&text).unwrap()
}

fn files_of(dir: &Path) -> BTreeMap<String, String> {
    fn walk(base: &Path, path: &Path, out: &mut BTreeMap<String, String>, corrupt: &Regex) {
        let Ok(entries) = std::fs::read_dir(path) else { return };
        for entry in entries.flatten() {
            let full = entry.path();
            if full.is_dir() {
                walk(base, &full, out, corrupt);
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.ends_with(".lock") || name.contains(".tmp") {
                continue;
            }
            let rel = full.strip_prefix(base).unwrap().components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/");
            let rel = corrupt.replace(&rel, ".corrupt-<ts>").into_owned();
            out.insert(rel, String::from_utf8_lossy(&std::fs::read(&full).unwrap()).into_owned());
        }
    }
    let mut out = BTreeMap::new();
    let goals = dir.join("goals");
    walk(&goals, &goals, &mut out, &Regex::new(r"\.corrupt-\d+").unwrap());
    out
}

struct Source {
    stored: StoredGoals,
    lines: Mutex<Vec<String>>,
}

#[async_trait]
impl RecoverySource for Source {
    async fn list_active_session_ids(&self) -> GoalResult<Vec<String>> {
        self.stored.list_active_session_ids().await
    }
    async fn read_stored_goal(&self, session_id: &str) -> GoalResult<Option<Goal>> {
        self.stored.read_snapshot(session_id).await
    }
    async fn materialize_session(&self, session_id: &str) -> GoalResult<()> {
        if session_id == "sess_fail" {
            return Err(GoalError::new("cannot materialize"));
        }
        self.lines.lock().unwrap().push(format!("materialize {session_id}"));
        Ok(())
    }
    fn log(&self, line: &str) {
        self.lines.lock().unwrap().push(line.to_owned());
    }
}

struct Case {
    world: Arc<World>,
    dir: tempfile::TempDir,
    options: Value,
    runtime: GoalRuntime,
    subscription: Option<super::Subscription>,
    events: Arc<Mutex<Vec<Value>>>,
    errors: Arc<Mutex<Vec<String>>>,
    tool: GoalTool,
}

impl Case {
    fn start(&mut self) {
        let tokens = mixdog_rt::testing::tokens();
        let opt = |key: &str| self.options.get(key).and_then(Value::as_f64);
        let mut config = GoalConfig::new(self.dir.path().to_string_lossy().into_owned());
        config.default_time_limit_ms = opt("defaultTimeLimitMs").unwrap_or(0.0);
        if let Some(ttl) = opt("completedGoalTtlMs") {
            config.completed_goal_ttl_ms = ttl;
        }
        config.suspend_detectable = self.world.monotonic;
        let errors = self.errors.clone();
        let env = GoalEnv {
            clock: Arc::new(Clock(self.world.clone())),
            timers: Arc::new(Timers(self.world.clone())),
            titles: (self.options.get("titles") != Some(&json!(false))).then(|| Arc::new(Titles) as Arc<dyn GoalTitles>),
            on_storage_error: Arc::new(move |error| errors.lock().unwrap().push(error.message.clone())),
            lane: tokens.durability_io,
        };
        self.runtime = GoalRuntime::new(config, env);
        let events = self.events.clone();
        self.subscription = Some(self.runtime.subscribe(move |event| {
            events.lock().unwrap().push(json!({ "goal": goal_value(event.goal.clone()), "sessionId": event.session_id }));
        }));
        self.tool = GoalTool::new(Arc::new(self.runtime.clone()), Arc::new(NoTodos), Arc::new(Facts));
    }

    /// What the recorder's `settle` does after every step: the background work finishes and the
    /// legacy-task clear it runs for each known session.
    async fn settle(&self) {
        self.runtime.settled().await;
        for id in SESSIONS {
            let _ = self.runtime.clear_legacy_tasks(id).await;
        }
        self.runtime.settled().await;
    }

    async fn advance(&self, ms: f64) {
        let target = self.world.clock() + ms;
        loop {
            let due = {
                let timers = self.world.timers.lock().unwrap();
                timers.iter().filter(|(_, t)| t.due <= target).min_by(|a, b| a.1.due.total_cmp(&b.1.due).then(a.0.cmp(b.0))).map(|(id, _)| *id)
            };
            let Some(id) = due else { break };
            let mut timer = self.world.timers.lock().unwrap().remove(&id).unwrap();
            let delta = (timer.due - self.world.clock()).max(0.0);
            *self.world.clock.lock().unwrap() += delta;
            *self.world.mono.lock().unwrap() += delta;
            if timer.beat {
                self.world.beat_places.lock().unwrap().push((id, timer.due));
            }
            (timer.callback.take().unwrap())();
            // The legacy-task clear is a no-op for a record without legacy tasks, and costs a
            // locked read per session; between timers only the background work is awaited.
            self.runtime.settled().await;
        }
        *self.world.mono.lock().unwrap() += target - self.world.clock();
        *self.world.clock.lock().unwrap() = target;
        self.settle().await;
    }

    /// Fires every timer due within `ms` with nothing settling in between: what a timer queued is
    /// already in the session's queue when the next request arrives.
    fn fire_unsettled(&self, ms: f64) {
        let target = self.world.clock() + ms;
        loop {
            let due = {
                let timers = self.world.timers.lock().unwrap();
                timers.iter().filter(|(_, t)| t.due <= target).min_by(|a, b| a.1.due.total_cmp(&b.1.due).then(a.0.cmp(b.0))).map(|(id, _)| *id)
            };
            let Some(id) = due else { break };
            let mut timer = self.world.timers.lock().unwrap().remove(&id).unwrap();
            let delta = (timer.due - self.world.clock()).max(0.0);
            *self.world.clock.lock().unwrap() += delta;
            *self.world.mono.lock().unwrap() += delta;
            if timer.beat {
                self.world.beat_places.lock().unwrap().push((id, timer.due));
            }
            (timer.callback.take().unwrap())();
        }
        *self.world.mono.lock().unwrap() += target - self.world.clock();
        *self.world.clock.lock().unwrap() = target;
    }

    async fn goal_ref(&self, session: &str, reference: &str) -> String {
        match reference {
            "current" => self.runtime.stored_snapshot(session).await.ok().flatten().map(|g| super::js::string(&g, "id")).unwrap_or_default(),
            "stale" => "no-such-goal".into(),
            other => other.to_owned(),
        }
    }

    async fn resolve(&self, session: &str, value: &Value) -> Value {
        match value {
            Value::String(text) if text.contains("$current") => {
                let current = self.goal_ref(session, "current").await;
                Value::String(text.replacen("$current", if current.is_empty() { "none" } else { &current }, 1))
            }
            Value::Object(map) => {
                let mut out = Map::new();
                for (key, entry) in map {
                    let resolved = match entry.as_str() {
                        Some(text) if key == "expectedGoalId" && text.starts_with('$') => Value::String(self.goal_ref(session, &text[1..]).await),
                        _ => entry.clone(),
                    };
                    out.insert(key.clone(), resolved);
                }
                Value::Object(out)
            }
            other => other.clone(),
        }
    }

    fn stored_goals(&self, ttl: f64) -> StoredGoals {
        let world = self.world.clone();
        let mut stored = StoredGoals::new(self.dir.path().to_string_lossy().into_owned(), mixdog_rt::testing::tokens().durability_io);
        stored.completed_ttl_ms = ttl;
        stored.now = Arc::new(move || world.clock());
        stored
    }

    async fn run_op(&self, step: &Value) -> Result<Value, String> {
        let session = step["session"].as_str().unwrap_or("s1");
        let args = &step["args"];
        let fail = |e: GoalError| e.message;
        match step["op"].as_str().unwrap() {
            "fireThenControl" => {
                self.fire_unsettled(args["ms"].as_f64().unwrap());
                let request = self.resolve(session, &args["request"]).await;
                self.runtime.control(session, request).await.map_err(fail)
            }
            "control" => {
                let request = self.resolve(session, &args["request"]).await;
                self.runtime.control(session, request).await.map_err(fail)
            }
            "tool" => {
                let input = self.resolve(session, &args["input"]).await;
                match self.tool.call(&tool_ctx(session), input).await {
                    Ok(out) => match &out.parts[0] {
                        ToolPart::Text(text) => Ok(Value::String(text.clone())),
                        other => panic!("unexpected part {other:?}"),
                    },
                    Err(error) => Err(error.message_for_model),
                }
            }
            "startTurn" => self.runtime.start_turn(session).await.map(goal_value).map_err(fail),
            "settleTurn" => self.runtime.settle_turn(session, args["detail"].clone()).await.map(goal_value).map_err(fail),
            "continuation" => {
                let input = ContinuationInput {
                    awaiting_work: args["awaiting"].as_bool().unwrap_or(false),
                    todo: args["todo"].as_str().unwrap_or_default().to_owned(),
                };
                self.runtime.continuation(session, input).await.map(|c| c.to_value()).map_err(fail)
            }
            "reset" => self.runtime.reset_continuation_rules(session).map(|()| Value::Null).map_err(fail),
            "archive" => self.runtime.archive_completed_on_user_input(session).await.map(goal_value).map_err(fail),
            "reactivate" => {
                let goal_id = self.goal_ref(session, args["goal"].as_str().unwrap()).await;
                let called = Arc::new(Mutex::new(Vec::<Value>::new()));
                let probe = |name: &'static str, mode: &Value| {
                    let (called, mode) = (called.clone(), mode.clone());
                    Box::new(move || -> GoalResult<bool> {
                        called.lock().unwrap().push(json!(name));
                        match &mode {
                            Value::String(_) => Err(GoalError::new(if name == "isCurrent" { "current failed" } else { "accept failed" })),
                            other => Ok(other.as_bool().unwrap()),
                        }
                    }) as Box<dyn Fn() -> GoalResult<bool> + Send>
                };
                let admission = Admission {
                    is_current: args.get("current").map(|m| probe("isCurrent", m)),
                    accept: args.get("accept").map(|m| probe("accept", m)),
                };
                let goal = self.runtime.reactivate_usage_limited(session, &goal_id, admission).await.map_err(fail)?;
                Ok(json!({ "goal": goal_value(goal), "called": *called.lock().unwrap() }))
            }
            "snapshot" => self.runtime.snapshot(session).await.map(goal_value).map_err(fail),
            "stored" => self.runtime.stored_snapshot(session).await.map(goal_value).map_err(fail),
            "watch" => self.runtime.watch_session(session).await.map(goal_value).map_err(fail),
            "legacyTasks" => Ok(Value::Array(self.runtime.legacy_tasks(session).await)),
            "clearLegacy" => self.runtime.clear_legacy_tasks(session).await.map(goal_value).map_err(fail),
            "stateSnapshot" => self.runtime.snapshot(session).await.map(|g| goal_value(g.map(|g| goal_state_snapshot(&g)))).map_err(fail),
            "listStored" => {
                let ttl = self.options.get("completedGoalTtlMs").and_then(Value::as_f64).unwrap_or(DEFAULT_COMPLETED_GOAL_TTL_MS);
                self.stored_goals(ttl).list_active_session_ids().await.map(|ids| json!(ids)).map_err(fail)
            }
            "readStored" => {
                let ttl = self.options.get("completedGoalTtlMs").and_then(Value::as_f64).unwrap_or(DEFAULT_COMPLETED_GOAL_TTL_MS);
                self.stored_goals(ttl).read_snapshot(session).await.map(goal_value).map_err(fail)
            }
            "recover" => {
                let source = Source { stored: self.stored_goals(DEFAULT_COMPLETED_GOAL_TTL_MS), lines: Mutex::default() };
                let summary = recover_active_goals(&source).await;
                Ok(json!({
                    "summary": { "found": summary.found, "resumed": summary.resumed, "skipped": summary.skipped, "failed": summary.failed },
                    "lines": *source.lines.lock().unwrap(),
                }))
            }
            other => panic!("unknown op {other}"),
        }
    }
}

async fn replay(case: &Value) -> Result<(), String> {
    let world = Arc::new(World {
        clock: Mutex::new(1_800_000_000_000.0),
        mono: Mutex::new(5_000.0),
        monotonic: case["options"]["monotonic"] == json!(true),
        timers: Mutex::default(),
        seq: AtomicU64::new(1),
        beat_places: Mutex::default(),
    });
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("goals")).unwrap();
    for (file, content) in case["files"].as_object().unwrap() {
        let path = dir.path().join("goals").join(file);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content.as_str().unwrap()).unwrap();
    }
    let runtime_dir = dir.path().to_string_lossy().into_owned();
    // Replaced by `start` before the first step; it only gives the fields a value.
    let placeholder = GoalRuntime::new(GoalConfig::new(runtime_dir), GoalEnv::system(mixdog_rt::testing::tokens().durability_io));
    let mut run = Case {
        world: world.clone(),
        dir,
        options: case["options"].clone(),
        tool: GoalTool::new(Arc::new(placeholder.clone()), Arc::new(NoTodos), Arc::new(Facts)),
        runtime: placeholder,
        subscription: None,
        events: Arc::default(),
        errors: Arc::default(),
    };
    run.start();
    let mut namer = Namer::new();
    let mut previous = files_of(run.dir.path());
    for (index, step) in case["steps"].as_array().unwrap().iter().enumerate() {
        run.events.lock().unwrap().clear();
        run.errors.lock().unwrap().clear();
        let op = step["op"].as_str().unwrap();
        let result: Result<Value, String> = match op {
            "advance" => {
                run.advance(step["args"]["ms"].as_f64().unwrap()).await;
                Ok(Value::Null)
            }
            "suspend" => {
                *world.clock.lock().unwrap() += step["args"]["ms"].as_f64().unwrap();
                Ok(Value::Null)
            }
            "restart" => {
                run.subscription = None;
                run.runtime.close().await;
                world.timers.lock().unwrap().clear();
                *world.clock.lock().unwrap() += step["args"]["ms"].as_f64().unwrap_or(0.0);
                run.start();
                Ok(Value::Null)
            }
            _ => run.run_op(step).await,
        };
        if op != "advance" {
            run.settle().await;
        }
        let dir = run.dir.path().to_owned();
        let mut live: Vec<f64> = world.timers.lock().unwrap().values().filter(|t| !t.title).map(|t| t.due - world.clock()).collect();
        live.sort_by(f64::total_cmp);
        let now_files = files_of(&dir);
        let changed = now_files != previous;
        previous = now_files.clone();
        let mut actual = Map::new();
        match result {
            Ok(value) => {
                actual.insert("value".into(), namer.name(&scrub(&dir, &value)));
            }
            Err(message) => {
                actual.insert("error".into(), namer.name(&scrub(&dir, &Value::String(message))));
            }
        }
        let events = Value::Array(run.events.lock().unwrap().clone());
        actual.insert("events".into(), namer.name(&events));
        let errors = Value::Array(run.errors.lock().unwrap().iter().cloned().map(Value::String).collect());
        actual.insert("storageErrors".into(), scrub(&dir, &errors));
        actual.insert("timers".into(), json!(live));
        if changed {
            let mut named = Map::new();
            let keys: Vec<String> = now_files.keys().map(|k| namer.name(&Value::String(k.clone())).as_str().unwrap().to_owned()).collect();
            for (key, content) in keys.iter().zip(now_files.values()) {
                named.insert(key.clone(), Value::String(content.clone()));
            }
            actual.insert("files".into(), namer.name(&Value::Object(named)));
        }
        for key in ["value", "error", "events", "storageErrors", "timers", "files"] {
            let want = step.get(key);
            let got = actual.get(key);
            let equal = match (want, got) {
                (None, None) => true,
                (Some(w), Some(g)) => same(w, g),
                _ => false,
            };
            if !equal {
                return Err(format!(
                    "step {index} {op} {} session {}: `{key}` differs\n  node: {}\n  rust: {}",
                    shorten(&step["args"]),
                    step["session"],
                    want.map_or("<absent>".into(), shorten),
                    got.map_or("<absent>".into(), shorten),
                ));
            }
        }
    }
    run.subscription = None;
    run.runtime.close().await;
    Ok(())
}

fn twin() -> Value {
    serde_json::from_str(include_str!("../../../../fixtures/goal/goal-runtime-twin.json")).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_runtime_answers_like_node_operation_by_operation() {
    let twin = twin();
    let mut failures = Vec::new();
    let cases = twin["cases"].as_array().unwrap();
    // Every case has its own directory and clock; the durable writes (fsync) of different cases
    // overlap on the lanes.
    let replays = cases
        .iter()
        .filter(|case| std::env::var("GOAL_CASE").is_ok_and(|only| only == case["name"].as_str().unwrap()) || std::env::var("GOAL_CASE").is_err())
        .map(|case| async move { (case, replay(case).await) });
    for (case, replayed) in futures::future::join_all(replays).await {
        if let Err(message) = replayed {
            failures.push(format!("{}: {message}", case["name"]));
        }
    }
    assert!(failures.is_empty(), "{} of {} cases differ from Node:\n{}", failures.len(), cases.len(), failures.iter().take(12).cloned().collect::<Vec<_>>().join("\n\n"));
}

fn as_goal(value: &Value) -> Goal {
    value.as_object().unwrap().clone()
}

#[test]
fn texts_commands_titles_and_durations_equal_nodes() {
    let twin = twin();
    for row in twin["reminders"].as_array().unwrap() {
        let got = goal_state_reminder(Some(&as_goal(&row["goal"])), row["reason"].as_str().unwrap());
        assert_eq!(got, row["text"].as_str().unwrap(), "reminder {}", shorten(row));
    }
    for row in twin["prompts"].as_array().unwrap() {
        let got = continuation_prompt(&as_goal(&row["goal"]), row["includeRules"].as_bool().unwrap(), row["todo"].as_str().unwrap());
        assert_eq!(got, row["text"].as_str().unwrap(), "prompt {}", shorten(row));
    }
    for row in twin["durationLabels"].as_array().unwrap() {
        // Node's untyped `"x"` becomes NaN there; a typed millisecond count cannot be one.
        let ms = match &row["ms"] {
            Value::Number(n) => n.as_f64().unwrap(),
            Value::Null => 0.0,
            _ => continue,
        };
        assert_eq!(duration_label(ms), row["label"].as_str().unwrap(), "label {}", row["ms"]);
    }
    for row in twin["commands"].as_array().unwrap() {
        let got = Value::Object(parse_user_command(row["command"].as_str().unwrap()));
        assert!(same(&got, &row["parsed"]), "command {}: {} vs {}", row["command"], shorten(&got), shorten(&row["parsed"]));
    }
    for row in twin["titles"].as_array().unwrap() {
        assert_eq!(super::session_title::compact_session_title(row["value"].as_str().unwrap()), row["title"].as_str().unwrap(), "title {}", row["value"]);
    }
    for row in twin["durations"].as_array().unwrap() {
        let input = if row["input"].get("undefined").is_some() { Value::Null } else { row["input"].clone() };
        match parse_goal_duration(&input) {
            Ok(ms) => assert!(same(&mixdog_js::json_number(ms), &row["value"]), "duration {}", row["input"]),
            Err(error) => assert_eq!(error.message, row["error"].as_str().unwrap(), "duration {}", row["input"]),
        }
    }
}
