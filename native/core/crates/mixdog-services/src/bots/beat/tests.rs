//! The heartbeat against scripted sources. Each timeline replays one the Node recorder ran
//! (`benchmarks/rust-core/recorders/record-heartbeat.mjs`, fixture `heartbeat-twin.json`): every
//! tick's outcome and the state file it left must equal Node's, byte for byte as a document.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use chrono::{TimeZone, Utc};
use mixdog_core_base::rooms::ids::{MIXY_AGENT_ID, agent_home_session_id};
use mixdog_rt::testing::tokens;
use serde_json::{Value, json};

use super::digest::{SessionReader, TranscriptPage};
use super::*;
use crate::bots::TurnSettle;
use crate::bots::heartbeat::HeartbeatSessions;
use crate::bots::live::{LiveSurface, WakeOptions, WakeTurn};
use crate::bots::routine::RoutineKind;
use crate::bots::runtime::{RoutineRecords, RoutineState};
use crate::bots::state_json::StateJson;
use crate::bots::tests::{Fixture, fixture};
use crate::bots::wake::{MixyWake, WakeHost};
use crate::scheduler::Clock;
use crate::webhooks::RunStamp;

const MINUTE: i64 = 60_000;
const INTERVAL: i64 = 60 * MINUTE;
const SEEN_FAR_AHEAD: i64 = 1_900_000_000_000;

struct TestClock(Mutex<i64>);

impl TestClock {
    fn advance(&self, ms: i64) {
        *self.0.lock().unwrap() += ms;
    }
    fn at(&self) -> i64 {
        *self.0.lock().unwrap()
    }
}

impl Clock for TestClock {
    fn now(&self) -> chrono::DateTime<Utc> {
        Utc.timestamp_millis_opt(self.at()).unwrap()
    }
}

/// What the sources report: the catalog, the routines, the held requests; one switch breaks
/// the catalog.
#[derive(Default)]
struct World {
    rows: Mutex<Vec<CatalogRow>>,
    routines: Mutex<Vec<RoutineState>>,
    held: AtomicUsize,
    broken: AtomicBool,
    collects: AtomicUsize,
}

impl World {
    /// Node's `activity`: one session the user talks in.
    fn activity(&self) {
        *self.rows.lock().unwrap() = vec![CatalogRow {
            id: "sess_lead_1".into(),
            title: "Report".into(),
            last_message_preview: "Draft done".into(),
            last_used_at: SEEN_FAR_AHEAD,
            ..Default::default()
        }];
    }

    /// Node's `failing(failures)`: a schedule failing in a row, and no session news.
    fn failing(&self, failures: u32, with_activity: bool) {
        self.rows.lock().unwrap().clear();
        if with_activity {
            self.activity();
        }
        *self.routines.lock().unwrap() = vec![RoutineState {
            name: "daily-news".into(),
            owner_agent_id: "lead".into(),
            enabled: true,
            consecutive_failures: failures,
            last_failed_at: None,
            result_delivery: None,
        }];
    }
}

#[async_trait]
impl SessionCatalog for World {
    async fn page(&self, _limit: usize, _cursor: Option<&str>) -> Result<CatalogPage, String> {
        self.collects.fetch_add(1, Ordering::SeqCst);
        if self.broken.load(Ordering::SeqCst) {
            return Err("catalog unavailable".into());
        }
        Ok(CatalogPage { sessions: self.rows.lock().unwrap().clone(), next_cursor: None })
    }
    fn awaiting_approval(&self, _session_id: &str) -> bool {
        false
    }
}

#[async_trait]
impl TaskWatches for World {
    async fn task_session_ids(&self) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
}

#[async_trait]
impl HeldRequests for World {
    async fn pending(&self) -> Result<usize, String> {
        Ok(self.held.load(Ordering::SeqCst))
    }
}

#[async_trait]
impl RoutineRecords for World {
    async fn state(&self, _kind: RoutineKind, _name: &str) -> Result<Option<RoutineState>, String> {
        Ok(None)
    }
    async fn list(&self, kind: RoutineKind) -> Result<Vec<RoutineState>, String> {
        Ok(if kind == RoutineKind::Schedule { self.routines.lock().unwrap().clone() } else { Vec::new() })
    }
    async fn record_skip(&self, _kind: RoutineKind, _name: &str, _at: chrono::DateTime<Utc>) -> Result<(), String> {
        Ok(())
    }
    async fn record_delivery(&self, _kind: RoutineKind, _name: &str, _run_id: &str, _entry: Option<Value>) -> Result<(), String> {
        Ok(())
    }
    async fn record_webhook_run(&self, _name: &str, _outcome: RunStamp, _at: chrono::DateTime<Utc>) -> Result<(), String> {
        Ok(())
    }
}

/// How the Maintainer answers the gate; a review always gets an unusable reply, so a line
/// stays as collected, as Node's `review: unmanaged` leaves it.
#[derive(Clone)]
enum Gate {
    Nothing,
    Garbage,
    Down,
    Wake(&'static str),
}

struct Model {
    route: Mutex<Option<MaintainerRoute>>,
    gate: Mutex<Gate>,
    decides: AtomicUsize,
}

impl Model {
    fn set_model(&self, model: Option<&str>) {
        *self.route.lock().unwrap() =
            model.map(|model| MaintainerRoute { provider: "fake".into(), model: model.into(), effort: String::new(), fast: false });
    }
}

#[async_trait]
impl MaintainerModel for Model {
    async fn route(&self) -> Result<Option<MaintainerRoute>, String> {
        Ok(self.route.lock().unwrap().clone())
    }
    async fn send(&self, _route: &MaintainerRoute, _system: &str, user: &str, _max_output_tokens: u32) -> Result<String, String> {
        if !user.starts_with("Digest:\n") {
            return Ok("two\nlines".into());
        }
        self.decides.fetch_add(1, Ordering::SeqCst);
        match self.gate.lock().unwrap().clone() {
            Gate::Nothing => Ok("NOTHING".into()),
            Gate::Garbage => Ok("WAKE\n- the report is ready\nstray line".into()),
            Gate::Down => Err("503 overloaded".into()),
            Gate::Wake(item) => Ok(format!("WAKE\n- {item}")),
        }
    }
}

struct NoTranscripts;

#[async_trait]
impl SessionReader for NoTranscripts {
    async fn read_tail(&self, _session_id: &str, _limit: usize) -> Result<TranscriptPage, String> {
        Err("no transcript".into())
    }
}

#[derive(Default)]
struct Live {
    notices: Mutex<Vec<(String, Value)>>,
}

#[async_trait]
impl LiveSurface for Live {
    fn busy(&self, _session_id: &str) -> bool {
        false
    }
    async fn notice(&self, session_id: &str, notice: Value) -> Result<bool, String> {
        self.notices.lock().unwrap().push((session_id.into(), notice));
        Ok(true)
    }
    async fn wake(&self, _session_id: &str, _prompt: &str, _options: WakeOptions) -> Result<Option<WakeTurn>, String> {
        Ok(None)
    }
}

struct Settings {
    enabled: AtomicBool,
    mixy: AtomicBool,
    asked: AtomicUsize,
}

#[async_trait]
impl HeartbeatSettings for Settings {
    async fn is_enabled(&self) -> Result<bool, String> {
        self.asked.fetch_add(1, Ordering::SeqCst);
        Ok(self.enabled.load(Ordering::SeqCst))
    }
    async fn mixy_exists(&self) -> Result<bool, String> {
        Ok(self.mixy.load(Ordering::SeqCst))
    }
    async fn interval_ms(&self) -> Result<i64, String> {
        Ok(INTERVAL)
    }
}

/// The session service as a wake sees it. A close fails as often as `failures` says for the id;
/// ids of a session left open by an earlier process always fail.
#[derive(Default)]
struct Sessions {
    made: AtomicUsize,
    failures: Mutex<HashMap<String, usize>>,
    closes: Mutex<Vec<String>>,
}

#[async_trait]
impl WakeHost for Sessions {
    fn session_service_running(&self) -> bool {
        true
    }
    async fn lead_route(&self) -> Result<Option<Value>, String> {
        Ok(Some(json!({ "provider": "anthropic", "model": "opus" })))
    }
    async fn create_hidden_session(&self, _lead: &Value, _profile: &Value) -> Result<String, String> {
        Ok(format!("sess_hidden_{}", self.made.fetch_add(1, Ordering::SeqCst) + 1))
    }
    async fn close_hidden_session(&self, session_id: &str) -> Result<bool, String> {
        self.closes.lock().unwrap().push(session_id.into());
        if session_id.starts_with("sess_daemon_left") {
            return Ok(false);
        }
        let mut failures = self.failures.lock().unwrap();
        let left = failures.entry(session_id.into()).or_insert(0);
        if *left > 0 {
            *left -= 1;
            return Ok(false);
        }
        Ok(true)
    }
    async fn deliver(&self, _agent_id: &str, _run_id: &str, _text: &str) -> Result<(), String> {
        Ok(())
    }
}

struct Rig {
    hb: Arc<Heartbeat>,
    clock: Arc<TestClock>,
    world: Arc<World>,
    model: Arc<Model>,
    settings: Arc<Settings>,
    live: Arc<Live>,
    sessions: Arc<Sessions>,
    activity: Arc<UserActivity>,
    store: Arc<HeartbeatStore>,
    f: Fixture,
    path: PathBuf,
}

#[allow(clippy::disallowed_methods, reason = "test reads the state file the store wrote")]
fn read_state(path: &Path) -> Value {
    std::fs::read_to_string(path).ok().map_or(Value::Null, |text| serde_json::from_str(&text).unwrap())
}

#[allow(clippy::disallowed_methods, reason = "test seeds the state file an earlier process left")]
fn seed_state(path: &Path, doc: &Value) {
    std::fs::write(path, doc.to_string()).unwrap();
}

#[allow(clippy::disallowed_methods, reason = "test fixture loading")]
fn twin() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/heartbeat/heartbeat-twin.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// A heartbeat over the scripted sources, the Maintainer set to `model` (none: off).
async fn rig(model: Option<&str>, seed: Option<Value>) -> Rig {
    let f = fixture().await;
    let path = f._dir.path().join("heartbeat.json");
    if let Some(seed) = seed {
        seed_state(&path, &seed);
    }
    let clock = Arc::new(TestClock(Mutex::new(twin()["T0"].as_i64().unwrap())));
    let store = HeartbeatStore::new(StateJson::new(path.clone(), tokens().durability_io));
    let activity = UserActivity::new(store.clone(), clock.clone());
    let world = Arc::new(World::default());
    world.activity();
    let model_fake = Arc::new(Model { route: Mutex::new(None), gate: Mutex::new(Gate::Nothing), decides: AtomicUsize::new(0) });
    model_fake.set_model(model);
    let settings = Arc::new(Settings { enabled: AtomicBool::new(true), mixy: AtomicBool::new(true), asked: AtomicUsize::new(0) });
    let live = Arc::new(Live::default());
    let sessions = Arc::new(Sessions::default());
    let marks = HeartbeatSessions::new();
    *f.host.marks.lock().unwrap() = Some(marks.clone());
    let wake = Arc::new(MixyWake::new(f.rt.clone(), sessions.clone(), marks, store.clone()));
    let hb = Heartbeat::new(HeartbeatParts {
        clock: clock.clone(),
        store: store.clone(),
        activity: activity.clone(),
        settings: settings.clone(),
        facts: FactSources { catalog: world.clone(), watches: world.clone(), held: world.clone(), routines: world.clone() },
        tails: Arc::new(NoTranscripts),
        maintainer: Maintainer::new(model_fake.clone()),
        wake,
        live: live.clone(),
    });
    Rig { hb, clock, world, model: model_fake, settings, live, sessions, activity, store, f, path }
}

impl Rig {
    /// A wake's turn ends with `reply`.
    fn reply(&self, reply: &str) {
        self.f.host.settles.lock().unwrap().push_back(TurnSettle::Done { result: reply.into() });
    }

    fn advance(&self) {
        self.clock.advance(INTERVAL);
    }

    /// One tick, and the state file it left.
    async fn tick(&self) -> (Outcome, Value) {
        let outcome = self.hb.tick().await;
        (outcome, read_state(&self.path))
    }

    /// The tick must equal step `index` of Node's scenario `name`.
    async fn step(&self, name: &str, index: usize) {
        let (outcome, state) = self.tick().await;
        let node = &twin()["scenarios"][name]["steps"][index];
        assert_eq!(outcome.word(), node["outcome"].as_str().unwrap(), "{name} step {index} ({})", node["label"]);
        let expected = node["state"].as_object().unwrap();
        let got = state.as_object().expect("a state file");
        assert_eq!(got.len(), expected.len(), "{name} step {index}: keys {:?} against {:?}", got.keys().collect::<Vec<_>>(), expected.keys().collect::<Vec<_>>());
        for (key, want) in expected {
            assert_eq!(&got[key], want, "{name} step {index} ({}): `{key}` of the state file", node["label"]);
        }
    }

    /// The items each wake turn carried, in order.
    fn wakes(&self) -> Vec<Vec<String>> {
        self.f
            .host
            .turns()
            .iter()
            .map(|turn| {
                let content = turn.content.as_str().unwrap();
                content
                    .lines()
                    .skip_while(|line| !line.starts_with("Heartbeat items"))
                    .skip(1)
                    .take_while(|line| !line.is_empty())
                    .map(|line| line.strip_prefix("- ").unwrap().to_owned())
                    .collect()
            })
            .collect()
    }

    async fn notices(&self, count: usize) -> Vec<(String, Value)> {
        for _ in 0..200 {
            if self.live.notices.lock().unwrap().len() >= count {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        self.live.notices.lock().unwrap().clone()
    }
}

fn node(name: &str, key: &str) -> Value {
    twin()["scenarios"][name][key].clone()
}

fn routine_item() -> Vec<String> {
    vec!["schedule \"daily-news\" failed 3x in a row".to_owned()]
}

#[test]
fn the_timers_are_a_minute_then_five() {
    assert_eq!((FIRST_TICK, TICK), (Duration::from_secs(60), Duration::from_secs(300)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_first_tick_comes_after_its_wait_and_the_rest_at_the_tick() {
    let r = rig(None, None).await;
    r.settings.enabled.store(false, Ordering::SeqCst);
    let running = start_mixy_heartbeat(r.hb.clone(), Duration::from_millis(100), Duration::from_millis(400));
    let asked = |r: &Rig| r.settings.asked.load(Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(asked(&r), 0, "nothing before the first wait");
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(asked(&r), 1, "the first tick after the wait");
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(asked(&r), 2, "the repeating timer's first tick is a full tick after the start (400 ms)");
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(asked(&r), 2);
    tokio::time::sleep(Duration::from_millis(350)).await;
    assert_eq!(asked(&r), 3, "then one per tick (800 ms; the next at 1200)");
    running.stop().await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(asked(&r), 3, "a stopped heartbeat ticks no more");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_setting_off_runs_nothing_and_no_mixy_clears_the_watermark() {
    let r = rig(None, None).await;
    r.settings.enabled.store(false, Ordering::SeqCst);
    assert_eq!(r.tick().await, (Outcome::Off, Value::Null), "off writes no file");
    r.settings.enabled.store(true, Ordering::SeqCst);
    assert_eq!(r.tick().await.0, Outcome::Armed);
    r.settings.mixy.store(false, Ordering::SeqCst);
    let (outcome, state) = r.tick().await;
    assert_eq!((outcome, state["lastBeatAt"].clone()), (Outcome::NoMixy, json!(0)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn checks_are_one_interval_apart_and_a_wake_hands_over_the_routine_item() {
    let r = rig(None, None).await;
    r.world.failing(3, false);
    r.reply("Reported.");
    r.step("routineWake", 0).await;
    r.advance();
    r.step("routineWake", 1).await;
    r.advance();
    r.step("routineWake", 2).await;
    r.clock.advance(1);
    r.step("routineWake", 3).await;
    assert_eq!(r.wakes(), [routine_item()]);
    assert_eq!(r.model.decides.load(Ordering::SeqCst), 0, "no model is asked");
    assert_eq!(r.world.collects.load(Ordering::SeqCst), node("routineWake", "collects").as_array().unwrap().len());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_due_check_waits_for_thirty_quiet_minutes() {
    let r = rig(Some("tiny"), None).await;
    r.step("idleGate", 0).await;
    r.advance();
    r.activity.note_user_turn(r.clock.at() - 29 * MINUTE);
    let (outcome, _) = r.tick().await;
    assert_eq!(outcome.word(), twin()["scenarios"]["idleGate"]["steps"][1]["outcome"]);
    assert_eq!(r.world.collects.load(Ordering::SeqCst), 0, "a deferred check collects nothing");
    r.clock.advance(MINUTE);
    let (outcome, _) = r.tick().await;
    assert_eq!(outcome.word(), twin()["scenarios"]["idleGate"]["steps"][2]["outcome"]);
    assert_eq!(r.world.collects.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_collection_commits_nothing_and_waits_for_the_next_interval() {
    let r = rig(Some("tiny"), None).await;
    r.step("failedCollection", 0).await;
    r.advance();
    r.world.broken.store(true, Ordering::SeqCst);
    r.step("failedCollection", 1).await;
    r.step("failedCollection", 2).await;
    r.world.broken.store(false, Ordering::SeqCst);
    r.advance();
    r.step("failedCollection", 3).await;
    assert_eq!(r.world.collects.load(Ordering::SeqCst), node("failedCollection", "collects").as_array().unwrap().len(), "the failed check was collected again");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rejected_wake_keeps_the_digest_and_the_report_for_the_next_check() {
    let r = rig(None, None).await;
    r.world.failing(3, false);
    r.step("rejectedWake", 0).await;
    r.advance();
    r.f.host.settles.lock().unwrap().push_back(TurnSettle::Failed("no Lead model is chosen".into()));
    r.step("rejectedWake", 1).await;
    r.advance();
    r.reply("Reported.");
    r.step("rejectedWake", 2).await;
    r.advance();
    r.step("rejectedWake", 3).await;
    assert_eq!(r.wakes(), [routine_item(), routine_item()]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_routine_wake_after_a_failed_gate_commits_only_the_routine_warning() {
    let r = rig(Some("tiny"), None).await;
    r.world.failing(3, true);
    *r.model.gate.lock().unwrap() = Gate::Down;
    r.step("failedGate", 0).await;
    r.advance();
    r.reply("Reported.");
    r.step("failedGate", 1).await;
    *r.model.gate.lock().unwrap() = Gate::Wake("The report draft is ready");
    r.advance();
    r.reply("Reported.");
    r.step("failedGate", 2).await;
    assert_eq!(r.wakes(), [routine_item(), vec!["The report draft is ready".to_owned()]]);
    assert_eq!(r.world.collects.load(Ordering::SeqCst), node("failedGate", "collects").as_array().unwrap().len());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn three_unusable_replies_trip_the_breaker_with_one_notice_until_the_model_changes() {
    let r = rig(Some("tiny"), None).await;
    *r.model.gate.lock().unwrap() = Gate::Garbage;
    r.step("parseBreaker", 0).await;
    for index in 1..=4 {
        r.advance();
        r.step("parseBreaker", index).await;
    }
    assert_eq!(r.model.decides.load(Ordering::SeqCst), 3, "the fourth check skips the Maintainer");
    let home = agent_home_session_id(MIXY_AGENT_ID).unwrap();
    let notices = r.notices(1).await;
    assert_eq!(notices.len(), 1);
    assert_eq!(notices[0].0, home);
    assert_eq!(notices[0].1, json!({ "text": node("parseBreaker", "notices")[0], "tone": "warn" }));
    r.model.set_model(Some("other"));
    r.world.rows.lock().unwrap().clear();
    r.world.held.store(1, Ordering::SeqCst);
    r.advance();
    r.step("parseBreaker", 5).await;
    assert_eq!(r.model.decides.load(Ordering::SeqCst), node("parseBreaker", "decides").as_u64().unwrap() as usize, "a new model resets it");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn five_provider_failures_trip_it_and_a_failing_routine_still_wakes_mixy() {
    let r = rig(Some("tiny"), None).await;
    *r.model.gate.lock().unwrap() = Gate::Down;
    r.step("providerBreaker", 0).await;
    for index in 1..=5 {
        r.advance();
        r.step("providerBreaker", index).await;
    }
    let notices = r.notices(1).await;
    assert_eq!(notices.len(), 1);
    assert_eq!(notices[0].1["text"], node("providerBreaker", "notices")[0]);
    r.world.failing(3, false);
    r.advance();
    r.reply("Reported.");
    r.step("providerBreaker", 6).await;
    assert_eq!(r.model.decides.load(Ordering::SeqCst), 5);
    assert_eq!(r.wakes(), [routine_item()]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_close_that_did_not_land_is_retried_first_on_the_next_tick() {
    let r = rig(None, None).await;
    r.world.failing(3, false);
    // The wake's own close fails, then the first retry fails too (Node's recorder fails the
    // first close it is asked for); the third try lands.
    r.sessions.failures.lock().unwrap().insert("sess_hidden_1".into(), 2);
    r.step("retryRelease", 0).await;
    r.advance();
    r.reply("Reported.");
    r.step("retryRelease", 1).await;
    assert_eq!(*r.sessions.closes.lock().unwrap(), ["sess_hidden_1"]);
    r.step("retryRelease", 2).await;
    assert_eq!(*r.sessions.closes.lock().unwrap(), ["sess_hidden_1", "sess_hidden_1"], "retried before anything else");
    let (_, state) = r.tick().await;
    assert_eq!(state["unreleased"], json!([]), "a landed retry drops the id");
    assert_eq!(r.sessions.closes.lock().unwrap().len(), 3);
    assert_eq!(r.wakes().len(), 1, "never woken again for it");
}

fn left_open(count: usize) -> Vec<String> {
    (0..count).map(|index| format!("sess_daemon_left{index}")).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn twenty_unclosed_sessions_block_every_check_and_keep_every_id() {
    let ids = left_open(20);
    assert_eq!(node("blocked", "ids"), json!(ids));
    let r = rig(Some("tiny"), Some(json!({ "unreleased": ids }))).await;
    r.world.failing(3, false);
    r.step("blocked", 0).await;
    r.advance();
    r.step("blocked", 1).await;
    assert!(r.wakes().is_empty());
    assert_eq!(r.model.decides.load(Ordering::SeqCst), 0);
    assert_eq!(r.sessions.closes.lock().unwrap().len(), 40, "each tick retried all twenty first");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn nineteen_unclosed_sessions_still_let_a_check_run() {
    let ids = left_open(19);
    let r = rig(None, Some(json!({ "unreleased": ids }))).await;
    r.world.failing(3, false);
    r.step("underCap", 0).await;
    r.advance();
    r.reply("Reported.");
    r.step("underCap", 1).await;
    assert_eq!(r.wakes(), [routine_item()]);
    assert_eq!(r.store.state().await.unreleased.len(), 19);
}
