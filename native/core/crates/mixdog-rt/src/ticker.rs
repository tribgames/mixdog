//! The core ticker (P §4.7, R13): one task on RT-C serves every deadline of the process.
//!
//! A deadline is an absolute [`Instant`] plus a callback; the ticker puts it on the tokio clock
//! (its distance from now) so a paused or advanced test clock moves it too. The ticker keeps them ordered, sleeps
//! until the earliest, runs the due callbacks and sleeps again; it never polls. Registering an
//! earlier deadline than the current first wakes it to re-arm. There is no task or timer per
//! deadline, so a million pending expiries cost a map entry each.
//!
//! Callbacks run inside a poll of the ticker task (RT-C, 5 ms bound): they must only flip a
//! flag, send on a channel or `notify`, never block, do I/O or take long. A panicking callback
//! is contained and does not stop the ticker. For "sleep until" inside async code use
//! [`Ticker::wait_until`].

use std::collections::BTreeMap;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::panic::catch_unwind;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::OnceLock;
use std::time::Instant;

use tokio::sync::Notify;
use tokio::sync::oneshot;

use crate::TaskClass;
use crate::scoped::on_tokio_clock;

type Callback = Box<dyn FnOnce() + Send>;

#[derive(Default)]
struct State {
    next_id: u64,
    /// Ordered by deadline (tokio clock), then registration order.
    pending: BTreeMap<(tokio::time::Instant, u64), Callback>,
}

struct Shared {
    state: Mutex<State>,
    /// Wakes the ticker task when the earliest deadline changes.
    changed: Notify,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// A deadline scheduler backed by a single task on RT-C.
#[derive(Clone)]
pub struct Ticker {
    shared: Arc<Shared>,
}

/// Cancels one registered deadline. Dropping it does **not** cancel: the callback still fires.
#[must_use = "dropping the handle keeps the deadline armed; call cancel() to disarm it"]
pub struct TimerHandle {
    shared: Arc<Shared>,
    key: (tokio::time::Instant, u64),
}

impl TimerHandle {
    /// Disarms the deadline. Returns `true` if it had not fired yet (its callback will never
    /// run), `false` if it already fired or was taken for firing.
    pub fn cancel(self) -> bool {
        self.shared.lock().pending.remove(&self.key).is_some()
    }
}

impl Ticker {
    /// Starts a ticker task on RT-C. Most code uses the process-wide [`ticker`]. Requires an
    /// installed backend.
    pub fn start() -> Self {
        let shared = Arc::new(Shared {
            state: Mutex::new(State::default()),
            changed: Notify::new(),
        });
        // Detached: the task lives as long as the runtime.
        drop(crate::spawn(
            "core-ticker",
            TaskClass::Control,
            run(shared.clone()),
        ));
        Self { shared }
    }

    /// Runs `callback` once at `at` (immediately, on the next tick, if `at` has passed).
    pub fn register(&self, at: Instant, callback: impl FnOnce() + Send + 'static) -> TimerHandle {
        let key;
        let earliest;
        {
            let mut state = self.shared.lock();
            state.next_id += 1;
            key = (on_tokio_clock(at), state.next_id);
            state.pending.insert(key, Box::new(callback));
            earliest = state.pending.keys().next() == Some(&key);
        }
        if earliest {
            self.shared.changed.notify_waiters();
        }
        TimerHandle {
            shared: self.shared.clone(),
            key,
        }
    }

    /// Resolves at `at`. Cancel-safe: dropping the future disarms the deadline.
    pub fn wait_until(&self, at: Instant) -> impl Future<Output = ()> + Send + use<> {
        let (tx, rx) = oneshot::channel();
        let handle = self.register(at, move || {
            let _ = tx.send(());
        });
        let guard = DisarmOnDrop(Some(handle));
        async move {
            let _guard = guard;
            let _ = rx.await;
        }
    }

    /// Deadlines currently armed.
    pub fn pending(&self) -> usize {
        self.shared.lock().pending.len()
    }
}

struct DisarmOnDrop(Option<TimerHandle>);

impl Drop for DisarmOnDrop {
    fn drop(&mut self) {
        if let Some(handle) = self.0.take() {
            let _ = handle.cancel();
        }
    }
}

/// The process-wide ticker, started on first use. Requires an installed backend.
pub fn ticker() -> &'static Ticker {
    static TICKER: OnceLock<Ticker> = OnceLock::new();
    TICKER.get_or_init(Ticker::start)
}

async fn run(shared: Arc<Shared>) {
    loop {
        // Registered before the scan, so a deadline added meanwhile is not missed.
        let changed = shared.changed.notified();
        tokio::pin!(changed);
        changed.as_mut().enable();

        let now = tokio::time::Instant::now();
        let (due, next) = {
            let mut state = shared.lock();
            let later = state.pending.split_off(&(now, u64::MAX));
            let due = std::mem::replace(&mut state.pending, later);
            (due, state.pending.keys().next().map(|(at, _)| *at))
        };
        for callback in due.into_values() {
            let _ = catch_unwind(AssertUnwindSafe(callback));
        }
        if let Some(at) = next {
            let _ = tokio::time::timeout_at(at, changed).await;
        } else {
            changed.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    /// The clock is advanced far from the std clock before the deadline is registered. On a
    /// std-instant scan the ticker saw the deadline as never due and re-armed it in a loop.
    #[tokio::test(start_paused = true)]
    async fn a_deadline_registered_after_the_clock_advanced_fires_at_its_distance() {
        let shared = Arc::new(Shared { state: Mutex::new(State::default()), changed: Notify::new() });
        let ticker = Ticker { shared: shared.clone() };
        let task = tokio::spawn(run(shared));
        tokio::time::advance(Duration::from_secs(3600)).await;
        let started = tokio::time::Instant::now();
        let (tx, rx) = oneshot::channel();
        let _ = ticker.register(Instant::now() + Duration::from_secs(10), move || {
            let _ = tx.send(tokio::time::Instant::now());
        });
        let fired = tokio::time::timeout(Duration::from_secs(60), rx).await.expect("fired inside the bound").unwrap();
        // The std clock moved a few microseconds between `Instant::now()` and the registration.
        let waited = fired - started;
        assert!(waited > Duration::from_secs(9) && waited <= Duration::from_secs(10), "{waited:?}");
        task.abort();
    }
}
