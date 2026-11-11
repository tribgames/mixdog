//! The core's timers: every crate arms its timers here (`clippy.toml` refuses `tokio::time`'s timer functions elsewhere). Without
//! feature `virtual-clock` the types are tokio's own, re-exported, and each function is tokio's, called through an inline wrapper
//! (a re-export would carry tokio's path, which the ban names). With it, and a replay's clock running the process
//! (`virtual_clock.rs`), each sleep is a timer in that clock's copy of Node's timer lists, fired in Node's order; without a
//! replay's clock they are tokio's again.

pub use tokio::time::MissedTickBehavior;

#[cfg(not(feature = "virtual-clock"))]
pub use off_virtual_clock::*;

#[cfg(not(feature = "virtual-clock"))]
mod off_virtual_clock {
    use std::future::IntoFuture;
    use std::time::Duration;

    pub use tokio::time::Instant;
    pub use tokio::time::Interval;
    pub use tokio::time::Sleep;
    pub use tokio::time::Timeout;
    pub use tokio::time::error::Elapsed;

    /// `tokio::time::sleep`.
    #[inline]
    #[track_caller]
    pub fn sleep(duration: Duration) -> Sleep {
        tokio::time::sleep(duration)
    }

    /// `tokio::time::sleep_until`.
    #[inline]
    #[track_caller]
    pub fn sleep_until(deadline: Instant) -> Sleep {
        tokio::time::sleep_until(deadline)
    }

    /// `tokio::time::timeout`.
    #[inline]
    #[track_caller]
    pub fn timeout<F: IntoFuture>(duration: Duration, future: F) -> Timeout<F::IntoFuture> {
        tokio::time::timeout(duration, future)
    }

    /// `tokio::time::timeout_at`.
    #[inline]
    #[track_caller]
    pub fn timeout_at<F: IntoFuture>(deadline: Instant, future: F) -> Timeout<F::IntoFuture> {
        tokio::time::timeout_at(deadline, future)
    }

    /// `tokio::time::interval`.
    #[inline]
    #[track_caller]
    pub fn interval(period: Duration) -> Interval {
        tokio::time::interval(period)
    }

    /// `tokio::time::interval_at`.
    #[inline]
    #[track_caller]
    pub fn interval_at(start: Instant, period: Duration) -> Interval {
        tokio::time::interval_at(start, period)
    }
}

#[cfg(feature = "virtual-clock")]
pub use on_virtual_clock::*;

#[cfg(feature = "virtual-clock")]
mod on_virtual_clock {
    use std::future::Future;
    use std::future::IntoFuture;
    use std::pin::Pin;
    use std::sync::Arc;
    use std::task::Context;
    use std::task::Poll;
    use std::time::Duration;

    pub use tokio::time::Instant;

    use super::MissedTickBehavior;
    use crate::virtual_clock;
    use crate::virtual_clock::Key;
    use crate::virtual_clock::Slot;

    /// `tokio::time::sleep`; on the replay's clock, Node's `setTimeout(f, duration)`.
    pub fn sleep(duration: Duration) -> Sleep {
        let now = Instant::now();
        // As tokio: a deadline past the clock's range is about 30 years away.
        let deadline = now.checked_add(duration).unwrap_or_else(|| now + Duration::from_secs(86_400 * 365 * 30));
        let inner = if virtual_clock::active() { Inner::from(virtual_clock::wake_after(duration)) } else { Inner::new(deadline) };
        Sleep { deadline, inner }
    }

    /// `tokio::time::sleep_until`; on the replay's clock, a timer for the deadline's distance, ready at once when that is none.
    pub fn sleep_until(deadline: Instant) -> Sleep {
        Sleep { deadline, inner: Inner::new(deadline) }
    }

    /// `tokio::time::timeout`.
    pub fn timeout<F: IntoFuture>(duration: Duration, future: F) -> Timeout<F::IntoFuture> {
        Timeout { value: Box::pin(future.into_future()), delay: sleep(duration) }
    }

    /// `tokio::time::timeout_at`.
    pub fn timeout_at<F: IntoFuture>(deadline: Instant, future: F) -> Timeout<F::IntoFuture> {
        Timeout { value: Box::pin(future.into_future()), delay: sleep_until(deadline) }
    }

    /// `tokio::time::interval_at`. On the replay's clock, Node's `setInterval`: each tick after the first is armed when the next
    /// [`Interval::tick`] is called (after the code the last tick ran, as Node re-inserts after the callback), for `period` from
    /// the V the last tick fired at.
    pub fn interval_at(start: Instant, period: Duration) -> Interval {
        assert!(period > Duration::ZERO, "`period` must be non-zero.");
        Interval { period, sleep: sleep_until(start), missed: MissedTickBehavior::Burst, fired_at: None }
    }

    /// `tokio::time::interval`: the first tick at once.
    pub fn interval(period: Duration) -> Interval {
        interval_at(Instant::now(), period)
    }

    enum Inner {
        Tokio(Pin<Box<tokio::time::Sleep>>),
        Virtual { key: Option<Key>, slot: Arc<Slot>, due: u64 },
    }

    impl Inner {
        fn new(deadline: Instant) -> Self {
            if virtual_clock::active() {
                Self::from(virtual_clock::wake_at(deadline))
            } else {
                Self::Tokio(Box::pin(tokio::time::sleep_until(deadline)))
            }
        }

        fn from(armed: virtual_clock::Armed) -> Self {
            Self::Virtual { key: armed.key, slot: armed.slot, due: armed.due }
        }

        fn disarm(&mut self) {
            if let Self::Virtual { key, .. } = self
                && let Some(key) = key.take()
            {
                virtual_clock::disarm(key);
            }
        }
    }

    /// `tokio::time::Sleep`.
    #[must_use = "futures do nothing unless you `.await` or poll them"]
    pub struct Sleep {
        deadline: Instant,
        inner: Inner,
    }

    impl Sleep {
        pub fn deadline(&self) -> Instant {
            self.deadline
        }

        pub fn is_elapsed(&self) -> bool {
            match &self.inner {
                Inner::Tokio(sleep) => sleep.is_elapsed(),
                Inner::Virtual { slot, .. } => slot.is_fired(),
            }
        }

        /// Re-arms the sleep for `deadline`: on the replay's clock it takes a new place in the queue.
        pub fn reset(self: Pin<&mut Self>, deadline: Instant) {
            let this = self.get_mut();
            this.inner.disarm();
            this.deadline = deadline;
            match &mut this.inner {
                Inner::Tokio(sleep) => sleep.as_mut().reset(deadline),
                queued @ Inner::Virtual { .. } => *queued = Inner::new(deadline),
            }
        }
    }

    impl Drop for Sleep {
        fn drop(&mut self) {
            self.inner.disarm();
        }
    }

    impl Future for Sleep {
        type Output = ();

        fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
            match &mut self.get_mut().inner {
                Inner::Tokio(sleep) => sleep.as_mut().poll(cx),
                Inner::Virtual { key, slot, .. } => {
                    let polled = slot.poll(cx);
                    if polled.is_ready() {
                        // Fired: the clock already took it out of its queue.
                        *key = None;
                    }
                    polled
                }
            }
        }
    }

    /// `tokio::time::Timeout`.
    #[must_use = "futures do nothing unless you `.await` or poll them"]
    pub struct Timeout<T> {
        value: Pin<Box<T>>,
        delay: Sleep,
    }

    impl<T> Timeout<T> {
        pub fn get_ref(&self) -> &T {
            &self.value
        }

        pub fn into_inner(self) -> T
        where
            T: Unpin,
        {
            *Pin::into_inner(self.value)
        }
    }

    impl<T: Future> Future for Timeout<T> {
        type Output = Result<T::Output, Elapsed>;

        fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
            let this = self.get_mut();
            if let Poll::Ready(value) = this.value.as_mut().poll(cx) {
                return Poll::Ready(Ok(value));
            }
            Pin::new(&mut this.delay).poll(cx).map(|()| Err(Elapsed(())))
        }
    }

    /// `tokio::time::error::Elapsed`.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct Elapsed(());

    impl std::fmt::Display for Elapsed {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("deadline has elapsed")
        }
    }

    impl std::error::Error for Elapsed {}

    impl From<Elapsed> for std::io::Error {
        fn from(_: Elapsed) -> std::io::Error {
            std::io::ErrorKind::TimedOut.into()
        }
    }

    /// `tokio::time::Interval`; on the replay's clock, Node's `setInterval` ([`interval_at`]), whatever its missed-tick behaviour.
    pub struct Interval {
        period: Duration,
        sleep: Sleep,
        missed: MissedTickBehavior,
        /// The V the last tick fired at, on the replay's clock, until the next tick is armed.
        fired_at: Option<u64>,
    }

    impl Interval {
        pub async fn tick(&mut self) -> Instant {
            if let Some(start) = self.fired_at.take() {
                self.sleep.inner = Inner::from(virtual_clock::wake_from(start, self.period));
                self.sleep.deadline += self.period;
            }
            (&mut self.sleep).await;
            let at = self.sleep.deadline();
            match &mut self.sleep.inner {
                Inner::Virtual { due, .. } => self.fired_at = Some(*due),
                Inner::Tokio(sleep) => {
                    let now = Instant::now();
                    // tokio's `MissedTickBehavior::next_timeout`.
                    let next = match self.missed {
                        MissedTickBehavior::Burst => at + self.period,
                        MissedTickBehavior::Delay => now + self.period,
                        MissedTickBehavior::Skip => {
                            let late = now.saturating_duration_since(at).as_nanos();
                            let period = self.period.as_nanos();
                            now + self.period - Duration::from_nanos(u64::try_from(late % period).unwrap_or(0))
                        }
                    };
                    self.sleep.deadline = next;
                    sleep.as_mut().reset(next);
                }
            }
            at
        }

        pub fn period(&self) -> Duration {
            self.period
        }

        pub fn missed_tick_behavior(&self) -> MissedTickBehavior {
            self.missed
        }

        /// Off the replay's clock as tokio's; on it, every tick is Node's (the next one `period` after the last fired).
        pub fn set_missed_tick_behavior(&mut self, behavior: MissedTickBehavior) {
            self.missed = behavior;
        }
    }
}

/// `SystemTime::now()`, on the replay's clock when one runs the process (feature `virtual-clock`); without the feature, exactly
/// `std::time::SystemTime::now()`.
#[cfg(not(feature = "virtual-clock"))]
#[macro_export]
macro_rules! wall_clock {
    () => {
        ::std::time::SystemTime::now()
    };
}

/// `SystemTime::now()`, on the replay's clock when one runs the process (feature `virtual-clock`); without the feature, exactly
/// `std::time::SystemTime::now()`.
#[cfg(feature = "virtual-clock")]
#[macro_export]
macro_rules! wall_clock {
    () => {
        $crate::virtual_clock::system_now()
    };
}

/// `chrono::Utc::now()` (the caller depends on `chrono`), on the replay's clock when one runs the process.
#[cfg(not(feature = "virtual-clock"))]
#[macro_export]
macro_rules! utc_now {
    () => {
        ::chrono::Utc::now()
    };
}

/// `chrono::Utc::now()` (the caller depends on `chrono`), on the replay's clock when one runs the process.
#[cfg(feature = "virtual-clock")]
#[macro_export]
macro_rules! utc_now {
    () => {
        ::chrono::DateTime::<::chrono::Utc>::from($crate::virtual_clock::system_now())
    };
}
