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
use std::sync::Arc;
use std::sync::LazyLock;
use std::sync::Mutex;
use std::sync::PoisonError;

use futures::FutureExt;
use futures::future::BoxFuture;
use futures::future::Shared;
use mixdog_rt::Expired;

use crate::transport::deadlines::REFRESH_FLIGHT;

type Key = (PathBuf, TypeId);

/// A running flight: its identity (what its end removes, and nothing put there after it) and its shared result.
type Flight = (Arc<()>, Box<dyn Any + Send>);

static FLIGHTS: LazyLock<Mutex<HashMap<Key, Flight>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn flights() -> std::sync::MutexGuard<'static, HashMap<Key, Flight>> {
    FLIGHTS.lock().unwrap_or_else(PoisonError::into_inner)
}

/// No flight is running for a caller after this one, as in a new process; a flight still running ends on its own.
#[cfg(any(test, feature = "test-support"))]
pub(crate) fn reset() {
    flights().clear();
}

/// Runs `refresh` unless one with the same result type is already running for
/// `credential`; then waits for that one and returns its result, or the
/// [`Expired`] that ended the flight. The refresh runs to its end as a task of
/// its own, as Node's promise does, whether or not a caller still waits: a
/// refreshed credential is written even when every caller went away.
pub(crate) async fn refresh_once<T, F>(credential: &Path, refresh: F) -> Result<T, Expired>
where
    T: Clone + Send + Sync + 'static,
    F: Future<Output = T> + Send + 'static,
{
    let key: Key = (credential.to_owned(), TypeId::of::<T>());
    let flight = {
        let mut map = flights();
        match map
            .get(&key)
            .and_then(|(_, slot)| slot.downcast_ref::<Shared<BoxFuture<'static, Result<T, Expired>>>>())
        {
            Some(running) => running.clone(),
            None => {
                let (done, identity) = (key.clone(), Arc::new(()));
                let ours = identity.clone();
                let task = tokio::spawn(async move {
                    // An expired flight leaves the map like a finished one, and every joiner
                    // gets the same typed failure instead of a dead flight.
                    let result = REFRESH_FLIGHT.bound_head(refresh).await;
                    let mut map = flights();
                    if map.get(&done).is_some_and(|(id, _)| Arc::ptr_eq(id, &ours)) {
                        map.remove(&done);
                    }
                    result
                });
                let shared = async move {
                    match task.await {
                        Ok(result) => result,
                        Err(error) if error.is_panic() => std::panic::resume_unwind(error.into_panic()),
                        Err(error) => panic!("the refresh flight was cancelled: {error}"),
                    }
                }
                .boxed()
                .shared();
                map.insert(key, (identity, Box::new(shared.clone())));
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
        assert!(results.iter().all(|r| *r == Ok(7)));
        assert_eq!(
            counter.load(Ordering::SeqCst),
            1,
            "one refresh for eight callers"
        );
        // The flight is over: the next caller refreshes again.
        assert_eq!(refresh_once(path, slow(counter.clone(), 8)).await, Ok(8));
        assert_eq!(counter.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn different_credentials_do_not_share() {
        let counter = Arc::new(AtomicUsize::new(0));
        let (a, b) = tokio::join!(
            refresh_once(Path::new("x-oauth.json"), slow(counter.clone(), 1)),
            refresh_once(Path::new("y-oauth.json"), slow(counter.clone(), 2)),
        );
        assert_eq!((a, b), (Ok(1), Ok(2)));
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
        assert_eq!(second.await, Ok(3));
        assert_eq!(counter.load(Ordering::SeqCst), 1);
    }

    // Node's refresh promise runs to its end when its callers went away; the refreshed credential is written.
    #[tokio::test(start_paused = true)]
    async fn a_refresh_whose_callers_all_went_away_runs_to_its_end() {
        let (ended, end) = tokio::sync::oneshot::channel();
        let refresh = async move {
            tokio::task::yield_now().await;
            ended.send(()).ok();
            4u32
        };
        let mut caller = Box::pin(refresh_once(Path::new("left-oauth.json"), refresh));
        assert!((&mut caller).now_or_never().is_none(), "the refresh is under way");
        drop(caller);
        let deadline = std::time::Duration::from_secs(60);
        assert!(matches!(tokio::time::timeout(deadline, end).await, Ok(Ok(()))), "the refresh ended with no caller waiting");
    }

    // A replay starts as a new process: a refresh left running by an earlier one is not joined.
    #[tokio::test(start_paused = true)]
    async fn after_a_reset_the_next_caller_starts_its_own_refresh() {
        let path = Path::new("reset-oauth.json");
        let mut left = Box::pin(refresh_once(path, std::future::pending::<u32>()));
        assert!((&mut left).now_or_never().is_none(), "the refresh is under way");
        drop(left);
        reset();
        assert_eq!(refresh_once(path, async { 9u32 }).await, Ok(9));
    }

    #[tokio::test(start_paused = true)]
    async fn a_refresh_that_never_answers_ends_and_frees_the_credential() {
        let path = Path::new("hung-oauth.json");
        let owner = refresh_once(path, std::future::pending::<u32>());
        let joiner = refresh_once(path, std::future::pending::<u32>());
        let (owner, joiner) = tokio::join!(owner, joiner);
        let expired = Err(Expired {
            after: std::time::Duration::from_secs(150),
        });
        assert_eq!((owner, joiner), (expired, expired));
        // The dead flight is gone: the next caller starts a new refresh.
        assert_eq!(refresh_once(path, async { 5u32 }).await, Ok(5));
    }
}
