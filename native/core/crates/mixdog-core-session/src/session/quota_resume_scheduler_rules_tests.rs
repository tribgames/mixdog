//! The quota-resume scheduler: when its one timer is armed, what each tick fires, retries and cancels, and how overlapping ticks,
//! a stop and a restart leave the queue. The clock is one the test moves.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_core_base::quota_resume::QuotaResumeStore;
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

fn scheduler_over(
    store: &Arc<QuotaResumeStore>,
    host: Arc<dyn ResumeHost>,
    clock: &Arc<ManualClock>,
    log: &Arc<Mutex<Vec<String>>>,
) -> Arc<QuotaResumeScheduler> {
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
        let routes =
            self.spec.get("routes").and_then(Value::as_array).cloned().unwrap_or_else(|| vec![json!({ "provider": "openai-oauth", "model": "gpt-x" })]);
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

#[tokio::test(start_paused = true)]
async fn overlapping_ticks_fire_once() {
    let now = NOW;
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
    crate::session::testing::awaiting(|| "the second tick to find the pass in flight and wait for it".to_owned(), async {
        tokio::select! {
            biased;
            () = scheduler.joined() => {}
            ended = &mut second => panic!("the second tick ended instead of waiting for the pass in flight: {ended:?}"),
        }
    })
    .await;
    assert!(!second.is_finished(), "the second tick waits for the pass in flight");
    assert_eq!(host.fires.lock().unwrap().len() as u64, 1);
    host.gate.add_permits(1);
    first.await.unwrap();
    second.await.unwrap();
    let fires: Vec<u64> = host.fires.lock().unwrap().iter().map(|(_, generation)| *generation).collect();
    assert_eq!(fires, [1], "one fire for the generation");
    assert_eq!(store.list().len(), 0);
}

#[tokio::test(start_paused = true)]
async fn nothing_fires_after_stop() {
    let now = NOW;
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
    let now = NOW;
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
    let now = NOW;
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
    let now = NOW;
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

const NOW: f64 = 1_000_000.0;

type QueueRow = (&'static str, u64, f64, u64);

struct Step {
    advance: f64,
    log: &'static [&'static str],
    queue: &'static [QueueRow],
    armed: Option<u64>,
}

struct Case {
    name: &'static str,
    /// What the scripted host answers: `usable`, `fire`, `materialize`, `routes`, and `autoResume` for the setting.
    spec: &'static str,
    entries: &'static [(&'static str, f64)],
    armed: Option<u64>,
    steps: &'static [Step],
}

const FIRED: &str = "quota resume session=s1 outcome=fired";

const CASES: &[Case] = &[
    Case { name: "an empty queue arms no timer", spec: "{}", entries: &[], armed: None, steps: &[] },
    Case {
        name: "a future entry waits for its reset and then fires",
        spec: "{}",
        entries: &[("s1", 5000.0)],
        armed: Some(5000),
        steps: &[
            Step { advance: 0.0, log: &[], queue: &[("s1", 1, 5000.0, 0)], armed: Some(5000) },
            Step { advance: 5000.0, log: &[FIRED], queue: &[], armed: None },
        ],
    },
    Case {
        name: "a timer is capped at the largest delay a timer takes",
        spec: "{}",
        entries: &[("s1", 3_000_000_000.0)],
        armed: Some(2_147_483_647),
        steps: &[],
    },
    Case {
        name: "an overdue entry fires at once",
        spec: "{}",
        entries: &[("s1", -10.0)],
        armed: Some(0),
        steps: &[Step { advance: 0.0, log: &[FIRED], queue: &[], armed: None }],
    },
    Case {
        name: "the timer is armed for the earliest of two entries and then for the next",
        spec: "{}",
        entries: &[("s1", 9000.0), ("s2", 4000.0)],
        armed: Some(4000),
        steps: &[
            Step { advance: 4000.0, log: &["quota resume session=s2 outcome=fired"], queue: &[("s1", 1, 9000.0, 0)], armed: Some(5000) },
            Step { advance: 5000.0, log: &[FIRED], queue: &[], armed: None },
        ],
    },
    Case {
        name: "a model with no usage left is retried once after five minutes and then given up",
        spec: r#"{"usable":false}"#,
        entries: &[("s1", 0.0)],
        armed: Some(0),
        steps: &[
            Step { advance: 0.0, log: &["quota resume session=s1 outcome=exhausted-retry"], queue: &[("s1", 1, 300_000.0, 1)], armed: Some(300_000) },
            Step { advance: 300_000.0, log: &["quota resume session=s1 outcome=exhausted"], queue: &[], armed: None },
        ],
    },
    Case {
        name: "a session that is busy is looked at again in thirty seconds without using an attempt",
        spec: r#"{"fire":"busy"}"#,
        entries: &[("s1", 0.0)],
        armed: Some(0),
        steps: &[
            Step { advance: 0.0, log: &["quota resume session=s1 outcome=busy"], queue: &[("s1", 1, 30_000.0, 0)], armed: Some(30_000) },
            Step { advance: 30_000.0, log: &["quota resume session=s1 outcome=busy"], queue: &[("s1", 1, 60_000.0, 0)], armed: Some(30_000) },
        ],
    },
    Case {
        name: "a rejected resume is looked at again in thirty seconds",
        spec: r#"{"fire":"rejected"}"#,
        entries: &[("s1", 0.0)],
        armed: Some(0),
        steps: &[Step { advance: 0.0, log: &["quota resume session=s1 outcome=rejected"], queue: &[("s1", 1, 30_000.0, 0)], armed: Some(30_000) }],
    },
    Case {
        name: "a stale generation settles its entry",
        spec: r#"{"fire":"stale"}"#,
        entries: &[("s1", 0.0)],
        armed: Some(0),
        steps: &[Step { advance: 0.0, log: &["quota resume session=s1 outcome=stale"], queue: &[], armed: None }],
    },
    Case {
        name: "a superseded resume settles its entry",
        spec: r#"{"fire":"superseded"}"#,
        entries: &[("s1", 0.0)],
        armed: Some(0),
        steps: &[Step { advance: 0.0, log: &["quota resume session=s1 outcome=superseded"], queue: &[], armed: None }],
    },
    Case {
        name: "a turn that cannot be replayed settles its entry",
        spec: r#"{"fire":"unreplayable"}"#,
        entries: &[("s1", 0.0)],
        armed: Some(0),
        steps: &[Step { advance: 0.0, log: &["quota resume session=s1 outcome=unreplayable"], queue: &[], armed: None }],
    },
    Case {
        name: "a fire that throws is logged and tried again in five minutes",
        spec: r#"{"fire":{"fail":"lane gone"}}"#,
        entries: &[("s1", 0.0)],
        armed: Some(0),
        steps: &[Step { advance: 0.0, log: &["quota resume failed session=s1: lane gone"], queue: &[("s1", 1, 300_000.0, 0)], armed: Some(300_000) }],
    },
    Case {
        name: "a session that cannot be loaded is dropped as unavailable",
        spec: r#"{"materialize":"no such session"}"#,
        entries: &[("s1", 0.0)],
        armed: Some(0),
        steps: &[Step {
            advance: 0.0,
            log: &["quota resume could not load session=s1: no such session", "quota resume session=s1 outcome=unavailable"],
            queue: &[],
            armed: None,
        }],
    },
    Case {
        name: "a usage reading that fails counts as no usage left",
        spec: r#"{"usable":{"fail":"timeout"}}"#,
        entries: &[("s1", 0.0)],
        armed: Some(0),
        steps: &[Step {
            advance: 0.0,
            log: &["quota resume usage reading failed provider=openai-oauth: timeout", "quota resume session=s1 outcome=exhausted-retry"],
            queue: &[("s1", 1, 300_000.0, 1)],
            armed: Some(300_000),
        }],
    },
    Case {
        name: "an unreachable usage proxy fails the fire without using an attempt",
        spec: r#"{"usable":{"proxy":"pc offline"}}"#,
        entries: &[("s1", 0.0)],
        armed: Some(0),
        steps: &[Step { advance: 0.0, log: &["quota resume failed session=s1: pc offline"], queue: &[("s1", 1, 300_000.0, 0)], armed: Some(300_000) }],
    },
    Case {
        name: "a route that changes while the session is read is looked at again in thirty seconds",
        spec: r#"{"routes":[{"provider":"openai-oauth","model":"gpt-x"},{"provider":"anthropic","model":"claude-y"}]}"#,
        entries: &[("s1", 0.0)],
        armed: Some(0),
        steps: &[Step { advance: 0.0, log: &["quota resume session=s1 outcome=route-changed"], queue: &[("s1", 1, 30_000.0, 0)], armed: Some(30_000) }],
    },
    Case {
        name: "a session whose route is unknown uses the entry's route",
        spec: r#"{"routes":[{"provider":"","model":""}]}"#,
        entries: &[("s1", 0.0)],
        armed: Some(0),
        steps: &[Step { advance: 0.0, log: &[FIRED], queue: &[], armed: None }],
    },
    Case {
        name: "turning the setting off cancels every pending resume",
        spec: r#"{"autoResume":false}"#,
        entries: &[("s1", 0.0), ("s2", 100.0)],
        armed: Some(0),
        steps: &[Step { advance: 0.0, log: &["quota resume off: pending resumes cancelled"], queue: &[], armed: None }],
    },
    Case {
        name: "two entries due in one pass fire in order under their generations",
        spec: r#"{}"#,
        entries: &[("s1", 0.0), ("s2", 0.0)],
        armed: Some(0),
        steps: &[Step { advance: 0.0, log: &[FIRED, "quota resume session=s2 outcome=fired"], queue: &[], armed: None }],
    },
];

#[tokio::test]
async fn the_clock_arms_one_timer_and_each_tick_settles_entries_by_the_rules() {
    for case in CASES {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(dir.path()).await;
        for (id, reset_in) in case.entries {
            schedule(&store, id, NOW + reset_in).await;
        }
        let clock = Arc::new(ManualClock::new(NOW));
        let spec: Value = serde_json::from_str(case.spec).unwrap();
        let auto = spec["autoResume"].as_bool().unwrap_or(true);
        let host = Arc::new(Host { spec, calls: Mutex::default() });
        let log: Arc<Mutex<Vec<String>>> = Arc::default();
        let sink = log.clone();
        let scheduler = QuotaResumeScheduler::new(
            store.clone(),
            host.clone(),
            clock.clone(),
            Arc::new(move || auto),
            Arc::new(move |line: &str| sink.lock().unwrap().push(line.to_owned())),
        );
        assert_eq!(scheduler.armed_ms(), case.armed, "{}: armed", case.name);
        for (i, step) in case.steps.iter().enumerate() {
            clock.advance(step.advance);
            log.lock().unwrap().clear();
            let armed = scheduler.tick().await;
            let at = format!("{} step {i}", case.name);
            assert_eq!(*log.lock().unwrap(), step.log, "{at}: log");
            let queued: Vec<Value> = step.queue.iter().map(|(id, generation, reset_in, attempts)| json!({ "sessionId": id, "generation": generation, "resetAt": json_number(*reset_in), "attempts": attempts })).collect();
            assert_eq!(queue(&store, NOW, 0), Value::Array(queued), "{at}: queue");
            assert_eq!(armed, step.armed, "{at}: armed");
        }
    }
}
