//! Scheduler timers across a rename: what fires next, under which name and when, after each outcome.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use mixdog_services::channels::running::RunningWork;
use mixdog_services::scheduler::{Clock, MemoryScheduleStore, RunOutcome, Schedule, ScheduleError, ScheduleRecords, ScheduleRunner, Scheduler};

const START: &str = "2030-01-01T00:00:00Z";

struct PausedClock {
    base: DateTime<Utc>,
    start: tokio::time::Instant,
}

impl Clock for PausedClock {
    fn now(&self) -> DateTime<Utc> {
        self.base + chrono::Duration::from_std(self.start.elapsed()).unwrap()
    }
}

#[derive(Default)]
struct Runs(Mutex<Vec<(String, i64)>>, Mutex<Option<Arc<PausedClock>>>);

#[async_trait]
impl ScheduleRunner for Runs {
    async fn run(&self, schedule: &Schedule, _prompt: &str) -> Result<RunOutcome, String> {
        let clock = self.1.lock().unwrap().clone().unwrap();
        self.0.lock().unwrap().push((schedule.name.clone(), (clock.now() - clock.base).num_seconds()));
        Ok(RunOutcome::Done)
    }
}

struct World {
    sched: Scheduler,
    store: Arc<MemoryScheduleStore>,
    runs: Arc<Runs>,
}

fn one_shot(name: &str, after_secs: i64) -> Schedule {
    let base: DateTime<Utc> = START.parse().unwrap();
    Schedule { name: name.to_owned(), prompt: "go".to_owned(), when_at: Some(base + chrono::Duration::seconds(after_secs)), ..Schedule::default() }
}

fn world(rows: Vec<Schedule>) -> World {
    let clock = Arc::new(PausedClock { base: START.parse().unwrap(), start: tokio::time::Instant::now() });
    let runs = Arc::new(Runs::default());
    *runs.1.lock().unwrap() = Some(clock.clone());
    let store = Arc::new(MemoryScheduleStore::with(rows.clone()));
    let sched = Scheduler::new(store.clone(), runs.clone(), clock, RunningWork::new(), Tz::UTC, rows);
    sched.start();
    World { sched, store, runs }
}

async fn advance(secs: u64) {
    tokio::time::advance(Duration::from_secs(secs)).await;
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
}

fn ran(w: &World) -> Vec<(String, i64)> {
    w.runs.0.lock().unwrap().clone()
}

#[tokio::test(start_paused = true)]
async fn a_renamed_one_shot_fires_once_at_its_own_time_under_the_new_name() {
    let w = world(vec![one_shot("old", 60)]);
    let moved = one_shot("new", 60);
    let saved = w
        .sched
        .rename_locked(
            "old",
            "new",
            || async { ScheduleRecords::rename(&*w.store, "old", &moved, false).await },
            || async {
                w.sched.reload_config(vec![moved.clone()], true);
                Ok(())
            },
        )
        .await
        .unwrap();
    assert_eq!(saved.map(|s| s.name), Some("new".to_owned()));
    advance(59).await;
    assert!(ran(&w).is_empty(), "not before its time");
    advance(1).await;
    assert_eq!(ran(&w), vec![("new".to_owned(), 60)]);
    advance(600).await;
    assert_eq!(ran(&w).len(), 1, "once");
}

#[tokio::test(start_paused = true)]
async fn a_rename_onto_a_taken_name_changes_nothing_and_the_old_timer_still_fires() {
    let w = world(vec![one_shot("old", 60), one_shot("taken", 3_600)]);
    let target = one_shot("taken", 60);
    let refused =
        w.sched.rename_locked("old", "taken", || async { ScheduleRecords::rename(&*w.store, "old", &target, false).await }, || async { Ok(()) }).await;
    assert!(matches!(refused, Err(ScheduleError::NameTaken { .. })), "{refused:?}");
    advance(60).await;
    assert_eq!(ran(&w), vec![("old".to_owned(), 60)]);
}

#[tokio::test(start_paused = true)]
async fn a_failed_reload_after_the_row_moved_leaves_nothing_armed_under_the_old_name() {
    let w = world(vec![one_shot("old", 60)]);
    let moved = one_shot("new", 60);
    let result = w
        .sched
        .rename_locked("old", "new", || async { ScheduleRecords::rename(&*w.store, "old", &moved, false).await }, || async { Err("reload broke".to_owned()) })
        .await;
    assert!(matches!(&result, Err(ScheduleError::RenameReloadFailed { name, .. }) if name == "new"), "{result:?}");
    advance(600).await;
    assert!(ran(&w).is_empty(), "the old name must not run, and the new one is not armed until a reload");
    w.sched.reload_config(vec![moved.clone()], true);
    advance(1).await;
    assert_eq!(ran(&w).len(), 1, "the next reload arms the new name");
    assert_eq!(ran(&w)[0].0, "new");
}

#[tokio::test(start_paused = true)]
async fn a_rename_of_a_name_already_being_renamed_is_refused() {
    let w = world(vec![one_shot("old", 60)]);
    let moved = one_shot("new", 60);
    let (held, release) = tokio::sync::oneshot::channel::<()>();
    let first = w.sched.rename_locked(
        "old",
        "new",
        || async {
            let _ = release.await;
            ScheduleRecords::rename(&*w.store, "old", &moved, false).await
        },
        || async { Ok(()) },
    );
    let second = async {
        tokio::task::yield_now().await;
        let refused = w.sched.rename_locked("old", "x", || async { Ok(None::<Schedule>) }, || async { Ok(()) }).await;
        held.send(()).unwrap();
        refused
    };
    let (first, second) = tokio::join!(first, second);
    assert!(matches!(second, Err(ScheduleError::RenameRunning { .. })));
    assert!(first.unwrap().is_some());
}
