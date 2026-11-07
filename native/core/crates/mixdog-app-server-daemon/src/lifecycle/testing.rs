//! Recording ports for the lifecycle, control and stall tests.

use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::PoisonError;

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
    exit_signal: Condvar,
    notices: Mutex<Vec<DrainNotice>>,
    published: Mutex<Vec<DiscoveryState>>,
    cancelled: Mutex<Vec<Vec<Running>>>,
    /// Run inside `cancel_running`, on the caller's thread.
    pub on_cancel: Mutex<Option<CancelHook>>,
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
    fn exit(&self) {
        self.note("exit");
        *lock(&self.exited) = true;
        self.exit_signal.notify_all();
    }
}

pub struct Fixture {
    pub recorder: Arc<Recorder>,
    pub lifecycle: Arc<Lifecycle>,
    pub runtime_root: tempfile::TempDir,
}

pub fn fixture() -> Fixture {
    let recorder = Arc::new(Recorder::default());
    let runtime_root = tempfile::tempdir().unwrap();
    let lifecycle = Lifecycle::new(
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
    );
    Fixture { recorder, lifecycle, runtime_root }
}
