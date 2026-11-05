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

#[derive(Default)]
pub struct WakeHub {
    waiters: Mutex<HashMap<ThreadId, Vec<Arc<Waiter>>>>,
    queued: Mutex<Vec<Arc<dyn QueuedWake>>>,
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
        if let Some(wake) = queued {
            waiter.release(wake);
        }
        WaitGuard { hub: self.clone(), thread: thread.clone(), waiter }
    }

    /// Releases every active wait of `thread`; returns how many it released.
    pub fn interrupt(&self, thread: &ThreadId, reason: WakeReason, detail: Option<String>) -> usize {
        let waiters: Vec<Arc<Waiter>> =
            lock(&self.waiters).get(thread).cloned().unwrap_or_default();
        waiters
            .iter()
            .filter(|w| w.release(Wake { reason, detail: detail.clone() }))
            .count()
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
