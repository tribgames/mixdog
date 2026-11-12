//! Recording ports for the lifecycle, control and stall tests.

use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;

use super::ClientGrace;
use super::ReleaseBudgets;
use super::ports::GraceTimer;
use super::DiscoveryState;
use super::DrainNotice;
use super::Lifecycle;
use super::LifecycleConfig;
use super::Running;
use super::ports::CorePort;
use super::ports::Exiter;
use super::ports::Ports;
use super::ports::Publication;

type CancelHook = Box<dyn FnMut(&[Running]) + Send>;

#[derive(Default)]
pub struct Recorder {
    events: Mutex<Vec<String>>,
    exited: Mutex<bool>,
    exit_code: Mutex<Option<i32>>,
    exit_signal: Condvar,
    notices: Mutex<Vec<DrainNotice>>,
    published: Mutex<Vec<DiscoveryState>>,
    cancelled: Mutex<Vec<Vec<Running>>>,
    /// How many times the core was told it serves; kept out of `events` so their order stays what the tests read.
    serving: std::sync::atomic::AtomicUsize,
    /// Run inside `cancel_running`, on the caller's thread.
    pub on_cancel: Mutex<Option<CancelHook>>,
    /// Run inside `cut_new_tasks`, on the caller's thread; the cut is kept out of `events` so their order stays what the tests read.
    pub on_cut: Mutex<Option<Box<dyn FnMut() + Send>>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Recorder {
    fn note(&self, event: impl Into<String>) {
        lock(&self.events).push(event.into());
    }

    pub fn events(&self) -> Vec<String> {
        lock(&self.events).clone()
    }

    pub fn notices(&self) -> Vec<DrainNotice> {
        lock(&self.notices).clone()
    }

    pub fn published(&self) -> Vec<DiscoveryState> {
        lock(&self.published).clone()
    }

    pub fn cancelled(&self) -> Vec<Vec<Running>> {
        lock(&self.cancelled).clone()
    }

    pub fn serving_count(&self) -> usize {
        self.serving.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// The code the process-exit call carried, once it was made.
    pub fn exit_code(&self) -> Option<i32> {
        *lock(&self.exit_code)
    }

    pub fn has_exited(&self) -> bool {
        *lock(&self.exited)
    }

    /// Waits for the process-exit call; the bound only keeps a failing test from hanging.
    pub fn wait_exit(&self) {
        let guard = lock(&self.exited);
        let _exited = self
            .exit_signal
            .wait_while(guard, |exited| !*exited)
            .unwrap_or_else(PoisonError::into_inner);
    }
}

impl CorePort for Recorder {
    fn drain_notice(&self, notice: &DrainNotice) {
        self.note("drain_notice");
        lock(&self.notices).push(notice.clone());
    }
    fn serving(&self) {
        self.serving.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
    fn health(&self, stalled_ms: u64) {
        self.note(format!("health:{}", stalled_ms > 0));
    }
    fn cancel_running(&self, running: &[Running]) {
        self.note("cancel_running");
        lock(&self.cancelled).push(running.to_vec());
        if let Some(hook) = lock(&self.on_cancel).as_mut() {
            hook(running);
        }
    }
    fn cut_new_tasks(&self) {
        if let Some(hook) = lock(&self.on_cut).as_mut() {
            hook();
        }
    }
    fn release_decision(&self, pid: u32) {
        self.note(format!("release_decision:{pid}"));
    }
    fn release_started(&self, reason: &str) {
        self.note(format!("release_started:{reason}"));
    }
    fn final_barriers(&self) {
        self.note("final_barriers");
    }
    fn close_connections(&self) {
        self.note("close_connections");
    }
    fn close_ext_host(&self) {
        self.note("close_ext_host");
    }
    fn close_data_handles(&self) {
        self.note("close_data_handles");
    }
}

impl Publication for Recorder {
    fn publish(&self, state: &DiscoveryState) {
        self.note(format!("publish:{:?}", state.phase));
        lock(&self.published).push(state.clone());
    }
    fn withdraw(&self) {
        self.note("withdraw");
    }
}

impl Exiter for Recorder {
    fn exit(&self, code: i32) {
        self.note("exit");
        *lock(&self.exit_code) = Some(code);
        *lock(&self.exited) = true;
        self.exit_signal.notify_all();
    }
}

pub struct Fixture {
    pub recorder: Arc<Recorder>,
    pub lifecycle: Arc<Lifecycle>,
    pub runtime_root: tempfile::TempDir,
}

/// A lifecycle whose last client leaving stops the core at once: most tests are about what follows the stop.
pub fn fixture() -> Fixture {
    fixture_with_grace(ClientGrace::immediate(), ManualTimer::new())
}

/// A lifecycle whose no-clients grace runs on `timer`.
pub fn fixture_with_grace(grace: ClientGrace, timer: Arc<ManualTimer>) -> Fixture {
    let recorder = Arc::new(Recorder::default());
    let runtime_root = tempfile::tempdir().unwrap();
    let lifecycle = Lifecycle::with_grace(
        LifecycleConfig {
            instance_id: "instance-1".into(),
            version: "1.4.6".into(),
            runtime_root: runtime_root.path().to_owned(),
        },
        Ports {
            core: recorder.clone(),
            discovery: recorder.clone(),
            exiter: recorder.clone(),
        },
        ReleaseBudgets::default(),
        grace,
        timer,
    );
    Fixture { recorder, lifecycle, runtime_root }
}

/// The grace clock of a test: time moves only by [`ManualTimer::advance`].
#[derive(Default)]
pub struct ManualTimer {
    state: Mutex<ManualState>,
}

#[derive(Default)]
struct ManualState {
    now: Duration,
    timers: Vec<ManualEntry>,
}

struct ManualEntry {
    due: Duration,
    cancelled: Arc<AtomicBool>,
    fire: Option<Box<dyn FnOnce() + Send>>,
}

struct ManualHandle(Arc<AtomicBool>);

impl Drop for ManualHandle {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

impl ManualTimer {
    pub fn new() -> Arc<Self> {
        Arc::default()
    }

    /// Moves the clock; every timer that came due and was not cancelled fires, in due order, on this thread.
    pub fn advance(&self, by: Duration) {
        let due = {
            let mut state = lock(&self.state);
            state.now += by;
            let now = state.now;
            let (mut due, rest): (Vec<_>, Vec<_>) = std::mem::take(&mut state.timers).into_iter().partition(|entry| entry.due <= now);
            state.timers = rest;
            due.sort_by_key(|entry| entry.due);
            due
        };
        for mut entry in due {
            if !entry.cancelled.load(Ordering::SeqCst)
                && let Some(fire) = entry.fire.take()
            {
                fire();
            }
        }
    }

    /// The time left of every armed, uncancelled timer.
    pub fn armed(&self) -> Vec<Duration> {
        let state = lock(&self.state);
        state.timers.iter().filter(|entry| !entry.cancelled.load(Ordering::SeqCst)).map(|entry| entry.due - state.now).collect()
    }
}

impl GraceTimer for ManualTimer {
    fn after(&self, delay: Duration, fire: Box<dyn FnOnce() + Send>) -> Box<dyn Send> {
        let cancelled = Arc::new(AtomicBool::new(false));
        let mut state = lock(&self.state);
        let due = state.now + delay;
        state.timers.push(ManualEntry { due, cancelled: cancelled.clone(), fire: Some(fire) });
        Box::new(ManualHandle(cancelled))
    }
}
