//! The one stop watcher of `serve`, installed when startup begins and kept to the end (Node installs its `SIGTERM`/`SIGINT`/`SIGHUP`/`SIGBREAK` handlers once,
//! before `main`, `daemon.mjs:1297`). A stop that arrives during startup or composition is not lost: it wakes a blocked startup wait, ends a stalled composition's
//! slow waits, and is handed to the lifecycle once the core serves.

use std::future::Future;
use std::io;

use tokio::sync::watch;

use crate::signals::StopSignal;

type Seen = Option<Result<StopSignal, io::ErrorKind>>;

#[derive(Clone)]
pub struct StopWatch {
    seen: watch::Receiver<Seen>,
}

impl StopWatch {
    /// Installs the OS handlers. `on_signal` runs once, right after a stop request is recorded (it wakes a blocked startup wait).
    pub fn install(on_signal: impl FnOnce() + Send + 'static) -> Self {
        Self::from_source(crate::signals::stop_requested(), on_signal)
    }

    fn from_source(source: impl Future<Output = io::Result<StopSignal>> + Send + 'static, on_signal: impl FnOnce() + Send + 'static) -> Self {
        let (sender, seen) = watch::channel(None);
        mixdog_rt::spawn("serve.stop-watch", mixdog_rt::TaskClass::Control, async move {
            match source.await {
                Ok(signal) => {
                    sender.send_replace(Some(Ok(signal)));
                    on_signal();
                }
                Err(error) => {
                    tracing::error!(%error, "the stop signal handlers could not be installed");
                    sender.send_replace(Some(Err(error.kind())));
                }
            }
        });
        Self { seen }
    }

    /// The stop request that has already arrived, if any.
    pub fn requested(&self) -> Option<StopSignal> {
        match *self.seen.borrow() {
            Some(Ok(signal)) => Some(signal),
            _ => None,
        }
    }

    /// Resolves with the stop request; never, when the handlers could not be installed (that is [`Self::wait`]'s error).
    pub async fn arrived(&self) -> StopSignal {
        match self.wait().await {
            Ok(signal) => signal,
            Err(_) => std::future::pending().await,
        }
    }

    /// The stop request, or the error that kept the handlers from being installed.
    pub async fn wait(&self) -> io::Result<StopSignal> {
        let mut seen = self.seen.clone();
        match seen.wait_for(Option::is_some).await {
            Ok(outcome) => match *outcome {
                Some(Ok(signal)) => Ok(signal),
                Some(Err(kind)) => Err(io::Error::from(kind)),
                None => unreachable!("wait_for returned a value that is_some"),
            },
            Err(_) => Err(io::Error::other("the stop watcher ended before a stop request")),
        }
    }

    /// Runs `work` to its end, but a stop request that arrives meanwhile first calls `interrupt` (which must end the work's slow waits): the work is never dropped half
    /// done, so what it had acquired is released by its own failure path.
    pub async fn drive<T>(&self, work: impl Future<Output = T>, interrupt: impl FnOnce()) -> T {
        tokio::pin!(work);
        tokio::select! {
            done = &mut work => done,
            _ = self.arrived() => {
                interrupt();
                work.await
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;
    use std::time::Duration;

    use tokio::sync::oneshot;
    use tokio_util::sync::CancellationToken;

    use super::*;

    fn source() -> (oneshot::Sender<io::Result<StopSignal>>, impl Future<Output = io::Result<StopSignal>> + Send + 'static) {
        let (send, receive) = oneshot::channel();
        (send, async move { receive.await.unwrap_or_else(|_| Err(io::Error::other("closed"))) })
    }

    #[tokio::test(start_paused = true)]
    async fn a_stop_that_arrives_before_anyone_waits_is_kept_and_wakes_startup_once() {
        let woken = Arc::new(AtomicUsize::new(0));
        let (send, receive) = source();
        let watch = StopWatch::from_source(receive, {
            let woken = woken.clone();
            move || {
                woken.fetch_add(1, Ordering::SeqCst);
            }
        });
        assert_eq!(watch.requested(), None);
        send.send(Ok(StopSignal::Terminate)).unwrap();
        assert_eq!(watch.arrived().await, StopSignal::Terminate);
        assert_eq!(watch.requested(), Some(StopSignal::Terminate));
        // A later waiter (serve, after the core exists) still sees it.
        assert_eq!(watch.wait().await.unwrap(), StopSignal::Terminate);
        tokio::task::yield_now().await;
        assert_eq!(woken.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn handlers_that_cannot_be_installed_are_an_error_and_never_a_stop() {
        let (send, receive) = source();
        let watch = StopWatch::from_source(receive, || {});
        send.send(Err(io::Error::from(io::ErrorKind::PermissionDenied))).unwrap();
        assert_eq!(watch.wait().await.unwrap_err().kind(), io::ErrorKind::PermissionDenied);
        assert!(tokio::time::timeout(Duration::from_secs(60), watch.arrived()).await.is_err(), "no stop was requested");
    }

    /// A stalled composition (it waits on the token its slow acquisitions take) ends once the stop arrives, and its own failure path runs.
    #[tokio::test(start_paused = true)]
    async fn a_stop_interrupts_a_stalled_composition_which_then_cleans_up() {
        let (send, receive) = source();
        let watch = StopWatch::from_source(receive, || {});
        let token = CancellationToken::new();
        let released = Arc::new(AtomicUsize::new(0));
        let composing = {
            let (token, released) = (token.clone(), released.clone());
            async move {
                token.cancelled().await;
                released.fetch_add(1, Ordering::SeqCst); // the failure path: what was acquired is given back
                Err::<(), &str>("cancelled")
            }
        };
        send.send(Ok(StopSignal::Interrupt)).unwrap();
        let result = watch.drive(composing, || token.cancel()).await;
        assert_eq!(result, Err("cancelled"));
        assert_eq!(released.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_composition_that_ends_alone_is_not_interrupted() {
        let (_send, receive) = source();
        let watch = StopWatch::from_source(receive, || {});
        let interrupted = Arc::new(AtomicUsize::new(0));
        let flag = interrupted.clone();
        let result = watch
            .drive(async { 7 }, move || {
                flag.fetch_add(1, Ordering::SeqCst);
            })
            .await;
        assert_eq!(result, 7);
        assert_eq!(interrupted.load(Ordering::SeqCst), 0);
    }
}
