//! The random bytes the providers mint ids from (recovered tool-call ids, Antigravity request and session ids).
//!
//! A development-only seam, compiled only under `cfg(test)` or the `test-support` feature (which `build.rs` refuses in a
//! release-profile build) and inert unless a test scripts it: [`script`] queues the draws a recording made, in order, so a
//! replay mints the ids Node drew, and [`script_jitter`] the retry jitter samples.
//!
//! A script belongs to a scope: the work of one replay. A replay whose draws all run on its test's thread scripts that
//! thread's scope; one whose work moves to other threads runs under [`run_scoped`], a runtime every thread of
//! which (the caller's while it runs, and the runtime's blocking pool) draws in the replay's scope, so the script goes
//! with the replay's work to whichever of its threads runs it, and no other work sees it: another replay, or any thread
//! outside a replay, draws in a scope of its own (a thread outside every replay is its own scope). A draw past the end of
//! a script panics. Without a script in its scope every draw is `rand::random`. (No draw site of the crate runs on a
//! thread it spawns itself: `std::thread::spawn` in `src/` serves blocking reads only.)

/// `N` random bytes: the next scripted draw when this scope's test queued one, else fresh.
pub(crate) fn bytes<const N: usize>() -> [u8; N] {
    #[cfg(any(test, feature = "test-support"))]
    if let Some(draw) = scripted::NEXT.draw("random bytes") {
        return draw.try_into().unwrap_or_else(|draw: Vec<u8>| panic!("a scripted draw of {} bytes where {N} were drawn", draw.len()));
    }
    rand::random()
}

/// The next scripted retry jitter samples (`step`, `advice`) of this scope, when its test queued them.
pub(crate) fn jitter() -> Option<(f64, f64)> {
    #[cfg(any(test, feature = "test-support"))]
    return scripted::JITTER.draw("retry jitter");
    #[cfg(not(any(test, feature = "test-support")))]
    None
}

#[cfg(any(test, feature = "test-support"))]
pub(crate) mod scripted {
    use std::cell::Cell;
    use std::collections::BTreeMap;
    use std::collections::VecDeque;
    use std::sync::Mutex;
    use std::sync::PoisonError;
    use std::sync::atomic::AtomicU64;
    use std::sync::atomic::Ordering;

    /// The next scope id (0 is "none yet").
    static SCOPES: AtomicU64 = AtomicU64::new(1);

    thread_local! {
        /// The scope this thread draws in: the replay it runs for, else (once it draws or scripts) its own.
        static SCOPE: Cell<u64> = const { Cell::new(0) };
    }

    /// A scope no thread draws in yet.
    pub(crate) fn fresh() -> u64 {
        SCOPES.fetch_add(1, Ordering::SeqCst)
    }

    /// This thread's scope.
    fn current() -> u64 {
        SCOPE.with(|scope| {
            if scope.get() == 0 {
                scope.set(fresh());
            }
            scope.get()
        })
    }

    /// Puts this thread in scope `id`; returns the scope it was in.
    pub(crate) fn enter(id: u64) -> u64 {
        SCOPE.with(|scope| scope.replace(id))
    }

    /// One kind's scripts, each scope's own.
    pub(crate) struct Script<T> {
        by_scope: Mutex<BTreeMap<u64, VecDeque<T>>>,
    }

    impl<T> Script<T> {
        pub(crate) const fn new() -> Self {
            Self { by_scope: Mutex::new(BTreeMap::new()) }
        }

        fn scopes(&self) -> std::sync::MutexGuard<'_, BTreeMap<u64, VecDeque<T>>> {
            self.by_scope.lock().unwrap_or_else(PoisonError::into_inner)
        }

        /// Installs `queued` in this thread's scope (`None`, or nothing queued, removes the scope's script).
        pub(crate) fn set(&self, queued: Option<VecDeque<T>>) {
            let scope = current();
            match queued.filter(|q| !q.is_empty()) {
                Some(queued) => self.scopes().insert(scope, queued),
                None => self.scopes().remove(&scope),
            };
        }

        /// Removes scope `id`'s script.
        pub(crate) fn clear(&self, id: u64) {
            self.scopes().remove(&id);
        }

        /// The next value of this thread's scope's script; `None` (the real source) when the scope has none. A draw
        /// past the end of the script panics naming `kind`.
        pub(crate) fn draw(&self, kind: &str) -> Option<T> {
            let scope = current();
            let next = self.scopes().get_mut(&scope).map(VecDeque::pop_front)?;
            Some(next.unwrap_or_else(|| panic!("a {kind} draw past the end of this replay's script")))
        }

        /// The scope's current scripted value, left in place (a clock read).
        pub(crate) fn peek(&self) -> Option<T>
        where
            T: Copy,
        {
            let scope = current();
            self.scopes().get(&scope).and_then(|queued| queued.front().copied())
        }
    }

    pub(crate) static NEXT: Script<Vec<u8>> = Script::new();
    pub(crate) static JITTER: Script<(f64, f64)> = Script::new();
}

/// Replaces this scope's queued draws with `draws`, in drawing order; an empty list removes the scope's script.
#[cfg(any(test, feature = "test-support"))]
pub fn script(draws: impl IntoIterator<Item = Vec<u8>>) {
    scripted::NEXT.set(Some(draws.into_iter().collect()));
}

/// Replaces this scope's queued retry jitter samples (`step`, `advice` of each verdict, in order); empty removes it.
#[cfg(any(test, feature = "test-support"))]
pub fn script_jitter(samples: impl IntoIterator<Item = (f64, f64)>) {
    scripted::JITTER.set(Some(samples.into_iter().collect()));
}

/// Runs a replay's `future` to its end on a current-thread runtime of its own, in a fresh scope: every thread of the
/// runtime (the caller's while the future runs, and each thread of its blocking pool) draws random bytes, jitter and wall
/// time from the scripts the replay installs, and no thread outside it does. The scope's scripts go when it ends.
#[cfg(any(test, feature = "test-support"))]
pub fn run_scoped<F: std::future::Future>(future: F) -> F::Output {
    /// Leaves the scope when the replay ends, a panic included.
    struct Leave {
        id: u64,
        before: u64,
    }
    impl Drop for Leave {
        fn drop(&mut self) {
            scripted::NEXT.clear(self.id);
            scripted::JITTER.clear(self.id);
            crate::wall::clear(self.id);
            crate::pid::clear(self.id);
            scripted::enter(self.before);
        }
    }
    let id = scripted::fresh();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .on_thread_start(move || {
            scripted::enter(id);
        })
        .build()
        .expect("the replay's runtime");
    let _leave = Leave { id, before: scripted::enter(id) };
    runtime.block_on(future)
}

#[cfg(test)]
mod tests {
    /// Work of a replay that moves off the replay's thread (here to the runtime's blocking pool) draws from the replay's
    /// script, in order, and a draw past its end fails loudly.
    #[test]
    fn work_that_moves_off_the_replay_thread_draws_from_its_script() {
        super::run_scoped(async {
            super::script([vec![7; 8], vec![8; 8]]);
            super::script_jitter([(0.5, 0.5)]);
            let moved = tokio::task::spawn_blocking(|| (super::bytes::<8>(), super::jitter())).await.expect("a draw on the blocking pool");
            assert_eq!(moved, ([7; 8], Some((0.5, 0.5))));
            assert_eq!(super::bytes::<8>(), [8; 8]);
            let past = tokio::task::spawn_blocking(super::bytes::<8>).await.expect_err("a draw past the script panics");
            assert!(past.into_panic().downcast_ref::<String>().is_some_and(|m| m.contains("past the end")));
        });
    }

    /// Two replays scripting their draws at the same time each draw their own, and a thread outside both draws fresh
    /// without failing while both hold scripts.
    #[test]
    fn concurrent_replays_never_see_each_other_or_unrelated_work() {
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        let run = |mark: u8| {
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                super::run_scoped(async move {
                    super::script([vec![mark; 8], vec![mark + 1; 8]]);
                    super::script_jitter([(f64::from(mark), 0.0)]);
                    barrier.wait();
                    let first = super::bytes::<8>();
                    let moved = tokio::task::spawn_blocking(|| (super::bytes::<8>(), super::jitter())).await.expect("a moved draw");
                    barrier.wait();
                    (first, moved)
                })
            })
        };
        let (a, b) = (run(1), run(10));
        barrier.wait();
        let unrelated = std::thread::spawn(super::jitter).join().expect("an unrelated draw");
        barrier.wait();
        assert_eq!(unrelated, None);
        assert_eq!(a.join().unwrap(), ([1; 8], ([2; 8], Some((1.0, 0.0)))));
        assert_eq!(b.join().unwrap(), ([10; 8], ([11; 8], Some((10.0, 0.0)))));
    }
}
