//! The idle maintenance schedule, from `maintenance.rs`, in scripted timelines (times are milliseconds after a fixed start):
//!
//! - a task is registered due `initial_delay` after the registration time (`register_task`, line 401);
//! - a tick runs the tasks whose due time is at or before the tick's time (line 467), in registration order (line 406);
//! - the next due time is the tick's own time plus the interval, set before the task runs (line 488), so a task that ran
//!   late runs late again rather than catching up;
//! - the idle probe is asked before every task; a busy answer ends the tick with `busy` and leaves the due time as it was
//!   (lines 481-482), so the task runs at the first idle tick;
//! - a task that fails is reported to its `on_error` (line 493), keeps its next due time, and runs again at it.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt;

use crate::maintenance::{ErrorSink, MaintenanceSchedule, TaskFn, TaskOptions};

const T0: i64 = 1_000_000_000_000;

/// (name, interval ms, initial delay ms, fails)
type Task = (&'static str, u64, u64, bool);
/// (at ms after T0, process idle, tasks that ran, stopped busy)
type Step = (i64, bool, &'static [&'static str], bool);

/// Plays `steps` against a schedule of `tasks`: the tasks that ran in all, and the tasks that reported an error.
async fn timeline(tasks: &[Task], steps: &[Step]) -> (Vec<String>, Vec<String>) {
    let schedule = MaintenanceSchedule::new();
    let idle = Arc::new(AtomicBool::new(true));
    let probe_idle = idle.clone();
    let _probe = schedule.register_idle_probe(Arc::new(move || {
        let idle = probe_idle.load(Ordering::SeqCst);
        async move { idle }.boxed()
    }));
    let errors: Arc<Mutex<Vec<String>>> = Arc::default();
    for &(name, interval, initial_delay, fails) in tasks {
        let run: TaskFn = Arc::new(move || async move { if fails { Err("boom".to_owned()) } else { Ok(()) } }.boxed());
        let (sink, failed) = (errors.clone(), name.to_owned());
        let on_error: ErrorSink = Arc::new(move |_| sink.lock().unwrap().push(failed.clone()));
        let options = TaskOptions { interval: Duration::from_millis(interval), initial_delay: Duration::from_millis(initial_delay), on_error: Some(on_error) };
        drop(schedule.register_task(name, run, options, T0));
    }
    let mut ran_all = Vec::new();
    for &(at, is_idle, ran, busy) in steps {
        idle.store(is_idle, Ordering::SeqCst);
        let tick = schedule.run_tasks(false, T0 + at).await;
        assert_eq!((tick.ran.iter().map(String::as_str).collect::<Vec<_>>(), tick.busy), (ran.to_vec(), busy), "at {at}");
        ran_all.extend(tick.ran);
    }
    let reported = errors.lock().unwrap().clone();
    (ran_all, reported)
}

#[tokio::test]
async fn a_task_runs_after_its_initial_delay_and_then_once_per_interval() {
    let none: &[&str] = &[];
    let cleanup: &[&str] = &["worktree-cleanup"];
    let (ran, errors) = timeline(
        &[("worktree-cleanup", 3_600_000, 180_000, false)],
        &[
            (0, true, none, false),
            (179_999, true, none, false),
            (180_000, true, cleanup, false),
            (180_001, true, none, false),
            (3_779_999, true, none, false),
            (3_780_000, true, cleanup, false),
            (7_380_005, true, cleanup, false),
            (10_980_000, true, none, false),
        ],
    )
    .await;
    assert_eq!(ran, ["worktree-cleanup"; 3]);
    assert!(errors.is_empty());
}

#[tokio::test]
async fn a_busy_process_holds_a_due_task_back_until_it_is_idle() {
    let none: &[&str] = &[];
    let cleanup: &[&str] = &["worktree-cleanup"];
    let (ran, _) = timeline(
        &[("worktree-cleanup", 3_600_000, 180_000, false)],
        &[(180_000, false, none, true), (240_000, false, none, true), (300_000, true, cleanup, false), (360_000, true, none, false), (3_900_000, true, cleanup, false)],
    )
    .await;
    assert_eq!(ran, ["worktree-cleanup"; 2], "it ran when the process went idle, and again an interval later");
}

#[tokio::test]
async fn a_task_that_fails_is_reported_and_still_runs_on_its_next_interval() {
    let none: &[&str] = &[];
    let cleanup: &[&str] = &["worktree-cleanup"];
    let (ran, errors) = timeline(&[("worktree-cleanup", 3_600_000, 180_000, true)], &[(180_000, true, cleanup, false), (180_001, true, none, false), (3_780_000, true, cleanup, false)]).await;
    assert_eq!(ran, ["worktree-cleanup"; 2]);
    assert_eq!(errors, ["worktree-cleanup"; 2], "each failure is reported");
}

#[tokio::test]
async fn tasks_run_in_registration_order_each_on_its_own_interval() {
    let (ran, _) = timeline(
        &[("a", 600_000, 0, false), ("b", 1_800_000, 300_000, false)],
        &[(0, true, &["a"], false), (300_000, true, &["b"], false), (600_000, true, &["a"], false), (2_100_000, true, &["a", "b"], false)],
    )
    .await;
    assert_eq!(ran, ["a", "b", "a", "a", "b"]);
}
