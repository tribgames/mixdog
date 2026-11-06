//! The one idle-time maintenance schedule of the process (Node `maintenance-schedule.mjs`):
//! periodic housekeeping registers a task here instead of keeping a timer of its own.
//!
//! One timer ticks every `tick`. A tick runs the due tasks one at a time, each only when every
//! registered idle probe reports idle right before it; once a probe reports busy the tick stops
//! and the remaining due tasks wait for a later idle tick (never dropped). Idleness only picks a
//! quiet moment: a task still guards its own work against activity that starts while it runs.
//! A task is due `initial_delay` after it registered, then `interval` after its previous run
//! started. A failing task is reported to its `on_error` and rescheduled like a successful one.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::Weak;
use std::time::Duration;
use std::time::SystemTime;

use futures::FutureExt;
use futures::future::BoxFuture;
use futures::future::Shared;
use mixdog_rt::CancellationToken;

/// `DEFAULT_TICK_MS`.
pub const DEFAULT_TICK: Duration = Duration::from_secs(60);

/// What a task reports when it fails; handed to its `on_error`.
pub type TaskResult = Result<(), String>;
pub type TaskFn = Arc<dyn Fn() -> BoxFuture<'static, TaskResult> + Send + Sync>;
/// `true` while the process is idle enough for maintenance.
pub type IdleProbe = Arc<dyn Fn() -> BoxFuture<'static, bool> + Send + Sync>;
pub type ErrorSink = Arc<dyn Fn(&str) + Send + Sync>;
/// Epoch milliseconds (`Date.now()`).
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

pub struct TaskOptions {
    pub interval: Duration,
    pub initial_delay: Duration,
    pub on_error: Option<ErrorSink>,
}

struct Task {
    name: String,
    run: TaskFn,
    interval_ms: i64,
    on_error: Option<ErrorSink>,
    due_at: Mutex<i64>,
}

/// What one tick did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TickReport {
    pub ran: Vec<String>,
    pub busy: bool,
}

type Tick = Shared<BoxFuture<'static, TickReport>>;

#[derive(Default)]
struct State {
    /// Registration order; a re-registered name keeps its place (a `Map`'s `set`).
    tasks: Vec<Arc<Task>>,
    probes: Vec<(u64, IdleProbe)>,
    next_probe: u64,
    started: bool,
    /// The shutdown token of the started timer: once it fires no further task is admitted.
    shutdown: Option<CancellationToken>,
}

#[derive(Default)]
pub struct MaintenanceSchedule {
    state: Mutex<State>,
    running: Mutex<Option<Tick>>,
}

/// Removes the registration it came from, when it is still the registered one.
pub struct TaskRegistration {
    schedule: Weak<MaintenanceSchedule>,
    task: Weak<Task>,
}

impl TaskRegistration {
    pub fn unregister(self) {
        let (Some(schedule), Some(task)) = (self.schedule.upgrade(), self.task.upgrade()) else { return };
        schedule.state.lock().unwrap_or_else(|e| e.into_inner()).tasks.retain(|t| !Arc::ptr_eq(t, &task));
    }
}

/// Removes the idle probe it came from.
pub struct ProbeRegistration {
    schedule: Weak<MaintenanceSchedule>,
    id: u64,
}

impl ProbeRegistration {
    pub fn unregister(self) {
        if let Some(schedule) = self.schedule.upgrade() {
            schedule.state.lock().unwrap_or_else(|e| e.into_inner()).probes.retain(|(id, _)| *id != self.id);
        }
    }
}

/// `Date.now()`.
pub fn system_clock() -> Clock {
    Arc::new(|| {
        SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
    })
}

fn millis(d: Duration) -> i64 {
    i64::try_from(d.as_millis()).unwrap_or(i64::MAX)
}

impl MaintenanceSchedule {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Registers (or replaces) the task `name`, due `options.initial_delay` after `now`.
    pub fn register_task(self: &Arc<Self>, name: &str, run: TaskFn, options: TaskOptions, now: i64) -> TaskRegistration {
        assert!(!name.is_empty(), "maintenance task name is required");
        assert!(!options.interval.is_zero(), "maintenance task interval must be positive");
        let task = Arc::new(Task {
            name: name.to_owned(),
            run,
            interval_ms: millis(options.interval),
            on_error: options.on_error,
            due_at: Mutex::new(now.saturating_add(millis(options.initial_delay))),
        });
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        match state.tasks.iter().position(|t| t.name == name) {
            Some(at) => state.tasks[at] = task.clone(),
            None => state.tasks.push(task.clone()),
        }
        TaskRegistration { schedule: Arc::downgrade(self), task: Arc::downgrade(&task) }
    }

    /// Registers an idle probe.
    pub fn register_idle_probe(self: &Arc<Self>, probe: IdleProbe) -> ProbeRegistration {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let id = state.next_probe;
        state.next_probe += 1;
        state.probes.push((id, probe));
        ProbeRegistration { schedule: Arc::downgrade(self), id }
    }

    async fn is_idle(&self) -> bool {
        let probes: Vec<IdleProbe> = self.state.lock().unwrap_or_else(|e| e.into_inner()).probes.iter().map(|(_, p)| p.clone()).collect();
        for probe in probes {
            if !probe().await {
                return false;
            }
        }
        true
    }

    fn is_shut_down(&self) -> bool {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).shutdown.as_ref().is_some_and(CancellationToken::is_cancelled)
    }

    fn is_registered(&self, task: &Arc<Task>) -> bool {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).tasks.iter().any(|t| Arc::ptr_eq(t, task))
    }

    async fn tick(&self, force: bool, now: i64) -> TickReport {
        let due: Vec<Arc<Task>> = self
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .tasks
            .iter()
            .filter(|t| force || *t.due_at.lock().unwrap_or_else(|e| e.into_inner()) <= now)
            .cloned()
            .collect();
        let mut ran = Vec::new();
        for task in due {
            // After shutdown no further task is admitted; the one running has finished.
            if self.is_shut_down() {
                break;
            }
            if !self.is_registered(&task) {
                continue;
            }
            // Asked before every task: work that began during an earlier task defers the rest
            // to a later idle tick.
            if !force && !self.is_idle().await {
                return TickReport { ran, busy: true };
            }
            // Shutdown may have arrived while the probes were asked.
            if self.is_shut_down() {
                break;
            }
            *task.due_at.lock().unwrap_or_else(|e| e.into_inner()) = now.saturating_add(task.interval_ms);
            if let Err(error) = (task.run)().await
                && let Some(on_error) = &task.on_error
            {
                on_error(&error);
            }
            ran.push(task.name.clone());
        }
        TickReport { ran, busy: false }
    }

    /// One tick: when idle (or `force`), runs each due task (every task with `force`) in
    /// registration order. Concurrent calls share the tick under way.
    pub fn run_tasks(self: &Arc<Self>, force: bool, now: i64) -> Tick {
        let mut running = self.running.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(tick) = running.as_ref() {
            return tick.clone();
        }
        let schedule = self.clone();
        let tick = async move {
            let report = schedule.tick(force, now).await;
            *schedule.running.lock().unwrap_or_else(|e| e.into_inner()) = None;
            report
        }
        .boxed()
        .shared();
        *running = Some(tick.clone());
        tick
    }

    /// Starts ticking; `None` when it already runs. The timer ends with `shutdown` (or the last
    /// handle to the schedule). At shutdown no further task is admitted, the tick under way and
    /// the task it runs finish, every task is unregistered, and then the returned task ends:
    /// awaiting it is the end of the schedule.
    pub fn start(self: &Arc<Self>, tick: Duration, clock: Clock, shutdown: CancellationToken) -> Option<tokio::task::JoinHandle<()>> {
        {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.started {
                return None;
            }
            state.started = true;
            state.shutdown = Some(shutdown.clone());
        }
        let weak = Arc::downgrade(self);
        Some(mixdog_rt::spawn("maintenance.schedule", mixdog_rt::TaskClass::Work, async move {
            let mut timer = tokio::time::interval_at(tokio::time::Instant::now() + tick, tick);
            loop {
                tokio::select! {
                    () = shutdown.cancelled() => break,
                    _ = timer.tick() => {}
                }
                let Some(schedule) = weak.upgrade() else { return };
                schedule.run_tasks(false, clock()).await;
            }
            if let Some(schedule) = weak.upgrade() {
                let running = schedule.running.lock().unwrap_or_else(|e| e.into_inner()).clone();
                if let Some(running) = running {
                    running.await;
                }
                schedule.state.lock().unwrap_or_else(|e| e.into_inner()).tasks.clear();
            }
        }))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicBool;
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    use super::*;

    fn counting(counter: &Arc<AtomicUsize>, fail: bool) -> TaskFn {
        let counter = counter.clone();
        Arc::new(move || {
            let counter = counter.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                if fail { Err("boom".to_owned()) } else { Ok(()) }
            }
            .boxed()
        })
    }

    fn options(interval_ms: u64, delay_ms: u64, on_error: Option<ErrorSink>) -> TaskOptions {
        TaskOptions { interval: Duration::from_millis(interval_ms), initial_delay: Duration::from_millis(delay_ms), on_error }
    }

    fn probe(idle: &Arc<AtomicBool>) -> IdleProbe {
        let idle = idle.clone();
        Arc::new(move || {
            let idle = idle.load(Ordering::SeqCst);
            async move { idle }.boxed()
        })
    }

    /// A task is due `initial_delay` after it registered, then `interval` after its previous
    /// run started; a tick before that runs nothing.
    #[tokio::test]
    async fn a_task_runs_when_due_and_again_one_interval_after_its_run_started() {
        let schedule = MaintenanceSchedule::new();
        let runs = Arc::new(AtomicUsize::new(0));
        schedule.register_task("a", counting(&runs, false), options(100, 30, None), 1000);
        assert_eq!(schedule.run_tasks(false, 1029).await, TickReport { ran: vec![], busy: false });
        assert_eq!(schedule.run_tasks(false, 1030).await.ran, ["a"]);
        assert!(schedule.run_tasks(false, 1129).await.ran.is_empty());
        assert_eq!(schedule.run_tasks(false, 1130).await.ran, ["a"]);
        assert_eq!(runs.load(Ordering::SeqCst), 2);
    }

    /// Once a probe reports busy the tick stops; the due tasks are kept for a later idle tick,
    /// and `force` runs every task whatever the probes say.
    #[tokio::test]
    async fn a_busy_probe_defers_the_due_tasks_and_force_overrides_it() {
        let schedule = MaintenanceSchedule::new();
        let (a, b) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
        schedule.register_task("a", counting(&a, false), options(100, 0, None), 0);
        schedule.register_task("b", counting(&b, false), options(100, 0, None), 0);
        let idle = Arc::new(AtomicBool::new(false));
        schedule.register_idle_probe(probe(&idle));
        assert_eq!(schedule.run_tasks(false, 1).await, TickReport { ran: vec![], busy: true });
        assert_eq!((a.load(Ordering::SeqCst), b.load(Ordering::SeqCst)), (0, 0));
        idle.store(true, Ordering::SeqCst);
        assert_eq!(schedule.run_tasks(false, 2).await, TickReport { ran: vec!["a".into(), "b".into()], busy: false });
        idle.store(false, Ordering::SeqCst);
        assert_eq!(schedule.run_tasks(true, 3).await.ran, ["a", "b"], "force runs while busy");
    }

    /// The probe is asked before every task: work that starts during the first defers the rest.
    #[tokio::test]
    async fn the_probe_is_asked_again_before_each_task() {
        let schedule = MaintenanceSchedule::new();
        let idle = Arc::new(AtomicBool::new(true));
        let flip = idle.clone();
        let first: TaskFn = Arc::new(move || {
            let flip = flip.clone();
            async move {
                flip.store(false, Ordering::SeqCst);
                Ok(())
            }
            .boxed()
        });
        let second = Arc::new(AtomicUsize::new(0));
        schedule.register_task("first", first, options(100, 0, None), 0);
        schedule.register_task("second", counting(&second, false), options(100, 0, None), 0);
        schedule.register_idle_probe(probe(&idle));
        assert_eq!(schedule.run_tasks(false, 1).await, TickReport { ran: vec!["first".into()], busy: true });
        assert_eq!(second.load(Ordering::SeqCst), 0);
    }

    /// A failing task is reported to its `on_error` and rescheduled like a successful one.
    #[tokio::test]
    async fn a_failing_task_is_reported_and_rescheduled() {
        let schedule = MaintenanceSchedule::new();
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = seen.clone();
        let on_error: ErrorSink = Arc::new(move |e| sink.lock().unwrap().push(e.to_owned()));
        let runs = Arc::new(AtomicUsize::new(0));
        schedule.register_task("bad", counting(&runs, true), options(100, 0, Some(on_error)), 0);
        assert_eq!(schedule.run_tasks(false, 0).await.ran, ["bad"]);
        assert_eq!(*seen.lock().unwrap(), ["boom"]);
        assert!(schedule.run_tasks(false, 99).await.ran.is_empty());
        assert_eq!(schedule.run_tasks(false, 100).await.ran, ["bad"]);
    }

    /// Re-registering a name replaces the task in place; an unregister removes only the
    /// registration it came from.
    #[tokio::test]
    async fn re_registering_replaces_in_place_and_unregister_is_per_registration() {
        let schedule = MaintenanceSchedule::new();
        let (old, new, other) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
        let stale = schedule.register_task("a", counting(&old, false), options(100, 0, None), 0);
        schedule.register_task("b", counting(&other, false), options(100, 0, None), 0);
        let current = schedule.register_task("a", counting(&new, false), options(100, 0, None), 0);
        stale.unregister();
        assert_eq!(schedule.run_tasks(false, 0).await.ran, ["a", "b"]);
        assert_eq!((old.load(Ordering::SeqCst), new.load(Ordering::SeqCst)), (0, 1));
        current.unregister();
        assert_eq!(schedule.run_tasks(false, 100).await.ran, ["b"]);
    }

    /// Concurrent calls share the tick under way: the task runs once.
    #[tokio::test]
    async fn concurrent_ticks_share_one_run() {
        let schedule = MaintenanceSchedule::new();
        let runs = Arc::new(AtomicUsize::new(0));
        schedule.register_task("a", counting(&runs, false), options(100, 0, None), 0);
        let (one, two) = (schedule.run_tasks(false, 0), schedule.run_tasks(false, 0));
        assert_eq!(one.await, two.await);
        assert_eq!(runs.load(Ordering::SeqCst), 1);
    }

    /// The started timer ticks the due tasks on its own and ends with the schedule.
    #[tokio::test(start_paused = true)]
    async fn the_started_timer_runs_due_tasks() {
        mixdog_rt::testing::tokens();
        let schedule = MaintenanceSchedule::new();
        let runs = Arc::new(AtomicUsize::new(0));
        let now = Arc::new(std::sync::atomic::AtomicI64::new(0));
        let clock_now = now.clone();
        schedule.register_task("a", counting(&runs, false), options(1000, 0, None), 0);
        let down = CancellationToken::new();
        let ended = schedule.start(Duration::from_millis(100), Arc::new(move || clock_now.load(Ordering::SeqCst)), down.clone());
        assert!(schedule.start(Duration::from_millis(100), Arc::new(|| 0), down.clone()).is_none(), "already started");
        now.store(100, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(runs.load(Ordering::SeqCst), 1);
        down.cancel();
        ended.expect("first start").await.expect("ended");
    }

    /// Shutdown that arrives while an idle probe is being awaited admits no task: the probe
    /// answers idle after the token fired, and the due task still does not start.
    #[tokio::test(start_paused = true)]
    async fn shutdown_during_the_idle_probe_admits_no_task() {
        mixdog_rt::testing::tokens();
        let schedule = MaintenanceSchedule::new();
        let down = CancellationToken::new();
        let runs = Arc::new(AtomicUsize::new(0));
        schedule.register_task("a", counting(&runs, false), options(1000, 0, None), 0);
        let (asked, release) = (Arc::new(tokio::sync::Notify::new()), Arc::new(tokio::sync::Notify::new()));
        let (probe_asked, probe_release) = (asked.clone(), release.clone());
        schedule.register_idle_probe(Arc::new(move || {
            let (asked, release) = (probe_asked.clone(), probe_release.clone());
            async move {
                asked.notify_one();
                release.notified().await;
                true
            }
            .boxed()
        }));
        let ended = schedule.start(Duration::from_millis(100), Arc::new(|| 1000), down.clone()).expect("started");
        asked.notified().await;
        down.cancel();
        release.notify_one();
        ended.await.expect("ended");
        assert_eq!(runs.load(Ordering::SeqCst), 0, "the task did not start after shutdown");
    }

    /// At shutdown the tick under way finishes its task, no further task is admitted, every
    /// task is unregistered, and the returned task ends after all that.
    #[tokio::test(start_paused = true)]
    async fn shutdown_admits_nothing_more_unregisters_the_tasks_and_ends_awaitably() {
        mixdog_rt::testing::tokens();
        let schedule = MaintenanceSchedule::new();
        let down = CancellationToken::new();
        let (first, second) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
        let entered = Arc::new(tokio::sync::Notify::new());
        let (signal, counter) = (entered.clone(), first.clone());
        let slow: TaskFn = Arc::new(move || {
            let (signal, counter) = (signal.clone(), counter.clone());
            async move {
                signal.notify_one();
                tokio::time::sleep(Duration::from_secs(5)).await;
                counter.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }
            .boxed()
        });
        schedule.register_task("slow", slow, options(1000, 0, None), 0);
        schedule.register_task("after", counting(&second, false), options(1000, 0, None), 0);
        let ended = schedule.start(Duration::from_millis(100), Arc::new(|| 0), down.clone()).expect("started");
        entered.notified().await;
        down.cancel();
        ended.await.expect("ended");
        assert_eq!(first.load(Ordering::SeqCst), 1, "the admitted task finished");
        assert_eq!(second.load(Ordering::SeqCst), 0, "no further task was admitted");
        assert!(schedule.run_tasks(true, 0).await.ran.is_empty(), "every task is unregistered");
    }
}
