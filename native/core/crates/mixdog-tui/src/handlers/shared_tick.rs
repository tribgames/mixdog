//! One process-wide animation timer for the TUI (`src/tui/hooks/useSharedTick.mjs`). A single timer avoids independent wakeups
//! for every animated component. Subscribers register the cadence they want; the timer targets the next due boundary and only
//! notifies each subscriber once its own interval has elapsed, so a 500 ms blink and a 130 ms spinner still animate at their own
//! rates off one timer. With no subscriber there is nothing to wake for. Components derive blink phase, elapsed seconds and
//! spinner frame from the clock at render; the tick only forces the redraw.
//!
//! Time is an input: the owner runs one timer for [`SharedTick::next_delay_ms`] and calls [`SharedTick::tick`] when it fires.
//! (`useSession`, the other hook of `hooks/`, is a subscription of React to the store; the run loop redraws on the store's
//! change signal, so it has no counterpart.)

/// Fire a subscriber a hair early rather than skip a whole base interval and drift its cadence by a frame.
pub const TICK_SLOP_MS: u64 = 16;

/// A subscription: hand it back to [`SharedTick::unsubscribe`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SubscriptionId(u64);

#[derive(Debug)]
struct Subscriber {
    id: SubscriptionId,
    interval_ms: u64,
    last_fire: u64,
}

#[derive(Debug, Default)]
pub struct SharedTick {
    subscribers: Vec<Subscriber>,
    next_id: u64,
}

impl SharedTick {
    pub fn new() -> Self {
        Self::default()
    }

    /// Subscribes at `interval_ms` (at least 1), counting from `now`. The owner re-aims its timer afterwards.
    pub fn subscribe(&mut self, interval_ms: u64, now: u64) -> SubscriptionId {
        let id = SubscriptionId(self.next_id);
        self.next_id += 1;
        self.subscribers.push(Subscriber { id, interval_ms: interval_ms.max(1), last_fire: now });
        id
    }

    /// Drops a subscription. The cadence of the others is tied to their own last fire, so removing the finest one does not
    /// stall them for a fresh interval.
    pub fn unsubscribe(&mut self, id: SubscriptionId) {
        self.subscribers.retain(|subscriber| subscriber.id != id);
    }

    /// The delay until the soonest subscriber is due (at least 1 ms), `None` when nothing is subscribed.
    pub fn next_delay_ms(&self, now: u64) -> Option<u64> {
        self.subscribers
            .iter()
            .map(|subscriber| (subscriber.last_fire + subscriber.interval_ms) as i128 - now as i128)
            .min()
            .map(|due| due.max(1) as u64)
    }

    /// The timer fired at `now`: the subscribers whose interval has elapsed (within [`TICK_SLOP_MS`]), each marked fired.
    pub fn tick(&mut self, now: u64) -> Vec<SubscriptionId> {
        let mut due = Vec::new();
        for subscriber in &mut self.subscribers {
            if now.saturating_sub(subscriber.last_fire) + TICK_SLOP_MS >= subscriber.interval_ms {
                subscriber.last_fire = now;
                due.push(subscriber.id);
            }
        }
        due
    }

    pub fn is_empty(&self) -> bool {
        self.subscribers.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs the one timer from `*now` up to `until`, collecting `(time, subscriber)` of every notification.
    fn run(tick: &mut SharedTick, now: &mut u64, until: u64, log: &mut Vec<(u64, SubscriptionId)>) {
        while let Some(delay) = tick.next_delay_ms(*now) {
            if *now + delay > until {
                break;
            }
            *now += delay;
            log.extend(tick.tick(*now).into_iter().map(|id| (*now, id)));
        }
        *now = until;
    }

    #[test]
    fn shared_tick_preserves_independent_cadence_and_unsubscribe_cleanup() {
        let mut tick = SharedTick::new();
        let mut now = 10_000;
        assert_eq!(tick.next_delay_ms(now), None);
        let fast = tick.subscribe(130, now);
        let slow = tick.subscribe(500, now);
        let mut log = Vec::new();

        run(&mut tick, &mut now, 10_129, &mut log);
        assert!(log.is_empty());
        run(&mut tick, &mut now, 10_390, &mut log);
        assert_eq!(log, [(10_130, fast), (10_260, fast), (10_390, fast)]);

        log.clear();
        run(&mut tick, &mut now, 10_500, &mut log);
        assert_eq!(log, [(10_500, slow)], "the slow one fires at its own boundary and the fast one is not early");
        log.clear();
        run(&mut tick, &mut now, 10_520, &mut log);
        assert_eq!(log, [(10_520, fast)]);

        tick.unsubscribe(fast);
        log.clear();
        run(&mut tick, &mut now, 11_000, &mut log);
        assert_eq!(log, [(11_000, slow)], "removing the finest subscriber leaves the other on its own cadence");

        tick.unsubscribe(slow);
        assert!(tick.is_empty());
        assert_eq!(tick.next_delay_ms(now), None, "nothing ticks when nothing animated is on screen");
    }

    #[test]
    fn an_overdue_subscriber_is_due_in_one_millisecond_and_a_zero_interval_is_one() {
        let mut tick = SharedTick::new();
        let id = tick.subscribe(0, 100);
        assert_eq!(tick.next_delay_ms(100), Some(1));
        assert_eq!(tick.next_delay_ms(500), Some(1));
        assert_eq!(tick.tick(101), [id]);
    }
}
