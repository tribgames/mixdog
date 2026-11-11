//! The wall clock a provider stamps its session state with (`Date.now()`).
//!
//! A development-only seam, compiled only under `cfg(test)` or the `test-support` feature (which `build.rs` refuses in a
//! release-profile build) and inert unless a test sets it: [`set`] fixes the time a recording's frozen `Date.now`
//! returned, so a replay stamps what Node stamped. The time belongs to the replay's scope (`random::run_scoped`): every
//! thread of the replay reads it, no other work does. Without one, the time is the system's.

use std::time::{SystemTime, UNIX_EPOCH};

/// A scope's scripted clock: a fixed time, or a start moving with tokio's clock.
#[cfg(any(test, feature = "test-support"))]
#[derive(Clone, Copy)]
enum Scripted {
    Fixed(u64),
    Followed(u64, tokio::time::Instant),
}

#[cfg(any(test, feature = "test-support"))]
static CLOCK: crate::random::scripted::Script<Scripted> = crate::random::scripted::Script::new();

/// Unix milliseconds: this scope's scripted time when its test set one, else the system's.
pub(crate) fn now_ms() -> u64 {
    #[cfg(any(test, feature = "test-support"))]
    if let Some(scripted) = CLOCK.peek() {
        return match scripted {
            Scripted::Fixed(ms) => ms,
            Scripted::Followed(at, since) => at + tokio::time::Instant::now().saturating_duration_since(since).as_millis() as u64,
        };
    }
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// Fixes this scope's wall clock at `ms`; `None` puts back the system's.
#[cfg(any(test, feature = "test-support"))]
pub fn set(ms: Option<u64>) {
    CLOCK.set(ms.map(|ms| [Scripted::Fixed(ms)].into()));
}

/// Starts this scope's wall clock at `ms` now and moves it with tokio's (paused) clock, as a recording's frozen
/// `Date.now` moved with its fake timers; `None` puts back the system's.
#[cfg(any(test, feature = "test-support"))]
pub fn follow(ms: Option<u64>) {
    CLOCK.set(ms.map(|ms| [Scripted::Followed(ms, tokio::time::Instant::now())].into()));
}

/// Removes scope `id`'s clock (the scope ended).
#[cfg(any(test, feature = "test-support"))]
pub(crate) fn clear(id: u64) {
    CLOCK.clear(id);
}

#[cfg(test)]
mod tests {
    /// A read of the wall clock by a replay's work moved to the runtime's blocking pool reads the replay's time, a thread
    /// outside the replay reads the system's meanwhile, and two replays each read their own.
    #[test]
    fn each_replay_reads_its_own_time_wherever_its_work_runs() {
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        let run = |ms: u64| {
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                crate::random::run_scoped(async move {
                    super::set(Some(ms));
                    barrier.wait();
                    let moved = tokio::task::spawn_blocking(super::now_ms).await.expect("a moved read");
                    barrier.wait();
                    (super::now_ms(), moved)
                })
            })
        };
        let (a, b) = (run(1_000), run(2_000));
        barrier.wait();
        let unrelated = std::thread::spawn(super::now_ms).join().expect("an unrelated read");
        barrier.wait();
        assert!(unrelated > 2_000);
        assert_eq!((a.join().unwrap(), b.join().unwrap()), ((1_000, 1_000), (2_000, 2_000)));
    }
}
