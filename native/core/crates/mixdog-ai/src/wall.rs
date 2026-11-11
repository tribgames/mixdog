//! The wall clock a provider stamps its session state with (`Date.now()`).
//!
//! A development-only seam, compiled only under `cfg(test)` or the `test-support` feature (which `build.rs` refuses in a
//! release-profile build) and inert unless a test sets it: [`set`] fixes the time a recording's frozen `Date.now`
//! returned, so a replay stamps what Node stamped. The fixed time belongs to the thread that set it, so concurrent replays
//! never read each other's; while any thread of the process holds one, a read on a thread without one panics (work that
//! left the replay's thread), so a replay never reads the system's time unnoticed. Without any, the time is the system's.

use std::time::{SystemTime, UNIX_EPOCH};

/// A thread's scripted clock: a fixed time, or a start moving with tokio's clock.
#[cfg(any(test, feature = "test-support"))]
#[derive(Clone, Copy)]
enum Scripted {
    Fixed(u64),
    Followed(u64, tokio::time::Instant),
}

#[cfg(any(test, feature = "test-support"))]
static INSTALLED: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

#[cfg(any(test, feature = "test-support"))]
thread_local! {
    static CLOCK: crate::random::scripted::Script<Scripted> = const { crate::random::scripted::Script::new(&INSTALLED) };
}

/// Unix milliseconds: this thread's scripted time when its test set one, else the system's.
pub(crate) fn now_ms() -> u64 {
    #[cfg(any(test, feature = "test-support"))]
    if let Some(scripted) = CLOCK.with(|clock| clock.peek("wall clock")) {
        return match scripted {
            Scripted::Fixed(ms) => ms,
            Scripted::Followed(at, since) => at + tokio::time::Instant::now().saturating_duration_since(since).as_millis() as u64,
        };
    }
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// Fixes this thread's wall clock at `ms`; `None` puts back the system's.
#[cfg(any(test, feature = "test-support"))]
pub fn set(ms: Option<u64>) {
    CLOCK.with(|clock| clock.set(ms.map(|ms| [Scripted::Fixed(ms)].into())));
}

/// Starts this thread's wall clock at `ms` now and moves it with tokio's (paused) clock, as a recording's frozen
/// `Date.now` moved with its fake timers; `None` puts back the system's.
#[cfg(any(test, feature = "test-support"))]
pub fn follow(ms: Option<u64>) {
    CLOCK.with(|clock| clock.set(ms.map(|ms| [Scripted::Followed(ms, tokio::time::Instant::now())].into())));
}

#[cfg(test)]
mod tests {
    /// A read of the wall clock by work that moved to another worker of a multi-thread runtime fails loudly while the
    /// replay's thread holds its fixed time; once it is removed, every thread reads the system's again.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_read_that_left_the_scripted_thread_fails_loudly() {
        super::set(Some(1_000));
        let moved = tokio::task::spawn_blocking(super::now_ms).await.expect_err("a read off the scripted thread panics");
        assert!(moved.is_panic());
        assert_eq!(super::now_ms(), 1_000);
        super::set(None);
        assert!(tokio::task::spawn_blocking(super::now_ms).await.expect("the system's time") > 1_000);
    }

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
