//! What the replays of the screen-control recordings run on: a deterministic executor, gates a fake backend
//! waits on, and a virtual clock. Nothing here waits on a thread, a real timer or the wall clock.

use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::task::Context;
use std::task::Poll;
use std::task::Wake;
use std::task::Waker;

use serde_json::Value;

use super::installer::Timers;
use super::router::BoxFuture;

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

struct Ready {
    queue: Mutex<VecDeque<Arc<Task>>>,
}

struct Task {
    future: Mutex<Option<BoxFuture<()>>>,
    queued: AtomicBool,
    ready: Arc<Ready>,
}

impl Wake for Task {
    fn wake(self: Arc<Self>) {
        self.wake_by_ref();
    }

    fn wake_by_ref(self: &Arc<Self>) {
        if !self.queued.swap(true, Ordering::SeqCst) {
            self.ready.queue.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).push_back(self.clone());
        }
    }
}

/// Runs the tasks it is given one at a time, in the order they became ready, and only when told to
/// (`settle`): the order Node's microtask queue gives between two macrotasks.
#[derive(Clone)]
pub(super) struct Sim {
    ready: Arc<Ready>,
}

impl Sim {
    pub(super) fn new() -> Self {
        Self { ready: Arc::new(Ready { queue: Mutex::new(VecDeque::new()) }) }
    }

    pub(super) fn spawn(&self, future: BoxFuture<()>) {
        let task = Arc::new(Task { future: Mutex::new(Some(future)), queued: AtomicBool::new(true), ready: self.ready.clone() });
        self.ready.queue.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).push_back(task);
    }

    /// Runs every task that can run until none can: what is left waits on a gate, a timer or a channel.
    pub(super) fn settle(&self) {
        loop {
            let next = self.ready.queue.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).pop_front();
            let Some(task) = next else {
                return;
            };
            task.queued.store(false, Ordering::SeqCst);
            let waker = Waker::from(task.clone());
            let mut context = Context::from_waker(&waker);
            let mut slot = task.future.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(future) = slot.as_mut()
                && Pin::new(future).poll(&mut context).is_ready()
            {
                *slot = None;
            }
        }
    }
}

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
    due: u64,
    seq: u64,
    state: Arc<Mutex<TimerState>>,
}

#[derive(Default)]
struct Clock {
    now: u64,
    seq: u64,
    timers: Vec<Timer>,
}

/// Virtual time: timers wait in one queue ordered by absolute due time, then registration order, and run one
/// at a time with the tasks they wake drained between timers. A timer whose future was dropped never runs.
#[derive(Clone)]
pub(super) struct VirtualTimers {
    sim: Sim,
    clock: Arc<Mutex<Clock>>,
}

impl VirtualTimers {
    pub(super) fn new(sim: Sim) -> Self {
        Self { sim, clock: Arc::new(Mutex::new(Clock::default())) }
    }

    fn clock(&self) -> std::sync::MutexGuard<'_, Clock> {
        self.clock.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Time elapsed since the start.
    pub(super) fn elapsed(&self) -> u64 {
        self.clock().now
    }

    /// Moves the clock forward by `ms`, running each timer that falls due, in order, one at a time; returns
    /// how many ran.
    pub(super) fn advance(&self, ms: u64) -> usize {
        let until = self.clock().now + ms;
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
            self.sim.settle();
            ran += 1;
        }
        self.clock().now = until;
        ran
    }
}

impl Timers for VirtualTimers {
    fn sleep(&self, ms: u64) -> BoxFuture<()> {
        let state = Arc::new(Mutex::new(TimerState { fired: false, cancelled: false, waker: None }));
        {
            let mut clock = self.clock();
            clock.seq += 1;
            let timer = Timer { due: clock.now + ms, seq: clock.seq, state: state.clone() };
            clock.timers.push(timer);
        }
        Box::pin(Sleep(state))
    }

    fn spawn(&self, task: BoxFuture<()>) {
        self.sim.spawn(task);
    }
}
