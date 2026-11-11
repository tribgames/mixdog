//! What the replays of the screen-control recordings run on: the product's own runtime (tokio, on the test's
//! thread), a tracker that tells when every task of the replay has run as far as it can, gates a fake waits
//! on, and a virtual clock that moves only when the script advances it. Nothing here waits on a thread, a real
//! timer or the wall clock.
//!
//! A recorded Node fake answers through a promise: even an answer it already has reaches the caller one
//! microtask later, behind whatever was queued before. [`next_turn`] gives a Rust fake the same: its answer
//! is delivered after one turn of the runtime's queue, behind the tasks that were ready before it.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::task::Context;
use std::task::Poll;
use std::task::Wake;
use std::task::Waker;

use serde_json::Value;

use super::installer::TimerHandle;
use super::installer::Timers;
use super::router::BoxFuture;
use super::turn::Turn;

pub(super) type Log = Arc<Mutex<Vec<Value>>>;

pub(super) fn log_new() -> Log {
    Arc::new(Mutex::new(Vec::new()))
}

pub(super) fn log_push(log: &Log, event: Value) {
    log.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).push(event);
}

pub(super) fn log_take(log: &Log) -> Vec<Value> {
    log.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
}

/// Holds a recording's entries to its sub-directory's manifest: exactly the names the manifest lists as the
/// recorder's inputs, in its order, so a scenario dropped from either side fails.
pub(super) fn manifest_names(manifest: &str, entries: &[Value]) {
    let manifest: Value = serde_json::from_str(manifest).expect("the manifest parses");
    let listed = manifest["inputs"]["scenarios"].as_array().expect("the manifest lists its inputs");
    let names: Vec<&Value> = entries.iter().map(|entry| &entry["name"]).collect();
    assert_eq!(names, listed.iter().collect::<Vec<_>>(), "the recording's entries against its manifest's inputs");
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Polls a settle may take before it is a livelock: tasks that keep waking each other never settle.
const SETTLE_POLLS: u64 = 100_000;

/// How many of the replay's tasks are woken and not yet polled, and the driver waiting for none to be.
#[derive(Default)]
struct Tracker {
    scheduled: AtomicUsize,
    polls: AtomicU64,
    /// The poll count past which the waiting settle fails.
    limit: AtomicU64,
    driver: Mutex<Option<Waker>>,
}

impl Tracker {
    fn wake_driver(&self) {
        if let Some(driver) = lock(&self.driver).take() {
            driver.wake();
        }
    }
}

/// A task's waker: counts the task as scheduled once, then wakes it on the runtime.
struct Flag {
    scheduled: AtomicBool,
    tracker: Arc<Tracker>,
    task: Mutex<Option<Waker>>,
}

impl Wake for Flag {
    fn wake(self: Arc<Self>) {
        self.wake_by_ref();
    }

    fn wake_by_ref(self: &Arc<Self>) {
        if !self.scheduled.swap(true, Ordering::SeqCst) {
            self.tracker.scheduled.fetch_add(1, Ordering::SeqCst);
        }
        if let Some(task) = lock(&self.task).as_ref() {
            task.wake_by_ref();
        }
    }
}

struct Tracked {
    inner: BoxFuture<()>,
    flag: Arc<Flag>,
}

impl Future for Tracked {
    type Output = ();

    fn poll(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<()> {
        let flag = self.flag.clone();
        let tracker = flag.tracker.clone();
        *lock(&flag.task) = Some(context.waker().clone());
        if flag.scheduled.swap(false, Ordering::SeqCst) {
            tracker.scheduled.fetch_sub(1, Ordering::SeqCst);
        }
        let polls = tracker.polls.fetch_add(1, Ordering::SeqCst) + 1;
        let waker = Waker::from(flag);
        let result = self.inner.as_mut().poll(&mut Context::from_waker(&waker));
        if tracker.scheduled.load(Ordering::SeqCst) == 0 || polls > tracker.limit.load(Ordering::SeqCst) {
            tracker.wake_driver();
        }
        result
    }
}

impl Drop for Tracked {
    fn drop(&mut self) {
        if self.flag.scheduled.swap(false, Ordering::SeqCst) {
            self.flag.tracker.scheduled.fetch_sub(1, Ordering::SeqCst);
            self.flag.tracker.wake_driver();
        }
    }
}

/// Completes once no task of the replay is woken and unpolled: every task has run as far as it can, and what
/// is left waits on a gate, a timer or the script. Fails after [`SETTLE_POLLS`] polls without getting there.
struct Settle {
    tracker: Arc<Tracker>,
}

impl Future for Settle {
    type Output = ();

    fn poll(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<()> {
        if self.tracker.scheduled.load(Ordering::SeqCst) == 0 {
            return Poll::Ready(());
        }
        assert!(
            self.tracker.polls.load(Ordering::SeqCst) <= self.tracker.limit.load(Ordering::SeqCst),
            "the replay did not settle within {SETTLE_POLLS} polls: its tasks keep waking each other"
        );
        *lock(&self.tracker.driver) = Some(context.waker().clone());
        Poll::Pending
    }
}

/// One replay: its tasks run on a current-thread tokio runtime, the runtime the product's futures run on,
/// driven by the script on the same thread.
#[derive(Clone)]
pub(super) struct Replay {
    tracker: Arc<Tracker>,
}

impl Replay {
    /// Runs the script `body` to its end on a fresh runtime.
    pub(super) fn run<F: Future>(body: impl FnOnce(Replay) -> F) -> F::Output {
        let runtime = tokio::runtime::Builder::new_current_thread().build().expect("a current-thread runtime");
        let replay = Replay { tracker: Arc::new(Tracker::default()) };
        runtime.block_on(body(replay))
    }

    /// Runs `future` as a task of the replay.
    pub(super) fn spawn(&self, future: BoxFuture<()>) {
        let flag = Arc::new(Flag { scheduled: AtomicBool::new(true), tracker: self.tracker.clone(), task: Mutex::new(None) });
        self.tracker.scheduled.fetch_add(1, Ordering::SeqCst);
        drop(tokio::spawn(Tracked { inner: future, flag }));
    }

    /// Lets every task run until none can: the recorder's checkpoint (all microtasks drained).
    pub(super) async fn settle(&self) {
        let polls = self.tracker.polls.load(Ordering::SeqCst);
        self.tracker.limit.store(polls + SETTLE_POLLS, Ordering::SeqCst);
        Settle { tracker: self.tracker.clone() }.await;
    }
}

pub(super) use super::router::next_turn;

/// A closed door a fake backend's send waits at until the script opens it. A hung gate never opens.
pub(super) struct Gate {
    hung: bool,
    state: Mutex<(bool, Vec<Waker>)>,
}

impl Gate {
    pub(super) fn closed() -> Arc<Self> {
        Arc::new(Self { hung: false, state: Mutex::new((false, Vec::new())) })
    }

    pub(super) fn hung() -> Arc<Self> {
        Arc::new(Self { hung: true, state: Mutex::new((false, Vec::new())) })
    }

    pub(super) fn open(&self) {
        if self.hung {
            return;
        }
        let wakers = {
            let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            state.0 = true;
            std::mem::take(&mut state.1)
        };
        for waker in wakers {
            waker.wake();
        }
    }

    pub(super) fn wait(self: &Arc<Self>) -> GateWait {
        GateWait(self.clone())
    }
}

pub(super) struct GateWait(Arc<Gate>);

impl Future for GateWait {
    type Output = ();

    fn poll(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<()> {
        let mut state = self.0.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.0 {
            Poll::Ready(())
        } else {
            state.1.push(context.waker().clone());
            Poll::Pending
        }
    }
}

struct TimerState {
    fired: bool,
    cancelled: bool,
    waker: Option<Waker>,
}

struct Sleep(Arc<Mutex<TimerState>>);

impl Future for Sleep {
    type Output = ();

    fn poll(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<()> {
        let mut state = self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.fired {
            Poll::Ready(())
        } else {
            state.waker = Some(context.waker().clone());
            Poll::Pending
        }
    }
}

impl Drop for Sleep {
    fn drop(&mut self) {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).cancelled = true;
    }
}

struct Timer {
    /// Nanoseconds since the start.
    due: u64,
    seq: u64,
    state: Arc<Mutex<TimerState>>,
    /// A `set_timeout` callback, run by `advance` itself as Node's timer queue runs it; `None` for a sleep,
    /// whose task is woken instead.
    callback: Option<Box<dyn FnOnce() + Send>>,
}

#[derive(Default)]
struct Clock {
    /// Nanoseconds since the start.
    now: u64,
    seq: u64,
    timers: Vec<Timer>,
}

/// Virtual time: timers wait in one queue ordered by absolute due time, then registration order, and run one
/// at a time with the tasks they wake drained between timers. A timer whose future was dropped never runs.
#[derive(Clone)]
pub(super) struct VirtualTimers {
    replay: Replay,
    clock: Arc<Mutex<Clock>>,
    turn: Arc<Turn>,
}

impl VirtualTimers {
    pub(super) fn new(replay: Replay) -> Self {
        Self { replay, clock: Arc::new(Mutex::new(Clock::default())), turn: Turn::new() }
    }

    fn clock(&self) -> std::sync::MutexGuard<'_, Clock> {
        self.clock.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Milliseconds elapsed since the start, as the recorder writes them (a whole number when it is one).
    pub(super) fn elapsed(&self) -> Value {
        ms_value(self.clock().now)
    }

    /// Timers armed and neither run nor dropped.
    pub(super) fn pending(&self) -> usize {
        self.clock().timers.iter().filter(|timer| !lock(&timer.state).cancelled).count()
    }

    /// Moves the clock forward by `ms`, running each timer that falls due, in order, one at a time; returns
    /// how many ran.
    pub(super) async fn advance(&self, ms: u64) -> usize {
        let until = self.clock().now + ms * 1_000_000;
        let mut ran = 0;
        loop {
            let due = {
                let mut clock = self.clock();
                clock.timers.retain(|timer| !timer.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).cancelled);
                let next = clock.timers.iter().enumerate().min_by_key(|(_, timer)| (timer.due, timer.seq)).map(|(index, _)| index);
                match next {
                    Some(index) if clock.timers[index].due <= until => {
                        let timer = clock.timers.remove(index);
                        clock.now = clock.now.max(timer.due);
                        Some(timer)
                    }
                    _ => None,
                }
            };
            let Some(timer) = due else {
                break;
            };
            let waker = {
                let mut state = timer.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                state.fired = true;
                state.waker.take()
            };
            if let Some(waker) = waker {
                waker.wake();
            }
            if let Some(callback) = timer.callback {
                callback();
            }
            self.replay.settle().await;
            ran += 1;
        }
        self.clock().now = until;
        ran
    }
}

/// Nanoseconds as a JSON number of milliseconds: whole when they are, as Node's numbers are.
pub(super) fn ms_value(nanos: u64) -> Value {
    if nanos % 1_000_000 == 0 { Value::from(nanos / 1_000_000) } else { Value::from(nanos as f64 / 1e6) }
}

impl Timers for VirtualTimers {
    fn now_ms(&self) -> f64 {
        self.clock().now as f64 / 1e6
    }

    fn sleep(&self, after: std::time::Duration) -> BoxFuture<()> {
        let state = Arc::new(Mutex::new(TimerState { fired: false, cancelled: false, waker: None }));
        {
            let mut clock = self.clock();
            clock.seq += 1;
            let timer = Timer { due: clock.now + after.as_nanos() as u64, seq: clock.seq, state: state.clone(), callback: None };
            clock.timers.push(timer);
        }
        Box::pin(Sleep(state))
    }

    fn run(&self, task: BoxFuture<()>) {
        self.replay.spawn(task);
    }

    fn turn(&self) -> &Arc<Turn> {
        &self.turn
    }

    fn arm(&self, after: std::time::Duration, callback: Box<dyn FnOnce() + Send>) -> TimerHandle {
        let state = Arc::new(Mutex::new(TimerState { fired: false, cancelled: false, waker: None }));
        {
            let mut clock = self.clock();
            clock.seq += 1;
            let timer = Timer { due: clock.now + after.as_nanos() as u64, seq: clock.seq, state: state.clone(), callback: Some(callback) };
            clock.timers.push(timer);
        }
        TimerHandle::new(move || lock(&state).cancelled = true)
    }
}

// Timers on a multi-threaded runtime, for the tests that show what runs beside what.

/// How long one awaited event may take before the test fails, naming it.
pub(super) const DEADLINE: std::time::Duration = std::time::Duration::from_secs(10);

type Armed = (u64, u64, Arc<std::sync::atomic::AtomicBool>, Box<dyn FnOnce() + Send>);

#[derive(Default)]
struct ThreadedClock {
    /// Nanoseconds since the start.
    now: u64,
    seq: u64,
    timers: Vec<Armed>,
}

/// Timers on a multi-threaded tokio runtime with a virtual clock: a task runs on the runtime's workers, and a due
/// timer's callback is started on a worker when the script advances the clock (as `TokioTimers` starts it when
/// its sleep ends), so it runs beside whatever else is running.
#[derive(Clone)]
pub(super) struct ThreadedTimers {
    runtime: tokio::runtime::Handle,
    clock: Arc<Mutex<ThreadedClock>>,
    tasks: Arc<Mutex<Vec<tokio::task::JoinHandle<()>>>>,
    pub(super) turn: Arc<Turn>,
}

impl Timers for ThreadedTimers {
    fn now_ms(&self) -> f64 {
        lock(&self.clock).now as f64 / 1e6
    }

    fn sleep(&self, _after: std::time::Duration) -> BoxFuture<()> {
        panic!("nothing on these timers sleeps")
    }

    fn run(&self, task: BoxFuture<()>) {
        let handle = self.runtime.spawn(task);
        lock(&self.tasks).push(handle);
    }

    fn arm(&self, after: std::time::Duration, callback: Box<dyn FnOnce() + Send>) -> TimerHandle {
        let cleared = Arc::new(std::sync::atomic::AtomicBool::new(false));
        {
            let mut clock = lock(&self.clock);
            clock.seq += 1;
            let (due, seq) = (clock.now + after.as_nanos() as u64, clock.seq);
            clock.timers.push((due, seq, cleared.clone(), callback));
        }
        TimerHandle::new(move || cleared.store(true, std::sync::atomic::Ordering::SeqCst))
    }

    fn turn(&self) -> &Arc<Turn> {
        &self.turn
    }
}

impl ThreadedTimers {
    pub(super) fn new(runtime: tokio::runtime::Handle) -> Self {
        Self { runtime, clock: Arc::default(), tasks: Arc::default(), turn: Turn::new() }
    }

    /// Moves the clock by `ms`, starting each timer that falls due and is not cleared on a worker, in due order.
    pub(super) fn advance(&self, ms: u64) -> Vec<tokio::task::JoinHandle<()>> {
        let mut clock = lock(&self.clock);
        let until = clock.now + ms * 1_000_000;
        let mut started = Vec::new();
        loop {
            clock.timers.retain(|timer| !timer.2.load(std::sync::atomic::Ordering::SeqCst));
            let next = clock.timers.iter().enumerate().min_by_key(|(_, timer)| (timer.0, timer.1)).map(|(index, _)| index);
            match next {
                Some(index) if clock.timers[index].0 <= until => {
                    let (due, _, _, callback) = clock.timers.remove(index);
                    clock.now = clock.now.max(due);
                    started.push(self.runtime.spawn(async move { callback() }));
                }
                _ => break,
            }
        }
        clock.now = until;
        started
    }

    pub(super) fn elapsed(&self) -> Value {
        ms_value(lock(&self.clock).now)
    }

    pub(super) fn pending(&self) -> usize {
        lock(&self.clock).timers.iter().filter(|timer| !timer.2.load(std::sync::atomic::Ordering::SeqCst)).count()
    }

    pub(super) fn finish(&self, task: tokio::task::JoinHandle<()>, what: &str) {
        self.runtime
            .block_on(async { mixdog_rt::time::timeout(DEADLINE, task).await })
            .unwrap_or_else(|_| panic!("{what} did not end within {DEADLINE:?}"))
            .unwrap_or_else(|error| panic!("{what} failed: {error}"));
    }

    /// Waits for every task started so far, and those they start, to end.
    pub(super) fn settle(&self) {
        loop {
            let tasks = std::mem::take(&mut *lock(&self.tasks));
            if tasks.is_empty() {
                return;
            }
            for task in tasks {
                self.finish(task, "a task of the script");
            }
        }
    }
}
