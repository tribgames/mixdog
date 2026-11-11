//! The random bytes the providers mint ids from (recovered tool-call ids, Antigravity request and session ids).
//!
//! A development-only seam, compiled only under `cfg(test)` or the `test-support` feature (which `build.rs` refuses in a
//! release-profile build) and inert unless a test scripts it: [`script`] queues the draws a recording made, in order, so a
//! replay mints the ids Node drew, and [`script_jitter`] the retry jitter samples. The script belongs to the thread that
//! set it: a replay drawing on its own (current-thread) runtime never sees another test's script, and a draw on any
//! other thread is fresh. Without a script every draw is `rand::random`.

/// `N` random bytes: the next scripted draw when this thread's test queued one, else fresh.
pub(crate) fn bytes<const N: usize>() -> [u8; N] {
    #[cfg(any(test, feature = "test-support"))]
    if let Some(draw) = scripted::NEXT.with_borrow_mut(std::collections::VecDeque::pop_front) {
        return draw.try_into().unwrap_or_else(|draw: Vec<u8>| panic!("a scripted draw of {} bytes where {N} were drawn", draw.len()));
    }
    rand::random()
}

/// The next scripted retry jitter samples (`step`, `advice`) of this thread, when its test queued them.
pub(crate) fn jitter() -> Option<(f64, f64)> {
    #[cfg(any(test, feature = "test-support"))]
    return scripted::JITTER.with_borrow_mut(std::collections::VecDeque::pop_front);
    #[cfg(not(any(test, feature = "test-support")))]
    None
}

#[cfg(any(test, feature = "test-support"))]
mod scripted {
    use std::cell::RefCell;
    use std::collections::VecDeque;

    thread_local! {
        pub(super) static NEXT: RefCell<VecDeque<Vec<u8>>> = const { RefCell::new(VecDeque::new()) };
        pub(super) static JITTER: RefCell<VecDeque<(f64, f64)>> = const { RefCell::new(VecDeque::new()) };
    }
}

/// Replaces this thread's queued draws with `draws`, in drawing order; an empty list puts back fresh randomness.
#[cfg(any(test, feature = "test-support"))]
pub fn script(draws: impl IntoIterator<Item = Vec<u8>>) {
    scripted::NEXT.set(draws.into_iter().collect());
}

/// Replaces this thread's queued retry jitter samples (`step`, `advice` of each verdict, in order); empty puts back fresh.
#[cfg(any(test, feature = "test-support"))]
pub fn script_jitter(samples: impl IntoIterator<Item = (f64, f64)>) {
    scripted::JITTER.set(samples.into_iter().collect());
}

#[cfg(test)]
mod tests {
    /// Two replays scripting their draws at the same time, on two threads, each draw their own: the script is the
    /// thread's, so neither can take or replace the other's.
    #[test]
    fn concurrent_scripts_never_see_each_other() {
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let run = |mark: u8| {
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                super::script([vec![mark; 8], vec![mark + 1; 8]]);
                super::script_jitter([(f64::from(mark), 0.0)]);
                barrier.wait();
                let drawn = (super::bytes::<8>(), super::bytes::<8>(), super::jitter());
                barrier.wait();
                drawn
            })
        };
        let (a, b) = (run(1), run(10));
        assert_eq!(a.join().unwrap(), ([1; 8], [2; 8], Some((1.0, 0.0))));
        assert_eq!(b.join().unwrap(), ([10; 8], [11; 8], Some((10.0, 0.0))));
    }
}
