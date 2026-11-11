use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};
use chrono_tz::Tz;
use tokio::sync::Notify;

use super::*;
use crate::channels::running::RunningWork;

fn at(s: &str) -> DateTime<Utc> {
    s.parse().unwrap()
}

struct FixedClock(Mutex<DateTime<Utc>>);
impl Clock for FixedClock {
    fn now(&self) -> DateTime<Utc> {
        *self.0.lock().unwrap()
    }
}

/// Time that follows tokio's (pausable) clock.
struct TokioClock {
    base: DateTime<Utc>,
    start: tokio::time::Instant,
}
impl Clock for TokioClock {
    fn now(&self) -> DateTime<Utc> {
        self.base + Duration::from_std(self.start.elapsed()).unwrap()
    }
}

#[derive(Default)]
struct Script {
    runs: AtomicUsize,
    fail: Mutex<bool>,
    gate: Option<Arc<Notify>>,
    started: Notify,
    /// The schedules run, in order.
    names: Mutex<Vec<String>>,
}

#[async_trait]
impl ScheduleRunner for Script {
    async fn run(&self, s: &Schedule, _prompt: &str) -> Result<RunOutcome, String> {
        self.runs.fetch_add(1, Ordering::SeqCst);
        self.names.lock().unwrap().push(s.name.clone());
        self.started.notify_one();
        if let Some(gate) = &self.gate {
            gate.notified().await;
        }
        if *self.fail.lock().unwrap() { Err("boom".into()) } else { Ok(RunOutcome::Done) }
    }
}

fn cron_row(name: &str) -> Schedule {
    Schedule { name: name.into(), prompt: "do it".into(), when_cron: Some("0 9 * * *".into()), ..Default::default() }
}

fn one_shot_row(name: &str, when: &str) -> Schedule {
    Schedule { name: name.into(), prompt: "once".into(), when_at: Some(at(when)), ..Default::default() }
}

struct Fixture {
    sched: Scheduler,
    store: Arc<MemoryScheduleStore>,
    runner: Arc<Script>,
    work: RunningWork,
}

fn fixture(rows: Vec<Schedule>, runner: Script) -> Fixture {
    fixture_clock(rows, runner, Arc::new(FixedClock(Mutex::new(at("2025-01-01T09:00:00Z")))))
}

fn fixture_clock(rows: Vec<Schedule>, runner: Script, clock: Arc<dyn Clock>) -> Fixture {
    let store = Arc::new(MemoryScheduleStore::with(rows.clone()));
    let runner = Arc::new(runner);
    let work = RunningWork::new();
    let sched = Scheduler::new(store.clone(), runner.clone(), clock, work.clone(), Tz::UTC, rows);
    Fixture { sched, store, runner, work }
}

#[tokio::test]
async fn cron_slot_runs_once_and_stamps_success() {
    let f = fixture(vec![cron_row("daily")], Script::default());
    let slot = at("2025-01-01T09:00:00Z");
    f.sched.fire_cron_slot("daily", slot).await;
    f.sched.fire_cron_slot("daily", slot).await; // duplicate slot
    assert_eq!(f.runner.runs.load(Ordering::SeqCst), 1);
    let row = f.store.get("daily").await.unwrap().unwrap();
    assert_eq!(row.last_scheduled_at, Some(slot));
    assert!(row.last_success_at.is_some());
    assert_eq!(row.next_fire_at, Some(at("2025-01-02T09:00:00Z")));
    assert_eq!(f.sched.status()[0].running, false);
}

#[tokio::test]
async fn failures_count_and_pause_the_schedule_at_the_limit() {
    let f = fixture(vec![cron_row("daily")], Script::default());
    *f.runner.fail.lock().unwrap() = true;
    for day in 1..=5 {
        f.sched.fire_cron_slot("daily", at("2025-01-01T09:00:00Z") + Duration::days(day)).await;
    }
    let row = f.store.get("daily").await.unwrap().unwrap();
    assert_eq!(row.consecutive_failures, 5);
    assert!(!row.enabled);
    // A switched-off row admits no further slot.
    f.sched.fire_cron_slot("daily", at("2025-02-01T09:00:00Z")).await;
    assert_eq!(f.runner.runs.load(Ordering::SeqCst), 5);
}

#[tokio::test]
async fn overlapping_fire_is_a_skip_not_a_failure() {
    let gate = Arc::new(Notify::new());
    let f = fixture(vec![cron_row("daily")], Script { gate: Some(gate.clone()), ..Default::default() });
    let first = tokio::spawn({
        let s = f.sched.clone();
        async move { s.fire_cron_slot("daily", at("2025-01-01T09:00:00Z")).await }
    });
    f.runner.started.notified().await;
    assert!(f.sched.status()[0].running);
    f.sched.fire_cron_slot("daily", at("2025-01-02T09:00:00Z")).await;
    let row = f.store.get("daily").await.unwrap().unwrap();
    assert!(row.last_skipped_at.is_some());
    assert_eq!(row.consecutive_failures, 0);
    gate.notify_one();
    first.await.unwrap();
    assert_eq!(f.runner.runs.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn one_shot_fires_then_is_done_and_never_refires() {
    let f = fixture(vec![one_shot_row("once", "2025-01-01T08:00:00Z")], Script::default());
    f.sched.fire_one_shot("once").await;
    let row = f.store.get("once").await.unwrap().unwrap();
    assert_eq!(row.status, ScheduleStatus::Done);
    assert!(row.last_fired_at.is_some());
    f.sched.fire_one_shot("once").await;
    assert_eq!(f.runner.runs.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn failed_one_shot_stays_pending() {
    let f = fixture(vec![one_shot_row("once", "2025-01-01T08:00:00Z")], Script::default());
    *f.runner.fail.lock().unwrap() = true;
    f.sched.fire_one_shot("once").await;
    let row = f.store.get("once").await.unwrap().unwrap();
    assert_eq!(row.status, ScheduleStatus::Active);
    assert!(row.last_fired_at.is_none());
    assert_eq!(row.consecutive_failures, 1);
}

#[tokio::test]
async fn changed_row_is_not_fired_from_a_stale_armed_copy() {
    let f = fixture(vec![cron_row("daily")], Script::default());
    let mut edited = cron_row("daily");
    edited.when_cron = Some("0 10 * * *".into());
    f.store.replace(edited);
    f.sched.fire_cron_slot("daily", at("2025-01-01T09:00:00Z")).await;
    assert_eq!(f.runner.runs.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn deferred_schedule_skips_and_advances_the_cursor() {
    let f = fixture(vec![cron_row("daily")], Script::default());
    f.sched.defer("daily", 30.0).await.unwrap();
    assert!(f.sched.should_skip("daily"));
    f.sched.fire_cron_slot("daily", at("2025-01-01T09:00:00Z")).await;
    assert_eq!(f.runner.runs.load(Ordering::SeqCst), 0);
    let row = f.store.get("daily").await.unwrap().unwrap();
    assert_eq!(row.last_scheduled_at, Some(at("2025-01-01T09:00:00Z")));
    assert!(f.sched.defer("daily", 0.0).await.is_err());
}

#[tokio::test]
async fn rename_refused_while_running_and_reload_failure_drops_the_entry() {
    let gate = Arc::new(Notify::new());
    let f = fixture(vec![cron_row("daily")], Script { gate: Some(gate.clone()), ..Default::default() });
    let run = tokio::spawn({
        let s = f.sched.clone();
        async move { s.fire_cron_slot("daily", at("2025-01-01T09:00:00Z")).await }
    });
    f.runner.started.notified().await;
    let refused = f.sched.rename_locked("daily", "nightly", || async { Ok(Some(1)) }, || async { Ok(()) }).await;
    assert_eq!(refused, Err(ScheduleError::RenameRunning { name: "daily".into() }));
    gate.notify_one();
    run.await.unwrap();
    let failed = f
        .sched
        .rename_locked("daily", "nightly", || async { Ok(Some(1)) }, || async { Err("no pg".to_string()) })
        .await;
    assert!(matches!(failed, Err(ScheduleError::RenameReloadFailed { .. })));
    assert!(f.sched.find_schedule("daily").is_none());
    let ok = f.sched.rename_locked("gone", "went", || async { Ok(None::<u8>) }, || async { Ok(()) }).await;
    assert_eq!(ok, Ok(None));
}

/// What the timers do after each rename refusal, on the injected clock, as Node's `renameLocked`
/// (`scheduler.mjs:528-552`): `other` is a one-shot due at 08:00:10, `keep` a daily 09:00 cron; the
/// rename of `other` to `renamed` starts at 08:00:00 and is refused at 08:00:15.
/// - name taken: `other`'s timer fired during the rename and was refused (consumed); the refusal
///   re-arms the loaded schedules, so `other` fires at once (08:00:15), then `keep` at 09:00;
/// - running: refused before anything is reserved; nothing is re-armed, the running `other`
///   finishes, `keep` fires at 09:00;
/// - reload failed: the row moved to `renamed` and stays; the old entry is dropped (never fires),
///   the others are re-armed: `keep` fires at 09:00, nothing under either name.
#[tokio::test(start_paused = true)]
async fn after_each_rename_refusal_the_timers_are_nodes() {
    let rows = || vec![one_shot_row("other", "2025-01-01T08:00:10Z"), cron_row("keep")];
    let start = || -> Arc<dyn Clock> { Arc::new(TokioClock { base: at("2025-01-01T08:00:00Z"), start: tokio::time::Instant::now() }) };
    let renamed = || one_shot_row("renamed", "2025-01-01T08:00:10Z");
    let until = |t: &str| (at(t) - at("2025-01-01T08:00:00Z")).to_std().unwrap();
    async fn settle() {
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
    }

    // Name taken.
    let f = fixture_clock(rows(), Script::default(), start());
    f.store.replace(one_shot_row("renamed", "2025-02-01T08:00:00Z"));
    f.sched.start();
    let store = f.store.clone();
    let refused = f
        .sched
        .rename_locked(
            "other",
            "renamed",
            || async move {
                tokio::time::sleep(until("2025-01-01T08:00:15Z")).await;
                ScheduleRecords::rename(&*store, "other", &renamed(), false).await
            },
            || async { Ok(()) },
        )
        .await;
    assert_eq!(refused, Err(ScheduleError::NameTaken { name: "renamed".into() }));
    f.runner.started.notified().await;
    settle().await;
    let other = f.store.get("other").await.unwrap().unwrap();
    assert_eq!((other.status, other.last_fired_at), (ScheduleStatus::Done, Some(at("2025-01-01T08:00:15Z"))), "re-armed, fired at once");
    assert_eq!(f.sched.find_schedule("keep").unwrap().next_fire_at, Some(at("2025-01-01T09:00:00Z")));
    tokio::time::sleep(until("2025-01-01T09:00:01Z") - until("2025-01-01T08:00:15Z")).await;
    f.runner.started.notified().await;
    settle().await;
    assert_eq!(*f.runner.names.lock().unwrap(), ["other", "keep"]);
    assert_eq!(f.store.get("keep").await.unwrap().unwrap().last_scheduled_at, Some(at("2025-01-01T09:00:00Z")));
    f.sched.stop();

    // Running.
    let gate = Arc::new(Notify::new());
    let f = fixture_clock(rows(), Script { gate: Some(gate.clone()), ..Default::default() }, start());
    f.sched.start();
    tokio::time::sleep(until("2025-01-01T08:00:11Z")).await;
    f.runner.started.notified().await;
    let refused = f.sched.rename_locked("other", "renamed", || async { Ok(Some(1)) }, || async { Ok(()) }).await;
    assert_eq!(refused, Err(ScheduleError::RenameRunning { name: "other".into() }));
    assert_eq!(f.sched.find_schedule("keep").unwrap().next_fire_at, Some(at("2025-01-01T09:00:00Z")));
    gate.notify_one();
    settle().await;
    let other = f.store.get("other").await.unwrap().unwrap();
    assert_eq!((other.status, other.last_fired_at), (ScheduleStatus::Done, Some(at("2025-01-01T08:00:10Z"))), "the running fire finishes once");
    gate.notify_one();
    tokio::time::sleep(until("2025-01-01T09:00:01Z") - until("2025-01-01T08:00:11Z")).await;
    f.runner.started.notified().await;
    settle().await;
    assert_eq!(*f.runner.names.lock().unwrap(), ["other", "keep"]);
    f.sched.stop();

    // Reload failed.
    let f = fixture_clock(rows(), Script::default(), start());
    f.sched.start();
    let store = f.store.clone();
    let refused = f
        .sched
        .rename_locked(
            "other",
            "renamed",
            || async move {
                tokio::time::sleep(until("2025-01-01T08:00:15Z")).await;
                ScheduleRecords::rename(&*store, "other", &renamed(), false).await
            },
            || async { Err("timeout".to_string()) },
        )
        .await;
    assert_eq!(refused, Err(ScheduleError::RenameReloadFailed { name: "renamed".into(), cause: "timeout".into() }));
    assert!(f.sched.find_schedule("other").is_none() && f.sched.find_schedule("renamed").is_none(), "the old entry is dropped");
    assert!(f.store.get("other").await.unwrap().is_none());
    assert!(f.store.get("renamed").await.unwrap().is_some_and(|row| row.last_fired_at.is_none()), "the renamed row is kept, not fired");
    assert_eq!(f.sched.find_schedule("keep").unwrap().next_fire_at, Some(at("2025-01-01T09:00:00Z")));
    tokio::time::sleep(until("2025-01-01T09:00:01Z") - until("2025-01-01T08:00:15Z")).await;
    f.runner.started.notified().await;
    settle().await;
    assert_eq!(*f.runner.names.lock().unwrap(), ["keep"]);
    f.sched.stop();
}

#[tokio::test]
async fn armed_schedules_keep_the_core_alive_until_stopped() {
    let f = fixture(vec![cron_row("daily")], Script::default());
    assert!(f.work.is_idle());
    f.sched.start();
    assert_eq!(f.work.count(), 1);
    f.sched.start();
    assert_eq!(f.work.count(), 1);
    f.sched.stop();
    assert!(f.work.is_idle());
    let empty = fixture(vec![], Script::default());
    empty.sched.start();
    assert!(empty.work.is_idle());
}

#[tokio::test(start_paused = true)]
async fn armed_cron_fires_on_time() {
    let clock = Arc::new(TokioClock { base: at("2025-01-01T08:59:00Z"), start: tokio::time::Instant::now() });
    let f = fixture_clock(vec![cron_row("daily")], Script::default(), clock);
    f.sched.start();
    tokio::time::sleep(std::time::Duration::from_secs(61)).await;
    f.runner.started.notified().await;
    assert_eq!(f.runner.runs.load(Ordering::SeqCst), 1);
    f.sched.stop();
}

/// Tokio time plus a settable jump, like a suspend or a forward clock change.
struct JumpClock {
    base: DateTime<Utc>,
    start: tokio::time::Instant,
    jump: Mutex<Duration>,
}
impl Clock for JumpClock {
    fn now(&self) -> DateTime<Utc> {
        self.base + Duration::from_std(self.start.elapsed()).unwrap() + *self.jump.lock().unwrap()
    }
}

#[tokio::test(start_paused = true)]
async fn slots_missed_by_a_clock_jump_are_not_replayed() {
    let clock = Arc::new(JumpClock {
        base: at("2025-01-01T08:59:00Z"),
        start: tokio::time::Instant::now(),
        jump: Mutex::new(Duration::zero()),
    });
    let f = fixture_clock(vec![cron_row("daily")], Script::default(), clock.clone());
    f.sched.start();
    tokio::task::yield_now().await; // the job is now waiting for the 09:00 slot
    *clock.jump.lock().unwrap() = Duration::days(2) + Duration::minutes(30);
    tokio::time::sleep(std::time::Duration::from_secs(61)).await;
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
    // Three slots (Jan 1, 2, 3 at 09:00) elapsed unseen: none of them runs.
    assert_eq!(f.runner.runs.load(Ordering::SeqCst), 0);
    // The next slot is computed from now and fires once, on time.
    tokio::time::sleep(std::time::Duration::from_secs(24 * 3600)).await;
    f.runner.started.notified().await;
    assert_eq!(f.runner.runs.load(Ordering::SeqCst), 1);
    f.sched.stop();
}

#[tokio::test(start_paused = true)]
async fn armed_one_shot_fires_and_completes() {
    let clock = Arc::new(TokioClock { base: at("2025-01-01T08:00:00Z"), start: tokio::time::Instant::now() });
    let f = fixture_clock(vec![one_shot_row("once", "2025-01-01T08:00:10Z")], Script::default(), clock);
    f.sched.start();
    tokio::time::sleep(std::time::Duration::from_secs(11)).await;
    f.runner.started.notified().await;
    tokio::task::yield_now().await;
    let row = f.store.get("once").await.unwrap().unwrap();
    assert_eq!(row.status, ScheduleStatus::Done);
}

/// The run has no deadline of its own (an unattended run is ended by the progress watchdog, which
/// the runner sees as an error); what the scheduler guarantees is that the name is released
/// whenever the fire ends, however it ends.
#[tokio::test(start_paused = true)]
async fn an_aborted_fire_releases_its_name() {
    let f = fixture(vec![cron_row("daily")], Script { gate: Some(Arc::new(Notify::new())), ..Default::default() });
    let fire = tokio::spawn({
        let s = f.sched.clone();
        async move { s.fire_cron_slot("daily", at("2025-01-01T09:00:00Z")).await }
    });
    f.runner.started.notified().await;
    assert!(f.sched.status()[0].running);
    fire.abort();
    assert!(fire.await.unwrap_err().is_cancelled());
    assert!(!f.sched.status()[0].running);
}
