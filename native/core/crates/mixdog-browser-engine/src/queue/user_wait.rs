//! Owner: s4-engine-queue
//! Time a Browser Use command spends waiting for the person (an approval card) is not the page being slow. The command's
//! ceiling ([`crate::limits::COMMAND_TIMEOUT`]) stands still while any such wait is open and runs again, with what was left,
//! when the last one closes; cancelling the command still ends it at once. [`bounded`] is that ceiling (`cdp-bounded.ts`).

use std::future::Future;
use std::future::poll_fn;
use std::pin::pin;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::task::Poll;
use std::task::Waker;
use std::time::Duration;

use mixdog_rt::CancelView;
use mixdog_rt::time;

use super::barrier::Either;
use super::barrier::race;
use super::queue::QueueError;

#[derive(Default)]
struct State {
    open: usize,
    /// Bumped each time the first wait opens and each time the last one closes.
    version: u64,
    wakers: Vec<Waker>,
}

fn lock(state: &Mutex<State>) -> MutexGuard<'_, State> {
    state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// One command's clock of waits on the person. Clones share the waits.
#[derive(Clone, Default)]
pub struct UserWait {
    state: Arc<Mutex<State>>,
}

/// An open wait; dropping it closes the wait (once).
#[must_use]
pub struct WaitGuard {
    wait: UserWait,
}

impl UserWait {
    pub fn new() -> Self {
        Self::default()
    }

    /// Opens one wait; the returned guard closes it when dropped.
    pub fn begin(&self) -> WaitGuard {
        let woken = {
            let mut state = lock(&self.state);
            state.open += 1;
            if state.open == 1 {
                state.version += 1;
                std::mem::take(&mut state.wakers)
            } else {
                Vec::new()
            }
        };
        woken.into_iter().for_each(Waker::wake);
        WaitGuard { wait: self.clone() }
    }

    /// Whether any wait is open.
    pub fn is_waiting(&self) -> bool {
        lock(&self.state).open > 0
    }

    /// The version and whether a wait is open, read together.
    fn snapshot(&self) -> (u64, bool) {
        let state = lock(&self.state);
        (state.version, state.open > 0)
    }

    /// Resolves once the first wait opened or the last one closed since `seen` (a version of [`Self::snapshot`]).
    fn changed(&self, seen: u64) -> impl Future<Output = ()> + '_ {
        poll_fn(move |cx| {
            let mut state = lock(&self.state);
            if state.version != seen {
                return Poll::Ready(());
            }
            state.wakers.push(cx.waker().clone());
            Poll::Pending
        })
    }
}

impl Drop for WaitGuard {
    fn drop(&mut self) {
        let woken = {
            let mut state = lock(&self.wait.state);
            state.open -= 1;
            if state.open == 0 {
                state.version += 1;
                std::mem::take(&mut state.wakers)
            } else {
                Vec::new()
            }
        };
        woken.into_iter().for_each(Waker::wake);
    }
}

/// Ends when `timeout` of running time has passed; time while `wait` has a wait open does not count.
async fn ceiling(timeout: Duration, wait: Option<&UserWait>) {
    let Some(wait) = wait else {
        time::sleep(timeout).await;
        return;
    };
    let mut remaining = timeout;
    loop {
        let (seen, waiting) = wait.snapshot();
        if waiting {
            wait.changed(seen).await;
            continue;
        }
        let armed = time::Instant::now();
        match race(time::sleep(remaining), wait.changed(seen)).await {
            Either::Left(()) => return,
            Either::Right(()) => remaining = remaining.saturating_sub(armed.elapsed()),
        }
    }
}

/// Races `work` against the caller's cancellation and the ceiling (the work first, then the cancellation, when several are
/// ready). The ceiling stands still while `wait` has a wait open. Dropping `work` on the error side abandons its calls.
pub async fn bounded<T>(
    work: impl Future<Output = T>,
    timeout: Duration,
    label: &str,
    cancel: &CancelView,
    wait: Option<&UserWait>,
) -> Result<T, QueueError> {
    if cancel.is_cancelled() {
        return Err(QueueError::from_reason(cancel.reason()));
    }
    let work = pin!(work);
    match race(work, race(cancel.cancelled(), ceiling(timeout, wait))).await {
        Either::Left(done) => Ok(done),
        Either::Right(Either::Left(())) => Err(QueueError::from_reason(cancel.reason())),
        Either::Right(Either::Right(())) => Err(QueueError::TimedOut { label: label.to_string(), millis: timeout.as_millis() }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixdog_rt::CancelSource;

    #[tokio::test]
    async fn the_ceiling_ends_work_that_never_finishes() {
        let source = CancelSource::new();
        let error = bounded(std::future::pending::<()>(), Duration::from_millis(30), "browser wait", &source.view(), None).await;
        assert_eq!(error, Err(QueueError::TimedOut { label: "browser wait".into(), millis: 30 }));
        assert_eq!(error.unwrap_err().to_string(), "browser wait timed out after 30ms");
    }

    #[tokio::test]
    async fn a_wait_on_the_person_stops_the_ceiling() {
        let source = CancelSource::new();
        let wait = UserWait::new();
        let inner = wait.clone();
        let work = async move {
            let asking = inner.begin();
            time::sleep(Duration::from_millis(120)).await;
            drop(asking);
            time::sleep(Duration::from_millis(10)).await;
            7
        };
        let answered = bounded(work, Duration::from_millis(60), "browser click", &source.view(), Some(&wait)).await;
        assert_eq!(answered, Ok(7));
        assert!(!wait.is_waiting());
    }

    #[tokio::test]
    async fn the_ceiling_runs_on_with_what_was_left() {
        let source = CancelSource::new();
        let wait = UserWait::new();
        let inner = wait.clone();
        let work = async move {
            time::sleep(Duration::from_millis(30)).await;
            let asking = inner.begin();
            time::sleep(Duration::from_millis(50)).await;
            drop(asking);
            std::future::pending::<()>().await;
        };
        let started = time::Instant::now();
        let error = bounded(work, Duration::from_millis(60), "browser click", &source.view(), Some(&wait)).await;
        assert!(matches!(error, Err(QueueError::TimedOut { .. })));
        assert!(started.elapsed() >= Duration::from_millis(100), "the 50 ms of asking did not count");
    }

    #[tokio::test]
    async fn two_waits_close_the_clock_when_the_last_one_ends() {
        let wait = UserWait::new();
        let first = wait.begin();
        let second = wait.begin();
        drop(first);
        assert!(wait.is_waiting());
        drop(second);
        assert!(!wait.is_waiting());
    }

    #[tokio::test]
    async fn a_cancelled_command_ends_at_once_even_while_asking() {
        let source = CancelSource::new();
        let wait = UserWait::new();
        let _asking = wait.begin();
        source.cancel("fixture cancelled");
        let error = bounded(std::future::pending::<()>(), Duration::from_secs(60), "browser click", &source.view(), Some(&wait)).await;
        assert_eq!(error, Err(QueueError::Cancelled { reason: Some("fixture cancelled".into()) }));
    }
}
