//! Concurrent callers for one key share a single run; the entry exists only while it runs.
//!
//! The run is a task of its own, so no caller's cancel ends it for the others. A caller leaves by
//! dropping its `run` future (wrap the wait in `mixdog_rt::Scope::run` for a cancel token); the run
//! is cancelled, its future dropped, when the last waiter has left.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};

use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

struct Entry<V> {
    id: u64,
    waiters: usize,
    stop: CancellationToken,
    value: watch::Receiver<Option<V>>,
}

struct Flights<V> {
    next_id: u64,
    by_key: HashMap<String, Entry<V>>,
}

pub struct SingleFlight<V: Clone + Send + Sync + 'static> {
    flights: Arc<Mutex<Flights<V>>>,
}

impl<V: Clone + Send + Sync + 'static> Default for SingleFlight<V> {
    fn default() -> Self {
        Self { flights: Arc::new(Mutex::new(Flights { next_id: 0, by_key: HashMap::new() })) }
    }
}

/// One caller's place in a flight; leaving the last place cancels the run.
struct Waiter<V: Clone + Send + Sync + 'static> {
    flights: Arc<Mutex<Flights<V>>>,
    key: String,
    id: u64,
}

impl<V: Clone + Send + Sync + 'static> Drop for Waiter<V> {
    fn drop(&mut self) {
        let mut flights = self.flights.lock().unwrap();
        let Some(entry) = flights.by_key.get_mut(&self.key).filter(|e| e.id == self.id) else { return };
        entry.waiters -= 1;
        if entry.waiters == 0 {
            entry.stop.cancel();
            flights.by_key.remove(&self.key);
        }
    }
}

/// Removes the entry when the run ends, however it ends (a panic included).
struct Finish<V: Clone + Send + Sync + 'static> {
    flights: Arc<Mutex<Flights<V>>>,
    key: String,
    id: u64,
}

impl<V: Clone + Send + Sync + 'static> Drop for Finish<V> {
    fn drop(&mut self) {
        let mut flights = self.flights.lock().unwrap();
        if flights.by_key.get(&self.key).is_some_and(|e| e.id == self.id) {
            flights.by_key.remove(&self.key);
        }
    }
}

async fn lead<V: Clone + Send + Sync + 'static>(
    finish: Finish<V>,
    stop: CancellationToken,
    value: watch::Sender<Option<V>>,
    work: impl Future<Output = V>,
) {
    let _finish = finish;
    tokio::select! {
        () = stop.cancelled() => {}
        out = work => {
            value.send_replace(Some(out));
        }
    }
}

impl<V: Clone + Send + Sync + 'static> SingleFlight<V> {
    /// Returns the value of the run for `key`, starting it with `work` unless one is in flight.
    pub async fn run<F>(&self, key: &str, work: impl FnOnce() -> F) -> V
    where
        F: Future<Output = V> + Send + 'static,
    {
        let mut work = Some(work);
        loop {
            let (id, mut value) = {
                let mut flights = self.flights.lock().unwrap();
                if let Some(entry) = flights.by_key.get_mut(key) {
                    entry.waiters += 1;
                    (entry.id, entry.value.clone())
                } else {
                    let id = flights.next_id;
                    flights.next_id += 1;
                    let (sender, receiver) = watch::channel(None);
                    let stop = CancellationToken::new();
                    let run = work.take().expect("a run this caller led ended without a value")();
                    flights.by_key.insert(key.to_owned(), Entry { id, waiters: 1, stop: stop.clone(), value: receiver.clone() });
                    let finish = Finish { flights: Arc::clone(&self.flights), key: key.to_owned(), id };
                    tokio::spawn(lead(finish, stop, sender, run));
                    (id, receiver)
                }
            };
            let _waiter = Waiter { flights: Arc::clone(&self.flights), key: key.to_owned(), id };
            if let Ok(done) = value.wait_for(|v| v.is_some()).await {
                return (*done).clone().expect("wait_for returned a value");
            }
            // The run ended without a value (it panicked): a follower leads the next one.
        }
    }

    /// How many callers wait on `key`'s run.
    #[cfg(test)]
    pub(crate) fn waiters(&self, key: &str) -> usize {
        self.flights.lock().unwrap().by_key.get(key).map_or(0, |e| e.waiters)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use mixdog_rt::{Scope, Scoped};
    use tokio::sync::Notify;

    use super::*;

    #[tokio::test]
    async fn concurrent_callers_share_one_run() {
        let flight = SingleFlight::<u32>::default();
        let runs = Arc::new(AtomicUsize::new(0));
        let work = || {
            let runs = runs.clone();
            move || async move {
                runs.fetch_add(1, Ordering::SeqCst);
                tokio::task::yield_now().await;
                tokio::task::yield_now().await;
                7
            }
        };
        let (a, b, c) = tokio::join!(flight.run("k", work()), flight.run("k", work()), flight.run("k", work()));
        assert_eq!((a, b, c), (7, 7, 7));
        assert_eq!(runs.load(Ordering::SeqCst), 1);
        flight.run("k", work()).await;
        assert_eq!(runs.load(Ordering::SeqCst), 2, "the entry is gone after the run");
    }

    /// Tells the test when the run's future is dropped.
    struct DropSignal(Arc<Notify>);
    impl Drop for DropSignal {
        fn drop(&mut self) {
            self.0.notify_one();
        }
    }

    /// A run that waits on `gate`, counts itself, and signals `dropped` when its future is dropped.
    fn gated(gate: Arc<Notify>, runs: Arc<AtomicUsize>, dropped: Arc<Notify>) -> impl FnOnce() -> std::pin::Pin<Box<dyn Future<Output = u32> + Send>> {
        move || {
            Box::pin(async move {
                let _signal = DropSignal(dropped);
                runs.fetch_add(1, Ordering::SeqCst);
                gate.notified().await;
                9
            })
        }
    }

    async fn scoped(flight: &SingleFlight<u32>, cancel: &CancellationToken, work: impl FnOnce() -> std::pin::Pin<Box<dyn Future<Output = u32> + Send>>) -> Scoped<u32> {
        Scope::new().cancel(cancel).run(flight.run("k", work)).await
    }

    async fn until_waiters(flight: &SingleFlight<u32>, count: usize) {
        while flight.waiters("k") < count {
            tokio::task::yield_now().await;
        }
    }

    /// A follower that cancels leaves alone: the run goes on and the others get its value.
    #[tokio::test]
    async fn a_follower_cancelling_does_not_end_the_run_for_the_others() {
        let flight = Arc::new(SingleFlight::<u32>::default());
        let (gate, runs, dropped) = (Arc::new(Notify::new()), Arc::new(AtomicUsize::new(0)), Arc::new(Notify::new()));
        let (lead_cancel, follow_cancel) = (CancellationToken::new(), CancellationToken::new());
        let leader = tokio::spawn({
            let (flight, work, cancel) = (flight.clone(), gated(gate.clone(), runs.clone(), dropped.clone()), lead_cancel.clone());
            async move { scoped(&flight, &cancel, work).await }
        });
        until_waiters(&flight, 1).await;
        let follower = tokio::spawn({
            let (flight, work, cancel) = (flight.clone(), gated(gate.clone(), runs.clone(), dropped.clone()), follow_cancel.clone());
            async move { scoped(&flight, &cancel, work).await }
        });
        until_waiters(&flight, 2).await;
        follow_cancel.cancel();
        assert_eq!(follower.await.unwrap(), Scoped::Cancelled);
        assert_eq!(flight.waiters("k"), 1);
        gate.notify_one();
        assert_eq!(leader.await.unwrap(), Scoped::Done(9));
        assert_eq!(runs.load(Ordering::SeqCst), 1);
    }

    /// The leader's own caller cancelling does not end the run while a follower still waits.
    #[tokio::test]
    async fn the_leaders_caller_cancelling_leaves_the_run_to_the_followers() {
        let flight = Arc::new(SingleFlight::<u32>::default());
        let (gate, runs, dropped) = (Arc::new(Notify::new()), Arc::new(AtomicUsize::new(0)), Arc::new(Notify::new()));
        let (lead_cancel, follow_cancel) = (CancellationToken::new(), CancellationToken::new());
        let leader = tokio::spawn({
            let (flight, work, cancel) = (flight.clone(), gated(gate.clone(), runs.clone(), dropped.clone()), lead_cancel.clone());
            async move { scoped(&flight, &cancel, work).await }
        });
        until_waiters(&flight, 1).await;
        let follower = tokio::spawn({
            let (flight, work, cancel) = (flight.clone(), gated(gate.clone(), runs.clone(), dropped.clone()), follow_cancel.clone());
            async move { scoped(&flight, &cancel, work).await }
        });
        until_waiters(&flight, 2).await;
        lead_cancel.cancel();
        assert_eq!(leader.await.unwrap(), Scoped::Cancelled);
        gate.notify_one();
        assert_eq!(follower.await.unwrap(), Scoped::Done(9));
        assert_eq!(runs.load(Ordering::SeqCst), 1, "the follower did not start a second run");
    }

    /// The last waiter leaving drops the run's future, and the key is free for a new run.
    #[tokio::test]
    async fn the_last_waiter_leaving_cancels_the_run() {
        let flight = Arc::new(SingleFlight::<u32>::default());
        let (gate, runs, dropped) = (Arc::new(Notify::new()), Arc::new(AtomicUsize::new(0)), Arc::new(Notify::new()));
        let (first, second) = (CancellationToken::new(), CancellationToken::new());
        let a = tokio::spawn({
            let (flight, work, cancel) = (flight.clone(), gated(gate.clone(), runs.clone(), dropped.clone()), first.clone());
            async move { scoped(&flight, &cancel, work).await }
        });
        until_waiters(&flight, 1).await;
        let b = tokio::spawn({
            let (flight, work, cancel) = (flight.clone(), gated(gate.clone(), runs.clone(), dropped.clone()), second.clone());
            async move { scoped(&flight, &cancel, work).await }
        });
        until_waiters(&flight, 2).await;
        first.cancel();
        assert_eq!(a.await.unwrap(), Scoped::Cancelled);
        second.cancel();
        assert_eq!(b.await.unwrap(), Scoped::Cancelled);
        dropped.notified().await;
        assert_eq!(flight.waiters("k"), 0);
        // A later call starts a fresh run instead of joining the cancelled one.
        gate.notify_one();
        let fresh = flight.run("k", gated(gate.clone(), runs.clone(), dropped.clone())).await;
        assert_eq!((fresh, runs.load(Ordering::SeqCst)), (9, 2));
    }
}