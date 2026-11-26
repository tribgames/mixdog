//! Foreground shell concurrency admission (Node `resourceAdmission` `'shell'` pool).
//!
//! Only foreground shell runs hold a slot. Promoting a shell to the background releases its lease
//! immediately so running background jobs do not count toward the limit.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;

use async_trait::async_trait;
use tokio::sync::oneshot;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

/// Default maximum number of concurrent foreground shells (`RESOURCE_ADMISSION_DEFAULTS.maxShells`).
pub const DEFAULT_MAX_SHELLS: usize = 64;
/// Default maximum queued shell waiters (`RESOURCE_ADMISSION_DEFAULTS.maxQueue`).
pub const DEFAULT_MAX_QUEUE: usize = 1024;

/// A held foreground shell slot; dropping it releases the slot and wakes the next queued shell.
pub trait ShellLease: Send + Sync {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ShellAdmissionError {
    Cancelled,
    QueueFull(String),
}

/// Process-wide foreground shell concurrency pool.
#[async_trait]
pub trait ShellAdmission: Send + Sync {
    async fn acquire_shell(&self, owner: &str, cancel: &CancellationToken) -> Result<Box<dyn ShellLease>, ShellAdmissionError>;
}

struct Waiter {
    id: u64,
    tx: oneshot::Sender<LocalShellLease>,
}

struct State {
    active: usize,
    queue: VecDeque<Waiter>,
    next_id: u64,
}

struct Inner {
    max_shells: usize,
    max_queue: usize,
    state: Mutex<State>,
    counts: watch::Sender<(usize, usize)>,
}

impl Inner {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn publish_counts(&self, state: &State) {
        self.counts.send_replace((state.active, state.queue.len()));
    }

    fn drain(self: &Arc<Self>, state: &mut State) -> Vec<(oneshot::Sender<LocalShellLease>, LocalShellLease)> {
        let mut wake = Vec::new();
        while state.active < self.max_shells {
            let Some(waiter) = state.queue.pop_front() else { break };
            state.active += 1;
            wake.push((waiter.tx, LocalShellLease { inner: Arc::clone(self) }));
        }
        self.publish_counts(state);
        wake
    }

    fn deliver(wake: Vec<(oneshot::Sender<LocalShellLease>, LocalShellLease)>) {
        // Dropping an undelivered lease releases its slot and wakes the next waiter.
        for (tx, lease) in wake {
            let _ = tx.send(lease);
        }
    }

    fn release_slot(self: &Arc<Self>) {
        let wake = {
            let mut state = self.lock();
            state.active = state.active.saturating_sub(1);
            self.drain(&mut state)
        };
        Self::deliver(wake);
    }
}

struct LocalShellLease {
    inner: Arc<Inner>,
}

impl ShellLease for LocalShellLease {}

impl Drop for LocalShellLease {
    fn drop(&mut self) {
        self.inner.release_slot();
    }
}

fn floored(value: Option<String>) -> Option<i64> {
    let parsed = mixdog_js::string_to_number(value?.as_str());
    parsed.is_finite().then(|| parsed.floor() as i64)
}

/// Default standalone foreground shell pool used when no host-wide `ResourceAdmission` is bound.
pub struct LocalShellAdmission {
    inner: Arc<Inner>,
}

impl LocalShellAdmission {
    pub fn new(max_shells: usize, max_queue: usize) -> Self {
        let (counts, _) = watch::channel((0, 0));
        Self {
            inner: Arc::new(Inner {
                max_shells: max_shells.max(1),
                max_queue,
                state: Mutex::new(State { active: 0, queue: VecDeque::new(), next_id: 0 }),
                counts,
            }),
        }
    }

    pub fn from_env(env: &dyn Fn(&str) -> Option<String>) -> Self {
        let max_shells = floored(env("MIXDOG_MAX_CONCURRENT_SHELLS")).filter(|v| *v >= 1).map_or(DEFAULT_MAX_SHELLS, |v| v as usize);
        let max_queue = floored(env("MIXDOG_RESOURCE_MAX_QUEUE")).filter(|v| *v >= 0).map_or(DEFAULT_MAX_QUEUE, |v| v as usize);
        Self::new(max_shells, max_queue)
    }

    pub fn max_shells(&self) -> usize {
        self.inner.max_shells
    }

    pub fn active(&self) -> usize {
        self.inner.lock().active
    }

    pub fn queued(&self) -> usize {
        self.inner.lock().queue.len()
    }

    /// Resolves once `(active, queued)` reaches `(want_active, want_queued)`.
    pub async fn wait_counts(&self, want_active: usize, want_queued: usize) {
        let mut rx = self.inner.counts.subscribe();
        let _ = rx.wait_for(|&(active, queued)| active == want_active && queued == want_queued).await;
    }
}

struct QueueGuard {
    inner: Arc<Inner>,
    id: u64,
    armed: bool,
}

impl Drop for QueueGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let mut state = self.inner.lock();
        if let Some(pos) = state.queue.iter().position(|w| w.id == self.id) {
            state.queue.remove(pos);
            self.inner.publish_counts(&state);
        }
    }
}

#[async_trait]
impl ShellAdmission for LocalShellAdmission {
    async fn acquire_shell(&self, _owner: &str, cancel: &CancellationToken) -> Result<Box<dyn ShellLease>, ShellAdmissionError> {
        if cancel.is_cancelled() {
            return Err(ShellAdmissionError::Cancelled);
        }
        let (mut rx, id) = {
            let mut state = self.inner.lock();
            if state.active < self.inner.max_shells && state.queue.is_empty() {
                state.active += 1;
                self.inner.publish_counts(&state);
                return Ok(Box::new(LocalShellLease { inner: Arc::clone(&self.inner) }));
            }
            if state.queue.len() >= self.inner.max_queue {
                return Err(ShellAdmissionError::QueueFull(format!(
                    "resource pressure: high-load admission queue full (maximum {}); retry after running work completes",
                    self.inner.max_queue
                )));
            }
            let (tx, rx) = oneshot::channel();
            state.next_id += 1;
            let id = state.next_id;
            state.queue.push_back(Waiter { id, tx });
            self.inner.publish_counts(&state);
            (rx, id)
        };
        let mut guard = QueueGuard { inner: Arc::clone(&self.inner), id, armed: true };
        tokio::select! {
            biased;
            granted = &mut rx => {
                guard.armed = false;
                match granted {
                    Ok(lease) => Ok(Box::new(lease)),
                    Err(_) => Err(ShellAdmissionError::Cancelled),
                }
            }
            () = cancel.cancelled() => {
                drop(guard);
                // Dropping `rx` drops any buffered `LocalShellLease`, releasing its slot.
                drop(rx);
                Err(ShellAdmissionError::Cancelled)
            }
        }
    }
}
