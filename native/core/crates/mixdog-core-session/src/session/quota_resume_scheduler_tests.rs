//! The quota-resume clock against the Node recording
//! (`fixtures/quota-scheduler/golden.json`, Node's real `createQuotaResumeScheduler` over its real
//! store): the delay the one timer is armed for, and per tick the log, the usage readings, the
//! retries fired and the queue left behind. The timer's own wakeups, a restart over the file Node's
//! store wrote, overlapping ticks and stop are driven on a clock the test moves.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_core_base::quota_resume::{QUOTA_RESUME_FILE, QuotaResumeStore};
use mixdog_core_base::support::on_lane;
use mixdog_js::json_number;
use mixdog_rt::CancellationToken;
use serde_json::{Value, json};
use tokio::sync::{Notify, Semaphore};

use super::quota_resume_scheduler::{FireOutcome, QuotaResumeScheduler, ResumeClock, ResumeHost, ResumeLog, SessionRoute, UsageError};

/// A clock only the test moves: `sleep` returns when `advance` brings the clock to its deadline.
struct ManualClock {
    now: Mutex<f64>,
    sleepers: Arc<Mutex<Vec<Sleeper>>>,
    next: Mutex<u64>,
    /// Signals every change a test waits on: a timer set or cleared, a line logged.
    changed: Arc<Notify>,
}

struct Sleeper {
    id: u64,
    ms: u64,
    deadline: f64,
    wake: Arc<Notify>,
}

/// Removes the sleeper when its sleep ends or is dropped, as clearing a timer does.
struct Registered {
    sleepers: Arc<Mutex<Vec<Sleeper>>>,
    id: u64,
    changed: Arc<Notify>,
}

impl Drop for Registered {
    fn drop(&mut self) {
        self.sleepers.lock().unwrap().retain(|s| s.id != self.id);
        self.changed.notify_waiters();
    }
}

impl ManualClock {
    fn new(now: f64) -> Self {
        Self { now: Mutex::new(now), sleepers: Arc::default(), next: Mutex::new(0), changed: Arc::default() }
    }

    fn advance(&self, ms: f64) {
        let now = {
            let mut now = self.now.lock().unwrap();
            *now += ms;
            *now
        };
        for sleeper in self.sleepers.lock().unwrap().iter().filter(|s| s.deadline <= now) {
            sleeper.wake.notify_one();
        }
    }

    /// The delay the live timer was set for, none when no timer is set.
    fn armed(&self) -> Option<u64> {
        self.sleepers.lock().unwrap().last().map(|s| s.ms)
    }
}

#[async_trait]
impl ResumeClock for ManualClock {
    fn now_ms(&self) -> f64 {
        *self.now.lock().unwrap()
    }
    async fn sleep(&self, ms: u64) {
        let wake = Arc::new(Notify::new());
        let id = {
            let mut next = self.next.lock().unwrap();
            *next += 1;
            *next
        };
        let deadline = self.now_ms() + ms as f64;
        self.sleepers.lock().unwrap().push(Sleeper { id, ms, deadline, wake: wake.clone() });
        self.changed.notify_waiters();
        let _registered = Registered { sleepers: self.sleepers.clone(), id, changed: self.changed.clone() };
        wake.notified().await;
    }
}

/// Waits until $ready holds; a failure names its text.
macro_rules! wait_until {
    ($wakes:expr, $ready:expr) => {
        crate::eventually_on!($wakes, || ($ready).then_some(()))
    };
}

async fn open_store(dir: &Path) -> Arc<QuotaResumeStore> {
    Arc::new(QuotaResumeStore::open(dir, mixdog_rt::testing::tokens().durability_io, CancellationToken::new()).await.unwrap())
}

/// A store file as another process left it.
async fn put_store_file(dir: &Path, text: &str) {
    let (path, bytes) = (dir.join(QUOTA_RESUME_FILE), text.as_bytes().to_vec());
    on_lane(mixdog_rt::testing::tokens().durability_io, &CancellationToken::new(), move |lane| mixdog_statefile::append_file(lane, &path, &bytes))
        .await
        .unwrap()
        .unwrap();
}

fn golden() -> Value {
    serde_json::from_str(include_str!("../../../../fixtures/quota-scheduler/golden.json")).unwrap()
}

fn scheduler_over(store: &Arc<QuotaResumeStore>, host: Arc<dyn ResumeHost>, clock: &Arc<ManualClock>, log: &Arc<Mutex<Vec<String>>>) -> Arc<QuotaResumeScheduler> {
    let sink = log.clone();
    let changed = clock.changed.clone();
    let line_log: ResumeLog = Arc::new(move |line: &str| {
        sink.lock().unwrap().push(line.to_owned());
        changed.notify_waiters();
    });
    Arc::new(QuotaResumeScheduler::new(store.clone(), host, clock.clone(), Arc::new(|| true), line_log))
}

/// Holds every fire until the test lets it through.
struct GateHost {
    fires: Mutex<Vec<(String, u64)>>,
    fired: Notify,
    gate: Semaphore,
}

impl GateHost {
    fn new() -> Arc<Self> {
        Arc::new(Self { fires: Mutex::default(), fired: Notify::new(), gate: Semaphore::new(0) })
    }
}

#[async_trait]
impl ResumeHost for GateHost {
    async fn materialize(&self, _session_id: &str) -> Result<(), String> {
        Ok(())
    }
    async fn route(&self, _session_id: &str) -> SessionRoute {
        SessionRoute { provider: "openai-oauth".to_owned(), model: "gpt-x".to_owned() }
    }
    async fn usable(&self, _provider: &str, _model: &str) -> Result<bool, UsageError> {
        Ok(true)
    }
    async fn fire(&self, session_id: &str, generation: u64) -> Result<FireOutcome, String> {
        self.fires.lock().unwrap().push((session_id.to_owned(), generation));
        self.fired.notify_waiters();
        self.gate.acquire().await.unwrap().forget();
        Ok(FireOutcome::Fired)
    }
}

async fn schedule(store: &QuotaResumeStore, id: &str, reset_at: f64) {
    store
        .schedule(&json!({ "sessionId": id, "turnKey": format!("turn:{id}"), "provider": "openai-oauth", "model": "gpt-x", "resetAt": reset_at }))
        .await
        .unwrap();
}

#[derive(Default)]
struct Calls {
    reads: HashMap<String, usize>,
    usable: Vec<Value>,
    fire: Vec<Value>,
}

struct Host {
    spec: Value,
    calls: Mutex<Calls>,
}

#[async_trait]
impl ResumeHost for Host {
    async fn materialize(&self, _session_id: &str) -> Result<(), String> {
        match self.spec["materialize"].as_str() {
            Some(error) => Err(error.to_owned()),
            None => Ok(()),
        }
    }

    async fn route(&self, session_id: &str) -> SessionRoute {
        let routes = self.spec.get("routes").and_then(Value::as_array).cloned().unwrap_or_else(|| vec![json!({ "provider": "openai-oauth", "model": "gpt-x" })]);
        let mut calls = self.calls.lock().unwrap();
        let read = calls.reads.entry(session_id.to_owned()).or_default();
        *read += 1;
        let route = &routes[(*read).min(routes.len()) - 1];
        SessionRoute { provider: route["provider"].as_str().unwrap().to_owned(), model: route["model"].as_str().unwrap().to_owned() }
    }

    async fn usable(&self, provider: &str, model: &str) -> Result<bool, UsageError> {
        self.calls.lock().unwrap().usable.push(json!({ "provider": provider, "model": model }));
        match self.spec.get("usable") {
            None => Ok(true),
            Some(Value::Bool(usable)) => Ok(*usable),
            Some(other) if other.get("fail").is_some() => Err(UsageError::Failed(other["fail"].as_str().unwrap().to_owned())),
            Some(other) => Err(UsageError::ProxyUnavailable(other["proxy"].as_str().unwrap().to_owned())),
        }
    }

    async fn fire(&self, session_id: &str, generation: u64) -> Result<FireOutcome, String> {
        self.calls.lock().unwrap().fire.push(json!({ "sessionId": session_id, "generation": generation }));
        match self.spec.get("fire") {
            Some(Value::Object(fail)) => Err(fail["fail"].as_str().unwrap().to_owned()),
            None => Ok(FireOutcome::Fired),
            Some(name) => Ok(match name.as_str().unwrap() {
                "fired" => FireOutcome::Fired,
                "busy" => FireOutcome::Busy,
                "rejected" => FireOutcome::Rejected,
                "stale" => FireOutcome::Stale,
                "superseded" => FireOutcome::Superseded,
                "unreplayable" => FireOutcome::Unreplayable,
                other => panic!("{other}"),
            }),
        }
    }
}

fn queue(store: &QuotaResumeStore, now: f64, base: u64) -> Value {
    Value::Array(
        store
            .list()
            .iter()
            .map(|e| json!({ "sessionId": e.session_id, "generation": e.generation - base, "resetAt": json_number(e.reset_at.as_f64().unwrap() - now), "attempts": e.attempts }))
            .collect(),
    )
}

#[tokio::test]
async fn the_clock_matches_node() {
    let golden = golden();
    let now = golden["now"].as_f64().unwrap();
    for case in golden["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(
            QuotaResumeStore::open(dir.path(), mixdog_rt::testing::tokens().durability_io, mixdog_rt::CancellationToken::new()).await.unwrap(),
        );
        for entry in case["entries"].as_array().unwrap() {
            let mut request = entry.clone();
            request["resetAt"] = json!(now + entry["resetIn"].as_f64().unwrap());
            store.schedule(&request).await.unwrap();
        }
        let clock = Arc::new(ManualClock::new(now));
        let host = Arc::new(Host { spec: case.clone(), calls: Mutex::default() });
        let log: Arc<Mutex<Vec<String>>> = Arc::default();
        let sink = log.clone();
        let auto = case["autoResume"].as_bool().unwrap_or(true);
        let scheduler = QuotaResumeScheduler::new(
            store.clone(),
            host.clone(),
            clock.clone(),
            Arc::new(move || auto),
            Arc::new(move |line: &str| sink.lock().unwrap().push(line.to_owned())),
        );
        let scheduled: Vec<Value> = store
            .list()
            .iter()
            .map(|e| {
                let mut value = e.to_value();
                value["resetAt"] = json_number(e.reset_at.as_f64().unwrap() - now);
                value
            })
            .collect();
        let want: Vec<Value> = case["scheduled"].as_array().unwrap().clone();
        assert_eq!(scheduled.len(), want.len(), "{name}: scheduled");
        for (got, want) in scheduled.iter().zip(&want) {
            for key in ["sessionId", "generation", "resetAt", "attempts"] {
                assert_eq!(got[key], want[key], "{name}: scheduled {key}");
            }
        }
        assert_eq!(scheduler.armed_ms().map(|ms| json!(ms)).unwrap_or(Value::Null), case["armed"], "{name}: armed");
        for (i, step) in case["steps"].as_array().unwrap().iter().enumerate() {
            clock.advance(step["advance"].as_f64().unwrap());
            log.lock().unwrap().clear();
            {
                let mut calls = host.calls.lock().unwrap();
                calls.usable.clear();
                calls.fire.clear();
            }
            let armed = scheduler.tick().await;
            let at = format!("{name} step {i}");
            assert_eq!(json!(*log.lock().unwrap()), step["log"], "{at}: log");
            assert_eq!(Value::Array(host.calls.lock().unwrap().usable.clone()), step["usable"], "{at}: usable");
            assert_eq!(Value::Array(host.calls.lock().unwrap().fire.clone()), step["fire"], "{at}: fire");
            assert_eq!(queue(&store, now, 0), step["queue"], "{at}: queue");
            assert_eq!(armed.map(|ms| json!(ms)).unwrap_or(Value::Null), step["armed"], "{at}: armed");
        }
    }
}
#[tokio::test]
async fn the_timer_matches_node() {
    let golden = golden();
    let now = golden["now"].as_f64().unwrap();
    for case in golden["timerCases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let base = case["base"].as_u64().unwrap();
        let dir = tempfile::tempdir().unwrap();
        // The store file is the one Node's real store wrote for these entries.
        put_store_file(dir.path(), case["storeFile"].as_str().unwrap()).await;
        let clock = Arc::new(ManualClock::new(now));
        let host = Arc::new(Host { spec: case.clone(), calls: Mutex::default() });
        let log: Arc<Mutex<Vec<String>>> = Arc::default();
        let mut store = open_store(dir.path()).await;
        let mut scheduler = scheduler_over(&store, host.clone(), &clock, &log);
        scheduler.start();
        for (i, step) in case["steps"].as_array().unwrap().iter().enumerate() {
            let at = format!("{name} step {i}");
            let armed = step["armed"].as_u64();
            if step.get("restart").is_some() {
                scheduler.stop().await;
                store = open_store(dir.path()).await;
                scheduler = scheduler_over(&store, host.clone(), &clock, &log);
                scheduler.start();
                wait_until!(&[&clock.changed], clock.armed() == armed).await;
                assert_eq!(queue(&store, now, base), step["queue"], "{at}: the pending resumes survive");
                continue;
            }
            let wait = step["wait"].as_u64();
            wait_until!(&[&clock.changed], clock.armed() == wait).await;
            log.lock().unwrap().clear();
            {
                let mut calls = host.calls.lock().unwrap();
                calls.usable.clear();
                calls.fire.clear();
            }
            clock.advance(step["advance"].as_f64().unwrap());
            let want_log = step["log"].as_array().unwrap().iter().map(|l| l.as_str().unwrap().to_owned()).collect::<Vec<_>>();
            wait_until!(&[&clock.changed], *log.lock().unwrap() == want_log && clock.armed() == armed).await;
            assert_eq!(Value::Array(host.calls.lock().unwrap().usable.clone()), step["usable"], "{at}: usable");
            let fired: Vec<Value> = host.calls.lock().unwrap().fire.iter().map(|f| json!({ "sessionId": f["sessionId"], "generation": f["generation"].as_u64().unwrap() - base })).collect();
            assert_eq!(Value::Array(fired), step["fire"], "{at}: fire");
            assert_eq!(queue(&store, now, base), step["queue"], "{at}: queue");
        }
        scheduler.stop().await;
    }
}

#[tokio::test(start_paused = true)]
async fn overlapping_ticks_fire_once() {
    let golden = golden();
    let want = &golden["coalesce"];
    let now = golden["now"].as_f64().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path()).await;
    schedule(&store, "s1", now).await;
    let host = GateHost::new();
    let clock = Arc::new(ManualClock::new(now));
    let scheduler = scheduler_over(&store, host.clone(), &clock, &Arc::default());
    let mut first = tokio::spawn({
        let scheduler = scheduler.clone();
        async move { scheduler.tick().await }
    });
    crate::eventually_on_until!(&[&host.fired], || (host.fires.lock().unwrap().len() == 1).then_some(()), &mut first).await;
    let mut second = tokio::spawn({
        let scheduler = scheduler.clone();
        async move { scheduler.tick().await }
    });
    crate::session::testing::awaiting("the second tick to find the pass in flight and wait for it", async {
        tokio::select! {
            biased;
            () = scheduler.joined() => {}
            ended = &mut second => panic!("the second tick ended instead of waiting for the pass in flight: {ended:?}"),
        }
    })
    .await;
    assert!(!second.is_finished(), "the second tick waits for the pass in flight");
    assert_eq!(host.fires.lock().unwrap().len() as u64, want["firesWhileHeld"].as_u64().unwrap());
    host.gate.add_permits(1);
    first.await.unwrap();
    second.await.unwrap();
    let fires: Vec<u64> = host.fires.lock().unwrap().iter().map(|(_, generation)| *generation).collect();
    assert_eq!(json!(fires), want["fires"], "one fire for the generation");
    assert_eq!(store.list().len() as u64, want["queue"].as_u64().unwrap());
}

#[tokio::test(start_paused = true)]
async fn nothing_fires_after_stop() {
    let now = golden()["now"].as_f64().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path()).await;
    schedule(&store, "s1", now + 5000.0).await;
    let host = GateHost::new();
    host.gate.add_permits(10);
    let clock = Arc::new(ManualClock::new(now));
    let scheduler = scheduler_over(&store, host.clone(), &clock, &Arc::default());
    scheduler.start();
    wait_until!(&[&clock.changed], clock.armed() == Some(5000)).await;
    scheduler.stop().await;
    assert_eq!(clock.armed(), None, "the timer is gone once stop returns");
    clock.advance(5000.0);
    assert_eq!(scheduler.tick().await, None, "a tick after stop runs nothing");
    scheduler.start();
    assert_eq!(clock.armed(), None, "a stopped clock stays stopped");
    assert!(host.fires.lock().unwrap().is_empty(), "nothing fired after stop");
    assert_eq!(store.list().len(), 1, "the resume is still pending");
}

/// `s1`'s fire never answers; every other session's fires at once.
struct HungFireHost {
    fires: Mutex<Vec<String>>,
}

#[async_trait]
impl ResumeHost for HungFireHost {
    async fn materialize(&self, _session_id: &str) -> Result<(), String> {
        Ok(())
    }
    async fn route(&self, _session_id: &str) -> SessionRoute {
        SessionRoute { provider: "openai-oauth".to_owned(), model: "gpt-x".to_owned() }
    }
    async fn usable(&self, _provider: &str, _model: &str) -> Result<bool, UsageError> {
        Ok(true)
    }
    async fn fire(&self, session_id: &str, _generation: u64) -> Result<FireOutcome, String> {
        self.fires.lock().unwrap().push(session_id.to_owned());
        if session_id == "s1" {
            std::future::pending().await
        }
        Ok(FireOutcome::Fired)
    }
}

#[tokio::test(start_paused = true)]
async fn a_hung_host_call_fails_its_entry_and_the_pass_goes_on() {
    let now = golden()["now"].as_f64().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path()).await;
    schedule(&store, "s1", now).await;
    schedule(&store, "s2", now).await;
    let host = Arc::new(HungFireHost { fires: Mutex::default() });
    let clock = Arc::new(ManualClock::new(now));
    let log: Arc<Mutex<Vec<String>>> = Arc::default();
    let scheduler = scheduler_over(&store, host.clone(), &clock, &log);
    // Nothing moves but the paused tokio clock, which jumps to the host-call bound while s1 hangs.
    scheduler.tick().await;
    assert_eq!(*host.fires.lock().unwrap(), ["s1", "s2"], "the entry behind the hung one still ran");
    assert!(log.lock().unwrap().iter().any(|line| line == "quota resume failed session=s1: fire timed out"), "{:?}", log.lock().unwrap());
    assert_eq!(store.list().iter().map(|e| e.session_id.as_str()).collect::<Vec<_>>(), ["s1"], "the hung entry waits, deferred");
}

/// A host that keeps the contract `runtime.fireQuotaResume({ generation })` has: a generation
/// takes effect once, whoever asks again is answered `Stale`. The first fire never answers.
struct OnceHost {
    effective: Mutex<Vec<(String, u64)>>,
    asked: Mutex<Vec<(String, u64)>>,
    answered: Notify,
}

#[async_trait]
impl ResumeHost for OnceHost {
    async fn materialize(&self, _session_id: &str) -> Result<(), String> {
        Ok(())
    }
    async fn route(&self, _session_id: &str) -> SessionRoute {
        SessionRoute { provider: "openai-oauth".to_owned(), model: "gpt-x".to_owned() }
    }
    async fn usable(&self, _provider: &str, _model: &str) -> Result<bool, UsageError> {
        Ok(true)
    }
    async fn fire(&self, session_id: &str, generation: u64) -> Result<FireOutcome, String> {
        let key = (session_id.to_owned(), generation);
        self.asked.lock().unwrap().push(key.clone());
        self.answered.notify_waiters();
        if self.effective.lock().unwrap().contains(&key) {
            return Ok(FireOutcome::Stale);
        }
        self.effective.lock().unwrap().push(key);
        if self.asked.lock().unwrap().len() == 1 {
            std::future::pending().await
        }
        Ok(FireOutcome::Fired)
    }
}

#[tokio::test]
async fn a_fire_abandoned_at_stop_is_asked_again_under_the_same_generation_and_takes_effect_once() {
    let now = golden()["now"].as_f64().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path()).await;
    schedule(&store, "s1", now).await;
    let host = Arc::new(OnceHost { effective: Mutex::default(), asked: Mutex::default(), answered: Notify::new() });
    let clock = Arc::new(ManualClock::new(now));
    let first = scheduler_over(&store, host.clone(), &clock, &Arc::default());
    first.start();
    wait_until!(&[&clock.changed], clock.armed() == Some(0)).await;
    clock.advance(0.0);
    wait_until!(&[&host.answered], host.asked.lock().unwrap().len() == 1).await;
    first.stop().await;
    assert_eq!(store.list().len(), 1, "the abandoned fire's entry stays queued");
    // Nothing of the stopped scheduler fires again.
    assert_eq!(first.tick().await, None);
    assert_eq!(host.asked.lock().unwrap().len(), 1);

    // A restart over the same queue asks again with the generation it kept.
    let second = scheduler_over(&store, host.clone(), &clock, &Arc::default());
    second.tick().await;
    let asked = host.asked.lock().unwrap().clone();
    assert_eq!(asked.len(), 2);
    assert_eq!(asked[0], asked[1], "the same session and generation");
    assert_eq!(host.effective.lock().unwrap().len(), 1, "it took effect once");
    assert!(store.list().is_empty(), "the Stale answer settles the entry");
}

#[tokio::test]
async fn stop_releases_a_fire_in_flight_and_starts_no_further_entry() {
    let now = golden()["now"].as_f64().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path()).await;
    schedule(&store, "s1", now).await;
    schedule(&store, "s2", now).await;
    let host = GateHost::new();
    let clock = Arc::new(ManualClock::new(now));
    let scheduler = scheduler_over(&store, host.clone(), &clock, &Arc::default());
    scheduler.start();
    wait_until!(&[&clock.changed], clock.armed() == Some(0)).await;
    clock.advance(0.0);
    wait_until!(&[&host.fired], host.fires.lock().unwrap().len() == 1).await;
    // The gate stays shut: the fire answers nothing, and stop still returns.
    scheduler.stop().await;
    let fired: Vec<String> = host.fires.lock().unwrap().iter().map(|(id, _)| id.clone()).collect();
    assert_eq!(fired, ["s1"], "the second entry never started");
    assert_eq!(
        store.list().iter().map(|e| e.session_id.as_str()).collect::<Vec<_>>(),
        ["s1", "s2"],
        "the abandoned fire's entry stays queued, for its generation to be tried again"
    );
}

/// The file the 1.4.5 app left in a real data directory (`migration-corpus/v145/quota-resume.json`):
/// nothing pending, the generation counter at 31.
#[tokio::test]
async fn a_store_file_written_by_1_4_5_is_read() {
    let dir = tempfile::tempdir().unwrap();
    put_store_file(dir.path(), include_str!("../../../../fixtures/quota-scheduler/v145-quota-resume.json")).await;
    let store = open_store(dir.path()).await;
    assert!(store.list().is_empty());
    let clock = Arc::new(ManualClock::new(1_000_000.0));
    let scheduler = scheduler_over(&store, GateHost::new(), &clock, &Arc::default());
    assert_eq!(scheduler.armed_ms(), None, "nothing queued, no timer");
    schedule(&store, "s1", 1_005_000.0).await;
    assert_eq!(store.entry("s1").unwrap().generation, 32, "the counter continues from the file");
    assert_eq!(scheduler.armed_ms(), Some(5000));
}
