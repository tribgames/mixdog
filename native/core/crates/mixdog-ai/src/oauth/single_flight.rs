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

/// Takes a flight out of the map however its task ends: returned, expired, panicked, or dropped unfinished with its
/// runtime. A flight whose task is gone can never be joined, so the next caller starts its own refresh.
struct Landed {
    key: Key,
    identity: Arc<()>,
}

impl Drop for Landed {
    fn drop(&mut self) {
        let mut map = flights();
        if map.get(&self.key).is_some_and(|(id, _)| Arc::ptr_eq(id, &self.identity)) {
            map.remove(&self.key);
        }
    }
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
    let (flight, start) = {
        let mut map = flights();
        match map
            .get(&key)
            .and_then(|(_, slot)| slot.downcast_ref::<Shared<BoxFuture<'static, Result<T, Expired>>>>())
        {
            Some(running) => (running.clone(), None),
            None => {
                let identity = Arc::new(());
                let landed = Landed { key: key.clone(), identity: identity.clone() };
                let (started, task) = tokio::sync::oneshot::channel::<tokio::task::JoinHandle<Result<T, Expired>>>();
                let shared = async move {
                    // The task is handed over right after the flight is in the map (below).
                    let Ok(task) = task.await else { panic!("the refresh flight was never started") };
                    match task.await {
                        Ok(result) => result,
                        Err(error) if error.is_panic() => std::panic::resume_unwind(error.into_panic()),
                        Err(error) => panic!("the refresh flight was cancelled: {error}"),
                    }
                }
                .boxed()
                .shared();
                map.insert(key, (identity, Box::new(shared.clone())));
                (shared, Some((landed, started)))
            }
        }
    };
    // Spawned once the map's lock is released: a runtime that has shut down drops a task where it is spawned,
    // and that drop takes the flight out of the map (`Landed`), which needs the lock.
    if let Some((landed, started)) = start {
        let task = tokio::spawn(async move {
            // An expired flight leaves the map like a finished one, and every joiner
            // gets the same typed failure instead of a dead flight.
            let result = REFRESH_FLIGHT.bound_head(refresh).await;
            drop(landed);
            result
        });
        // The flight's own receiver lives in the map's entry or in a caller; with both gone nobody waits.
        let _ = started.send(task);
    }
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

    // A replay starts as a new process: a refresh left running by an earlier one is not joined. The reset is the
    // one a replay makes (`reset_process_state`), so dropping this module's call from it fails here.
    #[tokio::test(start_paused = true)]
    async fn after_a_reset_the_next_caller_starts_its_own_refresh() {
        let path = Path::new("reset-oauth.json");
        let mut left = Box::pin(refresh_once(path, std::future::pending::<u32>()));
        assert!((&mut left).now_or_never().is_none(), "the refresh is under way");
        drop(left);
        crate::reset_process_state();
        assert_eq!(refresh_once(path, async { 9u32 }).await, Ok(9));
    }

    async fn broken() -> u32 {
        panic!("the refresh broke")
    }

    // A refresh that panicked is over: its callers get the panic, the next caller a refresh of its own.
    #[tokio::test]
    async fn a_refresh_that_panicked_is_not_joined_by_the_next_caller() {
        let path = Path::new("panicked-oauth.json");
        let first = tokio::spawn(refresh_once(path, broken()));
        assert!(first.await.is_err_and(|error| error.is_panic()), "the caller of the broken refresh gets its panic");
        assert_eq!(refresh_once(path, async { 6u32 }).await, Ok(6));
    }

    // A runtime that ends drops the refresh it was running; a later runtime of the process starts its own.
    #[test]
    fn a_refresh_dropped_with_its_runtime_is_not_joined_in_the_next() {
        let path = Path::new("shutdown-oauth.json");
        let runtime = || tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let first = runtime();
        first.block_on(async {
            let (running, run) = tokio::sync::oneshot::channel();
            let refresh = async move {
                running.send(()).ok();
                std::future::pending::<u32>().await
            };
            let mut caller = Box::pin(refresh_once(path, refresh));
            assert!((&mut caller).now_or_never().is_none(), "the refresh is under way");
            // The refresh's own task says it runs, so what the runtime drops is a refresh in flight.
            let deadline = std::time::Duration::from_secs(60);
            assert!(matches!(tokio::time::timeout(deadline, run).await, Ok(Ok(()))), "the refresh's task ran");
        });
        drop(first);
        assert_eq!(runtime().block_on(refresh_once(path, async { 7u32 })), Ok(7));
    }

    // A runtime that has shut down drops a task where it is spawned. The flight's end takes the map's lock, so the
    // spawn is made with the lock released: the caller on the dead runtime gets the flight's end, and the map is
    // free for the next caller.
    #[test]
    fn a_refresh_started_on_a_runtime_that_has_shut_down_leaves_the_map_free() {
        let path = Path::new("closed-oauth.json");
        let runtime = || tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let closed = runtime();
        let handle = closed.handle().clone();
        drop(closed);
        let attempt = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _context = handle.enter();
            refresh_once(path, async { 1u32 }).now_or_never()
        }));
        assert!(attempt.is_err(), "the caller on the dead runtime is told its refresh was cancelled");
        assert_eq!(runtime().block_on(refresh_once(path, async { 8u32 })), Ok(8));
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
