//! One refresh per credential at a time. Concurrent callers for the same
//! credential file share the refresh already running and get its result, so a
//! single-use refresh token is never spent twice and providers keep no gate
//! of their own. The flight is keyed by the credential path and the result
//! type, process-wide: two handles on one file share it.
//!
//! A caller that arrives after the flight finished starts a new one; it
//! should re-read the credential first (another process may have refreshed
//! it), as the compare-and-swap of [`super::CredentialFile::replace_if`]
//! enforces on write.

use std::any::Any;
use std::any::TypeId;
use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::path::PathBuf;
use std::sync::LazyLock;
use std::sync::Mutex;
use std::sync::PoisonError;

use futures::FutureExt;
use futures::future::BoxFuture;
use futures::future::Shared;

type Key = (PathBuf, TypeId);

static FLIGHTS: LazyLock<Mutex<HashMap<Key, Box<dyn Any + Send>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn flights() -> std::sync::MutexGuard<'static, HashMap<Key, Box<dyn Any + Send>>> {
    FLIGHTS.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Runs `refresh` unless one with the same result type is already running for
/// `credential`; then waits for that one and returns its result.
pub(crate) async fn refresh_once<T, F>(credential: &Path, refresh: F) -> T
where
    T: Clone + Send + Sync + 'static,
    F: Future<Output = T> + Send + 'static,
{
    let key: Key = (credential.to_owned(), TypeId::of::<T>());
    let flight = {
        let mut map = flights();
        match map
            .get(&key)
            .and_then(|slot| slot.downcast_ref::<Shared<BoxFuture<'static, T>>>())
        {
            Some(running) => running.clone(),
            None => {
                let done = key.clone();
                let shared = async move {
                    let result = refresh.await;
                    flights().remove(&done);
                    result
                }
                .boxed()
                .shared();
                map.insert(key, Box::new(shared.clone()));
                shared
            }
        }
    };
    flight.await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    async fn slow(counter: Arc<AtomicUsize>, result: u32) -> u32 {
        counter.fetch_add(1, Ordering::SeqCst);
        // Each joiner re-polls the shared future, which advances one yield per
        // poll; enough yields keep the flight open until all callers joined.
        for _ in 0..100 {
            tokio::task::yield_now().await;
        }
        result
    }

    #[tokio::test]
    async fn concurrent_callers_for_one_credential_share_one_refresh() {
        let path = Path::new("a-oauth.json");
        let counter = Arc::new(AtomicUsize::new(0));
        let calls = (0..8).map(|_| refresh_once(path, slow(counter.clone(), 7)));
        let results = futures::future::join_all(calls).await;
        assert!(results.iter().all(|r| *r == 7));
        assert_eq!(counter.load(Ordering::SeqCst), 1, "one refresh for eight callers");
        // The flight is over: the next caller refreshes again.
        assert_eq!(refresh_once(path, slow(counter.clone(), 8)).await, 8);
        assert_eq!(counter.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn different_credentials_do_not_share() {
        let counter = Arc::new(AtomicUsize::new(0));
        let (a, b) = tokio::join!(
            refresh_once(Path::new("x-oauth.json"), slow(counter.clone(), 1)),
            refresh_once(Path::new("y-oauth.json"), slow(counter.clone(), 2)),
        );
        assert_eq!((a, b), (1, 2));
        assert_eq!(counter.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn a_dropped_first_caller_does_not_strand_the_others() {
        let path = Path::new("z-oauth.json");
        let counter = Arc::new(AtomicUsize::new(0));
        let first = refresh_once(path, slow(counter.clone(), 3));
        let second = refresh_once(path, slow(counter.clone(), 3));
        let mut first = Box::pin(first);
        assert!((&mut first).now_or_never().is_none(), "still pending");
        drop(first);
        assert_eq!(second.await, 3);
        assert_eq!(counter.load(Ordering::SeqCst), 1);
    }
}