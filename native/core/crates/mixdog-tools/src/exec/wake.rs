//! Per-thread wake control for `task wait` and the foreground shell hold
//! (`session/task-wait-control.mjs`). New user input, or a deliverable notification queued for the
//! thread, releases only a passive wait: the tool returns a running snapshot and the background
//! task keeps running. A wake is an event the session reports (`interrupt`); nothing polls.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;

use mixdog_protocol::ThreadId;
use tokio::sync::Notify;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum WakeReason {
    /// User input or steering.
    UserMessage,
    /// A deliverable task notification.
    Notification,
}

/// A wake and what caused it (the notified task id).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Wake {
    pub reason: WakeReason,
    pub detail: Option<String>,
}

/// What the session already has queued for a thread when a wait begins, so a message that
/// arrived before the wait is not missed. User input outranks a notification.
pub trait QueuedWake: Send + Sync {
    fn queued(&self, thread: &ThreadId) -> Option<Wake>;
}

#[derive(Default)]
struct Waiter {
    wake: Mutex<Option<Wake>>,
    notify: Notify,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Waiter {
    fn release(&self, wake: Wake) -> bool {
        let mut slot = lock(&self.wake);
        if slot.is_some() {
            return false;
        }
        *slot = Some(wake);
        self.notify.notify_one();
        true
    }
}

/// Where a wait that a notification cut short stands against the model's next steps.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
enum Cut {
    #[default]
    None,
    /// The cut wait's own tool batch has not reached its model-call boundary yet.
    Fresh,
    /// The boundary delivered the notification; the model has made no other call since.
    Armed,
}

#[derive(Default)]
struct ThreadState {
    /// A user message of this turn that no model-call boundary has delivered yet.
    user_pending: bool,
    /// A notification due for delivery that no boundary has delivered yet (the task id it names).
    notice_pending: Option<Option<String>>,
    cut: Cut,
}

/// Why a wait may not start.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum WaitRefusal {
    UserMessage,
    Notification,
}

#[derive(Default)]
pub struct WakeHub {
    waiters: Mutex<HashMap<ThreadId, Vec<Arc<Waiter>>>>,
    queued: Mutex<Vec<Arc<dyn QueuedWake>>>,
    state: Mutex<HashMap<ThreadId, ThreadState>>,
}

/// An active wait of one thread; dropping it ends the wait.
pub struct WaitGuard {
    hub: Arc<WakeHub>,
    thread: ThreadId,
    waiter: Arc<Waiter>,
}

impl WakeHub {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Registers a source of already-queued wakes (the session's steering queue).
    pub fn register_queued(&self, source: Arc<dyn QueuedWake>) {
        lock(&self.queued).push(source);
    }

    /// Starts a wait for `thread`. A wake already queued for it releases the wait at once.
    pub fn begin(self: &Arc<Self>, thread: &ThreadId) -> WaitGuard {
        let waiter = Arc::new(Waiter::default());
        lock(&self.waiters).entry(thread.clone()).or_default().push(waiter.clone());
        let mut queued: Option<Wake> = None;
        for source in lock(&self.queued).iter() {
            let Some(found) = source.queued(thread) else { continue };
            let is_user = found.reason == WakeReason::UserMessage;
            if queued.is_none() || is_user {
                queued = Some(found);
            }
            if is_user {
                break;
            }
        }
        // What the session reported while no wait was active: a wait registered after it must not miss it.
        if queued.is_none()
            && let Some(state) = lock(&self.state).get(thread)
        {
            queued = if state.user_pending {
                Some(Wake { reason: WakeReason::UserMessage, detail: None })
            } else {
                state.notice_pending.clone().map(|detail| Wake { reason: WakeReason::Notification, detail })
            };
        }
        if let Some(wake) = queued {
            waiter.release(wake);
        }
        WaitGuard { hub: self.clone(), thread: thread.clone(), waiter }
    }

    /// Releases every active wait of `thread`; returns how many it released.
    pub fn interrupt(&self, thread: &ThreadId, reason: WakeReason, detail: Option<String>) -> usize {
        {
            let mut states = lock(&self.state);
            let state = states.entry(thread.clone()).or_default();
            match reason {
                WakeReason::UserMessage => state.user_pending = true,
                WakeReason::Notification => state.notice_pending = Some(detail.clone()),
            }
        }
        let waiters: Vec<Arc<Waiter>> =
            lock(&self.waiters).get(thread).cloned().unwrap_or_default();
        waiters
            .iter()
            .filter(|w| w.release(Wake { reason, detail: detail.clone() }))
            .count()
    }

    /// Whether a wait may start now: not while a user message of this turn is unanswered, and not
    /// again straight after a notification cut one short with nothing else done since.
    pub fn refuse_wait(&self, thread: &ThreadId) -> Option<WaitRefusal> {
        let state = lock(&self.state);
        let state = state.get(thread)?;
        if state.user_pending {
            Some(WaitRefusal::UserMessage)
        } else if state.cut == Cut::Armed {
            Some(WaitRefusal::Notification)
        } else {
            None
        }
    }

    /// A wait ended because a notification arrived.
    pub fn cut_by_notification(&self, thread: &ThreadId) {
        lock(&self.state).entry(thread.clone()).or_default().cut = Cut::Fresh;
    }

    /// A model-call boundary of the thread's run: the cut wait's batch is over (`Fresh` becomes
    /// `Armed`), and any batch after it means the model did something else (`Armed` is cleared).
    /// `user_pending` / `notice_pending`: whether a user message, or a notification due for delivery (the
    /// task id it names), still waits in the queue after this boundary's drain.
    pub fn boundary(&self, thread: &ThreadId, user_pending: bool, notice_pending: Option<Option<String>>) {
        let mut states = lock(&self.state);
        let state = states.entry(thread.clone()).or_default();
        state.user_pending = user_pending;
        state.notice_pending = notice_pending;
        state.cut = match state.cut {
            Cut::Fresh => Cut::Armed,
            Cut::Armed | Cut::None => Cut::None,
        };
    }

    /// A run of the thread starts or ends: nothing carries over between turns.
    pub fn reset(&self, thread: &ThreadId) {
        lock(&self.state).remove(thread);
    }

    pub fn active_waits(&self, thread: &ThreadId) -> usize {
        lock(&self.waiters).get(thread).map_or(0, Vec::len)
    }
}

impl WaitGuard {
    /// Completes when the wait is released.
    pub async fn released(&self) {
        loop {
            if lock(&self.waiter.wake).is_some() {
                return;
            }
            self.waiter.notify.notified().await;
        }
    }

    /// Why the wait was released, once it was.
    pub fn wake(&self) -> Option<Wake> {
        lock(&self.waiter.wake).clone()
    }
}

impl Drop for WaitGuard {
    fn drop(&mut self) {
        let mut waiters = lock(&self.hub.waiters);
        if let Some(list) = waiters.get_mut(&self.thread) {
            list.retain(|w| !Arc::ptr_eq(w, &self.waiter));
            if list.is_empty() {
                waiters.remove(&self.thread);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Queued(Wake);
    impl QueuedWake for Queued {
        fn queued(&self, _: &ThreadId) -> Option<Wake> {
            Some(self.0.clone())
        }
    }

    #[tokio::test]
    async fn an_event_releases_an_active_wait_with_its_reason() {
        let hub = WakeHub::new();
        let thread = ThreadId::from("t");
        let guard = hub.begin(&thread);
        assert_eq!(hub.active_waits(&thread), 1);
        assert_eq!(hub.interrupt(&ThreadId::from("other"), WakeReason::UserMessage, None), 0);
        assert_eq!(hub.interrupt(&thread, WakeReason::Notification, Some("task-1".into())), 1);
        guard.released().await;
        assert_eq!(
            guard.wake(),
            Some(Wake { reason: WakeReason::Notification, detail: Some("task-1".into()) })
        );
        // The first reason stays.
        assert_eq!(hub.interrupt(&thread, WakeReason::UserMessage, None), 0);
        drop(guard);
        assert_eq!(hub.active_waits(&thread), 0);
    }

    #[tokio::test]
    async fn a_wake_queued_before_the_wait_releases_it_at_once() {
        let hub = WakeHub::new();
        hub.register_queued(Arc::new(Queued(Wake { reason: WakeReason::UserMessage, detail: None })));
        let guard = hub.begin(&ThreadId::from("t"));
        guard.released().await;
        assert_eq!(guard.wake().map(|w| w.reason), Some(WakeReason::UserMessage));
    }
}
