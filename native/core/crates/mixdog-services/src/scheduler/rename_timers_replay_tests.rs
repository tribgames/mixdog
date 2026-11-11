//! Replay of `native/core/fixtures/schedule-rename-timers-cases` (`record-schedule-rename-timers-cases.mjs`, Node
//! b6f10295a): what the scheduler fires next, and when, after each outcome of a rename (the new name taken, a run of the
//! schedule in flight, the row moved and the reload failing, the rename applied and its answer lost). The core's scheduler
//! runs as the channel runtime runs it (`channels/runtime.rs` `rename_schedule`: `rename_locked` with the store's rename and
//! a reload that re-arms the stored rows), on tokio's paused clock, moved only to the instants the recording lists. The row
//! store is the in-memory one, as the recorder's was an in-memory table: a store whose calls cross a lane would let the
//! paused clock run ahead while a fire waits for it.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration as StdDuration;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use mixdog_testkit::Exact;
use serde_json::{Value, json};
use tokio::sync::Notify;

use super::*;
use crate::channels::running::RunningWork;

const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/schedule-rename-timers-cases/golden.json");
/// How long (on the paused clock) a run the recording made may take to reach the runner.
const DEADLINE: StdDuration = StdDuration::from_secs(10);

fn at(text: &str) -> DateTime<Utc> {
    text.parse().unwrap_or_else(|_| panic!("an instant: {text}"))
}

fn iso(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// The recording's clock: the start instant plus the time tokio's paused clock has moved since.
struct PausedClock {
    base: DateTime<Utc>,
    start: tokio::time::Instant,
}

impl Clock for PausedClock {
    fn now(&self) -> DateTime<Utc> {
        self.base + chrono::Duration::from_std(self.start.elapsed()).unwrap()
    }
}

impl PausedClock {
    /// Moves the paused clock to `instant` (every timer due on the way fires at its own instant).
    async fn advance_to(&self, instant: &str) {
        let wait = (at(instant) - self.now()).to_std().unwrap_or_default();
        tokio::time::sleep(wait).await;
    }
}

/// The recorder's runner: each run with the clock's instant; with `hold`, a run waits until the hold is released
/// (the recorder's one promise: once released, no run waits).
struct Runs {
    clock: Arc<PausedClock>,
    runs: Mutex<Vec<Value>>,
    /// Notified when a run starts and when one ends.
    moved: Notify,
    count: AtomicUsize,
    ended: AtomicUsize,
    hold: Option<tokio::sync::watch::Receiver<bool>>,
}

#[async_trait]
impl ScheduleRunner for Runs {
    async fn run(&self, schedule: &Schedule, _prompt: &str) -> Result<RunOutcome, String> {
        self.runs.lock().unwrap().push(json!({"name": schedule.name, "at": iso(self.clock.now())}));
        self.count.fetch_add(1, Ordering::SeqCst);
        self.moved.notify_one();
        if let Some(hold) = &self.hold {
            hold.clone().wait_for(|released| *released).await.expect("the hold is kept until released");
        }
        self.ended.fetch_add(1, Ordering::SeqCst);
        self.moved.notify_one();
        Ok(RunOutcome::Done)
    }
}

impl Runs {
    async fn until(&self, counter: &AtomicUsize, n: usize, what: &str) {
        let waited = tokio::time::timeout(DEADLINE, async {
            loop {
                let moved = self.moved.notified();
                tokio::pin!(moved);
                moved.as_mut().enable();
                if counter.load(Ordering::SeqCst) >= n {
                    return;
                }
                moved.await;
            }
        });
        waited.await.unwrap_or_else(|_| panic!("timed out after {DEADLINE:?} awaiting {what}"));
    }

    /// Waits until `n` runs have started.
    async fn reached(&self, n: usize, what: &str) {
        self.until(&self.count, n, what).await;
    }

    /// Waits until `n` runs have ended. The store answers at once, so a fire's stamps are written in the same poll that
    /// returns from its run, before this task is polled again.
    async fn finished(&self, n: usize, what: &str) {
        self.until(&self.ended, n, what).await;
    }
}

fn rows(value: &Value) -> Vec<Schedule> {
    serde_json::from_value(value.clone()).expect("recorded schedule rows")
}

fn error_of(error: &ScheduleError) -> Value {
    let (code, name) = error.code_fields().expect("a coded refusal");
    json!({"code": code, "message": error.to_string(), "details": name.map(|name| json!({"name": name}))})
}

fn status(sched: &Scheduler) -> Value {
    serde_json::to_value(sched.status()).unwrap()
}

/// One recorded case driven on the core: the observation in the recording's shape.
async fn replay(recorded: &Value) -> Value {
    let outcome = recorded["outcome"].as_str().unwrap();
    let clock = Arc::new(PausedClock { base: at(recorded["start"].as_str().unwrap()), start: tokio::time::Instant::now() });
    let (release, held) = tokio::sync::watch::channel(false);
    let runner = Arc::new(Runs {
        clock: clock.clone(),
        runs: Mutex::new(Vec::new()),
        moved: Notify::new(),
        count: AtomicUsize::new(0),
        ended: AtomicUsize::new(0),
        hold: (outcome == "running").then_some(held),
    });
    let store = Arc::new(MemoryScheduleStore::with(rows(&recorded["stored"])));
    let sched = Scheduler::new(store.clone(), runner.clone(), clock.clone(), RunningWork::new(), Tz::UTC, rows(&recorded["loaded"]));
    let renamed: Schedule = serde_json::from_value(recorded["renamedTo"].clone()).unwrap();
    let steps = recorded["steps"].as_array().unwrap();
    sched.start();
    let mut replayed = Vec::new();
    let mut at_steps = steps.iter().peekable();
    // Before the rename: the run held in flight (the running case).
    if let Some(step) = at_steps.next_if(|step| step.get("advanceTo").is_some() && outcome == "running") {
        clock.advance_to(step["advanceTo"].as_str().unwrap()).await;
        runner.reached(1, &format!("{outcome}: the one-shot to start its run")).await;
        replayed.push(step.clone());
    }
    let rename_advances: Vec<String> = at_steps
        .next_if(|step| step.get("renameAdvancesTo").is_some())
        .map(|step| {
            replayed.push(step.clone());
            step["renameAdvancesTo"].as_array().unwrap().iter().map(|t| t.as_str().unwrap().to_owned()).collect()
        })
        .unwrap_or_default();
    let rename_ran = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let refused = sched
        .rename_locked(
            "other",
            &renamed.name,
            || {
                let (clock, store, renamed, ran) = (clock.clone(), store.clone(), renamed.clone(), rename_ran.clone());
                async move {
                    ran.store(true, Ordering::SeqCst);
                    for instant in &rename_advances {
                        clock.advance_to(instant).await;
                    }
                    ScheduleRecords::rename(&*store, "other", &renamed, false).await
                }
            },
            || {
                let (sched, store) = (sched.clone(), store.clone());
                async move {
                    if outcome == "reloadFailed" {
                        return Err("timeout".to_owned());
                    }
                    sched.reload_config(store.list().await.map_err(|e| e.to_string())?, true);
                    Ok(())
                }
            },
        )
        .await;
    let refused = json!({
        "at": iso(clock.now()),
        "error": refused.err().map_or(Value::Null, |error| error_of(&error)),
        "renameRan": rename_ran.load(Ordering::SeqCst),
        "status": status(&sched),
    });
    if runner.hold.is_some() {
        release.send_replace(true);
        runner.finished(1, &format!("{outcome}: the held run to finish")).await;
    }
    let mut seen = runner.count.load(Ordering::SeqCst);
    for step in at_steps {
        if let Some(instant) = step.get("advanceTo").and_then(Value::as_str) {
            clock.advance_to(instant).await;
            replayed.push(step.clone());
        } else if step.get("ranBy").is_some() {
            let want = seen + step["runs"].as_array().unwrap().len();
            let so_far = Value::Array(runner.runs.lock().unwrap().clone());
            runner.finished(want, &format!("{outcome}: the runs due by {} (runs before: {so_far})", step["ranBy"])).await;
            let runs = runner.runs.lock().unwrap()[seen..].to_vec();
            seen = runner.runs.lock().unwrap().len();
            replayed.push(json!({"ranBy": step["ranBy"], "runs": runs}));
        } else {
            panic!("a step the replay does not know: {step}");
        }
    }
    let observed = json!({
        "outcome": outcome,
        "start": recorded["start"],
        "loaded": recorded["loaded"],
        "stored": recorded["stored"],
        "renamedTo": recorded["renamedTo"],
        "steps": replayed,
        "refused": refused,
        "runs": *runner.runs.lock().unwrap(),
        "statusAtEnd": status(&sched),
    });
    sched.stop();
    observed
}

#[tokio::test(start_paused = true)]
async fn after_each_rename_outcome_the_scheduler_fires_what_node_fires_when_node_fires_it() {
    let golden = Exact::decode(&serde_json::from_str::<Value>(&GOLDEN).unwrap()).unwrap();
    let cases = golden.get("cases").as_array();
    assert_eq!(cases.len(), 4);
    let mut differing = Vec::new();
    for case in cases {
        let recorded = case.get("observed").to_plain().unwrap();
        let observed = replay(&recorded).await;
        if observed != recorded {
            differing.push(format!("{}:\n  node: {recorded}\n  core: {observed}", case.get("case").as_str()));
        }
    }
    assert!(differing.is_empty(), "{}", differing.join("\n"));
}
