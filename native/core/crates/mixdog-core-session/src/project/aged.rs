//! A bounded-age answer per key with one load at a time: callers that arrive while a load runs wait for
//! it and take its answer, and an answer younger than `ttl` is served without loading again. The
//! worktree preview and the stored-session marks it reads are asked for by every open composer, so
//! without this each ask repeats the same scan.

use std::collections::HashMap;
use std::future::Future;
use std::hash::Hash;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

/// One key's held answer, loaded by one caller at a time: `gate` serializes the loads (held across the load's awaits) and the answer\n/// itself is read and written in short sections only.
struct Held<V> {
    gate: tokio::sync::Semaphore,
    kept: Mutex<Option<Kept<V>>>,
}

impl<V> Default for Held<V> {
    fn default() -> Self {
        Self { gate: tokio::sync::Semaphore::new(1), kept: Mutex::new(None) }
    }
}

type Slot<V> = Arc<Held<V>>;

/// A held answer: when it was loaded, the epoch and version it was loaded at, and the answer.
type Kept<V> = (Instant, (u64, u64), V);

pub struct Aged<K, V> {
    ttl: Duration,
    slots: Mutex<HashMap<K, Slot<V>>>,
    /// Moves on [`Aged::forget`]: an answer stored under an older value is stale whatever its age.
    epoch: AtomicU64,
}

impl<K: Eq + Hash, V: Clone> Aged<K, V> {
    pub fn new(ttl: Duration) -> Self {
        Self { ttl, slots: Mutex::default(), epoch: AtomicU64::new(0) }
    }

    /// The answer for `key`: the held one while younger than `ttl`, else the result of `load`. A failed
    /// load is not kept; the next caller loads again.
    pub async fn get<E, F, Fut>(&self, key: K, load: F) -> Result<V, E>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<V, E>>,
    {
        self.get_at(key, 0, load).await
    }

    /// [`Aged::get`] for an answer derived from state that has its own version: the held answer is served only when it was
    /// loaded at `version` too, whatever its age, so the age bound is a cost limit and never what correctness rests on.
    pub async fn get_at<E, F, Fut>(&self, key: K, version: u64, load: F) -> Result<V, E>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<V, E>>,
    {
        let slot = self.slots.lock().unwrap_or_else(PoisonError::into_inner).entry(key).or_default().clone();
        let _turn = slot.gate.acquire().await.expect("a load gate is never closed");
        let born_now = (self.epoch.load(Ordering::Acquire), version);
        if let Some((at, born, value)) = slot.kept.lock().unwrap_or_else(PoisonError::into_inner).as_ref()
            && *born == born_now
            && at.elapsed() < self.ttl
        {
            return Ok(value.clone());
        }
        let value = load().await?;
        *slot.kept.lock().unwrap_or_else(PoisonError::into_inner) = Some((Instant::now(), born_now, value.clone()));
        Ok(value)
    }

    /// Drops every held answer: what they describe has changed.
    pub fn forget(&self) {
        self.epoch.fetch_add(1, Ordering::AcqRel);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;

    use super::*;

    #[tokio::test]
    async fn an_answer_is_served_only_at_the_version_it_was_loaded_at() {
        let (aged, loads) = (Aged::new(Duration::from_secs(60)), AtomicUsize::new(0));
        let ask = |version| aged.get_at::<(), _, _>("repo", version, || async { Ok(loads.fetch_add(1, Ordering::SeqCst) + 1) });
        assert_eq!(ask(7).await, Ok(1));
        assert_eq!(ask(7).await, Ok(1), "the same version is served as held, however many asks");
        assert_eq!(ask(8).await, Ok(2), "a moved version is loaded again though the answer is young");
    }

    #[tokio::test]
    async fn a_failed_load_is_not_kept() {
        let aged: Aged<&str, usize> = Aged::new(Duration::from_secs(60));
        assert!(aged.get("repo", || async { Err::<usize, _>("busy") }).await.is_err());
        assert_eq!(aged.get::<&str, _, _>("repo", || async { Ok(7) }).await, Ok(7));
    }


    async fn counted(aged: &Aged<&'static str, usize>, loads: &AtomicUsize, key: &'static str) -> usize {
        aged.get::<(), _, _>(key, || async {
            loads.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(50)).await;
            Ok(loads.load(Ordering::SeqCst))
        })
        .await
        .unwrap()
    }
    #[tokio::test]
    async fn overlapping_asks_for_one_key_share_one_load() {
        let (aged, loads) = (Arc::new(Aged::new(Duration::from_secs(60))), Arc::new(AtomicUsize::new(0)));
        let asks: Vec<_> = (0..8)
            .map(|_| {
                let (aged, loads) = (aged.clone(), loads.clone());
                tokio::spawn(async move { counted(&aged, &loads, "repo").await })
            })
            .collect();
        for ask in asks {
            assert_eq!(ask.await.unwrap(), 1);
        }
        assert_eq!(loads.load(Ordering::SeqCst), 1, "eight overlapping asks are one load");
        counted(&aged, &loads, "other").await;
        assert_eq!(loads.load(Ordering::SeqCst), 2, "another key has its own answer");
    }
    #[tokio::test]
    async fn an_answer_is_served_until_it_is_older_than_the_bound_or_forgotten() {
        let (aged, loads) = (Aged::new(Duration::from_millis(200)), AtomicUsize::new(0));
        counted(&aged, &loads, "repo").await;
        counted(&aged, &loads, "repo").await;
        assert_eq!(loads.load(Ordering::SeqCst), 1, "a young answer is served as held");
        aged.forget();
        counted(&aged, &loads, "repo").await;
        assert_eq!(loads.load(Ordering::SeqCst), 2, "a forgotten answer is loaded again");
        tokio::time::sleep(Duration::from_millis(250)).await;
        counted(&aged, &loads, "repo").await;
        assert_eq!(loads.load(Ordering::SeqCst), 3, "an answer older than the bound is loaded again");
    }
}
