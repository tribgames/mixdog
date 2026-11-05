//! Concurrent callers for one key share a single run; the entry exists only while it runs.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Mutex;

use tokio::sync::watch;

pub struct SingleFlight<V: Clone> {
    running: Mutex<HashMap<String, watch::Receiver<Option<V>>>>,
}

impl<V: Clone> Default for SingleFlight<V> {
    fn default() -> Self {
        Self {
            running: Mutex::new(HashMap::new()),
        }
    }
}

/// Removes the entry when the leader finishes or is dropped.
struct Leader<'a, V: Clone> {
    flight: &'a SingleFlight<V>,
    key: &'a str,
}

impl<V: Clone> Drop for Leader<'_, V> {
    fn drop(&mut self) {
        self.flight.running.lock().unwrap().remove(self.key);
    }
}

impl<V: Clone> SingleFlight<V> {
    /// Runs `work` unless a run for `key` is already in flight, then returns that run's value.
    /// A follower whose leader was dropped without a value becomes the next leader.
    pub async fn run<F: Future<Output = V>>(&self, key: &str, work: F) -> V {
        let mut work = Some(work);
        loop {
            let follow = {
                let mut running = self.running.lock().unwrap();
                match running.get(key) {
                    Some(rx) => Err(rx.clone()),
                    None => {
                        let (tx, rx) = watch::channel(None);
                        running.insert(key.to_owned(), rx);
                        Ok(tx)
                    }
                }
            };
            match follow {
                Ok(tx) => {
                    let _leader = Leader { flight: self, key };
                    let value = work.take().expect("leader runs once").await;
                    tx.send_replace(Some(value.clone()));
                    return value;
                }
                Err(mut rx) => {
                    if rx.wait_for(|v| v.is_some()).await.is_ok() {
                        if let Some(value) = rx.borrow().clone() {
                            return value;
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    #[tokio::test]
    async fn concurrent_callers_share_one_run() {
        let flight = SingleFlight::<u32>::default();
        let runs = AtomicUsize::new(0);
        let work = || async {
            runs.fetch_add(1, Ordering::SeqCst);
            tokio::task::yield_now().await;
            tokio::task::yield_now().await;
            7
        };
        let (a, b, c) = tokio::join!(flight.run("k", work()), flight.run("k", work()), flight.run("k", work()));
        assert_eq!((a, b, c), (7, 7, 7));
        assert_eq!(runs.load(Ordering::SeqCst), 1);
        flight.run("k", work()).await;
        assert_eq!(runs.load(Ordering::SeqCst), 2, "the entry is gone after the run");
    }
}
