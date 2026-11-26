//! The supervisor's clock: the idle deadline and the drain bounds are armed on it.

use std::future::Future;
use std::pin::Pin;

use mixdog_rt::time::Instant;

pub trait Clock: Send + Sync + 'static {
    fn now(&self) -> Instant;

    /// Completes at `deadline`; dropping it disarms it.
    fn sleep_until(&self, deadline: Instant) -> Pin<Box<dyn Future<Output = ()> + Send>>;
}

/// The runtime's timers (`mixdog_rt::time`).
pub struct RuntimeClock;

impl Clock for RuntimeClock {
    fn now(&self) -> Instant {
        Instant::now()
    }

    fn sleep_until(&self, deadline: Instant) -> Pin<Box<dyn Future<Output = ()> + Send>> {
        Box::pin(mixdog_rt::time::sleep_until(deadline))
    }
}

#[cfg(feature = "test-support")]
pub use manual::ManualClock;

#[cfg(feature = "test-support")]
mod manual {
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::Mutex;
    use std::sync::PoisonError;
    use std::time::Duration;

    use mixdog_rt::time::Instant;
    use tokio::sync::oneshot;

    use super::Clock;

    /// A clock that moves only when [`ManualClock::advance`] is called. A timer is registered when it is made, so one
    /// made before an advance is fired by it.
    pub struct ManualClock {
        origin: Instant,
        state: Mutex<State>,
    }

    struct State {
        elapsed: Duration,
        timers: Vec<(Instant, oneshot::Sender<()>)>,
    }

    impl Default for ManualClock {
        fn default() -> Self {
            Self { origin: Instant::now(), state: Mutex::new(State { elapsed: Duration::ZERO, timers: Vec::new() }) }
        }
    }

    impl ManualClock {
        pub fn new() -> Self {
            Self::default()
        }

        /// Moves the clock on and fires every timer now due.
        pub fn advance(&self, by: Duration) {
            let due = {
                let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
                state.elapsed += by;
                let now = self.origin + state.elapsed;
                let (due, waiting): (Vec<_>, Vec<_>) = std::mem::take(&mut state.timers).into_iter().partition(|(at, _)| *at <= now);
                state.timers = waiting;
                due
            };
            for (_, timer) in due {
                let _ = timer.send(());
            }
        }

        /// Timers armed and neither fired nor dropped.
        pub fn pending(&self) -> usize {
            self.state.lock().unwrap_or_else(PoisonError::into_inner).timers.iter().filter(|(_, timer)| !timer.is_closed()).count()
        }
    }

    impl Clock for ManualClock {
        fn now(&self) -> Instant {
            self.origin + self.state.lock().unwrap_or_else(PoisonError::into_inner).elapsed
        }

        fn sleep_until(&self, deadline: Instant) -> Pin<Box<dyn Future<Output = ()> + Send>> {
            let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            if deadline <= self.origin + state.elapsed {
                return Box::pin(std::future::ready(()));
            }
            state.timers.retain(|(_, timer)| !timer.is_closed());
            let (timer, fired) = oneshot::channel();
            state.timers.push((deadline, timer));
            Box::pin(async move {
                if fired.await.is_err() {
                    std::future::pending::<()>().await;
                }
            })
        }
    }
}
