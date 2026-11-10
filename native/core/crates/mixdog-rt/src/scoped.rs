//! The one cancel-and-deadline wrapper of every dispatcher (hang audit §8 item 3): the tool
//! dispatcher, the run port and the desktop host channel all wait through [`Scope::run`], so a
//! callee that ignores its token or never answers cannot hold the caller past cancel or deadline.

use std::future::Future;
use std::time::Instant;

use tokio_util::sync::CancellationToken;

/// How a scoped wait ended.
#[derive(Debug, PartialEq, Eq)]
pub enum Scoped<T> {
    Done(T),
    Cancelled,
    DeadlineExceeded,
}

impl<T> Scoped<T> {
    /// The work's output, or `None` when the scope ended it.
    pub fn done(self) -> Option<T> {
        match self {
            Self::Done(out) => Some(out),
            Self::Cancelled | Self::DeadlineExceeded => None,
        }
    }
}

/// A std deadline on the tokio clock: its distance from the std clock now, added to the tokio
/// clock now. Every wait in this crate sleeps on the tokio clock, which a paused or advanced test
/// clock moves away from `std::time::Instant::now()`; an absolute std instant compared with it
/// would already be past (or never come).
pub(crate) fn on_tokio_clock(at: Instant) -> tokio::time::Instant {
    tokio::time::Instant::now() + at.saturating_duration_since(Instant::now())
}

/// What bounds a wait: an optional token and an optional deadline.
#[derive(Clone, Copy, Default)]
pub struct Scope<'a> {
    cancel: Option<&'a CancellationToken>,
    deadline: Option<tokio::time::Instant>,
}

impl<'a> Scope<'a> {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(mut self, cancel: &'a CancellationToken) -> Self {
        self.cancel = Some(cancel);
        self
    }

    pub fn deadline(mut self, deadline: Option<Instant>) -> Self {
        self.deadline = deadline.map(on_tokio_clock);
        self
    }

    /// A deadline `budget` from now, taken on the tokio clock itself. A std deadline built by the caller
    /// (`Instant::now() + budget`) loses the real time that passes before [`Self::deadline`] converts it, so
    /// under a paused clock the wait ended that much short of `budget` (9.999 s of 10 s on a loaded machine).
    pub fn within(mut self, budget: std::time::Duration) -> Self {
        self.deadline = Some(tokio::time::Instant::now() + budget);
        self
    }

    /// `select!{ biased; cancel, deadline, work }`: cancel wins over an expired deadline, which
    /// wins over finished work. The work is dropped when the scope ends it.
    pub async fn run<F: Future>(self, work: F) -> Scoped<F::Output> {
        let cancelled = async {
            match self.cancel {
                Some(cancel) => cancel.cancelled().await,
                None => std::future::pending().await,
            }
        };
        let expired = async {
            match self.deadline {
                Some(at) => tokio::time::sleep_until(at).await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            biased;
            () = cancelled => Scoped::Cancelled,
            () = expired => Scoped::DeadlineExceeded,
            out = work => Scoped::Done(out),
        }
    }
}

impl Scope<'_> {
    /// [`Scope::run`] for a callee that can wind itself down: when cancel or the deadline ends
    /// the wait, `on_end` fires the callee's own token and the work keeps `grace` more to return
    /// (partial output, a killed process tree) before it is dropped. A result inside the grace
    /// is `Done`; otherwise the original ending is reported.
    pub async fn run_with_grace<F: Future + Unpin>(self, work: &mut F, grace: std::time::Duration, on_end: impl FnOnce()) -> Scoped<F::Output> {
        let ended = match self.run(&mut *work).await {
            Scoped::Done(out) => return Scoped::Done(out),
            ended => ended,
        };
        on_end();
        let grace_ends = Scope { cancel: None, deadline: Some(tokio::time::Instant::now() + grace) };
        match grace_ends.run(work).await {
            Scoped::Done(out) => Scoped::Done(out),
            _ => ended,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_callee_that_returns_inside_the_grace_keeps_its_result() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        let signalled = CancellationToken::new();
        let mut work = Box::pin({
            let signalled = signalled.clone();
            async move {
                signalled.cancelled().await;
                "partial"
            }
        });
        let out = Scope::new()
            .cancel(&cancel)
            .run_with_grace(&mut work, std::time::Duration::from_secs(60), || signalled.cancel())
            .await;
        assert_eq!(out, Scoped::Done("partial"));
    }

    #[tokio::test(start_paused = true)]
    async fn a_callee_that_ignores_its_signal_is_dropped_when_the_grace_ends() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        let mut work = Box::pin(std::future::pending::<()>());
        let out = Scope::new().cancel(&cancel).run_with_grace(&mut work, std::time::Duration::from_millis(1500), || {}).await;
        assert_eq!(out, Scoped::Cancelled);
    }

    /// The clock is moved far from the std clock before the run is cancelled; the grace must still
    /// be a full `grace` on the tokio clock, so the callee is polled after its signal.
    #[tokio::test(start_paused = true)]
    async fn the_grace_is_measured_on_the_advanced_tokio_clock() {
        tokio::time::advance(std::time::Duration::from_secs(3600)).await;
        let cancel = CancellationToken::new();
        cancel.cancel();
        let signalled = CancellationToken::new();
        let mut work = Box::pin({
            let signalled = signalled.clone();
            async move {
                signalled.cancelled().await;
                "partial"
            }
        });
        let out = Scope::new()
            .cancel(&cancel)
            .run_with_grace(&mut work, std::time::Duration::from_millis(1500), || signalled.cancel())
            .await;
        assert_eq!(out, Scoped::Done("partial"));
    }

    /// An advanced clock still ends a callee that ignores its signal, after the grace and not
    /// before it.
    #[tokio::test(start_paused = true)]
    async fn an_ignored_signal_is_dropped_after_the_grace_on_the_advanced_clock() {
        tokio::time::advance(std::time::Duration::from_secs(3600)).await;
        let cancel = CancellationToken::new();
        cancel.cancel();
        let started = tokio::time::Instant::now();
        let mut work = Box::pin(std::future::pending::<()>());
        let out = Scope::new().cancel(&cancel).run_with_grace(&mut work, std::time::Duration::from_millis(1500), || {}).await;
        assert_eq!(out, Scoped::Cancelled);
        assert_eq!(started.elapsed(), std::time::Duration::from_millis(1500));
    }

    #[tokio::test]
    async fn a_cancelled_token_releases_a_wait_that_never_ends() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        let out = Scope::new().cancel(&cancel).run(std::future::pending::<()>()).await;
        assert_eq!(out, Scoped::Cancelled);
    }

    #[tokio::test]
    async fn an_expired_deadline_releases_a_wait_that_never_ends() {
        let out = Scope::new().deadline(Some(Instant::now())).run(std::future::pending::<()>()).await;
        assert_eq!(out, Scoped::DeadlineExceeded);
    }

    #[tokio::test]
    async fn cancel_wins_over_the_deadline_and_over_finished_work() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        let out = Scope::new().cancel(&cancel).deadline(Some(Instant::now())).run(async { 1 }).await;
        assert_eq!(out, Scoped::Cancelled);
    }

    #[tokio::test]
    async fn an_unbounded_scope_returns_the_work() {
        assert_eq!(Scope::new().run(async { 7 }).await.done(), Some(7));
    }
}
