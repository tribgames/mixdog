//! The home delivery against `fixtures/home-delivery/golden.json`, recorded from the Node product
//! by `record-home-delivery.mjs`: the real `createAgentHomeDelivery` over a real
//! `routine-results.json`, driven by a script of operations. The Rust delivery replays the script
//! over fakes of the same seams and must leave, after every operation, the same queue file, the
//! same thread messages, the same live notices, the same wake turns and the same retry delays. Wake ids
//! compare exactly: the recorder replaced Node's `crypto.randomUUID` with a counter and the queue's id
//! source here is the same counter.

use std::collections::{BTreeMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use tokio::sync::oneshot;

use super::env::{DeliveryConfig, HomeAgent, HomeDirectory, HomeThreads, LiveSlot, Presence, RetryTimer, RoomRelay, ThreadSnapshot, WakeFollow};
use super::home::{AgentHomeDelivery, TaskReport};
use super::queue::{Handoffs, QUEUE_CAPS, RoutineResultQueue};
use crate::bots::host::{AnnouncedRun, DeliveryItem};
use crate::bots::live::{LiveSurface, WakeOptions, WakeTurn};
use crate::bots::routine::RoutineKind;
use crate::bots::state_json::StateJson;
use crate::scheduler::Clock;

const GOLDEN: &str = include_str!("../../../../../fixtures/home-delivery/golden.json");
const T0: i64 = 1_800_000_000_000;

struct FixedClock(Mutex<i64>);
impl Clock for FixedClock {
    fn now(&self) -> DateTime<Utc> {
        DateTime::from_timestamp_millis(*self.0.lock().unwrap()).unwrap()
    }
}

struct NoHandoffs;
impl Handoffs for NoHandoffs {
    fn note(&self, _: &Value) {}
    fn end(&self, _: &str) {}
}

#[derive(Default)]
struct Ctl {
    extra_drains: bool,
    busy: bool,
    refuse: u64,
    presence: BTreeMap<String, Presence>,
    home_agents: BTreeMap<String, HomeAgent>,
    mixy_exists: bool,
}

struct World {
    ctl: Mutex<Ctl>,
    threads: Mutex<BTreeMap<String, Vec<Value>>>,
    notices: Mutex<Vec<Value>>,
    wakes: Mutex<Vec<Value>>,
    turns: Mutex<VecDeque<oneshot::Sender<String>>>,
    retries: Mutex<Vec<Box<dyn FnOnce() + Send>>>,
    /// Every delay a retry was asked for, in order.
    scheduled: Mutex<Vec<u64>>,
    uuids: AtomicU64,
}

struct Threads(Arc<World>);
#[async_trait]
impl HomeThreads for Threads {
    async fn load(&self, id: &str) -> Result<Option<ThreadSnapshot>, String> {
        Ok(self.0.threads.lock().unwrap().get(id).map(|messages| ThreadSnapshot { closed: false, messages: messages.clone() }))
    }
    async fn append(&self, id: &str, rows: Vec<Value>, _: Option<i64>) -> Result<(), String> {
        self.0.threads.lock().unwrap().get_mut(id).ok_or("no thread")?.extend(rows);
        Ok(())
    }
    fn turn_in_flight(&self, _: &str) -> bool {
        self.0.ctl.lock().unwrap().busy
    }
    async fn session_deleted(&self, _: &str) -> bool {
        false
    }
}

struct Directory(Arc<World>);
#[async_trait]
impl HomeDirectory for Directory {
    async fn agent_presence(&self, agent_id: &str) -> Presence {
        self.0.ctl.lock().unwrap().presence.get(agent_id).copied().unwrap_or(Presence::Unknown)
    }
    async fn room_presence(&self, _: &str) -> Presence {
        Presence::Unknown
    }
    async fn home_agent(&self, agent_id: &str) -> HomeAgent {
        self.0.ctl.lock().unwrap().home_agents.get(agent_id).copied().unwrap_or(HomeAgent::Unknown)
    }
    async fn mixy_exists(&self) -> bool {
        self.0.ctl.lock().unwrap().mixy_exists
    }
}

struct Live(Arc<World>);
#[async_trait]
impl LiveSurface for Live {
    fn busy(&self, _: &str) -> bool {
        false
    }
    async fn notice(&self, session_id: &str, notice: Value) -> Result<bool, String> {
        self.0.notices.lock().unwrap().push(json!([session_id, notice]));
        Ok(true)
    }
    async fn wake(&self, session_id: &str, prompt: &str, options: WakeOptions) -> Result<Option<WakeTurn>, String> {
        self.0.wakes.lock().unwrap().push(json!([session_id, prompt, { "id": options.id, "hop": options.hop }]));
        {
            let mut ctl = self.0.ctl.lock().unwrap();
            if ctl.refuse > 0 {
                ctl.refuse -= 1;
                return Ok(None);
            }
        }
        let (settle, settled) = oneshot::channel();
        self.0.turns.lock().unwrap().push_back(settle);
        Ok(Some(WakeTurn { settled }))
    }
}

/// The script has no room members.
struct NoRooms;
#[async_trait]
impl RoomRelay for NoRooms {
    async fn relay(&self, session_id: &str, _: &str, _: WakeOptions, _: WakeFollow) -> Result<Option<WakeTurn>, String> {
        panic!("the script has no room member: {session_id}")
    }
}

struct Retries(Arc<World>);
impl RetryTimer for Retries {
    fn arm(&self, delay: Duration, fire: Box<dyn FnOnce() + Send>) {
        self.0.scheduled.lock().unwrap().push(delay.as_millis() as u64);
        self.0.retries.lock().unwrap().push(fire);
    }
}

const HOMES: [&str; 4] = ["sess_home_reviewer", "sess_home_lead", "sess_home_ghost", "sess_home_critic"];

fn text(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn opt(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(String::from)
}

fn kind_of(value: &Value) -> RoutineKind {
    if text(value, "kind") == "webhook" { RoutineKind::Webhook } else { RoutineKind::Schedule }
}

fn delivery_item(value: &Value) -> DeliveryItem {
    DeliveryItem {
        run_id: text(value, "runId"),
        kind: kind_of(value),
        ok: value["ok"].as_bool().unwrap(),
        text: text(value, "text"),
        run_session_id: opt(value, "runSessionId"),
        reason: opt(value, "reason"),
        paused: value.get("paused").and_then(Value::as_bool),
    }
}

fn task_report(value: &Value) -> TaskReport {
    let strings = |key: &str| value.get(key).and_then(Value::as_array).map(|a| a.iter().map(|v| v.as_str().unwrap().to_string()).collect()).unwrap_or_default();
    TaskReport {
        run_id: text(value, "runId"),
        task_session_id: text(value, "taskSessionId"),
        title: text(value, "title"),
        status: text(value, "status"),
        text: text(value, "text"),
        target: opt(value, "target"),
        files: value.get("files").and_then(Value::as_array).cloned().unwrap_or_default(),
        omitted: value.get("omitted").and_then(Value::as_f64).unwrap_or(0.0),
        hop: value.get("hop").and_then(Value::as_f64).unwrap_or(0.0),
        watch_id: text(value, "watchId"),
        watch_ids: strings("watchIds"),
        progress_run_id: text(value, "progressRunId"),
        from: text(value, "from"),
        progress_watch_id: text(value, "progressWatchId"),
        answer_id: text(value, "answerId"),
    }
}

struct Replay {
    world: Arc<World>,
    clock: Arc<FixedClock>,
    dir: tempfile::TempDir,
    delivery: Arc<AgentHomeDelivery>,
}

fn build(world: &Arc<World>, clock: &Arc<FixedClock>, dir: &std::path::Path, limit: usize) -> Arc<AgentHomeDelivery> {
    let state = StateJson::new(dir.join("routine-results.json"), mixdog_rt::testing::tokens().durability_io);
    let ids = world.clone();
    let uuids = Arc::new(move || format!("00000000-0000-4000-8000-{:012x}", ids.uuids.fetch_add(1, Ordering::SeqCst) + 1));
    let queue = Arc::new(RoutineResultQueue::new(state, limit, QUEUE_CAPS, clock.clone(), Arc::new(NoHandoffs)).with_uuids(uuids));
    let live = LiveSlot::new();
    live.set(Some(Arc::new(Live(world.clone()))));
    AgentHomeDelivery::new(
        Arc::new(Threads(world.clone())),
        Arc::new(Directory(world.clone())),
        live,
        Arc::new(NoRooms),
        queue,
        clock.clone(),
        Arc::new(Retries(world.clone())),
        DeliveryConfig::node(),
    )
}

impl Replay {
    fn new() -> Self {
        let world = Arc::new(World {
            ctl: Mutex::new(Ctl { extra_drains: true, mixy_exists: true, ..Ctl::default() }),
            threads: Mutex::default(),
            notices: Mutex::default(),
            wakes: Mutex::default(),
            turns: Mutex::default(),
            retries: Mutex::default(),
            scheduled: Mutex::default(),
            uuids: AtomicU64::new(0),
        });
        let clock = Arc::new(FixedClock(Mutex::new(T0)));
        let dir = tempfile::tempdir().unwrap();
        let delivery = build(&world, &clock, dir.path(), 200);
        Self { world, clock, dir, delivery }
    }

    #[allow(clippy::disallowed_methods)] // a test reads the file the queue wrote
    fn queue_file(&self) -> Value {
        std::fs::read_to_string(self.dir.path().join("routine-results.json")).ok().and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or(Value::Null)
    }

    /// What can still move: the queue file, the thread lengths and the counts of what the
    /// delivery emitted.
    fn fingerprint(&self) -> String {
        let lengths: Vec<usize> = self.world.threads.lock().unwrap().values().map(Vec::len).collect();
        format!(
            "{}{lengths:?}{}{}{}",
            self.queue_file(),
            self.world.notices.lock().unwrap().len(),
            self.world.wakes.lock().unwrap().len(),
            self.world.scheduled.lock().unwrap().len()
        )
    }

    /// The step's end: with xtraDrains every home is drained twice (joining a pass in flight),
    /// then the passes the delivery started on its own (a fired retry, a settled wake) are waited
    /// for until nothing moves, as the recorder does.
    async fn quiesce(&self) {
        let extra = self.world.ctl.lock().unwrap().extra_drains;
        if extra {
            for _ in 0..2 {
                for home in HOMES {
                    self.delivery.drain(home).wait().await;
                }
            }
        }
        let (mut last, mut same) = (String::new(), 0);
        while same < 5 {
            tokio::time::sleep(Duration::from_millis(25)).await;
            let now = self.fingerprint();
            same = if now == last { same + 1 } else { 0 };
            last = now;
        }
    }

    /// One operation of the script: what it returned.
    async fn run(&mut self, step: &Value) -> Value {
        let o = &step["op"];
        let d = self.delivery.clone();
        match o["op"].as_str().unwrap() {
            "config" => {
                self.delivery = build(&self.world, &self.clock, self.dir.path(), o["limit"].as_u64().unwrap() as usize);
                Value::Null
            }
            "enqueue" => json!(d.enqueue(&text(o, "owner"), &text(o, "name"), &delivery_item(&o["item"])).await.unwrap()),
            "held" => json!(d.enqueue_held(&text(o, "agent"), o["held"].clone()).await.unwrap()),
            "message" => json!(d.enqueue_message(&text(o, "agent"), &text(o, "runId"), &text(o, "text")).await.unwrap()),
            "task" => json!(d.enqueue_task(&text(o, "agent"), &task_report(&o["report"])).await.unwrap()),
            "drain" => {
                d.drain(&text(o, "home")).wait().await;
                Value::Null
            }
            "before" => {
                d.post_before_turn(&text(o, "home")).await;
                Value::Null
            }
            "thread" => {
                self.world.threads.lock().unwrap().insert(text(o, "id"), o["messages"].as_array().unwrap().clone());
                Value::Null
            }
            "extraDrains" => {
                self.world.ctl.lock().unwrap().extra_drains = o["value"].as_bool().unwrap();
                Value::Null
            }
            "busy" => {
                self.world.ctl.lock().unwrap().busy = o["value"].as_bool().unwrap();
                Value::Null
            }
            "refuseWakes" => {
                self.world.ctl.lock().unwrap().refuse = o["count"].as_u64().unwrap();
                Value::Null
            }
            "presence" => {
                self.world.ctl.lock().unwrap().presence = o["agents"].as_object().unwrap().iter().map(|(id, v)| (id.clone(), if v == "deleted" { Presence::Deleted } else { Presence::Present })).collect();
                Value::Null
            }
            "homeAgents" => {
                self.world.ctl.lock().unwrap().home_agents = o["agents"].as_object().unwrap().iter().map(|(id, v)| (id.clone(), if v == "none" { HomeAgent::None } else { HomeAgent::Bot })).collect();
                Value::Null
            }
            "mixyExists" => {
                self.world.ctl.lock().unwrap().mixy_exists = o["value"].as_bool().unwrap();
                Value::Null
            }
            "time" => {
                *self.clock.0.lock().unwrap() += o["ms"].as_i64().unwrap();
                Value::Null
            }
            "fire" => {
                let due: Vec<_> = self.world.retries.lock().unwrap().drain(..).collect();
                for fire in due {
                    fire();
                }
                Value::Null
            }
            "settle" => {
                let turn = self.world.turns.lock().unwrap().pop_front();
                if let Some(turn) = turn {
                    turn.send(text(o, "status")).unwrap();
                }
                Value::Null
            }
            "watch" => {
                d.watch_task(o["watch"].clone()).await.unwrap();
                Value::Null
            }
            "follow" => {
                d.follow_task(&text(o, "runId"), &text(o, "submissionId")).await.unwrap();
                Value::Null
            }
            "unwatch" => {
                d.unwatch_task(&text(o, "runId")).await.unwrap();
                Value::Null
            }
            "own" => {
                d.own_task(o["work"].clone()).await.unwrap();
                Value::Null
            }
            "disown" => {
                d.disown_task(o["runIds"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect()).await.unwrap();
                Value::Null
            }
            "watches" => Value::Array(d.task_watches().await.unwrap()),
            "owned" => Value::Array(d.owned_tasks().await.unwrap()),
            "reset" => {
                d.reset_rounds(&text(o, "home")).await.unwrap();
                Value::Null
            }
            "recover" => {
                d.recover().await.unwrap();
                Value::Null
            }
            "announce" => {
                let run = AnnouncedRun { item: delivery_item(&o["run"]), state: if text(&o["run"], "state") == "running" { "running" } else { "undelivered" } };
                json!(d.announce(&text(o, "owner"), &text(o, "name"), &run).await)
            }
            other => panic!("unknown op {other}"),
        }
    }

    /// The queue file and every thread, as one text.
    fn everything(&self) -> String {
        format!("{}{:?}", self.queue_file(), self.world.threads.lock().unwrap())
    }
}

/// A task's report and a routine run's result leave the session they come from: a value that session marked sensitive
/// is the marker in the queued item and in the home row (Node `agent-home-delivery.mjs` `taskReportItem`,
/// `routineResultItem`).
#[tokio::test(start_paused = true)]
async fn a_task_report_and_a_routine_result_reach_the_home_with_their_sessions_sensitive_values_as_the_marker() {
    const CODE: &str = "482913";
    let replay = Replay::new();
    let marks = Arc::new(crate::memory::sensitive::SensitiveStore::default());
    let fill = |code: &str| json!({ "name": "browser", "arguments": { "action": "fill", "input": { "sensitive": true, "text": code } } });
    assert!(marks.remember("sess_task", &[fill(CODE)]));
    assert!(marks.remember("sess_run", &[fill(CODE)]));
    assert!(replay.delivery.redact_with(marks));
    let report = task_report(&json!({ "runId": "t1", "taskSessionId": "sess_task", "title": "T", "status": "done", "text": format!("the code is {CODE}") }));
    replay.delivery.enqueue_task("reviewer", &report).await.unwrap();
    let item = delivery_item(&json!({ "runId": "r1", "kind": "schedule", "ok": true, "text": format!("ran with {CODE}"), "runSessionId": "sess_run" }));
    replay.delivery.enqueue("reviewer", "nightly", &item).await.unwrap();
    replay.quiesce().await;
    let all = replay.everything();
    assert!(!all.contains(CODE), "{all}");
    assert!(all.contains("the code is [redacted]") && all.contains("ran with [redacted]"), "{all}");
}

#[tokio::test(start_paused = true)]
async fn replays_the_node_delivery_script() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let mut replay = Replay::new();
    let (mut seen_notices, mut seen_wakes, mut seen_delays) = (0, 0, 0);
    for (index, step) in golden["steps"].as_array().unwrap().iter().enumerate() {
        let out = replay.run(step).await;
        replay.quiesce().await;
        let label = format!("step {index} {}", step["op"]);
        let notices = replay.world.notices.lock().unwrap().clone();
        let wakes = replay.world.wakes.lock().unwrap().clone();
        let threads = replay.world.threads.lock().unwrap().iter().map(|(id, messages)| (id.clone(), Value::Array(messages.clone()))).collect::<serde_json::Map<_, _>>();
        let delays = replay.world.scheduled.lock().unwrap().clone();
        assert_eq!(out, step["out"], "{label}: result");
        assert_eq!(replay.queue_file(), step["queue"], "{label}: routine-results.json");
        assert_eq!(Value::Object(threads), step["threads"], "{label}: threads");
        assert_eq!(Value::Array(notices[seen_notices..].to_vec()), step["notices"], "{label}: notices");
        assert_eq!(Value::Array(wakes[seen_wakes..].to_vec()), step["wakes"], "{label}: wakes");
        assert_eq!(json!(delays[seen_delays..]), step["delays"], "{label}: retry delays");
        seen_delays = delays.len();
        seen_notices = notices.len();
        seen_wakes = wakes.len();
    }
}
