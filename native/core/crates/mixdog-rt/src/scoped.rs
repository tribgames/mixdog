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

/// What bounds a wait: an optional token and an optional deadline.
#[derive(Clone, Copy, Default)]
pub struct Scope<'a> {
    cancel: Option<&'a CancellationToken>,
    deadline: Option<Instant>,
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
        self.deadline = deadline;
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
                Some(at) => tokio::time::sleep_until(tokio::time::Instant::from_std(at)).await,
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

#[cfg(test)]
mod tests {
    use super::*;

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
    async fn cancel_wins_over_the_deadline_and_work_that_is_pending_loses_to_both() {
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
