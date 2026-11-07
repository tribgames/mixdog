//! One single-flight slot with a task of its own, for Node's shared in-flight promise
//! (`let inflight = ..; promise.then(clear, clear)`: `providers/model-proxy-provider.mjs:318-321`,
//! `session-runtime-inline-host/boot-loaders.mjs:93-107`).
//!
//! Node's promise runs on its own, is shared by every caller that finds it, and its slot is emptied
//! when it settles, however it settles. Here:
//! - the work is a spawned task, so a caller that drops (a cancelled turn) does not stop it; callers
//!   only await its [`Join`];
//! - the slot is emptied by a guard that is created before the task is spawned and moved into the
//!   task's future, so it drops whenever that future does: on completion, on a panic, and when the
//!   runtime drops the task before its first poll;
//! - a task that ends abnormally (panic, shutdown) resolves its [`Join`] with the caller's
//!   `abnormal` value built from the `JoinError`, as Node's promise rejects;
//! - nothing stored in the slot refers to the owner of the state: the [`Join`] awaits a handle only.
//!
//! The slot lives next to the owner's own state `S` (a cache, a signature) under one lock, so a
//! caller checks that state, joins or starts a flight and publishes under it ([`Core::holds`] is
//! Node's `inflight === entry`). The lock is a std mutex and is never held across an await or a
//! spawn: [`SingleFlight::start`] takes the guard and releases it before it calls the caller's work
//! constructor and spawns, because a constructor that panics, or a runtime that is shutting down and
//! drops the task inside `spawn`, drops the flight's guard, which locks.

use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use futures::future::{BoxFuture, FutureExt, Shared};
use mixdog_rt::TaskClass;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

/// The result of a flight, shared by every caller.
pub type Join<T> = Shared<BoxFuture<'static, T>>;

struct Slot<K, T> {
    id: u64,
    key: K,
    join: Join<T>,
}

/// The state under the lock: the owner's `state`, and the flight in flight.
pub struct Core<S, K, T> {
    pub state: S,
    slot: Option<Slot<K, T>>,
    issued: u64,
}

impl<S, K, T: Clone + Send + Sync + 'static> Core<S, K, T> {
    /// The flight in flight: the key it was started with, and its result.
    pub fn joinable(&self) -> Option<(&K, Join<T>)> {
        self.slot.as_ref().map(|slot| (&slot.key, slot.join.clone()))
    }

    /// Whether `id` is still the flight in the slot (Node `inflight === entry`).
    pub fn holds(&self, id: u64) -> bool {
        self.slot.as_ref().is_some_and(|slot| slot.id == id)
    }

    pub fn is_idle(&self) -> bool {
        self.slot.is_none()
    }
}

/// Empties the slot that still holds this flight (Node `clear`).
struct ClearSlot<S, K, T> {
    core: Arc<Mutex<Core<S, K, T>>>,
    id: u64,
}

impl<S, K, T> Drop for ClearSlot<S, K, T> {
    fn drop(&mut self) {
        let mut core = self.core.lock().unwrap_or_else(PoisonError::into_inner);
        if core.slot.as_ref().is_some_and(|slot| slot.id == self.id) {
            core.slot = None;
        }
    }
}

pub struct SingleFlight<S, K, T>(Arc<Mutex<Core<S, K, T>>>);

impl<S, K, T> Clone for SingleFlight<S, K, T> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

impl<S: Default, K, T> Default for SingleFlight<S, K, T> {
    fn default() -> Self {
        Self::new(S::default())
    }
}

impl<S, K, T> SingleFlight<S, K, T> {
    pub fn new(state: S) -> Self {
        Self(Arc::new(Mutex::new(Core { state, slot: None, issued: 0 })))
    }

    pub fn lock(&self) -> MutexGuard<'_, Core<S, K, T>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl<S, K, T> SingleFlight<S, K, T>
where
    S: Send + 'static,
    K: Send + 'static,
    T: Clone + Send + Sync + 'static,
{
    /// Starts a flight in the slot. `work` is given the flight's id; `abnormal` turns the message of
    /// an abnormal end into the result the callers see. `core` is released before `work` is called
    /// and the task spawns.
    pub fn start<W>(
        &self,
        name: &'static str,
        core: MutexGuard<'_, Core<S, K, T>>,
        key: K,
        work: impl FnOnce(u64) -> W,
        abnormal: fn(String) -> T,
    ) -> Join<T>
    where
        W: Future<Output = T> + Send + 'static,
    {
        self.start_on(|task| mixdog_rt::spawn(name, TaskClass::Work, task), core, key, work, abnormal)
    }

    pub(crate) fn start_on<W>(
        &self,
        spawn: impl FnOnce(BoxFuture<'static, T>) -> JoinHandle<T>,
        mut core: MutexGuard<'_, Core<S, K, T>>,
        key: K,
        work: impl FnOnce(u64) -> W,
        abnormal: fn(String) -> T,
    ) -> Join<T>
    where
        W: Future<Output = T> + Send + 'static,
    {
        core.issued += 1;
        let id = core.issued;
        let (send, handle) = oneshot::channel::<JoinHandle<T>>();
        let join = async move {
            match handle.await {
                Ok(handle) => handle.await.unwrap_or_else(|error| abnormal(error.to_string())),
                Err(_) => abnormal("the flight was never started".to_owned()),
            }
        }
        .boxed()
        .shared();
        core.slot = Some(Slot { id, key, join: join.clone() });
        drop(core);
        // Armed once the lock is released and the slot is installed: `work(id)` (the caller's
        // constructor) may panic, and unwinding drops this guard, which locks. Created before the
        // spawn: a task dropped before its first poll drops this with its future. If the constructor
        // panics, `send` drops with it and the waiters that joined resolve through `abnormal`.
        let clear = ClearSlot { core: self.0.clone(), id };
        let work = work(id);
        let handle = spawn(
            async move {
                let _clear = clear;
                work.await
            }
            .boxed(),
        );
        // `join` holds the receiver and is returned below, so the handle is always taken.
        drop(send.send(handle));
        join
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use tokio::sync::Notify;

    use super::*;

    type Outcome = Result<u32, String>;
    type Flights = SingleFlight<(), u8, Outcome>;

    fn abnormal(message: String) -> Outcome {
        Err(message)
    }

    /// The runtime's abort hook: the task is dropped before it is ever polled.
    fn aborted(task: BoxFuture<'static, Outcome>) -> JoinHandle<Outcome> {
        let handle = tokio::task::spawn(task);
        handle.abort();
        handle
    }

    fn plain(task: BoxFuture<'static, Outcome>) -> JoinHandle<Outcome> {
        tokio::task::spawn(task)
    }

    struct Dies;

    impl Future for Dies {
        type Output = Outcome;

        fn poll(self: std::pin::Pin<&mut Self>, _: &mut std::task::Context<'_>) -> std::task::Poll<Outcome> {
            panic!("the work died");
        }
    }

    #[tokio::test]
    async fn a_task_dropped_before_its_first_poll_clears_its_slot_and_rejects_its_callers() {
        let flights = Flights::default();
        let ran = Arc::new(AtomicBool::new(false));
        let join = flights.start_on(
            aborted,
            flights.lock(),
            1,
            |_| {
                let ran = ran.clone();
                async move {
                    ran.store(true, Ordering::SeqCst);
                    Ok(1)
                }
            },
            abnormal,
        );
        let failure = join.await.unwrap_err();
        assert!(failure.contains("cancel"), "{failure}");
        assert!(!ran.load(Ordering::SeqCst), "the work never ran");
        assert!(flights.lock().is_idle(), "the slot is empty, so the next call starts again");
        let again = flights.start_on(plain, flights.lock(), 2, |_| async { Ok(7) }, abnormal);
        assert_eq!(again.await, Ok(7), "no caller joins the retained failure");
    }

    #[tokio::test]
    async fn a_failure_reaches_every_waiter_and_empties_the_slot() {
        let flights = Flights::default();
        let gate = Arc::new(Notify::new());
        let first = flights.start_on(
            plain,
            flights.lock(),
            1,
            |_| {
                let gate = gate.clone();
                async move {
                    gate.notified().await;
                    Err("boom".to_owned())
                }
            },
            abnormal,
        );
        let second = {
            let core = flights.lock();
            let (key, join) = core.joinable().expect("the flight is in the slot");
            assert_eq!(*key, 1);
            join
        };
        gate.notify_one();
        assert_eq!(first.await, Err("boom".to_owned()));
        assert_eq!(second.await, Err("boom".to_owned()));
        assert!(flights.lock().is_idle());
    }

    #[test]
    fn a_work_constructor_that_panics_leaves_no_flight_and_does_not_deadlock() {
        let flights = Flights::default();
        let started = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            flights.start_on(plain, flights.lock(), 1, |_| -> std::future::Ready<Outcome> { panic!("the work constructor died") }, abnormal)
        }));
        assert!(started.is_err(), "the panic reaches the caller that started the flight");
        // The unwinding guard locked the mutex after the caller's guard was released.
        assert!(flights.lock().is_idle(), "the slot is empty, so the next call starts again");
    }

    #[tokio::test(start_paused = true)]
    async fn a_task_that_panics_rejects_its_callers_and_empties_the_slot() {
        mixdog_rt::testing::tokens();
        let flights = Flights::default();
        let join = flights.start("test-flight", flights.lock(), 1, |_| Dies, abnormal);
        let failure = join.await.unwrap_err();
        assert!(failure.contains("panicked"), "{failure}");
        assert!(flights.lock().is_idle());
    }

    #[tokio::test]
    async fn a_waiter_that_drops_does_not_stop_the_work() {
        let flights = Flights::default();
        let gate = Arc::new(Notify::new());
        let done = Arc::new(Notify::new());
        let join = flights.start_on(
            plain,
            flights.lock(),
            1,
            |_| {
                let (gate, done) = (gate.clone(), done.clone());
                async move {
                    gate.notified().await;
                    done.notify_one();
                    Ok(3)
                }
            },
            abnormal,
        );
        let kept = join.clone();
        drop(join);
        gate.notify_one();
        done.notified().await;
        assert_eq!(kept.await, Ok(3));
        assert!(flights.lock().is_idle());
    }
}