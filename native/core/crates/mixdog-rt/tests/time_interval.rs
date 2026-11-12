//! `mixdog_rt::time::interval` off a replay's clock (with feature `virtual-clock`, its own `Interval`) against
//! `tokio::time::interval`, on a paused tokio clock: a tick polled late, on both sides of tokio's 5 ms threshold, schedules the
//! next tick where tokio's does, for every missed-tick behaviour.

use std::time::Duration;

use mixdog_rt::time::MissedTickBehavior;
use tokio::time::Instant;

const PERIOD: Duration = Duration::from_millis(100);

/// Where each of the first three ticks lands, from the interval's start, when the second is polled `late` after the start.
macro_rules! ticks {
    ($interval:path, $missed:expr, $late:expr) => {{
        let start = Instant::now();
        let mut interval = $interval(PERIOD);
        interval.set_missed_tick_behavior($missed);
        let first = interval.tick().await;
        tokio::time::advance($late).await;
        let second = interval.tick().await;
        let third = interval.tick().await;
        [first, second, third].map(|at| at - start)
    }};
}

#[tokio::test(start_paused = true)]
async fn a_late_tick_schedules_the_next_as_tokio_does() {
    for missed in [MissedTickBehavior::Burst, MissedTickBehavior::Delay, MissedTickBehavior::Skip] {
        // 101 and 105 ms: at most 5 ms late, not missed; 106 and 250 ms: missed.
        for late in [101, 105, 106, 250].map(Duration::from_millis) {
            let tokio = ticks!(tokio::time::interval, missed, late);
            let ours = ticks!(mixdog_rt::time::interval, missed, late);
            assert_eq!(ours, tokio, "{missed:?}, the second tick polled {late:?} after the start");
        }
    }
}
