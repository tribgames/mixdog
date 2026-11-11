//! The random bytes the providers mint ids from (recovered tool-call ids, Antigravity request and session ids).
//!
//! A development-only seam, compiled only under `cfg(test)` or the `test-support` feature (which `build.rs` refuses in a
//! release-profile build) and inert unless a test scripts it: [`script`] queues the draws a recording made, in order, so a
//! replay mints the ids Node drew, and [`script_jitter`] the retry jitter samples. The script belongs to the thread that
//! set it: a replay drawing on its own (current-thread) runtime never sees another test's script. A replay can never
//! draw from the real source unnoticed: while any thread of the process holds a script of a kind, a draw of that kind
//! on a thread without one panics (work that moved off the replay's thread), and so does a draw past the end of a
//! script. Without any script every draw is `rand::random`.

/// `N` random bytes: the next scripted draw when this thread's test queued one, else fresh.
pub(crate) fn bytes<const N: usize>() -> [u8; N] {
    #[cfg(any(test, feature = "test-support"))]
    if let Some(draw) = scripted::NEXT.with(|script| script.draw("random bytes")) {
        return draw.try_into().unwrap_or_else(|draw: Vec<u8>| panic!("a scripted draw of {} bytes where {N} were drawn", draw.len()));
    }
    rand::random()
}

/// The next scripted retry jitter samples (`step`, `advice`) of this thread, when its test queued them.
pub(crate) fn jitter() -> Option<(f64, f64)> {
    #[cfg(any(test, feature = "test-support"))]
    return scripted::JITTER.with(|script| script.draw("retry jitter"));
    #[cfg(not(any(test, feature = "test-support")))]
    None
}

#[cfg(any(test, feature = "test-support"))]
pub(crate) mod scripted {
    use std::cell::RefCell;
    use std::collections::VecDeque;
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    /// One thread's script of one kind, and the count of threads of the process holding a script of that kind.
    pub(crate) struct Script<T: 'static> {
        queued: RefCell<Option<VecDeque<T>>>,
        installed: &'static AtomicUsize,
    }

    impl<T> Script<T> {
        pub(crate) const fn new(installed: &'static AtomicUsize) -> Self {
            Self { queued: RefCell::new(None), installed }
        }

        /// Installs `queued` on this thread (`None`, or nothing queued, removes the thread's script).
        pub(crate) fn set(&self, queued: Option<VecDeque<T>>) {
            let queued = queued.filter(|q| !q.is_empty());
            let mut slot = self.queued.borrow_mut();
            match (slot.is_some(), queued.is_some()) {
                (false, true) => {
                    self.installed.fetch_add(1, Ordering::SeqCst);
                }
                (true, false) => {
                    self.installed.fetch_sub(1, Ordering::SeqCst);
                }
                _ => {}
            }
            *slot = queued;
        }

        /// This thread's next scripted value; `None` (the real source) only when no thread of the process holds a
        /// script of this kind. A draw this thread's script does not cover, or a draw on a thread without a script
        /// while another thread holds one, panics naming `kind`.
        pub(crate) fn draw(&self, kind: &str) -> Option<T> {
            match &mut *self.queued.borrow_mut() {
                Some(queued) => Some(queued.pop_front().unwrap_or_else(|| panic!("a {kind} draw past the end of this thread's script"))),
                None => self.unscripted(kind),
            }
        }

        /// This thread's current scripted value, left in place (a clock read); else as [`Script::draw`].
        pub(crate) fn peek(&self, kind: &str) -> Option<T>
        where
            T: Copy,
        {
            match &*self.queued.borrow() {
                Some(queued) => queued.front().copied(),
                None => self.unscripted(kind),
            }
        }

        fn unscripted(&self, kind: &str) -> Option<T> {
            assert!(
                self.installed.load(Ordering::SeqCst) == 0,
                "a {kind} draw on thread {:?}, which holds no script, while another thread's replay scripts {kind}: the work left the replay's thread",
                std::thread::current().id()
            );
            None
        }
    }

    impl<T> Drop for Script<T> {
        fn drop(&mut self) {
            if self.queued.get_mut().is_some() {
                self.installed.fetch_sub(1, Ordering::SeqCst);
            }
        }
    }

    static BYTES_INSTALLED: AtomicUsize = AtomicUsize::new(0);
    static JITTER_INSTALLED: AtomicUsize = AtomicUsize::new(0);

    thread_local! {
        pub(super) static NEXT: Script<Vec<u8>> = const { Script::new(&BYTES_INSTALLED) };
        pub(super) static JITTER: Script<(f64, f64)> = const { Script::new(&JITTER_INSTALLED) };
    }
}

/// Replaces this thread's queued draws with `draws`, in drawing order; an empty list removes the thread's script.
#[cfg(any(test, feature = "test-support"))]
pub fn script(draws: impl IntoIterator<Item = Vec<u8>>) {
    scripted::NEXT.with(|script| script.set(Some(draws.into_iter().collect())));
}

/// Replaces this thread's queued retry jitter samples (`step`, `advice` of each verdict, in order); empty removes it.
#[cfg(any(test, feature = "test-support"))]
pub fn script_jitter(samples: impl IntoIterator<Item = (f64, f64)>) {
    scripted::JITTER.with(|script| script.set(Some(samples.into_iter().collect())));
}

#[cfg(test)]
mod tests {
    /// Work of a replay that moves to another worker of a multi-thread runtime can never draw from the real source:
    /// while the replay's thread holds its script, a draw on a thread without one fails loudly, and so does a draw past
    /// the end of the script; once the script is removed, every thread draws fresh again.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_draw_that_left_the_scripted_thread_fails_loudly() {
        super::script([vec![7; 8]]);
        super::script_jitter([(0.5, 0.5)]);
        let moved = tokio::task::spawn_blocking(|| super::bytes::<8>()).await.expect_err("a draw off the scripted thread panics");
        assert!(moved.is_panic());
        let moved = tokio::task::spawn_blocking(super::jitter).await.expect_err("a jitter draw off the scripted thread panics");
        assert!(moved.is_panic());
        assert_eq!((super::bytes::<8>(), super::jitter()), ([7; 8], Some((0.5, 0.5))));
        let past = std::panic::catch_unwind(super::bytes::<8>).expect_err("a draw past the script panics");
        assert!(past.downcast_ref::<String>().is_some_and(|m| m.contains("past the end")));
        super::script(Vec::new());
        super::script_jitter(Vec::new());
        let fresh = tokio::task::spawn_blocking(|| (super::bytes::<8>(), super::jitter())).await.expect("fresh draws");
        assert_eq!(fresh.1, None);
    }

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
