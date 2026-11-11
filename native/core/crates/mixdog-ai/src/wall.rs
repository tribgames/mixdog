//! The wall clock a provider stamps its session state with (`Date.now()`).
//!
//! A development-only seam, compiled only under `cfg(test)` or the `test-support` feature (which `build.rs` refuses in a
//! release-profile build) and inert unless a test sets it: [`set`] fixes the time a recording's frozen `Date.now`
//! returned, so a replay stamps what Node stamped. The fixed time belongs to the thread that set it, so concurrent replays
//! never read each other's. Without it the time is the system's.

use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(any(test, feature = "test-support"))]
thread_local! {
    static FIXED: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    static FOLLOWED: std::cell::Cell<Option<(u64, tokio::time::Instant)>> = const { std::cell::Cell::new(None) };
}

/// Unix milliseconds: the fixed time when this thread's test set one, else the system's.
pub(crate) fn now_ms() -> u64 {
    #[cfg(any(test, feature = "test-support"))]
    if let fixed @ 1.. = FIXED.get() {
        return fixed;
    }
    #[cfg(any(test, feature = "test-support"))]
    if let Some((at, since)) = FOLLOWED.get() {
        return at + tokio::time::Instant::now().saturating_duration_since(since).as_millis() as u64;
    }
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// Fixes this thread's wall clock at `ms`; `None` puts back the system's.
#[cfg(any(test, feature = "test-support"))]
pub fn set(ms: Option<u64>) {
    FIXED.set(ms.unwrap_or(0));
}

/// Starts this thread's wall clock at `ms` now and moves it with tokio's (paused) clock, as a recording's frozen
/// `Date.now` moved with its fake timers; `None` puts back the system's.
#[cfg(any(test, feature = "test-support"))]
pub fn follow(ms: Option<u64>) {
    FOLLOWED.set(ms.map(|ms| (ms, tokio::time::Instant::now())));
}

#[cfg(test)]
mod tests {
    /// Two replays fixing the clock at the same time, on two threads, each read their own.
    #[test]
    fn concurrent_clocks_never_see_each_other() {
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let run = |ms: u64| {
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                super::set(Some(ms));
                barrier.wait();
                let read = super::now_ms();
                barrier.wait();
                read
            })
        };
        let (a, b) = (run(1_000), run(2_000));
        assert_eq!((a.join().unwrap(), b.join().unwrap()), (1_000, 2_000));
    }
}
