//! The deadline every outbound HTTP request carries (hang audit F5, F6).
//!
//! A request is one of two classes and says which when it is made:
//! - [`Liveness::Unary`]: the whole exchange (response head and the body to its end) must finish
//!   within `total`.
//! - [`Liveness::Stream`]: only the response head must arrive within `head`. The body is content
//!   and has no timer (SPEC §4.9 "a live-but-silent provider is normal").
//!
//! - [`Liveness::CancelOnly`]: no timer at all. The caller ends the exchange by dropping or
//!   selecting against its own cancel; for an exchange whose length no input bounds (a local
//!   transcription, D-hang-services-3).
//!
//! The deadline is a plain duration so a paused tokio clock drives it in tests.

use std::future::Future;
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Liveness {
    Unary { total: Duration },
    Stream { head: Duration },
    CancelOnly,
}

/// The deadline passed before the work finished.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Expired {
    pub after: Duration,
}

impl Liveness {
    pub const fn unary(total: Duration) -> Self {
        Self::Unary { total }
    }

    pub const fn stream(head: Duration) -> Self {
        Self::Stream { head }
    }

    pub const fn cancel_only() -> Self {
        Self::CancelOnly
    }

    /// How long the response head may take; `None` for a cancel-only exchange.
    pub const fn head_deadline(self) -> Option<Duration> {
        match self {
            Self::Unary { total } => Some(total),
            Self::Stream { head } => Some(head),
            Self::CancelOnly => None,
        }
    }

    /// The whole-exchange deadline; `None` for a stream, whose body has no timer.
    pub const fn total_deadline(self) -> Option<Duration> {
        match self {
            Self::Unary { total } => Some(total),
            Self::Stream { .. } | Self::CancelOnly => None,
        }
    }

    /// Runs `work` against the head deadline.
    pub async fn bound_head<T>(self, work: impl Future<Output = T>) -> Result<T, Expired> {
        match self.head_deadline() {
            Some(after) => crate::time::timeout(after, work)
                .await
                .map_err(|_| Expired { after }),
            None => Ok(work.await),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn a_silent_head_expires_on_the_virtual_clock() {
        let stalled = std::future::pending::<()>();
        let stream = Liveness::stream(Duration::from_secs(600));
        assert_eq!(
            stream.bound_head(stalled).await,
            Err(Expired {
                after: Duration::from_secs(600)
            })
        );
        assert_eq!(stream.total_deadline(), None);
        let unary = Liveness::unary(Duration::from_secs(30));
        assert_eq!(unary.total_deadline(), Some(Duration::from_secs(30)));
        assert_eq!(unary.bound_head(async { 7 }).await, Ok(7));
        // A cancel-only exchange has no timer: only the caller's own bound ends it.
        let waited = tokio::time::timeout(
            Duration::from_secs(24 * 3600),
            Liveness::cancel_only().bound_head(std::future::pending::<()>()),
        )
        .await;
        assert!(waited.is_err());
    }
}
