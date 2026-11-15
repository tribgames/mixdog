//! `Date.now()` of the Office code: the wall clock, or the instant a run was pinned to.
//!
//! Node's recorders replace `Date` to make a recording repeatable (every stamp a document carries is then the same instant);
//! [`pin`] is that replacement here. Everything of the Office crates that stamps what it writes reads [`now_ms`].

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// The bits of the pinned instant; this pattern (a NaN no instant has) when the wall clock is read.
const UNPINNED: u64 = u64::MAX;
static PINNED: AtomicU64 = AtomicU64::new(UNPINNED);

/// Milliseconds since the Unix epoch: the pinned instant, else the wall clock.
#[allow(clippy::disallowed_methods, reason = "the one read of the wall clock of the Office crates")]
pub fn now_ms() -> f64 {
    match PINNED.load(Ordering::Relaxed) {
        UNPINNED => SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |elapsed| elapsed.as_secs_f64() * 1000.0).floor(),
        bits => f64::from_bits(bits),
    }
}

/// Pins the clock of this process to `instant` (milliseconds since the epoch), or gives it back to the wall clock.
pub fn pin(instant: Option<f64>) {
    PINNED.store(instant.map_or(UNPINNED, f64::to_bits), Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pinned_clock_answers_its_instant_and_an_unpinned_one_the_wall_clock() {
        pin(Some(1_700_000_000_000.0));
        assert_eq!(now_ms(), 1_700_000_000_000.0);
        pin(None);
        assert!(now_ms() > 1_700_000_000_000.0);
    }
}
