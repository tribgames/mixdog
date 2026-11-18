use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};
use chrono_tz::Tz;
use tokio::sync::Notify;

use super::store::Ts;
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

#[derive(Default)]
struct Script {
    runs: AtomicUsize,
    fail: Mutex<bool>,
    gate: Option<Arc<Notify>>,
    started: Notify,
}

#[async_trait]
impl ScheduleRunner for Script {
    async fn run(&self, _s: &Schedule, _prompt: &str) -> Result<RunOutcome, String> {
        self.runs.fetch_add(1, Ordering::SeqCst);
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

#[derive(Default)]
struct StampGate {
    pending: Notify,
    release: Notify,
    released: Notify,
}

struct OneShotStore {
    inner: MemoryScheduleStore,
    next_fire_ack: Option<StampGate>,
    fail_success: bool,
}

#[async_trait]
impl ScheduleStore for OneShotStore {
    async fn get(&self, name: &str) -> Result<Option<Schedule>, ScheduleError> {
        self.inner.get(name).await
    }
    async fn list(&self) -> Result<Vec<Schedule>, ScheduleError> {
        self.inner.list().await
    }
    async fn mark_fired(&self, name: &str, at: Ts) -> Result<(), ScheduleError> {
        self.inner.mark_fired(name, at).await
    }
    async fn set_next_fire(&self, name: &str, next: Option<Ts>) -> Result<(), ScheduleError> {
        self.inner.set_next_fire(name, next).await?;
        if let Some(gate) = &self.next_fire_ack {
            gate.pending.notify_one();
            gate.release.notified().await;
            gate.released.notify_one();
        }
        Ok(())
    }
    async fn advance_cursor(&self, name: &str, scheduled_at: Ts, next: Option<Ts>) -> Result<bool, ScheduleError> {
        self.inner.advance_cursor(name, scheduled_at, next).await
    }
    async fn claim_run(&self, name: &str, scheduled_at: Ts, started_at: Ts, next: Option<Ts>) -> Result<bool, ScheduleError> {
        self.inner.claim_run(name, scheduled_at, started_at, next).await
    }
    async fn mark_success(&self, name: &str, at: Ts) -> Result<(), ScheduleError> {
        if self.fail_success {
            return Err(ScheduleError::Store("success timestamp write failed".into()));
        }
        self.inner.mark_success(name, at).await
    }
    async fn mark_failure(&self, name: &str, at: Ts) -> Result<(), ScheduleError> {
        self.inner.mark_failure(name, at).await
    }
    async fn mark_skipped(&self, name: &str, at: Ts) -> Result<(), ScheduleError> {
        self.inner.mark_skipped(name, at).await
    }
    async fn mark_done(&self, name: &str) -> Result<(), ScheduleError> {
        self.inner.mark_done(name).await
    }
    async fn set_deferred(&self, name: &str, until: Option<Ts>) -> Result<(), ScheduleError> {
        self.inner.set_deferred(name, until).await
    }
    async fn set_skipped_until(&self, name: &str, until: Option<Ts>) -> Result<(), ScheduleError> {
        self.inner.set_skipped_until(name, until).await
    }
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
async fn a_cron_whose_time_zone_does_not_parse_is_not_armed() {
    let mut bad = cron_row("bad");
    bad.timezone = Some("Mars/Olympus".into());
    let mut seoul = cron_row("seoul");
    seoul.timezone = Some(" Asia/Seoul ".into());
    let mut blank = cron_row("blank");
    blank.timezone = Some("  ".into());
    // `Intl` accepts any casing of an IANA name, so a stored `utc` or `asia/seoul` is valid and armed.
    let mut lower = cron_row("lower");
    lower.timezone = Some("asia/seoul".into());
    let mut utc = cron_row("utc");
    utc.timezone = Some("utc".into());
    // ... and so does a fixed offset or an ICU legacy id, which Node ran as typed.
    let mut offset = cron_row("offset");
    offset.timezone = Some("+09:00".into());
    let mut legacy = cron_row("legacy");
    legacy.timezone = Some("PST".into());
    assert!(lower.validate().is_ok() && utc.validate().is_ok() && offset.validate().is_ok() && legacy.validate().is_ok());
    let f = fixture(vec![bad, seoul, blank, cron_row("local"), lower, utc, offset, legacy], Script::default());
    f.sched.start();
    assert_eq!(
        f.sched.armed_names(),
        ["blank", "legacy", "local", "lower", "offset", "seoul", "utc"].map(String::from).to_vec()
    );
    assert_eq!(f.sched.status().iter().find(|s| s.name == "offset").and_then(|s| s.next_fire.clone()).as_deref(), Some("2025-01-02T00:00:00.000Z"));
    f.sched.stop();
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
async fn one_shot_completes_despite_a_failed_success_stamp() {
    let row = one_shot_row("once", "2025-01-01T08:00:00Z");
    let store = Arc::new(OneShotStore {
        inner: MemoryScheduleStore::with([row.clone()]),
        next_fire_ack: None,
        fail_success: true,
    });
    let runner = Arc::new(Script::default());
    let started = at("2025-01-01T09:00:00Z");
    let clock = Arc::new(FixedClock(Mutex::new(started)));
    let sched = Scheduler::new(store.clone(), runner.clone(), clock.clone(), RunningWork::new(), Tz::UTC, vec![row]);
    sched.fire_one_shot("once").await;

    let row = store.get("once").await.unwrap().unwrap();
    assert_eq!(row.status, ScheduleStatus::Done);
    assert_eq!(row.last_fired_at, Some(started));
    assert!(row.last_success_at.is_none());
    assert!(row.last_failed_at.is_none());
    assert_eq!(row.consecutive_failures, 0);

    let recovered = Scheduler::new(store, runner.clone(), clock, RunningWork::new(), Tz::UTC, vec![row]);
    recovered.fire_one_shot("once").await;
    assert_eq!(runner.runs.load(Ordering::SeqCst), 1);
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

#[derive(Default)]
struct PromptLog(Mutex<Vec<String>>);

#[async_trait]
impl ScheduleRunner for PromptLog {
    async fn run(&self, _s: &Schedule, prompt: &str) -> Result<RunOutcome, String> {
        self.0.lock().unwrap().push(prompt.to_owned());
        Ok(RunOutcome::Done)
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
#[tokio::test(start_paused = true)]
async fn armed_cron_fires_on_time() {
    let clock = Arc::new(TokioClock { base: at("2025-01-01T08:59:00Z"), start: tokio::time::Instant::now() });
    let f = fixture_clock(vec![cron_row("daily")], Script::default(), clock);
    f.sched.start();
    mixdog_rt::time::sleep(std::time::Duration::from_secs(61)).await;
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
    mixdog_rt::time::sleep(std::time::Duration::from_secs(61)).await;
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
    // Three slots (Jan 1, 2, 3 at 09:00) elapsed unseen: none of them runs.
    assert_eq!(f.runner.runs.load(Ordering::SeqCst), 0);
    // The next slot is computed from now and fires once, on time.
    mixdog_rt::time::sleep(std::time::Duration::from_secs(24 * 3600)).await;
    f.runner.started.notified().await;
    assert_eq!(f.runner.runs.load(Ordering::SeqCst), 1);
    f.sched.stop();
}
#[tokio::test(start_paused = true)]
async fn armed_one_shot_fires_and_completes() {
    let clock = Arc::new(TokioClock { base: at("2025-01-01T08:00:00Z"), start: tokio::time::Instant::now() });
    let f = fixture_clock(vec![one_shot_row("once", "2025-01-01T08:00:10Z")], Script::default(), clock);
    f.sched.start();
    mixdog_rt::time::sleep(std::time::Duration::from_secs(11)).await;
    f.runner.started.notified().await;
    tokio::task::yield_now().await;
    let row = f.store.get("once").await.unwrap().unwrap();
    assert_eq!(row.status, ScheduleStatus::Done);
}

#[tokio::test(start_paused = true)]
async fn overdue_one_shot_fires_while_next_fire_write_is_pending() {
    let row = one_shot_row("once", "2025-01-01T08:00:00Z");
    let store = Arc::new(OneShotStore {
        inner: MemoryScheduleStore::with([row.clone()]),
        next_fire_ack: Some(StampGate::default()),
        fail_success: false,
    });
    let runner = Arc::new(Script::default());
    let clock = Arc::new(FixedClock(Mutex::new(at("2025-01-01T09:00:00Z"))));
    let sched = Scheduler::new(store.clone(), runner.clone(), clock, RunningWork::new(), Tz::UTC, vec![row]);
    let gate = store.next_fire_ack.as_ref().unwrap();
    sched.start();
    let wait = std::time::Duration::from_secs(1);
    tokio::time::timeout(wait, gate.pending.notified()).await.expect("the next-fire write should start");
    let ran = tokio::time::timeout(wait, runner.started.notified()).await;
    gate.release.notify_one();
    tokio::time::timeout(wait, gate.released.notified()).await.expect("the next-fire write should return");
    sched.stop();
    ran.expect("the overdue turn should start before the next-fire write returns");
}

async fn prompt_run(row: Schedule, dir: &std::path::Path) -> Vec<String> {
    let name = row.name.clone();
    let store = Arc::new(MemoryScheduleStore::with(vec![row.clone()]));
    let runner = Arc::new(PromptLog::default());
    let clock = Arc::new(FixedClock(Mutex::new(at("2025-01-01T09:00:00Z"))));
    let sched = Scheduler::new(store, runner.clone(), clock, RunningWork::new(), Tz::UTC, vec![row]);
    sched.set_prompts_dir(dir.to_path_buf(), mixdog_rt::testing::tokens().durability_io);
    sched.fire_cron_slot(&name, at("2025-01-01T09:00:00Z")).await;
    // The cron fire is fire-and-forget: wait for the spawned run.
    for _ in 0..200 {
        if !runner.0.lock().unwrap().is_empty() {
            break;
        }
        mixdog_rt::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    runner.0.lock().unwrap().clone()
}
#[tokio::test]
async fn empty_prompt_reads_the_named_file_in_the_prompts_folder() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("daily.md"), "  from the file \n").unwrap();
    let mut row = cron_row("daily");
    row.prompt = String::new();
    assert_eq!(prompt_run(row, dir.path()).await, vec!["from the file".to_string()]);
}
#[tokio::test]
async fn prompt_naming_a_file_or_an_absolute_path_is_read_and_plain_text_is_kept() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.md"), "relative body").unwrap();
    let abs = dir.path().join("elsewhere.txt");
    std::fs::write(&abs, "absolute body").unwrap();
    let mut row = cron_row("daily");
    row.prompt = "a.md".into();
    assert_eq!(prompt_run(row, dir.path()).await, vec!["relative body".to_string()]);
    let mut row = cron_row("daily");
    row.prompt = abs.to_string_lossy().into_owned();
    assert_eq!(prompt_run(row, dir.path()).await, vec!["absolute body".to_string()]);
    let mut row = cron_row("daily");
    row.prompt = "do it".into();
    assert_eq!(prompt_run(row, dir.path()).await, vec!["do it".to_string()]);
}
